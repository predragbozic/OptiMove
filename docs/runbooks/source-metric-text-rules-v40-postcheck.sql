-- v40 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the phase 4 merge served /api/health with ok: true
-- (v39's post-check is docs/runbooks/source-metric-revision-lifecycle-v39-postcheck.sql).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v40 recorded exactly once with the repository's
--    checksum, and it is the last migration; v39 recorded once.
--    Expected: v40_rows = 1, v40_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql,
--    v39_rows = 1.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql') as v40_rows,
  (select bool_and(checksum = 'd684fce90ff11f0e8e834b96241cb32d6be8fe039e17fedf3e9a3d4dfc396332') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql') as v40_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_rows;

-- 2. The two functions carry v40's bodies (no btrim; the Q10 characters, such
--    as U+3164, named; the explicit U+0020 in the unit rule) and keep their
--    signature, parameter names, language and volatility.
--    Expected: text_ok_is_v40 = true, unit_token_is_v40 = true, sql_immutable = 2,
--    text_ok_args = v text, max_len integer, unit_token_args = v text.
select
  (select bool_and(position('btrim' in p.prosrc) = 0 and position('3164' in p.prosrc) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_text_ok') as text_ok_is_v40,
  (select bool_and(position('0020|=' in p.prosrc) > 0 and position('3164' in p.prosrc) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_unit_token_ok') as unit_token_is_v40,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname = 'training_load' and p.proname in ('source_metric_text_ok', 'source_metric_unit_token_ok')
      and l.lanname = 'sql' and p.provolatile = 'i') as sql_immutable,
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_text_ok') as text_ok_args,
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_unit_token_ok') as unit_token_args;

-- 3. Every CHECK that calls the two functions (directly, or through the
--    parameter shape) is still there and validated.
--    Expected: checks = 21, checks_validated = 21.
select count(*) as checks, count(*) filter (where c.convalidated) as checks_validated
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
 where n.nspname = 'training_load' and c.contype = 'c'
   and pg_get_constraintdef(c.oid) ~ '(source_metric_text_ok|source_metric_unit_token_ok|source_metric_parameters_shape_ok)\(';

-- 4. No stored row is refused by the new rule (the migration's own block
--    checked it before its COMMIT; this reads it again through the functions).
--    Expected: 21 rows, refused = 0 in every row.
select col, refused from (
  select 'source_metric_definitions.source_label' as col, (select count(*) from training_load.source_metric_definitions where not training_load.source_metric_text_ok(source_label, 80)) as refused
  union all select 'source_metric_definitions.retired_reason', (select count(*) from training_load.source_metric_definitions where retired_reason is not null and not training_load.source_metric_text_ok(retired_reason, 500))
  union all select 'source_metric_definition_versions.expected_source_unit', (select count(*) from training_load.source_metric_definition_versions where expected_source_unit is not null and not training_load.source_metric_unit_token_ok(expected_source_unit))
  union all select 'source_metric_definition_versions.source_unit', (select count(*) from training_load.source_metric_definition_versions where source_unit is not null and not training_load.source_metric_unit_token_ok(source_unit))
  union all select 'source_metric_definition_versions.expected_source_bound_unit', (select count(*) from training_load.source_metric_definition_versions where expected_source_bound_unit is not null and not training_load.source_metric_unit_token_ok(expected_source_bound_unit))
  union all select 'source_metric_definition_versions.source_bound_unit', (select count(*) from training_load.source_metric_definition_versions where source_bound_unit is not null and not training_load.source_metric_unit_token_ok(source_bound_unit))
  union all select 'source_metric_definition_versions.unit_note', (select count(*) from training_load.source_metric_definition_versions where unit_note is not null and not training_load.source_metric_text_ok(unit_note, 500))
  union all select 'source_metric_definition_versions.retired_reason', (select count(*) from training_load.source_metric_definition_versions where retired_reason is not null and not training_load.source_metric_text_ok(retired_reason, 500))
  union all select 'unit_conversions.from_unit', (select count(*) from training_load.unit_conversions where not training_load.source_metric_text_ok(from_unit, 30))
  union all select 'unit_conversions.to_unit', (select count(*) from training_load.unit_conversions where not training_load.source_metric_text_ok(to_unit, 30))
  union all select 'unit_conversions.retired_reason', (select count(*) from training_load.unit_conversions where retired_reason is not null and not training_load.source_metric_text_ok(retired_reason, 500))
  union all select 'source_metric_mapping_versions.source_unit', (select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_unit_token_ok(source_unit))
  union all select 'source_metric_mapping_versions.target_unit', (select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_unit_token_ok(target_unit))
  union all select 'source_metric_mapping_versions.conversion_note', (select count(*) from training_load.source_metric_mapping_versions where conversion_note is not null and not training_load.source_metric_text_ok(conversion_note, 500))
  union all select 'source_metric_mapping_versions.disable_reason', (select count(*) from training_load.source_metric_mapping_versions where disable_reason is not null and not training_load.source_metric_text_ok(disable_reason, 500))
  union all select 'source_metric_mapping_versions.source_parameters', (select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_parameters_shape_ok(parameter_kind, 'source', source_parameters))
  union all select 'source_metric_mapping_versions.canonical_parameters', (select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_parameters_shape_ok(parameter_kind, 'canonical', canonical_parameters))
  union all select 'source_metric_mapping_activations.reason', (select count(*) from training_load.source_metric_mapping_activations where not training_load.source_metric_text_ok(reason, 500))
  union all select 'metric_value_source_provenance.source_unit', (select count(*) from training_load.metric_value_source_provenance where not training_load.source_metric_unit_token_ok(source_unit))
  union all select 'source_metric_audit.reason', (select count(*) from training_load.source_metric_audit where reason is not null and not training_load.source_metric_text_ok(reason, 500))
  union all select 'metric_variable_requests.reason', (select count(*) from training_load.metric_variable_requests where reason is not null and not training_load.source_metric_text_ok(reason, 500))
) as counts order by col;
