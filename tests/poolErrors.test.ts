import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../src/db/pool.js";

/**
 * A dropped idle connection is an 'error' event on the pool; unhandled, Node
 * turns it into an uncaught exception and the process exits.
 */
describe("createPool", () => {
  it("handles an idle connection's error instead of letting it crash the process", async () => {
    const pool = createPool("postgres://nobody@localhost:1/none");
    try {
      assert.ok(pool.listenerCount("error") > 0, "the pool must have an error listener");
      assert.doesNotThrow(() => pool.emit("error", new Error("Connection terminated unexpectedly")));
    } finally {
      await pool.end();
    }
  });
});
