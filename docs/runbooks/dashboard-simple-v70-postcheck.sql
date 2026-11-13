begin transaction read only;
select migration_name, checksum from public.schema_migrations
where migration_name = 'migrations_v2/202611131320_training_load_v70_dashboard_simple_atomic_save.sql';
select md5(prosrc) = 'a845d879d38d8a6dccf443736a34fe8f' as revision_function_matches
from pg_proc where oid = to_regprocedure('training_load.dashboard_widgets_bump_revision()');
select to_regclass('training_load.dashboard_simple_requests') as receipt_table;
select column_name from information_schema.columns where table_schema = 'training_load'
  and table_name = 'dashboard_widgets' and column_name = 'presentation_config';
select tgname from pg_trigger where not tgisinternal and tgrelid in
  ('training_load.dashboard_widgets'::regclass, 'training_load.dashboard_widget_series'::regclass);
select conname from pg_constraint where conrelid = 'training_load.dashboard_widgets'::regclass;
select (select count(*) from training_load.dashboard_widgets) as widgets,
       (select count(*) from training_load.dashboard_widget_series) as series;
rollback;
