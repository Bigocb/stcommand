import type { NotifySnapshot } from "./types.js";

/**
 * The number on the app icon: how many things need a person right now. Approvals waiting, ships stranded, and ships the
 * attention feed rates critical. Tower's own "N need you" also counts traders with no route, which only the open app can
 * work out, so the app corrects the icon to its own figure whenever it is open.
 */
export function needsYouCount(s: Pick<NotifySnapshot, "approvals" | "stranded" | "attention">): number {
  return s.approvals.length + s.stranded.length + s.attention.filter((a) => a.severity === "critical").length;
}
