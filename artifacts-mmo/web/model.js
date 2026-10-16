// Pure data shaping for the map viewer. No DOM, no I/O, no clock.

export const LAYERS = ['overworld', 'underground', 'interior'];

/** Classify a map tile into a display kind. Returns { kind, skill, code, transition, access }. */
export function classifyTile(tile) {
  const content = tile.interactions?.content ?? null;
  const transition = !!tile.interactions?.transition;
  const access = tile.access?.type ?? 'standard';
  let kind;
  if (content) {
    kind = content.type;
  } else if (transition) kind = 'transition';
  else if (access === 'blocked') kind = 'blocked';
  else kind = 'empty';
  return { kind, code: content?.code ?? null, transition, access };
}

/** Build lookups by code and a tile list per layer, with classification attached. */
export function buildModel({ maps = [], monsters = [], resources = [], npcs = [], items = [], events = [] }) {
  const by = (arr) => new Map(arr.map((x) => [x.code, x]));
  const model = {
    monsters: by(monsters), resources: by(resources), npcs: by(npcs), items: by(items), events,
    layers: Object.fromEntries(LAYERS.map((l) => [l, new Map()])),
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
  let first = true;
  for (const t of maps) {
    const c = classifyTile(t);
    const rec = { ...t, ...c, access: c.access, accessConditions: t.access?.conditions ?? [], key: tileKey(t.x, t.y) };
    if (c.kind === 'resource') rec.skill = model.resources.get(c.code)?.skill ?? null;
    if (c.kind === 'workshop') rec.skill = c.code;
    (model.layers[t.layer] ??= new Map()).set(rec.key, rec);
    const b = model.bounds;
    if (first) { b.minX = b.maxX = t.x; b.minY = b.maxY = t.y; first = false; }
    else { b.minX = Math.min(b.minX, t.x); b.maxX = Math.max(b.maxX, t.x); b.minY = Math.min(b.minY, t.y); b.maxY = Math.max(b.maxY, t.y); }
  }
  model.index = buildSearchIndex(model);
  return model;
}

export const tileKey = (x, y) => `${x},${y}`;

/** Palette key used for colouring: resources and workshops split by skill. */
export function colorKey(rec) {
  if (rec.kind === 'resource' || rec.kind === 'workshop') return `${rec.kind}:${rec.skill ?? '?'}`;
  return rec.kind;
}

/** Search index: entries { label, type, code, tiles:[{layer,x,y}] }. A monster's drops make items searchable. */
export function buildSearchIndex(model) {
  const entries = new Map();
  const add = (type, code, label, tile, extra) => {
    const id = `${type}:${code}`;
    let e = entries.get(id);
    if (!e) entries.set(id, (e = { id, type, code, label, norm: norm(label), tiles: [], note: extra || '' }));
    if (!e.tiles.some((t) => t.layer === tile.layer && t.x === tile.x && t.y === tile.y)) e.tiles.push({ layer: tile.layer, x: tile.x, y: tile.y });
  };
  for (const layer of Object.values(model.layers)) {
    for (const t of layer.values()) {
      const pos = { layer: t.layer, x: t.x, y: t.y };
      if (t.kind === 'monster') {
        const m = model.monsters.get(t.code);
        if (!m) continue;
        add('monster', m.code, m.name, pos, `lvl ${m.level}`);
        for (const d of m.drops ?? []) add('item', d.code, model.items.get(d.code)?.name ?? d.code, pos, `drop of ${m.name}`);
      } else if (t.kind === 'resource') {
        const r = model.resources.get(t.code);
        if (!r) continue;
        add('resource', r.code, r.name, pos, `${r.skill} ${r.level}`);
        for (const d of r.drops ?? []) add('item', d.code, model.items.get(d.code)?.name ?? d.code, pos, `drop of ${r.name}`);
      } else if (t.kind === 'npc') {
        const n = model.npcs.get(t.code);
        if (n) add('npc', n.code, n.name, pos, n.type);
      } else if (t.kind === 'workshop') {
        add('workshop', t.code, `${cap(t.code)} workshop`, pos, 'workshop');
      }
    }
  }
  return [...entries.values()];
}

export const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const cap = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Ranked name search: prefix matches first, then substring; monsters/resources before items. */
export function search(index, query, limit = 12) {
  const q = norm(query);
  if (!q) return [];
  const rank = { monster: 0, resource: 1, npc: 2, workshop: 3, item: 4 };
  const scored = [];
  for (const e of index) {
    const i = e.norm.indexOf(q);
    if (i < 0) continue;
    scored.push([(i === 0 ? 0 : e.norm.includes(' ' + q) ? 1 : 2) * 10 + (rank[e.type] ?? 5), e]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label));
  return scored.slice(0, limit).map((s) => s[1]);
}

/** Drops of a monster/resource sorted by best (lowest rate number) first. rate = 1-in-N. */
export function topDrops(drops, n = 4) {
  return [...(drops ?? [])].sort((a, b) => a.rate - b.rate).slice(0, n);
}

export function formatCondition(c) {
  const op = { cost: 'costs', has_item: 'needs', achievement_unlocked: 'achievement' }[c.operator] ?? c.operator;
  return c.operator === 'cost' || c.operator === 'has_item' ? `${op} ${c.value} x ${c.code}` : `${op}: ${c.code}${c.value > 1 ? ' ' + c.value : ''}`;
}

/** Plain-data description of a tile for the side panel / tooltip. */
export function describeTile(model, rec) {
  const d = { title: rec.name, coords: `(${rec.x}, ${rec.y})`, layer: rec.layer, kind: rec.kind, access: rec.access };
  const t = rec.interactions?.transition;
  if (rec.kind === 'monster') {
    const m = model.monsters.get(rec.code);
    d.title = m?.name ?? rec.code;
    d.monster = m ? { name: m.name, level: m.level, hp: m.hp, type: m.type,
      resists: { fire: m.res_fire, earth: m.res_earth, water: m.res_water, air: m.res_air },
      attacks: { fire: m.attack_fire, earth: m.attack_earth, water: m.attack_water, air: m.attack_air },
      drops: topDrops(m.drops).map((x) => ({ ...x, name: model.items.get(x.code)?.name ?? x.code })) } : null;
  } else if (rec.kind === 'resource') {
    const r = model.resources.get(rec.code);
    d.title = r?.name ?? rec.code;
    d.resource = r ? { skill: r.skill, level: r.level, drops: topDrops(r.drops).map((x) => ({ ...x, name: model.items.get(x.code)?.name ?? x.code })) } : null;
  } else if (rec.kind === 'workshop') d.title = `${cap(rec.code)} workshop`;
  else if (rec.kind === 'npc') { const n = model.npcs.get(rec.code); d.title = n?.name ?? rec.code; d.npc = n ? { type: n.type, description: n.description } : null; }
  else if (['bank', 'grand_exchange', 'tasks_master', 'raid'].includes(rec.kind)) d.title = cap(rec.kind === 'raid' ? `Raid: ${rec.code}` : rec.kind);
  else if (rec.kind === 'blocked') d.title = 'Impassable';
  else if (rec.kind === 'transition') d.title = 'Passage';
  if (t) d.transition = { x: t.x, y: t.y, layer: t.layer, conditions: (t.conditions ?? []).map(formatCondition) };
  d.accessConditions = (rec.accessConditions ?? []).map(formatCondition);
  return d;
}

/** Axis-aligned path (x first, then y) as a list of cells excluding the start. */
export function pathBetween(a, b) {
  const out = [];
  let { x, y } = a;
  while (x !== b.x) { x += Math.sign(b.x - x); out.push({ x, y }); }
  while (y !== b.y) { y += Math.sign(b.y - y); out.push({ x, y }); }
  return out;
}

/** Position of a walker along `from` + path after `elapsedMs`, msPerTile per step. Returns {x,y,done}. */
export function positionAt(from, path, elapsedMs, msPerTile = 5000) {
  if (!path.length || elapsedMs >= path.length * msPerTile) {
    const end = path.length ? path[path.length - 1] : from;
    return { x: end.x, y: end.y, done: true };
  }
  const step = Math.floor(Math.max(0, elapsedMs) / msPerTile);
  const f = (Math.max(0, elapsedMs) - step * msPerTile) / msPerTile;
  const p0 = step === 0 ? from : path[step - 1];
  const p1 = path[step];
  return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f, done: false };
}
