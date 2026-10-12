-- Rollback of migration v34 (the schema foundation of the source-to-canonical
-- metric mapping, M1):
-- migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-metric-mapping-m1.test.mjs: apply ->
-- rollback -> the v33 catalog again -> re-apply, and every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists, the
-- application is back on a commit without v34, and the owner approved this
-- database specifically (.claude/rules/database-safety.md).
--
-- It removes the M1 objects and the v34 record, and only while M1 holds
-- nothing but its own seed. It refuses, changing nothing, when
--   * v34 is not recorded on the database;
--   * any mapping (T3), mapping version (T4), activation (T5), provenance
--     row (T6) or audit row (T8) exists - those are business history;
--   * the source metric definitions (T2a), their revisions (T2b) or the
--     unit conversions are not exactly what v34 seeded (a label, a state,
--     a proof, a retirement or an extra row is a use of its own);
--   * a Metrics Core connection carries a source instance (T7) - dropping
--     the two columns would erase an instance identity;
--   * a foreign key of another table points at an M1 table;
--   * any migrations_v2 migration newer than v34 is recorded.
-- After any of these the only way forward is a new migration.
--
-- One transaction: everything or nothing. Waits are bounded: a stalled
-- transaction that holds one of the tables makes this script fail after 5 s.
-- Run it as one script that stops at the first error
-- (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open transaction is
-- aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') then
    raise exception 'v34 rollback refused: v34 is not recorded on this database';
  end if;
end $$;

lock table training_load.source_metric_audit, training_load.metric_value_source_provenance,
  training_load.source_metric_mapping_activations, training_load.source_metric_mapping_versions,
  training_load.source_metric_mappings, training_load.source_metric_definition_versions,
  training_load.source_metric_definitions, training_load.unit_conversions in access exclusive mode;
lock table training_load.metric_source_connections, training_load.source_host_catalog in share row exclusive mode;

do $$
declare
  v34 constant text := 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql';
  hypothesis constant text := 'Expected unit is a hypothesis from the e03 pilot; not proven on server3.';
  burst_note constant text := 'Expected unit is a hypothesis from the e03 pilot; not proven on server3. The observed unit "number" is a shape; the meaning is unconfirmed.';
  compat constant text := 'docs/ai/gpexe-rest-v1-compatibility.md#2-the-table';
  d5 constant text := 'docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed';
  reasons text[] := '{}';
  n bigint;
  newer text;
  external_refs text;
begin
  select count(*) into n from training_load.source_metric_mappings;
  if n > 0 then reasons := reasons || format('%s source metric mapping(s) exist', n); end if;
  select count(*) into n from training_load.source_metric_mapping_versions;
  if n > 0 then reasons := reasons || format('%s mapping version(s) exist', n); end if;
  select count(*) into n from training_load.source_metric_mapping_activations;
  if n > 0 then reasons := reasons || format('%s activation(s) exist', n); end if;
  select count(*) into n from training_load.metric_value_source_provenance;
  if n > 0 then reasons := reasons || format('%s provenance row(s) exist', n); end if;
  select count(*) into n from training_load.source_metric_audit;
  if n > 0 then reasons := reasons || format('%s audit row(s) exist', n); end if;

  if (select count(*) from training_load.source_metric_definitions) <> 9 or exists (
       select source_system, api_family, source_metric_key, source_label, state, retired_by_user_id, retired_at,
              retired_reason, created_by_user_id, seed_migration
         from training_load.source_metric_definitions
       except
       select 'gpexe', 'rest_v1', s.k, s.l, 'active', null::uuid, null::timestamptz, null::text, null::uuid, v34
         from (values
           ('athlete_session.total_time', 'TIME'),
           ('athlete_session.total_distance', 'TotDist'),
           ('athlete_session.max_v', 'SPEEDmax'),
           ('more.complementary_data.power.distance', 'Power zone distance'),
           ('more.complementary_data.speed.distance', 'Speed zone distance'),
           ('more.events.acceleration_events_count', 'Acceleration events'),
           ('more.events.deceleration_events_count', 'Deceleration events'),
           ('details.players.tot_burst_events', 'Burst events'),
           ('details.players.tot_brake_events', 'Brake events')) as s (k, l)) then
    reasons := reasons || 'the source metric definitions are not exactly the v34 seed'::text;
  end if;

  if (select count(*) from training_load.source_metric_definition_versions) <> 9 or exists (
       select d.source_metric_key, v.revision_number, v.value_shape, v.parameter_kind, v.supports_session, v.supports_drill,
              v.expected_source_unit, v.expected_source_bound_unit, v.unit_note, v.source_unit, v.source_bound_unit, v.bound_operator,
              v.unit_verified_by_user_id, v.unit_verified_at, v.unit_evidence_ref, v.meaning_verified_by_user_id, v.meaning_verified_at,
              v.meaning_evidence_ref, v.evidence_status, v.evidence_ref, v.state, v.activated_by_user_id, v.retired_by_user_id,
              v.retired_at, v.retired_reason, v.created_by_user_id, v.seed_migration, (v.activated_at is not null)
         from training_load.source_metric_definition_versions v
         join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id
       except
       select s.k, 1, s.shape, s.kind, true, true, s.unit, s.bound_unit, s.note, null::text, null::text, null::text,
              null::uuid, null::timestamptz, null::text, null::uuid, null::timestamptz,
              null::text, 'observed', compat, 'active', null::uuid, null::uuid,
              null::timestamptz, null::text, null::uuid, v34, true
         from (values
           ('athlete_session.total_time', 'number', 'none', 's', null::text, hypothesis),
           ('athlete_session.total_distance', 'number', 'none', 'm', null::text, hypothesis),
           ('athlete_session.max_v', 'number', 'none', 'm/s', null::text, hypothesis),
           ('more.complementary_data.power.distance', 'zone_distance', 'zone_bounds', 'm', 'W/kg', hypothesis),
           ('more.complementary_data.speed.distance', 'zone_distance', 'zone_bounds', 'm', 'm/s', hypothesis),
           ('more.events.acceleration_events_count', 'event_count', 'event_threshold', 'count', null::text, hypothesis),
           ('more.events.deceleration_events_count', 'event_count', 'event_threshold', 'count', null::text, hypothesis),
           ('details.players.tot_burst_events', 'unit_value_object', 'none', 'count', null::text, burst_note),
           ('details.players.tot_brake_events', 'unit_value_object', 'none', 'count', null::text, burst_note))
           as s (k, shape, kind, unit, bound_unit, note)) then
    reasons := reasons || 'the source metric revisions are not exactly the v34 seed'::text;
  end if;

  if (select count(*) from training_load.unit_conversions) <> 4 or exists (
       select from_unit, to_unit, scale::text, scale_divisor::text, "offset"::text, state, retired_by_user_id, retired_at,
              retired_reason, evidence_ref, created_by_user_id, seed_migration
         from training_load.unit_conversions
       except
       select s.f, s.t, s.sc, s.dv, '0', 'active', null::uuid, null::timestamptz, null::text, d5, null::uuid, v34
         from (values ('s', 'min', '1', '60'), ('m/s', 'km/h', '3.6', '1'), ('m', 'km', '0.001', '1'), ('km/h', 'm/s', '1', '3.6'))
           as s (f, t, sc, dv)) then
    reasons := reasons || 'the unit conversions are not exactly the v34 seed'::text;
  end if;

  select count(*) into n from training_load.metric_source_connections
   where source_host_key is not null or source_instance_key is not null;
  if n > 0 then reasons := reasons || format('%s Metrics Core connection(s) carry a source instance', n); end if;

  select string_agg(distinct c.conrelid::regclass::text, ', ') into external_refs
    from pg_constraint c
   where c.contype = 'f'
     and c.confrelid in ('training_load.source_metric_definitions'::regclass, 'training_load.source_metric_definition_versions'::regclass,
                         'training_load.source_metric_mappings'::regclass, 'training_load.unit_conversions'::regclass,
                         'training_load.source_metric_mapping_versions'::regclass, 'training_load.source_metric_mapping_activations'::regclass,
                         'training_load.metric_value_source_provenance'::regclass, 'training_load.source_metric_audit'::regclass)
     and c.conrelid not in ('training_load.source_metric_definitions'::regclass, 'training_load.source_metric_definition_versions'::regclass,
                            'training_load.source_metric_mappings'::regclass, 'training_load.unit_conversions'::regclass,
                            'training_load.source_metric_mapping_versions'::regclass, 'training_load.source_metric_mapping_activations'::regclass,
                            'training_load.metric_value_source_provenance'::regclass, 'training_load.source_metric_audit'::regclass);
  if external_refs is not null then
    reasons := reasons || format('other tables reference the M1 tables: %s', external_refs);
  end if;

  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name collate "C" > v34 collate "C";
  if newer is not null then
    reasons := reasons || format('later migrations are applied: %s', newer);
  end if;

  if cardinality(reasons) > 0 then
    raise exception 'v34 rollback refused: %; only a forward migration is allowed', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger metric_definitions_source_metric_guard on training_load.metric_definitions;
drop trigger metric_definition_scope_capabilities_source_metric_guard on training_load.metric_definition_scope_capabilities;
drop trigger metric_source_connections_instance_write_once on training_load.metric_source_connections;
drop trigger source_host_catalog_api_family_immutable on training_load.source_host_catalog;

drop table training_load.source_metric_audit;
drop table training_load.metric_value_source_provenance;
drop table training_load.source_metric_mapping_activations;
drop table training_load.source_metric_mapping_versions;
drop table training_load.source_metric_mappings;
drop table training_load.source_metric_definition_versions;
drop table training_load.source_metric_definitions;
drop table training_load.unit_conversions;

alter table training_load.source_team_bindings drop constraint source_team_bindings_id_team_key;
drop index training_load.metric_source_connections_one_active_instance;
alter table training_load.metric_source_connections
  drop constraint metric_source_connections_source_instance_together,
  drop column source_host_key,
  drop column source_instance_key;
alter table training_load.source_host_catalog drop column api_family;

drop function training_load.source_metric_audit_insert_guard();
drop function training_load.source_metric_audit_row_ok(text, text, text, text, text, text, text);
drop function training_load.metric_value_provenance_insert_guard();
drop function training_load.metric_source_connections_instance_write_once();
drop function training_load.source_metric_activations_update_guard();
drop function training_load.source_metric_activations_insert_guard();
drop function training_load.source_metric_guard_scope_capability();
drop function training_load.source_metric_guard_canonical_definition();
drop function training_load.source_metric_mapping_versions_update_guard();
drop function training_load.source_metric_mapping_versions_insert_guard();
drop function training_load.source_metric_check_parameters(text, text, text, jsonb, jsonb, jsonb, numeric, numeric, numeric, boolean);
drop function training_load.source_metric_check_conversion(text, text, numeric, numeric, numeric, boolean);
drop function training_load.source_metric_check_levels(uuid, boolean, boolean, boolean);
drop function training_load.unit_conversions_guard();
drop function training_load.source_metric_mappings_guard();
drop function training_load.source_metric_revisions_guard();
drop function training_load.source_metric_definitions_guard();
drop function training_load.source_host_catalog_api_family_immutable();
drop function training_load.source_metric_append_only();
drop function training_load.source_metric_no_truncate();
drop function training_load.source_metric_require_seed_window(text);
drop function training_load.source_metric_require_club_admin(uuid, uuid);
drop function training_load.source_metric_require_platform_admin(uuid);
drop function training_load.source_metric_value_matches(numeric, numeric, numeric, numeric, numeric);
drop function training_load.source_metric_parameter_fingerprint(text, jsonb);
drop function training_load.source_metric_parameters_shape_ok(text, text, jsonb);
drop function training_load.source_metric_numeric_finite(numeric);
drop function training_load.source_metric_evidence_ref_ok(text);
drop function training_load.source_metric_unit_token_ok(text);
drop function training_load.source_metric_text_ok(text, integer);

do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'training_load'
                and c.relname in ('source_metric_definitions', 'source_metric_definition_versions', 'source_metric_mappings',
                                  'unit_conversions', 'source_metric_mapping_versions', 'source_metric_mapping_activations',
                                  'metric_value_source_provenance', 'source_metric_audit')) then
    raise exception 'v34 rollback refused: an M1 table is still there';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'training_load' and (p.proname like 'source_metric%' or p.proname in (
                'unit_conversions_guard', 'metric_value_provenance_insert_guard', 'metric_source_connections_instance_write_once',
                'source_host_catalog_api_family_immutable'))) then
    raise exception 'v34 rollback refused: an M1 function is still there';
  end if;
end $$;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql';

commit;
