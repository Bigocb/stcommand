// Typed Artifacts MMO client. All I/O goes through injected fetch/now/sleep, so it is testable offline.
import { ApiError } from './errors.js';
import { bucketFor, createLimiter, type Limiter, type LimiterOptions } from './limiter.js';
import { createCooldownTracker, type CooldownInfo, type CooldownTracker } from './cooldown.js';

export const DEFAULT_BASE_URL = 'https://api.artifactsmmo.com';

export type Json = Record<string, unknown>;
export interface Character extends Json { name: string }
export interface ActionResult extends Json { cooldown: CooldownInfo }
export interface Page<T> { data: T[]; total: number; page: number; size: number; pages: number }
export interface SimpleItem { code: string; quantity: number }

export interface MinimalResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<MinimalResponse>;

export interface ClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limiter?: Limiter;
  limiterOptions?: LimiterOptions;
  cooldowns?: CooldownTracker;
  /** Max retries on 429 (exponential 1s,2s,4s...). Default 3. */
  maxBackoffRetries?: number;
  /** Page size for listAll (API max 100). */
  pageSize?: number;
}

type Query = Record<string, string | number | boolean | undefined>;
interface ReqOpts { query?: Query; body?: unknown; raw?: boolean }

export function createClient(opts: ClientOptions) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<MinimalResponse>);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limiter = opts.limiter ?? createLimiter(opts.limiterOptions);
  const cooldowns = opts.cooldowns ?? createCooldownTracker();
  const maxBackoff = opts.maxBackoffRetries ?? 3;
  const pageSize = opts.pageSize ?? 100;

  async function throttle(bucket: ReturnType<typeof bucketFor>): Promise<void> {
    for (;;) {
      const r = limiter.tryAcquire(bucket, now());
      if (r.ok) return;
      await sleep(Math.ceil(r.waitMs));
    }
  }

  function buildUrl(path: string, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return `${baseUrl}${path}${s ? `?${s}` : ''}`;
  }

  /** Seconds remaining in a 499 body: data.remaining_seconds, else the first number in the message. */
  function remainingFrom499(err: ApiError): number {
    const d = err.data as { remaining_seconds?: unknown } | undefined;
    if (d && typeof d.remaining_seconds === 'number') return d.remaining_seconds;
    const m = /(\d+(?:\.\d+)?)\s*second/i.exec(err.message);
    return m ? Number(m[1]) : 3;
  }

  async function once(method: string, path: string, o: ReqOpts): Promise<unknown> {
    await throttle(bucketFor(method, path));
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' };
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    const res = await doFetch(buildUrl(path, o.query), init);
    let json: unknown;
    try { json = await res.json(); } catch { json = undefined; }
    if (res.ok) return json;
    const e = (json as { error?: { code?: number; message?: string; data?: unknown } } | undefined)?.error;
    const code = typeof e?.code === 'number' ? e.code : res.status;
    const err = new ApiError(code, e?.message ?? `HTTP ${res.status}`, res.status, e?.data);
    const ra = res.headers?.get('retry-after');
    if (ra && Number.isFinite(Number(ra))) (err as { retryAfterMs?: number }).retryAfterMs = Number(ra) * 1000;
    throw err;
  }

  async function request<T>(method: string, path: string, o: ReqOpts = {}): Promise<T> {
    const actor = /^\/my\/([^/]+)\/action\//.exec(path)?.[1];
    let cooldownRetried = false;
    let backoffs = 0;
    for (;;) {
      if (actor) {
        const w = cooldowns.waitMs(actor, now());
        if (w > 0) await sleep(w);
      }
      try {
        const body = await once(method, path, o);
        const data = o.raw ? body : ((body as { data?: unknown } | undefined)?.data ?? body);
        const cd = actor ? (data as { cooldown?: CooldownInfo } | undefined)?.cooldown : undefined;
        if (actor && cd) cooldowns.record(actor, cd, now());
        return data as T;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.code === 499 && actor && !cooldownRetried) {
          cooldownRetried = true;
          const ms = Math.ceil(remainingFrom499(e) * 1000) + 100;
          cooldowns.setReadyAt(actor, now() + ms);
          continue; // loop top sleeps the cooldown
        }
        if (e.code === 429 && backoffs < maxBackoff) {
          const ra = (e as { retryAfterMs?: number }).retryAfterMs;
          await sleep(ra ?? 1000 * 2 ** backoffs);
          backoffs++;
          continue;
        }
        throw e;
      }
    }
  }

  const get = <T>(path: string, query?: Query) => request<T>('GET', path, { query });
  const act = <T = ActionResult>(name: string, action: string, body?: unknown) =>
    request<T>('POST', `/my/${encodeURIComponent(name)}/action/${action}`, { body });

  async function listAll<T = Json>(path: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const p = await request<Partial<Page<T>>>('GET', path, { query: { ...query, page, size: pageSize }, raw: true });
      const rows = p.data ?? [];
      out.push(...rows);
      if (rows.length === 0 || page >= (p.pages ?? page)) break;
    }
    return out;
  }

  return {
    limiter, cooldowns,
    request, listAll,
    getServer: () => get<Json>('/'),
    getMyCharacters: () => get<Character[]>('/my/characters'),
    getCharacter: (name: string) => get<Character>(`/characters/${encodeURIComponent(name)}`),
    getBank: () => get<Json>('/my/bank'),
    getBankItems: (query: Query = {}) => get<Json[]>('/my/bank/items', query),
    getMyRates: () => get<Json>('/my/rates'),

    move: (name: string, dest: { x: number; y: number } | { map_id: number }) => act(name, 'move', dest),
    fight: (name: string, participants?: string[]) => act(name, 'fight', participants ? { participants } : undefined),
    rest: (name: string) => act(name, 'rest'),
    gathering: (name: string) => act(name, 'gathering'),
    crafting: (name: string, code: string, quantity = 1) => act(name, 'crafting', { code, quantity }),
    equip: (name: string, code: string, slot: string, quantity?: number) => act(name, 'equip', { code, slot, quantity }),
    unequip: (name: string, slot: string, quantity?: number) => act(name, 'unequip', { slot, quantity }),
    use: (name: string, code: string, quantity = 1) => act(name, 'use', { code, quantity }),

    bankDepositItems: (name: string, items: SimpleItem[]) => act(name, 'bank/deposit/item', items),
    bankWithdrawItems: (name: string, items: SimpleItem[]) => act(name, 'bank/withdraw/item', items),
    bankDepositGold: (name: string, quantity: number) => act(name, 'bank/deposit/gold', { quantity }),
    bankWithdrawGold: (name: string, quantity: number) => act(name, 'bank/withdraw/gold', { quantity }),

    npcBuy: (name: string, code: string, quantity: number) => act(name, 'npc/buy', { code, quantity }),
    npcSell: (name: string, code: string, quantity: number) => act(name, 'npc/sell', { code, quantity }),
    recycling: (name: string, code: string, quantity = 1) => act(name, 'recycling', { code, quantity }),

    taskNew: (name: string) => act(name, 'task/new'),
    taskComplete: (name: string) => act(name, 'task/complete'),
    taskTrade: (name: string, code: string, quantity: number) => act(name, 'task/trade', { code, quantity }),
    taskExchange: (name: string) => act(name, 'task/exchange'),
    taskCancel: (name: string) => act(name, 'task/cancel'),

    geOrders: (query: Query = {}) => get<Json[]>('/my/grandexchange/orders', query),
    geHistory: (query: Query = {}) => get<Json[]>('/my/grandexchange/history', query),
    geBuy: (name: string, id: string, quantity: number) => act(name, 'grandexchange/buy', { id, quantity }),
    geSell: (name: string, code: string, quantity: number, price: number) =>
      act(name, 'grandexchange/create_sell_order', { code, quantity, price }),
    geCreateBuyOrder: (name: string, code: string, quantity: number, price: number) =>
      act(name, 'grandexchange/create_buy_order', { code, quantity, price }),
    geFill: (name: string, id: string, quantity: number) => act(name, 'grandexchange/fill', { id, quantity }),
    geCancel: (name: string, id: string) => act(name, 'grandexchange/cancel', { id }),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
