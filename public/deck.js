/**
 * Deck — desktop redesign. Overview (pass 1), Fleet (pass 2), and Markets (pass 3)
 * screens. See docs/deck-desktop-design.md, docs/deck-fleet-design.md, and
 * docs/deck-markets-design.md for build specs. All data comes through the same
 * shared/*.js store every other UI version uses, with no new fetching layer.
 */
import { api, onUnauthorized } from "/shared/api.js";
import { login, probeSession } from "/shared/session.js";
import {
  state, bridge, fleetStatus, approvals, dispatchAssignments, dispatchRoutes, activity,
  marketRoutes, intel,
  systems, marketSnapshots, leaderboard, factions, systemAgents, systemAgentsHistory,
  contracts, missions, feeds, feedChains, chainHealth, minerPreferences, notes,
  priceGoods, priceWaypointsByGood, pricePoints,
  doctrineRules, doctrineFires, doctrineFireShips,
  keeperMarketsCfg, keeperStationsCfg, keeperCoverList,
  connectionStatus,
  subscribe, subscribeConnection, loadState, loadBridge, loadApprovals, loadDispatch, loadActivity,
  loadMarkets, loadGoods, loadPrices, loadGalaxy, loadProgramme,
  loadDoctrine, loadDoctrineFireShips, loadKeepers, loadNotes,
} from "/shared/store.js";
import { startRateLimitIndicator } from "/shared/rateLimit.js";
import { enableAdmin, openAdmin, closeAdmin } from "/shared/admin.js";
import { initDeckMap, renderDeckMap, setDeckMapVisible, setDeckMapSystem, getDeckMapSystem, setDeckMapSelectedShip, mountDeckMap } from "/deck-map.js";
import { keeperCoverage, chainHealthHtml } from "/shared/domain.js";
import { cooldownHtml, startCooldownTicker, tickCooldowns, loadCollapsed, toggleCollapsed, roleRank } from "/shared/cooldown.js";
import { fmt, signed, escapeHtml, fmtTime, shortWp, roleMismatchReason } from "/shared/domain.js";

const $ = (id) => document.getElementById(id);
startRateLimitIndicator($("tb-conn"));
startCooldownTicker();

/* ── auth gate ─────────────────────────────
 * Same mechanism as Tower: session-cookie-based, existing tenants only.
 */
let authed = false;
onUnauthorized(() => showAuthGate("Session expired — sign in again."));

function showAuthGate(msg) {
  authed = false;
  $("auth-err").textContent = msg ?? "";
  $("app-root").hidden = true;
  $("auth-gate").hidden = false;
}

function hideAuthGate() {
  authed = true;
  $("auth-gate").hidden = true;
  $("app-root").hidden = false;
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("auth-token").value.trim();
  if (!token) return;
  try {
    const who = await login(token);
    hideAuthGate();
    if (who?.operator) enableAdmin($("rail-admin"));
    boot();
  } catch (err) {
    $("auth-err").textContent = err.message || "Could not reach the server.";
  }
});

/* ── view switching ────────────────────────
 * Overview, Fleet, and Markets screens; others show inert placeholders.
 */
function setView(name) {
  document.querySelectorAll(".content").forEach((c) => c.hidden = true);
  document.querySelectorAll(".rail .item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const viewEl = $(`view-${name}`);
  if (viewEl) viewEl.hidden = false;
  if (name !== "admin") closeAdmin();
  if (name === "admin") openAdmin();
  if (name === "fleet") renderFleet();
  if (name === "markets") renderMarkets();
  // One shared 3D map: Overview hosts it (home system) or the Map screen does.
  setDeckMapVisible(name === "map" || name === "overview");
  if (name === "overview") renderMinimap();
  if (name === "map") {
    mountDeckMap($("map-slot"));
    loadGalaxy();
    renderMap();
  }
  if (name === "ops") {
    loadProgramme();
    loadNotes();
    renderOps();
  }
  if (name === "feeds") {
    loadProgramme();
    loadGoods();
    renderFeeds();
    renderChains();
  }
  if (name === "doctrine") {
    loadDoctrine();
    loadDoctrineFireShips();
    renderDoctrine();
  }
}

$("rail").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (btn) setView(btn.dataset.view);
});

/* ── Topbar rendering ──────────────────────
 * Credits, rate, ships, connection status, AUTO/HALT toggle.
 */
function renderTopbar() {
  // Agent name in brand
  $("tb-agent").textContent = state?.agent?.symbol ?? "—";

  // Credits
  const credits = state?.agent?.credits ?? bridge.credits ?? 0;
  $("tb-credits").textContent = fmt(credits);

  // Rate (format with sign, color based on positive/negative)
  const rate = bridge.rate ?? 0;
  const rateEl = $("tb-rate");
  rateEl.textContent = signed(rate);
  rateEl.className = "v";
  if (rate >= 0) rateEl.classList.add("good");
  else rateEl.classList.add("bad");

  // Ships count
  $("tb-ships").textContent = (state?.ships ?? []).length;

  // Connection status pill
  const connEl = $("tb-conn");
  connEl.className = "pill";
  const level = connectionStatus.level ?? "unknown";
  if (level === "stale") connEl.classList.add("stale");
  else if (level === "offline") connEl.classList.add("offline");
  const textMap = { "live": "LIVE", "stale": "STALE", "offline": "OFFLINE", "unknown": "—" };
  connEl.innerHTML = `<i></i>${textMap[level] ?? "—"}`;

  // AUTO/HALT toggle
  const isHalt = fleetStatus.paused ?? false;
  $("tb-modes").querySelectorAll("span").forEach((s) => {
    const mode = s.dataset.mode;
    const isActive = (mode === "halt" && isHalt) || (mode === "auto" && !isHalt);
    s.classList.toggle("on", isActive);
  });
}

$("tb-modes").addEventListener("click", async (e) => {
  const mode = e.target.dataset.mode;
  if (!mode) return;
  const shouldPause = mode === "halt";
  const endpoint = shouldPause ? "/api/fleet/pause" : "/api/fleet/resume";
  try {
    await api("POST", endpoint, {});
    await loadBridge();
  } catch (err) {
    console.error(err);
  }
});

/* ── KPI tiles rendering ────────────────────
 * Credits, rate, ships, stranded, unassigned, manual hold, alerts, best route.
 * Note: "Forgone" is dropped per spec §5 (no data source), so 5 tiles instead of 6.
 */
function unassignedTraders() {
  const roleBy = new Map((fleetStatus.ships ?? []).map((s) => [s.symbol, s.role]));
  // A feed/mission carrier is claimed work, not idle: jobFor() already resolves feed and mission
  // claims (and loaded holds) before it falls back to "unassigned", so use it as the single test.
  return (state?.ships ?? []).filter(
    (s) => roleBy.get(s.symbol) === "trader" && !dispatchAssignments.some((a) => a.shipSymbol === s.symbol) && jobFor(s, "trader") === "unassigned",
  );
}

function renderKPIs() {
  const stranded = fleetStatus.stranded ?? [];
  const unassigned = unassignedTraders();
  const manual = (fleetStatus.ships ?? []).filter((s) => s.paused);
  const alerts = approvals.length;
  const bestRoute = [...dispatchAssignments].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0))[0];

  // Five KPI tiles (Credits and Rate are in the topbar, not duplicated here)
  const kpis = [
    {
      k: "Stranded",
      v: stranded.length,
      sub: stranded.length ? stranded.map((s) => s.symbol).join(" · ") : "none",
      cls: stranded.length ? "bad" : null,
    },
    {
      k: "Unassigned",
      v: unassigned.length,
      sub: null,
      cls: unassigned.length ? "amber" : null,
    },
    {
      k: "Manual hold",
      v: manual.length,
      sub: null,
      cls: manual.length ? "amber" : null,
    },
    {
      k: "Alerts",
      v: alerts,
      sub: `${alerts} approval${alerts === 1 ? "" : "s"}`,
      cls: alerts ? "amber" : null,
    },
    {
      k: "Best route now",
      v: bestRoute ? signed(bestRoute.profitPerTrip) : "—",
      sub: bestRoute ? bestRoute.good : "none",
      cls: "amber",
    },
    // Realized P&L from completed buy/sell round trips only, over the same
    // window the topbar's smoothed Rate averages — excludes cargo still in
    // transit, fuel, and repairs. Reads "—" rather than 0 when nothing has
    // closed yet in the window, so an idle fleet doesn't look like a
    // zero-profit one. Ported from v6.js's own "Matched" tile.
    (() => {
      const trades = bridge.matchedTrades ?? 0;
      const net = bridge.matchedNet ?? 0;
      return {
        k: "Matched",
        v: trades ? signed(net) : "—",
        sub: trades ? `${trades} trade${trades === 1 ? "" : "s"} · ${bridge.matchedWindowHours ?? 3}h window` : "no completed trades yet",
        cls: trades ? (net > 0 ? "good" : net < 0 ? "bad" : null) : null,
      };
    })(),
  ];

  $("ov-kpis").innerHTML = kpis.map((kpi) => `
    <div class="kpi">
      <div class="k">${escapeHtml(kpi.k)}</div>
      <div class="v${kpi.cls ? ` ${kpi.cls}` : ""}">${escapeHtml(String(kpi.v))}</div>
      ${kpi.sub ? `<div class="sub">${escapeHtml(String(kpi.sub))}</div>` : ""}
    </div>
  `).join("");
}

/* ── Home system mini-map ──────────────────
 * Renders waypoints in the home system as a spatial chart.
 * Ships shown as stranded or in-transit.
 */
function renderMinimap() {
  // Overview's "Home system" panel now hosts the same 3D map as the Map screen.
  if ($("view-overview").hidden) return;
  const homeSystem = state?.systemSymbol;
  if (!homeSystem) return;
  mountDeckMap($("ov-minimap"));
  setDeckMapVisible(true);
  if (getDeckMapSystem() !== homeSystem) setDeckMapSystem(homeSystem);
  else renderDeckMap();
  const wps = (state?.systems ?? []).find((s) => s.symbol === homeSystem)?.waypoints ?? [];
  $("ov-map-count").textContent = wps.length ? `${wps.length} waypoints` : "";
}

/* ── Wants vs. Doing table ──────────────────
 * Ships with wants/doing mismatches. Sorted by mismatch (wants !== doing)
 * then alphabetical.
 */
function renderWantsDoing() {
  const summary = fleetStatus.summary ?? [];
  // Filter to only ships that have a "wants" set
  const withWants = summary.filter((s) => s.wants);
  // Sort: mismatches first, then alphabetical
  withWants.sort((a, b) => {
    const aMismatch = a.wants !== a.doing ? 0 : 1;
    const bMismatch = b.wants !== b.doing ? 0 : 1;
    if (aMismatch !== bMismatch) return aMismatch - bMismatch;
    return a.symbol.localeCompare(b.symbol);
  });

  if (!withWants.length) {
    $("ov-wantsdo-rows").innerHTML = '<tr><td colspan="4" class="empty">No ships with wants pinned.</td></tr>';
    return;
  }

  $("ov-wantsdo-rows").innerHTML = withWants.map((s) => {
    const mismatch = s.wants !== s.doing;
    return `
      <tr>
        <td><span class="shipsym">${escapeHtml(s.symbol)}</span></td>
        <td>${escapeHtml(s.wants ?? "—")}</td>
        <td>${escapeHtml(s.doing ?? "—")}</td>
        <td>${mismatch ? '<div class="mismatch"><span class="w">wants</span><span class="d">vs</span></div>' : ""}</td>
      </tr>
    `;
  }).join("");
}

/* ── Approvals panel ────────────────────────
 * Right-hand signal rail: approvals and activity.
 */
function renderApprovals() {
  $("sig-approvals-count").textContent = approvals.length;
  const el = $("sig-approvals");
  if (!approvals.length) {
    el.innerHTML = '<div class="empty">No approvals waiting.</div>';
    return;
  }

  el.innerHTML = approvals.map((a) => `
    <div class="approval">
      <div class="kind">${escapeHtml(a.kind)}</div>
      <div class="body">${escapeHtml(a.detail)}</div>
      ${a.cost != null ? `<div class="body"><code>${fmt(a.cost)}c</code></div>` : ""}
      ${a.expiresAt ? `<div class="meta">expires ${new Date(a.expiresAt).toLocaleTimeString()}</div>` : ""}
      <div class="btns">
        <button class="btn pri" data-approve-id="${escapeHtml(a.id)}">Approve</button>
        <button class="btn deny" data-deny-id="${escapeHtml(a.id)}">Deny</button>
      </div>
    </div>
  `).join("");
}

$("sig-approvals").addEventListener("click", async (e) => {
  const approveBtn = e.target.closest("button[data-approve-id]");
  const denyBtn = e.target.closest("button[data-deny-id]");
  if (!approveBtn && !denyBtn) return;

  const id = approveBtn?.dataset.approveId ?? denyBtn?.dataset.denyId;
  const decision = approveBtn ? "approved" : "denied";
  const btn = approveBtn ?? denyBtn;
  btn.disabled = true;

  try {
    await api("POST", `/api/approvals/${id}/decide`, { decision });
    await loadApprovals();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
  }
});

/* ── Activity log ──────────────────────────
 * Copy Tower's ACTIVITY_HIDDEN_KINDS filtering.
 */
const ACTIVITY_HIDDEN_KINDS = new Set(["extract", "survey", "siphon", "scan", "market", "shipyard", "flightmode", "navigate"]);

function renderActivity() {
  const el = $("sig-activity");
  const rows = activity.filter((a) => !ACTIVITY_HIDDEN_KINDS.has(a.kind)).slice(0, 30);
  if (!rows.length) {
    el.innerHTML = '<div class="empty">No activity yet.</div>';
    return;
  }

  el.innerHTML = rows.map((a) => `
    <div class="actline${a.credits && a.credits < 0 ? " warn" : ""}">
      <b>${escapeHtml(a.detail)}</b>
      ${a.credits != null ? ` <span class="t">${signed(a.credits)}</span>` : ""}
      <span class="t">${fmtTime(a.timestamp)}</span>
    </div>
  `).join("");
}

/* ── Fleet screen (pass 2) ──────────────────
 * System-scope chip row, ship table, and detail panel.
 */
/** Priority: feed/chain claim, then mission claim (both apply to any role —
 *  a feed's crew is very often a miner, not a trader), then the trader-only
 *  dispatch assignment, then — lowest priority, informational only — cargo
 *  the ship happens to be holding that an active contract still wants.
 *  Ported from v6.js's own jobFor(), which takes the full ship object
 *  rather than just its symbol, so cargo/contract matching works too. */
function jobFor(ship, role) {
  const shipSymbol = ship.symbol;
  const feed = (feeds ?? []).find((f) => f.assignedShips?.includes(shipSymbol));
  if (feed) {
    const label = feed.chainName ? `chain: ${escapeHtml(feed.chainName)}` : `feed: ${escapeHtml(feed.good)}`;
    return `${label} → ${escapeHtml(feed.targetWaypoint)}`;
  }
  const mission = (missions ?? []).find((m) => m.status !== "complete" && m.assignedShips?.includes(shipSymbol));
  if (mission) {
    const outstanding = (mission.materials ?? []).find((mm) => mm.fulfilled < mm.required);
    return `mission: ${escapeHtml(outstanding?.tradeSymbol ?? "supplying")} @ ${escapeHtml(mission.targetWaypoint)}`;
  }
  if (role === "trader") {
    const a = dispatchAssignments.find((x) => x.shipSymbol === shipSymbol);
    if (a) {
      const good = escapeHtml(a.good);
      if (a.role === "direct") return `route: ${good}`;
      if (a.role === "contractBuy") return `contract: ${good}`;
      if (a.role === "haul") return `mission: ${good}`;
      if (a.role === "buy") return a.missionBuy ? `mission: ${good}` : `warehouse buy: ${good}`;
      if (a.role === "sell") return `warehouse sell: ${good}`;
      return good;
    }
  }
  const held = new Set((ship.cargo?.inventory ?? []).map((i) => i.symbol));
  const wanted = (contracts ?? []).find((c) => c.accepted && !c.fulfilled && !c.abandoned && c.deliver.some((d) => held.has(d.tradeSymbol) && d.unitsFulfilled < d.unitsRequired));
  if (wanted) {
    const d = wanted.deliver.find((x) => held.has(x.tradeSymbol));
    return `contract: ${escapeHtml(d.tradeSymbol)} → ${escapeHtml(d.destinationSymbol)}`;
  }
  // A trader with no dispatcher assignment but a loaded hold is mid-trade
  // (bought, not yet sold), not idle: say what it is carrying instead of
  // "unassigned" — the dispatcher assignment is lost on a restart/role flip
  // while the cargo is still very much aboard.
  const cargoUnits = ship.cargo?.units ?? 0;
  if (role === "trader" && cargoUnits > 0) {
    const top = [...(ship.cargo?.inventory ?? [])].sort((a, b) => b.units - a.units)[0];
    return `carrying: ${top ? `${top.units} ${escapeHtml(top.symbol)}` : `${cargoUnits} units`}`;
  }
  return role === "trader" ? "unassigned" : "—";
}

/** The honest, role-appropriate fallback for a ship with no live intent —
 *  "autonomous" alone reads as if automation stalled fleet-wide. Ported
 *  from v6.js's own describeAutomation(). */
function describeAutomation(r) {
  const status = (fleetStatus.ships ?? []).find((s) => s.symbol === r.symbol);
  const ship = (state?.ships ?? []).find((s) => s.symbol === r.symbol) ?? { symbol: r.symbol };
  const claim = jobFor(ship, r.role);
  if (r.role === "trader") {
    return claim === "unassigned" ? "unassigned — no viable route right now" : claim;
  }
  if (claim !== "—") return claim;
  if ((r.role === "miner" || r.role === "surveyor") && status?.pinnedField) return `pinned to mine at ${shortWp(status.pinnedField)}`;
  if (r.role === "miner") return "autonomous — picks its own field each cycle";
  if (r.role === "surveyor") return "autonomous — surveying for the fleet's miners";
  if (r.role === "tour" && status?.tourDestination) return `touring toward ${shortWp(status.tourDestination)}`;
  if (r.role === "tour") return "autonomous — touring known markets";
  if (r.role === "keeper") return "stationed, keeping its market fresh";
  if (r.role === "siphoner") return "autonomous — siphoning its assigned target";
  if (r.role === "scout") return "autonomous — scouting connected systems";
  if (r.role === "warehouse") return "designated warehouse ship";
  if (r.role === "idle") return "idle — no role assigned";
  return "autonomous";
}

/** Every ship's current automated decision, from fleetStatusSummary()'s own
 *  wants/wantsReason/wantsSource. Ported from v6.js's renderAutomationFeed(). */
function renderAutomationFeed() {
  const el = $("automation-feed");
  const countEl = $("automation-count");
  if (!el) return;
  const rows = [...(fleetStatus.summary ?? [])].sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (countEl) countEl.textContent = `${rows.length} ships`;
  if (!rows.length) { el.innerHTML = '<div class="empty">No ships in the register.</div>'; return; }
  el.innerHTML = rows.map((r) => {
    const cls = r.doing === "stranded" ? "warn" : r.wantsSource === "operator" ? "hold" : "";
    const wants = r.wants
      ? `<b>${escapeHtml(r.wants)}</b>${r.wantsSource ? ` <span class="src">${escapeHtml(r.wantsSource)}</span>` : ""}`
      : `<span class="ops-sub">${describeAutomation(r)}</span>`;
    return `<div class="automation-row ${cls}">
      <span class="ship"><b>${escapeHtml(shortWp(r.symbol))}</b><span class="role">${escapeHtml(r.role)}</span></span>
      <span class="doing">${escapeHtml(r.doing)}</span>
      <span class="wants">${wants}${r.wantsReason ? ` <span class="why">— ${escapeHtml(r.wantsReason)}</span>` : ""}</span>
    </div>`;
  }).join("");
}

/* ── Notes (Ops) ──────────────────────────────
 * Operator's own persisted scratchpad — a log line or a note to self.
 * Ported from v6.js's own Notes pane (append/list/delete only, nothing
 * the engine reads or acts on).
 */
function renderNotes() {
  const el = $("notes");
  if (!el) return;
  el.innerHTML = (notes ?? []).length
    ? notes.map((n) => `<div class="ops-card">
        <div class="ops-head">
          <span class="ops-sub">${escapeHtml(fmtTime(n.createdAt))}</span>
          <span class="fill"></span>
          <button class="btn ghost" data-act="delete-note" data-id="${escapeAttr(n.id)}">Delete</button>
        </div>
        <div style="margin-top:4px; white-space:pre-wrap">${escapeHtml(n.body)}</div>
      </div>`).join("")
    : '<div class="empty">No notes yet.</div>';
}
async function addNote() {
  const input = $("note-input");
  const body = input.value.trim();
  if (!body) return;
  const btn = $("note-add");
  btn.disabled = true;
  try {
    await api("POST", "/api/notes", { body });
    input.value = "";
    await loadNotes();
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; }
}
$("note-add").addEventListener("click", addNote);
$("note-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addNote(); });
$("notes").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act='delete-note']");
  if (!b) return;
  b.disabled = true;
  try {
    await api("DELETE", `/api/notes/${b.dataset.id}`);
    await loadNotes();
  } catch (err) { alert(err.message); b.disabled = false; }
});

function fleetRows() {
  const ships = state?.ships ?? [];
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = (fleetStatus.ships ?? []).find((x) => x.symbol === s.symbol);
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
      job: jobFor(s, st?.role),
      cooldown: cooldownHtml(s),
      stranded: strandedBy.has(s.symbol),
      fuel: s.fuel?.current ?? 0, fuelCap: s.fuel?.capacity ?? 0,
      cargo: s.cargo?.units ?? 0, cargoCap: s.cargo?.capacity ?? 0,
      goal: strandedBy.has(s.symbol) ? "stranded" : st?.paused ? "manual hold" : (s.nav?.status ?? "").replace(/_/g, " ").toLowerCase(),
      at: s.nav?.waypointSymbol ?? "",
      // route.arrival is the game's own committed ETA — only meaningful
      // while actually IN_TRANSIT, since the API leaves it holding the last
      // flight's arrival time once a ship has landed. Ported from v6.js.
      eta: s.nav?.status === "IN_TRANSIT" ? s.nav?.route?.arrival : undefined,
      flightMode: s.nav?.status === "IN_TRANSIT" ? s.nav?.flightMode : undefined,
      frame: s.frame?.symbol ?? "",
      cargoInventory: s.cargo?.inventory ?? [],
    };
  });
}

function fmTag(flightMode) {
  if (flightMode === "DRIFT") return `<span class="fm-tag fm-drift" title="Drifting: not enough fuel for cruise, very slow">drift</span>`;
  if (flightMode === "BURN") return `<span class="fm-tag fm-burn">burn</span>`;
  return "";
}

let selectedFleetShip = null;
let selectedFleetSystem = "All systems";

/** Time remaining until a ship's `nav.route.arrival`, as "Xh Ym" / "Ym" /
 *  "<1m". Already arrived or no active transit both read as "—" rather
 *  than a negative duration. Ported from v6.js's own fmtEta(). */
function fmtEta(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderFleet() {
  const rows = fleetRows();

  // Group by system (derive from waypoint: waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-")))
  const groupedSystems = {};
  for (const row of rows) {
    let sys = "Unknown";
    if (row.at) {
      const lastDash = row.at.lastIndexOf("-");
      if (lastDash > 0) sys = row.at.slice(0, lastDash);
    }
    if (!groupedSystems[sys]) groupedSystems[sys] = [];
    groupedSystems[sys].push(row);
  }

  // Render chip row
  const systems = Object.keys(groupedSystems).sort();
  const chipHTML = `
    <div class="syschip${selectedFleetSystem === "All systems" ? " on" : ""}" data-sys="All systems">All systems · ${rows.length}</div>
    ${systems.map((sys) => `<div class="syschip${selectedFleetSystem === sys ? " on" : ""}" data-sys="${escapeAttr(sys)}">${escapeHtml(sys)} · ${groupedSystems[sys].length}</div>`).join("")}
  `;
  $("fleet-chiprow").innerHTML = chipHTML;

  // Wire chip clicks
  $("fleet-chiprow").querySelectorAll(".syschip").forEach((chip) => {
    chip.addEventListener("click", () => {
      selectedFleetSystem = chip.dataset.sys;
      renderFleet();
    });
  });

  // Filter rows to selected system
  const displayRows = selectedFleetSystem === "All systems" ? rows : rows.filter((r) => {
    let sys = "Unknown";
    if (r.at) {
      const lastDash = r.at.lastIndexOf("-");
      if (lastDash > 0) sys = r.at.slice(0, lastDash);
    }
    return sys === selectedFleetSystem;
  });

  // Render table: role groups (same grouping as Tower/V6), collapsible. A
  // collapsed group must not hide trouble, so its header counts what needs
  // attention.
  const collapsed = loadCollapsed();
  const rowHtml = (row) => {
    const fuelPct = row.fuelCap ? Math.round((row.fuel / row.fuelCap) * 100) : 0;
    let statusClass = "";
    if (row.goal === "stranded") statusClass = "bad";
    else if (["in_transit", "docked", "orbiting"].some((s) => row.goal.includes(s))) statusClass = "good";

    return `
      <tr data-ship="${escapeAttr(row.symbol)}"${selectedFleetShip === row.symbol ? ' class="sel"' : ""}>
        <td><span class="shipsym">${escapeHtml(row.symbol)}</span></td>
        <td><span class="chip ${escapeHtml(row.role)}">${escapeHtml(row.role)}</span></td>
        <td>${escapeHtml(row.job)} ${row.cooldown}</td>
        <td${statusClass ? ` class="${statusClass}"` : ""}>${escapeHtml(row.goal)}</td>
        <td class="mono">${fuelPct}%</td>
        <td class="mono">${row.cargo}/${row.cargoCap}</td>
        <td class="mono">${escapeHtml(row.at)}</td>
        <td class="mono eta${fmtEta(row.eta) !== "—" ? " live" : ""}">${escapeHtml(fmtEta(row.eta))}${fmTag(row.flightMode)}</td>
      </tr>
    `;
  };
  const roleGroups = new Map();
  for (const row of displayRows) {
    const g = roleGroups.get(row.role) ?? [];
    g.push(row);
    roleGroups.set(row.role, g);
  }
  const tableHTML = [...roleGroups.entries()]
    .sort((a, b) => roleRank(a[0]) - roleRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([role, items]) => {
      const isCollapsed = collapsed.has(role);
      const crit = items.filter((r) => r.stranded).length;
      const warn = items.filter((r) => !r.stranded && r.job === "unassigned").length;
      const badge = crit ? `<span class="grp-badge crit">${crit} stranded</span>` : warn ? `<span class="grp-badge warn">${warn} unassigned</span>` : "";
      return `<tr class="grp-row" data-grp="${escapeAttr(role)}" aria-expanded="${!isCollapsed}"><td colspan="8">
        <span class="chev">${isCollapsed ? "▸" : "▾"}</span><span class="g-name">${escapeHtml(role)}</span><span class="g-n">${items.length}</span>${badge}
      </td></tr>${isCollapsed ? "" : items.map(rowHtml).join("")}`;
    }).join("");
  $("fleet-table-rows").innerHTML = tableHTML;
  tickCooldowns($("fleet-table-rows"));

  // Wire group header clicks (collapse/expand)
  $("fleet-table").querySelectorAll("tbody tr.grp-row").forEach((tr) => {
    tr.addEventListener("click", () => { toggleCollapsed(tr.dataset.grp); renderFleet(); });
  });

  // Wire table row clicks
  $("fleet-table").querySelectorAll("tbody tr[data-ship]").forEach((tr) => {
    tr.addEventListener("click", () => {
      if (tr.dataset.ship !== selectedFleetShip) resetFleetActionForms();
      selectedFleetShip = tr.dataset.ship;
      renderFleet();
    });
  });

  // Render detail panel
  if (selectedFleetShip) {
    const shipRow = rows.find((r) => r.symbol === selectedFleetShip);
    if (shipRow) {
      const wants = shipRow.role === "trader" ? (shipRow.job !== "unassigned" && shipRow.job !== "—" ? shipRow.job : "unassigned") : shipRow.role.charAt(0).toUpperCase() + shipRow.role.slice(1);
      const doing = shipRow.goal;

      const detailHeadHTML = `
        <div class="name"><span class="shipsym">${escapeHtml(shipRow.symbol)}</span><span class="chip ${escapeHtml(shipRow.role)}">${escapeHtml(shipRow.role)}</span></div>
        <div class="wantsdo">
          <div class="wd">
            <div class="l">Wants</div>
            <div class="v">${escapeHtml(wants)}</div>
          </div>
          <div class="wd${doing === "stranded" ? " bad" : ""}">
            <div class="l">Doing</div>
            <div class="v">${escapeHtml(doing)}</div>
          </div>
        </div>
      `;
      $("fleet-detail-head").innerHTML = detailHeadHTML;

      const cargoHTML = shipRow.cargoInventory.map((item) => {
        const pct = (item.units / shipRow.cargoCap) * 100;
        return `
          <div class="cargorow">
            <span class="g">${escapeHtml(item.symbol)}</span>
            <span class="mono">${item.units}/${shipRow.cargoCap}</span>
          </div>
          <div class="meter"><i style="width:${pct}%"></i></div>
        `;
      }).join("");

      const detailBodyHTML = `
        ${cargoHTML}
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
          <div>
            <div class="wd"><div class="l">Frame</div><div class="v">${escapeHtml(shipRow.frame)}</div></div>
          </div>
          <div>
            <div class="wd"><div class="l">Fuel</div><div class="v mono">${shipRow.fuel}/${shipRow.fuelCap}</div></div>
          </div>
        </div>
        <div class="detail-actions" id="fleet-detail-actions"></div>
      `;
      $("fleet-detail-body").innerHTML = detailBodyHTML;
      renderFleetActions(shipRow);
    } else {
      $("fleet-detail-head").innerHTML = '<div class="empty">Select a ship to see details.</div>';
      $("fleet-detail-body").innerHTML = '';
      renderFleetActions(null);
    }
  } else {
    $("fleet-detail-head").innerHTML = '<div class="empty">Select a ship to see details.</div>';
    $("fleet-detail-body").innerHTML = '';
    renderFleetActions(null);
  }
}

/* ── Fleet ship-action sheet (pass A) ────────
 * Per-ship hold/release, dock, repair, role change, sell/scrap, assign
 * route, send-to-waypoint, and full details (jettison/install/remove).
 * Ported from Tower's own working sheet (public/m.js renderSheet() +
 * its #sheet-actions handler) — same endpoints, same body shapes. Every
 * endpoint already existed in src/http/dashboard.ts; no new backend.
 */
let fleetSendOpen = false;
let fleetRouteOpen = false;
let fleetRoleOpen = false;
let fleetRoleFormRole = null;
let fleetDetailsOpen = false;

const SHIP_ROLES = ["trader", "miner", "surveyor", "siphoner", "tour", "explorer", "scout", "keeper"];

function roleLabel(role) {
  return String(role).split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

/** Cargo hold, loadout, modules, mounts, install-from-cargo — the same
 *  fields Tower's sheet shows; ported verbatim from m.js renderShipDetails(). */
function renderShipDetails(ship) {
  if (!ship) return "";
  const part = (p) => p ? `<div class="detail-row"><span>${escapeHtml(p.name ?? p.symbol)}</span><span class="d">${escapeHtml(p.symbol)}</span></div>` : "";
  const cargo = ship.cargo?.inventory ?? [];
  const modules = ship.modules ?? [];
  const mounts = ship.mounts ?? [];
  const cargoComps = cargo.filter((i) => i.symbol.startsWith("MODULE_") || i.symbol.startsWith("MOUNT_"));

  const role = ship.registration?.role;
  const capacity = ship.cargo?.capacity ?? 0;

  return `<div class="ship-details">
    ${role ? `<div class="detail-row"><span>Type</span><span class="d">${escapeHtml(roleLabel(role))}</span></div>` : ""}
    <div class="dtl-h">Cargo hold ${ship.cargo?.units ?? 0}/${capacity}</div>
    ${cargo.length
      ? cargo.map((i) => `<div class="detail-row"><span>${i.units}u ${escapeHtml(i.symbol)}</span><button class="btn deny" data-act="jettison" data-good="${escapeAttr(i.symbol)}" data-units="${i.units}">Jettison</button></div>`).join("")
      : '<div class="empty">Hold is empty.</div>'}
    <div class="dtl-h">Loadout</div>
    ${part(ship.frame)}${part(ship.reactor)}${part(ship.engine)}
    <div class="dtl-h">Modules</div>
    ${modules.length
      ? modules.map((m) => `<div class="detail-row"><span>${escapeHtml(m.name)}</span><button class="btn deny" data-act="remove-comp" data-comp="${escapeAttr(m.symbol)}">Remove</button></div>`).join("")
      : '<div class="empty">No modules.</div>'}
    <div class="dtl-h">Mounts</div>
    ${mounts.length
      ? mounts.map((m) => `<div class="detail-row"><span>${escapeHtml(m.name)}</span><button class="btn deny" data-act="remove-comp" data-comp="${escapeAttr(m.symbol)}">Remove</button></div>`).join("")
      : '<div class="empty">No mounts.</div>'}
    <div class="dtl-h">Components in cargo</div>
    ${cargoComps.length
      ? cargoComps.map((i) => `<div class="detail-row"><span>${escapeHtml(i.symbol)}</span><button class="btn" data-act="install-comp" data-comp="${escapeAttr(i.symbol)}">Install</button></div>`).join("")
      : '<div class="empty">No modules/mounts in cargo.</div>'}
  </div>`;
}

function renderFleetActions(shipRow) {
  const el = $("fleet-detail-actions");
  if (!el) return;
  if (!shipRow) { el.innerHTML = ""; return; }
  const ship = (state?.ships ?? []).find((s) => s.symbol === shipRow.symbol);
  if (!ship) { el.innerHTML = ""; return; }

  const st = (fleetStatus.ships ?? []).find((s) => s.symbol === shipRow.symbol);
  const nav = ship.nav?.status ?? "";
  const holdBtn = st?.paused
    ? `<button class="btn" data-act="release">Release</button>`
    : `<button class="btn" data-act="hold">Hold</button>`;
  // Disabled (not hidden) mid-transit, matching the endpoint's own guard.
  const dockBtn = nav === "IN_TRANSIT"
    ? `<button class="btn" disabled title="in transit — wait for arrival">Dock / Undock</button>`
    : `<button class="btn" data-act="dock-toggle">${nav === "DOCKED" ? "Undock" : "Dock"}</button>`;

  let extra = "";
  if (fleetSendOpen) {
    extra += `<div class="sheet-inline-form"><input class="field-input" id="fleet-send-wp" placeholder="Waypoint, e.g. X1-A-B2" /><button class="btn pri" data-act="send-go">Go</button></div>`;
  }
  if (fleetRouteOpen) {
    const top = [...dispatchRoutes].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0)).slice(0, 4);
    extra += `<div class="route-pick">${
      top.length
        ? top.map((r) => `<button data-act="route-pick" data-good="${escapeAttr(r.good)}"><span>${escapeHtml(r.good)}</span><b>${signed(r.profitPerTrip)}/trip</b></button>`).join("")
        : '<div class="empty">No profitable routes right now.</div>'
    }</div>`;
  }
  if (fleetRoleOpen) {
    const currentRole = fleetRoleFormRole ?? (SHIP_ROLES.includes(shipRow.role) ? shipRow.role : SHIP_ROLES[0]);
    const mismatch = roleMismatchReason(currentRole, ship);
    extra += `<div class="role-form">
      <div class="sheet-inline-form">
        <select class="role-select field-select" aria-label="New role">
          ${SHIP_ROLES.map((r) => `<option value="${r}" ${r === currentRole ? "selected" : ""}>${r}</option>`).join("")}
        </select>
        <button class="btn pri" data-act="role-set">Set</button>
      </div>
      ${mismatch ? `<div class="role-warn">⚠ ${escapeHtml(mismatch)}</div>` : ""}
      ${currentRole === "keeper" ? `<input class="role-keeper-wp field-input" placeholder="keeper market waypoint (skip if already there)" />` : ""}
    </div>`;
  }
  if (fleetDetailsOpen) extra += renderShipDetails(ship);

  el.innerHTML = `
    <button class="btn" data-act="send-toggle">Send to waypoint</button>
    ${holdBtn}
    ${dockBtn}
    <button class="btn" data-act="route-toggle">Assign route</button>
    <button class="btn" data-act="repair">Repair</button>
    <button class="btn deny" data-act="sell">Sell / Scrap</button>
    <button class="btn full" data-act="role-toggle">${fleetRoleOpen ? "Close" : `Change role (${escapeHtml(shipRow.role)})`}</button>
    <button class="btn full" data-act="details-toggle">${fleetDetailsOpen ? "Close full details" : "Full details"}</button>
    ${extra}
  `;
}

function resetFleetActionForms() {
  fleetSendOpen = false;
  fleetRouteOpen = false;
  fleetRoleOpen = false;
  fleetRoleFormRole = null;
  fleetDetailsOpen = false;
}

$("fleet-detail-body").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  const ship = selectedFleetShip;
  if (!ship) return;

  if (act === "send-toggle") { fleetSendOpen = !fleetSendOpen; fleetRouteOpen = false; fleetRoleOpen = false; fleetDetailsOpen = false; return renderFleet(); }
  if (act === "route-toggle") { fleetRouteOpen = !fleetRouteOpen; fleetSendOpen = false; fleetRoleOpen = false; fleetDetailsOpen = false; return renderFleet(); }
  if (act === "role-toggle") {
    fleetRoleOpen = !fleetRoleOpen;
    fleetRoleFormRole = null;
    fleetSendOpen = false;
    fleetRouteOpen = false;
    fleetDetailsOpen = false;
    return renderFleet();
  }
  if (act === "details-toggle") {
    fleetDetailsOpen = !fleetDetailsOpen;
    fleetSendOpen = false;
    fleetRouteOpen = false;
    fleetRoleOpen = false;
    return renderFleet();
  }
  if (act === "jettison") {
    const { good, units } = b.dataset;
    if (!confirm(`Jettison ${units}u ${good} from ${ship}? This cannot be undone.`)) return;
    b.disabled = true;
    try { await api("POST", "/api/fleet/jettison", { shipSymbol: ship, good, units: Number(units) }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "remove-comp") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/remove-component", { shipSymbol: ship, componentSymbol: b.dataset.comp }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "install-comp") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/install", { shipSymbol: ship, componentSymbol: b.dataset.comp }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "role-set") {
    const role = $("fleet-detail-actions").querySelector(".role-select")?.value;
    if (!role) return;
    const keeperMarket = $("fleet-detail-actions").querySelector(".role-keeper-wp")?.value.trim() || undefined;
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/role", { shipSymbol: ship, role, keeperMarket });
      resetFleetActionForms();
      await loadBridge();
    } catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "send-go") {
    const wp = $("fleet-send-wp")?.value.trim();
    if (!wp) return;
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/dispatch", { shipSymbol: ship, waypointSymbol: wp });
      fleetSendOpen = false;
      await loadBridge();
    } catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "route-pick") {
    const route = dispatchRoutes.find((r) => r.good === b.dataset.good);
    b.disabled = true;
    try {
      await api("POST", "/api/dispatch", {
        shipSymbol: ship, good: b.dataset.good,
        buyAt: route?.buyAt, sellAt: route?.sellAt,
        buyPrice: route?.buyPrice, sellPrice: route?.sellPrice,
        profitPerTrip: route?.profitPerTrip,
      });
      fleetRouteOpen = false;
      await loadDispatch();
    } catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "hold" || act === "release") {
    b.disabled = true;
    try { await api("POST", `/api/fleet/${act}`, { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "dock-toggle") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/dock", { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "repair") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/repair", { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderFleet();
  }
  if (act === "sell") {
    if (!confirm(`Sell ${ship} permanently? It will fly to the nearest shipyard and be scrapped there. This cannot be undone.`)) return;
    b.disabled = true;
    try { await api("POST", "/api/fleet/sell-ship", { shipSymbol: ship }); selectedFleetShip = null; await loadState(); }
    catch (err) { alert(err.message); }
    return renderFleet();
  }
});

$("fleet-detail-body").addEventListener("change", (e) => {
  if (!e.target.classList.contains("role-select")) return;
  fleetRoleFormRole = e.target.value;
  renderFleet();
});

function escapeAttr(s) {
  return (s + "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ── Markets screen (pass 3) ─────────────────
 * Routes, Yards & outfitting, Warehouse, Dispatch read-only panels.
 */
function renderMarkets() {
  // Routes panel
  const routesHtml = (() => {
    if (!marketRoutes.length) {
      return '<div class="empty">No profitable routes yet.</div>';
    }
    const sorted = [...marketRoutes].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0));
    const top5 = sorted.slice(0, 5);
    return top5.map((r) => `
      <div class="goodrow">
        <div style="flex:1">
          <div class="name">${escapeHtml(r.goodSymbol)}</div>
          <div class="route">${escapeHtml(r.buyAt)} → ${escapeHtml(r.sellAt)}</div>
        </div>
        <div class="profit">${signed(r.profitPerTrip)}</div>
      </div>
    `).join('');
  })();
  const routesEl = $("mk-routes");
  if (routesEl) routesEl.innerHTML = routesHtml;

  // Yards & outfitting panel
  const yardsHtml = (() => {
    const yards = intel.shipyards ?? [];
    if (!yards.length) {
      return '<div class="empty">No shipyard intel yet.</div>';
    }
    const byType = new Map();
    for (const y of yards) {
      if (!byType.has(y.shipType)) byType.set(y.shipType, []);
      byType.get(y.shipType).push(y);
    }
    const groups = [...byType.values()]
      .map((rows) => rows.slice().sort((a, b) => a.purchasePrice - b.purchasePrice))
      .sort((a, b) => a[0].purchasePrice - b[0].purchasePrice);
    if (!groups.length) {
      return '<div class="empty">No shipyard intel yet.</div>';
    }
    return groups.map((rows) => {
      const best = rows[0];
      return `
        <div class="goodrow">
          <div style="flex:1">
            <div class="name">${escapeHtml(best.shipTypeName)}</div>
            <div class="route">${escapeHtml(shortWp(best.waypointSymbol))}</div>
          </div>
          <div class="profit">${fmt(best.purchasePrice)}c</div>
          <button class="btn pri" style="margin-left:10px" data-buy-ship="${escapeAttr(best.shipType)}" data-yard="${escapeAttr(best.waypointSymbol)}" title="Buy ${escapeAttr(best.shipTypeName)} at ${escapeAttr(best.waypointSymbol)}">Buy</button>
          ${rows.slice(1).map((o) => `<button class="btn" style="margin-left:4px" data-buy-ship="${escapeAttr(o.shipType)}" data-yard="${escapeAttr(o.waypointSymbol)}" title="Buy at ${escapeAttr(o.waypointSymbol)}">${escapeHtml(shortWp(o.waypointSymbol))} ${fmt(o.purchasePrice)}c</button>`).join("")}
        </div>
      `;
    }).join('');
  })();
  const yardsEl = $("mk-yards");
  if (yardsEl) yardsEl.innerHTML = yardsHtml;



  // Dispatch panel
  const dispatchHtml = (() => {
    if (!dispatchAssignments.length) {
      return '<div class="empty">No traders assigned routes yet.</div>';
    }
    const top5 = dispatchAssignments.slice(0, 5);
    return top5.map((a) => {
      const job = jobFor(a.shipSymbol, "trader");
      return `
        <div class="goodrow">
          <div style="flex:1">
            <div class="name">${escapeHtml(a.shipSymbol)}</div>
            <div class="route">${escapeHtml(job)}</div>
          </div>
        </div>
      `;
    }).join('');
  })();
  const dispatchEl = $("mk-dispatch");
  if (dispatchEl) dispatchEl.innerHTML = dispatchHtml;

  // Toolbars (pass B) — repopulate the selects while preserving whatever
  // the operator currently has chosen, same discipline as v6.js's
  // renderDispatch()/renderWarehouse(): a 15s poll must not yank the
  // selection back to the first option mid-interaction.
  const traders = (fleetStatus.ships ?? []).filter((s) => s.role === "trader");
  setSelectOptions($("mk-dispatch-ship"), traders.map((s) => s.symbol));
  setSelectOptions($("mk-dispatch-good"), [...new Set(dispatchRoutes.map((r) => r.good))]);
  renderMinerPreferences();

  // Keeper panel (optional Pass B) — static textarea, so re-rendering must
  // not clobber what the operator is midway through typing.
  renderKeepers();
  renderMktPricePickers();
  renderMktPriceChart();
  renderMktPriceMarketList();
}

/* ── Markets: Routes/Yards/Prices segment ────
 * Ported from Tower's own Prices tab (m.js) — good/marketplace pickers,
 * timeframe buttons, a compact SVG price line, and the per-market list with
 * the keeper-priority badge.
 */
let mktSeg = "routes";
let priceGood = "";
let priceWaypoint = "";
let priceTimeframeMs = 86_400_000;

$("mk-mkt-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-seg]");
  if (!b) return;
  mktSeg = b.dataset.seg;
  $("mk-mkt-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  $("mk-routes").hidden = mktSeg !== "routes";
  $("mk-yards").hidden = mktSeg !== "yards";
  $("mk-prices").hidden = mktSeg !== "prices";
  $("mk-keeper").hidden = mktSeg !== "keeper";
  $("mk-mkt-seg-count").textContent = mktSeg === "prices" || mktSeg === "keeper" ? "" : "top 5";
});

/** Covered/pending/unflagged indicator for one market waypoint — ported
 *  from Tower's own keeperBadge() (m.js), same three states and the same
 *  tap-to-toggle /api/keeper/markets call. */
function keeperBadge(wp) {
  const cov = keeperCoverage(wp, keeperStationsCfg, keeperMarketsCfg, state?.ships);
  if (cov === "covered") return `<span class="keeper-badge covered" title="Keeper stationed here">● covered</span>`;
  if (cov === "enroute") return `<span class="keeper-badge pending" title="A keeper is on its way — this becomes covered when it arrives">◐ pending</span>`;
  if (cov === "pending") return `<span class="keeper-badge pending" data-wp="${escapeAttr(wp)}" role="button" title="On the keeper priority list, no keeper stationed yet — click to remove">◐ pending</span>`;
  return `<span class="keeper-badge none" data-wp="${escapeAttr(wp)}" role="button" title="Not on the keeper priority list — click to add">+ keeper</span>`;
}
async function toggleKeeperPriority(wp) {
  const next = keeperMarketsCfg.includes(wp) ? keeperMarketsCfg.filter((m) => m !== wp) : [...keeperMarketsCfg, wp];
  try {
    await api("POST", "/api/keeper/markets", { markets: next });
    await loadKeepers();
  } catch (err) { alert(err.message); }
}

function renderMktPriceMarketList() {
  const el = $("mk-price-market-list");
  if (!el) return;
  const waypoints = priceWaypointsByGood[priceGood] ?? [];
  if (!waypoints.length) { el.innerHTML = '<div class="empty">No snapshots for this good yet.</div>'; return; }
  const byWp = new Map(marketSnapshots.filter((s) => s.goodSymbol === priceGood).map((s) => [s.waypointSymbol, s]));
  el.innerHTML = waypoints.map((wp) => {
    const snap = byWp.get(wp);
    return `<div class="goodrow"><span>${escapeHtml(shortWp(wp))} ${keeperBadge(wp)}</span><span class="d">${
      snap ? `buy ${fmt(snap.purchasePrice)} · sell ${fmt(snap.sellPrice)}` : "no recent snapshot"
    }</span></div>`;
  }).join("");
}
$("mk-price-market-list").addEventListener("click", (e) => {
  const b = e.target.closest(".keeper-badge[data-wp]");
  if (b) toggleKeeperPriority(b.dataset.wp);
});

/** Compact SVG price line — amber sell, dashed green buy. Ported from
 *  Tower's own renderPriceChart() (m.js). */
function renderMktPriceChart() {
  const el = $("mk-price-chart-room");
  if (!el) return;
  if (!pricePoints.length) { el.innerHTML = '<div class="empty">No price history for this good yet.</div>'; return; }
  const W = Math.max(120, el.clientWidth || 320), H = Math.max(80, el.clientHeight || 160), P = 12;
  const sellVals = pricePoints.map((p) => Number(p.avg));
  const buyVals = pricePoints.map((p) => (p.buyAvg == null ? NaN : Number(p.buyAvg)));
  const hasBuy = buyVals.some((v) => Number.isFinite(v));
  const allVals = hasBuy ? [...sellVals, ...buyVals.filter(Number.isFinite)] : sellVals;
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => P + (i / (pricePoints.length - 1 || 1)) * (W - P * 2);
  const y = (v) => H - P - ((v - min) / span) * (H - P * 2);
  const toLine = (vals) => vals.map((v, i) => (Number.isFinite(v) ? `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}` : "")).join(" ");
  const sellLine = toLine(sellVals);
  const buyLine = hasBuy ? toLine(buyVals) : "";
  const lastIdx = pricePoints.length - 1;
  const lastBuy = buyVals[lastIdx];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${[0.25, 0.5, 0.75].map((f) => `<line x1="${P}" x2="${W - P}" y1="${y(min + span * f)}" y2="${y(min + span * f)}" stroke="var(--hair)" stroke-width="1"/>`).join("")}
    <path d="${sellLine}" fill="none" stroke="var(--amber)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${x(lastIdx)}" cy="${y(sellVals[lastIdx])}" r="2.5" fill="var(--amber)"/>
    ${hasBuy ? `<path d="${buyLine}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3,2"/>` : ""}
    ${hasBuy && Number.isFinite(lastBuy) ? `<circle cx="${x(lastIdx)}" cy="${y(lastBuy)}" r="2.5" fill="var(--green)"/>` : ""}
    <text x="${P}" y="${y(max)}" font-size="8" fill="var(--dim)">${Math.round(max)}</text>
    <text x="${P}" y="${y(min)}" font-size="8" fill="var(--dim)">${Math.round(min)}</text>
    ${hasBuy ? `<g transform="translate(${W - P - 66},${P - 4})" font-size="8">
      <line x1="0" y1="0" x2="9" y2="0" stroke="var(--amber)" stroke-width="1.5"/><text x="12" y="3" fill="var(--dim)">sell</text>
      <line x1="34" y1="0" x2="43" y2="0" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="3,2"/><text x="46" y="3" fill="var(--dim)">buy</text>
    </g>` : ""}
  </svg>`;
}

/** Rebuilds the good/marketplace <select> lists. Returns true when
 *  `priceGood` itself changed (priceGoods just arrived) so the caller
 *  knows to fetch. Ported from Tower's own renderPricePickers() (m.js). */
function renderMktPricePickers() {
  let goodChanged = false;
  const goodSel = $("mk-price-good-sel");
  if (goodSel && document.activeElement !== goodSel) {
    if (!priceGoods.includes(priceGood)) {
      const next = priceGoods[0] ?? "";
      goodChanged = next !== priceGood;
      priceGood = next;
    }
    goodSel.innerHTML = priceGoods.map((g) => `<option value="${escapeAttr(g)}"${g === priceGood ? " selected" : ""}>${escapeHtml(g)}</option>`).join("");
  }
  const wpSel = $("mk-price-wp-sel");
  if (wpSel && document.activeElement !== wpSel) {
    const waypoints = priceWaypointsByGood[priceGood] ?? [];
    if (priceWaypoint && !waypoints.includes(priceWaypoint)) priceWaypoint = "";
    wpSel.innerHTML = `<option value="">All markets</option>` + waypoints.map((wp) => `<option value="${escapeAttr(wp)}"${wp === priceWaypoint ? " selected" : ""}>${escapeHtml(wp)}</option>`).join("");
  }
  return goodChanged;
}

function renderMktPrices() {
  const goodChanged = renderMktPricePickers();
  renderMktPriceChart();
  renderMktPriceMarketList();
  if (goodChanged && priceGood) loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
}

$("mk-price-good-sel").addEventListener("change", (e) => {
  priceGood = e.target.value;
  priceWaypoint = "";
  renderMktPricePickers();
  renderMktPriceChart();
  renderMktPriceMarketList();
  if (priceGood) loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
});
$("mk-price-wp-sel").addEventListener("change", (e) => {
  priceWaypoint = e.target.value;
  loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
});
$("mk-price-timeframe-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-span]");
  if (!b) return;
  priceTimeframeMs = Number(b.dataset.span);
  $("mk-price-timeframe-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
});

function renderKeepers() {
  const countEl = $("mk-keeper-count");
  if (countEl) countEl.textContent = `${keeperStationsCfg.length} stationed · ${keeperMarketsCfg.length} listed`;
  const cover = $("mk-keeper-cover");
  if (cover) cover.setAttribute("aria-pressed", String(keeperCoverList));
  const ta = $("mk-keeper-markets");
  // Only seed the textarea when it isn't already being edited — a poll
  // landing mid-type would otherwise wipe the operator's work.
  if (ta && document.activeElement !== ta) ta.value = keeperMarketsCfg.join("\n");
  const el = $("mk-keeper-stations");
  if (!el) return;
  if (!keeperStationsCfg.length) { el.innerHTML = '<div class="empty">No keepers stationed yet.</div>'; return; }
  el.innerHTML = keeperStationsCfg.map((s) => `
    <div class="goodrow">
      <div style="flex:1">
        <div class="name">${escapeHtml(s.market)}</div>
        <div class="route">guarded by ${escapeHtml(s.shipSymbol)}</div>
      </div>
    </div>
  `).join("");
}

/** Repopulates a <select>, keeping the previous value if it's still a
 *  valid option — see renderMarkets()'s toolbar note. */
function setSelectOptions(sel, values) {
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = values.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("");
  if (values.includes(current)) sel.value = current;
}

/* ── Markets toolbars (pass B) ───────────────
 * Ported from v6.js's dispatchAssign/dispatchClear/warehouseDesignate/
 * warehouseRelease — same endpoints, same body shapes. */
$("mk-dispatch-assign").addEventListener("click", async () => {
  const ship = $("mk-dispatch-ship").value;
  const good = $("mk-dispatch-good").value;
  if (!ship || !good) return;
  const route = dispatchRoutes.find((r) => r.good === good);
  try {
    await api("POST", "/api/dispatch", {
      shipSymbol: ship, good,
      buyAt: route?.buyAt, sellAt: route?.sellAt,
      buyPrice: route?.buyPrice, sellPrice: route?.sellPrice,
      profitPerTrip: route?.profitPerTrip,
    });
    await loadDispatch();
  } catch (err) { alert(err.message); }
});

$("mk-dispatch-auto").addEventListener("click", async () => {
  const ship = $("mk-dispatch-ship").value;
  if (!ship) return;
  try {
    await api("POST", "/api/dispatch", { shipSymbol: ship, clear: true });
    await loadDispatch();
  } catch (err) { alert(err.message); }
});

/** Ported from v6.js's own miner-preference mini-form — a separate control
 *  from the trader-only Dispatch panel above it, since a miner never gets a
 *  dispatcher assignment at all. */
function renderMinerPreferences() {
  const miners = (bridge.shipStatus ?? []).filter((s) => s.role === "miner");
  const sel = $("mk-miner-pref-ship");
  if (sel) {
    const current = sel.value;
    sel.innerHTML = miners.map((s) => `<option value="${escapeAttr(s.symbol)}">${escapeHtml(s.symbol)}</option>`).join("");
    if (miners.some((m) => m.symbol === current)) sel.value = current;
  }
  const list = $("mk-miner-pref-list");
  if (!list) return;
  list.innerHTML = !(minerPreferences ?? []).length
    ? '<div class="empty">No miner preferences set — every miner surveys for whatever refines to a metal.</div>'
    : minerPreferences.map((p) => `
      <div class="goodrow">
        <div class="name">${escapeHtml(p.shipSymbol)}</div>
        <div class="route">${escapeHtml(p.good)}</div>
      </div>`).join("");
}
$("mk-miner-pref-save").addEventListener("click", async () => {
  const ship = $("mk-miner-pref-ship").value;
  const good = $("mk-miner-pref-good").value.trim().toUpperCase();
  if (!ship || !good) return;
  try {
    await api("POST", "/api/miner-preference", { shipSymbol: ship, good });
    $("mk-miner-pref-good").value = "";
    await loadDispatch();
  } catch (err) { alert(err.message); }
});
$("mk-miner-pref-clear").addEventListener("click", async () => {
  const ship = $("mk-miner-pref-ship").value;
  if (!ship) return;
  try {
    await api("POST", "/api/miner-preference", { shipSymbol: ship, clear: true });
    await loadDispatch();
  } catch (err) { alert(err.message); }
});

$("mk-keeper-save").addEventListener("click", async () => {
  const lines = $("mk-keeper-markets").value.split("\n").map((l) => l.trim().toUpperCase()).filter(Boolean);
  try {
    await api("POST", "/api/keeper/markets", { markets: lines });
    await loadKeepers();
  } catch (err) { alert(err.message); }
});

$("mk-keeper-cover").addEventListener("click", async () => {
  const next = !keeperCoverList;
  try {
    await api("POST", "/api/keeper/markets", { coverList: next });
    await loadKeepers();
  } catch (err) { alert(err.message); }
});

$("mk-keeper-reset").addEventListener("click", async () => {
  try {
    await api("POST", "/api/keeper/markets", { reset: true });
    await loadKeepers();
  } catch (err) { alert(err.message); }
});

/* ── Ops screen (pass 5) ──────────────────────
 * Contracts and construction missions, read-only display.
 */
function renderOps() {
  const chainEl = $("ops-chain");
  if (chainEl) chainEl.innerHTML = chainHealthHtml(chainHealth);
  // Contracts panel
  const contractsHtml = (() => {
    if (!contracts.length) {
      return '<div class="empty">No contracts available.</div>';
    }
    return contracts.map((c) => {
      const status = c.accepted ? "accepted" : c.declined ? "declined" : c.abandoned ? "not being worked" : "offered";
      const deliverables = (c.deliver ?? []).map((d) => {
        const pct = d.unitsRequired ? Math.round((d.unitsFulfilled / d.unitsRequired) * 100) : 0;
        return `
          <div style="display:flex;flex-direction:column;gap:4px;padding:8px 14px;border-bottom:1px solid var(--hair)">
            <div style="display:flex;gap:8px;align-items:center">
              <span style="flex:1;font-size:11px;font-weight:500">${escapeHtml(d.tradeSymbol)}</span>
              <span style="font-size:10px;color:var(--dim2)">→ ${escapeHtml(d.destinationSymbol)}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <span style="font-size:10px;color:var(--dim2)">${d.unitsFulfilled}/${d.unitsRequired}</span>
              <div class="meter"><i style="width:${pct}%"></i></div>
              <span style="font-size:10px;color:var(--dim2);min-width:30px;text-align:right">${pct}%</span>
            </div>
          </div>
        `;
      }).join("");
      const total = c.onAccepted + c.onFulfilled;
      return `
        <div style="margin-bottom:12px;border:1px solid var(--hair);border-radius:6px;overflow:hidden;background:var(--panel)">
          <div style="padding:10px 14px;border-bottom:1px solid var(--hair);display:flex;gap:8px;align-items:center">
            <span style="flex:1;font-weight:600;font-size:12px">${escapeHtml(c.type)} · ${escapeHtml(c.factionSymbol)}</span>
            <span class="chip" style="font-size:9px;padding:2px 6px">${escapeHtml(status)}</span>
          </div>
          <div style="display:flex;gap:8px;padding:8px 14px;border-bottom:1px solid var(--hair);font-size:11px;color:var(--dim2)">
            <span>+${fmt(c.onAccepted)}</span>
            <span>/</span>
            <span>+${fmt(c.onFulfilled)}</span>
          </div>
          ${deliverables}
          <div style="padding:8px 14px;font-size:10px;color:var(--dim2)">deadline ${fmtTime(c.deadline)}</div>
        </div>
      `;
    }).join("");
  })();
  const contractsEl = $("ops-contracts");
  if (contractsEl) contractsEl.innerHTML = contractsHtml;

  // Missions panel
  const missionsHtml = (() => {
    const active = (missions ?? []).filter((m) => m.status === "active");
    if (!active.length) {
      return '<div class="empty">No construction missions.</div>';
    }
    return active.map((m) => {
      const allDone = (m.materials ?? []).every((mat) => mat.fulfilled >= mat.required);
      const status = m.paused ? "paused" : allDone ? "complete" : "supplying";
      const materials = (m.materials ?? []).map((mat) => {
        const pct = mat.required ? Math.round((mat.fulfilled / mat.required) * 100) : 0;
        return `
          <div style="display:flex;flex-direction:column;gap:4px;padding:8px 14px;border-bottom:1px solid var(--hair)">
            <div style="display:flex;gap:8px;align-items:center">
              <span style="flex:1;font-size:11px;font-weight:500">${escapeHtml(mat.tradeSymbol)}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <span style="font-size:10px;color:var(--dim2)">${mat.fulfilled}/${mat.required}</span>
              <div class="meter"><i style="width:${pct}%"></i></div>
              <span style="font-size:10px;color:var(--dim2);min-width:30px;text-align:right">${pct}%</span>
            </div>
          </div>
        `;
      }).join("");
      return `
        <div style="margin-bottom:12px;border:1px solid var(--hair);border-radius:6px;overflow:hidden;background:var(--panel)">
          <div style="padding:10px 14px;border-bottom:1px solid var(--hair);display:flex;gap:8px;align-items:center">
            <span style="flex:1;font-weight:600;font-size:12px">${escapeHtml(m.targetWaypoint)}</span>
            <span class="chip" style="font-size:9px;padding:2px 6px">${escapeHtml(status)}</span>
          </div>
          <div style="padding:8px 14px;border-bottom:1px solid var(--hair);font-size:11px;color:var(--dim2)">
            ${(m.assignedShips ?? []).length ? `crew ${(m.assignedShips ?? []).length}/${m.carrierTarget ?? 1}: ${escapeHtml(m.assignedShips.join(", "))}` : "no carrier yet"}
          </div>
          ${materials}
          <div class="mission-pacing" data-wp="${escapeAttr(m.targetWaypoint)}" style="padding:10px 14px;display:flex;flex-direction:column;gap:6px">
            <div class="ops-sub" style="padding:0">Buy pacing &mdash; price depends on total units bought, so slow the rate to match the market's refill. Blank = default.</div>
            <div class="mk-toolbar" style="padding:0;align-items:flex-end">
              <label style="display:flex;flex-direction:column;gap:3px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Units per buy
                <input class="field-input mp-lot" type="number" min="1" placeholder="default" value="${m.pacing?.buyLotUnits ?? ""}" aria-label="Units per purchase" /></label>
              <label style="display:flex;flex-direction:column;gap:3px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Gap (min)
                <input class="field-input mp-gap" type="number" min="1" placeholder="none" value="${m.pacing?.buyGapMin ?? ""}" aria-label="Minutes between purchases" /></label>
              <label style="display:flex;flex-direction:column;gap:3px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Ceiling % over 24h low
                <input class="field-input mp-cap" type="number" min="1" placeholder="40" value="${m.pacing?.maxInflationPct ?? ""}" aria-label="Price ceiling percent" /></label>
              <label style="display:flex;flex-direction:column;gap:3px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em" title="Buy the next lot only once the ask is back within this % of its level before the previous lot">Recover %
                <input class="field-input mp-rec" type="number" min="1" placeholder="off" value="${m.pacing?.recoverPct ?? ""}" aria-label="Recovery percent" /></label>
              <button class="btn pri" data-mact="save-pacing">Save pacing</button>
              ${m.paused
                ? '<button class="btn" data-mact="resume">Resume</button>'
                : '<button class="btn deny" data-mact="pause">Stop</button>'}
            </div>
          </div>
        </div>
      `;
    }).join("");
  })();
  const missionsEl = $("ops-missions");
  // Don't rebuild the cards under someone who is typing into a pacing field (the programme data refreshes every 15 s).
  if (missionsEl && !missionsEl.contains(document.activeElement)) missionsEl.innerHTML = missionsHtml;

  renderAutomationFeed();
  renderNotes();
}

/* ── Mission pacing / pause / resume (Ops → Missions) ── */
$("ops-missions").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-mact]");
  if (!b) return;
  const card = b.closest(".mission-pacing");
  const wp = card?.dataset.wp;
  if (!wp) return;
  const act = b.dataset.mact;
  if (act === "pause" && !confirm(`Stop the construction mission at ${wp}? The crew will be released; you can resume later.`)) return;
  b.disabled = true;
  try {
    if (act === "save-pacing") {
      const val = (cls) => { const v = card.querySelector(cls).value.trim(); return v === "" ? null : Number(v); };
      await api("POST", "/api/missions/pacing", { waypoint: wp, buyLotUnits: val(".mp-lot"), buyGapMin: val(".mp-gap"), maxInflationPct: val(".mp-cap"), recoverPct: val(".mp-rec") });
    } else {
      await api("POST", `/api/missions/${act}`, { waypoint: wp });
    }
    await loadProgramme();
  } catch (err) { alert(err.message); }
  b.disabled = false;
  renderOps();
});

/* ── Feeder chains (Feeds) ────────────────────
 * A chain is an ordered set of feeder tiers where each tier's buy market is
 * pinned to the previous tier's own sell market, instead of each tier
 * independently re-deriving "cheapest known market" — e.g. ore→H56→F50→D40.
 * Under the hood a chain is just several Feeds sharing a chainId
 * (FeedManager.startChain()), so a chain's own tiers also show up in the
 * plain Feeder tiers panel with full crew controls — this panel is only for
 * building/toggling the chain as a whole. Ported verbatim from v6.js.
 */
function chainTierRowHtml(n, isFirst) {
  return `<div class="chain-tier-row">
    <span class="tier-n">${n}</span>
    <select class="tier-good"><option value="">Good…</option></select>
    <select class="tier-market"><option value="">Sell into…</option></select>
    <label style="display:flex;align-items:center;gap:4px;font-size:9px;color:var(--dim);white-space:nowrap"><input type="checkbox" class="tier-mine" /> mine</label>
    <span class="tier-hint">${isFirst ? "" : "buys where the tier above sold"}</span>
    <button class="btn ghost tier-remove" type="button">&times;</button>
  </div>`;
}
function renumberChainTierRows() {
  [...$("chain-tier-rows").children].forEach((row, i) => {
    row.querySelector(".tier-n").textContent = i + 1;
    row.querySelector(".tier-hint").textContent = i === 0 ? "" : "buys where the tier above sold";
  });
}

/** Good/market pickers for the Feed and Feeder-chain forms — dropdowns
 *  sourced from priceGoods/priceWaypointsByGood (see loadGoods()), not
 *  free text. Ported from v6.js: a typo'd target waypoint (a wrong
 *  system symbol, then a same-system near-miss) left a feed with 0
 *  reachable markets and a full crew never joining — restricting the
 *  picker to markets that actually exist and actually trade the chosen
 *  good makes that typo class impossible. */
function populateGoodSelect(sel) {
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Good…</option>' + priceGoods.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join("");
  if (priceGoods.includes(current)) sel.value = current;
}
function populateWaypointSelectForGood(sel, good) {
  if (!sel) return;
  const current = sel.value;
  const options = good ? (priceWaypointsByGood[good] ?? []) : [];
  sel.innerHTML = `<option value="">${good ? "Market…" : "Pick a good first…"}</option>` + options.map((wp) => `<option value="${escapeAttr(wp)}">${escapeHtml(wp)}</option>`).join("");
  if (options.includes(current)) sel.value = current;
}
function refreshFeedFormSelects() {
  populateGoodSelect($("feed-good"));
  populateWaypointSelectForGood($("feed-waypoint"), $("feed-good").value);
  [...$("chain-tier-rows").children].forEach((row) => {
    populateGoodSelect(row.querySelector(".tier-good"));
    populateWaypointSelectForGood(row.querySelector(".tier-market"), row.querySelector(".tier-good").value);
  });
}
$("feed-good").addEventListener("change", () => populateWaypointSelectForGood($("feed-waypoint"), $("feed-good").value));
$("chain-tier-rows").addEventListener("change", (e) => {
  const sel = e.target.closest("select.tier-good");
  if (!sel) return;
  populateWaypointSelectForGood(sel.closest(".chain-tier-row").querySelector(".tier-market"), sel.value);
});

function addChainTierRow() {
  const container = $("chain-tier-rows");
  container.insertAdjacentHTML("beforeend", chainTierRowHtml(container.children.length + 1, container.children.length === 0));
  const row = container.lastElementChild;
  populateGoodSelect(row.querySelector(".tier-good"));
  populateWaypointSelectForGood(row.querySelector(".tier-market"), "");
}
$("chain-add-tier").addEventListener("click", addChainTierRow);
$("chain-tier-rows").addEventListener("click", (e) => {
  const btn = e.target.closest(".tier-remove");
  if (!btn) return;
  btn.closest(".chain-tier-row").remove();
  renumberChainTierRows();
});
addChainTierRow();
addChainTierRow();

$("chain-start").addEventListener("click", async () => {
  const name = $("chain-name").value.trim();
  const rows = [...$("chain-tier-rows").children];
  const tiers = rows.map((row) => ({
    good: row.querySelector(".tier-good").value.trim().toUpperCase(),
    sellAt: row.querySelector(".tier-market").value.trim(),
    mine: row.querySelector(".tier-mine").checked,
  }));
  if (!name || tiers.length === 0 || tiers.some((t) => !t.good || !t.sellAt)) {
    alert("Enter a chain name and fill in every tier");
    return;
  }
  try {
    await api("POST", "/api/feed-chains/start", { name, tiers });
    $("chain-name").value = "";
    $("chain-tier-rows").innerHTML = "";
    addChainTierRow();
    addChainTierRow();
    loadProgramme();
  } catch (err) { alert(err.message); }
});

function renderChains() {
  const el = $("chains");
  if (!el) return;
  const items = feedChains ?? [];
  if (!items.length) { el.innerHTML = ""; return; }
  el.innerHTML = items.map((c) => {
    const off = c.tiers.every((t) => t.paused);
    const tierRows = c.tiers.map((t, i) => {
      const crew = t.assignedShips ?? [];
      const target = t.carrierTarget ?? 1;
      return `<div class="ops-row">
        <span class="ops-title">${i + 1}. ${escapeHtml(t.good)} → ${escapeHtml(t.targetWaypoint)}</span>
        <span class="fill"></span>
        <span class="ops-sub">${t.mine ? "mined" : t.buyAt ? `buy @ ${escapeHtml(shortWp(t.buyAt))}` : "buy (cheapest)"} · crew ${crew.length}/${target}</span>
      </div>`;
    }).join("");
    return `<div class="ops-card">
      <div class="ops-head">
        <span class="ops-title">${escapeHtml(c.name)}</span>
        <span class="tag ${off ? "paused" : "done"}">${off ? "off" : "on"}</span>
        <span class="fill"></span>
        <span class="ops-sub">${c.tiers.length} tier${c.tiers.length === 1 ? "" : "s"}</span>
      </div>
      ${tierRows}
      <div class="ops-head" style="margin-top:6px">
        ${off
          ? `<button class="btn pri" data-act="chain-on" data-chain="${escapeAttr(c.chainId)}">Turn on</button>`
          : `<button class="btn" data-act="chain-off" data-chain="${escapeAttr(c.chainId)}">Turn off</button>`}
        <button class="btn ghost" data-act="chain-remove" data-chain="${escapeAttr(c.chainId)}">Remove chain</button>
      </div>
    </div>`;
  }).join("");
}
$("chains").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, chain } = btn.dataset;
  try {
    if (act === "chain-on") {
      await api("POST", "/api/feed-chains/resume", { chainId: chain });
    } else if (act === "chain-off") {
      await api("POST", "/api/feed-chains/pause", { chainId: chain });
    } else if (act === "chain-remove") {
      if (!confirm("Remove this whole chain? Every tier's crew is released; this isn't just a pause.")) return;
      await api("POST", "/api/feed-chains/remove", { chainId: chain });
    }
    loadProgramme();
  } catch (err) { alert(err.message); }
});

/* ── Feeder tiers (Feeds) ─────────────────────
 * A feeder tier is a crew that continuously buys a good cheap and sells it
 * into one specific upstream market — the counter-pressure to a buyer's own
 * repeated purchasing driving that market's price up (FeedManager,
 * src/engine/feed.ts). Ported verbatim from v6.js's renderFeeds()/
 * feedStart()/onFeedClick().
 */
function renderFeeds() {
  const el = $("feeds");
  if (!el) return;
  const items = feeds ?? [];
  if (!items.length) {
    el.innerHTML = '<div class="empty">No feeder tiers. Enter the market to feed and the good, then Start feed.</div>';
    return;
  }
  const committedElsewhere = new Set([
    ...(missions ?? []).flatMap((m) => m.assignedShips ?? []),
    ...items.flatMap((f) => f.assignedShips ?? []),
  ]);
  const carrierCandidates = (fleetStatus.ships ?? []).filter((s) =>
    (s.role === "miner" || s.role === "trader") && !committedElsewhere.has(s.symbol)
  );
  el.innerHTML = items.map((f) => {
    const crew = f.assignedShips ?? [];
    const target = f.carrierTarget ?? 1;
    const options = carrierCandidates
      .concat(crew.filter((s) => !carrierCandidates.some((c) => c.symbol === s)).map((s) => ({ symbol: s })))
      .map((s) => `<option value="${escapeAttr(s.symbol)}">${escapeHtml(shortWp(s.symbol))}</option>`)
      .join("");
    const crewChips = crew.length
      ? crew.map((s) => `<span class="tag">${escapeHtml(s)} <button class="chip-x" data-act="remove-carrier" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" data-ship="${escapeAttr(s)}" aria-label="Remove ${escapeHtml(s)}">&times;</button></span>`).join(" ")
      : '<span class="ops-sub">no crew yet</span>';
    return `<div class="ops-card">
      <div class="ops-head">
        <span class="ops-title">${escapeHtml(f.good)} → ${escapeHtml(f.targetWaypoint)}</span>
        <span class="tag">${f.mine ? "mine" : f.buyAt ? `buy @ ${escapeHtml(shortWp(f.buyAt))}` : "buy"}</span>
        ${f.chainName ? `<span class="tag">chain: ${escapeHtml(f.chainName)}</span>` : ""}
        ${f.force ? `<span class="tag" title="Buying every cycle regardless of margin">forced</span>` : ""}
        <span class="tag" title="Minimum gap between sells into this market, shared across the crew">gap ${f.sellGapMs ? `${Math.round(f.sellGapMs / 60_000)}m` : "default"}</span>
        ${f.stopAtSupply ? `<span class="tag" title="Stops sourcing once the target's supply reaches this bucket">stop at ${escapeHtml(f.stopAtSupply.toLowerCase())}</span>` : ""}
        ${f.maxLossPerUnit != null ? `<span class="tag" title="Accepts paying up to this many credits per unit above what the target pays">loss ≤ ${f.maxLossPerUnit}c</span>` : ""}
        ${f.field ? `<span class="tag" title="Drones pinned to this asteroid">field ${escapeHtml(shortWp(f.field))}</span>` : ""}
        ${f.collector ? `<span class="tag" title="Shuttle that collects the drones' holds in orbit and carries them to market">collector ${escapeHtml(f.collector)}</span>` : ""}
        <span class="tag ${f.paused ? "paused" : "done"}">${f.paused ? "off" : "on"}</span>
        <span class="fill"></span>
        <span class="ops-sub">crew ${crew.length}/${target}</span>
      </div>
      <div class="ops-head" style="margin-top:6px">${crewChips}</div>
      <div class="ops-head" style="margin-top:6px">
        <select class="assign-carrier" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" aria-label="Carrier ship">
          <option value="">add ship…</option>
          ${options}
        </select>
        <button class="btn" data-act="assign" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">Add</button>
      </div>
      <div class="ops-head" style="margin-top:6px">
        <input type="number" class="carrier-target" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" min="0" value="${target}" style="width:56px" aria-label="Crew target">
        <button class="btn" data-act="set-target" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">Set crew size</button>
        <input type="number" class="sell-gap-min" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" min="0" placeholder="min" value="${f.sellGapMs ? Math.round(f.sellGapMs / 60_000) : ""}" style="width:56px" title="Minimum minutes between sells into this market (blank = default)" aria-label="Sell gap minutes">
        <button class="btn" data-act="set-sell-gap" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">Set sell gap</button>
        <span class="fill"></span>
        ${f.paused
          ? `<button class="btn pri" data-act="on" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">Turn on</button>`
          : `<button class="btn" data-act="off" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">Turn off</button>`}
        <button class="btn ghost" data-act="${f.force ? "unforce" : "force"}" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">${f.force ? "Unforce" : "Force"}</button>
        <button class="btn ghost" data-act="remove" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">Remove</button>
      </div>
      <div class="ops-head" style="margin-top:6px">
        <input type="number" class="feed-loss" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" min="0" placeholder="loss c/u" value="${f.maxLossPerUnit ?? ""}" style="width:70px" title="Accept paying up to this many credits per unit above what the target pays (blank = default margin gate)" aria-label="Max loss per unit">
        <select class="feed-stop" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" title="Stop sourcing once the target's supply reaches this bucket" aria-label="Stop at supply">
          ${["", "MODERATE", "HIGH", "ABUNDANT"].map((v) => `<option value="${v}"${(f.stopAtSupply ?? "") === v ? " selected" : ""}>${v ? `stop at ${v.toLowerCase()}` : "no stop"}</option>`).join("")}
        </select>
        <button class="btn" data-act="set-limits" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}">Set limits</button>
        ${f.mine ? `
        <input class="feed-field field-input" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" placeholder="asteroid, e.g. X1-JX83-B35" value="${escapeAttr(f.field ?? "")}" style="width:150px;padding:4px 6px" aria-label="Field">
        <select class="feed-collector" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" aria-label="Collector shuttle">
          <option value="">no collector</option>
          ${(state?.ships ?? []).filter((sh) => (sh.cargo?.capacity ?? 0) >= 20 && !(sh.mounts ?? []).some((m) => /MINING_LASER|GAS_SIPHON/.test(m.symbol))).map((sh) => `<option value="${escapeAttr(sh.symbol)}"${f.collector === sh.symbol ? " selected" : ""}>${escapeHtml(sh.symbol)} (${sh.cargo?.capacity ?? 0})</option>`).join("")}
        </select>
        <button class="btn" data-act="set-collector" data-wp="${escapeAttr(f.targetWaypoint)}" data-good="${escapeAttr(f.good)}" title="Drones stay on the field; the collector takes their holds in orbit and carries them to market">Set collector</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

async function onFeedClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, wp, good, ship } = btn.dataset;
  try {
    if (act === "assign") {
      const select = btn.closest(".ops-head").querySelector(".assign-carrier");
      const shipSymbol = select?.value;
      if (!shipSymbol) { alert("Pick a ship first"); return; }
      await api("POST", "/api/feeds/assign", { waypoint: wp, good, shipSymbol });
    } else if (act === "remove-carrier") {
      await api("POST", "/api/feeds/remove-carrier", { waypoint: wp, good, shipSymbol: ship });
    } else if (act === "set-target") {
      const input = btn.closest(".ops-head").querySelector(".carrier-target");
      const count = Number(input?.value);
      if (!Number.isFinite(count) || count < 0) { alert("Enter a valid crew size"); return; }
      await api("POST", "/api/feeds/carrier-target", { waypoint: wp, good, count });
    } else if (act === "on") {
      await api("POST", "/api/feeds/resume", { waypoint: wp, good });
    } else if (act === "off") {
      await api("POST", "/api/feeds/pause", { waypoint: wp, good });
    } else if (act === "remove") {
      if (!confirm(`Remove the feed ${good} → ${wp}? Its crew is released; this isn't just a pause.`)) return;
      await api("POST", "/api/feeds/remove", { waypoint: wp, good });
    } else if (act === "force" || act === "unforce") {
      await api("POST", "/api/feeds/force", { waypoint: wp, good, force: act === "force" });
    } else if (act === "set-limits") {
      const card = btn.closest(".ops-card");
      const loss = card.querySelector(".feed-loss").value.trim();
      const stop = card.querySelector(".feed-stop").value;
      await api("POST", "/api/feeds/limits", { waypoint: wp, good, maxLossPerUnit: loss === "" ? null : Number(loss), stopAtSupply: stop || null });
    } else if (act === "set-collector") {
      const card = btn.closest(".ops-card");
      const field = card.querySelector(".feed-field").value.trim().toUpperCase();
      const collector = card.querySelector(".feed-collector").value;
      await api("POST", "/api/feeds/collector", { waypoint: wp, good, field: field || null, collector: collector || null });
    } else if (act === "set-sell-gap") {
      const input = btn.closest(".ops-head").querySelector(".sell-gap-min");
      const sellGapMin = input?.value?.trim() ?? "";
      await api("POST", "/api/feeds/sell-gap", { waypoint: wp, good, sellGapMin: sellGapMin === "" ? null : Number(sellGapMin) });
    }
    loadProgramme();
  } catch (err) { alert(err.message); }
}
$("feeds").addEventListener("click", onFeedClick);

async function feedStart() {
  const waypoint = $("feed-waypoint").value.trim();
  const good = $("feed-good").value.trim().toUpperCase();
  const crew = Number($("feed-crew").value) || 1;
  const mine = $("feed-mine").checked;
  const force = $("feed-force").checked;
  const sellGapMinRaw = $("feed-sell-gap").value.trim();
  if (!waypoint || !good) { alert("Enter both a market waypoint and a good"); return; }
  try {
    await api("POST", "/api/feeds/start", {
      waypoint, good, carrierTarget: crew, mine, force,
      sellGapMin: sellGapMinRaw === "" ? undefined : Number(sellGapMinRaw),
    });
    $("feed-waypoint").value = ""; $("feed-good").value = ""; $("feed-crew").value = "1";
    $("feed-mine").checked = false; $("feed-force").checked = false; $("feed-sell-gap").value = "";
    loadProgramme();
  } catch (err) { alert(err.message); }
}
$("feed-start").addEventListener("click", feedStart);

/* ── Doctrine screen (pass 6) ────────────────
 * Standing orders and recent activity. Pass D wires the enable/disable
 * toggle on each standing order — ported from Tower's renderMoreDoctrine()
 * + its click handler (m.js): POST /api/doctrine { key, enabled }.
 */
function renderDoctrine() {
  // Standing Orders panel
  const standingOrdersHtml = (() => {
    if (!doctrineRules.length) {
      return '<div class="empty">No standing orders configured.</div>';
    }
    const applied = doctrineRules.filter(r => r.enabled).length;
    const headerHtml = `<div style="padding:10px 14px;border-bottom:1px solid var(--hair);display:flex;gap:8px;align-items:center">
      <span style="flex:1;font-weight:600;font-size:12px">Standing Orders</span>
      <span style="font-size:10px;color:var(--dim2)">${applied} / ${doctrineRules.length} applied</span>
    </div>`;
    const rulesHtml = doctrineRules.map((r) => {
      const enabledStatus = r.enabled ? "on" : "off";
      return `
        <div class="doc-row" data-key="${escapeAttr(r.key)}" style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:10px 14px;border-bottom:1px solid var(--hair)">
          <span style="flex:1">
            <span style="font-weight:600;font-size:12px">${escapeHtml(r.name)}</span>
            <span class="chip" style="font-size:9px;padding:2px 6px;margin-left:8px">${enabledStatus}</span>
            <div style="font-size:11px;color:var(--dim2);margin-top:4px">${r.max > 1
              ? `<input class="field-input doc-val" type="number" min="${r.min}" max="${r.max}" step="${r.step}" value="${escapeAttr(String(r.value))}" style="width:110px;padding:4px 6px" aria-label="${escapeAttr(r.name)} value" /> ${escapeHtml(r.unit ?? "")}`
              : escapeHtml(String(r.value))}</div>
          </span>
          <button class="sw" aria-pressed="${r.enabled}" aria-label="Toggle ${escapeAttr(r.name)}"><i></i></button>
        </div>
      `;
    }).join('');
    return headerHtml + rulesHtml;
  })();
  const standingOrdersEl = $("doctrine-standing-orders");
  if (standingOrdersEl) standingOrdersEl.innerHTML = standingOrdersHtml;

  // Recent Activity panel
  const recentActivityHtml = (() => {
    const notes = doctrineRules
      .map((r) => ({ r, stats: doctrineFires.get(r.key), ships: doctrineFireShips.get(r.key) ?? [] }))
      .filter((x) => x.stats && x.stats.fireCount > 0)
      .sort((a, b) => b.stats.fireCount - a.stats.fireCount)
      .slice(0, 6);

    if (!notes.length) {
      return '<div class="empty">No rules have fired yet.</div>';
    }

    const headerHtml = `<div style="padding:10px 14px;border-bottom:1px solid var(--hair);display:flex;gap:8px;align-items:center">
      <span style="flex:1;font-weight:600;font-size:12px">Recent Activity</span>
    </div>`;
    const notesHtml = notes.map(({ r, stats, ships }) => {
      const lastFired = stats.lastFired ? fmtTime(stats.lastFired) : "never";
      const shipsText = ships.length ? ships.join(", ") : "—";
      return `
        <div style="margin-bottom:12px;padding:10px 14px;border-bottom:1px solid var(--hair);last:child:border-bottom:none">
          <div style="font-weight:600;font-size:12px">${escapeHtml(r.name)}</div>
          <div style="font-size:11px;color:var(--dim2);margin-top:4px">
            Fired <b>${stats.fireCount}</b> time${stats.fireCount === 1 ? "" : "s"}, last ${lastFired}
          </div>
          <div style="font-size:10px;color:var(--dim2);margin-top:4px">Ships: ${escapeHtml(shipsText)}</div>
        </div>
      `;
    }).join('');
    return headerHtml + notesHtml;
  })();
  const recentActivityEl = $("doctrine-recent-activity");
  if (recentActivityEl) recentActivityEl.innerHTML = recentActivityHtml;
}

$("mk-yards").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-buy-ship]");
  if (!b) return;
  const label = b.textContent;
  if (!confirm(`Buy ${b.dataset.buyShip.replace(/^SHIP_/, "").replace(/_/g, " ").toLowerCase()} at ${b.dataset.yard}?`)) return;
  b.disabled = true; b.textContent = "Buying…";
  try {
    await api("POST", "/api/fleet/buy", { shipType: b.dataset.buyShip, yardSymbol: b.dataset.yard });
    await loadState();
  } catch (err) { alert(err.message); }
  b.disabled = false; b.textContent = label;
});

$("doctrine-standing-orders").addEventListener("change", async (e) => {
  const inp = e.target.closest("input.doc-val");
  if (!inp) return;
  const key = inp.closest(".doc-row").dataset.key;
  const value = Number(inp.value);
  if (!Number.isFinite(value)) return;
  inp.disabled = true;
  try {
    await api("POST", "/api/doctrine", { key, value });
    await loadDoctrine();
  } catch (err) { alert(err.message); await loadDoctrine(); }
  renderDoctrine();
});

$("doctrine-standing-orders").addEventListener("click", async (e) => {
  const sw = e.target.closest("button.sw");
  if (!sw) return;
  const key = sw.closest(".doc-row").dataset.key;
  const enabled = sw.getAttribute("aria-pressed") !== "true";
  sw.disabled = true;
  try {
    await api("POST", "/api/doctrine", { key, enabled });
    await loadDoctrine();
  } catch (err) { alert(err.message); await loadDoctrine(); }
  renderDoctrine();
});

/* ── Map screen (pass 4) ────────────────────
 * System chips, 2D waypoint scatter, market detail panel, leaderboard.
 */
let selectedMapSystem = null;
let selectedMapWaypoint = null;
let selectedMapShip = null;

function renderMap() {
  const rows = fleetRows();

  // Determine systems: home system + all systems where fleet has ships
  const homeSystem = state?.agent?.headquarters?.slice(0, state.agent.headquarters.lastIndexOf("-")) ?? "Unknown";
  const fleetSystems = new Set([homeSystem]);
  for (const row of rows) {
    if (row.at) {
      const lastDash = row.at.lastIndexOf("-");
      if (lastDash > 0) {
        fleetSystems.add(row.at.slice(0, lastDash));
      }
    }
  }
  const sysArray = Array.from(fleetSystems).sort();

  // Default to home system if not yet selected
  if (!selectedMapSystem || !sysArray.includes(selectedMapSystem)) {
    selectedMapSystem = homeSystem;
    selectedMapWaypoint = null;
  }

  // Render chip row
  const chipHTML = sysArray.map((sys) =>
    `<div class="syschip${selectedMapSystem === sys ? " on" : ""}" data-sys="${escapeAttr(sys)}">${escapeHtml(sys)}</div>`
  ).join("");
  $("map-chiprow").innerHTML = chipHTML;

  // Wire chip clicks
  $("map-chiprow").querySelectorAll(".syschip").forEach((chip) => {
    chip.addEventListener("click", () => {
      selectedMapSystem = chip.dataset.sys;
      selectedMapWaypoint = null;
      selectedMapShip = null;
      setDeckMapSelectedShip(null);
      renderMap();
    });
  });

  // The 3D map (deck-map.js) owns the chart, legend and camera; this screen
  // only tells it which system to show and listens for clicks.
  if (getDeckMapSystem() !== selectedMapSystem) setDeckMapSystem(selectedMapSystem);
  else renderDeckMap();
  renderMapLegend();

  // Render detail panel
  renderMapDetail();

  // Render leaderboard
  renderMapLeaderboard();

  // Galaxy data (pass C) — Factions + System Agents, ported from v6.js.
  renderFactions();
  renderSystemAgents();
}

/** Factions list — ported from v6.js's renderFactions(). */
function renderFactions() {
  const el = $("map-factions");
  if (!el) return;
  const countEl = $("map-factions-count");
  if (countEl) countEl.textContent = `${factions.length} factions`;
  if (!factions.length) { el.innerHTML = '<div class="empty">No faction data yet.</div>'; return; }
  el.innerHTML = factions.map((f) => `
    <div style="padding:6px 0;border-bottom:1px solid rgba(255,199,120,.06)">
      <div style="font-family:var(--mono);color:var(--bone)">
        ${escapeHtml(f.name)} <span style="color:var(--dim2)">(${escapeHtml(f.symbol)})</span>${f.isRecruiting ? ' <span style="color:var(--green)">· recruiting</span>' : ""}
      </div>
      <div style="font-size:10px;color:var(--dim);margin-top:2px">${escapeHtml(f.description)}</div>
      <div style="font-size:10px;color:var(--dim2);margin-top:2px">${(f.traits ?? []).map((t) => escapeHtml(t.name)).join(", ")}</div>
    </div>
  `).join("");
}

/** Other agents headquartered in this tenant's home system, with the
 *  running credits tally behind the current snapshot — ported from
 *  v6.js's renderSystemAgents(). `systemAgentsHistory` is the durable
 *  per-hour series (agent_credit_snapshots); a delta is only shown when
 *  there are 2+ points, since a single point is not a trend. */
function renderSystemAgents() {
  const el = $("map-system-agents");
  if (!el) return;
  const countEl = $("map-agents-count");
  if (countEl) countEl.textContent = systemAgents.length ? `${systemAgents.length} agents` : "—";
  if (!systemAgents.length) {
    el.innerHTML = '<div class="empty">No agent data yet — the background galaxy crawl hasn\'t completed its first pass.</div>';
    return;
  }
  const mySymbol = state?.agent?.symbol;
  const byAgent = new Map();
  for (const h of systemAgentsHistory ?? []) {
    if (!byAgent.has(h.agentSymbol)) byAgent.set(h.agentSymbol, []);
    byAgent.get(h.agentSymbol).push(h);
  }
  el.innerHTML = systemAgents.map((a) => {
    const points = byAgent.get(a.symbol) ?? [];
    const first = points[0];
    const delta = first && points.length > 1 ? a.credits - first.credits : null;
    const deltaHtml = delta == null ? "" : ` <span style="color:${delta > 0 ? "var(--green)" : delta < 0 ? "var(--red)" : "var(--dim)"}">${signed(delta)}c since ${fmtTime(first.timestamp)}</span>`;
    return `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,199,120,.06)">
        <span style="font-family:var(--mono)">${escapeHtml(a.symbol)}${a.symbol === mySymbol ? ' <span style="color:var(--amber)">· you</span>' : ""}</span>
        <span style="text-align:right">${a.shipCount}${a.shipCount === 1 ? " ship" : " ships"} · ${fmt(a.credits)}c${deltaHtml}</span>
      </div>
    `;
  }).join("");
}

/** Static key for the 3D map's glyph vocabulary (v6's own legend, Deck-styled). */
function renderMapLegend() {
  $("map-legend").innerHTML = `
    <span><i style="background:var(--ice)"></i>Planet</span>
    <span><i class="sw-station" style="background:var(--bone)"></i>Station</span>
    <span><i class="sw-asteroid" style="background:var(--dim2)"></i>Asteroid</span>
    <span><i class="sw-gate"></i>Gate</span>
    <span><i class="sw-ship"></i>Ship</span>`;
}

/** Side-panel card for a ship clicked on the map, with a way into the Fleet screen. */
function renderMapShipCard() {
  const el = $("map-market-detail");
  const row = fleetRows().find((r) => r.symbol === selectedMapShip);
  if (!row) return false;
  el.innerHTML = `
    <div class="detail-row"><span class="shipsym">${escapeHtml(row.symbol)}</span><span class="chip ${escapeHtml(row.role)}">${escapeHtml(row.role)}</span></div>
    <div class="detail-row"><span>Job</span><span>${escapeHtml(row.job)}</span></div>
    <div class="detail-row"><span>Status</span><span>${escapeHtml(row.goal)}</span></div>
    <div class="detail-row"><span>Fuel</span><span class="mono">${row.fuelCap ? Math.round((row.fuel / row.fuelCap) * 100) : 0}%</span></div>
    <div class="detail-row"><span>Cargo</span><span class="mono">${row.cargo}/${row.cargoCap}</span></div>
    <div class="detail-row"><span>At</span><span class="mono">${escapeHtml(row.at)}</span></div>
    <div class="detail-row"><span>ETA</span><span class="mono">${escapeHtml(fmtEta(row.eta))}${fmTag(row.flightMode)}</span></div>
    <div style="padding:10px 14px"><button class="btn" id="map-open-fleet">Open in Fleet</button></div>`;
  $("map-open-fleet").addEventListener("click", () => {
    selectedFleetShip = row.symbol;
    selectedFleetSystem = "All systems";
    setView("fleet");
  });
  return true;
}

initDeckMap({
  onShip: (symbol) => {
    selectedMapShip = symbol;
    selectedMapWaypoint = null;
    setDeckMapSelectedShip(symbol);
    renderMapDetail();
  },
  onWaypoint: (symbol) => {
    selectedMapWaypoint = symbol;
    selectedMapShip = null;
    setDeckMapSelectedShip(null);
    renderMapDetail();
  },
  onSystemChange: (symbol) => {
    selectedMapSystem = symbol;
    selectedMapWaypoint = null;
    selectedMapShip = null;
    renderMap();
  },
});

function renderMapDetail() {
  const el = $("map-market-detail");
  if (selectedMapShip && renderMapShipCard()) return;
  if (!selectedMapWaypoint) {
    el.innerHTML = '<div class="empty">Click a waypoint to see its market.</div>';
    return;
  }

  const snapshots = marketSnapshots.filter((s) => s.waypointSymbol === selectedMapWaypoint);
  if (!snapshots.length) {
    el.innerHTML = '<div class="empty">No market data for this waypoint yet.</div>';
    return;
  }

  const html = snapshots.map((s) => `
    <div class="goodrow">
      <div style="flex:1">
        <div class="name">${escapeHtml(s.goodSymbol)}</div>
      </div>
      <div style="display:flex;gap:8px;color:var(--dim);font-size:10px">
        <span>buy ${s.purchasePrice}c</span>
        <span>sell ${s.sellPrice}c</span>
      </div>
    </div>
  `).join("");
  el.innerHTML = html;
}

function renderMapLeaderboard() {
  const el = $("map-leaderboard");
  if (!leaderboard.length) {
    el.innerHTML = '<div style="color:var(--dim2);font-size:11px">No leaderboard data yet.</div>';
    return;
  }

  const sorted = [...leaderboard].sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0));
  const top3 = sorted.slice(0, 3);
  const mySymbol = state?.agent?.symbol;

  const html = top3.map((a, i) => {
    const isMe = a.agentSymbol === mySymbol;
    return `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,199,120,.06);font-size:10px${isMe ? ";color:var(--accent)" : ""}">
        <span>${escapeHtml(a.agentSymbol)}${isMe ? " · you" : ""}</span>
        <span class="mono">${fmt(a.credits)}c</span>
      </div>
    `;
  }).join("");
  el.innerHTML = html;
}

/* ── subscriptions ──────────────────────────
 * Wire render functions to data slices.
 */
subscribe("state", () => {
  renderTopbar();
  renderKPIs();
  renderMinimap();
  renderWantsDoing();
  renderFleet();
  renderMarkets();
  if (!$("view-map").hidden) renderMap();
});
subscribe("bridge", () => {
  renderTopbar();
  renderKPIs();
  if (!$("view-ops").hidden) renderAutomationFeed();
});
subscribe("approvals", () => {
  renderApprovals();
  renderTopbar();
});
subscribe("dispatch", () => {
  renderKPIs();
  renderFleet();
  renderMarkets();
});
subscribe("goods", () => {
  renderMarkets();
});
subscribe("keepers", () => {
  renderKeepers();
  if (!$("view-markets").hidden) renderMktPriceMarketList();
});
subscribe("prices", () => {
  if (!$("view-markets").hidden) renderMktPrices();
  refreshFeedFormSelects();
});
subscribe("activity", () => {
  renderActivity();
});
subscribe("galaxy", () => {
  if (!$("view-map").hidden) renderMap();
  if (!$("view-map").hidden) renderMapDetail();
  if (!$("view-map").hidden) renderMapLeaderboard();
  if (!$("view-map").hidden) renderFactions();
  if (!$("view-map").hidden) renderSystemAgents();
});
subscribe("programme", () => {
  // Feed/mission claims decide what the Fleet table and Overview call "unassigned" (jobFor), so
  // they must refresh on every programme load, not only while Ops/Feeds is open.
  renderKPIs();
  renderFleet();
  renderWantsDoing();
  if (!$("view-ops").hidden) renderOps();
  if (!$("view-feeds").hidden) { renderFeeds(); renderChains(); }
});
subscribe("doctrine", () => {
  if (!$("view-doctrine").hidden) renderDoctrine();
});
subscribe("notes", () => {
  if (!$("view-ops").hidden) renderNotes();
});
subscribeConnection(() => {
  renderTopbar();
});

/* ── boot ──────────────────────────────────
 * Same 15s polling as Tower/v6.
 */
function boot() {
  loadState();
  loadBridge();
  loadApprovals();
  loadDispatch();
  loadActivity();
  loadMarkets();
  loadGoods();
  loadKeepers();
  loadProgramme();
  renderTopbar();
  renderKPIs();
  renderMinimap();
  renderWantsDoing();
  renderFleet();
  renderMarkets();
  renderApprovals();
  renderActivity();
}

function pollTick() {
  loadState();
  loadBridge();
  loadApprovals();
  loadDispatch();
  loadActivity();
  loadMarkets();
  loadGoods();
  loadKeepers();
  loadProgramme();
}

setInterval(() => {
  if (!authed || document.hidden) return;
  pollTick();
}, 15_000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !authed) return;
  pollTick();
});

/* ── Command palette (⌘K) ───────────────────
 * Jump to a rail section or a ship by symbol. No actions beyond
 * navigation this pass — see docs' own "what happens after" notes on
 * every prior spec doc, which all named this as the final scoped piece.
 */
const CMDK_SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "fleet", label: "Fleet" },
  { key: "markets", label: "Markets" },
  { key: "map", label: "Map" },
  { key: "ops", label: "Ops" },
  { key: "doctrine", label: "Doctrine" },
];
let cmdkSelected = 0;

function cmdkItems(query) {
  const q = query.trim().toLowerCase();
  const adminOn = document.getElementById("rail-admin")?.hidden === false;
  const sections = [...CMDK_SECTIONS, ...(adminOn ? [{ key: "admin", label: "Admin" }] : [])]
    .filter((s) => !q || s.label.toLowerCase().includes(q) || s.key.includes(q))
    .map((s) => ({ tag: "section", label: s.label, run: () => setView(s.key) }));
  const ships = (state?.ships ?? [])
    .filter((s) => !q || s.symbol.toLowerCase().includes(q))
    .slice(0, 8)
    .map((s) => ({
      tag: "ship",
      label: s.symbol,
      run: () => {
        selectedFleetShip = s.symbol;
        selectedFleetSystem = "All systems";
        setView("fleet");
      },
    }));
  return [...sections, ...ships];
}

function renderCmdk() {
  const items = cmdkItems($("cmdk-input").value);
  cmdkSelected = Math.min(cmdkSelected, Math.max(items.length - 1, 0));
  const el = $("cmdk-list");
  if (!items.length) {
    el.innerHTML = '<div class="cpempty">No matches.</div>';
    return;
  }
  el.innerHTML = items.map((it, i) => `
    <div class="cpitem${i === cmdkSelected ? " sel" : ""}" data-i="${i}">
      <span class="tag">${escapeHtml(it.tag)}</span>
      <span class="lbl">${escapeHtml(it.label)}</span>
    </div>`).join("");
  el.querySelectorAll(".cpitem").forEach((row) => {
    row.addEventListener("click", () => { items[Number(row.dataset.i)].run(); closeCmdk(); });
  });
}

function openCmdk() {
  cmdkSelected = 0;
  $("cmdk-input").value = "";
  $("cmdk-overlay").hidden = false;
  renderCmdk();
  $("cmdk-input").focus();
}

function closeCmdk() {
  $("cmdk-overlay").hidden = true;
}

$("cmdk-trigger").addEventListener("click", openCmdk);

$("cmdk-input").addEventListener("input", () => { cmdkSelected = 0; renderCmdk(); });

$("cmdk-input").addEventListener("keydown", (e) => {
  const items = cmdkItems($("cmdk-input").value);
  if (e.key === "ArrowDown") { e.preventDefault(); cmdkSelected = Math.min(cmdkSelected + 1, items.length - 1); renderCmdk(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); cmdkSelected = Math.max(cmdkSelected - 1, 0); renderCmdk(); }
  else if (e.key === "Enter") { e.preventDefault(); const it = items[cmdkSelected]; if (it) { it.run(); closeCmdk(); } }
  else if (e.key === "Escape") { e.preventDefault(); closeCmdk(); }
});

$("cmdk-overlay").addEventListener("click", (e) => { if (e.target === $("cmdk-overlay")) closeCmdk(); });

document.addEventListener("keydown", (e) => {
  if (!authed) return;
  const isK = e.key === "k" || e.key === "K";
  if (isK && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if ($("cmdk-overlay").hidden) openCmdk(); else closeCmdk();
  }
});

(async function boot0() {
  if (new URLSearchParams(window.location.search).get("login") === "1") {
    window.history.replaceState({}, "", window.location.pathname);
    return showAuthGate();
  }
  const session = await probeSession();
  if (!session.authenticated) return showAuthGate();
  hideAuthGate();
  if (session.operator) enableAdmin($("rail-admin"));
  boot();
})();
