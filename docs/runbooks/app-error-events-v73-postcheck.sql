-- Read-only POST-CHECK for migration v73 (migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql); run after the deploy. Changes nothing.
-- Blocks 1, 2, 4 and 5 return true values; block 3 is read.

-- 1. v73 is recorded once, with the file's checksum.
select count(*) = 1 as recorded_once,
       bool_and(checksum = 'bf0685110493bfa6d287696e6cebfb9e518c6b6de61b2781228e9d2609093f4f') as checksum_ok
  from public.schema_migrations where migration_name = 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql';

-- 2. The five columns, the 28 CHECKs (22 before v73 and 6 of v73), the update guard with v73's body, the three guards enabled.
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'
          and column_name in ('request_method', 'request_route', 'server_uptime', 'page_behind_server', 'delivered_late')) = 5 as five_columns,
       (select count(*) from pg_constraint where conrelid = 'public.app_error_events'::regclass and contype = 'c' and convalidated) = 28 as checks_28_valid,
       (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update') = '05cd59a40237bf6b443d268961409d93' as guard_is_v73,
       (select count(*) from pg_trigger where tgrelid = 'public.app_error_events'::regclass and not tgisinternal and tgenabled = 'O') = 3 as three_guards_enabled;

-- 3. For reading: the new facts as they arrive. Right after the deploy every existing row has none of them.
select count(*) as rows_total,
       count(*) filter (where request_route is not null) as with_request,
       count(*) filter (where server_uptime is not null) as with_uptime,
       count(*) filter (where server_uptime = 'lt_2m') as within_2m_of_start,
       count(*) filter (where delivered_late is not null) as delivered_late,
       count(*) filter (where page_behind_server) as page_behind_server,
       max(last_seen_at) as newest
  from public.app_error_events;

-- 4. No server error carries a request, a page's build or a late delivery; no route holds a query string or is over 120 characters.
select not exists (select 1 from public.app_error_events where source = 'server'
                    and (request_method is not null or request_route is not null or page_behind_server is not null or delivered_late is not null)) as server_rows_clean,
       not exists (select 1 from public.app_error_events where request_route is not null and (request_route ~ '[?#=&@ ]' or length(request_route) > 120)) as routes_are_patterns;

-- 5. Nothing is stuck.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx;
