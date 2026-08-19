import pg from "pg";

const { Pool } = pg;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The connection pool. One per process, shared by every tenant — this is the
 * whole point of moving off per-tenant SQLite files: Postgres is async and
 * pooled, so one tenant's query never blocks another's the way a synchronous
 * `better-sqlite3` call on a shared event loop would.
 *
 * Every connection sets `search_path=stcommand` at the libpq level via
 * `options`, deliberately excluding `public` — this database (Render's
 * promptoria-db) already runs a real, unrelated app in `public`. Every query
 * in `store.ts` uses unqualified table names on purpose; this is the one
 * place that decides what those names resolve against, so a typo can never
 * silently resolve to one of promptoria's tables just because they happened
 * to share a name.
 */
export function createPool(connectionString: string): pg.Pool {
  // Render's Postgres (and most hosted Postgres) requires TLS and rejects a
  // plaintext connection outright ("SSL/TLS required") — local dev/CI
  // Postgres on localhost neither requires nor typically serves a cert, so
  // this is conditional on the host rather than always-on.
  //
  // rejectUnauthorized is false rather than Node's default chain
  // verification: Render's *external* hostname (dpg-xxx.oregon-postgres.
  // render.com) presents a publicly-trusted cert that verifies fine, but
  // the *internal* one (dpg-xxx, no suffix — what a same-region Render web
  // service should actually use, per pool.ts's own search_path comment
  // about staying same-network) presents a cert signed by Render's own
  // internal CA, which isn't in Node's public trust store and fails with
  // "self-signed certificate" under full verification. Encrypted either
  // way; this only relaxes chain verification, which for same-provider
  // internal-network traffic Render itself documents as the expected
  // setup — not a workaround for a mistake.
  const isLocal = /(?:^|@)(localhost|127\.0\.0\.1)(?::|\/)/.test(connectionString);
  return new Pool({
    connectionString,
    options: "-c search_path=stcommand",
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    // pg's own default (10) was confirmed in production as a real
    // bottleneck: a dashboard login's own burst of ~9 parallel API requests
    // already uses most of a 10-connection pool, and coincides with the
    // engine's background market/shipyard refresh also wanting connections
    // — logs showed pool.connect() taking 500-800ms with total=10 idle=0
    // and requests queued waiting. This alone doesn't fix the root cause
    // (Store.recordMarkets() batching real connection *usage* down, see its
    // own comment) — it's headroom on top of that, not a substitute for it.
    max: 20,
  });
}

/**
 * Run `fn` with a connection whose Postgres session has `app.tenant_id` set
 * for the duration of one transaction. Every RLS policy in migrations/001_init.sql
 * reads that setting to decide which rows a query can see — this function is
 * the ONLY place that sets it, so there is exactly one path by which a query
 * becomes tenant-scoped, not one per call site.
 *
 * `SET LOCAL` (not `SET`) matters: it's scoped to the transaction and
 * automatically reverts on commit/rollback, so a pooled connection can never
 * leak one tenant's context into the next caller that happens to reuse it.
 */
/**
 * Temporary diagnostic: every withTenant() call site (fleet_state, ship_state,
 * ship_manifest, ship_claims, missions, doctrine, activity, ledger, ...) has
 * been silently producing zero persisted rows in production despite no
 * errors ever surfacing at any call site — logged here, at the one place
 * every one of those calls actually goes through, since guessing which of
 * dozens of call sites is affected (or whether it's all of them) wasn't
 * getting anywhere. Remove once the cause is found.
 */
let withTenantCalls = 0;
let withTenantSlowWarned = 0;

export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  // Postgres won't accept a parameterized value in SET LOCAL, so tenantId gets
  // string-interpolated below. This is the ONE place in the whole app that
  // does that, and it's exactly the place where a bug would mean one
  // tenant's data leaking into another's session — so validate the shape
  // before it ever reaches a query string, rather than trusting every future
  // caller to only ever pass a real uuid.
  if (!UUID_RE.test(tenantId)) throw new Error(`withTenant: not a uuid: ${JSON.stringify(tenantId)}`);
  const callId = ++withTenantCalls;
  const startedAt = Date.now();
  const connectStart = Date.now();
  const client = await pool.connect();
  const connectMs = Date.now() - connectStart;
  if (connectMs > 500) console.log(`[withTenant#${callId}] pool.connect() took ${connectMs}ms (pool: total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`);
  const watchdog = setTimeout(() => {
    withTenantSlowWarned += 1;
    console.log(`[withTenant#${callId}] still running after 5s (pool: total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`);
  }, 5_000);
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const result = await fn(client);
    await client.query("COMMIT");
    const totalMs = Date.now() - startedAt;
    if (totalMs > 1_000) console.log(`[withTenant#${callId}] committed in ${totalMs}ms`);
    return result;
  } catch (err) {
    console.log(`[withTenant#${callId}] FAILED after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`);
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    clearTimeout(watchdog);
    client.release();
  }
}

/**
 * Run `fn` against the shared, ungated tables (market_snapshots,
 * shipyard_inventory, module_catalog) — no tenant context needed or set.
 */
export async function withPool<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
