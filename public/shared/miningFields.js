/**
 * Mining fields table: every minable asteroid with what our surveys say it holds, sortable by any column. Reads the
 * `mining_fields` ops tool (GET /api/ops/mining_fields). The sorting lives in miningSort.js (no imports, so it can be tested).
 */
import { escapeHtml, shortWp } from "/shared/domain.js";
import { shareGoods, sortFieldRows, heat, shareOf } from "/shared/miningSort.js";

const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private window: fine */ } };

export function mountMiningFields(root, { api } = {}) {
  let data = null;
  let sortKey = lsGet("miningSortKey", "surveys");
  let sortDir = lsGet("miningSortDir", "desc");
  let target = lsGet("miningTarget", "");
  let loading = false;
  let error = "";

  root.innerHTML = `<div class="panel">
    <div class="panel-h"><span class="dot"></span><span class="title">Mining fields</span>
      <input id="mf-target" class="field-input" placeholder="distance to… e.g. X1-CM13-H57" style="max-width:240px" aria-label="Distance to waypoint">
      <span class="count" id="mf-note"></span></div>
    <div class="panel-b" style="padding:0;overflow:auto" id="mf-table"></div>
  </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  $("mf-target").value = target;

  function render() {
    $("mf-note").textContent = error || (data ? `${data.fields.length} fields · ${data.unsurveyed.length} never surveyed · shares are % of listed deposits` : "");
    if (!data) { $("mf-table").innerHTML = `<div class="empty">${error ? escapeHtml(error) : "Loading…"}</div>`; return; }
    const goods = shareGoods(data.fields);
    const rows = sortFieldRows(data.fields, sortKey, sortDir);
    const arrow = (k) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");
    const th = (k, label, title = "") => `<th data-sort="${escapeHtml(k)}" class="mf-sort" title="${escapeHtml(title || "Sort by " + label)}">${escapeHtml(label)}${arrow(k)}</th>`;
    const head = `<tr>${th("waypoint", "Field")}${th("distance", target ? `Dist → ${shortWp(target)}` : "Dist")}${th("surveys", "Surveys")}${goods.map((g) => th(`share:${g}`, g.replace(/_ORE$/, "").replace(/_/g, " "), `${g}: share of listed deposits`)).join("")}${th("miners", "On it")}<th>Traits</th></tr>`;
    const body = rows.map((r) => {
      const cells = goods.map((g) => {
        const p = shareOf(r, g);
        return `<td class="mono" style="text-align:right;${p ? `background:rgba(255,170,40,${heat(p).toFixed(2)})` : ""}">${r.surveyed ? (p ? `${p}%` : "·") : ""}</td>`;
      }).join("");
      const on = [...(r.miners ?? []).map((m) => m), ...(r.feeds ?? []).map((f) => `feed ${f.good}`)];
      return `<tr>
        <td><span class="shipsym">${escapeHtml(shortWp(r.waypoint))}</span> <span class="dim" style="font-size:10px">${escapeHtml(r.type === "ENGINEERED_ASTEROID" ? "eng." : "")}</span></td>
        <td class="mono" style="text-align:right">${r.distanceToTarget ?? "—"}</td>
        <td class="mono" style="text-align:right" title="${r.reliable ? "enough surveys to trust" : r.surveyed ? "few surveys: the shares move a lot with each new one" : "never surveyed"}">${r.surveys}${r.surveyed && !r.reliable ? " ⚠" : ""}${!r.surveyed ? " —" : ""}</td>
        ${cells}
        <td class="mono" title="${escapeHtml(on.join(", "))}">${(r.miners ?? []).length ? `${r.miners.length} ⛏` : ""}${(r.feeds ?? []).length ? ` ${r.feeds.length} feed` : ""}</td>
        <td class="dim" style="font-size:10px">${escapeHtml((r.traits ?? []).map((t) => t.replace(/_DEPOSITS$/, "").replace(/_/g, " ").toLowerCase()).join(", "))}</td>
      </tr>`;
    }).join("");
    $("mf-table").innerHTML = `<table class="mf"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      data = await api("GET", `/api/ops/mining_fields${target ? `?target=${encodeURIComponent(target)}` : ""}`);
      error = "";
    } catch (err) {
      error = `Could not load fields: ${err.message}`;
    } finally {
      loading = false;
      render();
    }
  }

  $("mf-table").addEventListener("click", (e) => {
    const h = e.target.closest("th[data-sort]");
    if (!h) return;
    const k = h.dataset.sort;
    if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = k; sortDir = k === "waypoint" || k === "distance" ? "asc" : "desc"; }
    lsSet("miningSortKey", sortKey); lsSet("miningSortDir", sortDir);
    render();
  });
  $("mf-target").addEventListener("change", (e) => {
    target = e.target.value.trim().toUpperCase();
    lsSet("miningTarget", target);
    load();
  });

  return { show() { render(); load(); } };
}
