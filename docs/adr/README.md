# Architecture Decision Records

This is the decision log: one file per architecturally significant
decision, written once it's actually landed. Short, past-tense, narrative
— what was decided, why, and what alternative was rejected and why. Not a
design doc (see below for that) and not a changelog entry (see
`CHANGELOG.md` — that's for "what shipped," this is for "why we built it
this way").

## When to write one

Write an ADR when a decision would otherwise get re-litigated or
misunderstood later — a tradeoff that isn't obvious from reading the code,
a path not taken and why, a constraint (like SpaceTraders' per-IP rate
limit) that shapes multiple unrelated parts of the system. Don't write one
for a straightforward bug fix or a small tuning change — that's a
`CHANGELOG.md` line.

## Process going forward

1. **Proposal stage** (optional, for anything non-trivial): write a
   longer-form doc under `docs/*-plan.md` — context, current-state
   analysis with file:line citations, proposed design, tradeoffs, phased
   implementation. This is where open questions get argued out. See
   `docs/unimplemented-api-features-plan.md` or
   `docs/ambiguous-mutation-safety-plan.md` for the format.
2. **Once it's actually implemented**: write the ADR — `NNNN-short-title.md`,
   next sequential number, a few hundred words, past tense. Link back to
   the plan doc if one existed. The plan doc can stay as historical
   record or get folded into the ADR; don't feel obliged to delete it.
3. **Add a line to `CHANGELOG.md`** for the change itself, linking the ADR.

A decision doesn't need to have gone through a plan doc first — a lot of
the existing ADRs below were written straight from a decision made in the
moment. The plan-doc stage is for decisions worth arguing out loud first,
not a mandatory gate.

## Index

| # | Decision |
|---|---|
| [0001](0001-postgres-rls-not-per-tenant-sqlite.md) | Postgres + RLS, not per-tenant SQLite |
| [0002](0002-single-shared-schema-not-schema-per-tenant.md) | Single shared schema, not schema-per-tenant |
| [0003](0003-bring-your-own-key-no-shared-credential.md) | Bring-your-own SpaceTraders token, no shared credential |
| [0004](0004-session-cookie-auth-no-jwt.md) | Session-cookie auth, not JWT |
| [0005](0005-one-process-n-tenant-workers-on-render.md) | One process, N tenant workers, on Render |
| [0006](0006-shipregistry-single-ownership-arbiter.md) | `ShipRegistry` as the single ownership arbiter |
| [0007](0007-unified-scheduler-priority-queue.md) | Unified scheduler priority queue |
| [0008](0008-additive-dual-write-migration-discipline.md) | Additive, dual-write migration discipline |
| [0009](0009-eager-boot-known-tenants-on-process-start.md) | Eager-boot known tenants on process start |

Update this table whenever a new ADR is added — it's the fast way to scan
what's already been decided before re-opening the question.
