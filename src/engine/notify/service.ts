import { detectAll, DETECTORS } from "./detectors.js";
import { needsYouCount } from "./badge.js";
import { decide } from "./policy.js";
import type { PushStore, PushSubscriptionRow } from "./store.js";
import type { PushMessage, PushTransport } from "./transport.js";
import { DEFAULT_PREFS, type DeliveryState, type Detector, type NotifyEvent, type NotifyPrefs, type NotifySnapshot } from "./types.js";

/**
 * The per-tenant notification loop: take a snapshot, find events, and for each subscribed device apply that device's
 * choices and send what is left. Everything it needs comes in through the constructor, so it runs the same in tests as live.
 */

export interface NotificationServiceDeps {
  tenantId: string;
  store: PushStore;
  transport: PushTransport;
  /** Read the fleet. May throw; the pass is skipped and tried again next time. */
  snapshot: () => Promise<NotifySnapshot>;
  detectors?: readonly Detector[];
  now?: () => number;
  log?: (msg: string) => void;
}

export interface PassResult {
  events: number;
  sent: number;
  held: number;
  failed: number;
  removed: number;
}

const messageOf = (e: NotifyEvent, badge: number): PushMessage => ({ title: e.title, body: e.body, url: e.url, severity: e.severity, tag: e.key, badge });

export class NotificationService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: NotificationServiceDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One pass over every subscribed device. Never throws. */
  async pass(): Promise<PassResult> {
    const result: PassResult = { events: 0, sent: 0, held: 0, failed: 0, removed: 0 };
    const { tenantId, store, transport } = this.deps;
    const log = this.deps.log ?? (() => {});
    let subs: PushSubscriptionRow[];
    let events: NotifyEvent[];
    let badge = 0;
    try {
      subs = await store.listPushSubscriptions(tenantId);
      if (subs.length === 0) return result; // nobody to tell: do not even read the fleet
      const snap = await this.deps.snapshot();
      badge = needsYouCount(snap);
      events = detectAll(snap, this.deps.detectors ?? DETECTORS);
    } catch (err) {
      log(`notify: pass skipped: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
    result.events = events.length;
    const now = this.now;

    for (const sub of subs) {
      try {
        const prefs: NotifyPrefs = { ...DEFAULT_PREFS, ...sub.prefs };
        let state: DeliveryState = sub.delivery;
        // A device is brought up to date silently the first time: what was already true when it joined is not news.
        if (!state.seeded) {
          const seeded = decide(events, state, prefs, now, { seedOnly: true });
          await store.savePushDelivery(tenantId, sub.id, { ...seeded.state, seeded: true });
          continue;
        }
        const d = decide(events, state, prefs, now);
        result.held += d.held.length;
        let next = d.state;
        let gone = false;
        let lastError: string | undefined;
        let delivered = 0;
        for (const e of d.send) {
          const r = await transport.send(sub, messageOf(e, badge));
          if (r.ok) { result.sent++; delivered++; continue; }
          result.failed++;
          lastError = r.error;
          if (r.gone) { gone = true; break; }
          // Not delivered: un-record it so the next pass tries again, and give the slot back to the hourly cap.
          const sent = { ...next.sent };
          for (const k of e.members ?? [e.key]) delete sent[k];
          next = { ...next, sent, recent: next.recent.slice(0, -1) };
        }
        if (gone) {
          await store.deletePushSubscription(tenantId, sub.endpoint);
          result.removed++;
          log(`notify: removed a subscription the push service no longer knows (${sub.endpoint.slice(0, 48)}...)`);
          continue;
        }
        const changed = JSON.stringify(next) !== JSON.stringify(state) || lastError !== undefined;
        if (changed) await store.savePushDelivery(tenantId, sub.id, { ...next, seeded: true }, { sent: delivered > 0, error: lastError });
      } catch (err) {
        log(`notify: device pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  /** Send one message to one device now, ignoring the policy. For the "send a test" button. */
  async sendTest(endpoint: string): Promise<{ ok: boolean; error?: string; removed?: boolean }> {
    const sub = await this.deps.store.getPushSubscription(this.deps.tenantId, endpoint);
    if (!sub) return { ok: false, error: "not subscribed" };
    const r = await this.deps.transport.send(sub, { title: "Tower notifications are on", body: "This is a test.", url: "/m", severity: "info", tag: "test" });
    if (r.ok) return { ok: true };
    if (r.gone) { await this.deps.store.deletePushSubscription(this.deps.tenantId, endpoint); return { ok: false, error: "the push service no longer knows this device", removed: true }; }
    return { ok: false, error: r.error };
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.pass().catch(() => {}).finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
