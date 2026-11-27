-- Called by the Page service in the same transaction as the sanctioned page create.
create function training_load.copy_dashboard_page_contents(
  p_dashboard uuid, p_source uuid, p_destination uuid, p_actor uuid, p_request uuid
) returns void language plpgsql as $$
declare
  source_page training_load.dashboard_pages%rowtype;
  source_widget training_load.dashboard_widgets%rowtype;
  new_widget uuid;
  series_map jsonb;
begin
  perform training_load.assert_dashboard_writable(p_dashboard);
  if p_source = p_destination then
    raise exception 'invalidRequest' using errcode = '22023';
  end if;
  perform 1 from training_load.dashboard_page_requests
    where initiator_user_id = p_actor and request_id = p_request
      and dashboard_id = p_dashboard and operation = 'create'
      and receipt->>'pageId' = p_destination::text
      and xmin::text::bigint = (pg_current_xact_id()::text::numeric % 4294967296);
  if not found then raise exception 'notFound' using errcode = 'P0002'; end if;
  select * into strict source_page from training_load.dashboard_pages
    where id = p_source and dashboard_id = p_dashboard;
  perform 1 from training_load.dashboard_widget_series s
    join training_load.dashboard_widgets w on w.id = s.widget_id
    where w.dashboard_id = p_dashboard and w.page_id = p_source
    order by s.id for update of s;
  update training_load.dashboard_pages set
    default_filter = source_page.default_filter, period_config = source_page.period_config
    where id = p_destination and dashboard_id = p_dashboard and not is_home;
  if not found then raise exception 'notFound' using errcode = 'P0002'; end if;

  perform set_config('optimove.dashboard_page', pg_current_xact_id()::text || ':' || p_destination::text, true);
  for source_widget in select * from training_load.dashboard_widgets
    where dashboard_id = p_dashboard and page_id = p_source order by widget_order, id
  loop
    insert into training_load.dashboard_widgets (
      dashboard_id, page_id, widget_type, title, widget_order, x, y, width, height,
      mobile_order, group_by, state, display_config, local_filter_override
    ) values (
      p_dashboard, p_destination, source_widget.widget_type, source_widget.title,
      source_widget.widget_order, source_widget.x, source_widget.y, source_widget.width,
      source_widget.height, source_widget.mobile_order, source_widget.group_by,
      source_widget.state, source_widget.display_config, source_widget.local_filter_override
    ) returning id into new_widget;

    insert into training_load.dashboard_widget_series (
      widget_id, series_order, metric_definition_id, built_in_series_key, template_metric_key_hints,
      resolution_status, template_resolution_candidates, axis, source_policy, source_connection_id,
      data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy,
      comparison_period, color, display_label, created_by_user_id
    )
    select new_widget, series_order, metric_definition_id, built_in_series_key, template_metric_key_hints,
      resolution_status, template_resolution_candidates, axis, source_policy, source_connection_id,
      data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy,
      comparison_period, color, display_label, p_actor
    from training_load.dashboard_widget_series where widget_id = source_widget.id order by series_order;

    select jsonb_object_agg(src.id::text, dst.id::text) into series_map
    from training_load.dashboard_widget_series src
    join training_load.dashboard_widget_series dst
      on dst.widget_id = new_widget and dst.series_order = src.series_order
    where src.widget_id = source_widget.id;
    update training_load.dashboard_widgets
    set presentation_config = training_load.dashboard_chart_shape_remap(source_widget.presentation_config, series_map)
    where id = new_widget;
  end loop;
  perform set_config('optimove.dashboard_page', '', true);
end;
$$;
