-- Only while admission is closed and no generation has been captured.
begin;
set local lock_timeout='5s';
do $migrator$ begin
  if not pg_try_advisory_xact_lock(822026) then raise exception 'v117 rollback refused: migrator running'; end if;
end $migrator$;
lock table training_load.source_credential_connections, training_load.source_host_catalog in access exclusive mode nowait;
lock table training_load.source_provider_admission, training_load.source_provider_attempts,
  training_load.source_provider_attempt_teams in share mode nowait;
do $gate$
declare installed timestamptz;
begin
  select applied_at into installed from public.schema_migrations where migration_name='migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql' and checksum='8ed1a6b3e81ea8fef9db8e1d705fa5a9538b03a602178832b88aa3bcc0392786';
  if installed is null or not (exists (select from public.schema_migrations where migration_name='migrations_v2/202612181000_training_load_v116_sources_provider_store.sql' and checksum='fbb52694dcbdd31fe3e67e2d998b5a612923daff431498a65fb45286b7cf0f11')) or exists (
    select from public.schema_migrations where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name<>'migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql'
      and (migration_name>'migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql' or applied_at>=installed)
  ) then raise exception 'v117 rollback refused: registry changed'; end if;
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
    raise exception 'v117 rollback refused: store changed';
  end if;
  if ((select count(*)=6 from pg_trigger t where not t.tgisinternal and t.tgrelid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass))
    and not exists (
      select from (values
        ('training_load.source_credential_connections'::regclass,'source_credential_connections_check_host','training_load.source_credential_connection_check_host()',23,'7443b08724f2be6df95ce40a1727806f'),
        ('training_load.source_credential_connections'::regclass,'source_credential_connections_protect_identity','training_load.source_credential_connection_protect_identity()',19,'751a692ee5cdda3be0a81a8292d57830'),
        ('training_load.source_host_catalog'::regclass,'source_host_catalog_api_family_immutable','training_load.source_host_catalog_api_family_immutable()',19,'0f7b2b8075c15e62dc99f1b99b48be7a'),
        ('training_load.source_host_catalog'::regclass,'source_host_catalog_immutable','training_load.source_host_catalog_immutable()',27,'ca35be68fd690efd8f0c4463a8d49c7a'),
        ('training_load.source_host_catalog'::regclass,'zz_source_host_capture_generation','training_load.capture_source_host_generation()',23,'9ef778dadd938e301ba2e6af955dda6c'),
        ('training_load.source_credential_connections'::regclass,'zz_source_connection_capture_generation','training_load.capture_source_connection_generation()',23,'73ea8687038ef6a520c6d58c8c72b2ef')
      ) as e(rel,trigger_name,fn,trigger_type,body_md5)
      left join pg_trigger t on t.tgrelid=e.rel and t.tgname=e.trigger_name
      left join pg_proc p on p.oid=t.tgfoid
      where t.tgenabled is distinct from 'O' or t.tgtype is distinct from e.trigger_type
        or t.tgnargs is distinct from 0 or t.tgqual is not null
        or t.tgfoid is distinct from to_regprocedure(e.fn) or md5(p.prosrc) is distinct from e.body_md5
    )) is distinct from true then
    raise exception 'v117 rollback refused: source guards changed';
  end if;
  if ((select count(*)=2 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass) and a.attname='provider_generation' and not a.attisdropped
    and a.atttypid='bigint'::regtype and a.attnotnull and pg_get_expr(d.adbin,d.adrelid) in ('0','0::bigint')) and (not exists (
      select from pg_roles r cross join pg_class c
      where r.rolname in ('anon','authenticated','service_role') and c.oid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass)
        and has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    )
    and not exists (
      select from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass) and a.grantee=0
    )) and (not exists (
      select from pg_attribute target cross join lateral aclexplode(target.attacl) grants
      where target.attrelid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass)
        and target.attname='provider_generation' and not target.attisdropped and grants.grantee=0
    ) and not exists (
      select from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid in ('training_load.capture_source_host_generation()'::regprocedure,'training_load.capture_source_connection_generation()'::regprocedure)
        and a.grantee=0
    ) and not exists (
      select from pg_roles r
      where r.rolname in ('anon','authenticated','service_role') and (
        has_function_privilege(r.oid,'training_load.capture_source_host_generation()','EXECUTE')
        or has_function_privilege(r.oid,'training_load.capture_source_connection_generation()','EXECUTE')
        or has_column_privilege(r.oid,'training_load.source_host_catalog'::regclass,'provider_generation','SELECT,INSERT,UPDATE,REFERENCES')
        or has_column_privilege(r.oid,'training_load.source_credential_connections'::regclass,'provider_generation','SELECT,INSERT,UPDATE,REFERENCES')
      )
    ))) is distinct from true then
    raise exception 'v117 rollback refused: columns or ACL changed';
  end if;
  if exists (select from training_load.source_host_catalog where provider_generation<>0)
     or exists (select from training_load.source_credential_connections where provider_generation<>0) then
    raise exception 'v117 rollback refused: generation already captured';
  end if;
end
$gate$;
drop trigger zz_source_connection_capture_generation on training_load.source_credential_connections;
drop trigger zz_source_host_capture_generation on training_load.source_host_catalog;
drop function training_load.capture_source_connection_generation(), training_load.capture_source_host_generation();
alter table training_load.source_credential_connections drop column provider_generation;
alter table training_load.source_host_catalog drop column provider_generation;
delete from public.schema_migrations where migration_name='migrations_v2/202612191000_training_load_v117_sources_provider_host_connection_generations.sql' and checksum='8ed1a6b3e81ea8fef9db8e1d705fa5a9538b03a602178832b88aa3bcc0392786';
commit;
