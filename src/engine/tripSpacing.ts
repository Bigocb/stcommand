/**
 * Trip spacing, per route: a minimum gap between the STARTS of trips that buy the same good at the same buy market, for the
 * goods and markets that need it.
 *
 * The round limits (routeRounds.ts) count trips when they CLOSE, so several ships can all start buying the same good before
 * any trip has closed and the limit has anything to count. 2026-11-02, after the CLOTHING and FABRICS chain had rested two
 * hours and recovered (FABRICS at E49 2,594 -> 2,097), three ships bought 40 units each in four minutes (19:26-19:30) at
 * 2,097, 2,260 and 2,447, and the recovery was gone; buying lifts the ask 4 to 15% a lot. Applied to every good it also held
 * back dozens of small routes that had no recovery to protect (ships sat idle), so spacing is per route:
 *
 *   - an OPERATOR rule names a good (and optionally one buy market) and an optional gap of its own;
 *   - an AUTO rule needs no entry: a (good, buy market) we have started trips at is spaced while its live ask stands
 *     `autoPct` percent or more above the lowest price a trip of ours started at in the lookback, that is, while our own
 *     buying has visibly lifted it. It lifts itself when the ask comes back down.
 *
 * Pure: the caller passes the starts it has seen, the rules, the live ask and the clock. `minGapMin` 0 switches the whole
 * thing off. A ship's own start never rests it (it is the one mid-trip), so the caller names it in `exceptShip`.
 */

export interface TripStart { good: string; buyAt: string; shipSymbol: string; at: number; /** First-lot price per unit, when known. */ price?: number }
export interface SpacedRoute { good: string; /** Undefined = every buy market for this good. */ buyAt?: string; /** Undefined = the default gap. */ gapMin?: number; reason?: string; at: string }
export interface SpacingPolicy {
  /** The default gap; 0 switches spacing off entirely. */
  minGapMin: number;
  /** Auto rule: percent the live ask stands above our lowest recent start price; 0 = no auto rule. */
  autoPct: number;
}

const GOOD = /^[A-Z][A-Z0-9_]{1,60}$/;
const MARKET = /^[A-Z0-9][A-Z0-9-]{1,40}$/;

const normalGood = (raw: string): string | undefined => {
  const g = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return GOOD.test(g) ? g : undefined;
};
const normalMarket = (raw: string): string | undefined => {
  const m = raw.trim().toUpperCase();
  return MARKET.test(m) ? m : undefined;
};

export function parseSpaced(raw: string | undefined): SpacedRoute[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((e) => {
      const good = typeof e?.good === "string" ? normalGood(e.good) : undefined;
      if (!good) return [];
      const buyAt = typeof e.buyAt === "string" ? normalMarket(e.buyAt) : undefined;
      return [{
        good, at: typeof e.at === "string" ? e.at : "",
        ...(buyAt ? { buyAt } : {}),
        ...(typeof e.gapMin === "number" && e.gapMin > 0 ? { gapMin: e.gapMin } : {}),
        ...(typeof e.reason === "string" && e.reason ? { reason: e.reason } : {}),
      }];
    });
  } catch {
    return [];
  }
}

/** Add or replace the rule for this good and buy market (a market left out means every market for the good). */
export function spaceRoute(list: readonly SpacedRoute[], good: string, atIso: string, opts: { buyAt?: string; gapMin?: number; reason?: string } = {}): SpacedRoute[] {
  const g = normalGood(good);
  if (!g) throw new Error(`"${good}" is not a trade symbol (e.g. CLOTHING)`);
  const buyAt = opts.buyAt === undefined ? undefined : normalMarket(opts.buyAt);
  if (opts.buyAt !== undefined && !buyAt) throw new Error(`"${opts.buyAt}" is not a market waypoint (e.g. X1-UZ49-K88)`);
  if (opts.gapMin !== undefined && !(opts.gapMin >= 1 && opts.gapMin <= 240)) throw new Error("gapMin must be between 1 and 240 minutes");
  const rule: SpacedRoute = { good: g, at: atIso, ...(buyAt ? { buyAt } : {}), ...(opts.gapMin ? { gapMin: opts.gapMin } : {}), ...(opts.reason ? { reason: opts.reason } : {}) };
  return [...list.filter((e) => !(e.good === g && e.buyAt === buyAt)), rule];
}

export function unspaceRoute(list: readonly SpacedRoute[], good: string, buyAt?: string): SpacedRoute[] {
  const g = normalGood(good);
  const m = buyAt === undefined ? undefined : normalMarket(buyAt);
  return g ? list.filter((e) => !(e.good === g && e.buyAt === m)) : [...list];
}

/** The rule that covers this good at this market: one naming the market beats one for the good everywhere. */
export function ruleFor(rules: readonly SpacedRoute[], good: string, buyAt: string): SpacedRoute | undefined {
  return rules.find((r) => r.good === good && r.buyAt === buyAt) ?? rules.find((r) => r.good === good && r.buyAt === undefined);
}

/** How far the live ask stands above the lowest price a trip of ours started at here (percent), or undefined with no history. */
export function askDriftPct(starts: readonly TripStart[], good: string, buyAt: string, liveAsk: number | undefined): number | undefined {
  if (liveAsk === undefined || !(liveAsk > 0)) return undefined;
  const prices = starts.filter((s) => s.good === good && s.buyAt === buyAt && s.price !== undefined && s.price > 0).map((s) => s.price!);
  if (prices.length === 0) return undefined;
  return (liveAsk / Math.min(...prices) - 1) * 100;
}

/** Why this good at this buy market is resting under the spacing rule, or undefined when a trip may start. */
export function spacingReason(
  starts: readonly TripStart[], good: string, buyAt: string, now: number, policy: SpacingPolicy,
  rules: readonly SpacedRoute[] = [], exceptShip?: string, liveAsk?: number,
): string | undefined {
  if (!(policy.minGapMin > 0)) return undefined;
  let gapMin = policy.minGapMin;
  let why: string | undefined;
  const rule = ruleFor(rules, good, buyAt);
  if (rule) {
    gapMin = rule.gapMin ?? policy.minGapMin;
    why = `operator rule${rule.reason ? ` (${rule.reason})` : ""}`;
  } else if (policy.autoPct > 0) {
    const drift = askDriftPct(starts, good, buyAt, liveAsk);
    if (drift === undefined || drift < policy.autoPct) return undefined;
    why = `auto: the ask is ${Math.round(drift)}% above our lowest recent buy here`;
  } else {
    return undefined;
  }
  const since = now - gapMin * 60_000;
  const recent = starts.filter((s) => s.good === good && s.buyAt === buyAt && s.at >= since && s.shipSymbol !== exceptShip);
  if (recent.length === 0) return undefined;
  const latest = Math.max(...recent.map((s) => s.at));
  const sinceMin = Math.max(0, Math.round((now - latest) / 60_000));
  const leftMin = Math.max(1, Math.ceil((latest + gapMin * 60_000 - now) / 60_000));
  return `spacing (${why}): a trip bought ${good} at ${buyAt} ${sinceMin} min ago, next may start in ${leftMin} min (gap ${gapMin} min)`;
}

/** The (good, buy market) pairs auto-spaced right now, with the drift that triggered each, for the operator's view. */
export function autoSpacedNow(starts: readonly TripStart[], asks: ReadonlyMap<string, number>, policy: SpacingPolicy, rules: readonly SpacedRoute[]): { good: string; buyAt: string; driftPct: number; ask: number }[] {
  if (!(policy.minGapMin > 0) || !(policy.autoPct > 0)) return [];
  const seen = new Set<string>();
  const out: { good: string; buyAt: string; driftPct: number; ask: number }[] = [];
  for (const s of starts) {
    const key = `${s.good}|${s.buyAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ruleFor(rules, s.good, s.buyAt)) continue;
    const ask = asks.get(key);
    const drift = askDriftPct(starts, s.good, s.buyAt, ask);
    if (drift !== undefined && ask !== undefined && drift >= policy.autoPct) out.push({ good: s.good, buyAt: s.buyAt, driftPct: Math.round(drift * 10) / 10, ask });
  }
  return out;
}
