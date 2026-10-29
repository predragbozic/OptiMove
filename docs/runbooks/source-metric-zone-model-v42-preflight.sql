-- v42 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the phase 5b pull request
-- (migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql;
-- contract docs/ai/phase5-zone-model-contract.md, section 3.5).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later, as v41 already needs.
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v41 the last migration, recorded once with the
--    repository's checksum; v42 absent and nothing recorded at or after its
--    name (the migrator runs files in name order).
--    Expected: v41_rows = 1, v41_checksum_ok = true, v42_rows = 0,
--    at_or_after_v42 = 0,
--    last_migration = migrations_v2/202610281000_training_load_v41_metric_classification.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_rows,
  (select bool_and(checksum = '600be1a964ac92cf55486f2cc4bf41bbf488539073e83e6de610778831f4d89d') from public.schema_migrations
    where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as v42_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as at_or_after_v42,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The two functions v42 replaces are exactly v34's seed window and v39's
--    actor guard (the md5 of each body as those migrations wrote it), and
--    neither carries a comment yet.
--    Expected: seed_window_is_v34 = true, actor_guard_is_v39 = true,
--    seed_window_comment = null, actor_guard_comment = null.
select
  (select md5(p.prosrc) = '4f870ac6676ffaf2c63178f11664e69b'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_require_seed_window') as seed_window_is_v34,
  (select md5(p.prosrc) = '57365c058b35c6d6113eb7a5d4a9942a'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_revisions_actor_guard') as actor_guard_is_v39,
  obj_description('training_load.source_metric_require_seed_window(text)'::regprocedure, 'pg_proc') as seed_window_comment,
  obj_description('training_load.source_metric_revisions_actor_guard()'::regprocedure, 'pg_proc') as actor_guard_comment;

-- 4. The source fields are the nine of v34 and no other; none has the new key.
--    v34_fingerprint is a digest of the nine v34 fields and all their
--    revisions, every column.
--    Expected: fields = 9, v34_fields = 9, open_top_rows = 0; v34_fingerprint
--    is information: record it, post-check block 4 shows it again (run both in
--    the same tool, the Supabase SQL Editor, so dates print the same way).
select
  (select count(*) from training_load.source_metric_definitions) as fields,
  (select count(*) from training_load.source_metric_definitions
    where seed_migration = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_fields,
  (select count(*) from training_load.source_metric_definitions
    where source_metric_key = 'more.complementary_data.power.distance.open_top') as open_top_rows,
  (select md5(string_agg(row_to_json(d)::text || row_to_json(r)::text, '|' order by d.source_metric_key, r.revision_number))
     from training_load.source_metric_definitions d
     join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id
    where d.seed_migration = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_fingerprint;

-- 5. No zone revision carries a meaning proof or an operator (until v42 the
--    database refuses both, so a non-zero value here is a stop).
--    Expected: zones_with_meaning_or_operator = 0. zone_revisions is
--    informational: 2 (the power and the speed zone fields of v34) unless a
--    revision of one was created since.
select
  (select count(*) from training_load.source_metric_definition_versions where parameter_kind = 'zone_bounds') as zone_revisions,
  (select count(*) from training_load.source_metric_definition_versions
    where parameter_kind = 'zone_bounds' and (meaning_verified_at is not null or bound_operator is not null)) as zones_with_meaning_or_operator;

-- 6. The migrator's role may do it: it owns the two tables (the seed inserts
--    run their triggers as any write does; the lock needs no more) and the
--    two functions (a `create or replace` needs it); every trigger of the two
--    tables is enabled.
--    Expected: owns_fields = true, owns_revisions = true, owns_functions = true,
--    disabled_triggers = 0.
select
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_definitions'::regclass)) = current_user as owns_fields,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_definition_versions'::regclass)) = current_user as owns_revisions,
  (select bool_and(pg_get_userbyid(p.proowner) = current_user) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in ('source_metric_require_seed_window', 'source_metric_revisions_actor_guard')) as owns_functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_definitions', 'source_metric_definition_versions')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 7. Informational - record the numbers (T3, T4, T5, T6 and T8).
--    Expected: any value.
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions) as mapping_versions,
  (select count(*) from training_load.source_metric_mapping_activations) as activations,
  (select count(*) from training_load.metric_value_source_provenance) as provenance_rows,
  (select count(*) from training_load.source_metric_audit) as audit_rows;

-- 8. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 9. A quiet moment: v42 takes SHARE ROW EXCLUSIVE on the source fields and
--    their revisions until it commits, so no other session holds or waits for
--    a lock mode that conflicts with it (plain reads - ACCESS SHARE - do not),
--    and none is idle in a transaction.
--    Expected: conflicting_locks = 0, idle_in_transaction = 0. A non-zero
--    conflicting_locks that is gone when the block is run again a few seconds
--    later was an ordinary short write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
      and l.relation in ('training_load.source_metric_definitions'::regclass, 'training_load.source_metric_definition_versions'::regclass)) as conflicting_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
