import { describe, it } from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";
import { NotificationService } from "../src/engine/notify/service.js";
import type { PushStore, PushSubscriptionRow } from "../src/engine/notify/store.js";
import { vapidFromEnv, WebPushTransport, type PushMessage, type PushTarget, type PushTransport, type SendResult } from "../src/engine/notify/transport.js";
import type { DeliveryState, NotifySnapshot } from "../src/engine/notify/types.js";

const T = "tenant-1";
const sub = (id: string, over: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow => ({
  id, endpoint: `https://push.example/${id}`, p256dh: "k", auth: "a", userAgent: null, prefs: {}, delivery: { sent: {}, recent: [] },
  lastSentAt: null, failures: 0, lastError: null, ...over,
});

class FakeStore implements PushStore {
  subs = new Map<string, PushSubscriptionRow>();
  saves: { id: string; delivery: DeliveryState; sent?: boolean; error?: string }[] = [];
  constructor(rows: PushSubscriptionRow[]) { for (const r of rows) this.subs.set(r.endpoint, r); }
  async upsertPushSubscription(): Promise<PushSubscriptionRow> { throw new Error("unused"); }
  async listPushSubscriptions() { return [...this.subs.values()]; }
  async getPushSubscription(_t: string, endpoint: string) { return this.subs.get(endpoint); }
  async setPushPrefs() { return true; }
  async savePushDelivery(_t: string, id: string, delivery: DeliveryState, o: { sent?: boolean; error?: string } = {}) {
    this.saves.push({ id, delivery, ...o });
    for (const s of this.subs.values()) if (s.id === id) s.delivery = delivery;
  }
  async deletePushSubscription(_t: string, endpoint: string) { return this.subs.delete(endpoint); }
}

class FakeTransport implements PushTransport {
  sent: { to: string; m: PushMessage }[] = [];
  result: (t: PushTarget) => SendResult = () => ({ ok: true });
  async send(t: PushTarget, m: PushMessage): Promise<SendResult> { const r = this.result(t); if (r.ok) this.sent.push({ to: t.endpoint, m }); return r; }
}

const snap = (over: Partial<NotifySnapshot> = {}): NotifySnapshot => ({ now: 0, approvals: [], stranded: [], attention: [], ...over });
function make(rows: PushSubscriptionRow[], getSnap: () => NotifySnapshot | Promise<NotifySnapshot>) {
  const store = new FakeStore(rows);
  const transport = new FakeTransport();
  const calls = { snapshot: 0 };
  const svc = new NotificationService({ tenantId: T, store, transport, snapshot: async () => { calls.snapshot++; return getSnap(); }, now: () => 1_000_000 });
  return { store, transport, svc, calls };
}

describe("NotificationService", () => {
  it("does not even read the fleet when nobody is subscribed", async () => {
    const { svc, calls } = make([], () => snap());
    assert.deepEqual(await svc.pass(), { events: 0, sent: 0, held: 0, failed: 0, removed: 0 });
    assert.equal(calls.snapshot, 0);
  });

  it("brings a new device up to date silently, then sends only what is new, once", async () => {
    let s = snap({ stranded: [{ symbol: "THEOREM-1" }] });
    const { svc, transport, store } = make([sub("a")], () => s);
    await svc.pass(); // seeds: THEOREM-1 was already stranded when the device joined
    assert.equal(transport.sent.length, 0);
    assert.equal(store.subs.get("https://push.example/a")!.delivery.seeded, true);
    s = snap({ stranded: [{ symbol: "THEOREM-1" }, { symbol: "THEOREM-2" }] });
    await svc.pass();
    assert.deepEqual(transport.sent.map((x) => x.m.title), ["THEOREM-2 is stranded"]);
    await svc.pass();
    assert.equal(transport.sent.length, 1, "not repeated while it is still true");
  });

  it("applies each device's own choices", async () => {
    const s = snap({ approvals: [{ id: "ap1", kind: "buy_ship", shipSymbol: null }] });
    const quiet = sub("b", { prefs: { categories: { approvals: false } }, delivery: { sent: {}, recent: [], seeded: true } });
    const loud = sub("c", { delivery: { sent: {}, recent: [], seeded: true } });
    const { svc, transport } = make([quiet, loud], () => s);
    await svc.pass();
    assert.deepEqual(transport.sent.map((x) => x.to), ["https://push.example/c"]);
  });

  it("puts the current count of things needing a person on every message, for the app icon", async () => {
    const s = snap({ approvals: [{ id: "a", kind: "buyShip", shipSymbol: null }], stranded: [{ symbol: "S-1" }, { symbol: "S-2" }] });
    const { svc, transport } = make([sub("g", { delivery: { sent: {}, recent: [], seeded: true } })], () => s);
    await svc.pass();
    assert.equal(transport.sent.length, 3);
    assert.deepEqual([...new Set(transport.sent.map((x) => x.m.badge))], [3]);
  });

  it("a failed send is not recorded, so the next pass tries again", async () => {
    const s = snap({ stranded: [{ symbol: "THEOREM-9" }] });
    const { svc, transport, store } = make([sub("d", { delivery: { sent: {}, recent: [], seeded: true } })], () => s);
    transport.result = () => ({ ok: false, gone: false, status: 503, error: "push service down" });
    const first = await svc.pass();
    assert.equal(first.failed, 1);
    assert.deepEqual(store.subs.get("https://push.example/d")!.delivery.sent, {}, "nothing recorded as announced");
    assert.equal(store.saves.at(-1)!.error, "push service down");
    transport.result = () => ({ ok: true });
    const second = await svc.pass();
    assert.equal(second.sent, 1);
  });

  it("removes a device the push service says is gone, and keeps going", async () => {
    const s = snap({ stranded: [{ symbol: "THEOREM-9" }] });
    const { svc, transport, store } = make([sub("dead", { delivery: { sent: {}, recent: [], seeded: true } }), sub("live", { delivery: { sent: {}, recent: [], seeded: true } })], () => s);
    transport.result = (t) => (t.endpoint.endsWith("dead") ? { ok: false, gone: true, status: 410, error: "gone" } : { ok: true });
    const r = await svc.pass();
    assert.equal(r.removed, 1);
    assert.deepEqual([...store.subs.keys()], ["https://push.example/live"]);
    assert.equal(transport.sent.length, 1);
  });

  it("a snapshot that throws skips the pass without throwing", async () => {
    const lines: string[] = [];
    const store = new FakeStore([sub("e")]);
    const svc = new NotificationService({ tenantId: T, store, transport: new FakeTransport(), snapshot: async () => { throw new Error("fleet not ready"); }, log: (m) => lines.push(m) });
    assert.equal((await svc.pass()).sent, 0);
    assert.match(lines[0]!, /fleet not ready/);
  });

  it("sendTest goes straight through, ignoring the policy, and reports an unknown device", async () => {
    const { svc, transport } = make([sub("f", { prefs: { enabled: false } })], () => snap());
    assert.deepEqual(await svc.sendTest("https://push.example/f"), { ok: true });
    assert.equal(transport.sent[0]!.m.title, "Tower notifications are on");
    assert.equal((await svc.sendTest("https://push.example/none")).ok, false);
  });
});

describe("WebPushTransport", () => {
  const vapid = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" };
  const target = { endpoint: "https://push.example/x", p256dh: "k", auth: "a" };

  it("sends a small JSON payload with the urgency the severity asks for", async (t) => {
    const calls: any[] = [];
    t.mock.method(webpush, "sendNotification", async (...args: unknown[]) => { calls.push(args); return {} as never; });
    const r = await new WebPushTransport(vapid).send(target, { title: "T", body: "B", severity: "critical", url: "/m#fleet", tag: "k" });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(JSON.parse(calls[0][1]), { title: "T", body: "B", url: "/m#fleet", severity: "critical", tag: "k" }, "no badge given, none sent");
    await new WebPushTransport(vapid).send(target, { title: "T", body: "B", severity: "info", badge: 4 });
    assert.equal(JSON.parse(calls[1][1]).badge, 4);
    assert.equal(calls[0][2].urgency, "high");
  });

  it("maps 404 and 410 to gone, and other failures to a plain error", async (t) => {
    const m = t.mock.method(webpush, "sendNotification", async () => { throw Object.assign(new Error("Gone"), { statusCode: 410 }); });
    const msg = { title: "T", body: "B", severity: "info" as const };
    assert.deepEqual(await new WebPushTransport(vapid).send(target, msg), { ok: false, gone: true, status: 410, error: "Gone" });
    m.mock.restore();
    t.mock.method(webpush, "sendNotification", async () => { throw Object.assign(new Error("Service Unavailable"), { statusCode: 503 }); });
    assert.deepEqual(await new WebPushTransport(vapid).send(target, msg), { ok: false, gone: false, status: 503, error: "Service Unavailable" });
  });

  it("a server without the library still builds the transport, and a send reports the problem instead of throwing", async () => {
    const t = new WebPushTransport(vapid, async () => { throw new Error("Cannot find package 'web-push'"); });
    const r = await t.send(target, { title: "T", body: "B", severity: "info" });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not installed on this server \(run npm ci\)/);
    assert.equal((r as { gone: boolean }).gone, false, "a missing library must not delete anyone's subscription");
  });

  it("is configured only when both VAPID keys are set", () => {
    assert.equal(vapidFromEnv({}), undefined);
    assert.equal(vapidFromEnv({ VAPID_PUBLIC_KEY: "p" }), undefined);
    assert.deepEqual(vapidFromEnv({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "s", VAPID_SUBJECT: "mailto:me@x.y" }), { publicKey: "p", privateKey: "s", subject: "mailto:me@x.y" });
  });
});
