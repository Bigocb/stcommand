import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { Client } from "../src/core/client.js";

/**
 * Client's `proxyUrl` option, end to end: a real CONNECT-tunneling forward
 * proxy in front of a real HTTPS target, the actual mechanism a dedicated
 * datacenter proxy (Webshare, etc.) provides for reaching SpaceTraders'
 * HTTPS-only API. Confirms the request genuinely leaves through the proxy
 * (not silently going direct, which would defeat the whole feature) and
 * that the response round-trips correctly through Client's retry/JSON
 * handling.
 */

const PROXY_PORT = 41862;
const TARGET_PORT = 41863;

let proxyServer: http.Server;
let targetServer: https.Server;
let connectCount = 0;
let lastRequestPath = "";
let tmpDir: string;
let originalTlsReject: string | undefined;

before(async () => {
  // The target server below uses a throwaway self-signed cert — real
  // SpaceTraders traffic uses a real, properly-signed one, so this only
  // ever applies inside this test file, restored in after() below.
  originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-proxy-test-"));
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
    lastRequestPath = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { symbol: "PROXIED" } }));
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

describe("Client proxyUrl", () => {
  it("routes a real HTTPS request through the CONNECT-tunneling proxy", async () => {
    connectCount = 0;
    const client = new Client({
      token: "t",
      baseUrl: `https://localhost:${TARGET_PORT}`,
      proxyUrl: `http://localhost:${PROXY_PORT}`,
    });
    const result = await client.request<{ data: { symbol: string } }>({ method: "GET", path: "/my/agent" });
    assert.equal(connectCount, 1, "the request must actually tunnel through the proxy, not go direct");
    assert.equal(lastRequestPath, "/my/agent");
    assert.equal(result.data.symbol, "PROXIED");
  });

  it("without proxyUrl, connects directly and never touches the proxy", async () => {
    connectCount = 0;
    const client = new Client({ token: "t", baseUrl: `https://localhost:${TARGET_PORT}`, maxRetries: 0 });
    const result = await client.request<{ data: { symbol: string } }>({ method: "GET", path: "/my/agent" });
    assert.equal(result.data.symbol, "PROXIED");
    assert.equal(connectCount, 0, "a Client without proxyUrl must never route through the proxy");
  });
});
