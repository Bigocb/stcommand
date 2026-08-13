# Standing Orders

Multi-tenant autonomous SpaceTraders fleet engine — the greenfield rewrite of
[straders](https://github.com/Bigocb/straders), built tenant-isolated from the
start instead of retrofitted onto a single-fleet design.

See [`docs/architecture-plan.md`](docs/architecture-plan.md) for the full
design: why Postgres + Row-Level Security instead of per-tenant SQLite files,
how bring-your-own-LLM-key settings work, and hosting on Render.

## Status

Phase 0 (repo scaffold): done.

- Postgres schema (`migrations/001_init.sql`) — every tenant-scoped table
  behind Row-Level Security, three shared galaxy-data tables ungated.
- Async `Store` (`src/db/store.ts`) — a representative slice ported from
  straders' `Store` (ledger, activity, doctrine, fleet flags, warehouse's
  weighted-average cost basis), proven against a real Postgres instance with
  tests that specifically verify cross-tenant isolation holds.

Not yet started: the rest of `Store`'s methods (mechanical, same three
patterns already proven), the engine core port (straders' `FleetManager` /
`TraderAgent` / etc. — expected to carry over close to unchanged per the
original multi-tenant plan's finding that none of it holds global state), the
gate/auth screen, `TenantRegistry`, and the LLM settings page.

## Local development

Requires a local Postgres. To stand one up quickly:

```
createuser stcommand --login --pwprompt --createdb
createdb stcommand --owner stcommand
```

```
cp .env.example .env   # fill in DATABASE_URL, SESSION_SECRET
npm install
npm run migrate
npm test
```

## Commands

| Command | Description |
| --- | --- |
| `npm run migrate` | Apply `migrations/001_init.sql` against `DATABASE_URL` |
| `npm test` | Run the test suite (needs `TEST_DATABASE_URL`, defaults to a local `stcommand` db) |
| `npm run typecheck` | Typecheck (`tsc --noEmit`) |
| `npm run build` | Build to `dist/` |
