-- Per-tenant API keys for the hosted MCP server (docs/mcp-server-plan.md),
-- so an MCP client authenticates as a specific tenant with a long-lived
-- bearer credential instead of the browser session cookie. Looked up by
-- its own key_hash BEFORE app.tenant_id is known — same reasoning
-- 001_init.sql gives for excluding `sessions` from apply_tenant_rls():
-- RLS on this table would make the lookup itself impossible (there's no
-- tenant_id to SET LOCAL until this query tells us which one), so it's
-- deliberately NOT row-level-secured, same as `sessions`. key_hash being
-- an HMAC-SHA256 digest of a high-entropy, server-generated random key
-- (src/auth/crypto.ts's hashApiKey()) is this table's real security
-- boundary — the raw key is never stored, shown once at mint time, the
-- same discipline every other secret in this schema already follows.

CREATE TABLE IF NOT EXISTS tenant_mcp_keys (
  id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash      text NOT NULL UNIQUE,
  label         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_tenant_mcp_keys_tenant ON tenant_mcp_keys (tenant_id);
