import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Covers public/shared/session.js — the gate calls and the onboarding
 * catalog retry, shared by all four UI versions.
 *
 * The retry is the reason this file exists. It encodes a real fact about
 * the system: a brand-new agent's first /api/* request triggers its full
 * fleet boot, and resolveTenant blocks on that, so an early 503 means
 * "still starting" rather than "broken". That behaviour is invisible to
 * the DOM harness (which never onboards) and easy to silently lose in a
 * refactor, so it is pinned here.
 */
interface SharedSession {
  login: (token: string) => Promise<any>;
  register: (agentSymbol: string, faction: string, accountToken: string) => Promise<any>;
  logout: () => Promise<void>;
  fetchOnboardingCatalog: (opts?: { attempts?: number; delayMs?: (n: number) => number }) => Promise<any[]>;
  completeOnboarding: (selections: Record<string, boolean>) => Promise<any>;
}

let session: SharedSession;
let calls: { url: string; init?: any }[];
let responder: (url: string) => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

before(async () => {
  (globalThis as any).window = {};
  const impl = (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    calls.push({ url, init });
    return Promise.resolve(responder(url));
  };
  (globalThis as any).window.fetch = impl;
  (globalThis as any).fetch = impl;
  // @ts-expect-error — untyped browser ES module; SharedSession above is the contract.
  session = await import("../public/shared/session.js");
});

beforeEach(() => {
  calls = [];
  responder = () => json({});
});

describe("shared/session.js — gate calls", () => {
  it("login posts the token and returns the server's answer", async () => {
    responder = () => json({ isNewTenant: false, agentSymbol: "DAGGER" });
    const out = await session.login("st-token");
    assert.equal(calls[0]!.url, "/api/gate/login");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(calls[0]!.init.body, '{"token":"st-token"}');
    assert.deepEqual(out, { isNewTenant: false, agentSymbol: "DAGGER" });
  });

  it("register carries all three fields", async () => {
    responder = () => json({ isNewTenant: true });
    const out = await session.register("SLIME", "COSMIC", "acct-token");
    assert.equal(calls[0]!.url, "/api/gate/register");
    assert.deepEqual(JSON.parse(calls[0]!.init.body), {
      agentSymbol: "SLIME", faction: "COSMIC", accountToken: "acct-token",
    });
    assert.equal(out.isNewTenant, true, "a genuinely new tenant is what routes to onboarding");
  });

  it("surfaces the server's own error message", async () => {
    responder = () => json({ error: "invalid SpaceTraders token" }, 401);
    await assert.rejects(() => session.login("bad"), /invalid SpaceTraders token/);
  });

  it("falls back to a status line when the error body is not JSON", async () => {
    responder = () => new Response("nginx", { status: 502 });
    await assert.rejects(() => session.login("x"), /Server error \(502\)/);
  });

  it("logout never throws — the cookie is being abandoned either way", async () => {
    responder = () => { throw new Error("network down"); };
    await assert.doesNotReject(() => session.logout());
  });
});

describe("shared/session.js — fetchOnboardingCatalog()", () => {
  const noDelay = () => 0;

  it("returns the catalog on a first-attempt success", async () => {
    responder = () => json({ catalog: [{ key: "cashFloor" }] });
    assert.deepEqual(await session.fetchOnboardingCatalog({ delayMs: noDelay }), [{ key: "cashFloor" }]);
    assert.equal(calls.length, 1);
  });

  it("retries past a 503 while the tenant's engine is still booting", async () => {
    // The real case this exists for: resolveTenant blocks a new tenant's
    // first request on a live fleet boot, so the first calls 503.
    let n = 0;
    responder = () => (++n < 3 ? new Response("", { status: 503 }) : json({ catalog: [{ key: "marginFloor" }] }));
    const out = await session.fetchOnboardingCatalog({ delayMs: noDelay });
    assert.deepEqual(out, [{ key: "marginFloor" }]);
    assert.equal(calls.length, 3, "should have kept trying rather than failing on the first 503");
  });

  it("treats an empty catalog as not-ready, not as a valid answer", async () => {
    // An empty checklist would be confirmed as "adopt nothing", silently
    // switching every policy off — including the cash floor.
    let n = 0;
    responder = () => (++n < 2 ? json({ catalog: [] }) : json({ catalog: [{ key: "cashFloor" }] }));
    assert.deepEqual(await session.fetchOnboardingCatalog({ delayMs: noDelay }), [{ key: "cashFloor" }]);
    assert.equal(calls.length, 2);
  });

  it("gives up after the configured number of attempts and throws", async () => {
    responder = () => new Response("", { status: 503 });
    await assert.rejects(() => session.fetchOnboardingCatalog({ attempts: 4, delayMs: noDelay }));
    assert.equal(calls.length, 4);
  });

  it("backs off progressively between attempts", async () => {
    const waits: number[] = [];
    responder = () => new Response("", { status: 503 });
    await session.fetchOnboardingCatalog({ attempts: 4, delayMs: (n) => { waits.push(n); return 0; } })
      .catch(() => {});
    assert.deepEqual(waits, [1, 2, 3], "delay grows with the attempt, and none is taken after the last");
  });
});

describe("shared/session.js — completeOnboarding()", () => {
  it("posts the selections under the key the server expects", async () => {
    responder = () => json({ ok: true, rules: [] });
    await session.completeOnboarding({ cashFloor: true, marginFloor: false });
    assert.equal(calls[0]!.url, "/api/doctrine/onboard");
    assert.deepEqual(JSON.parse(calls[0]!.init.body), {
      selections: { cashFloor: true, marginFloor: false },
    });
  });

  it("surfaces a failure rather than reporting success", async () => {
    responder = () => json({ error: "selections required" }, 400);
    await assert.rejects(() => session.completeOnboarding({}), /selections required/);
  });
});
