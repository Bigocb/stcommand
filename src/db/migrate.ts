import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";
import { createPool } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "migrations");

/**
 * Applies every `migrations/*.sql` file, in filename order, that hasn't run
 * yet against DATABASE_URL — tracked in `schema_migrations`. Nothing is
 * deployed yet (see README.md), so there's no already-migrated database to
 * stay compatible with; a fresh database just runs every file once, in
 * order, and records each as applied.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = createPool(connectionString);
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS stcommand`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS stcommand.schema_migrations (
         filename    text PRIMARY KEY,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const already = await pool.query(`SELECT 1 FROM stcommand.schema_migrations WHERE filename = $1`, [file]);
      if (already.rowCount) {
        console.log(`skipped (already applied): ${file}`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await pool.query(sql);
      await pool.query(`INSERT INTO stcommand.schema_migrations (filename) VALUES ($1)`, [file]);
      console.log(`migrated: ${file}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
