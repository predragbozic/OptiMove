-- Read-only; all booleans must be true. v92/v93 are not prerequisites.
begin transaction read only;
set local time zone 'UTC';
select md5(prosrc)='75953d6b01271f1707c1f28c1a7c0632' as copy_body from pg_proc where oid='training_load.copy_dashboard_page_widget(uuid,uuid,jsonb,uuid,text,uuid,uuid,integer,uuid,integer,timestamp with time zone)'::regprocedure;
select md5(prosrc)='33c8f87b3104a723f4c4d140d8922b43' as simple_body from pg_proc where oid='training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)'::regprocedure;
select (select checksum from public.schema_migrations where migration_name='migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql')='1da5706c418c0f3262d6a88689e8d1355247a97d7d31bad4a82a59d396c52247' as exact_v91;
select md5(prosrc)='d547e14a8a7021702769f4e17b6d94e8' as valid_body from pg_proc where oid='training_load.dashboard_presentation_valid(jsonb)'::regprocedure;
select md5(prosrc)='c0a9f476ac4bb0f0e7831fbc7014cc95' as compatible_body from pg_proc where oid='training_load.dashboard_presentation_assert_compatible(jsonb,text,text)'::regprocedure;
select dashboard_id,count(*) as widgets_per_dashboard,md5(coalesce(string_agg(to_jsonb(w)::text,E'\n' order by id),'')) as digest from training_load.dashboard_widgets w group by dashboard_id order by dashboard_id;
select count(*) as widgets,md5(coalesce(string_agg(to_jsonb(w)::text,E'\n' order by id),'')) as digest from training_load.dashboard_widgets w;
select w.dashboard_id,count(*) as series_per_dashboard,md5(coalesce(string_agg(to_jsonb(s)::text,E'\n' order by s.id),'')) as digest from training_load.dashboard_widget_series s join training_load.dashboard_widgets w on w.id=s.widget_id group by w.dashboard_id order by w.dashboard_id;
select count(*) as series,md5(coalesce(string_agg(to_jsonb(s)::text,E'\n' order by id),'')) as digest from training_load.dashboard_widget_series s;
select not exists(select 1 from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid() and state<>'idle' and xact_start is not null) as quiet_moment;
commit;
