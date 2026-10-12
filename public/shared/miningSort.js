/** Pure helpers for the mining fields table (shared/miningFields.js): which goods get a column, and the sort. */

/** Goods seen in any survey, the one with the most total share first, then by name. */
export function shareGoods(rows) {
  const total = new Map();
  for (const r of rows) for (const s of r.shares ?? []) total.set(s.good, (total.get(s.good) ?? 0) + s.percent);
  return [...total.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
}

export const shareOf = (r, good) => (r.shares ?? []).find((s) => s.good === good)?.percent ?? 0;

/**
 * Sort rows by a column key: "waypoint", "surveys", "distance", "miners", or "share:GOOD". Never-surveyed fields sort last on a
 * share column whichever way it runs, and ties fall back to the field name so the order is stable.
 */
export function sortFieldRows(rows, key, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  const value = (r) => {
    if (key === "waypoint") return r.waypoint;
    if (key === "surveys") return r.surveys ?? 0;
    if (key === "distance") return r.distanceToTarget ?? Infinity;
    if (key === "miners") return (r.miners ?? []).length;
    if (key.startsWith("share:")) return shareOf(r, key.slice(6));
    return 0;
  };
  return [...rows].sort((a, b) => {
    if (key.startsWith("share:") && a.surveyed !== b.surveyed) return a.surveyed ? -1 : 1;
    const x = value(a), y = value(b);
    const c = typeof x === "string" ? x.localeCompare(y) : x === y ? 0 : x < y ? -1 : 1;
    return c * sign || a.waypoint.localeCompare(b.waypoint);
  });
}

/** Background strength for a share cell, 0 to 0.55 of the amber, so the richest cells stand out. */
export const heat = (percent) => Math.min(0.55, (percent / 100) * 1.4);

