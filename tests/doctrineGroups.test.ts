import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOCTRINE_CATALOG, RETIRED_POLICIES } from "../src/engine/doctrine.js";
import {
  CLAUSE_GROUP, CLAUSE_NEEDS, COMMON_KNOBS, DOCTRINE_GROUPS, briefClause, groupOf, kindOf, matchesSearch, resolveGroup, summarizeGroups,
  type ClauseInput,
} from "../src/engine/doctrineGroups.js";

const input = (key: string, over: Partial<ClauseInput> = {}): ClauseInput => {
  const d = DOCTRINE_CATALOG.find((x) => x.key === key)!;
  return { ...d, defaultValue: d.value, defaultEnabled: d.enabled, adopted: true, ...over };
};

describe("doctrine groups: drift guard", () => {
  const groupIds = new Set(DOCTRINE_GROUPS.map((g) => g.id));

  it("every catalog clause has exactly one known group", () => {
    const missing = DOCTRINE_CATALOG.filter((d) => !CLAUSE_GROUP[d.key]).map((d) => d.key);
    assert.deepEqual(missing, [], `add these to CLAUSE_GROUP in src/engine/doctrineGroups.ts: ${missing.join(", ")}`);
    for (const d of DOCTRINE_CATALOG) assert.ok(groupIds.has(CLAUSE_GROUP[d.key]![0]), `${d.key} names an unknown group`);
  });

  it("the metadata names no unknown key", () => {
    const keys = new Set(DOCTRINE_CATALOG.map((d) => d.key));
    for (const k of Object.keys(CLAUSE_GROUP)) assert.ok(keys.has(k), `CLAUSE_GROUP has unknown key ${k}`);
    for (const [k, needs] of Object.entries(CLAUSE_NEEDS)) {
      assert.ok(keys.has(k), `CLAUSE_NEEDS has unknown key ${k}`);
      for (const n of needs) assert.ok(keys.has(n), `${k} needs unknown key ${n}`);
    }
    for (const k of COMMON_KNOBS) assert.ok(keys.has(k), `COMMON_KNOBS has unknown key ${k}`);
  });

  it("group ids are unique, no group is empty, retired clauses only in retired", () => {
    assert.equal(groupIds.size, DOCTRINE_GROUPS.length);
    for (const g of DOCTRINE_GROUPS) assert.ok(Object.values(CLAUSE_GROUP).some(([id]) => id === g.id), `group ${g.id} is empty`);
    for (const k of RETIRED_POLICIES) assert.equal(CLAUSE_GROUP[k]?.[0], "retired");
    for (const [k, [g]] of Object.entries(CLAUSE_GROUP)) if (g === "retired") assert.ok(RETIRED_POLICIES.has(k));
  });

  it("no sub-group holds more than 9 clauses", () => {
    const counts = new Map<string, number>();
    for (const [g, sg] of Object.values(CLAUSE_GROUP)) counts.set(`${g}/${sg}`, (counts.get(`${g}/${sg}`) ?? 0) + 1);
    for (const [k, n] of counts) assert.ok(n <= 9, `${k} has ${n}`);
  });
});

describe("doctrine groups: helpers", () => {
  it("dynamic ship caps go to cash / Hull caps", () => {
    assert.deepEqual(groupOf("shipCap:SHIP_LIGHT_HAULER"), ["cash", "Hull caps"]);
  });

  it("kinds: modes, switches and numbers", () => {
    assert.equal(kindOf({ key: "freshGate", min: 0, max: 2 }), "mode");
    assert.equal(kindOf({ key: "routeHoldAware", min: 1, max: 1 }), "switch");
    assert.equal(kindOf({ key: "autoBuyShips", min: 0, max: 1 }), "switch");
    assert.equal(kindOf({ key: "positioningHops", min: 1, max: 10 }), "number");
  });

  it("search splits camelCase and needs every word", () => {
    assert.equal(matchesSearch(input("keeperTopUpPerHour"), "top up"), true);
    assert.equal(matchesSearch(input("keeperTopUpPerHour"), "top up release"), false);
    assert.equal(matchesSearch(input("positioningHops"), "JUMPS"), true, "matches the group name");
    assert.equal(matchesSearch(input("jumpCashFloor"), ""), true);
  });

  it("brief rows carry the default only when changed, and the description only when asked", () => {
    const same = briefClause(input("positioningHops"));
    assert.equal(same.default, undefined);
    assert.equal(same.description, undefined);
    assert.equal(same.group, "reach");
    assert.equal(same.common, true);
    const changed = briefClause(input("positioningHops", { value: 9 }), true);
    assert.deepEqual(changed.default, { value: DOCTRINE_CATALOG.find((d) => d.key === "positioningHops")!.value, enabled: changed.default!.enabled });
    assert.ok(changed.description && changed.description.length > changed.summary.length - 1);
    assert.deepEqual(briefClause(input("chainCircuitMinGain")).needs, ["chainCircuitWeight"]);
  });

  it("group summaries count clauses, switches on and changes", () => {
    const rows = [input("positioningHops", { value: 9 }), input("jumpCashFloor", { enabled: true }), input("cashFloor")];
    const s = summarizeGroups(rows);
    const reach = s.find((g) => g.id === "reach")!;
    assert.equal(reach.count, 2);
    assert.equal(reach.changedFromDefault, 2);
    assert.equal(s.find((g) => g.id === "cash")!.count, 1);
    assert.equal(s.some((g) => g.id === "mining"), false, "empty groups are omitted");
  });

  it("a group argument resolves by id or name prefix", () => {
    assert.equal(resolveGroup("fresh"), "fresh");
    assert.equal(resolveGroup("Keepers: cov"), "keeper-cover");
    assert.equal(resolveGroup("API"), "api");
    assert.equal(resolveGroup("nope"), undefined);
  });

  it("the full brief catalog is far smaller than today's get_doctrine reply", () => {
    const all = DOCTRINE_CATALOG.filter((d) => !RETIRED_POLICIES.has(d.key)).map((d) => briefClause(input(d.key)));
    const size = JSON.stringify(all).length;
    // 60k until 2026-11-20; 62k for the tour-plan clauses (issue #63), 64k for fill fit and the staging reserve. Still about a third of the old 180 KB reply.
    assert.ok(size < 64_000, `brief catalog is ${size} bytes`);
  });
});

import { queryDoctrine } from "../src/engine/doctrineGroups.js";

describe("queryDoctrine (what stcommand_get_doctrine returns)", () => {
  const all = DOCTRINE_CATALOG.map((d) => input(d.key));

  it("no arguments: groups and the common knobs only, a few KB, retired hidden", () => {
    const r = queryDoctrine(all, {}) as any;
    assert.ok(r.groups.length >= 13);
    assert.equal(r.groups.some((g: any) => g.id === "retired"), false);
    assert.equal(r.common.length, COMMON_KNOBS.length);
    assert.equal(r.total, all.length - RETIRED_POLICIES.size);
    assert.ok(JSON.stringify(r).length < 15_000, `${JSON.stringify(r).length} bytes`);
  });

  it("group= returns only that group, in sub-group order, with group counts over the matches", () => {
    const r = queryDoctrine(all, { group: "reach" }) as any;
    assert.ok(r.clauses.length > 0);
    assert.ok(r.clauses.every((c: any) => c.group === "reach"));
    assert.equal(r.groups.length, 1);
  });

  it("search, changed and paging", () => {
    const changed = all.map((c) => (c.key === "positioningHops" ? { ...c, value: 9 } : c));
    assert.deepEqual((queryDoctrine(changed, { changed: "default" }) as any).clauses.map((c: any) => c.key), ["positioningHops"]);
    assert.ok((queryDoctrine(all, { search: "top up" }) as any).clauses.some((c: any) => c.key === "keeperTopUpPerHour"));
    const page = queryDoctrine(all, { group: "fresh", limit: 5 }) as any;
    assert.equal(page.returned, 5);
    assert.equal(page.next, "offset=5");
  });

  it("an unknown group names the valid ones", () => {
    assert.throws(() => queryDoctrine(all, { group: "nope" }), /unknown doctrine group "nope"; groups: cash, routes/);
  });
});
