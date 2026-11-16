-- Read-only post-check of migration v74 (generic source fields, G1): migrations_v2/202611161200_training_load_v74_generic_source_fields.sql
-- Run each block in a read-only transaction. Every block names its expected value.

-- 1. v74 recorded once with the file's checksum, and nothing later. Expected: 1, true, 0.
select count(*) as v74_rows, bool_and(checksum = '4bba2767f4b39b8ffdab4ef39a4513f33d884f9bcff880af147b31537a4f764b') as checksum_ok,
       (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql') as later
  from public.schema_migrations where migration_name = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql';

-- 2. The fifteen v74 bodies. Expected: 15 rows, every ok = true.
with expected(name, md5) as (values
    ('source_metric_audit_revision_guard', '833800203ddc21ef2c9758d6393a554a'),
    ('source_metric_audit_row_ok', 'd4f6fa07d21bcd54a21d7789b67c38ae'),
    ('source_metric_confirmation_items_insert_guard', '1d2c25710612f3adf811cc4421db4d62'),
    ('source_metric_confirmation_rows_hold', '54d39cb464774bcba838b046e236b682'),
    ('source_metric_confirmations_commit_link', 'f55ef973de6a49ead59359c87a8279fa'),
    ('source_metric_confirmations_insert_guard', '54db1047da56c6848acc21bfe68d6685'),
    ('source_metric_definitions_actor_guard', 'eaf6ebc56de03c7413e843da4dc77644'),
    ('source_metric_definitions_create_link', 'ee8dbd5650fbcad096bb3f0e146a95c4'),
    ('source_metric_display_unit_ok', '0f9faa060c4d3a98d7a665af0885a95d'),
    ('source_metric_mapping_versions_update_guard', '1a5652ad19625a1d7e57333984dc1ad8'),
    ('source_metric_require_seed_window', '0152cdbdd79f8c40151ee40efe1aab21'),
    ('source_metric_revisions_actor_guard', 'ef8659d274a09a25c50a8485a0ce6562'),
    ('source_metric_revisions_audit_link', '1b2a0a55036e3688d0cf3cb457f4c324'),
    ('source_metric_revisions_guard', '00d89ea1daededdc1591646f30e5f5c5'),
    ('source_unit_words_guard', 'dbfa79d52c1479affbdd796136ee3cac'))
select e.name, (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'training_load' and p.proname = e.name) = e.md5 as ok
  from expected e order by 1;

-- 3. The two new triggers, enabled; the new columns. Expected: 2 enabled triggers; 3 columns.
select (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O'
         and tgname in ('source_metric_definitions_v74_actor_guard', 'source_metric_definitions_v74_create_link')) as triggers,
       (select count(*) from information_schema.columns where table_schema = 'training_load'
         and ((table_name = 'source_metric_definition_versions' and column_name in ('unit_observation_id', 'meaning_observation_id'))
           or (table_name = 'source_metric_confirmations' and column_name = 'source_metric_version_id'))) as columns;

-- 4. GPEXE's unit words, exactly (plan section 8.10). Expected: nine rows, as listed there.
select word, source_unit, display_rule, evidence_kind, evidence_ref from training_load.source_unit_words
 where source_system = 'gpexe' and api_family = 'rest_v1' order by word;

-- 5. The revisions verified by documents are unchanged. Expected: the two values of the preflight's block 6.
select count(*)::int as verified_revisions,
         md5(coalesce(string_agg(concat_ws('|', id, source_metric_definition_id, revision_number, state, value_shape, parameter_kind,
           source_unit, source_bound_unit, bound_operator, unit_verified_by_user_id, unit_verified_at, unit_evidence_ref,
           meaning_verified_by_user_id, meaning_verified_at, meaning_evidence_ref, evidence_status, evidence_ref, activated_at, retired_at), '#' order by id), '')) as verified_digest
    from training_load.source_metric_definition_versions where evidence_status = 'verified';

-- 6. Nothing was created or observed yet. Expected: every count 0.
select (select count(*) from training_load.source_metric_audit
         where action in ('source_metric_create', 'source_metric_unit_observed', 'source_metric_meaning_observed')) as audit_rows,
       (select count(*) from training_load.source_metric_confirmations where kind = 'field_observation') as observations,
       (select count(*) from training_load.source_metric_definition_versions where evidence_status = 'source_stated') as source_stated;

-- 7. No idle transaction left. Expected: 0.
select count(*) as idle_transactions from pg_stat_activity where datname = current_database() and state like 'idle in transaction%';
