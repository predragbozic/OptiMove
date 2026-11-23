-- P1 A rollback: only a closed, Home-only database, with no later migration.
-- The runner must no longer contain v90 before restarting after this manual rollback.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $guard$
begin
 if not pg_try_advisory_xact_lock(822026) then raise exception 'v90 rollback refused: migrator active' using errcode='23514'; end if;
 if (select checksum from public.schema_migrations where migration_name='migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql') is distinct from 'dcfb07b959cc886fa1b3f99faad6916288d19448b837ebffbdb36b0aefc0bbaf' then raise exception 'v90 rollback refused: migration checksum mismatch' using errcode='23514';end if;
 if not exists(select 1 from public.schema_migrations where migration_name='migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql') then
  raise exception 'v90 rollback refused: not recorded' using errcode='23514';
 end if;
 if exists(select 1 from public.schema_migrations where migration_name > 'migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql') then
  raise exception 'v90 rollback refused: later migration' using errcode='23514';
 end if;
end
$guard$;
lock table training_load.dashboards in access exclusive mode;
lock table training_load.dashboard_widgets in access exclusive mode;
lock table training_load.dashboard_widget_series in access exclusive mode;
lock table training_load.dashboard_pages in access exclusive mode;
do $guard$
begin
 if exists(select 1 from training_load.dashboard_pages_activation where enabled)
 or exists(select 1 from training_load.dashboard_pages where not is_home or name<>'Home' or position<>0 or period_config is not null)
 or exists(select 1 from training_load.dashboard_widgets w join training_load.dashboard_pages p on p.id=w.page_id where not p.is_home)
 or exists(select 1 from training_load.dashboards d left join training_load.dashboard_pages p on p.dashboard_id=d.id and p.is_home
           where p.id is null or p.default_filter is distinct from d.default_filter) then
  raise exception 'v90 rollback refused: Page state is not legacy compatible' using errcode='23514';
 end if;
end
$guard$;
do $current_a$
begin
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.assert_dashboard_writable(uuid)')) is distinct from 'f87c11a22a39517c37fbf1e4f117a69b' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.current_dashboard_page(uuid)')) is distinct from '5deeaf70aefbc0655f262cc94f3c9dc8' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_home_required()')) is distinct from 'a0f385cf24691b3389e2397d23ae4c07' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_home_sync_defaults()')) is distinct from '70f38353a470245079231daf2ee93478' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_page_context_matches(uuid)')) is distinct from '79ae2ff5f31f2cd8dffff2c40402147e' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_page_period_valid(jsonb)')) is distinct from 'de37086fc382ec8b50173412cd8b1924' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widget_assign_home()')) is distinct from '673f26f5b9949bb1241b0d5d884b2458' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widget_bump_page_revision()')) is distinct from 'b3ab8b1d33176e95fa5f9352ea0ddea7' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widgets_check_no_overlap()')) is distinct from '96b0f3fed42ce4eca49a13468d44b838' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.delete_dashboard(uuid,integer,uuid,character varying)')) is distinct from '19453ff4134447c03da1a2db1147dd27' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.ensure_dashboard_home()')) is distinct from 'f5666f32e7fd0a2dfcf2fc8e1faf4c25' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_dashboard_page_identity()')) is distinct from '60599a027271957e8aa6d1c23a74c030' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_dashboard_widget_page_protocol()')) is distinct from '4915decb92f583bf2b75d8dd30d478d0' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)')) is distinct from '33c8f87b3104a723f4c4d140d8922b43' then raise exception 'v90 rollback refused: function body changed' using errcode='23514';end if;
end
$current_a$;
CREATE OR REPLACE FUNCTION training_load.assert_dashboard_writable(p_dashboard_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_status varchar;
begin
  select status into v_status from training_load.dashboards where id = p_dashboard_id;
  if v_status = 'archived' then
    raise exception 'dashboard % is archived — read-only (query/clone/metadata/layout/widget/series writes are all refused)', p_dashboard_id using errcode = '40002';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION training_load.dashboard_widgets_check_no_overlap()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_conflict record;
begin
  select a.id as a_id, b.id as b_id into v_conflict
    from training_load.dashboard_widgets a
    join training_load.dashboard_widgets b on b.dashboard_id = a.dashboard_id and b.id <> a.id
      and a.x < b.x + b.width and b.x < a.x + a.width
      and a.y < b.y + b.height and b.y < a.y + a.height
    where a.dashboard_id = new.dashboard_id
    limit 1;
  if v_conflict.a_id is not null then
    raise exception 'dashboard_widgets: final layout still has an overlap between widgets % and % on dashboard %', v_conflict.a_id, v_conflict.b_id, new.dashboard_id;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION training_load.delete_dashboard(p_dashboard_id uuid, p_expected_revision integer, p_deleted_by_user_id uuid, p_authorized_via character varying)
 RETURNS TABLE(out_dashboard_id uuid, out_log_id uuid)
 LANGUAGE plpgsql
AS $function$
declare
  -- %rowtype is resolved at call time: renaming/dropping one of the
  -- dashboards columns read below breaks this function on its next call,
  -- not when that later migration is applied (db-reviewer) - grep for
  -- dashboards%rowtype before changing those columns.
  v_row training_load.dashboards%rowtype;
  v_widget_count integer;
  v_series_count integer;
  v_log_id uuid;
begin
  select * into v_row from training_load.dashboards where id = p_dashboard_id for update;
  if not found then
    -- P0002 (no_data_found), not a bare P0001: the route maps a bare
    -- P0001 to 400 invalidRequest, but a dashboard deleted by a concurrent
    -- request while this one waited on the row lock must read as 404, the
    -- same as any other dashboard that no longer exists.
    raise exception 'delete_dashboard: dashboard % not found', p_dashboard_id using errcode = 'P0002';
  end if;
  if v_row.revision <> p_expected_revision then
    raise exception 'delete_dashboard: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_row.revision using errcode = '40001';
  end if;
  -- Read under the dashboard lock: every widget/series write locks the
  -- dashboard row first (ADR-003), so these counts cannot move before the
  -- delete below.
  select count(*) into v_widget_count from training_load.dashboard_widgets w where w.dashboard_id = p_dashboard_id;
  select count(*) into v_series_count from training_load.dashboard_widget_series s
    join training_load.dashboard_widgets w on w.id = s.widget_id where w.dashboard_id = p_dashboard_id;
  -- Logged BEFORE the delete, in the same transaction: if the delete
  -- below fails (e.g. 23503, a clone still references this dashboard) the
  -- log row rolls back with it.
  insert into training_load.dashboard_deletion_log (
    deleted_by_user_id, authorized_via, dashboard_id, dashboard_name, owner_scope,
    owner_user_id, owner_club_id, owner_team_id, data_workspace_type, data_workspace_scope_id,
    is_template, status, revision, widget_count, series_count,
    dashboard_created_by_user_id, dashboard_created_at
  ) values (
    p_deleted_by_user_id, p_authorized_via, v_row.id, v_row.name, v_row.owner_scope,
    v_row.owner_user_id, v_row.owner_club_id, v_row.owner_team_id, v_row.data_workspace_type, v_row.data_workspace_scope_id,
    v_row.is_template, v_row.status, v_row.revision, v_widget_count, v_series_count,
    v_row.created_by_user_id, v_row.created_at
  ) returning id into v_log_id;
  delete from training_load.dashboard_active_selection where dashboard_id = p_dashboard_id;
  -- The cascade fires v16's after-delete triggers on each widget/series,
  -- which call bump_dashboard_revision()/bump the parent widget. Their
  -- UPDATE targets a row this same transaction just deleted, so it simply
  -- matches 0 rows - no error, no cross-transaction conflict (db-reviewer).
  delete from training_load.dashboards where id = p_dashboard_id;
  return query select p_dashboard_id, v_log_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION training_load.save_simple_widget(p_initiator_user_id uuid, p_request_id uuid, p_payload_hash text, p_request_issued_at timestamp with time zone, p_dashboard_id uuid, p_widget_id uuid, p_expected_widget_revision integer, p_widget jsonb, p_resolved_period jsonb, p_workspace jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  recorded_request training_load.dashboard_simple_requests%rowtype;
  locked_dashboard training_load.dashboards%rowtype;
  locked_widget training_load.dashboard_widgets%rowtype;
  locked_series training_load.dashboard_widget_series%rowtype;
  widget_catalog training_load.dashboard_widget_types%rowtype;
  desired_widget training_load.dashboard_widgets%rowtype;
  desired_series training_load.dashboard_widget_series%rowtype;
  compiled_series jsonb;
  actual_widget_id uuid;
  actual_series_id uuid;
  widget_count integer;
  next_order integer;
  next_mobile_order integer;
  placement_x smallint;
  placement_y smallint;
  binding_changed boolean;
  retained_pin boolean := false;
  series_changed boolean;
  widget_changed boolean;
  period_start date;
  period_end date;
  operation_name text;
  saved_receipt jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('dashboard-simple:' || p_initiator_user_id::text || ':' || p_request_id::text, 0));
  if p_initiator_user_id is null or p_request_id is null or p_dashboard_id is null
    or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_request_issued_at is null or not isfinite(p_request_issued_at)
    or date_trunc('milliseconds', p_request_issued_at) is distinct from p_request_issued_at
    or jsonb_typeof(p_workspace) is distinct from 'object'
    or jsonb_typeof(p_resolved_period) is distinct from 'object' then
    raise exception 'invalidRequest' using errcode = 'S2C05';
  end if;
  select dashboard.* into locked_dashboard from training_load.dashboards dashboard where dashboard.id = p_dashboard_id for update;
  if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
  select request.* into recorded_request from training_load.dashboard_simple_requests request
    where request.initiator_user_id = p_initiator_user_id and request.request_id = p_request_id;
  if found then
    if recorded_request.payload_hash is distinct from p_payload_hash
      or recorded_request.dashboard_id is distinct from p_dashboard_id
      or recorded_request.widget_id is distinct from p_widget_id
      or recorded_request.workspace is distinct from p_workspace
      or recorded_request.request_issued_at is distinct from p_request_issued_at
      or recorded_request.resolved_period is distinct from p_resolved_period then
      raise exception 'idempotencyConflict' using errcode = 'S2C01';
    end if;
    if clock_timestamp() > recorded_request.retain_until then
      raise exception 'requestExpired' using errcode = 'S2C06';
    end if;
    perform 1 from training_load.dashboard_widgets widget
      where widget.id = (recorded_request.receipt ->> 'widgetId')::uuid and widget.dashboard_id = p_dashboard_id for update;
    if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
    return recorded_request.receipt;
  end if;
  if p_request_issued_at < clock_timestamp() - interval '168 hours' then
    raise exception 'requestExpired' using errcode = 'S2C06';
  end if;
  if p_request_issued_at > clock_timestamp() + interval '1 second' then
    raise exception 'invalidRequestIssuedAt' using errcode = 'S2C05';
  end if;
  if not training_load.dashboard_simple_object(p_resolved_period, array['dateFrom','dateTo','timeZone'], array['dateFrom','dateTo','timeZone'])
    or jsonb_typeof(p_resolved_period -> 'dateFrom') is distinct from 'string'
    or jsonb_typeof(p_resolved_period -> 'dateTo') is distinct from 'string'
    or jsonb_typeof(p_resolved_period -> 'timeZone') is distinct from 'string'
    or p_resolved_period ->> 'dateFrom' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or p_resolved_period ->> 'dateTo' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or btrim(p_resolved_period ->> 'timeZone') = '' then
    raise exception 'invalidResolvedPeriod' using errcode = 'S2C05';
  end if;
  begin
    period_start := (p_resolved_period ->> 'dateFrom')::date;
    period_end := (p_resolved_period ->> 'dateTo')::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalidResolvedPeriod' using errcode = 'S2C05';
  end;
  if period_end < period_start or period_end - period_start >= 400 then
    raise exception 'invalidResolvedPeriod' using errcode = 'S2C05';
  end if;
  perform training_load.assert_dashboard_writable(p_dashboard_id);
  if locked_dashboard.is_template or locked_dashboard.data_workspace_type is null then
    raise exception 'advancedRequired' using errcode = 'S2C04';
  end if;
  if jsonb_typeof(p_widget) is distinct from 'object' or jsonb_typeof(p_widget -> 'series') is distinct from 'array' then
    raise exception 'invalidCompiledWidget' using errcode = 'S2C05';
  end if;
  if jsonb_array_length(p_widget -> 'series') <> 1 then
    raise exception 'advancedRequired' using errcode = 'S2C04';
  end if;
  compiled_series := p_widget -> 'series' -> 0;
  if jsonb_typeof(compiled_series) is distinct from 'object'
    or not (p_widget ?& array['id','widget_type','title','group_by','display_config','presentation_config','local_filter_override'])
    or not (compiled_series ?& array['id','resolution_status','metric_definition_id','built_in_series_key','series_order','axis',
      'source_policy','source_connection_id','data_scope_level','analytical_aggregation','aggregation_role_policy','coverage_policy','comparison_period'])
    or compiled_series ->> 'resolution_status' is distinct from 'resolved'
    or compiled_series -> 'template_metric_key_hints' is not null and compiled_series -> 'template_metric_key_hints' <> 'null'::jsonb
    or compiled_series -> 'template_resolution_candidates' is not null and compiled_series -> 'template_resolution_candidates' <> 'null'::jsonb then
    raise exception 'invalidCompiledWidget' using errcode = 'S2C05';
  end if;
  if p_widget_id is not null then
    select widget.* into locked_widget from training_load.dashboard_widgets widget
      where widget.id = p_widget_id and widget.dashboard_id = p_dashboard_id for update;
    if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
    if locked_widget.revision is distinct from p_expected_widget_revision then
      raise exception 'staleRevision' using errcode = '40001';
    end if;
    perform 1 from training_load.dashboard_widget_series series where series.widget_id = p_widget_id order by series.id for update;
    select count(*) into widget_count from training_load.dashboard_widget_series series where series.widget_id = p_widget_id;
    if widget_count <> 1 then raise exception 'advancedRequired' using errcode = 'S2C04'; end if;
    select series.* into locked_series from training_load.dashboard_widget_series series where series.widget_id = p_widget_id;
    if locked_series.resolution_status <> 'resolved' or locked_series.template_metric_key_hints is not null
      or locked_series.template_resolution_candidates is not null then
      raise exception 'advancedRequired' using errcode = 'S2C04';
    end if;
  elsif p_expected_widget_revision is not null then
    raise exception 'invalidCreateRevision' using errcode = 'S2C05';
  end if;
  select * into desired_widget from jsonb_populate_record(null::training_load.dashboard_widgets,
    jsonb_build_object('widget_type', p_widget -> 'widget_type', 'title', p_widget -> 'title',
      'group_by', p_widget -> 'group_by', 'display_config', p_widget -> 'display_config',
      'presentation_config', p_widget -> 'presentation_config', 'local_filter_override', p_widget -> 'local_filter_override'));
  select * into desired_series from jsonb_populate_record(null::training_load.dashboard_widget_series, compiled_series);
  if desired_widget.widget_type is null or desired_widget.title is null or desired_widget.group_by is null
    or desired_widget.display_config is null or desired_series.id is null or (p_widget ->> 'id') is null then
    raise exception 'invalidCompiledWidget' using errcode = 'S2C05';
  end if;
  perform (p_widget ->> 'id')::uuid;
  select catalog.* into widget_catalog from training_load.dashboard_widget_types catalog
    where catalog.key = desired_widget.widget_type for share;
  if not found or not widget_catalog.is_active then raise exception 'advancedRequired' using errcode = 'S2C04'; end if;
  if desired_series.metric_definition_id is not null then
    perform 1 from training_load.metric_definitions definition where definition.id = desired_series.metric_definition_id for share;
    if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
    if not exists (select 1 from training_load.metric_definitions definition
      join training_load.metric_definition_versions version on version.id = definition.current_version_id
      where definition.id = desired_series.metric_definition_id and definition.state = 'active'
        and version.value_type in ('numeric','text','boolean') and (
          definition.owner_scope = 'system'
          or definition.owner_scope = 'user' and locked_dashboard.owner_scope = 'user' and definition.owner_user_id = locked_dashboard.owner_user_id
          or definition.owner_scope = 'club' and locked_dashboard.data_workspace_type = 'club' and definition.owner_club_id = locked_dashboard.data_workspace_scope_id
          or definition.owner_scope = 'team' and locked_dashboard.data_workspace_type = 'team' and definition.owner_team_id = locked_dashboard.data_workspace_scope_id
        )) then raise exception 'notFound' using errcode = 'S2C07'; end if;
  end if;
  if desired_series.built_in_series_key is not null then
    perform 1 from training_load.dashboard_builtin_series builtin where builtin.key = desired_series.built_in_series_key for share;
    if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
    if not exists (select 1 from training_load.dashboard_builtin_series builtin
      where builtin.key = desired_series.built_in_series_key and builtin.is_active) then
      raise exception 'notFound' using errcode = 'S2C07';
    end if;
  end if;
  if desired_series.source_connection_id is not null then
    select connection.state = 'inactive' into retained_pin from training_load.metric_source_connections connection
      where connection.id = desired_series.source_connection_id for share;
    if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
    retained_pin := retained_pin and p_widget_id is not null
      and locked_series.widget_id = locked_widget.id
      and desired_series.id = locked_series.id
      and (p_widget ->> 'id')::uuid = locked_widget.id
      and locked_series.source_policy = 'source_connection'
      and desired_series.source_policy = locked_series.source_policy
      and desired_series.source_connection_id = locked_series.source_connection_id
      and desired_series.metric_definition_id is not distinct from locked_series.metric_definition_id
      and desired_series.built_in_series_key is not distinct from locked_series.built_in_series_key;
    if not exists (select 1 from training_load.metric_source_connections connection
      where connection.id = desired_series.source_connection_id
      and (connection.state = 'active' or connection.state = 'inactive' and retained_pin) and (
        connection.owner_scope = 'system'
        or connection.owner_scope = 'user' and locked_dashboard.owner_scope = 'user' and connection.owner_user_id = locked_dashboard.owner_user_id
        or connection.owner_scope = 'club' and locked_dashboard.data_workspace_type = 'club' and connection.owner_club_id = locked_dashboard.data_workspace_scope_id
        or connection.owner_scope = 'team' and locked_dashboard.data_workspace_type = 'team' and connection.owner_team_id = locked_dashboard.data_workspace_scope_id
      )) then raise exception 'notFound' using errcode = 'S2C07'; end if;
  end if;
  perform training_load.dashboard_presentation_assert_compatible(
    desired_widget.presentation_config, desired_widget.widget_type, desired_widget.group_by);
  if p_widget_id is null then
    if training_load.dashboard_presentation_opaque(desired_widget.presentation_config) then
      raise exception 'unsupportedPresentation' using errcode = 'S2C03';
    end if;
    select coalesce(max(widget.widget_order), -1) + 1, coalesce(max(widget.mobile_order), -1) + 1
      into next_order, next_mobile_order
      from training_load.dashboard_widgets widget where widget.dashboard_id = p_dashboard_id;
    select candidate_x.x::smallint, candidate_y.y::smallint into placement_x, placement_y
      from (
        select 0 as y
        union
        select widget.y::integer + widget.height from training_load.dashboard_widgets widget where widget.dashboard_id = p_dashboard_id
      ) candidate_y
      cross join generate_series(0, 12 - widget_catalog.default_width) candidate_x(x)
      where candidate_y.y <= 32767 - widget_catalog.default_height and not exists (
        select 1 from training_load.dashboard_widgets widget where widget.dashboard_id = p_dashboard_id
          and candidate_x.x < widget.x + widget.width and widget.x < candidate_x.x + widget_catalog.default_width
          and candidate_y.y < widget.y::integer + widget.height and widget.y < candidate_y.y + widget_catalog.default_height
      ) order by candidate_y.y, candidate_x.x limit 1;
    if placement_x is null then raise exception 'layoutCapacityExceeded' using errcode = 'S2C04'; end if;
    insert into training_load.dashboard_widgets (
      dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order,
      group_by, display_config, local_filter_override, presentation_config
    ) values (
      p_dashboard_id, desired_widget.widget_type, desired_widget.title, next_order, placement_x, placement_y,
      widget_catalog.default_width, widget_catalog.default_height, next_mobile_order,
      desired_widget.group_by, desired_widget.display_config, desired_widget.local_filter_override, desired_widget.presentation_config
    ) returning id into actual_widget_id;
    operation_name := 'created';
  else
    actual_widget_id := locked_widget.id;
    actual_series_id := locked_series.id;
    binding_changed := desired_series.metric_definition_id is distinct from locked_series.metric_definition_id
      or desired_series.built_in_series_key is distinct from locked_series.built_in_series_key;
    series_changed := binding_changed or desired_series.axis is distinct from locked_series.axis
      or desired_series.source_policy is distinct from locked_series.source_policy
      or desired_series.source_connection_id is distinct from locked_series.source_connection_id
      or desired_series.data_scope_level is distinct from locked_series.data_scope_level
      or desired_series.analytical_aggregation is distinct from locked_series.analytical_aggregation
      or desired_series.aggregation_role_policy is distinct from locked_series.aggregation_role_policy
      or desired_series.coverage_policy is distinct from locked_series.coverage_policy
      or desired_series.comparison_period is distinct from locked_series.comparison_period;
    widget_changed := desired_widget.widget_type is distinct from locked_widget.widget_type
      or desired_widget.title is distinct from locked_widget.title or desired_widget.group_by is distinct from locked_widget.group_by
      or desired_widget.display_config is distinct from locked_widget.display_config
      or desired_widget.local_filter_override is distinct from locked_widget.local_filter_override
      or desired_widget.presentation_config is distinct from locked_widget.presentation_config;
    if series_changed then
      if training_load.dashboard_presentation_opaque(desired_widget.presentation_config) then
        raise exception 'presentationRevalidationRequired' using errcode = 'S2C03';
      end if;
      if locked_widget.presentation_config is not null then
        update training_load.dashboard_widgets set presentation_config=null where id=actual_widget_id;
      end if;
    end if;
    if not retained_pin and (binding_changed
      or locked_widget.widget_type is distinct from desired_widget.widget_type and series_changed) then
      delete from training_load.dashboard_widget_series series where series.id = locked_series.id;
      actual_series_id := null;
    end if;
    if widget_changed then
      update training_load.dashboard_widgets widget set
        widget_type = desired_widget.widget_type, title = desired_widget.title, group_by = desired_widget.group_by,
        display_config = desired_widget.display_config, local_filter_override = desired_widget.local_filter_override,
        presentation_config = case when series_changed then null else desired_widget.presentation_config end where widget.id = actual_widget_id;
    end if;
    if series_changed and actual_series_id is not null then
      update training_load.dashboard_widget_series series set
        axis = desired_series.axis, source_policy = desired_series.source_policy,
        source_connection_id = desired_series.source_connection_id, data_scope_level = desired_series.data_scope_level,
        analytical_aggregation = desired_series.analytical_aggregation, aggregation_role_policy = desired_series.aggregation_role_policy,
        coverage_policy = desired_series.coverage_policy, comparison_period = desired_series.comparison_period
        where series.id = actual_series_id;
    end if;
    operation_name := case when widget_changed or series_changed then 'updated' else 'unchanged' end;
  end if;
  if actual_series_id is null then
    insert into training_load.dashboard_widget_series (
      id, widget_id, series_order, metric_definition_id, built_in_series_key, resolution_status,
      axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation,
      aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id
    ) values (
      case when p_widget_id is not null and not binding_changed then locked_series.id else gen_random_uuid() end,
      actual_widget_id, case when p_widget_id is null then 0 else locked_series.series_order end,
      desired_series.metric_definition_id, desired_series.built_in_series_key, 'resolved',
      desired_series.axis, case when p_widget_id is null then desired_series.color else locked_series.color end,
      case when p_widget_id is null then desired_series.display_label else locked_series.display_label end,
      desired_series.source_policy, desired_series.source_connection_id, desired_series.data_scope_level,
      desired_series.analytical_aggregation, desired_series.aggregation_role_policy, desired_series.coverage_policy,
      desired_series.comparison_period, case when p_widget_id is null then p_initiator_user_id else locked_series.created_by_user_id end
    ) returning id into actual_series_id;
  end if;
  if p_widget_id is not null and series_changed and desired_widget.presentation_config is not null then
    update training_load.dashboard_widgets set presentation_config=desired_widget.presentation_config where id=actual_widget_id;
  end if;
  set constraints training_load.dashboard_widgets_check_no_overlap,
    training_load.dashboard_widgets_order_unique, training_load.dashboard_widgets_mobile_order_unique,
    training_load.dashboard_widget_series_order_unique immediate;
  select jsonb_build_object(
    'requestId', p_request_id, 'operation', operation_name, 'widgetId', actual_widget_id, 'seriesId', actual_series_id,
    'idMapping', jsonb_build_object('widget', jsonb_build_object('from', p_widget -> 'id', 'to', actual_widget_id),
      'series', jsonb_build_object('from', compiled_series -> 'id', 'to', actual_series_id)),
    'widgetRevision', widget.revision, 'dashboardRevision', dashboard.revision,
    'resolvedPeriod', p_resolved_period,
    'requestIssuedAt', to_char(p_request_issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) into saved_receipt from training_load.dashboard_widgets widget
    join training_load.dashboards dashboard on dashboard.id = widget.dashboard_id where widget.id = actual_widget_id;
  insert into training_load.dashboard_simple_requests (
    initiator_user_id, request_id, dashboard_id, widget_id, workspace, payload_hash,
    request_issued_at, resolved_period, receipt, retain_until
  ) values (
    p_initiator_user_id, p_request_id, p_dashboard_id, p_widget_id, p_workspace, p_payload_hash,
    p_request_issued_at, p_resolved_period, saved_receipt, p_request_issued_at + interval '168 hours 10 minutes'
  );
  return saved_receipt;
end;
$function$
;
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_order_unique;
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_mobile_order_unique;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_order_unique unique(dashboard_id,widget_order) deferrable initially deferred;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_mobile_order_unique unique(dashboard_id,mobile_order) deferrable initially deferred;
do $restored$
begin
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.assert_dashboard_writable(uuid)')) is distinct from '2570e150e7ab4df97a96d425e1d61b05' then
 raise exception 'v90 rollback: restored function body mismatch' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widgets_check_no_overlap()')) is distinct from '4d67afabd6f05ad36fcba27b9fdb5fb0' then
 raise exception 'v90 rollback: restored function body mismatch' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.delete_dashboard(uuid,integer,uuid,character varying)')) is distinct from '222271ed02f0816ed9b8688b2ff57091' then
 raise exception 'v90 rollback: restored function body mismatch' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)')) is distinct from 'a7e743e074cf1be5a61fb0b5aca9b060' then
 raise exception 'v90 rollback: restored function body mismatch' using errcode='23514';end if;
end
$restored$;
-- Remove only v90 additions. Existing v71 receipts and v19 logs are untouched.
drop trigger dashboards_require_home on training_load.dashboards;
drop trigger dashboard_pages_require_home on training_load.dashboard_pages;
drop trigger dashboards_sync_home_defaults on training_load.dashboards;
drop trigger dashboards_ensure_home on training_load.dashboards;
drop trigger dashboard_widgets_assign_home on training_load.dashboard_widgets;
drop trigger dashboard_widgets_bump_page on training_load.dashboard_widgets;
drop trigger dashboard_widgets_guard_page_protocol on training_load.dashboard_widgets;
drop trigger dashboard_pages_guard_identity on training_load.dashboard_pages;
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_page_fk;
drop index training_load.dashboard_widgets_page_idx;
alter table training_load.dashboard_widgets drop column page_id;
alter table training_load.dashboards drop column pages_revision;
drop table training_load.dashboard_pages;
drop table training_load.dashboard_pages_activation;
drop function training_load.dashboard_home_required();
drop function training_load.dashboard_home_sync_defaults();
drop function training_load.dashboard_widget_assign_home();
drop function training_load.guard_dashboard_page_identity();
drop function training_load.ensure_dashboard_home();
drop function training_load.dashboard_page_period_valid(jsonb);
drop function training_load.guard_dashboard_widget_page_protocol();
drop function training_load.current_dashboard_page(uuid);
drop function training_load.dashboard_page_context_matches(uuid);
drop function training_load.dashboard_widget_bump_page_revision();
delete from public.schema_migrations where migration_name='migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql';
commit;
