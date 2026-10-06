import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  API_PRIORITY,
  Client,
  RateLimiter,
  callKind,
  currentApiPriority,
  runWithApiPriority,
  taskToApiPriority,
} from "../src/core/client.js";
import { FleetManager } from "../src/engine/fleet.js";
import { Scheduler } from "../src/engine/scheduler.js";

/**
 * One 1.5 req/s bucket carries the whole fleet. These pin down which calls get
 * a token first when it is full: ships in motion before refreshes that can
 * wait a couple of seconds — without letting the refreshes starve.
 */

describe("callKind", () => {
  const cases: [string, string, string][] = [
    ["POST", "/my/ships/TH-1/navigate", "navigate"],
    ["POST", "/my/ships/TH-1/extract", "extract"],
    ["POST", "/my/ships/TH-1/extract/survey", "survey"],
    ["POST", "/my/ships/TH-1/sell", "sell-cargo"],
    ["POST", "/my/ships/TH-1/purchase", "buy-cargo"],
    ["POST", "/my/ships/TH-1/refuel", "refuel"],
    ["POST", "/my/ships/TH-1/dock", "dock"],
    ["POST", "/my/ships/TH-1/orbit", "orbit"],
    ["POST", "/my/ships/TH-1/jump", "jump"],
    ["GET", "/my/ships/TH-1", "ship"],
    ["GET", "/my/ships/TH-1/cargo", "cargo"],
    ["GET", "/my/ships", "ships"],
    ["POST", "/my/ships", "buy-ship"],
    ["GET", "/my/agent", "agent"],
    ["GET", "/my/contracts", "contract"],
    ["GET", "/systems/X1-A/waypoints/X1-A-B1/market", "market"],
    ["GET", "/systems/X1-A/waypoints/X1-A-B1/shipyard", "shipyard"],
    ["GET", "/systems/X1-A/waypoints/X1-A-G1/construction", "construction"],
    ["POST", "/systems/X1-A/waypoints/X1-A-G1/construction/supply", "gate-supply"],
    ["GET", "/systems/X1-A/waypoints?limit=20&page=2", "waypoints"],
    ["GET", "/systems/X1-A", "system"],
    ["GET", "/systems", "systems"],
    ["GET", "/something/new", "other"],
  ];
  for (const [method, path, kind] of cases) {
    it(`${method} ${path} -> ${kind}`, () => assert.equal(callKind(method, path), kind));
  }
});

describe("taskToApiPriority", () => {
  it("treats rescue as boot, mission and trade work as critical, keeper and survey as deferrable", () => {
    assert.equal(taskToApiPriority(0), API_PRIORITY.BOOT);
    assert.equal(taskToApiPriority(1), API_PRIORITY.CRITICAL);
    assert.equal(taskToApiPriority(2), API_PRIORITY.CRITICAL);
    assert.equal(taskToApiPriority(3), API_PRIORITY.DEFERRABLE);
    assert.equal(taskToApiPriority(4), API_PRIORITY.BACKGROUND);
  });
});

describe("RateLimiter priority and aging", () => {
  it("serves a critical call ahead of deferrable calls that queued first", async () => {
    const limiter = new RateLimiter(20, 1);
    await limiter.acquire(); // use the one burst token so everything below queues
    const order: string[] = [];
    const waits = [
      limiter.acquire(API_PRIORITY.DEFERRABLE, "T", "market").then(() => order.push("market")),
      limiter.acquire(API_PRIORITY.DEFERRABLE, "T", "shipyard").then(() => order.push("shipyard")),
      limiter.acquire(API_PRIORITY.CRITICAL, "T", "sell-cargo").then(() => order.push("sell-cargo")),
    ];
    await Promise.all(waits);
    assert.deepEqual(order, ["sell-cargo", "market", "shipyard"]);
  });

  it("promotes a call that has waited, so a stream of critical calls cannot starve it", async () => {
    const limiter = new RateLimiter(20, 1, 40); // a tier per 40ms of waiting
    await limiter.acquire();
    const order: string[] = [];
    const waits: Promise<void>[] = [limiter.acquire(API_PRIORITY.BACKGROUND, "T", "other").then(() => { order.push("background"); })];
    // Feed critical calls steadily for longer than the aging threshold would need (4 tiers -> 3 steps to tie with critical).
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      waits.push(limiter.acquire(API_PRIORITY.CRITICAL, "T", "sell-cargo").then(() => { order.push(`critical${i}`); }));
    }
    await Promise.all(waits);
    const at = order.indexOf("background");
    assert.ok(at >= 0 && at < order.length - 1, `background call should finish before the last critical one, order: ${order.join(",")}`);
  });

  it("never lets aging overtake a boot-priority call", async () => {
    const limiter = new RateLimiter(5, 1, 10); // a token every 200ms, so both calls are queued when it arrives
    await limiter.acquire();
    const order: string[] = [];
    const old = limiter.acquire(API_PRIORITY.BACKGROUND, "T", "other").then(() => order.push("old"));
    await new Promise((r) => setTimeout(r, 80));
    const boot = limiter.acquire(API_PRIORITY.BOOT, "T", "agent").then(() => order.push("boot"));
    await Promise.all([old, boot]);
    assert.deepEqual(order, ["boot", "old"]);
  });

  it("reports waits per tier and calls per kind", async () => {
    const limiter = new RateLimiter(50, 1);
    await Promise.all([
      limiter.acquire(API_PRIORITY.CRITICAL, "T", "sell-cargo"),
      limiter.acquire(API_PRIORITY.DEFERRABLE, "T", "market"),
      limiter.acquire(API_PRIORITY.DEFERRABLE, "T", "market"),
    ]);
    const st = limiter.stats();
    assert.equal(st.byKind["market"]?.calls, 2);
    assert.equal(st.byKind["sell-cargo"]?.calls, 1);
    assert.equal(st.byPriority[String(API_PRIORITY.DEFERRABLE)]?.calls, 2);
  });
});

/** A Client wired to a limiter that only records how it was asked, and a fetch that always succeeds. */
function recordingClient(): { client: Client; asked: { priority: number; kind: string }[]; restore: () => void } {
  const asked: { priority: number; kind: string }[] = [];
  const limiter = { acquire: async (priority: number, _label: string, kind: string) => { asked.push({ priority, kind }); } } as unknown as RateLimiter;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  return { client: new Client({ token: "t", sharedLimiter: limiter }), asked, restore: () => { globalThis.fetch = original; } };
}

describe("Client request priority", () => {
  it("uses the priority of the context that made the call, and names the call", async () => {
    const { client, asked, restore } = recordingClient();
    try {
      await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => client.request({ method: "GET", path: "/systems/X1-A/waypoints/X1-A-B1/market" }));
      await runWithApiPriority(API_PRIORITY.CRITICAL, () => client.request({ method: "POST", path: "/my/ships/TH-1/sell", body: {} }));
      await client.request({ method: "GET", path: "/my/agent" }); // no context: the Client's own default
    } finally {
      restore();
    }
    assert.deepEqual(asked, [
      { priority: API_PRIORITY.DEFERRABLE, kind: "market" },
      { priority: API_PRIORITY.CRITICAL, kind: "sell-cargo" },
      { priority: 1, kind: "agent" },
    ]);
  });

  it("keeps two concurrent contexts apart", async () => {
    const { client, asked, restore } = recordingClient();
    try {
      await Promise.all([
        runWithApiPriority(API_PRIORITY.DEFERRABLE, async () => { await new Promise((r) => setTimeout(r, 5)); await client.request({ method: "GET", path: "/my/agent" }); }),
        runWithApiPriority(API_PRIORITY.CRITICAL, async () => { await client.request({ method: "POST", path: "/my/ships/TH-1/navigate", body: {} }); }),
      ]);
    } finally {
      restore();
    }
    assert.deepEqual(asked.map((a) => a.priority).sort(), [API_PRIORITY.CRITICAL, API_PRIORITY.DEFERRABLE]);
  });

  it("lets boot priority override the calling context", async () => {
    const { client, asked, restore } = recordingClient();
    client.setPriority(0);
    try {
      await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => client.request({ method: "GET", path: "/my/agent" }));
    } finally {
      restore();
    }
    assert.equal(asked[0]!.priority, 0);
  });
});

describe("coordinator loops and the scheduler set their own urgency", () => {
  it("runs each loop's pass at that loop's priority", async () => {
    const fleet = new FleetManager({ api: {} as any, log: () => {} });
    const seen: Record<string, number | undefined> = {};
    for (const loop of ["core", "feeds", "maintenance"]) {
      await (fleet as any).pass(loop, async () => { seen[loop] = currentApiPriority(); });
    }
    assert.deepEqual(seen, { core: API_PRIORITY.ROUTINE, feeds: API_PRIORITY.CRITICAL, maintenance: API_PRIORITY.DEFERRABLE });
  });

  it("scopes a task's priority to its own work instead of flipping the Client", async () => {
    let flipped = 0;
    let during: number | undefined;
    const sched = new Scheduler({
      setClientPriority: () => { flipped += 1; },
      runWithPriority: (p, fn) => runWithApiPriority(taskToApiPriority(p), fn),
    });
    sched.enqueue({
      id: "T-trade", shipSymbol: "T", priority: 2, estimatedCalls: 1, earliestRunAt: 0,
      run: async () => { during = currentApiPriority(); return { actualCalls: 1 }; },
    } as any);
    await sched.runOnce();
    assert.equal(during, API_PRIORITY.CRITICAL);
    assert.equal(flipped, 0, "the shared Client field is left alone when a scoped runner is supplied");
  });
});
