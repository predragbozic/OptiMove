-- Read only. Every value must be true before applying v104.
select
  exists (select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612051000_training_load_v103_activity_identity_manage_bridge.sql'
      and checksum = '653df87e3c5980a8502edf0df62581f629fe068a3d8eb937489f30c2ebc6a487') as v103_matches,
  not exists (select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612021000_training_load_v100_dashboard_page_copy.sql') as retired_copy_slot_absent,
  not exists (select 1 from public.schema_migrations
    where migration_name > 'migrations_v2/202612051000_training_load_v103_activity_identity_manage_bridge.sql')
    as v103_is_latest,
  to_regprocedure('training_load.copy_dashboard_page_contents(uuid,uuid,uuid,uuid,uuid)') is null as copy_function_absent,
  to_regprocedure('training_load.mutate_dashboard_page(uuid,uuid,jsonb,uuid,text,integer,text,uuid,jsonb,timestamp with time zone)') is not null as page_writer_present,
  to_regprocedure('training_load.dashboard_chart_shape_remap(jsonb,jsonb)') is not null as remapper_present;
