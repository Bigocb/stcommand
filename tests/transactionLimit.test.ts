import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lotAfterRefusal, transactionLimit } from "../src/engine/transactionLimit.js";

const msg = (n: number) => new Error(`Market transaction failed. Trade good SHIP_PLATING has a limit of ${n} units per transaction.`);

describe("transactionLimit", () => {
  it("reads the cap out of the market's own message", () => {
    assert.equal(transactionLimit(msg(8)), 8);
    assert.equal(transactionLimit(new Error("has a limit of 1 unit per transaction")), 1);
    assert.equal(transactionLimit("limit of 60 units per transaction"), 60);
  });
  it("returns nothing for any other error", () => {
    assert.equal(transactionLimit(new Error("insufficient credits")), undefined);
    assert.equal(transactionLimit(new Error("limit of 0 units per transaction")), undefined);
    assert.equal(transactionLimit(undefined), undefined);
  });
  it("retries only when the cap is smaller than the lot that failed (9u against a cap of 8 -> 8)", () => {
    assert.equal(lotAfterRefusal(msg(8), 9), 8);
    assert.equal(lotAfterRefusal(msg(8), 8), undefined, "same size: retrying cannot help, let the error surface");
    assert.equal(lotAfterRefusal(msg(8), 5), undefined);
    assert.equal(lotAfterRefusal(new Error("boom"), 9), undefined);
  });
});

describe("trader.ts wiring: a refused lot is retried at the market's cap (THEOREM-1, 9u SHIP_PLATING, 2026-10-18)", () => {
  const src = readFileSync(new URL("../src/engine/trader.ts", import.meta.url), "utf8");
  it("both sell loops (leftover sweep and held leg) catch the refusal and shrink lotSize", () => {
    const loops = src.match(/sold = await this\.api\.sellCargo\(this\.symbol, item\.symbol, lot\);\s*\} catch \(err\) \{[\s\S]{0,700}?lotAfterRefusal\(err, lot\)[\s\S]{0,500}?lotSize = cap;[\s\S]{0,300}?continue;/g);
    assert.equal(loops?.length, 2);
    assert.match(src, /let lotSize = leg\.lotSize > 0/);
    assert.match(src, /let lotSize = effectiveLotSize\(marketLot/);
  });
  it("the buy loop does the same and pins the smaller lot", () => {
    assert.match(src, /res = await this\.api\.purchaseCargo\(this\.symbol, route\.good, lot\);\s*\} catch \(err\) \{[\s\S]{0,700}lotAfterRefusal\(err, lot\)[\s\S]{0,400}lotCap = cap;[\s\S]{0,300}continue;/);
    assert.match(src, /lotSize: lotCap \}\);/);
  });
  it("any other error still surfaces", () => {
    assert.match(src, /if \(cap === undefined\) throw err;/);
  });
});
