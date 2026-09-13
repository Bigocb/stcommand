-- Persists GalaxyAtlas's gate-construction cache — same shared, no-tenant-id
-- pattern as galaxy_jump_costs (migration 017) and for the identical reason:
-- a gate's construction status is a fact about the galaxy, not about which
-- tenant happened to check it, and every tenant's own live check should
-- help every other tenant skip a redundant one.
--
-- Before this, gateConstruction lived only in GalaxyAtlas's in-memory Map
-- (galaxy.ts), wiped on every restart. Confirmed live: with deploys
-- happening several times a day, canJump() — which RouteDispatcher.recompute()
-- requires to be true before it will ever assign a cross-system "direct"
-- route — kept reading false for gate pairs a tenant's own explorers had
-- already jumped through successfully in an earlier process lifetime,
-- silently dropping a route with real, positive profit (confirmed live:
-- DRAGOM-1 stuck on a same-system FUEL leg worth 286c/trip while
-- ELECTRONICS@X1-YB82-BD9F, worth 44,976c/trip, sat unassignable) in favor
-- of whatever same-system fallback was left.
CREATE TABLE IF NOT EXISTS galaxy_gate_construction (
  gate_symbol text PRIMARY KEY,
  is_complete boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
