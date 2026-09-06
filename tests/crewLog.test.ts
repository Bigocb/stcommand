import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCrewEvents, selectForLogging, isCrewed, type CrewShip } from "../src/engine/crewLog.js";
import { PERSONAS, defaultPersonaFor, getPersona } from "../src/engine/personas.js";
import type { ActivityEntry } from "../src/db/store.js";

/**
 * The crew log's trigger and budget model.
 *
 * This is the file that answers "how often would this fire, and about what"
 * without a fleet, a database or a model — which is the question worth
 * settling before any tokens are spent on it.
 */
const ship = (symbol: string, over: Partial<CrewShip> = {}): CrewShip => ({
  symbol,
  crew: { current: 20, capacity: 40, morale: 100 },
  fuel: { current: 300, capacity: 400 },
  condition: 95,
  nav: { systemSymbol: "X1-AA", waypointSymbol: "X1-AA-A1", status: "IN_ORBIT" },
  ...over,
});

const act = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  timestamp: "2026-09-05T08:00:00.000Z",
  shipSymbol: "DAGGER-1", kind: "navigate", detail: "moved", ...over,
});

describe("crew log — who has a captain", () => {
  it("skips uncrewed hulls entirely", () => {
    // A probe has nobody aboard to write anything up, and generating a log
    // for one is spending money to invent a person.
    const probe = ship("PROBE-1", { crew: { current: 0, capacity: 0, morale: 0 } });
    assert.equal(isCrewed(probe), false);
    const events = detectCrewEvents([probe], [act({ shipSymbol: "PROBE-1", kind: "sell", credits: 99999 })]);
    assert.deepEqual(events, []);
  });
});

describe("crew log — what earns an entry", () => {
  it("does not fire on a routine hop", () => {
    // The branch that keeps the feed from being a movement log with
    // adjectives. Eighteen hulls navigating is not eighteen stories.
    const events = detectCrewEvents(
      [ship("DAGGER-1")],
      [act({ kind: "navigate", detail: "DAGGER-1 → X1-AA-A3" })],
      { knownSystems: new Map([["DAGGER-1", new Set(["X1-AA"])]]) },
    );
    assert.deepEqual(events, []);
  });

  it("fires on the first arrival in a system it has not seen", () => {
    const events = detectCrewEvents(
      [ship("DAGGER-1")],
      [act({ kind: "navigate", detail: "DAGGER-1 → X1-AA-A3" })],
      { knownSystems: new Map() },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "arrival");
    assert.match(events[0]!.detail, /first arrival in X1-AA/);
  });

  it("scales a windfall to the fleet's own trading, not a fixed figure", () => {
    // 40,000 credits is a great day for a starter fleet and noise for a
    // mature one. A hardcoded threshold would go quiet exactly as the fleet
    // got interesting.
    const small = [
      act({ kind: "sell", credits: 1000 }), act({ kind: "sell", credits: 1200 }),
      act({ kind: "sell", credits: 5000 }),
    ];
    const hits = detectCrewEvents([ship("DAGGER-1")], small).filter((e) => e.kind === "windfall");
    assert.equal(hits.length, 1, "the 5,000 stands out against a median of 1,200");

    const big = [
      act({ kind: "sell", credits: 100_000 }), act({ kind: "sell", credits: 120_000 }),
      act({ kind: "sell", credits: 5000 }),
    ];
    const noHits = detectCrewEvents([ship("DAGGER-1")], big).filter((e) => e.kind === "windfall");
    assert.equal(noHits.length, 0, "the same 5,000 is noise for a fleet trading in hundreds of thousands");
  });

  it("ranks a stranded hull above everything else, and gives it one story", () => {
    const events = detectCrewEvents(
      [ship("DAGGER-1", { stranded: true, condition: 10, fuel: { current: 0, capacity: 400 } })],
      [],
    );
    assert.equal(events.length, 1, "stranded, broken and dry is one story, not three");
    assert.equal(events[0]!.kind, "stranded");
    assert.equal(events[0]!.notability, 100);
  });

  it("notices trouble that never reaches the activity feed", () => {
    // Low fuel and worn components are states, not events — nothing writes
    // an activity row for them, so a purely activity-driven feed would never
    // mention the hull that is quietly about to strand.
    const kinds = detectCrewEvents(
      [ship("DAGGER-1", { fuel: { current: 20, capacity: 400 }, condition: 30, crew: { current: 5, capacity: 40, morale: 12 } })],
      [],
    ).map((e) => e.kind);
    assert.deepEqual(new Set(kinds), new Set(["fuel", "condition", "morale"]));
  });
});

describe("crew log — the budget", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      shipSymbol: `DAGGER-${i}`, kind: "windfall" as const,
      notability: 100 - i, detail: "sold well", timestamp: "2026-09-05T08:00:00.000Z",
    }));

  it("writes nothing at all when the budget is zero", () => {
    // Un-adopted must mean off. The doctrine catalogue has been bitten
    // before by an "off" value that resolved to something permissive.
    assert.deepEqual(selectForLogging(many(10), { budget: 0 }), []);
  });

  it("spends a scarce budget on the most notable events", () => {
    const picked = selectForLogging(many(10), { budget: 3 });
    assert.equal(picked.length, 3);
    assert.deepEqual(picked.map((e) => e.shipSymbol), ["DAGGER-0", "DAGGER-1", "DAGGER-2"]);
  });

  it("gives one hull at most one entry per pass", () => {
    const events = [
      { shipSymbol: "D1", kind: "stranded" as const, notability: 100, detail: "a", timestamp: "t" },
      { shipSymbol: "D1", kind: "fuel" as const, notability: 90, detail: "b", timestamp: "t" },
      { shipSymbol: "D2", kind: "windfall" as const, notability: 70, detail: "c", timestamp: "t" },
    ];
    assert.deepEqual(selectForLogging(events, { budget: 5 }).map((e) => e.shipSymbol), ["D1", "D2"]);
  });

  it("keeps one loud hull from monopolising the feed", () => {
    // The reason a budget alone is not enough: a stranded ship stays
    // stranded, so it out-ranks everything on every pass forever and the
    // other seventeen never appear. The budget bounds cost; the cooldown is
    // what keeps this a fleet's voice.
    const now = 1_700_000_000_000;
    const events = [
      { shipSymbol: "D1", kind: "stranded" as const, notability: 100, detail: "a", timestamp: "t" },
      { shipSymbol: "D2", kind: "windfall" as const, notability: 40, detail: "c", timestamp: "t" },
    ];
    const picked = selectForLogging(events, {
      budget: 2, now, lastLoggedAt: new Map([["D1", now - 60_000]]),
    });
    assert.deepEqual(picked.map((e) => e.shipSymbol), ["D2"]);
  });

  it("lets a hull back in once its cooldown has passed", () => {
    const now = 1_700_000_000_000;
    const events = [{ shipSymbol: "D1", kind: "fuel" as const, notability: 60, detail: "a", timestamp: "t" }];
    const picked = selectForLogging(events, {
      budget: 2, now, lastLoggedAt: new Map([["D1", now - 30 * 60_000]]),
    });
    assert.equal(picked.length, 1);
  });
});

describe("personas", () => {
  it("has twenty, with unique keys", () => {
    assert.equal(PERSONAS.length, 20);
    assert.equal(new Set(PERSONAS.map((p) => p.key)).size, 20);
  });

  it("assigns the same captain to a hull every time", () => {
    // A fleet's cast has to survive a restart without a stored assignment,
    // or the crew you have been reading becomes strangers on every deploy.
    assert.equal(defaultPersonaFor("DAGGER-7").key, defaultPersonaFor("DAGGER-7").key);
    assert.ok(getPersona(defaultPersonaFor("DAGGER-7").key));
  });

  it("spreads a fleet across many captains rather than clustering", () => {
    const fleet = Array.from({ length: 18 }, (_, i) => defaultPersonaFor(`DAGGER-${i + 1}`).key);
    assert.ok(new Set(fleet).size >= 10, `expected a varied cast, got ${new Set(fleet).size} distinct`);
  });
});

describe("activity attribution", () => {
  it("names the hull that did it, not the fleet", async () => {
    // The bug the dry run surfaced: FleetManager wrapped every agent's
    // callback as `(kind, detail, credits) => onActivity(kind, ...)`,
    // dropping the fourth argument and prepending the symbol to the free
    // text instead. Every one of a day's 11,618 activity rows landed under
    // the pseudo-hull "fleet", so the ship_symbol column was dead: nothing
    // could filter activity by ship, and a per-hull history was not
    // derivable without parsing prose.
    //
    // Asserted against the source rather than a live fleet because the
    // regression is a dropped argument at a call site, which is exactly what
    // reading the call sites checks — and a runtime test would need a booted
    // tenant to catch one missing wrapper out of twenty-three.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/engine/fleet.ts", import.meta.url), "utf8");

    const wrappers = src.match(/onActivity: \(kind, detail, credits\) =>[^\n]*/g) ?? [];
    assert.ok(wrappers.length > 10, "expected the agent wrappers to still exist");
    for (const w of wrappers) {
      assert.match(w, /credits, (ship\.symbol|shipSymbol|sym)\)/, `wrapper drops the hull: ${w.trim()}`);
    }

    // Direct calls that name a hull in their text must pass it too.
    const direct = (src.match(/this\.onActivity\?\.\("[^\n]*/g) ?? [])
      .filter((c) => /\$\{(shipSymbol|ship\.symbol|s\.symbol|plan\.strandedSymbol)\}/.test(c));
    for (const c of direct) {
      assert.match(c, /, (shipSymbol|ship\.symbol|s\.symbol|sym|plan\.strandedSymbol)\);/,
        `names a hull in the text but files it under "fleet": ${c.trim()}`);
    }
  });
});
