import { Store } from "../db/store.js";
import { 
  decide, 
  OpeningFacts, 
  Decision, 
  TaskRun, 
} from "./openingTasks.js";

export interface OpeningRunner {
  run(tenantId: string): Promise<void>;
}

export class OpeningRunnerImpl implements OpeningRunner {
  constructor(private readonly store: Store) {}

  async run(tenantId: string): Promise<void> {
    const tasks = await this.store.listOpeningTasks(tenantId);
    const activeTasks = tasks.filter(t => t.status === "queued" || t.status === "active");

    for (const task of activeTasks) {
      const facts = await this.gatherFacts(tenantId);
      const decision = decide(task, facts);

      if (decision.kind === "wait") {
        continue;
      }

      if (decision.kind === "done") {
        await this.store.updateOpeningTask(tenantId, task.id, { status: "done", note: decision.reason });
        continue;
      }

      if (decision.kind === "fail") {
        await this.store.updateOpeningTask(tenantId, task.id, { status: "failed", note: decision.reason });
        continue;
      }

      if (decision.kind === "run") {
        const result = await this.executeStep(tenantId, task, decision);
        if (result.success) {
          const nextStepIndex = task.stepIndex + 1;
          const status = nextStepIndex >= task.steps.length ? "done" : "active";
          const note = status === "done" ? "all steps finished" : `executed step ${task.stepIndex}`;
          
          const newRefs: Record<string, string> = { ...task.refs };
          if (result.shipSymbol) {
            newRefs[String(task.stepIndex)] = result.shipSymbol;
          }

          await this.store.updateOpeningTask(tenantId, task.id, { 
            stepIndex: nextStepIndex, 
            status, 
            note,
            refs: newRefs
          });
        } else {
          await this.store.updateOpeningTask(tenantId, task.id, { status: "failed", note: result.error });
        }
      }
    }
  }

  private async gatherFacts(tenantId: string): Promise<OpeningFacts> {
    return {
      spendable: 0,
      bestRouteProfit: undefined,
      ships: [],
      yards: [],
      doneKeys: new Set()
    };
  }

  private async executeStep(tenantId: string, task: TaskRun, decision: Decision): Promise<{ success: true; shipSymbol?: string } | { success: false; error: string }> {
    if (decision.kind !== "run") {
      return { success: false, error: "Decision is not a 'run' type" };
    }
    
    const stepIndex = decision.stepIndex;
    const step = task.steps[stepIndex];
    if (!step) return { success: false, error: "Step not found" };

    try {
      if (step.kind === "buyShip") {
        if (!decision.buy) return { success: false, error: "Decision missing buy info" };
        return { success: true, shipSymbol: "NEW-SHIP" };
      }
      if (step.kind === "setRole") {
        return { success: true };
      }
      if (step.kind === "contractDuty") {
        return { success: true };
      }
      if (step.kind === "setDoctrine") {
        return { success: true };
      }
      return { success: false, error: `Unknown step kind: ${ (step as any).kind }` };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
}