import { CATEGORIES } from "./categories.js";
import { DEFAULT_PREFS, type NotifyPrefs, type QuietHours } from "./types.js";

/**
 * Turn whatever a device sent into prefs the policy can trust. Unknown categories are dropped, numbers are clamped, and
 * anything malformed falls back to the default, so a bad request can narrow nothing and break nothing.
 */

const int = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
};

function sanitizeQuiet(v: unknown): QuietHours | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const startMin = int(o.startMin, 0, 1439);
  const endMin = int(o.endMin, 0, 1439);
  const tzOffsetMin = int(o.tzOffsetMin, -840, 840);
  if (startMin === undefined || endMin === undefined || tzOffsetMin === undefined) return undefined;
  return { startMin, endMin, tzOffsetMin, allowCritical: o.allowCritical !== false };
}

export function sanitizePrefs(input: unknown): Partial<NotifyPrefs> {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const out: Partial<NotifyPrefs> = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (o.categories && typeof o.categories === "object") {
    const known = new Set(CATEGORIES.map((c) => c.id));
    const cats: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o.categories as Record<string, unknown>)) if (known.has(k) && typeof v === "boolean") cats[k] = v;
    out.categories = cats;
  }
  if ("quietHours" in o) {
    const q = sanitizeQuiet(o.quietHours);
    if (q) out.quietHours = q;
  }
  const cap = int(o.maxPerHour, 1, 60);
  if (cap !== undefined) out.maxPerHour = cap;
  const every = typeof o.statusEveryHours === "number" ? o.statusEveryHours : typeof o.statusEveryHours === "string" ? Number(o.statusEveryHours) : NaN;
  if ([1, 3, 6, 12].includes(every)) out.statusEveryHours = every;
  return out;
}

/** What the policy sees: the device's choices over the defaults. `quietHours: null` in a saved choice cannot occur; absent means none. */
export function effectivePrefs(saved: Partial<NotifyPrefs>): NotifyPrefs {
  return { ...DEFAULT_PREFS, ...saved };
}

/** A push subscription as a browser's PushSubscription.toJSON() gives it, checked for the shape and size we store. */
export function sanitizeSubscription(input: unknown): { endpoint: string; p256dh: string; auth: string } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof o.endpoint === "string" ? o.endpoint : "";
  const p256dh = typeof o.keys?.p256dh === "string" ? o.keys.p256dh : "";
  const auth = typeof o.keys?.auth === "string" ? o.keys.auth : "";
  const b64url = /^[A-Za-z0-9_-]+={0,2}$/;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || endpoint.length > 1024) return undefined;
  } catch {
    return undefined;
  }
  if (!b64url.test(p256dh) || p256dh.length > 200 || !b64url.test(auth) || auth.length > 100) return undefined;
  return { endpoint, p256dh, auth };
}
