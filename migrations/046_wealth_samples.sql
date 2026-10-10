-- Periodic sample of credits and hold value per tenant, for the "Credits + holds" chart on Metrics.
-- The ledger has the wallet after each trade but nothing records what the holds were worth over time,
-- so the engine writes one row every few minutes (fleet.ts sampleWealth()). History only; the newest row is
-- what "Credits + holds now" would show if the live figure were missing.

CREATE TABLE IF NOT EXISTS wealth_samples (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL,
  credits    bigint NOT NULL,
  holds      bigint NOT NULL,
  PRIMARY KEY (tenant_id, sampled_at)
);
ALTER TABLE wealth_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE wealth_samples FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wealth_samples USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
