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
  return new Pool({ connectionString, options: "-c search_path=stcommand" });
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
export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  // Postgres won't accept a parameterized value in SET LOCAL, so tenantId gets
  // string-interpolated below. This is the ONE place in the whole app that
  // does that, and it's exactly the place where a bug would mean one
  // tenant's data leaking into another's session — so validate the shape
  // before it ever reaches a query string, rather than trusting every future
  // caller to only ever pass a real uuid.
  if (!UUID_RE.test(tenantId)) throw new Error(`withTenant: not a uuid: ${JSON.stringify(tenantId)}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
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
