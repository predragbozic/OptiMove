-- Read-only POST-CHECK for migration v72 (migrations_v2/202611151200_training_load_v72_source_field_observations.sql); run after the
-- deploy that applied it (the Rukovodilac, each block in a read-only transaction). Changes nothing. Every boolean column of every
-- block must be true.

-- 1. v72 is recorded once and is the last migration. D1's v71 (202611151000_training_load_v71_dashboard_simple_atomic_save.sql) sorts before it and may be recorded
--    once or not at all, in either order.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611151200_training_load_v72_source_field_observations.sql') = 1 as recorded_once,
       (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611151000_training_load_v71_dashboard_simple_atomic_save.sql') <= 1 as d1_v71_absent_or_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611151200_training_load_v72_source_field_observations.sql' as last;

-- 2. The table, its checks and its key.
select to_regclass('training_load.source_field_observations') is not null as table_ok,
       exists (select 1 from pg_constraint where conname = 'source_field_observations_key' and contype = 'u') as key_unique,
       (select count(*) from pg_constraint where conrelid = 'training_load.source_field_observations'::regclass and contype = 'c') = 7 as checks_ok;

-- 3. The guard, the delete and truncate refusals, enabled; the three functions are v72's.
select (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O'
         and t.tgrelid = 'training_load.source_field_observations'::regclass
         and t.tgname in ('source_field_observations_guard', 'source_field_observations_no_delete', 'source_field_observations_no_truncate')) = 3 as triggers_ok,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'field_inventory_context_check') = 'e9ca07242d20642b15490504720d8be6' as context_fn_is_v72,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'source_field_observations_guard') = '418ea1daedf13f2ea15a3f68c78a3dc7' as guard_fn_is_v72,
       (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'source_field_observations_keep') = 'c58f74033c1ea54ba0d0c725427f5930' as keep_fn_is_v72;

-- 4. No idle transaction. (Rows appear from the first succeeded check after the deploy; their presence is no failure of v72.)
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;

-- 5. (L3, the Independent's note on I1) The Supabase API roles reach nothing of training_load: no USAGE on the schema and no
--    table they could select. Each boolean is true when the role does not exist (a disposable database).
select coalesce((select not has_schema_privilege(r.oid, 'training_load', 'USAGE') from pg_roles r where r.rolname = 'anon'), true) as anon_no_usage,
       coalesce((select not has_schema_privilege(r.oid, 'training_load', 'USAGE') from pg_roles r where r.rolname = 'authenticated'), true) as authenticated_no_usage,
       (select count(*) from pg_roles r cross join pg_tables t
         where r.rolname in ('anon', 'authenticated') and t.schemaname = 'training_load'
           and has_table_privilege(r.oid, quote_ident(t.schemaname) || '.' || quote_ident(t.tablename), 'SELECT')) = 0 as no_selectable_table;
