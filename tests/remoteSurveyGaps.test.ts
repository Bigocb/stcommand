import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

// maybeRemoteSurvey run against a stand-in `this`: only the members the pass touches.
function fake(opts: { waypoints: { symbol: string; traits: { symbol: string }[] }[]; directory: string[]; judge: () => Promise<void> }) {
  const retry = new Map<string, number>();
  const logs: string[] = [];
  const self: any = {
    doctrine: { isEnabledOr: () => true, value: (k: string) => (k === "remoteSurveyPerPass" ? 1 : 0) },
    store: {
      directorySystems: async () => new Set(opts.directory),
      recentSystemSurveys: async () => [],
      recordMarketDirectory: async () => {},
      recordShipyardDirectory: async () => {},
    },
    timers: () => ({ load: async () => {}, save: async () => {} }),
    tenantId: "t",
    lastRemoteSurveyAt: 0,
    systemSymbol: "X1-HOME",
    systemQueue: { list: () => [], get: () => undefined },
    remoteSurveyRetry: retry,
    markets: [],
    galaxy: {
      connectedSystems: (u: string) => (u === "X1-HOME" ? ["X1-AA"] : []),
      canJump: () => true,
      loadSystem: async () => {},
      surveyMarkets: async () => opts.waypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE")).map((w) => ({ symbol: w.symbol })),
      surveyShipyards: async () => opts.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD")).map((w) => ({ symbol: w.symbol, shipTypes: [] })),
      getSystem: () => ({ waypoints: opts.waypoints }),
    },
    refreshTraitsIfEmpty: async () => {},
    judgeAndIntake: opts.judge,
    log: (m: string) => logs.push(m),
  };
  return { self, retry, logs };
}
const run = (self: any) => (FleetManager.prototype as any).maybeRemoteSurvey.call(self);
const market = { symbol: "X1-AA-M1", traits: [{ symbol: "MARKETPLACE" }] };
const yard = { symbol: "X1-AA-Y1", traits: [{ symbol: "SHIPYARD" }] };

describe("maybeRemoteSurvey gaps", () => {
  it("retries a system whose read was saved but whose intake threw", async () => {
    let calls = 0;
    const { self, retry } = fake({ waypoints: [market], directory: ["X1-AA"], judge: async () => { calls++; } });
    retry.set("X1-AA", 0); // a failed intake left a retry entry that is due
    await run(self);
    assert.equal(calls, 1, "the saved-but-unjudged system is picked again");
    assert.equal(retry.has("X1-AA"), false, "a finished read clears the retry entry");
  });

  it("keeps a system whose intake throws on a 2 h retry", async () => {
    const { self, retry } = fake({ waypoints: [market], directory: [], judge: async () => { throw new Error("boom"); } });
    await run(self);
    assert.ok((retry.get("X1-AA") ?? 0) > Date.now() + 3_600_000);
  });

  it("leaves a yard-only system alone for hours instead of reading it every pass", async () => {
    const { self, retry } = fake({ waypoints: [yard], directory: [], judge: async () => {} });
    await run(self);
    assert.ok((retry.get("X1-AA") ?? 0) > Date.now() + 5 * 3_600_000);
  });
});
