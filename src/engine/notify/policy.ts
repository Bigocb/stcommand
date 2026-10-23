import { CATEGORIES, categoryOf } from "./categories.js";
import { SEVERITY_RANK, type CategoryDef, type DeliveryState, type NotifyEvent, type NotifyPrefs, type QuietHours, type Severity } from "./types.js";

/**
 * What one device is actually sent. Pure: the caller passes the events found this pass, what the device was already told,
 * its choices and the clock, and gets back what to send, what was held back and why, and the new state to keep.
 *
 * Rules, in order, for each event:
 *  1. the device has notifications on, and the event's category is on for it (its choice, else the category default);
 *  2. quiet hours hold everything but critical events when the device allows those through;
 *  3. an event already announced is held until its category's cooldown passes (0: until the condition clears and returns);
 *  4. the hourly cap holds the rest.
 * Anything held for rules 1, 2 or 4 is not recorded as sent, so it still goes out once the hold lifts if it is still true.
 * Three or more events of one category in a pass go as a single digest message.
 */

export interface DecideOptions {
  /** Record what would be sent as sent, and send nothing. The first pass after a restart uses it, so standing conditions are not announced again. */
  seedOnly?: boolean;
  /** Events of one category at or above this count are sent as one digest. */
  digestAt?: number;
  /** Category definitions; defaults to the registry. */
  categories?: readonly CategoryDef[];
}

export interface Decision {
  send: NotifyEvent[];
  held: { key: string; reason: string }[];
  state: DeliveryState;
}

const DAY_MIN = 1440;

/** Is this moment inside the device's quiet hours? */
export function inQuietHours(nowMs: number, q: QuietHours): boolean {
  if (q.startMin === q.endMin) return false;
  const local = (((Math.floor(nowMs / 60_000) + q.tzOffsetMin) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return q.startMin < q.endMin ? local >= q.startMin && local < q.endMin : local >= q.startMin || local < q.endMin;
}

export function categoryEnabled(prefs: NotifyPrefs, category: string, categories: readonly CategoryDef[] = CATEGORIES): boolean {
  const chosen = prefs.categories[category];
  if (chosen !== undefined) return chosen;
  return (categories.find((c) => c.id === category) ?? categoryOf(category))?.defaultOn ?? false;
}

const maxSeverity = (events: readonly NotifyEvent[]): Severity => events.reduce<Severity>((m, e) => (SEVERITY_RANK[e.severity] > SEVERITY_RANK[m] ? e.severity : m), "info");

export function decide(events: readonly NotifyEvent[], state: DeliveryState, prefs: NotifyPrefs, now: number, opts: DecideOptions = {}): Decision {
  const categories = opts.categories ?? CATEGORIES;
  const digestAt = opts.digestAt ?? 3;
  const held: { key: string; reason: string }[] = [];
  const nextSent: Record<string, number> = {};
  const eligible: NotifyEvent[] = [];
  const hourAgo = now - 3_600_000;
  let recent = state.recent.filter((t) => t > hourAgo);
  const quiet = prefs.quietHours && inQuietHours(now, prefs.quietHours);

  // Standing conditions keep their announced time; anything that has cleared drops out of the state.
  for (const e of events) if (state.sent[e.key] !== undefined) nextSent[e.key] = state.sent[e.key]!;

  for (const e of events) {
    if (!prefs.enabled) { held.push({ key: e.key, reason: "notifications are off" }); continue; }
    if (!categoryEnabled(prefs, e.category, categories)) { held.push({ key: e.key, reason: `${e.category} is off` }); continue; }
    if (quiet && !(e.severity === "critical" && prefs.quietHours!.allowCritical)) { held.push({ key: e.key, reason: "quiet hours" }); continue; }
    const last = state.sent[e.key];
    if (last !== undefined) {
      const cooldown = (categories.find((c) => c.id === e.category)?.cooldownMin ?? 0) * 60_000;
      if (cooldown === 0 || now - last < cooldown) { held.push({ key: e.key, reason: "already announced" }); continue; }
    }
    eligible.push(e);
  }

  // The hourly cap, most severe first so a flood of minor events cannot crowd out a critical one.
  eligible.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const room = Math.max(0, prefs.maxPerHour - recent.length);
  const going: NotifyEvent[] = [];
  for (const e of eligible) {
    if (going.length >= room && !opts.seedOnly) { held.push({ key: e.key, reason: "hourly limit" }); continue; }
    going.push(e);
  }
  for (const e of going) nextSent[e.key] = now;

  if (opts.seedOnly) return { send: [], held, state: { sent: nextSent, recent } };

  // Digest: a pass that finds many of one kind says so once.
  const send: NotifyEvent[] = [];
  const byCat = new Map<string, NotifyEvent[]>();
  for (const e of going) (byCat.get(e.category) ?? byCat.set(e.category, []).get(e.category)!).push(e);
  for (const [cat, list] of byCat) {
    if (list.length >= digestAt) {
      const label = categories.find((c) => c.id === cat)?.label ?? cat;
      send.push({
        key: `digest:${cat}`,
        category: cat,
        severity: maxSeverity(list),
        title: `${list.length} alerts: ${label}`,
        body: list.slice(0, 3).map((e) => e.title).join(" · ") + (list.length > 3 ? ` · +${list.length - 3} more` : ""),
        url: list[0]!.url,
        members: list.map((e) => e.key),
      });
    } else send.push(...list);
  }
  // A digest counts as one message against the cap.
  recent = [...recent, ...send.map(() => now)];
  return { send, held, state: { sent: nextSent, recent } };
}
