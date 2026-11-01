/**
 * Per-item fields on a construction mission's pacing form (Tower and Deck): a max price and a lot size for each material, which
 * override the mission-wide max price and lot for that material only (server: MissionPacing.maxPriceBy / buyLotUnitsBy).
 * Plain browser module with no DOM calls of its own beyond the card it is handed, so it can be tested with a small stand-in.
 */

/** The materials to show a pair of boxes for, with the values now on the mission: the ones still outstanding, plus any that has a value set. */
export function perItemMaterials(mission) {
  const pacing = mission?.pacing ?? {};
  return (mission?.materials ?? [])
    .filter((m) => m.fulfilled < m.required || pacing.maxPriceBy?.[m.tradeSymbol] !== undefined || pacing.buyLotUnitsBy?.[m.tradeSymbol] !== undefined)
    .map((m) => ({ material: m.tradeSymbol, max: pacing.maxPriceBy?.[m.tradeSymbol] ?? "", lot: pacing.buyLotUnitsBy?.[m.tradeSymbol] ?? "" }));
}

/** Read the per-item boxes of a pacing card: [{ material, max, lot }] with the raw box text. */
export function readPerItemRows(card) {
  const rows = new Map();
  for (const el of card.querySelectorAll(".mpb-max, .mpb-lot")) {
    const material = el.dataset.mat;
    if (!material) continue;
    const row = rows.get(material) ?? { material, max: "", lot: "" };
    if (el.classList.contains("mpb-max")) row.max = el.value; else row.lot = el.value;
    rows.set(material, row);
  }
  return [...rows.values()];
}

const toNumberOrNull = (v) => {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * The part of the pacing request the per-item boxes make. A filled box sets that material's value, a blank one clears it (null),
 * the same rule as every other pacing box. With no boxes on the card it is empty, so the request leaves per-item settings alone.
 */
export function perItemPatch(rows) {
  const maxPriceBy = {};
  const buyLotUnitsBy = {};
  for (const r of rows ?? []) {
    const material = String(r?.material ?? "").trim().toUpperCase();
    if (!material) continue;
    maxPriceBy[material] = toNumberOrNull(r.max);
    buyLotUnitsBy[material] = toNumberOrNull(r.lot);
  }
  return Object.keys(maxPriceBy).length ? { maxPriceBy, buyLotUnitsBy } : {};
}
