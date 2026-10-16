// Planner types. Everything here is plain data; no behaviour.
import type { Pos, WorldIndex } from '../world/index.js';

export interface SkillState { level: number; xp: number; /** xp needed for the next level; policy formula when absent */ maxXp?: number }
export interface TaskState { code: string; type: string; total: number; progress: number }
export interface InvItem { code: string; quantity: number }

/** One character. Times are seconds on a caller-supplied clock (the planner never reads a clock). */
export interface CharState {
  position: Pos;
  hp: number; maxHp: number;
  level: number; xp?: number; maxXp?: number; // combat level + xp
  skills: Record<string, SkillState>; // gathering/crafting skills (combat may also appear)
  inventory: InvItem[]; // quantities may be fractional inside planHorizon (expected values)
  inventoryMax: number; // total item count the bag holds
  gold: number;
  equipped: string[]; // item codes
  task: TaskState | null;
  now: number; // current time, seconds
  cooldownReadyAt: number; // seconds; <= now means ready
}

export type World = WorldIndex;

export type ActionKind =
  | 'move' | 'transition' | 'fight' | 'rest' | 'gather' | 'craft' | 'bank_deposit'
  | 'task_new' | 'task_complete' | 'task_exchange' | 'idle';

/** Expected-value effect of one action, used by planHorizon's state transition. */
export interface Expect {
  skill?: string; xp?: number; // xp credited to `skill` ('combat' = character level)
  gold?: number; items?: InvItem[]; consumes?: InvItem[];
  hpLost?: number; hpRestored?: number;
  moveTo?: Pos;
  bank?: boolean; // deposit everything not protected
  keep?: string[];
  taskAccept?: TaskState; taskProgress?: number; taskDone?: boolean;
}

export interface PlanStep { action: ActionKind; args: Record<string, unknown>; expectedCooldownSeconds: number; note: string }

export interface Decision {
  action: ActionKind;
  args: Record<string, unknown>;
  expectedCooldownSeconds: number;
  /** seconds to wait for the current cooldown before sending it */
  waitSeconds: number;
  reason: string; // one line
  plan?: PlanStep[]; // what follows (remaining route steps, then the work)
  expect: Expect;
}

export interface PlannerPolicy {
  xpWeight: number; goldWeight: number; // score = xpWeight*xp + goldWeight*gold
  skillGoal: string | null; // gathering/crafting skill to level; null = combat/tasks
  doTasks: boolean;
  winRateFloor: number;
  restBelowFraction: number; // rest before fighting under this hp fraction
  bankAtFraction: number; // go bank at this inventory fill
  coinExchangeAt: number; // exchange tasks_coin at the task master from this many
  monteCarloFights: number; // samples per monster (speed vs precision)
  maxActionsPerTrip: number; // cap when an action yields (almost) no items
  topK: number; // monsters re-ranked with travel
  bankActionSeconds: number;
  // Undocumented formulas, kept as policy (ASSUMPTIONS):
  gatherXpBase: number; gatherXpPerLevel: number;
  craftXpBase: number; craftXpPerLevel: number;
  xpToNextBase: number; xpToNextPerLevel: number;
  itemValue: Record<string, number>; // extra/override gold per item (npc sell prices are merged in)
  hpPerLevel: number; // max hp gained per level in the horizon
}
