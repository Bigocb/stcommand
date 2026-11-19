/**
 * The fleet's short-lived decision memory, saved across a restart (fleet flag `fleetShortMemory`).
 *
 * Operator rule (2026-11-19, repeated): nothing a decision depends on may live only in memory. Two maps did:
 * - `queueTourSentAt`: when the fresh-system tour queue sent each ship. It decides the minimum stay before a ship is moved
 *   on and whether a destination is the queue's own (2026-11-17 a restart forgot it and every tour ship was locked out
 *   for 10 hours).
 * - `keeperYardPaid`: the last price really paid for a hull at a yard, which raises the keeper price the auto-approve cap
 *   checks for an hour after a purchase.
 *
 * Pure: no I/O, no clock (the caller passes `now`). Rows too old to matter and malformed rows are skipped.
 */

import type { PaidPrice } from "./keeperYardPrice.js";

export interface FleetMemory { tourSent: [string, number][]; yardPaid: [string, PaidPrice][] }

/** Tour send marks older than this no longer change any decision (the queue's minimum stay is 20 min; a day is generous). */
export const TOUR_SENT_KEEP_MS = 24 * 3_600_000;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;

export function packFleetMemory(m: FleetMemory, now: number, yardPaidKeepMs: number): string {
  return JSON.stringify({
    tourSent: m.tourSent.filter(([, at]) => at >= now - TOUR_SENT_KEEP_MS),
    yardPaid: m.yardPaid.filter(([, p]) => p.at >= now - yardPaidKeepMs),
  });
}

export function unpackFleetMemory(json: string, now: number, yardPaidKeepMs: number): FleetMemory {
  let o: { tourSent?: unknown; yardPaid?: unknown };
  try { o = JSON.parse(json) ?? {}; } catch { return { tourSent: [], yardPaid: [] }; }
  const tourSent: [string, number][] = [];
  for (const r of Array.isArray(o.tourSent) ? o.tourSent : []) {
    if (Array.isArray(r) && isStr(r[0]) && isNum(r[1]) && r[1] >= now - TOUR_SENT_KEEP_MS && r[1] <= now) tourSent.push([r[0], r[1]]);
  }
  const yardPaid: [string, PaidPrice][] = [];
  for (const r of Array.isArray(o.yardPaid) ? o.yardPaid : []) {
    if (!Array.isArray(r) || !isStr(r[0])) continue;
    const p = r[1] as Partial<PaidPrice>;
    if (p && isNum(p.price) && p.price > 0 && isNum(p.at) && p.at >= now - yardPaidKeepMs && p.at <= now) yardPaid.push([r[0], { price: p.price, at: p.at }]);
  }
  return { tourSent, yardPaid };
}
