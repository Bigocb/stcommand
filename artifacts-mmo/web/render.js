import { colorKey, cap } from './model.js';

export const COLORS = {
  empty: '#1b2733', blocked: '#0d1218', transition: '#7b61ff', monster: '#d9534f', raid: '#ff2d6f',
  bank: '#f2c14e', grand_exchange: '#ffd86b', tasks_master: '#4cc9f0', npc: '#c77dff', workshop: '#b08968',
  'resource:mining': '#8d99ae', 'resource:woodcutting': '#4f9d5d', 'resource:fishing': '#2f8fd6', 'resource:alchemy': '#3fd1a5',
  'workshop:weaponcrafting': '#c9784a', 'workshop:gearcrafting': '#b5651d', 'workshop:jewelrycrafting': '#e0a2d8',
  'workshop:cooking': '#e0813a', 'workshop:woodcutting': '#8a6a3d', 'workshop:mining': '#9aa5b1', 'workshop:alchemy': '#55c9a5',
};
const GLYPH = { monster: '⚔', raid: '☠', bank: '$', grand_exchange: '⇄', tasks_master: '!', npc: '☺', transition: '⇅', workshop: '⚒',
  'resource:mining': '⛏', 'resource:woodcutting': '♣', 'resource:fishing': '≈', 'resource:alchemy': '✿' };
export const LEGEND = [
  ['monster', 'Monster'], ['resource:mining', 'Mining'], ['resource:woodcutting', 'Woodcutting'], ['resource:fishing', 'Fishing'],
  ['resource:alchemy', 'Alchemy'], ['workshop', 'Workshop'], ['bank', 'Bank'], ['grand_exchange', 'Grand Exchange'],
  ['tasks_master', 'Tasks master'], ['npc', 'NPC'], ['transition', 'Passage'], ['blocked', 'Blocked'],
];
export const colorFor = (rec) => COLORS[colorKey(rec)] ?? COLORS[rec.kind] ?? COLORS.empty;
export const glyphFor = (rec) => GLYPH[colorKey(rec)] ?? GLYPH[rec.kind] ?? '';

export const CHAR_COLORS = ['#ffd166', '#06d6a0', '#ef476f', '#4cc9f0', '#f78c6b'];

/** View: { cx, cy, scale } where (cx,cy) is the world point at canvas centre and scale is CSS px per tile. */
export const worldToScreen = (v, w, h, x, y) => [w / 2 + (x - v.cx) * v.scale, h / 2 + (y - v.cy) * v.scale];
export const screenToWorld = (v, w, h, sx, sy) => [v.cx + (sx - w / 2) / v.scale, v.cy + (sy - h / 2) / v.scale];

export function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w: r.width, h: r.height, dpr };
}

/** s = { model, layer, view, selected, hover, highlights:Set, chars:[{...,px,py,color}], t } */
export function draw(canvas, s) {
  const { w, h, dpr } = resizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0e13';
  ctx.fillRect(0, 0, w, h);
  const v = s.view, sc = v.scale, gap = sc >= 14 ? 1 : 0;
  const tiles = s.model.layers[s.layer];
  const [x0, y0] = screenToWorld(v, w, h, 0, 0), [x1, y1] = screenToWorld(v, w, h, w, h);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const t of tiles.values()) {
    if (t.x + 1 < x0 - 0.5 || t.x - 1 > x1 || t.y + 1 < y0 - 0.5 || t.y - 1 > y1) continue;
    const [sx, sy] = worldToScreen(v, w, h, t.x - 0.5, t.y - 0.5);
    ctx.fillStyle = colorFor(t);
    const dim = s.highlights.size && !s.highlights.has(t.key);
    ctx.globalAlpha = dim ? 0.28 : 1;
    ctx.fillRect(sx, sy, sc - gap, sc - gap);
    if (t.kind === 'blocked' && sc >= 14) { ctx.strokeStyle = '#18222c'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx + 3, sy + sc - 4); ctx.lineTo(sx + sc - 4, sy + 3); ctx.stroke(); }
    if (t.access?.type === 'conditional' || t.access?.type === 'restricted') { ctx.fillStyle = '#ffd166'; ctx.fillRect(sx + sc - 6 - gap, sy, 6, 6); }
    if (sc >= 22) {
      const g = glyphFor(t);
      if (g) {
        ctx.fillStyle = t.kind === 'bank' || t.kind === 'grand_exchange' ? '#2a2108' : '#fff';
        ctx.font = `${Math.round(sc * 0.5)}px system-ui, "Segoe UI Symbol", sans-serif`;
        ctx.fillText(g, sx + sc / 2, sy + sc / 2 - (sc >= 56 ? sc * 0.08 : 0));
      }
      if (t.transition && t.kind !== 'transition') { ctx.fillStyle = '#7b61ff'; ctx.beginPath(); ctx.arc(sx + 6, sy + 6, 3.5, 0, 7); ctx.fill(); }
    }
    if (sc >= 56 && t.code && t.kind !== 'blocked') {
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      const label = cap(t.code);
      let fs = Math.max(10, Math.round(sc * 0.14));
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      if (tw > sc - 8) { fs = Math.max(8, Math.floor(fs * (sc - 8) / tw)); ctx.font = `600 ${fs}px system-ui, sans-serif`; }
      ctx.fillText(label, sx + sc / 2, sy + sc - 9);
    }
    ctx.globalAlpha = 1;
    if (s.highlights.has(t.key)) {
      const pulse = 0.5 + 0.5 * Math.sin(s.t / 260);
      ctx.strokeStyle = `rgba(255,214,102,${0.6 + 0.4 * pulse})`; ctx.lineWidth = 2.5;
      ctx.strokeRect(sx - 1, sy - 1, sc + 1, sc + 1);
    }
  }
  if (sc >= 30) {
    ctx.fillStyle = 'rgba(160,180,200,.55)'; ctx.font = '600 10px ui-monospace, monospace';
    for (const t of tiles.values()) {
      if (t.x < x0 - 1 || t.x > x1 + 1 || t.y < y0 - 1 || t.y > y1 + 1) continue;
      const [sx, sy] = worldToScreen(v, w, h, t.x - 0.5, t.y - 0.5);
      if (t.y === s.model.bounds.minY) ctx.fillText(t.x, sx + sc / 2, sy - 8);
      if (t.x === s.model.bounds.minX) ctx.fillText(t.y, sx - 10, sy + sc / 2);
    }
  }
  for (const k of [s.hover, s.selected]) {
    if (!k) continue;
    const [sx, sy] = worldToScreen(v, w, h, k.x - 0.5, k.y - 0.5);
    ctx.strokeStyle = k === s.selected ? '#ffd166' : 'rgba(255,255,255,.7)'; ctx.lineWidth = k === s.selected ? 2.5 : 1.5;
    ctx.strokeRect(sx + 0.5, sy + 0.5, sc - 2, sc - 2);
  }
  // characters
  for (const c of s.chars) {
    if (c.layer !== s.layer) continue;
    const [px, py] = worldToScreen(v, w, h, c.px, c.py);
    const r = Math.max(8, Math.min(18, sc * 0.3));
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.ellipse(px, py + r * 0.9, r * 0.9, r * 0.35, 0, 0, 7); ctx.fill();
    ctx.fillStyle = c.color; ctx.strokeStyle = '#0a0e13'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#10151b'; ctx.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.fillText(c.name[0].toUpperCase(), px, py + 1);
    const frac = c.max_hp ? Math.max(0, Math.min(1, c.hp / c.max_hp)) : 1;
    ctx.fillStyle = '#10151b'; ctx.fillRect(px - r, py - r - 7, r * 2, 4);
    ctx.fillStyle = frac > 0.5 ? '#06d6a0' : frac > 0.25 ? '#ffd166' : '#ef476f'; ctx.fillRect(px - r, py - r - 7, r * 2 * frac, 4);
    if (sc >= 26) {
      ctx.font = '600 11px system-ui, sans-serif'; const tw = ctx.measureText(c.name).width + 8;
      ctx.fillStyle = 'rgba(10,14,19,.85)'; ctx.fillRect(px - tw / 2, py + r + 3, tw, 15);
      ctx.fillStyle = '#fff'; ctx.fillText(c.name, px, py + r + 11);
    }
  }
}
