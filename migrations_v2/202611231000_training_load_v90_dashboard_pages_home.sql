-- P1 A: compatible Home schema. Runner owns the transaction.
-- No trigger is disabled. v91 supplies Page writers; activation remains closed.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table training_load.dashboards in access exclusive mode;
lock table training_load.dashboard_widgets in access exclusive mode;
lock table training_load.dashboard_widget_series in access exclusive mode;

do $gate$
declare actual jsonb;
begin
 select jsonb_agg(jsonb_build_object('tgname',t.tgname,'signature',p.oid::regprocedure::text,
 'body_md5',md5(p.prosrc),'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled::text) order by t.tgname)
 into actual from pg_trigger t join pg_proc p on p.oid=t.tgfoid
 where t.tgrelid='training_load.dashboard_widgets'::regclass and not t.tgisinternal;
 if actual is distinct from '[{"tgname":"dashboard_widgets_bump_parent_on_delete","signature":"training_load.dashboard_widgets_bump_parent_dashboard_revision()","body_md5":"4d2495c0884475299f69811f7e3b0831","definition":"CREATE TRIGGER dashboard_widgets_bump_parent_on_delete AFTER DELETE ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_bump_parent_dashboard_revision()","enabled":"O"},{"tgname":"dashboard_widgets_bump_parent_on_insert","signature":"training_load.dashboard_widgets_bump_parent_dashboard_revision()","body_md5":"4d2495c0884475299f69811f7e3b0831","definition":"CREATE TRIGGER dashboard_widgets_bump_parent_on_insert AFTER INSERT ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_bump_parent_dashboard_revision()","enabled":"O"},{"tgname":"dashboard_widgets_bump_revision","signature":"training_load.dashboard_widgets_bump_revision()","body_md5":"a845d879d38d8a6dccf443736a34fe8f","definition":"CREATE TRIGGER dashboard_widgets_bump_revision BEFORE UPDATE ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_bump_revision()","enabled":"O"},{"tgname":"dashboard_widgets_check_no_overlap","signature":"training_load.dashboard_widgets_check_no_overlap()","body_md5":"4d67afabd6f05ad36fcba27b9fdb5fb0","definition":"CREATE CONSTRAINT TRIGGER dashboard_widgets_check_no_overlap AFTER INSERT OR UPDATE OF x, y, width, height ON training_load.dashboard_widgets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_check_no_overlap()","enabled":"O"},{"tgname":"dashboard_widgets_guard_presentation","signature":"training_load.dashboard_widgets_guard_presentation()","body_md5":"f66d2b259464e844e9f73df286761b6f","definition":"CREATE TRIGGER dashboard_widgets_guard_presentation BEFORE INSERT OR UPDATE ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_guard_presentation()","enabled":"O"},{"tgname":"dashboard_widgets_lock_dashboard_before_layout_write","signature":"training_load.dashboard_widgets_lock_dashboard_before_layout_write()","body_md5":"587a5c613a2e69d578cd9af8e23150f9","definition":"CREATE TRIGGER dashboard_widgets_lock_dashboard_before_layout_write BEFORE INSERT OR UPDATE OF x, y, width, height ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_lock_dashboard_before_layout_write()","enabled":"O"},{"tgname":"dashboard_widgets_protect_dashboard_id","signature":"training_load.protect_dashboard_widgets_dashboard_id()","body_md5":"dc61219b2601d30c239e507a10262a69","definition":"CREATE TRIGGER dashboard_widgets_protect_dashboard_id BEFORE UPDATE OF dashboard_id ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.protect_dashboard_widgets_dashboard_id()","enabled":"O"},{"tgname":"dashboard_widgets_revalidate_series_on_type_change","signature":"training_load.dashboard_widgets_revalidate_series_on_type_change()","body_md5":"cc37fcbb542c99405a6801d0b50e9ea3","definition":"CREATE TRIGGER dashboard_widgets_revalidate_series_on_type_change AFTER UPDATE OF widget_type ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_revalidate_series_on_type_change()","enabled":"O"},{"tgname":"dashboard_widgets_validate_layout","signature":"training_load.dashboard_widgets_validate_layout()","body_md5":"b43588b955a6aece5cac50db425312c0","definition":"CREATE TRIGGER dashboard_widgets_validate_layout BEFORE INSERT OR UPDATE OF widget_type, width, height ON training_load.dashboard_widgets FOR EACH ROW EXECUTE FUNCTION training_load.dashboard_widgets_validate_layout()","enabled":"O"}]'::jsonb then
 raise exception 'v90: widget trigger manifest changed' using errcode='23514';
 end if;
end
$gate$;
-- Retain original columns exactly for the in-transaction backfill proof.
create temporary table p1_before_widgets on commit drop as
 select id, to_jsonb(w) row_data from training_load.dashboard_widgets w;
create temporary table p1_before_dashboards on commit drop as
 select id, to_jsonb(d) row_data from training_load.dashboards d;
create temporary table p1_before_series on commit drop as
 select id, to_jsonb(s) row_data from training_load.dashboard_widget_series s;

alter table training_load.dashboards add column pages_revision integer not null default 1 check (pages_revision > 0);
create table training_load.dashboard_pages (
 id uuid primary key default gen_random_uuid(),
 dashboard_id uuid not null references training_load.dashboards(id) on delete cascade,
 name text not null check (public.permission_text_ok(name,80)),
 position integer not null check(position >= 0 and position < 20),
 is_home boolean not null default false,
 revision integer not null default 1 check(revision > 0),
 defaults_revision integer not null default 1 check(defaults_revision > 0),
 period_config jsonb,
 default_filter jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(dashboard_id,id),
 constraint dashboard_pages_position_unique unique(dashboard_id,position) deferrable initially deferred,
 check(not is_home or position=0)
);
create unique index dashboard_pages_name_unique on training_load.dashboard_pages(dashboard_id,lower(name));
create unique index dashboard_pages_home_unique on training_load.dashboard_pages(dashboard_id) where is_home;

-- Persistent server-side activation, independent of HTTP route mounting.
-- No public/application grant to change this row; owner activation is a separate order.
create table training_load.dashboard_pages_activation (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false
);
insert into training_load.dashboard_pages_activation(singleton,enabled) values(true,false);
revoke all on training_load.dashboard_pages_activation from public;

create function training_load.ensure_dashboard_home() returns trigger language plpgsql as $$
begin
 insert into training_load.dashboard_pages(dashboard_id,name,position,is_home,default_filter)
 values(new.id,'Home',0,true,new.default_filter);
 return new;
end;
$$;
create trigger dashboards_ensure_home after insert on training_load.dashboards
 for each row execute function training_load.ensure_dashboard_home();

-- Home is protected from direct deletion; a parent cascade sees no surviving parent.
-- This also keeps the unchanged v19 function and its exactly-one deletion log intact.
create function training_load.guard_dashboard_page_identity() returns trigger language plpgsql as $$
declare parent_id uuid; parent_exists boolean;
begin
 parent_id := case when tg_op='DELETE' then old.dashboard_id else new.dashboard_id end;
 perform 1 from training_load.dashboards where id=parent_id for update;
 parent_exists := found;
 if tg_op='DELETE' then
   if parent_exists and old.is_home then raise exception 'homePageRequired' using errcode='23514'; end if;
   if parent_exists and exists(select 1 from training_load.dashboard_widgets where page_id=old.id) then
     raise exception 'pageNotEmpty' using errcode='23514';
   end if;
   return old;
 end if;
 if tg_op='UPDATE' and (new.id<>old.id or new.dashboard_id<>old.dashboard_id or new.is_home<>old.is_home) then
   raise exception 'pageIdentityImmutable' using errcode='23514';
 end if;
 if tg_op='INSERT' and not new.is_home then
   if not coalesce((select enabled from training_load.dashboard_pages_activation where singleton),false) then
     raise exception 'dashboardPagesDisabled' using errcode='23514';
   end if;
   if (select count(*) from training_load.dashboard_pages where dashboard_id=new.dashboard_id)>=20 then
     raise exception 'pageLimit' using errcode='23514';
   end if;
 end if;
 return new;
end;
$$;
-- Installed after backfill, when widget.page_id exists.

insert into training_load.dashboard_pages(dashboard_id,name,position,is_home,default_filter)
 select id,'Home',0,true,default_filter from training_load.dashboards;
alter table training_load.dashboard_widgets add column page_id uuid;
update training_load.dashboard_widgets w set page_id=p.id
 from training_load.dashboard_pages p where p.dashboard_id=w.dashboard_id and p.is_home;
alter table training_load.dashboard_widgets alter column page_id set not null;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_page_fk
 foreign key(dashboard_id,page_id) references training_load.dashboard_pages(dashboard_id,id) on delete no action deferrable initially deferred;
create index dashboard_widgets_page_idx on training_load.dashboard_widgets(page_id,widget_order);

create trigger dashboard_pages_guard_identity before insert or update or delete on training_load.dashboard_pages
 for each row execute function training_load.guard_dashboard_page_identity();

create function training_load.dashboard_widget_assign_home() returns trigger language plpgsql as $$
begin
 if tg_op='UPDATE' then
   if new.page_id is distinct from old.page_id then raise exception 'pageIdentityImmutable' using errcode='23514'; end if;
 else
   if new.page_id is null then
     new.page_id := training_load.current_dashboard_page(new.dashboard_id);
   end if;
 end if;
 return new;
end;
$$;
create trigger dashboard_widgets_assign_home before insert or update of page_id on training_load.dashboard_widgets
 for each row execute function training_load.dashboard_widget_assign_home();

-- Legacy metadata is the only Home-default writer in stage A. Its existing revision
-- behavior is unchanged; the projection update cannot feed a second dashboard update.
create function training_load.dashboard_home_sync_defaults() returns trigger language plpgsql as $$
begin
 if new.default_filter is distinct from old.default_filter then
   update training_load.dashboard_pages set default_filter=new.default_filter,
    revision=revision+1,defaults_revision=defaults_revision+1,updated_at=now()
    where dashboard_id=new.id and is_home;
 end if;
 return new;
end;
$$;
create trigger dashboards_sync_home_defaults after update of default_filter on training_load.dashboards
 for each row execute function training_load.dashboard_home_sync_defaults();

create function training_load.dashboard_home_required() returns trigger language plpgsql as $$
declare parent_id uuid; filter jsonb; home_count integer;
begin
 if tg_table_name='dashboards' then
   parent_id := coalesce(new.id,old.id);
 else
   parent_id := coalesce(new.dashboard_id,old.dashboard_id);
 end if;
 select default_filter into filter from training_load.dashboards where id=parent_id;
 if not found then return null; end if;
 select count(*) into home_count from training_load.dashboard_pages where dashboard_id=parent_id and is_home;
 if home_count<>1 or exists(select 1 from training_load.dashboard_pages where dashboard_id=parent_id and is_home and default_filter is distinct from filter) then
   raise exception 'homePageRequired' using errcode='23514';
 end if;
 return null;
end;
$$;
create constraint trigger dashboards_require_home after insert or update on training_load.dashboards
 deferrable initially deferred for each row execute function training_load.dashboard_home_required();
create constraint trigger dashboard_pages_require_home after insert or update or delete on training_load.dashboard_pages
 deferrable initially deferred for each row execute function training_load.dashboard_home_required();

-- No disable/enable step: unchanged v71 presentation validation runs normally.
-- Reject any non-page difference, including revision/updated_at, in the migration itself.
do $proof$
begin
 if exists(select 1 from p1_before_widgets b full join training_load.dashboard_widgets w on w.id=b.id
   where b.id is null or w.id is null or b.row_data is distinct from to_jsonb(w)-'page_id')
 or exists(select 1 from p1_before_dashboards b full join training_load.dashboards d on d.id=b.id
   where b.id is null or d.id is null or b.row_data is distinct from to_jsonb(d)-'pages_revision')
 or exists(select 1 from p1_before_series b full join training_load.dashboard_widget_series s on s.id=b.id
   where b.id is null or s.id is null or b.row_data is distinct from to_jsonb(s)) then
   raise exception 'v90 backfill changed existing data' using errcode='23514';
 end if;
 if exists(select 1 from pg_trigger where tgrelid in ('training_load.dashboards'::regclass,
 'training_load.dashboard_pages'::regclass,'training_load.dashboard_widgets'::regclass) and not tgisinternal and tgenabled<>'O') then
   raise exception 'v90 found a disabled trigger' using errcode='23514';
 end if;
end
$proof$;


-- Compatible Page locks and Page-local constraints, installed only AFTER backfill.
do $gate$ begin if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.assert_dashboard_writable(uuid)')) is distinct from '2570e150e7ab4df97a96d425e1d61b05' then raise exception 'v90: prior function body changed' using errcode='23514';end if;end $gate$;
CREATE OR REPLACE FUNCTION training_load.assert_dashboard_writable(p_dashboard_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_status varchar;
begin
  select status into v_status from training_load.dashboards where id = p_dashboard_id;
  perform 1 from training_load.dashboard_pages where dashboard_id=p_dashboard_id order by id for update;
  if v_status = 'archived' then
    raise exception 'dashboard % is archived — read-only (query/clone/metadata/layout/widget/series writes are all refused)', p_dashboard_id using errcode = '40002';
  end if;
end;
$function$
;
do $gate$ begin if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widgets_check_no_overlap()')) is distinct from '4d67afabd6f05ad36fcba27b9fdb5fb0' then raise exception 'v90: prior function body changed' using errcode='23514';end if;end $gate$;
CREATE OR REPLACE FUNCTION training_load.dashboard_widgets_check_no_overlap()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_conflict record;
begin
  select a.id as a_id, b.id as b_id into v_conflict
    from training_load.dashboard_widgets a
    join training_load.dashboard_widgets b on b.dashboard_id = a.dashboard_id and b.page_id = a.page_id and b.id <> a.id
      and a.x < b.x + b.width and b.x < a.x + a.width
      and a.y < b.y + b.height and b.y < a.y + a.height
    where a.dashboard_id = new.dashboard_id and a.page_id = new.page_id
    limit 1;
  if v_conflict.a_id is not null then
    raise exception 'dashboard_widgets: final layout still has an overlap between widgets % and % on dashboard %', v_conflict.a_id, v_conflict.b_id, new.dashboard_id;
  end if;
  return new;
end;
$function$
;
do $gate$ begin if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.delete_dashboard(uuid,integer,uuid,character varying)')) is distinct from '222271ed02f0816ed9b8688b2ff57091' then raise exception 'v90: prior function body changed' using errcode='23514';end if;end $gate$;
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
  perform 1 from training_load.dashboard_pages where dashboard_id=p_dashboard_id order by id for update;
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
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_order_unique;
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_mobile_order_unique;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_order_unique unique(page_id,widget_order) deferrable initially deferred;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_mobile_order_unique unique(page_id,mobile_order) deferrable initially deferred;
-- Page revision is additive; existing dashboard/widget bump semantics stay unchanged.
-- Sanctioned writers acquire dashboard -> all Pages (UUID order) BEFORE widget locks.
create function training_load.dashboard_widget_bump_page_revision() returns trigger language plpgsql as $$
declare target uuid;
begin
 if tg_op='UPDATE' and new is not distinct from old then return new;end if;
 target:=case when tg_op='DELETE' then old.page_id else new.page_id end;
 update training_load.dashboard_pages set revision=revision+1,updated_at=now() where id=target;
 return coalesce(new,old);
end;
$$;
create trigger dashboard_widgets_bump_page after insert or update or delete on training_load.dashboard_widgets
 for each row execute function training_load.dashboard_widget_bump_page_revision();
-- New protocols identify their Page only inside the current transaction. Legacy
-- callers never set this marker, so no legacy writer can reach a non-Home widget.
create function training_load.dashboard_page_context_matches(p_page_id uuid) returns boolean language sql stable as $$
 select coalesce(current_setting('optimove.dashboard_page',true)=pg_current_xact_id()::text||':'||p_page_id::text,false)
 and coalesce((select enabled from training_load.dashboard_pages_activation where singleton),false);
$$;
create function training_load.guard_dashboard_widget_page_protocol() returns trigger language plpgsql as $$
declare row_page uuid;parent_id uuid;
begin
 if tg_op='DELETE' then row_page:=old.page_id;parent_id:=old.dashboard_id;
 else row_page:=new.page_id;parent_id:=new.dashboard_id;end if;
 if not exists(select 1 from training_load.dashboards where id=parent_id) then return coalesce(new,old);end if;
 if not exists(select 1 from training_load.dashboard_pages where id=row_page and dashboard_id=parent_id and is_home)
 and not training_load.dashboard_page_context_matches(row_page) then raise exception 'notFound' using errcode='P0002';end if;
 return coalesce(new,old);
end;
$$;
create trigger dashboard_widgets_guard_page_protocol before insert or update or delete on training_load.dashboard_widgets
 for each row execute function training_load.guard_dashboard_widget_page_protocol();
create function training_load.current_dashboard_page(p_dashboard_id uuid) returns uuid language sql stable as $$
 select id from training_load.dashboard_pages where dashboard_id=p_dashboard_id
 order by training_load.dashboard_page_context_matches(id) desc,is_home desc limit 1;
$$;
do $gate$ begin if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)')) is distinct from 'a7e743e074cf1be5a61fb0b5aca9b060' then raise exception 'v90: Simple save prior body changed' using errcode='23514';end if;end $gate$;
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
$function$
;

create function training_load.dashboard_page_period_valid(p_period jsonb) returns boolean language plpgsql stable as $$
declare first_day date;last_day date;
begin
 if p_period is null then return true;end if;
 if jsonb_typeof(p_period)<>'object' or p_period->'schemaVersion' is distinct from '1'::jsonb
 or jsonb_typeof(p_period->'timeZone') is distinct from 'string'
 or not exists(select 1 from pg_timezone_names where name=p_period->>'timeZone') then return false;end if;
 if p_period->>'mode'='relative' then
  return training_load.dashboard_simple_object(p_period,array['schemaVersion','mode','preset','timeZone'],array['schemaVersion','mode','preset','timeZone'])
   and coalesce(p_period->>'preset' in ('today','last_7_days','last_28_days','this_week'),false);
 elsif p_period->>'mode'='fixed' then
  if not training_load.dashboard_simple_object(p_period,array['schemaVersion','mode','dateFrom','dateTo','timeZone'],array['schemaVersion','mode','dateFrom','dateTo','timeZone'])
   or not coalesce(p_period->>'dateFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false)
   or not coalesce(p_period->>'dateTo' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false) then return false;end if;
  first_day:=(p_period->>'dateFrom')::date;last_day:=(p_period->>'dateTo')::date;
  return first_day<=last_day and last_day-first_day<400;
 end if;
 return false;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end;
$$;
alter table training_load.dashboard_pages add constraint dashboard_pages_period_valid check(training_load.dashboard_page_period_valid(period_config));
