import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PersistedTimers } from "../src/engine/persistedTimers.js";

const fakeIo = () => {
  let doc: string | undefined;
  return { io: { read: async () => doc, write: async (j: string) => { doc = j; } }, peek: () => doc };
};

describe("PersistedTimers", () => {
  it("survives a restart: a second instance reads what the first wrote", async () => {
    const { io } = fakeIo();
    const a = new PersistedTimers(io);
    await a.load();
    a.book.yardWait.set("approval-1", 1_000);
    a.book.queueCooldown.set("X1-CK45-D44", 9_000_000);
    a.book.surveyRetry.set("X1-SQ36", 8_000_000);
    await a.save(2_000);
    const b = new PersistedTimers(io); // the process restarted
    await b.load();
    assert.equal(b.book.yardWait.get("approval-1"), 1_000);
    assert.equal(b.book.queueCooldown.get("X1-CK45-D44"), 9_000_000);
    assert.equal(b.book.surveyRetry.get("X1-SQ36"), 8_000_000);
  });
  it("drops cool-offs and retries that have run out, but not the start time of a wait", async () => {
    const { io } = fakeIo();
    const a = new PersistedTimers(io);
    await a.load();
    a.book.yardWait.set("old-wait", 5);              // when the wait began: kept until the caller deletes it
    a.book.queueCooldown.set("expired", 100);
    a.book.surveyRetry.set("expired2", 100);
    await a.save(1_000);
    const b = new PersistedTimers(io);
    await b.load();
    assert.equal(b.book.yardWait.get("old-wait"), 5);
    assert.equal(b.book.queueCooldown.has("expired"), false);
    assert.equal(b.book.surveyRetry.has("expired2"), false);
  });
  it("an unreadable or missing document starts empty instead of failing", async () => {
    const t = new PersistedTimers({ read: async () => "{not json", write: async () => {} });
    await t.load();
    assert.equal(t.book.yardWait.size + t.book.queueCooldown.size + t.book.surveyRetry.size, 0);
    const u = new PersistedTimers({ read: async () => { throw new Error("db down"); }, write: async () => { throw new Error("db down"); } });
    await u.load();
    await u.save(1); // must not throw
  });
});
