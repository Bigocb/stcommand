import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TenantRegistry } from "../src/engine/tenantRegistry.js";
import { rateLimitMonitor } from "../src/core/rateLimitMonitor.js";

/**
 * The proxy lane's wiring in TenantRegistry: the environment decides whether a lane exists, the tenant's own doctrine clause
 * (apiLaneProxy) decides whether any call uses it, and api_budget can see it. No database: the registry is built on a stub pool.
 */
let saved: { url?: string; rate?: string };
before(() => {
  saved = { url: process.env.API_LANE_PROXY_URL, rate: process.env.API_LANE_PROXY_RATE };
});
after(() => {
  if (saved.url === undefined) delete process.env.API_LANE_PROXY_URL; else process.env.API_LANE_PROXY_URL = saved.url;
  if (saved.rate === undefined) delete process.env.API_LANE_PROXY_RATE; else process.env.API_LANE_PROXY_RATE = saved.rate;
});

// apiLaneCount (how many proxies are active) is on at 3 unless `count` is given; the value() stub answers each key separately.
const fakeDoctrine = (on: boolean, value = 3, count = 3) => ({ isEnabledOr: (k: string) => k === "apiLaneCount" || (k === "apiLaneProxy" && on), value: (k: string) => (k === "apiLaneCount" ? count : value) });
const make = () => new TenantRegistry({} as never, () => {}, undefined);

describe("TenantRegistry proxy lane", () => {
  it("no API_LANE_PROXY_URL: no lane is reported and the policy is off", () => {
    delete process.env.API_LANE_PROXY_URL;
    const r = make();
    assert.equal(rateLimitMonitor.snapshot().lane, undefined);
    assert.equal((r as any).lanePolicyFor("THEO").enabled, false);
  });

  it("a list of URLs gives a pool: every proxy shows by host:port with its own breaker and byte meter, none with credentials", () => {
    delete process.env.API_LANE_PROXY_URL;
    process.env.API_LANE_PROXY_URLS = "http://u:secretpass@a.example:1/,http://u:secretpass@b.example:2/|0.9";
    try {
      make();
      const lane = rateLimitMonitor.snapshot().lane as { proxy: string; activeProxies: number; configuredProxies: number; proxies: { id: string; proxy: string; ratePerMin: number; breaker: { open: boolean }; bytes: { projectedGBPerMonth: number } }[] };
      assert.equal(lane.configuredProxies, 2);
      assert.deepEqual(lane.proxies.map((p) => [p.id, p.proxy]), [["p1", "a.example:1"], ["p2", "b.example:2"]]);
      assert.equal(lane.proxies[1]!.ratePerMin, 54);
      assert.equal(lane.proxy, "a.example:1", "the old single-lane fields describe the first proxy");
      assert.equal(lane.proxies[0]!.bytes.projectedGBPerMonth, 0);
      assert.ok(!JSON.stringify(lane).includes("secret"));
    } finally { delete process.env.API_LANE_PROXY_URLS; }
  });

  it("with the URL set: the lane shows in the monitor by host:port only, never the credentials", () => {
    process.env.API_LANE_PROXY_URL = "http://secretuser:secretpass@lane.example:6014/";
    make();
    const lane = rateLimitMonitor.snapshot().lane as { proxy: string; ratePerMin: number; breaker: { open: boolean } };
    assert.equal(lane.proxy, "lane.example:6014");
    assert.ok(lane.ratePerMin > 0);
    assert.equal(lane.breaker.open, false);
    assert.ok(!JSON.stringify(lane).includes("secret"));
  });

  it("the policy follows the tenant's own doctrine clause, live, and is off for a tenant not booted yet", () => {
    process.env.API_LANE_PROXY_URL = "http://lane.example:6014/";
    const r = make();
    assert.equal((r as any).lanePolicyFor("THEO").enabled, false, "no worker yet");
    const w = { agentSymbol: "THEO", fleet: { doctrine: fakeDoctrine(false) } };
    (r as any).workers.set("t1", w);
    assert.equal((r as any).lanePolicyFor("THEO").enabled, false, "clause off");
    w.fleet.doctrine = fakeDoctrine(true, 4);
    assert.deepEqual((r as any).lanePolicyFor("THEO"), { enabled: true, minPriority: 4, active: 3 }, "clause on, value 4 = background only, three proxies active");
    w.fleet.doctrine = fakeDoctrine(true, 3, 2);
    assert.equal((r as any).lanePolicyFor("THEO").active, 2, "apiLaneCount sets how many proxies are active");
    assert.equal((r as any).lanePolicyFor("OTHER").enabled, false, "another tenant has its own clause");
  });
});
