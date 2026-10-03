/**
 * Cooldown bar + role-group collapse state, shared by Tower and V6.
 *
 * A ship's `cooldown` (from /state) carries an absolute `expiration`, so the
 * bar is computed against the clock here instead of trusting a polled
 * "seconds remaining" that goes stale between snapshots. One 1s ticker
 * updates every bar in place — no list re-render, no extra polling.
 */
const LS_KEY = "stcommand.fleetGroupsCollapsed";

function ensureStyle() {
  if (document.getElementById("cd-style")) return;
  const st = document.createElement("style");
  st.id = "cd-style";
  st.textContent = `
    .cd { display:inline-flex; align-items:center; gap:5px; vertical-align:middle; }
    .cd .cd-bar { position:relative; display:inline-block; width:34px; height:3px; border-radius:2px; background:rgba(255,255,255,.12); overflow:hidden; }
    .cd .cd-bar i { position:absolute; left:0; top:0; bottom:0; width:100%; border-radius:2px; background:var(--cd-c,#ffb020); transition:width .9s linear, background-color .9s linear; }
    .cd .cd-t { font:9px ui-monospace,monospace; font-variant-numeric:tabular-nums; color:var(--cd-c,#ffb020); }
    .cd[hidden] { display:none; }
  `;
  document.head.appendChild(st);
}

/** {end, total} in ms for a ship that is on cooldown right now, else null. */
export function cooldownInfo(ship) {
  const cd = ship?.cooldown;
  if (!cd) return null;
  const totalMs = (cd.totalSeconds ?? 0) * 1000;
  let end = cd.expiration ? new Date(cd.expiration).getTime() : NaN;
  if (!Number.isFinite(end)) end = Date.now() + (cd.remainingSeconds ?? 0) * 1000;
  if (end <= Date.now()) return null;
  return { end, total: Math.max(totalMs, end - Date.now()) };
}

export function cooldownHtml(ship) {
  const c = cooldownInfo(ship);
  if (!c) return "";
  return `<span class="cd" data-end="${c.end}" data-total="${c.total}" title="On cooldown"><span class="cd-bar"><i></i></span><span class="cd-t"></span></span>`;
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

// amber (just started) → green (nearly clear)
function colorFor(frac) {
  const hue = Math.round(38 + (1 - frac) * 90); // 38 amber … 128 green
  return `hsl(${hue} 85% 55%)`;
}

export function tickCooldowns(root = document) {
  const now = Date.now();
  root.querySelectorAll(".cd[data-end]").forEach((el) => {
    const end = Number(el.dataset.end), total = Number(el.dataset.total) || 1;
    const left = end - now;
    if (left <= 0) { el.hidden = true; return; }
    const frac = Math.min(1, left / total);
    el.style.setProperty("--cd-c", colorFor(frac));
    el.querySelector("i").style.width = `${(frac * 100).toFixed(1)}%`;
    el.querySelector(".cd-t").textContent = fmtLeft(left);
  });
}

let ticker = null;
export function startCooldownTicker() {
  ensureStyle();
  if (ticker) return;
  ticker = setInterval(() => { if (!document.hidden) tickCooldowns(); }, 1000);
}

/* ── role-group collapse state ── */
const DEFAULT_COLLAPSED = ["keeper"];
export function loadCollapsed() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return new Set(raw ? JSON.parse(raw) : DEFAULT_COLLAPSED);
  } catch (_) { return new Set(DEFAULT_COLLAPSED); }
}
export function toggleCollapsed(role) {
  const set = loadCollapsed();
  if (set.has(role)) set.delete(role); else set.add(role);
  try { localStorage.setItem(LS_KEY, JSON.stringify([...set])); } catch (_) { /* private mode */ }
  return set;
}

const ROLE_ORDER = ["trader", "miner", "siphoner", "surveyor", "explorer", "scout", "tour", "keeper"];
export function roleRank(role) {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}
