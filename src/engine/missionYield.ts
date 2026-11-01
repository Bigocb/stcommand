/**
 * Yield mode for a construction mission (MissionPacing.yieldToTrading): the mission only holds a trader while it can actually buy.
 *
 * A gate mission's carrier used to sit docked at the producer, waiting for the ask to fall to the price ceiling, while the
 * fleet had good routes and no free ship (2026-11-01: THEOREM-1 idle for two hours behind FAB_MATS 2,485c over a 2,000c max, with 14
 * routes listed and one trader flying). With the mode on: when at least one outstanding material can be bought at or under its
 * ceiling the mission takes the next free trader, and when none can it gives the carrier back to trading.
 *
 * Pure: no I/O, no clock. The caller passes the cheapest quote for each material and the times, and gets a decision and a
 * one-line reason back.
 */
import { maxPriceFor, type CeilingPacing } from "./missionCeiling.js";

/** A ship stays on the mission at least this long once taken, so a price hovering at the ceiling does not swap it every minute. */
export const YIELD_MIN_HOLD_MS = 10 * 60_000;
/** After the mission gives a ship back it takes none for this long, for the same reason. */
export const YIELD_MIN_FREE_MS = 5 * 60_000;

export interface YieldMaterial {
  tradeSymbol: string;
  required: number;
  fulfilled: number;
}

/** The cheapest ask known for a material in the mission's system; undefined when there is no quote at all. */
export interface YieldQuote {
  material: string;
  ask: number | undefined;
}

export type YieldDecision =
  /** At least one outstanding material is at or under its ceiling: the mission wants a ship. */
  | "run"
  /** Nothing outstanding can be bought now and every price is known: give the carrier back. */
  | "yield"
  /** Some price is unknown, so say nothing and change nothing (never release on missing data). */
  | "hold";

export interface YieldView {
  decision: YieldDecision;
  /** One line for the mission card and the log. */
  reason: string;
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

export function missionYieldView(
  materials: readonly YieldMaterial[],
  pacing: (CeilingPacing & { onlyMaterials?: readonly string[] }) | null | undefined,
  quotes: readonly YieldQuote[],
): YieldView {
  const only = pacing?.onlyMaterials;
  const outstanding = materials.filter((m) => m.fulfilled < m.required && (!only?.length || only.includes(m.tradeSymbol)));
  if (outstanding.length === 0) return { decision: "run", reason: "nothing outstanding to decide on" };
  const ok: string[] = [];
  const over: string[] = [];
  const unknown: string[] = [];
  for (const m of outstanding) {
    const ask = quotes.find((q) => q.material === m.tradeSymbol)?.ask;
    if (ask === undefined || !(ask > 0)) { unknown.push(m.tradeSymbol); continue; }
    const ceiling = maxPriceFor(pacing, m.tradeSymbol);
    // No absolute ceiling set: this mode has no price to compare with, so the material counts as buyable (the percentage guard still applies at purchase).
    if (ceiling === undefined || ask <= ceiling) ok.push(ceiling === undefined ? `${m.tradeSymbol} ${fmt(ask)}` : `${m.tradeSymbol} ${fmt(ask)} within ${fmt(ceiling)}`);
    else over.push(`${m.tradeSymbol} ${fmt(ask)} over ${fmt(ceiling)}`);
  }
  if (ok.length) return { decision: "run", reason: `can buy: ${ok.join(", ")}` };
  if (unknown.length) return { decision: "hold", reason: `no price for ${unknown.join(", ")}${over.length ? `; ${over.join(", ")}` : ""}` };
  return { decision: "yield", reason: over.join("; ") };
}

/** May a carrier taken at `takenAt` be given back now? */
export function mayRelease(now: number, takenAt: number, minHoldMs = YIELD_MIN_HOLD_MS): boolean {
  return now - takenAt >= minHoldMs;
}

/** May the mission take a ship now, given when it last gave one back (undefined = never)? */
export function mayTake(now: number, releasedAt: number | undefined, minFreeMs = YIELD_MIN_FREE_MS): boolean {
  return releasedAt === undefined || now - releasedAt >= minFreeMs;
}
