/**
 * Doctrine screen helpers (Deck and Tower): search, filter and group the clauses /api/doctrine returns.
 * Pure: no DOM. docs/doctrine-organization.md section 8; the server side is src/engine/doctrineGroups.ts.
 */

/** Split camelCase and punctuation so "top up" finds keeperTopUpPerHour. */
export function tokens(s) {
  return String(s ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[:_\-]/g, " ").toLowerCase();
}

/** Every word of the query must appear in the key, name, summary, description, group or sub-group. */
export function matches(c, query, groupName = "") {
  const words = tokens(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${tokens(c.key)} ${String(c.key).toLowerCase()} ${tokens(c.name)} ${String(c.summary ?? "").toLowerCase()} ${String(c.description ?? "").toLowerCase()} ${c.group ?? ""} ${tokens(groupName)} ${tokens(c.subGroup)}`;
  return words.every((w) => hay.includes(w));
}

/** show: "all" | "on" | "off" | "changed" | "common". */
export function filterClauses(clauses, { q = "", group = "", show = "all" } = {}, groupOrder = []) {
  const names = new Map(groupOrder.map((g) => [g.id, g.name]));
  return clauses.filter((c) =>
    (!group || c.group === group)
    && (show === "all" || (show === "on" && c.enabled) || (show === "off" && !c.enabled) || (show === "changed" && !!c.default) || (show === "common" && c.common))
    && matches(c, q, names.get(c.group) ?? ""));
}

/** [{id, name, blurb, count, subs: [{name, clauses}]}] in the server's group order; unknown groups last. */
export function groupClauses(clauses, groupOrder = []) {
  const order = groupOrder.length ? groupOrder : [{ id: "all", name: "All clauses", blurb: "" }];
  const byGroup = new Map();
  for (const c of clauses) {
    const id = groupOrder.length ? (c.group ?? "auto") : "all";
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id).push(c);
  }
  const known = new Set(order.map((g) => g.id));
  const extra = [...byGroup.keys()].filter((id) => !known.has(id)).map((id) => ({ id, name: id, blurb: "" }));
  return [...order, ...extra].filter((g) => byGroup.has(g.id)).map((g) => {
    const subs = new Map();
    for (const c of byGroup.get(g.id)) {
      const sg = c.subGroup ?? "";
      if (!subs.has(sg)) subs.set(sg, []);
      subs.get(sg).push(c);
    }
    return { id: g.id, name: g.name, blurb: g.blurb, count: byGroup.get(g.id).length, subs: [...subs].map(([name, list]) => ({ name, clauses: list })) };
  });
}

/** An older server sends only `rules`: show them as one ungrouped list. */
export function clausesFrom(data) {
  if (data.clauses?.length) return data.clauses;
  return (data.rules ?? []).map((r) => ({
    key: r.key, name: r.name, group: "all", subGroup: "", kind: r.max > 1 ? "number" : "switch", value: r.value, unit: r.unit ?? "",
    min: r.min, max: r.max, step: r.step ?? 1, enabled: r.enabled, adopted: true, common: false, summary: r.description ?? "", description: r.description ?? "",
  }));
}

/** Needed clauses that are off, by key -> name. */
export function neededOff(c, all) {
  if (!c.needs?.length) return [];
  const byKey = new Map(all.map((x) => [x.key, x]));
  return c.needs.map((k) => byKey.get(k)).filter((x) => x && !x.enabled).map((x) => ({ key: x.key, name: x.name }));
}

/** "1 - 10, step 1" with the unit, for the muted range hint. */
export function rangeHint(c) {
  const u = String(c.unit ?? "").trim();
  return `${c.min} - ${c.max}${u ? ` ${u}` : ""}, step ${c.step ?? 1}`;
}
