import { LAYERS, describeTile, search, cap } from './model.js';
import { COLORS, LEGEND, CHAR_COLORS } from './render.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function buildLayerTabs(current, onPick) {
  const box = $('layers');
  box.innerHTML = '';
  for (const l of LAYERS) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.layer = l; b.textContent = l;
    b.addEventListener('click', () => onPick(l));
    b.addEventListener('keydown', (e) => {
      const i = LAYERS.indexOf(l);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { onPick(LAYERS[(i + 1) % 3]); box.querySelector('[aria-checked="true"]').focus(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { onPick(LAYERS[(i + 2) % 3]); box.querySelector('[aria-checked="true"]').focus(); }
    });
    box.append(b);
  }
  markLayer(current);
}
export function markLayer(current) {
  for (const b of $('layers').children) { const on = b.dataset.layer === current; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; }
}

export function buildLegend() {
  $('legendList').innerHTML = LEGEND.map(([k, label]) => `<li><span class="sw" style="background:${COLORS[k]}"></span>${label}</li>`).join('');
}

export function tooltipText(model, rec) {
  const d = describeTile(model, rec);
  const extra = d.monster ? ` · lvl ${d.monster.level}` : d.resource ? ` · ${d.resource.skill} ${d.resource.level}` : '';
  return `<b>${esc(d.title)}${esc(extra)}</b><span>${d.coords} · ${rec.layer}</span>`;
}
export function showTip(html, x, y, box) {
  const t = $('tip'); t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(4, Math.min(box.width - w - 4, x + 14)) + 'px';
  t.style.top = Math.max(4, Math.min(box.height - h - 4, y + 14)) + 'px';
}
export const hideTip = () => { $('tip').hidden = true; };

const RES = ['fire', 'earth', 'water', 'air'];
const dropList = (drops) => `<ul>${drops.map((d) => `<li><span>${esc(d.name)}</span><small>1 in ${d.rate}${d.max_quantity > 1 ? ` · ${d.min_quantity}-${d.max_quantity}` : ''}</small></li>`).join('')}</ul>`;

export function showPanel(model, rec, onGoto) {
  const d = describeTile(model, rec);
  let h = `<h2>${esc(d.title)}</h2><div class="sub">${d.coords} · ${rec.layer} · ${esc(rec.skin)}</div>`;
  const badges = [];
  if (d.access?.type && d.access.type !== 'standard') badges.push(`<span class="badge warn">${esc(d.access.type)}</span>`);
  if (badges.length) h += `<p>${badges.join('')}</p>`;
  if (d.accessConditions.length) h += `<h3>Access</h3><ul>${d.accessConditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
  if (d.monster) {
    const m = d.monster;
    h += `<h3>Monster</h3><dl><dt>Level</dt><dd>${m.level} (${esc(m.type)})</dd><dt>HP</dt><dd>${m.hp}</dd></dl>`;
    h += `<h3>Resistances</h3><dl>${RES.map((r) => `<dt>${cap(r)}</dt><dd class="${m.resists[r] > 0 ? 'pos' : m.resists[r] < 0 ? 'neg' : ''}">${m.resists[r]}%</dd>`).join('')}</dl>`;
    const atk = RES.filter((r) => m.attacks[r]);
    if (atk.length) h += `<h3>Attacks</h3><dl>${atk.map((r) => `<dt>${cap(r)}</dt><dd>${m.attacks[r]}</dd>`).join('')}</dl>`;
    if (m.drops.length) h += `<h3>Top drops</h3>${dropList(m.drops)}`;
  }
  if (d.resource) {
    h += `<h3>Resource</h3><dl><dt>Skill</dt><dd>${esc(d.resource.skill)}</dd><dt>Level</dt><dd>${d.resource.level}</dd></dl>`;
    if (d.resource.drops.length) h += `<h3>Top drops</h3>${dropList(d.resource.drops)}`;
  }
  if (rec.kind === 'workshop') h += `<h3>Workshop</h3><dl><dt>Skill</dt><dd>${esc(cap(rec.code))}</dd></dl>`;
  if (d.npc) h += `<h3>${esc(cap(d.npc.type))}</h3><p>${esc(d.npc.description)}</p>`;
  if (d.transition) {
    const t = d.transition;
    h += `<h3>Passage to</h3><dl><dt>Destination</dt><dd>(${t.x}, ${t.y}) ${esc(t.layer)}</dd></dl>`;
    h += t.conditions.length ? `<ul>${t.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p>No conditions.</p>';
    h += `<button class="go" data-go="1" type="button">Go to destination</button>`;
  }
  if (rec.kind === 'empty' || rec.kind === 'blocked') h += `<p>${rec.kind === 'blocked' ? 'Characters cannot enter this tile.' : 'Nothing to interact with here.'}</p>`;
  $('pbody').innerHTML = h;
  $('panel').hidden = false;
  const go = $('pbody').querySelector('[data-go]');
  if (go) go.addEventListener('click', () => onGoto(d.transition));
}
export const hidePanel = () => { $('panel').hidden = true; };

export function wireSearch(getIndex, onPick) {
  const q = $('q'), list = $('results');
  let items = [], sel = -1;
  const render = () => {
    list.hidden = !items.length; q.setAttribute('aria-expanded', !list.hidden);
    list.innerHTML = items.map((e, i) => `<li role="option" id="r${i}" aria-selected="${i === sel}" data-i="${i}"><span>${esc(e.label)}</span><span class="meta">${esc(e.type)} · ${e.tiles.length} tile${e.tiles.length > 1 ? 's' : ''}</span></li>`).join('');
  };
  const pick = (i) => { if (!items[i]) return; q.value = items[i].label; items = []; sel = -1; render(); onPick(items0[i]); };
  let items0 = [];
  q.addEventListener('input', () => { items = items0 = search(getIndex(), q.value); sel = -1; render(); if (!q.value) onPick(null); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items.length) { pick(Math.max(0, sel)); } e.preventDefault(); }
    else if (e.key === 'Escape') { items = []; render(); if (!q.value) onPick(null); else { q.value = ''; onPick(null); } }
  });
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  q.addEventListener('blur', () => { items = []; render(); });
}

export function renderChars(chars, onPick) {
  const ul = $('chars');
  ul.innerHTML = '';
  chars.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" aria-label="${esc(c.name)}, ${c.hp} of ${c.max_hp ?? c.hp} HP, ${esc(c.layer)} ${c.x},${c.y}"><span class="dot" style="background:${CHAR_COLORS[i % 5]}"></span><span class="nm">${esc(c.name)}</span><span class="hp">${c.hp}${c.max_hp ? '/' + c.max_hp : ''}</span></button>`;
    li.firstChild.addEventListener('click', () => onPick(c));
    ul.append(li);
  });
}
