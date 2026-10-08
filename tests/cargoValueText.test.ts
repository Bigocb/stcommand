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
