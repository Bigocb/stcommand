import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { LiveFeed } from "../src/engine/liveFeed.js";
import { diffShips, shipRow } from "../src/engine/shipRows.js";
import { liveRoute } from "../src/http/live.js";

const ship = (symbol: string, over: Record<string, unknown> = {}) => ({
  symbol,
  nav: { status: "DOCKED", waypointSymbol: "X1-A-1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: "2026-10-15T00:00:00Z" } },
  fuel: { current: 100, capacity: 400 },
  cargo: { units: 0, capacity: 40, inventory: [] },
  cooldown: { shipSymbol: symbol, totalSeconds: 0, remainingSeconds: 0 },
  ...over,
}) as any;

describe("live feed hub", () => {
  it("numbers events and replays what a reconnecting screen missed", () => {
    const f = new LiveFeed();
    f.publish("a", 1); f.publish("b", 2); f.publish("c", 3);
    assert.equal(f.lastSeq, 3);
    assert.deepEqual(f.since(1)!.map((e) => e.type), ["b", "c"]);
    assert.deepEqual(f.since(3), []);
  });

  it("says a snapshot is needed when the missed events have left the buffer, or the number is from another run", () => {
    const f = new LiveFeed(2);
    f.publish("a", 1); f.publish("b", 2); f.publish("c", 3);
    assert.equal(f.since(0), undefined, "event 1 is gone");
    assert.deepEqual(f.since(1)!.map((e) => e.seq), [2, 3]);
    assert.equal(f.since(99), undefined, "ahead of us: the server restarted");
  });

  it("keeps delivering to the other screens when one subscriber throws", () => {
    const f = new LiveFeed();
    const got: number[] = [];
    f.subscribe(() => { throw new Error("closed socket"); });
    f.subscribe((e) => got.push(e.seq));
    f.publish("a", 1);
    assert.deepEqual(got, [1]);
  });
});

describe("ship rows", () => {
  it("sends only ships whose position, fuel, cargo or cooldown changed, and names removed ones", () => {
    const first = diffShips(new Map(), [ship("S-1"), ship("S-2")]);
    assert.equal(first.diff.changed.length, 2);
    const same = diffShips(first.next, [ship("S-1"), ship("S-2")]);
    assert.equal(same.diff.changed.length, 0);
    const moved = diffShips(first.next, [ship("S-1", { fuel: { current: 60, capacity: 400 } })]);
    assert.deepEqual(moved.diff.changed.map((r) => r.symbol), ["S-1"]);
    assert.deepEqual(moved.diff.removed, ["S-2"]);
  });

  it("ignores a cooldown counting down by itself", () => {
    const a = diffShips(new Map(), [ship("S-1", { cooldown: { shipSymbol: "S-1", totalSeconds: 70, remainingSeconds: 60, expiration: "2026-10-15T00:01:00Z" } })]);
    const b = diffShips(a.next, [ship("S-1", { cooldown: { shipSymbol: "S-1", totalSeconds: 70, remainingSeconds: 40, expiration: "2026-10-15T00:01:00Z" } })]);
    assert.equal(b.diff.changed.length, 0);
  });
});

describe("ship row trim", () => {
  it("keeps what the screens read and drops the rest, for about a third of the size", () => {
    const full = ship("S-1", {
      nav: {
        status: "IN_TRANSIT", waypointSymbol: "X1-A-2", systemSymbol: "X1-A", flightMode: "BURN",
        route: {
          origin: { symbol: "X1-A-1", type: "PLANET", systemSymbol: "X1-A", x: 1, y: 2 },
          destination: { symbol: "X1-A-2", type: "MOON", systemSymbol: "X1-A", x: 30, y: 40 },
          departureTime: "2026-10-15T00:00:00Z", arrival: "2026-10-15T00:01:00Z",
        },
      },
      fuel: { current: 24, capacity: 80, consumed: { amount: 56, timestamp: "2026-10-15T00:00:00Z" } },
      cargo: { capacity: 15, units: 6, inventory: [{ symbol: "COPPER_ORE", name: "Copper Ore", description: "A valuable ore used in the production of copper and other alloys.", units: 6 }] },
    });
    const row = shipRow(full);
    assert.deepEqual(row.nav.route!.destination, { symbol: "X1-A-2", x: 30, y: 40 }, "the map's interpolation needs symbol, x and y");
    assert.equal(row.nav.route!.arrival, "2026-10-15T00:01:00Z");
    assert.deepEqual(row.cargo.inventory, [{ symbol: "COPPER_ORE", units: 6 }]);
    assert.deepEqual(row.fuel, { current: 24, capacity: 80 });
    const fullRow = { symbol: full.symbol, nav: full.nav, fuel: full.fuel, cargo: full.cargo, cooldown: full.cooldown };
    assert.ok(JSON.stringify(row).length < JSON.stringify(fullRow).length * 0.7);
  });
});

describe("GET /api/live", () => {
  let server: Server;
  let base = "";
  const live = new LiveFeed();
  before(async () => {
    const app = express();
    app.get("/api/live", liveRoute(() => ({ live, liveSnapshot: () => ({ seq: live.lastSeq, ships: [], credits: 1000 }) })));
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  after(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));

  /** Open the stream, read until `count` events have arrived, then close. */
  const read = (headers: Record<string, string>, count: number, publishAfterOpen?: () => void) => new Promise<{ type: string; id: string; data: any }[]>((resolve, reject) => {
    import("node:http").then(({ get }) => {
      const req = get(`${base}/api/live`, { headers }, (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream");
        let buf = "";
        const events: { type: string; id: string; data: any }[] = [];
        res.on("data", (chunk) => {
          buf += chunk.toString();
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            if (block.startsWith(":")) continue;
            const f: Record<string, string> = Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
            events.push({ type: f.event ?? "", id: f.id ?? "", data: JSON.parse(f.data ?? "null") });
            if (events.length === 1) publishAfterOpen?.();
            if (events.length >= count) { req.destroy(); resolve(events); }
          }
        });
      });
      req.on("error", (e) => { if ((e as any).code !== "ECONNRESET") reject(e); });
    });
  });

  it("sends a snapshot on connect, then the events published after it", async () => {
    const events = await read({}, 2, () => live.publish("credits", { credits: 1234 }));
    assert.equal(events[0]!.type, "snapshot");
    assert.equal(events[0]!.data.credits, 1000);
    assert.equal(events[1]!.type, "credits");
    assert.equal(events[1]!.data.credits, 1234);
  });

  it("replays only the missed events for a screen that reconnects with its last event number", async () => {
    const before = live.lastSeq;
    live.publish("activity", { kind: "sell", detail: "one" });
    live.publish("activity", { kind: "sell", detail: "two" });
    const events = await read({ "Last-Event-ID": String(before) }, 2);
    assert.deepEqual(events.map((e) => e.data.detail), ["one", "two"]);
  });
});
