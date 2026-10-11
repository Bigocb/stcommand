-- Which agent-and-week a ledger row belongs to: `<agent symbol>@<reset date>`, e.g. THEOREM@2026-10-11
-- (src/engine/universe.ts). The game resets weekly into a different universe and reuses ship symbols, so a row that
-- names THEOREM-1 cannot say which week it is from. With the key, a week's rows can be KEPT for comparison without
-- leaking into another week's numbers. NULL on rows written before this column existed.
--
-- The scoping is a RESTRICTIVE row-level-security policy rather than a filter added to each query: there are some twenty
-- ledger readers (metrics, cost basis, earnings, the ops tools), and the cost-basis ones in particular must never see a
-- previous week's purchase by a ship with the same symbol. A restrictive policy is ANDed with tenant_isolation, so every
-- read through withTenant() is scoped to the tenant's current universe, including a reader written next year.
--
-- `app.universe_key` is set by withTenant() from the tenant's current key. Unset or empty means "every universe", which is
-- what the week-over-week comparison and the pre-key behaviour use. A key that is set must match the row.
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS universe_key text;
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_universe_ts ON ledger (tenant_id, universe_key, timestamp);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'ledger' AND policyname = 'universe_scope') THEN
    CREATE POLICY universe_scope ON ledger AS RESTRICTIVE
      USING (nullif(current_setting('app.universe_key', true), '') IS NULL
             OR universe_key = current_setting('app.universe_key', true));
  END IF;
END
$$;
