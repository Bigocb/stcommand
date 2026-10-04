-- One row per agent per server-reset period: the scoreboard for "how did that
-- week go". Captured by ResetWatcher just before a reset wipes the old
-- universe's data (src/engine/resetWatcher.ts), or on demand for the week in
-- progress (Store.captureRunResult).
--
-- Deliberately NOT tenant-scoped (no RLS, no foreign key to tenants): it is
-- the durable record that must outlive both the weekly game-data wipe and
-- deleting a tenant, keyed by agent_symbol + the resetDate of the universe it
-- describes. The game-table wipe (Store.TENANT_GAME_TABLES) never touches it.
--
-- Money columns are credits as bigint. `ledger_by_type` stores each ledger
-- type's row count and total magnitude (the ledger keeps `total` positive;
-- direction comes from type). Headline numbers:
--   wallet_delta   = final_credits - starting_credits  (the real profit/loss)
--   trading_net    = SUM(realized_pnl) on SELL rows    (matched round trips only)
-- and the gap between them is fuel, jumps, ships bought and open cargo — see
-- CLAUDE.md "Reporting matched buy/sell P&L".
CREATE TABLE IF NOT EXISTS run_results (
  id                bigserial PRIMARY KEY,
  agent_symbol      text NOT NULL,
  tenant_id         uuid,
  reset_date        text NOT NULL,          -- resetDate of the universe this row describes ('unknown' if it was never seen)
  ended_by_reset    text,                   -- the resetDate that replaced it (null for an on-demand mid-week capture)
  captured_at       timestamptz NOT NULL DEFAULT now(),
  capture_kind      text NOT NULL DEFAULT 'reset',   -- 'reset' | 'manual'
  started_at        timestamptz,            -- earliest ledger/activity timestamp
  ended_at          timestamptz,            -- last state snapshot (≈ the moment the token died)
  home_system       text,
  headquarters      text,
  play_profile      text,

  starting_credits  bigint,                 -- the registration grant (175,000)
  final_credits     bigint,                 -- cash in hand at the end
  peak_credits      bigint,
  wallet_delta      bigint,                 -- final - starting
  ship_count        integer,
  ships_by_role     jsonb,                  -- fleet roles the app assigned (trader/miner/tour/…)
  ships_by_class    jsonb,                  -- the game's own ship roles (HAULER/EXCAVATOR/…)

  trading_net       bigint,                 -- sum of realized_pnl on SELLs
  trades            integer,                -- SELLs with a matched cost basis
  sell_revenue      bigint,
  purchase_cost     bigint,
  fuel_cost         bigint,
  jump_cost         bigint,
  jumps             integer,
  ship_spend        bigint,
  ledger_by_type    jsonb,
  top_ships         jsonb,                  -- best 5 ships by realized pnl
  top_goods         jsonb,                  -- best 5 goods by realized pnl
  contracts         jsonb,                  -- mission/contract counts by status
  doctrine          jsonb,                  -- the standing-order settings in force
  operator_actions  integer,                -- manual interventions that week
  notes             text,
  UNIQUE (agent_symbol, reset_date, capture_kind)
);
CREATE INDEX IF NOT EXISTS idx_run_results_agent ON run_results (agent_symbol, captured_at);
