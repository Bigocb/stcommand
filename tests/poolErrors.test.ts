import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPool } from "../src/db/pool.js";

describe("createPool error handling", () => {
  it("a checked-out client losing its connection does not become an uncaught exception", async () => {
    const pool = createPool("postgres://u:p@localhost:5432/none"); // nothing connects until a query runs
    const client = new EventEmitter();
    pool.emit("connect", client); // what pg-pool does for every new connection
    assert.doesNotThrow(() => client.emit("error", new Error("Connection terminated unexpectedly")));
    await pool.end();
  });

  it("without the listener the same error would throw (the bug this guards)", () => {
    const bare = new EventEmitter();
    assert.throws(() => bare.emit("error", new Error("Connection terminated unexpectedly")));
  });

  it("an idle pool-level error is still only logged", async () => {
    const pool = createPool("postgres://u:p@localhost:5432/none");
    assert.doesNotThrow(() => pool.emit("error", new Error("Connection terminated unexpectedly")));
    await pool.end();
  });
});
