begin transaction read only;
select md5(prosrc) = '888e7c8fb69ffc645da37203c5aa96cf' as revision_function_matches
from pg_proc where oid = to_regprocedure('training_load.dashboard_widgets_bump_revision()');
select to_regclass('training_load.dashboard_simple_requests') is null as receipt_table_absent,
       not exists (select 1 from information_schema.columns where table_schema = 'training_load'
         and table_name = 'dashboard_widgets' and column_name = 'presentation_config') as presentation_absent;
select (select count(*) from training_load.dashboard_widgets) as widgets,
       (select count(*) from training_load.dashboard_widget_series) as series;
-- These tracks can be deployed separately. Reject a different file in any reserved slot.
with expected(version, prefix, filename) as (values
 ('66','202611131000','202611131000_training_load_v66_club_activation_confirmation_gate.sql'),
 ('67','202611131200','202611131200_training_load_v67_gpexe_track_choices.sql'),
 ('68','202611131300','202611131300_training_load_v68_track_choice_scale.sql'),
 ('69','202611131310','202611131310_training_load_v69_scale_recording_estimates.sql'),
 ('70','202611131400','202611131400_app_error_events_v70_device_and_keyed_hash.sql')
)
select version, filename,
       exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/' || filename) as recorded,
       not exists (
         select 1 from public.schema_migrations
         where migration_name <> 'migrations_v2/' || filename
           and (split_part(migration_name, '/', 2) like prefix || '\_%'
                or split_part(migration_name, '/', 2) ~ ('_v' || version || '_'))
       ) as slot_matches
from expected order by version;
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql') as v70_required_recorded;
rollback;
