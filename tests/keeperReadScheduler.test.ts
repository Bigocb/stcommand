import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planKeeperReads, keeperShipSkipsRead, DEFAULT_KEEPER_READ_POLICY, type KeeperReadInput, type KeeperReadPolicy } from "../src/engine/keeperReadScheduler.js";
import { FleetManager } from "../src/engine/fleet.js";

const NOW = 10_000_000_000;
const MIN = 60_000;
const on: KeeperReadPolicy = { ...DEFAULT_KEEPER_READ_POLICY, enabled: true, targetPassMin: 30, ceilingPerMin: 1_000 };
const markets = (n: number, ageMin = 60) => Array.from({ length: n }, (_, i) => ({ waypoint: `X1-AA-M${String(i).padStart(4, "0")}`, lastReadMs: NOW - ageMin * MIN }));
const input = (over: Partial<KeeperReadInput> = {}): KeeperReadInput => ({ markets: markets(1_500), nowMs: NOW, laneCapacityPerMin: 1_000, inFlight: new Set(), elapsedMs: 60_000, carry: 0, ...over });

describe("keeper read scheduler (pure)", () => {
  it("off picks nothing", () => {
    const p = planKeeperReads(input(), { ...on, enabled: false });
    assert.deepEqual(p.read, []);
    assert.equal(p.limitedBy, "off");
  });

  it("plans keepers / target pass minutes and issues that share per tick", () => {
    const p = planKeeperReads(input({ elapsedMs: 2_000 }), on);
    assert.equal(p.demandPerMin, 50);
    assert.equal(p.plannedPerMin, 50);
    assert.equal(p.limitedBy, "demand");
    assert.equal(p.projectedPassMin, 30);
    // 50/min over 2 s = 1.67 reads: 1 now, 0.67 carried.
    assert.equal(p.read.length, 1);
    assert.ok(Math.abs(p.carry - 2 / 3) < 1e-9);
    const q = planKeeperReads(input({ elapsedMs: 2_000, carry: p.carry, inFlight: new Set(p.read) }), on);
    assert.equal(q.read.length, 2, "the carry adds up across ticks");
    assert.ok(!q.read.includes(p.read[0]!), "an in-flight market is not picked again");
  });

  it("picks never-read first, then the most overdue", () => {
    const p = planKeeperReads(input({
      markets: [
        { waypoint: "X1-AA-FRESH", lastReadMs: NOW - 5 * MIN },
        { waypoint: "X1-AA-OLD", lastReadMs: NOW - 90 * MIN },
        { waypoint: "X1-AA-NEVER" },
        { waypoint: "X1-AA-LATE", lastReadMs: NOW - 40 * MIN },
      ],
      elapsedMs: 60_000, carry: 10,
    }), on);
    assert.deepEqual(p.read, ["X1-AA-NEVER", "X1-AA-OLD", "X1-AA-LATE"]);
    assert.equal(p.due, 3);
  });

  it("is capped by lane capacity, then by the ceiling", () => {
    const cap = planKeeperReads(input({ laneCapacityPerMin: 20, elapsedMs: 6_000 }), on);
    assert.equal(cap.plannedPerMin, 20);
    assert.equal(cap.limitedBy, "capacity");
    assert.equal(cap.read.length, 2, "20/min over a 6 s tick");
    assert.equal(cap.projectedPassMin, 75);
    const ceil = planKeeperReads(input({ laneCapacityPerMin: 500, elapsedMs: 6_000 }), { ...on, ceilingPerMin: 10 });
    assert.equal(ceil.plannedPerMin, 10);
    assert.equal(ceil.limitedBy, "ceiling");
    assert.equal(ceil.read.length, 1, "10/min over a 6 s tick");
  });

  it("with no lane capacity it reads nothing, so keeper ships keep reading", () => {
    const p = planKeeperReads(input({ laneCapacityPerMin: 0 }), on);
    assert.deepEqual(p.read, []);
    assert.equal(p.limitedBy, "no-lane");
  });

  it("uses per-market interval overrides, as a map or a function", () => {
    const ms = [{ waypoint: "X1-AA-HOT", lastReadMs: NOW - 6 * MIN }, { waypoint: "X1-AA-COLD", lastReadMs: NOW - 40 * MIN }];
    const map = planKeeperReads(input({ markets: ms, carry: 5, intervals: new Map([["X1-AA-HOT", 5 * MIN], ["X1-AA-COLD", 120 * MIN]]) }), on);
    assert.deepEqual(map.read, ["X1-AA-HOT"], "the hot market is due, the cold one is not");
    assert.equal(map.demandPerMin, 0.2);
    const fn = planKeeperReads(input({ markets: ms, carry: 5, intervals: (wp) => (wp === "X1-AA-COLD" ? 10 * MIN : undefined) }), on);
    assert.deepEqual(fn.read, ["X1-AA-COLD"], "no override = target pass time (30 min), so HOT at 6 min is not due");
  });

  it("honours maxInFlight", () => {
    const p = planKeeperReads(input({ inFlight: new Set(["X1-AA-ZZZZ1", "X1-AA-ZZZZ2", "X1-AA-ZZZZ3"]) }), { ...on, maxInFlight: 5 });
    assert.equal(p.read.length, 2);
  });

  it("a long gap between ticks issues at most about 10 seconds' worth, not a burst", () => {
    const p = planKeeperReads(input({ elapsedMs: 600_000 }), on);
    assert.equal(p.read.length, 8, "50/min: max(4, 50/6) = 8");
  });

  it("does not bank a burst while nothing is due", () => {
    const p = planKeeperReads(input({ markets: markets(100, 1), elapsedMs: 600_000 }), on);
    assert.deepEqual(p.read, []);
    assert.equal(p.carry, 0);
  });

  it("a keeper ship skips its read only while the scheduler is active and the market is fresh", () => {
    assert.equal(keeperShipSkipsRead({ schedulerActive: true, lastReadMs: NOW - 10 * MIN, nowMs: NOW, intervalMs: 30 * MIN }), true);
    assert.equal(keeperShipSkipsRead({ schedulerActive: true, lastReadMs: NOW - 50 * MIN, nowMs: NOW, intervalMs: 30 * MIN }), false, "scheduler behind: keeper reads");
    assert.equal(keeperShipSkipsRead({ schedulerActive: false, lastReadMs: NOW - 1 * MIN, nowMs: NOW, intervalMs: 30 * MIN }), false);
    assert.equal(keeperShipSkipsRead({ schedulerActive: true, nowMs: NOW, intervalMs: 30 * MIN }), false);
  });
});

/** The seam where the fleet uses the scheduler: which markets it reads, the keeper ships' skip, and off = as before. */
function fakeFleet(clauses: Record<string, { on: boolean; v?: number }>) {
  const fetched = new Map<string, string>([
    ["X1-AA-A", new Date(Date.now() - 45 * MIN).toISOString()],
    ["X1-AA-B", new Date(Date.now() - 2 * MIN).toISOString()],
    ["X1-AA-C", new Date(Date.now() - 90 * MIN).toISOString()],
  ]);
  const reads: { wp: string; maxAgeMs?: number }[] = [];
  const ship = (wp: string, status = "DOCKED") => ({ nav: { waypointSymbol: wp, status } });
  const self: any = {
    doctrine: {
      isEnabledOr: (k: string, d: boolean) => (k in clauses ? clauses[k]!.on : d),
      value: (k: string, d?: number) => clauses[k]?.v ?? d ?? 0,
    },
    keepers: new Map<string, any>([
      ["K-1", { running: true, getShip: () => ship("X1-AA-A") }],
      ["K-2", { running: true, getShip: () => ship("X1-AA-B") }],
      ["K-3", { running: true, getShip: () => ship("X1-AA-C", "IN_TRANSIT") }],
      ["K-4", { running: true, getShip: () => ship("X1-AA-D", "IN_ORBIT") }],
    ]),
    keeperMarkets: new Map([["K-1", "X1-AA-A"], ["K-2", "X1-AA-B"], ["K-3", "X1-AA-C"], ["K-4", "X1-AA-D"]]),
    registry: { market: (wp: string) => (fetched.has(wp) ? { fetchedAt: fetched.get(wp) } : undefined) },
    isLoopKeeper: () => false,
    readTiers: { intervalMs: () => undefined },
    paused: false,
    haltedByDeadToken: () => false,
    laneCapacityPerMin: () => 900,
    keeperReads: { note: () => {} },
    keeperReadSched: { inFlight: new Set<string>(), carry: 0, lastTickAt: 0, last: undefined, reads: { note: () => {}, perMin: () => 0 } },
    recordMarketSnapshot: async (wp: string, opts: { maxAgeMs?: number }) => { reads.push({ wp, maxAgeMs: opts.maxAgeMs }); fetched.set(wp, new Date().toISOString()); },
  };
  for (const k of ["tickKeeperReads", "keeperReadInterval", "keeperReadPolicy", "keeperReadLaneCapacity", "keeperReadMarkets", "keeperShipSkipsRead", "keeperReadSchedulerStatus"]) self[k] = (FleetManager.prototype as any)[k].bind(self);
  return { self, reads };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const ON = { keeperReadScheduler: { on: true, v: 1 }, keeperTargetPassMin: { on: true, v: 30 }, apiLaneProxy: { on: true, v: 3 } };

describe("keeper read scheduler at the fleet seam", () => {
  it("reads the overdue markets whose keeper is in place, fresh, and the keeper skips a market just read", async () => {
    const { self, reads } = fakeFleet(ON);
    self.keeperReadSched.carry = 10;
    self.keeperReadSched.lastTickAt = Date.now() - 2_000;
    await self.tickKeeperReads();
    await settle();
    // A is 45 min old and in place; B is fresh; C's keeper is in transit; D never read and in orbit there.
    assert.deepEqual(reads.map((r) => r.wp), ["X1-AA-D", "X1-AA-A"]);
    assert.ok(reads.every((r) => r.maxAgeMs === 0), "the scheduler's decision is not second-guessed by the reuse window");
    assert.equal(self.keeperReadSched.inFlight.size, 0);
    assert.equal(self.keeperShipSkipsRead("X1-AA-A"), true, "just read: the keeper ship does not read it again");
    assert.equal(self.keeperShipSkipsRead("X1-AA-C"), false, "90 min old: its keeper still reads it");
    const st = self.keeperReadSchedulerStatus(Date.now());
    assert.equal(st.targetPassMin, 30);
    assert.equal(st.laneCapacityPerMin, 540);
    assert.equal(st.plannedPerMin, 0.1, "3 keeper markets in place at 30 min");
  });

  it("a read tier's interval replaces the target pass time for that market", async () => {
    const { self, reads } = fakeFleet(ON);
    self.readTiers = { intervalMs: (wp: string) => (wp === "X1-AA-A" ? 60 * MIN : wp === "X1-AA-B" ? 1 * MIN : undefined) };
    self.keeperReadSched.carry = 10;
    await self.tickKeeperReads();
    await settle();
    // A (45 min old) is COLD at 60 min: not due; B (2 min old) is HOT at 1 min: due; D never read.
    assert.deepEqual(reads.map((r) => r.wp), ["X1-AA-D", "X1-AA-B"]);
  });

  it("off: no scheduled reads and keeper ships read as before", async () => {
    const { self, reads } = fakeFleet({ ...ON, keeperReadScheduler: { on: false, v: 1 } });
    self.keeperReadSched.carry = 10;
    await self.tickKeeperReads();
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(self.keeperShipSkipsRead("X1-AA-B"), false);
    assert.equal(self.keeperReadSchedulerStatus(Date.now()).limitedBy, "off");
  });

  it("with the proxy lane off it reads nothing and the keepers keep reading", async () => {
    const { self, reads } = fakeFleet({ ...ON, apiLaneProxy: { on: false, v: 3 } });
    self.keeperReadSched.carry = 10;
    await self.tickKeeperReads();
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(self.keeperShipSkipsRead("X1-AA-B"), false);
  });
});
