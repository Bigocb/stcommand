import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { chooseLane, LaneBreaker, laneProxyFromEnv, LANES_OFF, type LanePolicy } from "../src/engine/apiLanes.js";
import { ApiCallLog } from "../src/core/apiCallLog.js";
import { Client, RateLimiter, API_PRIORITY, runWithApiPriority } from "../src/core/client.js";

const on: LanePolicy = { enabled: true, minPriority: 3 };

describe("chooseLane", () => {
  it("off (the default) sends everything from the box", () => {
    for (const priority of [0, 1, 2, 3, 4]) assert.equal(chooseLane({ priority, method: "GET" }, LANES_OFF), "box");
  });
  it("on: a read at deferrable or background priority goes to the proxy", () => {
    assert.equal(chooseLane({ priority: 3, method: "GET" }, on), "proxy");
    assert.equal(chooseLane({ priority: 4, method: "get" }, on), "proxy");
  });
  it("on: critical and routine reads, and boot, stay on the box", () => {
    assert.equal(chooseLane({ priority: 1, method: "GET" }, on), "box");
    assert.equal(chooseLane({ priority: 2, method: "GET" }, on), "box");
    assert.equal(chooseLane({ priority: 0, method: "GET" }, on), "box");
  });
  it("on: a write never moves, whatever its priority", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(chooseLane({ priority: 3, method }, on), "box");
  });
  it("minPriority 4 moves background reads only", () => {
    const p: LanePolicy = { enabled: true, minPriority: 4 };
    assert.equal(chooseLane({ priority: 3, method: "GET" }, p), "box");
    assert.equal(chooseLane({ priority: 4, method: "GET" }, p), "proxy");
  });
});

describe("LaneBreaker", () => {
  it("opens after the set number of failures in a row and lets one trial through after the cooldown", () => {
    const b = new LaneBreaker({ failures: 3, cooldownMs: 1000 });
    b.failure(0); b.failure(10);
    assert.equal(b.allows(20), true, "two failures: still closed");
    b.failure(20);
    assert.equal(b.allows(500), false, "three in a row: open");
    assert.equal(b.state(500).open, true);
    assert.equal(b.allows(1020), true, "cooldown over: a trial is let through");
    b.failure(1020);
    assert.equal(b.allows(1100), false, "the trial failed: open again at once");
    assert.equal(b.allows(2020), true);
    b.success();
    assert.deepEqual(b.state(2021), { open: false, consecutiveFailures: 0, reopensInMs: 0 });
  });
  it("a success in between resets the count", () => {
    const b = new LaneBreaker({ failures: 3, cooldownMs: 1000 });
    b.failure(0); b.failure(1); b.success(); b.failure(2); b.failure(3);
    assert.equal(b.allows(4), true);
  });
});

describe("laneProxyFromEnv", () => {
  it("unset, blank, invalid or non-http gives no lane", () => {
    assert.equal(laneProxyFromEnv({}, 1.75), undefined);
    assert.equal(laneProxyFromEnv({ API_LANE_PROXY_URL: " " }, 1.75), undefined);
    assert.equal(laneProxyFromEnv({ API_LANE_PROXY_URL: "nope" }, 1.75), undefined);
    assert.equal(laneProxyFromEnv({ API_LANE_PROXY_URL: "socks5://h:1" }, 1.75), undefined);
  });
  it("a valid URL gives a credential-free label and the box's rate by default, clamped when set", () => {
    const c = laneProxyFromEnv({ API_LANE_PROXY_URL: "http://u:p@h.example:6014/" }, 1.75);
    assert.equal(c?.label, "h.example:6014");
    assert.equal(c?.ratePerSec, 1.75);
    assert.equal(laneProxyFromEnv({ API_LANE_PROXY_URL: "http://h:1/", API_LANE_PROXY_RATE: "9" }, 1.75)?.ratePerSec, 1.9);
    assert.equal(laneProxyFromEnv({ API_LANE_PROXY_URL: "http://h:1/", API_LANE_PROXY_RATE: "0.05" }, 1.75)?.ratePerSec, 0.2);
  });
});

describe("ApiCallLog lanes", () => {
  it("counts calls by the IP they left from; no lane means the box", () => {
    const log = new ApiCallLog();
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    log.record({ at: now, role: "keeper", kind: "market", priority: 3, waitMs: 100, durationMs: 400, status: 200, lane: "proxy" });
    log.record({ at: now, role: "keeper", kind: "market", priority: 3, waitMs: 300, durationMs: 600, status: 429, lane: "proxy" });
    log.record({ at: now, role: "trader", kind: "navigate", priority: 1, waitMs: 50, durationMs: 300, status: 200 });
    const s = log.summary(now + 1000, 60);
    const by = Object.fromEntries(s.lanes.map((l) => [l.lane, l]));
    assert.equal(by.proxy!.calls, 2);
    assert.equal(by.proxy!.r429, 1);
    assert.equal(by.proxy!.avgWaitMs, 200);
    assert.equal(by.box!.calls, 1);
    assert.equal(s.calls, 3, "the per-role rows still count every call");
  });
});

const PROXY_PORT = 41882;
const TARGET_PORT = 41883;
let proxyServer: http.Server;
let targetServer: https.Server;
let connectCount = 0;
let tmpDir: string;
let originalTlsReject: string | undefined;

before(async () => {
  originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-lanes-test-"));
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

function laneClient(policy: LanePolicy, proxyPort = PROXY_PORT, breaker = new LaneBreaker({ failures: 3, cooldownMs: 60_000 })) {
  const box = new RateLimiter(100, 100);
  const lane = new RateLimiter(100, 100);
  const client = new Client({
    token: "t", baseUrl: `https://localhost:${TARGET_PORT}`, maxRetries: 2, retryBackoffMs: 1, sharedLimiter: box,
    lanes: { proxyUrl: `http://localhost:${proxyPort}`, limiter: lane, breaker, policy: () => policy },
  });
  return { client, box, lane, breaker };
}
const get = (c: Client) => c.request<{ data: { symbol: string } }>({ method: "GET", path: "/systems" });

describe("Client lanes (a real CONNECT proxy in front of a real HTTPS target)", () => {
  it("on: a deferrable GET leaves through the proxy and draws from the lane's own limiter", async () => {
    connectCount = 0;
    const { client, box, lane } = laneClient(on);
    const out = await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => get(client));
    assert.equal(out.data.symbol, "OK");
    assert.equal(connectCount, 1, "it must tunnel through the proxy");
    assert.equal(lane.stats().calls, 1);
    assert.equal(box.stats().calls, 0, "the box's budget is untouched");
  });
  it("on: a critical GET and a deferrable POST stay on the box", async () => {
    connectCount = 0;
    const { client, box, lane } = laneClient(on);
    await runWithApiPriority(API_PRIORITY.CRITICAL, () => get(client));
    await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => client.request({ method: "POST", path: "/my/ships/X/dock" }));
    assert.equal(connectCount, 0);
    assert.equal(lane.stats().calls, 0);
    assert.equal(box.stats().calls, 2);
  });
  it("off: nothing uses the proxy even with a lane configured (today's behaviour)", async () => {
    connectCount = 0;
    const { client, lane } = laneClient(LANES_OFF);
    await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => get(client));
    assert.equal(connectCount, 0);
    assert.equal(lane.stats().calls, 0);
  });
  it("a Client with no lanes behaves as before", async () => {
    connectCount = 0;
    const c = new Client({ token: "t", baseUrl: `https://localhost:${TARGET_PORT}`, maxRetries: 0 });
    const out = await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => get(c));
    assert.equal(out.data.symbol, "OK");
    assert.equal(connectCount, 0);
  });
  it("a dead proxy: the read still succeeds on the box, and the breaker opens after three failures in a row", async () => {
    const { client, box, breaker } = laneClient(on, 41999); // nothing listens there
    for (let i = 0; i < 3; i++) {
      const out = await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => get(client));
      assert.equal(out.data.symbol, "OK", "the caller never sees the proxy's failure");
    }
    assert.equal(box.stats().calls, 3, "each read fell back to the box");
    assert.equal(breaker.allows(Date.now()), false, "three in a row open the breaker");
    // With the breaker open the next read goes straight to the box with no attempt on the proxy.
    const before = box.stats().calls;
    await runWithApiPriority(API_PRIORITY.DEFERRABLE, () => get(client));
    assert.equal(box.stats().calls, before + 1);
  });
});
