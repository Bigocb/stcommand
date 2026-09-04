/**
 * Pure computation and formatting shared by every UI version.
 *
 * Nothing in here touches the DOM, emits markup, or reads app state — that
 * is the entry criterion, not a coincidence. Anything that renders belongs
 * to a version (v2/v3/v4/v5 each draw these values differently); anything
 * that fetches belongs to the transport layer. What is left is the maths
 * and the vocabulary, which are the same whichever way the fleet is drawn.
 *
 * shipHeadingDeg/shipTransitLerp live here rather than in a separate
 * mapmath module: they are the only genuinely map-specific pure functions
 * in the frontend. Everything else about the map is DOM-bound and stays
 * version-owned.
 */

/** Same min(frame, engine, reactor) the server uses (FleetManager.worstCondition()) — mirrored client-side since the fleet table reads straight from state.ships, not a server-computed summary. */
export function worstConditionPct(ship) {
  const parts = [ship.frame?.condition, ship.engine?.condition, ship.reactor?.condition].filter((c) => c != null);
  if (!parts.length) return null;
  return Math.round(Math.min(...parts) * 100);
}

/** Real heading in degrees for a mid-transit ship, or null (docked/orbiting,
 *  or a route missing origin/destination — an older cached snapshot from
 *  before a fresh nav). Computed from the same origin/destination points
 *  shipTransitLerp() already uses to animate position, projected through
 *  the same screen-space sx/sy the map actually draws with — not raw world
 *  coordinates — since the map's x/y scale factors aren't necessarily equal
 *  and a world-space angle can point subtly wrong once drawn. +90 corrects
 *  for the hull path's own tip sitting at (0,-2.6): "up" at rot=0. */
export function shipHeadingDeg(ship, sx, sy) {
  if (ship.nav.status !== "IN_TRANSIT") return null;
  const r = ship.nav.route;
  if (!r?.origin || !r?.destination) return null;
  const dx = sx(r.destination.x) - sx(r.origin.x);
  const dy = sy(r.destination.y) - sy(r.origin.y);
  if (dx === 0 && dy === 0) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI + 90;
}

/** World-space position of an in-transit ship, linearly interpolated between
 *  its route's origin and destination by elapsed time — or null for a ship
 *  that isn't traveling (or is missing route timing, e.g. an older cached
 *  state snapshot from before a fresh nav). No speed/flight-mode modeling:
 *  the API's own departureTime/arrival window already reflects whichever
 *  mode (drift/cruise/burn) the flight actually used, so lerping between
 *  the two timestamps tracks it correctly for free. */
export function shipTransitLerp(ship) {
  if (ship.nav.status !== "IN_TRANSIT") return null;
  const r = ship.nav.route;
  if (!r?.departureTime || !r?.arrival || !r.origin || !r.destination) return null;
  const t0 = new Date(r.departureTime).getTime();
  const t1 = new Date(r.arrival).getTime();
  if (!(t1 > t0)) return null;
  const frac = Math.min(1, Math.max(0, (Date.now() - t0) / (t1 - t0)));
  return {
    x: r.origin.x + (r.destination.x - r.origin.x) * frac,
    y: r.origin.y + (r.destination.y - r.origin.y) * frac,
  };
}

export function systemOf(s) {
  if (!s) return "—";
  const parts = s.split("-");
  if (parts.length >= 2) return parts.slice(0, 2).join("-");
  return s;
}

export function shortWp(s) {
  if (!s) return "—";
  const parts = s.split("-");
  return parts.slice(-1)[0];
}

export function abbrev(s) {
  if (!s) return "?";
  return s.split("_").map((p) => p[0]).join("").slice(0, 3).toUpperCase();
}

/** "3m ago" / "1h 12m ago" — relative-time formatting for fire-log timestamps. */
export function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

export function countdown(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export function roleMismatchReason(role, ship) {
  const mountSymbols = (ship.mounts ?? []).map((m) => m.symbol);
  const frame = ship.frame?.symbol ?? "";
  if (role === "miner" && !mountSymbols.some((s) => s.startsWith("MOUNT_MINING_LASER"))) return "no mining laser mounted";
  if (role === "surveyor" && !mountSymbols.some((s) => s.startsWith("MOUNT_SURVEYOR"))) return "no surveyor mounted";
  if (role === "siphoner" && !mountSymbols.some((s) => s.startsWith("MOUNT_GAS_SIPHON"))) return "no gas siphon mounted";
  if (role === "tour" && frame !== "FRAME_SHUTTLE" && ship.registration?.role !== "COMMAND") return "not a shuttle or command frame";
  if (role === "keeper" && ship.registration?.role !== "SATELLITE" && frame !== "FRAME_PROBE") return "not a probe/satellite hull";
  if (role === "trader" && (ship.cargo?.capacity ?? 0) < 15) return "cargo capacity under 15";
  return null;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Same escaping, named for use inside attribute values. */
export const escapeAttr = escapeHtml;

export const fmt = (n) => Math.round(n ?? 0).toLocaleString("en-US");

export const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n ?? 0));

export const fmtTime = (iso) => {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false });
};

/** Human age of a timestamp: "3m", "2h", "5d". */
export const fmtAge = (iso) => {
  if (!iso) return "?";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
};
