import { fetch as undiciFetch, ProxyAgent } from "undici";

/**
 * Optional outbound proxy for the galaxy crawler (2026-11-06, operator).
 *
 * SpaceTraders rate-limits by source IP (2 requests a second, burst 30; measured 2026-11-02), and every tenant on this box shares one
 * IP budget (API_RATE, 1.75 a second). The crawler makes only public, tokenless reads, so it is the safest first thing to move
 * to a second IP: nothing it does needs the box's IP, and a bad proxy costs a slower crawl, not a stalled fleet. It also frees the
 * box's budget, and lets the crawler run: its busy check skips a tick whenever the box is at 60 or more calls a minute, which the
 * fleet now always is.
 *
 * Set CRAWLER_PROXY_URL (http://user:pass@host:port/, an HTTP CONNECT proxy) in the box's environment. Unset, nothing changes.
 * CRAWLER_PROXY_RATE (requests a second, default 1, 0.2-1.9) is the crawler's own limiter once it has its own IP.
 *
 * Pure apart from the fetch it builds. The proxied path uses undici's own fetch with its own ProxyAgent, never Node's global fetch
 * with an undici dispatcher (client.ts explains why: the two undici copies disagree and the mix hangs).
 */

export const DEFAULT_CRAWLER_PROXY_RATE = 1;
const MIN_RATE = 0.2;
const MAX_RATE = 1.9;

/** What the crawler reads from a response: the few members both fetch implementations share. */
export type PublicResponse = Pick<Response, "status" | "ok" | "headers" | "statusText" | "json" | "text">;
export type PublicFetch = (url: URL) => Promise<PublicResponse>;

/** `http://user:pass@host:port/` -> `host:port`. Never returns the credentials, so it is safe to log. */
export function maskProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host || "proxy";
  } catch {
    return "proxy";
  }
}

export interface CrawlerProxyConfig {
  url: string;
  /** host:port without credentials, for the log. */
  label: string;
  /** The crawler's own limiter, requests a second. */
  ratePerSec: number;
}

/** The crawler's proxy from the environment, or undefined when CRAWLER_PROXY_URL is unset or not a usable URL. */
export function crawlerProxyFromEnv(env: Record<string, string | undefined>): CrawlerProxyConfig | undefined {
  const raw = env.CRAWLER_PROXY_URL?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return undefined; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const asked = Number(env.CRAWLER_PROXY_RATE);
  const ratePerSec = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_RATE, Math.max(MIN_RATE, asked)) : DEFAULT_CRAWLER_PROXY_RATE;
  return { url: raw, label: maskProxyUrl(raw), ratePerSec };
}

/**
 * The fetch the crawler uses for public reads. With a proxy URL: undici's fetch through a ProxyAgent built once. Without: Node's
 * global fetch, looked up at call time (tests replace globalThis.fetch).
 */
export function makePublicFetch(proxyUrl?: string): PublicFetch {
  if (!proxyUrl) return (url) => fetch(url);
  const dispatcher = new ProxyAgent(proxyUrl);
  return (url) => undiciFetch(url, { dispatcher }) as unknown as Promise<PublicResponse>;
}
