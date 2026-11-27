import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionGate, generalLimit, acquireConnectionSlot, runInDbLane, currentDbLane, connectionGateStats } from "../src/db/dbLanes.js";

const tick = () => new Promise((r) => setImmediate(r));

test("generalLimit: pool less the reserve, never under 1", () => {
  assert.equal(generalLimit(60, 10), 50);
  assert.equal(generalLimit(5, 10), 1);
  assert.equal(generalLimit(30, 0), 30);
});

test("ConnectionGate: holds the limit, wakes waiters in order", async () => {
  const gate = new ConnectionGate(() => 2);
  const a = await gate.acquire();
  const b = await gate.acquire();
  const order: string[] = [];
  const c = gate.acquire().then((r) => { order.push("c"); return r; });
  const d = gate.acquire().then((r) => { order.push("d"); return r; });
  await tick();
  assert.equal(gate.inUse, 2);
  assert.equal(gate.waiting, 2);
  a();
  const rc = await c;
  assert.deepEqual(order, ["c"]);
  assert.equal(gate.inUse, 2);
  b();
  const rd = await d;
  assert.deepEqual(order, ["c", "d"]);
  rc(); rd();
  assert.equal(gate.inUse, 0);
});

test("ConnectionGate: a release is idempotent and a shrunk limit is respected", async () => {
  let limit = 2;
  const gate = new ConnectionGate(() => limit);
  const a = await gate.acquire();
  const b = await gate.acquire();
  limit = 1;
  let got = false;
  const c = gate.acquire().then((r) => { got = true; return r; });
  a(); a();
  await tick();
  assert.equal(got, false, "still at the shrunk limit with b held");
  assert.equal(gate.inUse, 1);
  b();
  (await c)();
  assert.equal(gate.inUse, 0);
});

test("acquireConnectionSlot: trade lane skips the gate; other work is capped at pool - reserve", async () => {
  const prev = process.env.DB_TRADE_RESERVE;
  process.env.DB_TRADE_RESERVE = "2";
  try {
    const pool = {};
    const r1 = await acquireConnectionSlot(pool, 3); // general limit 1
    let second = false;
    const p2 = acquireConnectionSlot(pool, 3).then((r) => { second = true; return r; });
    await tick();
    assert.equal(second, false);
    // A trader is not blocked by the full general gate.
    const tradeRel = await runInDbLane("trade", async () => {
      assert.equal(currentDbLane(), "trade");
      return acquireConnectionSlot(pool, 3);
    });
    tradeRel();
    assert.deepEqual(connectionGateStats(pool), { inUse: 1, waiting: 1 });
    r1();
    (await p2)();
    assert.equal(second, true);
    assert.deepEqual(connectionGateStats(pool), { inUse: 0, waiting: 0 });
  } finally {
    if (prev === undefined) delete process.env.DB_TRADE_RESERVE; else process.env.DB_TRADE_RESERVE = prev;
  }
});

test("acquireConnectionSlot: reserve 0 = no gate (behaviour before)", async () => {
  const prev = process.env.DB_TRADE_RESERVE;
  process.env.DB_TRADE_RESERVE = "0";
  try {
    const pool = {};
    const rels = await Promise.all([1, 2, 3, 4].map(() => acquireConnectionSlot(pool, 1)));
    rels.forEach((r) => r());
    assert.equal(connectionGateStats(pool), undefined);
  } finally {
    if (prev === undefined) delete process.env.DB_TRADE_RESERVE; else process.env.DB_TRADE_RESERVE = prev;
  }
});
