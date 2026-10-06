import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * The coordinator used to be one serial tick(): dispatch, then every purchase
 * check, then feeds and missions, then the syncs. One slow step — in
 * production feeds.tick() reached 25 minutes once the API rate limiter backed
 * up — held the whole pass, so traders waited that long for their next
 * route. run() now drives three loops (core / feeds / maintenance) that only
 * ever wait on themselves.
 */

const STATICS = ["CORE_INTERVAL_MS", "FEEDS_INTERVAL_MS", "MAINTENANCE_INTERVAL_MS", "TICK_WARN_MS"] as const;
const saved = new Map<string, number>();

beforeEach(() => {
  for (const k of STATICS) saved.set(k, (FleetManager as any)[k]);
  // `static readonly` is a compile-time promise only; shrink the pauses so the test is quick.
  (FleetManager as any).CORE_INTERVAL_MS = 5;
  (FleetManager as any).FEEDS_INTERVAL_MS = 5;
  (FleetManager as any).MAINTENANCE_INTERVAL_MS = 5;
});

afterEach(() => {
  for (const k of STATICS) (FleetManager as any)[k] = saved.get(k);
});

const until = async (cond: () => boolean, ms = 2_000) => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
  return cond();
};

describe("FleetManager coordinator loops", () => {
  it("keeps dispatching while the feeds loop is stuck", async () => {
    const fleet = new FleetManager({ api: {} as any, log: () => {} });
    let core = 0;
    let maintenance = 0;
    (fleet as any).tickCore = async () => { core += 1; };
    (fleet as any).tickMaintenance = async () => { maintenance += 1; };
    (fleet as any).tickFeeds = () => new Promise<void>(() => {}); // never returns

    void fleet.run(Number.POSITIVE_INFINITY);
    try {
      assert.ok(await until(() => core >= 5 && maintenance >= 3), `core ran ${core}x, maintenance ${maintenance}x while feeds hung`);
    } finally {
      fleet.stop();
    }
  });

  it("keeps the feeds running while maintenance is stuck", async () => {
    const fleet = new FleetManager({ api: {} as any, log: () => {} });
    let feeds = 0;
    (fleet as any).tickCore = async () => {};
    (fleet as any).tickFeeds = async () => { feeds += 1; };
    (fleet as any).tickMaintenance = () => new Promise<void>(() => {});

    void fleet.run(Number.POSITIVE_INFINITY);
    try {
      assert.ok(await until(() => feeds >= 5), `feeds ran ${feeds}x while maintenance hung`);
    } finally {
      fleet.stop();
    }
  });

  it("stops every loop once the control loop reaches maxTicks", async () => {
    const fleet = new FleetManager({ api: {} as any, log: () => {} });
    let core = 0;
    (fleet as any).tickCore = async () => { core += 1; };
    (fleet as any).tickFeeds = async () => {};
    (fleet as any).tickMaintenance = async () => {};

    await fleet.run(3);
    assert.equal(core, 3);
  });

  it("a failing pass is logged and the loop carries on", async () => {
    const lines: string[] = [];
    const fleet = new FleetManager({ api: {} as any, log: (m) => lines.push(m) });
    let attempts = 0;
    (fleet as any).tickCore = async () => { attempts += 1; if (attempts === 1) throw new Error("boom"); };
    (fleet as any).tickFeeds = async () => {};
    (fleet as any).tickMaintenance = async () => {};

    await fleet.run(3);
    assert.equal(attempts, 3);
    assert.ok(lines.some((l) => l.includes("coordinator error [core]: boom")), lines.join("\n"));
  });

  it("attributes a slow step to the loop that ran it, not to a loop running beside it", async () => {
    (FleetManager as any).TICK_WARN_MS = 0;
    const lines: string[] = [];
    const fleet = new FleetManager({ api: {} as any, log: (m) => lines.push(m) });
    const f = fleet as any;
    // Two passes awaiting at once, each timing a differently-named step.
    await Promise.all([
      f.pass("feeds", async () => { await f.timed("feeds.tick", () => new Promise((r) => setTimeout(r, 30))); }),
      f.pass("maintenance", async () => { await f.timed("maybeBuyShip", () => new Promise((r) => setTimeout(r, 10))); }),
    ]);
    const feedsLine = lines.find((l) => l.includes("SLOW pass [feeds]"));
    const maintLine = lines.find((l) => l.includes("SLOW pass [maintenance]"));
    assert.ok(feedsLine?.includes("feeds.tick") && !feedsLine.includes("maybeBuyShip"), feedsLine);
    assert.ok(maintLine?.includes("maybeBuyShip") && !maintLine.includes("feeds.tick"), maintLine);
  });
});
