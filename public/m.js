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
  state, bridge, fleetStatus, approvals, dispatchAssignments,
  subscribe, loadState, loadBridge, loadApprovals, loadDispatch,
} from "/shared/store.js";
import { fmt, signed, escapeHtml, countdown } from "/shared/domain.js";

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
 * Fleet/Map/Markets/More exist as real tab targets so the shell reads as
 * complete, but only render an inert placeholder until their own pass —
 * see docs/mobile-app-design.md's "What this pass does not do".
 */
function setTab(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.dataset.screen === name));
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
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

subscribe("state", () => { renderTiles(); renderTriage(); });
subscribe("bridge", () => { renderTiles(); renderTriage(); });
subscribe("dispatch", () => { renderTiles(); renderTriage(); });
subscribe("approvals", () => { renderTiles(); renderTriage(); });

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
  renderStatusbar();
}
setInterval(() => {
  if (!authed || document.hidden) return;
  loadState(); loadBridge(); loadApprovals(); loadDispatch();
}, 15_000);

(async function boot0() {
  const session = await probeSession();
  if (!session.authenticated) return showAuthGate();
  hideAuthGate();
  boot();
})();
