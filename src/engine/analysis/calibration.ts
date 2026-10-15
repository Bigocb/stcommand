/**
 * Calibration: how much of its estimate a route or a good actually earns, the first step toward prediction.
 *
 * Pure. For trips with an estimate, the factor is actual over expected (both after the trip's own costs). Per route and
 * per good it is shrunk toward the fleet-wide factor in proportion to how few trips back it, so one lucky trip doesn't
 * produce a factor of 3. Measured and shown only: nothing acts on it yet (docs/analysis-engine.md, "Toward predictions").
 */
import { tripNet, type Trip } from "./trips.js";
import { round2, type AnalysisPolicy } from "./types.js";

export interface CalibrationFactor {
  key: string;
  trips: number;
  rawFactor: number;
  factor: number;
}

export interface Calibration {
  fleet: { trips: number; factor: number | null };
  routes: CalibrationFactor[];
  goods: CalibrationFactor[];
}

export function calibrate(trips: readonly Trip[], policy: AnalysisPolicy): Calibration {
  const est = trips.filter((t) => t.endMs !== null && !t.partial && t.expectedProfit !== null && t.expectedProfit > 0);
  const sumExp = est.reduce((s, t) => s + t.expectedProfit!, 0);
  const sumAct = est.reduce((s, t) => s + tripNet(t), 0);
  const fleet = sumExp > 0 ? sumAct / sumExp : null;
  const group = (keyOf: (t: Trip) => string): CalibrationFactor[] => {
    const by = new Map<string, Trip[]>();
    for (const t of est) (by.get(keyOf(t)) ?? by.set(keyOf(t), []).get(keyOf(t))!).push(t);
    const out: CalibrationFactor[] = [];
    for (const [key, list] of by) {
      const exp = list.reduce((s, t) => s + t.expectedProfit!, 0);
      const act = list.reduce((s, t) => s + tripNet(t), 0);
      const raw = act / exp;
      const k = policy.calibrationPrior;
      const n = list.length;
      const factor = fleet === null ? raw : (n * raw + k * fleet) / (n + k);
      out.push({ key, trips: n, rawFactor: round2(raw), factor: round2(factor) });
    }
    return out.sort((a, b) => b.trips - a.trips);
  };
  return {
    fleet: { trips: est.length, factor: fleet === null ? null : round2(fleet) },
    routes: group((t) => `${t.good} ${t.buyAt ?? "?"}>${t.sellAt ?? "?"}`),
    goods: group((t) => t.good),
  };
}

/** What a route is likely to earn, given its estimate and the calibration (route factor, else good, else fleet). */
export function predictProfit(c: Calibration, expected: number, good: string, route?: string): { predicted: number; factor: number | null; basis: string } {
  const r = route ? c.routes.find((x) => x.key === `${good} ${route}`) : undefined;
  if (r) return { predicted: Math.round(expected * r.factor), factor: r.factor, basis: `route, ${r.trips} trips` };
  const g = c.goods.find((x) => x.key === good);
  if (g) return { predicted: Math.round(expected * g.factor), factor: g.factor, basis: `good, ${g.trips} trips` };
  if (c.fleet.factor !== null) return { predicted: Math.round(expected * c.fleet.factor), factor: c.fleet.factor, basis: `fleet, ${c.fleet.trips} trips` };
  return { predicted: expected, factor: null, basis: "no history" };
}
