-- ============================================================
-- OPTIMOVE — Training Load 3B2: Analysis Dashboard v17 — the 15
-- sanctioned write functions (13 original + create_dashboard/update_
-- dashboard_metadata, added in the 3B2 corrective round — see their own
-- header comment below). Migration 3 of 4 — depends on v15/v16.
--
-- The project uses no SECURITY DEFINER / DB-role trick to make raw SQL
-- against these tables physically impossible — nothing below claims
-- otherwise. What these functions ARE: the one documented, proven-safe
-- dashboard->widget->series lock order for every write this subsystem
-- needs, which the real backend's route layer MUST use exclusively (see
-- backend/src/trainingLoadDashboard*.js) — a raw INSERT/UPDATE/DELETE
-- against these tables from application code is out of contract. Every
-- function locks the DASHBOARD row FIRST (via the widget's own, immutable
-- dashboard_id when needed), then the widget, then performs its own
-- table's operation — the same order, every time.
-- ============================================================

-- ------------------------------------------------------------
-- Lifecycle: create / update metadata. Added in the 3B2 corrective round
-- — createDashboard()/updateDashboardMetadata() (backend/src/
-- trainingLoadDashboardCatalog.js) previously ran raw INSERT/UPDATE
-- against training_load.dashboards directly, which was out of contract
-- with this file's own header (every write must go through a sanctioned
-- function). These two bring the sanctioned-function count to 15 —
-- cloneDashboard() remains the one documented, explicit exception (a
-- genuine multi-table composite transaction: dashboard + N widgets + N
-- series, with live template-binding re-resolution, that cannot be
-- expressed as a single set-based function call) and is NOT required to
-- route through create_dashboard() — it locks the source dashboard (via
-- the existing dashboards_validate_clone_provenance FOR SHARE trigger,
-- which fires on the INSERT below, before any widget/series is read) and
-- performs its own dashboard/widget/series inserts directly, atomically,
-- inside one transaction, exactly as documented in trainingLoadDashboardCatalog.js.
-- ------------------------------------------------------------

create function training_load.create_dashboard(
  p_name text, p_description text, p_owner_scope varchar, p_owner_user_id uuid, p_owner_club_id uuid, p_owner_team_id uuid,
  p_data_workspace_type varchar, p_data_workspace_scope_id uuid, p_is_template boolean, p_created_by_user_id uuid
) returns setof training_load.dashboards as $$
declare
  v_id uuid;
begin
  insert into training_load.dashboards (name, description, owner_scope, owner_user_id, owner_club_id, owner_team_id, data_workspace_type, data_workspace_scope_id, is_template, created_by_user_id)
    values (p_name, p_description, p_owner_scope, p_owner_user_id, p_owner_club_id, p_owner_team_id, p_data_workspace_type, p_data_workspace_scope_id, coalesce(p_is_template, false), p_created_by_user_id)
    returning id into v_id;
  return query select * from training_load.dashboards where id = v_id;
end;
$$ language plpgsql;

-- p_clear_description/p_clear_default_filter follow the same "explicit
-- clear flag, never a bare NULL means clear" convention as update_
-- widget_content()/update_series() above — a bare NULL parameter always
-- means "leave unchanged" (coalesce), never "clear". is_template is free
-- to flip in either direction (see v15's own comment on dashboards_bump_
-- revision — no unresolved-series protection is needed for a template
-- flip in this model).
create function training_load.update_dashboard_metadata(
  p_dashboard_id uuid, p_expected_revision integer,
  p_name text default null, p_description text default null, p_clear_description boolean default false,
  p_default_filter jsonb default null, p_clear_default_filter boolean default false,
  p_is_template boolean default null
) returns setof training_load.dashboards as $$
declare
  v_current_revision integer;
begin
  select d.revision into v_current_revision from training_load.dashboards d where d.id = p_dashboard_id for update;
  if not found then
    raise exception 'update_dashboard_metadata: dashboard % not found', p_dashboard_id;
  end if;
  if v_current_revision <> p_expected_revision then
    raise exception 'update_dashboard_metadata: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_current_revision using errcode = '40001';
  end if;
  update training_load.dashboards d set
    name = coalesce(p_name, d.name),
    description = case when p_clear_description then null else coalesce(p_description, d.description) end,
    default_filter = case when p_clear_default_filter then null else coalesce(p_default_filter, d.default_filter) end,
    is_template = coalesce(p_is_template, d.is_template)
  where d.id = p_dashboard_id and d.revision = p_expected_revision;
  if not found then
    raise exception 'update_dashboard_metadata: stale revision (expected %) — reload and retry', p_expected_revision using errcode = '40001';
  end if;
  return query select * from training_load.dashboards where id = p_dashboard_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- Layout.
-- ------------------------------------------------------------

-- The ONE sanctioned way to apply a multi-widget position/size/
-- mobile_order change (desktop swap/rearrange, or a batch of mobile Move
-- up/down steps) as a single all-or-nothing operation: lock the
-- dashboard, check the caller's expected revision, apply every row, force
-- the deferred overlap check to run NOW, and return the fresh state.
create function training_load.replace_dashboard_layout(
  p_dashboard_id uuid,
  p_expected_revision integer,
  p_layout jsonb -- [{"widgetId": "...", "x":0,"y":0,"width":4,"height":2,"mobileOrder":1}, ...]
) returns table (widget_id uuid, x smallint, y smallint, width smallint, height smallint, mobile_order integer, revision integer, dashboard_revision integer) as $$
declare
  v_current_revision integer;
  v_entry jsonb;
begin
  select d.revision into v_current_revision from training_load.dashboards d where d.id = p_dashboard_id for update;
  if not found then
    raise exception 'replace_dashboard_layout: dashboard % not found', p_dashboard_id;
  end if;
  if v_current_revision <> p_expected_revision then
    raise exception 'replace_dashboard_layout: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_current_revision using errcode = '40001';
  end if;

  for v_entry in select * from jsonb_array_elements(p_layout) loop
    -- Table alias `w` + qualified column references throughout — the
    -- bare column names (x, width, ...) would otherwise collide with
    -- this FUNCTION's own RETURNS TABLE out-parameter names.
    update training_load.dashboard_widgets w
      set x = coalesce((v_entry ->> 'x')::smallint, w.x),
          y = coalesce((v_entry ->> 'y')::smallint, w.y),
          width = coalesce((v_entry ->> 'width')::smallint, w.width),
          height = coalesce((v_entry ->> 'height')::smallint, w.height),
          mobile_order = coalesce((v_entry ->> 'mobileOrder')::integer, w.mobile_order)
      where w.id = (v_entry ->> 'widgetId')::uuid and w.dashboard_id = p_dashboard_id;
    if not found then
      raise exception 'replace_dashboard_layout: widget % does not belong to dashboard %', v_entry ->> 'widgetId', p_dashboard_id;
    end if;
  end loop;

  -- Force the deferred overlap check (and the deferred widget_order/
  -- mobile_order uniqueness constraints) to run NOW, inside this
  -- function's own transaction scope.
  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique, training_load.dashboard_widgets_mobile_order_unique immediate;

  -- Each per-widget UPDATE above already bumps dashboards.revision on its
  -- own (dashboard_widgets_bump_revision's layout branch) — this extra,
  -- explicit call is kept anyway as a deliberate, unconditional
  -- guarantee, and keeps this function's own correctness independent of
  -- exactly how that trigger is implemented. A harmless double-bump on
  -- the normal (non-empty) path is explicitly fine — the caller's own
  -- contract is "the returned token is fresh and sole-authoritative", not
  -- "revision increments by exactly 1".
  perform training_load.bump_dashboard_revision(p_dashboard_id);

  return query
    select w.id, w.x, w.y, w.width, w.height, w.mobile_order, w.revision, d.revision
    from training_load.dashboard_widgets w
    join training_load.dashboards d on d.id = w.dashboard_id
    where w.dashboard_id = p_dashboard_id and w.id in (select (e ->> 'widgetId')::uuid from jsonb_array_elements(p_layout) e);
end;
$$ language plpgsql;

-- The sanctioned, deadlock-safe SINGLE-widget layout-change entry point —
-- proven safe to run concurrently with replace_dashboard_layout() because
-- it locks the DASHBOARD row FIRST via its own explicit `SELECT ... FOR
-- UPDATE` (after only a plain, unlocked read to resolve the widget's
-- dashboard_id) and only THEN touches the widget row — genuinely
-- dashboard-before-widget. A raw `UPDATE dashboard_widgets SET x=...
-- WHERE id=...` cannot achieve this order: Postgres locks an UPDATE's own
-- target row before any before-row trigger runs, so dashboard_widgets_
-- lock_dashboard_before_layout_write's attempt to lock the dashboard
-- "first" is already too late for an UPDATE. The application layer must
-- use THIS function (or replace_dashboard_layout for a multi-widget
-- batch) for every layout write.
create function training_load.update_widget_layout(
  p_widget_id uuid,
  p_expected_widget_revision integer,
  p_x smallint,
  p_y smallint,
  p_width smallint,
  p_height smallint,
  p_mobile_order integer
) returns table (
  widget_id uuid, dashboard_id uuid, x smallint, y smallint, width smallint, height smallint,
  mobile_order integer, widget_revision integer, dashboard_revision integer
) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_locked_dashboard_id uuid;
begin
  -- 1. An UNLOCKED read used ONLY to find dashboard_id (never trusted for
  --    anything else — it exists purely to know which dashboard row to
  --    lock first, since dashboard_id is immutable so this can never
  --    itself go stale in a way that matters).
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'update_widget_layout: widget % not found', p_widget_id;
  end if;

  -- 2. Lock the DASHBOARD row first — genuinely first, before this
  --    function has touched dashboard_widgets at all.
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;

  -- 3. NOW lock and RE-READ the widget row — this is the fresh,
  --    trustworthy revision, taken only after the dashboard lock is
  --    held, so nothing can have raced it undetected in between.
  select w.dashboard_id, w.revision into v_locked_dashboard_id, v_current_widget_revision
    from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if not found then
    raise exception 'update_widget_layout: widget % disappeared concurrently (deleted between lookup and lock)', p_widget_id;
  end if;

  -- 4. Confirm the widget still belongs to the SAME dashboard we locked
  --    (defense-in-depth — dashboard_id is immutable by trigger).
  if v_locked_dashboard_id is distinct from v_dashboard_id then
    raise exception 'update_widget_layout: widget % dashboard_id changed between lookup and lock (% -> %)', p_widget_id, v_dashboard_id, v_locked_dashboard_id;
  end if;

  -- 5. ONLY NOW check the caller's expected revision, against the FRESH,
  --    locked value from step 3 — never the stale step-1 read.
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'update_widget_layout: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;

  -- 6. The UPDATE itself, with an EXTRA revision guard in the WHERE
  --    clause on top of the row lock already held.
  update training_load.dashboard_widgets w
    set x = p_x, y = p_y, width = p_width, height = p_height, mobile_order = p_mobile_order
    where w.id = p_widget_id and w.revision = p_expected_widget_revision;
  if not found then
    raise exception 'update_widget_layout: stale widget revision (expected %) — reload and retry', p_expected_widget_revision using errcode = '40001';
  end if;

  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique, training_load.dashboard_widgets_mobile_order_unique immediate;

  -- 7. Return the REAL, fresh widget AND dashboard revision tokens.
  return query
    select w.id, w.dashboard_id, w.x, w.y, w.width, w.height, w.mobile_order, w.revision, d.revision
    from training_load.dashboard_widgets w
    join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = p_widget_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- Widgets.
-- ------------------------------------------------------------

create function training_load.create_widget(
  p_dashboard_id uuid, p_expected_dashboard_revision integer,
  p_widget_type text, p_title text, p_widget_order integer,
  p_x smallint, p_y smallint, p_width smallint, p_height smallint, p_mobile_order integer,
  p_group_by varchar default 'day', p_display_config jsonb default '{"schemaVersion": 1}'::jsonb,
  p_local_filter_override jsonb default null
) returns table (widget_id uuid, dashboard_revision integer) as $$
declare
  v_current_revision integer;
  v_widget_id uuid;
begin
  select d.revision into v_current_revision from training_load.dashboards d where d.id = p_dashboard_id for update;
  if not found then
    raise exception 'create_widget: dashboard % not found', p_dashboard_id;
  end if;
  if v_current_revision <> p_expected_dashboard_revision then
    raise exception 'create_widget: stale dashboard revision (expected %, dashboard is at %) — reload and retry', p_expected_dashboard_revision, v_current_revision using errcode = '40001';
  end if;
  insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order, group_by, display_config, local_filter_override)
    values (p_dashboard_id, p_widget_type, p_title, p_widget_order, p_x, p_y, p_width, p_height, p_mobile_order, coalesce(p_group_by, 'day'), coalesce(p_display_config, '{"schemaVersion": 1}'::jsonb), p_local_filter_override)
    returning id into v_widget_id;
  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique, training_load.dashboard_widgets_mobile_order_unique immediate;
  return query select v_widget_id, d.revision from training_load.dashboards d where d.id = p_dashboard_id;
end;
$$ language plpgsql;

create function training_load.update_widget_content(
  p_widget_id uuid, p_expected_widget_revision integer,
  p_widget_type text default null, p_title text default null, p_group_by varchar default null,
  p_state varchar default null, p_display_config jsonb default null,
  p_local_filter_override jsonb default null, p_clear_local_filter_override boolean default false
) returns table (widget_id uuid, widget_revision integer, dashboard_id uuid) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'update_widget_content: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if not found then
    raise exception 'update_widget_content: widget % disappeared concurrently', p_widget_id;
  end if;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'update_widget_content: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  update training_load.dashboard_widgets w set
    widget_type = coalesce(p_widget_type, w.widget_type),
    title = coalesce(p_title, w.title),
    group_by = coalesce(p_group_by, w.group_by),
    state = coalesce(p_state, w.state),
    display_config = coalesce(p_display_config, w.display_config),
    local_filter_override = case when p_clear_local_filter_override then null else coalesce(p_local_filter_override, w.local_filter_override) end
  where w.id = p_widget_id and w.revision = p_expected_widget_revision;
  if not found then
    raise exception 'update_widget_content: stale widget revision (expected %) — reload and retry', p_expected_widget_revision using errcode = '40001';
  end if;
  return query select w.id, w.revision, w.dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- The sanctioned single-widget delete — closes the AB-BA risk a raw
-- `DELETE FROM dashboard_widgets WHERE id=...` carries (the DELETE's own
-- implicit row lock is acquired on the WIDGET first, then dashboard_
-- widgets_bump_parent_on_delete's AFTER trigger locks the dashboard
-- second — the reverse of every other sanctioned function's order, and a
-- genuine deadlock risk against replace_dashboard_layout()/update_
-- widget_layout() running concurrently on the same dashboard).
create function training_load.delete_widget(p_widget_id uuid, p_expected_widget_revision integer)
returns table (dashboard_id uuid, dashboard_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'delete_widget: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if not found then
    raise exception 'delete_widget: widget % disappeared concurrently', p_widget_id;
  end if;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'delete_widget: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  delete from training_load.dashboard_widgets where id = p_widget_id;
  return query select v_dashboard_id, d.revision from training_load.dashboards d where d.id = v_dashboard_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- Series.
-- ------------------------------------------------------------

create function training_load.add_series(
  p_widget_id uuid, p_expected_widget_revision integer, p_series_order integer,
  p_metric_definition_id uuid default null, p_built_in_series_key text default null,
  p_template_metric_key_hints jsonb default null, p_resolution_status varchar default 'resolved',
  p_template_resolution_candidates jsonb default null,
  p_axis varchar default 'primary', p_color text default null, p_display_label text default null,
  p_source_policy varchar default 'all_with_conflicts', p_source_connection_id uuid default null,
  p_data_scope_level varchar default 'session', p_analytical_aggregation varchar default 'sum',
  p_aggregation_role_policy varchar default 'standalone_and_source_rollup', p_coverage_policy varchar default 'complete_and_partial',
  p_comparison_period varchar default null, p_created_by_user_id uuid default null
) returns table (series_id uuid, widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_series_id uuid;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'add_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'add_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  insert into training_load.dashboard_widget_series (
    widget_id, series_order, metric_definition_id, built_in_series_key, template_metric_key_hints,
    resolution_status, template_resolution_candidates,
    axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation,
    aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id
  ) values (
    p_widget_id, p_series_order, p_metric_definition_id, p_built_in_series_key, p_template_metric_key_hints,
    p_resolution_status, p_template_resolution_candidates,
    coalesce(p_axis, 'primary'), p_color, p_display_label, coalesce(p_source_policy, 'all_with_conflicts'), p_source_connection_id,
    coalesce(p_data_scope_level, 'session'), coalesce(p_analytical_aggregation, 'sum'),
    coalesce(p_aggregation_role_policy, 'standalone_and_source_rollup'), coalesce(p_coverage_policy, 'complete_and_partial'),
    p_comparison_period, p_created_by_user_id
  ) returning id into v_series_id;
  return query select v_series_id, w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

create function training_load.update_series(
  p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer,
  p_axis varchar default null, p_color text default null, p_display_label text default null,
  p_source_policy varchar default null, p_source_connection_id uuid default null,
  p_data_scope_level varchar default null, p_analytical_aggregation varchar default null,
  p_aggregation_role_policy varchar default null, p_coverage_policy varchar default null,
  p_comparison_period varchar default null, p_clear_comparison_period boolean default false
) returns table (series_id uuid, widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'update_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'update_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  -- Whenever the CALLER explicitly changes source_policy to anything
  -- other than 'source_connection', the connection pin is cleared
  -- automatically — no separate p_clear flag needed, since a non-
  -- 'source_connection' policy can never legally carry a connection id
  -- (the table's own CHECK constraint would otherwise reject the
  -- transition outright, since the OLD connection id would survive a
  -- naive coalesce).
  update training_load.dashboard_widget_series s set
    axis = coalesce(p_axis, s.axis),
    color = coalesce(p_color, s.color),
    display_label = coalesce(p_display_label, s.display_label),
    source_policy = coalesce(p_source_policy, s.source_policy),
    source_connection_id = case
      when p_source_policy is not null and p_source_policy <> 'source_connection' then null
      else coalesce(p_source_connection_id, s.source_connection_id)
    end,
    data_scope_level = coalesce(p_data_scope_level, s.data_scope_level),
    analytical_aggregation = coalesce(p_analytical_aggregation, s.analytical_aggregation),
    aggregation_role_policy = coalesce(p_aggregation_role_policy, s.aggregation_role_policy),
    coverage_policy = coalesce(p_coverage_policy, s.coverage_policy),
    comparison_period = case when p_clear_comparison_period then null else coalesce(p_comparison_period, s.comparison_period) end
  where s.id = p_series_id and s.widget_id = p_widget_id;
  if not found then
    raise exception 'update_series: series % not found under widget %', p_series_id, p_widget_id;
  end if;
  return query select p_series_id, w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- The sanctioned resolve/bind function — the ONE write path allowed to
-- move a series out of 'unresolved'/'ambiguous' into 'resolved'. This
-- function does NOT trust the row's own stored template_resolution_
-- candidates as an authorization source (that JSONB snapshot can be
-- stale — visibility can change between clone time and pick time) — it
-- re-validates the CALLER's chosen p_metric_definition_id LIVE, by
-- performing a genuine UPDATE of metric_definition_id, which fires the
-- SAME dashboard_widget_series_validate_metric_visibility (and
-- _validate_scope_capability, _validate_axis_unit, _validate_metric_
-- active_state, _validate_aggregation_type_compat) triggers every other
-- metric_definition_id write already goes through — no bespoke, possibly-
-- weaker re-implementation of any of those checks here, the real
-- triggers ARE the authorization.
create function training_load.resolve_series_binding(
  p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer, p_metric_definition_id uuid
) returns table (series_id uuid, widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_current_status varchar;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'resolve_series_binding: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'resolve_series_binding: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  select resolution_status into v_current_status from training_load.dashboard_widget_series where id = p_series_id and widget_id = p_widget_id;
  if not found then
    raise exception 'resolve_series_binding: series % not found under widget %', p_series_id, p_widget_id;
  end if;
  if v_current_status = 'resolved' then
    raise exception 'resolve_series_binding: series % is already resolved — nothing to bind', p_series_id;
  end if;
  if p_metric_definition_id is null then
    raise exception 'resolve_series_binding: p_metric_definition_id is required';
  end if;
  update training_load.dashboard_widget_series s set
    metric_definition_id = p_metric_definition_id,
    resolution_status = 'resolved',
    template_resolution_candidates = null
  where s.id = p_series_id and s.widget_id = p_widget_id;
  return query select p_series_id, w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

create function training_load.delete_series(p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer)
returns table (widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_deleted uuid;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'delete_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'delete_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  delete from training_load.dashboard_widget_series where id = p_series_id and widget_id = p_widget_id returning id into v_deleted;
  if v_deleted is null then
    raise exception 'delete_series: series % not found under widget %', p_series_id, p_widget_id;
  end if;
  return query select w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- Batch series reorder — the series-level analog of replace_dashboard_
-- layout(), same dashboard-first lock order, one atomic all-or-nothing
-- call for a drag-reorder of a widget's own series.
create function training_load.reorder_series(p_widget_id uuid, p_expected_widget_revision integer, p_order jsonb)
returns table (widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_entry jsonb;
  v_updated uuid;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'reorder_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'reorder_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  for v_entry in select * from jsonb_array_elements(p_order) loop
    update training_load.dashboard_widget_series s set series_order = (v_entry ->> 'seriesOrder')::integer
      where s.id = (v_entry ->> 'seriesId')::uuid and s.widget_id = p_widget_id
      returning s.id into v_updated;
    if v_updated is null then
      raise exception 'reorder_series: series % does not belong to widget %', v_entry ->> 'seriesId', p_widget_id;
    end if;
  end loop;
  set constraints training_load.dashboard_widget_series_order_unique immediate;
  return query select w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- Lifecycle.
-- ------------------------------------------------------------

create function training_load.archive_dashboard(p_dashboard_id uuid, p_expected_revision integer)
returns table (dashboard_id uuid, status varchar, revision integer) as $$
declare
  v_current_revision integer;
begin
  select d.revision into v_current_revision from training_load.dashboards d where d.id = p_dashboard_id for update;
  if not found then
    raise exception 'archive_dashboard: dashboard % not found', p_dashboard_id;
  end if;
  if v_current_revision <> p_expected_revision then
    raise exception 'archive_dashboard: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_current_revision using errcode = '40001';
  end if;
  update training_load.dashboards set status = 'archived' where id = p_dashboard_id;
  return query select d.id, d.status, d.revision from training_load.dashboards d where d.id = p_dashboard_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- Active dashboard selection.
-- ------------------------------------------------------------

-- The sanctioned entry point for choosing (or switching) a user's active
-- dashboard for one workspace context. Lock order: dashboard -> active-
-- selection, explicitly, as this function's own first statement — the
-- SAME order archive_dashboard() locks the dashboard in, and the SAME row
-- the validate_visibility trigger (v16) will (redundantly but harmlessly,
-- same session already holds it) re-lock as its own first statement.
-- Whichever of a concurrent set_active_dashboard() and a concurrent
-- archive_dashboard() targeting the SAME dashboard reaches this lock
-- first fully completes (commits) before the other is ever unblocked.
--
-- The actual write is a real UPSERT keyed on the table's own `unique
-- nulls not distinct (user_id, workspace_type, scope_id)` constraint —
-- "first selection" (no existing row) INSERTs; "switch to a different
-- dashboard in the SAME workspace" (a row already exists) UPDATEs that
-- SAME row's dashboard_id in place, never leaving a stale second row
-- behind. Either path fires dashboard_active_selection_validate_
-- visibility, so a switch is validated exactly as strictly as a first
-- selection.
--
-- Out-parameter names below are deliberately PREFIXED (out_...) rather
-- than reusing the table's own column names (dashboard_id/workspace_type/
-- scope_id/updated_at) — Postgres cannot otherwise resolve a bare column
-- reference inside `on conflict (user_id, workspace_type, scope_id)`
-- between the out-parameter and the table column (that ON CONFLICT target
-- list must be bare column names per SQL grammar — it cannot be
-- table-prefixed, so renaming the out-parameters is the only fix).
create function training_load.set_active_dashboard(
  p_user_id uuid, p_workspace_type varchar, p_scope_id uuid, p_dashboard_id uuid
) returns table (out_selection_id uuid, out_dashboard_id uuid, out_workspace_type varchar, out_scope_id uuid, out_updated_at timestamptz) as $$
declare
  v_selection_id uuid;
begin
  perform 1 from training_load.dashboards where id = p_dashboard_id for update;
  insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id)
  values (p_user_id, p_workspace_type, p_scope_id, p_dashboard_id)
  on conflict (user_id, workspace_type, scope_id)
  do update set dashboard_id = excluded.dashboard_id
  returning id into v_selection_id;
  return query
    select s.id, s.dashboard_id, s.workspace_type, s.scope_id, s.updated_at
    from training_load.dashboard_active_selection s where s.id = v_selection_id;
end;
$$ language plpgsql;

-- The sanctioned counterpart to set_active_dashboard() for explicitly
-- clearing a user's active selection for one workspace context. A plain
-- DELETE with no invariant left to violate (an ABSENT selection is always
-- a legal state, unlike an active one), but still exposed as a real
-- sanctioned function for the same "one write path per mutation" reason
-- every other function here exists.
create function training_load.clear_active_dashboard(
  p_user_id uuid, p_workspace_type varchar, p_scope_id uuid
) returns table (cleared boolean) as $$
declare
  v_dashboard_id uuid;
  v_deleted_id uuid;
begin
  select dashboard_id into v_dashboard_id from training_load.dashboard_active_selection
    where user_id = p_user_id and workspace_type = p_workspace_type and scope_id is not distinct from p_scope_id;
  if v_dashboard_id is not null then
    perform 1 from training_load.dashboards where id = v_dashboard_id for update;
  end if;
  delete from training_load.dashboard_active_selection
    where user_id = p_user_id and workspace_type = p_workspace_type and scope_id is not distinct from p_scope_id
    returning id into v_deleted_id;
  return query select (v_deleted_id is not null);
end;
$$ language plpgsql;
