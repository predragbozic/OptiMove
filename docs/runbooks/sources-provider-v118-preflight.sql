-- Run on the intended database immediately before deploying v118.
begin read only;
set local lock_timeout='2s';
set local statement_timeout='3s';
select
  exists (select from public.schema_migrations where migration_name='migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql'
    and checksum='8ed1a6b3e81ea8fef9db8e1d705fa5a9538b03a602178832b88aa3bcc0392786')
  and not exists (select from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_'
    and migration_name > 'migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql') as registry_ready,
  coalesce((select count(*)=1 and bool_and(singleton and not enabled and epoch=0) from training_load.source_provider_admission),false)
    and not exists(select from training_load.source_provider_attempts)
    and not exists(select from training_load.source_provider_attempt_teams) as provider_closed,
  (select count(*) <= 10000 from (select 1 from training_load.source_team_bindings limit 10001) bounded) as history_within_cap,
  to_regclass('training_load.source_binding_sparse_base') is null
    and to_regclass('training_load.source_binding_sparse_delta') is null
    and to_regprocedure('training_load.capture_binding_sparse_delta()') is null
    and to_regprocedure('training_load.source_binding_sparse_generation(uuid)') is null as sparse_objects_absent;
do $legacy$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgrelid='training_load.source_team_bindings'::regclass) <> 5
    or exists (
    select from (values
      ('source_team_bindings_check_owner','training_load.source_team_binding_check_owner()',7,'e58ff3c1f04391b6f919fdd7963c8712'),
      ('source_team_bindings_immutable','training_load.source_team_binding_immutable()',27,'f6b27af36cafa65298358c057fcfc316'),
      ('source_team_bindings_no_truncate','training_load.source_history_no_truncate()',34,'da60b2bca34b8b19134f86099257121a'),
      ('source_team_bindings_check_pair','training_load.refuse_unapproved_gpexe_binding()',7,'f3063292510ef7f73229dd77b9968017'),
      ('source_team_bindings_drop_identities','training_load.gpexe_athlete_identities_drop_for_binding()',17,'8d687ca5980955a447fd5276e55c562d')
    ) as e(name,fn,type,body_md5)
    left join pg_trigger t on t.tgrelid='training_load.source_team_bindings'::regclass and t.tgname=e.name
    left join pg_proc p on p.oid=t.tgfoid
    where t.tgenabled is distinct from 'O' or t.tgtype is distinct from e.type
      or t.tgnargs is distinct from 0 or t.tgqual is not null
      or t.tgfoid is distinct from to_regprocedure(e.fn) or md5(p.prosrc) is distinct from e.body_md5
  ) then raise exception 'Binding guard catalogue drifted'; end if;
end
$legacy$;
commit;
