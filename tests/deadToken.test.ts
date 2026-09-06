import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, APIError } from "../src/core/client.js";

/**
 * A SpaceTraders reset retires every token issued before it, and the API says
 * so explicitly. That is not a transient failure, so retrying it is not
 * resilience — it is a busy-wait against a shared budget. Live, two dead
 * tenants retried it about every 0.67 seconds indefinitely, burning most of
 * the per-IP rate limit that the operator's new agent then had to compete
 * for, and burying every real error under a wall of identical ones.
 */

const resetBody = JSON.stringify({
  error: {
    message: "Failed to parse token. Token reset_date does not match the server. Expected: 2026-09-06, Actual: 2026-08-30",
    code: 401,
  },
});

function clientWith(responses: { status: number; body: string }[]): { client: Client; sent: () => number } {
  let sent = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(sent, responses.length - 1)]!;
    sent += 1;
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  const client = new Client({ token: "stale", maxRetries: 0, retryBackoffMs: 1 });
  (client as unknown as { restore: () => void }).restore = () => { globalThis.fetch = original; };
  return { client, sent: () => sent };
}

describe("a token retired by a server reset is never retried", () => {
  it("latches after the first rejection and sends no further requests", async () => {
    const { client, sent } = clientWith([{ status: 401, body: resetBody }]);
    try {
      await assert.rejects(() => client.get("/my/agent"), /reset_date does not match/);
      assert.equal(sent(), 1, "the first call is real");

      // Everything after must be refused locally — no network, and crucially
      // no rate-limiter slot, or dead tenants crowd out the working one.
      for (let i = 0; i < 5; i += 1) {
        await assert.rejects(() => client.get("/my/agent"), (e: unknown) =>
          e instanceof APIError && /previous server reset/.test(e.message));
      }
      assert.equal(sent(), 1, "a permanent failure must not be re-sent");
      assert.match(client.deadTokenReason() ?? "", /re-register/);
    } finally {
      (client as unknown as { restore: () => void }).restore();
    }
  });

  it("does not latch on an ordinary 401", async () => {
    // A wrong token is a different problem from a retired one, and the caller
    // may legitimately retry it.
    const { client, sent } = clientWith([
      { status: 401, body: JSON.stringify({ error: { message: "Invalid token", code: 401 } }) },
    ]);
    try {
      await assert.rejects(() => client.get("/my/agent"));
      assert.equal(client.deadTokenReason(), undefined);
      await assert.rejects(() => client.get("/my/agent"));
      assert.equal(sent(), 2, "an ordinary auth failure is still the caller's to decide about");
    } finally {
      (client as unknown as { restore: () => void }).restore();
    }
  });
});

describe("a fleet whose token is retired stops working and says so once", () => {
  it("skips the tick and logs the fix, rather than a wall of identical errors", async () => {
    const { FleetManager } = await import("../src/engine/fleet.js");
    const logs: string[] = [];
    const fleet = new FleetManager({
      api: {
        getCallCount: () => 0,
        deadTokenReason: () => "agent token is from a previous server reset — re-register this agent to resume",
      } as never,
      log: (m: string) => logs.push(m),
    } as never);

    for (let i = 0; i < 20; i += 1) await fleet.tick();

    const halts = logs.filter((l) => l.includes("halted:"));
    assert.equal(halts.length, 1, `twenty ticks must produce one line, got ${halts.length}`);
    assert.match(halts[0]!, /re-register this agent/);
  });

  it("does not halt when the token is fine", async () => {
    // Asserted on the guard rather than a full tick: a healthy tick does real
    // fleet work and needs the whole API surface, which would test the fake
    // rather than the guard.
    const { FleetManager } = await import("../src/engine/fleet.js");
    const fleet = new FleetManager({
      api: { getCallCount: () => 0, deadTokenReason: () => undefined } as never,
    } as never);
    assert.equal((fleet as never as { haltedByDeadToken(): boolean }).haltedByDeadToken(), false);
  });

  it("does not halt when the api predates this method entirely", async () => {
    const { FleetManager } = await import("../src/engine/fleet.js");
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as never } as never);
    assert.equal((fleet as never as { haltedByDeadToken(): boolean }).haltedByDeadToken(), false);
  });
});
