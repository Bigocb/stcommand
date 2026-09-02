/**
 * Refuses to let the test suite run against the production schema.
 *
 * store.test.ts and tenantRegistry.test.ts both `DELETE FROM tenants`, and
 * the shared galaxy tables get seeded with fixture rows. Pointed at
 * `stcommand` that destroys the running fleet's data — tenants, ledger,
 * doctrine, the lot, via ON DELETE CASCADE.
 *
 * Wired as npm's `pretest`, so it runs automatically before `npm test` and
 * cannot be forgotten. It guards the documented path, not every possible
 * one: invoking `node --test` directly still bypasses it.
 */
const PRODUCTION_SCHEMA = "stcommand";

const schema = process.env.DB_SCHEMA;
const url = process.env.TEST_DATABASE_URL;

const fail = (msg) => {
  console.error(`\n  refusing to run tests: ${msg}\n`);
  console.error("  Fix: copy .env.test.example to .env.test and fill it in.");
  console.error("  `npm test` loads that file automatically — no manual exports.\n");
  process.exit(1);
};

if (!schema) {
  fail("DB_SCHEMA is not set, so the suite would fall back to the production schema.");
}
if (schema === PRODUCTION_SCHEMA) {
  fail(`DB_SCHEMA is "${PRODUCTION_SCHEMA}" — the live schema. These tests delete tenants.`);
}
if (!url) {
  fail(
    "TEST_DATABASE_URL is not set, so every DB-backed test would fall back to\n" +
      "  localhost and fail with 'password authentication failed for user \"stcommand\"'.",
  );
}

console.log(`  tests will use schema "${schema}"`);
