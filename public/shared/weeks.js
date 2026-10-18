/**
 * Insights > Weeks (Deck): every finished week, newest first, with what it ended on: final cash, wallet change, matched trading net, ships, trades, and (click a row)
 * roles, top ships and goods, spend and the standing orders in force. Not the Season screen: that is the plan and its reports, this is the record. Rows are written just
 * before each reset (run_results); your own agent's, or every agent's for an operator.
 */
import { scoreboardHtml, bindScoreboard } from "/shared/admin.js";
import { escapeHtml } from "/shared/domain.js";

export function mountWeeks(root, { api }) {
  root.innerHTML = '<div class="panel"><div class="panel-h"><span class="dot"></span><span class="title">Past weeks</span><span class="count" id="wk-count"></span></div><div class="panel-b adm-body" id="wk-body"></div></div>';
  const body = root.querySelector("#wk-body"), count = root.querySelector("#wk-count");
  let token = 0;
  async function load() {
    const t = ++token;
    let d;
    try { d = await api("GET", "/api/run-results?limit=50"); } catch (e) { if (t === token) body.innerHTML = `<div class="adm-empty">${escapeHtml(e.message || "Could not load the weeks.")}</div>`; return; }
    if (t !== token) return;
    const rows = d.rows ?? [];
    count.textContent = `${rows.length} week${rows.length === 1 ? "" : "s"}${d.operator ? " · all agents" : d.agent ? " · " + escapeHtml(d.agent) : ""}`;
    if (!rows.length) { body.innerHTML = '<div class="adm-empty">No finished weeks for this agent yet. A row is written for each agent just before a reset.</div>'; return; }
    body.innerHTML = scoreboardHtml(rows);
    bindScoreboard(body);
  }
  return { show() { load(); }, hide() { token++; } };
}
