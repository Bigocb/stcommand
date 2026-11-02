/**
 * Spaced routes: per-route trip spacing (src/engine/tripSpacing.ts). One module for Deck (Settings › Doctrine) and Tower
 * (More › Rules), the same pattern as blockedGoods.js.
 *
 *   const s = mountSpacedRoutes(rootEl, { api });
 *   s.show();   // reads the rules and what the automatic trigger holds
 *
 * Data: GET /api/route-spacing; changes: POST /api/route-spacing { action: "add" | "remove", good, buyAt?, gapMin?, reason? }.
 * A spaced route may not start a new buying trip until `gap` minutes after the last one started at that buy market, whichever
 * ship it is. Needs the buyMarketSpacingMin clause switched on (the master switch and default gap).
 */
import { escapeHtml } from "/shared/domain.js";

const h = (s) => escapeHtml(String(s ?? ""));

export function mountSpacedRoutes(root, { api } = {}) {
  let view = { enabled: false, defaultGapMin: 0, autoPct: 0, rules: [], auto: [] };
  let error = "";
  root.innerHTML = `<div class="bg-note">Routes where a new buying trip waits for a gap after the last one started, so our own buying does not wear the price down. Leave the market empty to cover the good everywhere. The engine also spaces a route by itself while its ask stands well above our lowest recent buy.</div>
    <div class="bg-note" id="sp-state"></div>
    <div class="bg-form"><input id="sp-good" class="field-input" placeholder="TRADE_SYMBOL e.g. CLOTHING" autocapitalize="characters" spellcheck="false" aria-label="Trade symbol to space" />
    <input id="sp-at" class="field-input" placeholder="buy market (optional) e.g. X1-UZ49-K88" autocapitalize="characters" spellcheck="false" aria-label="Buy market" />
    <input id="sp-gap" class="field-input" placeholder="gap, min (optional)" inputmode="numeric" aria-label="Gap in minutes" />
    <input id="sp-reason" class="field-input" placeholder="why (optional)" aria-label="Reason" />
    <button class="btn pri" id="sp-add">Space</button></div>
    <div class="bg-err" id="sp-err"></div><div id="sp-list"></div><div id="sp-auto"></div>`;
  const $ = (id) => root.querySelector(`#${id}`);

  async function load() {
    try { view = await api("GET", "/api/route-spacing"); error = ""; } catch (e) { error = e.message || String(e); }
    render();
  }
  async function change(body) {
    try { view = await api("POST", "/api/route-spacing", body); error = ""; } catch (e) { error = e.message || String(e); }
    render();
  }
  function render() {
    $("sp-err").textContent = error;
    $("sp-state").textContent = view.enabled
      ? `Spacing is on: default gap ${view.defaultGapMin} min${view.autoPct ? `, automatic trigger at ${view.autoPct}% above our lowest recent buy` : ", automatic trigger off"}.`
      : "Spacing is off (the buyMarketSpacingMin clause is disabled), so no rule acts yet.";
    const rules = view.rules ?? [];
    $("sp-list").innerHTML = rules.length
      ? rules.map((r) => `<div class="bg-row"><span class="bg-good">${h(r.good)}</span><span class="bg-why">${h(r.buyAt ?? "every market")} · gap ${h(r.gapMin ?? view.defaultGapMin)} min${r.reason ? ` · ${h(r.reason)}` : ""}</span><button class="btn" data-unspace="${h(r.good)}" data-at="${h(r.buyAt ?? "")}">Remove</button></div>`).join("")
      : `<div class="empty">No rules.</div>`;
    const auto = view.auto ?? [];
    $("sp-auto").innerHTML = auto.length
      ? `<div class="bg-note">Held by the automatic trigger now:</div>` + auto.map((a) => `<div class="bg-row"><span class="bg-good">${h(a.good)}</span><span class="bg-why">${h(a.buyAt)} · ask ${h(a.ask)} is ${h(a.driftPct)}% above our lowest recent buy</span></div>`).join("")
      : "";
  }
  $("sp-add").addEventListener("click", () => {
    const good = $("sp-good").value.trim();
    if (!good) return;
    const body = { action: "add", good, buyAt: $("sp-at").value.trim() || undefined, gapMin: $("sp-gap").value.trim() || undefined, reason: $("sp-reason").value.trim() || undefined };
    for (const id of ["sp-good", "sp-at", "sp-gap", "sp-reason"]) $(id).value = "";
    change(body);
  });
  $("sp-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-unspace]");
    if (b) change({ action: "remove", good: b.dataset.unspace, buyAt: b.dataset.at || undefined });
  });
  return { show: load };
}
