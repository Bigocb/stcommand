import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import "dotenv/config";
import { createPool, dbSchema } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "migrations");

/**
 * Applies every `migrations/*.sql` file, in filename order, that hasn't run
 * yet against `pool`, in the schema DB_SCHEMA selects (default `stcommand`;
 * the test suite points this at a throwaway schema) — tracked in
 * `schema_migrations`. A fresh database runs every file once, in order, and
 * records each as applied; re-running is always safe (every migration in
 * this repo is itself idempotent — CREATE TABLE IF NOT EXISTS, ADD COLUMN
 * IF NOT EXISTS, etc.) but this skips already-applied ones anyway rather
 * than relying on that.
 *
 * Exported so cli/index.ts can call it at server boot (see that file's own
 * comment) rather than depending on a separate manual/deploy-pipeline step
 * to have run first — confirmed live: migration 015 shipped and deployed
 * with nothing having actually applied it, silently, until the crawler
 * that depended on its tables started erroring on every tick.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const schema = dbSchema();
  // Quoted identifier: dbSchema() has already rejected anything that isn't
  // a plain identifier, so this can't inject — the quotes just keep a
  // reserved-word schema name legal.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
       filename    text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const already = await pool.query(`SELECT 1 FROM "${schema}".schema_migrations WHERE filename = $1`, [file]);
    if (already.rowCount) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await pool.query(sql);
    await pool.query(`INSERT INTO "${schema}".schema_migrations (filename) VALUES ($1)`, [file]);
    console.log(`migrated: ${file}`);
  }
}

// Only run as a standalone script (`npm run migrate`) — cli/index.ts
// imports runMigrations() directly instead of shelling out to this file,
// so this guard keeps `tsx src/db/migrate.ts` working without a second
// process.exit()/pool.end() racing the one main() below already does.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = createPool(connectionString);
  runMigrations(pool)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
