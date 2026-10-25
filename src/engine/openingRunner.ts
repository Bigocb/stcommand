import type { Store } from "../db/store.js";
import {
  decide,
  type Decision,
  type OpeningFacts,
  type ShipRef,
  type Step,
  type TaskRun,
  type Trigger,
} from "./openingTasks.js";

/**
 * Applies the pure evaluator's decisions to a live fleet.
 *
 * `src/engine/openingTasks.ts` decides — it takes fleet facts and returns
 * "wait", "run step N", "done" or "fail", with a one-line reason. This class
 * is the only part that *acts*, and it acts through the same FleetManager
 * methods the dashboard and MCP use (CLAUDE.md's one-gate rule), so a task can
 * never take a path an operator could not.
 *
 * Deliberately inert until the `openingAutomation` doctrine clause is on: the
 * caller (FleetManager.tick) checks the clause before constructing this, so an
 * off clause changes nothing.
 */
export interface OpeningShipFacts {
  symbol: string;
  isCommand: boolean;
  cargoUnits: number;
  waypoint: string;
  docked: boolean;
}

export interface OpeningYardFacts {
  waypoint: string;
  shipType: string;
  price: number;
}

/** Everything the runner needs from the live engine — kept structural so this
 *  module never imports fleet.ts (which imports this one). */
export interface OpeningHost {
  spendable(): number;
  ships(): OpeningShipFacts[];
  yards(): Promise<OpeningYardFacts[]>;
  /** Best profit-per-trip among the routes offered this tick; undefined when the dispatcher offered none. */
  bestRouteProfit(): number | undefined;
  /** Home-system markets at or above the keeper minimum of goods that no ship has priced yet (see surveyCoverage.ts). */
  /** Home gate progress 0-100 (100 = open); undefined when unknown. */
  gateProgress(): Promise<number | undefined>;
  surveyMissing(): Promise<{ total: number; missing: string[]; minGoods: number }>;
  buyShip(shipType: string, yardSymbol: string): Promise<{ symbol: string }>;
  setRole(shipSymbol: string, role: string): Promise<void>;
  setContractDuty(shipSymbol: string, on: boolean): Promise<void>;
  setDoctrine(key: string, patch: { value?: number; enabled?: boolean }): Promise<unknown>;
  log(msg: string): void;
}

type StepResult =
  | { ok: true; shipSymbol?: string }
  | { ok: false; error: string; needsReview?: boolean };

export class OpeningRunnerImpl {
  constructor(
    private readonly store: Store,
    private readonly host: OpeningHost,
  ) {}

  async run(tenantId: string): Promise<void> {
    const tasks = await this.store.listOpeningTasks(tenantId);
    const active = tasks.filter((t) => t.status === "queued" || t.status === "active");
    if (active.length === 0) return;

    // Facts are gathered once per pass, not once per task: the loop below can
    // move several tasks and each task would otherwise re-read the same fleet.
    const facts = await this.gatherFacts(tasks);

    for (const task of active) {
      const decision = decide(task, facts);

      if (decision.kind === "wait") continue;

      if (decision.kind === "done") {
        await this.store.updateOpeningTask(tenantId, task.id, { status: "done", note: decision.reason });
        continue;
      }

      if (decision.kind === "fail") {
        await this.store.updateOpeningTask(tenantId, task.id, { status: "failed", note: decision.reason });
        continue;
      }

      await this.runStep(tenantId, task, decision, facts);
    }
  }

  private async runStep(tenantId: string, task: TaskRun, decision: Decision, facts: OpeningFacts): Promise<void> {
    if (decision.kind !== "run") return;
    const step = task.steps[decision.stepIndex];
    if (!step) {
      await this.store.updateOpeningTask(tenantId, task.id, { status: "failed", note: "step missing at index" });
      return;
    }

    const result = await this.executeStep(task, decision.stepIndex, step, facts);
    if (!result.ok) {
      await this.store.updateOpeningTask(tenantId, task.id, {
        status: result.needsReview ? "needs_review" : "failed",
        note: result.error,
      });
      this.host.log(`opening task ${task.key}: step ${decision.stepIndex} — ${result.error}`);
      return;
    }

    const nextStepIndex = decision.stepIndex + 1;
    const done = nextStepIndex >= task.steps.length;
    const refs: Record<string, string> = { ...task.refs };
    if (result.shipSymbol) refs[String(decision.stepIndex)] = result.shipSymbol;

    await this.store.updateOpeningTask(tenantId, task.id, {
      stepIndex: nextStepIndex,
      status: done ? "done" : "active",
      refs,
      note: done ? "all steps finished" : `step ${decision.stepIndex}: ${decision.reason}`,
    });
    this.host.log(`opening task ${task.key}: ${decision.reason}${done ? " (task complete)" : ""}`);

    // A buy this pass changes what later tasks may do (spendable drops, a new
    // hull exists), so stop here and let the next tick re-gather.
    if (step.kind === "buyShip") return;
  }

  private async executeStep(
    task: TaskRun,
    stepIndex: number,
    step: Step,
    facts: OpeningFacts,
  ): Promise<StepResult> {
    try {
      if (step.kind === "buyShip") {
        // Already bought on an earlier pass — idempotent, never buy twice.
        if (task.refs[String(stepIndex)]) {
          return { ok: true, shipSymbol: task.refs[String(stepIndex)] };
        }
        if (!step.preApproved) {
          return {
            ok: false,
            needsReview: true,
            error:
              `buying a ${step.shipType} (max ${step.maxPrice.toLocaleString()}c) needs operator approval: ` +
              `the task does not mark this purchase pre-approved`,
          };
        }
        const decision = decide(task, facts);
        if (decision.kind !== "run" || !decision.buy) {
          return { ok: false, error: `no buy decision at step ${stepIndex}` };
        }
        const ship = await this.host.buyShip(step.shipType, decision.buy.yard);
        return { ok: true, shipSymbol: ship.symbol };
      }

      if (step.kind === "setRole") {
        const symbol = this.resolveShip(step.ship, task.refs, facts);
        if (!symbol) return { ok: false, error: `could not resolve ship ref ${JSON.stringify(step.ship)}` };
        await this.host.setRole(symbol, step.role);
        return { ok: true, shipSymbol: symbol };
      }

      if (step.kind === "contractDuty") {
        const symbol = this.resolveShip(step.ship, task.refs, facts);
        if (!symbol) return { ok: false, error: `could not resolve ship ref ${JSON.stringify(step.ship)}` };
        await this.host.setContractDuty(symbol, step.on);
        return { ok: true, shipSymbol: symbol };
      }

      if (step.kind === "waitFor") return { ok: true };

      if (step.kind === "setDoctrine") {
        const patch: { value?: number; enabled?: boolean } = {};
        if (step.value !== undefined) patch.value = step.value;
        if (step.enabled !== undefined) patch.enabled = step.enabled;
        await this.host.setDoctrine(step.key, patch);
        return { ok: true };
      }

      return { ok: false, error: `unknown step kind: ${(step as { kind: string }).kind}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Same resolution rules as openingTasks.ts's private helper, which only
   *  reports success/failure rather than the symbol the caller needs. */
  private resolveShip(ref: ShipRef, refs: Record<string, string>, facts: OpeningFacts): string | null {
    if (ref.by === "command") return facts.ships.find((s) => s.isCommand)?.symbol ?? null;
    if (ref.by === "symbol") return facts.ships.some((s) => s.symbol === ref.symbol) ? ref.symbol : null;
    const symbol = refs[String(ref.step)];
    if (!symbol) return null;
    return facts.ships.some((s) => s.symbol === symbol) ? symbol : null;
  }

  private async gatherFacts(tasks: TaskRun[]): Promise<OpeningFacts> {
    const yards = await this.host.yards();
    const needsCoverage = tasks.some((t) => t.status !== "done" && usesCoverage(t));
    const needsGate = tasks.some((t) => t.status !== "done" && (triggerUsesGate(t.trigger) || t.steps.some((s) => s.kind === "waitFor" && triggerUsesGate(s.trigger))));
    return {
      gatePct: needsGate ? await this.host.gateProgress() : undefined,
      surveyMissing: needsCoverage ? await this.host.surveyMissing() : undefined,
      spendable: this.host.spendable(),
      bestRouteProfit: this.host.bestRouteProfit(),
      ships: this.host.ships(),
      yards,
      doneKeys: new Set(tasks.filter((t) => t.status === "done").map((t) => t.key)),
    };
  }
}

function triggerUsesGate(t: Trigger): boolean {
  return t.kind === "gateProgressAtLeast" || (t.kind === "all" && t.of.some(triggerUsesGate));
}

function triggerUsesCoverage(t: Trigger): boolean {
  return t.kind === "marketsSurveyed" || (t.kind === "all" && t.of.some(triggerUsesCoverage));
}

/** Only tasks that wait on market coverage pay for gathering it. */
function usesCoverage(t: TaskRun): boolean {
  return triggerUsesCoverage(t.trigger) || t.steps.some((s) => s.kind === "waitFor" && triggerUsesCoverage(s.trigger));
}
