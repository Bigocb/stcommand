import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module, no types
import { matches, filterClauses, groupClauses, clausesFrom, neededOff, rangeHint } from "../public/shared/doctrineView.js";

const C = (key: string, group: string, subGroup: string, over: Record<string, unknown> = {}) => ({
  key, name: key, group, subGroup, kind: "number", value: 1, unit: "", min: 0, max: 10, step: 1, enabled: true, adopted: true, common: false, summary: "", ...over,
});
const ORDER = [{ id: "cash", name: "Cash floors & ship buying", blurb: "" }, { id: "reach", name: "Jumps & cross-system trading", blurb: "" }, { id: "keeper-cover", name: "Keepers: coverage & triage", blurb: "" }];
const ALL = [
  C("cashFloor", "cash", "Floors", { common: true }),
  C("positioningHops", "reach", "Jumps", { default: { value: 3, enabled: true }, value: 6 }),
  C("jumpCashFloor", "reach", "Jumps", { enabled: false }),
  C("keeperTopUpPerHour", "keeper-cover", "Top-up"),
  C("keeperTopUpMaxPending", "keeper-cover", "Top-up", { needs: ["keeperTopUpPerHour"] }),
];

describe("doctrineView (the shared doctrine screen helpers)", () => {
  it("search splits camelCase, needs every word and also matches the group name", () => {
    assert.equal(matches(ALL[3], "top up"), true);
    assert.equal(matches(ALL[3], "top up jump"), false);
    assert.equal(matches(ALL[1], "cross-system", "Jumps & cross-system trading"), true);
  });

  it("filters: on, off, changed, common and group", () => {
    const keys = (xs: any[]) => xs.map((x) => x.key);
    assert.deepEqual(keys(filterClauses(ALL, { show: "off" }, ORDER)), ["jumpCashFloor"]);
    assert.deepEqual(keys(filterClauses(ALL, { show: "changed" }, ORDER)), ["positioningHops"]);
    assert.deepEqual(keys(filterClauses(ALL, { show: "common" }, ORDER)), ["cashFloor"]);
    assert.deepEqual(keys(filterClauses(ALL, { group: "reach" }, ORDER)), ["positioningHops", "jumpCashFloor"]);
    assert.deepEqual(keys(filterClauses(ALL, { q: "jumps" }, ORDER)), ["positioningHops", "jumpCashFloor"]);
  });

  it("groups in the server's order, with sub-groups", () => {
    const g = groupClauses(ALL, ORDER);
    assert.deepEqual(g.map((x: any) => x.id), ["cash", "reach", "keeper-cover"]);
    assert.equal(g[1].count, 2);
    assert.deepEqual(g[2].subs.map((s: any) => s.name), ["Top-up"]);
  });

  it("an older server (rules only) shows one ungrouped list", () => {
    const cl = clausesFrom({ rules: [{ key: "a", name: "A", value: 1, min: 0, max: 5, step: 1, unit: "", enabled: true, description: "d" }] });
    assert.equal(cl[0].group, "all");
    const g = groupClauses(cl, []);
    assert.equal(g.length, 1);
    assert.equal(g[0].name, "All clauses");
  });

  it("needed clauses that are off, and the range hint", () => {
    const off = ALL.map((c) => (c.key === "keeperTopUpPerHour" ? { ...c, enabled: false } : c));
    assert.deepEqual(neededOff(off[4], off), [{ key: "keeperTopUpPerHour", name: "keeperTopUpPerHour" }]);
    assert.deepEqual(neededOff(ALL[4], ALL), []);
    assert.equal(rangeHint({ min: 1, max: 10, step: 1, unit: " jumps" }), "1 - 10 jumps, step 1");
  });
});
