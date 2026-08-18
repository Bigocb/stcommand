import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTriage } from "../src/engine/triage.js";

/**
 * buildTriage() had no test coverage before this, despite its own doc
 * comment calling it out as extracted specifically to be unit-testable.
 * Covers the stranded-ship engineWillAct fix: it used to hardcode "Fuel
 * tender dispatches automatically" for every stranded ship regardless of
 * whether a tender was actually possible — actively misleading when the
 * fleet had no viable tender at all.
 */

function baseInput(stranded: Parameters<typeof buildTriage>[0]["stranded"]) {
  return {
    ships: [{ symbol: "SHIP-1", role: "trader" }],
    stranded,
    earnings: [],
    contracts: [],
    now: Date.now(),
  };
}

describe("buildTriage: stranded ship rescue status", () => {
  it("reports the real tender status when a rescue is actively in progress", () => {
    const { triage } = buildTriage(baseInput([
      { symbol: "SHIP-1", waypointSymbol: "X1-A-A1", rescueActive: true, rescueDetail: "fuel tender SHIP-2 dispatched (en route)" },
    ]));

    const item = triage.find((t) => t.id === "stranded:SHIP-1")!;
    assert.equal(item.engineWillAct, "fuel tender SHIP-2 dispatched (en route)");
  });

  it("flags that it needs operator help when no tender is possible, instead of claiming one will dispatch", () => {
    const { triage } = buildTriage(baseInput([
      {
        symbol: "SHIP-1",
        waypointSymbol: "X1-A-A1",
        rescueActive: false,
        rescueDetail: "no rescue possible: no other ship free to tender (all are manual, in transit, at the same waypoint, or have no cargo hold)",
      },
    ]));

    const item = triage.find((t) => t.id === "stranded:SHIP-1")!;
    assert.match(item.engineWillAct!, /needs your help/);
    assert.match(item.engineWillAct!, /no rescue possible/);
  });

  it("shows the evaluating state as-is, without falsely claiming help is needed yet", () => {
    const { triage } = buildTriage(baseInput([
      { symbol: "SHIP-1", waypointSymbol: "X1-A-A1", rescueActive: false, rescueDetail: "evaluating rescue options" },
    ]));

    const item = triage.find((t) => t.id === "stranded:SHIP-1")!;
    assert.equal(item.engineWillAct, "evaluating rescue options");
  });

  it("falls back to null (not the old hardcoded claim) when no rescue status is supplied at all", () => {
    const { triage } = buildTriage(baseInput([{ symbol: "SHIP-1", waypointSymbol: "X1-A-A1" }]));

    const item = triage.find((t) => t.id === "stranded:SHIP-1")!;
    assert.equal(item.engineWillAct, null);
  });
});
