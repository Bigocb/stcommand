import type pg from "pg";
import { withPool } from "./pool.js";
import { encryptSecret, decryptSecret } from "../auth/crypto.js";

export interface TenantRow {
  id: string;
  agentSymbol: string;
}

/**
 * Control-plane tenant/session CRUD — deliberately separate from `store.ts`.
 * `store.ts`'s methods are all tenant-*scoped* (RLS-enforced reads/writes for
 * a tenant that's already known); these operate on the `tenants` and
 * `sessions` tables themselves, the ones RLS can't gate because they're how a
 * request finds out which tenant it is in the first place (see
 * migrations/001_init.sql's comment on why `sessions` is excluded from
 * `apply_tenant_rls()`). Every function here goes through `withPool`, not
 * `withTenant` — there is no tenant context to set yet.
 */

/**
 * Find the tenant for this agent symbol, or create one. The SpaceTraders
 * token is the credential — by the time this is called, the caller has
 * already verified it live against `GET /my/agent` (see the gate route), so
 * a matching `agent_symbol` here is enough to treat this as "log back in
 * with the same account" rather than requiring the stored token to match
 * byte-for-byte. The token is re-encrypted and stored either way, so a
 * rotated token (SpaceTraders lets an agent regenerate one) keeps working
 * without a separate re-link step.
 */
export async function findOrCreateTenant(pool: pg.Pool, agentSymbol: string, token: string): Promise<TenantRow> {
  const { enc, iv } = encryptSecret(token);
  return withPool(pool, async (c) => {
    const res = await c.query<{ id: string; agent_symbol: string }>(
      `INSERT INTO tenants (agent_symbol, token_enc, token_iv)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_symbol) DO UPDATE SET token_enc = excluded.token_enc, token_iv = excluded.token_iv, last_seen_at = now()
       RETURNING id, agent_symbol`,
      [agentSymbol, enc, iv],
    );
    const row = res.rows[0]!;
    return { id: row.id, agentSymbol: row.agent_symbol };
  });
}

/** Every known tenant. Used at process start to eager-boot every tenant's
 *  engine instead of waiting for that tenant's first authenticated request —
 *  see TenantRegistry.bootAll()'s doc comment for why. */
export async function listAllTenants(pool: pg.Pool): Promise<TenantRow[]> {
  return withPool(pool, async (c) => {
    const res = await c.query<{ id: string; agent_symbol: string }>(`SELECT id, agent_symbol FROM tenants`);
    return res.rows.map((r) => ({ id: r.id, agentSymbol: r.agent_symbol }));
  });
}

/** Decrypt and return a tenant's stored SpaceTraders token. */
export async function getTenantToken(pool: pg.Pool, tenantId: string): Promise<string> {
  return withPool(pool, async (c) => {
    const res = await c.query<{ token_enc: Buffer; token_iv: Buffer }>(
      `SELECT token_enc, token_iv FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`no tenant with id ${tenantId}`);
    return decryptSecret(row.token_enc, row.token_iv);
  });
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Create a session for a tenant, returning its id (the value a signed cookie carries). */
export async function createSession(pool: pg.Pool, tenantId: string, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<string> {
  return withPool(pool, async (c) => {
    const res = await c.query<{ id: string }>(
      `INSERT INTO sessions (tenant_id, expires_at) VALUES ($1, now() + $2 * interval '1 millisecond') RETURNING id`,
      [tenantId, ttlMs],
    );
    return res.rows[0]!.id;
  });
}

/** Resolve a session id to its tenant, or undefined if the session doesn't exist or has expired. */
export async function resolveSession(pool: pg.Pool, sessionId: string): Promise<TenantRow | undefined> {
  return withPool(pool, async (c) => {
    const res = await c.query<{ id: string; agent_symbol: string }>(
      `SELECT t.id, t.agent_symbol
         FROM sessions s
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sessionId],
    );
    const row = res.rows[0];
    return row ? { id: row.id, agentSymbol: row.agent_symbol } : undefined;
  });
}

/** Touch a tenant's last_seen_at — call on session resolution, not on every request, to keep this cheap. */
export async function touchTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  await withPool(pool, (c) => c.query(`UPDATE tenants SET last_seen_at = now() WHERE id = $1`, [tenantId]));
}

/** Delete a session (logout). Deleting an id that doesn't exist is a no-op, not an error. */
export async function deleteSession(pool: pg.Pool, sessionId: string): Promise<void> {
  await withPool(pool, (c) => c.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]));
}

export interface TenantLlmConfig {
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  apiKey: string;
}

/**
 * A tenant's bring-your-own LLM settings, or undefined if they haven't set
 * one — that absence, not a feature flag, is what disables the co-pilot for
 * that tenant (docs/architecture-plan.md §3).
 */
export async function getTenantLlmConfig(pool: pg.Pool, tenantId: string): Promise<TenantLlmConfig | undefined> {
  return withPool(pool, async (c) => {
    const res = await c.query<{
      llm_provider: string | null;
      llm_base_url: string | null;
      llm_model: string | null;
      llm_key_enc: Buffer | null;
      llm_key_iv: Buffer | null;
    }>(`SELECT llm_provider, llm_base_url, llm_model, llm_key_enc, llm_key_iv FROM tenants WHERE id = $1`, [tenantId]);
    const row = res.rows[0];
    if (!row || !row.llm_key_enc || !row.llm_key_iv) return undefined;
    return {
      provider: row.llm_provider,
      baseUrl: row.llm_base_url,
      model: row.llm_model,
      apiKey: decryptSecret(row.llm_key_enc, row.llm_key_iv),
    };
  });
}

/** Set (or clear, by passing undefined) a tenant's LLM settings. */
export async function setTenantLlmConfig(
  pool: pg.Pool,
  tenantId: string,
  config: { provider: string; baseUrl?: string; model: string; apiKey: string } | undefined,
): Promise<void> {
  await withPool(pool, async (c) => {
    if (!config) {
      await c.query(
        `UPDATE tenants SET llm_provider = NULL, llm_base_url = NULL, llm_model = NULL, llm_key_enc = NULL, llm_key_iv = NULL WHERE id = $1`,
        [tenantId],
      );
      return;
    }
    const { enc, iv } = encryptSecret(config.apiKey);
    await c.query(
      `UPDATE tenants SET llm_provider = $2, llm_base_url = $3, llm_model = $4, llm_key_enc = $5, llm_key_iv = $6 WHERE id = $1`,
      [tenantId, config.provider, config.baseUrl ?? null, config.model, enc, iv],
    );
  });
}

/**
 * A tenant's own Discord webhook URL, or undefined if they haven't set one.
 * `TenantRegistry` reads this once at boot to seed that tenant's own
 * `DiscordRelay` (see discord.ts's class doc comment on why there's one per
 * tenant, not a shared singleton).
 */
export async function getTenantDiscordWebhook(pool: pg.Pool, tenantId: string): Promise<string | undefined> {
  return withPool(pool, async (c) => {
    const res = await c.query<{ discord_webhook_enc: Buffer | null; discord_webhook_iv: Buffer | null }>(
      `SELECT discord_webhook_enc, discord_webhook_iv FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = res.rows[0];
    if (!row || !row.discord_webhook_enc || !row.discord_webhook_iv) return undefined;
    return decryptSecret(row.discord_webhook_enc, row.discord_webhook_iv);
  });
}

/** Set (or clear, by passing undefined) a tenant's Discord webhook URL. */
export async function setTenantDiscordWebhook(pool: pg.Pool, tenantId: string, webhookUrl: string | undefined): Promise<void> {
  await withPool(pool, async (c) => {
    if (!webhookUrl) {
      await c.query(`UPDATE tenants SET discord_webhook_enc = NULL, discord_webhook_iv = NULL WHERE id = $1`, [tenantId]);
      return;
    }
    const { enc, iv } = encryptSecret(webhookUrl);
    await c.query(`UPDATE tenants SET discord_webhook_enc = $2, discord_webhook_iv = $3 WHERE id = $1`, [tenantId, enc, iv]);
  });
}

/**
 * Whether a tenant's Discord relay is paused. Deliberately separate from the
 * webhook URL itself — pausing shouldn't force the operator to re-enter the
 * URL to resume later. Defaults to true (matches the column's DB default)
 * so a tenant with no row yet still behaves as "on".
 */
export async function getTenantDiscordEnabled(pool: pg.Pool, tenantId: string): Promise<boolean> {
  return withPool(pool, async (c) => {
    const res = await c.query<{ discord_enabled: boolean }>(`SELECT discord_enabled FROM tenants WHERE id = $1`, [tenantId]);
    return res.rows[0]?.discord_enabled ?? true;
  });
}

/** Pause or resume a tenant's Discord relay without touching its saved webhook URL. */
export async function setTenantDiscordEnabled(pool: pg.Pool, tenantId: string, enabled: boolean): Promise<void> {
  await withPool(pool, (c) => c.query(`UPDATE tenants SET discord_enabled = $2 WHERE id = $1`, [tenantId, enabled]));
}
