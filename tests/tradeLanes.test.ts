import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { tradeLaneFor, enrolledShips, retryAfterNetworkFailure, retryOnBoxAfterProxyRefusal, TRADE_LANES_OFF, type TradeLanePolicy } from "../src/engine/tradeLanes.js";
import { LaneBreaker, type LanePolicy } from "../src/engine/apiLanes.js";
import { Client, RateLimiter, API_PRIORITY, runWithApiPriority, runWithApiShip, APIError } from "../src/core/client.js";

const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
const all = () => true;
const policy = (ships: string[], firstSlot = 2): TradeLanePolicy => ({ enabled: true, ships: new Set(ships), firstSlot });

describe("tradeLaneFor", () => {
  it("off (the default) never picks a trade lane", () => {
    assert.equal(tradeLaneFor({ ship: "S-1", priority: 1 }, TRADE_LANES_OFF, ids, all), undefined);
  });
  it("only an enrolled ship's own calls, never boot or calls with no ship", () => {
    const p = policy(["S-1"]);
    assert.equal(tradeLaneFor({ ship: "S-2", priority: 1 }, p, ids, all), undefined);
    assert.equal(tradeLaneFor({ ship: undefined, priority: 1 }, p, ids, all), undefined);
    assert.equal(tradeLaneFor({ ship: "S-1", priority: 0 }, p, ids, all), undefined);
    assert.ok(tradeLaneFor({ ship: "S-1", priority: 1 }, p, ids, all));
  });
  it("uses only the slots after the read lanes, and pins a ship to one of them", () => {
    const p = policy(["S-1", "S-2", "S-3"], 2);
    for (const ship of ["S-1", "S-2", "S-3"]) {
      const a = tradeLaneFor({ ship, priority: 1 }, p, ids, all)!;
      const b = tradeLaneFor({ ship, priority: 2 }, p, ids, all)!;
      assert.ok(a.slotIndex >= 2, "never a read-lane slot");
      assert.equal(a.slotIndex, b.slotIndex, "the same ship always gets the same proxy");
    }
  });
  it("moves to the next proxy only while the pinned one's breaker is open, and gives up when all are out", () => {
    const p = policy(["S-1"], 2);
    const pinned = tradeLaneFor({ ship: "S-1", priority: 1 }, p, ids, all)!;
    const other = tradeLaneFor({ ship: "S-1", priority: 1 }, p, ids, (id) => id !== ids[pinned.slotIndex])!;
    assert.notEqual(other.slotIndex, pinned.slotIndex);
    assert.ok(other.slotIndex >= 2);
    assert.equal(tradeLaneFor({ ship: "S-1", priority: 1 }, p, ids, () => false), undefined);
  });
  it("no slots left after the read lanes means no trade lane", () => {
    assert.equal(tradeLaneFor({ ship: "S-1", priority: 1 }, policy(["S-1"], 6), ids, all), undefined);
  });
});

describe("enrolledShips", () => {
  it("is the first N traders by symbol, whatever order they come in", () => {
    assert.deepEqual([...enrolledShips(["T-9", "T-2", "T-5", "T-1"], 2)], ["T-1", "T-2"]);
    assert.equal(enrolledShips(["T-1"], 0).size, 0);
  });
});

describe("retry rules", () => {
  it("a write through a trade lane is never resent after a network failure; reads and box writes keep today's retry", () => {
    assert.equal(retryAfterNetworkFailure("POST", true), false);
    assert.equal(retryAfterNetworkFailure("GET", true), true);
    assert.equal(retryAfterNetworkFailure("POST", false), true);
  });
  it("a refused write goes to the box only on 407 (the proxy itself refusing)", () => {
    assert.equal(retryOnBoxAfterProxyRefusal("POST", 407, true), true);
    assert.equal(retryOnBoxAfterProxyRefusal("POST", 403, true), false);
    assert.equal(retryOnBoxAfterProxyRefusal("POST", 401, true), false);
    assert.equal(retryOnBoxAfterProxyRefusal("GET", 403, true), true);
    assert.equal(retryOnBoxAfterProxyRefusal("POST", 403, false), true);
  });
});

// The seam: a real CONNECT proxy in front of a real HTTPS target, as in apiLanes.test.ts.
const PROXY_PORT = 41961;
const TARGET_PORT = 41962;
const DEAD_PORT = 41963;
let proxyServer: http.Server;
let targetServer: https.Server;
let connectCount = 0;
let targetHits = 0;
let tmpDir: string;
let originalTlsReject: string | undefined;

before(async () => {
  originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-lanes-test-"));
  const keyPath = path.join(tmpDir, "key.pem");
  const certPath = path.join(tmpDir, "cert.pem");
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=localhost"`, { stdio: "ignore" });
  proxyServer = http.createServer();
  proxyServer.on("connect", (req, clientSocket, head) => {
    connectCount += 1;
    const [host, port] = req.url!.split(":");
    const serverSocket = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on("error", () => clientSocket.destroy());
  });
  targetServer = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
    targetHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { symbol: "OK", method: req.method } }));
  });
  await new Promise<void>((r) => proxyServer.listen(PROXY_PORT, r));
  await new Promise<void>((r) => targetServer.listen(TARGET_PORT, r));
});

after(async () => {
  await new Promise<void>((r) => proxyServer.close(() => r()));
  await new Promise<void>((r) => targetServer.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsReject;
});

const readsOff: LanePolicy = { enabled: false, minPriority: 3 };

function tradeClient(trade: TradeLanePolicy, proxyPort = PROXY_PORT) {
  const box = new RateLimiter(100, 100);
  const lane = new RateLimiter(100, 100);
  const breaker = new LaneBreaker({ failures: 3, cooldownMs: 60_000 });
  const client = new Client({
    token: "t", baseUrl: `https://localhost:${TARGET_PORT}`, maxRetries: 2, retryBackoffMs: 1, sharedLimiter: box,
    lanes: { slots: [{ id: "p1", proxyUrl: `http://localhost:${proxyPort}`, limiter: lane, breaker }], policy: () => readsOff, tradePolicy: () => trade },
  });
  return { client, box, lane, breaker };
}
const dock = (c: Client) => c.request<{ data: { method: string } }>({ method: "POST", path: "/my/ships/S-1/dock" });
const asShip = <T>(ship: string, fn: () => Promise<T>) => runWithApiShip(ship, () => runWithApiPriority(API_PRIORITY.CRITICAL, fn));

describe("Client trade lanes", () => {
  it("an enrolled ship's write leaves through its proxy and draws from that proxy's limiter", async () => {
    connectCount = 0;
    const { client, box, lane } = tradeClient(policy(["S-1"], 0));
    const out = await asShip("S-1", () => dock(client));
    assert.equal(out.data.method, "POST");
    assert.equal(connectCount, 1);
    assert.equal(lane.stats().calls, 1);
    assert.equal(box.stats().calls, 0);
  });
  it("a ship not enrolled, and a call with no ship, stay on the box", async () => {
    connectCount = 0;
    const { client, box } = tradeClient(policy(["S-1"], 0));
    await asShip("S-2", () => dock(client));
    await runWithApiPriority(API_PRIORITY.CRITICAL, () => dock(client));
    assert.equal(connectCount, 0);
    assert.equal(box.stats().calls, 2);
  });
  it("off: an enrolled ship's write stays on the box (today's behaviour)", async () => {
    connectCount = 0;
    const { client, box } = tradeClient(TRADE_LANES_OFF);
    await asShip("S-1", () => dock(client));
    assert.equal(connectCount, 0);
    assert.equal(box.stats().calls, 1);
  });
  it("a dead proxy: the write is NOT resent anywhere and the caller is told the outcome is unknown", async () => {
    targetHits = 0;
    const { client, box } = tradeClient(policy(["S-1"], 0), DEAD_PORT);
    await assert.rejects(asShip("S-1", () => dock(client)), (err: unknown) => err instanceof APIError && err.code === "TRADE_LANE_UNKNOWN");
    assert.equal(box.stats().calls, 0, "never sent again on the box");
    assert.equal(targetHits, 0);
  });
  it("a dead proxy: an enrolled ship's read still succeeds on the box", async () => {
    const { client, box } = tradeClient(policy(["S-1"], 0), DEAD_PORT);
    const out = await asShip("S-1", () => client.request<{ data: { symbol: string } }>({ method: "GET", path: "/systems/X1-A/waypoints/X1-A-B/market" }));
    assert.equal(out.data.symbol, "OK");
    assert.equal(box.stats().calls, 1);
  });
});
