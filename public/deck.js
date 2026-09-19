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
  connectionStatus,
  subscribe, subscribeConnection, loadState, loadBridge, loadApprovals, loadDispatch, loadActivity,
  loadMarkets, loadGoods, loadWarehouse,
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

/* ── subscriptions ──────────────────────────
 * Wire render functions to data slices.
 */
subscribe("state", () => {
  renderTopbar();
  renderKPIs();
  renderMinimap();
  renderWantsDoing();
  renderFleet();
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
