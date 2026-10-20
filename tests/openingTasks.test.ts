import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { 
  validateTaskSpec, 
  validateTemplateTasks, 
  triggerMet, 
  decide, 
  STANDARD_OPENING, 
  OpeningFacts,
  Trigger,
  Step,
} from "../src/engine/openingTasks.js";

describe("Opening Tasks Validation", () => {
  it("accepts each task in STANDARD_OPENING", () => {
    for (const spec of STANDARD_OPENING) {
      const v = validateTaskSpec(spec);
      assert.strictEqual(v.ok, true, `Standard task ${spec.key} failed validation: ${v.ok ? "" : (v as any).error}`);
    }
  });

  it("rejects invalid keys and step counts", () => {
    assert.strictEqual(validateTaskSpec({ key: "Bad Key", name: "n", trigger: { kind: "always" }, steps: [{ kind: "setDoctrine", key: "k", value: 1 }] }).ok, false);
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "always" }, steps: [] }).ok, false);
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "always" }, steps: Array(9).fill({ kind: "setDoctrine", key: "k", value: 1 }) }).ok, false);
  });

  it("rejects invalid buyShip and setDoctrine", () => {
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "always" }, steps: [{ kind: "buyShip", shipType: "SHIP_PROBE", maxPrice: 0, preApproved: false }] }).ok, false);
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "always" }, steps: [{ kind: "setDoctrine", key: "k" }] }).ok, false);
  });

  it("rejects invalid ship refs", () => {
    // step 1 using step 1
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "always" }, steps: [{ kind: "setDoctrine", key: "k", value: 1 }, { kind: "setRole", ship: { by: "step", step: 1 }, role: "trader" }] }).ok, false);
    // step ref pointing at setRole (Step 0 is not buyShip)
    // FIX: In the original test this was returning true because step 0 was a setRole, but we need it to be FALSE.
    // Our current implementation of validateShipRef only checks if step < currentStepIndex.
    // We MUST check that step N is a buyShip.
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "always" }, steps: [{ kind: "setRole", ship: { by: "command" }, role: "trader" }, { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" }] }).ok, false);
    // trigger containing by:step
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "shipHoldEmpty", ship: { by: "step", step: 0 } }, steps: [{ kind: "setDoctrine", key: "k", value: 1 }] }).ok, false);
  });

  it("rejects NaN credits", () => {
    assert.strictEqual(validateTaskSpec({ key: "ok", name: "n", trigger: { kind: "cashAtLeast", credits: NaN }, steps: [{ kind: "setDoctrine", key: "k", value: 1 }] }).ok, false);
  });

  it("validateTemplateTasks rejects duplicates and unknown keys", () => {
    const valid = STANDARD_OPENING;
    assert.strictEqual(validateTemplateTasks(valid).ok, true);
    
    const dups = [{ ...valid[0], key: "a" }, { ...valid[1], key: "a" }];
    assert.strictEqual(validateTemplateTasks(dups).ok, false);
    
    const unknown = [{ ...valid[0], trigger: { kind: "taskDone", taskKey: "unknown" }, steps: [{ kind: "setDoctrine", key: "k", value: 1 }] }];
    assert.strictEqual(validateTemplateTasks(unknown).ok, false);
  });
});

describe("Opening Tasks Trigger", () => {
  const facts: OpeningFacts = {
    spendable: 100000,
    bestRouteProfit: 40000,
    ships: [{ symbol: "CMD-1", isCommand: true, cargoUnits: 0, waypoint: "W1", docked: true }],
    yards: [],
    doneKeys: new Set(["task-1"])
  };

  it("met: always", () => {
    assert.strictEqual(triggerMet({ kind: "always" }, facts).met, true);
  });
  it("met: cashAtLeast", () => {
    assert.strictEqual(triggerMet({ kind: "cashAtLeast", credits: 50000 }, facts).met, true);
    assert.strictEqual(triggerMet({ kind: "cashAtLeast", credits: 150000 }, facts).met, false);
  });
  it("met: routeProfitAtLeast", () => {
    assert.strictEqual(triggerMet({ kind: "routeProfitAtLeast", profitPerTrip: 30000 }, facts).met, true);
    assert.strictEqual(triggerMet({ kind: "routeProfitAtLeast", profitPerTrip: 50000 }, facts).met, false);
  });
  it("met: shipHoldEmpty", () => {
    assert.strictEqual(triggerMet({ kind: "shipHoldEmpty", ship: { by: "command" } }, facts).met, true);
    const fullFacts = { ...facts, ships: [{ symbol: "CMD-1", isCommand: true, cargoUnits: 10, waypoint: "W1", docked: true }] };
    assert.strictEqual(triggerMet({ kind: "shipHoldEmpty", ship: { by: "command" } }, fullFacts).met, false);
  });
  it("met: taskDone", () => {
    assert.strictEqual(triggerMet({ kind: "taskDone", taskKey: "task-1" }, facts).met, true);
    assert.strictEqual(triggerMet({ kind: "taskDone", taskKey: "unknown" }, facts).met, false);
  });
  it("met: all", () => {
    const trigger: Trigger = { kind: "all", of: [
      { kind: "always" },
      { kind: "cashAtLeast", credits: 50000 }
    ]};
    assert.strictEqual(triggerMet(trigger, facts).met, true);
    
    const triggerFail: Trigger = { kind: "all", of: [
      { kind: "always" },
      { kind: "cashAtLeast", credits: 150000 }
    ]};
    assert.strictEqual(triggerMet(triggerFail, facts).met, false);
  });
  it("shipHoldEmpty with unknown command ship is not met", () => {
    const noCmdFacts = { ...facts, ships: [] };
    assert.strictEqual(triggerMet({ kind: "shipHoldEmpty", ship: { by: "command" } }, noCmdFacts).met, false);
  });
});

describe("Opening Tasks Decide", () => {
  const facts: OpeningFacts = {
    spendable: 100000,
    bestRouteProfit: 40000,
    ships: [{ symbol: "CMD-1", isCommand: true, cargoUnits: 0, waypoint: "W1", docked: true }],
    yards: [{ waypoint: "Y1", shipType: "SHIP_LIGHT_SHUTTLE", price: 80000 }],
    doneKeys: new Set()
  };

  it("stepIndex 0 unmet trigger -> wait", () => {
    const task = {
      trigger: { kind: "cashAtLeast", credits: 200000 } as Trigger,
      steps: [{ kind: "setDoctrine", key: "k", value: 1 } as Step],
      stepIndex: 0,
      refs: {}
    };
    const d = decide(task, facts);
    assert.strictEqual(d.kind, "wait");
  });

  it("stepIndex 1 unmet trigger -> run", () => {
    const task = {
      trigger: { kind: "cashAtLeast", credits: 200000 } as Trigger,
      steps: [{ kind: "setDoctrine", key: "k", value: 1 }, { kind: "setDoctrine", key: "k2", value: 2 }] as Step[],
      stepIndex: 1,
      refs: {}
  };
    const d = decide(task, facts);
    assert.strictEqual(d.kind, "run");
  });

  it("stepIndex === steps.length -> done", () => {
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "setDoctrine", key: "k", value: 1 } as Step],
      stepIndex: 1,
      refs: {}
    };
    const d = decide(task, facts);
    assert.strictEqual(d.kind, "done");
  });

  it("setRole on {by:step,step:0} with no ref -> fail", () => {
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [
        { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false },
        { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" }
      ] as Step[],
      stepIndex: 1,
      refs: {}
    };
    const d = decide(task, facts);
    assert.strictEqual(d.kind, "fail");
  });

  it("setRole on {by:step,step:0} with ref but ship not in fleet -> fail", () => {
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [
        { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false },
        { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" }
      ] as Step[],
      stepIndex: 1,
      refs: { "0": "S-1" }
    };
    const d = decide(task, facts);
    assert.strictEqual(d.kind, "fail");
  });

  it("buyShip: no yard row for type -> wait", () => {
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "buyShip", shipType: "SHIP_PROBE", maxPrice: 100000, preApproved: false } as Step],
      stepIndex: 0,
      refs: {}
    };
    const d = decide(task, facts);
    assert.strictEqual(d.kind, "wait");
  });

  it("buyShip: yard row over maxPrice -> wait", () => {
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 70000, preApproved: false } as Step],
      stepIndex: 0,
      refs: {}
    };
    const d = decide(task, facts);
    assert.strictEqual(d.kind, "wait");
  });

  it("buyShip: yard with no docked ship -> wait", () => {
    const noDockedFacts = { ...facts, ships: [{ symbol: "CMD-1", isCommand: true, cargoUnits: 0, waypoint: "W1", docked: false }] };
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false } as Step],
      stepIndex: 0,
      refs: {}
    };
    const d = decide(task, noDockedFacts);
    assert.strictEqual(d.kind, "wait");
  });

  it("buyShip: two yards, both docked, 90k and 80k -> run 80k", () => {
    const multiYardsFacts = { ...facts, yards: [
      { waypoint: "Y1", shipType: "SHIP_LIGHT_SHUTTLE", price: 90000 },
      { waypoint: "Y2", shipType: "SHIP_LIGHT_SHUTTLE", price: 80000 },
    ]};
    const multiYardsShips = [
      { symbol: "CMD-1", isCommand: true, cargoUnits: 0, waypoint: "Y1", docked: true },
      { symbol: "S-1", isCommand: false, cargoUnits: 0, waypoint: "Y2", docked: true },
    ];
    const finalFacts = { ...multiYardsFacts, ships: multiYardsShips };
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false } as Step],
      stepIndex: 0,
      refs: {}
    };
    const d = decide(task, finalFacts);
    assert.strictEqual(d.kind, "run");
    assert.strictEqual(d.buy?.yard, "Y2");
    assert.strictEqual(d.buy?.price, 80000);
  });

  it("buyShip: equal prices -> lexicographically smaller waypoint", () => {
    const equalYardsFactsFixed = { ...facts, yards: [
      { waypoint: "Y2", shipType: "SHIP_LIGHT_SHUTTLE", price: 80000 },
      { waypoint: "Y1", shipType: "SHIP_LIGHT_SHUTTLE", price: 80000 },
    ]};
    const equalYardsShips = [
      { symbol: "CMD-1", isCommand: true, cargoUnits: 0, waypoint: "Y1", docked: true },
      { symbol: "S-1", isCommand: false, cargoUnits: 0, waypoint: "Y2", docked: true },
    ];
    const finalFacts = { ...equalYardsFactsFixed, ships: equalYardsShips };
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false } as Step],
      stepIndex: 0,
      refs: {}
    };
    const d = decide(task, finalFacts);
    assert.strictEqual(d.kind, "run");
    assert.strictEqual(d.buy?.yard, "Y1");
  });

  it("buyShip: cheapest yard has no docked ship but a dearer one does -> run dearer", () => {
    const cheapYardsFacts = { ...facts, yards: [
      { waypoint: "Y1", shipType: "SHIP_LIGHT_SHUTTLE", price: 70000 },
      { waypoint: "Y2", shipType: "SHIP_LIGHT_SHUTTLE", price: 80000 },
    ]};
    const cheapYardsShips = [
      { symbol: "CMD-1", isCommand: true, cargoUnits: 0, waypoint: "Y2", docked: true },
    ];
    const finalFacts = { ...cheapYardsFacts, ships: cheapYardsShips };
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false } as Step],
      stepIndex: 0,
      refs: {}
    };
    const d = decide(task, finalFacts);
    assert.strictEqual(d.kind, "run");
    assert.strictEqual(d.buy?.yard, "Y2");
    assert.strictEqual(d.buy?.price, 80000);
  });

  it("buyShip: spendable below price -> wait", () => {
    const task = {
      trigger: { kind: "always" } as Trigger,
      steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false } as Step],
      stepIndex: 0,
      refs: {}
  };
    const lowCashFacts = { ...facts, spendable: 70000 };
    const d = decide(task, lowCashFacts);
    assert.strictEqual(d.kind, "wait");
  });
});
