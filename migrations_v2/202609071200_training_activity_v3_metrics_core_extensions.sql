-- ============================================================
-- OPTIMOVE — Training Activity Identity Core v3: additive Metrics Core
-- (training_load.metric_*) extensions needed by the canonical Training
-- Activity read contract (v4).
--
-- Purely additive over the real, already-deployed v10-v13 Metrics Core
-- migrations — no existing table, column, or trigger from those files is
-- altered or dropped. Proven safe to apply as an UPGRADE over a database
-- that already holds real metric_values/metric_measurement_occasions
-- history (not just a fresh empty schema) before being written as this
-- migration: existing values keep their meaning, existing
-- import-correction chains keep working, and the scope-capability
-- backfill below only ever derives from real, observed history — it
-- never guesses.
-- ============================================================

-- Lets ONE metric_definition explicitly declare it may legitimately be
-- captured at more than one level (e.g. "Distance" at both session and
-- component level) — required by check_metric_value_scope_capability
-- below, which refuses an insert at any level a definition hasn't
-- declared.
create table training_load.metric_definition_scope_capabilities (
  metric_definition_id uuid not null references training_load.metric_definitions(id),
  scope_level varchar(20) not null check (scope_level in ('session', 'component', 'day')),
  primary key (metric_definition_id, scope_level)
);

-- An UPGRADE run of this file (applied over a database that already has
-- real, pre-existing training_load.metric_values rows) must not leave
-- every existing metric_definition with zero scope_capability rows: the
-- very next INSERT into metric_values for that same definition would then
-- be rejected by check_metric_value_scope_capability below, even though
-- that definition has been recording values at this exact scope for a
-- long time. This backfill derives capability rows ONLY from what already
-- really happened — the OBSERVED scope of each definition's own existing
-- occasions (same day/segment-presence logic as
-- check_metric_value_scope_capability's own v_scope_level below) — never
-- a guess. A definition with values at more than one real scope correctly
-- gets more than one row; a definition with NO existing values gets NONE
-- (there is nothing to derive from) and is left for a future Metric
-- Library to configure explicitly. On a fresh (non-upgrade) database,
-- training_load.metric_values is still empty at this point in the
-- script, so this is a harmless no-op.
insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level)
select distinct v.metric_definition_id,
  case when e.scope_level = 'day' then 'day' when o.segment_id is not null then 'component' else 'session' end
from training_load.metric_values v
join training_load.metric_measurement_occasions o on o.id = v.occasion_id
join training_load.metric_event_participants p on p.id = o.event_participant_id
join training_load.metric_events e on e.id = p.event_id
on conflict do nothing;

-- A capability may never be removed once real historical values exist at
-- that scope for that definition — doing so would silently strand
-- existing metric_values under a scope the definition no longer admits
-- (they'd stay readable, since this only guards INSERT, but the
-- definition's own configured shape would then lie about its own
-- history). The application layer (trainingLoadMetricsCatalog.js) is
-- expected to prevent this from ever being attempted in the first place;
-- this trigger is the LAST, unconditional line of defense regardless of
-- what removed the row.
create function training_load.protect_scope_capability_with_history() returns trigger as $$
declare
  v_has_history boolean;
begin
  select exists (
    select 1
    from training_load.metric_values v
    join training_load.metric_measurement_occasions o on o.id = v.occasion_id
    join training_load.metric_event_participants p on p.id = o.event_participant_id
    join training_load.metric_events e on e.id = p.event_id
    where v.metric_definition_id = old.metric_definition_id
      and (case when e.scope_level = 'day' then 'day' when o.segment_id is not null then 'component' else 'session' end) = old.scope_level
  ) into v_has_history;
  if v_has_history then
    raise exception 'metric_definition_scope_capabilities: cannot remove scope ''%'' for definition % — real historical values already exist at that scope', old.scope_level, old.metric_definition_id;
  end if;
  return old;
end;
$$ language plpgsql;
create trigger metric_definition_scope_capabilities_protect_history
  before delete on training_load.metric_definition_scope_capabilities
  for each row execute function training_load.protect_scope_capability_with_history();

-- Three orthogonal dimensions on each metric_values row:
--   aggregation_role — is this value a standalone/direct observation, a
--     rollup ASSEMBLED FROM this source's own components
--     ('source_rollup'), or a rollup DERIVED by some downstream
--     computation ('derived_rollup')? This is what stops a session total
--     and a component breakdown from ever being silently summed as if
--     they were the same kind of number. A WHOLE-SESSION TOTAL reported
--     directly BY THE SOURCE device/system is 'source_rollup', not
--     'standalone' — it is semantically a rollup of that source's own
--     internal finer-grained measurement even though we never see the
--     finer grain ourselves, and its coverage is 'complete' by definition
--     (it IS the source's own total over its own window). A raw
--     per-SEGMENT value reported directly by the source (e.g. "Half 1
--     distance") IS 'standalone' — an atomic fact, not itself a rollup of
--     anything smaller in this model.
--   coverage — does this rollup represent the COMPLETE set of known
--     components, only PARTIAL coverage (e.g. a device dropout), or is
--     that simply UNKNOWN. A standalone value has no coverage concept —
--     always 'not_applicable'.
--   computed_by_ref — already exists on the real v13 metric_values table;
--     kept entirely separate from entry_method (already on the occasion —
--     manual/api_import/csv_import) and is_derived (already on
--     metric_values) so "how was this captured" and "what kind of number
--     is this" and "who/what computed it" are three independent facts,
--     never conflated into one.
--
-- metric_values is append-only (see the real
-- training_load.forbid_update_delete trigger already active on it) — every
-- column below must be set at INSERT time, never via a later UPDATE.
-- aggregation_role/coverage must agree with each other, and a
-- derived_rollup requires BOTH is_derived=true AND a non-null
-- computed_by_ref.
-- Columns first, with only their own simple domain CHECKs (the enum
-- shape) — a constant-default ALTER ADD COLUMN is metadata-only in PG11+,
-- safe regardless of table size, on both a fresh install and an upgrade.
alter table training_load.metric_values
  add column aggregation_role varchar(20) not null default 'standalone'
    check (aggregation_role in ('standalone', 'source_rollup', 'derived_rollup')),
  add column coverage varchar(20) not null default 'not_applicable'
    check (coverage in ('complete', 'partial', 'unknown', 'not_applicable'));

-- Round 4 upgrade-safety fix: the blanket 'standalone' default above is
-- WRONG for any pre-existing row that already has is_derived=true and a
-- non-null computed_by_ref — a real, already-recorded derived/computed
-- value from before this migration ever existed. The
-- metric_values_computed_by_ref_requires_derived constraint added below
-- requires aggregation_role='derived_rollup' whenever computed_by_ref is
-- set, so an UPGRADE run over real data of this shape would otherwise
-- fail validating that constraint. This backfill derives the CORRECT role
-- for exactly those rows before the constraint is ever added — never a
-- guess for anything else (a plain legacy row with is_derived=false, or
-- is_derived=true with no computed_by_ref, correctly keeps the
-- 'standalone' default). coverage is set to 'unknown', never 'complete'
-- — there is no way to determine actual historical coverage
-- retroactively for data that predates this column existing at all.
--
-- metric_values is append-only (training_load.forbid_update_delete,
-- applied by the real, already-deployed v10/v13 migrations) — this UPDATE
-- is the one narrow, transactional exception this migration needs: the
-- immutability trigger is disabled for exactly this single backfill
-- statement and unconditionally re-enabled immediately after, both inside
-- this same migration's own transaction. No business value column
-- (value_numeric/value_boolean/value_text/unit_at_capture/...) is ever
-- touched here — only the two brand-new columns this same migration just
-- added above, which no reader could have depended on before this file
-- ever ran.
alter table training_load.metric_values disable trigger metric_values_immutable;
update training_load.metric_values
  set aggregation_role = 'derived_rollup', coverage = 'unknown'
  where is_derived = true and computed_by_ref is not null;
alter table training_load.metric_values enable trigger metric_values_immutable;

alter table training_load.metric_values
  add constraint metric_values_computed_by_ref_requires_derived
    check (computed_by_ref is null or aggregation_role = 'derived_rollup'),
  add constraint metric_values_derived_rollup_requires_provenance
    check (aggregation_role <> 'derived_rollup' or (is_derived = true and computed_by_ref is not null)),
  add constraint metric_values_aggregation_coverage_consistency
    check (
      (aggregation_role = 'standalone' and coverage = 'not_applicable') or
      (aggregation_role in ('source_rollup', 'derived_rollup') and coverage in ('complete', 'partial', 'unknown'))
    );

-- A group activity's own timezone must never be guessed from a
-- participant's personal device timezone (see the metric-event group
-- materializer in v4). This column lets a connector/manual import record
-- the SESSION's own known place/time context directly on the event,
-- provider-neutral (no vendor-specific columns).
alter table training_load.metric_events
  add column event_timezone_snapshot text;

-- event_timezone_snapshot is added AFTER the real v12
-- protect_event_identity_once_measured() trigger was already defined, so
-- that trigger's own "identity fields are immutable once measured" list —
-- fixed at the moment it was written, before this column existed — does
-- not, and structurally cannot retroactively, cover it. Closed with this
-- column's own dedicated trigger instead of touching the real trigger's
-- body:
--   * NULL -> a real, validated, non-blank IANA zone may be set exactly
--     once;
--   * once non-null, WRITE-ONCE — no correction, no re-guess, ever;
--   * once a CONFIRMED activity_metric_event_links row exists for this
--     event, no change at all is permitted (including the very first
--     NULL -> value write, closing the gap where a raw insert could
--     bypass materialize_activity_group_from_metric_event()'s (v4) own
--     pre-materialization requirement that the timezone already be set);
--   * validated as a real timezone Postgres itself recognizes (`... AT
--     TIME ZONE`), not merely "any non-empty string";
--   * whenever BOTH occurred_instant and event_timezone_snapshot are
--     known (in either order — this fires on every INSERT/UPDATE touching
--     any of the three columns), occurred_date must be the date of that
--     instant IN the event's own zone — never an independently-entered,
--     possibly-inconsistent date.
create function training_load.protect_event_timezone_snapshot() returns trigger as $$
declare
  v_has_confirmed_link boolean;
begin
  if tg_op = 'UPDATE' and new.event_timezone_snapshot is distinct from old.event_timezone_snapshot then
    if old.event_timezone_snapshot is not null then
      raise exception 'metric_events (id=%): event_timezone_snapshot is write-once once set', old.id;
    end if;
    if new.event_timezone_snapshot is not null then
      select exists (
        select 1 from training.activity_metric_event_links where metric_event_id = old.id and link_status = 'confirmed'
      ) into v_has_confirmed_link;
      if v_has_confirmed_link then
        raise exception 'metric_events (id=%): cannot set event_timezone_snapshot once a CONFIRMED activity link already exists', old.id;
      end if;
    end if;
  end if;

  if new.event_timezone_snapshot is not null then
    if btrim(new.event_timezone_snapshot) = '' then
      raise exception 'metric_events (id=%): event_timezone_snapshot cannot be blank', coalesce(new.id, old.id);
    end if;
    begin
      perform now() at time zone new.event_timezone_snapshot;
    exception when others then
      raise exception 'metric_events (id=%): "%" is not a timezone Postgres recognizes', coalesce(new.id, old.id), new.event_timezone_snapshot;
    end;
  end if;

  if new.occurred_instant is not null and new.event_timezone_snapshot is not null
     and new.occurred_date is distinct from (new.occurred_instant at time zone new.event_timezone_snapshot)::date then
    raise exception 'metric_events (id=%): occurred_date (%) does not match occurred_instant (%) converted into event_timezone_snapshot (%)',
      coalesce(new.id, old.id), new.occurred_date, new.occurred_instant, new.event_timezone_snapshot;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger metric_events_protect_timezone_snapshot
  before insert or update on training_load.metric_events
  for each row execute function training_load.protect_event_timezone_snapshot();

-- The actual VALUE's own scope must have been explicitly declared allowed
-- via metric_definition_scope_capabilities for that metric_definition —
-- never merely assumed. A day-level metric_event (scope_level='day':
-- sleep, recovery, resting HR, ...) is ALWAYS 'day' regardless of
-- segment_id (day events are not expected to carry segments at all, but
-- the event's own scope_level wins if one somehow did); only a
-- SESSION-level event's own value is 'session' (no segment) or
-- 'component' (segment present). A component-scope value additionally
-- requires its segment to ALREADY carry a CONFIRMED
-- activity_component_metric_segment_links row (v2) — a component-scope
-- number with no confirmed component/segment context to anchor it is
-- refused outright, at INSERT time (the only time this append-only table
-- accepts a write at all).
create function training_load.check_metric_value_scope_capability() returns trigger as $$
declare
  v_segment_id uuid;
  v_event_scope_level varchar;
  v_scope_level varchar;
  v_allowed boolean;
  v_component_linked boolean;
begin
  -- Compatible lock, taken BEFORE reading capabilities below — the
  -- app-layer write paths already take this same `FOR KEY SHARE` lock
  -- earlier in their own transaction (see lockDefinitionsForKeyShare in
  -- trainingLoadMetricsMeasurements.js), but this trigger fires on
  -- EVERY insert into metric_values regardless of caller, so it is the
  -- one place that protects a future or raw write path that never went
  -- through that app-layer lock. `FOR KEY SHARE` conflicts with the
  -- `FOR UPDATE` setDefinitionScopeCapabilities takes on the same
  -- metric_definitions row (and only with that — it does not conflict
  -- with itself), so a capability removal and a value insert against
  -- the SAME definition always serialize through this one lock,
  -- regardless of which side got here first.
  perform 1 from training_load.metric_definitions where id = new.metric_definition_id for key share;

  select o.segment_id, e.scope_level into v_segment_id, v_event_scope_level
    from training_load.metric_measurement_occasions o
    join training_load.metric_event_participants p on p.id = o.event_participant_id
    join training_load.metric_events e on e.id = p.event_id
    where o.id = new.occasion_id;
  v_scope_level := case
    when v_event_scope_level = 'day' then 'day'
    when v_segment_id is not null then 'component'
    else 'session'
  end;

  -- Unconditional — a definition with ZERO declared capability rows is
  -- rejected exactly like one with the WRONG capability declared. This
  -- is deliberately the LAST strict line of defense regardless of
  -- caller: the application layer (trainingLoadMetricsCatalog.js /
  -- trainingLoadMetricsMeasurements.js) is expected to check this
  -- proactively and return a clean, actionable 409
  -- (`scopeCapabilitiesRequired`) before ever attempting the insert —
  -- see that layer's own comments — but this trigger must still catch
  -- anything that reaches metric_values by any other path.
  select exists (
    select 1 from training_load.metric_definition_scope_capabilities
    where metric_definition_id = new.metric_definition_id and scope_level = v_scope_level
  ) into v_allowed;
  if not v_allowed then
    raise exception 'metric_values: metric_definition % has no declared scope_capability for level ''%''', new.metric_definition_id, v_scope_level;
  end if;

  if v_scope_level = 'component' then
    select exists (
      select 1 from training.activity_component_metric_segment_links
      where metric_event_segment_id = v_segment_id and link_status = 'confirmed'
    ) into v_component_linked;
    if not v_component_linked then
      raise exception 'metric_values: a component-scope value requires its segment (%) to already have a CONFIRMED activity_component_metric_segment_links row', v_segment_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger metric_values_check_scope_capability
  before insert on training_load.metric_values
  for each row execute function training_load.check_metric_value_scope_capability();

-- Round 4 fix: training_load.metric_write_requests (already deployed,
-- real v13 migration) had no length bound on its own request_key —
-- additive over that real, deployed table, exactly like the rest of this
-- file's own extensions. Same reasonable bound as training.
-- activity_write_requests.request_key (v1, this branch's own table) and
-- this app's other free-text identifier fields.
--
-- Round 5 upgrade-safety fix: a plain `ADD CONSTRAINT ... CHECK (...)`
-- validates EVERY existing row as part of the ALTER TABLE itself — this
-- table is real and already deployed, so a single historical request_key
-- longer than 200 characters (written before this bound ever existed)
-- would make the whole migration fail on a real production upgrade.
-- `NOT VALID` skips that initial scan of existing rows (an old,
-- over-length historical key is grandfathered in, left exactly as-is —
-- never truncated, rewritten, or deleted) while the constraint is still
-- fully enforced against every NEW insert/update from this point forward
-- — Postgres's own documented behavior for NOT VALID constraints,
-- not a partial or best-effort check. training.activity_write_requests
-- (below/v1) is a brand-new table on this branch with no legacy data, so
-- its own CHECK stays a normal, immediately-validated constraint.
alter table training_load.metric_write_requests
  add constraint metric_write_requests_request_key_length check (length(request_key) <= 200) not valid;
