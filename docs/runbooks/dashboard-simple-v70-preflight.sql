begin transaction read only;
select md5(prosrc) = '888e7c8fb69ffc645da37203c5aa96cf' as revision_function_matches
from pg_proc where oid = to_regprocedure('training_load.dashboard_widgets_bump_revision()');
select to_regclass('training_load.dashboard_simple_requests') is null as receipt_table_absent,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load'
         and table_name = 'dashboard_widgets' and column_name = 'presentation_config') as presentation_absent;
select (select count(*) from training_load.dashboard_widgets) as widgets,
       (select count(*) from training_load.dashboard_widget_series) as series;
rollback;
