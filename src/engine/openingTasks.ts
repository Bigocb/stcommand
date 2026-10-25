export const OPENING_ROLES = ["miner", "trader", "surveyor", "tour", "explorer", "keeper", "scout", "siphoner"] as const;
export type OpeningRole = (typeof OPENING_ROLES)[number];

/** Copy of the ShipType union in src/core/schema.d.ts (line ~1825). */
export const OPENING_SHIP_TYPES = [
  "SHIP_PROBE", "SHIP_MINING_DRONE", "SHIP_SIPHON_DRONE", "SHIP_INTERCEPTOR", "SHIP_LIGHT_HAULER", "SHIP_COMMAND_FRIGATE", "SHIP_EXPLORER",
  "SHIP_HEAVY_FREIGHTER", "SHIP_LIGHT_SHUTTLE", "SHIP_ORE_HOUND", "SHIP_REFINING_FREIGHTER", "SHIP_SURVEYOR", "SHIP_BULK_FREIGHTER",
] as const;
export type OpeningShipType = (typeof OPENING_SHIP_TYPES)[number];

/** command = the one ship whose registration.role is "COMMAND"; step = the ship that step N (a buyShip step) bought; symbol = a literal ship symbol. */
export type ShipRef = { by: "command" } | { by: "step"; step: number } | { by: "symbol"; symbol: string };

export type Trigger =
  | { kind: "always" }
  | { kind: "cashAtLeast"; credits: number }
  | { kind: "routeProfitAtLeast"; profitPerTrip: number }
  | { kind: "shipHoldEmpty"; ship: ShipRef }
  | { kind: "taskDone"; taskKey: string }
  /** Every home-system market with at least the keeper minimum of goods has been priced by a ship's visit. */
  | { kind: "marketsSurveyed" }
  /** The home system's jump gate has had this share (0-100) of its materials delivered; 100 means the gate is open. */
  | { kind: "gateProgressAtLeast"; pct: number }
  | { kind: "all"; of: Trigger[] };

export type Step =
  /** keepCash: the purchase waits unless this much cash is left after paying (a hull is no use if it leaves nothing to trade with). */
  | { kind: "buyShip"; shipType: OpeningShipType; maxPrice: number; preApproved: boolean; keepCash?: number }
  | { kind: "setRole"; ship: ShipRef; role: OpeningRole }
  | { kind: "contractDuty"; ship: ShipRef; on: boolean }
  | { kind: "setDoctrine"; key: string; value?: number; enabled?: boolean }
  /** Start the home gate's construction mission (idempotent). paused: true leaves it created but not buying, so its materials are protected and the chain is visible; false lets it buy (the engine's own producer-activity and recovery guards still apply). Pacing fields are the mission's own (see setMissionPacing). */
  | { kind: "startGateMission"; paused?: boolean; buyLotUnits?: number; buyGapMin?: number; maxInflationPct?: number; recoverPct?: number; onlyMaterials?: string[] }
  /** Start a feeder tier: a crew that sources `good` and sells it into `waypoint`. carrier: a ship symbol to crew it, so the engine's own picker (biggest empty hold first) cannot take a better-placed hull. */
  | { kind: "startFeed"; waypoint: string; good: string; mine?: boolean; carrierTarget?: number; buyAt?: string; stopAtSupply?: "MODERATE" | "HIGH" | "ABUNDANT"; maxLossPerUnit?: number; carrier?: string }
  /** Does nothing itself: the task waits here until the trigger is met, then carries on with the next step. */
  | { kind: "waitFor"; trigger: Trigger };

export interface TaskSpec { key: string; name: string; trigger: Trigger; steps: Step[] }

export type TaskStatus = "queued" | "active" | "done" | "failed" | "needs_review" | "cancelled";

export interface TaskRun extends TaskSpec {
  id: number;
  status: TaskStatus;
  stepIndex: number;
  stepPhase: "idle" | "started";
  refs: Record<string, string>;
  note: string | null;
}

export interface OpeningTaskRow extends TaskRun {
  id: number;
}

export interface OpeningTemplateRow {
  id: number;
  name: string;
  tasks: TaskSpec[];
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateTaskSpec(x: unknown): Validation<TaskSpec> {
  if (typeof x !== "object" || x === null) return { ok: false, error: "Task spec must be an object" };
  const s = x as any;

  if (typeof s.key !== "string" || !/^[a-z0-9_-]{1,24}$/.test(s.key)) {
    return { ok: false, error: "Key must be 1-24 chars, lowercase alphanumeric, underscores or hyphens" };
  }
  if (typeof s.name !== "string" || s.name.trim().length === 0 || s.name.trim().length > 80) {
    return { ok: false, error: "Name must be 1-80 characters" };
  }
  if (!Array.isArray(s.steps) || s.steps.length === 0 || s.steps.length > 8) {
    return { ok: false, error: "Steps must be an array of 1 to 8 items" };
  }

  const vTrig = validateTrigger(s.trigger);
  if (!vTrig.ok) return { ok: false, error: "Trigger: " + vTrig.error };

  const cleanedSteps: Step[] = [];
  for (let i = 0; i < s.steps.length; i++) {
    const step = s.steps[i];
    if (typeof step !== "object" || step === null) return { ok: false, error: "Step " + i + " must be an object" };
    
    if (step.kind === "buyShip") {
      if (!OPENING_SHIP_TYPES.includes(step.shipType)) return { ok: false, error: "Step " + i + ": invalid ship type" };
      if (typeof step.maxPrice !== "number" || step.maxPrice < 1 || step.maxPrice > 5000000 || !Number.isFinite(step.maxPrice)) {
        return { ok: false, error: "Step " + i + ": maxPrice must be 1 to 5,000,000" };
      }
      if (typeof step.preApproved !== "boolean") return { ok: false, error: "Step " + i + ": preApproved must be boolean" };
      if (step.keepCash !== undefined && (typeof step.keepCash !== "number" || !Number.isFinite(step.keepCash) || step.keepCash < 0 || step.keepCash > 1000000000)) {
        return { ok: false, error: "Step " + i + ": keepCash must be 0 to 1,000,000,000" };
      }
    } else if (step.kind === "setRole") {
      if (!validateShipRef(step.ship, i, s.steps)) return { ok: false, error: "Step " + i + ": invalid ship ref" };
      if (!OPENING_ROLES.includes(step.role)) return { ok: false, error: "Step " + i + ": invalid role" };
    } else if (step.kind === "contractDuty") {
      if (!validateShipRef(step.ship, i, s.steps)) return { ok: false, error: "Step " + i + ": invalid ship ref" };
      if (typeof step.on !== "boolean") return { ok: false, error: "Step " + i + ": on must be boolean" };
    } else if (step.kind === "setDoctrine") {
      if (typeof step.key !== "string" || step.key.length === 0 || step.key.length > 60) {
        return { ok: false, error: "Step " + i + ": doctrine key must be 1-60 chars" };
      }
      if (step.value === undefined && step.enabled === undefined) {
        return { ok: false, error: "Step " + i + ": doctrine must have value or enabled" };
      }
      if (step.value !== undefined && (!Number.isFinite(step.value))) {
        return { ok: false, error: "Step " + i + ": doctrine value must be finite" };
      }
      if (step.enabled !== undefined && typeof step.enabled !== "boolean") {
        return { ok: false, error: "Step " + i + ": doctrine enabled must be boolean" };
      }
    } else if (step.kind === "startGateMission") {
      const e = validateGateMissionStep(step);
      if (e) return { ok: false, error: "Step " + i + ": " + e };
    } else if (step.kind === "startFeed") {
      const e = validateFeedStep(step);
      if (e) return { ok: false, error: "Step " + i + ": " + e };
    } else if (step.kind === "waitFor") {
      const w = validateTrigger(step.trigger);
      if (!w.ok) return { ok: false, error: "Step " + i + ": " + w.error };
      if (w.value.kind === "all" ? w.value.of.some((m) => m.kind === "shipHoldEmpty" && m.ship.by === "step") : false) {
        return { ok: false, error: "Step " + i + ": a waitFor trigger cannot refer to a bought ship by step" };
      }
      cleanedSteps.push({ kind: "waitFor", trigger: w.value });
      continue;
    } else {
      return { ok: false, error: "Step " + i + ": unknown kind" };
    }
    cleanedSteps.push(step);
  }

  return { 
    ok: true, 
    value: { key: s.key, name: s.name.trim(), trigger: vTrig.value, steps: cleanedSteps } 
  };
}

const posInt = (n: unknown, lo: number, hi: number): boolean => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

function validateGateMissionStep(s: any): string | undefined {
  if (s.paused !== undefined && typeof s.paused !== "boolean") return "paused must be boolean";
  if (s.buyLotUnits !== undefined && !posInt(s.buyLotUnits, 1, 1000)) return "buyLotUnits must be a whole number 1 to 1000";
  if (s.buyGapMin !== undefined && !posInt(s.buyGapMin, 0, 1440)) return "buyGapMin must be a whole number 0 to 1440";
  if (s.maxInflationPct !== undefined && !posInt(s.maxInflationPct, 0, 500)) return "maxInflationPct must be a whole number 0 to 500";
  if (s.recoverPct !== undefined && !posInt(s.recoverPct, 0, 100)) return "recoverPct must be a whole number 0 to 100";
  if (s.onlyMaterials !== undefined && (!Array.isArray(s.onlyMaterials) || s.onlyMaterials.length > 10 || s.onlyMaterials.some((m: unknown) => typeof m !== "string" || !/^[A-Z0-9_]{2,40}$/.test(m)))) return "onlyMaterials must be up to 10 trade symbols";
  return undefined;
}

function validateFeedStep(s: any): string | undefined {
  if (typeof s.waypoint !== "string" || !/^[A-Z0-9-]{3,40}$/.test(s.waypoint)) return "waypoint must be a waypoint symbol like X1-AB12-C3";
  if (typeof s.good !== "string" || !/^[A-Z0-9_]{2,40}$/.test(s.good)) return "good must be a trade symbol like IRON_ORE";
  if (s.mine !== undefined && typeof s.mine !== "boolean") return "mine must be boolean";
  if (s.carrierTarget !== undefined && !posInt(s.carrierTarget, 1, 10)) return "carrierTarget must be a whole number 1 to 10";
  if (s.carrier !== undefined && (typeof s.carrier !== "string" || !/^[A-Z0-9-]{1,40}$/.test(s.carrier))) return "carrier must be a ship symbol";
  if (s.buyAt !== undefined && (typeof s.buyAt !== "string" || !/^[A-Z0-9-]{3,40}$/.test(s.buyAt))) return "buyAt must be a waypoint symbol";
  if (s.stopAtSupply !== undefined && !["MODERATE", "HIGH", "ABUNDANT"].includes(s.stopAtSupply)) return "stopAtSupply must be MODERATE, HIGH or ABUNDANT";
  if (s.maxLossPerUnit !== undefined && (typeof s.maxLossPerUnit !== "number" || !Number.isFinite(s.maxLossPerUnit) || s.maxLossPerUnit < 0 || s.maxLossPerUnit > 100000)) return "maxLossPerUnit must be 0 to 100000";
  return undefined;
}

function validateTrigger(t: any): Validation<Trigger> {
  if (typeof t !== "object" || t === null) return { ok: false, error: "Trigger must be an object" };
  if (t.kind === "always") return { ok: true, value: { kind: "always" } };
  if (t.kind === "cashAtLeast") {
    if (typeof t.credits !== "number" || t.credits < 0 || t.credits > 1000000000 || !Number.isFinite(t.credits)) {
      return { ok: false, error: "credits must be 0 to 1,000,000,000" };
    }
    return { ok: true, value: { kind: "cashAtLeast", credits: t.credits } };
  }
  if (t.kind === "routeProfitAtLeast") {
    if (typeof t.profitPerTrip !== "number" || t.profitPerTrip < 1 || t.profitPerTrip > 100000000 || !Number.isFinite(t.profitPerTrip)) {
      return { ok: false, error: "profitPerTrip must be 1 to 100,000,000" };
    }
    return { ok: true, value: { kind: "routeProfitAtLeast", profitPerTrip: t.profitPerTrip } };
  }
  if (t.kind === "shipHoldEmpty") {
    if (!validateShipRef(t.ship, -1)) return { ok: false, error: "invalid ship ref (by:step not allowed in trigger)" };
    return { ok: true, value: { kind: "shipHoldEmpty", ship: t.ship } };
  }
  if (t.kind === "marketsSurveyed") return { ok: true, value: { kind: "marketsSurveyed" } };
  if (t.kind === "gateProgressAtLeast") {
    if (typeof t.pct !== "number" || !Number.isFinite(t.pct) || t.pct < 0 || t.pct > 100) return { ok: false, error: "pct must be 0 to 100" };
    return { ok: true, value: { kind: "gateProgressAtLeast", pct: t.pct } };
  }
  if (t.kind === "taskDone") {
    if (typeof t.taskKey !== "string" || t.taskKey.length === 0) return { ok: false, error: "taskKey required" };
    return { ok: true, value: { kind: "taskDone", taskKey: t.taskKey } };
  }
  if (t.kind === "all") {
    if (!Array.isArray(t.of) || t.of.length === 0 || t.of.length > 6) {
      return { ok: false, error: "must have 1 to 6 members" };
    }
    const cleanedOf: Trigger[] = [];
    for (const m of t.of) {
      if (m?.kind === "all") return { ok: false, error: "nested 'all' triggers not allowed" };
      const v = validateTrigger(m);
      if (!v.ok) return { ok: false, error: v.error };
      cleanedOf.push(v.value);
    }
    return { ok: true, value: { kind: "all", of: cleanedOf } };
  }
  return { ok: false, error: "unknown trigger kind" };
}

function validateShipRef(ref: any, currentStepIndex: number, steps: Step[] = []): boolean {
  if (typeof ref !== "object" || ref === null) return false;
  if (ref.by === "command") return true;
  if (ref.by === "symbol") return typeof ref.symbol === "string" && /^[A-Z0-9-]{1,40}$/.test(ref.symbol);
  if (ref.by === "step") {
    if (currentStepIndex === -1) return false;
    if (typeof ref.step !== "number" || ref.step < 0 || ref.step >= currentStepIndex) return false;
    const targetStep = steps[ref.step];
    if (!targetStep || targetStep.kind !== "buyShip") return false;
    return true;
  }
  return false;
}

export function validateTemplateTasks(x: unknown): Validation<TaskSpec[]> {
  if (!Array.isArray(x)) return { ok: false, error: "Tasks must be an array" };
  if (x.length === 0 || x.length > 12) return { ok: false, error: "Template must have 1 to 12 tasks" };
  const cleaned: TaskSpec[] = [];
  const keys = new Set<string>();
  for (const s of x) {
    const v = validateTaskSpec(s);
    if (!v.ok) return { ok: false, error: v.error };
    if (keys.has(v.value.key)) return { ok: false, error: "Duplicate key: " + v.value.key };
    keys.add(v.value.key);
    cleaned.push(v.value);
  }
  for (const s of cleaned) {
    const checkTaskDone = (t: Trigger): boolean => {
      if (t.kind === "taskDone") return keys.has(t.taskKey);
      if (t.kind === "all") return t.of.every(checkTaskDone);
      return true;
    };
    if (!checkTaskDone(s.trigger)) return { ok: false, error: "Task " + s.key + " references unknown taskKey" };
  }
  return { ok: true, value: cleaned };
}

export interface OpeningFacts {
  spendable: number;
  bestRouteProfit: number | undefined;
  ships: { symbol: string; isCommand: boolean; cargoUnits: number; waypoint: string; docked: boolean }[];
  yards: { waypoint: string; shipType: string; price: number }[];
  doneKeys: ReadonlySet<string>;
  /** Home-system markets worth a keeper (goods count at or above the keeper minimum, or unknown) that no ship has priced yet. Undefined when not gathered. */
  /** Home gate progress 0-100 (100 = open); undefined when unknown. */
  gatePct?: number;
  surveyMissing?: { total: number; missing: string[]; minGoods: number };
}

export function triggerMet(t: Trigger, f: OpeningFacts): { met: boolean; reason: string } {
  switch (t.kind) {
    case "always": return { met: true, reason: "always met" };
    case "cashAtLeast": {
      const met = f.spendable >= t.credits;
      return { met, reason: "spendable " + f.spendable.toLocaleString() + (met ? " >= " : " < ") + t.credits.toLocaleString() };
    }
    case "routeProfitAtLeast": {
      if (f.bestRouteProfit === undefined) return { met: false, reason: "no routes offered" };
      const met = f.bestRouteProfit >= t.profitPerTrip;
      return { met, reason: "best route profit " + f.bestRouteProfit.toLocaleString() + (met ? " >= " : " < ") + t.profitPerTrip.toLocaleString() };
    }
    case "shipHoldEmpty": {
      const symbol = resolveShipRef(t.ship, {}, f);
      if (!symbol) return { met: false, reason: "ship ref could not be resolved" };
      const ship = f.ships.find(s => s.symbol === symbol);
      if (!ship) return { met: false, reason: symbol + " is not in the fleet" };
      const met = ship.cargoUnits === 0;
      return { met, reason: symbol + " hold " + (met ? "is empty" : "contains " + ship.cargoUnits + " units") };
    }
    case "taskDone": {
      const met = f.doneKeys.has(t.taskKey);
      return { met, reason: "task " + t.taskKey + (met ? " is done" : " is not done") };
    }
    case "gateProgressAtLeast": {
      if (f.gatePct === undefined) return { met: false, reason: "gate progress not known yet" };
      const met = f.gatePct >= t.pct;
      return { met, reason: "gate " + f.gatePct + "%" + (met ? " >= " : " < ") + t.pct + "%" };
    }
    case "marketsSurveyed": {
      const c = f.surveyMissing;
      if (!c) return { met: false, reason: "market coverage not known yet" };
      if (c.total === 0) return { met: false, reason: "no markets known in the home system yet" };
      const met = c.missing.length === 0;
      return { met, reason: met ? c.total + " markets with " + c.minGoods + "+ goods all priced" : c.missing.length + " of " + c.total + " markets with " + c.minGoods + "+ goods still unpriced (" + c.missing.slice(0, 4).join(", ") + (c.missing.length > 4 ? ", ..." : "") + ")" };
    }
    case "all": {
      for (const m of t.of) {
        const res = triggerMet(m, f);
        if (!res.met) return res;
      }
      return { met: true, reason: "all triggers met" };
    }
  }
  throw new Error("unknown trigger kind");
}

export type Decision =
  | { kind: "wait"; reason: string }
  | { kind: "run"; stepIndex: number; reason: string; buy?: { yard: string; price: number } }
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string };

export function decide(task: Pick<TaskRun, "trigger" | "steps" | "stepIndex" | "refs">, f: OpeningFacts): Decision {
  if (task.stepIndex >= task.steps.length) return { kind: "done", reason: "all steps finished" };
  if (task.stepIndex === 0) {
    const trig = triggerMet(task.trigger, f);
    if (!trig.met) return { kind: "wait", reason: trig.reason };
  }
  const step = task.steps[task.stepIndex];
  if (!step) return { kind: "fail", reason: "step missing at index" };
  if (step.kind === "setRole" || step.kind === "contractDuty") {
    const shipRef = (step as any).ship;
    if (!shipRef) return { kind: "fail", reason: "step missing ship ref: " + JSON.stringify(step) };
    const symbol = resolveShipRef(shipRef, task.refs, f);
    if (!symbol) {
      // A ship an earlier step just bought is recorded in refs at once but only shows in the fleet snapshot a moment later. Failing here
      // killed the task for good (2026-10-25: "Ship for touring" bought THEOREM-7, then failed on step 2 with the ship already in the fleet).
      const bought = shipRef.by === "step" ? task.refs[String(shipRef.step)] : undefined;
      if (bought) return { kind: "wait", reason: "waiting for " + bought + " (bought by step " + (shipRef.step + 1) + ") to appear in the fleet" };
      return { kind: "fail", reason: "could not resolve ship ref: " + JSON.stringify(shipRef) };
    }
    return { kind: "run", stepIndex: task.stepIndex, reason: "execute " + step.kind };
  }
  if (step.kind === "setDoctrine" || step.kind === "startGateMission" || step.kind === "startFeed") {
    return { kind: "run", stepIndex: task.stepIndex, reason: "execute " + step.kind };
  }
  if (step.kind === "waitFor") {
    const w = triggerMet(step.trigger, f);
    if (!w.met) return { kind: "wait", reason: "step " + (task.stepIndex + 1) + " waits: " + w.reason };
    return { kind: "run", stepIndex: task.stepIndex, reason: "wait over: " + w.reason };
  }
  if (step.kind === "buyShip") {
    const s = step as any;
    const candidates = f.yards.filter(y => y.shipType === s.shipType && y.price <= s.maxPrice);
    if (candidates.length === 0) {
      return { kind: "wait", reason: "no yard in the home system stocks " + s.shipType + " at or under " + s.maxPrice };
    }
    const viable = candidates.filter(y => f.ships.some(s => s.docked && s.waypoint === y.waypoint));
    if (viable.length === 0) {
      return { kind: "wait", reason: "no ship of ours is docked at a yard that stocks " + s.shipType };
    }
    const sorted = [...viable].sort((a, b) => a.price - b.price || a.waypoint.localeCompare(b.waypoint));
    const best = sorted[0];
    if (!best) return { kind: "fail", reason: "no viable yards found after sorting" };
    if (f.spendable < best.price) {
      return { kind: "wait", reason: "spendable " + f.spendable.toLocaleString() + " < price " + best.price.toLocaleString() };
    }
    const keep = s.keepCash ?? 0;
    if (f.spendable - best.price < keep) {
      return { kind: "wait", reason: "buying at " + best.price.toLocaleString() + " would leave " + (f.spendable - best.price).toLocaleString() + ", under the " + keep.toLocaleString() + " to keep" };
    }
    return { 
      kind: "run", 
      stepIndex: task.stepIndex, 
      reason: "buy " + s.shipType + " at " + best.waypoint + " for " + best.price, 
      buy: { yard: best.waypoint, price: best.price } 
    };
  }
  throw new Error("unknown step kind");
}

function resolveShipRef(ref: ShipRef, refs: Record<string, string>, f: OpeningFacts): string | null {
  if (ref.by === "command") {
    const s = f.ships.find(s => s.isCommand);
    return s ? s.symbol : null;
  }
  if (ref.by === "symbol") {
    return f.ships.some(s => s.symbol === ref.symbol) ? ref.symbol : null;
  }
  if (ref.by === "step") {
    const symbol = refs[String(ref.step)];
    if (!symbol) return null;
    return f.ships.some(s => s.symbol === symbol) ? symbol : null;
  }
  return null;
}

export const STANDARD_OPENING: TaskSpec[] = [
  {
    key: "cmd-trader",
    name: "Command ship trades",
    trigger: { kind: "routeProfitAtLeast", profitPerTrip: 30000 },
    steps: [
      { kind: "setRole", ship: { by: "command" }, role: "trader" }
    ]
  },
  {
    key: "contract-ship",
    name: "Contract ship",
    trigger: { 
      kind: "all", 
      of: [
        { kind: "taskDone", taskKey: "cmd-trader" },
        { kind: "shipHoldEmpty", ship: { by: "command" } },
        { kind: "cashAtLeast", credits: 110000 }
      ] 
    },
    steps: [
      { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false },
      { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
      { kind: "contractDuty", ship: { by: "step", step: 0 }, on: true }
    ]
  },
  {
    key: "tour-ship",
    name: "Tour ship",
    trigger: { 
      kind: "all", 
      of: [
        { kind: "taskDone", taskKey: "contract-ship" },
        { kind: "cashAtLeast", credits: 110000 }
      ] 
    },
    steps: [
      { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100000, preApproved: false },
      { kind: "setRole", ship: { by: "step", step: 0 }, role: "tour" }
    ]
  }
];