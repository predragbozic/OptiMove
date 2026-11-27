-- Read only. Both values must be true after applying v104.
select
  exists (select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612061000_training_load_v104_dashboard_page_copy.sql'
      and checksum = '19c89d6c818189ce3a1146998d8ef2aec25b1f8dadb700ac183cd88cc7a461ab') as v104_matches,
  coalesce((select md5(prosrc) = 'dc35259ba1bcb357cd70383829f27307'
    from pg_proc where oid = to_regprocedure('training_load.copy_dashboard_page_contents(uuid,uuid,uuid,uuid,uuid)')), false) as copy_function_matches;
