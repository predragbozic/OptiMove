-- v40 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), before the merge and deploy of the phase 4 pull request
-- (migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql,
-- deployed together with v39, whose own preflight is
-- docs/runbooks/source-metric-revision-lifecycle-v39-preflight.sql). Run it
-- the same day as the merge and deploy, after the last admin write: v40's
-- fail-closed block refuses the migration (and the server does not start)
-- if a row the new rule refuses exists at deploy time.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 13 or later and a UTF8 server encoding (v40's patterns name
--    code points outside the Basic Multilingual Plane; the migration refuses
--    any other encoding).
--    Expected: pg13_or_later = true, utf8 = true.
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 130000 as pg13_or_later,
       current_setting('server_encoding') = 'UTF8' as utf8;

-- 2. The migration state: v40 (and v39, deployed with it) absent, and nothing
--    recorded at or after v39's name.
--    Expected: v39_rows = 0, v40_rows = 0, at_or_after_v39 = 0,
--    last_migration = migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_rows,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql') as v40_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as at_or_after_v39,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The two functions still carry v34's bodies, and the migrator's role owns
--    them (a `create or replace` needs it).
--    Expected: text_ok_is_v34 = true, unit_token_is_v34 = true, owns_functions = true.
select
  (select bool_and(position('btrim' in p.prosrc) > 0) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_text_ok') as text_ok_is_v34,
  (select bool_and(position('|=' in p.prosrc) > 0 and position('3164' in p.prosrc) = 0) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_unit_token_ok') as unit_token_is_v34,
  (select bool_and(pg_get_userbyid(p.proowner) = current_user) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in ('source_metric_text_ok', 'source_metric_unit_token_ok')) as owns_functions;

-- 4. The rows the new rule would refuse, column by column - every CHECK that
--    calls the two functions (directly, or through the parameter shape for a
--    parameter's unit). A read-only transaction cannot create a function, so the
--    new rule is copied inline below (the `rule` lines; the parity test of
--    backend/tests/source-revision-lifecycle-v39.test.mjs proves they equal the
--    migration's functions and backend/src/metricTextRules.js on every code point).
--    Expected: 21 rows, refused = 0 in every row. Any row above 0: stop, change
--    nothing, report the column and the count (never the value).
with rule as (
  select
    '^[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$'::text as edge,
    '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'::text as text_forbidden,
    '[\u0020|=\u0001-\u001f\u007f-\u009f\u00a0\u00ad\u034f\u061c\u115f\u1160\u1680\u17b4\u17b5\u180b-\u180f\u2000-\u200f\u2028-\u202f\u205f-\u206f\u2800\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'::text as unit_forbidden
),
-- text_bad(v, n): not (1..n characters, no blank at either end, no forbidden character).
-- unit_bad(v): not (1..30 characters, no forbidden character).
counts(col, refused) as (
  select 'source_metric_definitions.source_label', count(*) from training_load.source_metric_definitions, rule
   where not (char_length(source_label) between 1 and 80 and source_label !~ rule.edge and source_label !~ rule.text_forbidden)
  union all select 'source_metric_definitions.retired_reason', count(*) from training_load.source_metric_definitions, rule
   where retired_reason is not null and not (char_length(retired_reason) between 1 and 500 and retired_reason !~ rule.edge and retired_reason !~ rule.text_forbidden)
  union all select 'source_metric_definition_versions.expected_source_unit', count(*) from training_load.source_metric_definition_versions, rule
   where expected_source_unit is not null and not (char_length(expected_source_unit) between 1 and 30 and expected_source_unit !~ rule.unit_forbidden)
  union all select 'source_metric_definition_versions.source_unit', count(*) from training_load.source_metric_definition_versions, rule
   where source_unit is not null and not (char_length(source_unit) between 1 and 30 and source_unit !~ rule.unit_forbidden)
  union all select 'source_metric_definition_versions.expected_source_bound_unit', count(*) from training_load.source_metric_definition_versions, rule
   where expected_source_bound_unit is not null and not (char_length(expected_source_bound_unit) between 1 and 30 and expected_source_bound_unit !~ rule.unit_forbidden)
  union all select 'source_metric_definition_versions.source_bound_unit', count(*) from training_load.source_metric_definition_versions, rule
   where source_bound_unit is not null and not (char_length(source_bound_unit) between 1 and 30 and source_bound_unit !~ rule.unit_forbidden)
  union all select 'source_metric_definition_versions.unit_note', count(*) from training_load.source_metric_definition_versions, rule
   where unit_note is not null and not (char_length(unit_note) between 1 and 500 and unit_note !~ rule.edge and unit_note !~ rule.text_forbidden)
  union all select 'source_metric_definition_versions.retired_reason', count(*) from training_load.source_metric_definition_versions, rule
   where retired_reason is not null and not (char_length(retired_reason) between 1 and 500 and retired_reason !~ rule.edge and retired_reason !~ rule.text_forbidden)
  union all select 'unit_conversions.from_unit', count(*) from training_load.unit_conversions, rule
   where not (char_length(from_unit) between 1 and 30 and from_unit !~ rule.edge and from_unit !~ rule.text_forbidden)
  union all select 'unit_conversions.to_unit', count(*) from training_load.unit_conversions, rule
   where not (char_length(to_unit) between 1 and 30 and to_unit !~ rule.edge and to_unit !~ rule.text_forbidden)
  union all select 'unit_conversions.retired_reason', count(*) from training_load.unit_conversions, rule
   where retired_reason is not null and not (char_length(retired_reason) between 1 and 500 and retired_reason !~ rule.edge and retired_reason !~ rule.text_forbidden)
  union all select 'source_metric_mapping_versions.source_unit', count(*) from training_load.source_metric_mapping_versions, rule
   where not (char_length(source_unit) between 1 and 30 and source_unit !~ rule.unit_forbidden)
  union all select 'source_metric_mapping_versions.target_unit', count(*) from training_load.source_metric_mapping_versions, rule
   where not (char_length(target_unit) between 1 and 30 and target_unit !~ rule.unit_forbidden)
  union all select 'source_metric_mapping_versions.conversion_note', count(*) from training_load.source_metric_mapping_versions, rule
   where conversion_note is not null and not (char_length(conversion_note) between 1 and 500 and conversion_note !~ rule.edge and conversion_note !~ rule.text_forbidden)
  union all select 'source_metric_mapping_versions.disable_reason', count(*) from training_load.source_metric_mapping_versions, rule
   where disable_reason is not null and not (char_length(disable_reason) between 1 and 500 and disable_reason !~ rule.edge and disable_reason !~ rule.text_forbidden)
  -- A parameter's unit (the rest of the parameter shape is unchanged by v40 and
  -- already held by v34's CHECK).
  union all select 'source_metric_mapping_versions.source_parameters', count(*) from training_load.source_metric_mapping_versions, rule
   where parameter_kind <> 'none' and not (char_length(source_parameters ->> 'unit') between 1 and 30 and (source_parameters ->> 'unit') !~ rule.unit_forbidden)
  union all select 'source_metric_mapping_versions.canonical_parameters', count(*) from training_load.source_metric_mapping_versions, rule
   where parameter_kind <> 'none' and not (char_length(canonical_parameters ->> 'unit') between 1 and 30 and (canonical_parameters ->> 'unit') !~ rule.unit_forbidden)
  union all select 'source_metric_mapping_activations.reason', count(*) from training_load.source_metric_mapping_activations, rule
   where not (char_length(reason) between 1 and 500 and reason !~ rule.edge and reason !~ rule.text_forbidden)
  union all select 'metric_value_source_provenance.source_unit', count(*) from training_load.metric_value_source_provenance, rule
   where not (char_length(source_unit) between 1 and 30 and source_unit !~ rule.unit_forbidden)
  union all select 'source_metric_audit.reason', count(*) from training_load.source_metric_audit, rule
   where reason is not null and not (char_length(reason) between 1 and 500 and reason !~ rule.edge and reason !~ rule.text_forbidden)
  union all select 'metric_variable_requests.reason', count(*) from training_load.metric_variable_requests, rule
   where reason is not null and not (char_length(reason) between 1 and 500 and reason !~ rule.edge and reason !~ rule.text_forbidden)
)
select col, refused from counts order by col;

-- 5. Informational only - not part of v40's fail-closed block (v38 exempts an
--    unchanged name, J3b.9): the system and club variables of Metrics Core whose
--    name the new rule would refuse, and the units a new mapping version would
--    refuse (a mapping version's insert checks the canonical unit, v34, C56; the
--    unit of a condition description is tied to the canonical parameters' unit).
--    Expected: any value; record the numbers. A number above 0 means that
--    variable keeps its name until it is renamed, and that a new mapping version
--    to it is refused until its unit is corrected.
with rule as (
  select
    '^[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$'::text as edge,
    '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'::text as text_forbidden,
    '[\u0020|=\u0001-\u001f\u007f-\u009f\u00a0\u00ad\u034f\u061c\u115f\u1160\u1680\u17b4\u17b5\u180b-\u180f\u2000-\u200f\u2028-\u202f\u205f-\u206f\u2800\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'::text as unit_forbidden
)
select
  (select count(*) from training_load.metric_definitions d, rule
    where d.owner_scope in ('system', 'club')
      and not (char_length(d.label) between 1 and 80 and d.label !~ rule.edge and d.label !~ rule.text_forbidden)) as labels_refused,
  (select count(*) from training_load.metric_definitions d, rule
    where d.owner_scope in ('system', 'club') and d.short_label is not null
      and not (char_length(d.short_label) between 1 and 20 and d.short_label !~ rule.edge and d.short_label !~ rule.text_forbidden)) as short_labels_refused,
  (select count(*) from training_load.metric_definitions d, rule
    where d.owner_scope in ('system', 'club') and d.description is not null
      and not (char_length(d.description) between 1 and 500 and d.description !~ rule.edge and d.description !~ rule.text_forbidden)) as descriptions_refused,
  (select count(*) from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id, rule
    where d.owner_scope in ('system', 'club') and v.unit is not null
      and not (char_length(v.unit) between 1 and 30 and v.unit !~ rule.unit_forbidden)) as current_units_refused,
  (select count(*) from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id, rule
    where d.owner_scope in ('system', 'club') and jsonb_typeof(v.condition_description -> 'unit') = 'string'
      and not (char_length(v.condition_description ->> 'unit') between 1 and 30 and (v.condition_description ->> 'unit') !~ rule.unit_forbidden)) as condition_units_refused;
