import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
// @ts-expect-error plain browser module, no types
import { pushSupport, urlBase64ToUint8Array } from "../public/shared/pushSupport.js";
import { cacheHeaders } from "../src/http/uiVersions.js";

/** The browser side of push: the support check, the key decoder, and the service worker run in a stand-in for its scope. */

describe("pushSupport", () => {
  const win = (standalone: boolean, push = true) => ({ matchMedia: () => ({ matches: standalone }), ...(push ? { PushManager: {}, Notification: {} } : {}) });
  const nav = (ua: string, extra: object = {}) => ({ userAgent: ua, serviceWorker: {}, ...extra });
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)";

  it("asks an iPhone to install Tower first, and says why", () => {
    const r = pushSupport(win(false), nav(iphone));
    assert.equal(r.ok, false);
    assert.match(r.reason, /Home Screen/);
  });
  it("lets an installed iPhone app, and an ordinary desktop browser, through", () => {
    assert.deepEqual(pushSupport(win(true), nav(iphone)), { ok: true });
    assert.deepEqual(pushSupport(win(false), nav("Mozilla/5.0 (X11; Linux x86_64)")), { ok: true });
  });
  it("says so when the browser has no push at all", () => {
    assert.match(pushSupport(win(false, false), nav("Mozilla/5.0 (X11; Linux x86_64)")).reason, /does not support/);
    assert.match(pushSupport(win(false), { userAgent: "x" }).reason, /does not support/);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a VAPID public key (url-safe base64) to its 65 bytes", () => {
    const key = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
    const bytes = urlBase64ToUint8Array(key);
    assert.equal(bytes.length, 65);
    assert.equal(bytes[0], 4, "an uncompressed P-256 point starts with 0x04");
  });
});

describe("service worker", () => {
  function load() {
    const handlers: Record<string, (e: any) => void> = {};
    const shown: { title: string; opts: any }[] = [];
    const opened: string[] = [];
    const messages: unknown[] = [];
    let windows: any[] = [];
    const badges: (number | "clear")[] = [];
    const self = {
      navigator: { setAppBadge: async (n: number) => { badges.push(n); }, clearAppBadge: async () => { badges.push("clear"); } } as Record<string, unknown>,
      location: { origin: "https://tower.example" },
      skipWaiting: () => {},
      addEventListener: (t: string, f: (e: any) => void) => { handlers[t] = f; },
      registration: { showNotification: async (title: string, opts: any) => { shown.push({ title, opts }); } },
      clients: {
        claim: async () => {},
        matchAll: async () => windows,
        openWindow: async (u: string) => { opened.push(u); },
      },
    };
    vm.runInNewContext(readFileSync(new URL("../public/sw-tower.js", import.meta.url), "utf8"), { self, URL, Promise });
    const run = async (name: string, e: any) => { let p: Promise<unknown> | undefined; handlers[name]!({ ...e, waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
    return { run, shown, opened, messages, badges, self, setWindows: (w: any[]) => { windows = w; } };
  }

  it("shows the pushed message with its tag, link and a persistent banner only for critical", async () => {
    const sw = load();
    await sw.run("push", { data: { json: () => ({ title: "THEOREM-9 is stranded", body: "It cannot continue on its own.", url: "/m#fleet", severity: "critical", tag: "stranded:THEOREM-9" }) } });
    assert.equal(sw.shown[0]!.title, "THEOREM-9 is stranded");
    assert.deepEqual({ tag: sw.shown[0]!.opts.tag, url: sw.shown[0]!.opts.data.url, sticky: sw.shown[0]!.opts.requireInteraction }, { tag: "stranded:THEOREM-9", url: "/m#fleet", sticky: true });
    await sw.run("push", { data: { json: () => ({ title: "Approval needed", body: "x", severity: "warning" }) } });
    assert.equal(sw.shown[1]!.opts.requireInteraction, false);
    assert.equal(sw.shown[1]!.opts.data.url, "/m", "no link: opens Tower");
  });

  it("sets the icon badge from the payload, clears it at zero, and leaves it alone when none is sent", async () => {
    const sw = load();
    await sw.run("push", { data: { json: () => ({ title: "a", body: "b", badge: 3 }) } });
    await sw.run("push", { data: { json: () => ({ title: "c", body: "d", badge: 0 }) } });
    await sw.run("push", { data: { json: () => ({ title: "e", body: "f" }) } });
    assert.deepEqual(sw.badges, [3, "clear"]);
    assert.equal(sw.shown.length, 3, "a badge problem never costs the notification");
  });

  it("still shows the notification on a platform with no badge support", async () => {
    const sw = load();
    delete sw.self.navigator.setAppBadge; delete sw.self.navigator.clearAppBadge;
    await sw.run("push", { data: { json: () => ({ title: "a", body: "b", badge: 2 }) } });
    assert.equal(sw.shown.length, 1);
  });

  it("copes with a payload that is not JSON", async () => {
    const sw = load();
    await sw.run("push", { data: { json: () => { throw new Error("not json"); }, text: () => "plain words" } });
    assert.deepEqual([sw.shown[0]!.title, sw.shown[0]!.opts.body], ["Tower", "plain words"]);
  });

  it("a tap focuses the open Tower and tells it where to go, or opens a window when none is open", async () => {
    const sw = load();
    const posted: unknown[] = [];
    let focused = 0;
    sw.setWindows([{ url: "https://tower.example/m", focus: async () => { focused++; }, postMessage: (m: unknown) => posted.push(m) }]);
    let closed = 0;
    await sw.run("notificationclick", { notification: { close: () => { closed++; }, data: { url: "/m#approvals" } } });
    assert.deepEqual([closed, focused, sw.opened.length], [1, 1, 0]);
    assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: "tower-open", url: "https://tower.example/m#approvals" }]); // JSON: the worker ran in another realm
    sw.setWindows([]);
    await sw.run("notificationclick", { notification: { close: () => {}, data: { url: "/m#fleet" } } });
    assert.deepEqual(sw.opened, ["https://tower.example/m#fleet"]);
  });

  it("is always re-checked by the browser", () => {
    assert.deepEqual(cacheHeaders("/app/public/sw-tower.js"), { "Cache-Control": "no-cache" });
  });
});
