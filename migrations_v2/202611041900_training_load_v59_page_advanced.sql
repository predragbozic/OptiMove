-- v59 Page Advanced (v57 + v58 required). SECURITY INVOKER throughout.
-- 12 Advanced writer copies; Simple retains its separate v58 Page port.
-- API shape validation/bounds belong to the JS adapter. SQL verifies fresh
-- authority, real UUID parents, CAS and a fixed operation whitelist.
-- Replay requires a LIVE authorized dashboard; Page/widget/series may be deleted.
-- Receipt replay precedes archive/template/revision checks. No ledger FKs or purge.
-- GUCs scope triggers only; they are not credentials or a privilege boundary.

create table training_load.dashboard_page_advanced_requests (
  initiator_user_id uuid not null,
  request_id uuid not null,
  workspace jsonb not null check(jsonb_typeof(workspace)='object'),
  dashboard_id uuid not null,
  page_id uuid not null,
  operation text not null check(operation in ('layout','widgetCreate','widgetLayout','widgetContent','widgetDelete',
    'seriesAdd','seriesUpdate','seriesDelete','seriesReorder','seriesResolve')),
  widget_id uuid,
  series_id uuid,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check(jsonb_typeof(receipt)='object'),
  created_at timestamptz not null default now(),
  primary key(initiator_user_id,request_id)
);
revoke all on training_load.dashboard_page_advanced_requests from public;
create trigger dashboard_page_advanced_requests_append_only before update or delete
  on training_load.dashboard_page_advanced_requests for each row
  execute function training_load.dashboard_deletion_log_append_only();
create trigger dashboard_page_advanced_requests_no_truncate before truncate
  on training_load.dashboard_page_advanced_requests for each statement
  execute function training_load.dashboard_deletion_log_append_only();

-- Real parent guard used ONLY by new copies. Legacy entry guards stay closed.
create function training_load.page_advanced_parent_guard(p_page_id uuid,p_dashboard_id uuid,p_widget_id uuid)
returns void language plpgsql as $$
declare parent uuid;
begin
  select dashboard_id into parent from training_load.dashboard_pages where id=p_page_id;
  if parent is null or (p_dashboard_id is not null and parent<>p_dashboard_id) then
    raise exception 'notFound' using errcode='P4P10'; end if;
  perform 1 from training_load.dashboards where id=parent for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  perform 1 from training_load.dashboard_pages where id=p_page_id and dashboard_id=parent for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  if p_widget_id is not null then
    perform 1 from training_load.dashboard_widgets where id=p_widget_id and dashboard_id=parent and page_id=p_page_id for update;
    if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  end if;
end $$;

create or replace function training_load.dashboard_page_internal(p_dashboard uuid,p_page uuid,p_operation text default null)
returns boolean language plpgsql stable as $$
declare s jsonb;
begin
  s := nullif(current_setting('training_load.page_mutation',true),'')::jsonb;
  return coalesce(s->>'dashboardId'=p_dashboard::text and s->>'pageId'=p_page::text
    and s->>'operation' in ('duplicate','delete','simpleSave','advanced')
    and (p_operation is null or s->>'operation'=p_operation)
    and exists(select 1 from training_load.dashboard_pages where id=p_page and dashboard_id=p_dashboard),false);
exception when invalid_text_representation then return false;
end $$;

-- Pin complete LF-normalized post-v58 legacy bodies. Each replacement is
-- counted. Dynamic DDL is migration-owned text, never user input or API SQL.
do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='replace_dashboard_layout')<>1 then
    raise exception 'v59: expected exactly one source replace_dashboard_layout'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='replace_dashboard_layout'
      and p.oid='training_load.replace_dashboard_layout(uuid,integer,jsonb)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'22201639c9b6f0bccc1c0e8dcc6d8c5c' then
    raise exception 'v59: source drift replace_dashboard_layout'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(p_dashboard_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,p_dashboard_id,null);$new$,1),
    ($old$w.dashboard_id = p_dashboard_id$old$,$new$w.dashboard_id = p_dashboard_id and w.page_id = p_page_id$new$,2)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift replace_dashboard_layout: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_replace_dashboard_layout(p_page_id uuid, p_dashboard_id uuid,
  p_expected_revision integer,
  p_layout jsonb -- [{"widgetId": "...", "x":0,"y":0,"width":4,"height":2,"mobileOrder":1}, ...]
) returns table (widget_id uuid, x smallint, y smallint, width smallint, height smallint, mobile_order integer, revision integer, dashboard_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='update_widget_layout')<>1 then
    raise exception 'v59: expected exactly one source update_widget_layout'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='update_widget_layout'
      and p.oid='training_load.update_widget_layout(uuid,integer,smallint,smallint,smallint,smallint,integer)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'ed47cca1f5c99b171735f6d06eb3c3fd' then
    raise exception 'v59: source drift update_widget_layout'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift update_widget_layout: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_update_widget_layout(p_page_id uuid, p_widget_id uuid,
  p_expected_widget_revision integer,
  p_x smallint default null,
  p_y smallint default null,
  p_width smallint default null,
  p_height smallint default null,
  p_mobile_order integer default null
) returns table (
  widget_id uuid, dashboard_id uuid, x smallint, y smallint, width smallint, height smallint,
  mobile_order integer, widget_revision integer, dashboard_revision integer
) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='create_widget')<>1 then
    raise exception 'v59: expected exactly one source create_widget'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='create_widget'
      and p.oid='training_load.create_widget(uuid,integer,text,text,integer,smallint,smallint,smallint,smallint,integer,varchar,jsonb,jsonb)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'69fc131dfe6fe2e4e728ae318ceaee05' then
    raise exception 'v59: source drift create_widget'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(p_dashboard_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,p_dashboard_id,null);$new$,1),
    ($old$(dashboard_id, widget_type,$old$,$new$(dashboard_id, page_id, widget_type,$new$,1),
    ($old$values (p_dashboard_id, p_widget_type,$old$,$new$values (p_dashboard_id, p_page_id, p_widget_type,$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift create_widget: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_create_widget(p_page_id uuid, p_dashboard_id uuid, p_expected_dashboard_revision integer,
  p_widget_type text, p_title text, p_widget_order integer,
  p_x smallint, p_y smallint, p_width smallint, p_height smallint, p_mobile_order integer,
  p_group_by varchar default ''day'', p_display_config jsonb default ''{"schemaVersion": 1}''::jsonb,
  p_local_filter_override jsonb default null
) returns table (widget_id uuid, dashboard_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='update_widget_content')<>1 then
    raise exception 'v59: expected exactly one source update_widget_content'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='update_widget_content'
      and p.oid='training_load.update_widget_content(uuid,integer,text,text,varchar,varchar,jsonb,jsonb,boolean)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'d1246139debdc65dc6e0398721aff684' then
    raise exception 'v59: source drift update_widget_content'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift update_widget_content: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_update_widget_content(p_page_id uuid, p_widget_id uuid, p_expected_widget_revision integer,
  p_widget_type text default null, p_title text default null, p_group_by varchar default null,
  p_state varchar default null, p_display_config jsonb default null,
  p_local_filter_override jsonb default null, p_clear_local_filter_override boolean default false
) returns table (widget_id uuid, widget_revision integer, dashboard_id uuid) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='delete_widget')<>1 then
    raise exception 'v59: expected exactly one source delete_widget'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='delete_widget'
      and p.oid='training_load.delete_widget(uuid,integer)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'c252e7a887ed025aa4078f8b5d4966b9' then
    raise exception 'v59: source drift delete_widget'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift delete_widget: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_delete_widget(p_page_id uuid, p_widget_id uuid, p_expected_widget_revision integer
) returns table (dashboard_id uuid, dashboard_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='add_series')<>1 then
    raise exception 'v59: expected exactly one source add_series'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='add_series'
      and p.oid='training_load.add_series(uuid,integer,integer,uuid,text,jsonb,varchar,text,text,varchar,uuid,varchar,varchar,varchar,varchar,varchar,uuid)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'50396f796fd829885dacf80c90779312' then
    raise exception 'v59: source drift add_series'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift add_series: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_add_series(p_page_id uuid, p_widget_id uuid, p_expected_widget_revision integer, p_series_order integer,
  p_metric_definition_id uuid default null, p_built_in_series_key text default null,
  p_template_metric_key_hints jsonb default null,
  p_axis varchar default ''primary'', p_color text default null, p_display_label text default null,
  p_source_policy varchar default ''all_with_conflicts'', p_source_connection_id uuid default null,
  p_data_scope_level varchar default ''session'', p_analytical_aggregation varchar default ''sum'',
  p_aggregation_role_policy varchar default ''standalone_and_source_rollup'', p_coverage_policy varchar default ''complete_and_partial'',
  p_comparison_period varchar default null, p_created_by_user_id uuid default null
) returns table (series_id uuid, widget_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='update_series')<>1 then
    raise exception 'v59: expected exactly one source update_series'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='update_series'
      and p.oid='training_load.update_series(uuid,uuid,integer,varchar,text,boolean,text,boolean,varchar,uuid,varchar,varchar,varchar,varchar,varchar,boolean)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'648237029b1ef0ebbaced4951da14125' then
    raise exception 'v59: source drift update_series'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift update_series: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_update_series(p_page_id uuid, p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer,
  p_axis varchar default null, p_color text default null, p_clear_color boolean default false,
  p_display_label text default null, p_clear_display_label boolean default false,
  p_source_policy varchar default null, p_source_connection_id uuid default null,
  p_data_scope_level varchar default null, p_analytical_aggregation varchar default null,
  p_aggregation_role_policy varchar default null, p_coverage_policy varchar default null,
  p_comparison_period varchar default null, p_clear_comparison_period boolean default false
) returns table (series_id uuid, widget_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='resolve_series_binding')<>1 then
    raise exception 'v59: expected exactly one source resolve_series_binding'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='resolve_series_binding'
      and p.oid='training_load.resolve_series_binding(uuid,uuid,integer,uuid)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'e9df64783bd5afcf2329238e3b0c2e4b' then
    raise exception 'v59: source drift resolve_series_binding'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift resolve_series_binding: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_resolve_series_binding(p_page_id uuid, p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer, p_metric_definition_id uuid
) returns table (series_id uuid, widget_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='delete_series')<>1 then
    raise exception 'v59: expected exactly one source delete_series'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='delete_series'
      and p.oid='training_load.delete_series(uuid,uuid,integer)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'fcd75ed6215e14a11ade6c247653a67a' then
    raise exception 'v59: source drift delete_series'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift delete_series: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_delete_series(p_page_id uuid, p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer
) returns table (widget_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='reorder_series')<>1 then
    raise exception 'v59: expected exactly one source reorder_series'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='reorder_series'
      and p.oid='training_load.reorder_series(uuid,integer,jsonb)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'b2beb5364d9971ddba93f74c8e8c28ff' then
    raise exception 'v59: source drift reorder_series'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift reorder_series: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_reorder_series(p_page_id uuid, p_widget_id uuid, p_expected_widget_revision integer, p_order jsonb
) returns table (widget_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='create_widget_with_presentation')<>1 then
    raise exception 'v59: expected exactly one source create_widget_with_presentation'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='create_widget_with_presentation'
      and p.oid='training_load.create_widget_with_presentation(uuid,integer,text,text,integer,smallint,smallint,smallint,smallint,integer,varchar,jsonb,jsonb,jsonb)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'29c00d2b3cbdf76bba9dc5b014fcf264' then
    raise exception 'v59: source drift create_widget_with_presentation'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(p_dashboard_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,p_dashboard_id,null);$new$,1),
    ($old$training_load.create_widget(
    p_dashboard_id$old$,$new$training_load.page_advanced_create_widget(
    p_page_id, p_dashboard_id$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift create_widget_with_presentation: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_create_widget_with_presentation(p_page_id uuid, p_dashboard_id uuid, p_expected_dashboard_revision integer,
  p_widget_type text, p_title text, p_widget_order integer,
  p_x smallint, p_y smallint, p_width smallint, p_height smallint, p_mobile_order integer,
  p_group_by varchar, p_display_config jsonb, p_local_filter_override jsonb, p_presentation_config jsonb
) returns table (widget_id uuid, dashboard_revision integer) language plpgsql as ' || quote_literal(body);
end $copy$;

do $copy$
declare original text; body text; r record; n integer;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='training_load' and p.proname='update_widget_content_with_presentation')<>1 then
    raise exception 'v59: expected exactly one source update_widget_content_with_presentation'; end if;
  select replace(p.prosrc,chr(13),'') into original from pg_proc p
    join pg_namespace ns on ns.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang
    where ns.nspname='training_load' and p.proname='update_widget_content_with_presentation'
      and p.oid='training_load.update_widget_content_with_presentation(uuid,integer,text,text,varchar,varchar,jsonb,jsonb,boolean,text,jsonb)'::regprocedure
      and lang.lanname='plpgsql' and not p.prosecdef;
  if original is null or md5(original)<>'df33dbf70d51c4718197dba26d7b1944' then
    raise exception 'v59: source drift update_widget_content_with_presentation'; end if;
  body:=original;
  for r in select * from (values
    ($old$perform training_load.dashboard_legacy_page_guard(null,p_widget_id);$old$,$new$perform training_load.page_advanced_parent_guard(p_page_id,null,p_widget_id);$new$,1)
  ) replacements(before_text,after_text,expected_count) loop
    r.before_text:=replace(r.before_text,chr(13),''); r.after_text:=replace(r.after_text,chr(13),'');
    n:=(length(body)-length(replace(body,r.before_text,'')))/length(r.before_text);
    if n<>r.expected_count then raise exception 'v59: anchor drift update_widget_content_with_presentation: %',r.before_text; end if;
    body:=replace(body,r.before_text,r.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v59: legacy guard retained'; end if;
  execute 'create function training_load.page_advanced_update_widget_content_with_presentation(p_page_id uuid, p_widget_id uuid, p_expected_widget_revision integer,
  p_widget_type text, p_title text, p_group_by varchar, p_state varchar, p_display_config jsonb,
  p_local_filter_override jsonb, p_clear_local_filter_override boolean,
  p_presentation_mode text, p_presentation_config jsonb
) returns table (widget_id uuid, widget_revision integer, dashboard_id uuid) language plpgsql as ' || quote_literal(body);
end $copy$;

create function training_load.mutate_dashboard_page_advanced(
  p_actor uuid,p_request uuid,p_payload_hash text,p_dashboard uuid,p_page uuid,
  p_widget uuid,p_series uuid,p_operation text,p_input jsonb,p_workspace jsonb
) returns jsonb language plpgsql as $$
declare
  ws jsonb; d training_load.dashboards%rowtype; pg training_load.dashboard_pages%rowtype;
  w training_load.dashboard_widgets%rowtype;
  recorded training_load.dashboard_page_advanced_requests%rowtype;
  revision_key text; expected numeric; entry jsonb; member_id uuid;
  previous_scope text; raw jsonb; result jsonb; receipt jsonb;
begin
  if p_actor is null or p_request is null or p_dashboard is null or p_page is null
    or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_operation is null or p_operation not in ('layout','widgetCreate','widgetLayout','widgetContent','widgetDelete',
      'seriesAdd','seriesUpdate','seriesDelete','seriesReorder','seriesResolve')
    or jsonb_typeof(p_input) is distinct from 'object'
    or p_input->'contractVersion' is distinct from '1'::jsonb
    or jsonb_typeof(p_input->'requestId') is distinct from 'string' then
    raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p_input->>'requestId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if (p_input->>'requestId')::uuid<>p_request then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dashboard-page-advanced:'||p_actor::text||':'||p_request::text,0));
  ws:=training_load.dashboard_page_actor_workspace(p_actor);
  if ws is distinct from p_workspace then raise exception 'notFound' using errcode='P4P10'; end if;
  select * into d from training_load.dashboards where id=p_dashboard for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  perform training_load.dashboard_page_assert_access(p_actor,p_dashboard,ws);
  -- Lock Page if it still exists. Recorded UUID/workspace/operation/hash proves
  -- the old target on replay; no reconstruction or child-existence requirement.
  select * into pg from training_load.dashboard_pages where id=p_page and dashboard_id=p_dashboard for update;
  select * into recorded from training_load.dashboard_page_advanced_requests
    where initiator_user_id=p_actor and request_id=p_request;
  if found then
    if recorded.workspace is distinct from ws or recorded.dashboard_id is distinct from p_dashboard
      or recorded.page_id is distinct from p_page or recorded.operation is distinct from p_operation
      or recorded.widget_id is distinct from p_widget or recorded.series_id is distinct from p_series
      or recorded.payload_hash is distinct from p_payload_hash then
      raise exception 'idempotencyConflict' using errcode='P4P08'; end if;
    return recorded.receipt;
  end if;
  if pg.id is null then raise exception 'notFound' using errcode='P4P10'; end if;
  perform training_load.assert_dashboard_writable(p_dashboard);
  if d.status<>'active' or d.is_template then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p_operation in ('layout','widgetCreate') then
    if p_widget is not null or p_series is not null then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  elsif p_widget is null then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p_operation in ('seriesUpdate','seriesDelete','seriesResolve') then
    if p_series is null then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  elsif p_series is not null then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  revision_key:=case p_operation when 'layout' then 'expectedPageLayoutRevision'
    when 'widgetCreate' then 'expectedPageRevision' else 'expectedWidgetRevision' end;
  if jsonb_typeof(p_input->revision_key) is distinct from 'number' then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  expected:=(p_input->>revision_key)::numeric;
  if expected<1 or expected>9007199254740991 or expected<>trunc(expected) then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p_operation='layout' and pg.layout_revision<>expected then raise exception 'stalePageLayoutRevision' using errcode='P4A01'; end if;
  if p_operation='widgetCreate' and pg.revision<>expected then raise exception 'stalePageRevision' using errcode='P4P02'; end if;
  if p_widget is not null then
    select * into w from training_load.dashboard_widgets where id=p_widget and dashboard_id=p_dashboard and page_id=p_page for update;
    if not found then raise exception 'notFound' using errcode='P4P10'; end if;
    if w.revision<>expected then raise exception 'staleRevision' using errcode='40001'; end if;
    perform 1 from training_load.dashboard_widget_series where widget_id=p_widget order by id for update;
    if p_series is not null and not exists(select 1 from training_load.dashboard_widget_series where id=p_series and widget_id=p_widget) then
      raise exception 'notFound' using errcode='P4P10'; end if;
  end if;
  if p_operation in ('layout','seriesReorder') then
    if jsonb_typeof(p_input->(case p_operation when 'layout' then 'layout' else 'order' end)) is distinct from 'array' then
      raise exception 'invalidRequest' using errcode='P4P09'; end if;
    for entry in select value from jsonb_array_elements(p_input->(case p_operation when 'layout' then 'layout' else 'order' end)) loop
      if jsonb_typeof(entry->(case p_operation when 'layout' then 'widgetId' else 'seriesId' end)) is distinct from 'string'
        or entry->>(case p_operation when 'layout' then 'widgetId' else 'seriesId' end) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'invalidRequest' using errcode='P4P09'; end if;
      member_id:=(entry->>(case p_operation when 'layout' then 'widgetId' else 'seriesId' end))::uuid;
      if p_operation='layout' then
        if not exists(select 1 from training_load.dashboard_widgets where id=member_id and dashboard_id=p_dashboard and page_id=p_page) then
          raise exception 'notFound' using errcode='P4P10'; end if;
      elsif not exists(select 1 from training_load.dashboard_widget_series where id=member_id and widget_id=p_widget) then
        raise exception 'notFound' using errcode='P4P10'; end if;
    end loop;
    if p_operation='layout' then
      perform 1 from training_load.dashboard_widgets where dashboard_id=p_dashboard and page_id=p_page order by id for update;
    end if;
  end if;
  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique,
    training_load.dashboard_widgets_mobile_order_unique, training_load.dashboard_widget_series_order_unique deferred;
  previous_scope:=current_setting('training_load.page_mutation',true);
  perform set_config('training_load.page_mutation',jsonb_build_object('dashboardId',p_dashboard,'pageId',p_page,'operation','advanced')::text,true);
  if p_operation='layout' then
    select jsonb_build_object('widgets',coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb)) into result from training_load.page_advanced_replace_dashboard_layout(p_page,p_dashboard,
      d.revision,
      nullif(p_input->'layout','null'::jsonb)) r;
  elsif p_operation='widgetCreate' then
    select to_jsonb(r) into raw from training_load.page_advanced_create_widget_with_presentation(p_page,p_dashboard,
      d.revision,
      (p_input->>'widgetType')::text,
      (p_input->>'title')::text,
      (p_input->>'widgetOrder')::integer,
      (p_input->>'x')::smallint,
      (p_input->>'y')::smallint,
      (p_input->>'width')::smallint,
      (p_input->>'height')::smallint,
      (p_input->>'mobileOrder')::integer,
      coalesce((p_input->>'groupBy')::varchar,'day'),
      coalesce(nullif(p_input->'displayConfig','null'::jsonb),'{"schemaVersion":1}'::jsonb),
      nullif(p_input->'localFilterOverride','null'::jsonb),
      case when p_input#>>'{presentation,mode}'='clear' then null else p_input#>'{presentation,value}' end) r;
    result:=jsonb_build_object('widgetId',raw->'widget_id','dashboardRevision',raw->'dashboard_revision');
  elsif p_operation='widgetLayout' then
    select to_jsonb(r) into raw from training_load.page_advanced_update_widget_layout(p_page,p_widget,
      (p_input->>'expectedWidgetRevision')::integer,
      (p_input->>'x')::smallint,
      (p_input->>'y')::smallint,
      (p_input->>'width')::smallint,
      (p_input->>'height')::smallint,
      (p_input->>'mobileOrder')::integer) r;
    result:=jsonb_build_object('widget',raw);
  elsif p_operation='widgetContent' then
    select to_jsonb(r) into raw from training_load.page_advanced_update_widget_content_with_presentation(p_page,p_widget,
      (p_input->>'expectedWidgetRevision')::integer,
      (p_input->>'widgetType')::text,
      (p_input->>'title')::text,
      (p_input->>'groupBy')::varchar,
      (p_input->>'state')::varchar,
      nullif(p_input->'displayConfig','null'::jsonb),
      nullif(p_input->'localFilterOverride','null'::jsonb),
      coalesce(p_input->'localFilterOverride'='null'::jsonb,false),
      coalesce(p_input#>>'{presentation,mode}','preserve'),
      case when p_input#>>'{presentation,mode}'='clear' then null else p_input#>'{presentation,value}' end) r;
    result:=jsonb_build_object('widget',raw);
  elsif p_operation='widgetDelete' then
    select to_jsonb(r) into raw from training_load.page_advanced_delete_widget(p_page,p_widget,
      (p_input->>'expectedWidgetRevision')::integer) r;
    result:=jsonb_build_object('dashboard',raw);
  elsif p_operation='seriesAdd' then
    select to_jsonb(r) into raw from training_load.page_advanced_add_series(p_page,p_widget,
      (p_input->>'expectedWidgetRevision')::integer,
      (p_input->>'seriesOrder')::integer,
      (p_input->>'metricDefinitionId')::uuid,
      (p_input->>'builtInSeriesKey')::text,
      nullif(p_input->'templateMetricKeyHints','null'::jsonb),
      coalesce((p_input->>'axis')::varchar,'primary'),
      (p_input->>'color')::text,
      (p_input->>'displayLabel')::text,
      coalesce((p_input->>'sourcePolicy')::varchar,case when p_input->>'builtInSeriesKey' is not null then 'not_applicable' else 'all_with_conflicts' end),
      (p_input->>'sourceConnectionId')::uuid,
      coalesce((p_input->>'dataScopeLevel')::varchar,'session'),
      coalesce((p_input->>'analyticalAggregation')::varchar,'sum'),
      coalesce((p_input->>'aggregationRolePolicy')::varchar,'standalone_and_source_rollup'),
      coalesce((p_input->>'coveragePolicy')::varchar,'complete_and_partial'),
      (p_input->>'comparisonPeriod')::varchar,
      p_actor) r;
    result:=jsonb_build_object('seriesId',raw->'series_id','widgetRevision',raw->'widget_revision');
  elsif p_operation='seriesUpdate' then
    select to_jsonb(r) into raw from training_load.page_advanced_update_series(p_page,p_series,
      p_widget,
      (p_input->>'expectedWidgetRevision')::integer,
      (p_input->>'axis')::varchar,
      (p_input->>'color')::text,
      coalesce(p_input->'color'='null'::jsonb,false),
      (p_input->>'displayLabel')::text,
      coalesce(p_input->'displayLabel'='null'::jsonb,false),
      (p_input->>'sourcePolicy')::varchar,
      (p_input->>'sourceConnectionId')::uuid,
      (p_input->>'dataScopeLevel')::varchar,
      (p_input->>'analyticalAggregation')::varchar,
      (p_input->>'aggregationRolePolicy')::varchar,
      (p_input->>'coveragePolicy')::varchar,
      (p_input->>'comparisonPeriod')::varchar,
      coalesce(p_input->'comparisonPeriod'='null'::jsonb,false)) r;
    result:=jsonb_build_object('seriesId',raw->'series_id','widgetRevision',raw->'widget_revision');
  elsif p_operation='seriesDelete' then
    select to_jsonb(r) into raw from training_load.page_advanced_delete_series(p_page,p_series,
      p_widget,
      (p_input->>'expectedWidgetRevision')::integer) r;
    result:=jsonb_build_object('widgetRevision',raw->'widget_revision');
  elsif p_operation='seriesReorder' then
    select to_jsonb(r) into raw from training_load.page_advanced_reorder_series(p_page,p_widget,
      (p_input->>'expectedWidgetRevision')::integer,
      nullif(p_input->'order','null'::jsonb)) r;
    result:=jsonb_build_object('widgetRevision',raw->'widget_revision');
  elsif p_operation='seriesResolve' then
    select to_jsonb(r) into raw from training_load.page_advanced_resolve_series_binding(p_page,p_series,
      p_widget,
      (p_input->>'expectedWidgetRevision')::integer,
      (p_input->>'metricDefinitionId')::uuid) r;
    result:=jsonb_build_object('seriesId',raw->'series_id','widgetRevision',raw->'widget_revision');
  end if;
  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique,
    training_load.dashboard_widgets_mobile_order_unique, training_load.dashboard_widget_series_order_unique immediate;
  perform set_config('training_load.page_mutation',coalesce(previous_scope,''),true);
  select * into pg from training_load.dashboard_pages where id=p_page and dashboard_id=p_dashboard;
  receipt:=jsonb_build_object('requestId',p_request,'pageId',p_page,'dashboardId',p_dashboard,
    'operation',p_operation,'result',result,'pageRevision',pg.revision,'defaultsRevision',pg.defaults_revision,
    'layoutRevision',pg.layout_revision,'dashboardRevision',(select revision from training_load.dashboards where id=p_dashboard));
  insert into training_load.dashboard_page_advanced_requests(initiator_user_id,request_id,workspace,dashboard_id,page_id,
    operation,widget_id,series_id,payload_hash,receipt)
    values(p_actor,p_request,ws,p_dashboard,p_page,p_operation,p_widget,p_series,p_payload_hash,receipt);
  return receipt;
end $$;
