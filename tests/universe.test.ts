import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { universeKey, isUniverseKey, parseUniverseKey } from "../src/engine/universe.js";

describe("universeKey", () => {
  it("is the agent symbol and the reset date, symbol upper-cased", () => {
    assert.equal(universeKey("THEOREM", "2026-10-11"), "THEOREM@2026-10-11");
    assert.equal(universeKey("theo", "2026-10-04"), "THEO@2026-10-04");
  });

  it("keeps weeks apart for one agent, and agents apart within one week", () => {
    assert.notEqual(universeKey("THEO", "2026-10-04"), universeKey("THEO", "2026-10-11"));
    assert.notEqual(universeKey("THEO", "2026-10-11"), universeKey("THEOREM", "2026-10-11"));
  });

  it("is undefined while either part is missing or malformed", () => {
    assert.equal(universeKey(undefined, "2026-10-11"), undefined);
    assert.equal(universeKey("THEO", undefined), undefined);
    assert.equal(universeKey("THEO", "current"), undefined, "a manual capture's placeholder is not a date");
    assert.equal(universeKey("THEO", "unknown"), undefined);
    assert.equal(universeKey("TH EO", "2026-10-11"), undefined);
  });

  it("refuses anything that could escape a SET LOCAL statement", () => {
    assert.equal(universeKey("THEO'; DROP TABLE ledger; --", "2026-10-11"), undefined);
    assert.equal(isUniverseKey("THEO@2026-10-11'; --"), false);
    assert.equal(isUniverseKey("THEO@2026-10-11"), true);
    assert.equal(isUniverseKey(undefined), false);
  });

  it("round-trips through parseUniverseKey", () => {
    assert.deepEqual(parseUniverseKey("THEOREM@2026-10-11"), { agentSymbol: "THEOREM", resetDate: "2026-10-11" });
    assert.equal(parseUniverseKey("nonsense"), undefined);
  });
});
