import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { gzipJson } from "../src/http/gzipJson.js";

describe("gzipJson", () => {
  let server: Server;
  let base = "";
  const big = { rows: Array.from({ length: 500 }, (_, i) => ({ i, name: `ship-${i}`, note: "x".repeat(20) })) };
  before(async () => {
    const app = express();
    app.use("/api", gzipJson());
    app.get("/api/big", (_req, res) => { res.json(big); });
    app.get("/api/small", (_req, res) => { res.json({ ok: true }); });
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  // fetch decompresses gzip on its own, so read the raw bytes with node:http to see what was actually sent.
  const raw = (path: string, gzipOk: boolean) => new Promise<{ enc: string | undefined; body: Buffer }>((resolve, reject) => {
    import("node:http").then(({ get }) => {
      get(`${base}${path}`, { headers: gzipOk ? { "Accept-Encoding": "gzip" } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ enc: res.headers["content-encoding"] as string | undefined, body: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
  });

  it("gzips a large JSON body when the browser accepts gzip, and the body decodes to the same JSON", async () => {
    const r = await raw("/api/big", true);
    assert.equal(r.enc, "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(r.body).toString()), big);
    assert.ok(r.body.length < JSON.stringify(big).length / 3, "compressed well");
  });

  it("leaves a small body alone, and anything for a client that doesn't accept gzip", async () => {
    assert.equal((await raw("/api/small", true)).enc, undefined);
    const plain = await raw("/api/big", false);
    assert.equal(plain.enc, undefined);
    assert.deepEqual(JSON.parse(plain.body.toString()), big);
  });
});
