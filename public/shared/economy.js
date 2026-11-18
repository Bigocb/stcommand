/**
 * The Economy card and the buy-ship warning sheet, shared by Tower (/m) and Deck (/deck).
 *
 * The card reads GET /api/ops/economy_health (src/engine/economyHealth.ts) and lists its findings worst first, or a green
 * "nothing to flag". The buy sheet reads GET /api/fleet/buy/preflight (src/engine/buyAdvice.ts) before every buy and, when
 * there are warnings, asks "Buy anyway" or "Cancel". Both are advisory: nothing here changes the fleet by itself.
 *
 * Each app keeps its own look: the card uses classes both stylesheets define (.econ-*), the sheet is a fixed overlay styled in
 * m.css and deck.css with each app's own palette.
 */
import { escapeHtml } from "/shared/domain.js";

const LEVEL_WORD = { bad: "Bad", warn: "Warning" };

/** The card's inner HTML for an economy_health report (or null while loading, or an Error). */
export function economyCardHtml(report) {
  if (report instanceof Error) return `<div class="econ-empty">${escapeHtml(report.message || String(report))}</div>`;
  if (!report) return `<div class="econ-empty">Loading…</div>`;
  if (report.on === false) return `<div class="econ-empty">Economy alerts are off (doctrine economyAlerts).</div>`;
  const list = report.findings ?? [];
  if (!list.length) return `<div class="econ-ok"><span class="econ-dot"></span>Nothing to flag.</div>`;
  return list.map((f) => `
    <div class="econ-item ${f.level === "bad" ? "bad" : "warn"}">
      <div class="econ-row1"><span class="econ-sev">${LEVEL_WORD[f.level] ?? escapeHtml(f.level)}</span></div>
      <div class="econ-line">${escapeHtml(f.line)}</div>
      ${f.suggestion ? `<div class="econ-sugg" title="${escapeHtml(f.suggestion.why ?? "")}">Try: <code>${escapeHtml(f.suggestion.action)}</code></div>` : ""}
    </div>`).join("");
}

/** Count for a header badge: how many findings, and whether any is bad. */
export function economyCount(report) {
  const list = report && !(report instanceof Error) ? report.findings ?? [] : [];
  return { n: list.length, bad: list.some((f) => f.level === "bad") };
}

/**
 * Load the report into `el` now and every `everyMs` while `visible()` says so. Returns a function that reloads at once.
 * `onReport` (optional) gets each report, for a badge.
 */
export function mountEconomy(el, api, { everyMs = 60_000, visible = () => true, onReport } = {}) {
  let last = null;
  let at = 0;
  const load = async (force = false) => {
    if (!el || (!force && (!visible() || Date.now() - at < everyMs))) return;
    at = Date.now();
    try { last = await api("GET", "/api/ops/economy_health"); } catch (err) { last = err instanceof Error ? err : new Error(String(err)); }
    el.innerHTML = economyCardHtml(last);
    onReport?.(last);
  };
  el.innerHTML = economyCardHtml(last);
  load(true);
  const timer = setInterval(() => load(false), Math.min(everyMs, 30_000));
  const reload = () => load(true);
  reload.stop = () => clearInterval(timer);
  return reload;
}

/** The warnings sheet: resolves true for "Buy anyway", false for "Cancel" (or a tap outside). */
export function confirmBuySheet({ title, warnings, notes = [] }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "econ-confirm";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.innerHTML = `
      <div class="econ-confirm-box">
        <div class="econ-confirm-h">${escapeHtml(title)}</div>
        <div class="econ-confirm-sub">This buy breaks ${warnings.length === 1 ? "a cash rule" : `${warnings.length} cash rules`}. It is your call.</div>
        <ul class="econ-confirm-list">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
        ${notes.length ? `<div class="econ-confirm-notes">${notes.map((n) => `<div>${escapeHtml(n)}</div>`).join("")}</div>` : ""}
        <div class="econ-confirm-actions">
          <button class="btn" data-econ="cancel">Cancel</button>
          <button class="btn deny" data-econ="buy">Buy anyway</button>
        </div>
      </div>`;
    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    wrap.addEventListener("click", (e) => {
      const b = e.target.closest?.("[data-econ]");
      if (b) return done(b.dataset.econ === "buy");
      if (e.target === wrap) done(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    wrap.querySelector("[data-econ='cancel']")?.focus();
  });
}

const hullName = (type) => String(type).replace(/^SHIP_/, "").replace(/_/g, " ").toLowerCase();

/**
 * Ask the preflight, and when it warns, the operator. Resolves true when the buy should go ahead. A preflight that fails
 * (server down, old server) does not stop the buy: the warning is advice, never a gate. `confirmPlain` (optional) is the app's
 * own plain confirm for a buy with no warnings; omit it to buy straight away.
 */
export async function preflightBuy(api, shipType, yardSymbol, { confirmPlain } = {}) {
  let p = null;
  try {
    p = await api("GET", `/api/fleet/buy/preflight?shipType=${encodeURIComponent(shipType)}&yardSymbol=${encodeURIComponent(yardSymbol)}`);
  } catch (_) {
    p = null;
  }
  const warnings = p?.warnings ?? [];
  if (warnings.length) return confirmBuySheet({ title: `Buy ${hullName(shipType)} at ${yardSymbol}?`, warnings, notes: p?.notes ?? [] });
  return confirmPlain ? confirmPlain(`Buy ${hullName(shipType)} at ${yardSymbol}?`) : true;
}
