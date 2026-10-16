import { buildModel, tileKey, pathBetween, positionAt, LAYERS } from './model.js';
import { loadGameData, loadCharacters, currentCharacters } from './data.js';
import { draw, screenToWorld, CHAR_COLORS } from './render.js';
import * as ui from './ui.js';

const MS_PER_TILE = 5000;
const canvas = document.getElementById('map');
const state = { model: null, layer: 'overworld', view: { cx: 3, cy: 8, scale: 28 }, selected: null, hover: null, highlights: new Set(), chars: [], t: 0 };
let box = { width: 1, height: 1 };

const clampScale = (s) => Math.max(8, Math.min(140, s));
function fit() {
  const { minX, maxX, minY, maxY } = state.model.bounds;
  const r = canvas.getBoundingClientRect(); box = { width: r.width, height: r.height };
  const pad = r.width < 640 ? 1.2 : 2;
  state.view = {
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    scale: clampScale(Math.min(r.width / (maxX - minX + 1 + pad), r.height / (maxY - minY + 1 + pad))),
  };
}
const tileAt = (sx, sy) => {
  const [wx, wy] = screenToWorld(state.view, box.width, box.height, sx, sy);
  return state.model.layers[state.layer].get(tileKey(Math.round(wx), Math.round(wy))) ?? null;
};
function zoomAt(sx, sy, factor) {
  const v = state.view, [wx, wy] = screenToWorld(v, box.width, box.height, sx, sy);
  const scale = clampScale(v.scale * factor);
  state.view = { scale, cx: wx - (sx - box.width / 2) / scale, cy: wy - (sy - box.height / 2) / scale };
}
function setLayer(l) {
  state.layer = l; ui.markLayer(l); state.hover = null; ui.hideTip();
  if (state.selected) { const t = state.model.layers[l].get(state.selected.key); state.selected = t ?? null; if (!t) ui.hidePanel(); else ui.showPanel(state.model, t, gotoTransition); }
}
function select(rec) {
  state.selected = rec;
  if (rec) {
    ui.showPanel(state.model, rec, gotoTransition);
    const v = state.view;
    if (box.width <= 640 && box.height * 0.5 < (rec.y - v.cy) * v.scale + box.height / 2 + v.scale) state.view = { ...v, cy: rec.y + (box.height * 0.25) / v.scale };
  } else ui.hidePanel();
}
function gotoTransition(t) {
  setLayer(t.layer);
  state.view = { ...state.view, cx: t.x, cy: t.y };
  select(state.model.layers[t.layer].get(tileKey(t.x, t.y)) ?? null);
}
function centerOn(x, y, minScale = 40) { state.view = { cx: x, cy: y, scale: Math.max(state.view.scale, minScale) }; }

// ---- pointer: drag, tap, pinch
const ptrs = new Map();
let drag = null, pinch0 = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (ptrs.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: state.view.cx, cy: state.view.cy, moved: false };
  else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), s: state.view.scale }; drag = null; }
});
canvas.addEventListener('pointermove', (e) => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pinch0 && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, clampScale(pinch0.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch0.d) / state.view.scale);
    return;
  }
  if (drag) {
    const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) { state.view = { ...state.view, cx: drag.cx - dx / state.view.scale, cy: drag.cy - dy / state.view.scale }; ui.hideTip(); return; }
  }
  if (e.pointerType === 'mouse' && !drag?.moved) {
    const t = tileAt(e.offsetX, e.offsetY); state.hover = t;
    if (t) ui.showTip(ui.tooltipText(state.model, t), e.offsetX, e.offsetY, box); else ui.hideTip();
  }
});
const endPtr = (e) => {
  const wasTap = drag && !drag.moved && ptrs.size === 1 && e.type === 'pointerup';
  ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null;
  if (wasTap) select(tileAt(e.offsetX, e.offsetY));
  if (!ptrs.size) drag = null;
};
canvas.addEventListener('pointerup', endPtr); canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { state.hover = null; ui.hideTip(); } });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
canvas.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (step) {
    const cur = state.selected ?? tileAt(box.width / 2, box.height / 2);
    const next = state.model.layers[state.layer].get(tileKey(cur.x + step[0], cur.y + step[1]));
    if (next) { select(next); const v = state.view; const [sx, sy] = [box.width / 2 + (next.x - v.cx) * v.scale, box.height / 2 + (next.y - v.cy) * v.scale];
      if (sx < 20 || sy < 20 || sx > box.width - 20 || sy > box.height - 20) state.view = { ...v, cx: next.x, cy: next.y }; }
    e.preventDefault();
  } else if (e.key === '+' || e.key === '=') zoomAt(box.width / 2, box.height / 2, 1.25);
  else if (e.key === '-') zoomAt(box.width / 2, box.height / 2, 0.8);
  else if (e.key === '0') fit();
  else if (e.key === 'Escape') select(null);
});
document.getElementById('zin').onclick = () => zoomAt(box.width / 2, box.height / 2, 1.3);
document.getElementById('zout').onclick = () => zoomAt(box.width / 2, box.height / 2, 1 / 1.3);
document.getElementById('zfit').onclick = fit;
document.getElementById('pclose').onclick = () => select(null);

// ---- characters
const walkers = new Map();
function syncChars(list, now) {
  list.forEach((c, i) => {
    const w = walkers.get(c.name);
    const color = CHAR_COLORS[i % 5];
    if (!w) { walkers.set(c.name, { ...c, color, from: { x: c.x, y: c.y }, path: [], t0: now, px: c.x, py: c.y }); return; }
    Object.assign(w, { hp: c.hp, max_hp: c.max_hp, color });
    if (c.layer !== w.layer) { Object.assign(w, { layer: c.layer, x: c.x, y: c.y, from: { x: c.x, y: c.y }, path: [], px: c.x, py: c.y }); }
    else if (c.x !== w.x || c.y !== w.y) {
      const cur = { x: Math.round(w.px), y: Math.round(w.py) };
      w.from = { x: w.px, y: w.py }; w.path = pathBetween(cur, c); w.t0 = now; w.x = c.x; w.y = c.y;
    }
  });
  for (const k of [...walkers.keys()]) if (!list.some((c) => c.name === k)) walkers.delete(k);
  state.chars = [...walkers.values()];
}
let lastSig = '';
function pollChars(now) {
  const list = currentCharacters();
  if (!list) return;
  const sig = JSON.stringify(list);
  if (sig === lastSig) return;
  lastSig = sig; syncChars(list, now); ui.renderChars(list, (c) => { setLayer(c.layer); centerOn(c.x, c.y); });
}

// ---- search
function highlight(entry) {
  state.highlights = new Set();
  if (!entry) return;
  for (const t of entry.tiles) state.highlights.add(tileKey(t.x, t.y) + '|' + t.layer);
  const tiles = entry.tiles;
  const here = tiles.filter((t) => t.layer === state.layer);
  const pick = here[0] ?? tiles[0];
  if (pick.layer !== state.layer) setLayer(pick.layer);
  const onLayer = tiles.filter((t) => t.layer === state.layer);
  const xs = onLayer.map((t) => t.x), ys = onLayer.map((t) => t.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2) + 3;
  state.view = { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, scale: clampScale(Math.min(box.width, box.height) / span) };
}

// ---- loop
function frame(now) {
  state.t = now;
  pollChars(now);
  for (const w of walkers.values()) { const p = positionAt(w.from, w.path, now - w.t0, MS_PER_TILE); w.px = p.x; w.py = p.y; }
  const hl = new Set();
  for (const k of state.highlights) { const [key, layer] = k.split('|'); if (layer === state.layer) hl.add(key); }
  draw(canvas, { ...state, highlights: hl });
  requestAnimationFrame(frame);
}

async function start() {
  try {
    const data = await loadGameData();
    state.model = buildModel(data);
    ui.buildLayerTabs(state.layer, setLayer); ui.buildLegend();
    ui.wireSearch(() => state.model.index, highlight);
    const initial = await loadCharacters();
    if (!Array.isArray(globalThis.ARTIFACTS_CHARACTERS)) globalThis.ARTIFACTS_CHARACTERS = initial;
    new ResizeObserver(() => { const r = canvas.getBoundingClientRect(); box = { width: r.width, height: r.height }; }).observe(canvas);
    fit();
    requestAnimationFrame(frame);
    globalThis.__atlas = { state, LAYERS };
  } catch (err) {
    document.querySelector('.stage').insertAdjacentHTML('beforeend', `<p style="position:absolute;inset:auto 16px 16px;color:#ef6b66">Could not load map data: ${String(err.message)}. Run <code>npm run web</code> from artifacts-mmo/.</p>`);
  }
}
start();
