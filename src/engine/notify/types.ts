/**
 * Notifications: what happened that is worth a person's attention, and who gets told.
 *
 * Three small pieces, each replaceable on its own (see docs/notifications.md):
 *  - a DETECTOR reads a snapshot of the fleet and returns events (detectors.ts);
 *  - a CATEGORY says what kind of thing an event is, whether it is on by default and how often a standing condition may
 *    repeat (categories.ts);
 *  - the POLICY decides, per device, what is actually sent: dedupe, quiet hours, switches, hourly cap (policy.ts).
 * A CHANNEL (web push today, Discord or e-mail later) only delivers what the policy lets through (service.ts).
 *
 * Everything in this folder except the channel is pure: no clock, no I/O, no globals.
 */

export type Severity = "critical" | "warning" | "info";
export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export interface NotifyEvent {
  /** Identity of the condition. The same key is the same alert: it is not sent again until its cooldown passes. */
  key: string;
  /** A registered category id (categories.ts). */
  category: string;
  severity: Severity;
  title: string;
  /** Short text. No credit figures or tokens: push payloads pass through the platform's servers. */
  body: string;
  /** Where tapping it goes, relative to the app. Defaults to the app's home. */
  url?: string;
  /** The number to show on the app icon when this arrives: how many things need a person right now (badge.ts). */
  badge?: number;
  /** Notification tag when it should differ from the key: the same tag replaces the earlier notification instead of stacking (the status report). */
  tag?: string;
  /** Set on a scheduled report: its hour number (hours since the epoch). A device that wants a report every N hours takes the ones where slot % N is 0. */
  slot?: number;
  /** Set on a digest: the keys of the events it stands for, so a failed send can un-record each of them. */
  members?: string[];
}

/** A small, read-only picture of the fleet at one moment, filled by the caller from what the engine already has. */
export interface NotifySnapshot {
  now: number;
  approvals: { id: string; kind: string; shipSymbol: string | null; /** When the engine gives up waiting and applies its default, ISO. */ expiresAt?: string | null }[];
  stranded: { symbol: string }[];
  /** Traders that have had no route for a while (idleTraders.ts), already past the alert threshold. */
  idle?: { symbol: string; idleMs: number; waypoint?: string }[];
  attention: { ship: string; severity: Severity; reasons: { text: string; severity: Severity }[] }[];
  /** Milliseconds until the weekly universe reset; undefined when not known. */
  msToReset?: number;
  /** Trading pace, credits per hour. The rate alert compares the two against each other; the status report shows them. */
  rate?: { perHour1h: number; perHour3h: number };
  /** What the status report says besides the rate: hulls in the fleet and the wallet. */
  status?: { ships: number; credits: number };
}

export interface Detector {
  id: string;
  /** The category its events carry; every event from this detector uses it. */
  category: string;
  detect(snapshot: NotifySnapshot): NotifyEvent[];
}

export interface CategoryDef {
  id: string;
  label: string;
  description: string;
  /** On for a device that has not chosen. */
  defaultOn: boolean;
  /** Minutes before a condition that is still true is announced again; 0 = once, until it clears and returns. */
  cooldownMin: number;
}

export interface QuietHours {
  /** Minutes after local midnight, 0-1439. start > end wraps past midnight (22:00 to 07:00). */
  startMin: number;
  endMin: number;
  /** The device's offset from UTC in minutes, east positive (the browser's -getTimezoneOffset()). */
  tzOffsetMin: number;
  /** Critical events still come through during quiet hours. */
  allowCritical: boolean;
}

/** One device's choices. Missing categories fall back to the registry's default. */
export interface NotifyPrefs {
  enabled: boolean;
  categories: Record<string, boolean>;
  quietHours?: QuietHours;
  /** At most this many messages an hour. */
  maxPerHour: number;
  /** A status report every this many hours (1, 3, 6 or 12) when the category is on; absent = every hour. */
  statusEveryHours?: number;
}

export const DEFAULT_PREFS: NotifyPrefs = { enabled: true, categories: {}, maxPerHour: 6 };

/** What a device has already been told, so the next pass does not repeat it. Plain data: it is saved between passes. */
export interface DeliveryState {
  /** key -> when it was last announced, ms. Only keys still true are kept, so a condition that clears and returns is announced again. */
  sent: Record<string, number>;
  /** When recent messages went out, ms, for the hourly cap. */
  recent: number[];
  /** True once the device has been brought up to date silently (what was already true when it joined is not announced). */
  seeded?: boolean;
}

export const EMPTY_STATE: DeliveryState = { sent: {}, recent: [] };
