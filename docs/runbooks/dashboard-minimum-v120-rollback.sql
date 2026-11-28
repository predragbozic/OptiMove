-- Drain application instances that can write Minimum before running.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
set local search_path=pg_catalog, public;
do $gate$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v120 rollback refused: the migration runner is active';
  end if;
end;
$gate$;
lock table public.schema_migrations in share row exclusive mode;
lock table training_load.dashboard_widget_series in access exclusive mode;
do $gate$
begin
  if not exists (select from public.schema_migrations
    where migration_name='migrations_v2/202612211000_training_load_v119_sources_provider_team_pointer_generations.sql'
      and checksum='55178f2f8ed4cdb7a738431383997532b15d4b03f7001b76004e1119029df99d') then
    raise exception 'The exact v119 predecessor is missing';
  end if;
  if not exists (select from public.schema_migrations
    where migration_name='migrations_v2/202612221000_training_load_v120_dashboard_minimum.sql'
      and checksum='9ef591f0ed43fb776f6eecb1a820087b78792d755c85eb219333ce1a5a7010b7')
    or exists (select from public.schema_migrations
      where migration_name>='migrations_v2/202612221000'
        and migration_name<>'migrations_v2/202612221000_training_load_v120_dashboard_minimum.sql') then
    raise exception 'The exact v120 migration must be the latest migration';
  end if;
  if not exists (
    select from pg_constraint c
    where c.conrelid='training_load.dashboard_widget_series'::regclass
      and c.conname='dashboard_widget_series_analytical_aggregation_check'
      and c.contype='c' and c.convalidated and not c.connoinherit
      and regexp_replace(pg_get_constraintdef(c.oid), '::(character varying|text)(\[\])?|[()[:space:]]', '', 'g')
        = 'CHECKanalytical_aggregation=ANYARRAY[''sum'',''avg'',''min'',''max'',''last'',''none'',''ratio'']'
  ) then
    raise exception 'The dashboard analytical aggregation CHECK does not match v120';
  end if;
  if not exists (
    select from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where t.tgrelid='training_load.dashboard_widget_series'::regclass
      and t.tgname='dashboard_widget_series_validate_aggregation_type_compat'
      and t.tgfoid=to_regprocedure('training_load.dashboard_widget_series_validate_aggregation_type_compat()')
      and t.tgenabled='O' and t.tgtype=23 and not t.tgisinternal and t.tgqual is null and t.tgnargs=0
      and t.tgattr::text=(
        select string_agg(a.attnum::text, ' ' order by cols.ordinality)
        from unnest(array['metric_definition_id','built_in_series_key','analytical_aggregation'])
          with ordinality as cols(name, ordinality)
        join pg_attribute a on a.attrelid=t.tgrelid and a.attname=cols.name and not a.attisdropped
      )
      and md5(p.prosrc)='259f15ee79a08434b0439ebd0a3daff4'
  ) then
    raise exception 'The dashboard numeric/type/ratio guard differs from the v79 contract';
  end if;
  if exists (select from training_load.dashboard_widget_series where analytical_aggregation='min') then
    raise exception 'v120 rollback refused: saved Minimum series exist';
  end if;
end;
$gate$;

alter table training_load.dashboard_widget_series
  drop constraint dashboard_widget_series_analytical_aggregation_check,
  add constraint dashboard_widget_series_analytical_aggregation_check
    check (analytical_aggregation in ('sum', 'avg', 'max', 'last', 'none', 'ratio'));

delete from public.schema_migrations
where migration_name='migrations_v2/202612221000_training_load_v120_dashboard_minimum.sql'
  and checksum='9ef591f0ed43fb776f6eecb1a820087b78792d755c85eb219333ce1a5a7010b7';
commit;
select true as v120_rollback_ok;
