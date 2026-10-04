import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOperator, operatorAgents, requireOperator } from "../src/http/operatorFlag.js";

function run(agentSymbol: string | undefined) {
  let status = 0;
  let nexted = false;
  const res = { status(c: number) { status = c; return this; }, json() { return this; } };
  requireOperator({ agentSymbol } as never, res as never, () => { nexted = true; });
  return { status, nexted };
}

describe("operator flag", () => {
  it("parses OPERATOR_AGENTS case-insensitively and ignores blanks", () => {
    assert.deepEqual([...operatorAgents({ OPERATOR_AGENTS: " theo, ,Bob " })].sort(), ["BOB", "THEO"]);
    assert.equal(isOperator("theo", { OPERATOR_AGENTS: "THEO" }), true);
    assert.equal(isOperator("OTHER", { OPERATOR_AGENTS: "THEO" }), false);
    assert.equal(isOperator(undefined, { OPERATOR_AGENTS: "THEO" }), false);
  });

  it("fails closed when OPERATOR_AGENTS is unset", () => {
    const prev = process.env.OPERATOR_AGENTS;
    delete process.env.OPERATOR_AGENTS;
    try {
      assert.deepEqual(run("THEO"), { status: 503, nexted: false });
    } finally {
      if (prev !== undefined) process.env.OPERATOR_AGENTS = prev;
    }
  });

  it("403s a non-operator and lets an operator through", () => {
    const prev = process.env.OPERATOR_AGENTS;
    process.env.OPERATOR_AGENTS = "THEO";
    try {
      assert.deepEqual(run("SOMEONE"), { status: 403, nexted: false });
      assert.deepEqual(run("THEO"), { status: 0, nexted: true });
    } finally {
      if (prev === undefined) delete process.env.OPERATOR_AGENTS; else process.env.OPERATOR_AGENTS = prev;
    }
  });
});
