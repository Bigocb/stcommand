// Pulls PUBLIC Grand Exchange data (no auth) into data/ge_orders.json and data/ge_history.json.
// Polite: <= 3 requests/second, honours 429 (Retry-After), retries a few times.
// Usage: node scripts/fetch-ge.mjs [topN=60]
import { writeFileSync, mkdirSync } from 'node:fs';
const BASE = 'https://api.artifactsmmo.com';
const TOP = Number(process.argv[2] ?? 60);
const GAP_MS = 350;
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(BASE + path);
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after'));
      await sleep((Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`${path}: gave up after repeated 429s`);
}
const orders = [];
for (let page = 1; ; page++) {
  const j = await get(`/grandexchange/orders?size=100&page=${page}`);
  orders.push(...j.data);
  if (page >= j.pages) break;
}
const counts = new Map();
for (const o of orders) counts.set(o.code, (counts.get(o.code) ?? 0) + 1);
const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([c]) => c);
const history = {};
for (const code of top) {
  // History is oldest-first, so the newest sales are on the LAST page; take the last two pages.
  const base = `/grandexchange/history/${encodeURIComponent(code)}?size=100`;
  const first = await get(`${base}&page=1`);
  let rows = first.data;
  if (first.pages > 1) {
    rows = (await get(`${base}&page=${first.pages}`)).data;
    if (first.pages > 2) rows = [...(await get(`${base}&page=${first.pages - 1}`)).data, ...rows];
  }
  history[code] = rows;
}
writeFileSync(new URL('../data/ge_orders.json', import.meta.url), JSON.stringify(orders));
writeFileSync(new URL('../data/ge_history.json', import.meta.url), JSON.stringify(history));
console.log(`orders ${orders.length} (${counts.size} items), history for ${top.length} items`);
