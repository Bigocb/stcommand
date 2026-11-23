/**
 * The week's forecast: where the week should be, hour by hour, if the goals hold (operator request 2026-11-22, issue #76).
 * Drawn as a third, dotted "Forecast" line on the compare charts (src/http/compare.ts, public/shared/compare.js).
 *
 * An hourly simulation, pure: no I/O, no clock. Each hour the fleet makes a base rate (small hulls; lower before the gate
 * opens) plus what each big hull trading makes; the wallet takes the profit less the jump and fuel share; a hull is bought
 * whenever the wallet clears its price plus the working-capital floor (the buy rule the hull buyer, #72, and the operator's
 * standing yes use). A hull bought in hour h trades from hour h+1 and makes its first-hour yield then. What a big hull makes
 * falls as more of them sell into the same markets.
 *
 * The defaults are calibrated from the 2026-11-15 and 2026-11-08 weeks (ops_profit_curve hourly buckets; the 11-15 crash
 * hours 56-97 left out; docs/plan-week-2026-11-22.md §0):
 *   - before the gate: about 210k/h (11-15: 7.1M over 34 h)
 *   - after the gate, small hulls only: about 650k/h (11-15 hours 37-54)
 *   - a heavy's first hour: about 900k (THEO-A1 +940k on 11-17 20:00)
 *   - a settled big hull: about 380k/h with up to 15 of them, falling to about 255k/h at 48 (11-22: 12.25M/h with 48); beyond
 *     48 the total is held flat, because no week has had more and the markets were already crowding
 *   - the gate's materials: about 5.5M (11-15: 7.1M made before the gate, 1.67M left in the wallet when it opened); the gate
 *     opens at `gateHour` only if the wallet can pay for it, otherwise at the first hour it can
 *   - keepers, probes and small hulls after the gate: about 400k/h (11-17: 5-25 ships bought an hour while the wallet sat near 3M)
 * With the gate at 34 and the first heavy at 55 this gives 2M/h at about hour 60-64, the no-crash estimate for 11-15.
 *
 * Re-anchoring (clause weekForecastAnchor, operator request 2026-11-23): forecastFrom() restarts the same loop from the week's
 * latest real hour, with the gate's real opening hour, the recent real profit rate and the real wallet, so the line follows what
 * happened instead of the plan it was set up with.
 */

export interface ForecastPolicy {
  /** Hours to simulate (a week is 168). */
  hours: number;
  /** Wallet at hour 0. */
  startWallet: number;
  /** Hour the home gate opens (goal G1). */
  gateHour: number;
  /** Hour the first heavy is trading at the earliest (goal G4); no hull is bought before the hour before it. */
  firstHeavyHour: number;
  /** Profit an hour before the gate opens. */
  preGateRate: number;
  /** Profit an hour from the small hulls once the gate is open. */
  postGateBase: number;
  /** Price of a big hull. */
  hullPrice: number;
  /** What a big hull makes in its first trading hour (fresh routes, empty markets). */
  firstHourYield: number;
  /** What a settled big hull makes an hour while there are at most `crowdFrom` of them. */
  settledYield: number;
  /** Big hulls at which yields start to fall. */
  crowdFrom: number;
  /** What each big hull makes an hour at `crowdAt` hulls and beyond. */
  crowdedYield: number;
  crowdAt: number;
  /** Most big hulls (trade lanes: proxies less read lanes). */
  maxHulls: number;
  /** Most hulls bought in one hour (a buy round). */
  maxBuysPerHour: number;
  /** Working-capital floor: this much per big hull plus `floorBase` (doctrine buyAdvice, big hulls x 400k + others). */
  floorPerHull: number;
  floorBase: number;
  /** What the gate's materials cost, paid when it opens. */
  gateCost: number;
  /** Spend an hour on keepers, probes and small hulls once the gate is open. */
  otherSpendPostGate: number;
  /** Share of profit spent on jumps and fuel (11-22: 12-15%). */
  overheadShare: number;
  /** Profit per unit before and after the gate opens (units = profit / this). */
  profitPerUnitPreGate: number;
  profitPerUnitPostGate: number;
}

export const DEFAULT_FORECAST: ForecastPolicy = {
  hours: 168,
  startWallet: 175_000,
  gateHour: 40,
  firstHeavyHour: 40,
  preGateRate: 210_000,
  postGateBase: 650_000,
  hullPrice: 2_200_000,
  firstHourYield: 900_000,
  settledYield: 380_000,
  crowdFrom: 15,
  crowdedYield: 255_000,
  crowdAt: 48,
  maxHulls: 80,
  maxBuysPerHour: 3,
  floorPerHull: 400_000,
  floorBase: 100_000,
  gateCost: 5_500_000,
  otherSpendPostGate: 400_000,
  overheadShare: 0.13,
  profitPerUnitPreGate: 450,
  profitPerUnitPostGate: 900,
};

/** One hour of the forecast, with the same keys the compare chart reads from a week's points (weekCompare.ts `Point`). */
export interface ForecastPoint {
  hour: number;
  /** The gate is open this hour. */
  gateOpen: boolean;
  /** Matched profit so far. */
  cumPnl: number;
  /** Matched profit in this hour. */
  pnl: number;
  /** Profit an hour, averaged over this hour and the two before it (as weekCompare's `rate`). */
  rate: number;
  /** Units sold so far. */
  units: number;
  /** Wallet at the end of the hour. */
  wallet: number;
  /** Big hulls bought so far. Not drawn on the "ships bought" chart, which counts every ship (keeper probes included). */
  bigHulls: number;
  /** One line on what happened this hour (a buy, the gate), for a tooltip or a test. */
  note: string;
}

/** What one big hull makes an hour when `n` of them are trading (beyond `crowdAt` the total stays flat). */
export function hullYield(n: number, p: ForecastPolicy): number {
  if (n <= p.crowdFrom) return p.settledYield;
  if (n >= p.crowdAt) return (p.crowdedYield * p.crowdAt) / n;
  const t = (n - p.crowdFrom) / (p.crowdAt - p.crowdFrom);
  return p.settledYield + t * (p.crowdedYield - p.settledYield);
}

/** What the `n`th big hull adds to the fleet's hourly profit once settled. */
export function marginalYield(n: number, p: ForecastPolicy): number {
  return n * hullYield(n, p) - (n - 1) * hullYield(n - 1, p);
}

/** The working-capital floor with `bigHulls` big hulls. */
export function floorFor(bigHulls: number, p: ForecastPolicy): number {
  return p.floorBase + bigHulls * p.floorPerHull;
}

/** Where a simulation starts: hour 0 with the start wallet for a plain forecast, or the latest real reading for an anchored one. */
interface ForecastStart {
  /** First hour to simulate. */
  fromHour: number;
  wallet: number;
  cumPnl: number;
  units: number;
  /** Hour the gate opened (real or simulated before `fromHour`), or null while it is closed. */
  gateOpenAt: number | null;
  /** Hour each big hull starts trading. */
  trading: number[];
}

/** The hourly loop, shared by forecastWeek (from hour 0) and forecastFrom (from the latest real hour). Points cover `start.fromHour` to the last hour. */
function simulate(p: ForecastPolicy, start: ForecastStart): ForecastPoint[] {
  const out: ForecastPoint[] = [];
  let wallet = start.wallet, cum = start.cumPnl, units = start.units;
  let gateOpenAt = start.gateOpenAt;
  /** Hour each big hull starts trading. */
  const trading = [...start.trading];
  for (let h = start.fromHour; h < p.hours; h++) {
    const notes: string[] = [];
    if (gateOpenAt === null && h >= p.gateHour && wallet >= p.gateCost) {
      wallet -= p.gateCost;
      gateOpenAt = h;
      notes.push(h === p.gateHour ? "gate opens" : `gate opens (${h - p.gateHour} h late: the wallet could not pay for it at hour ${p.gateHour})`);
    }
    const gateOpen = gateOpenAt !== null;
    const active = trading.filter((from) => from <= h);
    const n = active.length;
    const settled = hullYield(n, p);
    const hullProfit = active.reduce((s, from) => s + (from === h ? Math.max(p.firstHourYield, settled) : settled), 0);
    const pnl = (gateOpen ? p.postGateBase : p.preGateRate) + hullProfit;
    cum += pnl;
    units += pnl / (gateOpen ? p.profitPerUnitPostGate : p.profitPerUnitPreGate);
    wallet += pnl * (1 - p.overheadShare) - (gateOpen ? p.otherSpendPostGate : 0);

    // Buy: from the hour before the first heavy may trade, while the wallet clears price + floor and the hull can still pay
    // its price back before the week ends.
    let bought = 0;
    if (gateOpen && h >= p.firstHeavyHour - 1) {
      while (bought < p.maxBuysPerHour && trading.length < p.maxHulls) {
        const next = trading.length + 1;
        const hoursLeft = p.hours - (h + 1);
        const paysBack = hoursLeft * marginalYield(next, p) >= p.hullPrice;
        if (!paysBack || wallet - p.hullPrice < floorFor(next, p)) break;
        wallet -= p.hullPrice;
        trading.push(h + 1);
        bought++;
      }
    }
    if (bought) notes.push(`${bought} hull${bought > 1 ? "s" : ""} bought (${trading.length} in all)`);
    out.push({ hour: h, gateOpen, cumPnl: Math.round(cum), pnl: Math.round(pnl), rate: 0, units: Math.round(units), wallet: Math.round(wallet), bigHulls: trading.length, note: notes.join("; ") });
  }
  return out;
}

/** Profit an hour averaged over this hour and the two before it (as weekCompare's `rate`), filled in place. */
function fillRates(points: ForecastPoint[]): ForecastPoint[] {
  for (let i = 0; i < points.length; i++) {
    const from = Math.max(0, i - 2);
    let sum = 0;
    for (let j = from; j <= i; j++) sum += points[j]!.pnl;
    points[i]!.rate = Math.round(sum / (i - from + 1));
  }
  return points;
}

export function forecastWeek(p: ForecastPolicy = DEFAULT_FORECAST): ForecastPoint[] {
  return fillRates(simulate(p, { fromHour: 0, wallet: p.startWallet, cumPnl: 0, units: 0, gateOpenAt: null, trading: [] }));
}

/** What the week has actually done, as far as it has got: the forecast restarts from here (clause weekForecastAnchor). */
export interface ForecastAnchor {
  /** Last hour with real data. The forecast's own hours begin the hour after. */
  hour: number;
  /** Matched profit so far and the wallet at that hour. */
  cumPnl: number;
  wallet: number;
  units: number;
  /** The hour the home gate really opened, or null while it is still closed. */
  gateOpenHour: number | null;
  /** Matched profit of each real hour, oldest first: the recent ones set the base rate. */
  pnlByHour: readonly number[];
  /** Big hulls already trading (0 when not known). */
  bigHulls?: number;
}

/** Real hours that set the base rate; fewer than `MIN_RATE_HOURS` of them and the calibrated default stays. */
export const ANCHOR_RATE_HOURS = 6;
export const MIN_RATE_HOURS = 3;

/**
 * The forecast re-anchored on what has happened (operator request 2026-11-23: "the forecast line changes based on when the gate
 * actually did open"). Hours up to `anchor.hour` are the real ones; from the next hour the simulation continues from the real wallet and
 * profit, with:
 *   - the gate: open from its real hour (its materials are already paid for), or, while closed, not before the next hour;
 *   - the base rate: the mean of the last `ANCHOR_RATE_HOURS` real hours, in place of the calibrated 210k / 650k;
 *   - the first heavy: allowed from the next hour (the standing yes), not at the planned hour.
 * Returns only the hours after the anchor; the caller joins them to the real points. Pure.
 */
export function forecastFrom(anchor: ForecastAnchor, p: ForecastPolicy = DEFAULT_FORECAST): { points: ForecastPoint[]; policy: ForecastPolicy; baseRate: number | null } {
  const next = anchor.hour + 1;
  const recent = anchor.pnlByHour.slice(-ANCHOR_RATE_HOURS);
  const baseRate = recent.length >= MIN_RATE_HOURS ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null;
  const gateOpen = anchor.gateOpenHour !== null && anchor.gateOpenHour <= anchor.hour;
  const policy: ForecastPolicy = {
    ...p,
    hours: Math.max(p.hours, next),
    gateHour: gateOpen ? anchor.gateOpenHour! : Math.max(p.gateHour, next),
    firstHeavyHour: next,
    ...(baseRate !== null ? (gateOpen ? { postGateBase: Math.max(0, baseRate) } : { preGateRate: Math.max(0, baseRate) }) : {}),
  };
  const points = simulate(policy, {
    fromHour: next, wallet: anchor.wallet, cumPnl: anchor.cumPnl, units: anchor.units,
    gateOpenAt: gateOpen ? anchor.gateOpenHour! : null,
    trading: Array.from({ length: Math.max(0, anchor.bigHulls ?? 0) }, () => anchor.hour),
  });
  return { points, policy, baseRate };
}

/** Real hours first, then the anchored forecast, as one series with rates over the join. `real` carries the actual points as ForecastPoints. */
export function joinForecast(real: readonly ForecastPoint[], future: readonly ForecastPoint[]): ForecastPoint[] {
  return fillRates([...real.map((x) => ({ ...x })), ...future.map((x) => ({ ...x }))]);
}

/** The hour the gate opened in the forecast, or null. */
export function gateHourOf(points: readonly ForecastPoint[]): number | null {
  const p = points.find((x) => x.gateOpen);
  return p ? p.hour : null;
}

/** The first hour whose profit reaches `perHour`, or null. */
export function firstHourAt(points: readonly ForecastPoint[], perHour: number): number | null {
  const p = points.find((x) => x.pnl >= perHour);
  return p ? p.hour : null;
}

/**
 * The policy from doctrine: clause `weekForecast` (its value is the gate hour) and `weekForecastHeavyHour` (the first heavy's
 * hour). Off = no forecast. `value(key)` is Doctrine.value; the calibration constants stay at DEFAULT_FORECAST.
 */
export function forecastPolicyFromDoctrine(d: { isEnabled(key: string): boolean; value(key: string): number }): ForecastPolicy | null {
  if (!d.isEnabled("weekForecast")) return null;
  const gateHour = d.value("weekForecast");
  const heavy = d.isEnabled("weekForecastHeavyHour") ? d.value("weekForecastHeavyHour") : gateHour;
  return { ...DEFAULT_FORECAST, gateHour, firstHeavyHour: heavy };
}
