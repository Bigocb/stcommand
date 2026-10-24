/**
 * Shared shapes for the analysis engine (docs/analysis-engine.md). Every module returns findings in this form, so the
 * report can rank them together and a reader always sees the evidence and the sample size behind a claim.
 */

export type FindingKind = "worked" | "didnt_work" | "estimate" | "cost" | "market_impact" | "market_recovery" | "price_moves" | "competition" | "change_impact" | "freshness";

export type Confidence = "low" | "medium" | "high";

/** A concrete, reversible action, with the exact MCP tool and arguments when one exists. Advisory only. */
export interface Suggestion {
  action: string;
  why: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface Finding {
  /** Stable key, so the same finding can be followed week to week. */
  id: string;
  kind: FindingKind;
  /** What it is about: a route, a market, a setting. */
  subject: string;
  headline: string;
  /** The numbers behind the headline. */
  evidence: Record<string, number | string | null>;
  sampleSize: number;
  confidence: Confidence;
  /** Rough credits at stake, for ranking. */
  weight: number;
  suggestion?: Suggestion;
}

/** Thresholds and windows. Policy is data: the report can be rerun with different values. */
export interface AnalysisPolicy {
  /** Minimum closed trips on a route before it is called a success or a failure. */
  minTrips: number;
  /** Minimum trips with an estimate before the estimate is called biased. */
  minEstimateSamples: number;
  /** Realized over expected below this is optimistic, above 1/this pessimistic. */
  estimateBiasRatio: number;
  /** The route model's price impact per lot, as a fraction (routeEconomics.ts). */
  modelImpactPerLot: number;
  /** Measured impact above model x this is called heavy. */
  heavyImpactFactor: number;
  /** A market is recovered once its price is back within this fraction of where it was before our trade. */
  recoveredWithin: number;
  /** Median recovery above this many minutes is slow. */
  slowRecoveryMinutes: number;
  /** A price move at least this fraction between consecutive snapshots is attributed. */
  priceMoveThreshold: number;
  /** Before/after windows around a settings change, in hours, and the settle time skipped after it, in minutes. */
  changeWindowHours: number;
  changeSettleMinutes: number;
  /** Positioning cost above this share of a route's gross profit is called heavy. */
  heavyPositioningShare: number;
  /** Shrinkage strength for calibration factors (trips of weight given to the fleet-wide factor). */
  calibrationPrior: number;
  /** How far before a trip's buy and its sell other ships' trades of the good count as competition, in minutes. */
  competitionWindowMin: number;
  /** A trip met heavy competition at this many rival units or more across its two markets. */
  heavyRivalUnits: number;
  /** Trips needed in both the quiet and the heavy group before the difference is reported. */
  minCompetitionTrips: number;
  /** Quiet-minus-heavy realized-over-estimated gap that is worth a finding. */
  competitionGap: number;
}

export const DEFAULT_ANALYSIS_POLICY: AnalysisPolicy = {
  minTrips: 3,
  minEstimateSamples: 3,
  estimateBiasRatio: 0.7,
  modelImpactPerLot: 0.045,
  heavyImpactFactor: 1.5,
  recoveredWithin: 0.02,
  slowRecoveryMinutes: 60,
  priceMoveThreshold: 0.05,
  changeWindowHours: 6,
  changeSettleMinutes: 15,
  heavyPositioningShare: 0.3,
  calibrationPrior: 3,
  competitionWindowMin: 60,
  heavyRivalUnits: 100,
  minCompetitionTrips: 8,
  competitionGap: 0.1,
};

/** Confidence from a sample size: a handful is low, a dozen medium, more high. */
export function confidenceFor(n: number): Confidence {
  if (n >= 12) return "high";
  if (n >= 5) return "medium";
  return "low";
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
export const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;
