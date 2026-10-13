import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseHopMethod, DEFAULT_WARP_POLICY, pickWarpArrival, warpDriveRange } from "../src/engine/warpTour.js";

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
    assert.equal(c.fuelNeeded, 600); // ceil(500 * 1 * 1.2)
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
    assert.equal(c.fuelNeeded, 600);
    assert.match(c.reason, /needs about 600 fuel, has 500/);
  });

  it("goes through a gate when the distance is not known yet", () => {
    const c = chooseHopMethod(on, { warpRange: 2000, fuel: 800, distance: undefined });
    assert.equal(c.method, "gate");
    assert.match(c.reason, /distance .* isn.t known/);
  });

  it("applies the fuel margin, so exactly-enough fuel is not enough", () => {
    // 1000 units at 1.2 fuel per unit needs 1200; a 1199 tank must not warp.
    assert.equal(chooseHopMethod(on, { warpRange: 2000, fuel: 1199, distance: 1000 }).method, "gate");
    assert.equal(chooseHopMethod(on, { warpRange: 2000, fuel: 1200, distance: 1000 }).method, "warp");
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
