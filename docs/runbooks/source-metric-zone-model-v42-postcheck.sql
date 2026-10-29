-- v42 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the phase 5b merge served /api/health with
-- ok: true (contract docs/ai/phase5-zone-model-contract.md, section 3.5).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v42 recorded exactly once with the repository's
--    checksum, and it is the last migration; v41 still recorded once.
--    Expected: v42_rows = 1, v42_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql,
--    v41_rows = 1.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as v42_rows,
  (select bool_and(checksum = '042445620eade972e9940667c4777469a5e9d22f3d9b551d1d4b64bbdb610af1') from public.schema_migrations
    where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as v42_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_rows;

-- 2. The two function bodies are v42's (the md5 of each body as v42 wrote it,
--    and the sentence only v42 writes), and both carry v42's comment.
--    Expected: seed_window_is_v42 = true, actor_guard_is_v42 = true,
--    zone_rule = true, comments_name_v42 = true.
select
  (select md5(p.prosrc) = '7b475353e78d96e24cb4c7beeb440af4'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_require_seed_window') as seed_window_is_v42,
  (select md5(p.prosrc) = 'e9ecbc6b57ed3f2dc93a450707c9270f'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_revisions_actor_guard') as actor_guard_is_v42,
  (select position('a zone takes the operator between or >=' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_revisions_actor_guard') as zone_rule,
  (coalesce(obj_description('training_load.source_metric_require_seed_window(text)'::regprocedure, 'pg_proc'), '') like 'v42 %'
   and coalesce(obj_description('training_load.source_metric_revisions_actor_guard()'::regprocedure, 'pg_proc'), '') like 'v42 %') as comments_name_v42;

-- 3. The seed window refuses every marker now: its body accepts v42's marker
--    alone, and only while v42 is not recorded (block 1 shows it recorded).
--    Expected: names_only_v42 = true, v42_recorded = true.
select
  (select position('migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql' in p.prosrc) > 0
      and position('migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql' in p.prosrc) = 0
      and position('exists (select 1 from public.schema_migrations where migration_name = p_marker)' in p.prosrc) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_require_seed_window') as names_only_v42,
  exists (select 1 from public.schema_migrations
           where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as v42_recorded;

-- 4. Ten source fields: the nine of v34 and the open top zone exactly as v42
--    seeded it (one revision: observed, active, no proof, no operator, no
--    actor); the nine v34 revisions still without any proof of a zone's
--    meaning or operator.
--    Expected: fields = 10, v34_fields = 9, open_top_seed = 1, open_top_revisions = 1,
--    zones_with_meaning_or_operator = 0, and v34_fingerprint equal to the value
--    preflight block 4 recorded (the nine v34 fields and their revisions are
--    unchanged, every column). Run it before any zone field is confirmed.
select
  (select count(*) from training_load.source_metric_definitions) as fields,
  (select count(*) from training_load.source_metric_definitions
    where seed_migration = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_fields,
  (select count(*) from training_load.source_metric_definitions d
     join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id
    where d.source_system = 'gpexe' and d.api_family = 'rest_v1'
      and d.source_metric_key = 'more.complementary_data.power.distance.open_top'
      and d.source_label = 'Power zone distance (open top zone)' and d.state = 'active' and d.created_by_user_id is null
      and d.seed_migration = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql'
      and r.revision_number = 1 and r.value_shape = 'zone_distance' and r.parameter_kind = 'zone_bounds'
      and r.supports_session and r.supports_drill and r.expected_source_unit = 'm' and r.expected_source_bound_unit = 'W/kg'
      and r.source_unit is null and r.source_bound_unit is null and r.bound_operator is null
      and r.unit_verified_at is null and r.meaning_verified_at is null
      and r.evidence_status = 'observed' and r.evidence_ref = 'docs/ai/gpexe-rest-v1-compatibility.md#2-the-table'
      and r.state = 'active' and r.activated_at is not null and r.activated_by_user_id is null and r.created_by_user_id is null
      and r.seed_migration = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as open_top_seed,
  (select count(*) from training_load.source_metric_definition_versions r
     join training_load.source_metric_definitions d on d.id = r.source_metric_definition_id
    where d.source_metric_key = 'more.complementary_data.power.distance.open_top') as open_top_revisions,
  (select count(*) from training_load.source_metric_definition_versions
    where parameter_kind = 'zone_bounds' and (meaning_verified_at is not null or bound_operator is not null)) as zones_with_meaning_or_operator,
  (select md5(string_agg(row_to_json(d)::text || row_to_json(r)::text, '|' order by d.source_metric_key, r.revision_number))
     from training_load.source_metric_definitions d
     join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id
    where d.seed_migration = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_fingerprint;

-- 5. Every trigger of the source fields and their revisions is enabled.
--    Expected: disabled_triggers = 0.
select count(*) as disabled_triggers
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and c.relname in ('source_metric_definitions', 'source_metric_definition_versions')
   and not t.tgisinternal and t.tgenabled <> 'O';

-- 6. No audit row names the new field or its revision (a seed writes none).
--    Expected: open_top_audit_rows = 0.
select count(*) as open_top_audit_rows
  from training_load.source_metric_audit a
  join training_load.source_metric_definitions d on d.id = a.source_metric_definition_id
 where d.source_metric_key = 'more.complementary_data.power.distance.open_top';

-- 7. No actor default and no lock left on the two tables.
--    Expected: actor_defaults = 0, conflicting_locks = 0 (a non-zero value that
--    is gone a few seconds later was an ordinary short write).
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg
    where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
      and l.relation in ('training_load.source_metric_definitions'::regclass, 'training_load.source_metric_definition_versions'::regclass)) as conflicting_locks;
