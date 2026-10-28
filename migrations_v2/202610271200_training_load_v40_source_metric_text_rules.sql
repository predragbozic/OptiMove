-- v40: Q10 part B - the database twins of the Metrics Core admin text rules.
--
-- Contract: docs/ai/v39-revision-lifecycle-contract.md (J5, section J5.4),
-- decision C100 of docs/ai/gpexe-metric-variable-mapping-discovery.md (O6,
-- R5) and J3b.9 (Q10). Q10 part A (PR #229) made the services and the
-- frontend refuse a wider set of characters (backend/src/metricTextRules.js);
-- the database still accepted what part A refuses. v40 replaces the two v34
-- functions every CHECK and guard of the source metric tables calls, so the
-- database refuses the same text whoever writes it:
--
--   * source_metric_text_ok(v, max_len): 1 to max_len characters (code
--     points, char_length), no character of TEXT_FORBIDDEN, and no character
--     of TEXT_EDGE_BLANK (U+0020, U+00A0, U+1680, U+2000-U+200A, U+202F,
--     U+205F, U+3000) at either end. v34's rule was v = btrim(v) (U+0020
--     only) and C53's shorter list: the new rule is a strict superset of it.
--   * source_metric_unit_token_ok(v): 1-30 characters, no character of
--     UNIT_FORBIDDEN. v34's locale-dependent \s is now an explicit U+0020:
--     the explicit list already holds every other JavaScript \s code point,
--     so the rule is the same on every server locale.
--
-- The lists use only PostgreSQL's fixed-width \uXXXX and \UXXXXXXXX escapes
-- inside one bracket expression each (never \x, which is variable length) -
-- the same characters as backend/src/metricTextRules.js; the parity test of
-- backend/tests/source-revision-lifecycle-v39.test.mjs compares every code
-- point of the two layers and of the read-only preflight's inline copy. The
-- signatures, the parameter names (v, max_len), `language sql immutable` and
-- the OIDs stay, so every CHECK stays attached.
--
-- Fail-closed: a CHECK is not re-validated when its function is replaced, so
-- a row the new rule refuses would stay and could no longer be updated (and a
-- later dump restore, which re-validates, would fail). The DO block at the end
-- counts, column by column, the rows the new functions refuse and raises if
-- any count is above 0: the runner then rolls back v40 alone (each migration
-- is its own transaction, backend/src/migrate.js) and stops, so the server
-- does not start. The read-only preflight
-- (docs/runbooks/source-metric-text-rules-v40-preflight.sql) shows the same
-- counts before the merge; the recovery if the block refuses anyway is in the
-- runbook (remove the v40 file and redeploy, or correct a row that is not
-- append-only on the owner's order and redeploy the same code).
--
-- No table, column, index or trigger change; no data change. Rollback:
-- docs/runbooks/source-metric-text-rules-v40-rollback.sql restores the v34
-- bodies verbatim (the new rule only refuses, so no row depends on it).

do $$
begin
  if current_setting('server_encoding') is distinct from 'UTF8' then
    raise exception 'v40: the server encoding must be UTF8' using errcode = '22023';
  end if;
end $$;

-- Bounded single-line text (C41, C53, Q10): 1..max characters; none of
-- U+0001-U+001F, U+007F-U+009F, U+00AD, U+034F, U+061C, U+115F, U+1160,
-- U+17B4, U+17B5, U+180B-U+180F, U+200B-U+200F, U+2028-U+202E, U+2060-U+206F,
-- U+2800, U+3164, U+FE00-U+FE0F, U+FEFF, U+FFA0, U+FFF0-U+FFFB,
-- U+1BCA0-U+1BCA3, U+1D173-U+1D17A, U+E0000-U+E0FFF; no blank (U+0020,
-- U+00A0, U+1680, U+2000-U+200A, U+202F, U+205F, U+3000) at either end. A
-- NULL is never "ok": a nullable column checks "is null or ok".
create or replace function training_load.source_metric_text_ok(v text, max_len integer) returns boolean
  language sql immutable as $$
    select coalesce(char_length(v) between 1 and max_len
       and v !~ '^[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$'
       and v !~ '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]', false)
  $$;

-- A unit token (D3, Q10): 1-30 characters; none of U+0020, "|", "=" (the
-- characters the fingerprint text uses), U+0001-U+001F, U+007F-U+009F,
-- U+00A0, U+00AD, U+034F, U+061C, U+115F, U+1160, U+1680, U+17B4, U+17B5,
-- U+180B-U+180F, U+2000-U+200F, U+2028-U+202F, U+205F-U+206F, U+2800,
-- U+3000, U+3164, U+FE00-U+FE0F, U+FEFF, U+FFA0, U+FFF0-U+FFFB,
-- U+1BCA0-U+1BCA3, U+1D173-U+1D17A, U+E0000-U+E0FFF.
create or replace function training_load.source_metric_unit_token_ok(v text) returns boolean
  language sql immutable as $$
    select coalesce(char_length(v) between 1 and 30
       and v !~ '[\u0020|=\u0001-\u001f\u007f-\u009f\u00a0\u00ad\u034f\u061c\u115f\u1160\u1680\u17b4\u17b5\u180b-\u180f\u2000-\u200f\u2028-\u202f\u205f-\u206f\u2800\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]', false)
  $$;

-- Fail-closed: no existing row may be refused by the new rule. Every CHECK
-- that calls the two functions (directly, or through
-- source_metric_parameters_shape_ok for a parameter's unit), column by
-- column; a count above 0 rolls v40 back.
do $$
declare
  refused text[] := '{}';
  n bigint;
  r record;
begin
  for r in
    select * from (values
      ('source_metric_definitions.source_label',
       $q$select count(*) from training_load.source_metric_definitions where not training_load.source_metric_text_ok(source_label, 80)$q$),
      ('source_metric_definitions.retired_reason',
       $q$select count(*) from training_load.source_metric_definitions where retired_reason is not null and not training_load.source_metric_text_ok(retired_reason, 500)$q$),
      ('source_metric_definition_versions.expected_source_unit',
       $q$select count(*) from training_load.source_metric_definition_versions where expected_source_unit is not null and not training_load.source_metric_unit_token_ok(expected_source_unit)$q$),
      ('source_metric_definition_versions.source_unit',
       $q$select count(*) from training_load.source_metric_definition_versions where source_unit is not null and not training_load.source_metric_unit_token_ok(source_unit)$q$),
      ('source_metric_definition_versions.expected_source_bound_unit',
       $q$select count(*) from training_load.source_metric_definition_versions where expected_source_bound_unit is not null and not training_load.source_metric_unit_token_ok(expected_source_bound_unit)$q$),
      ('source_metric_definition_versions.source_bound_unit',
       $q$select count(*) from training_load.source_metric_definition_versions where source_bound_unit is not null and not training_load.source_metric_unit_token_ok(source_bound_unit)$q$),
      ('source_metric_definition_versions.unit_note',
       $q$select count(*) from training_load.source_metric_definition_versions where unit_note is not null and not training_load.source_metric_text_ok(unit_note, 500)$q$),
      ('source_metric_definition_versions.retired_reason',
       $q$select count(*) from training_load.source_metric_definition_versions where retired_reason is not null and not training_load.source_metric_text_ok(retired_reason, 500)$q$),
      ('unit_conversions.from_unit',
       $q$select count(*) from training_load.unit_conversions where not training_load.source_metric_text_ok(from_unit, 30)$q$),
      ('unit_conversions.to_unit',
       $q$select count(*) from training_load.unit_conversions where not training_load.source_metric_text_ok(to_unit, 30)$q$),
      ('unit_conversions.retired_reason',
       $q$select count(*) from training_load.unit_conversions where retired_reason is not null and not training_load.source_metric_text_ok(retired_reason, 500)$q$),
      ('source_metric_mapping_versions.source_unit',
       $q$select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_unit_token_ok(source_unit)$q$),
      ('source_metric_mapping_versions.target_unit',
       $q$select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_unit_token_ok(target_unit)$q$),
      ('source_metric_mapping_versions.conversion_note',
       $q$select count(*) from training_load.source_metric_mapping_versions where conversion_note is not null and not training_load.source_metric_text_ok(conversion_note, 500)$q$),
      ('source_metric_mapping_versions.disable_reason',
       $q$select count(*) from training_load.source_metric_mapping_versions where disable_reason is not null and not training_load.source_metric_text_ok(disable_reason, 500)$q$),
      ('source_metric_mapping_versions.source_parameters',
       $q$select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_parameters_shape_ok(parameter_kind, 'source', source_parameters)$q$),
      ('source_metric_mapping_versions.canonical_parameters',
       $q$select count(*) from training_load.source_metric_mapping_versions where not training_load.source_metric_parameters_shape_ok(parameter_kind, 'canonical', canonical_parameters)$q$),
      ('source_metric_mapping_activations.reason',
       $q$select count(*) from training_load.source_metric_mapping_activations where not training_load.source_metric_text_ok(reason, 500)$q$),
      ('metric_value_source_provenance.source_unit',
       $q$select count(*) from training_load.metric_value_source_provenance where not training_load.source_metric_unit_token_ok(source_unit)$q$),
      ('source_metric_audit.reason',
       $q$select count(*) from training_load.source_metric_audit where reason is not null and not training_load.source_metric_text_ok(reason, 500)$q$),
      ('metric_variable_requests.reason',
       $q$select count(*) from training_load.metric_variable_requests where reason is not null and not training_load.source_metric_text_ok(reason, 500)$q$)
    ) as c(col, sql)
  loop
    execute r.sql into n;
    if n > 0 then
      refused := array_append(refused, r.col || ' ' || n);
    end if;
  end loop;
  if array_length(refused, 1) > 0 then
    raise exception 'v40 refused: rows the new text rule refuses exist (%)', array_to_string(refused, ', ') using errcode = '23514';
  end if;
end $$;
