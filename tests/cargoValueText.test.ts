import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module, no types
import { cargoValueText, cargoValueTitle } from "../public/shared/domain.js";

const cv = (value: number, unpricedUnits = 0) => ({
  value, gross: value + 5000, cost: 80_000, unpricedUnits,
  items: [{ symbol: "ANTIMATTER", units: 18, unitPrice: 5000, source: "route", sellAt: "X1-AA-D", net: value }],
});

describe("cargoValueText", () => {
  it("formats proceeds compactly", () => {
    assert.equal(cargoValueText(cv(290_400)), "~290k");
    assert.equal(cargoValueText(cv(1_234_567)), "~1.23M");
    assert.equal(cargoValueText(cv(850)), "~850");
  });
  it("marks a partly priced hold with + and an unpriced one with ?", () => {
    assert.equal(cargoValueText(cv(120_000, 5)), "~120k+");
    assert.equal(cargoValueText({ ...cv(0, 18), items: [{ symbol: "X", units: 18, unitPrice: 0, source: "none", net: 0 }] }), "?");
  });
  it("is blank for an empty hold or no data", () => {
    assert.equal(cargoValueText(undefined), "");
    assert.equal(cargoValueText({ value: 0, gross: 0, cost: 0, unpricedUnits: 0, items: [] }), "");
  });
  it("explains itself in the tooltip", () => {
    const t = cargoValueTitle(cv(90_000));
    assert.match(t, /18 ANTIMATTER @ 5,000/);
    assert.match(t, /Net of our own price impact/);
    assert.match(t, /Paid about 80,000/);
  });
});

import { cargoProfit } from "../public/shared/domain.js";

describe("cargoProfit", () => {
  it("is proceeds minus cost, signed and toned", () => {
    assert.deepEqual(cargoProfit(cv(290_400)), { text: "+210k", tone: "up", profit: 210_400 });
    assert.equal(cargoProfit({ ...cv(50_000) }).text, "-30k");
    assert.equal(cargoProfit({ ...cv(50_000) }).tone, "down");
  });
  it("is ? without a cost basis or with unpriced units, blank when empty", () => {
    assert.equal(cargoProfit({ ...cv(50_000), cost: 0 }).text, "?");
    assert.equal(cargoProfit(cv(50_000, 3)).text, "?");
    assert.equal(cargoProfit(undefined).text, "");
  });
});

import { walletPlusHolds } from "../public/shared/domain.js";

describe("walletPlusHolds", () => {
  it("adds every hold's proceeds to the wallet and flags unpriced cargo", () => {
    const r = walletPlusHolds(13_000, { a: cv(400_000), b: cv(170_000, 2), c: undefined });
    assert.deepEqual(r, { total: 583_000, holds: 570_000, partial: true });
  });
  it("is just the wallet with no cargo values", () => {
    assert.deepEqual(walletPlusHolds(5, undefined), { total: 5, holds: 0, partial: false });
  });
});
