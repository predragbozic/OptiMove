alter table training_load.dashboard_page_advanced_requests
  drop constraint dashboard_page_advanced_requests_operation_check,
  add constraint dashboard_page_advanced_requests_operation_check
    check (operation in ('layout','widgetCreate','widgetLayout','widgetContent','widgetDelete','widgetCopy',
      'seriesAdd','seriesUpdate','seriesDelete','seriesReorder','seriesResolve'));

create function training_load.copy_dashboard_page_widget(
  p_actor uuid, p_dashboard uuid, p_source_page uuid, p_widget uuid,
  p_destination uuid, p_revision bigint
) returns uuid language plpgsql security invoker as $$
declare
  original training_load.dashboard_widgets%rowtype;
  copied training_load.dashboard_widgets%rowtype;
  item training_load.dashboard_widget_series%rowtype;
  old_id uuid;
  series_map jsonb := '{}'::jsonb;
  previous_scope text := current_setting('training_load.page_mutation', true);
begin
  perform 1 from training_load.dashboards where id=p_dashboard for update;
  perform 1 from training_load.dashboard_pages where id=p_destination and dashboard_id=p_dashboard for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  select * into original from training_load.dashboard_widgets
    where id=p_widget and dashboard_id=p_dashboard and page_id=p_source_page for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  if original.revision<>p_revision then raise exception 'staleRevision' using errcode='40001'; end if;

  copied := original;
  copied.id := gen_random_uuid();
  copied.page_id := p_destination;
  copied.revision := 1;
  copied.created_at := now();
  copied.updated_at := now();
  copied.presentation_config := null;
  if p_source_page=p_destination then copied.title := left(original.title,195) || ' copy'; end if;
  select coalesce(max(y::integer + height),0), coalesce(max(widget_order)+1,0), coalesce(max(mobile_order)+1,0)
    into copied.y, copied.widget_order, copied.mobile_order
    from training_load.dashboard_widgets where dashboard_id=p_dashboard and page_id=p_destination;

  perform set_config('training_load.page_mutation',
    jsonb_build_object('dashboardId',p_dashboard,'pageId',p_destination,'operation','duplicate')::text,true);
  insert into training_load.dashboard_widgets select (copied).*;
  for item in select * from training_load.dashboard_widget_series where widget_id=p_widget order by series_order,id loop
    old_id := item.id;
    item.id := gen_random_uuid();
    item.widget_id := copied.id;
    item.created_at := now();
    item.created_by_user_id := p_actor;
    insert into training_load.dashboard_widget_series select (item).*;
    series_map := series_map || jsonb_build_object(old_id::text,item.id);
  end loop;
  if original.presentation_config is not null then
    update training_load.dashboard_widgets
      set presentation_config=training_load.dashboard_page_remap_presentation(original.presentation_config,series_map)
      where id=copied.id;
  end if;
  perform set_config('training_load.page_mutation',coalesce(previous_scope,''),true);
  return copied.id;
end $$;

create function training_load.record_dashboard_widget_copy(
  p_actor uuid, p_request uuid, p_workspace jsonb, p_dashboard uuid,
  p_page uuid, p_widget uuid, p_hash text, p_receipt jsonb
) returns void language sql security invoker as $$
  insert into training_load.dashboard_page_advanced_requests
    (initiator_user_id,request_id,workspace,dashboard_id,page_id,operation,widget_id,payload_hash,receipt)
  values (p_actor,p_request,p_workspace,p_dashboard,p_page,'widgetCopy',p_widget,p_hash,p_receipt);
$$;
