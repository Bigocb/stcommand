/**
 * Rate-limit indicator shared by Tower and Deck. Polls /api/rate-limit and,
 * while SpaceTraders is answering 429s, shows a small amber dot in `anchor`
 * and raises a toast when it starts. If another server instance is alive at
 * the same time (a deploy's old instance — the usual cause of a storm) the
 * toast says so. Silent when everything is quiet.
 */
import { api } from "/shared/api.js";

const POLL_MS = 15_000;
let timer = null;
let active = false;

function ensureStyle() {
  if (document.getElementById("rl-style")) return;
  const st = document.createElement("style");
  st.id = "rl-style";
  st.textContent = `
    .rl-dot { display:none; width:8px; height:8px; border-radius:50%; background:#ffb020;
      box-shadow:0 0 6px rgba(255,176,32,.6); margin-right:8px; cursor:pointer; flex:0 0 auto; }
    .rl-dot.on { display:inline-block; animation: rl-pulse 1.6s ease-in-out infinite; }
    @keyframes rl-pulse { 50% { opacity:.35; } }
    .rl-toast { position:fixed; left:50%; bottom:84px; transform:translateX(-50%); z-index:9999;
      max-width:min(92vw,420px); padding:10px 14px; border-radius:8px; font:12px/1.4 ui-monospace,monospace;
      color:#f3efe6; background:#2a251b; border:1px solid rgba(255,176,32,.5); box-shadow:0 6px 24px rgba(0,0,0,.5);
      opacity:0; pointer-events:none; transition:opacity .25s; }
    .rl-toast.show { opacity:1; pointer-events:auto; }
  `;
  document.head.appendChild(st);
}

export function describeRateLimit(s) {
  const n = s.hits60s;
  let msg = `Rate limited by SpaceTraders — ${n} hit${n === 1 ? "" : "s"} in the last minute.`;
  const others = s.otherInstances ?? [];
  if (others.length) {
    msg += ` Another server instance is also running (${others.map((o) => o.instanceId.slice(-5)).join(", ")}) — likely deploy overlap; it should clear on its own.`;
  }
  return msg;
}

/** `anchor` is the element the dot is inserted before (its parent's flow). */
export function startRateLimitIndicator(anchor) {
  if (timer) return;
  ensureStyle();
  const dot = document.createElement("span");
  dot.className = "rl-dot";
  dot.title = "Rate limited";
  anchor.parentNode.insertBefore(dot, anchor);
  const toast = document.createElement("div");
  toast.className = "rl-toast";
  document.body.appendChild(toast);
  let hideT = null;
  let lastState = null;
  const show = () => {
    if (!lastState) return;
    toast.textContent = describeRateLimit(lastState);
    toast.classList.add("show");
    clearTimeout(hideT);
    hideT = setTimeout(() => toast.classList.remove("show"), 7000);
  };
  dot.addEventListener("click", show);
  toast.addEventListener("click", () => toast.classList.remove("show"));

  const tick = async () => {
    if (document.hidden) return;
    try {
      const s = await api("GET", "/api/rate-limit");
      lastState = s;
      const nowActive = s.hits60s > 0;
      dot.classList.toggle("on", nowActive);
      if (nowActive && !active) show(); // toast only on the transition into limited
      active = nowActive;
      if (!nowActive) toast.classList.remove("show");
    } catch (_) { /* engine not ready / signed out — stay quiet */ }
  };
  timer = setInterval(tick, POLL_MS);
  tick();
}
