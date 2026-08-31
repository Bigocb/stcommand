# Policy library + new-agent onboarding — design doc

Two related asks: let a captain add/remove policies from a growing catalog
(not just tune the fixed set that ships in code), and give a brand-new agent
token a guided first-run screen to choose its starting policies instead of
silently inheriting whatever the code's defaults happen to be.

---

## 1. What exists today

`doctrine.ts`'s `DEFAULTS` is a fixed, code-level array (~10 rules —
`marginFloor`, `maxLossPct`, `minerTarget`, `keeperCount`, etc.). Every
tenant gets every one of them, always, with only two dials: its numeric
`value` and `enabled`/disabled. There's a separate dynamic mechanism for
per-ship-type fleet caps (`shipCap:SHIP_X`), auto-created the first time a
hull type is seen.

Persistence: one `doctrine` table per tenant (`key, value, enabled`), RLS-
scoped. `Doctrine.reload()` loads it into an in-memory cache at boot;
`list()`/`value()`/`isEnabled()` read that cache synchronously (dozens of
call sites per tick, deliberately not async). `set()` writes through.

Book mode (`v2.html`'s `renderBook()`) renders `doctrineRules` (`list()`'s
output) as prose clauses with a toggle switch and a click-to-edit value —
but the *set of clauses shown* is always exactly `DEFAULTS`, because that's
also exactly the set the tenant has rows for or falls back to. There's no
concept of a rule that exists in code but isn't yet part of a given
tenant's fleet.

First login (`findOrCreateTenant`, an upsert keyed on `agent_symbol`) has no
special path — a brand-new tenant boots with an empty `doctrine` table,
`list()` silently falls back to `DEFAULTS` for everything, and the operator
never sees a moment where they chose anything.

### The gap this closes
Every future policy (repair floor, anything from further API-feature work)
either has to ship "on for everyone, forever" the moment it's coded, or
"on for no one until they happen to notice a new row in Book mode." Neither
is right. And a first-time captain never gets asked what kind of fleet they
want to run — they just get whatever the code shipped with that week.

---

## 2. Data model change

Rename the code-level concept from "the fixed rule set" to "the catalog" —
`DEFAULTS` becomes `POLICY_CATALOG`, a superset that can grow over time
without touching any existing tenant's behavior. Each entry gains one field:

```ts
interface PolicyDefinition extends DoctrineRule {   // DoctrineRule's existing shape, unchanged
  category: "trading" | "fleet" | "risk" | "ops";   // groups the library/onboarding UI
  /** True for every rule that exists today — grandfathers current tenants
   *  in without a backfill migration (see §5). A brand-new catalog entry
   *  added later defaults to false: opt-in only, discovered via the library
   *  or offered at onboarding for genuinely new tenants. */
  defaultAdopted: boolean;
}
```

Persistence: add one column to the existing `doctrine` table rather than a
new table — it already *is* the per-tenant override store, and every read/
write path already goes through `Store.getDoctrine()`/`setDoctrine()`.

```sql
ALTER TABLE doctrine ADD COLUMN adopted boolean NOT NULL DEFAULT true;
```
(`DEFAULT true` matters for the migration — see §5 — not because new rows
should default that way going forward; `setDoctrine()`'s call sites always
pass it explicitly after this lands.)

### Reading: three states per policy, not two
- **Adopted + enabled** — active, engine uses it, shows as a normal clause.
- **Adopted + disabled** — in the fleet's policy set but switched off (today's
  existing "disabled" state, unchanged).
- **Not adopted** — no row, or `adopted = false`. Behaves exactly like
  "disabled" for every engine read (`value()`'s `whenOff` fallback,
  `isEnabled()` returning the base default) — not adopting a policy must
  never change engine behavior beyond "this rule doesn't apply," so nothing
  above `Doctrine` needs to change. The only place "adopted" is a new,
  separate question from "enabled" is `list()`/a new `catalog()` method, for
  Book mode and the onboarding screen to render.

```ts
list(): DoctrineRule[] {
  // unchanged shape, but now only rows the tenant has actually adopted
  // (explicit row with adopted=true, OR a catalog entry with
  // defaultAdopted=true and no explicit row at all — the grandfather case).
}

catalog(): (PolicyDefinition & { adopted: boolean })[] {
  // every POLICY_CATALOG entry, tagged with this tenant's adopted state —
  // what the library and onboarding screen both render from.
}

async setAdopted(key: string, adopted: boolean, initialValue?: number): Promise<DoctrineRule | undefined> {
  // writes/updates the doctrine row's `adopted` column (and value/enabled
  // if this is a first-time add). Removing sets adopted=false rather than
  // deleting the row — cheap to re-add later with whatever value the
  // captain had it tuned to.
}
```

---

## 3. Book mode: the policy library

Additive to the existing clause list, not a replacement:

- Each active clause keeps its current enable/disable toggle, and gains a
  small "Remove" affordance next to it — calls `setAdopted(key, false)`,
  clause disappears from the active list on the next render.
- A new **Policy Library** section (collapsed by default, a "+ Add a
  policy" disclosure at the bottom of the standing-orders sheet, same
  prose-document feel as the rest of Book mode) lists every
  `POLICY_CATALOG` entry the tenant hasn't adopted, grouped by `category`,
  each with an "Add" button — calls `setAdopted(key, true)` with the
  catalog's declared starting value, clause appears in the active list.
- `GET /api/doctrine` response gains a `catalog` array alongside the
  existing `rules`; `POST /api/doctrine` gains an `adopted` action
  alongside the existing value/enabled patch (or a separate
  `POST /api/doctrine/adopt`, mirroring the existing route's shape —
  exact split TBD at implementation time, not load-bearing for this doc).

---

## 4. New-agent onboarding

### Trigger
`findOrCreateTenant`'s `INSERT ... ON CONFLICT ... DO UPDATE` can report
whether the insert or the update branch fired in the same query
(`RETURNING (xmax = 0) AS inserted` — standard Postgres technique, one
query, no extra round-trip). `gate.ts`'s login/register routes already call
this; thread `isNewTenant` through to the session response so the frontend
knows to launch onboarding immediately after auth succeeds, before the
first `loadState()`.

### Flow
A full-screen step (not a modal over a half-loaded dashboard — this is
before the captain has any reason to look at Bridge/Fleet/Markets yet):

1. **Welcome** — one line of framing ("Set your standing orders before the
   fleet launches — you can change any of this later from the Book").
2. **Catalog, grouped by category**, each entry pre-checked exactly where
   `defaultAdopted: true` says (today's behavior, so a captain who just
   clicks through gets what every tenant gets today — no regression), with
   its description and value control right there (same click-to-edit
   affordance Book mode already has for values).
3. **Confirm** — writes an explicit `adopted` row for every catalog entry
   (checked → `adopted:true` with whatever value they left it at; unchecked
   → `adopted:false`), not just the ones they touched. This is the one
   place a tenant's row set becomes fully explicit — after this, "not
   adopted" for this tenant means "the captain saw this and skipped it,"
   not "this didn't exist yet when they onboarded."
4. Redirect into the dashboard proper.

### Must not be a hard gate
The engine already has a complete, safe fallback for an empty `doctrine`
table (that's what every tenant runs on today, pre-feature). If the captain
closes the tab mid-onboarding, `list()`'s grandfather-fallback behavior
means the fleet runs exactly as it would have with no onboarding at all —
nothing breaks, nothing blocks fleet boot. Onboarding is a nicety layered
on an already-safe default, not new required state. A tenant that skips it
entirely can still open Book mode's library later and adopt things
individually — onboarding is just the one-time guided version of the same
mechanism.

---

## 5. Migration & rollout

`ALTER TABLE doctrine ADD COLUMN adopted boolean NOT NULL DEFAULT true`
means every existing row (every tenant's every prior explicit
value/enabled override) becomes `adopted = true` automatically — no
backfill script needed, no risk of an existing tenant's tuned fleet
suddenly losing a rule it was relying on. Combined with `list()`'s
grandfather clause (`defaultAdopted: true` catalog entries with *no* row
at all still show as adopted), every current tenant's Book page renders
identically to before this ships, for both rules they'd tuned and ones
they'd never touched.

New catalog entries added after this ships (repair floor, anything future)
get `defaultAdopted: false` — invisible to existing tenants until they
open the library, offered as a real choice to a brand-new tenant going
through onboarding for the first time.

---

## 6. Tests

- `Doctrine.list()`: a `defaultAdopted:true` catalog entry with no row
  shows adopted (grandfather case); a `defaultAdopted:false` entry with no
  row is absent; a row with `adopted:false` is absent regardless of
  `defaultAdopted`; a row with `adopted:true` and `enabled:false` still
  shows (disabled, not removed) — the three-state matrix from §2.
- `Doctrine.value()`/`isEnabled()`: unchanged behavior pre- and post-
  migration for every existing rule — the regression test that actually
  matters here, since nothing above `Doctrine` should need to change at
  all.
- `setAdopted()`: adding writes value/enabled from the catalog's declared
  starting point on first adopt; removing preserves the tuned value/enabled
  for a later re-add rather than resetting it.
- `findOrCreateTenant`: `isNewTenant` true only on genuine first insert,
  false on every subsequent login for the same `agent_symbol` (including
  after a token rotation, which already upserts rather than inserting).
- Onboarding route: confirming with a partial selection writes explicit
  rows for every catalog entry, not just the checked ones (the "no future
  ambiguity" property from §4 step 3).

## Suggested build order
Data model + `Doctrine` three-state logic first (self-contained, fully
covered by unit tests, zero UI). Book mode library second (needs the data
model, delivers the "add/remove" ask on its own). Onboarding last — it's
the same `setAdopted()` plumbing wearing a guided-flow UI, and only matters
once there's a real second catalog entry (repair) worth being asked about.
