-- Run immediately after v118; no provider admission change is expected.
begin read only;
set local lock_timeout='2s';
set local statement_timeout='3s';
with history as (
  select connection_id, count(*) + count(*) filter(where state='ended') as generation
  from training_load.source_team_bindings group by connection_id
), keys as (
  select connection_id from history
  union select connection_id from training_load.source_binding_sparse_base
  union select connection_id from training_load.source_binding_sparse_delta
)
select
  exists(select from public.schema_migrations where migration_name='migrations_v2/202612201000_training_load_v118_sources_provider_binding_generations.sql' and checksum='d05f048b211358a08de721b3e3f58312a4c3af7484b678577d30542efaf6bbc9') as recorded,
  coalesce((select count(*)=1 and bool_and(singleton and not enabled and epoch=0) from training_load.source_provider_admission),false)
    and not exists(select from training_load.source_provider_attempts)
    and not exists(select from training_load.source_provider_attempt_teams) as provider_closed,
  (select count(*)=1 and bool_and(tgenabled='O' and tgtype=21 and tgnargs=0 and tgqual is null
    and tgfoid=to_regprocedure('training_load.capture_binding_sparse_delta()'))
    from pg_trigger where tgrelid='training_load.source_team_bindings'::regclass and tgname='zz_source_binding_sparse_delta')
    and (select count(*)=6 from pg_trigger where tgrelid='training_load.source_team_bindings'::regclass and not tgisinternal) as capture_enabled,
  not exists (select from keys k left join history h using(connection_id)
    where training_load.source_binding_sparse_generation(k.connection_id) is distinct from coalesce(h.generation,0)) as witness_matches_history;
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
do $attributes$
begin
  if not exists (
    select from pg_proc capture join pg_proc witness on witness.oid='training_load.source_binding_sparse_generation(uuid)'::regprocedure
    join pg_class baseline on baseline.oid='training_load.source_binding_sparse_base'::regclass
    join pg_class delta on delta.oid='training_load.source_binding_sparse_delta'::regclass
    where capture.oid='training_load.capture_binding_sparse_delta()'::regprocedure
      and capture.prosecdef and capture.proconfig=array['search_path=pg_catalog']
      and not witness.prosecdef and witness.proconfig=array['search_path=pg_catalog']
      and capture.proowner=witness.proowner and capture.proowner=baseline.relowner and capture.proowner=delta.relowner
      and not exists (
        select from pg_roles r where r.rolname in ('anon','authenticated','service_role')
          and pg_has_role(r.oid,capture.proowner,'MEMBER')
      )
  ) then raise exception 'Sparse binding function attributes or ownership drifted'; end if;
end
$attributes$;
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
commit;
