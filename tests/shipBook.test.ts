import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipBook, advanceShip, describeShipBookSummary, shipsTouched } from "../src/engine/shipBook.js";
import { Client, SpaceTradersAPI } from "../src/core/client.js";
import { ShipProxy } from "../src/engine/shipProxy.js";

const T0 = Date.parse("2026-10-15T12:00:00Z");

function ship(over: Record<string, unknown> = {}) {
  return {
    symbol: "S-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-1", systemSymbol: "X1-A", route: { arrival: new Date(T0).toISOString(), destination: { symbol: "X1-A-1", systemSymbol: "X1-A" } } },
    fuel: { current: 100, capacity: 400 },
    cargo: { units: 0, capacity: 80, inventory: [] },
    cooldown: { remainingSeconds: 0, totalSeconds: 0, expiration: new Date(T0).toISOString() },
    ...over,
  };
}

function book(serve = true, maxAgeMs = 300_000) {
  let now = T0;
  const b = new ShipBook(() => now);
  b.setPolicy({ serve, maxAgeMs });
  return { b, at: (t: number) => { now = t; } };
}

describe("ShipBook", () => {
  it("serves nothing before a full read, and nothing with the clause off", () => {
    const { b } = book();
    assert.equal(b.serve("S-1"), undefined);
    const off = book(false);
    off.b.onShipRead("S-1", ship());
    assert.equal(off.b.serve("S-1"), undefined);
  });

  it("serves the last read, then the action response folded in", () => {
    const { b } = book();
    b.onShipRead("S-1", ship());
    const t = b.onShipActionStart(["S-1"]);
    assert.equal(b.serve("S-1"), undefined, "unknown while the action is in flight");
    b.onShipActionDone(t, "S-1", "orbit", { nav: { ...ship().nav, status: "IN_ORBIT" } });
    assert.equal((b.serve("S-1") as any).nav.status, "IN_ORBIT");
  });

  it("stays unknown after an action that failed, an unknown action, or a later action still in flight", () => {
    const failed = book();
    failed.b.onShipRead("S-1", ship());
    failed.b.onShipActionStart(["S-1"]);
    assert.equal(failed.b.serve("S-1"), undefined);

    const odd = book();
    odd.b.onShipRead("S-1", ship());
    odd.b.onShipActionDone(odd.b.onShipActionStart(["S-1"]), "S-1", "mounts/install", {});
    assert.equal(odd.b.serve("S-1"), undefined);

    const race = book();
    race.b.onShipRead("S-1", ship());
    const first = race.b.onShipActionStart(["S-1"]);
    race.b.onShipActionStart(["S-1"]);
    race.b.onShipActionDone(first, "S-1", "dock", { nav: ship().nav });
    assert.equal(race.b.serve("S-1"), undefined);
  });

  it("leaves a transfer's receiving ship unknown", () => {
    const { b } = book();
    b.onShipRead("S-1", ship());
    b.onShipRead("S-2", ship({ symbol: "S-2" }));
    const t = b.onShipActionStart(["S-1", "S-2"]);
    b.onShipActionDone(t, "S-1", "transfer", { cargo: { units: 0, capacity: 80, inventory: [] } });
    assert.ok(b.serve("S-1"));
    assert.equal(b.serve("S-2"), undefined);
  });

  it("stops serving once the read under it is older than the age limit", () => {
    const { b, at } = book(true, 60_000);
    b.onShipRead("S-1", ship());
    at(T0 + 61_000);
    assert.equal(b.serve("S-1"), undefined);
  });

  it("advances a finished transit and an expired cooldown", () => {
    const s = ship({
      nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-1", systemSymbol: "X1-A", route: { arrival: new Date(T0 + 10_000).toISOString(), destination: { symbol: "X1-A-9", systemSymbol: "X1-A" } } },
      cooldown: { remainingSeconds: 30, totalSeconds: 30, expiration: new Date(T0 + 30_000).toISOString() },
    });
    const later = advanceShip(s, T0 + 20_000) as any;
    assert.equal(later.nav.status, "IN_ORBIT");
    assert.equal(later.nav.waypointSymbol, "X1-A-9");
    assert.equal(later.cooldown.remainingSeconds, 10);
  });

  it("hands out copies, so a caller editing its ship can't edit the book", () => {
    const { b } = book();
    b.onShipRead("S-1", ship());
    (b.serve("S-1") as any).fuel.current = 1;
    assert.equal((b.serve("S-1") as any).fuel.current, 100);
  });

  it("counts in shadow how often a served copy would have matched the fresh read", () => {
    const { b, at } = book(false);
    b.onShipRead("S-1", ship());
    at(T0 + 5_000);
    b.onShipRead("S-1", ship());
    at(T0 + 10_000);
    b.onShipRead("S-1", ship({ fuel: { current: 50, capacity: 400 } }));
    const s = b.takeSummary();
    assert.equal(s.reads, 3);
    assert.equal(s.servable, 2);
    assert.equal(s.matched, 1);
    assert.equal(s.mismatches.fuel, 1);
    assert.match(describeShipBookSummary(s, false), /ship book \(shadow\): 3 reads · 2 could have been served, 1 matched \(50%\)/);
  });
});

describe("shipsTouched", () => {
  it("names the path ship, a body ship, and the action", () => {
    assert.deepEqual(shipsTouched("POST", "/my/ships/S-1/transfer", { shipSymbol: "S-2" }), { primary: "S-1", others: ["S-2"], action: "transfer" });
    assert.deepEqual(shipsTouched("POST", "/my/contracts/C-1/deliver", { shipSymbol: "S-1" }), { primary: "S-1", others: [], action: "deliver-cargo" });
    assert.deepEqual(shipsTouched("POST", "/systems/X1-A/waypoints/X1-A-I/construction/supply", { shipSymbol: "S-1" }), { primary: "S-1", others: [], action: "deliver-cargo" });
    assert.deepEqual(shipsTouched("GET", "/my/ships/S-1", undefined), { others: [] });
  });
});

describe("ShipBook at the client and ShipProxy seam", () => {
  it("skips the read when serving, and reads when the book can't answer", async () => {
    const original = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      paths.push(`${init?.method} ${new URL(String(url)).pathname}`);
      const body = /dock$/.test(String(url)) ? { data: { nav: { ...ship().nav, status: "DOCKED" } } } : { data: ship({ nav: { ...ship().nav, status: "IN_ORBIT" } }) };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      const b = new ShipBook();
      b.setPolicy({ serve: true, maxAgeMs: 300_000 });
      const api = new SpaceTradersAPI(new Client({ token: "t", baseUrl: "https://x.test/v2" }), "t");
      api.setShipObserver(b);
      api.setShipSource((s) => b.serve(s));
      const proxy = new ShipProxy(ship({ nav: { ...ship().nav, status: "IN_ORBIT" } }) as any, { api: api as any } as any);
      await proxy.refresh();
      await proxy.ensureDocked();
      await proxy.refresh();
      assert.equal((proxy as any).ship.nav.status, "DOCKED");
      assert.deepEqual(paths.map((p) => p.replace("/v2", "")), ["GET /my/ships/S-1", "POST /my/ships/S-1/dock"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
