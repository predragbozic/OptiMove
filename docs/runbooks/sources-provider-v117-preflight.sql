-- Read-only. The migration also takes NOWAIT locks on both source relations.
select (exists (select from public.schema_migrations where migration_name='migrations_v2/202612181000_training_load_v116_sources_provider_store.sql' and checksum='fbb52694dcbdd31fe3e67e2d998b5a612923daff431498a65fb45286b7cf0f11')) as exact_v116,
(not exists (select from public.schema_migrations
  where migration_name ~ '^migrations_v2/[0-9]{12}_' and migration_name > 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql')) as registry_matches,
(((select count(*)=1 and bool_and(singleton and not enabled and epoch=0) from training_load.source_provider_admission)
    and not exists(select from training_load.source_provider_attempts)
    and not exists(select from training_load.source_provider_attempt_teams)
    and (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.source_provider_store_closed()'))='952568303b4b671a17dd04ced6660840'
    and (select count(*)=3 from pg_trigger t where not t.tgisinternal and t.tgrelid in ('training_load.source_provider_admission'::regclass, 'training_load.source_provider_attempts'::regclass, 'training_load.source_provider_attempt_teams'::regclass))
    and (select count(*)=3 from pg_trigger t where (t.tgrelid,t.tgname) in (
      ('training_load.source_provider_admission'::regclass, 'source_provider_admission_keep_closed'),
      ('training_load.source_provider_attempts'::regclass, 'source_provider_attempts_keep_closed'),
      ('training_load.source_provider_attempt_teams'::regclass, 'source_provider_attempt_teams_keep_closed')
    ) and t.tgenabled='O' and t.tgtype=62 and t.tgnargs=0 and t.tgqual is null
      and t.tgfoid=to_regprocedure('training_load.source_provider_store_closed()')))) as v116_closed,
((select count(*)=4 from pg_trigger t where not t.tgisinternal and t.tgrelid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass))
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
    )) as source_guards_exact,
(not exists (
      select from pg_roles r cross join pg_class c
      where r.rolname in ('anon','authenticated','service_role') and c.oid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass)
        and has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    )
    and not exists (
      select from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass) and a.grantee=0
    )) as new_fields_can_remain_private,
(not exists (select from pg_attribute a where a.attrelid in ('training_load.source_host_catalog'::regclass,'training_load.source_credential_connections'::regclass) and a.attname='provider_generation' and not a.attisdropped)
    and to_regprocedure('training_load.capture_source_host_generation()') is null
    and to_regprocedure('training_load.capture_source_connection_generation()') is null) as generation_objects_absent;
