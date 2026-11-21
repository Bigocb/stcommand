import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/** Screens read the route list through computeDispatchRoutesCached(); they must not start their own build while the core
 *  pass holds a fresh list (2026-11-21 SEV0). Called on a stand-in object so no FleetManager has to be built. */
const call = (self: object, maxAgeMs?: number) =>
  (FleetManager.prototype as unknown as { computeDispatchRoutesCached(this: object, m?: number): Promise<unknown[]> }).computeDispatchRoutesCached.call(self, maxAgeMs);

describe("screen route list", () => {
  it("uses the core pass's fresh list instead of building", async () => {
    let builds = 0;
    const self = { routesCache: undefined, coreRouteHold: { at: Date.now() - 30_000, buildMs: 8000, routes: [{ good: "A" }] }, computeDispatchRoutes: async () => { builds += 1; return [{ good: "B" }]; } };
    assert.deepEqual(await call(self), [{ good: "A" }]);
    assert.equal(builds, 0);
  });

  it("builds when neither its own cache nor the core list is fresh, and caches the result", async () => {
    let builds = 0;
    const self = { routesCache: undefined, coreRouteHold: { at: Date.now() - 300_000, buildMs: 8000, routes: [{ good: "A" }] }, computeDispatchRoutes: async () => { builds += 1; return [{ good: "B" }]; } };
    assert.deepEqual(await call(self), [{ good: "B" }]);
    assert.deepEqual(await call(self), [{ good: "B" }]);
    assert.equal(builds, 1);
  });

  it("hands out copies", async () => {
    const routes = [{ good: "A" }];
    const self = { routesCache: undefined, coreRouteHold: { at: Date.now(), buildMs: 1, routes }, computeDispatchRoutes: async () => [] };
    const got = await call(self);
    got.push({ good: "X" });
    assert.equal(routes.length, 1);
  });
});
