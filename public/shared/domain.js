// Pure computation & formatting — no DOM, no shared app state.
// See docs/ui-versions-plan.md §3.

export const fmt = (n) => Math.round(n ?? 0).toLocaleString("en-US");
export const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n ?? 0));

export function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

export function countdown(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export function worstConditionPct(ship) {
  const parts = [ship.frame?.condition, ship.engine?.condition, ship.reactor?.condition].filter((c) => c != null);
  if (!parts.length) return null;
  return Math.round(Math.min(...parts) * 100);
}

export function roleMismatchReason(role, ship) {
  const mountSymbols = (ship.mounts ?? []).map((m) => m.symbol);
  const frame = ship.frame?.symbol ?? "";
  if (role === "miner" && !mountSymbols.some((s) => s.startsWith("MOUNT_MINING_LASER"))) return "no mining laser mounted";
  if (role === "surveyor" && !mountSymbols.some((s) => s.startsWith("MOUNT_SURVEYOR"))) return "no surveyor mounted";
  if (role === "siphoner" && !mountSymbols.some((s) => s.startsWith("MOUNT_GAS_SIPHON"))) return "no gas siphon mounted";
  if (role === "tour" && frame !== "FRAME_SHUTTLE" && ship.registration?.role !== "COMMAND") return "not a shuttle or command frame";
  if (role === "keeper" && ship.registration?.role !== "SATELLITE" && frame !== "FRAME_PROBE") return "not a probe/satellite hull";
  if (role === "trader" && (ship.cargo?.capacity ?? 0) < 15) return "cargo capacity under 15";
  return null;
}

export function abbrev(s) {
  if (!s) return "?";
  return s.split("_").map((p) => p[0]).join("").slice(0, 3).toUpperCase();
}

export function shortWp(s) {
  if (!s) return "—";
  const parts = s.split("-");
  return parts.slice(-1)[0];
}

export function systemOf(s) {
  if (!s) return "—";
  const parts = s.split("-");
  if (parts.length >= 2) return parts.slice(0, 2).join("-");
  return s;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export const escapeAttr = escapeHtml;

export function fmTag(flightMode) {
  if (flightMode === "DRIFT") return `<span class="fm-tag fm-drift">drift</span>`;
  if (flightMode === "BURN") return `<span class="fm-tag fm-burn">burn</span>`;
  return "";
}

export function chip(r) {
  return `<button type="button" class="n cval" data-key="${escapeAttr(r.key)}" data-value="${r.value}" data-min="${r.min}" data-max="${r.max}" data-step="${r.step}" data-unit="${escapeAttr(r.unit)}">${fmt(r.value)}${r.unit}</button>`;
}

export const CLAUSE_TEXT = {
  cashFloor: (r) => `Never let the balance fall below ${chip(r)} on any purchase — ships, modules, repairs, cargo. Fuel is always exempt.`,
  marginFloor: (r) => `Ignore arbitrage routes whose per-unit margin is below ${chip(r)}.`,
  maxLossPct: (r) => `Refuse to sell cargo at more than ${chip(r)} loss against its cost basis.`,
  minerTarget: (r) => `Grow the drone fleet until ${chip(r)} miners are active.`,
  promoteAtMiners: (r) => `Promote the biggest-hold miner to trader once ${chip(r)} miners exist.`,
  shipBudget: (r) => `Only consider buying a ship when credits exceed the cash floor by ${chip(r)}.`,
  snapshotMaxAgeMin: (r) => `Ignore market prices older than ${chip(r)}. <em>Both the dispatcher and the traders read this, so they always agree on which routes exist.</em>`,
  keeperCount: (r) => `Station ${chip(r)} ships as market keepers so prices never go stale.`,
  sensorScanIntervalMin: (r) => `Run a sensor scan every ${chip(r)} once there is nothing left to chart. <em>Off by default — this changes the auto-buyer's spending.</em>`,
  siphonTarget: (r) => `Grow the fleet until ${chip(r)} gas siphoners are active.`,
  warehouseTarget: () => `Route trade through the warehouse. <em>Which goods, and how much of each, is set per-good in the Warehouse pane.</em>`,
  warehouseMax: (r) => `Never hold more than ${chip(r)} of any one good in the warehouse.`,
  warehouseMinMargin: (r) => `Only sell out of the warehouse when the live price clears cost basis by ${chip(r)} per unit.`,
};

export function clauseForRule(r) {
  const fn = CLAUSE_TEXT[r.key];
  if (fn) return fn(r);
  if (r.key.startsWith("shipCap:")) {
    const type = r.key.replace(/^shipCap:/, "").replace(/^SHIP_/, "").replace(/_/g, " ").toLowerCase();
    return `Fleet cap for ${type}: buy no more than ${chip(r)}.`;
  }
  return `<b>${escapeHtml(r.name)}</b>: ${chip(r)}`;
}

export function conditionSectionHtml(ship, shipSymbol, atYard) {
  const parts = [
    { label: "Frame", c: ship.frame },
    { label: "Engine", c: ship.engine },
    { label: "Reactor", c: ship.reactor },
  ].filter((p) => p.c);
  if (!parts.length) return "";
  const worst = Math.min(...parts.map((p) => p.c.condition ?? 1));
  const docked = ship.nav.status === "DOCKED";
  const canRepair = docked && atYard;
  return `<div class="loadout-section"><h4>Condition</h4>
    ${parts.map((p) => {
      const pct = Math.round(Math.max(0, Math.min(1, p.c.condition ?? 1)) * 100);
      const low = pct < 50;
      return `<div class="loadout-item"><span class="n">${p.label}<span class="meter${low ? " neg" : ""}" style="margin-left:6px"><i style="width:${pct}%"></i></span></span><span class="d">${pct}%</span></div>`;
    }).join("")}
    <div class="jump-row">
      <span class="tgt">${worst < 1
        ? `<b>${Math.round(worst * 100)}% worst component</b> <span class="d" style="color:var(--dim);font-size:9px">${canRepair ? "ready to repair here" : "requires DOCKED at a shipyard"}</span>`
        : `<b>Full condition</b> <span class="d" style="color:var(--dim);font-size:9px">nothing to repair</span>`}</span>
      <button class="repair-now" data-ship="${escapeAttr(shipSymbol)}" ${canRepair && worst < 1 ? "" : "disabled"}>Repair</button>
    </div>
  </div>`;
}

export function crewSectionHtml(crew) {
  if (!crew) return "";
  const pct = Math.max(0, Math.min(100, crew.morale ?? 0));
  const low = pct < 40;
  return `<div class="loadout-section"><h4>Crew</h4>
    <div class="loadout-item"><span class="n">${crew.current}/${crew.capacity} aboard</span><span class="d">min ${crew.required}</span></div>
    <div class="loadout-item"><span class="n">Morale<span class="meter${low ? " neg" : ""}" style="margin-left:6px"><i style="width:${pct}%"></i></span></span><span class="d">${pct}/100</span></div>
    <div class="loadout-item"><span class="n">${crew.rotation === "STRICT" ? "Strict shifts" : "Relaxed shifts"}</span><span class="d">${crew.rotation === "STRICT" ? "sharper, harder on morale" : "easier on morale"}</span></div>
    <div class="loadout-item"><span class="n">Wages</span><span class="d">${fmt(crew.wages)}c/crew/hr · ${fmt(crew.wages * crew.current)}c/hr total</span></div>
  </div>`;
}
