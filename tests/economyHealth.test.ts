import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bucketsFromLedger, DEFAULT_ECONOMY_POLICY, ECONOMY_OFF, economyHealth, economyPolicyFrom, fmtCredits, shipStatsFromLedger,
  type EconomyBucket, type EconomyHealthInput, type EconomyLedgerRow,
} from "../src/engine/economyHealth.js";

/**
 * Economy health (src/engine/economyHealth.ts) against the 2026-11-17/18 domino week (docs/lessons-learned.md):
 *  - the hour ending ~02:53 UTC 11-18: 232k matched profit, 80 jumps, 486k jump fees, 38k other costs (fuel);
 *  - THEO-1 (40 cargo): 29 jumps (~175k) for 22k profit in 2 h;
 *  - no release from 22:30 to 01:30 with 4-8 staged systems waiting;
 *  - wallet plus holds about 1.19M at 01:13 and 845k at 03:13; the wallet fell to 95k at 01:37.
 * The hour before 01:53 is not in the journal in this detail; it is filled with a plausible jump-heavy hour (the fixes had
 * already released RS9 at 01:30 and traders were crossing gates), net negative, so the 2-hour rules have two hours to judge.
 */

const HOUR = 3_600_000;
const T = (iso: string) => Date.parse(iso);
const NOW = T("2026-11-18T02:53:00Z");

const bucket = (startMs: number, b: Partial<EconomyBucket> = {}): EconomyBucket => ({
  startMs, profit: 0, sales: 0, jumps: 0, jumpFees: 0, fuel: 0, hullSpend: 0, hullsBought: 0, ...b,
});

/** Twelve 30-minute buckets ending at 02:53: four quiet good hours, then the two bad ones. */
function nightBuckets(now = NOW): EconomyBucket[] {
  const start = now - 6 * HOUR;
  const out: EconomyBucket[] = [];
  for (let i = 0; i < 12; i++) {
    const s = start + i * 30 * 60_000;
    if (i < 8) out.push(bucket(s, { profit: 145_000, sales: 30, jumps: 5, jumpFees: 30_000, fuel: 7_000 }));
    else if (i === 8) out.push(bucket(s, { profit: 140_000, sales: 28, jumps: 30, jumpFees: 180_000, fuel: 15_000 }));
    else if (i === 9) out.push(bucket(s, { profit: 120_000, sales: 25, jumps: 35, jumpFees: 210_000, fuel: 15_000 }));
    else out.push(bucket(s, { profit: 116_000, sales: 24, jumps: 40, jumpFees: 243_000, fuel: 19_000 })); // 232k / 80 / 486k / 38k for the hour
  }
  return out;
}

function input(over: Partial<EconomyHealthInput> = {}): EconomyHealthInput {
  return {
    now: NOW,
    bucketMin: 30,
    buckets: nightBuckets(),
    worth: [],
    wallet: [],
    walletNow: 600_000,
    floor: 0,
    queue: { staged: [] },
    ships: [],
    shipWindowHours: 2,
    settings: { positioningHops: 10 },
    ...over,
  };
}

const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

describe("economyHealth: the 2026-11-18 night", () => {
  it("fires jumpsOverProfit with the hour's figures and suggests lowering positioningHops", () => {
    const f = economyHealth(input()).find((x) => x.id === "jumpsOverProfit");
    assert.ok(f, "jumpsOverProfit should fire");
    assert.equal(f.line, "Jump fees 486k against 232k profit in the last hour (80 jumps).");
    assert.equal(f.level, "bad");
    assert.equal(f.numbers.jumps, 80);
    assert.equal(f.suggestion?.action, "stcommand_set_doctrine positioningHops 3");
    assert.deepEqual(f.suggestion?.args, { key: "positioningHops", value: 3 });
  });

  it("fires netNegative at about 290k an hour", () => {
    const f = economyHealth(input()).find((x) => x.id === "netNegative");
    assert.ok(f);
    assert.equal(f.level, "bad");
    assert.equal(f.numbers.lastHourNet, 232_000 - 486_000 - 38_000);
    assert.match(f.line, /^Losing about 2\d0k an hour after jumps and fuel/);
  });

  it("fires smallHullJumping for THEO-1 (40 cargo, 29 jumps in 2 h, 22k) with a set_ship_reach suggestion", () => {
    const f = economyHealth(input({ ships: [
      { symbol: "THEO-1", cargo: 40, jumps: 29, jumpFees: 175_000, profit: 22_000 },
      { symbol: "THEO-A1", cargo: 480, jumps: 20, jumpFees: 120_000, profit: 900_000 }, // a heavy is not a small hull
      { symbol: "THEO-9", cargo: 40, jumps: 4, jumpFees: 24_000, profit: 60_000 }, // two an hour is fine
    ] })).filter((x) => x.id === "smallHullJumping");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.ship, "THEO-1");
    assert.equal(f[0]!.line, "THEO-1 (40 cargo): 15 jumps an hour, 11k profit.");
    assert.equal(f[0]!.level, "bad", "its jump fees are more than it made");
    assert.equal(f[0]!.suggestion?.action, "stcommand_set_ship_reach THEO-1 system");
    assert.deepEqual(f[0]!.suggestion?.args, { shipSymbol: "THEO-1", reach: "system" });
  });

  it("fires releaseDrought at 01:30 after the 22:30 release with 4 staged and the tour ships busy", () => {
    const now = T("2026-11-18T01:30:00Z");
    const f = economyHealth(input({ now, buckets: nightBuckets(now), queue: { lastReleaseAt: T("2026-11-17T22:30:00Z"), staged: ["X1-RS9", "X1-PD3", "X1-TA36", "X1-TU72"], tourShips: 3, tourShipsFree: 0 } }))
      .find((x) => x.id === "releaseDrought");
    assert.ok(f);
    assert.equal(f.line, "No system opened for 3 h; 4 staged waiting, all tour ships busy.");
    assert.equal(f.suggestion?.action, "stcommand_release_system X1-RS9");
  });

  it("does not call a drought with nothing staged, or before the threshold", () => {
    const now = T("2026-11-18T01:30:00Z");
    const base = { now, buckets: nightBuckets(now) };
    assert.ok(!ids(economyHealth(input({ ...base, queue: { lastReleaseAt: T("2026-11-17T22:30:00Z"), staged: [] } }))).includes("releaseDrought"));
    assert.ok(!ids(economyHealth(input({ ...base, queue: { lastReleaseAt: T("2026-11-17T23:00:00Z"), staged: ["X1-RS9"] } }))).includes("releaseDrought"));
  });

  it("fires worthFalling for 1.19M -> 845k over 2 h with no hulls bought", () => {
    const now = T("2026-11-18T03:13:00Z");
    const f = economyHealth(input({ now, buckets: nightBuckets(now), worth: [
      { at: T("2026-11-18T01:13:00Z"), worth: 1_190_000 },
      { at: T("2026-11-18T02:13:00Z"), worth: 1_020_000 },
      { at: now, worth: 845_000 },
    ] })).find((x) => x.id === "worthFalling");
    assert.ok(f);
    assert.equal(f.line, "Wallet plus holds 1.19M -> 845k in 2 h (no hulls bought).");
    assert.equal(f.level, "bad", "a 29% fall");
  });

  it("does not call worth falling when a hull bought in the window explains the drop", () => {
    const now = T("2026-11-17T23:11:00Z");
    const buckets = nightBuckets(now).map((b) => ({ ...b }));
    buckets[10]!.hullSpend = 2_303_936; buckets[10]!.hullsBought = 1;
    const f = economyHealth(input({ now, buckets, worth: [
      { at: now - 2 * HOUR, worth: 3_300_000 },
      { at: now - HOUR, worth: 3_250_000 },
      { at: now, worth: 1_100_000 },
    ] })).find((x) => x.id === "worthFalling");
    assert.equal(f, undefined, "3.25M -> 1.10M + 2.30M added back is up, not down");
  });

  it("fires cashStarved when the wallet has sat under the floor for 30 minutes", () => {
    const now = T("2026-11-18T01:45:00Z");
    const f = economyHealth(input({ now, buckets: nightBuckets(now), floor: 1_800_000, walletNow: 95_000, wallet: [
      { at: T("2026-11-18T01:00:00Z"), wallet: 420_000 },
      { at: T("2026-11-18T01:37:00Z"), wallet: 95_000 },
    ] })).find((x) => x.id === "cashStarved");
    assert.ok(f);
    assert.equal(f.line, "Wallet 95k, floor 1.8M: traders can't load fully.");
    assert.equal(f.level, "bad");
  });

  it("says how much of the money is in cargo (2026-11-18: the card read 'Wallet 84k' with 1.35M in holds)", () => {
    const now = T("2026-11-18T04:42:00Z");
    const f = economyHealth(input({ now, buckets: nightBuckets(now), floor: 1_800_000, walletNow: 84_000,
      worth: [{ at: now, worth: 84_000 + 1_350_000 }],
      wallet: [{ at: T("2026-11-18T04:00:00Z"), wallet: 411_000 }, { at: T("2026-11-18T04:40:00Z"), wallet: 103_000 }],
    })).find((x) => x.id === "cashStarved");
    assert.ok(f);
    assert.equal(f.line, "Wallet 84k (1.35M in cargo), floor 1.8M: traders can't load fully.");
    assert.equal(f.numbers.holds, 1_350_000);
  });

  it("does not call cash starved when the wallet was over the floor inside the window", () => {
    const now = T("2026-11-18T01:45:00Z");
    const f = economyHealth(input({ now, buckets: nightBuckets(now), floor: 1_800_000, walletNow: 950_000, wallet: [
      { at: T("2026-11-18T01:00:00Z"), wallet: 950_000 },
      { at: T("2026-11-18T01:30:00Z"), wallet: 2_100_000 },
    ] })).find((x) => x.id === "cashStarved");
    assert.equal(f, undefined);
  });

  it("lists bad findings before warnings", () => {
    const now = T("2026-11-18T01:30:00Z");
    const fs = economyHealth(input({ now, buckets: nightBuckets(now), queue: { lastReleaseAt: T("2026-11-17T22:30:00Z"), staged: ["X1-RS9"] } }));
    const firstWarn = fs.findIndex((f) => f.level === "warn");
    if (firstWarn >= 0) assert.ok(fs.slice(firstWarn).every((f) => f.level === "warn"), ids(fs).join(","));
  });
});

describe("economyHealth: margin decay", () => {
  it("fires when profit per sale in the last hour is under half its 6-hour average", () => {
    const buckets = nightBuckets().map((b, i) => (i < 10 ? { ...b, profit: 7_900 * b.sales, jumps: 0, jumpFees: 0 } : { ...b, profit: 2_300 * b.sales, jumps: 0, jumpFees: 0 }));
    const f = economyHealth(input({ buckets })).find((x) => x.id === "marginDecay");
    assert.ok(f);
    assert.match(f.line, /^Profit per sale 2\.3k against \d\.\dk \(6 h avg\)\.$/);
  });

  it("is quiet with too few sales to judge", () => {
    const buckets = nightBuckets().map((b, i) => (i < 10 ? { ...b, profit: 7_900 * b.sales } : { ...b, sales: 1, profit: 100 }));
    assert.equal(economyHealth(input({ buckets })).find((x) => x.id === "marginDecay"), undefined);
  });
});

describe("economyHealth: a healthy day and the switch", () => {
  it("a good night says nothing", () => {
    const buckets = nightBuckets().map((b) => ({ ...b, profit: 300_000, jumps: 6, jumpFees: 36_000, fuel: 8_000 }));
    assert.deepEqual(economyHealth(input({ buckets, ships: [{ symbol: "THEO-9", cargo: 40, jumps: 2, jumpFees: 12_000, profit: 80_000 }] })), []);
  });

  it("policy off returns no findings, whatever the numbers", () => {
    const fs = economyHealth(input({ floor: 1_800_000, walletNow: 95_000, ships: [{ symbol: "THEO-1", cargo: 40, jumps: 29, jumpFees: 175_000, profit: 22_000 }] }), ECONOMY_OFF);
    assert.deepEqual(fs, []);
  });

  it("economyPolicyFrom: clause off is ECONOMY_OFF, values come from doctrine", () => {
    const doc = (vals: Record<string, number>, off: string[] = []) => ({
      value: (k: string, d?: number) => (off.includes(k) ? (d as number) : vals[k] ?? (d as number)),
      isEnabledOr: (k: string) => !off.includes(k),
    });
    assert.equal(economyPolicyFrom(doc({}, ["economyAlerts"])).on, false);
    const p = economyPolicyFrom(doc({ economyDroughtHours: 4, economyMarginDecayPct: 40, economySmallHullJumps: 8 }));
    assert.equal(p.on, true);
    assert.equal(p.releaseDroughtHours, 4);
    assert.equal(p.marginDecayShare, 0.4);
    assert.equal(p.smallHullJumpsPerHour, 8);
    assert.equal(p.netNegativeHours, DEFAULT_ECONOMY_POLICY.netNegativeHours);
  });
});

describe("economyHealth: building the input from ledger rows", () => {
  it("buckets sells, jumps, fuel and hull buys, and ignores a scrap refund", () => {
    const now = T("2026-11-18T03:00:00Z");
    const rows: EconomyLedgerRow[] = [
      { ts: now - 10 * 60_000, ship: "THEO-1", type: "SELL", total: 50_000, pnl: 9_000, wallet: 600_000 },
      { ts: now - 12 * 60_000, ship: "THEO-1", type: "JUMP", total: 6_100, pnl: null, wallet: null },
      { ts: now - 40 * 60_000, ship: "THEO-1", type: "REFUEL", total: 900, pnl: null, wallet: null },
      { ts: now - 50 * 60_000, ship: "THEO-A7", type: "SHIP", total: 2_303_936, pnl: null, wallet: null },
      { ts: now - 55 * 60_000, ship: "THEO-3", type: "SHIP", total: -40_000, pnl: null, wallet: null },
      { ts: now - 7 * HOUR, ship: "THEO-1", type: "SELL", total: 1, pnl: 1, wallet: null }, // outside the 6 h
    ];
    const b = bucketsFromLedger(rows, now, 30, 6);
    assert.equal(b.length, 12);
    const last = b[11]!, prev = b[10]!;
    assert.equal(last.sales, 1); assert.equal(last.profit, 9_000); assert.equal(last.jumps, 1); assert.equal(last.jumpFees, 6_100);
    assert.equal(prev.fuel, 900); assert.equal(prev.hullsBought, 1); assert.equal(prev.hullSpend, 2_303_936);
    assert.equal(b.reduce((n, x) => n + x.sales, 0), 1);

    const ships = shipStatsFromLedger(rows, now - 2 * HOUR, new Map([["THEO-1", 40]]));
    assert.deepEqual(ships, [{ symbol: "THEO-1", cargo: 40, jumps: 1, jumpFees: 6_100, profit: 9_000 }]);
  });

  it("fmtCredits", () => {
    assert.equal(fmtCredits(486_000), "486k");
    assert.equal(fmtCredits(1_190_000), "1.19M");
    assert.equal(fmtCredits(2_300), "2.3k");
    assert.equal(fmtCredits(950), "950");
  });
});
