do $prior_a$
begin
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.assert_dashboard_writable(uuid)')) is distinct from 'f87c11a22a39517c37fbf1e4f117a69b' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.current_dashboard_page(uuid)')) is distinct from '5deeaf70aefbc0655f262cc94f3c9dc8' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_home_required()')) is distinct from 'a0f385cf24691b3389e2397d23ae4c07' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_home_sync_defaults()')) is distinct from '70f38353a470245079231daf2ee93478' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_page_context_matches(uuid)')) is distinct from '79ae2ff5f31f2cd8dffff2c40402147e' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_page_period_valid(jsonb)')) is distinct from 'de37086fc382ec8b50173412cd8b1924' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widget_assign_home()')) is distinct from '673f26f5b9949bb1241b0d5d884b2458' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widget_bump_page_revision()')) is distinct from 'b3ab8b1d33176e95fa5f9352ea0ddea7' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widgets_check_no_overlap()')) is distinct from '96b0f3fed42ce4eca49a13468d44b838' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.delete_dashboard(uuid,integer,uuid,character varying)')) is distinct from '19453ff4134447c03da1a2db1147dd27' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.ensure_dashboard_home()')) is distinct from 'f5666f32e7fd0a2dfcf2fc8e1faf4c25' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_dashboard_page_identity()')) is distinct from '60599a027271957e8aa6d1c23a74c030' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_dashboard_widget_page_protocol()')) is distinct from '4915decb92f583bf2b75d8dd30d478d0' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)')) is distinct from '33c8f87b3104a723f4c4d140d8922b43' then raise exception 'v91: v90 function body changed' using errcode='23514';end if;
end
$prior_a$;

-- P1 B: CREATE-only Page operations. Stage A already owns compatible schema/bodies.
set local lock_timeout='5s';
set local statement_timeout='30s';
do $gate$ begin
 if (select checksum from public.schema_migrations where migration_name='migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql') is distinct from 'dcfb07b959cc886fa1b3f99faad6916288d19448b837ebffbdb36b0aefc0bbaf' then raise exception 'v91 requires the exact v90 file' using errcode='23514';end if;
 if to_regclass('training_load.dashboard_pages') is null
 or not exists(select 1 from public.schema_migrations where migration_name='migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql') then
  raise exception 'v91 requires v90' using errcode='23514';
 end if;
end $gate$;

create table training_load.dashboard_page_requests (
 initiator_user_id uuid not null references public.users(id),
 request_id uuid not null,
 dashboard_id uuid not null, -- receipt survives whole-dashboard deletion, as v71 does
 workspace jsonb not null,
 operation text not null,
 payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
 receipt jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 request_issued_at timestamptz not null,
 retain_until timestamptz not null,
 primary key(initiator_user_id,request_id),
 check(retain_until=request_issued_at+interval '168 hours 10 minutes')
);
create index dashboard_page_requests_retention_idx on training_load.dashboard_page_requests(retain_until);

create function training_load.guard_dashboard_page_requests() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' and old.retain_until<=clock_timestamp()
  and current_setting('optimove.dashboard_page_retention',true)=pg_current_xact_id()::text then return old; end if;
 raise exception 'dashboardPageReceiptImmutable' using errcode='23514';
end;
$$;
create trigger dashboard_page_requests_immutable before update or delete on training_load.dashboard_page_requests
 for each row execute function training_load.guard_dashboard_page_requests();
create trigger dashboard_page_requests_no_truncate before truncate on training_load.dashboard_page_requests
 for each statement execute function training_load.guard_dashboard_page_requests();

create function training_load.cleanup_dashboard_page_requests(p_limit integer default 100) returns integer language plpgsql as $$
declare affected integer;
begin
 if p_limit is null or p_limit<1 or p_limit>1000 then raise exception 'invalidRequest' using errcode='22023'; end if;
 perform set_config('optimove.dashboard_page_retention',pg_current_xact_id()::text,true);
 with expired as (select initiator_user_id,request_id from training_load.dashboard_page_requests
   where retain_until<=clock_timestamp() order by retain_until,initiator_user_id,request_id limit p_limit for update skip locked)
 delete from training_load.dashboard_page_requests r using expired e
 where r.initiator_user_id=e.initiator_user_id and r.request_id=e.request_id;
 get diagnostics affected=row_count;
 perform set_config('optimove.dashboard_page_retention','',true);
 return affected;
end;
$$;

-- Caller locks live actor/rights/workspace before invoking any write function.
-- This entry locks dashboard then all Pages in UUID order before writing anything.
create function training_load.mutate_dashboard_page(
 p_dashboard_id uuid,p_actor_id uuid,p_workspace jsonb,p_request_id uuid,p_payload_hash text,
 p_expected_pages_revision integer,p_operation text,p_page_id uuid,p_input jsonb,
 p_request_issued_at timestamptz
) returns jsonb language plpgsql as $$
declare d training_load.dashboards%rowtype; p training_load.dashboard_pages%rowtype;
 recorded training_load.dashboard_page_requests%rowtype; result jsonb; entry jsonb; count_pages integer; changed boolean:=false; changed_count integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('dashboard-page:'||p_actor_id::text||':'||p_request_id::text,0));
 select * into d from training_load.dashboards where id=p_dashboard_id for update;
 if not found then raise exception 'notFound' using errcode='P0002'; end if;
 perform training_load.assert_dashboard_writable(p_dashboard_id);
 select * into recorded from training_load.dashboard_page_requests where initiator_user_id=p_actor_id and request_id=p_request_id;
 if found then
  if recorded.dashboard_id<>p_dashboard_id or recorded.workspace is distinct from p_workspace
   or recorded.payload_hash<>p_payload_hash or recorded.request_issued_at is distinct from p_request_issued_at or recorded.operation<>p_operation then
   raise exception 'idempotencyConflict' using errcode='S2C01';
  end if;
  if recorded.retain_until<=clock_timestamp() then raise exception 'requestExpired' using errcode='S2C06'; end if;
  return recorded.receipt;
 end if;
 if p_request_issued_at is null or not isfinite(p_request_issued_at) or date_trunc('milliseconds',p_request_issued_at)<>p_request_issued_at or p_request_issued_at>clock_timestamp()+interval '1 second' then raise exception 'invalidRequest' using errcode='22023';end if;
 if p_request_issued_at<clock_timestamp()-interval '168 hours' then raise exception 'requestExpired' using errcode='S2C06';end if;
 if not coalesce((select enabled from training_load.dashboard_pages_activation where singleton),false) then
  raise exception 'dashboardPagesDisabled' using errcode='23514';
 end if;
 if d.pages_revision<>p_expected_pages_revision then raise exception 'staleRevision' using errcode='40001'; end if;
 if p_operation not in ('create','rename','reorder','delete','defaults') or jsonb_typeof(p_input)<>'object' then
  raise exception 'invalidRequest' using errcode='22023';
 end if;
 if p_operation='create' then
  select count(*) into count_pages from training_load.dashboard_pages where dashboard_id=p_dashboard_id;
  if count_pages>=20 then raise exception 'pageLimit' using errcode='23514'; end if;
  insert into training_load.dashboard_pages(dashboard_id,name,position,default_filter,period_config)
   values(p_dashboard_id,p_input->>'name',count_pages,coalesce(p_input->'defaultFilter','{}'::jsonb),p_input->'period') returning * into p;
  changed:=true;
 elsif p_operation='reorder' then
  if jsonb_typeof(p_input->'pageIds')<>'array'
   or jsonb_array_length(p_input->'pageIds')<>(select count(*) from training_load.dashboard_pages where dashboard_id=p_dashboard_id)
   or (select count(distinct value) from jsonb_array_elements_text(p_input->'pageIds'))<>jsonb_array_length(p_input->'pageIds')
   or exists(select 1 from jsonb_array_elements_text(p_input->'pageIds') e(value) left join training_load.dashboard_pages x on x.id=e.value::uuid and x.dashboard_id=p_dashboard_id where x.id is null)
   or not exists(select 1 from training_load.dashboard_pages where dashboard_id=p_dashboard_id and is_home and id=(p_input->'pageIds'->>0)::uuid) then
   raise exception 'invalidRequest' using errcode='22023';
  end if;
  for entry in select jsonb_build_object('id',value,'position',ordinality-1) from jsonb_array_elements_text(p_input->'pageIds') with ordinality loop
   update training_load.dashboard_pages set position=(entry->>'position')::int,revision=revision+1,updated_at=now()
    where dashboard_id=p_dashboard_id and id=(entry->>'id')::uuid and position<>(entry->>'position')::int;
   get diagnostics changed_count=row_count;changed:=changed or changed_count>0;
  end loop;
 else
  select * into p from training_load.dashboard_pages where id=p_page_id and dashboard_id=p_dashboard_id;
  if not found then raise exception 'notFound' using errcode='P0002'; end if;
  if p_operation='rename' then
   if p.name is distinct from p_input->>'name' then
    update training_load.dashboard_pages set name=p_input->>'name',revision=revision+1,updated_at=now() where id=p.id returning * into p;changed:=true;
   end if;
  elsif p_operation='delete' then
   delete from training_load.dashboard_pages where id=p.id;changed:=true;
   update training_load.dashboard_pages set position=position-1,revision=revision+1,updated_at=now() where dashboard_id=p_dashboard_id and position>p.position;
  else
   if p.defaults_revision is distinct from (p_input->>'expectedDefaultsRevision')::int then raise exception 'staleRevision' using errcode='40001';end if;
   -- One actual default change gives exactly one Page/defaults bump.
   if p.default_filter is distinct from nullif(p_input->'defaultFilter','null'::jsonb)
    or p.period_config is distinct from nullif(p_input->'period','null'::jsonb) then
    if p.is_home and p.default_filter is distinct from nullif(p_input->'defaultFilter','null'::jsonb) then
     perform training_load.update_dashboard_metadata(p_dashboard_id,d.revision,null,null,false,nullif(p_input->'defaultFilter','null'::jsonb),(nullif(p_input->'defaultFilter','null'::jsonb) is null),null);
    end if;
    update training_load.dashboard_pages set default_filter=nullif(p_input->'defaultFilter','null'::jsonb),period_config=nullif(p_input->'period','null'::jsonb),
     revision=p.revision+1,defaults_revision=p.defaults_revision+1,updated_at=now() where id=p.id returning * into p;
   end if;
  end if;
 end if;
 if changed and p_operation in ('create','rename','reorder','delete') then
  update training_load.dashboards set pages_revision=pages_revision+1 where id=p_dashboard_id returning * into d;
 end if;
 result:=jsonb_build_object('pageId',p.id,'dashboardId',p_dashboard_id,'pagesRevision',d.pages_revision,'operation',p_operation);
 insert into training_load.dashboard_page_requests(initiator_user_id,request_id,dashboard_id,workspace,operation,payload_hash,receipt,request_issued_at,retain_until)
 values(p_actor_id,p_request_id,p_dashboard_id,p_workspace,p_operation,p_payload_hash,result,p_request_issued_at,p_request_issued_at+interval '168 hours 10 minutes');
 return result;
end;
$$;

create function training_load.copy_dashboard_page_widget(
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
 perform set_config('optimove.dashboard_page','',true);
 result:=jsonb_build_object('dashboardId',p_dashboard_id,'pageId',target.id,'widgetId',new_id,'operation','copy');
 insert into training_load.dashboard_page_requests(initiator_user_id,request_id,dashboard_id,workspace,operation,payload_hash,receipt,request_issued_at,retain_until)
 values(p_actor_id,p_request_id,p_dashboard_id,p_workspace,'copy',p_payload_hash,result,p_request_issued_at,p_request_issued_at+interval '168 hours 10 minutes');
 return result;
end;
$$;

create function training_load.save_simple_page_widget(
 p_page_id uuid,p_expected_defaults_revision integer,
 p_initiator_user_id uuid,p_request_id uuid,p_payload_hash text,p_request_issued_at timestamptz,
 p_dashboard_id uuid,p_widget_id uuid,p_expected_widget_revision integer,
 p_widget jsonb,p_resolved_period jsonb,p_workspace jsonb,p_save_period_config jsonb default null
) returns jsonb language plpgsql as $$
declare page training_load.dashboard_pages%rowtype;receipt jsonb;replay boolean;
begin
 perform 1 from training_load.dashboards where id=p_dashboard_id for update;
 if not found then raise exception 'notFound' using errcode='S2C07';end if;
 perform training_load.assert_dashboard_writable(p_dashboard_id);
 select * into page from training_load.dashboard_pages where id=p_page_id and dashboard_id=p_dashboard_id;
 if not found or not coalesce((select enabled from training_load.dashboard_pages_activation where singleton),false) then
  raise exception 'notFound' using errcode='S2C07';end if;
 replay:=exists(select 1 from training_load.dashboard_simple_requests where initiator_user_id=p_initiator_user_id and request_id=p_request_id);
 if not replay and page.defaults_revision<>p_expected_defaults_revision then raise exception 'staleRevision' using errcode='40001';end if;
 if p_widget_id is not null and not exists(select 1 from training_load.dashboard_widgets where id=p_widget_id and page_id=page.id and dashboard_id=p_dashboard_id) then
  raise exception 'notFound' using errcode='S2C07';end if;
 perform set_config('optimove.dashboard_page',pg_current_xact_id()::text||':'||page.id::text,true);
 receipt:=training_load.save_simple_widget(p_initiator_user_id,p_request_id,p_payload_hash,p_request_issued_at,
 p_dashboard_id,p_widget_id,p_expected_widget_revision,p_widget,p_resolved_period,p_workspace);
 if not replay and p_save_period_config is not null and page.period_config is distinct from p_save_period_config then
  update training_load.dashboard_pages set period_config=p_save_period_config,revision=revision+1,defaults_revision=defaults_revision+1,updated_at=now() where id=page.id;
 end if;
 perform set_config('optimove.dashboard_page','',true);
 return receipt;
end;
$$;

-- Page-aware adapters reuse the existing catalog/series/presentation validators.
-- They take every hierarchy lock before the first write and never move a widget.
create function training_load.write_dashboard_page_widget(
 p_dashboard_id uuid,p_page_id uuid,p_expected_page_revision integer,p_operation text,
 p_widget_id uuid,p_series_id uuid,p_actor_id uuid,p_body jsonb
) returns jsonb language plpgsql as $$
declare parent training_load.dashboards%rowtype;page training_load.dashboard_pages%rowtype;
 existing training_load.dashboard_widgets%rowtype;result jsonb;entry jsonb;layout_rows jsonb;
begin
 select * into parent from training_load.dashboards where id=p_dashboard_id for update;
 if not found then raise exception 'notFound' using errcode='P0002';end if;
 perform training_load.assert_dashboard_writable(p_dashboard_id);
 select * into page from training_load.dashboard_pages where id=p_page_id and dashboard_id=p_dashboard_id;
 if not found or not coalesce((select enabled from training_load.dashboard_pages_activation where singleton),false) then
  raise exception 'notFound' using errcode='P0002';end if;
 if p_expected_page_revision is not null and p_expected_page_revision<>page.revision then raise exception 'staleRevision' using errcode='40001';end if;
 if p_operation in ('create','layout') and p_expected_page_revision is null then raise exception 'invalidRequest' using errcode='22023';end if;
 if p_operation not in ('create','layout') then
  select * into existing from training_load.dashboard_widgets where id=p_widget_id and dashboard_id=p_dashboard_id and page_id=p_page_id for update;
  if not found then raise exception 'notFound' using errcode='P0002';end if;
  perform 1 from training_load.dashboard_widget_series where widget_id=p_widget_id order by id for update;
 end if;
 if p_operation='layout' then
  if jsonb_typeof(p_body->'layout') is distinct from 'array'
   or jsonb_array_length(p_body->'layout')<>(select count(*) from training_load.dashboard_widgets where page_id=p_page_id)
   or exists(select 1 from jsonb_array_elements(p_body->'layout') e left join training_load.dashboard_widgets w on w.id=(e->>'widgetId')::uuid and w.page_id=p_page_id where w.id is null)
   or (select count(distinct e->>'widgetId') from jsonb_array_elements(p_body->'layout') e)<>jsonb_array_length(p_body->'layout') then
   raise exception 'invalidRequest' using errcode='22023';end if;
  perform 1 from training_load.dashboard_widgets where page_id=p_page_id order by id for update;
 end if;
 perform set_config('optimove.dashboard_page',pg_current_xact_id()::text||':'||page.id::text,true);
 if p_operation='create' then
  select to_jsonb(r) into result from training_load.create_widget_with_presentation(
   p_dashboard_id,parent.revision,p_body->>'widgetType',p_body->>'title',(p_body->>'widgetOrder')::int,
   (p_body->>'x')::smallint,(p_body->>'y')::smallint,(p_body->>'width')::smallint,(p_body->>'height')::smallint,(p_body->>'mobileOrder')::int,
   coalesce(p_body->>'groupBy','day')::varchar,coalesce(p_body->'displayConfig','{"schemaVersion":1}'::jsonb),nullif(p_body->'localFilterOverride','null'::jsonb),
   nullif(p_body->'presentation'->'value','null'::jsonb)) r;
  result:=jsonb_build_object('widgetId',result->'widget_id','dashboardRevision',result->'dashboard_revision');
 elsif p_operation='layout' then
  select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into layout_rows from training_load.replace_dashboard_layout(p_dashboard_id,parent.revision,p_body->'layout') r;
  result:=jsonb_build_object('widgets',layout_rows);
 elsif p_operation='content' then
  select to_jsonb(r) into result from training_load.update_widget_content_with_presentation(
   p_widget_id,(p_body->>'expectedWidgetRevision')::int,p_body->>'widgetType',p_body->>'title',(p_body->>'groupBy')::varchar,(p_body->>'state')::varchar,p_body->'displayConfig',
   nullif(p_body->'localFilterOverride','null'::jsonb),p_body?'localFilterOverride' and p_body->'localFilterOverride'='null'::jsonb,
   coalesce(p_body->'presentation'->>'mode','preserve'),nullif(p_body->'presentation'->'value','null'::jsonb)) r;
  result:=jsonb_build_object('widget',result);
 elsif p_operation='widgetLayout' then
  select to_jsonb(r) into result from training_load.update_widget_layout(p_widget_id,(p_body->>'expectedWidgetRevision')::int,(p_body->>'x')::smallint,(p_body->>'y')::smallint,(p_body->>'width')::smallint,(p_body->>'height')::smallint,(p_body->>'mobileOrder')::int) r;
  result:=jsonb_build_object('widget',result);
 elsif p_operation='delete' then
  select to_jsonb(r) into result from training_load.delete_widget(p_widget_id,(p_body->>'expectedWidgetRevision')::int) r;
  result:=jsonb_build_object('dashboard',result);
 elsif p_operation='addSeries' then
  select to_jsonb(r) into result from training_load.add_series(
   p_widget_id,(p_body->>'expectedWidgetRevision')::int,(p_body->>'seriesOrder')::int,(p_body->>'metricDefinitionId')::uuid,p_body->>'builtInSeriesKey',nullif(p_body->'templateMetricKeyHints','null'::jsonb),
   coalesce(p_body->>'axis','primary')::varchar,p_body->>'color',p_body->>'displayLabel',coalesce(p_body->>'sourcePolicy',case when p_body?'builtInSeriesKey' then 'not_applicable' else 'all_with_conflicts' end)::varchar,
   (p_body->>'sourceConnectionId')::uuid,coalesce(p_body->>'dataScopeLevel','session')::varchar,coalesce(p_body->>'analyticalAggregation','sum')::varchar,
   coalesce(p_body->>'aggregationRolePolicy','standalone_and_source_rollup')::varchar,coalesce(p_body->>'coveragePolicy','complete_and_partial')::varchar,(p_body->>'comparisonPeriod')::varchar,p_actor_id) r;
  result:=jsonb_build_object('seriesId',result->'series_id','widgetRevision',result->'widget_revision');
 elsif p_operation='updateSeries' then
  select to_jsonb(r) into result from training_load.update_series(p_series_id,p_widget_id,(p_body->>'expectedWidgetRevision')::int,
   (p_body->>'axis')::varchar,p_body->>'color',p_body?'color' and p_body->'color'='null'::jsonb,p_body->>'displayLabel',p_body?'displayLabel' and p_body->'displayLabel'='null'::jsonb,
   (p_body->>'sourcePolicy')::varchar,(p_body->>'sourceConnectionId')::uuid,(p_body->>'dataScopeLevel')::varchar,(p_body->>'analyticalAggregation')::varchar,
   (p_body->>'aggregationRolePolicy')::varchar,(p_body->>'coveragePolicy')::varchar,(p_body->>'comparisonPeriod')::varchar,p_body?'comparisonPeriod' and p_body->'comparisonPeriod'='null'::jsonb) r;
  result:=jsonb_build_object('seriesId',result->'series_id','widgetRevision',result->'widget_revision');
 elsif p_operation='deleteSeries' then
  select to_jsonb(r) into result from training_load.delete_series(p_series_id,p_widget_id,(p_body->>'expectedWidgetRevision')::int) r;result:=jsonb_build_object('widget',result);
 elsif p_operation='reorderSeries' then
  select to_jsonb(r) into result from training_load.reorder_series(p_widget_id,(p_body->>'expectedWidgetRevision')::int,p_body->'order') r;result:=jsonb_build_object('widget',result);
 elsif p_operation='resolveSeries' then
  select to_jsonb(r) into result from training_load.resolve_series_binding(p_series_id,p_widget_id,(p_body->>'expectedWidgetRevision')::int,(p_body->>'metricDefinitionId')::uuid) r;
  result:=jsonb_build_object('seriesId',result->'series_id','widgetRevision',result->'widget_revision');
 else raise exception 'invalidRequest' using errcode='22023';
 end if;
 perform set_config('optimove.dashboard_page','',true);
 return result;
end;
$$;
