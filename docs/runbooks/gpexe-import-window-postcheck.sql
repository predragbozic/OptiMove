-- GPEXE import window, step 16: the post-import check - READ ONLY.
-- Contract docs/ai/phase9-importer-mappings-contract.md, section 10.3 step 16
-- (prepared in 9-R, section 10.4). It runs after the one approval (step 14)
-- and after the switch is off again (step 15). The freeze ends when it passes.
-- The pre-switch preflight of step 11 is
-- docs/runbooks/gpexe-import-window-preflight.sql.
--
-- How it runs: ONE numbered block per call, sent exactly as
--   begin transaction read only;
--   <the block, verbatim from this file>
--   rollback;
-- (docs/ai/metrics-core-plan.md, "Standing order for migration PRs", point 5,
-- the connector rule; contract section 10.3 step 16 applies it here). Every
-- block is one plain SELECT: it writes nothing, takes no row lock and needs no
-- parameter. The record names the sha256 of this whole file.
--
-- Any value other than the expected one: stop, change nothing, report the
-- block, the column and the value. No production undo is sanctioned: the
-- owner decides (O3).
--
-- Checked outside this file: the approval read
-- GET /api/training-load/gpexe/teams/:teamId/approvals/:approvalId (block 3
-- shows the same row), and the served commit through /api/health.
--
-- The approval is found without an id: step 11's block 8 showed no approval
-- anywhere, so the one approval of step 14 is the only row of the append-only
-- approvals table. Run block 3 first: every later block reads that row only
-- while exactly one approval exists, and shows no row or zeros otherwise.
--
-- Pinned to main as written: block 1 names v51
-- (202611011900_calendar_v51_settings.sql) and its checksum, and the expected
-- values follow the three pilot mappings decided under O6. If main carries a
-- later migration, or the decided mappings change, this file is re-issued
-- under a new sha256 together with the preflight, before step 11.
--
-- On production the expected numbers come from step 8's preview of GPEXE
-- session 190122: 39 results (13 athletes, each the whole session and two
-- drills), 117 values, no value left out. The blocks also compare every
-- number with the approved preview itself.

-- 1. The migrations: unchanged since step 11 (the switch's two deploys run
--    the same commit).
--    Expected: v51_rows = 1, v51_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202611011900_calendar_v51_settings.sql.
--    v2_rows is shown only (the same number as in step 11).
select
  (select count(*) from public.schema_migrations
    where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_rows,
  (select bool_and(checksum = 'b727cb0f74bb8bc41ee816c33995f1ab3df721ebac7bf77b861fd9e9b9f38cff')
     from public.schema_migrations
    where migration_name = 'migrations_v2/202611011900_calendar_v51_settings.sql') as v51_checksum_ok,
  (select count(*) from public.schema_migrations
    where starts_with(migration_name, 'migrations_v2/')
      and migration_name collate "C" > 'migrations_v2/202611011900_calendar_v51_settings.sql') as later_rows,
  (select migration_name from public.schema_migrations
    where starts_with(migration_name, 'migrations_v2/')
    order by migration_name collate "C" desc limit 1) as last_migration,
  (select count(*) from public.schema_migrations
    where starts_with(migration_name, 'migrations_v2/')) as v2_rows;

-- 2. Nothing runs, and no check of the team started since the approval (a
--    later check would move the candidate's last sighting).
--    Expected: approvals_total = 1, running_checks = 0,
--    running_identity_loads = 0, team_checks_since_approval = 0.
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
)
select
  (select count(*) from training_load.gpexe_import_approvals) as approvals_total,
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads,
  (select count(*) from training_load.gpexe_import_checks k
     join ap on ap.owner_team_id = k.owner_team_id
    where k.started_at >= ap.approved_at) as team_checks_since_approval;

-- 3. The approval, and that it belongs to the First team (the one active
--    GPEXE binding that holds an open mapping activation).
--    Expected: approvals_total = 1, first_team_bindings = 1,
--    approval_of_the_first_team = true, bound_to = 980 @ server3,
--    open_activations = 3, requirements = required,
--    approval_basis = platform_admin (team_grant if a granted coach approved,
--    and then no_grant = false), changes_to_imported = 0,
--    changes_accepted = false, results_imported = the preview's results
--    (39 on production), import_count_keys = created,
--    import_ids_recorded = true, and approved_by_user_id a user_id of step
--    11's block 11 (or of its block 12 when approval_basis = team_grant).
--    approval_id, approved_by_name and approved_utc are shown only: the id and
--    the time are what the HTTP approval read shows; a null name is matched
--    by approved_by_user_id.
with bound as (
  select b.id as binding_id, b.team_id, b.source_team_id, c.host_key
    from training_load.source_team_bindings b
    join training_load.source_credential_connections c on c.id = b.connection_id
   where b.source_system = 'gpexe' and b.state = 'active'
     and exists (select 1 from training_load.source_metric_mapping_activations a
                  where a.source_team_binding_id = b.id and a.ended_at is null)
),
ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
)
select
  (select count(*) from training_load.gpexe_import_approvals) as approvals_total,
  (select count(*) from bound) as first_team_bindings,
  ((select count(*) from bound) = 1 and exists (select 1 from ap join bound on bound.team_id = ap.owner_team_id)) as approval_of_the_first_team,
  (select string_agg(source_team_id || ' @ ' || host_key, ', ') from bound) as bound_to,
  (select count(*) from training_load.source_metric_mapping_activations a
     join bound on bound.binding_id = a.source_team_binding_id
    where a.ended_at is null) as open_activations,
  (select string_agg(distinct a.requirement, ', ') from training_load.source_metric_mapping_activations a
     join bound on bound.binding_id = a.source_team_binding_id
    where a.ended_at is null) as requirements,
  (select id from ap) as approval_id,
  (select approved_by_user_id from ap) as approved_by_user_id,
  (select coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), ''))
     from ap join public.users u on u.id = ap.approved_by_user_id) as approved_by_name,
  (select to_char(approved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') from ap) as approved_utc,
  (select approval_basis from ap) as approval_basis,
  (select approver_grant_id is null from ap) as no_grant,
  (select changes_to_imported from ap) as changes_to_imported,
  (select changes_accepted from ap) as changes_accepted,
  (select (import_counts ->> 'created')::int from ap) as results_imported,
  (select string_agg(k, ', ' order by k) from ap, jsonb_object_keys(ap.import_counts) as keys_t(k)) as import_count_keys,
  (select metric_event_id is not null and activity_id is not null and import_batch_id is not null from ap) as import_ids_recorded;

-- 4. The candidate imported in the approval, the approved preview kept, and
--    no other candidate imported anywhere.
--    Expected: candidate_status = imported, imported_in_the_approval = true,
--    same_content = true, stored_preview_is_the_approved_one = true,
--    preview_version = 3, preview_status = ready,
--    drill_parameter_effect = confirmed or not_required,
--    imported_candidates_total = 1, other_imported_candidates = 0.
--    gpexe_session_id is shown only (190122 on production).
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
)
select c.gpexe_team_session_id as gpexe_session_id,
       c.status as candidate_status,
       (c.imported_at = ap.approved_at) as imported_in_the_approval,
       (c.owner_team_id = ap.owner_team_id and c.gpexe_team_session_id = ap.gpexe_team_session_id
        and c.bundle_hash = ap.bundle_hash) as same_content,
       (c.preview_hash = ap.preview_hash) as stored_preview_is_the_approved_one,
       c.preview ->> 'version' as preview_version,
       c.preview ->> 'status' as preview_status,
       c.drill_parameter_effect,
       (select count(*) from training_load.gpexe_import_candidates x where x.status = 'imported') as imported_candidates_total,
       (select count(*) from training_load.gpexe_import_candidates x
         where (x.status = 'imported' or x.imported_at is not null) and x.id <> ap.candidate_id) as other_imported_candidates
  from ap
  join training_load.gpexe_import_candidates c on c.id = ap.candidate_id;

-- 5. The counts equal the approved preview. A result is one athlete at one
--    level (the whole session or one drill), and one occasion. A value is one
--    variable of one result.
--    Expected: preview_results = approval_results = preview_results_created
--    = batch_occasions = event_occasions (39 on production);
--    preview_values = written_values = event_values = t6_rows_of_the_import
--    = t6_rows_total (117 on production); preview_left_out = preview_left_out_entries (0 on
--    production); imported_athletes = event_participants (13 on production);
--    preview_changes_to_imported = 0.
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
),
c as (
  select x.* from training_load.gpexe_import_candidates x join ap on ap.candidate_id = x.id
),
res as (
  select ath.a, rs.r
    from c,
         jsonb_array_elements(c.preview -> 'athletes') as ath(a),
         jsonb_array_elements(ath.a -> 'results') as rs(r)
),
occ as (
  select o.id from training_load.metric_measurement_occasions o join ap on o.import_batch_id = ap.import_batch_id
),
val as (
  select v.id from training_load.metric_values v join occ on occ.id = v.occasion_id
)
select
  (select (c.preview -> 'counts' ->> 'created')::int from c) as preview_results,
  (select (ap.import_counts ->> 'created')::int from ap) as approval_results,
  (select count(*) from res where res.r ->> 'outcome' = 'created') as preview_results_created,
  (select count(*) from occ) as batch_occasions,
  (select count(*) from training_load.metric_measurement_occasions o
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join ap on p.event_id = ap.metric_event_id) as event_occasions,
  (select count(*) from res, jsonb_array_elements(res.r -> 'values') as vs(e)
    where res.r ->> 'outcome' = 'created' and vs.e ->> 'value' is not null) as preview_values,
  (select count(*) from val) as written_values,
  (select count(*) from training_load.metric_values v
     join training_load.metric_measurement_occasions o on o.id = v.occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join ap on p.event_id = ap.metric_event_id) as event_values,
  (select count(*) from training_load.metric_value_source_provenance p join val on val.id = p.metric_value_id) as t6_rows_of_the_import,
  (select count(*) from training_load.metric_value_source_provenance) as t6_rows_total,
  (select (c.preview -> 'counts' ->> 'skippedValues')::int from c) as preview_left_out,
  (select count(*) from c, jsonb_array_elements(c.preview -> 'athletes') as ath(a),
          jsonb_array_elements(ath.a -> 'skippedValues') as lo(s)) as preview_left_out_entries,
  (select count(*) from c, jsonb_array_elements(c.preview -> 'athletes') as ath(a)
    where ath.a ->> 'notImported' is null) as imported_athletes,
  (select count(*) from training_load.metric_event_participants p join ap on p.event_id = ap.metric_event_id) as event_participants,
  (select (c.preview -> 'counts' ->> 'changesToImported')::int from c) as preview_changes_to_imported;

-- 6. Value by value: every written value is its preview entry, and every
--    preview entry was written (athlete, value, unit, source value and unit,
--    activation, mapping version).
--    Expected: preview_values = stored_values (117 on production),
--    unmatched = 0, differing = 0.
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
),
c as (
  select x.* from training_load.gpexe_import_candidates x join ap on ap.candidate_id = x.id
),
pv as (
  select ath.a ->> 'athleteId' as athlete_id,
         rs.r ->> 'externalId' as external_id,
         vs.e ->> 'metricDefinitionId' as metric_definition_id,
         (vs.e ->> 'value')::numeric as value,
         vs.e ->> 'unit' as unit,
         (vs.e ->> 'sourceValue')::numeric as source_value,
         vs.e ->> 'sourceUnit' as source_unit,
         vs.e ->> 'activationId' as activation_id,
         vs.e ->> 'mappingVersionId' as mapping_version_id
    from c,
         jsonb_array_elements(c.preview -> 'athletes') as ath(a),
         jsonb_array_elements(ath.a -> 'results') as rs(r),
         jsonb_array_elements(rs.r -> 'values') as vs(e)
   where rs.r ->> 'outcome' = 'created' and vs.e ->> 'value' is not null
),
sv as (
  select par.athlete_id::text as athlete_id,
         si.source_external_id as external_id,
         v.metric_definition_id::text as metric_definition_id,
         v.value_numeric as value,
         v.unit_at_capture as unit,
         p.source_value_numeric as source_value,
         p.source_unit,
         p.activation_id::text as activation_id,
         p.mapping_version_id::text as mapping_version_id
    from ap
    join training_load.metric_measurement_occasions o on o.import_batch_id = ap.import_batch_id
    join training_load.metric_source_identities si on si.id = o.source_identity_id
    join training_load.metric_event_participants par on par.id = o.event_participant_id
    join training_load.metric_values v on v.occasion_id = o.id
    left join training_load.metric_value_source_provenance p on p.metric_value_id = v.id
)
select
  (select count(*) from pv) as preview_values,
  (select count(*) from sv) as stored_values,
  (select count(*) from pv full join sv
      on sv.external_id = pv.external_id and sv.metric_definition_id = pv.metric_definition_id
    where pv.external_id is null or sv.external_id is null) as unmatched,
  (select count(*) from pv join sv
      on sv.external_id = pv.external_id and sv.metric_definition_id = pv.metric_definition_id
    where sv.athlete_id is distinct from pv.athlete_id
       or sv.value is distinct from pv.value
       or sv.unit is distinct from pv.unit
       or sv.source_value is distinct from pv.source_value
       or sv.source_unit is distinct from pv.source_unit
       or sv.activation_id is distinct from pv.activation_id
       or sv.mapping_version_id is distinct from pv.mapping_version_id) as differing;

-- 7. Every value of the import has its T6 row, and every T6 row names the
--    First team's binding, its source instance, an open activation of that
--    binding, the activation's pinned version and a system variable.
--    Expected: team_bindings = 1, team_instances = 1,
--    values_of_the_import = t6_rows (117 on production), and every other
--    column 0, except activations_used (1 to open_activations, 3 on
--    production) and open_activations (3 on production).
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
),
b as (
  select bb.id from training_load.source_team_bindings bb join ap on ap.owner_team_id = bb.team_id
   where bb.source_system = 'gpexe' and bb.state = 'active'
),
m as (
  select ms.id from training_load.metric_source_connections ms join ap on ap.owner_team_id = ms.owner_team_id
   where ms.source_system = 'gpexe' and ms.owner_scope = 'team' and ms.state = 'active'
),
val as (
  select v.id, v.metric_definition_id, v.metric_definition_version_id, v.unit_at_capture,
         v.aggregation_role, v.coverage, v.is_derived, o.segment_id
    from training_load.metric_values v
    join training_load.metric_measurement_occasions o on o.id = v.occasion_id
    join ap on o.import_batch_id = ap.import_batch_id
),
p as (
  select p.* from training_load.metric_value_source_provenance p join val on val.id = p.metric_value_id
)
select
  (select count(*) from b) as team_bindings,
  (select count(*) from m) as team_instances,
  (select count(*) from val) as values_of_the_import,
  (select count(*) from p) as t6_rows,
  (select count(*) from val where not exists (select 1 from p where p.metric_value_id = val.id)) as values_without_t6,
  (select count(*) from p where p.source_team_binding_id is distinct from (select id from b)) as t6_other_binding,
  (select count(*) from p where p.metric_source_connection_id is distinct from (select id from m)) as t6_other_instance,
  (select count(*) from p
     left join training_load.source_metric_mapping_activations act on act.id = p.activation_id
    where act.id is null or act.ended_at is not null
       or act.source_team_binding_id is distinct from (select id from b)) as t6_not_an_open_activation,
  (select count(*) from p
     join val on val.id = p.metric_value_id
     join training_load.source_metric_mapping_activations act on act.id = p.activation_id
     join training_load.source_metric_mapping_versions mv on mv.id = act.mapping_version_id
    where p.mapping_version_id is distinct from act.mapping_version_id
       or val.metric_definition_id is distinct from act.metric_definition_id
       or val.metric_definition_version_id is distinct from mv.metric_definition_version_id
       or val.unit_at_capture is distinct from mv.target_unit
       or p.source_unit is distinct from mv.source_unit
       or mv.status <> 'active') as t6_not_the_pinned_version,
  (select count(*) from p, ap where p.recorded_at <> ap.approved_at) as t6_outside_the_approval,
  (select count(*) from val join training_load.metric_definitions d on d.id = val.metric_definition_id
    where d.owner_scope <> 'system') as values_not_on_a_system_variable,
  (select count(*) from val
    where val.is_derived
       or (val.segment_id is null and not (val.aggregation_role = 'source_rollup' and val.coverage = 'complete'))
       or (val.segment_id is not null and not (val.aggregation_role = 'standalone' and val.coverage = 'not_applicable'))) as role_or_coverage_wrong,
  (select count(distinct p.activation_id) from p) as activations_used,
  (select count(*) from training_load.source_metric_mapping_activations act
    where act.source_team_binding_id = (select id from b) and act.ended_at is null) as open_activations;

-- 8. The T7 keys set on the First team's source instance, and the import
--    written under that instance.
--    Expected: exactly one row: instance_state = active,
--    source_host_key = server3, source_instance_key = 980,
--    keys_are_the_bindings = true, is_the_event_instance = true,
--    is_the_event_binding_instance = true, identities_elsewhere = 0,
--    rows_with_these_keys = 1. created_in_the_approval is shown only (true when
--    the approval inserted the instance, false when it set the keys of an
--    instance written before).
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
),
b as (
  select bb.source_team_id, cc.host_key
    from training_load.source_team_bindings bb
    join training_load.source_credential_connections cc on cc.id = bb.connection_id
    join ap on ap.owner_team_id = bb.team_id
   where bb.source_system = 'gpexe' and bb.state = 'active'
)
select ms.state as instance_state,
       ms.source_host_key,
       ms.source_instance_key,
       (ms.source_host_key = b.host_key and ms.source_instance_key = b.source_team_id) as keys_are_the_bindings,
       (ms.id = e.source_connection_id) as is_the_event_instance,
       exists (select 1 from training_load.metric_event_source_bindings sb
                where sb.event_id = e.id and sb.source_connection_id = ms.id) as is_the_event_binding_instance,
       (select count(*) from training_load.metric_measurement_occasions o
          join training_load.metric_source_identities si on si.id = o.source_identity_id
         where o.import_batch_id = ap.import_batch_id and si.source_connection_id <> ms.id) as identities_elsewhere,
       (select count(*) from training_load.metric_source_connections z
         where z.source_system = 'gpexe' and z.source_host_key = b.host_key
           and z.source_instance_key = b.source_team_id) as rows_with_these_keys,
       (ms.created_at = ap.approved_at) as created_in_the_approval
  from ap
  join training_load.metric_events e on e.id = ap.metric_event_id
  left join b on true
  join training_load.metric_source_connections ms
    on ms.source_system = 'gpexe' and ms.owner_scope = 'team' and ms.owner_team_id = ap.owner_team_id
 order by ms.state;

-- 9. Where the preview left a value out, nothing is stored - above all, no
--    zero.
--    Expected: approvals_total = 1, left_out_entries = block 5's
--    preview_left_out (0 on production), left_out_with_a_stored_value = 0,
--    left_out_stored_as_zero = 0. left_out_by_reason is shown only ({} when
--    nothing was left out).
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
),
c as (
  select x.* from training_load.gpexe_import_candidates x join ap on ap.candidate_id = x.id
),
lo as (
  select ath.a ->> 'athleteId' as athlete_id,
         l.s ->> 'level' as level,
         (l.s ->> 'drillIndex')::int as drill_index,
         (l.s ->> 'activationId')::uuid as activation_id,
         l.s ->> 'reason' as reason
    from c,
         jsonb_array_elements(c.preview -> 'athletes') as ath(a),
         jsonb_array_elements(ath.a -> 'skippedValues') as l(s)
),
hit as (
  select lo.reason, v.value_numeric
    from lo
    join training_load.source_metric_mapping_activations act on act.id = lo.activation_id
    cross join ap
    join training_load.metric_event_participants par
      on par.event_id = ap.metric_event_id and par.athlete_id::text = lo.athlete_id
    join training_load.metric_measurement_occasions o
      on o.event_participant_id = par.id and o.import_batch_id = ap.import_batch_id
    left join training_load.metric_event_segments sg on sg.id = o.segment_id
    join training_load.metric_values v on v.occasion_id = o.id and v.metric_definition_id = act.metric_definition_id
   where (lo.level = 'full' and o.segment_id is null)
      or (lo.level = 'drill' and sg.segment_order = lo.drill_index + 1)
)
select
  (select count(*) from training_load.gpexe_import_approvals) as approvals_total,
  (select count(*) from lo) as left_out_entries,
  (select count(*) from hit) as left_out_with_a_stored_value,
  (select count(*) from hit where hit.value_numeric = 0) as left_out_stored_as_zero,
  (select coalesce(jsonb_object_agg(x.reason, x.n), '{}'::jsonb)
     from (select lo.reason, count(*) as n from lo group by lo.reason) x) as left_out_by_reason;

-- 10. No gpexe_* definition: the importer creates no variable (C46).
--     Expected: approvals_total = 1, gpexe_team_definitions = 0,
--     gpexe_named_definitions = 0 (both as in step 11's block 8),
--     definitions_written_by_the_approval = 0,
--     versions_written_by_the_approval = 0 (a row the approval's transaction
--     wrote carries its approved_at; a later administrator's variable is not
--     the import's).
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
)
select
  (select count(*) from training_load.gpexe_import_approvals) as approvals_total,
  (select count(*) from training_load.metric_definitions
    where starts_with(key, 'gpexe_') and owner_scope = 'team') as gpexe_team_definitions,
  (select count(*) from training_load.metric_definitions where starts_with(key, 'gpexe_')) as gpexe_named_definitions,
  (select count(*) from training_load.metric_definitions d, ap where d.created_at = ap.approved_at) as definitions_written_by_the_approval,
  (select count(*) from training_load.metric_definition_versions dv, ap where dv.created_at = ap.approved_at) as versions_written_by_the_approval;

-- 11. The rest of what the import wrote: the event, the threshold binding, the
--     batch, the activity, the identities, and no roster decision yet.
--     Expected: one row: event_is_the_session = true, event_owner_scope =
--     team, event_of_the_team = true, scope_level = session,
--     event_created_in_the_approval = true, threshold_binding_rows = 1,
--     batch_ok = true, activity_origin = source_import, activity_lifecycle =
--     confirmed, activity_of_the_team = true,
--     activity_created_in_the_approval = true, confirmed_event_links = 1,
--     activity_participants = event_participants (13 on production),
--     event_segments = drill_components, gpexe_events_total = 1,
--     identities = results + 1 (40 on production; one per result and the
--     session's own), identities_without_occasion = 1,
--     occasions_not_plain_created = 0, roster_decisions = 0.
with ap as (
  select * from training_load.gpexe_import_approvals
   where (select count(*) from training_load.gpexe_import_approvals) = 1
)
select (e.source_external_id = 'team_session:' || ap.gpexe_team_session_id) as event_is_the_session,
       e.owner_scope as event_owner_scope,
       (e.owner_team_id = ap.owner_team_id) as event_of_the_team,
       e.scope_level,
       (e.created_at = ap.approved_at) as event_created_in_the_approval,
       (select count(*) from training_load.metric_event_source_bindings sb
         where sb.event_id = e.id and sb.source_connection_id = e.source_connection_id
           and sb.source_external_id = e.source_external_id) as threshold_binding_rows,
       (bt.owner_scope = 'team' and bt.owner_team_id = ap.owner_team_id
        and bt.uploaded_by_user_id = ap.approved_by_user_id and bt.uploaded_at = ap.approved_at) as batch_ok,
       act.origin as activity_origin,
       act.lifecycle_state as activity_lifecycle,
       (act.owner_scope = 'team' and act.owner_team_id = ap.owner_team_id) as activity_of_the_team,
       (act.created_at = ap.approved_at) as activity_created_in_the_approval,
       (select count(*) from training.activity_metric_event_links l
         where l.metric_event_id = e.id and l.link_status = 'confirmed' and l.activity_id = ap.activity_id) as confirmed_event_links,
       (select count(*) from training.activity_participants pt where pt.activity_id = ap.activity_id) as activity_participants,
       (select count(*) from training_load.metric_event_participants mp where mp.event_id = e.id) as event_participants,
       (select count(*) from training_load.metric_event_segments sg where sg.event_id = e.id) as event_segments,
       (select count(*) from training.activity_components ac
         where ac.activity_id = ap.activity_id and ac.component_type_key = 'drill' and ac.origin = 'api_source') as drill_components,
       (select count(*) from training_load.metric_event_source_bindings) as gpexe_events_total,
       (select count(*) from training_load.metric_source_identities si
         where si.source_connection_id = e.source_connection_id) as identities,
       (select count(*) from training_load.metric_source_identities si
         where si.source_connection_id = e.source_connection_id and si.current_occasion_id is null) as identities_without_occasion,
       (select count(*) from training_load.metric_measurement_occasions o
         where o.import_batch_id = ap.import_batch_id
           and (o.entry_method <> 'api_import' or o.import_conflict_status is not null
                or o.supersedes_occasion_id is not null or o.superseded_by_occasion_id is not null)) as occasions_not_plain_created,
       (select count(*) from training.activity_athlete_decisions d where d.activity_id = ap.activity_id) as roster_decisions
  from ap
  join training_load.metric_events e on e.id = ap.metric_event_id
  join training_load.metric_import_batches bt on bt.id = ap.import_batch_id
  join training.activities act on act.id = ap.activity_id;
