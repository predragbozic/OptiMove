-- Read-only PREFLIGHT for migration v79 (migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql); run
-- before the deploy that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes
-- nothing. Every block returns ok = true, or the stated counts.

-- 1. v78 (the one migration v79 depends on) is recorded and v79 is not. Other migrations (the calendar's v81) may be
--    recorded or not; the list is for the reader only.
select exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql') as v78_recorded,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql') as v79_absent,
       (select string_agg(migration_name, ', ' order by migration_name) from public.schema_migrations
         where migration_name > 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql') as recorded_after_v78;

-- 2. The four bodies v79 replaces are the ones in force (v77's shape and value guard, v78's version guard, v16's series guard).
select bool_and(case p.proname
         when 'metric_calculation_shape_ok' then md5(p.prosrc) = '2d2a17ae713005d116fc1ab96b783b9d'
         when 'metric_calculation_version_guard' then md5(p.prosrc) = 'eae4cc9d519a498ca7f4acf0bedbdcbd'
         when 'metric_calculation_value_guard' then md5(p.prosrc) = '22e88230de37aba4646d49cc49986f6f'
         when 'dashboard_widget_series_validate_aggregation_type_compat' then md5(p.prosrc) = 'dbd91e8d23f6bd729fc89e705c7424c8'
       end) as bodies_in_force,
       count(*) = 4 as four_bodies
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load'
   and p.proname in ('metric_calculation_shape_ok', 'metric_calculation_version_guard', 'metric_calculation_value_guard',
                     'dashboard_widget_series_validate_aggregation_type_compat');

-- 3. The two CHECKs v79 widens exist under their names, and nothing stored is of a kind v79 adds: every count 0.
select (select count(*) from pg_constraint where conname = 'metric_definition_versions_daily_aggregation_method_check') = 1 as day_rule_check,
       (select count(*) from pg_constraint where conname = 'dashboard_widget_series_analytical_aggregation_check') = 1 as series_check,
       (select count(*) from training_load.metric_definition_versions where calculation is not null and calculation ->> 'kind' <> 'sum') as other_kinds,
       (select count(*) from training_load.metric_definition_versions where calculation is not null) as calculated_versions;

-- 4. A quiet moment: no idle transaction and no lock wait (the migration takes metric_definition_versions' and
--    dashboard_widget_series' ACCESS EXCLUSIVE lock for the CHECK scan with a 5 s lock_timeout).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 5. The role you run this as owns (or is a member of the owner of) the two tables v79 alters.
select bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) as owns_tables
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and c.relname in ('metric_definition_versions', 'dashboard_widget_series');

-- 6. Condition 1 of the Rukovodilac's GO (the unit a ratio's denominator is stored in): every active mapping version that fills
--    a variable keyed 'duration', with its source field, its conversion and the variable's stored unit. Expected for the First
--    team: source_unit 's', target_unit 'min', scale 1 / scale_divisor 60, and the variable's unit 'min'. A ratio over that
--    variable divides by minutes; v79 writes its unit as '<numerator unit>/min' (from the stored units, never typed).
select d.key, d.owner_scope, dv.unit as stored_unit, mv.id as mapping_version_id, mv.status, f.source_metric_key as source_field,
       mv.source_unit, mv.target_unit, mv.scale, mv.scale_divisor, mv.applies_to_session, mv.applies_to_drill
  from training_load.source_metric_mapping_versions mv
  join training_load.source_metric_definitions f on f.id = mv.source_metric_definition_id
  join training_load.metric_definitions d on d.id = mv.metric_definition_id
  join training_load.metric_definition_versions dv on dv.id = d.current_version_id
 where d.key = 'duration' and mv.status = 'active'
 order by d.owner_scope, mv.id;
