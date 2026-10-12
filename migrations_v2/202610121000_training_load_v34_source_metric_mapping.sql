-- Training Load v34 - the schema foundation of the source-to-canonical metric
-- mapping (M1).
--
-- Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, sections C
-- (owner decisions C1-C39 and the M1 SQL decisions C40-C50), D1-D12 and E.
-- Rule: .claude/rules/metrics-core-mapping.md. Metrics Core
-- (training_load.metric_definitions and its versions) stays the only
-- registry of OptiMove variables; nothing here is a second one.
--
-- What it adds:
--   D1  source_host_catalog.api_family (backfilled e03 -> api, server3 ->
--       rest_v1; immutable through its own trigger beside the v27 guard).
--   D2  T2a source_metric_definitions - the stable identity of a source field.
--   D3  T2b source_metric_definition_versions - its revisioned, proven contract.
--   D4  T3 source_metric_mappings - "this source field feeds this canonical
--       variable", owned by the system or one club (generated owner_key).
--   D5  unit_conversions - the only gate of a non-identity factor.
--   D6  T4 source_metric_mapping_versions - the immutable mapping contract,
--       the database-computed parameter fingerprint, the per-owner active
--       target; the guard on metric_definitions (decision 9) and on the
--       removal of a scope capability under an active version (section E).
--   D7  T5 source_metric_mapping_activations - one version on one team
--       binding; unique (id, team_id) on source_team_bindings as its anchor.
--   D8  T6 metric_value_source_provenance - 1:1 with an imported value.
--   D9  T7 - the write-once source instance on metric_source_connections.
--   D10 T8 source_metric_audit - append-only, one shape per action.
--   D12 the seed: nine observed gpexe / rest_v1 source fields with revision 1
--       and NO unit, and the four unit_conversions rows of D5.
--
-- What it does NOT do: it creates no canonical definition, no mapping, no
-- mapping version, no activation, no provenance row and no audit row; it
-- confirms no GPEXE unit or meaning (every seeded revision is 'observed',
-- every unit NULL); it adds no route and changes no importer, mapper,
-- preview or writer. The GPEXE importer keeps creating its team-owned
-- gpexe_* definitions until M4 (temporary compatibility, C46).
--
-- Lock order of every writer (D, as built): unit_conversions -> T2a -> T2b
-- -> T3 -> T4 -> metric_definitions (FOR SHARE) -> its scope-capability rows
-- (FOR SHARE, only an activation reads them under a lock) -> T5 -> the acting
-- user's user_global_roles / user_club_roles, users, clubs (FOR SHARE). The
-- triggers lock only parents they read, in that order; the v27 rows
-- (binding, connection, catalog) and T2a are plain reads (D7; T2a's state is
-- implied by the chain T5 -> active T4 -> active T2b, see the T2a guard).
--
-- Errors: an acting user who is not allowed raises SQLSTATE 42501; every
-- other explicit refusal of a trigger raises 23514; every message is fixed
-- text without an id, a value or a source answer. Native FK / UNIQUE / NOT
-- NULL / CHECK errors keep their own codes (C44).
--
-- Rollback: docs/runbooks/source-metric-mapping-v34-rollback.sql (rehearsed in
-- backend/tests/source-metric-mapping-m1.test.mjs on a disposable database).

-- ---------------------------------------------------------------------------
-- 0. Shape helpers (immutable; used by CHECK constraints and triggers)
-- ---------------------------------------------------------------------------

-- Bounded single-line text (C41): no leading or trailing space, 1..max
-- characters, no C0, DEL or C1 control character, no line or paragraph
-- separator. A NULL is never "ok": a nullable column checks "is null or ok".
create function training_load.source_metric_text_ok(v text, max_len integer) returns boolean
  language sql immutable as $$
    select coalesce(v = btrim(v)
       and char_length(v) between 1 and max_len
       and v !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]', false)
  $$;

-- A unit token (D3): 1-30 characters, no whitespace (the locale's \s and,
-- explicitly, every Unicode space and zero-width / bidi format character),
-- no control character, no "|" or "=" (the characters the fingerprint text
-- uses).
create function training_load.source_metric_unit_token_ok(v text) returns boolean
  language sql immutable as $$
    select coalesce(char_length(v) between 1 and 30
       and v !~ '[\s|=\x01-\x1f\x7f-\x9f\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]', false)
  $$;

-- A document reference (C40): a repository-relative path under docs/, no
-- empty, "." or ".." segment, then exactly one "#" and a non-empty anchor;
-- no space, colon (so no URL), control character or second "#"; 1-300
-- characters. That the file and the anchor exist is a test, not a CHECK.
create function training_load.source_metric_evidence_ref_ok(v text) returns boolean
  language sql immutable as $$
    select coalesce(char_length(v) between 1 and 300
       and v ~ '^docs(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+#[A-Za-z0-9_-]+$', false)
  $$;

-- A finite numeric (D5): numeric can hold NaN, Infinity and -Infinity, and
-- NaN compares greater than every number, so "> 0" alone admits it.
create function training_load.source_metric_numeric_finite(n numeric) returns boolean
  language sql immutable as $$
    select coalesce(n::text not in ('NaN', 'Infinity', '-Infinity'), false)
  $$;

-- The exact shape of a parameter snapshot (section E). 'none': {}. Zone
-- bounds: exactly {operator, lower, upper, unit}, numbers, upper null only
-- for an open operator, lower < upper. Event threshold: exactly {operator,
-- threshold_value | value, duration_seconds, unit}. Every unit a unit token,
-- every operator from the closed set of D3.
create function training_load.source_metric_parameters_shape_ok(p_kind text, p_side text, p jsonb) returns boolean
  language sql immutable as $$
    select coalesce(case
      when p is null or jsonb_typeof(p) <> 'object' then false
      when p_kind = 'none' then p = '{}'::jsonb
      when p_kind = 'zone_bounds' then
        (select array_agg(k order by k collate "C") from jsonb_object_keys(p) as k) = array['lower', 'operator', 'unit', 'upper']
        and jsonb_typeof(p -> 'lower') = 'number'
        and jsonb_typeof(p -> 'upper') in ('number', 'null')
        and jsonb_typeof(p -> 'unit') = 'string' and training_load.source_metric_unit_token_ok(p ->> 'unit')
        and jsonb_typeof(p -> 'operator') = 'string' and (p ->> 'operator') in ('between', '>=', '>', '<=', '<')
        and ((p ->> 'operator') = 'between') = (jsonb_typeof(p -> 'upper') = 'number')
        and case when jsonb_typeof(p -> 'lower') = 'number' and jsonb_typeof(p -> 'upper') = 'number'
                 then (p ->> 'lower')::numeric < (p ->> 'upper')::numeric else true end
      when p_kind = 'event_threshold' then
        (select array_agg(k order by k collate "C") from jsonb_object_keys(p) as k)
          = case p_side when 'source' then array['duration_seconds', 'operator', 'threshold_value', 'unit']
                        when 'canonical' then array['duration_seconds', 'operator', 'unit', 'value'] end
        and jsonb_typeof(p -> 'duration_seconds') = 'number'
        and jsonb_typeof(p -> (case p_side when 'source' then 'threshold_value' else 'value' end)) = 'number'
        and jsonb_typeof(p -> 'unit') = 'string' and training_load.source_metric_unit_token_ok(p ->> 'unit')
        and jsonb_typeof(p -> 'operator') = 'string' and (p ->> 'operator') in ('>=', '>', '<=', '<')
      else false end, false)
  $$;

-- The parameter fingerprint, version 1 (section E): '' for 'none', otherwise
-- 'v1:' and the SHA-256 hex of <kind> followed by |<key>=<value> for every
-- key of the source parameters sorted bytewise; a number through
-- trim_scale() in plain decimal notation, a JSON null as "null", a text as
-- its bytes. Bounds, units and the operator only - never an identity.
-- Computed by the T4 INSERT trigger only.
create function training_load.source_metric_parameter_fingerprint(p_kind text, p jsonb) returns text
  language sql stable as $$
    select case when p_kind = 'none' then ''
      else 'v1:' || encode(sha256(convert_to(
        p_kind || coalesce((
          select string_agg('|' || e.key || '=' || case jsonb_typeof(e.value)
                   when 'number' then trim_scale((e.value #>> '{}')::numeric)::text
                   when 'null' then 'null'
                   when 'string' then e.value #>> '{}'
                   else e.value::text end, '' order by e.key collate "C")
            from jsonb_each(p) as e), ''), 'UTF8')), 'hex')
    end
  $$;

-- The storage-scale check of D8 (C39): the value lies on the 9-decimal grid
-- and is the exact (source x scale + offset x divisor) / divisor rounded half
-- away from zero, tested with multiplications only.
create function training_load.source_metric_value_matches(p_source numeric, p_value numeric, p_scale numeric, p_div numeric, p_off numeric) returns boolean
  language sql immutable as $$
    select coalesce(scale(trim_scale(p_value)) <= 9 and (
      abs(p_value * p_div - (p_source * p_scale + p_off * p_div)) < p_div * 0.0000000005
      or (abs(p_value * p_div - (p_source * p_scale + p_off * p_div)) = p_div * 0.0000000005
          and sign(p_value * p_div - (p_source * p_scale + p_off * p_div)) = sign(p_source * p_scale + p_off * p_div))), false)
  $$;

-- The acting user (C45; v21 / v26 patterns): an active platform admin, or an
-- active admin of an active club. The role and user rows (and the club) are
-- held FOR SHARE, so a concurrent revocation lands first or waits.
create function training_load.source_metric_require_platform_admin(p_user uuid) returns void as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
     for share of r, u;
  if not found then
    raise exception 'source metric mapping: the acting user is not an active platform admin' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

create function training_load.source_metric_require_club_admin(p_user uuid, p_club uuid) returns void as $$
begin
  perform 1
    from public.user_club_roles r
    join public.users u on u.id = r.user_id
    join public.clubs c on c.id = r.club_id
   where r.user_id = p_user and r.club_id = p_club and r.role = 'club_admin' and r.is_active = true
     and u.is_active = true and coalesce(c.is_active, true)
     for share of r, u, c;
  if not found then
    raise exception 'source metric mapping: the acting user is not an active admin of the mapping''s club' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

-- A seed marker is accepted only from the migration that seeds (D12): the
-- marker names v34, and v34 is not recorded yet - true only inside v34's
-- own transaction, because the runner records a migration after running its
-- file, in the same transaction. Any later row with a marker has no acting
-- user and is refused (42501). A later seeding migration replaces this
-- function to name itself.
create function training_load.source_metric_require_seed_window(p_marker text) returns void as $$
begin
  if p_marker is distinct from 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'
     or exists (select 1 from public.schema_migrations where migration_name = p_marker) then
    raise exception 'source metric mapping: a seed marker is accepted only from the seeding migration' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

create function training_load.source_metric_no_truncate() returns trigger as $$
begin
  raise exception '%.% keeps history; TRUNCATE refused', tg_table_schema, tg_table_name using errcode = '23514';
end;
$$ language plpgsql;

-- The dedicated append-only refusal of T6 and T8 (forbid_update_delete of v10
-- formats old.id, and T6 has no id column).
create function training_load.source_metric_append_only() returns trigger as $$
begin
  raise exception '%.% is append-only; % refused', tg_table_schema, tg_table_name, tg_op using errcode = '23514';
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- D1. source_host_catalog.api_family
-- ---------------------------------------------------------------------------
alter table training_load.source_host_catalog add column api_family text;

update training_load.source_host_catalog
   set api_family = case host_key when 'e03' then 'api' when 'server3' then 'rest_v1' end
 where source_system = 'gpexe';

-- A catalog row this migration cannot place stays NULL and fails here: the
-- migration refuses to guess an API family.
alter table training_load.source_host_catalog alter column api_family set not null;
alter table training_load.source_host_catalog
  add constraint source_host_catalog_api_family_check check (api_family in ('api', 'rest_v1'));

comment on column training_load.source_host_catalog.api_family is
  'v34 (D1): the API family of the host (api | rest_v1), equal to apiFamily of backend/src/sourceHosts.js for the key. Immutable.';

-- Beside the v27 guard (which stays unchanged): the family never changes.
create function training_load.source_host_catalog_api_family_immutable() returns trigger as $$
begin
  if new.api_family is distinct from old.api_family then
    raise exception 'source_host_catalog: the API family of a host key is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_host_catalog_api_family_immutable
  before update on training_load.source_host_catalog
  for each row execute function training_load.source_host_catalog_api_family_immutable();

-- ---------------------------------------------------------------------------
-- D2. T2a source_metric_definitions
-- ---------------------------------------------------------------------------
create table training_load.source_metric_definitions (
  id                  uuid primary key default gen_random_uuid(),
  source_system       text not null
                        constraint source_metric_definitions_source_system_format
                        check (source_system ~ '^[a-z][a-z0-9_]{1,30}$'),
  api_family          text not null
                        constraint source_metric_definitions_api_family_check
                        check (api_family in ('api', 'rest_v1')),
  source_metric_key   text not null
                        constraint source_metric_definitions_key_format
                        check (source_metric_key ~ '^[a-z][a-z0-9_.]{1,120}$'),
  -- The source's own name: the only editable column.
  source_label        text not null
                        constraint source_metric_definitions_label_check
                        check (training_load.source_metric_text_ok(source_label, 80)),
  state               text not null default 'active'
                        constraint source_metric_definitions_state_check
                        check (state in ('active', 'retired')),
  retired_by_user_id  uuid references public.users(id) on delete restrict,
  retired_at          timestamptz,
  retired_reason      text
                        constraint source_metric_definitions_retired_reason_check
                        check (retired_reason is null or training_load.source_metric_text_ok(retired_reason, 500)),
  created_by_user_id  uuid references public.users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  seed_migration      text
                        constraint source_metric_definitions_seed_migration_format
                        check (seed_migration is null or seed_migration ~ '^migrations_v2/[0-9]{12}_[a-z0-9_]+\.sql$'),
  constraint source_metric_definitions_retired_facts check (
    (state = 'active' and retired_by_user_id is null and retired_at is null and retired_reason is null) or
    (state = 'retired' and retired_by_user_id is not null and retired_at is not null and retired_reason is not null)
  ),
  constraint source_metric_definitions_actor_or_seed
    check ((created_by_user_id is null) <> (seed_migration is null)),
  constraint source_metric_definitions_identity_key unique (source_system, api_family, source_metric_key),
  constraint source_metric_definitions_family_anchor unique (id, source_system, api_family)
);

comment on table training_load.source_metric_definitions is
  'v34 (D2, T2a): one row per field a source offers, with no semantics, no unit and no value. Identity (system, family, key) immutable; only source_label is editable; never deleted. Free text never names an athlete or carries a value.';

-- Retirement is refused while a revision is draft or active, or an
-- activation of the field is open. Those reads are plain: a revision insert
-- locks this row FOR SHARE (so it waits for a retirement or makes it wait),
-- a revision activation needs a committed draft (which blocks retirement),
-- and an open activation needs an active version, which needs an active
-- revision - so the chain keeps a retired field free of usable rows.
create function training_load.source_metric_definitions_guard() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_definitions: a source metric is never deleted; retire it' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'active' then
      raise exception 'source_metric_definitions: a source metric is created active' using errcode = '23514';
    end if;
    if new.seed_migration is not null then
      perform training_load.source_metric_require_seed_window(new.seed_migration);
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.source_system is distinct from old.source_system
     or new.api_family is distinct from old.api_family or new.source_metric_key is distinct from old.source_metric_key
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at
     or new.seed_migration is distinct from old.seed_migration then
    raise exception 'source_metric_definitions: the identity of a source metric is immutable' using errcode = '23514';
  end if;
  if old.state = 'retired' then
    if (new.state, new.retired_by_user_id, new.retired_at, new.retired_reason)
       is distinct from (old.state, old.retired_by_user_id, old.retired_at, old.retired_reason) then
      raise exception 'source_metric_definitions: a retired source metric stays retired' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.state = 'retired' then
    if exists (select 1 from training_load.source_metric_definition_versions
                where source_metric_definition_id = old.id and state in ('draft', 'active')) then
      raise exception 'source_metric_definitions: a source metric with a draft or active revision is not retired' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_mapping_activations
                where source_metric_definition_id = old.id and ended_at is null) then
      raise exception 'source_metric_definitions: a source metric with an open activation is not retired' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_definitions_guard
  before insert or update or delete on training_load.source_metric_definitions
  for each row execute function training_load.source_metric_definitions_guard();
create trigger source_metric_definitions_no_truncate
  before truncate on training_load.source_metric_definitions
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- D3. T2b source_metric_definition_versions
-- ---------------------------------------------------------------------------
create table training_load.source_metric_definition_versions (
  id                           uuid primary key default gen_random_uuid(),
  source_metric_definition_id  uuid not null
                                 constraint source_metric_revisions_definition_fk
                                 references training_load.source_metric_definitions(id) on delete restrict,
  revision_number              integer not null
                                 constraint source_metric_revisions_number_check check (revision_number > 0),
  value_shape                  text not null
                                 constraint source_metric_revisions_value_shape_check
                                 check (value_shape in ('number', 'numeric_text', 'unit_value_object', 'zone_distance', 'event_count')),
  parameter_kind               text not null
                                 constraint source_metric_revisions_parameter_kind_check
                                 check (parameter_kind in ('none', 'zone_bounds', 'event_threshold')),
  supports_session             boolean not null,
  supports_drill               boolean not null,
  -- A hypothesis only (never enters a mapping).
  expected_source_unit         text
                                 constraint source_metric_revisions_expected_unit_token
                                 check (expected_source_unit is null or training_load.source_metric_unit_token_ok(expected_source_unit)),
  unit_note                    text
                                 constraint source_metric_revisions_unit_note_check
                                 check (unit_note is null or training_load.source_metric_text_ok(unit_note, 500)),
  -- Only a proven unit; NULL until proven.
  source_unit                  text
                                 constraint source_metric_revisions_source_unit_token
                                 check (source_unit is null or training_load.source_metric_unit_token_ok(source_unit)),
  expected_source_bound_unit   text
                                 constraint source_metric_revisions_expected_bound_unit_token
                                 check (expected_source_bound_unit is null or training_load.source_metric_unit_token_ok(expected_source_bound_unit)),
  source_bound_unit            text
                                 constraint source_metric_revisions_source_bound_unit_token
                                 check (source_bound_unit is null or training_load.source_metric_unit_token_ok(source_bound_unit)),
  bound_operator               text
                                 constraint source_metric_revisions_bound_operator_check
                                 check (bound_operator is null or bound_operator in ('between', '>=', '>', '<=', '<')),
  unit_verified_by_user_id     uuid references public.users(id) on delete restrict,
  unit_verified_at             timestamptz,
  unit_evidence_ref            text
                                 constraint source_metric_revisions_unit_evidence_ref_check
                                 check (unit_evidence_ref is null or training_load.source_metric_evidence_ref_ok(unit_evidence_ref)),
  meaning_verified_by_user_id  uuid references public.users(id) on delete restrict,
  meaning_verified_at          timestamptz,
  meaning_evidence_ref         text
                                 constraint source_metric_revisions_meaning_evidence_ref_check
                                 check (meaning_evidence_ref is null or training_load.source_metric_evidence_ref_ok(meaning_evidence_ref)),
  evidence_status              text not null
                                 constraint source_metric_revisions_evidence_status_check
                                 check (evidence_status in ('unproven', 'documented', 'observed', 'verified')),
  evidence_ref                 text
                                 constraint source_metric_revisions_evidence_ref_check
                                 check (evidence_ref is null or training_load.source_metric_evidence_ref_ok(evidence_ref)),
  state                        text not null default 'draft'
                                 constraint source_metric_revisions_state_check
                                 check (state in ('draft', 'active', 'retired')),
  activated_by_user_id         uuid references public.users(id) on delete restrict,
  activated_at                 timestamptz,
  retired_by_user_id           uuid references public.users(id) on delete restrict,
  retired_at                   timestamptz,
  retired_reason               text
                                 constraint source_metric_revisions_retired_reason_check
                                 check (retired_reason is null or training_load.source_metric_text_ok(retired_reason, 500)),
  created_by_user_id           uuid references public.users(id) on delete restrict,
  created_at                   timestamptz not null default now(),
  seed_migration               text
                                 constraint source_metric_revisions_seed_migration_format
                                 check (seed_migration is null or seed_migration ~ '^migrations_v2/[0-9]{12}_[a-z0-9_]+\.sql$'),
  constraint source_metric_revisions_shape_kind check (
    (value_shape = 'zone_distance') = (parameter_kind = 'zone_bounds') and
    (value_shape = 'event_count') = (parameter_kind = 'event_threshold')
  ),
  constraint source_metric_revisions_levels_check check (supports_session or supports_drill),
  constraint source_metric_revisions_bound_only_parameterized check (
    parameter_kind <> 'none' or (expected_source_bound_unit is null and source_bound_unit is null and bound_operator is null)
  ),
  -- C43: a parameterized revision with a proven value unit has a proven bound unit.
  constraint source_metric_revisions_proven_bound_unit
    check (parameter_kind = 'none' or source_unit is null or source_bound_unit is not null),
  constraint source_metric_revisions_bound_unit_with_unit_proof
    check (source_bound_unit is null or unit_verified_at is not null),
  constraint source_metric_revisions_unit_proof_together check (
    (unit_verified_by_user_id is null) = (unit_verified_at is null) and
    (unit_verified_at is null) = (unit_evidence_ref is null)
  ),
  constraint source_metric_revisions_unit_proven_iff_verified
    check ((source_unit is null) = (unit_verified_at is null)),
  constraint source_metric_revisions_meaning_proof_together check (
    (meaning_verified_by_user_id is null) = (meaning_verified_at is null) and
    (meaning_verified_at is null) = (meaning_evidence_ref is null)
  ),
  -- C38: the operator is confirmed in the same act as the meaning.
  constraint source_metric_revisions_operator_with_meaning
    check (parameter_kind = 'none' or (meaning_verified_at is null) = (bound_operator is null)),
  constraint source_metric_revisions_verified_iff_proven check (
    (evidence_status = 'verified') =
    (source_unit is not null and meaning_verified_at is not null and (parameter_kind = 'none' or bound_operator is not null))
  ),
  -- C42: the first evidence_ref comes with the rise from 'unproven'.
  constraint source_metric_revisions_evidence_ref_iff_proven
    check ((evidence_status = 'unproven') = (evidence_ref is null)),
  constraint source_metric_revisions_state_facts check (
    (state = 'draft' and activated_by_user_id is null and activated_at is null
       and retired_by_user_id is null and retired_at is null and retired_reason is null) or
    (state = 'active' and activated_at is not null
       and retired_by_user_id is null and retired_at is null and retired_reason is null) or
    (state = 'retired' and retired_by_user_id is not null and retired_at is not null and retired_reason is not null)
  ),
  constraint source_metric_revisions_activation_actor_or_seed check (
    (activated_by_user_id is null or activated_at is not null) and
    (activated_at is null or (activated_by_user_id is null) <> (seed_migration is null))
  ),
  constraint source_metric_revisions_actor_or_seed
    check ((created_by_user_id is null) <> (seed_migration is null)),
  constraint source_metric_revisions_number_key unique (source_metric_definition_id, revision_number),
  constraint source_metric_revisions_definition_anchor unique (id, source_metric_definition_id)
);

create unique index source_metric_revisions_one_active
  on training_load.source_metric_definition_versions (source_metric_definition_id) where state = 'active';
create unique index source_metric_revisions_one_draft
  on training_load.source_metric_definition_versions (source_metric_definition_id) where state = 'draft';

comment on table training_load.source_metric_definition_versions is
  'v34 (D3, T2b): the proven contract of a source field. A correction is a new revision; the old one is retired, never changed. source_unit / bound unit / operator only after an audited verification; expected_* and unit_note are a hypothesis. Never a value, bound or threshold.';

create function training_load.source_metric_revisions_guard() returns trigger as $$
declare
  ranks constant text[] := array['unproven', 'documented', 'observed', 'verified'];
  unit_act boolean;
  meaning_act boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_definition_versions: a revision is never deleted; retire it' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    -- C42: a new revision only for an active source metric (T2a -> T2b).
    perform 1 from training_load.source_metric_definitions
     where id = new.source_metric_definition_id and state = 'active' for share;
    if not found then
      raise exception 'source_metric_definition_versions: a revision is created only for an active source metric' using errcode = '23514';
    end if;
    if not (new.state = 'draft' or (new.state = 'active' and new.seed_migration is not null)) then
      raise exception 'source_metric_definition_versions: a revision is created as draft; only a seed migration creates it active' using errcode = '23514';
    end if;
    if new.source_unit is not null or new.source_bound_unit is not null or new.unit_verified_by_user_id is not null
       or new.unit_verified_at is not null or new.unit_evidence_ref is not null or new.meaning_verified_by_user_id is not null
       or new.meaning_verified_at is not null or new.meaning_evidence_ref is not null or new.bound_operator is not null
       or new.activated_by_user_id is not null then
      raise exception 'source_metric_definition_versions: a revision is created without proof; unit and meaning are verified afterwards' using errcode = '23514';
    end if;
    if new.seed_migration is not null then
      perform training_load.source_metric_require_seed_window(new.seed_migration);
    end if;
    return new;
  end if;

  if old.state = 'retired' then
    if new is distinct from old then
      raise exception 'source_metric_definition_versions: a retired revision is immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  -- C42: identity, hypothesis, shape, parameter kind and levels are immutable.
  if new.id is distinct from old.id or new.source_metric_definition_id is distinct from old.source_metric_definition_id
     or new.revision_number is distinct from old.revision_number or new.value_shape is distinct from old.value_shape
     or new.parameter_kind is distinct from old.parameter_kind or new.supports_session is distinct from old.supports_session
     or new.supports_drill is distinct from old.supports_drill or new.expected_source_unit is distinct from old.expected_source_unit
     or new.expected_source_bound_unit is distinct from old.expected_source_bound_unit or new.unit_note is distinct from old.unit_note
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at
     or new.seed_migration is distinct from old.seed_migration then
    raise exception 'source_metric_definition_versions: the contract of a revision is immutable; correct it with a new revision' using errcode = '23514';
  end if;
  -- Proof is written once, from NULL, by its own act, never overwritten or cleared.
  if old.unit_verified_at is not null
     and (new.source_unit, new.source_bound_unit, new.unit_verified_by_user_id, new.unit_verified_at, new.unit_evidence_ref)
         is distinct from (old.source_unit, old.source_bound_unit, old.unit_verified_by_user_id, old.unit_verified_at, old.unit_evidence_ref) then
    raise exception 'source_metric_definition_versions: a unit proof is written once' using errcode = '23514';
  end if;
  if old.meaning_verified_at is not null
     and (new.bound_operator, new.meaning_verified_by_user_id, new.meaning_verified_at, new.meaning_evidence_ref)
         is distinct from (old.bound_operator, old.meaning_verified_by_user_id, old.meaning_verified_at, old.meaning_evidence_ref) then
    raise exception 'source_metric_definition_versions: a meaning proof is written once' using errcode = '23514';
  end if;
  if array_position(ranks, new.evidence_status) < array_position(ranks, old.evidence_status) then
    raise exception 'source_metric_definition_versions: the evidence status only rises' using errcode = '23514';
  end if;
  if old.evidence_ref is not null and new.evidence_ref is distinct from old.evidence_ref then
    raise exception 'source_metric_definition_versions: the evidence reference is written once' using errcode = '23514';
  end if;
  unit_act := old.unit_verified_at is null and new.unit_verified_at is not null;
  meaning_act := old.meaning_verified_at is null and new.meaning_verified_at is not null;
  if (unit_act or meaning_act) and new.state is distinct from old.state then
    raise exception 'source_metric_definition_versions: a verification is its own act, apart from a state change' using errcode = '23514';
  end if;

  if new.state is not distinct from old.state then
    if (new.activated_by_user_id, new.activated_at, new.retired_by_user_id, new.retired_at, new.retired_reason)
       is distinct from (old.activated_by_user_id, old.activated_at, old.retired_by_user_id, old.retired_at, old.retired_reason) then
      raise exception 'source_metric_definition_versions: the state facts are written by their transition' using errcode = '23514';
    end if;
  elsif old.state = 'draft' and new.state = 'active' then
    -- C42: activation needs an active source metric (a committed draft already
    -- blocks retirement, so this plain read is a backstop) and no other
    -- active revision (the partial unique index is the physical guard).
    if not exists (select 1 from training_load.source_metric_definitions
                    where id = new.source_metric_definition_id and state = 'active') then
      raise exception 'source_metric_definition_versions: a revision of a retired source metric is not activated' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_definition_versions
                where source_metric_definition_id = new.source_metric_definition_id and id <> new.id and state = 'active') then
      raise exception 'source_metric_definition_versions: another revision of this source metric is active; retire it first' using errcode = '23514';
    end if;
  elsif new.state = 'retired' then
    if (new.activated_by_user_id, new.activated_at) is distinct from (old.activated_by_user_id, old.activated_at) then
      raise exception 'source_metric_definition_versions: the state facts are written by their transition' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_mapping_versions
                where source_metric_version_id = old.id and status in ('needs_review', 'active')) then
      raise exception 'source_metric_definition_versions: a revision pinned by a submitted or active mapping version is not retired' using errcode = '23514';
    end if;
  else
    raise exception 'source_metric_definition_versions: this revision state transition is not allowed' using errcode = '23514';
  end if;

  -- The acting users the contract names (D intro), after every registry row.
  if unit_act then
    perform training_load.source_metric_require_platform_admin(new.unit_verified_by_user_id);
  end if;
  if meaning_act then
    perform training_load.source_metric_require_platform_admin(new.meaning_verified_by_user_id);
  end if;
  if old.state = 'draft' and new.state = 'active' then
    perform training_load.source_metric_require_platform_admin(new.activated_by_user_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_revisions_guard
  before insert or update or delete on training_load.source_metric_definition_versions
  for each row execute function training_load.source_metric_revisions_guard();
create trigger source_metric_revisions_no_truncate
  before truncate on training_load.source_metric_definition_versions
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- D4. T3 source_metric_mappings
-- ---------------------------------------------------------------------------
create table training_load.source_metric_mappings (
  id                           uuid primary key default gen_random_uuid(),
  source_metric_definition_id  uuid not null,
  source_system                text not null,
  api_family                   text not null,
  metric_definition_id         uuid not null
                                 constraint source_metric_mappings_definition_fk
                                 references training_load.metric_definitions(id) on delete restrict,
  owner_scope                  text not null
                                 constraint source_metric_mappings_owner_scope_check
                                 check (owner_scope in ('system', 'club')),
  owner_club_id                uuid
                                 constraint source_metric_mappings_owner_club_fk
                                 references public.clubs(id) on delete restrict,
  -- Never NULL, so every composite FK that copies it is checked (D4).
  owner_key                    text not null generated always as (coalesce(owner_club_id::text, 'system')) stored,
  created_by_user_id           uuid not null references public.users(id) on delete restrict,
  created_at                   timestamptz not null default now(),
  constraint source_metric_mappings_source_fk
    foreign key (source_metric_definition_id, source_system, api_family)
    references training_load.source_metric_definitions (id, source_system, api_family) on delete restrict,
  constraint source_metric_mappings_owner_check check (
    (owner_scope = 'system' and owner_club_id is null) or (owner_scope = 'club' and owner_club_id is not null)
  ),
  constraint source_metric_mappings_pair_key unique (source_metric_definition_id, metric_definition_id),
  constraint source_metric_mappings_version_anchor unique (id, source_metric_definition_id, metric_definition_id),
  constraint source_metric_mappings_family_anchor unique (id, source_system, api_family),
  constraint source_metric_mappings_owner_anchor unique (id, owner_key)
);

comment on table training_load.source_metric_mappings is
  'v34 (D4, T3): "this source field feeds this canonical variable", owned by the system or one club. May exist before the unit is proven; changes go through T4 versions. Immutable; never deleted.';

create function training_load.source_metric_mappings_guard() returns trigger as $$
declare
  md record;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_mappings: a mapping is never deleted' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'source_metric_mappings: a mapping identity is immutable; change it through a new version' using errcode = '23514';
  end if;
  select owner_scope, owner_club_id, state into md
    from training_load.metric_definitions where id = new.metric_definition_id for share;
  if not found or md.state is distinct from 'active' then
    raise exception 'source_metric_mappings: the canonical definition must be active' using errcode = '23514';
  end if;
  if new.owner_scope = 'system' and md.owner_scope is distinct from 'system' then
    raise exception 'source_metric_mappings: a system mapping targets a system definition' using errcode = '23514';
  end if;
  if new.owner_scope = 'club' and (md.owner_scope is distinct from 'club' or md.owner_club_id is distinct from new.owner_club_id) then
    raise exception 'source_metric_mappings: a club mapping targets a definition of the same club' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mappings_guard
  before insert or update or delete on training_load.source_metric_mappings
  for each row execute function training_load.source_metric_mappings_guard();
create trigger source_metric_mappings_no_truncate
  before truncate on training_load.source_metric_mappings
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- D5. unit_conversions
-- ---------------------------------------------------------------------------
create table training_load.unit_conversions (
  id                  uuid primary key default gen_random_uuid(),
  from_unit           text not null
                        constraint unit_conversions_from_unit_check check (training_load.source_metric_text_ok(from_unit, 30)),
  to_unit             text not null
                        constraint unit_conversions_to_unit_check check (training_load.source_metric_text_ok(to_unit, 30)),
  scale               numeric not null,
  scale_divisor       numeric not null,
  "offset"            numeric not null,
  state               text not null default 'active'
                        constraint unit_conversions_state_check check (state in ('active', 'retired')),
  retired_by_user_id  uuid references public.users(id) on delete restrict,
  retired_at          timestamptz,
  retired_reason      text
                        constraint unit_conversions_retired_reason_check
                        check (retired_reason is null or training_load.source_metric_text_ok(retired_reason, 500)),
  evidence_ref        text not null
                        constraint unit_conversions_evidence_ref_check check (training_load.source_metric_evidence_ref_ok(evidence_ref)),
  created_by_user_id  uuid references public.users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  seed_migration      text
                        constraint unit_conversions_seed_migration_format
                        check (seed_migration is null or seed_migration ~ '^migrations_v2/[0-9]{12}_[a-z0-9_]+\.sql$'),
  constraint unit_conversions_units_differ check (from_unit <> to_unit),
  constraint unit_conversions_factors_finite check (
    training_load.source_metric_numeric_finite(scale) and training_load.source_metric_numeric_finite(scale_divisor)
    and training_load.source_metric_numeric_finite("offset")
  ),
  constraint unit_conversions_scale_nonzero check (scale <> 0),
  constraint unit_conversions_divisor_positive check (scale_divisor > 0),
  constraint unit_conversions_factors_normal check (scale = 1 or scale_divisor = 1),
  constraint unit_conversions_retired_facts check (
    (state = 'active' and retired_by_user_id is null and retired_at is null and retired_reason is null) or
    (state = 'retired' and retired_by_user_id is not null and retired_at is not null and retired_reason is not null)
  ),
  constraint unit_conversions_actor_or_seed check ((created_by_user_id is null) <> (seed_migration is null))
);

create unique index unit_conversions_one_active_pair
  on training_load.unit_conversions (from_unit, to_unit) where state = 'active';

comment on table training_load.unit_conversions is
  'v34 (D5): the only place a non-identity factor between two units may come from: canonical = source x scale / scale_divisor + offset, in normal form. Not a metric catalog. Rows are immutable; a correction is a retirement plus a new row; mapping versions keep their own copies.';

create function training_load.unit_conversions_guard() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'unit_conversions: a conversion is never deleted; retire it' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'active' then
      raise exception 'unit_conversions: a conversion is created active' using errcode = '23514';
    end if;
    if new.created_by_user_id is not null then
      perform training_load.source_metric_require_platform_admin(new.created_by_user_id);
    elsif new.seed_migration is not null then
      perform training_load.source_metric_require_seed_window(new.seed_migration);
    end if;
    return new;
  end if;
  if old.state = 'retired' or new.state is not distinct from old.state
     or new.id is distinct from old.id or new.from_unit is distinct from old.from_unit or new.to_unit is distinct from old.to_unit
     or new.scale::text is distinct from old.scale::text or new.scale_divisor::text is distinct from old.scale_divisor::text
     or new."offset"::text is distinct from old."offset"::text or new.evidence_ref is distinct from old.evidence_ref
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at
     or new.seed_migration is distinct from old.seed_migration then
    raise exception 'unit_conversions: a conversion is immutable; the only change is its retirement' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger unit_conversions_guard
  before insert or update or delete on training_load.unit_conversions
  for each row execute function training_load.unit_conversions_guard();
create trigger unit_conversions_no_truncate
  before truncate on training_load.unit_conversions
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- D6. T4 source_metric_mapping_versions
-- ---------------------------------------------------------------------------
create table training_load.source_metric_mapping_versions (
  id                            uuid primary key default gen_random_uuid(),
  mapping_id                    uuid not null,
  source_metric_definition_id   uuid not null,
  metric_definition_id          uuid not null,
  -- The checked copy of the mapping's owner (filled by the INSERT trigger).
  owner_key                     text not null,
  source_metric_version_id      uuid not null,
  version_number                integer not null
                                  constraint source_metric_mapping_versions_number_check check (version_number > 0),
  metric_definition_version_id  uuid not null,
  conversion_kind               text not null
                                  constraint source_metric_mapping_versions_conversion_kind_check check (conversion_kind = 'numeric_linear'),
  scale                         numeric not null,
  scale_divisor                 numeric not null,
  "offset"                      numeric not null,
  -- A presentation field, unused in the pilot (C25, C39).
  rounding_decimals             integer
                                  constraint source_metric_mapping_versions_rounding_decimals_check
                                  check (rounding_decimals is null or rounding_decimals between 0 and 6),
  source_unit                   text not null
                                  constraint source_metric_mapping_versions_source_unit_token
                                  check (training_load.source_metric_unit_token_ok(source_unit)),
  target_unit                   text not null
                                  constraint source_metric_mapping_versions_target_unit_check
                                  check (char_length(target_unit) between 1 and 30),
  conversion_note               text
                                  constraint source_metric_mapping_versions_conversion_note_check
                                  check (conversion_note is null or training_load.source_metric_text_ok(conversion_note, 500)),
  parameter_kind                text not null
                                  constraint source_metric_mapping_versions_parameter_kind_check
                                  check (parameter_kind in ('none', 'zone_bounds', 'event_threshold')),
  source_parameters             jsonb not null,
  canonical_parameters          jsonb not null,
  -- Computed by the INSERT trigger from source_parameters; never the caller's.
  parameter_fingerprint         text not null,
  parameter_scale               numeric not null,
  parameter_scale_divisor       numeric not null,
  parameter_offset              numeric not null,
  applies_to_session            boolean not null,
  applies_to_drill              boolean not null,
  status                        text not null default 'draft'
                                  constraint source_metric_mapping_versions_status_check
                                  check (status in ('draft', 'needs_review', 'active', 'disabled')),
  submitted_by_user_id          uuid references public.users(id) on delete restrict,
  submitted_at                  timestamptz,
  submitted_basis               text
                                  constraint source_metric_mapping_versions_submitted_basis_check
                                  check (submitted_basis is null or submitted_basis in ('platform_admin', 'club_admin')),
  activated_by_user_id          uuid references public.users(id) on delete restrict,
  activated_at                  timestamptz,
  activated_basis               text
                                  constraint source_metric_mapping_versions_activated_basis_check
                                  check (activated_basis is null or activated_basis = 'platform_admin'),
  disabled_by_user_id           uuid references public.users(id) on delete restrict,
  disabled_at                   timestamptz,
  disabled_basis                text
                                  constraint source_metric_mapping_versions_disabled_basis_check
                                  check (disabled_basis is null or disabled_basis = 'platform_admin'),
  disable_reason                text
                                  constraint source_metric_mapping_versions_disable_reason_check
                                  check (disable_reason is null or training_load.source_metric_text_ok(disable_reason, 500)),
  created_by_user_id            uuid not null references public.users(id) on delete restrict,
  created_at                    timestamptz not null default now(),
  constraint source_metric_mapping_versions_mapping_fk
    foreign key (mapping_id, source_metric_definition_id, metric_definition_id)
    references training_load.source_metric_mappings (id, source_metric_definition_id, metric_definition_id) on delete restrict,
  constraint source_metric_mapping_versions_owner_fk
    foreign key (mapping_id, owner_key)
    references training_load.source_metric_mappings (id, owner_key) on delete restrict,
  constraint source_metric_mapping_versions_revision_fk
    foreign key (source_metric_version_id, source_metric_definition_id)
    references training_load.source_metric_definition_versions (id, source_metric_definition_id) on delete restrict,
  constraint source_metric_mapping_versions_canonical_version_fk
    foreign key (metric_definition_version_id, metric_definition_id)
    references training_load.metric_definition_versions (id, metric_definition_id) on delete restrict,
  constraint source_metric_mapping_versions_factors_finite check (
    training_load.source_metric_numeric_finite(scale) and training_load.source_metric_numeric_finite(scale_divisor)
    and training_load.source_metric_numeric_finite("offset")
  ),
  constraint source_metric_mapping_versions_scale_nonzero check (scale <> 0),
  constraint source_metric_mapping_versions_divisor_positive check (scale_divisor > 0),
  constraint source_metric_mapping_versions_factors_normal check (scale = 1 or scale_divisor = 1),
  constraint source_metric_mapping_versions_parameter_factors_finite check (
    training_load.source_metric_numeric_finite(parameter_scale) and training_load.source_metric_numeric_finite(parameter_scale_divisor)
    and training_load.source_metric_numeric_finite(parameter_offset)
  ),
  constraint source_metric_mapping_versions_parameter_scale_nonzero check (parameter_scale <> 0),
  constraint source_metric_mapping_versions_parameter_divisor_positive check (parameter_scale_divisor > 0),
  constraint source_metric_mapping_versions_parameter_factors_normal check (parameter_scale = 1 or parameter_scale_divisor = 1),
  constraint source_metric_mapping_versions_no_parameters_identity check (
    parameter_kind <> 'none' or (parameter_scale = 1 and parameter_scale_divisor = 1 and parameter_offset = 0)
  ),
  constraint source_metric_mapping_versions_note_when_units_differ
    check (source_unit = target_unit or conversion_note is not null),
  constraint source_metric_mapping_versions_source_parameters_shape
    check (training_load.source_metric_parameters_shape_ok(parameter_kind, 'source', source_parameters)),
  constraint source_metric_mapping_versions_canonical_parameters_shape
    check (training_load.source_metric_parameters_shape_ok(parameter_kind, 'canonical', canonical_parameters)),
  constraint source_metric_mapping_versions_fingerprint_shape check (
    (parameter_kind = 'none') = (parameter_fingerprint = '') and
    (parameter_fingerprint = '' or parameter_fingerprint ~ '^v[0-9]+:[0-9a-f]{64}$')
  ),
  constraint source_metric_mapping_versions_levels_check check (applies_to_session or applies_to_drill),
  constraint source_metric_mapping_versions_submitted_facts check (
    (submitted_by_user_id is null) = (submitted_at is null) and (submitted_at is null) = (submitted_basis is null)
  ),
  constraint source_metric_mapping_versions_activated_facts check (
    (activated_by_user_id is null) = (activated_at is null) and (activated_at is null) = (activated_basis is null)
  ),
  constraint source_metric_mapping_versions_disabled_facts check (
    (disabled_by_user_id is null) = (disabled_at is null) and (disabled_at is null) = (disabled_basis is null)
    and (disabled_at is null) = (disable_reason is null)
  ),
  constraint source_metric_mapping_versions_status_facts check (
    (status = 'draft' and submitted_at is null and activated_at is null and disabled_at is null) or
    (status = 'needs_review' and submitted_at is not null and activated_at is null and disabled_at is null) or
    (status = 'active' and submitted_at is not null and activated_at is not null and disabled_at is null) or
    (status = 'disabled' and disabled_at is not null and (activated_at is null or submitted_at is not null))
  ),
  constraint source_metric_mapping_versions_number_key unique (mapping_id, version_number),
  constraint source_metric_mapping_versions_activation_anchor
    unique (id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint),
  constraint source_metric_mapping_versions_provenance_mapping_anchor unique (id, mapping_id),
  constraint source_metric_mapping_versions_provenance_revision_anchor unique (id, source_metric_version_id)
);

-- One active version per mapping (D11.4).
create unique index source_metric_mapping_versions_one_active_per_mapping
  on training_load.source_metric_mapping_versions (mapping_id) where status = 'active';
-- Within one owner, one active canonical target per source field and
-- parameters (C33, D11.5): 'system' is one key, each club its own.
create unique index source_metric_mapping_versions_one_active_target_per_owner
  on training_load.source_metric_mapping_versions (source_metric_definition_id, parameter_fingerprint, owner_key) where status = 'active';
create index source_metric_mapping_versions_revision_idx
  on training_load.source_metric_mapping_versions (source_metric_version_id);
create index source_metric_mapping_versions_active_definition_idx
  on training_load.source_metric_mapping_versions (metric_definition_id) where status = 'active';

comment on table training_load.source_metric_mapping_versions is
  'v34 (D6, T4): one approved, immutable way to turn one source revision into one canonical version. Created as draft only after the unit is proven; draft -> needs_review -> active -> disabled; only a platform admin activates or disables. parameter_fingerprint is computed by the database.';

-- The levels of a version inside the canonical definition's scope
-- capabilities (session <-> session, drill <-> component). An activation
-- locks those capability rows FOR SHARE, after metric_definitions, so a
-- removal of a level and an activation never both succeed.
create function training_load.source_metric_check_levels(p_definition uuid, p_session boolean, p_drill boolean, p_lock boolean) returns void as $$
begin
  if p_lock then
    perform 1 from training_load.metric_definition_scope_capabilities
     where metric_definition_id = p_definition order by scope_level for share;
  end if;
  if p_session and not exists (select 1 from training_load.metric_definition_scope_capabilities
                                where metric_definition_id = p_definition and scope_level = 'session') then
    raise exception 'source_metric_mapping_versions: the session level is not a scope of the canonical definition' using errcode = '23514';
  end if;
  if p_drill and not exists (select 1 from training_load.metric_definition_scope_capabilities
                              where metric_definition_id = p_definition and scope_level = 'component') then
    raise exception 'source_metric_mapping_versions: the drill level is not a scope of the canonical definition' using errcode = '23514';
  end if;
end;
$$ language plpgsql;

-- A conversion (value or bound): (1, 1, 0) for string-equal units, otherwise
-- exactly the single active unit_conversions row of the pair (C34).
create function training_load.source_metric_check_conversion(p_from text, p_to text, p_scale numeric, p_div numeric, p_off numeric, p_parameter boolean) returns void as $$
begin
  if p_from = p_to then
    if not (p_scale = 1 and p_div = 1 and p_off = 0) then
      if p_parameter then
        raise exception 'source_metric_mapping_versions: equal bound units take the identity conversion (1, 1, 0)' using errcode = '23514';
      end if;
      raise exception 'source_metric_mapping_versions: equal units take the identity conversion (1, 1, 0)' using errcode = '23514';
    end if;
    return;
  end if;
  if (select count(*) from training_load.unit_conversions
       where from_unit = p_from and to_unit = p_to and state = 'active'
         and scale = p_scale and scale_divisor = p_div and "offset" = p_off) <> 1 then
    if p_parameter then
      raise exception 'source_metric_mapping_versions: the bound conversion must equal the active unit conversion of its unit pair' using errcode = '23514';
    end if;
    raise exception 'source_metric_mapping_versions: the conversion must equal the active unit conversion of its unit pair' using errcode = '23514';
  end if;
end;
$$ language plpgsql;

-- The parameter contract of section E: the shapes, the operator and bound
-- unit of the proven revision (C43), the canonical parameters equal to the
-- normalized condition_description of the pinned canonical version, and the
-- bound equivalence with multiplications only.
create function training_load.source_metric_check_parameters(
  p_kind text, p_operator text, p_bound_unit text, p_source jsonb, p_canonical jsonb, p_cd jsonb,
  p_scale numeric, p_div numeric, p_off numeric, p_check_conversion boolean) returns void as $$
declare
  cd_keys text[];
  canon jsonb;
begin
  if not training_load.source_metric_parameters_shape_ok(p_kind, 'source', p_source)
     or not training_load.source_metric_parameters_shape_ok(p_kind, 'canonical', p_canonical) then
    raise exception 'source_metric_mapping_versions: the parameters do not have the contract shape' using errcode = '23514';
  end if;
  if p_kind = 'none' then
    if not (p_scale = 1 and p_div = 1 and p_off = 0) then
      raise exception 'source_metric_mapping_versions: a contract without parameters takes the identity parameter conversion' using errcode = '23514';
    end if;
    return;
  end if;
  if (p_source ->> 'operator') is distinct from p_operator or (p_canonical ->> 'operator') is distinct from p_operator then
    raise exception 'source_metric_mapping_versions: the operator must be the revision''s proven operator' using errcode = '23514';
  end if;
  if (p_source ->> 'unit') is distinct from p_bound_unit then
    raise exception 'source_metric_mapping_versions: the source bound unit must be the revision''s proven bound unit' using errcode = '23514';
  end if;
  if p_cd is null or jsonb_typeof(p_cd) <> 'object' then
    raise exception 'source_metric_mapping_versions: the canonical condition description has no supported shape' using errcode = '23514';
  end if;
  select array_agg(k order by k collate "C") into cd_keys from jsonb_object_keys(p_cd) as k;
  if p_kind = 'zone_bounds' then
    if (p_cd ->> 'operator') = 'between' and cd_keys = array['max', 'min', 'operator', 'unit']
       and jsonb_typeof(p_cd -> 'min') = 'number' and jsonb_typeof(p_cd -> 'max') = 'number' and jsonb_typeof(p_cd -> 'unit') = 'string' then
      canon := jsonb_build_object('operator', p_cd -> 'operator', 'lower', p_cd -> 'min', 'upper', p_cd -> 'max', 'unit', p_cd -> 'unit');
    elsif (p_cd ->> 'operator') in ('>=', '>', '<=', '<') and cd_keys = array['operator', 'unit', 'value']
       and jsonb_typeof(p_cd -> 'value') = 'number' and jsonb_typeof(p_cd -> 'unit') = 'string' then
      canon := jsonb_build_object('operator', p_cd -> 'operator', 'lower', p_cd -> 'value', 'upper', 'null'::jsonb, 'unit', p_cd -> 'unit');
    else
      raise exception 'source_metric_mapping_versions: the canonical condition description has no supported shape' using errcode = '23514';
    end if;
    if (p_canonical ->> 'operator') is distinct from (canon ->> 'operator') or (p_canonical ->> 'unit') is distinct from (canon ->> 'unit')
       or (p_canonical ->> 'lower')::numeric <> (canon ->> 'lower')::numeric
       or jsonb_typeof(p_canonical -> 'upper') is distinct from jsonb_typeof(canon -> 'upper')
       or (jsonb_typeof(canon -> 'upper') = 'number' and (p_canonical ->> 'upper')::numeric <> (canon ->> 'upper')::numeric) then
      raise exception 'source_metric_mapping_versions: the canonical parameters must equal the canonical condition description' using errcode = '23514';
    end if;
    if (p_canonical ->> 'lower')::numeric * p_div <> (p_source ->> 'lower')::numeric * p_scale + p_off * p_div
       or jsonb_typeof(p_source -> 'upper') is distinct from jsonb_typeof(p_canonical -> 'upper')
       or (jsonb_typeof(p_source -> 'upper') = 'number'
           and (p_canonical ->> 'upper')::numeric * p_div <> (p_source ->> 'upper')::numeric * p_scale + p_off * p_div) then
      raise exception 'source_metric_mapping_versions: the source and canonical bounds are not equivalent' using errcode = '23514';
    end if;
  else
    if not ((p_cd ->> 'operator') in ('>=', '>', '<=', '<') and cd_keys = array['duration_seconds', 'operator', 'unit', 'value']
            and jsonb_typeof(p_cd -> 'value') = 'number' and jsonb_typeof(p_cd -> 'duration_seconds') = 'number'
            and jsonb_typeof(p_cd -> 'unit') = 'string') then
      raise exception 'source_metric_mapping_versions: the canonical condition description has no supported shape' using errcode = '23514';
    end if;
    if (p_canonical ->> 'operator') is distinct from (p_cd ->> 'operator') or (p_canonical ->> 'unit') is distinct from (p_cd ->> 'unit')
       or (p_canonical ->> 'value')::numeric <> (p_cd ->> 'value')::numeric
       or (p_canonical ->> 'duration_seconds')::numeric <> (p_cd ->> 'duration_seconds')::numeric then
      raise exception 'source_metric_mapping_versions: the canonical parameters must equal the canonical condition description' using errcode = '23514';
    end if;
    if (p_canonical ->> 'value')::numeric * p_div <> (p_source ->> 'threshold_value')::numeric * p_scale + p_off * p_div
       or (p_canonical ->> 'duration_seconds')::numeric <> (p_source ->> 'duration_seconds')::numeric then
      raise exception 'source_metric_mapping_versions: the source and canonical thresholds are not equivalent' using errcode = '23514';
    end if;
  end if;
  if p_check_conversion then
    perform training_load.source_metric_check_conversion(p_source ->> 'unit', p_canonical ->> 'unit', p_scale, p_div, p_off, true);
  end if;
end;
$$ language plpgsql;

create function training_load.source_metric_mapping_versions_insert_guard() returns trigger as $$
declare
  rev record;
  map_owner text;
  mdv record;
begin
  -- D6: every later state is a checked transition with its acting user.
  if new.status is distinct from 'draft' then
    raise exception 'source_metric_mapping_versions: a mapping version is created as draft' using errcode = '23514';
  end if;
  select state, source_unit, source_bound_unit, bound_operator, parameter_kind, supports_session, supports_drill into rev
    from training_load.source_metric_definition_versions
   where id = new.source_metric_version_id and source_metric_definition_id = new.source_metric_definition_id for share;
  if not found then
    raise exception 'source_metric_mapping_versions: the source revision does not belong to the mapping''s source metric' using errcode = '23514';
  end if;
  if rev.state not in ('draft', 'active') or rev.source_unit is null then
    raise exception 'source_metric_mapping_versions: a mapping version needs a draft or active source revision with a proven unit' using errcode = '23514';
  end if;
  select owner_key into map_owner from training_load.source_metric_mappings
   where id = new.mapping_id and source_metric_definition_id = new.source_metric_definition_id and metric_definition_id = new.metric_definition_id;
  if not found then
    raise exception 'source_metric_mapping_versions: the version must name its mapping''s source metric and canonical definition' using errcode = '23514';
  end if;
  if new.owner_key is null then
    new.owner_key := map_owner;
  elsif new.owner_key is distinct from map_owner then
    raise exception 'source_metric_mapping_versions: the owner key must be the mapping''s own' using errcode = '23514';
  end if;
  if new.source_unit is distinct from rev.source_unit then
    raise exception 'source_metric_mapping_versions: the source unit must be the revision''s proven unit' using errcode = '23514';
  end if;
  if new.parameter_kind is distinct from rev.parameter_kind then
    raise exception 'source_metric_mapping_versions: the parameter kind must be the revision''s' using errcode = '23514';
  end if;
  if (new.applies_to_session and not rev.supports_session) or (new.applies_to_drill and not rev.supports_drill) then
    raise exception 'source_metric_mapping_versions: a level outside the revision''s levels' using errcode = '23514';
  end if;
  select value_type, unit, condition_description into mdv from training_load.metric_definition_versions
   where id = new.metric_definition_version_id and metric_definition_id = new.metric_definition_id;
  if not found then
    raise exception 'source_metric_mapping_versions: the canonical version does not belong to the canonical definition' using errcode = '23514';
  end if;
  if mdv.value_type is distinct from 'numeric' then
    raise exception 'source_metric_mapping_versions: the canonical version is not numeric' using errcode = '23514';
  end if;
  if mdv.unit is null or char_length(mdv.unit) not between 1 and 30 then
    raise exception 'source_metric_mapping_versions: canonical_unit_missing' using errcode = '23514';
  end if;
  if new.target_unit is distinct from mdv.unit then
    raise exception 'source_metric_mapping_versions: the target unit must be the canonical version''s unit' using errcode = '23514';
  end if;
  perform training_load.source_metric_check_levels(new.metric_definition_id, new.applies_to_session, new.applies_to_drill, false);
  perform training_load.source_metric_check_conversion(new.source_unit, new.target_unit, new.scale, new.scale_divisor, new."offset", false);
  perform training_load.source_metric_check_parameters(new.parameter_kind, rev.bound_operator, rev.source_bound_unit,
    new.source_parameters, new.canonical_parameters, mdv.condition_description,
    new.parameter_scale, new.parameter_scale_divisor, new.parameter_offset, true);
  -- Never the caller's value (C32).
  new.parameter_fingerprint := training_load.source_metric_parameter_fingerprint(new.parameter_kind, new.source_parameters);
  return new;
end;
$$ language plpgsql;

create function training_load.source_metric_mapping_versions_update_guard() returns trigger as $$
declare
  rev record;
  map record;
  md record;
  mdv record;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_mapping_versions: a mapping version is never deleted; disable it' using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.mapping_id is distinct from old.mapping_id
     or new.source_metric_definition_id is distinct from old.source_metric_definition_id
     or new.metric_definition_id is distinct from old.metric_definition_id or new.owner_key is distinct from old.owner_key
     or new.source_metric_version_id is distinct from old.source_metric_version_id or new.version_number is distinct from old.version_number
     or new.metric_definition_version_id is distinct from old.metric_definition_version_id
     or new.conversion_kind is distinct from old.conversion_kind
     or new.scale::text is distinct from old.scale::text or new.scale_divisor::text is distinct from old.scale_divisor::text
     or new."offset"::text is distinct from old."offset"::text or new.rounding_decimals is distinct from old.rounding_decimals
     or new.source_unit is distinct from old.source_unit or new.target_unit is distinct from old.target_unit
     or new.conversion_note is distinct from old.conversion_note or new.parameter_kind is distinct from old.parameter_kind
     or new.source_parameters::text is distinct from old.source_parameters::text
     or new.canonical_parameters::text is distinct from old.canonical_parameters::text
     or new.parameter_fingerprint is distinct from old.parameter_fingerprint
     or new.parameter_scale::text is distinct from old.parameter_scale::text
     or new.parameter_scale_divisor::text is distinct from old.parameter_scale_divisor::text
     or new.parameter_offset::text is distinct from old.parameter_offset::text
     or new.applies_to_session is distinct from old.applies_to_session or new.applies_to_drill is distinct from old.applies_to_drill
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at then
    raise exception 'source_metric_mapping_versions: only the status of a mapping version changes' using errcode = '23514';
  end if;
  -- Status facts are written once, by their own transition.
  if (old.submitted_at is not null and (new.submitted_by_user_id, new.submitted_at, new.submitted_basis)
        is distinct from (old.submitted_by_user_id, old.submitted_at, old.submitted_basis))
     or (old.activated_at is not null and (new.activated_by_user_id, new.activated_at, new.activated_basis)
        is distinct from (old.activated_by_user_id, old.activated_at, old.activated_basis))
     or (old.disabled_at is not null and (new.disabled_by_user_id, new.disabled_at, new.disabled_basis, new.disable_reason)
        is distinct from (old.disabled_by_user_id, old.disabled_at, old.disabled_basis, old.disable_reason)) then
    raise exception 'source_metric_mapping_versions: the status facts are written once' using errcode = '23514';
  end if;
  if new.status is not distinct from old.status then
    if (new.submitted_at, new.activated_at, new.disabled_at) is distinct from (old.submitted_at, old.activated_at, old.disabled_at) then
      raise exception 'source_metric_mapping_versions: the status facts are written by their transition' using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'needs_review' then
    select state into rev from training_load.source_metric_definition_versions where id = new.source_metric_version_id for share;
    if rev.state not in ('draft', 'active') then
      raise exception 'source_metric_mapping_versions: the source revision is retired' using errcode = '23514';
    end if;
    select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id for share;
    if new.submitted_basis = 'platform_admin' then
      perform training_load.source_metric_require_platform_admin(new.submitted_by_user_id);
    elsif new.submitted_basis = 'club_admin' and map.owner_scope = 'club' then
      perform training_load.source_metric_require_club_admin(new.submitted_by_user_id, map.owner_club_id);
    else
      raise exception 'source metric mapping: the acting user may not submit this mapping version' using errcode = '42501';
    end if;
  elsif old.status = 'needs_review' and new.status = 'active' then
    select state, evidence_status, bound_operator, source_bound_unit into rev
      from training_load.source_metric_definition_versions where id = new.source_metric_version_id for share;
    if rev.state is distinct from 'active' or rev.evidence_status is distinct from 'verified' then
      raise exception 'source_metric_mapping_versions: the source revision must be active and verified' using errcode = '23514';
    end if;
    perform 1 from training_load.source_metric_mappings where id = new.mapping_id for share;
    select state, current_version_id into md from training_load.metric_definitions where id = new.metric_definition_id for share;
    if md.state is distinct from 'active' or md.current_version_id is distinct from new.metric_definition_version_id then
      raise exception 'source_metric_mapping_versions: the canonical definition must be active with the pinned version current' using errcode = '23514';
    end if;
    select condition_description into mdv from training_load.metric_definition_versions where id = new.metric_definition_version_id;
    perform training_load.source_metric_check_parameters(new.parameter_kind, rev.bound_operator, rev.source_bound_unit,
      new.source_parameters, new.canonical_parameters, mdv.condition_description,
      new.parameter_scale, new.parameter_scale_divisor, new.parameter_offset, false);
    perform training_load.source_metric_check_levels(new.metric_definition_id, new.applies_to_session, new.applies_to_drill, true);
    perform training_load.source_metric_require_platform_admin(new.activated_by_user_id);
  elsif new.status = 'disabled' and old.status in ('draft', 'needs_review', 'active') then
    -- A transition writes only its own facts: disabling never adds a
    -- submission or an activation that did not happen.
    if (new.submitted_by_user_id, new.submitted_at, new.submitted_basis, new.activated_by_user_id, new.activated_at, new.activated_basis)
       is distinct from (old.submitted_by_user_id, old.submitted_at, old.submitted_basis, old.activated_by_user_id, old.activated_at, old.activated_basis) then
      raise exception 'source_metric_mapping_versions: the status facts are written by their transition' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_mapping_activations
                where mapping_version_id = old.id and ended_at is null) then
      raise exception 'source_metric_mapping_versions: a mapping version with an open activation is not disabled' using errcode = '23514';
    end if;
    perform training_load.source_metric_require_platform_admin(new.disabled_by_user_id);
  else
    raise exception 'source_metric_mapping_versions: this status transition is not allowed' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mapping_versions_insert_guard
  before insert on training_load.source_metric_mapping_versions
  for each row execute function training_load.source_metric_mapping_versions_insert_guard();
create trigger source_metric_mapping_versions_update_guard
  before update or delete on training_load.source_metric_mapping_versions
  for each row execute function training_load.source_metric_mapping_versions_update_guard();
create trigger source_metric_mapping_versions_no_truncate
  before truncate on training_load.source_metric_mapping_versions
  for each statement execute function training_load.source_metric_no_truncate();

-- Decision 9: no new canonical semantic version (and no archive) while an
-- active mapping version pins the current one. A plain read, never a lock:
-- the catalog writers lock metric_definitions first.
create function training_load.source_metric_guard_canonical_definition() returns trigger as $$
begin
  if (new.current_version_id is distinct from old.current_version_id or new.state is distinct from old.state)
     and exists (select 1 from training_load.source_metric_mapping_versions
                  where metric_definition_id = old.id and metric_definition_version_id = old.current_version_id and status = 'active') then
    raise exception 'metric_definitions: an active mapping version pins the current version; disable it first' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_definitions_source_metric_guard
  before update of current_version_id, state on training_load.metric_definitions
  for each row execute function training_load.source_metric_guard_canonical_definition();

-- Section E: a level an active mapping version applies to is not removed.
create function training_load.source_metric_guard_scope_capability() returns trigger as $$
begin
  if tg_op = 'UPDATE' and new.metric_definition_id is not distinct from old.metric_definition_id
     and new.scope_level is not distinct from old.scope_level then
    return new;
  end if;
  if exists (select 1 from training_load.source_metric_mapping_versions
              where metric_definition_id = old.metric_definition_id and status = 'active'
                and ((old.scope_level = 'session' and applies_to_session) or (old.scope_level = 'component' and applies_to_drill))) then
    raise exception 'metric_definition_scope_capabilities: an active mapping version applies to this level; disable it first' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_definition_scope_capabilities_source_metric_guard
  before update or delete on training_load.metric_definition_scope_capabilities
  for each row execute function training_load.source_metric_guard_scope_capability();

-- ---------------------------------------------------------------------------
-- D7. T5 source_metric_mapping_activations
-- ---------------------------------------------------------------------------
alter table training_load.source_team_bindings
  add constraint source_team_bindings_id_team_key unique (id, team_id);

create table training_load.source_metric_mapping_activations (
  id                           uuid primary key default gen_random_uuid(),
  mapping_version_id           uuid not null,
  mapping_id                   uuid not null,
  source_metric_definition_id  uuid not null,
  metric_definition_id         uuid not null,
  parameter_fingerprint        text not null,
  source_team_binding_id       uuid not null,
  team_id                      uuid not null,
  applies_to_session           boolean not null,
  applies_to_drill             boolean not null,
  -- No default (C23).
  requirement                  text not null
                                 constraint source_metric_activations_requirement_check check (requirement in ('required', 'optional')),
  activated_by_user_id         uuid not null references public.users(id) on delete restrict,
  activated_basis              text not null
                                 constraint source_metric_activations_activated_basis_check check (activated_basis = 'platform_admin'),
  activated_at                 timestamptz not null default now(),
  reason                       text not null
                                 constraint source_metric_activations_reason_check check (training_load.source_metric_text_ok(reason, 500)),
  ended_at                     timestamptz,
  ended_by_user_id             uuid references public.users(id) on delete restrict,
  ended_basis                  text
                                 constraint source_metric_activations_ended_basis_check check (ended_basis is null or ended_basis = 'platform_admin'),
  end_reason                   text
                                 constraint source_metric_activations_end_reason_check
                                 check (end_reason is null or end_reason in ('admin_ended', 'mapping_version_replaced', 'mapping_version_disabled')),
  constraint source_metric_activations_version_fk
    foreign key (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint)
    references training_load.source_metric_mapping_versions (id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint)
    on delete restrict,
  constraint source_metric_activations_binding_fk
    foreign key (source_team_binding_id, team_id)
    references training_load.source_team_bindings (id, team_id) on delete restrict,
  constraint source_metric_activations_levels_check check (applies_to_session or applies_to_drill),
  constraint source_metric_activations_ended_facts check (
    (ended_at is null) = (ended_by_user_id is null) and (ended_at is null) = (ended_basis is null)
    and (ended_at is null) = (end_reason is null)
  ),
  constraint source_metric_activations_provenance_anchor unique (id, mapping_version_id, source_team_binding_id)
);

-- On one binding: a source field with given parameters at most once, and a
-- canonical variable with at most one activated source per scope (D11.7).
create unique index source_metric_activations_one_open_per_field
  on training_load.source_metric_mapping_activations (source_team_binding_id, source_metric_definition_id, parameter_fingerprint)
  where ended_at is null;
create unique index source_metric_activations_one_open_session_target
  on training_load.source_metric_mapping_activations (source_team_binding_id, metric_definition_id)
  where ended_at is null and applies_to_session;
create unique index source_metric_activations_one_open_drill_target
  on training_load.source_metric_mapping_activations (source_team_binding_id, metric_definition_id)
  where ended_at is null and applies_to_drill;
create index source_metric_activations_open_version_idx
  on training_load.source_metric_mapping_activations (mapping_version_id) where ended_at is null;
create index source_metric_activations_binding_idx
  on training_load.source_metric_mapping_activations (source_team_binding_id);

comment on table training_load.source_metric_mapping_activations is
  'v34 (D7, T5): this team binding may import through exactly this mapping version, as required or optional. Written and ended only by a platform admin; never deleted; an Unbind never touches it.';

create function training_load.source_metric_activations_insert_guard() returns trigger as $$
declare
  ver record;
  def record;
  map record;
  bnd record;
  conn record;
begin
  if new.ended_at is not null or new.ended_by_user_id is not null or new.ended_basis is not null or new.end_reason is not null then
    raise exception 'source_metric_mapping_activations: an activation is created open' using errcode = '23514';
  end if;
  select status, applies_to_session, applies_to_drill into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id for share;
  if ver.status is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: only an active mapping version is activated' using errcode = '23514';
  end if;
  if new.applies_to_session is distinct from ver.applies_to_session or new.applies_to_drill is distinct from ver.applies_to_drill then
    raise exception 'source_metric_mapping_activations: the levels must be the mapping version''s' using errcode = '23514';
  end if;
  -- C42: an active source field (implied by the active version's chain; a backstop).
  select source_system, api_family, state into def
    from training_load.source_metric_definitions where id = new.source_metric_definition_id;
  if def.state is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: the source metric is retired' using errcode = '23514';
  end if;
  -- The owner comes from T3, never from the caller.
  select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id;
  -- v27 rows, plain reads (an Unbind is never inverted).
  select connection_id, team_id, source_system, state into bnd
    from training_load.source_team_bindings where id = new.source_team_binding_id;
  if bnd.state is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: the team binding is not active' using errcode = '23514';
  end if;
  if bnd.source_system is distinct from def.source_system then
    raise exception 'source_metric_mapping_activations: the binding''s source is not the source metric''s' using errcode = '23514';
  end if;
  select c.owner_scope, c.owner_club_id, c.owner_team_id, h.api_family into conn
    from training_load.source_credential_connections c
    join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
   where c.id = bnd.connection_id;
  if conn.api_family is distinct from def.api_family then
    raise exception 'source_metric_mapping_activations: the API family of the binding''s host is not the source metric''s' using errcode = '23514';
  end if;
  if map.owner_scope = 'club' then
    -- C35: a club mapping only on a connection owned by that club; never on a team-owned one.
    if conn.owner_scope is distinct from 'club' or conn.owner_club_id is distinct from map.owner_club_id then
      raise exception 'source_metric_mapping_activations: a club mapping is activated only on a binding of a connection owned by that club' using errcode = '23514';
    end if;
  elsif conn.owner_scope = 'team' and conn.owner_team_id is distinct from bnd.team_id then
    raise exception 'source_metric_mapping_activations: a team-owned connection hosts a system mapping only for its own team' using errcode = '23514';
  end if;
  perform training_load.source_metric_require_platform_admin(new.activated_by_user_id);
  return new;
end;
$$ language plpgsql;

create function training_load.source_metric_activations_update_guard() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_mapping_activations: an activation is never deleted; end it' using errcode = '23514';
  end if;
  if old.ended_at is not null then
    raise exception 'source_metric_mapping_activations: an ended activation is immutable' using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.mapping_version_id is distinct from old.mapping_version_id
     or new.mapping_id is distinct from old.mapping_id or new.source_metric_definition_id is distinct from old.source_metric_definition_id
     or new.metric_definition_id is distinct from old.metric_definition_id or new.parameter_fingerprint is distinct from old.parameter_fingerprint
     or new.source_team_binding_id is distinct from old.source_team_binding_id or new.team_id is distinct from old.team_id
     or new.applies_to_session is distinct from old.applies_to_session or new.applies_to_drill is distinct from old.applies_to_drill
     or new.requirement is distinct from old.requirement or new.activated_by_user_id is distinct from old.activated_by_user_id
     or new.activated_basis is distinct from old.activated_basis or new.activated_at is distinct from old.activated_at
     or new.reason is distinct from old.reason then
    raise exception 'source_metric_mapping_activations: only the end of an activation is written' using errcode = '23514';
  end if;
  if new.ended_at is not null then
    perform training_load.source_metric_require_platform_admin(new.ended_by_user_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_activations_insert_guard
  before insert on training_load.source_metric_mapping_activations
  for each row execute function training_load.source_metric_activations_insert_guard();
create trigger source_metric_activations_update_guard
  before update or delete on training_load.source_metric_mapping_activations
  for each row execute function training_load.source_metric_activations_update_guard();
create trigger source_metric_activations_no_truncate
  before truncate on training_load.source_metric_mapping_activations
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- D9. T7 - the write-once source instance on metric_source_connections
-- ---------------------------------------------------------------------------
alter table training_load.metric_source_connections
  add column source_host_key text
    constraint metric_source_connections_source_host_key_format
    check (source_host_key is null or source_host_key ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
  add column source_instance_key text
    constraint metric_source_connections_source_instance_key_format
    check (source_instance_key is null or source_instance_key ~ '^[A-Za-z0-9._:-]{1,64}$'),
  add constraint metric_source_connections_source_instance_together
    check ((source_host_key is null) = (source_instance_key is null));

-- One active Metrics Core instance per source team (C36: partial).
create unique index metric_source_connections_one_active_instance
  on training_load.metric_source_connections (source_system, source_host_key, source_instance_key)
  where state = 'active';

comment on column training_load.metric_source_connections.source_instance_key is
  'v34 (D9, T7): with source_host_key, the write-once identity of the source instance (for GPEXE the canonical Team ID). Set only from NULL; never a credential.';

create function training_load.metric_source_connections_instance_write_once() returns trigger as $$
begin
  if (old.source_host_key is not null or old.source_instance_key is not null)
     and (new.source_host_key is distinct from old.source_host_key or new.source_instance_key is distinct from old.source_instance_key) then
    raise exception 'metric_source_connections: the source instance of a connection is written once' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_source_connections_instance_write_once
  before update of source_host_key, source_instance_key on training_load.metric_source_connections
  for each row execute function training_load.metric_source_connections_instance_write_once();

-- ---------------------------------------------------------------------------
-- D8. T6 metric_value_source_provenance
-- ---------------------------------------------------------------------------
create table training_load.metric_value_source_provenance (
  metric_value_id              uuid primary key
                                 constraint metric_value_provenance_value_fk
                                 references training_load.metric_values(id) on delete restrict,
  activation_id                uuid not null,
  mapping_version_id           uuid not null,
  source_team_binding_id       uuid not null,
  mapping_id                   uuid not null,
  source_metric_version_id     uuid not null,
  metric_source_connection_id  uuid not null
                                 constraint metric_value_provenance_connection_fk
                                 references training_load.metric_source_connections(id) on delete restrict,
  source_unit                  text not null
                                 constraint metric_value_provenance_source_unit_token check (training_load.source_metric_unit_token_ok(source_unit)),
  source_value_numeric         numeric not null
                                 constraint metric_value_provenance_source_value_finite check (training_load.source_metric_numeric_finite(source_value_numeric)),
  recorded_at                  timestamptz not null default now(),
  constraint metric_value_provenance_activation_fk
    foreign key (activation_id, mapping_version_id, source_team_binding_id)
    references training_load.source_metric_mapping_activations (id, mapping_version_id, source_team_binding_id) on delete restrict,
  constraint metric_value_provenance_mapping_fk
    foreign key (mapping_version_id, mapping_id)
    references training_load.source_metric_mapping_versions (id, mapping_id) on delete restrict,
  constraint metric_value_provenance_revision_fk
    foreign key (mapping_version_id, source_metric_version_id)
    references training_load.source_metric_mapping_versions (id, source_metric_version_id) on delete restrict
);

create index metric_value_provenance_activation_idx
  on training_load.metric_value_source_provenance (activation_id);
create index metric_value_provenance_binding_idx
  on training_load.metric_value_source_provenance (source_team_binding_id);

comment on table training_load.metric_value_source_provenance is
  'v34 (D8, T6): every imported value names the activation, mapping version, source revision, binding and Metrics Core source instance that produced it, with the source value and unit. Append-only; read by no coach-facing reader; never raw JSON, a name or a credential.';

create function training_load.metric_value_provenance_insert_guard() returns trigger as $$
declare
  act record;
  ver record;
  rev_unit text;
  val record;
  bnd record;
  conn_host text;
  msc record;
  occasion_connection uuid;
begin
  -- C49: never a new fact through an ended activation. The row is held FOR
  -- SHARE, so an ending UPDATE either waits for this fact or lands first.
  select ended_at into act from training_load.source_metric_mapping_activations
   where id = new.activation_id and mapping_version_id = new.mapping_version_id
     and source_team_binding_id = new.source_team_binding_id for share;
  if not found then
    raise exception 'metric_value_source_provenance: the activation does not match the fact' using errcode = '23514';
  end if;
  if act.ended_at is not null then
    raise exception 'metric_value_source_provenance: a fact is never written through an ended activation' using errcode = '23514';
  end if;
  select mapping_id, source_metric_version_id, metric_definition_id, metric_definition_version_id, target_unit, source_unit,
         scale, scale_divisor, "offset" into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id;
  if ver.mapping_id is distinct from new.mapping_id or ver.source_metric_version_id is distinct from new.source_metric_version_id then
    raise exception 'metric_value_source_provenance: the fact must name its mapping version''s mapping and revision' using errcode = '23514';
  end if;
  select source_unit into rev_unit from training_load.source_metric_definition_versions where id = new.source_metric_version_id;
  if new.source_unit is distinct from rev_unit or new.source_unit is distinct from ver.source_unit then
    raise exception 'metric_value_source_provenance: the source unit must be the revision''s proven unit' using errcode = '23514';
  end if;
  select v.metric_definition_id, v.metric_definition_version_id, v.unit_at_capture, v.value_numeric, o.source_identity_id into val
    from training_load.metric_values v
    join training_load.metric_measurement_occasions o on o.id = v.occasion_id
   where v.id = new.metric_value_id;
  if not found then
    raise exception 'metric_value_source_provenance: the value does not exist' using errcode = '23514';
  end if;
  if val.metric_definition_id is distinct from ver.metric_definition_id
     or val.metric_definition_version_id is distinct from ver.metric_definition_version_id then
    raise exception 'metric_value_source_provenance: the value must be of the pinned canonical version' using errcode = '23514';
  end if;
  if val.unit_at_capture is distinct from ver.target_unit then
    raise exception 'metric_value_source_provenance: the value''s unit must be the mapping''s target unit' using errcode = '23514';
  end if;
  if val.value_numeric is null
     or not training_load.source_metric_value_matches(new.source_value_numeric, val.value_numeric, ver.scale, ver.scale_divisor, ver."offset") then
    raise exception 'metric_value_source_provenance: the value is not the source value converted at the storage scale' using errcode = '23514';
  end if;
  select source_system, source_team_id, connection_id into bnd
    from training_load.source_team_bindings where id = new.source_team_binding_id;
  select host_key into conn_host from training_load.source_credential_connections where id = bnd.connection_id;
  select source_system, source_host_key, source_instance_key into msc
    from training_load.metric_source_connections where id = new.metric_source_connection_id;
  if msc.source_system is distinct from bnd.source_system or msc.source_host_key is distinct from conn_host
     or msc.source_instance_key is distinct from bnd.source_team_id then
    raise exception 'metric_value_source_provenance: the Metrics Core source instance must be the binding''s' using errcode = '23514';
  end if;
  select source_connection_id into occasion_connection
    from training_load.metric_source_identities where id = val.source_identity_id;
  if occasion_connection is distinct from new.metric_source_connection_id then
    raise exception 'metric_value_source_provenance: the value''s occasion must come from the same source instance' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_value_provenance_insert_guard
  before insert on training_load.metric_value_source_provenance
  for each row execute function training_load.metric_value_provenance_insert_guard();
create trigger metric_value_source_provenance_append_only
  before update or delete on training_load.metric_value_source_provenance
  for each row execute function training_load.source_metric_append_only();
create trigger metric_value_provenance_no_truncate
  before truncate on training_load.metric_value_source_provenance
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- D10. T8 source_metric_audit
-- ---------------------------------------------------------------------------

-- One shape per action (C48). p_targets lists which of the eight target
-- columns are set, in the order source_metric_definition_id,
-- source_metric_version_id, mapping_id, mapping_version_id, activation_id,
-- unit_conversion_id, metric_source_connection_id, team_id ('1' = set).
create function training_load.source_metric_audit_row_ok(
  p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text) returns boolean
  language sql immutable as $$
    select coalesce(case p_action
      when 'source_metric_create' then
        p_targets = '10000000' and p_from is null and p_to = 'active' and p_basis = 'platform_admin'
      when 'source_metric_retire' then
        p_targets = '10000000' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_metric_revision_create' then
        p_targets = '11000000' and p_from is null and p_to = 'draft' and p_basis = 'platform_admin'
      when 'source_metric_unit_verified' then
        p_targets = '11000000' and p_from is null and p_to is null and p_evidence is not null and p_basis = 'platform_admin'
      when 'source_metric_meaning_verified' then
        p_targets = '11000000' and p_from is null and p_to is null and p_evidence is not null and p_basis = 'platform_admin'
      when 'source_metric_revision_activate' then
        p_targets = '11000000' and p_from = 'draft' and p_to = 'active' and p_basis = 'platform_admin'
      when 'source_metric_revision_retire' then
        p_targets = '11000000' and p_from in ('draft', 'active') and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'mapping_create' then
        p_targets = '00100000' and p_from is null and p_to is null and p_basis in ('platform_admin', 'club_admin')
      when 'mapping_version_create' then
        p_targets = '00110000' and p_from is null and p_to = 'draft' and p_basis in ('platform_admin', 'club_admin')
      when 'mapping_status' then
        p_targets = '00110000' and (
             (p_from = 'draft' and p_to = 'needs_review' and p_basis in ('platform_admin', 'club_admin'))
          or (p_from = 'needs_review' and p_to = 'active' and p_basis = 'platform_admin')
          or (p_from in ('draft', 'needs_review', 'active') and p_to = 'disabled' and p_reason is not null and p_basis = 'platform_admin'))
      when 'mapping_version_replaced' then
        p_targets = '00110000' and p_from = 'needs_review' and p_to = 'active' and p_reason is not null and p_basis = 'platform_admin'
      when 'activation_start' then
        p_targets = '00011001' and p_from is null and p_to is null and p_reason is not null and p_basis = 'platform_admin'
      when 'activation_end' then
        p_targets = '00011001' and p_from is null and p_to is null and p_basis = 'platform_admin'
      when 'unit_conversion_create' then
        p_targets = '00000100' and p_from is null and p_to = 'active' and p_evidence is not null and p_basis = 'platform_admin'
      when 'unit_conversion_retire' then
        p_targets = '00000100' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_instance_end' then
        p_targets in ('00000010', '00000011') and p_from = 'active' and p_to = 'inactive' and p_reason is not null and p_basis = 'platform_admin'
      else false end, false)
  $$;

create table training_load.source_metric_audit (
  id                           uuid primary key default gen_random_uuid(),
  action                       text not null
                                 constraint source_metric_audit_action_check check (action in (
                                   'source_metric_create', 'source_metric_revision_create', 'source_metric_unit_verified',
                                   'source_metric_meaning_verified', 'source_metric_revision_activate', 'source_metric_revision_retire',
                                   'source_metric_retire', 'mapping_create', 'mapping_version_create', 'mapping_status',
                                   'mapping_version_replaced', 'activation_start', 'activation_end', 'unit_conversion_create',
                                   'unit_conversion_retire', 'source_instance_end')),
  source_metric_definition_id  uuid references training_load.source_metric_definitions(id) on delete restrict,
  source_metric_version_id     uuid references training_load.source_metric_definition_versions(id) on delete restrict,
  mapping_id                   uuid references training_load.source_metric_mappings(id) on delete restrict,
  mapping_version_id           uuid references training_load.source_metric_mapping_versions(id) on delete restrict,
  activation_id                uuid references training_load.source_metric_mapping_activations(id) on delete restrict,
  unit_conversion_id           uuid references training_load.unit_conversions(id) on delete restrict,
  metric_source_connection_id  uuid references training_load.metric_source_connections(id) on delete restrict,
  team_id                      uuid references public.teams(id) on delete restrict,
  from_status                  text
                                 constraint source_metric_audit_from_status_check
                                 check (from_status is null or from_status in ('draft', 'needs_review', 'active', 'disabled', 'retired', 'inactive')),
  to_status                    text
                                 constraint source_metric_audit_to_status_check
                                 check (to_status is null or to_status in ('draft', 'needs_review', 'active', 'disabled', 'retired', 'inactive')),
  reason                       text
                                 constraint source_metric_audit_reason_check
                                 check (reason is null or training_load.source_metric_text_ok(reason, 500)),
  evidence_ref                 text
                                 constraint source_metric_audit_evidence_ref_check
                                 check (evidence_ref is null or training_load.source_metric_evidence_ref_ok(evidence_ref)),
  performed_by_user_id         uuid not null references public.users(id) on delete restrict,
  basis                        text not null
                                 constraint source_metric_audit_basis_check check (basis in ('platform_admin', 'club_admin')),
  performed_at                 timestamptz not null default now(),
  operation_id                 uuid not null,
  request_key                  uuid,
  request_hash                 text
                                 constraint source_metric_audit_request_hash_format
                                 check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'),
  constraint source_metric_audit_request_pair check ((request_key is null) = (request_hash is null)),
  constraint source_metric_audit_revision_fk
    foreign key (source_metric_version_id, source_metric_definition_id)
    references training_load.source_metric_definition_versions (id, source_metric_definition_id) on delete restrict,
  constraint source_metric_audit_version_fk
    foreign key (mapping_version_id, mapping_id)
    references training_load.source_metric_mapping_versions (id, mapping_id) on delete restrict,
  constraint source_metric_audit_action_shape check (training_load.source_metric_audit_row_ok(
    action,
    (case when source_metric_definition_id is null then '0' else '1' end)
      || (case when source_metric_version_id is null then '0' else '1' end)
      || (case when mapping_id is null then '0' else '1' end)
      || (case when mapping_version_id is null then '0' else '1' end)
      || (case when activation_id is null then '0' else '1' end)
      || (case when unit_conversion_id is null then '0' else '1' end)
      || (case when metric_source_connection_id is null then '0' else '1' end)
      || (case when team_id is null then '0' else '1' end),
    from_status, to_status, reason, evidence_ref, basis))
);

-- A replay finds one row; a second body on the same key is request_key_reused.
create unique index source_metric_audit_one_request_per_key
  on training_load.source_metric_audit (performed_by_user_id, request_key) where request_key is not null;
-- One operation has exactly one request record.
create unique index source_metric_audit_one_request_per_operation
  on training_load.source_metric_audit (operation_id) where request_key is not null;
create index source_metric_audit_operation_idx
  on training_load.source_metric_audit (operation_id);

comment on table training_load.source_metric_audit is
  'v34 (D10, T8): append-only record of every source metric, mapping, activation, unit conversion and source instance operation. No metadata column; reason and evidence_ref are bounded, format-checked and never name an athlete or carry a value.';

-- An activation row names its own mapping version and team; a club-admin
-- row names a club-owned mapping (C45: the club-admin basis only where D / G
-- allow it). Plain reads.
create function training_load.source_metric_audit_insert_guard() returns trigger as $$
begin
  if new.basis = 'club_admin' and not exists (
       select 1 from training_load.source_metric_mappings where id = new.mapping_id and owner_scope = 'club') then
    raise exception 'source_metric_audit: a club-admin row names a club mapping' using errcode = '23514';
  end if;
  if new.activation_id is not null and not exists (
       select 1 from training_load.source_metric_mapping_activations
        where id = new.activation_id and mapping_version_id = new.mapping_version_id and team_id = new.team_id) then
    raise exception 'source_metric_audit: an activation row must name its own mapping version and team' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_audit_insert_guard
  before insert on training_load.source_metric_audit
  for each row execute function training_load.source_metric_audit_insert_guard();
create trigger source_metric_audit_append_only
  before update or delete on training_load.source_metric_audit
  for each row execute function training_load.source_metric_append_only();
create trigger source_metric_audit_no_truncate
  before truncate on training_load.source_metric_audit
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- D12. Seed (data only). Observed source fields of gpexe / rest_v1 with NO
-- unit and NO operator; expected units are the e03 pilot's hypothesis. No
-- mapping, version, activation, canonical definition or audit row.
-- ---------------------------------------------------------------------------
insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, seed_migration)
values
  ('gpexe', 'rest_v1', 'athlete_session.total_time', 'TIME', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'athlete_session.total_distance', 'TotDist', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'athlete_session.max_v', 'SPEEDmax', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'more.complementary_data.power.distance', 'Power zone distance', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'more.complementary_data.speed.distance', 'Speed zone distance', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'more.events.acceleration_events_count', 'Acceleration events', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'more.events.deceleration_events_count', 'Deceleration events', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'details.players.tot_burst_events', 'Burst events', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('gpexe', 'rest_v1', 'details.players.tot_brake_events', 'Brake events', 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql');

insert into training_load.source_metric_definition_versions
  (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill,
   expected_source_unit, expected_source_bound_unit, unit_note, evidence_status, evidence_ref, state, activated_at, seed_migration)
select d.id, 1, s.value_shape, s.parameter_kind, true, true, s.expected_unit, s.expected_bound_unit, s.unit_note,
       'observed', 'docs/ai/gpexe-rest-v1-compatibility.md#2-the-table', 'active', now(),
       'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'
  from (values
    ('athlete_session.total_time', 'number', 'none', 's', null,
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3.'),
    ('athlete_session.total_distance', 'number', 'none', 'm', null,
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3.'),
    ('athlete_session.max_v', 'number', 'none', 'm/s', null,
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3.'),
    ('more.complementary_data.power.distance', 'zone_distance', 'zone_bounds', 'm', 'W/kg',
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3.'),
    ('more.complementary_data.speed.distance', 'zone_distance', 'zone_bounds', 'm', 'm/s',
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3.'),
    ('more.events.acceleration_events_count', 'event_count', 'event_threshold', 'count', null,
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3.'),
    ('more.events.deceleration_events_count', 'event_count', 'event_threshold', 'count', null,
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3.'),
    ('details.players.tot_burst_events', 'unit_value_object', 'none', 'count', null,
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3. The observed unit "number" is a shape; the meaning is unconfirmed.'),
    ('details.players.tot_brake_events', 'unit_value_object', 'none', 'count', null,
     'Expected unit is a hypothesis from the e03 pilot; not proven on server3. The observed unit "number" is a shape; the meaning is unconfirmed.')
  ) as s (source_metric_key, value_shape, parameter_kind, expected_unit, expected_bound_unit, unit_note)
  join training_load.source_metric_definitions d
    on d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.source_metric_key = s.source_metric_key;

insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", evidence_ref, seed_migration)
values
  ('s', 'min', 1, 60, 0, 'docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed',
   'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('m/s', 'km/h', 3.6, 1, 0, 'docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed',
   'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('m', 'km', 0.001, 1, 0, 'docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed',
   'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'),
  ('km/h', 'm/s', 1, 3.6, 0, 'docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed',
   'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql');
