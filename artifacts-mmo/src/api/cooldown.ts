// Pure per-character cooldown tracker and cooldown predictors.

export interface CooldownInfo {
  total_seconds: number;
  remaining_seconds: number;
  expiration?: string;
  reason?: string;
  started_at?: string;
}

export interface CooldownTracker {
  /** Record the cooldown returned by an action. nowMs is the local receive time. */
  record(name: string, cd: CooldownInfo, nowMs: number): void;
  /** Epoch ms when the character is ready (0 if unknown/never recorded). */
  readyAt(name: string): number;
  waitMs(name: string, nowMs: number): number;
  /** Force a ready time (e.g. from a 499 response). */
  setReadyAt(name: string, ms: number): void;
}

/**
 * readyAt = now + remaining_seconds (immune to local/server clock skew); falls back to the
 * server `expiration` timestamp only when remaining_seconds is missing.
 */
export function createCooldownTracker(): CooldownTracker {
  const ready = new Map<string, number>();
  return {
    record(name, cd, nowMs) {
      let at: number;
      if (Number.isFinite(cd.remaining_seconds)) at = nowMs + cd.remaining_seconds * 1000;
      else if (cd.expiration && Number.isFinite(Date.parse(cd.expiration))) at = Date.parse(cd.expiration);
      else at = nowMs + (cd.total_seconds || 0) * 1000;
      ready.set(name, at);
    },
    readyAt: (name) => ready.get(name) ?? 0,
    waitMs: (name, nowMs) => Math.max(0, (ready.get(name) ?? 0) - nowMs),
    setReadyAt: (name, ms) => { ready.set(name, ms); },
  };
}

// ---- predictors (seconds). Inputs are plain numbers so a scheduler can plan before sending. ----

/** Move: 5s per tile. Assumed tile distance = Manhattan-free Euclidean, rounded, min 1 (see tileDistance). */
export function tileDistance(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y)));
}
export function predictMove(tiles: number): number { return Math.max(0, Math.round(tiles * 5)); }

/** Fight: turns*2 reduced by haste %, minimum 5s. */
export function predictFight(turns: number, hastePct = 0): number {
  return Math.max(5, Math.round(turns * 2 * (1 - hastePct / 100)));
}

/** Gathering: 30s + resourceLevel/2, reduced by the tool's cooldown-reduction % (positive number, e.g. 10). */
export function predictGathering(resourceLevel: number, toolReductionPct = 0): number {
  return Math.max(1, Math.round((30 + resourceLevel / 2) * (1 - toolReductionPct / 100)));
}

/** Crafting: 5s per item crafted. */
export function predictCrafting(totalItems: number): number { return Math.max(0, Math.round(totalItems * 5)); }

/** Rest: 1s per 5 HP restored, minimum 3s. */
export function predictRest(hpRestored: number): number { return Math.max(3, Math.ceil(hpRestored / 5)); }

/** Everything else (bank, npc, equip, use, task, GE...): 3s. */
export const PREDICT_OTHER_SECONDS = 3;
export function predictOther(): number { return PREDICT_OTHER_SECONDS; }
