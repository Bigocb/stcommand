/**
 * Blocked goods: trade goods the fleet will not buy for margin trading (src/engine/blockedGoods.ts). One module for Deck
 * (Settings › Doctrine) and Tower (More › Doctrine).
 *
 *   const b = mountBlockedGoods(rootEl, { api });
 *   b.show();   // reads the list
 *
 * Data: GET /api/ops/blocked_goods; changes: POST /api/blocked-goods { good, reason?, remove? }. Blocking only stops new buys: cargo
 * already aboard is still sold by the usual rules, a pinned route and contracts are untouched.
 */
import { escapeHtml } from "/shared/domain.js";

const h = (s) => escapeHtml(String(s ?? ""));

export function mountBlockedGoods(root, { api } = {}) {
  let list = [];
  let error = "";
  root.innerHTML = `<div class="bg-note">Goods the fleet will not buy for margin trading. Cargo already aboard is still sold by the usual rules; a hand-pinned route and contracts are not affected.</div>
    <div class="bg-form"><input id="bg-good" class="field-input" placeholder="TRADE_SYMBOL e.g. VIRAL_AGENTS" autocapitalize="characters" spellcheck="false" aria-label="Trade symbol to block" />
    <input id="bg-reason" class="field-input" placeholder="why (optional)" aria-label="Reason" />
    <button class="btn pri" id="bg-add">Block</button></div>
    <div class="bg-err" id="bg-err"></div><div id="bg-list"></div>`;
  const $ = (id) => root.querySelector(`#${id}`);

  async function load() {
    try { list = (await api("GET", "/api/ops/blocked_goods")).blocked ?? []; error = ""; } catch (e) { error = e.message || String(e); }
    render();
  }
  async function change(body) {
    try { await api("POST", "/api/blocked-goods", body); error = ""; } catch (e) { error = e.message || String(e); }
    await load();
  }
  function render() {
    $("bg-err").textContent = error;
    $("bg-list").innerHTML = list.length
      ? list.map((e) => `<div class="bg-row"><span class="bg-good">${h(e.good)}</span><span class="bg-why">${h(e.reason ?? "")}</span><button class="btn" data-unblock="${h(e.good)}">Unblock</button></div>`).join("")
      : `<div class="empty">Nothing blocked.</div>`;
  }
  $("bg-add").addEventListener("click", () => {
    const good = $("bg-good").value.trim();
    if (!good) return;
    $("bg-good").value = ""; const reason = $("bg-reason").value; $("bg-reason").value = "";
    change({ good, reason });
  });
  $("bg-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-unblock]");
    if (b) change({ good: b.dataset.unblock, remove: true });
  });
  return { show: load };
}
