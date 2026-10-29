/**
 * Queue: the fresh-system queue and the figures around it, so the hourly update does not have to be asked for.
 * Shared by Tower (Trade > Queue). Read-only; refreshed when shown and every two minutes while it is open.
 *
 *   const c = mountQueue(rootEl, { api });
 *   c.show();   // loads and renders
 *   c.hide();
 */
import { escapeHtml } from "/shared/domain.js";
import { buildQueueView } from "/shared/queueView.js";

const h = (s) => escapeHtml(String(s ?? ""));
const compact = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const x = Number(n), a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(x));
};

export function mountQueue(root, { api, approvalCount, layout = "tables" }) {
  let view = null;
  let error = "";
  let busy = false;
  let loadedAt = 0;
  let timer = null;

  async function get(path) { try { return await api("GET", path); } catch { return undefined; } }

  async function load() {
    if (busy) return;
    busy = true; error = "";
    try {
      const [queue, keepers, review, p1, p2, p3, stuck] = await Promise.all([
        api("GET", "/api/ops/system_queue"), get("/api/ops/keepers"), get("/api/ops/keeper_review"),
        get("/api/ops/pnl?sinceHours=1"), get("/api/ops/pnl?sinceHours=2"), get("/api/ops/pnl?sinceHours=3"),
        get("/api/ops/stuck"),
      ]);
      view = buildQueueView({ queue, keepers, review, pnl: { 1: p1, 2: p2, 3: p3 }, stuck, approvals: approvalCount?.() ?? 0, nowMs: Date.now() });
      loadedAt = Date.now();
    } catch (err) {
      error = err.message || String(err);
    } finally {
      busy = false;
      render();
    }
  }

  const table = (head, body) => `<table class="qq-t"><thead><tr>${head.map((c) => `<th>${h(c)}</th>`).join("")}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="qq-none">none</td></tr>`}</tbody></table>`;
  const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;

  /* One question per card (Tower's redesign B): what opens next, how many in each state, what is live, what was last
   * released. Keepers and the hourly profit have their own tabs, so they are links here instead of repeated tables. */
  function renderCards() {
    const v = view;
    const asOf = new Date(loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const next = v.staged[0];
    const last = v.live[0];
    root.innerHTML = `
      ${v.attention.length ? `<div class="qq-card qq-warn-card"><div class="qq-q">Needs attention</div>${v.attention.map((a) => `<div class="qq-a">${h(a.item)}: ${h(a.detail)}</div>`).join("")}</div>` : ""}
      <div class="qq-card"><div class="qq-q">Next to open</div>
        ${next ? `<div class="qq-big">${h(next.system)}</div><div class="qq-a">${next.inPlace} of ${next.of} keepers in place · staged ${h(next.since)}${next.held ? " · held" : ""}</div>` : `<div class="qq-a">Nothing staged right now.</div>`}
        ${v.rule ? `<div class="qq-a qq-rule-a">Release rule: ${h(v.rule)}</div>` : ""}
      </div>
      <div class="qq-card"><div class="qq-q">Systems in each state</div>
        <div class="qq-counts"><div><b>${v.counts.live}</b><span>live</span></div><div><b>${v.counts.staged}</b><span>staged</span></div><div><b>${v.counts.scouted}</b><span>scouted</span></div></div>
        <div class="qq-a">Mode ${h(v.mode)}</div>
      </div>
      <div class="qq-card"><div class="qq-q">Last released</div>
        ${last ? `<div class="qq-big">${h(last.system)}</div><div class="qq-a">open ${h(last.age)} · ${last.sells} sells${last.ratio ? ` · ${Number(last.ratio).toFixed(2)}× the mature rate` : ""}</div>` : `<div class="qq-a">None yet.</div>`}
      </div>
      <div class="qq-card"><div class="qq-q">Live systems, newest first</div>
        ${table(["System", "Open", "Premium", "Sells"], v.live.map((s) => tr([h(s.system) + (s.held ? " 🔒" : ""), h(s.age), s.ratio ? `${Number(s.ratio).toFixed(2)}×` : "—", String(s.sells)])).join(""))}
      </div>
      <div class="qq-card"><div class="qq-q">Waiting behind the gate</div>
        ${table(["System", "Markets", "Queued"], v.scouted.slice(0, 8).map((s) => tr([h(s.system) + (s.held ? " 🔒" : ""), String(s.markets), h(s.age)])).join(""))}
        ${v.scouted.length > 8 ? `<div class="qq-a">and ${v.scouted.length - 8} more</div>` : ""}
      </div>
      <div class="qq-links">
        <button class="qq-link" data-go="expand:keepers">Keepers: ${v.keepers.rows[0]?.value ?? "—"} covered, polling ${v.keepers.polling ?? "—"} of ${v.keepers.pollingMax}/min ›</button>
        <button class="qq-link" data-go="money:hourly">Profit per hour ›</button>
        <button class="qq-refresh" data-q="refresh">↻ Refresh (${h(asOf)})</button>
      </div>`;
  }

  function render() {
    if (error) { root.innerHTML = `<div class="empty">${h(error)}</div>`; return; }
    if (!view) { root.innerHTML = `<div class="empty">Loading…</div>`; return; }
    if (layout === "cards") { renderCards(); return; }
    const v = view;
    const asOf = new Date(loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const trade = v.trade;
    root.innerHTML = `
      <div class="qq-top"><span>Mode <b>${h(v.mode)}</b> · live <b>${v.counts.live}</b> · staged <b>${v.counts.staged}</b> · scouted <b>${v.counts.scouted}</b></span><button class="qq-refresh" data-q="refresh">↻ ${h(asOf)}</button></div>
      ${v.rule ? `<div class="qq-rule">${h(v.rule)}</div>` : ""}
      <div class="qq-sub">Needs attention</div>
      ${v.attention.length ? table(["Item", "Detail"], v.attention.map((a) => tr([h(a.item), h(a.detail)])).join("")) : `<div class="qq-ok">nothing</div>`}
      <div class="qq-sub">Staged — keepers in place, gate shut</div>
      ${table(["System", "Keepers", "For"], v.staged.map((s) => tr([h(s.system) + (s.held ? " 🔒" : ""), `${s.inPlace} of ${s.of}`, h(s.since)])).join(""))}
      <div class="qq-sub">Live — released</div>
      ${table(["System", "Open for", "Premium", "Sells"], v.live.map((s) => tr([h(s.system) + (s.held ? " 🔒" : ""), h(s.age), s.ratio ? `${Number(s.ratio).toFixed(2)}×` : "—", String(s.sells)])).join(""))}
      <div class="qq-sub">Keepers</div>
      ${table(["", "Now"], v.keepers.rows.map((r) => tr([h(r.label), String(r.value)])).join(""))}
      <div class="qq-line">Polling <b>${v.keepers.polling ?? "—"}</b> of ${v.keepers.pollingMax} calls/min · ${v.keepers.stationed ?? "—"} keepers of ${v.keepers.limit ?? "—"}</div>
      <div class="qq-sub">Trading — matched profit</div>
      ${table(["Window", "Profit", "Per hour", "Sales"], trade.rows.map((r) => tr([`${r.hours} h`, compact(r.profit), compact(r.perHour), r.sales ?? "—"])).join(""))}
      ${trade.flag ? `<div class="qq-warn">Last hour is ${trade.drop}% under the 3-hour rate.</div>` : ""}
      <div class="qq-sub">Scouted — waiting behind the gate (${v.counts.scouted})</div>
      ${table(["System", "Markets", "Queued"], v.scouted.slice(0, 12).map((s) => tr([h(s.system) + (s.held ? " 🔒" : ""), String(s.markets), h(s.age)])).join(""))}
      ${v.scouted.length > 12 ? `<div class="qq-line">and ${v.scouted.length - 12} more</div>` : ""}`;
  }

  root.addEventListener("click", (e) => { if (e.target.closest?.("[data-q=refresh]")) load(); });

  return {
    show() { render(); if (Date.now() - loadedAt > 20_000) load(); clearInterval(timer); timer = setInterval(load, 120_000); },
    hide() { clearInterval(timer); timer = null; },
  };
}
