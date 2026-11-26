-- Read only. Every value must be true before applying v100.
select
  exists (select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612011000_training_load_v99_schedule_manage_bridge.sql'
      and checksum = '230d51b45702a291b21e84a60fa3738404d1e4bfeb68124ec9554396d858a401') as v99_matches,
  not exists (select 1 from public.schema_migrations
    where migration_name >= 'migrations_v2/202612021000') as migration_slot_clear,
  to_regprocedure('training_load.copy_dashboard_page_contents(uuid,uuid,uuid,uuid,uuid)') is null as copy_function_absent,
  to_regprocedure('training_load.mutate_dashboard_page(uuid,uuid,jsonb,uuid,text,integer,text,uuid,jsonb,timestamp with time zone)') is not null as page_writer_present,
  to_regprocedure('training_load.dashboard_chart_shape_remap(jsonb,jsonb)') is not null as remapper_present;
