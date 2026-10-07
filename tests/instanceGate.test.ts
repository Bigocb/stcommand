import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForPredecessor } from "../src/core/instanceGate.js";

function fakeClock() {
  const c = { t: 1_000_000 };
  return { c, now: () => c.t, sleep: async (ms: number) => { c.t += ms; } };
}

describe("waitForPredecessor", () => {
  const bootedAt = new Date(1_000_000);
  const older = { instanceId: "old", startedAt: new Date(500_000).toISOString() };

  it("returns at once when no other instance is alive", async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    await waitForPredecessor({ others: async () => { calls += 1; return []; }, bootedAt, log: () => {}, now, sleep });
    assert.equal(calls, 1);
  });

  it("waits while an older instance is checking in, then starts once it stops", async () => {
    const { c, now, sleep } = fakeClock();
    const logs: string[] = [];
    await waitForPredecessor({ others: async () => (c.t < 1_020_000 ? [older] : []), bootedAt, log: (m) => logs.push(m), now, sleep, pollMs: 3_000 });
    assert.ok(c.t >= 1_020_000, "it must not start while the old instance is alive");
    assert.match(logs[0]!, /waiting for old/);
    assert.match(logs.at(-1)!, /previous instance gone/);
  });

  it("ignores an instance that started after this one", async () => {
    const { now, sleep } = fakeClock();
    const newer = { instanceId: "new", startedAt: new Date(2_000_000).toISOString() };
    let calls = 0;
    await waitForPredecessor({ others: async () => { calls += 1; return [newer]; }, bootedAt, log: () => {}, now, sleep });
    assert.equal(calls, 1);
  });

  it("starts anyway after maxWaitMs, and on a heartbeat read error", async () => {
    const { c, now, sleep } = fakeClock();
    await waitForPredecessor({ others: async () => [older], bootedAt, log: () => {}, now, sleep, maxWaitMs: 90_000 });
    assert.ok(c.t - 1_000_000 >= 90_000 && c.t - 1_000_000 < 95_000);
    await waitForPredecessor({ others: async () => { throw new Error("db down"); }, bootedAt, log: () => {}, now, sleep });
  });
});
