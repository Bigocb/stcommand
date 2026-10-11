/* ── Contract crew: haulers and miners for one contract delivery ───────────────────────────────────────────────
   Shared by Tower and Deck. Each delivery line of an accepted contract gets a "Crew" toggle that opens two pick lists:
   traders to haul the good (several at once; each becomes a manual contract-buy route), and, when surveys have shown the
   good as a mined deposit somewhere, miners to send after it (survey preference for the good plus, optionally, a pin to the
   field with the best share). Selection and open/closed state live here so a poll-driven re-render does not lose them. */
import { escapeHtml, escapeAttr, shortWp } from "/shared/domain.js";

const open = new Set();
const picked = new Map(); // `${key}|hauler` / `${key}|miner` -> Set of ship symbols
const fieldPick = new Map(); // key -> waypoint
let fieldsCache = { at: 0, fields: [] };

export const crewKey = (contractId, good) => `${contractId}|${good}`;

/** Field compositions from the surveys taken so far, cached for a minute (GET /api/field-composition). */
export async function loadFields(api) {
  if (Date.now() - fieldsCache.at < 60_000) return fieldsCache.fields;
  try {
    const d = await api("GET", "/api/field-composition");
    fieldsCache = { at: Date.now(), fields: d.fields ?? [] };
  } catch { /* leave the old list; the panel just shows no mining option */ }
  return fieldsCache.fields;
}
export const cachedFields = () => fieldsCache.fields;

/** Fields where the good has been seen as a deposit, best share first. */
export function fieldsFor(good, fields) {
  return fields
    .map((f) => ({ waypoint: f.waypointSymbol, count: f.counts?.[good] ?? 0, deposits: f.deposits || 0, surveys: f.surveys || 0 }))
    .filter((f) => f.count > 0)
    .map((f) => ({ ...f, share: f.deposits ? Math.round((f.count / f.deposits) * 100) : 0 }))
    .sort((a, b) => b.share - a.share);
}

const setFor = (k) => { if (!picked.has(k)) picked.set(k, new Set()); return picked.get(k); };

/** The crew toggle and, when open, the pick lists. `ctx` carries the live data the caller already has. */
export function crewHtml({ contractId, good, needed, ctx }) {
  const key = crewKey(contractId, good);
  const isOpen = open.has(key);
  const { summary = [], assignments = [], minerPrefs = [], fields = [], miners = [] } = ctx;

  const assigned = assignments.filter((a) => a.role === "contractBuy" && a.good === good).map((a) => a.shipSymbol);
  const mining = minerPrefs.filter((p) => p.good === good).map((p) => p.shipSymbol);
  const count = assigned.length + mining.length;
  const toggle = `<button class="crew-toggle" data-act="crew-toggle" data-key="${escapeAttr(key)}" aria-expanded="${isOpen}">Crew${count ? ` (${count})` : ""} ${isOpen ? "▴" : "▾"}</button>`;
  if (!isOpen) return `<div class="crew">${toggle}</div>`;

  // Haulers: traders with a hold.
  const traders = summary.filter((s) => s.role === "trader" && (s.cargoCap ?? 0) > 0);
  const haulPick = setFor(`${key}|hauler`);
  const assignedCap = traders.filter((t) => assigned.includes(t.symbol)).reduce((n, t) => n + t.cargoCap, 0);
  const haulRows = traders.length
    ? traders.map((t) => {
        const onThis = assigned.includes(t.symbol);
        const a = assignments.find((x) => x.shipSymbol === t.symbol);
        const doing = onThis ? "on this contract" : a ? `on ${a.good}` : "free";
        return `<button class="crew-ship${haulPick.has(t.symbol) ? " on" : ""}${onThis ? " mine" : ""}" data-act="crew-pick" data-kind="hauler" data-key="${escapeAttr(key)}" data-ship="${escapeAttr(t.symbol)}"><span>${escapeHtml(t.symbol)} · ${t.cargoCap}u</span><span>${escapeHtml(doing)}</span></button>`;
      }).join("")
    : '<div class="crew-empty">No traders with a hold.</div>';
  const haulActs = `<div class="crew-acts">
      <button class="crew-go" data-act="crew-assign" data-key="${escapeAttr(key)}" data-good="${escapeAttr(good)}">Assign selected</button>
      ${assigned.length ? `<button class="crew-go ghost" data-act="crew-release" data-key="${escapeAttr(key)}" data-ships="${escapeAttr(assigned.join(","))}">Release all (${assigned.length})</button>` : ""}
    </div>`;
  const haulHead = `<div class="crew-h">Haulers · ${assignedCap}u assigned of ${needed}u still needed${assignedCap > needed ? " · more than needed" : ""}</div>`;

  // Miners: only offered for a good surveys have shown as a deposit.
  const where = fieldsFor(good, fields);
  let mineHtml = "";
  if (where.length) {
    const minePick = setFor(`${key}|miner`);
    const chosenField = fieldPick.get(key) ?? where[0].waypoint;
    const fieldBtns = where.slice(0, 5).map((f) => `<button class="crew-field${f.waypoint === chosenField ? " on" : ""}" data-act="crew-field" data-key="${escapeAttr(key)}" data-field="${escapeAttr(f.waypoint)}">${escapeHtml(shortWp(f.waypoint))} · ${f.share}% (${f.surveys} surveys)</button>`).join("");
    const minerRows = miners.length
      ? miners.map((m) => {
          const pref = minerPrefs.find((p) => p.shipSymbol === m.symbol);
          const doing = pref?.good === good ? "mining this" : pref ? `prefers ${pref.good}` : m.pinnedField ? `at ${shortWp(m.pinnedField)}` : "free";
          return `<button class="crew-ship${minePick.has(m.symbol) ? " on" : ""}${pref?.good === good ? " mine" : ""}" data-act="crew-pick" data-kind="miner" data-key="${escapeAttr(key)}" data-ship="${escapeAttr(m.symbol)}"><span>${escapeHtml(m.symbol)}</span><span>${escapeHtml(doing)}</span></button>`;
        }).join("")
      : '<div class="crew-empty">No miners.</div>';
    mineHtml = `<div class="crew-h">Miners · ${escapeHtml(good)} seen in surveys at ${where.length} field${where.length === 1 ? "" : "s"}</div>
      <div class="crew-fields">${fieldBtns}</div>
      ${minerRows}
      <div class="crew-acts">
        <button class="crew-go" data-act="crew-mine" data-key="${escapeAttr(key)}" data-good="${escapeAttr(good)}" data-field="${escapeAttr(chosenField)}">Send selected to ${escapeHtml(shortWp(chosenField))}</button>
        ${mining.length ? `<button class="crew-go ghost" data-act="crew-mine-clear" data-key="${escapeAttr(key)}" data-ships="${escapeAttr(mining.join(","))}">Stop mining it (${mining.length})</button>` : ""}
      </div>`;
  } else {
    mineHtml = `<div class="crew-note">${escapeHtml(good)} is not a mined deposit in any survey so far, so there is no miner option. Scan fields to find where it occurs.</div>`;
  }
  return `<div class="crew">${toggle}<div class="crew-body">${haulHead}${haulRows}${haulActs}${mineHtml}</div></div>`;
}

/**
 * Handles a click on any crew control. Returns true when it was one (the caller then re-renders), false otherwise.
 * `reload` refreshes the data the panel reads (assignments, miner preferences, contracts).
 */
export async function crewAction(b, api, reload) {
  const act = b.dataset.act;
  if (!act?.startsWith("crew-")) return false;
  const key = b.dataset.key;
  const report = (r) => { if (r?.failed?.length) alert(r.failed.map((f) => `${f.ship}: ${f.error}`).join("\n")); };
  try {
    if (act === "crew-toggle") { open.has(key) ? open.delete(key) : open.add(key); if (open.has(key)) await loadFields(api); return true; }
    if (act === "crew-pick") { const set = setFor(`${key}|${b.dataset.kind}`); set.has(b.dataset.ship) ? set.delete(b.dataset.ship) : set.add(b.dataset.ship); return true; }
    if (act === "crew-field") { fieldPick.set(key, b.dataset.field); return true; }
    if (act === "crew-assign") {
      const ships = [...setFor(`${key}|hauler`)];
      if (!ships.length) { alert("Pick one or more traders first."); return true; }
      b.disabled = true;
      report(await api("POST", "/api/contracts/assign", { shipSymbols: ships, tradeSymbol: b.dataset.good }));
      picked.delete(`${key}|hauler`);
    } else if (act === "crew-release") {
      b.disabled = true;
      report(await api("POST", "/api/contracts/assign", { shipSymbols: b.dataset.ships.split(","), clear: true }));
    } else if (act === "crew-mine") {
      const ships = [...setFor(`${key}|miner`)];
      if (!ships.length) { alert("Pick one or more miners first."); return true; }
      b.disabled = true;
      report(await api("POST", "/api/contracts/miners", { shipSymbols: ships, tradeSymbol: b.dataset.good, field: b.dataset.field }));
      picked.delete(`${key}|miner`);
    } else if (act === "crew-mine-clear") {
      b.disabled = true;
      report(await api("POST", "/api/contracts/miners", { shipSymbols: b.dataset.ships.split(","), clear: true }));
    } else return false;
    await reload();
  } catch (err) { alert(err.message); }
  return true;
}
