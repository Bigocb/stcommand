/**
 * The operator's blocked-goods list: trade goods the fleet is not to buy for margin trading because they are not worth it
 * (2026-10-22: VIRAL_AGENTS, a thin market where every lot sold ratchets the price down and each sale under the loss floor
 * needed an approval). Blocking only stops new buys: routes in that good are dropped from the dispatcher and from a trader's own
 * choice; cargo already aboard is still sold by the normal rules, a hand-pinned route is the operator's explicit choice and is
 * untouched, and contract or mission work is separate.
 *
 * Pure: list in, list out. Persisted by FleetManager as a fleet flag.
 */

export interface BlockedGood { good: string; reason?: string; at: string }

const GOOD = /^[A-Z][A-Z0-9_]{1,60}$/;

/** A trade symbol in its canonical form, or undefined if it cannot be one. */
export function normalizeGood(raw: string): string | undefined {
  const g = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return GOOD.test(g) ? g : undefined;
}

export function parseBlocked(raw: string | undefined): BlockedGood[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((e) => {
      const good = typeof e?.good === "string" ? normalizeGood(e.good) : undefined;
      return good ? [{ good, at: typeof e.at === "string" ? e.at : "", ...(typeof e.reason === "string" && e.reason ? { reason: e.reason } : {}) }] : [];
    });
  } catch {
    return [];
  }
}

export function blockGood(list: readonly BlockedGood[], good: string, atIso: string, reason?: string): BlockedGood[] {
  const g = normalizeGood(good);
  if (!g) throw new Error(`"${good}" is not a trade symbol (e.g. VIRAL_AGENTS)`);
  if (list.some((e) => e.good === g)) return list.map((e) => (e.good === g && reason ? { ...e, reason } : e));
  return [...list, { good: g, at: atIso, ...(reason ? { reason } : {}) }];
}

export function unblockGood(list: readonly BlockedGood[], good: string): BlockedGood[] {
  const g = normalizeGood(good);
  return g ? list.filter((e) => e.good !== g) : [...list];
}

export const blockedSet = (list: readonly BlockedGood[]): Set<string> => new Set(list.map((e) => e.good));
