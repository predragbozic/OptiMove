-- Read-only. No provider access required.
select exists (
  select from public.schema_migrations
  where migration_name = 'migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql'
    and checksum = '7b8f035cbc134aec30adaffe031607a826af4346bb9617fa0e292ed078a201b4'
) as exact_v115,
not exists (
  select from public.schema_migrations
  where migration_name ~ '^migrations_v2/[0-9]{12}_'
    and migration_name > 'migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql'
) as registry_matches,
(select md5(prosrc) from pg_proc where oid = to_regprocedure('public.permission_word_honoured(text)'))
  = '6a30d1efc10f2e065c5a53ab570c82c9' as evaluator_unchanged,
to_regclass('training_load.sources_connect_local_bridge_use') is not null as v115_evidence_present,
to_regclass('training_load.source_provider_admission') is null
  and to_regclass('training_load.source_provider_attempts') is null
  and to_regclass('training_load.source_provider_attempt_teams') is null
  and to_regprocedure('training_load.source_provider_store_closed()') is null as store_absent;
