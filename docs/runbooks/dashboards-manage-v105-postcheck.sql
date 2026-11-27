-- Read-only. Compare checksum with the frozen release packet.
select migration_name, checksum from public.schema_migrations where migration_name='migrations_v2/202612071000_training_load_v105_dashboards_manage_bridge.sql';
select first_checked_write_at from training_load.dashboards_manage_v105_use where singleton;
select layer,count(*) as seeded from training_load.dashboards_manage_v105_seed group by layer order by layer;
select coalesce((select md5(prosrc) = '6c1e8d75e9631ca53ff0aa18bebddfd7' from pg_proc
                 where oid=to_regprocedure('public.permission_word_honoured(text)')),false) as v105_permission_body_matches,
       public.permission_word_honoured('dashboards.manage') as word_storable;
