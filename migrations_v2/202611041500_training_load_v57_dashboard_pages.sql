-- S4b foundation. Requires the S4a Simple migration and main through v55.
-- No app Page widget port/capability is enabled by this migration.
-- SQLSTATE: P4P01 pagesClientRequired; 02 stalePageRevision; 03 stalePagesRevision;
-- 04 stalePageDefaultsRevision; 05 lastPageRequired; 06 pageNotEmpty;
-- 07 pageLimitReached; 08 idempotencyConflict; 09 invalidRequest; 10 notFound.
-- Existing 40002 remains dashboardArchived. All functions are SECURITY INVOKER:
-- sanctioned entry points, not a new DB privilege or authentication boundary.

alter table training_load.dashboards add column pages_revision integer not null default 1
  check (pages_revision between 1 and 9007199254740991);

create function training_load.dashboard_page_period_valid(p jsonb) returns boolean
language plpgsql stable as $$
declare f date; t date;
begin
  if jsonb_typeof(p) is distinct from 'object' or p->'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(p->'timeZone') is distinct from 'string'
    or not exists(select 1 from pg_timezone_names where name=p->>'timeZone')
    or p->>'timeZone' ~ '^[+-]' then return false; end if;
  if p->>'mode' = 'relative' then
    return training_load.dashboard_simple_object(p, array['schemaVersion','mode','preset','timeZone'],
      array['schemaVersion','mode','preset','timeZone'])
      and p->>'preset' in ('today','last_7_days','last_28_days','this_week');
  elsif p->>'mode' = 'fixed' then
    if not training_load.dashboard_simple_object(p, array['schemaVersion','mode','dateFrom','dateTo','timeZone'],
      array['schemaVersion','mode','dateFrom','dateTo','timeZone'])
      or jsonb_typeof(p->'dateFrom') is distinct from 'string' or jsonb_typeof(p->'dateTo') is distinct from 'string'
      or p->>'dateFrom' !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or p->>'dateTo' !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
    f := (p->>'dateFrom')::date; t := (p->>'dateTo')::date;
    return t >= f and t-f < 400 and to_char(f,'YYYY-MM-DD')=p->>'dateFrom' and to_char(t,'YYYY-MM-DD')=p->>'dateTo';
  end if;
  return false;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end $$;

create function training_load.dashboard_page_resolve_period(p jsonb,p_evaluated_at timestamptz)
returns jsonb language plpgsql stable as $$
declare today date; first_day date; last_day date;
begin
  if p is null then return null; end if;
  if not coalesce(training_load.dashboard_page_period_valid(p),false) then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p->>'mode'='fixed' then return p-array['schemaVersion','mode']; end if;
  today := (p_evaluated_at at time zone (p->>'timeZone'))::date;
  first_day := today; last_day := today;
  if p->>'preset'='this_week' then
    first_day := today-(extract(isodow from today)::integer-1); last_day:=first_day+6;
  elsif p->>'preset'='last_7_days' then first_day:=today-6;
  elsif p->>'preset'='last_28_days' then first_day:=today-27; end if;
  return jsonb_build_object('dateFrom',to_char(first_day,'YYYY-MM-DD'),'dateTo',to_char(last_day,'YYYY-MM-DD'),'timeZone',p->>'timeZone');
end $$;

create function training_load.dashboard_page_filter_valid(p jsonb) returns boolean
language plpgsql immutable as $$
declare k text; v jsonb; ids uuid[];
begin
  if not training_load.dashboard_simple_object(p,array['athleteIds','activityId','componentId']) then return false; end if;
  for k,v in select * from jsonb_each(p) loop
    if v='null'::jsonb then continue; end if;
    if k='athleteIds' then
      if jsonb_typeof(v) is distinct from 'array' then return false; end if;
      if jsonb_array_length(v)>500 then return false; end if;
      if exists(select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string'
        or e#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
      select array_agg((e#>>'{}')::uuid) into ids from jsonb_array_elements(v) e;
      if cardinality(ids) <> (select count(distinct id) from unnest(ids) id) then return false; end if;
    elsif jsonb_typeof(v) is distinct from 'string'
      or v#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;
    end if;
  end loop;
  return true;
end $$;

create table training_load.dashboard_pages (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references training_load.dashboards(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200 and name ~ '[^[:space:]]' and name !~ '[[:cntrl:]]'),
  position integer not null check (position between 0 and 31),
  revision integer not null default 1 check (revision between 1 and 9007199254740991),
  defaults_revision integer not null default 1 check (defaults_revision between 1 and 9007199254740991),
  layout_revision integer not null default 1 check (layout_revision between 1 and 9007199254740991),
  default_filter jsonb check(default_filter is null or training_load.dashboard_page_filter_valid(default_filter)),
  period_config jsonb,
  period_origin text not null default 'legacyRuntime' check (period_origin in ('legacyRuntime','configured')),
  unique (id,dashboard_id),
  constraint dashboard_pages_position_unique unique (dashboard_id,position) deferrable initially deferred,
  check ((period_origin='legacyRuntime' and period_config is null)
    or (period_origin='configured' and period_config is not null and training_load.dashboard_page_period_valid(period_config)))
);

-- No invented dates, zone, filters or new widget identities. Dashboard filters
-- remain inherited; a NULL Page filter means no Page override.
insert into training_load.dashboard_pages(dashboard_id,name,position)
  select id,'Početna',0 from training_load.dashboards;
alter table training_load.dashboard_widgets add column page_id uuid;
-- Avoid firing the historical content/layout/presentation triggers on backfill.
-- The existing bump trigger does not include page_id; every value stays intact.
update training_load.dashboard_widgets w set page_id=p.id from training_load.dashboard_pages p where p.dashboard_id=w.dashboard_id;
alter table training_load.dashboard_widgets alter column page_id set not null;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_page_dashboard_fk
  foreign key(page_id,dashboard_id) references training_load.dashboard_pages(id,dashboard_id) on delete cascade;
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_order_unique;
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_mobile_order_unique;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_order_unique unique(page_id,widget_order) deferrable initially deferred;
alter table training_load.dashboard_widgets add constraint dashboard_widgets_mobile_order_unique unique(page_id,mobile_order) deferrable initially deferred;
create index dashboard_widgets_page_mobile_idx on training_load.dashboard_widgets(page_id,mobile_order);

create function training_load.dashboard_new_initial_page() returns trigger language plpgsql as $$
begin
  insert into training_load.dashboard_pages(dashboard_id,name,position) values(new.id,'Početna',0);
  return new;
end $$;
create trigger dashboards_new_initial_page after insert on training_load.dashboards
  for each row execute function training_load.dashboard_new_initial_page();

-- Durable replay evidence deliberately has NO FK to the deleted Page/dashboard.
-- No retention/purge protocol. Workspace is a verified, server-derived snapshot.
create table training_load.dashboard_page_requests (
  initiator_user_id uuid not null references public.users(id) on delete restrict,
  request_id uuid not null,
  dashboard_id uuid not null,
  workspace jsonb not null check(jsonb_typeof(workspace)='object'),
  operation text not null check(operation in ('create','rename','defaults','reorder','duplicate','delete')),
  page_id uuid,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  input_body jsonb not null,
  receipt jsonb not null check(jsonb_typeof(receipt)='object'),
  created_at timestamptz not null default now(),
  unique(initiator_user_id,workspace,dashboard_id,request_id)
);
create trigger dashboard_page_requests_append_only before update or delete on training_load.dashboard_page_requests
  for each row execute function training_load.dashboard_deletion_log_append_only();
create trigger dashboard_page_requests_no_truncate before truncate on training_load.dashboard_page_requests
  for each statement execute function training_load.dashboard_deletion_log_append_only();

-- Same live authority sources as Simple authorizePreviewTarget/save lockActor.
-- users -> roles -> preference, then dashboard. A caller-supplied workspace is
-- compared against this return value, never used to establish authority.
create function training_load.dashboard_page_actor_workspace(p_actor uuid) returns jsonb language plpgsql as $$
declare pref public.user_workspace_preferences%rowtype; a uuid; ok boolean;
begin
  perform 1 from public.users where id=p_actor and is_active=true for share;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  perform 1 from public.user_global_roles where user_id=p_actor order by role for share;
  perform 1 from public.user_club_roles where user_id=p_actor order by club_id,role for share;
  perform 1 from public.user_team_roles where user_id=p_actor order by team_id,role for share;
  select * into pref from public.user_workspace_preferences where user_id=p_actor for share;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  if pref.workspace_type in ('platform','private_coach') then
    select exists(select 1 from public.user_global_roles where user_id=p_actor and is_active=true
      and role=case pref.workspace_type when 'platform' then 'platform_admin' else 'independent_coach' end) into ok;
  elsif pref.workspace_type='club' then
    perform 1 from public.clubs where id=pref.scope_id and coalesce(is_active,true) for share;
    ok := found and exists(select 1 from public.user_club_roles where user_id=p_actor and club_id=pref.scope_id and role='club_admin' and is_active=true);
  elsif pref.workspace_type='team' then
    perform 1 from public.teams where id=pref.scope_id and coalesce(is_active,true) for share;
    ok := found and exists(select 1 from public.user_team_roles where user_id=p_actor and team_id=pref.scope_id and role='team_coach' and is_active=true);
  elsif pref.workspace_type='athlete' then
    select id into a from public.athletes where user_id=p_actor order by id limit 1 for share;
    ok := found;
  end if;
  if not coalesce(ok,false) then raise exception 'notFound' using errcode='P4P10'; end if;
  return jsonb_build_object('type',pref.workspace_type,'dataWorkspaceType',pref.workspace_type,
    'dataWorkspaceScopeId',case when pref.workspace_type in ('club','team') then pref.scope_id else null::uuid end)
    || case when pref.workspace_type in ('private_coach','athlete') then jsonb_build_object('dataWorkspaceUserId',p_actor) else '{}'::jsonb end
    || case when a is not null then jsonb_build_object('athleteWorkspaceAthleteId',a) else '{}'::jsonb end;
end $$;

create function training_load.dashboard_page_assert_access(p_actor uuid,p_dashboard uuid,p_workspace jsonb)
returns void language plpgsql as $$
declare d training_load.dashboards%rowtype; manager boolean; club uuid;
begin
  select * into d from training_load.dashboards where id=p_dashboard;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  manager := exists(select 1 from public.user_global_roles where user_id=p_actor and role='platform_admin' and is_active=true)
    or (d.owner_scope='user' and d.owner_user_id=p_actor)
    or (d.owner_scope='club' and exists(select 1 from public.user_club_roles where user_id=p_actor and club_id=d.owner_club_id and role='club_admin' and is_active=true));
  if d.owner_scope='team' then
    select club_id into club from public.teams where id=d.owner_team_id for share;
    manager := manager or exists(select 1 from public.user_team_roles where user_id=p_actor and team_id=d.owner_team_id and role='team_coach' and is_active=true)
      or exists(select 1 from public.user_club_roles where user_id=p_actor and club_id=club and role='club_admin' and is_active=true);
  end if;
  if not coalesce(manager,false) or d.data_workspace_type is distinct from p_workspace->>'dataWorkspaceType'
    or d.data_workspace_scope_id is distinct from (p_workspace->>'dataWorkspaceScopeId')::uuid
    or (d.data_workspace_type in ('private_coach','athlete') and d.owner_user_id is distinct from p_actor) then
    raise exception 'notFound' using errcode='P4P10';
  end if;
end $$;

create function training_load.dashboard_page_assert_filter(p_actor uuid,p_workspace jsonb,p_filter jsonb)
returns void language plpgsql as $$
declare a uuid; act uuid; comp uuid; parent_act uuid; typ text := p_workspace->>'dataWorkspaceType'; scope uuid := (p_workspace->>'dataWorkspaceScopeId')::uuid;
begin
  if not training_load.dashboard_page_filter_valid(p_filter) then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  for a in select value::uuid from jsonb_array_elements_text(nullif(p_filter->'athleteIds','null'::jsonb)) loop
    if not exists(select 1 from public.athletes where id=a) or not (
      typ='platform'
      or typ='athlete' and a=(p_workspace->>'athleteWorkspaceAthleteId')::uuid
      or typ='private_coach' and exists(select 1 from public.user_athletes where user_id=p_actor and athlete_id=a and is_active=true)
      or typ in ('club','team') and exists(select 1 from public.athlete_memberships m where m.athlete_id=a and m.status='active'
        and m.membership_type=typ and case typ when 'club' then m.club_id else m.team_id end=scope)
    ) then raise exception 'notFound' using errcode='P4P10'; end if;
  end loop;
  act := (p_filter->>'activityId')::uuid; comp := (p_filter->>'componentId')::uuid;
  if comp is not null then
    select activity_id into parent_act from training.activity_components where id=comp for share;
    if not found then raise exception 'notFound' using errcode='P4P10'; end if;
    if act is not null and act<>parent_act then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  end if;
  for act in select distinct id from unnest(array[act,parent_act]) id where id is not null loop
    perform 1 from training.activities activity where activity.id=act and activity.lifecycle_state<>'superseded' and (
      typ='platform' or typ in ('club','team') and activity.owner_scope=typ
        and case typ when 'club' then activity.owner_club_id else activity.owner_team_id end=scope
      or typ='private_coach' and activity.owner_scope='user' and activity.owner_user_id=p_actor
      or typ='athlete' and exists(select 1 from training.activity_participants participant where participant.activity_id=activity.id
        and participant.athlete_id=(p_workspace->>'athleteWorkspaceAthleteId')::uuid and participant.merge_status='canonical')
    ) for share of activity;
    if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  end loop;
end $$;

create function training_load.dashboard_page_row_guard() returns trigger language plpgsql as $$
declare parent uuid := coalesce(new.dashboard_id,old.dashboard_id); n integer;
begin
  perform 1 from training_load.dashboards where id=parent for update;
  if not found then return coalesce(new,old); end if; -- dashboard DELETE cascade
  if tg_op='INSERT' then
    select count(*) into n from training_load.dashboard_pages where dashboard_id=parent;
    if n>=32 then raise exception 'pageLimitReached' using errcode='P4P07'; end if;
  elsif tg_op='DELETE' then
    if (select count(*) from training_load.dashboard_pages where dashboard_id=parent)<=1 then
      raise exception 'lastPageRequired' using errcode='P4P05'; end if;
  elsif new.dashboard_id is distinct from old.dashboard_id or new.id is distinct from old.id then
    raise exception 'invalidRequest' using errcode='P4P09';
  else
    new.defaults_revision := old.defaults_revision;
    if new.name is distinct from old.name or new.default_filter is distinct from old.default_filter
      or new.period_config is distinct from old.period_config or new.period_origin is distinct from old.period_origin then
      new.revision := old.revision+1;
    -- Internal widget/series revision bumps are independent of Page field edits.
    else new.revision := greatest(old.revision,new.revision); end if;
    if new.default_filter is distinct from old.default_filter or new.period_config is distinct from old.period_config
      or new.period_origin is distinct from old.period_origin then new.defaults_revision := old.defaults_revision+1; end if;
  end if;
  return coalesce(new,old);
end $$;
-- Revision bumps for child changes are handled separately below; retain caller's
-- explicit revision increment when no Page content field changed.
create trigger dashboard_pages_row_guard before insert or update or delete on training_load.dashboard_pages
  for each row execute function training_load.dashboard_page_row_guard();
create function training_load.dashboard_pages_bump_collection() returns trigger language plpgsql as $$
begin
  if tg_op<>'UPDATE' or new.position is distinct from old.position then
    update training_load.dashboards set pages_revision=pages_revision+1 where id=coalesce(new.dashboard_id,old.dashboard_id);
  end if;
  return coalesce(new,old);
end $$;
create trigger dashboard_pages_collection after insert or update or delete on training_load.dashboard_pages
  for each row execute function training_load.dashboard_pages_bump_collection();

-- GUC is only an internal-operation scope marker, NOT authorization. Every
-- use verifies actual parent membership. mutate_dashboard_page authorizes first.
create function training_load.dashboard_page_internal(p_dashboard uuid,p_page uuid,p_operation text default null)
returns boolean language plpgsql stable as $$
declare s jsonb;
begin
  s := nullif(current_setting('training_load.page_mutation',true),'')::jsonb;
  return coalesce(s->>'dashboardId'=p_dashboard::text and s->>'pageId'=p_page::text
    and s->>'operation' in ('duplicate','delete') and (p_operation is null or s->>'operation'=p_operation)
    and exists(select 1 from training_load.dashboard_pages where id=p_page and dashboard_id=p_dashboard),false);
exception when invalid_text_representation then return false;
end $$;

-- Called at the START of legacy sanctioned writers, before any widget lock.
create function training_load.dashboard_legacy_page_guard(p_dashboard uuid,p_widget uuid default null)
returns void language plpgsql as $$
declare parent uuid := p_dashboard;
begin
  if parent is null then select dashboard_id into parent from training_load.dashboard_widgets where id=p_widget; end if;
  perform 1 from training_load.dashboards where id=parent for update;
  if (select count(*) from training_load.dashboard_pages where dashboard_id=parent)>=2 then
    raise exception 'pagesClientRequired' using errcode='P4P01';
  end if;
  perform 1 from training_load.dashboard_pages where dashboard_id=parent order by id for update;
end $$;

create function training_load.dashboard_widgets_page_guard() returns trigger language plpgsql as $$
declare parent uuid := coalesce(new.dashboard_id,old.dashboard_id); pg uuid := coalesce(new.page_id,old.page_id); n integer;
begin
  if tg_op='UPDATE' and (new.page_id is distinct from old.page_id or new.id is distinct from old.id) then
    raise exception 'invalidRequest' using errcode='P4P09'; end if;
  perform 1 from training_load.dashboards where id=parent for update;
  if not found and tg_op='DELETE' then return old; end if;
  select count(*) into n from training_load.dashboard_pages where dashboard_id=parent;
  if tg_op='INSERT' and pg is null and n=1 then
    select id into pg from training_load.dashboard_pages where dashboard_id=parent; new.page_id:=pg;
  end if;
  -- A Page DELETE has already removed the parent. Permit only its FK cascade.
  if tg_op='DELETE' and not exists(select 1 from training_load.dashboard_pages where id=pg and dashboard_id=parent)
    and pg_trigger_depth()>1 then return old; end if;
  if n>=2 and not training_load.dashboard_page_internal(parent,pg) then raise exception 'pagesClientRequired' using errcode='P4P01'; end if;
  perform 1 from training_load.dashboard_pages where id=pg and dashboard_id=parent for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  return coalesce(new,old);
end $$;
create trigger aaa_dashboard_widgets_page_guard before insert or update or delete on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_page_guard();

create function training_load.dashboard_series_page_guard() returns trigger language plpgsql as $$
declare w training_load.dashboard_widgets%rowtype; wid uuid := coalesce(new.widget_id,old.widget_id);
begin
  select * into w from training_load.dashboard_widgets where id=wid;
  if not found and tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  perform 1 from training_load.dashboards where id=w.dashboard_id for update;
  if (select count(*) from training_load.dashboard_pages where dashboard_id=w.dashboard_id)>=2
    and not training_load.dashboard_page_internal(w.dashboard_id,w.page_id) then raise exception 'pagesClientRequired' using errcode='P4P01'; end if;
  perform 1 from training_load.dashboard_pages where id=w.page_id and dashboard_id=w.dashboard_id for update;
  perform 1 from training_load.dashboard_widgets where id=wid and page_id=w.page_id for update;
  return coalesce(new,old);
end $$;
create trigger aaa_dashboard_series_page_guard before insert or update or delete on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_series_page_guard();

create or replace function training_load.dashboard_widgets_check_no_overlap() returns trigger language plpgsql as $$
begin
  if exists(select 1 from training_load.dashboard_widgets a join training_load.dashboard_widgets b
    on b.page_id=a.page_id and b.id<>a.id and a.x<b.x+b.width and b.x<a.x+a.width
    and a.y<b.y+b.height and b.y<a.y+a.height where a.page_id=new.page_id) then
    raise exception 'dashboard_widgets: final page layout overlaps' using errcode='23514';
  end if;
  return new;
end $$;

create function training_load.dashboard_widget_page_revision() returns trigger language plpgsql as $$
declare pg uuid := coalesce(new.page_id,old.page_id); content boolean := true; layout boolean := true;
begin
  if tg_op='UPDATE' then
    layout := row(new.x,new.y,new.width,new.height,new.mobile_order) is distinct from row(old.x,old.y,old.width,old.height,old.mobile_order);
    -- Includes explicit widget revision bumps caused by series triggers.
    content := (to_jsonb(new)-array['x','y','width','height','mobile_order','revision','updated_at'])
      is distinct from (to_jsonb(old)-array['x','y','width','height','mobile_order','revision','updated_at'])
      or (not layout and new.revision is distinct from old.revision);
  end if;
  update training_load.dashboard_pages set revision=revision+case when content then 1 else 0 end,
    layout_revision=layout_revision+case when layout then 1 else 0 end where id=pg;
  return coalesce(new,old);
end $$;
create trigger dashboard_widgets_page_revision after insert or update or delete on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widget_page_revision();

-- Preserve known v1 main-series references; unknown versions are opaque JSONB
-- values and MUST be returned byte-for-byte in the JSONB representation.
create function training_load.dashboard_page_remap_presentation(p jsonb,p_series_map jsonb)
returns jsonb language plpgsql immutable as $$
declare rule jsonb; rules jsonb := '[]'::jsonb; ref text;
begin
  if p is null or training_load.dashboard_presentation_opaque(p) then return p; end if;
  if jsonb_typeof(p#>'{tableFormatting,rules}')='array' then
    for rule in select value from jsonb_array_elements(p#>'{tableFormatting,rules}') loop
      ref := rule#>>'{target,series}';
      if p_series_map ? ref then rule := jsonb_set(rule,'{target,series}',p_series_map->ref); end if;
      -- The symbolic main selector remains symbolic; rule IDs/athlete IDs and
      -- backendReference IDs are deliberately not treated as series IDs.
      rules := rules||jsonb_build_array(rule);
    end loop;
    p := jsonb_set(p,'{tableFormatting,rules}',rules);
  end if;
  return p;
end $$;

create function training_load.mutate_dashboard_page(
  p_actor uuid,p_request uuid,p_payload_hash text,p_dashboard uuid,p_page uuid,p_operation text,p_input jsonb,p_workspace jsonb
) returns jsonb language plpgsql as $$
declare
  ws jsonb; d training_load.dashboards%rowtype; pg training_load.dashboard_pages%rowtype;
  saved training_load.dashboard_page_requests%rowtype; required text[]; allowed text[]; k text;
  result jsonb; target uuid; ids uuid[]; n integer; prev_scope text; w training_load.dashboard_widgets%rowtype;
  s training_load.dashboard_widget_series%rowtype; nw training_load.dashboard_widgets%rowtype;
  ns training_load.dashboard_widget_series%rowtype; widget_map jsonb := '{}'; series_map jsonb := '{}';
  evaluated_at timestamptz := clock_timestamp();
begin
  if p_actor is null or p_request is null or p_dashboard is null or p_payload_hash is null
    or p_payload_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or octet_length(p_input::text)>65536 or p_operation is null
    or p_operation not in ('create','rename','defaults','reorder','duplicate','delete') then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  ws := training_load.dashboard_page_actor_workspace(p_actor);
  if ws is distinct from p_workspace then raise exception 'notFound' using errcode='P4P10'; end if;
  -- No request may use the workspace argument or a scope GUC to acquire rights.
  perform training_load.dashboard_page_assert_access(p_actor,p_dashboard,ws);
  select * into d from training_load.dashboards where id=p_dashboard for update;
  if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  perform training_load.dashboard_page_assert_access(p_actor,p_dashboard,ws);
  perform 1 from training_load.dashboard_pages where dashboard_id=p_dashboard order by id for update;
  select * into saved from training_load.dashboard_page_requests where initiator_user_id=p_actor
    and workspace=ws and dashboard_id=p_dashboard and request_id=p_request;
  if found then
    if saved.operation is distinct from p_operation or saved.page_id is distinct from p_page
      or saved.payload_hash is distinct from p_payload_hash or saved.input_body is distinct from p_input then
      raise exception 'idempotencyConflict' using errcode='P4P08'; end if;
    -- A deleted target is replayable only through its original ledger proof;
    -- current parent/workspace authority was checked above. Never execute again.
    return saved.receipt;
  end if;
  perform training_load.assert_dashboard_writable(p_dashboard);
  if d.is_template or d.data_workspace_type is null then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  set constraints training_load.dashboard_pages_position_unique, training_load.dashboard_widgets_order_unique,
    training_load.dashboard_widgets_mobile_order_unique, training_load.dashboard_widget_series_order_unique,
    training_load.dashboard_widgets_check_no_overlap deferred;
  if (p_operation in ('create','reorder')) is distinct from (p_page is null) then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p_page is not null then
    select * into pg from training_load.dashboard_pages where id=p_page and dashboard_id=p_dashboard;
    if not found then raise exception 'notFound' using errcode='P4P10'; end if;
  end if;
  required := case p_operation
    when 'create' then array['name','periodConfig','defaultFilter','expectedPagesRevision']
    when 'rename' then array['name','expectedPageRevision']
    when 'defaults' then array['expectedPageDefaultsRevision']
    when 'reorder' then array['pageIds','expectedPagesRevision']
    when 'duplicate' then array['name','expectedPageRevision','expectedPagesRevision']
    when 'delete' then array['expectedPageRevision','expectedPagesRevision','deleteWidgets'] end;
  allowed := required || array['contractVersion','requestId'] || case when p_operation='defaults' then array['periodConfig','defaultFilter'] else array[]::text[] end;
  if not training_load.dashboard_simple_object(p_input,allowed,required||array['contractVersion','requestId'])
    or p_input->'contractVersion' is distinct from '1'::jsonb or p_input->>'requestId' is distinct from p_request::text then
    raise exception 'invalidRequest' using errcode='P4P09'; end if;
  foreach k in array array['expectedPagesRevision','expectedPageRevision','expectedPageDefaultsRevision'] loop
    if p_input ? k then
      if jsonb_typeof(p_input->k) is distinct from 'number' then raise exception 'invalidRequest' using errcode='P4P09'; end if;
      if (p_input->>k)::numeric<1
        or (p_input->>k)::numeric>9007199254740991 or trunc((p_input->>k)::numeric)<>(p_input->>k)::numeric then
        raise exception 'invalidRequest' using errcode='P4P09'; end if;
    end if;
  end loop;
  if p_input ? 'name' and (jsonb_typeof(p_input->'name') is distinct from 'string' or char_length(p_input->>'name') not between 1 and 200
    or p_input->>'name' !~ '[^[:space:]]' or p_input->>'name' ~ '[[:cntrl:]]') then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p_input ? 'periodConfig' and not coalesce(training_load.dashboard_page_period_valid(p_input->'periodConfig'),false) then raise exception 'invalidRequest' using errcode='P4P09'; end if;
  if p_input ? 'defaultFilter' then perform training_load.dashboard_page_assert_filter(p_actor,ws,p_input->'defaultFilter'); end if;
  if p_input ? 'expectedPagesRevision' and d.pages_revision<>(p_input->>'expectedPagesRevision')::bigint then raise exception 'stalePagesRevision' using errcode='P4P03'; end if;
  if p_input ? 'expectedPageRevision' and pg.revision<>(p_input->>'expectedPageRevision')::bigint then raise exception 'stalePageRevision' using errcode='P4P02'; end if;
  if p_input ? 'expectedPageDefaultsRevision' and pg.defaults_revision<>(p_input->>'expectedPageDefaultsRevision')::bigint then raise exception 'stalePageDefaultsRevision' using errcode='P4P04'; end if;
  select count(*) into n from training_load.dashboard_pages where dashboard_id=p_dashboard;
  target := p_page;
  if p_operation in ('create','duplicate') then
    if n>=32 then raise exception 'pageLimitReached' using errcode='P4P07'; end if;
    insert into training_load.dashboard_pages(dashboard_id,name,position,default_filter,period_config,period_origin)
      values(p_dashboard,p_input->>'name',n,case when p_operation='create' then p_input->'defaultFilter' else pg.default_filter end,
        case when p_operation='create' then p_input->'periodConfig' else pg.period_config end,
        case when p_operation='create' then 'configured' else pg.period_origin end) returning id into target;
  end if;
  if p_operation='rename' then update training_load.dashboard_pages set name=p_input->>'name' where id=p_page;
  elsif p_operation='defaults' then
    if not p_input ?| array['defaultFilter','periodConfig'] then raise exception 'invalidRequest' using errcode='P4P09'; end if;
    update training_load.dashboard_pages set
      default_filter=case when p_input ? 'defaultFilter' then p_input->'defaultFilter' else default_filter end,
      period_config=case when p_input ? 'periodConfig' then p_input->'periodConfig' else period_config end,
      period_origin=case when p_input ? 'periodConfig' then 'configured' else period_origin end where id=p_page;
  elsif p_operation='reorder' then
    if jsonb_typeof(p_input->'pageIds') is distinct from 'array' then raise exception 'invalidRequest' using errcode='P4P09'; end if;
    if jsonb_array_length(p_input->'pageIds')<>n then raise exception 'invalidRequest' using errcode='P4P09'; end if;
    if exists(select 1 from jsonb_array_elements(p_input->'pageIds') e where jsonb_typeof(e)<>'string'
      or e#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'invalidRequest' using errcode='P4P09'; end if;
    select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_input->'pageIds');
    if (select count(distinct id) from unnest(ids) id)<>n then raise exception 'invalidRequest' using errcode='P4P09'; end if;
    if exists(select 1 from unnest(ids) member(page_id) where not exists(select 1 from training_load.dashboard_pages p where p.id=member.page_id and p.dashboard_id=p_dashboard)) then raise exception 'notFound' using errcode='P4P10'; end if;
    update training_load.dashboard_pages p set position=ordered.ordinality-1 from unnest(ids) with ordinality ordered(id,ordinality) where p.id=ordered.id;
  elsif p_operation in ('duplicate','delete') then
    perform 1 from training_load.dashboard_widgets where page_id=p_page and dashboard_id=p_dashboard order by id for update;
    perform 1 from training_load.dashboard_widget_series locked_series
      join training_load.dashboard_widgets locked_widget on locked_widget.id=locked_series.widget_id
      where locked_widget.page_id=p_page and locked_widget.dashboard_id=p_dashboard
      order by locked_series.id for update of locked_series;
    prev_scope := current_setting('training_load.page_mutation',true);
    perform set_config('training_load.page_mutation',jsonb_build_object('dashboardId',p_dashboard,'pageId',case when p_operation='duplicate' then target else p_page end,'operation',p_operation)::text,true);
    if p_operation='delete' then
      if jsonb_typeof(p_input->'deleteWidgets') is distinct from 'boolean' then raise exception 'invalidRequest' using errcode='P4P09'; end if;
      if n<=1 then raise exception 'lastPageRequired' using errcode='P4P05'; end if;
      if p_input->'deleteWidgets'<>'true'::jsonb and exists(select 1 from training_load.dashboard_widgets where page_id=p_page) then raise exception 'pageNotEmpty' using errcode='P4P06'; end if;
      -- Delete children explicitly while their Page still exists, preserving
      -- actual-parent checks and the opaque-series cascade behavior.
      delete from training_load.dashboard_widgets where page_id=p_page and dashboard_id=p_dashboard;
      delete from training_load.dashboard_pages where id=p_page and dashboard_id=p_dashboard;
      update training_load.dashboard_pages set position=position-1 where dashboard_id=p_dashboard and position>pg.position;
    else
      for w in select * from training_load.dashboard_widgets where page_id=p_page and dashboard_id=p_dashboard order by id loop
        nw := w; nw.id:=gen_random_uuid(); nw.page_id:=target; nw.revision:=1; nw.created_at:=now(); nw.updated_at:=now(); nw.presentation_config:=null;
        insert into training_load.dashboard_widgets select (nw).*;
        widget_map := widget_map||jsonb_build_object(w.id::text,nw.id);
        for s in select * from training_load.dashboard_widget_series where widget_id=w.id order by id loop
          ns:=s; ns.id:=gen_random_uuid(); ns.widget_id:=nw.id; ns.created_at:=now(); ns.created_by_user_id:=p_actor;
          insert into training_load.dashboard_widget_series select (ns).*;
          series_map := series_map||jsonb_build_object(s.id::text,ns.id);
        end loop;
        update training_load.dashboard_widgets set presentation_config=training_load.dashboard_page_remap_presentation(w.presentation_config,series_map) where id=nw.id and page_id=target;
      end loop;
    end if;
    perform set_config('training_load.page_mutation',coalesce(prev_scope,''),true);
  end if;
  set constraints training_load.dashboard_pages_position_unique, training_load.dashboard_widgets_order_unique,
    training_load.dashboard_widgets_mobile_order_unique, training_load.dashboard_widget_series_order_unique,
    training_load.dashboard_widgets_check_no_overlap immediate;
  select * into pg from training_load.dashboard_pages where id=target and dashboard_id=p_dashboard;
  result := jsonb_build_object('requestId',p_request,'dashboardId',p_dashboard,'pageId',target,'operation',p_operation,
    'pagesRevision',(select pages_revision from training_load.dashboards where id=p_dashboard));
  if pg.id is not null then
    result := result||jsonb_build_object('pageRevision',pg.revision,'defaultsRevision',pg.defaults_revision,'layoutRevision',pg.layout_revision);
    if pg.period_config is not null then result:=result||jsonb_build_object('resolvedPeriod',training_load.dashboard_page_resolve_period(pg.period_config,evaluated_at),'evaluatedAt',evaluated_at); end if;
  end if;
  if p_operation='duplicate' then result := result||jsonb_build_object('idMapping',jsonb_build_object('widgets',widget_map,'series',series_map)); end if;
  insert into training_load.dashboard_page_requests(initiator_user_id,request_id,dashboard_id,workspace,operation,page_id,payload_hash,input_body,receipt)
    values(p_actor,p_request,p_dashboard,ws,p_operation,p_page,p_payload_hash,p_input,result);
  return result;
end $$;

-- Add entry guards to existing sanctioned widget/series writers, preserving
-- signatures, OUT names and defaults. Simple keeps its recorded-replay exception.
-- Trigger backstops also cover raw legacy clone SQL; archive/delete exempt.
do $$
declare f record; body text; call text; guarded integer := 0;
begin
  for f in select p.oid,p.proname,p.prosrc,p.proargnames from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='training_load' and p.proname=any(array['replace_dashboard_layout','update_widget_layout','create_widget',
      'update_widget_content','delete_widget','add_series','update_series','resolve_series_binding','delete_series','reorder_series',
      'create_widget_with_presentation','update_widget_content_with_presentation','save_simple_widget']) loop
    if f.proname='save_simple_widget' then
      -- Preserve its advisory-lock -> dashboard order and original ledger
      -- replay (including on multi-Page). Only a genuinely new write requires
      -- a single Page. Lock Page rows before the replay's original widget lock.
      if position('select request.* into recorded_request' in f.prosrc)=0
        or position('if p_request_issued_at < clock_timestamp()' in f.prosrc)=0 then
        raise exception 'v55: unexpected Simple replay body';
      end if;
      body:=replace(f.prosrc,'select request.* into recorded_request',
        'perform 1 from training_load.dashboard_pages where dashboard_id=p_dashboard_id order by id for update;'||chr(10)||'  select request.* into recorded_request');
      body:=replace(body,'if p_request_issued_at < clock_timestamp()',
        'perform training_load.dashboard_legacy_page_guard(p_dashboard_id);'||chr(10)||'  if p_request_issued_at < clock_timestamp()');
    else
      call := case when 'p_dashboard_id'=any(f.proargnames) then 'perform training_load.dashboard_legacy_page_guard(p_dashboard_id);'
        else 'perform training_load.dashboard_legacy_page_guard(null,p_widget_id);' end;
      body := regexp_replace(f.prosrc,'\mbegin\M','begin'||chr(10)||'  '||call,'i');
    end if;
    if body=f.prosrc then raise exception 'v55: legacy writer guard injection failed: %',f.proname; end if;
    execute replace(pg_get_functiondef(f.oid),f.prosrc,body);
    guarded:=guarded+1;
  end loop;
  if guarded<>13 then raise exception 'v55: expected 13 legacy sanctioned widget/series writers, found %',guarded; end if;
end $$;
