begin read only;
set local lock_timeout='2s';
set local statement_timeout='3s';
set local search_path=pg_catalog, public;
do $lab$
begin
  if (select count(*)=1 and bool_and(singleton and not enabled and epoch=0) from training_load.source_provider_admission) is distinct from true
    or exists (select from training_load.source_provider_attempts)
    or exists (select from training_load.source_provider_attempt_teams)
    or not exists (select from public.schema_migrations where
      migration_name='migrations_v2/202612201000_training_load_v118_sources_provider_binding_generations.sql'
      and checksum='d05f048b211358a08de721b3e3f58312a4c3af7484b678577d30542efaf6bbc9') then
    raise exception 'v119 requires the exact closed v118 registry and store';
  end if;
  if not exists (
    select from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where t.tgrelid='training_load.source_team_bindings'::regclass and t.tgname='zz_source_binding_sparse_delta'
      and t.tgenabled='O' and t.tgtype=21 and t.tgnargs=0 and t.tgqual is null
      and t.tgfoid=to_regprocedure('training_load.capture_binding_sparse_delta()')
      and p.prosecdef and p.proconfig=array['search_path=pg_catalog']
      and md5(p.prosrc)='9e2893f16c426c1f6d9c2e711177d6d1'
  ) then raise exception 'v119 requires the enabled v118 binding capture'; end if;
  if exists (select from public.schema_migrations
    where migration_name ~ '^migrations_v2/[0-9]{12}_'
      and migration_name>'migrations_v2/202612211000_training_load_v119_sources_provider_team_pointer_generations.sql') then
    raise exception 'v119 requires the registry before later migrations';
  end if;
  -- Digest covers trigger definition, enabled status, and function definition.
  if (select md5(string_agg(t.tgname || ':' || md5(pg_get_triggerdef(t.oid) || '/' || t.tgenabled::text ||
        '/' || pg_get_functiondef(t.tgfoid)), ',' order by t.tgname collate "C"))
      from pg_trigger t where not t.tgisinternal
        and t.tgrelid in ('public.teams'::regclass,'training_load.gpexe_team_settings'::regclass)
        ) is distinct from 'b5e870454c18529d18b6b32421d3ef7f' then
    raise exception 'Sources sidecar legacy trigger fingerprint changed';
  end if;
end
$lab$;
select true as v119_ready;
commit;
