import { randomBytes } from "node:crypto";
import type pg from "pg";
import { withPool } from "./pool.js";
import { hashApiKey } from "../auth/crypto.js";

/**
 * Control-plane CRUD for `tenant_mcp_keys` — same reasoning `tenants.ts`'s
 * own header comment gives for `tenants`/`sessions`: this table isn't
 * RLS-scoped (see migrations/021_tenant_mcp_keys.sql), so every function
 * here goes through `withPool`, not `withTenant`.
 */

export interface McpKeyRow {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const KEY_PREFIX = "sctk_"; // "stcommand token" — printable prefix, same idea as GitHub's ghp_/gho_ etc.

/**
 * Mint a new key for `tenantId`. Returns the raw key exactly once — only
 * `hashApiKey()`'s digest is ever persisted, so this is the caller's only
 * chance to see (and hand to an MCP client) the actual credential.
 */
export async function mintMcpKey(pool: pg.Pool, tenantId: string, label: string): Promise<{ id: string; rawKey: string }> {
  const rawKey = KEY_PREFIX + randomBytes(32).toString("base64url");
  const keyHash = hashApiKey(rawKey);
  return withPool(pool, async (c) => {
    const res = await c.query<{ id: string }>(
      `INSERT INTO tenant_mcp_keys (tenant_id, key_hash, label) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, keyHash, label],
    );
    return { id: res.rows[0]!.id, rawKey };
  });
}

/**
 * Resolve a raw key (as presented in an MCP client's Authorization header)
 * to the tenant it belongs to, or undefined if it doesn't exist, was
 * revoked, or the raw key is malformed. Also updates `last_used_at` —
 * best-effort, mirrors `touchTenant()`'s own "must never fail the request
 * it's riding along with" reasoning.
 */
export async function resolveMcpKey(pool: pg.Pool, rawKey: string): Promise<{ tenantId: string; agentSymbol: string } | undefined> {
  if (!rawKey.startsWith(KEY_PREFIX)) return undefined;
  const keyHash = hashApiKey(rawKey);
  return withPool(pool, async (c) => {
    const res = await c.query<{ tenant_id: string; agent_symbol: string; id: string }>(
      `SELECT k.id, k.tenant_id, t.agent_symbol
         FROM tenant_mcp_keys k
         JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [keyHash],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    try {
      await c.query(`UPDATE tenant_mcp_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
    } catch {
      // Best-effort bookkeeping — never fail auth over a stats update.
    }
    return { tenantId: row.tenant_id, agentSymbol: row.agent_symbol };
  });
}

/** Every key belonging to `tenantId`, newest first — for the dashboard's key-management panel. Never returns the raw key (it was never stored). */
export async function listMcpKeys(pool: pg.Pool, tenantId: string): Promise<McpKeyRow[]> {
  return withPool(pool, async (c) => {
    const res = await c.query<{ id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
      `SELECT id, label, created_at, last_used_at, revoked_at
         FROM tenant_mcp_keys
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [tenantId],
    );
    return res.rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
  });
}

/** Revoke a key. Scoped to `tenantId` so one tenant can never revoke another's by guessing an id; revoking an already-revoked or nonexistent key is a no-op, not an error. */
export async function revokeMcpKey(pool: pg.Pool, tenantId: string, keyId: string): Promise<void> {
  await withPool(pool, (c) =>
    c.query(`UPDATE tenant_mcp_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`, [keyId, tenantId]));
}
