import type { NotifyEvent, NotifySnapshot } from "./types.js";
import { needsYouCount } from "./badge.js";

/**
 * The scheduled status report: one short message a device asks for every N hours. Pure: it reads a snapshot and the clock
 * and writes the text; when it is sent, and to whom, is the policy's business (policy.ts, `slot`).
 */

/** 7,361,000 -> "7.4M", 950,000 -> "950k", -240,000 -> "-240k". */
export function compactCredits(n: number): string {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${sign}${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${sign}${Math.round(v / 1_000)}k`;
  return `${sign}${Math.round(v)}`;
}

/** The report for this hour, or nothing when the snapshot has no figures to report. */
export function statusEvents(s: NotifySnapshot): NotifyEvent[] {
  const parts: string[] = [];
  if (s.rate) parts.push(`${s.rate.perHour1h >= 0 ? "+" : ""}${compactCredits(s.rate.perHour1h)}/hr (3h avg ${compactCredits(s.rate.perHour3h)})`);
  if (s.status) {
    parts.push(`${s.status.ships} ships`);
    parts.push(`${compactCredits(s.status.credits)} credits`);
  }
  if (!parts.length) return [];
  const need = needsYouCount(s);
  parts.push(need > 0 ? `${need} need you` : "all clear");
  const slot = Math.floor(s.now / 3_600_000);
  return [{ key: `status:${slot}`, tag: "status", slot, category: "status", severity: "info", title: "Tower status", body: parts.join(" · "), url: "/m#home" }];
}
