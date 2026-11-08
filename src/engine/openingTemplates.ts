import type { TaskSpec } from "./openingTasks.js";

/**
 * The opening the operator set out on 2026-11-08, as data (docs/reset-opening-playbook.md, "Opening v3").
 *
 * Order: THEO-1 tours, then trades once a route pays; at 200k keepers on the shipyards; when cash is back at 200k a shuttle for
 * contracts; at 1M keepers on the top markets; when cash is back at 1M a light hauler put on the gate crew, and the gate mission
 * starts buying with the price ceilings the operator named (FAB_MATS 2,000, ADVANCED_CIRCUITRY 4,000). "Wait till we get back to"
 * is read as: the next purchase waits for the previous task to finish and for cash to be at its own level again.
 *
 * Saved on the tenant under OPENING_V3_NAME and under the name the reset recovery looks for by default (DEFAULT_OPENING_TEMPLATE),
 * and queued by the reset recovery with every key ending -<MMDD> of the reset date (instantiateTemplate), so a task finished last
 * week can never hold this week's back. Keys here must stay short enough for that suffix (24 characters in all).
 *
 * Not in it, because the new map is unknown until the reset: feeds into the gate producers' inputs (they name waypoints), the third
 * gate material's ceiling, and the hour 1-3 chain work in the playbook. Those stay by hand.
 */
export const OPENING_V3_NAME = "Opening v3 (2026-11-08)";

/** Price ceilings the operator asked for (2026-11-08). */
export const GATE_CEILINGS = { FAB_MATS: 2000, ADVANCED_CIRCUITRY: 4000 } as const;

const PACING = { buyLotUnits: 20, buyGapMin: 30, recoverPct: 3, maxInflationPct: 25, maxPriceBy: { ...GATE_CEILINGS } } as const;

export const OPENING_V3: TaskSpec[] = [
  {
    key: "o3-tour",
    name: "Command ship tours the home markets",
    trigger: { kind: "always" },
    steps: [{ kind: "setRole", ship: { by: "command" }, role: "tour" }],
  },
  {
    key: "o3-start",
    name: "Start settings: cash floor 20k, top-up and idle parking off, keeper reserve 100k",
    trigger: { kind: "always" },
    steps: [
      { kind: "setDoctrine", key: "cashFloor", value: 20000 },
      { kind: "setDoctrine", key: "keeperTopUpPerHour", enabled: false },
      { kind: "setDoctrine", key: "freshIdleMinHourlyProfit", enabled: false },
      { kind: "setDoctrine", key: "keeperAutoApproveMinCash", value: 100000, enabled: true },
    ],
  },
  {
    key: "o3-gatemission",
    name: "Create the gate mission, paused, with the price ceilings",
    trigger: { kind: "always" },
    steps: [{ kind: "startGateMission", paused: true, ...PACING }],
  },
  {
    key: "o3-trader",
    name: "Command ship trades once a route pays 15k a trip, or after 30 minutes",
    trigger: { kind: "any", of: [{ kind: "routeProfitAtLeast", profitPerTrip: 15000 }, { kind: "minutesSinceQueued", minutes: 30 }] },
    steps: [{ kind: "setRole", ship: { by: "command" }, role: "trader" }],
  },
  {
    key: "o3-yardkeep",
    name: "At 200k: keepers on the shipyards",
    trigger: { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-trader" }, { kind: "cashAtLeast", credits: 200000 }] },
    steps: [{ kind: "keepers", scope: "shipyards" }],
  },
  {
    key: "o3-contract",
    name: "Back at 200k: a shuttle for contracts",
    trigger: { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-yardkeep" }, { kind: "cashAtLeast", credits: 200000 }] },
    steps: [
      { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 130000, keepCash: 60000, preApproved: true },
      { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
      { kind: "contractDuty", ship: { by: "step", step: 0 }, on: true },
    ],
  },
  {
    key: "o3-topkeep",
    name: "At 1M: keepers on the top markets, top-up back on, cash floor 100k",
    trigger: { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-contract" }, { kind: "cashAtLeast", credits: 1000000 }] },
    steps: [
      { kind: "setDoctrine", key: "keeperAutoApproveMinCash", value: 300000, enabled: true },
      { kind: "setDoctrine", key: "keeperTopUpPerHour", enabled: true },
      { kind: "setDoctrine", key: "cashFloor", value: 100000 },
      { kind: "keepers", scope: "top", count: 10 },
    ],
  },
  {
    key: "o3-gatehaul",
    name: "Back at 1M: a light hauler on the gate crew, gate buying starts",
    trigger: { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-topkeep" }, { kind: "cashAtLeast", credits: 1000000 }] },
    steps: [
      { kind: "buyShip", shipType: "SHIP_LIGHT_HAULER", maxPrice: 400000, keepCash: 300000, preApproved: true },
      { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
      { kind: "gateCrew", ship: { by: "step", step: 0 } },
      { kind: "startGateMission", paused: false, ...PACING, cashFloor: 300000, cashResume: 400000 },
    ],
  },
  {
    key: "o3-finalpush",
    name: "Gate 85%: drop the gate cash floor",
    trigger: { kind: "gateProgressAtLeast", pct: 85 },
    steps: [{ kind: "startGateMission", paused: false, cashFloor: 0, cashResume: 0 }],
  },
  {
    key: "o3-gateopen",
    name: "Gate open: cash floor 100k, idle parking back on",
    trigger: { kind: "gateProgressAtLeast", pct: 100 },
    steps: [
      { kind: "setDoctrine", key: "cashFloor", value: 100000 },
      { kind: "setDoctrine", key: "freshIdleMinHourlyProfit", value: 20000, enabled: true },
    ],
  },
];
