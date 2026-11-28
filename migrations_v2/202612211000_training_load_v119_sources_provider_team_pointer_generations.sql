-- Closed provider generation capture. Missing sidecar rows have generation zero.
-- The runner owns the transaction when this draft eventually gets a slot.
set local lock_timeout='5s';
set local search_path=pg_catalog, public;
lock table public.teams, training_load.gpexe_team_settings in access exclusive mode nowait;
lock table training_load.source_provider_admission, training_load.source_provider_attempts,
  training_load.source_provider_attempt_teams in share mode nowait;
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

create table training_load.source_provider_team_generations (
  team_id uuid primary key, generation bigint not null check (generation > 0)
);
create table training_load.source_provider_pointer_generations (
  team_id uuid primary key, generation bigint not null check (generation > 0)
);
alter table training_load.source_provider_team_generations enable row level security;
alter table training_load.source_provider_pointer_generations enable row level security;

-- No FK or update on the parent. Keep team tombstones so ID reuse changes
-- generation. Sort both keys if an authorized direct writer changes a PK.
create function training_load.capture_source_team_sidecar() returns trigger
language plpgsql security definer set search_path=pg_catalog as $capture$
declare before_id uuid; after_id uuid;
begin
  if tg_relid <> 'public.teams'::regclass or tg_when <> 'AFTER' or tg_level <> 'ROW' then
    raise exception 'invalid Sources team generation trigger';
  end if;
  if tg_op <> 'INSERT' then before_id := old.id; end if;
  if tg_op <> 'DELETE' then after_id := new.id; end if;
  if tg_op = 'UPDATE' and row(new.id,new.club_id,coalesce(new.is_active,true))
    is not distinct from row(old.id,old.club_id,coalesce(old.is_active,true)) then
    return null;
  end if;
  insert into training_load.source_provider_team_generations as seen(team_id,generation)
    select distinct id, 1 from (values (before_id),(after_id)) as touched(id)
    where id is not null order by id
    on conflict(team_id) do update set generation=seen.generation+1;
  return null;
end
$capture$;

-- Legacy v24 forbids delete/rekey and cancels raw exact no-ops. Canonical
-- formatting changes may still be written in legacy history.
create function training_load.capture_source_pointer_sidecar() returns trigger
language plpgsql security definer set search_path=pg_catalog as $capture$
begin
  if tg_relid <> 'training_load.gpexe_team_settings'::regclass
    or tg_when <> 'AFTER' or tg_level <> 'ROW' or tg_op not in ('INSERT','UPDATE') then
    raise exception 'invalid Sources pointer generation trigger';
  end if;
  if tg_op = 'UPDATE' and training_load.gpexe_team_id_canonical(new.gpexe_team_id)
    is not distinct from training_load.gpexe_team_id_canonical(old.gpexe_team_id) then
    return null;
  end if;
  insert into training_load.source_provider_pointer_generations as seen(team_id,generation)
    values(new.owner_team_id,1)
    on conflict(team_id) do update set generation=seen.generation+1;
  return null;
end
$capture$;

create trigger zz_source_provider_team_sidecar
after insert or update of id,club_id,is_active or delete on public.teams
for each row execute function training_load.capture_source_team_sidecar();
create trigger zz_source_provider_pointer_sidecar
after insert or update of owner_team_id,gpexe_team_id on training_load.gpexe_team_settings
for each row execute function training_load.capture_source_pointer_sidecar();

revoke all on training_load.source_provider_team_generations,training_load.source_provider_pointer_generations from public;
revoke all on function training_load.capture_source_team_sidecar(),training_load.capture_source_pointer_sidecar() from public;
do $acl$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on training_load.source_provider_team_generations, training_load.source_provider_pointer_generations from %I', api_role);
      execute format('revoke all on function training_load.capture_source_team_sidecar(), training_load.capture_source_pointer_sidecar() from %I', api_role);
    end if;
  end loop;
end
$acl$;

do $verify$
begin
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
$verify$;
