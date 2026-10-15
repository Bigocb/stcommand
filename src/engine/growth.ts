/**
 * Growth: how fast the fleet's net worth grows, in percent a day.
 *
 * Net worth is credits plus holds (wealth_samples) plus the hull capital the fleet has put into ships: purchases less
 * scrap proceeds. Buying a hull moves cash into capital and leaves net worth unchanged, so a purchase doesn't read as a
 * loss; scrapping returns cash, so the proceeds are taken back out and a scrapped hull is not counted as growth.
 *
 * Pure. The caller fetches the samples and the ship rows and passes them in.
 */

export interface WealthPoint {
  ts: number;
  /** Credits plus holds at that moment. */
  worth: number;
}

export interface HullEvent {
  ts: number;
  /** Positive for a purchase (cash to capital), negative for scrap proceeds (cash back out of capital). */
  amount: number;
}

/** Hull capital at a moment: every purchase up to then, less the scrap proceeds. */
export function hullCapitalAt(events: readonly HullEvent[], atMs: number): number {
  let capital = 0;
  for (const e of events) if (e.ts <= atMs) capital += e.amount;
  return capital;
}

export interface NetWorthPoint {
  ts: number;
  netWorth: number;
}

export function netWorthSeries(points: readonly WealthPoint[], events: readonly HullEvent[]): NetWorthPoint[] {
  return [...points].sort((a, b) => a.ts - b.ts).map((p) => ({ ts: p.ts, netWorth: Math.round(p.worth + hullCapitalAt(events, p.ts)) }));
}

export interface GrowthRate {
  /** Percent a day, from the first to the last sample in the window, to two places. */
  perDayPct: number;
  startNetWorth: number;
  endNetWorth: number;
  /** The span the rate is measured over, in hours (the samples', not the window's). */
  hours: number;
}

/** A sample series shorter than this (in hours) says nothing reliable about a rate: holds move with the market. */
const MIN_SPAN_HOURS = 0.5;

/**
 * Growth per day between the first and last sample inside [fromMs, toMs]. Null when there are fewer than two samples,
 * they span less than half an hour, or net worth at the start isn't positive (a rate off nothing means nothing).
 */
export function growthPerDay(points: readonly WealthPoint[], events: readonly HullEvent[], fromMs: number, toMs: number): GrowthRate | null {
  const inWindow = netWorthSeries(points.filter((p) => p.ts >= fromMs && p.ts <= toMs), events);
  if (inWindow.length < 2) return null;
  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  const hours = (last.ts - first.ts) / 3_600_000;
  if (hours < MIN_SPAN_HOURS || first.netWorth <= 0) return null;
  const perDay = ((last.netWorth - first.netWorth) / first.netWorth) * (24 / hours) * 100;
  return { perDayPct: Math.round(perDay * 100) / 100, startNetWorth: first.netWorth, endNetWorth: last.netWorth, hours: Math.round(hours * 100) / 100 };
}
