/**
 * Systems tab: where a local-only trader (reach "system") could work, with the reasons (advisory only). Systems are
 * ranked by their same-system routes; systems we already trade in stay listed, since a local trader can work there too.
 *
 *   const s = mountSystems(rootEl, { api });
 *   s.show();  // fetches and refreshes every minute while shown
 *   s.hide();  // stops it
 *
 * Data: GET /api/ops/systems_candidates?maxHops=N&requireHullYard=0|1 (src/ops/systems.ts, engine/systems/candidates.ts).
 * Nothing here moves a ship: the list is for deciding where to send one.
 */
import { escapeHtml } from "/shared/domain.js";

const REFRESH_MS = 60_000;
const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private window: fine */ } };
const h = (s) => escapeHtml(String(s ?? ""));

function row(v) {
  const f = v.facts;
  const hops = f.hops === undefined ? "—" : String(f.hops);
  const hull = f.hullYard === true ? "yes" : f.hullYard === false ? "no" : "unknown";
  const ours = f.ourShips ? ` · ${f.ourShips} of our ship${f.ourShips === 1 ? "" : "s"} here` : "";
  const here = f.ourShips ? `<span class="mx-sys-here">we're here</span>` : "";
  return `<div class="mx-sys ${v.status}">
    <div class="mx-sys-h"><span class="mx-sys-name">${h(v.system)}</span>${here}${v.status === "candidate" ? `<span class="mx-sys-score">${v.score}</span>` : `<span class="mx-sys-tag">${v.status === "unsurveyed" ? "survey" : "out"}</span>`}</div>
    <div class="mx-sys-facts">${hops} hop${hops === "1" ? "" : "s"} · ${f.localRoutes} same-system route${f.localRoutes === 1 ? "" : "s"}${f.bestLocalProfit ? `, best ${Math.round(f.bestLocalProfit).toLocaleString("en-US")}` : ""} · hull yard ${hull}${ours}</div>
    <ul class="mx-sys-why">${v.reasons.map((r) => `<li>${h(r)}</li>`).join("")}</ul>
  </div>`;
}

export function mountSystems(root, { api } = {}) {
  let maxHops = Number(lsGet("systemsMaxHops", "2")) || 2;
  let requireHull = lsGet("systemsRequireHull", "0") === "1";
  let data = null;
  let error = "";
  let timer = null;
  let showing = false;

  root.innerHTML = `<div class="mx-bar">
      <span class="mx-title">Systems · local trader placement</span>
      <label class="mx-ctl">hops <select id="sys-hops">${[1, 2, 3].map((n) => `<option value="${n}"${n === maxHops ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="mx-ctl"><input type="checkbox" id="sys-hull"${requireHull ? " checked" : ""}> trading hull yard only</label>
    </div>
    <div class="mx-purpose">Where a local-only trader could work: each system is scored on its same-system routes (buy and sell both inside it), its distance in gate hops from our ships, and whether a yard there sells a trading hull. Systems we already trade in stay listed, since a local trader can work alongside the cross-system fleet there. Unsurveyed systems need a ship to visit before they can be scored.</div>
    <div class="mx-note" id="sys-note"></div>
    <div id="sys-body"></div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  root.querySelector("#sys-hops").addEventListener("change", (e) => { maxHops = Number(e.target.value); lsSet("systemsMaxHops", String(maxHops)); load(); });
  root.querySelector("#sys-hull").addEventListener("change", (e) => { requireHull = e.target.checked; lsSet("systemsRequireHull", requireHull ? "1" : "0"); load(); });

  async function load() {
    try {
      data = await api("GET", `/api/ops/systems_candidates?maxHops=${maxHops}&requireHullYard=${requireHull ? 1 : 0}`);
      error = "";
    } catch (err) {
      error = err.message || String(err);
    }
    render();
  }

  function render() {
    if (error) { $("sys-note").textContent = error; return; }
    if (!data) { $("sys-note").textContent = "Loading…"; return; }
    const v = data.verdicts;
    const cands = v.filter((x) => x.status === "candidate");
    const surveys = v.filter((x) => x.status === "unsurveyed");
    const out = v.filter((x) => x.status === "excluded");
    $("sys-note").textContent = `${cands.length} candidate${cands.length === 1 ? "" : "s"} · ${surveys.length} to survey · ${out.length} excluded · updated ${new Date(data.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Advisory only: nothing is moved or bought.`;
    $("sys-body").innerHTML = `
      <div class="panel"><div class="panel-h"><span class="title">Candidates</span><span class="count">best place for a local trader first</span></div><div class="panel-b">${cands.map(row).join("") || `<div class="empty">No system meets the criteria right now.</div>`}</div></div>
      <div class="panel"><div class="panel-h"><span class="title">To survey</span><span class="count">markets and yards unknown until a ship visits</span></div><div class="panel-b">${surveys.map(row).join("") || `<div class="empty">Nothing waiting to be surveyed within ${maxHops} hop${maxHops === 1 ? "" : "s"}.</div>`}</div></div>
      <details class="panel"><summary class="panel-h"><span class="title">Excluded (${out.length})</span></summary><div class="panel-b">${out.map(row).join("") || `<div class="empty">None.</div>`}</div></details>`;
  }

  return {
    show() {
      showing = true;
      load();
      clearInterval(timer);
      timer = setInterval(() => { if (showing) load(); }, REFRESH_MS);
    },
    hide() {
      showing = false;
      clearInterval(timer);
      timer = null;
    },
  };
}
