# One shared schema, not schema-per-tenant

Every tenant's rows live in the same tables, distinguished by `tenant_id`
and enforced by RLS — not Postgres's own native `CREATE SCHEMA tenant_xyz`
/ per-connection `search_path` alternative. Schema-per-tenant gives real
isolation too, but every future migration then has to run once per tenant
schema; that doesn't scale operationally the way one shared schema with RLS
does; a single `migrations/*.sql` file (tracked in `schema_migrations`)
applies once and covers every tenant. Three galaxy-data tables
(`market_snapshots`/`market_latest`, `shipyard_inventory`, `module_catalog`)
are deliberately excluded from tenant scoping entirely — they describe the
shared game world, not any one fleet, so gating them per-tenant would just
duplicate identical rows.
