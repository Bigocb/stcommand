-- Operator override: buy for this feed regardless of the margin gate
-- (src/engine/feed.ts's stepCarrier() now pauses a buy cycle when the
-- source price leaves no real margin against the destination's current
-- sell price, instead of buying every cycle unconditionally). Force is
-- for the cases an operator wants the route run through anyway --
-- a contract deadline, or just wanting the good moving regardless of
-- the spreadsheet math for now.

ALTER TABLE feed_missions ADD COLUMN IF NOT EXISTS force boolean NOT NULL DEFAULT false;
