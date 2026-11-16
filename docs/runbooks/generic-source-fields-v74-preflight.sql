-- Read-only preflight of migration v74 (generic source fields, G1): migrations_v2/202611161200_training_load_v74_generic_source_fields.sql
-- Run each block in a read-only transaction (begin transaction read only; ... rollback;). Every block names its expected
-- value; anything else is a stop. Block 6's two values are kept: the post-check compares them.

-- 1. PostgreSQL and the migrations: v72 recorded, v74 not; v73 (App health) may be recorded or not. Expected: v72 = 1,
--    v74 = 0, later_than_v74 = 0.
select current_setting('server_version_num') as server_version_num,
       (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611151200_training_load_v72_source_field_observations.sql') as v72,
       (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql') as v74,
       (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql') as later_than_v74;

-- 2. The twelve bodies v74 replaces are the ones it was written on. Expected: 12 rows, every ok = true.
with expected(name, md5) as (values
    ('source_metric_audit_revision_guard', '942b806526756311a5289b42c27e4918'),
    ('source_metric_audit_row_ok', '0ef48fd391a5380f70c92d96f47f894a'),
    ('source_metric_confirmation_items_insert_guard', 'e653a3f19a7509468035912c4af4fddc'),
    ('source_metric_confirmation_rows_hold', 'cad0eba4b81cd3abf13e81be61879a17'),
    ('source_metric_confirmations_commit_link', '5d424bf0457f4b94a2377b733b6b1414'),
    ('source_metric_confirmations_insert_guard', 'bbab4e588f066c01abee0cf931c4c768'),
    ('source_metric_display_unit_ok', 'ce1f638445a5a9539b8f38e2dc7196b0'),
    ('source_metric_mapping_versions_update_guard', '42fb55a2dd043328079fa9b6f4a2c43e'),
    ('source_metric_require_seed_window', '7b475353e78d96e24cb4c7beeb440af4'),
    ('source_metric_revisions_actor_guard', 'e9ecbc6b57ed3f2dc93a450707c9270f'),
    ('source_metric_revisions_audit_link', '65a257caab8316ad595fa3a1351f2545'),
    ('source_metric_revisions_guard', 'ddd8721160d7f5efa8a456fc220532c2'))
select e.name, (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'training_load' and p.proname = e.name) = e.md5 as ok
  from expected e order by 1;

-- 3. Nothing v74 creates exists yet. Expected: every count 0.
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname in ('source_metric_definitions_actor_guard', 'source_metric_definitions_create_link')) as functions,
       (select count(*) from information_schema.columns where table_schema = 'training_load'
         and column_name in ('unit_observation_id', 'meaning_observation_id', 'source_metric_version_id')
         and table_name in ('source_metric_definition_versions', 'source_metric_confirmations')) as columns,
       (select count(*) from training_load.unit_conversions where from_unit = 'number' and to_unit = 'count') as number_count;

-- 4. The rows the new CHECKs read already satisfy them (they only widen; a sanity count). Expected: 0.
select count(*) as rows_outside from training_load.source_metric_definition_versions
 where not ((evidence_status = 'unproven') = (evidence_ref is null));

-- 5. A quiet moment: no lock held or awaited on the six tables, no idle transaction. Expected: 0 and 0.
select (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
         where l.pid <> pg_backend_pid() and n.nspname = 'training_load' and c.relname in ('source_metric_definitions', 'source_metric_definition_versions',
           'source_metric_confirmations', 'source_metric_confirmation_items', 'source_metric_audit', 'unit_conversions')) as locks,
       (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%') as idle_transactions;

-- 6. The revisions verified by documents, before v74 (the post-check's block 5 compares both values).
select count(*)::int as verified_revisions,
         md5(coalesce(string_agg(concat_ws('|', id, source_metric_definition_id, revision_number, state, value_shape, parameter_kind,
           source_unit, source_bound_unit, bound_operator, unit_verified_by_user_id, unit_verified_at, unit_evidence_ref,
           meaning_verified_by_user_id, meaning_verified_at, meaning_evidence_ref, evidence_status, evidence_ref, activated_at, retired_at), '#' order by id), '')) as verified_digest
    from training_load.source_metric_definition_versions where evidence_status = 'verified';
