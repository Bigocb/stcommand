import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buyAdvice, buyRulesFrom, BUY_RULES_OFF, DEFAULT_BUY_RULES, hullCargo, workingCapitalFloor } from "../src/engine/buyAdvice.js";

/**
 * The buy-ship warning (src/engine/buyAdvice.ts) against the two heavy buys of 2026-11-17 (docs/lessons-learned.md):
 *  - 19:24 THEO-A1, 2,240,596c, wallet about 3.2M before; no big hull yet, 10 other traders;
 *  - 22:11 THEO-A7, 2,303,936c, wallet about 2.93M before; A1 was 2.8 h old and had not paid back; after the buy two heavies
 *    and 10 other traders, so the floor is 2 x 400k + 10 x 100k = 1.8M against 625k left.
 * A1 made about 940k matched in its first hour; 1.5M by 22:11 is assumed here (under its price either way).
 */

const T = (iso: string) => Date.parse(iso);
const HEAVY = 480;

describe("buyAdvice: the 22:11 heavy buy", () => {
  const advice = buyAdvice({
    price: 2_303_936, cargo: HEAVY, wallet: 2_930_000, holds: 400_000,
    traders: 11, bigHulls: 1,
    lastBigHullBuy: { ship: "THEO-A1", price: 2_240_596, at: T("2026-11-17T19:24:00Z"), profitSince: 1_500_000 },
    now: T("2026-11-17T22:11:00Z"),
    rules: DEFAULT_BUY_RULES,
  });

  it("is not ok and says why", () => {
    assert.equal(advice.ok, false);
    assert.equal(advice.bigHull, true);
    assert.equal(advice.floor, 1_800_000);
    assert.equal(advice.walletAfter, 2_930_000 - 2_303_936);
  });

  it("warns on the working-capital floor", () => {
    assert.ok(advice.warnings.some((w) => w.startsWith("Wallet after the buy 626k is under the working-capital floor 1.8M (2 big hulls x 400k + 10 other traders x 100k)")), advice.warnings.join(" | "));
  });

  it("warns on the 10M big-hull line (and the 3M line)", () => {
    assert.ok(advice.warnings.some((w) => w === "Wallet 2.93M is under the 10M line for a hull over 80 cargo (and the 3M line for any hull)."), advice.warnings.join(" | "));
  });

  it("warns that the last big hull has not paid back", () => {
    assert.ok(advice.warnings.some((w) => w.startsWith("THEO-A1, the last big hull (2.24M, 2.8 h ago), has made 1.5M matched profit: not paid back yet")), advice.warnings.join(" | "));
  });
});

describe("buyAdvice: other cases", () => {
  it("the 19:24 buy warns on the floor and the 10M line, not on payback (no earlier big hull)", () => {
    const a = buyAdvice({ price: 2_240_596, cargo: HEAVY, wallet: 3_200_000, holds: 300_000, traders: 10, bigHulls: 0, now: T("2026-11-17T19:24:00Z"), rules: DEFAULT_BUY_RULES });
    assert.equal(a.floor, 400_000 + 10 * 100_000);
    assert.equal(a.warnings.length, 2, a.warnings.join(" | "));
    assert.ok(a.warnings[0]!.startsWith("Wallet after the buy 959k is under the working-capital floor 1.4M"));
    assert.ok(a.warnings[1]!.startsWith("Wallet 3.2M is under the 10M line"));
  });

  it("a light hauler on a 12M wallet with paid-back hulls is fine", () => {
    const a = buyAdvice({
      price: 316_860, cargo: 80, wallet: 12_000_000, holds: 1_000_000, traders: 12, bigHulls: 2,
      lastBigHullBuy: { ship: "THEO-A7", price: 2_303_936, at: T("2026-11-18T10:00:00Z"), profitSince: 2_500_000 },
      now: T("2026-11-18T12:00:00Z"), rules: DEFAULT_BUY_RULES,
    });
    assert.deepEqual(a.warnings, []);
    assert.equal(a.ok, true);
  });

  it("a light hauler under 3M warns on the 3M line only", () => {
    const a = buyAdvice({ price: 316_860, cargo: 80, wallet: 2_800_000, holds: 0, traders: 6, bigHulls: 0, rules: DEFAULT_BUY_RULES });
    assert.deepEqual(a.warnings, ["Wallet 2.8M is under the 3M line for any hull."]);
  });

  it("a bad economy finding is a warning; a warn-level one is not", () => {
    const a = buyAdvice({
      price: 316_860, cargo: 80, wallet: 12_000_000, holds: 0, traders: 6, bigHulls: 0, rules: DEFAULT_BUY_RULES,
      economyFindings: [
        { id: "netNegative", level: "bad", line: "Losing about 290k an hour after jumps and fuel." },
        { id: "marginDecay", level: "warn", line: "Profit per sale 3.5k against 6.0k (6 h avg)." },
      ],
    });
    assert.deepEqual(a.warnings, ["Economy: Losing about 290k an hour after jumps and fuel."]);
  });

  it("shows the escape clause as a note, never as a block", () => {
    const a = buyAdvice({ price: 316_860, cargo: 80, wallet: 2_000_000, holds: 0, traders: 6, bigHulls: 0, rules: DEFAULT_BUY_RULES, escape: { cashFlatOrFalling2h: true, idleTraders: 3 } });
    assert.equal(a.notes.length, 1);
    assert.match(a.notes[0]!, /^Escape clause: cash has been flat or falling for 2 h and 3 traders are idle/);
    assert.equal(a.warnings.length, 1, "the 3M warning stays");
  });

  it("a probe (no cargo) does not add a trader to the floor", () => {
    const a = buyAdvice({ price: 23_000, cargo: 0, wallet: 5_000_000, holds: 0, traders: 4, bigHulls: 0, rules: DEFAULT_BUY_RULES });
    assert.equal(a.floor, 400_000);
  });

  it("rules off: no warnings", () => {
    const a = buyAdvice({ price: 2_303_936, cargo: HEAVY, wallet: 2_930_000, holds: 0, traders: 11, bigHulls: 1, rules: BUY_RULES_OFF });
    assert.deepEqual(a.warnings, []);
    assert.equal(a.ok, true);
  });

  it("workingCapitalFloor and buyRulesFrom", () => {
    assert.equal(workingCapitalFloor(2, 10, DEFAULT_BUY_RULES), 1_800_000);
    const doc = (off: string[] = []) => ({ value: (k: string, d?: number) => (k === "buyAdviceBigHullLoad" ? 350_000 : (d as number)), isEnabledOr: (k: string) => !off.includes(k) });
    assert.equal(buyRulesFrom(doc(["buyAdvice"])).on, false);
    assert.equal(buyRulesFrom(doc()).bigHullLoad, 350_000);
    assert.equal(buyRulesFrom(doc()).bigHullLine, 10_000_000);
  });

  it("a big hull wants cargo in transit on top of the wallet line (operator 2026-11-19: 3.5M wallet and about 1M in holds)", () => {
    const rules = { ...DEFAULT_BUY_RULES, bigHullLine: 3_500_000, bigHullHolds: 1_000_000 };
    const thin = buyAdvice({ price: 2_181_498, cargo: HEAVY, wallet: 3_600_000, holds: 300_000, traders: 10, bigHulls: 2, rules });
    assert.ok(thin.warnings.some((w) => /Holds .* under the .* cargo in transit/.test(w)), thin.warnings.join("\n"));
    const loaded = buyAdvice({ price: 2_181_498, cargo: HEAVY, wallet: 3_600_000, holds: 1_200_000, traders: 10, bigHulls: 2, rules });
    assert.ok(!loaded.warnings.some((w) => /cargo in transit/.test(w)));
    assert.ok(!buyAdvice({ price: 2_181_498, cargo: HEAVY, wallet: 3_600_000, holds: 0, traders: 10, bigHulls: 2, rules: DEFAULT_BUY_RULES }).warnings.some((w) => /cargo in transit/.test(w)), "off (0) = holds not checked");
  });

  it("hullCargo sums cargo-hold modules when the inventory row says 0 (the THEO-BD buy read the heavy as 0 cargo)", () => {
    const heavy = { cargoCapacity: 0, modules: [{ symbol: "MODULE_CARGO_HOLD_III", capacity: 75 }, { symbol: "MODULE_CARGO_HOLD_III", capacity: 75 }, { symbol: "MODULE_CARGO_HOLD_III", capacity: 75 }, { symbol: "MODULE_CREW_QUARTERS_I", capacity: 40 }] };
    assert.equal(hullCargo(heavy), 225);
    assert.equal(hullCargo({ cargoCapacity: 80, modules: [] }), 80);
    assert.equal(hullCargo({ cargoCapacity: 0, modules: [] }), 0, "a probe");
    assert.equal(hullCargo(undefined), 0);
  });
});
