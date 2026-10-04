/**
 * Deck — Admin (operator-only). One page, one tab at a time — no stacked
 * sections. Auth is the normal tenant session plus the server's OPERATOR_AGENTS
 * flag (src/http/operatorFlag.ts); the Admin rail item only appears when
 * /api/gate/session says `operator: true`, and every call goes to
 * /api/operator/* (admin handlers) or /api/ops/* (the read-only ops tools),
 * both of which the server gates again. Nothing here is a security boundary.
 */
import { api } from "/shared/api.js";
import { escapeHtml } from "/shared/domain.js";

const $ = (id) => document.getElementById(id);
const TABS = ["reset", "scoreboard", "timeline", "health", "tenants"];
const TAB_LABEL = { reset: "Reset", scoreboard: "Scoreboard", timeline: "Timeline", health: "Health", tenants: "Tenants" };

let tab = "reset";
let refreshTimer;
let renderToken = 0; // drops a slow response that arrives after the tab changed
const timelineFilters = { ship: "", hours: "24", kinds: "" };

const n = (v) => (v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString());
const signedN = (v) => (v === null || v === undefined ? "—" : `${Number(v) >= 0 ? "+" : "−"}${Math.abs(Number(v)).toLocaleString()}`);
const cls = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

function untilText(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

const body = () => $("adm-body");
const err = (e) => `<div class="adm-err">${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
const kv = (k, v) => `<div class="adm-kv"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`;
const badge = (text, kind) => `<span class="adm-badge ${kind}">${escapeHtml(text)}</span>`;

/* ── Reset ─────────────────────────────── */
async function renderReset() {
  const t = ++renderToken;
  let d;
  try { d = await api("GET", "/api/operator/reset-watch"); } catch (e) { if (t === renderToken) body().innerHTML = err(e); return; }
  if (t !== renderToken) return;
  const w = d.watcher;
  const stateKind = !w ? "dim" : w.state === "recovered" || w.state === "idle" ? "ok" : w.state === "error" || w.state === "needs_account_token" ? "bad" : "warn";
  const tenants = w?.tenants ? Object.entries(w.tenants) : [];
  body().innerHTML = `
    <div class="adm-grid2">
      <div class="adm-card">
        <h3>Server reset</h3>
        ${kv("Watcher", w ? badge(w.state, stateKind) : badge("not running", "bad"))}
        ${kv("Next scheduled reset", w?.nextReset ? `${escapeHtml(when(w.nextReset))} <em>(in ${untilText(w.nextReset)})</em>` : "—")}
        ${kv("Game resetDate", escapeHtml(w?.apiResetDate ?? "—"))}
        ${kv("Last handled", escapeHtml(w?.handledResetDate ?? "—"))}
        ${kv("This universe (history tag)", escapeHtml(d.universe ?? "—"))}
        ${kv("Last check", escapeHtml(when(w?.checkedAt)))}
      </div>
      <div class="adm-card">
        <h3>Recovery setup</h3>
        ${kv("Account token", d.accountTokenConfigured ? badge("set", "ok") : badge("missing — cannot register", "bad"))}
        ${kv("Auto-recovery", d.recoveryEnabled ? badge("on", "ok") : badge("off (detect only)", "warn"))}
        ${w?.lastError ? kv("Last error", `<span class="down">${escapeHtml(w.lastError)}</span>`) : ""}
        <div class="adm-note">On a reset the server saves each agent's week to the scoreboard, clears the old
        universe's data, registers a fresh agent with the same name, swaps in the new token and boots it.
        Set <code>AUTO_RESET_RECOVERY=off</code> to make it report only.</div>
      </div>
    </div>
    <div class="adm-card" style="margin-top:12px">
      <h3>Per-agent progress</h3>
      ${tenants.length ? tenants.map(([a, s]) => kv(a, escapeHtml(s))).join("") : '<div class="adm-empty">Nothing in progress — no reset is being handled.</div>'}
    </div>`;
}

/* ── Scoreboard ────────────────────────── */
function scoreDetail(r) {
  const roles = Object.entries(r.ships_by_role ?? {}).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(" · ") || "—";
  const ships = (r.top_ships ?? []).map((s) => `${escapeHtml(s.ship)} ${signedN(s.pnl)}`).join("<br>") || "—";
  const goods = (r.top_goods ?? []).map((g) => `${escapeHtml(g.good)} ${signedN(g.pnl)}`).join("<br>") || "—";
  const doc = Object.entries(r.doctrine ?? {}).filter(([, v]) => v.enabled).map(([k, v]) => `${escapeHtml(k)}=${v.value}`).join(" · ") || "—";
  return `<div class="adm-detail">
    <div><b>Roles</b><br>${roles}</div>
    <div><b>Top ships</b><br>${ships}</div>
    <div><b>Top goods</b><br>${goods}</div>
    <div><b>Spend</b><br>ships ${n(r.ship_spend)}<br>fuel ${n(r.fuel_cost)}<br>jumps ${n(r.jump_cost)} (${n(r.jumps)})</div>
    <div class="wide"><b>Standing orders in force</b><br>${doc}</div>
  </div>`;
}

async function renderScoreboard() {
  const t = ++renderToken;
  let d;
  try { d = await api("GET", "/api/operator/run-results?limit=50"); } catch (e) { if (t === renderToken) body().innerHTML = err(e); return; }
  if (t !== renderToken) return;
  const rows = d.rows ?? [];
  $("adm-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) { body().innerHTML = '<div class="adm-empty">No weeks recorded yet. A row is written for each agent just before a reset.</div>'; return; }
  body().innerHTML = `<table class="adm-table"><thead><tr>
      <th>Week</th><th>Agent</th><th class="r">Final cash</th><th class="r">Wallet Δ</th><th class="r">Trading net</th><th class="r">Ships</th><th class="r">Trades</th><th class="r">Ops</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="adm-row" data-i="${i}">
      <td>${escapeHtml(r.reset_date)} ${r.capture_kind === "manual" ? badge("mid-week", "warn") : ""}</td>
      <td>${escapeHtml(r.agent_symbol)}</td>
      <td class="r">${n(r.final_credits)}</td>
      <td class="r ${cls(r.wallet_delta)}">${signedN(r.wallet_delta)}</td>
      <td class="r ${cls(r.trading_net)}">${signedN(r.trading_net)}</td>
      <td class="r">${n(r.ship_count)}</td><td class="r">${n(r.trades)}</td><td class="r">${n(r.operator_actions)}</td></tr>
      <tr class="adm-expand" data-i="${i}" hidden><td colspan="8">${scoreDetail(r)}</td></tr>`).join("")}
    </tbody></table>`;
  body().querySelectorAll("tr.adm-row").forEach((tr) => tr.addEventListener("click", () => {
    const ex = body().querySelector(`tr.adm-expand[data-i="${tr.dataset.i}"]`);
    ex.hidden = !ex.hidden;
  }));
}

/* ── Timeline ──────────────────────────── */
const KIND_GROUPS = {
  "": "All",
  "role_change,mcp_role_change": "Roles",
  "ship_purchased,manual_buy,mcp_buy": "Purchases",
  "approval_requested,approval_decided": "Approvals",
};

function sparkline(samples) {
  const pts = samples.filter((s) => s.credits !== null && s.credits !== undefined).map((s) => ({ t: new Date(s.ts).getTime(), v: Number(s.credits) }));
  if (pts.length < 2) return '<div class="adm-empty">Not enough samples for a curve yet (one is taken every 15 minutes).</div>';
  const W = 760, H = 120, P = 6;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vmax = Math.max(...pts.map((p) => p.v)), vmin = Math.min(...pts.map((p) => p.v));
  const x = (t) => P + ((t - t0) / Math.max(t1 - t0, 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - vmin) / Math.max(vmax - vmin, 1)) * (H - 2 * P);
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" class="adm-spark" preserveAspectRatio="none" role="img" aria-label="Credits over time">
      <polyline fill="none" stroke="var(--amber)" stroke-width="1.6" vector-effect="non-scaling-stroke" points="${line}"/></svg>
    <div class="adm-spark-axis"><span>${escapeHtml(when(pts[0].t))} · ${n(pts[0].v)}</span><span>${escapeHtml(when(pts[pts.length - 1].t))} · ${n(pts[pts.length - 1].v)}</span></div>`;
}

async function renderTimeline() {
  const t = ++renderToken;
  const f = timelineFilters;
  const q = new URLSearchParams({ samples: "true", limit: "300" });
  if (f.ship) q.set("ship", f.ship.trim());
  if (f.hours) q.set("sinceHours", f.hours);
  if (f.kinds) q.set("kinds", f.kinds);
  let d;
  try { d = await api("GET", `/api/operator/timeline?${q}`); } catch (e) { if (t === renderToken) body().innerHTML = err(e); return; }
  if (t !== renderToken) return;
  const ev = [...(d.events ?? [])].reverse();
  $("adm-count").textContent = `${ev.length} event${ev.length === 1 ? "" : "s"}${d.agent ? ` · ${d.agent}` : ""}`;
  body().innerHTML = `
    <div class="adm-toolbar">
      <input id="tl-ship" class="field-input" placeholder="ship, e.g. THEO-3" value="${escapeHtml(f.ship)}">
      <select id="tl-hours" class="field-select">
        ${[["6", "6 hours"], ["24", "24 hours"], ["72", "3 days"], ["", "All time"]].map(([v, l]) => `<option value="${v}"${f.hours === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
      <select id="tl-kinds" class="field-select">
        ${Object.entries(KIND_GROUPS).map(([v, l]) => `<option value="${v}"${f.kinds === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
      <button class="btn" id="tl-go">Refresh</button>
    </div>
    <div class="adm-card">${sparkline(d.samples ?? [])}</div>
    <table class="adm-table"><thead><tr><th>Time</th><th>Source</th><th>Kind</th><th>Ship</th><th>What</th></tr></thead><tbody>
      ${ev.length ? ev.map((e) => `<tr><td>${escapeHtml(when(e.ts))}</td><td>${badge(e.source === "operator" ? "you" : "engine", e.source === "operator" ? "warn" : "dim")}</td><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.ship ?? "")}</td><td>${escapeHtml(e.detail)}</td></tr>`).join("") : '<tr><td colspan="5" class="adm-empty">No events in this window.</td></tr>'}
    </tbody></table>`;
  const apply = () => {
    f.ship = $("tl-ship").value;
    f.hours = $("tl-hours").value;
    f.kinds = $("tl-kinds").value;
    renderTimeline();
  };
  $("tl-go").addEventListener("click", apply);
  $("tl-hours").addEventListener("change", apply);
  $("tl-kinds").addEventListener("change", apply);
  $("tl-ship").addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
}

/* ── Health ────────────────────────────── */
async function renderHealth() {
  const t = ++renderToken;
  const [stuck, inst, keep] = await Promise.allSettled([
    api("GET", "/api/ops/stuck"), api("GET", "/api/ops/instances"), api("GET", "/api/ops/keepers"),
  ]);
  if (t !== renderToken) return;
  const card = (title, res, fn) => `<div class="adm-card"><h3>${title}</h3>${res.status === "fulfilled" ? fn(res.value) : err(res.reason)}</div>`;
  body().innerHTML = `<div class="adm-grid3">
    ${card("Stuck ships", stuck, (d) => {
      const c = d.counts ?? {};
      return `${kv("Ships", n(d.ships))}${kv("Critical / warn / info", `<span class="down">${c.crit ?? 0}</span> / <span class="warn">${c.warn ?? 0}</span> / ${c.info ?? 0}`)}
        ${(d.findings ?? []).slice(0, 8).map((f) => `<div class="adm-find ${escapeHtml(f.severity)}"><b>${escapeHtml(f.ship)}</b> ${escapeHtml(f.kind)}<br><small>${escapeHtml(f.detail)}</small></div>`).join("") || '<div class="adm-empty">Nothing looks wrong.</div>'}`;
    })}
    ${card("Instances & rate limit", inst, (d) => `${kv("Alive now", `${d.aliveCount}${d.overlap ? " " + badge("overlap", "bad") : ""}`)}
        ${kv("This instance up", `${n(d.uptimeMin)} min`)}${kv("429s (last minute)", n(d.rateLimit?.hits60s))}
        <small class="adm-note">More than one alive instance means a deploy overlap — the usual cause of a rate-limit burst.</small>`)}
    ${card("Keeper coverage", keep, (d) => {
      const c = d.counts ?? {};
      return `${kv("Covered", `<span class="up">${c.covered ?? 0}</span>`)}${kv("En route", n(c.enroute ?? 0))}${kv("Pending", n(c.pending ?? 0))}
        ${(d.duplicates ?? []).length ? kv("Duplicate keepers", badge(String(d.duplicates.length), "warn")) : ""}
        ${(d.uncoveredPriority ?? []).length ? kv("Uncovered priority", badge(String(d.uncoveredPriority.length), "bad")) : ""}`;
    })}
  </div>`;
}

/* ── Tenants ───────────────────────────── */
async function renderTenants() {
  const t = ++renderToken;
  let d;
  try { d = await api("GET", "/api/operator/tenants"); } catch (e) { if (t === renderToken) body().innerHTML = err(e); return; }
  if (t !== renderToken) return;
  const list = d.tenants ?? [];
  $("adm-count").textContent = `${list.length} tenant${list.length === 1 ? "" : "s"}`;
  body().innerHTML = `
    <table class="adm-table"><thead><tr><th>Agent</th><th>Last seen</th><th>Engine</th><th>Play profile</th><th></th></tr></thead><tbody>
    ${list.map((x) => `<tr>
      <td>${escapeHtml(x.agentSymbol)}${x.deadTokenReason ? " " + badge("reset-invalidated token", "bad") : ""}</td>
      <td>${escapeHtml(when(x.lastSeenAt))}</td>
      <td>${x.running ? badge("running", "ok") : badge("not booted", "dim")}</td>
      <td><input class="field-input adm-profile" data-id="${x.id}" value="${escapeHtml(x.playProfile ?? "")}" placeholder="e.g. baseline"></td>
      <td class="r"><button class="btn adm-sm" data-act="view" data-id="${x.id}">View as</button>
        <button class="btn deny adm-sm" data-act="delete" data-id="${x.id}" data-agent="${escapeHtml(x.agentSymbol)}">Delete</button></td></tr>`).join("")}
    </tbody></table>
    <div class="adm-card" style="margin-top:12px">
      <h3>Manual post-reset cleanup</h3>
      <div class="adm-note">Only needed if automatic recovery could not run. Clears stale game data for the checked tenants and the shared galaxy tables.
      Uncheck a tenant that is already flying in the new universe.</div>
      ${list.map((x) => `<label class="adm-check"><input type="checkbox" class="adm-keep" data-id="${x.id}" ${x.deadTokenReason ? "" : "checked"}> keep ${escapeHtml(x.agentSymbol)}'s data</label>`).join("")}
      <button class="btn deny" id="adm-cleanup">Clean up unchecked tenants + shared galaxy data</button>
      <div id="adm-cleanup-result" class="adm-note"></div>
    </div>`;
  body().querySelectorAll(".adm-profile").forEach((inp) => inp.addEventListener("change", async () => {
    try { await api("PATCH", `/api/operator/tenants/${inp.dataset.id}/profile`, { profile: inp.value.trim() || null }); inp.classList.add("saved"); }
    catch (e) { inp.value = ""; alert(e.message); }
  }));
  body().querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async () => {
    try {
      if (b.dataset.act === "view") {
        await api("POST", `/api/operator/tenants/${b.dataset.id}/impersonate`);
        window.location.reload();
      } else if (confirm(`Permanently delete ${b.dataset.agent} and ALL its data?`)) {
        await api("DELETE", `/api/operator/tenants/${b.dataset.id}`);
        renderTenants();
      }
    } catch (e) { alert(e.message); }
  }));
  $("adm-cleanup").addEventListener("click", async () => {
    const keep = [...body().querySelectorAll(".adm-keep")].filter((c) => c.checked).map((c) => c.dataset.id);
    if (!confirm("Wipe stale game data for every UNCHECKED tenant and the shared galaxy tables?")) return;
    try {
      const r = await api("POST", "/api/operator/reset-cleanup", { keepTenantIds: keep });
      $("adm-cleanup-result").textContent = `Cleared ${r.tenantsWiped.length} tenant(s); kept ${r.tenantsKept.length}.`;
    } catch (e) { $("adm-cleanup-result").textContent = e.message; }
  });
}

/* ── shell ─────────────────────────────── */
const RENDERERS = { reset: renderReset, scoreboard: renderScoreboard, timeline: renderTimeline, health: renderHealth, tenants: renderTenants };

function paintSeg() {
  $("adm-seg").innerHTML = TABS.map((k) => `<button data-tab="${k}"${k === tab ? ' class="on"' : ""}>${TAB_LABEL[k]}</button>`).join("");
}

function show(name) {
  tab = name;
  $("adm-count").textContent = "";
  paintSeg();
  clearInterval(refreshTimer);
  RENDERERS[tab]();
  // Status-type tabs stay live; list tabs refresh on demand so typing/expanding isn't clobbered.
  if (tab === "reset" || tab === "health") refreshTimer = setInterval(() => { if (!document.hidden) RENDERERS[tab](); }, 10_000);
}

/** Called by deck.js when the session says this agent is an operator. */
export function enableAdmin() {
  $("rail-admin").hidden = false;
  $("adm-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) show(b.dataset.tab);
  });
}

/** Called by deck.js each time the Admin view is opened. */
export function openAdmin() {
  show(tab);
}

/** Called by deck.js when leaving the Admin view, so it stops polling. */
export function closeAdmin() {
  clearInterval(refreshTimer);
}
