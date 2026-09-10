-- Persisted open trade positions: the durable twin of TraderAgent's
-- in-memory `heldRoute`/`heldCost` (src/engine/trader.ts).
--
-- Confirmed live: a process restart (which happens on every deploy) wipes
-- both maps. A trader that had already bought cargo woke up with no memory
-- of where it was headed, fell into clearLeftoverCargo()'s "no live route"
-- path, and dumped the position locally at a heavy loss. `heldRoute` — not
-- RouteDispatcher's own assignment map — is the thing that actually
-- protects money already spent (deliverHeldCargo() reads this directly,
-- never the dispatcher), so this is the one piece that needs to survive a
-- restart.
--
-- Keyed by (tenant_id, ship_symbol, good_symbol) rather than just
-- (tenant_id, ship_symbol) the way ship_state is: a ship can hold more than
-- one good at once (e.g. contract cargo alongside a direct-trade good).
--
-- No `SET search_path` here: src/db/pool.ts sets it per connection from
-- DB_SCHEMA, so this applies to whichever schema the migration run targets.

CREATE TABLE IF NOT EXISTS held_route (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ship_symbol text NOT NULL,
  good_symbol text NOT NULL,
  buy_at      text NOT NULL,
  sell_at     text NOT NULL,
  buy_price   numeric NOT NULL,
  sell_price  numeric NOT NULL,
  lot_size    integer NOT NULL,
  cost_basis  numeric NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ship_symbol, good_symbol)
);
ALTER TABLE held_route ENABLE ROW LEVEL SECURITY;
ALTER TABLE held_route FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON held_route USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX IF NOT EXISTS idx_held_route_tenant ON held_route (tenant_id);
