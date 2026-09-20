/**
 * Deck — desktop redesign. Overview (pass 1), Fleet (pass 2), and Markets (pass 3)
 * screens. See docs/deck-desktop-design.md, docs/deck-fleet-design.md, and
 * docs/deck-markets-design.md for build specs. All data comes through the same
 * shared/*.js store every other UI version uses, with no new fetching layer.
 */
import { api, onUnauthorized } from "/shared/api.js";
import { login, probeSession } from "/shared/session.js";
import {
  state, bridge, fleetStatus, approvals, dispatchAssignments, activity,
  marketRoutes, intel, warehouseState,
  systems, marketSnapshots, leaderboard,
  contracts, missions,
  connectionStatus,
  subscribe, subscribeConnection, loadState, loadBridge, loadApprovals, loadDispatch, loadActivity,
  loadMarkets, loadGoods, loadWarehouse, loadGalaxy, loadProgramme,
} from "/shared/store.js";
import { fmt, signed, escapeHtml, fmtTime, shortWp } from "/shared/domain.js";

const $ = (id) => document.getElementById(id);

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
    await login(token);
    hideAuthGate();
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
  if (name === "fleet") renderFleet();
  if (name === "markets") renderMarkets();
  if (name === "map") {
    loadGalaxy();
    renderMap();
  }
  if (name === "ops") {
    loadProgramme();
    renderOps();
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
  return (state?.ships ?? []).filter(
    (s) => roleBy.get(s.symbol) === "trader" && !dispatchAssignments.some((a) => a.shipSymbol === s.symbol),
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
  const homeSystem = state?.systemSymbol;
  const systems = state?.systems ?? [];
  const currentSys = systems.find((s) => s.symbol === homeSystem);
  const waypoints = currentSys?.waypoints ?? [];
  const ships = (state?.ships ?? []).filter((s) => s.nav?.systemSymbol === homeSystem);
  const strandedSet = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));

  if (!waypoints.length) {
    $("ov-minimap").innerHTML = '<div class="empty" style="padding:20px">No waypoints charted yet.</div>';
    $("ov-map-count").textContent = "";
    return;
  }

  // Compute projection: center and scale waypoints to fit in the chart
  const xs = waypoints.map((w) => w.x);
  const ys = waypoints.map((w) => w.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const project = (w) => ({ x: 50 + ((w.x - cx) / span) * 80, y: 50 - ((w.y - cy) / span) * 80 });

  // Build HTML
  let html = "";
  for (const w of waypoints) {
    const p = project(w);
    let cls = "market";
    if (w.type === "JUMP_GATE") cls = "gate";
    else if (!(w.traits ?? []).includes("MARKETPLACE")) cls = "planet";

    html += `<div class="blip" style="top:${p.y}%;left:${p.x}%"><span class="mk ${cls}"></span></div>`;
  }

  // Add ships
  for (const s of ships) {
    const wp = waypoints.find((w) => w.symbol === s.nav?.waypointSymbol);
    if (!wp) continue;
    const p = project(wp);
    const isStranded = strandedSet.has(s.symbol);
    html += `<div class="blip" style="top:${p.y}%;left:${p.x}%"><span class="mk ship${isStranded ? "warn" : ""}"></span></div>`;
  }

  $("ov-minimap").innerHTML = html;
  $("ov-map-count").textContent = `${waypoints.length} waypoints`;
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
function jobFor(shipSymbol, role) {
  if (role !== "trader") return "—";
  const a = dispatchAssignments.find((x) => x.shipSymbol === shipSymbol);
  if (!a) return "unassigned";
  if (a.role === "direct") return `route: ${a.good}`;
  if (a.role === "contractBuy") return `contract: ${a.good}`;
  if (a.role === "haul") return `mission: ${a.good}`;
  if (a.role === "buy") return a.missionBuy ? `mission: ${a.good}` : `warehouse buy: ${a.good}`;
  if (a.role === "sell") return `warehouse sell: ${a.good}`;
  return a.good;
}

function fleetRows() {
  const ships = state?.ships ?? [];
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = (fleetStatus.ships ?? []).find((x) => x.symbol === s.symbol);
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
      job: jobFor(s.symbol, st?.role),
      stranded: strandedBy.has(s.symbol),
      fuel: s.fuel?.current ?? 0, fuelCap: s.fuel?.capacity ?? 0,
      cargo: s.cargo?.units ?? 0, cargoCap: s.cargo?.capacity ?? 0,
      goal: strandedBy.has(s.symbol) ? "stranded" : st?.paused ? "manual hold" : (s.nav?.status ?? "").replace(/_/g, " ").toLowerCase(),
      at: s.nav?.waypointSymbol ?? "",
      frame: s.frame?.symbol ?? "",
      cargoInventory: s.cargo?.inventory ?? [],
    };
  });
}

let selectedFleetShip = null;
let selectedFleetSystem = "All systems";

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

  // Render table
  const tableHTML = displayRows.map((row) => {
    const fuelPct = row.fuelCap ? Math.round((row.fuel / row.fuelCap) * 100) : 0;
    let statusClass = "";
    if (row.goal === "stranded") statusClass = "bad";
    else if (["in_transit", "docked", "orbiting"].some((s) => row.goal.includes(s))) statusClass = "good";

    return `
      <tr data-ship="${escapeAttr(row.symbol)}"${selectedFleetShip === row.symbol ? ' class="sel"' : ""}>
        <td><span class="shipsym">${escapeHtml(row.symbol)}</span></td>
        <td><span class="chip ${escapeHtml(row.role)}">${escapeHtml(row.role)}</span></td>
        <td>${escapeHtml(row.job)}</td>
        <td${statusClass ? ` class="${statusClass}"` : ""}>${escapeHtml(row.goal)}</td>
        <td class="mono">${fuelPct}%</td>
        <td class="mono">${row.cargo}/${row.cargoCap}</td>
        <td class="mono">${escapeHtml(row.at)}</td>
      </tr>
    `;
  }).join("");
  $("fleet-table-rows").innerHTML = tableHTML;

  // Wire table row clicks
  $("fleet-table").querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("click", () => {
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
      `;
      $("fleet-detail-body").innerHTML = detailBodyHTML;
    }
  } else {
    $("fleet-detail-head").innerHTML = '<div class="empty">Select a ship to see details.</div>';
    $("fleet-detail-body").innerHTML = '';
  }
}

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
      .sort((a, b) => a[0].purchasePrice - b[0].purchasePrice)
      .slice(0, 5);
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
        </div>
      `;
    }).join('');
  })();
  const yardsEl = $("mk-yards");
  if (yardsEl) yardsEl.innerHTML = yardsHtml;

  // Warehouse panel
  const whCountText = warehouseState.ship
    ? `${escapeHtml(warehouseState.ship.waypointSymbol)} · ${warehouseState.goods.length} goods`
    : `no ship designated · ${warehouseState.goods.length} goods`;
  const whCountEl = $("mk-wh-count");
  if (whCountEl) whCountEl.textContent = whCountText;

  const warehouseHtml = (() => {
    if (!warehouseState.goods.length) {
      return '<div class="empty">Warehouse is empty.</div>';
    }
    const goodsRows = warehouseState.goods.map((g) => `
      <div class="goodrow">
        <div style="flex:1">
          <div class="name">${escapeHtml(g.goodSymbol)}</div>
          <div class="route">${g.units}u</div>
        </div>
        <div class="profit">${fmt(g.value)}c</div>
      </div>
    `).join('');
    const totalRow = `
      <div class="goodrow" style="border-bottom:none;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,199,120,.06)">
        <div style="flex:1;font-weight:600">Total</div>
        <div class="profit">${fmt(warehouseState.totalValue)}cr</div>
      </div>
    `;
    return goodsRows + totalRow;
  })();
  const warehouseEl = $("mk-warehouse");
  if (warehouseEl) warehouseEl.innerHTML = warehouseHtml;

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
}

/* ── Ops screen (pass 5) ──────────────────────
 * Contracts and construction missions, read-only display.
 */
function renderOps() {
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
            ${m.assignedShip ? `carrier ${escapeHtml(m.assignedShip)}` : "no carrier yet"}
          </div>
          ${materials}
        </div>
      `;
    }).join("");
  })();
  const missionsEl = $("ops-missions");
  if (missionsEl) missionsEl.innerHTML = missionsHtml;
}

/* ── Map screen (pass 4) ────────────────────
 * System chips, 2D waypoint scatter, market detail panel, leaderboard.
 */
function normalizeCoords(waypoints) {
  const xs = waypoints.map((w) => w.x), ys = waypoints.map((w) => w.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  // 10-90% range, not 0-100%, so a waypoint at the extreme edge of the
  // system doesn't render its blip half-clipped by the chart's own border.
  return (w) => ({
    left: 10 + ((w.x - minX) / spanX) * 80,
    top: 10 + ((w.y - minY) / spanY) * 80,
  });
}

let selectedMapSystem = null;
let selectedMapWaypoint = null;

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
      renderMap();
    });
  });

  // Get waypoints for selected system
  const system = systems.find((s) => s.symbol === selectedMapSystem);
  const waypoints = system?.waypoints ?? [];

  // Render chart with blips
  const normalizer = normalizeCoords(waypoints);
  const blipsHtml = waypoints.map((wp) => {
    const coords = normalizer(wp);

    // Determine blip class
    let blipClass = "planet"; // fallback
    if (wp.type === "JUMP_GATE") {
      blipClass = "gate";
    } else if (wp.traits?.includes("MARKETPLACE")) {
      blipClass = "market";
    } else if (wp.traits?.includes("FUEL_STATION")) {
      blipClass = "fuel";
    } else if (wp.type === "ASTEROID_FIELD" || wp.type === "ENGINEERED_ASTEROID") {
      blipClass = "asteroid";
    } else if (wp.type === "ORBITAL_STATION") {
      blipClass = "station";
    }

    const shortSymbol = wp.symbol.slice(wp.symbol.lastIndexOf("-") + 1);
    return `<div class="blip ${blipClass}" style="left:${coords.left}%;top:${coords.top}%" data-wp="${escapeAttr(wp.symbol)}">
      <div class="blabel">${escapeHtml(shortSymbol)}</div>
    </div>`;
  }).join("");

  // Add ships to the chart
  const shipHtml = rows
    .filter((row) => {
      if (row.at) {
        const lastDash = row.at.lastIndexOf("-");
        if (lastDash > 0) {
          const sys = row.at.slice(0, lastDash);
          return sys === selectedMapSystem;
        }
      }
      return false;
    })
    .filter((row) => {
      // Only show docked/orbiting ships, not in transit
      const ship = (state?.ships ?? []).find((s) => s.symbol === row.symbol);
      return ship && ship.nav?.status !== "IN_TRANSIT";
    })
    .map((row) => {
      const wp = waypoints.find((w) => w.symbol === row.at);
      if (!wp) return "";
      const coords = normalizer(wp);
      const shipClass = row.stranded ? "shipwarn" : "ship";
      return `<div class="blip ${shipClass}" style="left:${coords.left}%;top:${coords.top}%"></div>`;
    })
    .join("");

  $("map-chart").innerHTML = blipsHtml + shipHtml;

  // Wire blip clicks
  $("map-chart").querySelectorAll(".blip[data-wp]").forEach((blip) => {
    blip.addEventListener("click", () => {
      selectedMapWaypoint = blip.dataset.wp;
      renderMapDetail();
    });
  });

  // Render legend (only show what's actually on the map)
  const hasGate = waypoints.some((w) => w.type === "JUMP_GATE");
  const hasMarket = waypoints.some((w) => w.traits?.some((t) => t.symbol === "MARKETPLACE"));
  const hasFuel = waypoints.some((w) => w.traits?.some((t) => t.symbol === "FUEL_STATION"));
  const hasAsteroid = waypoints.some((w) => w.type === "ASTEROID_FIELD" || w.type === "ENGINEERED_ASTEROID");
  const hasStation = waypoints.some((w) => w.type === "ORBITAL_STATION");
  const hasPlanet = waypoints.some((w) => !["JUMP_GATE", "ASTEROID_FIELD", "ENGINEERED_ASTEROID", "ORBITAL_STATION"].includes(w.type) && !w.traits?.some((t) => t.symbol === "MARKETPLACE" || t.symbol === "FUEL_STATION"));
  const hasShip = rows.some((row) => {
    if (row.at) {
      const lastDash = row.at.lastIndexOf("-");
      if (lastDash > 0) {
        const sys = row.at.slice(0, lastDash);
        return sys === selectedMapSystem;
      }
    }
    return false;
  });
  const hasStranded = rows.some((row) => row.stranded && row.at && row.at.slice(0, row.at.lastIndexOf("-")) === selectedMapSystem);

  const legendItems = [];
  if (hasPlanet) legendItems.push('<span><i style="background:var(--ice)"></i>Planet</span>');
  if (hasStation) legendItems.push('<span><i class="sw-station" style="background:var(--bone)"></i>Station</span>');
  if (hasMarket) legendItems.push('<span><i style="background:var(--ice)"></i>Market</span>');
  if (hasAsteroid) legendItems.push('<span><i class="sw-asteroid" style="background:var(--dim2)"></i>Asteroid</span>');
  if (hasFuel) legendItems.push('<span><i style="background:var(--green)"></i>Fuel</span>');
  if (hasGate) legendItems.push('<span><i class="sw-gate"></i>Gate</span>');
  if (hasShip || hasStranded) {
    if (hasStranded) {
      legendItems.push('<span><i class="sw-ship" style="border-bottom-color:var(--red)"></i>Stranded</span>');
    } else {
      legendItems.push('<span><i class="sw-ship"></i>Ship</span>');
    }
  }

  $("map-legend").innerHTML = legendItems.length ? `<div class="legend">${legendItems.join("")}</div>` : "";

  // Render detail panel
  renderMapDetail();

  // Render leaderboard
  renderMapLeaderboard();
}

function renderMapDetail() {
  const el = $("map-market-detail");
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
  if (!$("view-map").hidden) renderMap();
});
subscribe("bridge", () => {
  renderTopbar();
  renderKPIs();
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
subscribe("activity", () => {
  renderActivity();
});
subscribe("galaxy", () => {
  if (!$("view-map").hidden) renderMap();
  if (!$("view-map").hidden) renderMapDetail();
  if (!$("view-map").hidden) renderMapLeaderboard();
});
subscribe("programme", () => {
  if (!$("view-ops").hidden) renderOps();
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
  loadWarehouse();
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
  loadWarehouse();
}

setInterval(() => {
  if (!authed || document.hidden) return;
  pollTick();
}, 15_000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !authed) return;
  pollTick();
});

(async function boot0() {
  if (new URLSearchParams(window.location.search).get("login") === "1") {
    window.history.replaceState({}, "", window.location.pathname);
    return showAuthGate();
  }
  const session = await probeSession();
  if (!session.authenticated) return showAuthGate();
  hideAuthGate();
  boot();
})();
