import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { createPool } from "../src/db/pool.js";
import { findOrCreateTenant, getTenantToken, createSession, resolveSession, touchTenant, deleteSession, getTenantLlmConfig, setTenantLlmConfig, getTenantDiscordWebhook, setTenantDiscordWebhook } from "../src/db/tenants.js";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
const tenantIds: string[] = [];

before(() => {
  process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
  pool = createPool(DB_URL);
});

after(async () => {
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

function agentSymbol(): string {
  return `TENANT-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("findOrCreateTenant", () => {
  it("creates a new tenant and encrypts the token at rest", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token-original");
    tenantIds.push(tenant.id);
    assert.equal(tenant.agentSymbol, symbol);

    const raw = await pool.query<{ token_enc: Buffer }>(`SELECT token_enc FROM tenants WHERE id = $1`, [tenant.id]);
    assert.ok(!raw.rows[0]!.token_enc.toString("utf8").includes("st-token-original"), "token must not be stored in plaintext");

    assert.equal(await getTenantToken(pool, tenant.id), "st-token-original");
  });

  it("logging in again with the same agent symbol reuses the tenant row and updates the token", async () => {
    const symbol = agentSymbol();
    const first = await findOrCreateTenant(pool, symbol, "st-token-v1");
    tenantIds.push(first.id);
    const second = await findOrCreateTenant(pool, symbol, "st-token-v2"); // e.g. a rotated token

    assert.equal(second.id, first.id, "same agent symbol must resolve to the same tenant, not a duplicate");
    assert.equal(await getTenantToken(pool, first.id), "st-token-v2", "the newer token wins");
  });
});

describe("session lifecycle", () => {
  it("createSession + resolveSession round-trips to the right tenant", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    const sessionId = await createSession(pool, tenant.id);
    const resolved = await resolveSession(pool, sessionId);

    assert.deepEqual(resolved, { id: tenant.id, agentSymbol: symbol });
  });

  it("resolveSession returns undefined for an unknown session id", async () => {
    assert.equal(await resolveSession(pool, "00000000-0000-0000-0000-000000000000"), undefined);
  });

  it("resolveSession returns undefined for an expired session", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    const sessionId = await createSession(pool, tenant.id, -1000); // already expired
    assert.equal(await resolveSession(pool, sessionId), undefined);
  });

  it("deleteSession invalidates the session (logout)", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    const sessionId = await createSession(pool, tenant.id);
    assert.ok(await resolveSession(pool, sessionId));
    await deleteSession(pool, sessionId);
    assert.equal(await resolveSession(pool, sessionId), undefined);
  });

  it("deleting an unknown session id is a safe no-op", async () => {
    await assert.doesNotReject(() => deleteSession(pool, "00000000-0000-0000-0000-000000000000"));
  });

  it("touchTenant updates last_seen_at", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);
    const before = (await pool.query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM tenants WHERE id = $1`, [tenant.id])).rows[0]!.last_seen_at;

    await new Promise((r) => setTimeout(r, 20));
    await touchTenant(pool, tenant.id);

    const after = (await pool.query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM tenants WHERE id = $1`, [tenant.id])).rows[0]!.last_seen_at;
    assert.ok(after.getTime() > before.getTime());
  });
});

describe("tenant LLM config", () => {
  it("is undefined for a tenant that hasn't set one — absence disables the co-pilot", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    assert.equal(await getTenantLlmConfig(pool, tenant.id), undefined);
  });

  it("setTenantLlmConfig + getTenantLlmConfig round-trips, encrypting the key at rest", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    await setTenantLlmConfig(pool, tenant.id, { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5", apiKey: "sk-secret-123" });

    const config = await getTenantLlmConfig(pool, tenant.id);
    assert.deepEqual(config, { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5", apiKey: "sk-secret-123" });

    const raw = await pool.query<{ llm_key_enc: Buffer }>(`SELECT llm_key_enc FROM tenants WHERE id = $1`, [tenant.id]);
    assert.ok(!raw.rows[0]!.llm_key_enc!.toString("utf8").includes("sk-secret-123"), "key must not be stored in plaintext");
  });

  it("setTenantLlmConfig(undefined) clears a previously-set config", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    await setTenantLlmConfig(pool, tenant.id, { provider: "openai", model: "gpt-5", apiKey: "sk-abc" });
    assert.ok(await getTenantLlmConfig(pool, tenant.id));

    await setTenantLlmConfig(pool, tenant.id, undefined);
    assert.equal(await getTenantLlmConfig(pool, tenant.id), undefined);
  });
});

describe("tenant Discord webhook", () => {
  it("is undefined for a tenant that hasn't set one", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    assert.equal(await getTenantDiscordWebhook(pool, tenant.id), undefined);
  });

  it("setTenantDiscordWebhook + getTenantDiscordWebhook round-trips, encrypting the URL at rest", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    await setTenantDiscordWebhook(pool, tenant.id, "https://discord.com/api/webhooks/123/secret-token");
    assert.equal(await getTenantDiscordWebhook(pool, tenant.id), "https://discord.com/api/webhooks/123/secret-token");

    const raw = await pool.query<{ discord_webhook_enc: Buffer }>(`SELECT discord_webhook_enc FROM tenants WHERE id = $1`, [tenant.id]);
    assert.ok(!raw.rows[0]!.discord_webhook_enc!.toString("utf8").includes("secret-token"), "webhook URL must not be stored in plaintext");
  });

  it("setTenantDiscordWebhook(undefined) clears a previously-set webhook", async () => {
    const symbol = agentSymbol();
    const tenant = await findOrCreateTenant(pool, symbol, "st-token");
    tenantIds.push(tenant.id);

    await setTenantDiscordWebhook(pool, tenant.id, "https://discord.com/api/webhooks/123/secret-token");
    assert.ok(await getTenantDiscordWebhook(pool, tenant.id));

    await setTenantDiscordWebhook(pool, tenant.id, undefined);
    assert.equal(await getTenantDiscordWebhook(pool, tenant.id), undefined);
  });
});
