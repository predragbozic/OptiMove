-- Read only. Every value must be true before applying v104.
select
  exists (select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612041000_training_load_v102_estimates_manage_bridge.sql'
      and checksum = '5966b180e4228650e42a1ed3ef0744f1c092a269fe7608e928955719c07c1c32') as v102_matches,
  not exists (select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612021000_training_load_v100_dashboard_page_copy.sql') as retired_copy_slot_absent,
  not exists (select 1 from public.schema_migrations
    where migration_name > 'migrations_v2/202612041000_training_load_v102_estimates_manage_bridge.sql')
    as v102_is_latest,
  to_regprocedure('training_load.copy_dashboard_page_contents(uuid,uuid,uuid,uuid,uuid)') is null as copy_function_absent,
  to_regprocedure('training_load.mutate_dashboard_page(uuid,uuid,jsonb,uuid,text,integer,text,uuid,jsonb,timestamp with time zone)') is not null as page_writer_present,
  to_regprocedure('training_load.dashboard_chart_shape_remap(jsonb,jsonb)') is not null as remapper_present;
