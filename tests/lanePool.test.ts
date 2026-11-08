import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { poolFromEnv, rendezvousOrder, pickProxy, laneKeyOf, ByteMeter } from "../src/engine/lanePool.js";
import { LaneBreaker, type LanePolicy } from "../src/engine/apiLanes.js";
import { ApiCallLog } from "../src/core/apiCallLog.js";
import { Client, RateLimiter, API_PRIORITY, runWithApiPriority, type LaneSlot } from "../src/core/client.js";

describe("poolFromEnv", () => {
  it("nothing configured: no lane", () => {
    assert.deepEqual(poolFromEnv({}, 1.75), []);
    assert.deepEqual(poolFromEnv({ API_LANE_PROXY_URLS: " , " }, 1.75), []);
  });
  it("the single API_LANE_PROXY_URL is a pool of one, with today's label and rate", () => {
    const p = poolFromEnv({ API_LANE_PROXY_URL: "http://u:p@h.example:6014/" }, 1.75);
    assert.equal(p.length, 1);
    assert.deepEqual([p[0]!.id, p[0]!.label, p[0]!.ratePerSec], ["p1", "h.example:6014", 1.75]);
  });
  it("API_LANE_PROXY_URLS: ids in the order written, per-proxy rate after a bar, credentials never in the label", () => {
    const p = poolFromEnv({ API_LANE_PROXY_URLS: "http://u:p@a.example:1, http://u:p@b.example:2|0.9\nhttp://u:p@c.example:3" }, 1.75);
    assert.deepEqual(p.map((x) => [x.id, x.label, x.ratePerSec]), [["p1", "a.example:1", 1.75], ["p2", "b.example:2", 0.9], ["p3", "c.example:3", 1.75]]);
  });
  it("invalid and repeated entries are skipped without breaking the rest, and the list wins over the single variable", () => {
    const p = poolFromEnv({ API_LANE_PROXY_URLS: "nope,http://a:1,http://a:1,socks5://x:2,http://b:2", API_LANE_PROXY_URL: "http://z:9" }, 1.75);
    assert.deepEqual(p.map((x) => x.label), ["a:1", "b:2"]);
  });
});

describe("rendezvous choice", () => {
  const ids = ["p1", "p2", "p3", "p4"];
  const keys = Array.from({ length: 400 }, (_, i) => `X1-S${i}`);
  const allow = () => true;

  it("the same key always gets the same proxy while the pool is unchanged, and the keys spread over all of them", () => {
    const first = keys.map((k) => pickProxy(k, ids, allow)!.id);
    assert.deepEqual(keys.map((k) => pickProxy(k, ids, allow)!.id), first);
    for (const id of ids) assert.ok(first.filter((x) => x === id).length > 50, `${id} gets a fair share`);
  });
  it("removing a proxy moves only the keys that were on it", () => {
    const before = keys.map((k) => pickProxy(k, ids, allow)!.id);
    const after = keys.map((k) => pickProxy(k, ["p1", "p2", "p4"], allow)!.id);
    keys.forEach((_, i) => { if (before[i] !== "p3") assert.equal(after[i], before[i]); });
  });
  it("one proxy is the single lane: chosen whenever its breaker allows, none when it is out", () => {
    assert.equal(pickProxy("anything", ["p1"], () => true)?.id, "p1");
    assert.equal(pickProxy("anything", ["p1"], () => false), undefined);
  });
  it("an open breaker is skipped in favour of the next proxy in the key's own order; all out gives none", () => {
    const k = "X1-AC17";
    const order = rendezvousOrder(k, ids);
    assert.equal(pickProxy(k, ids, (id) => id !== order[0])?.id, order[1]);
    assert.equal(pickProxy(k, ids, (id) => id === order[3])?.id, order[3]);
    assert.equal(pickProxy(k, ids, () => false), undefined);
  });
});

describe("laneKeyOf", () => {
  it("shards by system, else ship, else the path's start", () => {
    assert.equal(laneKeyOf("/systems/X1-AB12/waypoints/X1-AB12-C3/market"), "X1-AB12");
    assert.equal(laneKeyOf("/my/ships/THEO-1/cargo"), "THEO-1");
    assert.equal(laneKeyOf("/my/agent?x=1"), "/my/agent");
  });
});

describe("ByteMeter", () => {
  it("projects a month from the window and gives the average size by call kind", () => {
    const m = new ByteMeter();
    const t0 = Date.UTC(2026, 10, 8, 12, 0, 0);
    for (let i = 0; i < 10; i++) m.record(t0 + i * 60_000, "market", 6000);
    m.record(t0 + 9 * 60_000, "ships", 24_000);
    const s = m.stats(t0 + 10 * 60_000 - 1, 30);
    assert.deepEqual(s.byKind, [{ kind: "market", calls: 10, avgBytes: 6000 }, { kind: "ships", calls: 1, avgBytes: 24_000 }]);
    // 84,000 bytes over 10 minutes = 8,400 a minute = 0.36 GB over 30 days
    assert.equal(s.bytesPerMin, 8400);
    assert.equal(s.projectedGBPerMonth, 0.4);
  });
  it("an empty meter says zero, not NaN", () => {
    const s = new ByteMeter().stats(Date.now());
    assert.deepEqual([s.bytesPerMin, s.projectedGBPerMonth, s.coveredMin], [0, 0, 0]);
  });
});

describe("ApiCallLog bytes", () => {
  it("adds response size to the lane and the call-kind rows", () => {
    const log = new ApiCallLog();
    const now = Date.UTC(2026, 10, 8, 12, 0, 0);
    log.record({ at: now, role: "keeper", kind: "market", priority: 3, waitMs: 1, durationMs: 1, status: 200, lane: "proxy" });
    log.recordBytes({ at: now, role: "keeper", kind: "market", lane: "proxy", bytes: 5000 });
    log.record({ at: now, role: "keeper", kind: "market", priority: 3, waitMs: 1, durationMs: 1, status: 200, lane: "proxy" });
    log.recordBytes({ at: now, role: "keeper", kind: "market", lane: "proxy", bytes: 7000 });
    const s = log.summary(now + 1000, 60);
    assert.equal(s.lanes.find((l) => l.lane === "proxy")!.avgBytes, 6000);
    assert.equal(s.rows.find((r) => r.key === "keeper:market")!.avgBytes, 6000);
  });
});

// A real pair of CONNECT proxies in front of a real HTTPS target, to check the Client against a pool.
const PROXY_A = 41892, PROXY_B = 41893, TARGET = 41894;
const connects = { a: 0, b: 0 };
let servers: (http.Server | https.Server)[] = [];
let tmpDir: string;
let savedTls: string | undefined;

function connectProxy(port: number, count: () => void): http.Server {
  const s = http.createServer();
  s.on("connect", (req, sock, head) => {
    count();
    const [host, p] = req.url!.split(":");
    const up = net.connect(Number(p), host, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy());
  });
  s.listen(port);
  return s;
}

before(async () => {
  savedTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-pool-test-"));
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${tmpDir}/key.pem -out ${tmpDir}/cert.pem -days 1 -nodes -subj "/CN=localhost"`, { stdio: "ignore" });
  const target = https.createServer({ key: fs.readFileSync(`${tmpDir}/key.pem`), cert: fs.readFileSync(`${tmpDir}/cert.pem`) }, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { symbol: "OK" } }));
  });
  await new Promise<void>((r) => target.listen(TARGET, r));
  servers = [connectProxy(PROXY_A, () => { connects.a += 1; }), connectProxy(PROXY_B, () => { connects.b += 1; }), target];
  await new Promise((r) => setTimeout(r, 50));
});
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTls;
});

const slot = (id: string, port: number): LaneSlot => ({
  id, proxyUrl: `http://localhost:${port}`, limiter: new RateLimiter(100, 100), breaker: new LaneBreaker({ failures: 3, cooldownMs: 60_000 }), meter: new ByteMeter(),
});
function poolClient(slots: LaneSlot[], policy: LanePolicy) {
  const box = new RateLimiter(100, 100);
  const client = new Client({ token: "t", baseUrl: `https://localhost:${TARGET}`, maxRetries: 2, retryBackoffMs: 1, sharedLimiter: box, lanes: { slots, policy: () => policy } });
  return { client, box };
}
const read = (c: Client, system: string) => runWithApiPriority(API_PRIORITY.DEFERRABLE, () => c.request<{ data: { symbol: string } }>({ method: "GET", path: `/systems/${system}/waypoints` }));
const on: LanePolicy = { enabled: true, minPriority: 3 };
const systems = Array.from({ length: 40 }, (_, i) => `X1-T${i}`);

describe("Client with a pool of proxies", () => {
  it("each system's reads keep to one proxy, both proxies are used, the box is untouched, and bytes are counted", async () => {
    connects.a = 0; connects.b = 0;
    const a = slot("p1", PROXY_A), b = slot("p2", PROXY_B);
    const { client, box } = poolClient([a, b], on);
    for (const s of systems) await read(client, s);
    const firstA = a.limiter.stats().calls;
    assert.ok(firstA > 5 && b.limiter.stats().calls > 5, "the keys spread over both proxies");
    assert.equal(firstA + b.limiter.stats().calls, systems.length);
    assert.equal(box.stats().calls, 0);
    for (const s of systems) await read(client, s);
    assert.equal(a.limiter.stats().calls, firstA * 2, "the same systems go to the same proxy the second time");
    assert.ok(a.meter!.stats(Date.now()).byKind[0]!.avgBytes > 0);
  });
  it("a pool of one behaves as the single lane did", async () => {
    connects.a = 0;
    const a = slot("p1", PROXY_A);
    const { client, box } = poolClient([a], on);
    for (const s of systems.slice(0, 5)) await read(client, s);
    assert.equal(a.limiter.stats().calls, 5);
    assert.equal(box.stats().calls, 0);
  });
  it("apiLaneCount: only the first N proxies are used, the rest are spares", async () => {
    const a = slot("p1", PROXY_A), b = slot("p2", PROXY_B);
    const { client } = poolClient([a, b], { ...on, active: 1 });
    for (const s of systems.slice(0, 10)) await read(client, s);
    assert.equal(a.limiter.stats().calls, 10);
    assert.equal(b.limiter.stats().calls, 0);
  });
  it("a dead first proxy: its breaker opens and its systems move to the second proxy, not the box", async () => {
    const dead = slot("p1", 41999); // nothing listens there
    const b = slot("p2", PROXY_B);
    const { client, box } = poolClient([dead, b], on);
    for (const s of systems) await read(client, s); // every read succeeds, whatever happens to the proxy
    assert.equal(dead.breaker.allows(Date.now()), false, "three failures in a row opened p1's breaker");
    const boxBefore = box.stats().calls;
    const bBefore = b.limiter.stats().calls;
    for (const s of systems) await read(client, s);
    assert.equal(box.stats().calls, boxBefore, "with p1 out, the box is not touched");
    assert.equal(b.limiter.stats().calls, bBefore + systems.length, "p2 takes every read");
  });
  it("off: nothing leaves through a proxy even with a pool configured", async () => {
    const a = slot("p1", PROXY_A), b = slot("p2", PROXY_B);
    const { client, box } = poolClient([a, b], { enabled: false, minPriority: 3 });
    for (const s of systems.slice(0, 5)) await read(client, s);
    assert.equal(a.limiter.stats().calls + b.limiter.stats().calls, 0);
    assert.equal(box.stats().calls, 5);
  });
});
