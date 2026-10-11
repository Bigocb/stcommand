import { test } from "node:test";
import assert from "node:assert/strict";
import { contractPipeline, type PipelineContract, type PipelineContext } from "../src/engine/contractPipeline.js";

const NOW = Date.parse("2026-10-11T19:00:00Z");
const contract = (over: Partial<PipelineContract> = {}): PipelineContract => ({
  id: "c1", type: "PROCUREMENT", factionSymbol: "COSMIC", accepted: true, fulfilled: false, abandoned: false,
  deadline: "2026-10-18T19:00:00Z", onAccepted: 3107, onFulfilled: 7607,
  deliver: [{ tradeSymbol: "POLYNUCLEOTIDES", destinationSymbol: "X1-A-K101", unitsRequired: 22, unitsFulfilled: 20 }], ...over,
});
const ctx = (over: Partial<PipelineContext> = {}): PipelineContext => ({
  nowMs: NOW, cheapestPrice: () => 300, heldUnits: () => 0, ledger: () => ({ advance: 3107, costDelivered: 5700, unitsDelivered: 20 }), ...over,
});

test("what is owed, what it has cost, what finishing costs, and the net still to come", () => {
  const p = contractPipeline([contract()], ctx());
  const i = p.items[0]!;
  assert.equal(i.owed, 7607);
  assert.equal(i.advanceReceived, 3107);
  assert.equal(i.progressPct, 91);
  assert.equal(i.costSoFar, 5700);
  assert.equal(i.estCostToFinish, 600); // 2 units still to buy at 300
  assert.equal(i.expectedNet, 7607 - 5700 - 600);
  assert.equal(p.totalOwed, 7607);
});

test("units ships already carry are not bought again", () => {
  const i = contractPipeline([contract()], ctx({ heldUnits: () => 2 })).items[0]!;
  assert.equal(i.lines[0]!.held, 2);
  assert.equal(i.lines[0]!.toBuy, 0);
  assert.equal(i.estCostToFinish, 0);
});

test("held units beyond what is needed do not go negative", () => {
  const i = contractPipeline([contract()], ctx({ heldUnits: () => 99 })).items[0]!;
  assert.equal(i.lines[0]!.toBuy, 0);
});

test("a mined-only good is flagged, not priced", () => {
  const i = contractPipeline([contract()], ctx({ cheapestPrice: () => undefined })).items[0]!;
  assert.equal(i.lines[0]!.unitPrice, null);
  assert.equal(i.estCostToFinish, 0);
  assert.match(i.warnings.join(" "), /can only be mined/);
});

test("a loss and a short deadline are called out", () => {
  const loss = contractPipeline([contract({ onFulfilled: 100 })], ctx()).items[0]!;
  assert.match(loss.warnings.join(" "), /at a loss/);
  const tight = contractPipeline([contract({ deadline: "2026-10-11T19:30:00Z" })], ctx()).items[0]!;
  assert.match(tight.warnings.join(" "), /under an hour/);
});

test("an abandoned contract is listed but not counted as owed", () => {
  const p = contractPipeline([contract({ abandoned: true })], ctx());
  assert.equal(p.items.length, 1);
  assert.match(p.items[0]!.warnings.join(" "), /lapse/);
  assert.equal(p.totalOwed, 0);
});

test("unaccepted and fulfilled contracts are not in the pipeline; the soonest deadline is first", () => {
  const p = contractPipeline([
    contract({ id: "late", deadline: "2026-10-18T19:00:00Z" }),
    contract({ id: "soon", deadline: "2026-10-12T19:00:00Z" }),
    contract({ id: "offer", accepted: false }),
    contract({ id: "done", fulfilled: true }),
  ], ctx());
  assert.deepEqual(p.items.map((i) => i.contractId), ["soon", "late"]);
});

test("a contract with no ledger rows yet has zero cost so far and zero advance", () => {
  const i = contractPipeline([contract()], ctx({ ledger: () => undefined })).items[0]!;
  assert.equal(i.costSoFar, 0);
  assert.equal(i.advanceReceived, 0);
});
