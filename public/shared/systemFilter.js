/**
 * Filter the Approvals lists by system (operator request, 2026-11-17): the keeper queue holds one card at a time, and when a system the
 * operator cares about has no card yet it helps to see just its markets. Pure helpers plus one chip row, used by Tower and Deck.
 *
 * A waypoint `X1-SN86-K83` belongs to system `X1-SN86`. An approval's `shipSymbol` for keeper cards is `yard|market|hull`; the market
 * (second part) decides its system. Approvals with no system (a ship purchase) are never hidden by the filter.
 */

/** `X1-SN86-K83` -> `X1-SN86`; null when the text is not a waypoint (needs three dash-separated parts). */
export function waypointSystem(wp) {
  const parts = String(wp ?? "").split("-");
  return parts.length >= 3 ? parts.slice(0, 2).join("-") : null;
}

/** The system an approval is about, or null. */
export function approvalSystem(a) {
  const parts = String(a?.shipSymbol ?? "").split("|");
  return waypointSystem(parts.length >= 3 ? parts[1] : parts[0]);
}

/** Keep the items of the chosen system; `selected` empty or "all" keeps everything. `systemOfItem` returns null for items with no system, which are always kept. */
export function filterBySystem(items, selected, systemOfItem) {
  if (!selected || selected === "all") return items;
  return items.filter((it) => { const s = systemOfItem(it); return s === null || s === selected; });
}

/** `[{system, count}]` over the given system names, most items first, then by name. Nulls are skipped. */
export function systemCounts(systems) {
  const m = new Map();
  for (const s of systems) if (s) m.set(s, (m.get(s) ?? 0) + 1);
  return [...m].map(([system, count]) => ({ system, count })).sort((a, b) => b.count - a.count || a.system.localeCompare(b.system));
}

/** The chip row: "All" plus one chip per system with its count. Buttons carry `data-sys`. */
export function systemChipsHtml(counts, selected, escape) {
  const total = counts.reduce((n, c) => n + c.count, 0);
  const chip = (sys, label, n) => `<button type="button" class="sys-chip${(selected || "all") === sys ? " on" : ""}" data-sys="${escape(sys)}">${escape(label)} <b>${n}</b></button>`;
  return chip("all", "All", total) + counts.map((c) => chip(c.system, c.system.replace(/^X1-/, ""), c.count)).join("");
}
