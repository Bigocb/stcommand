/**
 * Tap a chart to see it large (operator request, 2026-11-17: low vision, charts are hard to read at their normal size).
 *
 * One delegated click handler on the document, so charts that the page redraws every few seconds keep working. A tap on
 * a chart opens a full-screen view with a copy of that chart (a snapshot taken at the tap), a close button, size steps
 * (the chart gets wider and the view scrolls) and a rotate button for a phone held upright. Esc, the close button or a
 * tap on the dark backdrop closes it. It brings its own styles, so Tower, Deck and any other page can use it with one
 * import and one call, and it touches nothing else on the page.
 */

/** The charts the apps draw: the shared metrics/compare/explorer charts, the pace sparkline and the price charts. */
export const CHART_SELECTOR = [
  'svg[role="img"]', "svg.pace-spark", "svg.adm-spark",
  ".price-chart-room svg", "#mk-price-chart-room svg", ".price-chart svg",
].join(", ");

/** Width steps as a share of the screen width; the view scrolls once the chart is wider than the screen. */
export const SIZE_STEPS = [1, 1.6, 2.4, 3.4];

const STYLE_ID = "blowout-style";
const CSS = `
${CHART_SELECTOR.split(", ").map((s) => `${s}`).join(",\n")} { cursor: zoom-in; }
.blowout { position: fixed; inset: 0; z-index: 99999; background: #05070a; color: #f2ede4; display: flex; flex-direction: column; font-family: system-ui, sans-serif; }
.blowout-bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; flex: 0 0 auto; border-bottom: 1px solid rgba(255,255,255,.18); }
.blowout-title { flex: 1; min-width: 0; font-size: 22px; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
.blowout-bar button { font: inherit; font-size: 22px; font-weight: 700; min-width: 56px; min-height: 56px; padding: 0 14px; border-radius: 10px; border: 2px solid #ffc778; background: #1b1f26; color: #ffc778; cursor: pointer; }
.blowout-bar button:disabled { opacity: .35; }
.blowout-bar .blowout-x { background: #ffc778; color: #111; }
.blowout-body { flex: 1; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; padding: 14px; }
.blowout-wrap { margin: 0 auto; }
.blowout-wrap svg { width: 100%; height: auto; display: block; max-height: none; background: #11151b; border-radius: 6px; }
.blowout-wrap svg.pace-spark, .blowout-wrap svg.adm-spark { height: 45vh; }
.blowout-hint { flex: 0 0 auto; text-align: center; font-size: 16px; padding: 6px; color: #b9b3a8; }
.blowout.rot { inset: auto; top: 0; left: 100vw; width: 100vh; height: 100vw; transform-origin: top left; transform: rotate(90deg); }
`;

/** The new width of the chart view after a size step: the step's share of the screen, as a CSS percentage. */
export function stepWidth(step) {
  const i = Math.max(0, Math.min(SIZE_STEPS.length - 1, step | 0));
  return `${Math.round(SIZE_STEPS[i] * 100)}%`;
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

/** A readable title for the chart: its own label, else the nearest heading text, else "Chart". */
export function chartTitle(svg) {
  const label = svg.getAttribute("aria-label");
  if (label) return label;
  const box = svg.closest(".cmp-chart-box, .panel, .card, section");
  const h = box && box.querySelector(".cmp-chart-h, .panel-h, h2, h3, .sec-h");
  return (h && h.textContent.trim()) || "Chart";
}

let openView = null;

export function closeBlowout() {
  if (!openView) return;
  openView.remove();
  openView = null;
  document.removeEventListener("keydown", onKey, true);
}

function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); closeBlowout(); }
}

export function openBlowout(svg) {
  closeBlowout();
  const doc = svg.ownerDocument;
  ensureStyle(doc);
  const clone = svg.cloneNode(true);
  for (const a of ["width", "height", "style"]) clone.removeAttribute(a);
  const wrap = doc.createElement("div");
  wrap.className = "blowout-wrap";
  // The compare charts are styled from a `.cmp` ancestor, so the copy keeps one.
  const holder = svg.closest(".cmp") ? doc.createElement("div") : wrap;
  if (holder !== wrap) { holder.className = "cmp"; wrap.appendChild(holder); }
  holder.appendChild(clone);

  const view = doc.createElement("div");
  view.className = "blowout";
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-modal", "true");
  view.innerHTML = `<div class="blowout-bar"><div class="blowout-title"></div>
    <button type="button" data-b="smaller" aria-label="Smaller">A−</button>
    <button type="button" data-b="bigger" aria-label="Bigger">A+</button>
    <button type="button" data-b="rotate" aria-label="Rotate">⟳</button>
    <button type="button" class="blowout-x" data-b="close" aria-label="Close">✕</button></div>
    <div class="blowout-body"></div>
    <div class="blowout-hint">A+ makes it bigger (scroll to pan). ⟳ turns it sideways. Tap ✕ or the dark edge to close.</div>`;
  view.querySelector(".blowout-title").textContent = chartTitle(svg);
  view.querySelector(".blowout-body").appendChild(wrap);
  let step = 0;
  const apply = () => {
    wrap.style.width = stepWidth(step);
    view.querySelector('[data-b="smaller"]').disabled = step === 0;
    view.querySelector('[data-b="bigger"]').disabled = step === SIZE_STEPS.length - 1;
  };
  view.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-b]");
    if (b) {
      const k = b.dataset.b;
      if (k === "close") return closeBlowout();
      if (k === "bigger") step = Math.min(SIZE_STEPS.length - 1, step + 1);
      else if (k === "smaller") step = Math.max(0, step - 1);
      else if (k === "rotate") view.classList.toggle("rot");
      return apply();
    }
    if (e.target === view || e.target.classList.contains("blowout-body")) closeBlowout();
  });
  doc.body.appendChild(view);
  doc.addEventListener("keydown", onKey, true);
  openView = view;
  apply();
}

/** Turn the feature on for the page. Safe to call more than once. */
let enabled = false;
export function enableChartBlowout(doc = document) {
  if (enabled) return;
  enabled = true;
  ensureStyle(doc);
  doc.addEventListener("click", (e) => {
    if (openView && openView.contains(e.target)) return;
    const svg = e.target.closest ? e.target.closest(CHART_SELECTOR) : null;
    if (!svg) return;
    // Selecting text inside a chart should not open it.
    const sel = doc.defaultView?.getSelection?.();
    if (sel && String(sel).length > 0) return;
    openBlowout(svg);
  });
}
