import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windDown } from "../src/engine/resetWindDown.js";

const MIN = 60_000;
const RESET = Date.parse("2026-10-17T12:00:00Z");
const on = { enabled: true, minutes: 60 };

describe("windDown", () => {
  it("is never active while the clause is off, however close the reset is", () => {
    const s = windDown(RESET - 5 * MIN, RESET, { enabled: false, minutes: 60 });
    assert.equal(s.active, false);
    assert.equal(s.reason, "reset wind-down is off");
  });

  it("is inactive while the next reset is unknown", () => {
    assert.equal(windDown(RESET, undefined, on).active, false);
    assert.equal(windDown(RESET, Number.NaN, on).active, false);
  });

  it("opens exactly at the window's start and stays open until the reset", () => {
    assert.equal(windDown(RESET - 61 * MIN, RESET, on).active, false, "one minute before the window");
    assert.equal(windDown(RESET - 60 * MIN, RESET, on).active, true, "the window's first instant");
    assert.equal(windDown(RESET - 1 * MIN, RESET, on).active, true, "a minute before reset");
  });

  it("closes once the reset has passed, so a stale reset time cannot keep the fleet idle", () => {
    const s = windDown(RESET + MIN, RESET, on);
    assert.equal(s.active, false);
    assert.equal(s.reason, "the reset has passed");
  });

  it("honours the window length from doctrine", () => {
    assert.equal(windDown(RESET - 30 * MIN, RESET, { enabled: true, minutes: 20 }).active, false);
    assert.equal(windDown(RESET - 30 * MIN, RESET, { enabled: true, minutes: 45 }).active, true);
  });

  it("says in one line why it is or isn't open", () => {
    assert.match(windDown(RESET - 42 * MIN, RESET, on).reason, /reset in 42 min: no new buys/);
    assert.match(windDown(RESET - 3 * 60 * MIN, RESET, on).reason, /reset in 180 min, wind-down opens at 60 min/);
  });
});

// The seam: TraderAgent.tick() must start no trip in the window, and must still sell a loaded hull.
import { TraderAgent } from "../src/engine/trader.js";

describe("TraderAgent.tick() during the wind-down", () => {
  function trader(opts: { blocked: boolean; units: number; role?: "sell" | "buy" | "direct" }) {
    const ship = {
      symbol: "THEO-T", nav: { systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", status: "DOCKED" },
      cargo: { capacity: 40, units: opts.units, inventory: opts.units ? [{ symbol: "IRON", units: opts.units }] : [] },
      fuel: { current: 100, capacity: 100 },
    };
    const t = new TraderAgent(ship as any, {
      api: {} as any,
      buysBlocked: () => opts.blocked,
      assignedRoute: opts.role ? () => ({ role: opts.role, good: "IRON", buyAt: "X1-A-A1", sellAt: "X1-A-B2" } as any) : undefined,
    } as any);
    const ran: string[] = [];
    const stub = (name: string) => { (t as any)[name] = async () => { ran.push(name); return true; }; };
    (t as any).refresh = async () => {};
    (t as any).loadSnapshots = async () => {};
    (t as any).clearLeftoverCargo = async () => undefined;
    stub("runArbitrage"); stub("runBuy"); stub("runSell");
    return { t, ran };
  }

  it("an empty hull starts no arbitrage trip while the window is open", async () => {
    const { t, ran } = trader({ blocked: true, units: 0 });
    assert.equal(await t.tick(), false);
    assert.deepEqual(ran, [], "no buy-side handler may run");
  });

  it("a loaded hull with a sell leg still sells", async () => {
    const { t, ran } = trader({ blocked: true, units: 20, role: "sell" });
    await t.tick();
    assert.deepEqual(ran, ["runSell"]);
  });

  it("a loaded hull with a buy leg does not buy more", async () => {
    const { t, ran } = trader({ blocked: true, units: 20, role: "buy" });
    assert.equal(await t.tick(), false);
    assert.deepEqual(ran, []);
  });

  it("a loaded hull with a direct (buy-then-sell) assignment sells what it holds and starts no new buy", async () => {
    // 2026-10-25: almost every trader holds a "direct" assignment. They stopped at the wind-down gate with full holds
    // and sold nothing for an hour (14 ships, ~4.4M of cargo that the reset destroys).
    const { t, ran } = trader({ blocked: true, units: 20, role: "direct" });
    (t as any).deliverHeldCargo = async () => { ran.push("deliverHeldCargo"); return true; };
    assert.equal(await t.tick(), true);
    assert.deepEqual(ran, ["deliverHeldCargo"], "the held cargo is sold; runArbitrage and runBuy must not run");
  });

  it("a loaded direct hull whose cargo has nothing to deliver idles instead of falling through to a buy", async () => {
    const { t, ran } = trader({ blocked: true, units: 20, role: "direct" });
    (t as any).deliverHeldCargo = async () => undefined;
    assert.equal(await t.tick(), false);
    assert.deepEqual(ran, []);
  });

  it("with the window closed, the same empty hull trades as before (control)", async () => {
    const { t, ran } = trader({ blocked: false, units: 0 });
    await t.tick();
    assert.deepEqual(ran, ["runArbitrage"]);
  });
});
