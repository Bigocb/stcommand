import type { PlannerPolicy } from './types.js';

/** Defaults: combat for xp, tasks off, no skill goal. Weight 0 / null / false reproduce "do nothing special". */
export const DEFAULT_PLANNER_POLICY: PlannerPolicy = {
  xpWeight: 1, goldWeight: 0.5, skillGoal: null, doTasks: false,
  winRateFloor: 0.95, restBelowFraction: 0.5, bankAtFraction: 0.8, coinExchangeAt: 6,
  monteCarloFights: 60, maxActionsPerTrip: 300, topK: 4, bankActionSeconds: 3,
  gatherXpBase: 6, gatherXpPerLevel: 2, craftXpBase: 5, craftXpPerLevel: 1.5,
  xpToNextBase: 150, xpToNextPerLevel: 50, itemValue: {}, hpPerLevel: 5,
};
