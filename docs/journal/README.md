# Week journal

One file per SpaceTraders week, named by the reset date (`2026-11-01.md` covers 2026-11-01 to the next reset). It records what
the code CHANGELOG does not: decisions, issues found and their causes, settings changed live, operator rules of thumb, and open
threads. Operator request (2026-11-05): "not just for code changes, but also for decisions, issues we figure out", so it can be
read back at the end of the week and used as working context during it.

## How to use it

- **Read the current week's file at the start of a session** (or after a summary/compaction), before acting on the fleet.
- **Append as things happen**, newest last within each day, under `## YYYY-MM-DD`. One short entry each, tagged:
  - **Decision**: what was decided, by whom (operator or Claude at the operator's request), and why.
  - **Rule**: a standing instruction from the operator that holds for the week (keep the "Standing rules" list at the top current).
  - **Issue**: a problem found, its cause if known, and what was done. Link the CHANGELOG entry or commit for code fixes.
  - **Action**: a live change to the fleet (release, stage, buy, role change, doctrine setting) with the numbers that drove it.
  - **Finding**: something learned about the game or the fleet (prices, rivals, rates) worth knowing later.
  - **Open**: a thread not finished; strike it or move it to Done when it closes.
- Times are UTC. Use real numbers (credits, ship symbols, systems). Write for someone who was not in the room.
- Code changes still get their own `CHANGELOG.md` entry; the journal links to it in one line rather than repeating it.
- At the end of the week, add a `## Week summary` (what worked, what did not, numbers) and carry the open threads and lessons into
  the next week's file and, where durable, into `CLAUDE.md` or `docs/reset-opening-playbook.md`.
