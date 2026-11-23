-- P2: seven chart shapes, compatible presentation validators and immutable use evidence.
-- The runner owns the transaction. No old widget/series row is rewritten.
set local lock_timeout='5s';
set local statement_timeout='30s';
do $gate$ begin
 if (select checksum from public.schema_migrations where migration_name='migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql') is distinct from '1da5706c418c0f3262d6a88689e8d1355247a97d7d31bad4a82a59d396c52247' then raise exception 'v94 requires exact v91' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_valid(jsonb)')) is distinct from 'd547e14a8a7021702769f4e17b6d94e8'
 or (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_assert_compatible(jsonb,text,text)')) is distinct from 'c0a9f476ac4bb0f0e7831fbc7014cc95' then raise exception 'v94 predecessor body changed' using errcode='23514';end if;
end $gate$;

create function training_load.dashboard_chart_shape_legacy_valid(p_config jsonb)
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

create function training_load.dashboard_chart_shape_legacy_compatible(
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

create function training_load.dashboard_chart_shape_valid(s jsonb) returns boolean language plpgsql immutable parallel safe as $$
declare b jsonb;selected_ids text[];used_ids text[]='{}';marks text[]='{}';kind text;
begin
 if not training_load.dashboard_simple_object(s,array['schemaVersion','kind','seriesIds','bindings','additive'],array['schemaVersion','kind','seriesIds'])
 or s->'schemaVersion'<>'1'::jsonb or jsonb_typeof(s->'kind') is distinct from 'string'
 or s->>'kind' not in ('area','horizontal_bar','combined','heatmap','scatter','stacked','boxplot')
 or jsonb_typeof(s->'seriesIds') is distinct from 'array' then return false;end if;
 if jsonb_array_length(s->'seriesIds')<1 or jsonb_array_length(s->'seriesIds')>20 then return false;end if;
 for b in select value from jsonb_array_elements(s->'seriesIds') loop
  if jsonb_typeof(b) is distinct from 'string' or (b#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
 end loop;
 select array_agg(lower(value)) into selected_ids from jsonb_array_elements_text(s->'seriesIds');
 if (select count(distinct v) from unnest(selected_ids) v)<>cardinality(selected_ids) then return false;end if;
 kind:=s->>'kind';
 if kind in ('heatmap','boxplot') and cardinality(selected_ids)<>1 or kind='scatter' and cardinality(selected_ids)<>2
 or kind in ('combined','stacked') and cardinality(selected_ids)<2 then return false;end if;
 if kind<>'combined' and s?'bindings' or kind<>'stacked' and s?'additive' then return false;end if;
 if kind='stacked' and s->'additive' is distinct from 'true'::jsonb then return false;end if;
 if kind='combined' then
  if jsonb_typeof(s->'bindings') is distinct from 'array' then return false;end if;
  if jsonb_array_length(s->'bindings')<>cardinality(selected_ids) then return false;end if;
  for b in select value from jsonb_array_elements(s->'bindings') loop
   if not training_load.dashboard_simple_object(b,array['seriesId','mark','axis'],array['seriesId','mark','axis'])
    or jsonb_typeof(b->'seriesId') is distinct from 'string' or not(lower(b->>'seriesId')=any(selected_ids))
    or lower(b->>'seriesId')=any(used_ids) or b->>'mark' not in ('bar','line')
    or jsonb_typeof(b->'mark') is distinct from 'string' or b->'axis' not in ('0'::jsonb,'1'::jsonb) then return false;end if;
   used_ids:=array_append(used_ids,lower(b->>'seriesId'));marks:=array_append(marks,b->>'mark');
  end loop;
  if not('bar'=any(marks) and 'line'=any(marks)) then return false;end if;
 end if;
 return true;
end;
$$;

create or replace function training_load.dashboard_presentation_valid(p_config jsonb)
returns boolean language plpgsql immutable parallel safe as $$
begin
 if p_config is not null and p_config->'schemaVersion'='1'::jsonb and p_config?'chartShape' then
  return training_load.dashboard_chart_shape_valid(p_config->'chartShape')
    and not(p_config?'tableFormatting') and training_load.dashboard_chart_shape_legacy_valid(p_config-'chartShape');
 end if;
 return training_load.dashboard_chart_shape_legacy_valid(p_config);
end;
$$;

create or replace function training_load.dashboard_presentation_assert_compatible(p_config jsonb,p_widget_type text,p_group_by text)
returns void language plpgsql as $$
begin
 if not training_load.dashboard_presentation_valid(p_config) then raise exception 'invalidPresentation' using errcode='S2C02';end if;
 perform training_load.dashboard_chart_shape_legacy_compatible(p_config-'chartShape',p_widget_type,p_group_by);
 if p_config->'schemaVersion'='1'::jsonb and p_config?'chartShape' then
  if p_widget_type not in ('line_chart','bar_chart') or p_config#>>'{chartShape,kind}'='area' and p_widget_type<>'line_chart'
   or p_config#>>'{chartShape,kind}'='horizontal_bar' and p_widget_type<>'bar_chart'
   or p_config#>>'{chartShape,kind}' in ('heatmap','boxplot') and p_group_by not in ('day','week') then
   raise exception 'incompatiblePresentation' using errcode='S2C02';end if;
 end if;
end;
$$;

create table training_load.dashboard_chart_shape_usage(
 widget_id uuid primary key, -- no FK: evidence survives widget/dashboard deletion
 first_used_at timestamptz not null default clock_timestamp()
);
create function training_load.dashboard_chart_shape_usage_guard() returns trigger language plpgsql as $$
begin raise exception 'chartShapeUseImmutable' using errcode='23514';end;
$$;
create trigger dashboard_chart_shape_usage_rows before update or delete on training_load.dashboard_chart_shape_usage
 for each row execute function training_load.dashboard_chart_shape_usage_guard();
create trigger dashboard_chart_shape_usage_truncate before truncate on training_load.dashboard_chart_shape_usage
 for each statement execute function training_load.dashboard_chart_shape_usage_guard();

create function training_load.dashboard_chart_shape_touch() returns trigger language plpgsql as $$
begin
 if new.presentation_config->'schemaVersion'='1'::jsonb and new.presentation_config?'chartShape' then
  insert into training_load.dashboard_chart_shape_usage(widget_id) values(new.id) on conflict do nothing;
 end if;
 return new;
end;
$$;
create trigger dashboard_widgets_chart_shape_use after insert or update on training_load.dashboard_widgets
 for each row execute function training_load.dashboard_chart_shape_touch();

create function training_load.dashboard_chart_shape_assert(p_widget_id uuid) returns void language plpgsql as $$
declare w training_load.dashboard_widgets%rowtype;s jsonb;ids uuid[];r record;units text[]='{}';scopes text[]='{}';axes jsonb='{}';b jsonb;axis_key text;
begin
 select * into w from training_load.dashboard_widgets where id=p_widget_id;
 if not found or w.presentation_config->'schemaVersion' is distinct from '1'::jsonb or not(w.presentation_config?'chartShape') then return;end if;
 s:=w.presentation_config->'chartShape';
 if not training_load.dashboard_chart_shape_valid(s) then raise exception 'invalidPresentation' using errcode='S2C02';end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(s->'seriesIds');
 if (select count(*) from training_load.dashboard_widget_series where widget_id=w.id and id=any(ids))<>cardinality(ids) then
  raise exception 'gallerySeriesRequired' using errcode='S2C02';end if;
 for r in select d.*,coalesce(v.unit,bs.unit) as gallery_unit,coalesce(v.value_type,bs.value_type) as gallery_value_type,
  v.calculation->>'kind' as calculation_kind from training_load.dashboard_widget_series d
  left join training_load.metric_definitions md on md.id=d.metric_definition_id
  left join training_load.metric_definition_versions v on v.id=md.current_version_id
  left join training_load.dashboard_builtin_series bs on bs.key=d.built_in_series_key
  where d.widget_id=w.id and d.id=any(ids) order by d.id
 loop
  if r.resolution_status<>'resolved' or r.gallery_value_type is distinct from 'numeric' or r.comparison_period is not null then
   raise exception 'gallerySeriesRequired' using errcode='S2C02';end if;
  units:=array_append(units,r.gallery_unit);scopes:=array_append(scopes,r.data_scope_level);
  if s->>'kind' in ('heatmap','boxplot') and r.analytical_aggregation<>'none' then raise exception 'galleryMeasurementsRequired' using errcode='S2C02';end if;
  if s->>'kind'='stacked' and (r.analytical_aggregation='ratio' or r.calculation_kind='ratio' or r.gallery_unit is null or lower(r.gallery_unit) in ('%','percent','percentage')) then
   raise exception 'nonAdditiveComponents' using errcode='S2C02';end if;
  if s->>'kind'='combined' then
   select value into b from jsonb_array_elements(s->'bindings') where (value->>'seriesId')::uuid=r.id;
   axis_key:=b->>'axis';
   if r.gallery_unit is null or r.axis is distinct from (case when axis_key='0' then 'primary' else 'secondary' end)
     or axes?axis_key and axes->>axis_key<>r.gallery_unit then raise exception 'incompatibleAxisUnit' using errcode='S2C02';end if;
   axes:=axes||jsonb_build_object(axis_key,r.gallery_unit);
  end if;
 end loop;
 if s->>'kind'='stacked' and (
   (select count(distinct jsonb_build_array(metric_definition_id,built_in_series_key)) from training_load.dashboard_widget_series where widget_id=w.id and id=any(ids))<>cardinality(ids)
   or exists(select 1 from training_load.dashboard_widget_series component
     join training_load.metric_definitions d on d.id=component.metric_definition_id
     join training_load.metric_definition_versions v on v.id=d.current_version_id
     join training_load.dashboard_widget_series input on input.widget_id=w.id and input.id=any(ids) and input.id<>component.id
     where component.widget_id=w.id and component.id=any(ids) and (v.calculation->'inputs') ? input.metric_definition_id::text)
 ) then raise exception 'nonAdditiveComponents' using errcode='S2C02';end if;
 if (select count(distinct v) from unnest(scopes) v)<>1 then raise exception 'incompatibleScope' using errcode='S2C02';end if;
 if s->>'kind' in ('area','horizontal_bar','stacked') and (select count(distinct jsonb_build_array(v)) from unnest(units) v)<>1 then
  raise exception 'incompatibleAxisUnit' using errcode='S2C02';end if;
end;
$$;
create function training_load.dashboard_chart_shape_deferred() returns trigger language plpgsql as $$
begin
 if tg_table_name='dashboard_widgets' then perform training_load.dashboard_chart_shape_assert(new.id);
 elsif tg_op='DELETE' then perform training_load.dashboard_chart_shape_assert(old.widget_id);
 else perform training_load.dashboard_chart_shape_assert(new.widget_id);end if;
 return null;
end;
$$;
create constraint trigger dashboard_widgets_chart_shape_check after insert or update on training_load.dashboard_widgets
 deferrable initially deferred for each row execute function training_load.dashboard_chart_shape_deferred();
create constraint trigger dashboard_series_chart_shape_check after insert or update or delete on training_load.dashboard_widget_series
 deferrable initially deferred for each row execute function training_load.dashboard_chart_shape_deferred();
create function training_load.dashboard_chart_shapes_available() returns boolean language sql immutable as $$select true;$$;

do $copy_gate$ begin if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.copy_dashboard_page_widget(uuid,uuid,jsonb,uuid,text,uuid,uuid,integer,uuid,integer,timestamp with time zone)')) is distinct from '75953d6b01271f1707c1f28c1a7c0632' then raise exception 'v94 predecessor copy body changed' using errcode='23514';end if;end $copy_gate$;

create function training_load.dashboard_chart_shape_remap(p_config jsonb,p_map jsonb) returns jsonb language plpgsql immutable as $$
declare s jsonb;ids jsonb='[]';bindings jsonb='[]';v jsonb;target text;
begin
 if p_config is null or p_config->'schemaVersion' is distinct from '1'::jsonb or not(p_config?'chartShape') then return p_config;end if;
 s:=p_config->'chartShape';
 for v in select value from jsonb_array_elements(s->'seriesIds') loop
  target:=p_map->>lower(v#>>'{}');if target is null then raise exception 'gallerySeriesRequired' using errcode='S2C02';end if;
  ids:=ids||jsonb_build_array(target);
 end loop;
 s:=jsonb_set(s,'{seriesIds}',ids);
 if s?'bindings' then
  for v in select value from jsonb_array_elements(s->'bindings') loop
   target:=p_map->>lower(v->>'seriesId');if target is null then raise exception 'gallerySeriesRequired' using errcode='S2C02';end if;
   bindings:=bindings||jsonb_build_array(jsonb_set(v,'{seriesId}',to_jsonb(target)));
  end loop;
  s:=jsonb_set(s,'{bindings}',bindings);
 end if;
 return jsonb_set(p_config,'{chartShape}',s);
end;
$$;

create or replace function training_load.copy_dashboard_page_widget(
 p_dashboard_id uuid,p_actor_id uuid,p_workspace jsonb,p_request_id uuid,p_payload_hash text,
 p_source_page_id uuid,p_widget_id uuid,p_expected_widget_revision integer,
 p_destination_page_id uuid,p_expected_page_revision integer,
 p_request_issued_at timestamptz
) returns jsonb language plpgsql as $$
declare source training_load.dashboard_widgets%rowtype; target training_load.dashboard_pages%rowtype;
 recorded training_load.dashboard_page_requests%rowtype; new_id uuid; result jsonb; next_y integer; next_order integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('dashboard-page:'||p_actor_id::text||':'||p_request_id::text,0));
 perform 1 from training_load.dashboards where id=p_dashboard_id for update;
 if not found then raise exception 'notFound' using errcode='P0002';end if;
 perform training_load.assert_dashboard_writable(p_dashboard_id);
 select * into recorded from training_load.dashboard_page_requests where initiator_user_id=p_actor_id and request_id=p_request_id;
 if found then
  if recorded.dashboard_id<>p_dashboard_id or recorded.workspace is distinct from p_workspace or recorded.payload_hash<>p_payload_hash or recorded.request_issued_at is distinct from p_request_issued_at or recorded.operation<>'copy' then
   raise exception 'idempotencyConflict' using errcode='S2C01';end if;
  if recorded.retain_until<=clock_timestamp() then raise exception 'requestExpired' using errcode='S2C06';end if;
  return recorded.receipt;
 end if;
 if p_request_issued_at is null or not isfinite(p_request_issued_at) or date_trunc('milliseconds',p_request_issued_at)<>p_request_issued_at or p_request_issued_at>clock_timestamp()+interval '1 second' then raise exception 'invalidRequest' using errcode='22023';end if;
 if p_request_issued_at<clock_timestamp()-interval '168 hours' then raise exception 'requestExpired' using errcode='S2C06';end if;
 if not coalesce((select enabled from training_load.dashboard_pages_activation where singleton),false) then
  raise exception 'dashboardPagesDisabled' using errcode='23514';end if;
 select * into target from training_load.dashboard_pages where dashboard_id=p_dashboard_id and id=p_destination_page_id;
 if not found then raise exception 'notFound' using errcode='P0002';end if;
 if target.revision<>p_expected_page_revision then raise exception 'staleRevision' using errcode='40001';end if;
 select * into source from training_load.dashboard_widgets where dashboard_id=p_dashboard_id and page_id=p_source_page_id and id=p_widget_id for update;
 if not found then raise exception 'notFound' using errcode='P0002';end if;
 if source.revision<>p_expected_widget_revision then raise exception 'staleRevision' using errcode='40001';end if;
 perform 1 from training_load.dashboard_widget_series where widget_id=p_widget_id order by id for update;
 select coalesce(max(y+height),0),coalesce(max(widget_order)+1,0) into next_y,next_order from training_load.dashboard_widgets where page_id=target.id;
 perform set_config('optimove.dashboard_page',pg_current_xact_id()::text||':'||target.id::text,true);
 insert into training_load.dashboard_widgets(dashboard_id,page_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by,state,display_config,local_filter_override,presentation_config)
 values(p_dashboard_id,target.id,source.widget_type,source.title,next_order,0,next_y,source.width,source.height,next_order,source.group_by,source.state,source.display_config,source.local_filter_override,source.presentation_config)
 returning id into new_id;
 insert into training_load.dashboard_widget_series(widget_id,series_order,metric_definition_id,built_in_series_key,template_metric_key_hints,resolution_status,template_resolution_candidates,
 axis,source_policy,source_connection_id,data_scope_level,analytical_aggregation,aggregation_role_policy,coverage_policy,comparison_period,color,display_label,created_by_user_id)
 select new_id,series_order,metric_definition_id,built_in_series_key,template_metric_key_hints,resolution_status,template_resolution_candidates,
 axis,source_policy,source_connection_id,data_scope_level,analytical_aggregation,aggregation_role_policy,coverage_policy,comparison_period,color,display_label,p_actor_id
 from training_load.dashboard_widget_series where widget_id=p_widget_id order by series_order;

 update training_load.dashboard_widgets set presentation_config=training_load.dashboard_chart_shape_remap(source.presentation_config,
  (select jsonb_object_agg(old_series.id::text,new_series.id::text) from training_load.dashboard_widget_series old_series
   join training_load.dashboard_widget_series new_series on new_series.widget_id=new_id and new_series.series_order=old_series.series_order
   where old_series.widget_id=p_widget_id)) where id=new_id;
 perform set_config('optimove.dashboard_page','',true);
 result:=jsonb_build_object('dashboardId',p_dashboard_id,'pageId',target.id,'widgetId',new_id,'operation','copy');
 insert into training_load.dashboard_page_requests(initiator_user_id,request_id,dashboard_id,workspace,operation,payload_hash,receipt,request_issued_at,retain_until)
 values(p_actor_id,p_request_id,p_dashboard_id,p_workspace,'copy',p_payload_hash,result,p_request_issued_at,p_request_issued_at+interval '168 hours 10 minutes');
 return result;
end;
$$;

do $save_gate$ begin if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)')) is distinct from '33c8f87b3104a723f4c4d140d8922b43' then raise exception 'v94 predecessor Simple save body changed' using errcode='23514';end if;end $save_gate$;
create or replace function training_load.save_simple_widget(p_initiator_user_id uuid, p_request_id uuid, p_payload_hash text, p_request_issued_at timestamp with time zone, p_dashboard_id uuid, p_widget_id uuid, p_expected_widget_revision integer, p_widget jsonb, p_resolved_period jsonb, p_workspace jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
as $$
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
  perform 1 from training_load.dashboard_pages where dashboard_id=p_dashboard_id order by id for update;
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
      where widget.id = (recorded_request.receipt ->> 'widgetId')::uuid and widget.dashboard_id = p_dashboard_id and widget.page_id = training_load.current_dashboard_page(p_dashboard_id) for update;
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
      where widget.id = p_widget_id and widget.dashboard_id = p_dashboard_id and widget.page_id = training_load.current_dashboard_page(p_dashboard_id) for update;
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
      from training_load.dashboard_widgets widget where widget.dashboard_id = p_dashboard_id and widget.page_id = training_load.current_dashboard_page(p_dashboard_id);
    select candidate_x.x::smallint, candidate_y.y::smallint into placement_x, placement_y
      from (
        select 0 as y
        union
        select widget.y::integer + widget.height from training_load.dashboard_widgets widget where widget.dashboard_id = p_dashboard_id and widget.page_id = training_load.current_dashboard_page(p_dashboard_id)
      ) candidate_y
      cross join generate_series(0, 12 - widget_catalog.default_width) candidate_x(x)
      where candidate_y.y <= 32767 - widget_catalog.default_height and not exists (
        select 1 from training_load.dashboard_widgets widget where widget.dashboard_id = p_dashboard_id and widget.page_id = training_load.current_dashboard_page(p_dashboard_id)
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
  if desired_widget.presentation_config->'schemaVersion'='1'::jsonb and desired_widget.presentation_config?'chartShape' then
    desired_widget.presentation_config:=training_load.dashboard_chart_shape_remap(desired_widget.presentation_config,jsonb_build_object(lower(compiled_series->>'id'),actual_series_id::text));
    update training_load.dashboard_widgets set presentation_config=desired_widget.presentation_config
      where id=actual_widget_id and presentation_config is distinct from desired_widget.presentation_config;
    perform training_load.dashboard_chart_shape_assert(actual_widget_id);
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
  if training_load.dashboard_page_context_matches(training_load.current_dashboard_page(p_dashboard_id)) then
    saved_receipt:=saved_receipt||jsonb_build_object('pageId',training_load.current_dashboard_page(p_dashboard_id));
  end if;
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
