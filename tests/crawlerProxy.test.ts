import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { crawlerProxyFromEnv, maskProxyUrl, makePublicFetch, DEFAULT_CRAWLER_PROXY_RATE } from "../src/engine/crawlerProxy.js";
import { GalaxyCrawler } from "../src/engine/galaxyCrawler.js";

describe("maskProxyUrl", () => {
  it("keeps host and port and never the credentials", () => {
    const out = maskProxyUrl("http://someuser:somepass@45.38.107.97:6014/");
    assert.equal(out, "45.38.107.97:6014");
    assert.ok(!out.includes("someuser") && !out.includes("somepass"));
  });
  it("says only 'proxy' for something that is not a URL, not the text itself", () => {
    assert.equal(maskProxyUrl("user:pass@nowhere"), "proxy");
  });
});

describe("crawlerProxyFromEnv", () => {
  it("unset or blank means no proxy, so nothing changes", () => {
    assert.equal(crawlerProxyFromEnv({}), undefined);
    assert.equal(crawlerProxyFromEnv({ CRAWLER_PROXY_URL: "   " }), undefined);
  });
  it("a bad value or a non-http scheme is ignored rather than half-applied", () => {
    assert.equal(crawlerProxyFromEnv({ CRAWLER_PROXY_URL: "not a url" }), undefined);
    assert.equal(crawlerProxyFromEnv({ CRAWLER_PROXY_URL: "socks5://h:1080" }), undefined);
  });
  it("a valid URL gives a credential-free label and the default rate", () => {
    const c = crawlerProxyFromEnv({ CRAWLER_PROXY_URL: "http://u:p@h.example:6014/" });
    assert.equal(c?.label, "h.example:6014");
    assert.equal(c?.ratePerSec, DEFAULT_CRAWLER_PROXY_RATE);
    assert.ok(!JSON.stringify(c?.label).includes("p@"));
  });
  it("the rate follows CRAWLER_PROXY_RATE, clamped to what the game allows", () => {
    const at = (r: string) => crawlerProxyFromEnv({ CRAWLER_PROXY_URL: "http://h:1/", CRAWLER_PROXY_RATE: r })?.ratePerSec;
    assert.equal(at("1.5"), 1.5);
    assert.equal(at("5"), 1.9);
    assert.equal(at("0.01"), 0.2);
    assert.equal(at("abc"), DEFAULT_CRAWLER_PROXY_RATE);
  });
});

const PROXY_PORT = 41872;
const TARGET_PORT = 41873;
let proxyServer: http.Server;
let targetServer: https.Server;
let connectCount = 0;
let tmpDir: string;
let originalTlsReject: string | undefined;

before(async () => {
  originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crawler-proxy-test-"));
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
    res.end(JSON.stringify({ data: [{ symbol: "COSMIC" }], path: req.url }));
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

describe("makePublicFetch", () => {
  it("with a proxy URL, a real HTTPS read tunnels through the CONNECT proxy", async () => {
    connectCount = 0;
    const f = makePublicFetch(`http://localhost:${PROXY_PORT}`);
    const res = await f(new URL(`https://localhost:${TARGET_PORT}/v2/factions`));
    const json = (await res.json()) as { data: { symbol: string }[]; path: string };
    assert.equal(res.status, 200);
    assert.equal(json.data[0]!.symbol, "COSMIC");
    assert.equal(json.path, "/v2/factions");
    assert.equal(connectCount, 1, "the read must leave through the proxy, not go direct");
  });
  it("without one, it goes direct and never touches the proxy", async () => {
    connectCount = 0;
    const res = await makePublicFetch(undefined)(new URL(`https://localhost:${TARGET_PORT}/v2/factions`));
    assert.equal(res.status, 200);
    assert.equal(connectCount, 0);
  });
  it("without one, it uses whatever globalThis.fetch is at call time (existing tests mock it)", async () => {
    const original = globalThis.fetch;
    let seen = "";
    globalThis.fetch = (async (u: unknown) => { seen = String(u); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      await makePublicFetch(undefined)(new URL("https://example.test/x"));
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(seen, "https://example.test/x");
  });
});

describe("GalaxyCrawler fetcher seam", () => {
  it("a public read goes through setFetcher, not the global fetch", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("the global fetch must not be used"); }) as typeof fetch;
    const calls: string[] = [];
    try {
      const crawler = new GalaxyCrawler({} as never);
      crawler.setFetcher(async (url) => { calls.push(url.pathname); return new Response(JSON.stringify({ data: [] }), { status: 200 }); });
      const out = await (crawler as unknown as { fetchPublic<T>(p: string, q?: Record<string, string | number>): Promise<T> }).fetchPublic<{ data: unknown[] }>("/factions", { limit: 20, page: 1 });
      assert.deepEqual(out.data, []);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /\/factions$/);
  });
});
