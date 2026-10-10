# Migrating stcommand from Render to the Lennox box

Written 2026-10-10 for an agent that will SSH into the box at **100.100.95.94** (a Tailscale address) and set stcommand up there. Read all of it before touching anything. The repo's own `CLAUDE.md`, `CONTEXT.md` and `docs/architecture-overview.md` are the background reading; this file is the runbook.

## 0. Ground rules

1. **The live fleet is running on Render right now.** Do not start an engine on the box that is configured with the live tenant's SpaceTraders token or the live database until the operator says the cutover is happening. Two engines driving the same ships doubled refuels, sold cargo the ship no longer held and caused 429 storms (see `src/core/instanceGate.ts`). Phase A below is built so nothing on the box can touch the live fleet.
2. **The operator decides the cutover.** Setting the box up today is Phase A. Phase B (the cutover) is a separate decision. Stop at the end of Phase A and report.
3. **Never print, log, commit or paste secrets.** That covers `SESSION_SECRET`, `ADMIN_KEY`, `ST_ACCOUNT_TOKEN`, `DATABASE_URL` and the LLM key. Put them in a root-only env file (`chmod 600`) and refer to them by name.
4. **Do not change the code or the Render service.** This job is infrastructure only. If something in the repo looks wrong, write it down in your report.
5. **Reset timing.** SpaceTraders resets the whole universe on **Sunday 2026-10-11 13:00 UTC**. Every agent token dies at that moment. This matters for the cutover choice in section 7.

## 1. What this application is

`stcommand` ("Standing Orders") is one Node process that runs an autonomous fleet engine for every tenant, plus an Express web server. There is no separate worker, queue or cache.

| Piece | Detail |
|---|---|
| Runtime | Node 22 (the repo was last built with 22.22.2), ES modules, TypeScript compiled to `dist/` |
| Entry point | `node scripts/start.mjs`, which imports `dist/cli/index.js`. If `dist/` is missing it falls back to `tsx` and uses about 2.5x the memory, so make sure the build ran |
| Build | `npm ci` runs a `postinstall` of `npm run build` (`tsc -p tsconfig.build.json`). `typescript` is a normal dependency, so a production-only install still builds |
| Database | PostgreSQL 15 or newer (it uses `gen_random_uuid()` from `pg_catalog`). One database, one schema named `stcommand` |
| Migrations | `migrations/*.sql` (46 files), applied automatically at every boot by `runMigrations()`, tracked in `stcommand.schema_migrations`. They are idempotent. `npm run migrate` also exists |
| HTTP | `PORT` (default 3000). `/healthz` returns `ok`. Pages: `/deck` (desktop), `/m` (mobile "Tower"), `/admin`, `/cartography`. `/mcp` is the hosted MCP server. `/api/*` is the dashboard API |
| Memory | About 100 MB for the compiled server on an empty database, growing to roughly 120 MB heap and 300 MB RSS with a full fleet. Render ran it on 512 MB |
| Outbound | Must reach `https://api.spacetraders.io` (HTTPS). SpaceTraders rate-limits by source IP at about 2 requests per second, so the box's IP has its own budget |

### Multi-tenancy and Row-Level Security (important)

Every tenant table has `FORCE ROW LEVEL SECURITY` keyed on `current_setting('app.tenant_id')`, set by `SET LOCAL` inside a transaction (`src/db/pool.ts`, `withTenant`). Two consequences for the database setup:

- **The application must connect as an ordinary role, not a superuser and not a role with `BYPASSRLS`.** A superuser ignores RLS, which would silently remove tenant isolation. Create a dedicated role.
- An ad-hoc `psql` session has no `app.tenant_id`, so it sees **zero rows** in tenant tables even when they are full. That is a false negative, not data loss. To inspect: `BEGIN; SET LOCAL app.tenant_id = '<tenant uuid>'; SELECT ...;`.

`sessions` and `tenant_mcp_keys` are not RLS-scoped (looked up before the tenant is known).

### The connection pool

`createPool()` uses `max: 20`, sets `search_path=stcommand` through libpq options, and **turns TLS off when the host is `localhost` or `127.0.0.1`** (any other host uses TLS with `rejectUnauthorized: false`). Run Postgres on the same box and connect via `localhost`. Do not put PgBouncer in front of it without checking: it uses transaction-scoped `SET LOCAL`, which works, but nothing else has been verified with a pooler.

## 2. Environment variables

Put these in `/etc/stcommand/stcommand.env` (mode 600, owned by root) and load it with systemd's `EnvironmentFile=`.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://stcommand_app:<password>@localhost:5432/stcommand`. Without it the server exits |
| `SESSION_SECRET` | yes | **Master key.** It encrypts every tenant's stored SpaceTraders token and LLM key, and signs session cookies and MCP key hashes. If a database copy is restored with a *different* secret, every stored token becomes unreadable. For a data-preserving move, copy the Render value exactly (the operator must supply it, take it from the Render dashboard, do not guess). For a fresh start, generate with `openssl rand -hex 32` |
| `ADMIN_KEY` | recommended | Protects `/admin`. If unset, every `/api/admin/*` call returns 503 (fails closed) |
| `PORT` | no | Default 3000 |
| `NODE_ENV` | see section 6 | `production` makes session cookies `Secure`, so they are dropped over plain HTTP |
| `ST_ACCOUNT_TOKEN` | **leave unset in Phase A** | Account token from my.spacetraders.io. The reset watcher uses it to register a fresh agent automatically after a reset. If set, the box will act on a detected reset. See section 7 |
| `AUTO_RESET_RECOVERY` | no | `off` makes the watcher detect and report only. **Set `off` in Phase A** |
| `RESET_FACTION` | no | Faction used for auto-registration. Default `COSMIC` |
| `ST_LLM_API_KEY`, `ST_LLM_MODEL`, `ST_LLM_BASE_URL` | no | Co-pilot chat and narrative. Optional |
| `PROXY_URL_<AGENTSYMBOL>` | no | Per-tenant outbound proxy. Not in use |
| `DB_SCHEMA` | no | Defaults to `stcommand`. **Never set this in production.** It exists so tests can use a throwaway schema |

Do not set `RENDER_INSTANCE_ID`. The process falls back to `<hostname>-<pid>`.

## 3. Step 0: discover the box (read-only)

Before installing anything, run these and put the output in your report. The operator has not yet told us the box's specs.

```bash
ssh <user>@100.100.95.94
cat /etc/os-release; uname -a
nproc; free -h; df -h
systemctl is-system-running
tailscale status; tailscale ip -4
node -v; npm -v; psql --version; git --version
ss -ltnp                      # what already listens, especially 3000 and 5432
systemctl list-units --type=service --state=running
docker ps 2>/dev/null
curl -sS -m 10 https://api.spacetraders.io/v2/ | head -c 400   # outbound check, no token needed
```

Stop and ask the operator if any of these is true:
- Less than about 1 GB of free RAM, or less than 5 GB of free disk.
- Port 3000 or a Postgres on 5432 is already in use by something else.
- The box has no outbound HTTPS to `api.spacetraders.io`.
- The OS is something other than a mainstream systemd Linux (the unit file below assumes systemd).

## 4. Phase A: build and verify (safe, no live data)

### 4.1 Packages

Debian/Ubuntu shown; adapt for other distros.

```bash
sudo apt-get update
sudo apt-get install -y postgresql postgresql-contrib git curl ca-certificates build-essential
# Node 22 (any method is fine; confirm with node -v):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Confirm Postgres is 15 or newer: `psql --version`. If it is older, stop and report.

### 4.2 Database and role

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE stcommand_app LOGIN PASSWORD '<generate one, store in the env file>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE stcommand OWNER stcommand_app;
SQL
sudo -u postgres psql -d stcommand -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='stcommand_app';"
```

`rolsuper` and `rolbypassrls` must both be `f`. Keep `listen_addresses = 'localhost'` (the default) so the database is not reachable from the network.

Tune lightly for a small box (`/etc/postgresql/*/main/conf.d/stcommand.conf`): `shared_buffers = 256MB` (about 25% of RAM, no more), `max_connections = 50` (the app needs up to 20), `synchronous_commit` left at the default. The Render database was a 256 MB instance that ran at about 96% memory and restarted roughly every 15 minutes on 2026-10-09; a local database with room to breathe should not.

### 4.3 Code

Repository: **https://github.com/Bigocb/stcommand** (private; GitHub owner `Bigocb`). Branch **`main`** is what Render runs. The working branch is `claude/stcommand-ui-parallel-versions-fd5p9q`; the two are kept in step, except that this runbook may be only on the working branch.

```bash
sudo useradd --system --create-home --shell /bin/bash stcommand
sudo -u stcommand git clone https://github.com/bigocb/stcommand.git /home/stcommand/app
cd /home/stcommand/app
sudo -u stcommand git checkout main        # Render deploys from main. This runbook itself may only exist on claude/stcommand-ui-parallel-versions-fd5p9q until main is next pushed; the code is the same
sudo -u stcommand npm ci                    # postinstall builds dist/
ls dist/cli/index.js                        # must exist
sudo -u stcommand npx tsc --noEmit          # typecheck, expect no output
```

If `git clone` needs credentials, ask the operator; do not invent a token.

### 4.4 Environment file for Phase A

```bash
sudo install -d -m 755 /etc/stcommand
sudo install -m 600 /dev/null /etc/stcommand/stcommand.env
sudo tee /etc/stcommand/stcommand.env >/dev/null <<EOF
DATABASE_URL=postgresql://stcommand_app:<password>@localhost:5432/stcommand
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_KEY=$(openssl rand -hex 32)
PORT=3000
AUTO_RESET_RECOVERY=off
EOF
```

Phase A uses a **throwaway** `SESSION_SECRET` and **no** `ST_ACCOUNT_TOKEN`, and the database is empty, so there are no tenants and no tokens: the box cannot touch SpaceTraders agents. Record the admin key in the operator's password manager, not in your report.

### 4.5 systemd unit

`/etc/systemd/system/stcommand.service`:

```ini
[Unit]
Description=stcommand fleet engine
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=stcommand
WorkingDirectory=/home/stcommand/app
EnvironmentFile=/etc/stcommand/stcommand.env
ExecStart=/usr/bin/node scripts/start.mjs
Restart=always
RestartSec=5
# A full fleet sits near 300 MB RSS; cap well above that so a leak restarts rather than starves the box.
MemoryMax=1G
# The app's own SIGTERM handler exits within 5 s.
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now stcommand
journalctl -u stcommand -f --no-pager        # expect "migrated: 001_init.sql" ... "migrated: 046_wealth_samples.sql", then "Standing Orders listening on :3000"
```

### 4.6 Verify

```bash
curl -sS http://localhost:3000/healthz                         # ok
sudo -u postgres psql -d stcommand -c "SELECT count(*) FROM stcommand.schema_migrations;"   # 46
sudo -u postgres psql -d stcommand -c "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='stcommand' AND relname IN ('ledger','doctrine','fleet_state');"   # all t / t
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/deck     # 200
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/admin/tenants   # 401 or 403 without the key (not 503, which means ADMIN_KEY is unset)
systemctl status stcommand --no-pager
ps -o rss,cmd -C node
```

Also confirm the galaxy crawler is running (it makes one public API call every 5 seconds with no token): `journalctl -u stcommand | grep -i crawl | tail`.

Optional: run the test suite on the box against a throwaway schema. It needs `.env.test` (`TEST_DATABASE_URL`, and `DB_SCHEMA=stcommand_test`); `npm test` runs `scripts/assert-test-schema.mjs` first, which refuses to run against the real schema. **Never run the tests with `DB_SCHEMA` unset or pointing at `stcommand`: they delete tenants.** If in doubt, skip the tests.

### 4.7 Operations

- **Backups:** a nightly `pg_dump -Fc -n stcommand stcommand > /var/backups/stcommand/$(date +%F).dump` from `/etc/cron.d`, 14 days retention, and a copy off the box if there is anywhere to put one. Test a restore once.
- **Logs:** journald is enough. Check retention (`journalctl --disk-usage`).
- **Time:** make sure `timedatectl` shows NTP synchronised. The fleet snapshots, the ledger and the SpaceTraders API timestamps all depend on a correct clock.
- **Updates:** deployment is manual here (no Render auto-deploy): `cd /home/stcommand/app && git pull origin main && npm ci && sudo systemctl restart stcommand`. The engine waits for a predecessor instance to stop before starting fleets (see section 7), so a normal restart is safe.

## 5. Reaching the box (decision for the operator)

`100.100.95.94` is a Tailscale address. It is only reachable from devices on the same tailnet. Two consequences:

1. **Claude's hosted environment and the Claude app's MCP connector cannot reach it.** The `stcommand` MCP server (`/mcp`) is currently connected over Render's public URL `https://stcommand.onrender.com`. If the MCP endpoint is only on the tailnet, the connector will stop working at cutover. Options: Tailscale Funnel (public HTTPS to the box, `tailscale funnel 3000`), a Cloudflare Tunnel, or a small reverse proxy on a public host. Funnel exposes the whole app, so keep `ADMIN_KEY` strong and consider restricting `/admin` in the proxy. Ask the operator which they want; do not enable Funnel on your own.
2. **Browsers on the tailnet** (the operator's phone running Tower, the desktop running Deck) can use `https://<box>.<tailnet>.ts.net` directly. Use `sudo tailscale serve --bg --https=443 http://localhost:3000` to get a real certificate.

Cookies: `src/http/gate.ts` marks the session cookie `Secure` when `NODE_ENV=production`. Behind `tailscale serve` (HTTPS) that is correct. If you test over plain `http://100.100.95.94:3000`, leave `NODE_ENV` unset or login will appear to succeed and then drop the session. If the app sits behind a TLS-terminating proxy, check whether Express needs `trust proxy`; nothing in the repo sets it, so report if cookies misbehave rather than editing code.

Firewall: allow SSH and, if you use it, the proxy port; the app port 3000 can stay bound to the interface Tailscale uses or to localhost only if `tailscale serve` fronts it.

## 6. What to carry over from Render (inventory)

The Render Postgres instance is `dpg-d79au56dqaus739isukg-a` (internal hostname) and **also hosts an unrelated app ("promptoria") in the `public` schema. Never dump or restore `public`.** Everything stcommand owns is in the `stcommand` schema.

State to carry over, in order of importance:

| Data | Tables | Why |
|---|---|---|
| Tenant identity | `tenants` (encrypted token, LLM key, Discord webhook), `tenant_mcp_keys` | Keeps the operator's MCP bearer key (`sctk_...`) working. The raw key is not recoverable, only its hash is stored |
| Standing orders | `doctrine`, `doctrine_fires` | The operator's rule settings (margin floors, route-match limits, and so on). A reset does not make these wrong |
| Operator history | `operator_actions`, `operator_notes`, `run_results` | Play-style tracking and per-week scoreboards |
| Game state, only if cutting over before the reset | everything else in `TENANT_GAME_TABLES` (`ledger`, `fleet_state`, `ship_state`, `missions`, and so on) | Needed only if the universe being run is the current one |
| Public galaxy data | `galaxy_*`, `market_*`, `shipyard_inventory`, `module_catalog` | Rebuilt by the crawler after a reset. Copy only if cutting over before the reset, to avoid a cold start |
| Disposable | `sessions`, `instance_heartbeats`, `tick_step_timings`, `chat_messages` | Do not carry |

`SESSION_SECRET` is what ties `tenants`, `tenant_mcp_keys` and every cookie together. See section 2.

## 7. Phase B: cutover options (the operator chooses; do not start without a go)

### Option 1: cut over right after the reset (recommended)

The reset at 13:00 UTC on 2026-10-11 wipes the game anyway, and every agent token dies at that moment. Moving then loses almost nothing and avoids two engines ever running on one universe.

1. Before the reset: take a **settings-only** dump from Render and restore it on the box with the engine **stopped**:
   ```bash
   pg_dump "<render external DATABASE_URL>" -Fc --no-owner --no-privileges -n stcommand \
     -t stcommand.tenants -t stcommand.tenant_mcp_keys -t stcommand.doctrine -t stcommand.doctrine_fires \
     -t stcommand.operator_actions -t stcommand.operator_notes -t stcommand.run_results \
     > stcommand-settings.dump
   ```
   The external URL is the one with the `.oregon-postgres.render.com` suffix (Render dashboard, database page, Connections). Restore into the empty `stcommand` schema **after the engine has booted once and applied the migrations** (so all tables exist), as `stcommand_app`, using `pg_restore --data-only --no-owner -d stcommand --disable-triggers` (note `--disable-triggers` needs a superuser; if that is a problem, restore in dependency order: `tenants` first, then the tables that reference it). Use the Render `SESSION_SECRET` in `stcommand.env`.
2. After the reset, the old tokens are dead. Either set `ST_ACCOUNT_TOKEN` and `AUTO_RESET_RECOVERY=on` so the watcher registers a fresh agent (see `docs/reset-opening-playbook.md` and `src/engine/resetWatcher.ts`), or re-register through the normal sign-in flow, then use `/admin` "After a server reset" to clear stale data. The watcher saves the previous week's scoreboard first.
3. **Stop the Render service** (suspend it in the dashboard; do not delete the database). Only one engine may run per universe.
4. Point the operator's MCP connector at the new URL (section 5) and give them the same `sctk_` key; it still works because `tenant_mcp_keys` was carried over with the same `SESSION_SECRET`.

### Option 2: move now, with the full database

1. Quiesce: ask the operator to approve. Suspend the Render service first (so nothing writes), then take a full dump of the `stcommand` schema: `pg_dump "<external url>" -Fc --no-owner --no-privileges -n stcommand > stcommand-full.dump`.
2. Restore on the box (engine stopped, same `SESSION_SECRET`), start the engine, and check the fleet in Deck.
3. Cost: the fleet is down for the dump and restore, and ships mid-flight keep flying (the game is real-time), but their in-memory intent is rebuilt from `fleet_state`. Anything the engine had not yet persisted is lost. Do this only if the operator accepts that with about a day left before the reset.

### Never do

- Run Render and the box against the same Render database at once: the instance gate (`instance_heartbeats`) waits up to 90 seconds for an older live instance, then starts anyway.
- Point the box at a restored copy while Render is still running with the same token. Two drivers, one fleet.

## 8. Rollback

Until the Render service is suspended there is nothing to roll back: stop the box (`systemctl stop stcommand`) and carry on. After cutover, rolling back means resuming the Render service and accepting that anything done on the box since is not on Render's database. If you used Option 2, take a final `pg_dump` from the box before resuming Render and keep it.

## 9. What to report back (end of Phase A)

1. Box specs from section 3, and any value that fell short.
2. The Node, Postgres and OS versions installed.
3. Confirmation of each check in 4.6, with the actual outputs for the migration count and the RLS and `rolsuper`/`rolbypassrls` queries.
4. How you made the app reachable (tailnet only, `tailscale serve`, or nothing yet), and what is open on the firewall.
5. Anything unexpected: errors in `journalctl -u stcommand`, a package that would not install, a check that failed.
6. A one-line statement that no SpaceTraders token was configured on the box.
7. What you need from the operator for Phase B: the Render `SESSION_SECRET`, the Render external connection string, the git credentials if the clone needed them, and the cutover choice from section 7.

## 10. Known gaps in this guide

- The box's specs and OS were not known when this was written, so section 3 is a discovery step rather than a fact.
- The Express `trust proxy` setting and the exact cookie behaviour behind a TLS-terminating proxy were not tested.
- `pg_restore --data-only` ordering for the settings-only restore was not rehearsed. Do a dry run into a scratch database first.
- Memory figures come from the 2026-10-10 profiling notes in `scripts/start.mjs`, not from the box.
