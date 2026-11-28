begin read only;
set local lock_timeout='2s';
set local statement_timeout='3s';
set local search_path=pg_catalog, public;
do $gate$
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
  if not exists (select from public.schema_migrations where migration_name='migrations_v2/202612211000_training_load_v119_sources_provider_team_pointer_generations.sql' and checksum='55178f2f8ed4cdb7a738431383997532b15d4b03f7001b76004e1119029df99d') then raise exception 'v119 registry row absent'; end if;
  -- Digest covers trigger definition, enabled status, and function definition.
  if (select md5(string_agg(t.tgname || ':' || md5(pg_get_triggerdef(t.oid) || '/' || t.tgenabled::text ||
        '/' || pg_get_functiondef(t.tgfoid)), ',' order by t.tgname collate "C"))
      from pg_trigger t where not t.tgisinternal
        and t.tgrelid in ('public.teams'::regclass,'training_load.gpexe_team_settings'::regclass)
        and t.tgname not in ('zz_source_provider_team_sidecar','zz_source_provider_pointer_sidecar')) is distinct from 'b5e870454c18529d18b6b32421d3ef7f' then
    raise exception 'Sources sidecar legacy trigger fingerprint changed';
  end if;
  if exists (
    select from (values
      ('public.teams'::regclass, 'training_load.source_provider_team_generations'::regclass, 'zz_source_provider_team_sidecar', 'training_load.capture_source_team_sidecar()', 29, array['id','club_id','is_active'], '003eef6dae2140dee4e2d9c77c1bf2d6'),
      ('training_load.gpexe_team_settings'::regclass, 'training_load.source_provider_pointer_generations'::regclass, 'zz_source_provider_pointer_sidecar', 'training_load.capture_source_pointer_sidecar()', 21, array['owner_team_id','gpexe_team_id'], '3fbc8d80dc07f780f825aeaed6c840e2')
    ) as expected(rel,sidecar,name,fn,kind,columns,body_md5)
    left join pg_trigger t on t.tgrelid=expected.rel and t.tgname=expected.name
    left join pg_proc p on p.oid=t.tgfoid
    left join pg_class sidecar on sidecar.oid=expected.sidecar
    where t.tgenabled is distinct from 'O' or t.tgtype is distinct from expected.kind
      or t.tgattr::text is distinct from (
        select string_agg(a.attnum::text,' ' order by cols.ordinality)
        from unnest(expected.columns) with ordinality as cols(name,ordinality)
        join pg_attribute a on a.attrelid=expected.rel and a.attname=cols.name and not a.attisdropped
      )
      or t.tgfoid is distinct from to_regprocedure(expected.fn)
      or t.tgnargs is distinct from 0 or t.tgqual is not null or t.tgisinternal
      or p.prosecdef is distinct from true or p.proconfig is distinct from array['search_path=pg_catalog']
      or p.proowner is distinct from sidecar.relowner
      or md5(p.prosrc) is distinct from expected.body_md5
  ) then
    raise exception 'Sources sidecar capture trigger changed';
  end if;
  if (select count(*) from pg_class c
      where c.oid in ('training_load.source_provider_team_generations'::regclass,
        'training_load.source_provider_pointer_generations'::regclass)
        and c.relkind='r' and c.relrowsecurity
        and not exists(select from pg_policy p where p.polrelid=c.oid)
        and not exists(select from pg_constraint k where k.conrelid=c.oid and k.contype='f')) <> 2
    or exists (
      select from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid in ('training_load.source_provider_team_generations'::regclass,
        'training_load.source_provider_pointer_generations'::regclass) and a.grantee=0
    ) or exists (
      select from pg_attribute column_acl cross join lateral aclexplode(column_acl.attacl) a
      where column_acl.attrelid in ('training_load.source_provider_team_generations'::regclass,
        'training_load.source_provider_pointer_generations'::regclass)
        and column_acl.attnum > 0 and not column_acl.attisdropped and a.grantee=0
    ) or exists (
      select from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid in ('training_load.capture_source_team_sidecar()'::regprocedure,
        'training_load.capture_source_pointer_sidecar()'::regprocedure) and a.grantee=0
    ) or exists (
      select from pg_roles r cross join pg_class c
      where r.rolname in ('anon','authenticated','service_role')
        and c.oid in ('training_load.source_provider_team_generations'::regclass,
          'training_load.source_provider_pointer_generations'::regclass)
        and (pg_has_role(r.oid,c.relowner,'MEMBER')
          or has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
    ) or exists (
      select from pg_roles r cross join pg_proc p
      where r.rolname in ('anon','authenticated','service_role')
        and p.oid in ('training_load.capture_source_team_sidecar()'::regprocedure,
          'training_load.capture_source_pointer_sidecar()'::regprocedure)
        and (pg_has_role(r.oid,p.proowner,'MEMBER') or has_function_privilege(r.oid,p.oid,'EXECUTE'))
    ) then raise exception 'v119 sidecar isolation changed'; end if;
end
$gate$;
select true as v119_integrity_verified;
commit;
