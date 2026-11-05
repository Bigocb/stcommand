/**
 * The profit curve of a window or a whole week: per bucket, what the fleet earned and what drove it.
 *
 * Operator question (2026-11-05): money "explodes" around Thursday/Friday every week; what conditions allow it? The ledger tool is
 * capped at 300 rows, so the curve could not be rebuilt. This takes the SQL roll-up per bucket (store.opsLedgerBuckets) and adds the
 * drivers that separate the two causes: how many ships sold (fleet size), sells per ship, units per sell (load size) and profit per
 * sale and per unit (price level), plus cumulative profit and the wallet. Per-day totals make a Thursday/Friday step visible at a glance.
 * Pure: buckets in, curve and one-line reading out. Fresh-system count per bucket is not in the ledger and is not guessed here.
 */

export interface CurveBucket {
  bucket: Date; sells: number; units: number; pnl: number; revenue: number; sellers: number; purchases: number; overhead: number; shipsBought: number; wallet: number | null;
}

export interface CurveRow {
  at: string;
  profit: number;
  sells: number;
  ships: number;
  unitsPerSell: number;
  profitPerSell: number;
  profitPerUnit: number;
  overhead: number;
  cumulativeProfit: number;
  shipsBought: number;
  wallet: number | null;
}

export interface CurveDay { day: string; weekday: string; profit: number; sells: number; peakShips: number; profitPerSell: number; profitPerUnit: number; profitPerHour: number }

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function profitCurve(buckets: readonly CurveBucket[], bucketMin: number): { rows: CurveRow[]; days: CurveDay[]; peak: { at: string; profitPerHour: number } | null; reading: string } {
  const perHour = 60 / Math.max(1, bucketMin);
  let cum = 0;
  const rows: CurveRow[] = buckets.map((b) => {
    cum += b.pnl;
    return {
      at: b.bucket.toISOString(),
      profit: b.pnl,
      sells: b.sells,
      ships: b.sellers,
      unitsPerSell: b.sells ? Math.round(b.units / b.sells) : 0,
      profitPerSell: b.sells ? Math.round(b.pnl / b.sells) : 0,
      profitPerUnit: b.units ? Math.round(b.pnl / b.units) : 0,
      overhead: b.overhead,
      cumulativeProfit: cum,
      shipsBought: b.shipsBought,
      wallet: b.wallet,
    };
  });

  const byDay = new Map<string, { profit: number; sells: number; units: number; peakShips: number; hours: number }>();
  for (const b of buckets) {
    const day = b.bucket.toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { profit: 0, sells: 0, units: 0, peakShips: 0, hours: 0 };
    d.profit += b.pnl; d.sells += b.sells; d.units += b.units; d.peakShips = Math.max(d.peakShips, b.sellers); d.hours += 1 / perHour;
    byDay.set(day, d);
  }
  const days: CurveDay[] = [...byDay.entries()].map(([day, d]) => ({
    day,
    weekday: WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!,
    profit: d.profit,
    sells: d.sells,
    peakShips: d.peakShips,
    profitPerSell: d.sells ? Math.round(d.profit / d.sells) : 0,
    profitPerUnit: d.units ? Math.round(d.profit / d.units) : 0,
    profitPerHour: d.hours ? Math.round(d.profit / d.hours) : 0,
  }));

  const best = rows.reduce<CurveRow | null>((m, r) => (!m || r.profit > m.profit ? r : m), null);
  const peak = best ? { at: best.at, profitPerHour: Math.round(best.profit * perHour) } : null;
  const top = days.reduce<CurveDay | null>((m, d) => (!m || d.profit > m.profit ? d : m), null);
  const first = days[0];
  const reading = !top || !first
    ? "no sells in the window"
    : `best day ${top.weekday} ${top.day}: ${top.profitPerHour}/h at ${top.profitPerSell} per sell, ${top.profitPerUnit} per unit, up to ${top.peakShips} ships selling per bucket (first day ${first.profitPerHour}/h at ${first.profitPerSell} per sell)`;
  return { rows, days, peak, reading };
}
