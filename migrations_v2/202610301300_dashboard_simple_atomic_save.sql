alter table training_load.dashboard_widgets add column presentation_config jsonb;

create function training_load.dashboard_simple_object(
  p_value jsonb, p_allowed text[], p_required text[] default array[]::text[]
) returns boolean language sql immutable parallel safe as $$
  select case when jsonb_typeof(p_value) = 'object' then
    not exists (select 1 from jsonb_object_keys(p_value) entry(key) where not (entry.key = any(p_allowed)))
    and p_value ?& p_required
  else false end;
$$;

create function training_load.dashboard_presentation_valid(p_config jsonb)
returns boolean language plpgsql immutable parallel safe as $$
declare
  interactions jsonb;
  section jsonb;
begin
  if p_config is null then return true; end if;
  if jsonb_typeof(p_config) <> 'object'
    or jsonb_typeof(p_config -> 'schemaVersion') is distinct from 'number' then return false; end if;
  if (p_config ->> 'schemaVersion')::numeric < 1
    or trunc((p_config ->> 'schemaVersion')::numeric) <> (p_config ->> 'schemaVersion')::numeric
    or (p_config ->> 'schemaVersion')::numeric > 9007199254740991 then return false; end if;
  if (p_config ->> 'schemaVersion')::numeric <> 1 then return true; end if;
  if not training_load.dashboard_simple_object(p_config,
    array['schemaVersion','chartComposition','chartInteractions','tableFormatting'], array['schemaVersion']) then return false; end if;
  if p_config ? 'chartComposition' and p_config -> 'chartComposition' <> '"athletes-v1"'::jsonb then return false; end if;
  if p_config ? 'tableFormatting' then
    if p_config ?| array['chartComposition','chartInteractions'] then return false; end if;
    section := p_config -> 'tableFormatting';
    if not training_load.dashboard_simple_object(section, array['evaluationVersion','rules'], array['evaluationVersion','rules'])
      or section -> 'evaluationVersion' <> '1'::jsonb
      or jsonb_typeof(section -> 'rules') is distinct from 'array' then return false; end if;
    if jsonb_array_length(section -> 'rules') <> 0 then return false; end if;
  end if;
  if p_config ? 'chartInteractions' then
    interactions := p_config -> 'chartInteractions';
    if not training_load.dashboard_simple_object(interactions,
      array['tooltip','legend','zoom','pointSelection','yAxis']) then return false; end if;
    if interactions ? 'tooltip' then
      section := interactions -> 'tooltip';
      if not training_load.dashboard_simple_object(section, array['mode'], array['mode'])
        or not (section -> 'mode' = any(array['"exact"'::jsonb,'"formatted"'::jsonb])) then return false; end if;
    end if;
    if interactions ? 'legend' then
      section := interactions -> 'legend';
      if not training_load.dashboard_simple_object(section, array['toggle'], array['toggle'])
        or jsonb_typeof(section -> 'toggle') is distinct from 'boolean' then return false; end if;
    end if;
    if interactions ? 'zoom' then
      section := interactions -> 'zoom';
      if not training_load.dashboard_simple_object(section, array['mode','applyPeriodAction'], array['mode','applyPeriodAction'])
        or not (section -> 'mode' = any(array['"disabled"'::jsonb,'"local"'::jsonb]))
        or jsonb_typeof(section -> 'applyPeriodAction') is distinct from 'boolean' then return false; end if;
    end if;
    if interactions ? 'pointSelection' then
      section := interactions -> 'pointSelection';
      if not training_load.dashboard_simple_object(section, array['mode'], array['mode'])
        or not (section -> 'mode' = any(array['"disabled"'::jsonb,'"details"'::jsonb])) then return false; end if;
    end if;
    if interactions ? 'yAxis' then
      section := interactions -> 'yAxis';
      if section -> 'mode' = '"auto"'::jsonb then
        if not training_load.dashboard_simple_object(section, array['mode'], array['mode']) then return false; end if;
      elsif section -> 'mode' = '"fixed"'::jsonb then
        if not training_load.dashboard_simple_object(section, array['mode','min','max'], array['mode','min','max'])
          or jsonb_typeof(section -> 'min') is distinct from 'number'
          or jsonb_typeof(section -> 'max') is distinct from 'number' then return false; end if;
        if (section ->> 'min')::numeric >= (section ->> 'max')::numeric
          or abs((section ->> 'min')::numeric) > 1.7976931348623157e308::numeric
          or abs((section ->> 'max')::numeric) > 1.7976931348623157e308::numeric then return false; end if;
      else return false;
      end if;
    end if;
  end if;
  return true;
end;
$$;

alter table training_load.dashboard_widgets add constraint dashboard_widgets_presentation_shape
  check (training_load.dashboard_presentation_valid(presentation_config));

create function training_load.dashboard_presentation_opaque(p_config jsonb)
returns boolean language sql immutable parallel safe as $$
  select p_config is not null and coalesce(p_config -> 'schemaVersion' <> '1'::jsonb, true);
$$;

create function training_load.dashboard_presentation_assert_compatible(
  p_config jsonb, p_widget_type text, p_group_by text
) returns void language plpgsql as $$
begin
  if not training_load.dashboard_presentation_valid(p_config) then
    raise exception 'invalidPresentation' using errcode = 'S2C02';
  end if;
  if p_config is null or training_load.dashboard_presentation_opaque(p_config) then return; end if;
  if (p_config ?| array['chartComposition','chartInteractions']) and p_widget_type not in ('line_chart','bar_chart')
    or p_config ? 'tableFormatting' and p_widget_type <> 'table'
    or p_config ? 'chartComposition' and p_group_by not in ('day','week','athlete')
    or p_group_by not in ('day','week') and (
      p_config #> '{chartInteractions,zoom,mode}' = '"local"'::jsonb
      or p_config #> '{chartInteractions,zoom,applyPeriodAction}' = 'true'::jsonb
    ) then
    raise exception 'incompatiblePresentation' using errcode = 'S2C02';
  end if;
end;
$$;

create function training_load.dashboard_presentation_assert_series(
  p_config jsonb, p_widget_type text, p_metric_id uuid, p_builtin_key text, p_resolution_status text
) returns void language plpgsql as $$
declare
  current_version uuid;
  binding_value_type text;
begin
  if p_config is null or training_load.dashboard_presentation_opaque(p_config)
    or p_widget_type not in ('line_chart','bar_chart') then return; end if;
  if p_resolution_status in ('unresolved','ambiguous')
    and p_metric_id is null and p_builtin_key is null then return; end if;
  if p_metric_id is not null then
    select definition.current_version_id into current_version from training_load.metric_definitions definition
      where definition.id=p_metric_id for share;
    select version.value_type into binding_value_type from training_load.metric_definition_versions version
      where version.id=current_version for share;
  elsif p_builtin_key is not null then
    select builtin.value_type into binding_value_type from training_load.dashboard_builtin_series builtin
      where builtin.key=p_builtin_key for share;
  end if;
  if p_resolution_status is distinct from 'resolved' or binding_value_type is distinct from 'numeric' then
    raise exception 'numericChartRequired' using errcode = 'S2C02';
  end if;
end;
$$;

create function training_load.dashboard_widgets_guard_presentation()
returns trigger language plpgsql as $$
declare
  attached_series record;
begin
  perform training_load.dashboard_presentation_assert_compatible(new.presentation_config, new.widget_type, new.group_by);
  if tg_op = 'UPDATE' and training_load.dashboard_presentation_opaque(new.presentation_config) then
    if new.widget_type is distinct from old.widget_type
      or new.group_by is distinct from old.group_by
      or new.local_filter_override is distinct from old.local_filter_override
      or new.display_config is distinct from old.display_config then
      raise exception 'presentationRevalidationRequired' using errcode = 'S2C03';
    end if;
    if training_load.dashboard_presentation_opaque(old.presentation_config)
      and training_load.dashboard_presentation_opaque(new.presentation_config)
      and new.presentation_config is distinct from old.presentation_config then
      raise exception 'opaquePresentationMustBePreserved' using errcode = 'S2C03';
    end if;
  end if;
  if new.presentation_config is not null and not training_load.dashboard_presentation_opaque(new.presentation_config)
    and new.widget_type in ('line_chart','bar_chart') then
    for attached_series in select series.* from training_load.dashboard_widget_series series
      where series.widget_id=new.id order by series.id for share
    loop
      perform training_load.dashboard_presentation_assert_series(new.presentation_config, new.widget_type,
        attached_series.metric_definition_id, attached_series.built_in_series_key, attached_series.resolution_status);
    end loop;
  end if;
  return new;
end;
$$;

create trigger dashboard_widgets_guard_presentation
  before insert or update on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_guard_presentation();

create function training_load.dashboard_widget_series_guard_presentation()
returns trigger language plpgsql as $$
declare
  parent_widget training_load.dashboard_widgets%rowtype;
  parent_id uuid;
  semantic_changed boolean;
begin
  parent_id := case when tg_op = 'DELETE' then old.widget_id else new.widget_id end;
  select widget.* into parent_widget from training_load.dashboard_widgets widget where widget.id = parent_id for update;
  if not found then return coalesce(new, old); end if;
  semantic_changed := true;
  if tg_op = 'UPDATE' then
    semantic_changed := (to_jsonb(new) - array['color','display_label','created_at','created_by_user_id'])
      is distinct from (to_jsonb(old) - array['color','display_label','created_at','created_by_user_id']);
  end if;
  if semantic_changed and training_load.dashboard_presentation_opaque(parent_widget.presentation_config) then
    raise exception 'presentationRevalidationRequired' using errcode = 'S2C03';
  end if;
  perform training_load.dashboard_presentation_assert_compatible(
    parent_widget.presentation_config, parent_widget.widget_type, parent_widget.group_by);
  if tg_op <> 'DELETE' then
    perform training_load.dashboard_presentation_assert_series(parent_widget.presentation_config, parent_widget.widget_type,
      new.metric_definition_id, new.built_in_series_key, new.resolution_status);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger dashboard_widget_series_guard_presentation
  before insert or update or delete on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_guard_presentation();

create or replace function training_load.dashboard_widgets_bump_revision() returns trigger language plpgsql as $$
declare
  layout_changed boolean;
  content_changed boolean;
begin
  layout_changed := new.x is distinct from old.x or new.y is distinct from old.y
    or new.width is distinct from old.width or new.height is distinct from old.height
    or new.mobile_order is distinct from old.mobile_order;
  content_changed := new.widget_type is distinct from old.widget_type or new.title is distinct from old.title
    or new.widget_order is distinct from old.widget_order or new.group_by is distinct from old.group_by
    or new.state is distinct from old.state or new.display_config is distinct from old.display_config
    or new.local_filter_override is distinct from old.local_filter_override
    or new.presentation_config is distinct from old.presentation_config;
  if layout_changed or content_changed then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  if layout_changed then perform training_load.bump_dashboard_revision(new.dashboard_id); end if;
  return new;
end;
$$;

create function training_load.create_widget_with_presentation(
  p_dashboard_id uuid, p_expected_dashboard_revision integer,
  p_widget_type text, p_title text, p_widget_order integer,
  p_x smallint, p_y smallint, p_width smallint, p_height smallint, p_mobile_order integer,
  p_group_by varchar, p_display_config jsonb, p_local_filter_override jsonb, p_presentation_config jsonb
) returns table (widget_id uuid, dashboard_revision integer) language plpgsql as $$
declare
  created_widget_id uuid;
begin
  select created.widget_id into created_widget_id from training_load.create_widget(
    p_dashboard_id, p_expected_dashboard_revision, p_widget_type, p_title, p_widget_order,
    p_x, p_y, p_width, p_height, p_mobile_order, p_group_by, p_display_config, p_local_filter_override
  ) created;
  if p_presentation_config is not null then
    update training_load.dashboard_widgets widget set presentation_config = p_presentation_config where widget.id = created_widget_id;
  end if;
  return query select created_widget_id, dashboard.revision from training_load.dashboards dashboard where dashboard.id = p_dashboard_id;
end;
$$;

create function training_load.update_widget_content_with_presentation(
  p_widget_id uuid, p_expected_widget_revision integer,
  p_widget_type text, p_title text, p_group_by varchar, p_state varchar, p_display_config jsonb,
  p_local_filter_override jsonb, p_clear_local_filter_override boolean,
  p_presentation_mode text, p_presentation_config jsonb
) returns table (widget_id uuid, widget_revision integer, dashboard_id uuid) language plpgsql as $$
declare
  parent_id uuid;
  locked_widget training_load.dashboard_widgets%rowtype;
begin
  if p_presentation_mode is null or p_presentation_mode not in ('preserve','replace','clear')
    or p_presentation_mode = 'replace' and p_presentation_config is null
    or p_presentation_mode <> 'replace' and p_presentation_config is not null then
    raise exception 'invalidPresentationMode' using errcode = 'S2C05';
  end if;
  select widget.dashboard_id into parent_id from training_load.dashboard_widgets widget where widget.id = p_widget_id;
  perform 1 from training_load.dashboards dashboard where dashboard.id = parent_id for update;
  perform training_load.assert_dashboard_writable(parent_id);
  select widget.* into locked_widget from training_load.dashboard_widgets widget where widget.id = p_widget_id for update;
  if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
  if locked_widget.revision is distinct from p_expected_widget_revision then
    raise exception 'staleRevision' using errcode = '40001';
  end if;
  update training_load.dashboard_widgets widget set
    widget_type = coalesce(p_widget_type, widget.widget_type), title = coalesce(p_title, widget.title),
    group_by = coalesce(p_group_by, widget.group_by), state = coalesce(p_state, widget.state),
    display_config = coalesce(p_display_config, widget.display_config),
    local_filter_override = case when p_clear_local_filter_override then null else coalesce(p_local_filter_override, widget.local_filter_override) end,
    presentation_config = case p_presentation_mode when 'preserve' then widget.presentation_config when 'clear' then null else p_presentation_config end
    where widget.id = p_widget_id;
  return query select widget.id, widget.revision, widget.dashboard_id from training_load.dashboard_widgets widget where widget.id = p_widget_id;
end;
$$;

create table training_load.dashboard_simple_requests (
  initiator_user_id uuid not null,
  request_id uuid not null,
  dashboard_id uuid not null,
  widget_id uuid,
  workspace jsonb not null check (jsonb_typeof(workspace) = 'object'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  request_issued_at timestamptz not null check (isfinite(request_issued_at)),
  resolved_period jsonb not null check (jsonb_typeof(resolved_period) = 'object'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default now(),
  retain_until timestamptz not null,
  primary key (initiator_user_id, request_id),
  check (retain_until = request_issued_at + interval '168 hours 10 minutes')
);

create index dashboard_simple_requests_retention_idx on training_load.dashboard_simple_requests (retain_until);
revoke all on training_load.dashboard_simple_requests from public;

create function training_load.save_simple_widget(
  p_initiator_user_id uuid, p_request_id uuid, p_payload_hash text, p_request_issued_at timestamptz,
  p_dashboard_id uuid, p_widget_id uuid, p_expected_widget_revision integer,
  p_widget jsonb, p_resolved_period jsonb, p_workspace jsonb
) returns jsonb language plpgsql as $$
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
    perform 1 from training_load.metric_source_connections connection where connection.id = desired_series.source_connection_id for share;
    if not found then raise exception 'notFound' using errcode = 'S2C07'; end if;
    if not exists (select 1 from training_load.metric_source_connections connection
      where connection.id = desired_series.source_connection_id and connection.state = 'active' and (
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
    if binding_changed or locked_widget.widget_type is distinct from desired_widget.widget_type
      and series_changed then
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
$$;

create function training_load.cleanup_dashboard_simple_requests(p_limit integer default 100)
returns integer language plpgsql as $$
declare
  expired_request record;
  deleted_count integer := 0;
  deleted_rows integer;
  cleanup_started_at timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalidCleanupLimit' using errcode = 'S2C05';
  end if;
  for expired_request in
    select request.initiator_user_id, request.request_id from training_load.dashboard_simple_requests request
      where request.retain_until < cleanup_started_at order by request.retain_until, request.initiator_user_id, request.request_id limit p_limit
  loop
    if pg_try_advisory_xact_lock(hashtextextended('dashboard-simple:' || expired_request.initiator_user_id::text || ':' || expired_request.request_id::text, 0)) then
      delete from training_load.dashboard_simple_requests request
        where request.initiator_user_id = expired_request.initiator_user_id and request.request_id = expired_request.request_id
          and request.retain_until < cleanup_started_at;
      get diagnostics deleted_rows = row_count;
      deleted_count := deleted_count + deleted_rows;
    end if;
  end loop;
  return deleted_count;
end;
$$;
