-- Jump costs get their own ledger type. Until now a scout/manual/tour jump was
-- written as type='REFUEL' with units=0 (the only way to tell it from a real
-- refuel, which carries the tank level in `units`), and a trader's jump was
-- not recorded at all. Relabel the old rows so the books separate fuel from
-- gate tolls. The ledger is FORCE ROW LEVEL SECURITY, so the update has to run
-- once per tenant with app.tenant_id set (a plain UPDATE would touch no rows).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE ledger SET type = 'JUMP' WHERE type = 'REFUEL' AND COALESCE(units, 0) = 0 AND total > 1000;
  END LOOP;
END $$;
