import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approvedSaleAllows } from "../src/engine/approvedSale.js";

describe("approvedSaleAllows", () => {
  it("no approval waives nothing", () => {
    assert.equal(approvedSaleAllows(undefined, 19_976), false);
    assert.equal(approvedSaleAllows(0, 19_976), false);
  });
  it("an approved sale carries on while a lot fetches at least 80% of the quote", () => {
    assert.equal(approvedSaleAllows(19_976, 19_976), true);
    assert.equal(approvedSaleAllows(19_976, 15_981), true);   // just over 80%
  });
  it("a bigger drop stops the sale so the operator is asked again", () => {
    assert.equal(approvedSaleAllows(19_976, 15_900), false);
    assert.equal(approvedSaleAllows(19_976, 8_830), false);
  });
  it("the tolerance is a parameter", () => {
    assert.equal(approvedSaleAllows(1000, 500, 50), true);
    assert.equal(approvedSaleAllows(1000, 499, 50), false);
  });
});
