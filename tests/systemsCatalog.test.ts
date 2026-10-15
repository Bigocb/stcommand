import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// The Systems page sends requireHullYard as a query string ("0" or "1"), so the input must accept both forms.
const requireHullYard = z.preprocess((v) => v === true || v === "1" || v === "true", z.boolean()).default(false);

describe("systems_candidates input", () => {
  it("accepts the query-string forms the Systems page sends", () => {
    assert.equal(requireHullYard.parse("1"), true);
    assert.equal(requireHullYard.parse("0"), false);
    assert.equal(requireHullYard.parse(true), true);
    assert.equal(requireHullYard.parse(undefined), false);
  });
});
