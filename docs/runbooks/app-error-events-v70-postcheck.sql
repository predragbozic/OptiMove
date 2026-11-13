-- Read-only POST-CHECK for migration v70 (migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql); run after the deploy. Changes nothing.
-- Blocks 1 to 3, 5 and 6 return true values; block 4 is read.

-- 1. v70 is recorded once, with the file's checksum.
select count(*) = 1 as recorded_once,
       bool_and(checksum = '858045833f49ed0ba59e2acec57d20e4ece762d7b1107490a7dc450659677d60') as checksum_ok
  from public.schema_migrations where migration_name = 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql';

-- 2. The seven columns, the 22 CHECKs (14 of v58 and 8 of v70), and the update guard with v70's body.
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'
          and column_name in ('device_class', 'os_family', 'browser_family', 'browser_major', 'viewport_bucket', 'touch', 'user_hash_version')) = 7 as seven_columns,
       (select count(*) from pg_constraint where conrelid = 'public.app_error_events'::regclass and contype = 'c' and convalidated) = 22 as checks_22_valid,
       (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update') = '13009f97dbedc04be84380baa037ce88' as guard_is_v70,
       (select count(*) from pg_trigger where tgrelid = 'public.app_error_events'::regclass and not tgisinternal and tgenabled = 'O') = 3 as three_guards_enabled;

-- 3. The lookups table: 4 CHECKs, its 4 guards enabled, row-level security on, nothing for PUBLIC, anon or authenticated.
select (select count(*) from pg_constraint where conrelid = 'public.app_error_person_lookups'::regclass and contype = 'c') = 4 as four_checks,
       (select count(*) from pg_trigger where tgrelid = 'public.app_error_person_lookups'::regclass and not tgisinternal and tgenabled = 'O') = 4 as four_guards_enabled,
       (select relrowsecurity from pg_class where oid = 'public.app_error_person_lookups'::regclass) as rls_on,
       not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = 'public.app_error_person_lookups'::regclass and a.grantee = 0) as table_not_public,
       not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.pronamespace = 'public'::regnamespace and p.proname like 'app_error\_%' and a.grantee = 0) as functions_not_public,
       not exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated') and has_table_privilege(r.rolname, 'public.app_error_person_lookups', 'SELECT')) as not_for_data_api;

-- 4. For reading: rows by hash version. Right after the deploy every row is version 1; new rows are version 2 or later.
--    signed_in_without_hash > 0 on rows of a signed-in role means the server runs without APP_ERROR_USER_HASH_KEYS.
select user_hash_version, count(*) as rows_total, count(*) filter (where user_hash is null and role <> 'none') as signed_in_without_hash,
       count(*) filter (where device_class is not null) as with_device, max(last_seen_at) as newest
  from public.app_error_events group by 1 order by 1;

-- 5. No server error carries a device fact, and no lookup row exists before AH-3.
select not exists (select 1 from public.app_error_events where source = 'server' and (device_class is not null or os_family is not null or browser_family is not null
                    or browser_major is not null or viewport_bucket is not null or touch is not null)) as server_rows_without_device,
       (select count(*) from public.app_error_person_lookups) = 0 as no_lookup_yet;

-- 6. Nothing is stuck.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;
