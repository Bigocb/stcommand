/** Shared between resolveTenant.ts and gate.ts so the cookie name/shape can't drift between where it's set and where it's read. */
export const SESSION_COOKIE_NAME = "st_session";

export const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches tenants.ts's DEFAULT_SESSION_TTL_MS
