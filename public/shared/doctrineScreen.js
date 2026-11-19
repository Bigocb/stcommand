/**
 * The doctrine settings screen, shared by Deck (#doctrine-standing-orders) and Tower (#more-doctrine).
 * Search, filters and groups over /api/doctrine's `clauses` (docs/doctrine-organization.md section 8).
 * Data in: getData() -> { clauses, groupOrder }. Writes go through POST /api/doctrine, then reload().
 */
import { filterClauses, groupClauses, neededOff, rangeHint } from "/shared/doctrineView.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const STATE_KEY = "doctrineView.v1";

const CSS = `
.dv-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--hair);position:sticky;top:0;background:var(--panel);z-index:2}
.dv-bar input,.dv-bar select{font:inherit;font-size:12px;color:inherit;background:var(--ground);border:1px solid var(--hair-hi);padding:5px 7px;border-radius:4px;min-width:0}
.dv-bar .dv-q{flex:1 1 160px}
.dv-bar .dv-n{font-size:11px;color:var(--dim);margin-left:auto;white-space:nowrap}
.dv-g{border-bottom:1px solid var(--hair)}
.dv-gh{padding:9px 12px 4px;font-weight:600;font-size:12px;display:flex;gap:8px;align-items:baseline}
.dv-gh .dv-gb{font-weight:400;font-size:11px;color:var(--dim)}
.dv-sg{padding:6px 12px 2px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.dv-row{padding:8px 12px;border-top:1px solid var(--hair);display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:start}
.dv-row .dv-nm{font-size:12px;font-weight:600;overflow-wrap:anywhere}
.dv-row .dv-k{font-family:var(--mono);font-size:10px;color:var(--dim);overflow-wrap:anywhere}
.dv-row .sw{grid-row:1/span 2;grid-column:2;align-self:center}
.dv-row .dv-ctl{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--dim)}
.dv-row .dv-ctl input{width:110px;font:inherit;font-size:12px;color:inherit;background:var(--ground);border:1px solid var(--hair-hi);padding:4px 6px;border-radius:4px}
.dv-row .dv-def{color:var(--amber)}
.dv-row button.dv-link{background:none;border:0;padding:0;color:var(--ice, var(--amber));cursor:pointer;font:inherit;text-decoration:underline}
.dv-row .dv-need{grid-column:1/-1;font-size:11px;color:var(--amber)}
.dv-row .dv-sum{grid-column:1/-1;font-size:11px;color:var(--dim);line-height:1.4}
.dv-row details{grid-column:1/-1;font-size:11px;color:var(--dim);line-height:1.45}
.dv-row details summary{cursor:pointer;color:var(--dim)}
.dv-row.dv-off .dv-nm{color:var(--dim)}
.dv-empty{padding:16px 12px;color:var(--dim);font-size:12px}
.dv-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--raised, var(--panel));border:1px solid var(--hair-hi);padding:8px 12px;border-radius:6px;font-size:12px;z-index:50;max-width:min(92vw,520px)}
`;

function injectCss() {
  if (document.getElementById("dv-css")) return;
  const st = document.createElement("style");
  st.id = "dv-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

function loadState() {
  try { return { q: "", group: "", show: "all", ...(JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}")) }; } catch { return { q: "", group: "", show: "all" }; }
}
function saveState(s) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* private window: keep it in memory */ }
}

function toast(msg) {
  document.querySelector(".dv-toast")?.remove();
  const t = document.createElement("div");
  t.className = "dv-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function fmtVal(c) {
  const u = String(c.unit ?? "").trim();
  return `${Number(c.value).toLocaleString()}${u ? ` ${u}` : ""}`;
}

function rowHtml(c, all) {
  const needs = neededOff(c, all);
  const valueCtl = c.kind === "switch" ? "" :
    `<input class="dv-val" type="number" inputmode="decimal" min="${c.min}" max="${c.max}" step="${c.step ?? 1}" value="${esc(c.value)}" aria-label="${esc(c.name)} value"> <span>${esc(String(c.unit ?? "").trim())}</span> <span>(${esc(rangeHint(c))})</span>`;
  const def = c.default
    ? `<span class="dv-def">default ${[c.kind === "switch" || c.default.value === c.value ? "" : esc(fmtVal({ ...c, value: c.default.value })), c.default.enabled !== c.enabled ? (c.default.enabled ? "on" : "off") : ""].filter(Boolean).join(", ")}</span> <button class="dv-link dv-reset" type="button">reset</button>`
    : "";
  return `<div class="dv-row${c.enabled ? "" : " dv-off"}" data-key="${esc(c.key)}">
    <div class="dv-nm">${esc(c.name)}</div>
    <button class="sw" aria-pressed="${c.enabled}" aria-label="Turn ${esc(c.name)} ${c.enabled ? "off" : "on"}"><i></i></button>
    <div class="dv-k">${esc(c.key)}</div>
    ${valueCtl || def ? `<div class="dv-ctl">${valueCtl}${def}</div>` : ""}
    ${needs.map((n) => `<div class="dv-need">Needs ${esc(n.name)} (off) <button class="dv-link dv-need-on" type="button" data-need="${esc(n.key)}">turn on</button></div>`).join("")}
    <div class="dv-sum">${esc(c.summary)}</div>
    ${c.description && c.description !== c.summary ? `<details><summary>More</summary>${esc(c.description)}</details>` : ""}
  </div>`;
}

/**
 * Mount the screen into `host`. Returns { refresh } to call when the doctrine store changes.
 * opts: { api(method, url, body), getData() -> {clauses, groupOrder}, reload() -> Promise }.
 */
export function mountDoctrineScreen(host, opts) {
  injectCss();
  const state = loadState();
  host.innerHTML = `<div class="dv-bar">
      <input class="dv-q" type="search" placeholder="Search doctrine (e.g. top up, jump, keeper cash)" aria-label="Search doctrine">
      <select class="dv-show" aria-label="Show">
        <option value="all">All</option><option value="common">Common knobs</option><option value="changed">Changed from default</option>
        <option value="on">On</option><option value="off">Off</option>
      </select>
      <select class="dv-grp" aria-label="Group"><option value="">All groups</option></select>
      <span class="dv-n"></span>
    </div><div class="dv-list"></div>`;
  const q = host.querySelector(".dv-q");
  const show = host.querySelector(".dv-show");
  const grp = host.querySelector(".dv-grp");
  const list = host.querySelector(".dv-list");
  const count = host.querySelector(".dv-n");
  q.value = state.q; show.value = state.show;

  function render(force = false) {
    const { clauses, groupOrder } = opts.getData();
    // Don't clobber a number being typed.
    if (!force && list.contains(document.activeElement) && document.activeElement.classList.contains("dv-val")) return;
    const opts2 = groupOrder.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join("");
    if (grp.dataset.sig !== opts2) { grp.innerHTML = `<option value="">All groups</option>${opts2}`; grp.dataset.sig = opts2; }
    grp.value = groupOrder.some((g) => g.id === state.group) ? state.group : "";
    if (!clauses.length) { list.innerHTML = '<div class="dv-empty">Doctrine unavailable — the fleet is still starting.</div>'; count.textContent = ""; return; }
    const shown = filterClauses(clauses, { q: state.q, group: grp.value, show: state.show }, groupOrder);
    count.textContent = `${shown.length} of ${clauses.length} · ${clauses.filter((c) => c.enabled).length} on`;
    if (!shown.length) { list.innerHTML = '<div class="dv-empty">No clause matches. Clear the search or pick All.</div>'; return; }
    list.innerHTML = groupClauses(shown, groupOrder).map((g) => `<section class="dv-g">
        <div class="dv-gh">${esc(g.name)} <span class="dv-gb">${g.count} · ${esc(g.blurb)}</span></div>
        ${g.subs.map((s) => `${s.name ? `<div class="dv-sg">${esc(s.name)}</div>` : ""}${s.clauses.map((c) => rowHtml(c, clauses)).join("")}`).join("")}
      </section>`).join("");
  }

  const update = () => { state.q = q.value; state.show = show.value; state.group = grp.value; saveState(state); render(true); };
  q.addEventListener("input", update);
  show.addEventListener("change", update);
  grp.addEventListener("change", update);

  async function post(body, label) {
    try {
      const res = await opts.api("POST", "/api/doctrine", body);
      if (body.value !== undefined && res?.rule && res.rule.value !== body.value) toast(`${label}: ${body.value} is outside the range, set to ${res.rule.value}`);
    } catch (err) { toast(`${label}: ${err.message}`); }
    await opts.reload();
    render(true);
  }

  list.addEventListener("click", async (e) => {
    const row = e.target.closest(".dv-row");
    if (!row) return;
    const key = row.dataset.key;
    const c = opts.getData().clauses.find((x) => x.key === key);
    if (!c) return;
    if (e.target.closest("button.sw")) {
      e.target.closest("button.sw").disabled = true;
      await post({ key, enabled: !c.enabled }, c.name);
    } else if (e.target.closest(".dv-reset") && c.default) {
      await post({ key, value: c.default.value, enabled: c.default.enabled }, c.name);
    } else if (e.target.closest(".dv-need-on")) {
      const need = e.target.closest(".dv-need-on").dataset.need;
      await post({ key: need, enabled: true }, need);
    }
  });
  list.addEventListener("change", async (e) => {
    const inp = e.target.closest("input.dv-val");
    if (!inp) return;
    const key = inp.closest(".dv-row").dataset.key;
    const value = Number(inp.value);
    if (!Number.isFinite(value) || inp.value === "") return;
    const c = opts.getData().clauses.find((x) => x.key === key);
    inp.disabled = true;
    await post({ key, value }, c?.name ?? key);
  });

  render(true);
  return { refresh: () => render(false) };
}
