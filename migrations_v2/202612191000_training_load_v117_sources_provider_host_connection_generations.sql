-- Stage host and connection authorization inputs. Provider admission remains closed.
set local lock_timeout='5s';
lock table training_load.source_credential_connections, training_load.source_host_catalog in access exclusive mode nowait;
lock table training_load.source_provider_admission, training_load.source_provider_attempts,
  training_load.source_provider_attempt_teams in share mode nowait;

do $gate$
begin
  if (exists (select from public.schema_migrations where migration_name='migrations_v2/202612181000_training_load_v116_sources_provider_store.sql' and checksum='fbb52694dcbdd31fe3e67e2d998b5a612923daff431498a65fb45286b7cf0f11') and not exists (select from public.schema_migrations
  where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql')) is distinct from true then
    raise exception 'v117 requires the exact v116 registry predecessor';
  end if;
  if (((select count(*)=1 and bool_and(singleton and not enabled and epoch=0) from training_load.source_provider_admission)
    and not exists(select from training_load.source_provider_attempts)
    and not exists(select from training_load.source_provider_attempt_teams)
    and (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.source_provider_store_closed()'))='952568303b4b671a17dd04ced6660840'
    and (select count(*)=3 from pg_trigger t where not t.tgisinternal and t.tgrelid in ('training_load.source_provider_admission'::regclass, 'training_load.source_provider_attempts'::regclass, 'training_load.source_provider_attempt_teams'::regclass))
    and (select count(*)=3 from pg_trigger t where (t.tgrelid,t.tgname) in (
      ('training_load.source_provider_admission'::regclass, 'source_provider_admission_keep_closed'),
      ('training_load.source_provider_attempts'::regclass, 'source_provider_attempts_keep_closed'),
      ('training_load.source_provider_attempt_teams'::regclass, 'source_provider_attempt_teams_keep_closed')
    ) and t.tgenabled='O' and t.tgtype=62 and t.tgnargs=0 and t.tgqual is null
      and t.tgfoid=to_regprocedure('training_load.source_provider_store_closed()')))) is distinct from true then
    raise exception 'v117 requires the exact closed and empty v116 store';
  end if;
  if ((select count(*)=4 from pg_trigger t where not t.tgisinternal and t.tgrelid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass))
    and not exists (
      select from (values
        ('training_load.source_credential_connections'::regclass,'source_credential_connections_check_host','training_load.source_credential_connection_check_host()',23,'7443b08724f2be6df95ce40a1727806f'),
        ('training_load.source_credential_connections'::regclass,'source_credential_connections_protect_identity','training_load.source_credential_connection_protect_identity()',19,'751a692ee5cdda3be0a81a8292d57830'),
        ('training_load.source_host_catalog'::regclass,'source_host_catalog_api_family_immutable','training_load.source_host_catalog_api_family_immutable()',19,'0f7b2b8075c15e62dc99f1b99b48be7a'),
        ('training_load.source_host_catalog'::regclass,'source_host_catalog_immutable','training_load.source_host_catalog_immutable()',27,'ca35be68fd690efd8f0c4463a8d49c7a')
      ) as e(rel,trigger_name,fn,trigger_type,body_md5)
      left join pg_trigger t on t.tgrelid=e.rel and t.tgname=e.trigger_name
      left join pg_proc p on p.oid=t.tgfoid
      where t.tgenabled is distinct from 'O' or t.tgtype is distinct from e.trigger_type
        or t.tgnargs is distinct from 0 or t.tgqual is not null
        or t.tgfoid is distinct from to_regprocedure(e.fn) or md5(p.prosrc) is distinct from e.body_md5
    )) is distinct from true then
    raise exception 'v117 source guards differ from the reviewed catalogue';
  end if;
  if (not exists (
      select from pg_roles r cross join pg_class c
      where r.rolname in ('anon','authenticated','service_role') and c.oid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass)
        and has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    )
    and not exists (
      select from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass) and a.grantee=0
    )) is distinct from true then
    raise exception 'v117 source relations already grant API or PUBLIC access';
  end if;
  if (not exists (select from pg_attribute a where a.attrelid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass) and a.attname='provider_generation' and not a.attisdropped)
    and to_regprocedure('training_load.capture_source_host_generation()') is null
    and to_regprocedure('training_load.capture_source_connection_generation()') is null) is distinct from true then
    raise exception 'v117 generation objects already exist';
  end if;
end
$gate$;

alter table training_load.source_host_catalog
  add column provider_generation bigint not null default 0;
alter table training_load.source_credential_connections
  add column provider_generation bigint not null default 0;

create function training_load.capture_source_host_generation() returns trigger
language plpgsql set search_path = pg_catalog as $capture$
begin
  if tg_op = 'INSERT' then
    new.provider_generation := 0;
  else
    new.provider_generation := old.provider_generation
      + case when row(new.state, new.api_family) is distinct from row(old.state, old.api_family) then 1 else 0 end;
  end if;
  return new;
end
$capture$;

create function training_load.capture_source_connection_generation() returns trigger
language plpgsql set search_path = pg_catalog as $capture$
begin
  if tg_op = 'INSERT' then
    new.provider_generation := 0;
  else
    new.provider_generation := old.provider_generation + case when row(
      new.source_system, new.host_key, new.owner_scope, new.owner_club_id, new.owner_team_id,
      new.state, new.credential_kind, new.credential_ciphertext, new.credential_nonce,
      new.credential_auth_tag, new.credential_key_version
    ) is distinct from row(
      old.source_system, old.host_key, old.owner_scope, old.owner_club_id, old.owner_team_id,
      old.state, old.credential_kind, old.credential_ciphertext, old.credential_nonce,
      old.credential_auth_tag, old.credential_key_version
    ) then 1 else 0 end;
  end if;
  return new;
end
$capture$;

-- PostgreSQL orders equally timed triggers by name: run after the existing
-- source guards. No different row, advisory lock, or audit is acquired here.
create trigger zz_source_host_capture_generation
before insert or update on training_load.source_host_catalog
for each row execute function training_load.capture_source_host_generation();
create trigger zz_source_connection_capture_generation
before insert or update on training_load.source_credential_connections
for each row execute function training_load.capture_source_connection_generation();

revoke all on function training_load.capture_source_host_generation(),
  training_load.capture_source_connection_generation() from public;
do $acl$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on function training_load.capture_source_host_generation(), training_load.capture_source_connection_generation() from %I',api_role);
    end if;
  end loop;
end
$acl$;
