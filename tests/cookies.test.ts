import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCookies } from "../src/http/cookies.js";

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    assert.deepEqual(parseCookies("st_session=abc123"), { st_session: "abc123" });
  });

  it("parses multiple cookies separated by semicolons", () => {
    assert.deepEqual(parseCookies("a=1; b=2;c=3"), { a: "1", b: "2", c: "3" });
  });

  it("decodes percent-encoded values", () => {
    assert.deepEqual(parseCookies("session=abc%2Edef"), { session: "abc.def" });
  });

  it("returns an empty object for undefined or empty input", () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(""), {});
  });

  it("ignores malformed entries without an =", () => {
    assert.deepEqual(parseCookies("a=1; garbage; b=2"), { a: "1", b: "2" });
  });

  it("falls back to the raw value if percent-decoding fails", () => {
    assert.deepEqual(parseCookies("bad=%"), { bad: "%" });
  });
});
