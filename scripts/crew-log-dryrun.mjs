/**
 * What the crew log would have done, against real history, for free.
 *
 * Runs the trigger and budget model over a tenant's actual activity rows and
 * reports how often it would have fired and about what — no model calls, no
 * writes, nothing to undo. The point is to settle "is this interesting, and
 * what does it cost" before any of it is switched on.
 *
 * Read-only: one SELECT against `activity`. It sets app.tenant_id because
 * every one of those tables is FORCE ROW LEVEL SECURITY and a session
 * without it sees zero rows — which reads exactly like an empty fleet.
 *
 *   node --env-file=.env scripts/crew-log-dryrun.mjs [--hours 24] [--budget 12]
 */
import pg from "pg";
import { detectCrewEvents, selectForLogging } from "../src/engine/crewLog.ts";
import { defaultPersonaFor } from "../src/engine/personas.ts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const HOURS = Number(arg("hours", 24));
const BUDGET_PER_HOUR = Number(arg("budget", 12));
/** How often the engine would evaluate triggers. */
const PASS_MINUTES = 5;

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set (try: node --env-file=.env ...)"); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  options: `-c search_path=${process.env.DB_SCHEMA ?? "stcommand"}`,
  ssl: /(?:^|@)(localhost|127\.0\.0\.1)(?::|\/)/.test(url) ? undefined : { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  const tenants = await client.query(`SELECT id, agent_symbol FROM tenants ORDER BY created_at`);
  if (!tenants.rowCount) { console.log("no tenants"); process.exit(0); }

  for (const t of tenants.rows) {
    await client.query(`SET app.tenant_id = '${t.id}'`);
    const { rows } = await client.query(
      `SELECT timestamp, ship_symbol, kind, detail, credits FROM activity
       WHERE timestamp > now() - ($1 || ' hours')::interval ORDER BY timestamp ASC`,
      [HOURS],
    );
    const activity = rows.map((r) => ({
      timestamp: r.timestamp.toISOString(), shipSymbol: r.ship_symbol,
      kind: r.kind, detail: r.detail, credits: r.credits ?? undefined,
    }));

    console.log(`\n═══ ${t.agent_symbol} — ${activity.length} activity rows over ${HOURS}h ═══`);
    if (!activity.length) { console.log("  (nothing to replay)"); continue; }

    // Every hull that appears in the window. Crew size is not in the
    // activity table, so the dry run assumes each is crewed — which
    // *overstates* the rate, and overstating a cost estimate is the safe
    // direction to be wrong in.
    const hulls = [...new Set(activity.map((a) => a.shipSymbol))];
    const ships = hulls.map((symbol) => ({ symbol, crew: { current: 1, capacity: 1, morale: 100 } }));

    const t0 = new Date(activity[0].timestamp).getTime();
    const t1 = new Date(activity.at(-1).timestamp).getTime();
    const budgetPerPass = Math.max(1, Math.round((BUDGET_PER_HOUR * PASS_MINUTES) / 60));
    const known = new Map();
    const lastLoggedAt = new Map();
    const written = [];

    for (let at = t0; at <= t1; at += PASS_MINUTES * 60_000) {
      const window = activity.filter((a) => {
        const ts = new Date(a.timestamp).getTime();
        return ts > at - PASS_MINUTES * 60_000 && ts <= at;
      });
      if (!window.length) continue;
      const events = detectCrewEvents(ships, window, { knownSystems: known });
      for (const e of selectForLogging(events, { budget: budgetPerPass, now: at, lastLoggedAt })) {
        lastLoggedAt.set(e.shipSymbol, at);
        written.push(e);
      }
    }

    const span = Math.max((t1 - t0) / 3_600_000, 0.01);
    const byKind = {};
    for (const e of written) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const byShip = {};
    for (const e of written) byShip[e.shipSymbol] = (byShip[e.shipSymbol] ?? 0) + 1;

    console.log(`  hulls seen:      ${hulls.length}`);
    console.log(`  entries:         ${written.length} over ${span.toFixed(1)}h  →  ${(written.length / span).toFixed(1)}/hour`);
    console.log(`  by trigger:      ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
    console.log(`  hulls that spoke: ${Object.keys(byShip).length} of ${hulls.length}`);
    // Batched 4 per call, ~800 prompt + ~320 completion tokens per call.
    const calls = Math.ceil(written.length / 4) / span;
    console.log(`  est. cost:       ~${calls.toFixed(1)} calls/hour batched 4-up (~${Math.round(calls * 1120)} tokens/hour)`);

    console.log("  sample:");
    for (const e of written.slice(0, 6)) {
      console.log(`    [${e.kind}] ${e.shipSymbol} (${defaultPersonaFor(e.shipSymbol).name}) — ${e.detail}`);
    }
  }
} finally {
  client.release();
  await pool.end();
}
