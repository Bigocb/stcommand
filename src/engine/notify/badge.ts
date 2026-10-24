import type { NotifySnapshot } from "./types.js";

/**
 * The number on the app icon: how many things need a person right now. Approvals waiting, ships stranded, traders with no route for
 * five minutes, and ships the attention feed rates critical. The open app corrects the icon to its own figure.
 */
export function needsYouCount(s: Pick<NotifySnapshot, "approvals" | "stranded" | "attention" | "idle">): number {
  return s.approvals.length + s.stranded.length + (s.idle?.length ?? 0) + s.attention.filter((a) => a.severity === "critical").length;
}
