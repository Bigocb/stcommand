-- Which route a trade belonged to. A PURCHASE or SELL row said where it happened but not the trip it was part of, so
-- "what was THEOREM-4 flying when it sold this" had to be guessed from neighbouring rows. `route` is a short readable
-- tag stamped when the row is written (src/engine/routeTag.ts), e.g. "X1-CM13-B7>X1-CM13-H60 auto circuit1".
-- Null on rows written before this and on trades with no route (fuel, jumps, mined cargo, contracts).
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS route text;
