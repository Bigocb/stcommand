import type { paths } from "./schema.js";
import type { components } from "./schema.js";

export type { paths, components };

export const API_BASE = "https://api.spacetraders.io/v2";

export class APIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "APIError";
  }
}

export interface ClientOptions {
  token?: string;
  baseUrl?: string;
  maxRetries?: number;
  retryBackoffMs?: number;
  /** Called with the seconds to wait when the server asks us to back off. */
  onRateLimited?: (retryAfterSec: number, attempt: number) => void;
  /**
   * Share one token bucket across multiple `Client` instances instead of each
   * getting its own. SpaceTraders enforces its rate limit per IP address, not
   * per account token — a multi-tenant process making requests for N tenants
   * from one IP is really N Clients sharing one real ceiling. Each Client
   * self-throttling to 1.5 req/s independently (the per-Client default below)
   * only holds that ceiling for a single tenant; with N tenants active it
   * admits up to N * 1.5 req/s from the same IP, which is exactly what
   * produces sustained 429s once several tenants have ships running at once.
   * `TenantRegistry` constructs one `RateLimiter` per process and passes it
   * here for every tenant's `Client` so they all draw from the same budget.
   * Omitted (the default), a Client gets its own private limiter — what every
   * test and one-off caller (e.g. the login/register token-verification
   * Client in gate.ts) wants, since those aren't part of the shared fleet
   * workload this exists to protect.
   */
  sharedLimiter?: RateLimiter;
}

type RequestOptions = {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simple token-bucket limiter to stay under the API's per-second cap. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.last) / 1000;
      this.last = now;
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - this.tokens) / this.ratePerSec * 1000));
    }
  }
}

/** A small typed HTTP client with token auth, rate-limit handling and retry. */
export class Client {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly limiter: RateLimiter;
  readonly onRateLimited: ClientOptions["onRateLimited"];
  /**
   * Real count of HTTP requests actually sent (including retries — a 429 or
   * 500 retry is still a real call against the rate limit, not a free
   * do-over). This is what makes Scheduler Task `actualCalls` a measured
   * number instead of the fixed per-task-type heuristic it used to be: an
   * agent's nextTask() reads this before and after its own work and reports
   * the delta. See fleet.ts/trader.ts/agent.ts/scout.ts/siphoner.ts's
   * nextTask() comments.
   */
  private callCount = 0;

  constructor(opts: ClientOptions = {}) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? API_BASE;
    this.maxRetries = opts.maxRetries ?? 4;
    this.retryBackoffMs = opts.retryBackoffMs ?? 250;
    this.onRateLimited = opts.onRateLimited;
    // SpaceTraders' real per-account limit is 2 req/sec, but that's the
    // server's own ceiling, not headroom to plan around — 2 here regularly
    // triggers live 429s (confirmed in production: near-continuous
    // "rate limited, backing off" once several ships are all trading, each
    // 429 costing a real retry round-trip instead of just consuming a
    // token). straders' original fleet ran at 1.5/s specifically because
    // of this; matching that here.
    //
    // A `sharedLimiter` (see ClientOptions' doc comment) takes precedence: the
    // real ceiling is per-IP, not per-Client, so a multi-tenant process must
    // have its tenants' Clients draw from one shared budget rather than each
    // independently believing it has the full 1.5 req/s to itself.
    this.limiter = opts.sharedLimiter ?? new RateLimiter(1.5, 30);
  }

  withToken(token: string): Client {
    return new Client({ ...this._opts(), token });
  }

  private _opts(): ClientOptions {
    return {
      token: this.token,
      baseUrl: this.baseUrl,
      maxRetries: this.maxRetries,
      retryBackoffMs: this.retryBackoffMs,
      onRateLimited: this.onRateLimited,
      // Always this instance's actual limiter, not just whatever sharedLimiter
      // it was constructed with — a withToken() clone must draw from the same
      // budget as its parent even when the parent got a private one by default.
      sharedLimiter: this.limiter,
    };
  }

  /** Perform an untyped request. Prefer the typed helpers below. */
  async request<T>(req: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + req.path);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      this.callCount += 1;
      const res = await fetch(url, {
        method: req.method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });

      const retryAfter = res.headers.get("retry-after");

      if (res.status === 429) {
        const wait = retryAfter ? Number(retryAfter) : undefined;
        const delayMs = (wait && !Number.isNaN(wait) ? wait * 1000 : undefined) ?? this.retryBackoffMs * 2 ** attempt;
        this.onRateLimited?.(delayMs / 1000, attempt);
        if (attempt < this.maxRetries) {
          attempt += 1;
          await sleep(delayMs);
          continue;
        }
      } else if (res.status >= 500 && attempt < this.maxRetries) {
        const delayMs = this.retryBackoffMs * 2 ** attempt;
        await sleep(delayMs);
        attempt += 1;
        continue;
      }

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;

      if (!res.ok) {
        const err = extractError(json);
        throw new APIError(err.message, res.status, err.code, json);
      }
      return json as T;
    }
  }

  /** GET expecting `{ data: T }`. */
  async get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    const res = await this.request<{ data: T }>({ method: "GET", path, query });
    return res.data;
  }

  /** POST expecting `{ data: T }`. */
  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.request<{ data: T }>({ method: "POST", path, body });
    return res.data;
  }

  /** PATCH expecting `{ data: T }`. */
  async patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.request<{ data: T }>({ method: "PATCH", path, body });
    return res.data;
  }

  /** Total real HTTP requests sent so far, including retries. */
  getCallCount(): number {
    return this.callCount;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractError(json: unknown): { message: string; code?: string } {
  const err = (json as { error?: { message?: string; code?: string } } | undefined)?.error;
  if (err?.message) return { message: err.message, code: err.code };
  if (typeof json === "string") return { message: json };
  return { message: `HTTP error ${json !== undefined ? JSON.stringify(json) : ""}`.trim() };
}

/** Typed API surface bound to a token. */
export class SpaceTradersAPI {
  constructor(
    public readonly client: Client,
    readonly token: string,
  ) {}

  status() {
    return this.client.request<paths["/"]["get"]["responses"]["200"]["content"]["application/json"]>({
      method: "GET",
      path: "/",
    });
  }

  /** Total real HTTP requests sent through this agent's client so far, including retries. */
  getCallCount(): number {
    return this.client.getCallCount();
  }

  getMyAgent() {
    return this.client.get<components["schemas"]["Agent"]>("/my/agent");
  }

  getMyShips(limit = 20, page = 1) {
    return this.client.get<components["schemas"]["Ship"][]>("/my/ships", { limit, page });
  }

  /** Fetch every owned ship, walking pages until the server returns fewer than requested. */
  async listAllShips(limit = 20): Promise<components["schemas"]["Ship"][]> {
    const out: components["schemas"]["Ship"][] = [];
    for (let page = 1; ; page += 1) {
      const ships = await this.client.get<components["schemas"]["Ship"][]>("/my/ships", { limit, page });
      out.push(...ships);
      if (ships.length < limit) return out;
    }
  }

  getShip(shipSymbol: string) {
    return this.client.get<components["schemas"]["Ship"]>(`/my/ships/${shipSymbol}`);
  }

  getShipCargo(shipSymbol: string) {
    return this.client.get<components["schemas"]["ShipCargo"]>(`/my/ships/${shipSymbol}/cargo`);
  }

  getContracts() {
    return this.client.get<components["schemas"]["Contract"][]>("/my/contracts", { limit: 20 });
  }

  acceptContract(contractId: string) {
    return this.client.post<{ agent: components["schemas"]["Agent"]; contract: components["schemas"]["Contract"] }>(
      `/my/contracts/${contractId}/accept`,
    );
  }

  fulfillContract(contractId: string) {
    return this.client.post<{ agent: components["schemas"]["Agent"]; contract: components["schemas"]["Contract"] }>(
      `/my/contracts/${contractId}/fulfill`,
    );
  }

  deliverContract(contractId: string, shipSymbol: string, tradeSymbol: string, units: number) {
    return this.client.post<{ contract: components["schemas"]["Contract"]; cargo: components["schemas"]["ShipCargo"] }>(
      `/my/contracts/${contractId}/deliver`,
      { shipSymbol, tradeSymbol, units },
    );
  }

  getSystem(systemSymbol: string) {
    return this.client.get<components["schemas"]["System"]>(`/systems/${systemSymbol}`);
  }

  getSystemWaypoints(systemSymbol: string, query?: { page?: number; limit?: number }) {
    return this.client.get<components["schemas"]["Waypoint"][]>(`/systems/${systemSymbol}/waypoints`, {
      page: query?.page,
      limit: query?.limit ?? 20,
    });
  }

  /** Fetch all waypoints in a system, following pagination. */
  async getAllSystemWaypoints(systemSymbol: string): Promise<components["schemas"]["Waypoint"][]> {
    const out: components["schemas"]["Waypoint"][] = [];
    let page = 1;
    for (;;) {
      const batch = await this.getSystemWaypoints(systemSymbol, { page, limit: 20 });
      out.push(...batch);
      if (batch.length < 20) break;
      page += 1;
    }
    return out;
  }

  getWaypoint(systemSymbol: string, waypointSymbol: string) {
    return this.client.get<components["schemas"]["Waypoint"]>(`/systems/${systemSymbol}/waypoints/${waypointSymbol}`);
  }

  getMarket(systemSymbol: string, waypointSymbol: string) {
    return this.client.get<components["schemas"]["Market"]>(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/market`);
  }

  getShipyard(systemSymbol: string, waypointSymbol: string) {
    return this.client.get<components["schemas"]["Shipyard"]>(
      `/systems/${systemSymbol}/waypoints/${waypointSymbol}/shipyard`,
    );
  }

  purchaseShip(shipType: string, waypointSymbol: string) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      ship: components["schemas"]["Ship"];
      transaction: components["schemas"]["ShipyardTransaction"];
    }>("/my/ships", { shipType, waypointSymbol });
  }

  transferCargo(shipSymbol: string, tradeSymbol: string, units: number, toShipSymbol: string) {
    // Note: the API's body field is named `shipSymbol` but holds the RECEIVING ship.
    return this.client.post<{
      cargo: components["schemas"]["ShipCargo"];
    }>(`/my/ships/${shipSymbol}/transfer`, { shipSymbol: toShipSymbol, tradeSymbol, units });
  }

  getFaction(factionSymbol: string) {
    return this.client.get<components["schemas"]["Faction"]>(`/factions/${factionSymbol}`);
  }

  orbitShip(shipSymbol: string) {
    return this.client.post<{ nav: components["schemas"]["ShipNav"] }>(`/my/ships/${shipSymbol}/orbit`);
  }

  dockShip(shipSymbol: string) {
    return this.client.post<{ nav: components["schemas"]["ShipNav"] }>(`/my/ships/${shipSymbol}/dock`);
  }

  getJumpGate(systemSymbol: string, waypointSymbol: string) {
    return this.client.get<components["schemas"]["JumpGate"]>(
      `/systems/${systemSymbol}/waypoints/${waypointSymbol}/jump-gate`,
    );
  }

  getConstruction(systemSymbol: string, waypointSymbol: string) {
    return this.client.get<components["schemas"]["Construction"]>(
      `/systems/${systemSymbol}/waypoints/${waypointSymbol}/construction`,
    );
  }

  supplyConstruction(systemSymbol: string, waypointSymbol: string, shipSymbol: string, tradeSymbol: string, units: number) {
    return this.client.post<{
      construction: components["schemas"]["Construction"];
      cargo: components["schemas"]["ShipCargo"];
    }>(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/construction/supply`, { shipSymbol, tradeSymbol, units });
  }

  jumpShip(shipSymbol: string, waypointSymbol: string) {
    return this.client.post<{
      nav: components["schemas"]["ShipNav"];
      cooldown: components["schemas"]["Cooldown"];
      transaction: components["schemas"]["MarketTransaction"];
      agent: components["schemas"]["Agent"];
    }>(`/my/ships/${shipSymbol}/jump`, { waypointSymbol });
  }

  navigateShip(shipSymbol: string, waypointSymbol: string) {
    return this.client.post<{
      fuel: components["schemas"]["ShipFuel"];
      nav: components["schemas"]["ShipNav"];
    }>(`/my/ships/${shipSymbol}/navigate`, { waypointSymbol });
  }

  refuelShip(shipSymbol: string, units?: number, fromCargo = false) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      fuel: components["schemas"]["ShipFuel"];
      transaction: components["schemas"]["MarketTransaction"];
      cargo?: components["schemas"]["ShipCargo"];
    }>(`/my/ships/${shipSymbol}/refuel`, { units, fromCargo });
  }

  extract(shipSymbol: string) {
    return this.client.post<{
      cooldown: components["schemas"]["Cooldown"];
      extraction: components["schemas"]["Extraction"];
      cargo: components["schemas"]["ShipCargo"];
    }>(`/my/ships/${shipSymbol}/extract`);
  }

  createSurvey(shipSymbol: string) {
    return this.client.post<{
      cooldown: components["schemas"]["Cooldown"];
      surveys: components["schemas"]["Survey"][];
    }>(`/my/ships/${shipSymbol}/survey`);
  }

  extractWithSurvey(shipSymbol: string, survey: components["schemas"]["Survey"]) {
    return this.client.post<{
      cooldown: components["schemas"]["Cooldown"];
      extraction: components["schemas"]["Extraction"];
      cargo: components["schemas"]["ShipCargo"];
    }>(`/my/ships/${shipSymbol}/extract/survey`, survey);
  }

  /** Extract gases from a gas giant. Requires a gas siphon mount; enters cooldown. */
  siphon(shipSymbol: string) {
    return this.client.post<{
      cooldown: components["schemas"]["Cooldown"];
      siphon: components["schemas"]["Siphon"];
      cargo: components["schemas"]["ShipCargo"];
    }>(`/my/ships/${shipSymbol}/siphon`);
  }

  refine(
    shipSymbol: string,
    produce: "IRON" | "COPPER" | "SILVER" | "GOLD" | "ALUMINUM" | "PLATINUM" | "URANITE" | "MERITIUM" | "FUEL",
  ) {
    return this.client.post<{
      cargo: components["schemas"]["ShipCargo"];
      cooldown: components["schemas"]["Cooldown"];
      produced: { tradeSymbol: string; units: number }[];
      consumed: { tradeSymbol: string; units: number }[];
    }>(`/my/ships/${shipSymbol}/refine`, { produce });
  }

  sellCargo(shipSymbol: string, symbol: string, units: number) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      cargo: components["schemas"]["ShipCargo"];
      transaction: components["schemas"]["MarketTransaction"];
    }>(`/my/ships/${shipSymbol}/sell`, { symbol, units });
  }

  purchaseCargo(shipSymbol: string, symbol: string, units: number) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      cargo: components["schemas"]["ShipCargo"];
      transaction: components["schemas"]["MarketTransaction"];
    }>(`/my/ships/${shipSymbol}/purchase`, { symbol, units });
  }

  /** Throw away cargo from a ship's hold (e.g. to free space on a stranded ship). */
  jettisonCargo(shipSymbol: string, symbol: string, units: number) {
    return this.client.post<{
      cargo: components["schemas"]["ShipCargo"];
    }>(`/my/ships/${shipSymbol}/jettison`, { symbol, units });
  }

  /** Chart the waypoint at the ship's current location. Pays a one-time credit reward and reveals traits. */
  chartShip(shipSymbol: string) {
    return this.client.post<{
      chart: components["schemas"]["Chart"];
      waypoint: components["schemas"]["Waypoint"];
      agent: components["schemas"]["Agent"];
    }>(`/my/ships/${shipSymbol}/chart`);
  }

  /** Scan for nearby systems. Requires a Sensor Array mount; enters cooldown. */
  scanSystems(shipSymbol: string) {
    return this.client.post<{
      cooldown: components["schemas"]["Cooldown"];
      systems: components["schemas"]["ScannedSystem"][];
    }>(`/my/ships/${shipSymbol}/scan/systems`);
  }

  /** Scan for nearby waypoints, revealing traits of uncharted ones. Requires a Sensor Array mount; enters cooldown. */
  scanWaypoints(shipSymbol: string) {
    return this.client.post<{
      cooldown: components["schemas"]["Cooldown"];
      waypoints: components["schemas"]["ScannedWaypoint"][];
    }>(`/my/ships/${shipSymbol}/scan/waypoints`);
  }

  /** Scan for nearby ships. Requires a Sensor Array mount; enters cooldown. */
  scanShips(shipSymbol: string) {
    return this.client.post<{
      cooldown: components["schemas"]["Cooldown"];
      ships: components["schemas"]["ScannedShip"][];
    }>(`/my/ships/${shipSymbol}/scan/ships`);
  }

  getShipCooldown(shipSymbol: string) {
    return this.client.request<{ data: components["schemas"]["Cooldown"] } | null>({
      method: "GET",
      path: `/my/ships/${shipSymbol}/cooldown`,
    });
  }

  installModule(shipSymbol: string, symbol: string) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      modules: components["schemas"]["ShipModule"][];
      cargo: components["schemas"]["ShipCargo"];
      transaction: components["schemas"]["ShipModificationTransaction"];
    }>(`/my/ships/${shipSymbol}/modules/install`, { symbol });
  }

  removeModule(shipSymbol: string, symbol: string) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      modules: components["schemas"]["ShipModule"][];
      cargo: components["schemas"]["ShipCargo"];
      transaction: components["schemas"]["ShipModificationTransaction"];
    }>(`/my/ships/${shipSymbol}/modules/remove`, { symbol });
  }

  installMount(shipSymbol: string, symbol: string) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      mounts: components["schemas"]["ShipMount"][];
      cargo: components["schemas"]["ShipCargo"];
      transaction: components["schemas"]["ShipModificationTransaction"];
    }>(`/my/ships/${shipSymbol}/mounts/install`, { symbol });
  }

  removeMount(shipSymbol: string, symbol: string) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      mounts: components["schemas"]["ShipMount"][];
      cargo: components["schemas"]["ShipCargo"];
      transaction: components["schemas"]["ShipModificationTransaction"];
    }>(`/my/ships/${shipSymbol}/mounts/remove`, { symbol });
  }

  scrapShip(shipSymbol: string) {
    return this.client.post<{
      agent: components["schemas"]["Agent"];
      transaction: components["schemas"]["ScrapTransaction"];
    }>(`/my/ships/${shipSymbol}/scrap`, {});
  }
}
