-- Web-push subscriptions: one row per device that asked to be notified (docs/notifications.md).
--
-- A subscription is the browser's push endpoint plus its two keys; `prefs` is that device's choices (which categories,
-- quiet hours, hourly cap) and `delivery` is what it has already been told, so a restart does not announce a standing
-- condition again. Not in Store.TENANT_GAME_TABLES on purpose: a device's subscription and choices are not about the
-- game universe and survive a reset.
--
-- Policy uses current_setting(..., true) like every other tenant table.

DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    endpoint     text NOT NULL,
    p256dh       text NOT NULL,
    auth         text NOT NULL,
    user_agent   text,
    prefs        jsonb NOT NULL DEFAULT '{}'::jsonb,
    delivery     jsonb NOT NULL DEFAULT '{"sent":{},"recent":[]}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    last_sent_at timestamptz,
    -- Consecutive failed sends that were not "gone" (a 404/410 deletes the row at once); reset on a success.
    failures     integer NOT NULL DEFAULT 0,
    last_error   text,
    UNIQUE (tenant_id, endpoint)
  );

  ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS tenant_isolation_push_subscriptions ON push_subscriptions;
  CREATE POLICY tenant_isolation_push_subscriptions ON push_subscriptions
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;
