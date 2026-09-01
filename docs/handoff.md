# Handoff — parallel UI versions (v3/v4/v5)

For whoever picks this up next, cold. Read this before touching anything.

Branch: **`ui-parallel-versions`**, 5 commits ahead of `main`, **not pushed**.
Working tree clean. `main` is deployed to production and auto-deploys on push.

---

## 1. The job

Ship three redesigned UIs alongside the current one, as `/v3`, `/v4`, `/v5`.
The full plan — measured, phased, with acceptance criteria — is
**`docs/ui-versions-plan.md`**. Read it; this file only covers state and
traps that aren't in it.

Designs (published artifacts, all approved by the user):

| What | Link |
|---|---|
| Three directions, Bridge screen each | https://claude.ai/code/artifact/8327f806-3afe-46fc-b34d-8e2ef60314cb |
| Mission Control's other five screens | https://claude.ai/code/artifact/178b3520-400a-4fba-a0c0-1bfb03d3cbfa |
| The build plan, rendered | https://claude.ai/code/artifact/a795cd22-6e03-4ea1-9e21-3fee4a15ad39 |

Decisions the user has already made — do not re-litigate:

- Build **all three**, in order **v3 → v5 → v4**.
- Work on a **feature branch**; the user verifies before merge. Pushes to
  `main` auto-deploy to the live fleet.
- v1 (`public/index.html`) is **deleted**. Done.
- Test DB: the user offered their Postgres. Done — see §3.

## 2. Where things actually stand

**Phase 0 has not started. `public/v2.html` is untouched.**

Everything committed so far is prerequisite work, not plan work:

```
c4cd309  Record the RLS false-negative that caused two wrong diagnoses
2f62f63  Fix three tests the working database exposed
9adfdf6  Fix a boot crash for any injected fake API (regression from 722401d)
ee3a6a2  Delete the v1 UI
bc00a56  Make the DB schema configurable so tests get their own
```

Next action is Phase 0 step 1: extract the 9 base64 `@font-face` blobs out of
`v2.html` into `public/fonts/*.woff2` + `shared/fonts.css`. That alone takes
the file from 408KB to roughly 60KB. Then the `shared/*.js` modules.

**The user was asked whether to start Phase 0 or pause for review first, and
had not answered when this handoff was written.** Confirm before editing
`v2.html`.

## 3. Running the tests — read this or you will waste an hour

The suite could not run at all until this branch. Every DB-backed test failed
on `password authentication failed for user "stcommand"` — roughly 137
failures that were pure noise. If you see that error, you have not set the
env vars.

```bash
export TEST_DATABASE_URL='<ask the user — it is in .env, which is gitignored>'
DB_SCHEMA=stcommand_test node --test --import tsx tests/*.test.ts
```

- `DB_SCHEMA=stcommand_test` is **mandatory**. Without it the tests run
  against the live `stcommand` schema, and `store.test.ts` /
  `tenantRegistry.test.ts` both `DELETE FROM tenants`. That is the running
  fleet's data.
- The schema already exists and is migrated. To rebuild it:
  `DB_SCHEMA=stcommand_test DATABASE_URL=... npx tsx src/db/migrate.ts`
- **It is slow** — roughly 25 minutes, because it is a real remote database
  in Oregon with per-query latency. Run it in the background and do other
  work. Do not pipe it through `tail`, which buffers everything and hides the
  summary until the end; redirect to a file and grep.
- **Never commit the connection string.** It is a live production credential
  the user pasted in chat. It lives in `.env` (gitignored). Ask them for it.

## 4. The trap that has now cost two investigations

`FORCE ROW LEVEL SECURITY` is on every tenant-scoped table, and it applies to
the table owner too. **A psql session with no `app.tenant_id` set reads zero
rows from all of them** — no error, just an empty result that looks exactly
like missing data.

```sql
SET app.tenant_id = '<tenant uuid>';   -- THEN select
```

This produced two confident, wrong conclusions before it was caught (both
documented in `docs/adr/0001`):

1. A long-running "`withTenant()` silently persists zero rows" bug, complete
   with counters and watchdog instrumentation in `pool.ts`. **There was never
   a write bug.** The same tenant had 20 doctrine rows, 2 fleet_flags and
   4,062 ledger rows the whole time. Instrumentation removed.
2. A claim — stated as fact in commit `cf4c27b`'s message — that the live
   tenant had zero doctrine rows and was being force-paused at boot. It was
   not. The `tenants.onboarding_pending` column that motivated is a better
   design and is worth keeping, but it did not fix a real regression.

The sharper version: the shared galaxy tables (`market_latest`,
`shipyard_inventory`, `galaxy_systems`) have no RLS and query normally. So a
session reading those looks perfectly healthy while every tenant-scoped table
silently reads empty. That is why it was convincing twice.

## 5. Open items for the user (do not decide these yourself)

1. **Start Phase 0, or pause for review first?** Asked, unanswered.
2. **`snapshotMaxAgeMin` is un-adopted on the live tenant DAGGER.** This is
   the real cause of the "stale prices in the Markets tab" complaint —
   `Doctrine.value()` returns the `whenOff` fallback for an un-adopted rule,
   and `intelMaxAgeMin()` passes `5_256_000` (ten years), so nothing is
   filtered. Fix is theirs to apply: Book → Library → re-add "Intel
   freshness". **Their live doctrine has not been touched.**
3. **Should "off" mean "unconstrained" for intel freshness?** Sensible for a
   cash floor; for market data it means the dispatcher plans real trades on
   decade-old prices. A design call, not a bug.
4. **v4's non-Bridge views are undesigned** (Fleet/Markets/Trade Ops — dense
   tables fight the HUD idiom). Decide the fallback *before* Phase 4, not
   during. v5's equivalents are designed; see the artifact above.

## 6. Norms this work has been held to

- **Typecheck after every change** (`npm run typecheck`), and run the suite
  before pushing. The one regression that reached `main` (`9adfdf6`) got
  there precisely because the suite could not run.
- **Verify claims against the database before asserting them in a commit
  message.** See §4 for what happens otherwise.
- Commits are grouped by concern and messages explain *why*, including when
  the previous reasoning was wrong. `c4cd309` corrects `cf4c27b` rather than
  quietly superseding it.
- Migrations are numbered and applied with `npm run migrate`; production is
  currently at `011_galaxy_topology.sql`.

## 7. Stale file to ignore

`HANDOFF.md` in the repo root is untracked, from an older session, and
describes a GitHub-push-access problem that no longer exists. It is
misleading. Ignore or delete it — along with `stcommandhandoff.bundle`.
