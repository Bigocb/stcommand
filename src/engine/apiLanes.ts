import { maskProxyUrl } from "./crawlerProxy.js";

/**
 * API lanes: send the calls nothing waits on through a second IP.
 *
 * SpaceTraders limits by source IP (2 a second, burst 30), and this box's one IP is full: about 104 of 105 calls a minute, with the
 * keepers' market reads (about 28% of calls) queueing 3-4 s and 429s at 2-6 a minute (2026-11-06). The calls split cleanly by what
 * waits on them:
 *   - Priority 1-2 (a trade, a jump, a dock, a ship's own state): a ship sits idle with cargo until they answer, and most change
 *     the game. They stay on the box's IP, which is known to work.
 *   - Priority 3-4 (keeper market and shipyard reads, remote surveys, fleet-state refreshes, telemetry) that are GETs: read-only,
 *     safe to repeat, and can wait. These can leave from a proxy's IP with a limiter of its own.
 * A request is never moved because of its ship, its tenant or a round-robin: a trader's buy going through a slow proxy mid-trade is
 * the bad case, and splitting by what the call does avoids it.
 *
 * Pure: a request in, a lane out. Policy is data (the doctrine clause apiLaneProxy); with it off, or no proxy configured, every
 * request takes the box lane, which is today's behaviour. The proxy lane falls back to the box lane when the proxy fails (a
 * breaker stops sending to a proxy that keeps failing, so reads do not sit on 20-second timeouts).
 */

export type Lane = "box" | "proxy";

export interface LanePolicy {
  enabled: boolean;
  /** Requests at this priority or lower urgency (a higher number) may use the proxy lane. 3 = deferrable and background. */
  minPriority: number;
}

export const LANES_OFF: LanePolicy = { enabled: false, minPriority: 3 };

export interface LaneRequest {
  /** The limiter priority the call asked for: 0 boot, 1 critical, 2 routine, 3 deferrable, 4 background. */
  priority: number;
  method: string;
}

/** The lane for one request. Boot (0) and every write stay on the box. */
export function chooseLane(req: LaneRequest, policy: LanePolicy): Lane {
  if (!policy.enabled) return "box";
  if (req.method.toUpperCase() !== "GET") return "box";
  if (req.priority <= 0) return "box";
  return req.priority >= policy.minPriority ? "proxy" : "box";
}

export interface BreakerPolicy {
  /** Consecutive failures that open the breaker. */
  failures: number;
  /** How long it stays open before one trial request is let through, ms. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = { failures: 3, cooldownMs: 120_000 };

/**
 * Stops sending to a proxy that keeps failing. `failures` in a row open it for `cooldownMs`; then one request is let through, and
 * its outcome closes the breaker (success) or re-opens it (failure). Pure: every method takes the time it needs.
 */
export class LaneBreaker {
  private consecutive = 0;
  private openUntil = 0;
  constructor(private readonly policy: BreakerPolicy = DEFAULT_BREAKER) {}

  /** May a request use the proxy lane now? */
  allows(now: number): boolean {
    return now >= this.openUntil;
  }
  success(): void {
    this.consecutive = 0;
    this.openUntil = 0;
  }
  failure(now: number): void {
    this.consecutive += 1;
    if (this.consecutive >= this.policy.failures) this.openUntil = now + this.policy.cooldownMs;
  }
  state(now: number): { open: boolean; consecutiveFailures: number; reopensInMs: number } {
    return { open: now < this.openUntil, consecutiveFailures: this.consecutive, reopensInMs: Math.max(0, this.openUntil - now) };
  }
}

export interface LaneProxyConfig {
  url: string;
  /** host:port without credentials, for the log. */
  label: string;
  /** Requests a second the proxy lane's own limiter admits. */
  ratePerSec: number;
}

/**
 * The proxy lane from the environment: API_LANE_PROXY_URL (an http or https URL of an HTTP CONNECT proxy) and API_LANE_PROXY_RATE
 * (a second, clamped 0.2-1.9; omitted = `defaultRate`, the box's own rate, since the game's limit per IP is the same). Unset or
 * unusable = no lane, so nothing changes.
 */
export function laneProxyFromEnv(env: Record<string, string | undefined>, defaultRate: number): LaneProxyConfig | undefined {
  const raw = env.API_LANE_PROXY_URL?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return undefined; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const asked = Number(env.API_LANE_PROXY_RATE);
  const rate = Number.isFinite(asked) && asked > 0 ? asked : defaultRate;
  return { url: raw, label: maskProxyUrl(raw), ratePerSec: Math.min(1.9, Math.max(0.2, rate)) };
}
