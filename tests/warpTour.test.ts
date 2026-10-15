import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseHopMethod, cruiseNeedFromGame, DEFAULT_WARP_POLICY, parseFuelShortfall, pickWarpArrival, warpDriveRange, warpRouteKey } from "../src/engine/warpTour.js";

const on = DEFAULT_WARP_POLICY;

describe("warpDriveRange", () => {
  it("reads the range of an installed warp drive, ignoring other modules", () => {
    assert.equal(warpDriveRange([{ symbol: "MODULE_CARGO_HOLD_II" }, { symbol: "MODULE_WARP_DRIVE_I", range: 2000 }]), 2000);
  });

  it("is undefined when the ship has no warp drive", () => {
    assert.equal(warpDriveRange([{ symbol: "MODULE_JUMP_DRIVE_I", range: 500 }]), undefined);
    assert.equal(warpDriveRange(undefined), undefined);
  });

  it("treats a drive with no reported range as unlimited rather than zero", () => {
    assert.equal(warpDriveRange([{ symbol: "MODULE_WARP_DRIVE_II" }]), Number.POSITIVE_INFINITY);
  });
});

describe("chooseHopMethod", () => {
  it("warps when the target is in range and the tank covers the estimate", () => {
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 800, distance: 500 });
    assert.equal(c.method, "warp");
    assert.equal(c.flightMode, "CRUISE");
    assert.equal(c.fuelNeeded, 525); // ceil(500 * 1 * 1.05)
  });

  it("goes through a gate when the ship has no warp drive, whatever else is true", () => {
    const c = chooseHopMethod(on, { warpRange: undefined, fuel: 800, distance: 10 });
    assert.equal(c.method, "gate");
    assert.match(c.reason, /no warp drive/);
  });

  it("goes through a gate when the doctrine toggle is off, even with a warp drive and range", () => {
    const c = chooseHopMethod({ ...on, enabled: false }, { warpRange: 2000, fuel: 800, distance: 100 });
    assert.equal(c.method, "gate");
    assert.match(c.reason, /switched off/);
  });

  it("goes through a gate when the target is beyond warp range", () => {
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 800, distance: 2500 });
    assert.equal(c.method, "gate");
    assert.match(c.reason, /beyond warp range 2000/);
  });

  it("goes through a gate when the tank is short of the estimated warp fuel", () => {
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 500, distance: 500 });
    assert.equal(c.method, "gate");
    assert.equal(c.fuelNeeded, 525);
    assert.match(c.reason, /needs about 525 fuel at cruise, has 500/);
  });

  it("goes through a gate when the distance is not known yet", () => {
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 800, distance: undefined });
    assert.equal(c.method, "gate");
    assert.match(c.reason, /distance .* isn.t known/);
  });

  it("applies the fuel margin to an estimate, so exactly-enough fuel is not enough", () => {
    // 1000 units at 1.05 per unit needs 1050; a 1049 tank must not warp.
    assert.equal(chooseHopMethod(on, { warpRange: 2000, fuel: 1049, distance: 1000 }).method, "gate");
    assert.equal(chooseHopMethod(on, { warpRange: 2000, fuel: 1050, distance: 1000 }).method, "warp");
  });

  // Live 2026-10-15: THEOREM-86 (tank 800) failed every warp X1-GJ35 -> X1-FY6 in BURN, "requires 362 more fuel" at
  // 798, so 1,160 at BURN and 580 at CRUISE. The fix is to warp at CRUISE, which fits.
  it("warps at CRUISE when BURN would not fit, using the need the game reported", () => {
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 798, capacity: 800, distance: 581, knownCruiseNeed: 580 });
    assert.equal(c.method, "warp");
    assert.equal(c.flightMode, "CRUISE");
    assert.equal(c.fuelNeeded, 580);
    assert.match(c.reason, /the game says 580 fuel at cruise/);
  });

  it("picks BURN only when it fits with a quarter tank left over", () => {
    assert.equal(chooseHopMethod(on, { warpRange: 2000, fuel: 800, capacity: 800, distance: 200 }).flightMode, "BURN"); // 420 burn, 380 left
    assert.equal(chooseHopMethod(on, { warpRange: 2000, fuel: 800, capacity: 800, distance: 300 }).flightMode, "CRUISE"); // 630 burn, 170 left < 200
  });

  it("says when a warp can never fit the tank, so it stops being retried", () => {
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 800, capacity: 800, knownCruiseNeed: 900 });
    assert.equal(c.method, "gate");
    assert.match(c.reason, /more than the 800 tank holds/);
  });

  it("uses a reported need even when the distance is unknown", () => {
    assert.equal(chooseHopMethod(on, { warpRange: 2000, fuel: 700, capacity: 800, knownCruiseNeed: 600 }).method, "warp");
  });

  it("prefers the reported need over the distance estimate", () => {
    // The estimate would say 525 for 500 units; the game said 700.
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 600, capacity: 800, distance: 500, knownCruiseNeed: 700 });
    assert.equal(c.method, "gate");
    assert.equal(c.fuelNeeded, 700);
  });
});

describe("pickWarpArrival", () => {
  it("prefers a market or shipyard over a jump gate or a plain waypoint", () => {
    const wps = [
      { symbol: "X1-A-1", type: "PLANET" },
      { symbol: "X1-A-2", type: "JUMP_GATE" },
      { symbol: "X1-A-3", type: "ORBITAL_STATION", traits: [{ symbol: "MARKETPLACE" }] },
    ];
    assert.equal(pickWarpArrival(wps), "X1-A-3");
  });

  it("falls back to the jump gate, then to any waypoint", () => {
    assert.equal(pickWarpArrival([{ symbol: "X1-A-1", type: "PLANET" }, { symbol: "X1-A-2", type: "JUMP_GATE" }]), "X1-A-2");
    assert.equal(pickWarpArrival([{ symbol: "X1-A-1", type: "PLANET" }]), "X1-A-1");
  });

  it("returns undefined for a system with no waypoints", () => {
    assert.equal(pickWarpArrival([]), undefined);
  });
});

describe("learning the real warp fuel from the game", () => {
  it("reads the shortfall from a rejection message", () => {
    assert.equal(parseFuelShortfall("Navigate request failed. Ship THEOREM-86 requires 362 more fuel for navigation."), 362);
    assert.equal(parseFuelShortfall("Ship is not currently in orbit"), undefined);
  });

  it("converts a BURN need or burn back to CRUISE, and leaves CRUISE as is", () => {
    assert.equal(cruiseNeedFromGame(798 + 362, "BURN"), 580);
    assert.equal(cruiseNeedFromGame(638 + 230, "BURN"), 434);
    assert.equal(cruiseNeedFromGame(580, "CRUISE"), 580);
    assert.equal(cruiseNeedFromGame(580, undefined), 580);
  });

  it("keys a learned need by direction", () => {
    assert.notEqual(warpRouteKey("X1-GJ35", "X1-FY6"), warpRouteKey("X1-FY6", "X1-GJ35"));
  });
});
