import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type ContractBuyTarget } from "../src/engine/dispatcher.js";

/**
 * Covers the "contractBuy" role added to close the contract-sourcing gap:
 * previously nothing ever proactively bought a good a contract needed
 * (wantsGood() was dead code with zero call sites) — this is the dispatcher
 * half of that fix. RouteDispatcher had no test coverage before this.
 */

describe("RouteDispatcher: contractBuy assignments", () => {
  it("assigns a contractBuy role from a contractBuyTarget, with no sell/warehouse leg", () => {
    const d = new RouteDispatcher();
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 20 }];

    d.recompute([], [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "contractBuy");
    assert.equal(a?.good, "IRON_ORE");
    assert.equal(a?.buyAt, "X1-A-M1");
    assert.equal(a?.sellAt, undefined);
  });

  it("skips a target with nothing outstanding (needed <= 0)", () => {
    const d = new RouteDispatcher();
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 0 }];

    d.recompute([], [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    assert.equal(d.assignmentFor("SHIP-1"), undefined);
  });

  it("reserves its own `${good}:contractBuy` key, distinct from an ordinary direct route on the same good", () => {
    const d = new RouteDispatcher();
    const routes = [{
      good: "IRON_ORE", buyAt: "X1-A-M1", buySystem: "X1-A", buyPrice: 10,
      sellAt: "X1-A-M2", sellSystem: "X1-A", sellPrice: 20, volume: 10, lotSize: 10,
      distance: 5, fuelUnits: 5, fuelCost: 5, profitPerTrip: 100, ageMinutes: 1,
    }];
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 20 }];

    d.recompute(routes, [
      { shipSymbol: "SHIP-1", capacity: 40 },
      { shipSymbol: "SHIP-2", capacity: 40 },
    ], [], [], [], targets);

    const roles = new Set([d.assignmentFor("SHIP-1")?.role, d.assignmentFor("SHIP-2")?.role]);
    assert.ok(roles.has("direct"), "the ordinary route must still be assignable");
    assert.ok(roles.has("contractBuy"), "the contract-buy target must also be assignable to a different ship");
  });

  it("a manual override on a good reserves it against auto contractBuy assignment too", () => {
    const d = new RouteDispatcher();
    d.setManual("SHIP-1", {
      shipSymbol: "SHIP-1", good: "IRON_ORE", role: "direct",
      buyAt: "X1-A-M1", sellAt: "X1-A-M2", profitPerTrip: 50, source: "manual",
    });
    const targets: ContractBuyTarget[] = [{ good: "IRON_ORE", buyAt: "X1-A-M1", buyPrice: 10, needed: 20 }];

    d.recompute([], [
      { shipSymbol: "SHIP-1", capacity: 40 },
      { shipSymbol: "SHIP-2", capacity: 40 },
    ], [], [], [], targets);

    assert.equal(d.assignmentFor("SHIP-2"), undefined, "IRON_ORE is reserved by SHIP-1's manual override, in every role");
  });
});

describe("RouteDispatcher: contractBuy priority reflects the contract's real payout, not just units left", () => {
  it("without a value, a nearly-finished contract's tiny shortfall loses out to an ordinary route (the bug)", () => {
    // Confirmed live: a COPPER contract down to its last 4 units scored
    // 4*100=400 — below an entirely ordinary IRON_ORE route's 1000 — so the
    // one available trader took the ordinary route and the contract's last
    // few units sat unclaimed. This test documents that old behavior still
    // happens when no `value` is supplied (e.g. a caller that hasn't been
    // updated); the next test shows the fix.
    const d = new RouteDispatcher();
    const routes = [{
      good: "IRON_ORE", buyAt: "X1-A-M1", buySystem: "X1-A", buyPrice: 10,
      sellAt: "X1-A-M2", sellSystem: "X1-A", sellPrice: 110, volume: 10, lotSize: 10,
      distance: 5, fuelUnits: 5, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
    }];
    const targets: ContractBuyTarget[] = [{ good: "COPPER", buyAt: "X1-A-M3", buyPrice: 10, needed: 4 }];

    d.recompute(routes, [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    assert.equal(d.assignmentFor("SHIP-1")?.good, "IRON_ORE", "the ordinary route still outranks the unvalued contract shortfall");
  });

  it("with a value, the same tiny shortfall outranks the ordinary route — completing the contract is worth more than one trip", () => {
    const d = new RouteDispatcher();
    const routes = [{
      good: "IRON_ORE", buyAt: "X1-A-M1", buySystem: "X1-A", buyPrice: 10,
      sellAt: "X1-A-M2", sellSystem: "X1-A", sellPrice: 110, volume: 10, lotSize: 10,
      distance: 5, fuelUnits: 5, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
    }];
    // Same 4-unit shortfall as above, but now the caller supplies the
    // contract's real onFulfilled payout (27,219c, matching the live
    // COPPER contract this was found on) via `value`.
    const targets: ContractBuyTarget[] = [{ good: "COPPER", buyAt: "X1-A-M3", buyPrice: 10, needed: 4, value: 27219 }];

    d.recompute(routes, [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], targets);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.good, "COPPER", "finishing the contract must now outrank the ordinary route");
    assert.equal(a?.profitPerTrip, 400, "the assignment's displayed profitPerTrip stays the needed*100 estimate — the 27,219c payout is a completion bonus, not a real per-trip figure, and must not be shown as one");
  });
});

describe("RouteDispatcher: only assigns reachable direct routes", () => {
  it("does not assign an unreachable direct route to a ship in a different system", () => {
    const d = new RouteDispatcher();
    const unreachable = {
      good: "CLOTHING", buyAt: "X1-YN70-K90", buySystem: "X1-YN70", buyPrice: 100,
      sellAt: "X1-YN70-A1", sellSystem: "X1-YN70", sellPrice: 200,
      volume: 10, lotSize: 10, distance: 10, fuelUnits: 10, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
    };

    d.recompute([unreachable], [{ shipSymbol: "SHIP-1", capacity: 40, system: "X1-S84" }], [], [], [], [], () => false);

    assert.equal(d.assignmentFor("SHIP-1"), undefined, "a ship in X1-S84 must not be assigned a route it cannot jump to");
  });

  it("assigns a direct route that is reachable via a completed jump gate", () => {
    const d = new RouteDispatcher();
    const reachable = {
      good: "CLOTHING", buyAt: "X1-YN70-K90", buySystem: "X1-YN70", buyPrice: 100,
      sellAt: "X1-YN70-A1", sellSystem: "X1-YN70", sellPrice: 200,
      volume: 10, lotSize: 10, distance: 10, fuelUnits: 10, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
    };

    d.recompute([reachable], [{ shipSymbol: "SHIP-1", capacity: 40, system: "X1-S84" }], [], [], [], [], () => true);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "direct");
    assert.equal(a?.good, "CLOTHING");
  });
});

describe("RouteDispatcher: same-system routes still need a fuel-distance check", () => {
  // Confirmed live: DRAGOM-3 (80-unit tank) was assigned an AMMUNITION leg
  // whose buy waypoint sat 99 units away — same system as the ship, so the
  // old reachable() check (system membership only) waved it through. The
  // trader's own whyNotViable() rejected it a cycle later, but the
  // assignment was already burned. distanceBetween closes that gap.
  const farLeg = {
    good: "AMMUNITION", buyAt: "X1-S84-E51", buySystem: "X1-S84", buyPrice: 50,
    sellAt: "X1-S84-F53", sellSystem: "X1-S84", sellPrice: 100,
    volume: 10, lotSize: 10, distance: 5, fuelUnits: 5, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
  };

  it("does not assign a same-system route whose buy leg exceeds the ship's own fuel capacity", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farLeg],
      [{ shipSymbol: "DRAGOM-3", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 80 }],
      [], [], [], [],
      () => false,
      (a, b) => (a === "X1-S84-H56" && b === "X1-S84-E51" ? 99 : 0),
    );

    assert.equal(d.assignmentFor("DRAGOM-3"), undefined, "99 units needed against an 80-unit tank must not be offered");
  });

  it("still assigns the same route to a ship (or from a position) that can actually make it", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farLeg],
      [{ shipSymbol: "DRAGOM-9", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 600 }],
      [], [], [], [],
      () => false,
      (a, b) => (a === "X1-S84-H56" && b === "X1-S84-E51" ? 99 : 0),
    );

    assert.equal(d.assignmentFor("DRAGOM-9")?.good, "AMMUNITION");
  });

  it("without a distanceBetween predicate, stays distance-blind — the safe default for an unmigrated caller", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farLeg],
      [{ shipSymbol: "DRAGOM-3", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 80 }],
    );

    assert.equal(d.assignmentFor("DRAGOM-3")?.good, "AMMUNITION", "no predicate supplied means the old behavior, not every route rejected");
  });

  // 2026-09-21, operator request: a leg beyond single-hop range no longer
  // has to be flatly rejected — ShipProxy.navigateTo() already reroutes
  // through a known fuel stop (or falls back to DRIFT) once a ship is
  // actually flying the leg, so the dispatcher shouldn't withhold the work
  // item from every idle trader just because none of them can cover it in
  // one hop. hasFuelStop() is how a caller tells reachable() a relay exists.
  it("still offers a buy leg beyond the tank when the caller confirms a fuel-stop relay exists", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farLeg],
      [{ shipSymbol: "DRAGOM-3", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 80 }],
      [], [], [], [],
      () => false,
      (a, b) => (a === "X1-S84-H56" && b === "X1-S84-E51" ? 99 : 0),
      undefined,
      (system, from, to) => system === "X1-S84" && from === "X1-S84-H56" && to === "X1-S84-E51",
    );

    assert.equal(d.assignmentFor("DRAGOM-3")?.good, "AMMUNITION", "a confirmed relay must be enough, not just a direct-only check");
  });

  it("still rejects the buy leg when hasFuelStop confirms no relay exists either", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farLeg],
      [{ shipSymbol: "DRAGOM-3", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 80 }],
      [], [], [], [],
      () => false,
      (a, b) => (a === "X1-S84-H56" && b === "X1-S84-E51" ? 99 : 0),
      undefined,
      () => false,
    );

    assert.equal(d.assignmentFor("DRAGOM-3"), undefined, "hasFuelStop confirming no relay must still reject, exactly as before");
  });
});

describe("RouteDispatcher: the sell leg needs the same fuel-distance check as the buy leg", () => {
  // Confirmed live: THEO-11 (80-unit tank) sat right next to the buy
  // waypoint — the old reachable() check above only looks at the leg from
  // the ship's current position to buyAt, so it passed — but
  // buyAt->sellAt was 91 units, further than THEO-11 could ever fly on a
  // full tank. It was assigned the identical unreachable route on three
  // separate recomputes, rejected a cycle later each time inside
  // TraderAgent's own findRoute(), while 14 other same-system routes it
  // could actually fly sat unused in the same work list.
  const farApartLeg = {
    good: "ADVANCED_CIRCUITRY", buyAt: "X1-S84-D43", buySystem: "X1-S84", buyPrice: 50,
    sellAt: "X1-S84-A4", sellSystem: "X1-S84", sellPrice: 100,
    volume: 10, lotSize: 10, distance: 5, fuelUnits: 5, fuelCost: 0, profitPerTrip: 1000, ageMinutes: 1,
  };
  const dist = (a: string, b: string): number => {
    if (a === "X1-S84-H56" && b === "X1-S84-D43") return 5; // ship to buyAt: easily in range
    if (a === "X1-S84-D43" && b === "X1-S84-A4") return 91; // buyAt to sellAt: not
    return 0;
  };

  it("does not assign a direct route whose sell leg exceeds the ship's fuel capacity, even when the buy leg is in range", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farApartLeg],
      [{ shipSymbol: "THEO-11", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 80 }],
      [], [], [], [],
      () => false,
      dist,
    );

    assert.equal(d.assignmentFor("THEO-11"), undefined, "a 91-unit sell leg against an 80-unit tank must not be offered");
  });

  it("still assigns it to a ship whose tank covers the whole round trip", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farApartLeg],
      [{ shipSymbol: "THEO-B", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 600 }],
      [], [], [], [],
      () => false,
      dist,
    );

    assert.equal(d.assignmentFor("THEO-B")?.good, "ADVANCED_CIRCUITRY");
  });

  it("still offers a sell leg beyond the tank when the caller confirms a fuel-stop relay exists", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [farApartLeg],
      [{ shipSymbol: "THEO-11", capacity: 15, system: "X1-S84", waypoint: "X1-S84-H56", fuelCapacity: 80 }],
      [], [], [], [],
      () => false,
      dist,
      undefined,
      (system, from, to) => system === "X1-S84" && from === "X1-S84-D43" && to === "X1-S84-A4",
    );

    assert.equal(d.assignmentFor("THEO-11")?.good, "ADVANCED_CIRCUITRY", "a confirmed relay must be enough for the sell leg too");
  });

  it("does not apply the sell-leg check across a jump — that leg is a gate transit, not a fuel-distance flight", () => {
    const crossLeg = {
      good: "MEDICINE", buyAt: "X1-B48-BX4A", buySystem: "X1-B48", buyPrice: 2682,
      sellAt: "X1-XB94-J58", sellSystem: "X1-XB94", sellPrice: 5094,
      volume: 60, lotSize: 60, distance: 0, fuelUnits: 0, fuelCost: 0, profitPerTrip: 139651, ageMinutes: 112,
    };
    const d = new RouteDispatcher();
    d.recompute(
      [crossLeg],
      [{ shipSymbol: "THEO-1", capacity: 40, system: "X1-B48", waypoint: "X1-B48-BX4A", fuelCapacity: 400 }],
      [], [], [], [],
      () => true, // gate confirmed open
      (a, b) => (a === b ? 0 : 999999), // would fail any real same-system distance check — must not be consulted for a cross-system leg
    );

    assert.equal(d.assignmentFor("THEO-1")?.good, "MEDICINE");
  });
});

describe("RouteDispatcher: cross-system direct routes", () => {
  it("without a canJump predicate, never assigns a cross-system route as 'direct' — the safe default when reachability is unknown", () => {
    const d = new RouteDispatcher();
    const crossSystem = {
      good: "COPPER", buyAt: "X1-SS66-H48", buySystem: "X1-SS66", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, lotSize: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    d.recompute([crossSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }]);

    assert.equal(d.assignmentFor("SHIP-1"), undefined, "no ship should be assigned a route no trader can actually fly");
  });

  it("assigns a cross-system route as 'direct' once the caller's canJump predicate says the gate is open", () => {
    const d = new RouteDispatcher();
    const crossSystem = {
      good: "COPPER", buyAt: "X1-SS66-H48", buySystem: "X1-SS66", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, lotSize: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    d.recompute([crossSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], [], () => true);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "direct", "a completed gate makes the round trip flyable, so 'direct' is no longer refused outright");
    assert.equal(a?.good, "COPPER");
  });

  it("still refuses a cross-system route as 'direct' when canJump reports that specific gate pair as not open, even with a predicate wired up", () => {
    const d = new RouteDispatcher();
    const crossSystem = {
      good: "COPPER", buyAt: "X1-SS66-H48", buySystem: "X1-SS66", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, lotSize: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    // A predicate that only recognizes a different system pair — this gate
    // pair still reads as not jumpable.
    d.recompute([crossSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }], [], [], [], [], (a, b) => a === "X1-OTHER" && b === "X1-TQ19");

    assert.equal(d.assignmentFor("SHIP-1"), undefined);
  });

  it("still assigns a same-system route as 'direct', unaffected", () => {
    const d = new RouteDispatcher();
    const sameSystem = {
      good: "COPPER", buyAt: "X1-TQ19-H48", buySystem: "X1-TQ19", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, lotSize: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    d.recompute([sameSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }]);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "direct");
    assert.equal(a?.good, "COPPER");
  });

  it("a cross-system route with a warehouse target can still be assigned as buy/sell (single-leg roles, unaffected by the direct-only restriction)", () => {
    const d = new RouteDispatcher();
    const crossSystem = {
      good: "COPPER", buyAt: "X1-SS66-H48", buySystem: "X1-SS66", buyPrice: 255,
      sellAt: "X1-TQ19-A3", sellSystem: "X1-TQ19", sellPrice: 277,
      volume: 60, lotSize: 60, distance: 10, fuelUnits: 10, fuelCost: 720, profitPerTrip: 1320, ageMinutes: 1,
    };

    d.recompute([crossSystem], [{ shipSymbol: "SHIP-1", capacity: 40 }], [{ good: "COPPER", target: 100, balance: 0 }]);

    const a = d.assignmentFor("SHIP-1");
    assert.equal(a?.role, "buy", "buy/sell legs are single-system-side, not a same-ship round trip — the cross-system restriction only applies to 'direct'");
  });
});

describe("RouteDispatcher: idle traders and sell-market spreading", () => {
  const route = (good: string, sellAt: string, profit: number, buyAt = "X1-A-BUY") => ({
    good, buyAt, buySystem: "X1-A", buyPrice: 100,
    sellAt, sellSystem: "X1-A", sellPrice: 100 + profit,
    volume: 10, lotSize: 10, distance: 10, fuelUnits: 10, fuelCost: 0,
    profitPerTrip: profit, ageMinutes: 1,
  });
  const traders = (n: number) => Array.from({ length: n }, (_, i) => ({ shipSymbol: `T${i + 1}`, capacity: 40 }));

  it("puts idle traders on the same good when they sell into different markets", () => {
    // Six traders and one profitable good used to mean five idle hulls: the
    // work list emitted exactly one item per good, and a direct assignment
    // reserved the whole good.
    const d = new RouteDispatcher();
    d.recompute([route("IRON", "X1-A-M1", 900), route("IRON", "X1-A-M2", 700), route("IRON", "X1-A-M3", 500)], traders(3));
    const assigned = d.list();
    assert.equal(assigned.length, 3, "every trader gets work");
    assert.deepEqual([...new Set(assigned.map((a) => a.sellAt))].sort(), ["X1-A-M1", "X1-A-M2", "X1-A-M3"]);
  });

  it("never puts two traders into the same sell market, which is what collapses a price", () => {
    const d = new RouteDispatcher();
    // Two routes for the same good AND the same destination: only one is work.
    d.recompute([route("IRON", "X1-A-M1", 900), route("IRON", "X1-A-M1", 800, "X1-A-BUY2")], traders(3));
    assert.equal(d.list().length, 1);
  });

  it("still ranks by profit, so the best route is taken first", () => {
    const d = new RouteDispatcher();
    d.recompute([route("IRON", "X1-A-M1", 200), route("GOLD", "X1-A-M9", 5000)], traders(1));
    const [only] = d.list();
    assert.equal(only!.good, "GOLD", "the single trader takes the most valuable work");
  });

  it("doesn't hand a busy trader's exact leg to a second, idle trader", (t) => {
    // Confirmed live: THEO-B was mid-haul on CLOTHING X1-XB94-K87 ->
    // X1-XB94-A1 (bought, in flight, not yet sold) when the very next
    // recompute handed THEO-A the identical CLOTHING/A1 route fresh. The
    // busy-carry-forward reservation keys on the qualified `good@sellAt`,
    // but the new best-route work item for that good was keyed on the bare
    // good with no market qualifier, so the two never collided.
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    // Cycle 1: T1 idle, gets the only CLOTHING route.
    d.recompute([route("CLOTHING", "X1-A-M1", 900)], [{ shipSymbol: "T1", capacity: 40 }]);
    assert.equal(d.list().length, 1);
    t.mock.timers.tick(60_001); // past recompute()'s own 60s throttle
    // Cycle 2: T1 now busy (mid-haul on that same route), T2 shows up idle.
    // The only known route is still the identical CLOTHING/M1 leg.
    d.recompute(
      [route("CLOTHING", "X1-A-M1", 900)],
      [{ shipSymbol: "T1", capacity: 40, busy: true }, { shipSymbol: "T2", capacity: 40 }],
    );
    const assigned = d.list();
    assert.equal(assigned.length, 1, "T2 must not get the leg T1 is already flying");
    assert.equal(assigned[0]!.shipSymbol, "T1");
  });

  it("still lets a second trader take the same good into a genuinely different market while the first is busy", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recompute([route("CLOTHING", "X1-A-M1", 900)], [{ shipSymbol: "T1", capacity: 40 }]);
    t.mock.timers.tick(60_001);
    d.recompute(
      [route("CLOTHING", "X1-A-M1", 900), route("CLOTHING", "X1-A-M2", 700, "X1-A-BUY2")],
      [{ shipSymbol: "T1", capacity: 40, busy: true }, { shipSymbol: "T2", capacity: 40 }],
    );
    const assigned = d.list();
    assert.equal(assigned.length, 2);
    assert.deepEqual(assigned.map((a) => a.sellAt).sort(), ["X1-A-M1", "X1-A-M2"]);
  });
});

describe("RouteDispatcher: recordSale() decays a market's ranking, not just a flat cooldown", () => {
  const route = (good: string, sellAt: string, profit: number, volume = 40, buyAt = "X1-A-BUY") => ({
    good, buyAt, buySystem: "X1-A", buyPrice: 100,
    sellAt, sellSystem: "X1-A", sellPrice: 100 + profit,
    volume, lotSize: volume, distance: 10, fuelUnits: 10, fuelCost: 0,
    profitPerTrip: profit, ageMinutes: 1,
  });

  it("prefers a fresher, lower-profit market over one it just dumped a full trip's worth of volume into", (t) => {
    // Confirmed live: THEO's fleet ran up 3.6M credits in ~30 minutes
    // system-wide and every route went to zero profit at once — a flat
    // per-route cooldown only reacts once a specific route is sold into,
    // it doesn't discourage the fleet from converging on a market before
    // that. Here M1 (900/trip) has already absorbed a full 40u trip; M2
    // (700/trip, nominally worse) hasn't been touched, so the decayed
    // score should flip the ranking even though the raw numbers wouldn't.
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordSale("IRON", "X1-A-M1", 40);
    d.recompute([route("IRON", "X1-A-M1", 900), route("IRON", "X1-A-M2", 700)], [{ shipSymbol: "T1", capacity: 40 }]);
    const [only] = d.list();
    assert.equal(only!.sellAt, "X1-A-M2", "the untouched market wins despite the lower on-paper profit");
  });

  it("a route with no recent sales into it ranks by its own real profitPerTrip, unaffected", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recompute([route("IRON", "X1-A-M1", 900), route("IRON", "X1-A-M2", 700)], [{ shipSymbol: "T1", capacity: 40 }]);
    const [only] = d.list();
    assert.equal(only!.sellAt, "X1-A-M1");
    assert.equal(only!.profitPerTrip, 900, "the assignment's displayed profit is the real figure, never discounted");
  });

  it("a market's fatigue fades once the recent-sales window ages the volume out", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordSale("IRON", "X1-A-M1", 40);
    t.mock.timers.tick(30 * 60_000 + 1); // past the volume-tracking window
    d.recompute([route("IRON", "X1-A-M1", 900), route("IRON", "X1-A-M2", 700)], [{ shipSymbol: "T1", capacity: 40 }]);
    const [only] = d.list();
    assert.equal(only!.sellAt, "X1-A-M1", "old sales no longer count against the market once they've aged out");
  });

  it("a heavily-sold route still wins if it's the only one for its good", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordSale("IRON", "X1-A-M1", 400); // ten trips' worth
    d.recompute([route("IRON", "X1-A-M1", 900)], [{ shipSymbol: "T1", capacity: 40 }]);
    assert.equal(d.list().length, 1, "no trader sits idle just because the only route is fatigued");
  });
});
