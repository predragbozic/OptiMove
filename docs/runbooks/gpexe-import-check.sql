-- GPEXE regular imports: the read-only import check - READ ONLY.
-- It replaces the two pinned files of the first window
-- (gpexe-import-window-preflight.sql, gpexe-import-window-postcheck.sql, which
-- stay as the record of that window) for regular imports. Prepared in
-- docs/ai/first-regular-import-prep-first-team.md, part B.
--
-- How it runs: ONE numbered block per call, sent exactly as
--   begin transaction read only;
--   <the block, verbatim from this file>
--   rollback;
-- (docs/ai/metrics-core-plan.md, "Standing order for migration PRs", point 5,
-- the connector rule). Every block is one plain SELECT: it writes nothing,
-- takes no row lock and needs no parameter. The record names the sha256 of
-- this whole file.
--
-- It is not pinned to a migration or a team. Run it before the first import
-- of a day (blocks 1-8) and after each import (blocks 1, 2, 8-17).
--
-- Any value other than the expected one: stop, change nothing, report the
-- block, the column and the value.
--
-- Checked outside this file: the served commit equals main (/api/health three
-- times in a row), block 1's last_migration equals the newest file of
-- migrations_v2/ in the served commit, the environment switch (the Imports
-- status shows importSwitch), and the backup's own VERIFIED record.
--
-- "The checked approval" (blocks 9-17) is the newest approval that was the FIRST
-- import of its session (changes_to_imported = 0, its event created in the
-- approval itself) whose candidate is still imported and not undone. An
-- approval into an existing event (a session approved again with changes) and
-- an undone import are not checked value by value: block 8 counts them, and a
-- person reads them. When a batch imported several sessions, the blocks check
-- the newest of them; run them per approval by reading the approval id from
-- block 9 and the Imports screen, or one session at a time.
--
-- Where the first window's file named "the First team", this file names the
-- team of the checked approval.

-- 1. The migrations: none is missing a checksum, and what is last.
--    Expected: null_checksums = 0, last_migration = the newest file of
--    migrations_v2/ in the served commit (compared outside this file),
--    v2_rows = the number of migrations_v2/ files in that commit (shown for
--    that comparison). previous_migration is shown only.
select
  (select count(*) from public.schema_migrations
    where starts_with(migration_name, 'migrations_v2/') and checksum is null) as null_checksums,
  (select migration_name from public.schema_migrations
    where starts_with(migration_name, 'migrations_v2/')
    order by migration_name collate "C" desc limit 1) as last_migration,
  (select migration_name from public.schema_migrations
    where starts_with(migration_name, 'migrations_v2/')
    order by migration_name collate "C" desc offset 1 limit 1) as previous_migration,
  (select count(*) from public.schema_migrations
    where starts_with(migration_name, 'migrations_v2/')) as v2_rows;

-- 2. Nothing runs, and it is a quiet moment: no check and no identity load is
--    running, no other session is idle in a transaction, none holds a write
--    lock on the main tables an approval reads or writes (plain reads are not
--    counted).
--    Expected: running_checks = 0, running_identity_loads = 0,
--    idle_in_transaction = 0, import_table_write_locks = 0. An ordinary write
--    or an autovacuum holds its lock for a moment: a non-zero
--    import_table_write_locks that is gone when the block is run again a few
--    seconds later was not a blocker. staged_observations and advisory_locks
--    are shown only. A role without pg_read_all_stats sees only its own
--    role's sessions in pg_stat_activity.
select
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads,
  (select count(*) from training_load.gpexe_import_check_observations) as staged_observations,
  (select count(*) from pg_stat_activity
    where datname = current_database() and state like 'idle in transaction%'
      and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from pg_locks l
     join pg_class c on c.oid = l.relation
     join pg_namespace n on n.oid = c.relnamespace
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock',
                     'ExclusiveLock', 'AccessExclusiveLock')
      and n.nspname = 'training_load'
      and c.relname in ('gpexe_import_checks', 'gpexe_import_candidates', 'gpexe_import_approvals',
                        'gpexe_import_check_observations', 'source_team_bindings',
                        'source_metric_mapping_activations', 'metric_source_connections',
                        'metric_value_source_provenance', 'metric_values')) as import_table_write_locks,
  (select count(*) from pg_locks
    where locktype = 'advisory' and pid <> pg_backend_pid()
      and database = (select oid from pg_database where datname = current_database())) as advisory_locks;

-- 3. The switches and their conditions: one row per kind of recorded date and
--    one per team switch. The environment switch GPEXE_IMPORT_APPLY_ENABLED is
--    not in the database; the Imports status shows it.
--    Expected, before an import: a team_switch row of the team being imported
--    with enabled = true and the mode the owner chose, and no other team
--    enabled; backup_age_days <= 2 and probe_age_days <= 35 (as of today; the
--    database checks them only when a team is turned on). Everything else is
--    shown only.
select 'team_switch' as what,
       t.name as team_name,
       s.enabled,
       s.mode,
       to_char(s.changed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as changed_utc,
       null::date as recorded_on,
       null::int as age_days
  from training_load.gpexe_team_import_switch s
  left join public.teams t on t.id = s.owner_team_id
union all
select 'recorded_' || r.kind,
       null,
       null,
       null,
       to_char(r.recorded_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
       r.recorded_on,
       (current_date - r.recorded_on)
  from (select distinct on (kind) * from training_load.gpexe_import_prerequisite_records
         order by kind, recorded_on desc, recorded_at desc) r
 order by 1, 2;

-- 4. Every binding that holds an open mapping activation, in any binding
--    state (an Unbind never ends an activation).
--    Expected: one row per team that imports, binding_state = active,
--    team_active = true, club_active = true, host_key = server3,
--    api_family = rest_v1, connection_owner_scope = club,
--    connection_club_is_team_club = true, open_required = open_activations
--    (every open activation of a team that imports is the requirement the
--    owner decided). team_name and connection_state are shown only: the
--    credential connection's state is no condition of an import (C55).
select b.source_system,
       b.source_team_id,
       b.state as binding_state,
       t.name as team_name,
       coalesce(t.is_active, true) as team_active,
       coalesce(cl.is_active, true) as club_active,
       c.host_key,
       h.api_family,
       c.owner_scope as connection_owner_scope,
       (c.owner_club_id is not distinct from t.club_id) as connection_club_is_team_club,
       c.state as connection_state,
       count(*) as open_activations,
       count(*) filter (where a.requirement = 'required') as open_required
  from training_load.source_metric_mapping_activations a
  join training_load.source_team_bindings b on b.id = a.source_team_binding_id
  join training_load.source_credential_connections c on c.id = b.connection_id
  left join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
  left join public.teams t on t.id = b.team_id
  left join public.clubs cl on cl.id = t.club_id
 where a.ended_at is null
 group by b.id, b.source_system, b.source_team_id, b.state, t.name, t.is_active, t.club_id, cl.is_active,
          c.host_key, h.api_family, c.owner_scope, c.owner_club_id, c.state
 order by b.source_system, b.source_team_id, b.state;

-- 5. Every active platform admin: each may approve for any team whose switch
--    is on. The owner accepts each row.
--    Expected: only platform admins the owner knows, revoked_at_null = true.
select r.user_id,
       coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), '')) as name,
       'platform_admin' as basis,
       to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as role_granted_utc,
       to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as role_changed_utc,
       (r.revoked_at is null) as revoked_at_null
  from public.user_global_roles r
  join public.users u on u.id = r.user_id
 where r.role = 'platform_admin' and r.is_active = true and u.is_active = true
 order by 2, r.user_id;

-- 6. Every approver grant that is not revoked, in every team, whether or not
--    it gives the right today. In pilot mode a grant approves; in team mode
--    the club admin and the team's coaches do as well.
--    Expected: only grants the owner knows; no row means no grant exists.
--    gives_the_right_now = true when the grantee is an active user holding an
--    active team_coach role of the team.
select g.id as grant_id,
       t.name as team_name,
       g.user_id,
       coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), '')) as name,
       to_char(g.granted_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as granted_utc,
       u.is_active as user_active,
       (u.is_active and exists (select 1 from public.user_team_roles tr
                                 where tr.user_id = g.user_id and tr.team_id = g.owner_team_id
                                   and tr.role = 'team_coach' and tr.is_active = true)) as gives_the_right_now,
       exists (select 1 from public.user_global_roles r
                where r.user_id = g.user_id and r.role = 'platform_admin' and r.is_active = true) as also_platform_admin
  from training_load.gpexe_import_approvers g
  join public.users u on u.id = g.user_id
  left join public.teams t on t.id = g.owner_team_id
 where g.revoked_at is null
 order by t.name, g.granted_at, g.id;

-- 7. Link gate: no GPEXE athlete id outside the canonical form, in any team,
--    linked or unlinked.
--    Expected: non_canonical_links = 0.
select count(*) as non_canonical_links
  from training_load.gpexe_athlete_links
 where gpexe_athlete_id !~ '^(0|[1-9][0-9]{0,11})$';

-- 8. The imports so far, counted, and what the value-by-value blocks do not
--    cover.
--    Expected: imported_without_approval = 0 (a candidate that is imported and
--    not undone has exactly one approval row of its own),
--    approvals_without_event = 0 among the approvals of candidates that are
--    imported and not undone (the event and the batch the approval names
--    exist). The other columns are shown only: approvals_total,
--    approvals_last_14_days, checked_first_imports_last_14_days (the ones
--    blocks 9-17 can check), approvals_into_existing_events_last_14_days (a
--    session approved again with changes: read by a person),
--    undone_candidates (v57), newest_approval_utc and the id of the checked
--    approval.
with live as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
   where cc.status = 'imported' and cc.import_undone_at is null
),
first_imports as (
  select l.*
    from live l
    join training_load.metric_events ee on ee.id = l.metric_event_id and ee.created_at = l.approved_at
   where l.changes_to_imported = 0
)
select
  (select count(*) from training_load.gpexe_import_approvals) as approvals_total,
  (select count(*) from training_load.gpexe_import_approvals where approved_at > now() - interval '14 days') as approvals_last_14_days,
  (select count(*) from first_imports where approved_at > now() - interval '14 days') as checked_first_imports_last_14_days,
  (select count(*) from live l
    where l.approved_at > now() - interval '14 days'
      and not exists (select 1 from first_imports f where f.id = l.id)) as approvals_into_existing_events_last_14_days,
  (select count(*) from training_load.gpexe_import_candidates where import_undone_at is not null) as undone_candidates,
  (select count(*) from training_load.gpexe_import_candidates c
    where c.status = 'imported' and c.import_undone_at is null
      and not exists (select 1 from training_load.gpexe_import_approvals a where a.candidate_id = c.id)) as imported_without_approval,
  (select count(*) from live l
    where not exists (select 1 from training_load.metric_events e where e.id = l.metric_event_id)
       or not exists (select 1 from training_load.metric_import_batches b where b.id = l.import_batch_id)) as approvals_without_event,
  (select to_char(max(approved_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') from training_load.gpexe_import_approvals) as newest_approval_utc,
  (select id from (select * from first_imports order by approved_at desc, id desc limit 1) x) as checked_approval_id;

-- 9. The checked approval (see the header), and that its team is bound.
--    Expected: checked_approvals = 1 (0 means there is no first import to
--    check yet: stop reading blocks 9-17), team_bindings = 1, bound_to = the
--    GPEXE team of the import, open_activations >= 1, requirements = the
--    requirement the owner decided (required), approval_basis =
--    platform_admin (team_grant with no_grant = false when a granted coach
--    approved; club_admin or team_coach in team mode), changes_to_imported = 0,
--    changes_accepted = false, results_imported = the preview's results
--    (block 11 compares), import_count_keys = created, import_ids_recorded =
--    true, and approved_by_user_id a user_id of block 5 (or the grantee of
--    block 6). approval_id, approved_by_name and approved_utc are shown only:
--    the id and the time are what the HTTP approval read shows.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
),
bound as (
  select b.id as binding_id, b.team_id, b.source_team_id, c.host_key
    from training_load.source_team_bindings b
    join training_load.source_credential_connections c on c.id = b.connection_id
    join ap on ap.owner_team_id = b.team_id
   where b.source_system = 'gpexe' and b.state = 'active'
)
select
  (select count(*) from ap) as checked_approvals,
  (select count(*) from bound) as team_bindings,
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

-- 10. The candidate imported in the approval, and the approved preview kept.
--    Expected: candidate_status = imported, imported_in_the_approval = true,
--    same_content = true, stored_preview_is_the_approved_one = true,
--    preview_version = 3, preview_status = ready,
--    drill_parameter_effect = confirmed or not_required,
--    live_imported_of_the_session = 1 (the session is imported once, not
--    undone). gpexe_session_id is shown only.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
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
       (select count(*) from training_load.gpexe_import_candidates x
         where x.owner_team_id = ap.owner_team_id and x.gpexe_team_session_id = ap.gpexe_team_session_id
           and x.status = 'imported' and x.import_undone_at is null) as live_imported_of_the_session
  from ap
  join training_load.gpexe_import_candidates c on c.id = ap.candidate_id;

-- 11. The counts equal the approved preview. A result is one athlete at one
--    level (the whole session or one drill), and one occasion. A value is one
--    variable of one result.
--    Expected: preview_results = approval_results = preview_results_created
--    = batch_occasions = event_occasions;
--    preview_values = written_values = event_values = t6_rows_of_the_import
--    = t6_rows_of_the_event; preview_left_out = preview_left_out_entries;
--    imported_athletes = event_participants;
--    preview_changes_to_imported = 0.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
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
  (select count(*) from training_load.metric_value_source_provenance pp
     join training_load.metric_values vv on vv.id = pp.metric_value_id
     join training_load.metric_measurement_occasions oo on oo.id = vv.occasion_id
     join training_load.metric_event_participants pa on pa.id = oo.event_participant_id
     join ap on pa.event_id = ap.metric_event_id) as t6_rows_of_the_event,
  (select (c.preview -> 'counts' ->> 'skippedValues')::int from c) as preview_left_out,
  (select count(*) from c, jsonb_array_elements(c.preview -> 'athletes') as ath(a),
          jsonb_array_elements(ath.a -> 'skippedValues') as lo(s)) as preview_left_out_entries,
  (select count(*) from c, jsonb_array_elements(c.preview -> 'athletes') as ath(a)
    where ath.a ->> 'notImported' is null) as imported_athletes,
  (select count(*) from training_load.metric_event_participants p join ap on p.event_id = ap.metric_event_id) as event_participants,
  (select (c.preview -> 'counts' ->> 'changesToImported')::int from c) as preview_changes_to_imported;

-- 12. Value by value: every written value is its preview entry, and every
--    preview entry was written (athlete, value, unit, source value and unit,
--    activation, mapping version).
--    Expected: preview_values = stored_values, unmatched = 0, differing = 0.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
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

-- 13. Every value of the import has its T6 row, and every T6 row names the
--    team's binding, its source instance, an open activation of that binding,
--    the activation's pinned version and a system variable.
--    Expected: team_bindings = 1, team_instances = 1, values_of_the_import =
--    t6_rows, and every other column 0, except activations_used (1 to
--    open_activations) and open_activations (shown).
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
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

-- 14. The T7 keys on the team's source instance, and the import written
--    under that instance. One row per source instance of the team.
--    Expected: exactly one row with instance_state = active that meets every
--    expectation: source_host_key = server3, source_instance_key = the GPEXE
--    team, keys_are_the_bindings = true, is_the_event_instance = true,
--    is_the_event_binding_instance = true, identities_elsewhere = 0,
--    rows_with_these_keys = 1 (a second row with these keys would be an
--    ended instance, instance_state = inactive, and may appear only as
--    inactive). created_in_the_approval is shown only.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
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

-- 15. Where the preview left a value out, nothing is stored - above all, no
--    zero.
--    Expected: left_out_entries = block 11's preview_left_out,
--    left_out_with_a_stored_value = 0, left_out_stored_as_zero = 0.
--    left_out_by_reason is shown only.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
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
  (select count(*) from lo) as left_out_entries,
  (select count(*) from hit) as left_out_with_a_stored_value,
  (select count(*) from hit where hit.value_numeric = 0) as left_out_stored_as_zero,
  (select coalesce(jsonb_object_agg(x.reason, x.n), '{}'::jsonb)
     from (select lo.reason, count(*) as n from lo group by lo.reason) x) as left_out_by_reason;

-- 16. No gpexe_* definition: the importer creates no variable (C46).
--     Expected: gpexe_team_definitions = 0, gpexe_named_definitions = 0,
--     definitions_written_by_the_approval = 0,
--     versions_written_by_the_approval = 0.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
)
select
  (select count(*) from training_load.metric_definitions
    where starts_with(key, 'gpexe_') and owner_scope = 'team') as gpexe_team_definitions,
  (select count(*) from training_load.metric_definitions where starts_with(key, 'gpexe_')) as gpexe_named_definitions,
  (select count(*) from training_load.metric_definitions d, ap where d.created_at = ap.approved_at) as definitions_written_by_the_approval,
  (select count(*) from training_load.metric_definition_versions dv, ap where dv.created_at = ap.approved_at) as versions_written_by_the_approval;

-- 17. The rest of what the import wrote: the event, the threshold binding, the
--     batch, the activity, the identities, and the roster work so far.
--     Expected: one row: event_is_the_session = true, event_owner_scope =
--     team, event_of_the_team = true, scope_level = session,
--     event_created_in_the_approval = true, threshold_binding_rows = 1,
--     batch_ok = true, activity_origin = source_import, activity_lifecycle =
--     confirmed, activity_of_the_team = true,
--     activity_created_in_the_approval = true, confirmed_event_links = 1,
--     activity_participants = event_participants, event_segments =
--     drill_components, identities_of_the_results = the results of block 11,
--     session_identities_without_occasion = 1, occasions_not_plain_created = 0.
--     gpexe_events_of_the_instance is shown only (it grows with each import).
--     roster_decisions is shown only: it must be 0 until the import is checked
--     and accepted, because the undo (v57) refuses once a roster decision
--     exists.
with ap as (
  select a.*
    from training_load.gpexe_import_approvals a
    join training_load.gpexe_import_candidates cc on cc.id = a.candidate_id
    join training_load.metric_events ee on ee.id = a.metric_event_id and ee.created_at = a.approved_at
   where cc.status = 'imported' and cc.import_undone_at is null
     and a.changes_to_imported = 0
   order by a.approved_at desc, a.id desc
   limit 1
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
       (select count(*) from training_load.metric_event_source_bindings sb2 where sb2.source_connection_id = e.source_connection_id) as gpexe_events_of_the_instance,
       (select count(distinct o2.source_identity_id) from training_load.metric_measurement_occasions o2
         where o2.import_batch_id = ap.import_batch_id) as identities_of_the_results,
       (select count(*) from training_load.metric_source_identities si
         where si.source_connection_id = e.source_connection_id and si.source_external_id = e.source_external_id
           and si.current_occasion_id is null) as session_identities_without_occasion,
       (select count(*) from training_load.metric_measurement_occasions o
         where o.import_batch_id = ap.import_batch_id
           and (o.entry_method <> 'api_import' or o.import_conflict_status is not null
                or o.supersedes_occasion_id is not null or o.superseded_by_occasion_id is not null)) as occasions_not_plain_created,
       (select count(*) from training.activity_athlete_decisions d where d.activity_id = ap.activity_id) as roster_decisions
  from ap
  join training_load.metric_events e on e.id = ap.metric_event_id
  join training_load.metric_import_batches bt on bt.id = ap.import_batch_id
  join training.activities act on act.id = ap.activity_id;
