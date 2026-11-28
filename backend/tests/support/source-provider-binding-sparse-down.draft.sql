-- Local disposable rehearsal only. First-effect or catalogue drift refuses.
begin;
set local lock_timeout='2s';
set local statement_timeout='3s';
set local transaction_timeout='5s';
lock table training_load.source_team_bindings in access exclusive mode nowait;
lock table training_load.source_provider_admission, training_load.source_provider_attempts,
  training_load.source_provider_attempt_teams, public.schema_migrations in share mode nowait;
do $gate$
begin
  if current_database() !~ '^optimove_tests_[a-z0-9_]+$' then
    raise exception 'Sparse generation prototype requires a disposable database';
  end if;
  if not exists (select from public.schema_migrations
    where migration_name='migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql'
      and checksum='8ed1a6b3e81ea8fef9db8e1d705fa5a9538b03a602178832b88aa3bcc0392786')
    or exists (select from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_'
      and migration_name > 'migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql') then
    raise exception 'Sparse generation prototype requires exact v117';
  end if;
  if (select count(*)=1 and bool_and(singleton and not enabled and epoch=0)
      from training_load.source_provider_admission) is distinct from true
    or exists (select from training_load.source_provider_attempts)
    or exists (select from training_load.source_provider_attempt_teams) then
    raise exception 'Provider store must be closed and unused';
  end if;
end
$gate$;
do $legacy$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgrelid='training_load.source_team_bindings'::regclass) <> 6
    or exists (
    select from (values
      ('source_team_bindings_check_owner','training_load.source_team_binding_check_owner()',7,'e58ff3c1f04391b6f919fdd7963c8712'),
      ('source_team_bindings_immutable','training_load.source_team_binding_immutable()',27,'f6b27af36cafa65298358c057fcfc316'),
      ('source_team_bindings_no_truncate','training_load.source_history_no_truncate()',34,'da60b2bca34b8b19134f86099257121a'),
      ('source_team_bindings_check_pair','training_load.refuse_unapproved_gpexe_binding()',7,'f3063292510ef7f73229dd77b9968017'),
      ('source_team_bindings_drop_identities','training_load.gpexe_athlete_identities_drop_for_binding()',17,'8d687ca5980955a447fd5276e55c562d'),
      ('zz_source_binding_sparse_delta','training_load.capture_binding_sparse_delta()',21,'9e2893f16c426c1f6d9c2e711177d6d1')
    ) as e(name,fn,type,body_md5)
    left join pg_trigger t on t.tgrelid='training_load.source_team_bindings'::regclass and t.tgname=e.name
    left join pg_proc p on p.oid=t.tgfoid
    where t.tgenabled is distinct from 'O' or t.tgtype is distinct from e.type
      or t.tgnargs is distinct from 0 or t.tgqual is not null
      or t.tgfoid is distinct from to_regprocedure(e.fn) or md5(p.prosrc) is distinct from e.body_md5
  ) then raise exception 'Binding guard catalogue drifted'; end if;
end
$legacy$;
do $verify$
begin
  if exists (
    select from pg_roles r cross join pg_class c
    where r.rolname in ('anon','authenticated','service_role')
      and c.oid in ('training_load.source_binding_sparse_base'::regclass,'training_load.source_binding_sparse_delta'::regclass)
      and (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
  ) or exists (
    select from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid in ('training_load.source_binding_sparse_base'::regclass,'training_load.source_binding_sparse_delta'::regclass)
      and a.grantee=0
  ) or exists (
    select from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid in ('training_load.capture_binding_sparse_delta()'::regprocedure,'training_load.source_binding_sparse_generation(uuid)'::regprocedure)
      and (a.grantee=0 or exists(select from pg_roles r where r.rolname in ('anon','authenticated','service_role')
        and has_function_privilege(r.oid,p.oid,'EXECUTE')))
  ) then raise exception 'Sparse binding sidecar exposes private privileges'; end if;
end
$verify$;
do $effect$
begin
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.source_binding_sparse_generation(uuid)')) is distinct from 'd8616b9c8997bf0ca8a3d5518adc85b3' then
    raise exception 'Sparse witness catalogue drifted';
  end if;
  if exists (select from training_load.source_binding_sparse_delta) then
    raise exception 'Sparse generation already captured';
  end if;
end
$effect$;
drop trigger zz_source_binding_sparse_delta on training_load.source_team_bindings;
drop function training_load.capture_binding_sparse_delta(), training_load.source_binding_sparse_generation(uuid);
drop table training_load.source_binding_sparse_base, training_load.source_binding_sparse_delta;
commit;
