-- Contract money, per contract. The ledger recorded only a contract's completion payout, with no way to say which contract
-- it belonged to, never the advance paid on accept, and never the delivery that consumed the goods bought for it, so the
-- metrics could not net a contract's income against its cost. contract_id ties these rows to one contract:
--   CONTRACT / trade_symbol ADVANCE  the credits paid on accept
--   CONTRACT / (null or PAYOUT)      the credits paid on completion (older rows have no id and no trade_symbol)
--   DELIVERY                         goods handed over: units, price_per_unit = cost basis per unit (null when mined), total 0
-- DELIVERY carries total 0 on purpose: it is not cash, and every cash formula sums totals by type.
ALTER TABLE ledger ADD COLUMN contract_id text;
CREATE INDEX idx_ledger_contract ON ledger (tenant_id, contract_id) WHERE contract_id IS NOT NULL;
