import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { perItemMaterials, readPerItemRows, perItemPatch } from "../public/shared/missionPerItem.js";

const el = (cls: string, mat: string, value: string) => ({ classList: { contains: (c: string) => c === cls }, dataset: { mat }, value });
const card = (els: unknown[]) => ({ querySelectorAll: () => els });

test("perItemMaterials lists outstanding materials with current values", () => {
  const rows = perItemMaterials({
    materials: [
      { tradeSymbol: "FAB_MATS", required: 10, fulfilled: 10 },
      { tradeSymbol: "ADVANCED_CIRCUITRY", required: 5, fulfilled: 0 },
    ],
    pacing: { maxPriceBy: { ADVANCED_CIRCUITRY: 4000 }, buyLotUnitsBy: { FAB_MATS: 7 } },
  });
  assert.deepEqual(rows, [
    { material: "FAB_MATS", max: "", lot: 7 },
    { material: "ADVANCED_CIRCUITRY", max: 4000, lot: "" },
  ]);
});

test("readPerItemRows and perItemPatch: filled sets, blank clears", () => {
  const rows = readPerItemRows(card([el("mpb-max", "ADVANCED_CIRCUITRY", "4000"), el("mpb-lot", "ADVANCED_CIRCUITRY", "10"), el("mpb-max", "FAB_MATS", ""), el("mpb-lot", "FAB_MATS", "")]));
  assert.deepEqual(perItemPatch(rows), {
    maxPriceBy: { ADVANCED_CIRCUITRY: 4000, FAB_MATS: null },
    buyLotUnitsBy: { ADVANCED_CIRCUITRY: 10, FAB_MATS: null },
  });
});

test("no boxes leaves per-item settings alone", () => {
  assert.deepEqual(perItemPatch(readPerItemRows(card([]))), {});
});
