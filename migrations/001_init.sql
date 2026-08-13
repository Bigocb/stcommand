-- Standing Orders: initial schema.
--
-- Every tenant-scoped table carries tenant_id and a FORCE ROW LEVEL SECURITY
-- policy keyed on the `app.tenant_id` session variable, set once per request
-- by the tenant-resolving middleware (src/db/pool.ts, withTenant()). A query
-- that forgets a tenant_id clause still can't see another tenant's rows —
-- Postgres enforces it, not application code. See docs/architecture-plan.md §2.
--
-- Three tables are deliberately NOT tenant-scoped: market_snapshots,
-- shipyard_inventory, module_catalog. They hold public galaxy data — the same
-- markets and prices for every tenant on the same game server reset — ported
-- directly from straders' schema, which made the same call for the same
-- reason.
--
-- Everything lives in a dedicated `stcommand` schema, not `public` — this
-- database (Render's promptoria-db) already runs a real, unrelated app in
-- `public` (Prisma-migrated, 41 tables: users, subscriptions, oauth_accounts,
-- etc.). A second app's tables in the same schema as an existing production
-- app is one shared blast radius for both — a bad migration, an accidental
-- DROP, or apply_tenant_rls() below scanning for a stray tenant_id column
-- could touch the other app's data. A dedicated schema is real namespace
-- isolation while still sharing the one paid instance, confirmed via the
-- pool-level `search_path` set in src/db/pool.ts rather than schema-qualifying
-- every query by hand.

CREATE SCHEMA IF NOT EXISTS stcommand;
SET search_path TO stcommand;

CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA stcommand; -- gen_random_uuid()

-- ── Control plane ──────────────────────────────────────────────

CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_symbol        text NOT NULL UNIQUE,
  token_enc           bytea NOT NULL,
  token_iv            bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  discord_webhook_enc bytea,
  discord_webhook_iv  bytea,
  -- Bring-your-own LLM key for the co-pilot. NULL key = co-pilot disabled
  -- for this tenant; no separate feature flag needed.
  llm_provider        text,
  llm_base_url        text,
  llm_model           text,
  llm_key_enc         bytea,
  llm_key_iv          bytea
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX idx_sessions_tenant ON sessions (tenant_id);

-- Applies RLS to every table already created in this session that has a
-- tenant_id column, so each CREATE TABLE below doesn't need to repeat the
-- ALTER/CREATE POLICY boilerplate. Called once at the bottom of this file.
--
-- `sessions` is deliberately excluded even though it has a tenant_id column:
-- a session has to be looked up by its own opaque id BEFORE app.tenant_id is
-- known — that lookup is how the middleware learns which tenant it belongs
-- to in the first place. RLS on it would make login impossible. The id
-- column being an unguessable random uuid is that table's real security
-- boundary, the same way any session token's unguessability is.
-- Scoped to table_schema = 'stcommand' explicitly, not just "whatever's on
-- search_path" — this function must never be able to reach promptoria's
-- tables in `public`, even if this migration is ever run with a different
-- search_path than expected.
CREATE OR REPLACE FUNCTION apply_tenant_rls() RETURNS void AS $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'tenant_id' AND table_schema = 'stcommand' AND table_name != 'sessions'
  LOOP
    EXECUTE format('ALTER TABLE stcommand.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE stcommand.%I FORCE ROW LEVEL SECURITY', t); -- applies even to the table owner
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON stcommand.%I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ── Tenant-scoped: trade ledger, activity, missions ────────────

CREATE TABLE ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timestamp     timestamptz NOT NULL,
  ship_symbol   text NOT NULL,
  waypoint_symbol text NOT NULL,
  type          text NOT NULL, -- PURCHASE | SELL | REFUEL | SHIP | OTHER
  trade_symbol  text,
  units         integer,
  price_per_unit double precision,
  total         double precision NOT NULL
);
CREATE INDEX idx_ledger_tenant_ts ON ledger (tenant_id, timestamp);
CREATE INDEX idx_ledger_tenant_ship_ts ON ledger (tenant_id, ship_symbol, timestamp);

CREATE TABLE activity (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timestamp   timestamptz NOT NULL,
  ship_symbol text NOT NULL,
  kind        text NOT NULL,
  detail      text NOT NULL,
  credits     integer
);
CREATE INDEX idx_activity_tenant_ts ON activity (tenant_id, timestamp);

CREATE TABLE missions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  target_system   text NOT NULL,
  target_waypoint text NOT NULL,
  status          text NOT NULL,
  assigned_ship   text,
  materials       jsonb NOT NULL,
  paused          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, target_waypoint)
);
CREATE INDEX idx_missions_tenant_status ON missions (tenant_id, status);

CREATE TABLE chat_messages (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role          text NOT NULL,
  content       text NOT NULL,
  tool_call_id  text,
  timestamp     timestamptz NOT NULL
);
CREATE INDEX idx_chat_tenant_ts ON chat_messages (tenant_id, timestamp);

-- ── Tenant-scoped: single-row-per-key settings ─────────────────
-- (doctrine, fleet role/flags, buckets, warehouse targets — every one of
-- these was a `key TEXT PRIMARY KEY` table in straders; the composite
-- (tenant_id, key) primary key here is the direct Postgres equivalent and
-- is what ON CONFLICT upserts target.)

CREATE TABLE doctrine (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      double precision NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE fleet_state (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol   text NOT NULL,
  role          text NOT NULL,
  keeper_market text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ship_symbol)
);

CREATE TABLE fleet_flags (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE buckets (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL,
  target      double precision NOT NULL,
  pct         double precision NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  balance     double precision NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE bucket_ledger (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timestamp timestamptz NOT NULL,
  bucket    text NOT NULL,
  delta     double precision NOT NULL,
  reason    text NOT NULL
);
CREATE INDEX idx_bucket_ledger_tenant_ts ON bucket_ledger (tenant_id, timestamp);

-- ── Tenant-scoped: warehouse ────────────────────────────────────

CREATE TABLE warehouse (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  good_symbol text NOT NULL,
  units       integer NOT NULL DEFAULT 0,
  avg_cost    double precision NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, good_symbol)
);

CREATE TABLE warehouse_ledger (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timestamp   timestamptz NOT NULL,
  good_symbol text NOT NULL,
  delta       integer NOT NULL,
  price       double precision NOT NULL,
  ship_symbol text,
  reason      text NOT NULL
);
CREATE INDEX idx_warehouse_ledger_tenant_ts ON warehouse_ledger (tenant_id, timestamp);
CREATE INDEX idx_warehouse_ledger_tenant_good ON warehouse_ledger (tenant_id, good_symbol);

-- Curated per-good warehouse targets: without a row here, a good is never
-- bought/sold through the warehouse, however profitable its route.
CREATE TABLE warehouse_targets (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  good_symbol text NOT NULL,
  target      integer NOT NULL,
  for_mission boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, good_symbol)
);

-- ── Shared, ungated: public galaxy data ─────────────────────────
-- No tenant_id, no RLS. Same rows for every tenant on the same server reset.

CREATE TABLE market_snapshots (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_symbol   text NOT NULL DEFAULT '',
  waypoint_symbol text NOT NULL,
  good_symbol     text NOT NULL,
  type            text NOT NULL,
  supply          text NOT NULL,
  purchase_price  double precision NOT NULL,
  sell_price      double precision NOT NULL,
  trade_volume    integer NOT NULL,
  timestamp       timestamptz NOT NULL
);
CREATE INDEX idx_snap_waypoint_good ON market_snapshots (waypoint_symbol, good_symbol);
CREATE INDEX idx_snap_ts ON market_snapshots (timestamp);

CREATE TABLE shipyard_inventory (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp       timestamptz NOT NULL,
  system_symbol   text NOT NULL,
  waypoint_symbol text NOT NULL,
  ship_type       text,
  ship_type_name  text,
  purchase_price  integer,
  fuel_capacity   integer,
  cargo_capacity  integer,
  module_slots    integer,
  mounting_points integer,
  frame_symbol    text,
  unique_key      text NOT NULL UNIQUE
);
CREATE INDEX idx_shipyard_waypoint ON shipyard_inventory (waypoint_symbol);
CREATE INDEX idx_shipyard_system ON shipyard_inventory (system_symbol);

CREATE TABLE module_catalog (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp       timestamptz NOT NULL,
  system_symbol   text NOT NULL,
  waypoint_symbol text NOT NULL,
  module_symbol   text,
  mount_symbol    text,
  name            text NOT NULL,
  category        text NOT NULL,
  purchase_price  integer NOT NULL,
  unique_key      text NOT NULL UNIQUE
);
CREATE INDEX idx_module_waypoint ON module_catalog (waypoint_symbol);
CREATE INDEX idx_module_symbol ON module_catalog (module_symbol, mount_symbol);
CREATE INDEX idx_module_system ON module_catalog (system_symbol);

-- Lock down every tenant-scoped table created above.
SELECT apply_tenant_rls();
