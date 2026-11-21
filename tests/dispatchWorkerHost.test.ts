import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";
import { DispatchWorkerHost } from "../src/engine/dispatchWorkerHost.js";
import { runDispatchJob, type DispatchJob } from "../src/engine/dispatchJob.js";
import type { DispatchWorld } from "../src/engine/dispatchWorld.js";
import { exportDispatcherState, same } from "../src/engine/dispatcherState.js";

const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);
const world: DispatchWorld = {
  positioningHops: 3, neighbors: { "X1-A": [] }, jumpInto: { "X1-A": [] }, gates: {}, hopCosts: {}, fuelStops: {},
  coords: Object.fromEntries([10, 12, 50, 60, 100, 102, 900].map((n) => [`X1-A-${n}`, [n, 0] as [number, number]])),
};
const job: DispatchJob = {
  routes: [route("OUT", "X1-A-10", "X1-A-100", 40_000), route("BACK", "X1-A-102", "X1-A-12", 38_000), route("SOLO", "X1-A-10", "X1-A-900", 45_000), route("GEM", "X1-A-50", "X1-A-60", 20_000)],
  traders: [
    { shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-10", fuelCapacity: 5000 },
    { shipSymbol: "T-2", capacity: 20, system: "X1-A", waypoint: "X1-A-102", fuelCapacity: 5000 },
    { shipSymbol: "T-3", capacity: 30, system: "X1-A", waypoint: "X1-A-50", fuelCapacity: 5000 },
  ],
  warehouseTargets: [], haulTargets: [], missionBuyTargets: [], contractBuyTargets: [],
  crossSystem: { enabled: false }, tuning: { circuitWeight: 1 }, inFlight: [],
};

const host = new DispatchWorkerHost({ timeoutMs: 30_000 });
after(() => host.close());

describe("dispatch worker host", () => {
  it("a recompute in the worker installs exactly what the in-thread recompute decides", async () => {
    const inThread = new RouteDispatcher();
    const linesA: string[] = [];
    runDispatchJob(inThread, job, world, (m) => linesA.push(m));
    const viaWorker = new RouteDispatcher();
    const linesB: string[] = [];
    const outcome = await host.run(viaWorker, job, world, (m) => linesB.push(m));
    assert.equal(outcome.path, "worker", outcome.reason);
    assert.deepEqual(viaWorker.list(), inThread.list());
    assert.ok(viaWorker.list().length > 0);
    // Same log lines apart from timing-dependent text.
    assert.equal(linesB.length, linesA.length);
    const a = exportDispatcherState(inThread), b = exportDispatcherState(viaWorker);
    for (const k of ["assignments", "routes"]) assert.ok(same(a[k], b[k]), k);
    // Circuits and commitments carry the time they were made (the two runs are milliseconds apart): compare without it.
    const strip = (m: unknown): string => JSON.stringify([...(m as Map<string, unknown>).entries()], (key, v) => (/(At|^at)$/.test(key) ? undefined : v));
    assert.equal(strip(b.circuits), strip(a.circuits));
    assert.equal(strip(b.committed), strip(a.committed));
    assert.ok((b.circuits as Map<string, unknown>).size > 0, "the fixture plans a circuit");
  });

  it("is throttled like recompute(): a second run inside a minute does nothing", async () => {
    const d = new RouteDispatcher();
    assert.equal((await host.run(d, job, world, () => {})).path, "worker");
    assert.equal((await host.run(d, job, world, () => {})).path, "skipped");
  });

  it("falls back to an in-thread recompute when the worker fails", async () => {
    const broken = new DispatchWorkerHost({ timeoutMs: 30_000, workerUrl: new URL("data:text/javascript,import{parentPort}from'node:worker_threads';parentPort.on('message',(m)=>parentPort.postMessage({id:m.id,ok:false,error:'boom',logs:[],memoryChanged:false,ms:0}))") });
    try {
      const d = new RouteDispatcher();
      const outcome = await broken.run(d, job, world, () => {});
      assert.equal(outcome.path, "inThread");
      assert.match(outcome.reason ?? "", /boom/);
      assert.ok(d.list().length > 0);
    } finally { await broken.close(); }
  });

  it("skips the cycle and restarts the worker when it does not answer", async () => {
    const silent = new DispatchWorkerHost({ timeoutMs: 300, workerUrl: new URL("data:text/javascript,import{parentPort}from'node:worker_threads';parentPort.on('message',()=>{})") });
    try {
      const d = new RouteDispatcher();
      const outcome = await silent.run(d, job, world, () => {});
      assert.equal(outcome.path, "timeout");
      assert.equal(d.list().length, 0, "nothing installed");
    } finally { await silent.close(); }
  });
});
