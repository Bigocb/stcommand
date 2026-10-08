import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { jsonErrors } from "../src/http/jsonErrors.js";

describe("jsonErrors", () => {
  let server: ReturnType<express.Express["listen"]>;
  let base: string;
  const origError = console.error;

  before(async () => {
    console.error = () => {};
    const app = express();
    const router = express.Router();
    router.post("/refuse", async () => { throw Object.assign(new Error("say which"), { status: 409 }); });
    router.post("/boom", async () => { throw new Error("db fell over"); });
    router.use(jsonErrors);
    app.use(router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => { console.error = origError; server.close(); });

  it("answers a thrown refusal with its own status and message", async () => {
    const r = await fetch(`${base}/refuse`, { method: "POST" });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "say which" });
  });

  it("answers any other thrown error as a JSON 500 carrying the message", async () => {
    const r = await fetch(`${base}/boom`, { method: "POST" });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "db fell over" });
  });
});
