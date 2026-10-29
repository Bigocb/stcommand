/**
 * Trading and worth per clock hour, from the metrics buckets (GET /api/metrics?hours=N, src/engine/metrics.ts).
 * Pure: no DOM, no fetch, no clock.
 *
 * Each bucket carries `net` (realized trading profit less fuel and jumps), `sells`, and `netWorth` (credits plus holds plus
 * what the hulls cost, at the bucket's end), so the change in `netWorth` over an hour is what the fleet gained with ship
 * purchases not counted as a loss. Hours are clock hours (10:00-11:00 UTC shown in local time by the caller); the newest
 * one is usually still running and is marked `partial`.
 */

/** Rows newest first: { start, net, sells, worth, partial }. `worth` is null when the hour has no worth samples. */
export function hourlyRows(buckets, bucketMinutes, nowMs) {
  const hours = new Map();
  for (const b of buckets ?? []) {
    const start = Math.floor(b.t / 3_600_000) * 3_600_000;
    const h = hours.get(start) ?? { start, net: 0, sells: 0, firstWorth: null, lastWorth: null, firstT: Infinity, lastT: -Infinity };
    h.net += b.net ?? 0;
    h.sells += b.sells ?? 0;
    const w = b.netWorth ?? null;
    if (w !== null && Number.isFinite(w)) {
      if (b.t < h.firstT) { h.firstT = b.t; h.firstWorth = w; }
      if (b.t > h.lastT) { h.lastT = b.t; h.lastWorth = w; }
    }
    hours.set(start, h);
  }
  const list = [...hours.values()].sort((a, b) => a.start - b.start);
  // Worth gained in an hour: the last bucket's end value against the previous hour's last value (or this hour's first).
  const rows = list.map((h, i) => {
    const prev = list[i - 1];
    const from = prev && prev.lastWorth !== null ? prev.lastWorth : h.firstWorth;
    const worth = from !== null && h.lastWorth !== null && (prev || h.lastT > h.firstT) ? Math.round(h.lastWorth - from) : null;
    return { start: h.start, net: Math.round(h.net), sells: h.sells, worth, partial: h.start + 3_600_000 > nowMs };
  });
  return rows.reverse();
}

/** The average of the last `n` complete hours: { net, sells, worth } per hour, or null with no complete hour. */
export function hourlyAverage(rows, n = 3) {
  const done = rows.filter((r) => !r.partial).slice(0, n);
  if (!done.length) return null;
  const avg = (k) => {
    const v = done.map((r) => r[k]).filter((x) => x !== null && x !== undefined);
    return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
  };
  return { hours: done.length, net: avg("net"), sells: avg("sells"), worth: avg("worth") };
}
