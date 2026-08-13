import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";
import { createPool } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies migrations/001_init.sql against DATABASE_URL.
 *
 * Deliberately simple for now — one file, run once against a fresh database.
 * A real migration runner (tracking which files have already applied) is a
 * later addition once there's more than one migration to track.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const sql = readFileSync(join(here, "..", "..", "migrations", "001_init.sql"), "utf8");
  const pool = createPool(connectionString);
  try {
    await pool.query(sql);
    console.log("migrated: 001_init.sql");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
