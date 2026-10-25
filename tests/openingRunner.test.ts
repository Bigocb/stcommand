import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db/store.js";
import { OpeningRunnerImpl, type OpeningHost, type OpeningShipFacts } from "../src/engine/openingRunner.js";
import type { TaskRun } from "../src/engine/openingTasks.js";

/**
 * The runner is the only part of opening automation that acts, so these tests
 * assert the actions it takes (and refuses to take) rather than logging.
 */

class MockStore extends Store {
  updates: { id: number; updates: Record<string, unknown> }[] = [];
  constructor(private readonly rows: TaskRun[]) {
    super({} as never);
  }
  async listOpeningTasks(_tenantId: string): Promise<TaskRun[]> {
    return this.rows;
  }
  async updateOpeningTask(_tenantId: string, id: number, updates: Partial<TaskRun>): Promise<void> {
    this.updates.push({ id, updates: updates as Record<string, unknown> });
  }
}

const SHIPS: OpeningShipFacts[] = [
  { symbol: "THEO-1", isCommand: true, cargoUnits: 0, waypoint: "X1-AA1-A1", docked: true },
  // A buy can only happen at a yard holding one of our docked ships
  // (openingTasks.ts's `viable` filter), so the fixture needs one there.
  { symbol: "THEO-2", isCommand: false, cargoUnits: 0, waypoint: "X1-AA1-B1", docked: true },
];

function task(over: Partial<TaskRun> & Pick<TaskRun, "steps">): TaskRun {
  return {
    id: 1,
    key: "t1",
    name: "Task 1",
    trigger: { kind: "always" },
    status: "queued",
    stepIndex: 0,
    stepPhase: "idle",
    refs: {},
    note: null,
    ...over,
  };
}

function host(over: Partial<OpeningHost> = {}): OpeningHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    spendable: () => 500_000,
    ships: () => SHIPS,
    yards: async () => [{ waypoint: "X1-AA1-B1", shipType: "SHIP_LIGHT_SHUTTLE", price: 90_000 }],
    bestRouteProfit: () => 50_000,
    surveyMissing: async () => ({ total: 4, missing: [], minGoods: 3 }),
    gateProgress: async () => undefined,
    buyShip: async (shipType, yard) => {
      calls.push(`buyShip:${shipType}@${yard}`);
      return { symbol: "THEO-9" };
    },
    setRole: async (symbol, role) => {
      calls.push(`setRole:${symbol}:${role}`);
    },
    setContractDuty: async (symbol, on) => {
      calls.push(`setContractDuty:${symbol}:${on}`);
    },
    setDoctrine: async (key, patch) => {
      calls.push(`setDoctrine:${key}:${JSON.stringify(patch)}`);
      return {};
    },
    log: () => {},
    ...over,
  };
}

describe("OpeningRunner", () => {
  it("executes a non-spending step and marks the task done", async () => {
    const store = new MockStore([
      task({ steps: [{ kind: "setRole", ship: { by: "command" }, role: "trader" }] }),
    ]);
    const h = host();
    await new OpeningRunnerImpl(store, h).run("tenant-1");

    assert.deepEqual(h.calls, ["setRole:THEO-1:trader"]);
    assert.equal(store.updates.length, 1);
    assert.equal(store.updates[0]!.updates.status, "done");
    assert.equal(store.updates[0]!.updates.stepIndex, 1);
  });

  it("records the bought hull against the step so later steps can resolve it", async () => {
    const store = new MockStore([
      task({
        steps: [
          { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100_000, preApproved: true },
          { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
        ],
      }),
    ]);
    const h = host();
    await new OpeningRunnerImpl(store, h).run("tenant-1");

    assert.deepEqual(h.calls, ["buyShip:SHIP_LIGHT_SHUTTLE@X1-AA1-B1"]);
    assert.equal(store.updates[0]!.updates.status, "active");
    assert.deepEqual(store.updates[0]!.updates.refs, { "0": "THEO-9" });
  });

  it("refuses a purchase the task did not pre-approve instead of spending", async () => {
    const store = new MockStore([
      task({ steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100_000, preApproved: false }] }),
    ]);
    const h = host();
    await new OpeningRunnerImpl(store, h).run("tenant-1");

    assert.deepEqual(h.calls, []);
    assert.equal(store.updates[0]!.updates.status, "needs_review");
  });

  it("waits when the trigger is not met, without writing anything", async () => {
    const store = new MockStore([
      task({ trigger: { kind: "cashAtLeast", credits: 10_000_000 }, steps: [{ kind: "setRole", ship: { by: "command" }, role: "trader" }] }),
    ]);
    const h = host();
    await new OpeningRunnerImpl(store, h).run("tenant-1");

    assert.deepEqual(h.calls, []);
    assert.equal(store.updates.length, 0);
  });

  it("does nothing at all when there are no active tasks", async () => {
    const store = new MockStore([task({ status: "done", steps: [{ kind: "setDoctrine", key: "x", value: 1 }] })]);
    const h = host();
    await new OpeningRunnerImpl(store, h).run("tenant-1");

    assert.deepEqual(h.calls, []);
    assert.equal(store.updates.length, 0);
  });
});
