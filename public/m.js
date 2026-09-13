/**
 * Tower — Home only, this pass. See docs/mobile-app-design.md for the
 * full IA (Fleet/Map/Markets/More follow later) and the approved visual
 * identity this file's markup/CSS implements.
 *
 * Deliberately thin: all data comes through the same shared/*.js store
 * every other UI version already uses (loadBridge/loadApprovals/
 * loadDispatch, the subscribe() reactive slices) — no new fetching layer.
 */
import { api, onUnauthorized } from "/shared/api.js";
import { login, probeSession } from "/shared/session.js";
import {
  state, bridge, fleetStatus, approvals, dispatchAssignments, dispatchRoutes, intel,
  marketRoutes, contracts, missions, warehouseState, doctrineRules,
  subscribe, loadState, loadBridge, loadApprovals, loadDispatch, loadMarkets,
  loadProgramme, loadWarehouse, loadDoctrine, setDoctrine,
} from "/shared/store.js";
import { fmt, signed, escapeHtml, countdown, shortWp, worstConditionPct, shipTransitLerp, shipHeadingDeg, roleMismatchReason } from "/shared/domain.js";

const $ = (id) => document.getElementById(id);

/* ── auth gate ─────────────────────────────
 * Deliberately scoped down from v6.js's gate: existing tenants only, no
 * register/onboarding flow — an operator setting up a brand-new agent
 * does that from desktop first. Same session-cookie mechanism underneath
 * (POST /api/gate/login), so a tenant already signed in on desktop is
 * already signed in here too — this only matters for a fresh browser/
 * private session.
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

/* ── tabs ──────────────────────────────────
 * Markets/More exist as real tab targets so the shell reads as
 * complete, but only render an inert placeholder until their own pass —
 * see docs/mobile-app-design.md's "What this pass does not do". Fleet
 * (the ship-card deck) and Map (the radar scope) are built below.
 */
function setTab(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.dataset.screen === name));
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (name === "fleet") renderDeck();
  if (name === "map") { loadMarkets(); renderScope(); }
  if (name === "markets") { loadMarkets(); renderMarkets(); }
  if (name === "more") { loadProgramme(); loadWarehouse(); loadDoctrine(); renderMore(); }
}
$("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setTab(b.dataset.tab);
});

/* ── status bar clock ── */
function renderStatusbar() {
  $("sb-time").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
setInterval(renderStatusbar, 30_000);

/* ── home: cockpit tiles ──────────────────── */
function unassignedTraders() {
  const roleBy = new Map((fleetStatus.ships ?? []).map((s) => [s.symbol, s.role]));
  return (state?.ships ?? []).filter(
    (s) => roleBy.get(s.symbol) === "trader" && !dispatchAssignments.some((a) => a.shipSymbol === s.symbol),
  );
}

function renderTiles() {
  const ships = state?.ships ?? [];
  const stranded = fleetStatus.stranded?.length ?? 0;
  const unassigned = unassignedTraders().length;
  const bestRoute = [...dispatchAssignments].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0))[0];
  const rate = bridge.rate ?? 0;

  $("home-tiles").innerHTML = `
    <div class="tile"><div class="k">Credits</div><div class="v">${fmt(state?.agent?.credits ?? bridge.credits ?? 0)}</div></div>
    <div class="tile"><div class="k">Rate</div><div class="v ${rate >= 0 ? "green" : "red"}">${signed(rate)}<span class="sub"> /hr</span></div></div>
    <div class="tile"><div class="k">Fleet</div><div class="v">${ships.length}<span class="sub"> hulls</span></div><div class="sub">${stranded} stranded · ${unassigned} unassigned</div></div>
    <div class="tile"><div class="k">Best route</div><div class="v amber">${bestRoute ? signed(bestRoute.profitPerTrip) : "—"}</div><div class="sub">${bestRoute ? escapeHtml(bestRoute.good) : "none yet"}</div></div>
  `;
  $("tb-note").textContent = stranded + unassigned + approvals.length > 0
    ? `${approvals.length + stranded + unassigned} need you`
    : "all clear";
}

/* ── home: triage feed ──────────────────────
 * Three sources, same shape every card renders from: an approval awaiting
 * a decision, a stranded ship, or a trader with no route/mission/contract
 * assignment at all (mirrors the desktop Fleet tab's Job column — see
 * jobFor() in v6.js — reduced here to just the "needs attention" case,
 * since Tower's Fleet screen, not Home, is where full per-ship job detail
 * belongs once it's built).
 */
function triageItems() {
  const items = [];
  for (const a of approvals) {
    items.push({
      kind: "approval", key: `a-${a.id}`, cls: "warn", id: a.id,
      who: a.kind, amt: a.cost != null ? `${fmt(a.cost)}c` : "",
      detail: a.detail, exp: a.expiresAt ? `auto-decides ${countdown(a.expiresAt)}` : "",
    });
  }
  for (const s of fleetStatus.stranded ?? []) {
    items.push({
      kind: "stranded", key: `s-${s.symbol}`, cls: "crit",
      who: s.symbol, amt: "Stranded",
      detail: `${s.waypointSymbol ?? "unknown position"}${s.reason ? ` · ${s.reason}` : ""}`, exp: "",
    });
  }
  for (const s of unassignedTraders()) {
    items.push({
      kind: "unassigned", key: `u-${s.symbol}`, cls: "info",
      who: s.symbol, amt: "Unassigned",
      detail: `Idle at ${s.nav?.waypointSymbol ?? "unknown"} · ready for a route`, exp: "",
    });
  }
  return items;
}

function renderTriage() {
  const items = triageItems();
  $("triage-count").textContent = items.length;
  const el = $("triage-list");
  if (!items.length) { el.innerHTML = '<div class="empty">Nothing waiting on you.</div>'; return; }
  el.innerHTML = items.map((it) => `
    <div class="card ${it.cls}">
      <div class="row1"><span class="who">${escapeHtml(it.who)}</span><span class="amt ${it.cls === "crit" ? "red" : it.cls === "warn" ? "amber" : ""}">${escapeHtml(it.amt)}</span></div>
      <div class="detail">${escapeHtml(it.detail)}</div>
      ${it.exp ? `<div class="exp">${escapeHtml(it.exp)}</div>` : ""}
      <div class="acts">
        ${it.kind === "approval"
          ? `<button class="btn pri" data-act="approve" data-id="${escapeHtml(it.id)}">Approve</button><button class="btn deny" data-act="deny" data-id="${escapeHtml(it.id)}">Deny</button>`
          : `<button class="btn ghost" disabled>Reassign — Fleet tab soon</button>`}
      </div>
    </div>`).join("");
}

$("triage-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || b.disabled) return;
  const decision = b.dataset.act === "approve" ? "approved" : "denied";
  b.disabled = true;
  try {
    await api("POST", `/api/approvals/${b.dataset.id}/decide`, { decision });
    await loadApprovals();
  } catch (err) {
    b.disabled = false;
  }
});

function fleetTabActive() {
  return document.querySelector('.screen[data-screen="fleet"]')?.classList.contains("on") ?? false;
}

subscribe("state", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderDeck(); if (mapTabActive()) renderScope(); });
subscribe("bridge", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderDeck(); });
subscribe("dispatch", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderDeck(); });
subscribe("approvals", () => { renderTiles(); renderTriage(); });

/* ── Fleet: ship-card deck ──────────────────
 * A swipeable deck (tap Prev/Next or swipe) rather than a table — the
 * approved concept for this screen (docs/mobile-app-design.md). Each
 * card's job label reuses the same TraderAssignment vocabulary as the
 * desktop Fleet tab's Job column (jobFor() in v6.js): route/contract/
 * mission/warehouse buy-sell, or "unassigned" for a trader with no
 * assignment at all — the ships worth looking at first.
 */
let fleetIndex = 0;
let sheetShip = null;
let sendFormOpen = false;
let routePickerOpen = false;
let roleFormOpen = false;
let roleFormRole = null;

const SHIP_ROLES = ["trader", "miner", "surveyor", "siphoner", "tour", "explorer", "scout", "keeper"];

function jobLabel(assignment) {
  if (!assignment) return null;
  const good = assignment.good;
  if (assignment.role === "direct") return `route: ${good}`;
  if (assignment.role === "contractBuy") return `contract: ${good}`;
  if (assignment.role === "haul") return `mission: ${good}`;
  if (assignment.role === "buy") return assignment.missionBuy ? `mission: ${good}` : `warehouse buy: ${good}`;
  if (assignment.role === "sell") return `warehouse sell: ${good}`;
  return good;
}

function fleetRows() {
  const ships = state?.ships ?? [];
  const statusBy = new Map((fleetStatus.ships ?? []).map((s) => [s.symbol, s]));
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = statusBy.get(s.symbol);
    const assignment = dispatchAssignments.find((a) => a.shipSymbol === s.symbol);
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
      manual: !!st?.paused,
      job: st?.role === "trader" ? (jobLabel(assignment) ?? "unassigned") : null,
      fuel: s.fuel?.current ?? 0, fuelCap: s.fuel?.capacity ?? 0,
      cargo: s.cargo?.units ?? 0, cargoCap: s.cargo?.capacity ?? 0,
      condition: worstConditionPct(s) ?? 100,
      waypoint: s.nav?.waypointSymbol ?? "",
      nav: s.nav?.status ?? "",
      stranded: strandedBy.has(s.symbol),
    };
  });
}

function hullCard(row, extraClass) {
  const cls = row.stranded ? " crit" : row.job === "unassigned" ? " warn" : "";
  return `
    <div class="hull ${extraClass}${extraClass === "front" ? cls : ""}">
      <div class="hd"><span class="sym">${escapeHtml(row.symbol)}</span><span class="role">${escapeHtml(row.role)}</span></div>
      ${row.job ? `<div class="job">${row.job === "unassigned" ? "unassigned" : "→ " + escapeHtml(row.job)}</div>` : ""}
      <div class="gauges">
        <div class="gauge-row"><span class="g-k">Fuel</span><div class="g-track"><div class="g-fill${row.fuelCap && row.fuel / row.fuelCap < 0.25 ? " red" : ""}" style="width:${row.fuelCap ? (row.fuel / row.fuelCap) * 100 : 0}%"></div></div><span class="g-v">${row.fuel}/${row.fuelCap}</span></div>
        <div class="gauge-row"><span class="g-k">Hold</span><div class="g-track"><div class="g-fill amber" style="width:${row.cargoCap ? (row.cargo / row.cargoCap) * 100 : 0}%"></div></div><span class="g-v">${row.cargoCap ? `${row.cargo}/${row.cargoCap}` : "—"}</span></div>
        <div class="gauge-row"><span class="g-k">Hull</span><div class="g-track"><div class="g-fill${row.condition < 50 ? " red" : ""}" style="width:${row.condition}%"></div></div><span class="g-v">${row.condition}%</span></div>
      </div>
      <div class="at">${row.stranded ? "STRANDED · " : ""}${escapeHtml(shortWp(row.waypoint))} · ${escapeHtml((row.nav || "idle").replace(/_/g, " ").toLowerCase())}</div>
    </div>`;
}

function renderDeck() {
  const rows = fleetRows();
  if (!rows.length) {
    $("deck-stack").innerHTML = '<div class="empty">No ships in the register.</div>';
    $("deck-note").textContent = "";
    $("fleet-sheet").hidden = true;
    return;
  }
  if (fleetIndex >= rows.length) fleetIndex = 0;
  $("deck-note").textContent = `hull ${fleetIndex + 1} of ${rows.length}`;

  let html = "";
  if (rows.length > 2) html += hullCard(rows[(fleetIndex + 2) % rows.length], "back2");
  if (rows.length > 1) html += hullCard(rows[(fleetIndex + 1) % rows.length], "back1");
  html += hullCard(rows[fleetIndex], "front");
  $("deck-stack").innerHTML = html;

  renderSheet(rows[fleetIndex]);
}

function renderSheet(row) {
  sheetShip = row.symbol;
  $("fleet-sheet").hidden = false;
  $("sheet-who").textContent = row.symbol;
  $("sheet-sub").textContent = `${row.role} · ${(row.nav || "idle").replace(/_/g, " ").toLowerCase()} · ${shortWp(row.waypoint)}`;

  const holdBtn = row.manual
    ? `<button class="btn" data-act="release">Release</button>`
    : `<button class="btn" data-act="hold">Hold</button>`;
  let extra = "";
  if (sendFormOpen) {
    extra += `<div class="sheet-inline-form"><input id="send-wp-input" placeholder="Waypoint, e.g. X1-A-B2" /><button class="btn pri" data-act="send-go">Go</button></div>`;
  }
  if (routePickerOpen) {
    const top = [...dispatchRoutes].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0)).slice(0, 4);
    extra += `<div class="route-pick">${
      top.length
        ? top.map((r) => `<button data-act="route-pick" data-good="${escapeHtml(r.good)}"><span>${escapeHtml(r.good)}</span><b>${signed(r.profitPerTrip)}/trip</b></button>`).join("")
        : '<div class="empty">No profitable routes right now.</div>'
    }</div>`;
  }
  if (roleFormOpen) {
    const ship = (state?.ships ?? []).find((s) => s.symbol === row.symbol);
    const currentRole = roleFormRole ?? (SHIP_ROLES.includes(row.role) ? row.role : SHIP_ROLES[0]);
    const mismatch = ship ? roleMismatchReason(currentRole, ship) : null;
    extra += `<div class="role-form">
      <div class="sheet-inline-form">
        <select class="role-select" aria-label="New role">
          ${SHIP_ROLES.map((r) => `<option value="${r}" ${r === currentRole ? "selected" : ""}>${r}</option>`).join("")}
        </select>
        <button class="btn pri" data-act="role-set">Set</button>
      </div>
      ${mismatch ? `<div class="role-warn">⚠ ${escapeHtml(mismatch)} — the ship won't be able to do this role's job</div>` : ""}
      ${currentRole === "keeper" ? `<input class="role-keeper-wp" placeholder="keeper market waypoint (skip if already there)" />` : ""}
    </div>`;
  }
  $("sheet-actions").innerHTML = `
    <button class="btn" data-act="send-toggle">Send to waypoint</button>
    ${holdBtn}
    <button class="btn" data-act="route-toggle">Assign route</button>
    <button class="btn" data-act="repair">Repair</button>
    <button class="btn deny" data-act="sell">Sell / Scrap</button>
    <button class="btn ghost full" data-act="role-toggle">${roleFormOpen ? "Close" : `Change role (${escapeHtml(row.role)})`}</button>
    ${extra}
  `;
}

$("sheet-actions").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  const ship = sheetShip;

  if (act === "send-toggle") { sendFormOpen = !sendFormOpen; routePickerOpen = false; roleFormOpen = false; return renderDeck(); }
  if (act === "route-toggle") { routePickerOpen = !routePickerOpen; sendFormOpen = false; roleFormOpen = false; return renderDeck(); }
  if (act === "role-toggle") {
    roleFormOpen = !roleFormOpen;
    roleFormRole = null;
    sendFormOpen = false;
    routePickerOpen = false;
    return renderDeck();
  }
  if (act === "role-set") {
    const role = $("sheet-actions").querySelector(".role-select")?.value;
    if (!role) return;
    const keeperMarket = $("sheet-actions").querySelector(".role-keeper-wp")?.value.trim() || undefined;
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/role", { shipSymbol: ship, role, keeperMarket });
      roleFormOpen = false;
      roleFormRole = null;
      await loadBridge();
    } catch (err) { alert(err.message); }
    return renderDeck();
  }

  if (act === "send-go") {
    const wp = $("send-wp-input")?.value.trim();
    if (!wp) return;
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/dispatch", { shipSymbol: ship, waypointSymbol: wp });
      sendFormOpen = false;
      await loadBridge();
    } catch (err) { alert(err.message); }
    return renderDeck();
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
      routePickerOpen = false;
      await loadDispatch();
    } catch (err) { alert(err.message); }
    return renderDeck();
  }
  if (act === "hold" || act === "release") {
    b.disabled = true;
    try { await api("POST", `/api/fleet/${act}`, { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderDeck();
  }
  if (act === "repair") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/repair", { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderDeck();
  }
  if (act === "sell") {
    if (!confirm(`Sell ${ship} permanently? It will fly to the nearest shipyard and be scrapped there. This cannot be undone.`)) return;
    b.disabled = true;
    try { await api("POST", "/api/fleet/sell-ship", { shipSymbol: ship }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderDeck();
  }
});

$("sheet-actions").addEventListener("change", (e) => {
  if (!e.target.classList.contains("role-select")) return;
  roleFormRole = e.target.value;
  renderDeck();
});

$("sheet-handle").addEventListener("click", () => {
  const collapsed = $("sheet-actions").hidden;
  $("sheet-actions").hidden = !collapsed;
  $("sheet-sub").hidden = !collapsed;
});

function deckStep(delta) {
  const rows = fleetRows();
  if (!rows.length) return;
  fleetIndex = (fleetIndex + delta + rows.length) % rows.length;
  sendFormOpen = false;
  routePickerOpen = false;
  roleFormOpen = false;
  roleFormRole = null;
  renderDeck();
}
$("deck-prev").addEventListener("click", () => deckStep(-1));
$("deck-next").addEventListener("click", () => deckStep(1));

// Swipe, in addition to the Prev/Next buttons — a deck should feel
// swipeable, but a tap target is the accessible/discoverable fallback.
let deckTouchStartX = null;
$("deck-stack").addEventListener("touchstart", (e) => { deckTouchStartX = e.touches[0].clientX; }, { passive: true });
$("deck-stack").addEventListener("touchend", (e) => {
  if (deckTouchStartX == null) return;
  const dx = e.changedTouches[0].clientX - deckTouchStartX;
  deckTouchStartX = null;
  if (Math.abs(dx) < 40) return;
  deckStep(dx < 0 ? 1 : -1);
});

/* ── Map: a literal radar scope ─────────────
 * See docs/mobile-app-design.md. Real waypoint x/y normalized into the
 * scope's circular field; tapping a waypoint opens a bottom sheet with
 * whatever shipyard/module intel is already known for it
 * (intel.shipyards/intel.modules, the same data desktop's Yards &
 * outfitting panel groups). Buying a ship works directly from the sheet
 * (no ship-context needed); installing a module does, so that stays
 * read-only here for now.
 *
 * Multi-system: state.systems (from GalaxyAtlas.listSystems(), the same
 * source the desktop galaxy overview reads) already carries every
 * charted system's full waypoint list — no new server endpoint needed to
 * let the operator look at a system other than home. A chip row picks
 * which one this screen is currently showing; it doesn't change which
 * system anything else in the app (Fleet, dispatch) operates on.
 */
let selectedWaypoint = null;
let scopeSystem = null;

function blipClass(wp) {
  if (wp.type === "JUMP_GATE") return "gate";
  if ((wp.traits ?? []).includes("SHIPYARD")) return "yard";
  if ((wp.traits ?? []).includes("MARKETPLACE")) return "mkt";
  return "other";
}

/** Only markets, shipyards, and jump gates are worth a blip — everything
 *  else (asteroid fields, gas giants, plain moons/planets, debris fields)
 *  is chart noise that flattens the zoom out to fit them all in.
 *  Excluding them from the *extent* calculation, not just from what's
 *  drawn, is what actually lets the scope zoom in — a scattered asteroid
 *  belt at the edge of the system was stretching every real destination
 *  into a tight cluster in the middle. */
function isChartable(wp) {
  return blipClass(wp) !== "other";
}

function chartedSystems() {
  return state?.systems ?? [];
}

function currentSystemWaypoints() {
  return chartedSystems().find((s) => s.symbol === scopeSystem)?.waypoints ?? [];
}

/** Real x/y (arbitrary system-coordinate units) centered and scaled to
 *  fit within ~80% of the scope's radius, one shared span for both axes
 *  so the layout isn't stretched. `extentWaypoints` decides the zoom
 *  level; `project()` can still place any point (e.g. a ship parked at an
 *  unlisted asteroid, or mid-transit) using that same transform. */
function computeMapProjection(extentWaypoints) {
  if (!extentWaypoints.length) return (w) => ({ x: 50, y: 50 });
  const xs = extentWaypoints.map((w) => w.x), ys = extentWaypoints.map((w) => w.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  return (w) => ({ x: 50 + ((w.x - cx) / span) * 80, y: 50 - ((w.y - cy) / span) * 80 });
}

/* ── pan/zoom ──
 * A plain CSS transform on #scope-field (translate then scale, both in
 * its own local pixel space) driven by Pointer Events — one pointer
 * pans, two pinch-zooms. Deliberately not touching the percentage-based
 * blip positions themselves: those stay in the untransformed coordinate
 * space project() already produces, so zoom/pan is purely a viewport
 * operation on top.
 */
let scopeXform = { scale: 1, tx: 0, ty: 0 };
const scopePointers = new Map();
let panBase = null;
let pinchBase = null;

function applyScopeXform() {
  $("scope-field").style.transform = `translate(${scopeXform.tx}px, ${scopeXform.ty}px) scale(${scopeXform.scale})`;
}

function resetScopeXform() {
  scopeXform = { scale: 1, tx: 0, ty: 0 };
  applyScopeXform();
}

function scopePointerDist() {
  const pts = [...scopePointers.values()];
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

$("scope-view").addEventListener("pointerdown", (e) => {
  scopePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  $("scope-view").setPointerCapture(e.pointerId);
  if (scopePointers.size === 1) {
    panBase = { x: e.clientX, y: e.clientY, tx: scopeXform.tx, ty: scopeXform.ty };
  } else if (scopePointers.size === 2) {
    panBase = null;
    pinchBase = { dist: scopePointerDist(), scale: scopeXform.scale };
  }
});
$("scope-view").addEventListener("pointermove", (e) => {
  if (!scopePointers.has(e.pointerId)) return;
  scopePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (scopePointers.size === 1 && panBase) {
    scopeXform.tx = panBase.tx + (e.clientX - panBase.x);
    scopeXform.ty = panBase.ty + (e.clientY - panBase.y);
    applyScopeXform();
  } else if (scopePointers.size === 2 && pinchBase) {
    const dist = scopePointerDist();
    if (dist > 0) {
      scopeXform.scale = Math.min(4, Math.max(1, pinchBase.scale * (dist / pinchBase.dist)));
      applyScopeXform();
    }
  }
});
function scopePointerEnd(e) {
  scopePointers.delete(e.pointerId);
  if (scopePointers.size === 1) {
    const [[, p]] = scopePointers;
    panBase = { x: p.x, y: p.y, tx: scopeXform.tx, ty: scopeXform.ty };
    pinchBase = null;
  } else {
    panBase = null;
    pinchBase = null;
  }
}
$("scope-view").addEventListener("pointerup", scopePointerEnd);
$("scope-view").addEventListener("pointercancel", scopePointerEnd);
$("scope-reset").addEventListener("click", resetScopeXform);

function renderSysPicker() {
  const systems = chartedSystems();
  const el = $("sys-picker");
  if (systems.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = systems.map((s) => `<button class="${s.symbol === scopeSystem ? "on" : ""}" data-sys="${escapeHtml(s.symbol)}">${escapeHtml(s.symbol)}${s.symbol === state?.systemSymbol ? " · home" : ""}</button>`).join("");
}
$("sys-picker").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sys]");
  if (!b) return;
  scopeSystem = b.dataset.sys;
  selectedWaypoint = null;
  $("map-sheet").hidden = true;
  resetScopeXform();
  renderScope();
});

function renderScope() {
  if (!scopeSystem) scopeSystem = state?.systemSymbol;
  const waypoints = currentSystemWaypoints();
  const chartable = waypoints.filter(isChartable);
  $("scope-hd-txt").textContent = scopeSystem ? `${scopeSystem} · ${chartable.length} charted` : "no system charted yet";
  renderSysPicker();

  const byWp = new Map(waypoints.map((w) => [w.symbol, w]));
  const project = computeMapProjection(chartable.length ? chartable : waypoints);
  // Labels always shown for a small, sparse system; suppressed by default
  // in a busy one to stop the overlapping-text pile-up a dense cluster
  // produces — zooming in (or tapping a blip) reveals them.
  const showLabels = chartable.length <= 10 || scopeXform.scale >= 1.6;
  const shipsHere = (state?.ships ?? []).filter((s) => s.nav?.systemSymbol === scopeSystem);

  let html = `<div class="ring" style="width:40%;height:40%"></div><div class="ring" style="width:65%;height:65%"></div><div class="ring" style="width:88%;height:88%"></div><div class="sweep"></div>`;
  for (const w of chartable) {
    const p = project(w);
    const sel = selectedWaypoint === w.symbol ? " sel" : "";
    const label = showLabels || sel ? `<span class="tg">${escapeHtml(shortWp(w.symbol))}</span>` : "";
    html += `<button class="blip${sel}" style="top:${p.y}%;left:${p.x}%" data-wp="${escapeHtml(w.symbol)}"><span class="mk ${blipClass(w)}"></span>${label}</button>`;
  }
  for (const s of shipsHere) {
    const inTransit = s.nav?.status === "IN_TRANSIT";
    const worldPos = inTransit ? shipTransitLerp(s) : byWp.get(s.nav.waypointSymbol);
    if (!worldPos) continue;
    const p = project(worldPos);
    const sx = (x) => project({ x, y: 0 }).x, sy = (y) => project({ x: 0, y }).y;
    const heading = inTransit ? shipHeadingDeg(s, sx, sy) : null;
    const arrow = heading != null ? ` style="transform:rotate(${heading}deg)"` : "";
    html += `<div class="blip" style="top:${p.y}%;left:${p.x}%"><span class="mk ship${heading != null ? " transit" : ""}"${arrow}></span><span class="tg">${escapeHtml(s.symbol)}</span></div>`;
  }
  $("scope-field").innerHTML = html;

  if (selectedWaypoint) renderMapSheet(selectedWaypoint);
}

function renderMapSheet(wpSymbol) {
  const wp = currentSystemWaypoints().find((w) => w.symbol === wpSymbol);
  if (!wp) { $("map-sheet").hidden = true; return; }
  $("map-sheet").hidden = false;
  const kind = blipClass(wp);
  const label = kind === "gate" ? "JUMP GATE" : kind === "yard" ? "SHIPYARD" : kind === "mkt" ? "MARKET" : wp.type;
  $("map-loc").innerHTML = `${escapeHtml(wpSymbol)}<small>${escapeHtml(label)}</small>`;

  const yards = intel.shipyards.filter((y) => y.waypointSymbol === wpSymbol);
  const mods = intel.modules.filter((m) => m.waypointSymbol === wpSymbol);
  if (!yards.length && !mods.length) {
    $("map-yards").innerHTML = '<div class="empty">No shipyard/module intel for this waypoint yet.</div>';
    return;
  }
  $("map-yards").innerHTML = [
    ...yards.map((y) => `<div class="yline"><span class="yn">${escapeHtml(y.shipTypeName)}</span><span class="yp">${fmt(y.purchasePrice)}c</span><button class="btn pri" data-buy-ship="${escapeHtml(y.shipType)}" data-yard="${escapeHtml(y.waypointSymbol)}">Buy</button></div>`),
    ...mods.map((m) => `<div class="yline"><span class="yn">${escapeHtml(m.symbol)}</span><span class="yp">${fmt(m.purchasePrice)}c</span></div>`),
  ].join("");
}

$("scope-field").addEventListener("click", (e) => {
  const b = e.target.closest("button.blip[data-wp]");
  if (!b) return;
  selectedWaypoint = b.dataset.wp;
  renderScope();
});
$("map-sheet-close").addEventListener("click", () => {
  selectedWaypoint = null;
  $("map-sheet").hidden = true;
});
$("map-yards").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-buy-ship]");
  if (!b) return;
  b.disabled = true;
  try {
    await api("POST", "/api/fleet/buy", { shipType: b.dataset.buyShip, yardSymbol: b.dataset.yard });
    await loadState();
  } catch (err) { alert(err.message); b.disabled = false; }
});

function mapTabActive() {
  return document.querySelector('.screen[data-screen="map"]')?.classList.contains("on") ?? false;
}
function marketsTabActive() {
  return document.querySelector('.screen[data-screen="markets"]')?.classList.contains("on") ?? false;
}
function moreTabActive() {
  return document.querySelector('.screen[data-screen="more"]')?.classList.contains("on") ?? false;
}
subscribe("markets", () => { if (mapTabActive()) renderScope(); if (marketsTabActive()) renderMarkets(); });

/* ── Markets: Routes / Yards segments ────────
 * Both segments are "where do I put money to make more" decisions, which
 * is why they share a tab rather than living separately (see
 * docs/mobile-app-design.md). Routes reuses the same profit-per-trip
 * computation the desktop Markets panel already shows; tapping a route
 * opens an inline ship picker rather than a separate sheet — assigning is
 * the only action this list needs.
 */
let mktSeg = "routes";
let openRouteGood = null;

function tradersFor() {
  return (fleetStatus.ships ?? []).filter((s) => s.role === "trader");
}

function renderMarketRoutes() {
  const el = $("mkt-routes");
  if (!marketRoutes.length) { el.innerHTML = '<div class="empty">No profitable routes in fresh snapshots.</div>'; return; }
  const top = [...marketRoutes].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0)).slice(0, 20);
  el.innerHTML = top.map((r) => {
    const good = r.goodSymbol;
    const assigned = dispatchAssignments.find((a) => a.role === "direct" && a.good === good);
    const picker = openRouteGood === good
      ? `<div class="ship-pick">${
          tradersFor().length
            ? tradersFor().map((s) => `<button data-act="assign-ship" data-good="${escapeHtml(good)}" data-ship="${escapeHtml(s.symbol)}"><span>${escapeHtml(s.symbol)}</span><span>${s.symbol === assigned?.shipSymbol ? "assigned" : "assign"}</span></button>`).join("")
            : '<div class="empty">No trader ships available.</div>'
        }</div>`
      : "";
    return `<div class="route-row">
      <div class="rr-top"><span class="rr-good">${escapeHtml(good)}</span><span class="rr-profit">${signed(r.profitPerTrip)}/trip</span></div>
      <div class="rr-legs">${escapeHtml(shortWp(r.buyAt))} → ${escapeHtml(shortWp(r.sellAt))} · margin ${Math.round(r.marginPct ?? 0)}%${r.crossSystem ? " · cross-system" : ""}${assigned ? ` · flying: ${escapeHtml(assigned.shipSymbol)}` : ""}</div>
      <div class="rr-actions"><button class="btn" data-act="route-toggle" data-good="${escapeHtml(good)}">${openRouteGood === good ? "Close" : "Assign a ship"}</button></div>
      ${picker}
    </div>`;
  }).join("");
}

function renderMarketYards() {
  const el = $("mkt-yards");
  const yards = intel.shipyards ?? [], mods = intel.modules ?? [];
  if (!yards.length && !mods.length) { el.innerHTML = '<div class="empty">No shipyard/module intel yet — scout systems to expand.</div>'; return; }
  let html = "";
  if (yards.length) {
    const byType = new Map();
    for (const y of yards) { if (!byType.has(y.shipType)) byType.set(y.shipType, []); byType.get(y.shipType).push(y); }
    const groups = [...byType.values()].map((rows) => rows.slice().sort((a, b) => a.purchasePrice - b.purchasePrice)).sort((a, b) => a[0].purchasePrice - b[0].purchasePrice);
    html += `<div class="sec-h">Shipyards</div>`;
    for (const rows of groups) {
      const best = rows[0];
      const others = rows.slice(1, 3);
      html += `<div class="yline">
        <span class="yn">${escapeHtml(best.shipTypeName)}<br><span class="rr-legs">${escapeHtml(shortWp(best.waypointSymbol))}${others.length ? ` · also ${others.map((o) => shortWp(o.waypointSymbol)).join(", ")}` : ""}</span></span>
        <span class="yp">${fmt(best.purchasePrice)}c</span>
        <button class="btn pri" data-buy-ship="${escapeHtml(best.shipType)}" data-yard="${escapeHtml(best.waypointSymbol)}">Buy</button>
      </div>`;
    }
  }
  if (mods.length) {
    const bySym = new Map();
    for (const m of mods) { if (!bySym.has(m.symbol)) bySym.set(m.symbol, []); bySym.get(m.symbol).push(m); }
    const groups = [...bySym.values()].map((rows) => rows.slice().sort((a, b) => a.purchasePrice - b.purchasePrice)).sort((a, b) => a[0].purchasePrice - b[0].purchasePrice);
    html += `<div class="sec-h" style="margin-top:10px">Modules & mounts</div>`;
    for (const rows of groups) {
      const best = rows[0];
      const others = rows.slice(1, 3);
      html += `<div class="yline">
        <span class="yn">${escapeHtml(best.symbol)}<br><span class="rr-legs">${escapeHtml(shortWp(best.waypointSymbol))}${others.length ? ` · also ${others.map((o) => shortWp(o.waypointSymbol)).join(", ")}` : ""}</span></span>
        <span class="yp">${fmt(best.purchasePrice)}c</span>
      </div>`;
    }
  }
  el.innerHTML = html;
}

function renderMarkets() {
  $("mkt-routes").hidden = mktSeg !== "routes";
  $("mkt-yards").hidden = mktSeg !== "yards";
  renderMarketRoutes();
  renderMarketYards();
}

$("mkt-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-seg]");
  if (!b) return;
  mktSeg = b.dataset.seg;
  $("mkt-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  renderMarkets();
});

$("mkt-routes").addEventListener("click", async (e) => {
  const toggle = e.target.closest("button[data-act='route-toggle']");
  if (toggle) { openRouteGood = openRouteGood === toggle.dataset.good ? null : toggle.dataset.good; return renderMarketRoutes(); }
  const pick = e.target.closest("button[data-act='assign-ship']");
  if (pick) {
    pick.disabled = true;
    const route = marketRoutes.find((r) => r.goodSymbol === pick.dataset.good);
    try {
      await api("POST", "/api/dispatch", {
        shipSymbol: pick.dataset.ship, good: route?.goodSymbol,
        buyAt: route?.buyAt, sellAt: route?.sellAt,
        buyPrice: route?.buyPrice, sellPrice: route?.sellPrice,
        profitPerTrip: route?.profitPerTrip,
      });
      openRouteGood = null;
      await loadDispatch();
    } catch (err) { alert(err.message); }
    renderMarketRoutes();
  }
});

$("mkt-yards").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-buy-ship]");
  if (!b) return;
  b.disabled = true;
  try { await api("POST", "/api/fleet/buy", { shipType: b.dataset.buyShip, yardSymbol: b.dataset.yard }); await loadState(); }
  catch (err) { alert(err.message); b.disabled = false; }
});

/* ── More: list-of-sections ──────────────────
 * Contracts, construction missions, warehouse, doctrine — lower-frequency
 * checks, deliberately a plain scroll of sections rather than their own
 * tabs (docs/mobile-app-design.md). Starting a brand-new construction
 * mission and full warehouse/doctrine editing stay desktop-only for now —
 * this covers the day-to-day accept/decline/toggle actions.
 */
function renderMoreContracts() {
  $("more-contract-count").textContent = contracts.length;
  const el = $("more-contracts");
  if (!contracts.length) { el.innerHTML = '<div class="empty">No contracts available.</div>'; return; }
  el.innerHTML = contracts.map((c) => {
    const total = c.onAccepted + c.onFulfilled;
    const done = (c.deliver ?? []).every((d) => d.unitsFulfilled >= d.unitsRequired);
    const delivRows = (c.deliver ?? []).map((d) => {
      const pct = d.unitsRequired ? Math.round((d.unitsFulfilled / d.unitsRequired) * 100) : 0;
      return `<div class="prog-row"><span>${escapeHtml(d.tradeSymbol)} → ${escapeHtml(shortWp(d.destinationSymbol))}</span><span class="pr-pct">${d.unitsFulfilled}/${d.unitsRequired}</span></div><div class="prog-track"><i style="width:${pct}%"></i></div>`;
    }).join("");
    return `<div class="card ${c.accepted && !done ? "info" : ""}">
      <div class="row1"><span class="who">${escapeHtml(c.type)} · ${escapeHtml(c.factionSymbol)}</span><span class="amt">${fmt(total)}c</span></div>
      ${delivRows || '<div class="detail">No deliveries listed</div>'}
      <div class="detail">${c.accepted ? `deadline ${countdown(c.deadline)}` : `accept by ${countdown(c.deadlineToAccept ?? c.deadline)}`}${c.abandoned ? " · not being worked" : ""}${c.declined ? " · declined" : ""}</div>
      <div class="acts">
        ${c.accepted
          ? (c.abandoned
              ? `<button class="btn pri" data-act="resume" data-id="${escapeHtml(c.id)}">Resume work</button>`
              : `<button class="btn deny" data-act="abandon" data-id="${escapeHtml(c.id)}">Stop working</button>`)
          : c.declined
            ? `<button class="btn" data-act="undecline" data-id="${escapeHtml(c.id)}">Allow</button><button class="btn pri" data-act="accept" data-id="${escapeHtml(c.id)}">Accept</button>`
            : `<button class="btn deny" data-act="decline" data-id="${escapeHtml(c.id)}">Decline</button><button class="btn pri" data-act="accept" data-id="${escapeHtml(c.id)}">Accept</button>`}
      </div>
    </div>`;
  }).join("");
}

function renderMoreMissions() {
  const el = $("more-missions");
  const active = missions.filter((m) => m.status === "active");
  if (!active.length) { el.innerHTML = '<div class="empty">No construction missions.</div>'; return; }
  el.innerHTML = active.map((m) => {
    const matRows = (m.materials ?? []).map((mat) => {
      const pct = mat.required ? Math.round((mat.fulfilled / mat.required) * 100) : 0;
      const done = mat.fulfilled >= mat.required;
      return `<div class="prog-row"><span>${escapeHtml(mat.tradeSymbol)}</span><span class="pr-pct">${done ? "supplied" : `${mat.fulfilled}/${mat.required}`}</span></div><div class="prog-track"><i style="width:${pct}%"></i></div>`;
    }).join("");
    const allDone = (m.materials ?? []).every((mat) => mat.fulfilled >= mat.required);
    return `<div class="card">
      <div class="row1">
        <span class="who">${escapeHtml(m.targetWaypoint)}</span>
        <span class="amt">${m.paused ? "paused" : allDone ? "complete" : "supplying"}</span>
      </div>
      ${m.assignedShip ? `<div class="detail">carrier ${escapeHtml(m.assignedShip)}</div>` : '<div class="detail">no carrier yet</div>'}
      ${matRows}
      <div class="acts">
        ${m.paused
          ? `<button class="btn pri" data-act="resume" data-wp="${escapeHtml(m.targetWaypoint)}">Resume</button>`
          : `<button class="btn deny" data-act="pause" data-wp="${escapeHtml(m.targetWaypoint)}">Stop</button>`}
      </div>
    </div>`;
  }).join("");
}

function renderMoreWarehouse() {
  const el = $("more-warehouse");
  if (!warehouseState.ship) { el.innerHTML = '<div class="empty">No warehouse ship stationed.</div>'; return; }
  const goods = warehouseState.goods ?? [];
  el.innerHTML = `
    <div class="card">
      <div class="row1"><span class="who">${escapeHtml(warehouseState.ship)}</span><span class="amt">${fmt(warehouseState.totalValue)}c</span></div>
      ${goods.length
        ? goods.slice(0, 8).map((g) => `<div class="prog-row"><span>${escapeHtml(g.goodSymbol)}</span><span class="pr-pct">${fmt(g.units)} units</span></div>`).join("")
        : '<div class="detail">No goods held.</div>'}
    </div>`;
}

function renderMoreDoctrine() {
  $("more-doctrine-count").textContent = `${doctrineRules.filter((r) => r.enabled).length} / ${doctrineRules.length} on`;
  const el = $("more-doctrine");
  if (!doctrineRules.length) { el.innerHTML = '<div class="empty">Doctrine unavailable — the fleet is still starting.</div>'; return; }
  el.innerHTML = doctrineRules.map((r) => `
    <div class="doc-row" data-key="${escapeHtml(r.key)}">
      <span class="dn">${escapeHtml(r.name)}</span>
      <span class="tag ${r.enforced ? "live" : ""}">${r.enforced ? "applied" : "not wired"}</span>
      <button class="sw" aria-pressed="${r.enabled}" aria-label="Toggle ${escapeHtml(r.name)}"><i></i></button>
    </div>`).join("");
}

function renderMore() {
  renderMoreContracts();
  renderMoreMissions();
  renderMoreWarehouse();
  renderMoreDoctrine();
}

$("mission-start-btn").addEventListener("click", async () => {
  const input = $("mission-wp-input");
  const wp = input.value.trim();
  if (!wp) return;
  const btn = $("mission-start-btn");
  btn.disabled = true;
  try {
    await api("POST", "/api/missions/start", { waypoint: wp });
    input.value = "";
    await loadProgramme();
  } catch (err) { alert(err.message); }
  btn.disabled = false;
  renderMoreMissions();
});

$("more-missions").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const { act, wp } = b.dataset;
  if (act === "pause" && !confirm(`Stop the construction mission at ${wp}? The carrier ship will be released; you can resume later.`)) return;
  b.disabled = true;
  try {
    await api("POST", `/api/missions/${act}`, { waypoint: wp });
    await loadProgramme();
  } catch (err) { alert(err.message); }
  renderMoreMissions();
});

$("more-contracts").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const { act, id } = b.dataset;
  b.disabled = true;
  try {
    if (act === "accept" || act === "decline" || act === "undecline") {
      const path = act === "accept" ? "/api/contracts/accept" : act === "decline" ? "/api/contracts/decline" : "/api/contracts/undecline";
      await api("POST", path, { contractId: id });
    } else if (act === "abandon") {
      if (!confirm("Stop working this contract? The fleet will stop buying for it and release any ship assigned to it. It cannot be handed back — the contract stays accepted and will lapse at its deadline, which costs reputation.")) { b.disabled = false; return; }
      await api("POST", "/api/contracts/abandon", { contractId: id });
    } else if (act === "resume") {
      await api("POST", "/api/contracts/resume", { contractId: id });
    }
    await loadProgramme();
  } catch (err) { alert(err.message); }
  renderMoreContracts();
});

$("more-doctrine").addEventListener("click", async (e) => {
  const sw = e.target.closest("button.sw");
  if (!sw) return;
  const key = sw.closest(".doc-row").dataset.key;
  const enabled = sw.getAttribute("aria-pressed") !== "true";
  sw.disabled = true;
  try {
    const res = await api("POST", "/api/doctrine", { key, enabled });
    setDoctrine(res.rules, undefined);
  } catch (err) { alert(err.message); loadDoctrine(); }
  renderMoreDoctrine();
});
subscribe("programme", () => { if (moreTabActive()) { renderMoreContracts(); renderMoreMissions(); } });
subscribe("warehouse", () => { if (moreTabActive()) renderMoreWarehouse(); });
subscribe("doctrine", () => { if (moreTabActive()) renderMoreDoctrine(); });

/* ── boot ──────────────────────────────────
 * Same 15s polling cadence as v6.js's tradeops/ops tabs — Home always
 * needs bridge/approvals/dispatch fresh since it's the one screen that's
 * always on, unlike a desktop tab that only polls while selected.
 */
function boot() {
  loadState();
  loadBridge();
  loadApprovals();
  loadDispatch();
  loadMarkets();
  renderStatusbar();
}
setInterval(() => {
  if (!authed || document.hidden) return;
  loadState(); loadBridge(); loadApprovals(); loadDispatch();
  if (mapTabActive() || marketsTabActive()) loadMarkets();
  if (moreTabActive()) { loadProgramme(); loadWarehouse(); }
}, 15_000);

(async function boot0() {
  const session = await probeSession();
  if (!session.authenticated) return showAuthGate();
  hideAuthGate();
  boot();
})();
