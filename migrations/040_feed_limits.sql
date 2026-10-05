-- Per-feed loss tolerance and a supply-based stop rule.
--   max_loss_per_unit: credits per unit the feed will accept paying MORE than the destination pays (a
--     deliberately subsidised feed that keeps a producer's input healthy); null keeps the old 10% margin gate.
--   stop_at_supply: stop sourcing once the target market's supply for the good reaches this bucket
--     (MODERATE/HIGH/ABUNDANT); null never stops. Over-feeding an import makes its market "evolve" (trade
--     volume and consumption grow), after which it needs far more to stay supplied.
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS max_loss_per_unit integer;
ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS stop_at_supply text;
