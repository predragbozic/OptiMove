-- GPEXE import window, step 11: the pre-switch preflight - READ ONLY.
-- Contract docs/ai/phase9-importer-mappings-contract.md, section 10.3 step 11
-- (prepared in 9-R, section 10.4). It runs after the freeze (step 9) and the
-- restore-verified backup (step 10), and before the record row (step 12) and
-- the switch (step 13). The post-import check of step 16 is
-- docs/runbooks/gpexe-import-window-postcheck.sql.
--
-- How it runs: ONE numbered block per call, sent exactly as
--   begin transaction read only;
--   <the block, verbatim from this file>
--   rollback;
-- (docs/ai/metrics-core-plan.md, "Standing order for migration PRs", point 5,
-- the connector rule; contract section 10.3 step 11 applies it here). Every
-- block is one plain SELECT: it writes nothing, takes no row lock and needs no
-- parameter. The record names the sha256 of this whole file.
--
-- Any value other than the expected one: stop, change nothing, report the
-- block, the column and the value. The window does not open.
--
-- Checked outside this file:
-- - the served commit equals main: /api/health three times in a row;
-- - the backup's freshness: block 14's newest times against the backup's time
--   (its VERIFIED output or .verify.json).
--
-- The First team is found without an id: the one active GPEXE binding that
-- holds an open mapping activation. Blocks 6, 10, 12 and 13 print
-- first_team_bindings, which must be 1; block 9 lists nothing unless it is 1.
--
-- Pinned to main as written: the last migrations_v2 file is v51
-- (202611011900_calendar_v51_settings.sql), and block 5 names the three pilot
-- mappings decided under O6. If main carries a later migration, or the
-- decided mappings change, this file is stale: it is re-issued under a new
-- sha256 before step 11.

-- 1. The migrations: v51 is the last migrations_v2 migration, recorded once
--    with the repository's checksum, and nothing is recorded after it.
--    Expected: v51_rows = 1, v51_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202611011900_calendar_v51_settings.sql.
--    v2_rows is shown only (80 where every migrations_v2 file of main has run).
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

-- 2. Nothing runs: no GPEXE check is running in any team, and no athlete
--    identity load is running.
--    Expected: running_checks = 0, running_identity_loads = 0.
--    staged_observations is shown only: rows a check that did not finish left
--    for the retention sweep (no route reads them, nothing publishes them).
select
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads,
  (select count(*) from training_load.gpexe_import_check_observations) as staged_observations;

-- 3. A quiet moment: no other session is idle in a transaction, and none holds
--    or waits for a write lock on the tables an approval reads or writes
--    (plain reads - ACCESS SHARE, ROW SHARE - are not counted).
--    Expected: idle_in_transaction = 0, import_table_write_locks = 0. An
--    ordinary write to one of these tables holds ROW EXCLUSIVE for a moment: a
--    non-zero import_table_write_locks that is gone when the block is run again
--    a few seconds later was such a write, not a blocker.
--    advisory_locks is shown only (the importer's team lock is an advisory
--    lock, held only while a check, an approval or a binding change runs).
--    A role without pg_read_all_stats sees only its own role's sessions in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions; pg_locks is not limited that way, and is read for this database
--    only (a relation id is unique per database).
select
  (select count(*) from pg_stat_activity
    where datname = current_database() and state like 'idle in transaction%'
      and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from pg_locks l
     join pg_class c on c.oid = l.relation
     join pg_namespace n on n.oid = c.relnamespace
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and (l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock',
                      'ExclusiveLock', 'AccessExclusiveLock') or not l.granted)
      and n.nspname = 'training_load'
      and c.relname in ('gpexe_import_checks', 'gpexe_import_candidates', 'gpexe_import_approvals',
                        'gpexe_import_check_observations', 'source_team_bindings',
                        'source_metric_mapping_activations', 'metric_source_connections',
                        'metric_value_source_provenance', 'metric_values')) as import_table_write_locks,
  (select count(*) from pg_locks
    where locktype = 'advisory' and pid <> pg_backend_pid()
      and database = (select oid from pg_database where datname = current_database())) as advisory_locks;

-- 4. The First team: every binding that holds an open mapping activation, in
--    any binding state (an Unbind never ends an activation).
--    Expected: exactly one row: source_system = gpexe, source_team_id = 980,
--    binding_state = active, team_active = true, club_active = true,
--    host_key = server3, api_family = rest_v1, connection_owner_scope = club,
--    connection_club_is_team_club = true, open_activations = 3,
--    open_required = 3.
--    team_name and connection_state are shown only: the credential
--    connection's state is no condition of an import (C55).
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

-- 5. The open activations, as decided (O6 (a): the three pilot fields, each
--    Required, at the session and the drill level, on system variables).
--    Expected: exactly three rows, as_decided = true on each:
--      duration              from athlete_session.total_time     s to min (1 / 60)
--      maximal_running_speed from athlete_session.max_v          m/s to km/h (3.6 / 1)
--      total_distance        from athlete_session.total_distance m to m (1 / 1)
--    The other columns say why a row is not as decided. min_value and
--    max_value are shown only.
with expected (variable_key, source_metric_key, source_unit, target_unit, scale, scale_divisor, value_offset) as (
  values ('duration', 'athlete_session.total_time', 's', 'min', 1::numeric, 60::numeric, 0::numeric),
         ('maximal_running_speed', 'athlete_session.max_v', 'm/s', 'km/h', 3.6::numeric, 1::numeric, 0::numeric),
         ('total_distance', 'athlete_session.total_distance', 'm', 'm', 1::numeric, 1::numeric, 0::numeric)
)
select md.key as variable_key,
       d.source_metric_key,
       a.requirement,
       a.applies_to_session,
       a.applies_to_drill,
       v.version_number,
       v.status as version_status,
       v.source_unit,
       v.target_unit,
       trim_scale(v.scale)::text as scale,
       trim_scale(v.scale_divisor)::text as scale_divisor,
       trim_scale(v."offset")::text as value_offset,
       r.revision_number,
       r.state as revision_state,
       r.evidence_status,
       r.source_unit as revision_source_unit,
       md.owner_scope as variable_scope,
       md.state as variable_state,
       mv.unit as variable_unit,
       trim_scale(mv.min_value)::text as min_value,
       trim_scale(mv.max_value)::text as max_value,
       (e.variable_key is not null
        and d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.state = 'active'
        and d.source_metric_key = e.source_metric_key
        and a.requirement = 'required' and a.applies_to_session and a.applies_to_drill
        and v.status = 'active' and v.parameter_kind = 'none' and v.source_parameters = '{}'::jsonb
        and v.source_unit = e.source_unit and v.target_unit = e.target_unit
        and v.scale = e.scale and v.scale_divisor = e.scale_divisor and v."offset" = e.value_offset
        and r.state = 'active' and r.evidence_status = 'verified' and r.source_unit = v.source_unit
        and md.owner_scope = 'system' and m.owner_scope = 'system' and md.state = 'active'
        and md.current_version_id = v.metric_definition_version_id
        and mv.value_type = 'numeric' and mv.unit = v.target_unit
        and exists (select 1 from training_load.metric_definition_scope_capabilities sc
                     where sc.metric_definition_id = md.id and sc.scope_level = 'session')
        and exists (select 1 from training_load.metric_definition_scope_capabilities sc
                     where sc.metric_definition_id = md.id and sc.scope_level = 'component')) is true as as_decided
  from training_load.source_metric_mapping_activations a
  join training_load.source_metric_mapping_versions v on v.id = a.mapping_version_id
  join training_load.source_metric_mappings m on m.id = a.mapping_id
  join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id
  join training_load.source_metric_definition_versions r on r.id = v.source_metric_version_id
  join training_load.metric_definitions md on md.id = v.metric_definition_id
  join training_load.metric_definition_versions mv on mv.id = v.metric_definition_version_id
  left join expected e on e.variable_key = md.key
 where a.ended_at is null
 order by md.key, d.source_metric_key;

-- 6. The First team's Metrics Core source instance (T7).
--    Expected: first_team_bindings = 1, other_keys = 0,
--    inactive_with_the_keys = 0, keys_held_elsewhere = 0, and either
--    active_instances = 0 (the approval inserts it) or active_instances = 1
--    with active_keys = NULL / NULL or server3 / 980.
with bound as (
  select b.id as binding_id, b.team_id, b.connection_id, b.source_team_id
    from training_load.source_team_bindings b
   where b.source_system = 'gpexe' and b.state = 'active'
     and exists (select 1 from training_load.source_metric_mapping_activations a
                  where a.source_team_binding_id = b.id and a.ended_at is null)
),
first_team as (
  select * from bound where (select count(*) from bound) = 1
),
expected_keys as (
  select f.team_id, c.host_key, f.source_team_id
    from first_team f
    join training_load.source_credential_connections c on c.id = f.connection_id
),
own as (
  select ms.state, ms.source_host_key, ms.source_instance_key
    from training_load.metric_source_connections ms
    join first_team f on f.team_id = ms.owner_team_id
   where ms.source_system = 'gpexe' and ms.owner_scope = 'team'
)
select
  (select count(*) from bound) as first_team_bindings,
  (select count(*) from own where own.state = 'active') as active_instances,
  (select string_agg(coalesce(own.source_host_key, 'NULL') || ' / ' || coalesce(own.source_instance_key, 'NULL'), ', ')
     from own where own.state = 'active') as active_keys,
  (select count(*) from own cross join expected_keys k
    where own.state = 'active' and (own.source_host_key is not null or own.source_instance_key is not null)
      and (own.source_host_key is distinct from k.host_key or own.source_instance_key is distinct from k.source_team_id
           or own.source_host_key is distinct from 'server3' or own.source_instance_key is distinct from '980')) as other_keys,
  (select count(*) from training_load.metric_source_connections ms cross join expected_keys k
    where ms.source_system = 'gpexe' and ms.state = 'inactive'
      and ms.source_host_key = k.host_key and ms.source_instance_key = k.source_team_id) as inactive_with_the_keys,
  (select count(*) from training_load.metric_source_connections ms cross join expected_keys k
    where ms.source_system = 'gpexe'
      and ms.source_host_key = k.host_key and ms.source_instance_key = k.source_team_id
      and (ms.owner_scope is distinct from 'team' or ms.owner_team_id is distinct from k.team_id)) as keys_held_elsewhere;

-- 7. Link gate (1): no GPEXE athlete id outside the canonical form, in any
--    team, linked or unlinked.
--    Expected: non_canonical_links = 0.
select count(*) as non_canonical_links
  from training_load.gpexe_athlete_links
 where gpexe_athlete_id !~ '^(0|[1-9][0-9]{0,11})$';

-- 8. Nothing has been imported through GPEXE yet, anywhere: the baseline
--    step 16 compares with.
--    Expected: approvals = 0, imported_candidates = 0, t6_rows = 0,
--    gpexe_events = 0, import_batches = 0, gpexe_team_definitions = 0.
--    gpexe_named_definitions is shown only (0 is expected).
select
  (select count(*) from training_load.gpexe_import_approvals) as approvals,
  (select count(*) from training_load.gpexe_import_candidates where status = 'imported') as imported_candidates,
  (select count(*) from training_load.metric_value_source_provenance) as t6_rows,
  (select count(*) from training_load.metric_event_source_bindings) as gpexe_events,
  (select count(*) from training_load.metric_import_batches) as import_batches,
  (select count(*) from training_load.metric_definitions
    where starts_with(key, 'gpexe_') and owner_scope = 'team') as gpexe_team_definitions,
  (select count(*) from training_load.metric_definitions where starts_with(key, 'gpexe_')) as gpexe_named_definitions;

-- 9. Every actionable candidate of the First team: pending, last seen by a
--    succeeded check of the team, drill effect confirmed or not_required. The
--    owner accepts each row by its candidate_id, or the window does not open.
--    Expected (the Rukovodilac's reading after step 8, 2026-11-02): one row,
--    gpexe_session_id = 190122 (the session of 23.10.2026 that step 8's check
--    of 23.10.2026 - 23.10.2026 found), last_check_is_newest = true,
--    last_check_through_the_binding = true, drill_parameter_effect =
--    confirmed or not_required, preview_version = 3, preview_status = ready,
--    blocked_code = null, results_created = 39, left_out_values = 0,
--    changes_to_imported = 0, snapshot_available = true, approval_id = null.
with bound as (
  select b.id as binding_id, b.team_id
    from training_load.source_team_bindings b
   where b.source_system = 'gpexe' and b.state = 'active'
     and exists (select 1 from training_load.source_metric_mapping_activations a
                  where a.source_team_binding_id = b.id and a.ended_at is null)
),
first_team as (
  select * from bound where (select count(*) from bound) = 1
),
newest_check as (
  select k.id
    from training_load.gpexe_import_checks k
    join first_team f on f.team_id = k.owner_team_id
   order by k.started_at desc, k.id desc
   limit 1
)
select c.id as candidate_id,
       c.gpexe_team_session_id as gpexe_session_id,
       to_char(c.session_started_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as session_started_utc,
       k.status as last_check_status,
       (c.last_seen_check_id = (select id from newest_check)) as last_check_is_newest,
       (k.source_path = 'source_connection' and k.source_binding_id = f.binding_id) as last_check_through_the_binding,
       c.drill_parameter_effect,
       c.preview ->> 'version' as preview_version,
       c.preview ->> 'status' as preview_status,
       c.preview -> 'blocked' ->> 'code' as blocked_code,
       c.preview -> 'counts' ->> 'created' as results_created,
       c.preview -> 'counts' ->> 'skippedValues' as left_out_values,
       case when jsonb_typeof(c.preview -> 'changesToImported') = 'array'
            then jsonb_array_length(c.preview -> 'changesToImported') end as changes_to_imported,
       (c.raw_bundle is not null and c.raw_purged_at is null and c.raw_expires_at > now()) as snapshot_available,
       to_char(c.raw_expires_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as snapshot_expires_utc,
       (select ap.id from training_load.gpexe_import_approvals ap where ap.candidate_id = c.id) as approval_id
  from first_team f
  join training_load.gpexe_import_candidates c on c.owner_team_id = f.team_id
  join training_load.gpexe_import_checks k on k.id = c.last_seen_check_id and k.owner_team_id = c.owner_team_id
 where c.status = 'pending'
   and k.status = 'succeeded'
   and c.drill_parameter_effect in ('not_required', 'confirmed')
 order by c.session_started_at desc nulls last, c.id;

-- 10. The First team's candidates counted, and its newest check.
--     Expected: first_team_bindings = 1, actionable = the rows of block 9,
--     actionable_v3_ready = actionable, imported = 0,
--     newest_check_status = succeeded, newest_check_through_the_binding = true.
--     pending, blocked and superseded are shown only.
with bound as (
  select b.id as binding_id, b.team_id
    from training_load.source_team_bindings b
   where b.source_system = 'gpexe' and b.state = 'active'
     and exists (select 1 from training_load.source_metric_mapping_activations a
                  where a.source_team_binding_id = b.id and a.ended_at is null)
),
first_team as (
  select * from bound where (select count(*) from bound) = 1
),
team_candidates as (
  select c.*,
         (c.status = 'pending' and c.drill_parameter_effect in ('not_required', 'confirmed')
          and exists (select 1 from training_load.gpexe_import_checks k
                       where k.id = c.last_seen_check_id and k.owner_team_id = c.owner_team_id
                         and k.status = 'succeeded')) as actionable
    from training_load.gpexe_import_candidates c
    join first_team f on f.team_id = c.owner_team_id
),
newest_check as (
  select k.status, k.source_path, k.source_binding_id, f.binding_id
    from training_load.gpexe_import_checks k
    join first_team f on f.team_id = k.owner_team_id
   order by k.started_at desc, k.id desc
   limit 1
)
select
  (select count(*) from bound) as first_team_bindings,
  (select count(*) from team_candidates where actionable) as actionable,
  (select count(*) from team_candidates
    where actionable and preview ->> 'version' = '3' and preview ->> 'status' = 'ready') as actionable_v3_ready,
  (select count(*) from team_candidates where status = 'imported') as imported,
  (select count(*) from team_candidates where status = 'pending') as pending,
  (select count(*) from team_candidates where status = 'blocked') as blocked,
  (select count(*) from team_candidates where status = 'superseded') as superseded,
  (select status from newest_check) as newest_check_status,
  (select source_path = 'source_connection' and source_binding_id = binding_id from newest_check) as newest_check_through_the_binding;

-- 11. Every active platform admin: each may approve for any team. The owner
--     accepts each row, or the window does not open.
--     Expected: only platform admins the owner knows, revoked_at_null = true.
--     role_granted_utc is the role row's first grant, role_changed_utc its
--     last change (a global role keeps no separate grant time). A row with no
--     name is accepted by its user_id, or the window does not open.
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

-- 12. Every approver grant of the First team that is not revoked, whether or
--     not it gives the right today (a grant whose coach role is off gives it
--     again when the role comes back). The owner accepts each row, or the
--     window does not open.
--     Expected: first_team_bindings = 1 on every row, and only grants the owner
--     knows; one row with grant_id = null means the team has no such grant. A
--     row with no name is accepted by its user_id, or the window does not open.
with bound as (
  select b.team_id
    from training_load.source_team_bindings b
   where b.source_system = 'gpexe' and b.state = 'active'
     and exists (select 1 from training_load.source_metric_mapping_activations a
                  where a.source_team_binding_id = b.id and a.ended_at is null)
),
first_team as (
  select * from bound where (select count(*) from bound) = 1
),
grants as (
  select g.id, g.user_id, g.owner_team_id, g.granted_at,
         coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), '')) as name,
         u.is_active as user_active
    from first_team f
    join training_load.gpexe_import_approvers g on g.owner_team_id = f.team_id and g.revoked_at is null
    join public.users u on u.id = g.user_id
)
select fb.first_team_bindings,
       g.id as grant_id,
       g.user_id,
       g.name,
       case when g.id is not null then 'team_grant' end as basis,
       to_char(g.granted_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as granted_utc,
       g.user_active,
       exists (select 1 from public.user_team_roles tr
                where tr.user_id = g.user_id and tr.team_id = g.owner_team_id
                  and tr.role = 'team_coach' and tr.is_active = true) as active_team_coach,
       (g.user_active and exists (select 1 from public.user_team_roles tr
                                   where tr.user_id = g.user_id and tr.team_id = g.owner_team_id
                                     and tr.role = 'team_coach' and tr.is_active = true)) as gives_the_right_now,
       exists (select 1 from public.user_global_roles r
                where r.user_id = g.user_id and r.role = 'platform_admin' and r.is_active = true) as also_platform_admin
  from (select count(*) as first_team_bindings from bound) fb
  left join grants g on true
 order by g.granted_at, g.id;

-- 13. The rights, counted.
--     Expected: first_team_bindings = 1, active_platform_admins = the rows of
--     block 11, unrevoked_grants = the rows of block 12,
--     grants_giving_the_right_now = the rows of block 12 with
--     gives_the_right_now = true.
--     may_approve_now (distinct users) and unrevoked_grants_all_teams are
--     shown only.
with bound as (
  select b.team_id
    from training_load.source_team_bindings b
   where b.source_system = 'gpexe' and b.state = 'active'
     and exists (select 1 from training_load.source_metric_mapping_activations a
                  where a.source_team_binding_id = b.id and a.ended_at is null)
),
first_team as (
  select * from bound where (select count(*) from bound) = 1
),
admins as (
  select r.user_id
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.role = 'platform_admin' and r.is_active = true and u.is_active = true
),
effective_grants as (
  select g.user_id
    from training_load.gpexe_import_approvers g
    join first_team f on f.team_id = g.owner_team_id
    join public.users u on u.id = g.user_id and u.is_active = true
   where g.revoked_at is null
     and exists (select 1 from public.user_team_roles tr
                  where tr.user_id = g.user_id and tr.team_id = g.owner_team_id
                    and tr.role = 'team_coach' and tr.is_active = true)
)
select
  (select count(*) from bound) as first_team_bindings,
  (select count(*) from admins) as active_platform_admins,
  (select count(*) from training_load.gpexe_import_approvers g
     join first_team f on f.team_id = g.owner_team_id
    where g.revoked_at is null) as unrevoked_grants,
  (select count(*) from effective_grants) as grants_giving_the_right_now,
  (select count(*) from (select user_id from admins union select user_id from effective_grants) x) as may_approve_now,
  (select count(*) from training_load.gpexe_import_approvers where revoked_at is null) as unrevoked_grants_all_teams;

-- 14. Freshness: for every table an approval writes, and every other
--     Metrics Core table, its row count and the newest time it records, in
--     UTC (environment-wide: a restore would lose a write to any team).
--     Expected: rows 1 to 13 and 34 = 0 with no time (nothing imported yet,
--     block 8) - except rows 6 and 7 when block 6 shows an active instance of
--     the First team (then 1, with its time) - and every newest_utc earlier
--     than the backup's time.
--     A time is the writing transaction's start (now()), except rows 24 and 26
--     (clock_timestamp()). Writes that set no time (the T7 keys, a deleted or
--     replaced row) show only in the counts. Rows 35 to 37 are the freeze's
--     tables (step 9): no change since the freeze began.
select x.row_no, x.table_name, x.row_count, x.newest_utc, x.time_column
  from (
              select  0 as row_no, 'this run' as table_name, null::bigint as row_count,
                      to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as newest_utc, 'now()' as time_column
    union all select  1, 'training_load.gpexe_import_approvals', count(*), to_char(max(approved_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'approved_at' from training_load.gpexe_import_approvals
    union all select  2, 'training_load.gpexe_import_candidates (imported)', count(*), to_char(max(imported_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'imported_at' from training_load.gpexe_import_candidates where status = 'imported'
    union all select  3, 'training_load.metric_value_source_provenance (T6)', count(*), to_char(max(recorded_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'recorded_at' from training_load.metric_value_source_provenance
    union all select  4, 'training_load.metric_event_source_bindings', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_event_source_bindings
    union all select  5, 'training_load.metric_import_batches', count(*), to_char(max(uploaded_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'uploaded_at' from training_load.metric_import_batches
    union all select  6, 'training_load.metric_source_connections', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_source_connections
    union all select  7, 'training_load.metric_source_connections (T7 keys set)', count(*), null, 'none' from training_load.metric_source_connections where source_host_key is not null
    union all select  8, 'training_load.metric_source_identities', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_source_identities
    union all select  9, 'training_load.metric_events (with a GPEXE binding)', count(*), to_char(max(e.created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_events e where exists (select 1 from training_load.metric_event_source_bindings sb where sb.event_id = e.id)
    union all select 10, 'training_load.metric_measurement_occasions (of a batch)', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_measurement_occasions where import_batch_id is not null
    union all select 11, 'training_load.metric_values (with T6)', count(*), to_char(max(v.created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_values v where exists (select 1 from training_load.metric_value_source_provenance p where p.metric_value_id = v.id)
    union all select 12, 'training.activity_source_observations', count(*), to_char(greatest(max(observed_at), max(resolved_at)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'observed_at, resolved_at' from training.activity_source_observations
    union all select 13, 'training_load.import_deletion_log', count(*), to_char(max(deleted_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'deleted_at' from training_load.import_deletion_log
    union all select 14, 'training_load.metric_events', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_events
    union all select 15, 'training_load.metric_event_participants', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_event_participants
    union all select 16, 'training_load.metric_event_segments', count(*), null, 'none' from training_load.metric_event_segments
    union all select 17, 'training_load.metric_measurement_occasions', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_measurement_occasions
    union all select 18, 'training_load.metric_values', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_values
    union all select 19, 'training_load.metric_write_requests', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_write_requests
    union all select 20, 'training_load.metric_definitions', count(*), to_char(greatest(max(created_at), max(updated_at)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at, updated_at' from training_load.metric_definitions
    union all select 21, 'training_load.metric_definition_versions', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_definition_versions
    union all select 22, 'training_load.metric_definition_scope_capabilities', count(*), null, 'none' from training_load.metric_definition_scope_capabilities
    union all select 23, 'training_load.metric_variable_requests', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_variable_requests
    union all select 24, 'training_load.metric_variable_changes', count(*), to_char(max(changed_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'changed_at' from training_load.metric_variable_changes
    union all select 25, 'training_load.metric_classification_requests', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_classification_requests
    union all select 26, 'training_load.metric_classification_changes', count(*), to_char(max(changed_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'changed_at' from training_load.metric_classification_changes
    union all select 27, 'training_load.metric_definition_hidden', count(*), to_char(max(hidden_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'hidden_at' from training_load.metric_definition_hidden
    union all select 28, 'training_load.metric_domains', count(*), to_char(greatest(max(created_at), max(updated_at)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at, updated_at' from training_load.metric_domains
    union all select 29, 'training_load.metric_categories', count(*), to_char(greatest(max(created_at), max(updated_at)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at, updated_at' from training_load.metric_categories
    union all select 30, 'training_load.metric_structure_links', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training_load.metric_structure_links
    union all select 31, 'training.activities', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training.activities
    union all select 32, 'training.activity_participants', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training.activity_participants
    union all select 33, 'training.activity_components', count(*), to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training.activity_components
    union all select 34, 'training.activity_metric_event_links (to a GPEXE event)', count(*), to_char(max(l.created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'created_at' from training.activity_metric_event_links l where exists (select 1 from training_load.metric_event_source_bindings sb where sb.event_id = l.metric_event_id)
    union all select 35, 'freeze: training_load.source_metric_mapping_activations (T5)', count(*), to_char(greatest(max(activated_at), max(ended_at)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'activated_at, ended_at' from training_load.source_metric_mapping_activations
    union all select 36, 'freeze: training_load.source_team_bindings', count(*), to_char(greatest(max(bound_at), max(ended_at)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'bound_at, ended_at' from training_load.source_team_bindings
    union all select 37, 'freeze: training_load.source_metric_audit (T8)', count(*), to_char(max(performed_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'performed_at' from training_load.source_metric_audit
  ) as x
 order by x.row_no;
