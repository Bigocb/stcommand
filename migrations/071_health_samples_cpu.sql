-- Box CPU on the health board (src/engine/cpuHealth.ts, operator 2026-11-27): the server row of each minute's reading also
-- keeps the process CPU share over the last 10 minutes (percent, 100 = one core) and the event-loop delay p99 (ms), so CPU
-- can be charted against uptime when deciding whether periodic restarts are worth it. NULL on tenant rows and on rows
-- written before this column existed.
ALTER TABLE health_samples
  ADD COLUMN IF NOT EXISTS cpu_pct real,
  ADD COLUMN IF NOT EXISTS loop_p99_ms real;
