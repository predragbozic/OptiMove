-- v58 Page-aware Simple: SECURITY INVOKER, like v57/S2c. API authenticates
-- tokens freshly; SQL locks live actor authority and verifies workspace/parent.
-- Lock order: request advisory -> fresh actor -> dashboard -> target Page -> widget/series.
-- Apply through the transactional migration runner. No changes to legacy receipts.
alter table training_load.dashboard_simple_requests add column page_id uuid;
-- No FK: preserve existing retention/replay evidence independently of deletion.

-- Only widget/series triggers consume this scope; legacy entry guards do not.
create or replace function training_load.dashboard_page_internal(p_dashboard uuid,p_page uuid,p_operation text default null)
returns boolean language plpgsql stable as $$
declare s jsonb;
begin
  s := nullif(current_setting('training_load.page_mutation',true),'')::jsonb;
  return coalesce(s->>'dashboardId'=p_dashboard::text and s->>'pageId'=p_page::text
    and s->>'operation' in ('duplicate','delete','simpleSave') and (p_operation is null or s->>'operation'=p_operation)
    and exists(select 1 from training_load.dashboard_pages where id=p_page and dashboard_id=p_dashboard),false);
exception when invalid_text_representation then return false;
end $$;

-- Derive a NEW function, not an ambient-marker redirect of the legacy writer.
-- Pin the complete LF-normalized v57/S2c body and every substitution count.
-- Any upstream drift aborts instead of silently weakening the port.
do $migration$
declare
  source_oid oid := 'training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)'::regprocedure;
  original text; body text; replacement record; occurrences integer;
begin
  select replace(prosrc,chr(13),'') into original from pg_proc where oid=source_oid
    and prolang=(select oid from pg_language where lanname='plpgsql') and not prosecdef;
  if original is null or md5(original)<>'564bba172bdacbacb62d076c6ce34420' then
    raise exception 'v58: unexpected v57/S2c body; refusing unsafe transformation';
  end if;
  body := original;
  for replacement in select * from (values
    ($old$  saved_receipt jsonb;$old$,$new$  saved_receipt jsonb;
  locked_page training_load.dashboard_pages%rowtype;
  verified_workspace jsonb;
  previous_page_scope text;$new$,1),
    ($old$  perform pg_advisory_xact_lock(hashtextextended('dashboard-simple:' || p_initiator_user_id::text || ':' || p_request_id::text, 0));$old$,$new$  perform pg_advisory_xact_lock(hashtextextended('dashboard-simple:' || p_initiator_user_id::text || ':' || p_request_id::text, 0));
  -- Same first lock/key as the JS save path; no actor lock before request lock.
  verified_workspace := training_load.dashboard_page_actor_workspace(p_initiator_user_id);
  if verified_workspace is distinct from p_workspace then raise exception 'notFound' using errcode='P4P10'; end if;
  perform training_load.dashboard_page_assert_access(p_initiator_user_id,p_dashboard_id,verified_workspace);$new$,1),
    ($old$or p_dashboard_id is null$old$,$new$or p_dashboard_id is null or p_page_id is null$new$,1),
    ($old$perform 1 from training_load.dashboard_pages where dashboard_id=p_dashboard_id order by id for update;$old$,$new$perform training_load.dashboard_page_assert_access(p_initiator_user_id,p_dashboard_id,verified_workspace);
  select page.* into locked_page from training_load.dashboard_pages page
    where page.id=p_page_id and page.dashboard_id=p_dashboard_id for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;$new$,1),
    ($old$if recorded_request.payload_hash is distinct from p_payload_hash$old$,$new$if recorded_request.page_id is distinct from p_page_id
      or recorded_request.payload_hash is distinct from p_payload_hash$new$,1),
    ($old$and widget.dashboard_id = p_dashboard_id for update;$old$,$new$and widget.dashboard_id = p_dashboard_id and widget.page_id = p_page_id for update;$new$,2),
    ($old$  perform training_load.dashboard_legacy_page_guard(p_dashboard_id);
$old$,$new$$new$,1),
    ($old$  perform training_load.assert_dashboard_writable(p_dashboard_id);$old$,$new$  perform training_load.assert_dashboard_writable(p_dashboard_id);
  -- NULL means no shared change; ordinary save ignores aggregate revisions.
  if p_period_config is not null then
    if not coalesce(training_load.dashboard_page_period_valid(p_period_config),false)
      or p_expected_defaults_revision is null or p_expected_defaults_revision<1 then
      raise exception 'invalidRequest' using errcode='P4P09';
    end if;
    if locked_page.defaults_revision is distinct from p_expected_defaults_revision then
      raise exception 'stalePageDefaultsRevision' using errcode='P4P04';
    end if;
    update training_load.dashboard_pages set period_config=p_period_config,period_origin='configured'
      where id=p_page_id and dashboard_id=p_dashboard_id;
  end if;$new$,1),
    ($old$  if p_widget_id is null then
    if training_load.dashboard_presentation_opaque$old$,$new$  previous_page_scope := current_setting('training_load.page_mutation',true);
  perform set_config('training_load.page_mutation',jsonb_build_object(
    'dashboardId',p_dashboard_id,'pageId',p_page_id,'operation','simpleSave')::text,true);
  if p_widget_id is null then
    if training_load.dashboard_presentation_opaque$new$,1),
    ($old$where widget.dashboard_id = p_dashboard_id$old$,$new$where widget.dashboard_id = p_dashboard_id and widget.page_id = p_page_id$new$,3),
    ($old$      dashboard_id, widget_type, title, widget_order,$old$,$new$      dashboard_id, page_id, widget_type, title, widget_order,$new$,1),
    ($old$      p_dashboard_id, desired_widget.widget_type,$old$,$new$      p_dashboard_id, p_page_id, desired_widget.widget_type,$new$,1),
    ($old$    'widgetRevision', widget.revision, 'dashboardRevision', dashboard.revision,$old$,$new$    'widgetRevision', widget.revision, 'dashboardRevision', dashboard.revision,
    'pageId',p_page_id,'defaultsRevision',page.defaults_revision,'pageRevision',page.revision,$new$,1),
    ($old$join training_load.dashboards dashboard on dashboard.id = widget.dashboard_id where widget.id = actual_widget_id;$old$,$new$join training_load.dashboards dashboard on dashboard.id = widget.dashboard_id
    join training_load.dashboard_pages page on page.id=widget.page_id and page.dashboard_id=dashboard.id
    where widget.id=actual_widget_id and widget.page_id=p_page_id;$new$,1),
    ($old$initiator_user_id, request_id, dashboard_id, widget_id, workspace, payload_hash,$old$,$new$initiator_user_id, request_id, dashboard_id, page_id, widget_id, workspace, payload_hash,$new$,1),
    ($old$p_initiator_user_id, p_request_id, p_dashboard_id, p_widget_id, p_workspace, p_payload_hash,$old$,$new$p_initiator_user_id, p_request_id, p_dashboard_id, p_page_id, p_widget_id, p_workspace, p_payload_hash,$new$,1),
    ($old$  return saved_receipt;$old$,$new$  perform set_config('training_load.page_mutation',coalesce(previous_page_scope,''),true);
  return saved_receipt;$new$,1)
  ) as replacements(before_text,after_text,expected_count) loop
    -- Dollar-quoted anchors inherit checkout line endings; source is LF-normalized.
    replacement.before_text := replace(replacement.before_text,chr(13),'');
    replacement.after_text := replace(replacement.after_text,chr(13),'');
    occurrences := (length(body)-length(replace(body,replacement.before_text,'')))/length(replacement.before_text);
    if occurrences<>replacement.expected_count then raise exception 'v58: anchor mismatch: %',replacement.before_text; end if;
    body := replace(body,replacement.before_text,replacement.after_text);
  end loop;
  if position('dashboard_legacy_page_guard' in body)>0 then raise exception 'v58: unported legacy guard'; end if;
  execute 'create function training_load.save_simple_page_widget(
    p_initiator_user_id uuid, p_request_id uuid, p_payload_hash text, p_request_issued_at timestamptz,
    p_dashboard_id uuid, p_widget_id uuid, p_expected_widget_revision integer,
    p_widget jsonb, p_resolved_period jsonb, p_workspace jsonb,
    p_page_id uuid, p_expected_defaults_revision integer, p_period_config jsonb
  ) returns jsonb language plpgsql as ' || quote_literal(body);
  -- Legacy cannot replay a new Page receipt; its multipage write guard is intact.
  body := replace(original,'if recorded_request.payload_hash is distinct from p_payload_hash',
    'if recorded_request.page_id is not null or recorded_request.payload_hash is distinct from p_payload_hash');
  execute replace(pg_get_functiondef(source_oid),(select prosrc from pg_proc where oid=source_oid),body);
end $migration$;
