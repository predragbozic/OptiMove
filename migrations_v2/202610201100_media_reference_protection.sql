-- L1: private, additive reference/retention protection. No GC, deadlines or quota writes.
-- The migration runner owns the transaction. All functions are SECURITY INVOKER.
do $$
begin
  if exists(select 1 from (
    select video_asset_id as id,'video'::text as kind from library.exercises where video_asset_id is not null
    union all select image_asset_id,'image' from library.exercises where image_asset_id is not null
    union all select video_asset_id,'video' from plans.plan_items where video_asset_id is not null
    union all select image_asset_id,'image' from plans.plan_items where image_asset_id is not null
    union all select source_video_asset_id,'video' from media.assets where source_video_asset_id is not null
  ) r left join media.assets a on a.id=r.id where a.id is null or a.status<>'ready' or a.kind<>r.kind) then
    raise exception 'media_reference_preflight_required' using errcode='P7501';
  end if;
end; $$;

create table media.retention_holds (
  id uuid primary key default gen_random_uuid(),
  basis_key text not null unique,
  basis_type text not null check (basis_type in ('assigned_plan','program_grant','unverified_commercial','ambiguous_grant')),
  source_plan_id uuid not null references plans.plans(id) on delete restrict,
  -- Deliberately historical UUID, not a cascading FK: revoke may delete the grant.
  source_program_access_id uuid,
  beneficiary_user_id uuid references public.users(id) on delete restrict,
  source_owner_user_id uuid references public.users(id) on delete restrict,
  assigned_athlete_id uuid references public.athletes(id) on delete restrict,
  review_required boolean not null,
  reason text not null check (length(reason)>0),
  basis_snapshot jsonb not null check (jsonb_typeof(basis_snapshot)='object'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index retention_holds_plan on media.retention_holds(source_plan_id);
create index retention_holds_beneficiary on media.retention_holds(beneficiary_user_id) where beneficiary_user_id is not null;
create index retention_holds_owner on media.retention_holds(source_owner_user_id) where source_owner_user_id is not null;
create index retention_holds_athlete on media.retention_holds(assigned_athlete_id) where assigned_athlete_id is not null;
create table media.hold_assets (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid not null references media.retention_holds(id) on delete restrict,
  asset_id uuid not null references media.assets(id) on delete restrict,
  -- Snapshot provenance survives ordinary item replacement/deletion.
  plan_item_id uuid not null,
  slot text not null check (slot in ('video','image')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(hold_id,asset_id,plan_item_id,slot)
);
create index hold_assets_asset on media.hold_assets(asset_id);
create table media.retention_events (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references media.assets(id) on delete restrict,
  hold_id uuid references media.retention_holds(id) on delete restrict,
  event text not null, source_table text not null, source_id uuid,
  reason text not null, details jsonb not null default '{}'::jsonb,
  database_role text not null default current_user,
  transaction_id bigint not null default txid_current(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index retention_events_asset on media.retention_events(asset_id,created_at,id);
create index retention_events_hold on media.retention_events(hold_id,created_at,id);

create view media.asset_reference_matrix with (security_invoker=true) as
  select e.video_asset_id as asset_id,'exercise'::text as reference_type,e.id as reference_id,'video'::text as slot,
    e.id as exercise_id,null::uuid as plan_item_id,null::uuid as plan_id,null::uuid as hold_id,true as protects_retention
    from library.exercises e where e.video_asset_id is not null
  union all select e.image_asset_id,'exercise',e.id,'image',e.id,null,null,null,true from library.exercises e where e.image_asset_id is not null
  union all select p.video_asset_id,'plan_item',p.id,'video',p.exercise_id,p.id,d.plan_id,null,true
    from plans.plan_items p join plans.plan_sessions s on s.id=p.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where p.video_asset_id is not null
  union all select p.image_asset_id,'plan_item',p.id,'image',p.exercise_id,p.id,d.plan_id,null,true
    from plans.plan_items p join plans.plan_sessions s on s.id=p.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where p.image_asset_id is not null
  union all select h.asset_id,'retention_hold',h.id,h.slot,null,h.plan_item_id,r.source_plan_id,h.hold_id,true
    from media.hold_assets h join media.retention_holds r on r.id=h.hold_id
  union all select a.source_video_asset_id,'derived_image',a.id,'source_video',null,null,null,null,true
    from media.assets a where a.source_video_asset_id is not null
  union all select u.asset_id,'upload',u.id,null,null,null,null,null,u.status in ('reserved','verifying','cancelling')
    from media.uploads u;

-- Serialize every new media reference against status transitions, including raw SQL/bulk copies.
create function media.l1_require_ready(p_asset uuid,p_kind text) returns void language plpgsql as $$
declare a media.assets%rowtype;
begin
  if p_asset is null then return; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'media_retention_isolation_required' using errcode='P7503'; end if;
  select * into a from media.assets where id=p_asset for update;
  if not found or a.status<>'ready' or a.kind<>p_kind then
    raise exception 'media_reference_unavailable' using errcode='P7501';
  end if;
end; $$;

create function media.l1_reference_guard() returns trigger language plpgsql as $$
declare previous jsonb; value uuid; old_value uuid; slot_name text; plan_uuid uuid;
begin
  previous:=case when TG_OP='UPDATE' then to_jsonb(OLD) else '{}'::jsonb end;
  -- The grant path locks plan -> assets. Item writes must follow the same order.
  if TG_TABLE_SCHEMA='plans' then
    for plan_uuid in select distinct d.plan_id from plans.plan_sessions ps join plans.plan_days d on d.id=ps.plan_day_id
      where ps.id in (NEW.plan_session_id,(previous->>'plan_session_id')::uuid) order by d.plan_id
    loop perform 1 from plans.plans where id=plan_uuid for no key update; end loop;
  end if;
  -- Sorted IDs avoid the common two-slot reverse-lock deadlock.
  for slot_name,value in select x.slot,x.asset from (values
    ('video',NEW.video_asset_id),('image',NEW.image_asset_id)) x(slot,asset) order by x.asset nulls last loop
    old_value:=(previous->>(slot_name||'_asset_id'))::uuid;
    if value is not null and value is distinct from old_value then perform media.l1_require_ready(value,slot_name); end if;
  end loop;
  return NEW;
end; $$;
create trigger media_l1_reference_guard before insert or update of video_asset_id,image_asset_id on library.exercises
  for each row execute function media.l1_reference_guard();
create trigger media_l1_reference_guard before insert or update of video_asset_id,image_asset_id,plan_session_id on plans.plan_items
  for each row execute function media.l1_reference_guard();

create function media.l1_hold_asset_guard() returns trigger language plpgsql as $$
begin
  perform media.l1_require_ready(NEW.asset_id,NEW.slot);
  return NEW;
end; $$;
create trigger hold_asset_ready before insert on media.hold_assets for each row execute function media.l1_hold_asset_guard();

create function media.l1_asset_guard() returns trigger language plpgsql as $$
begin
  if NEW.source_video_asset_id is not null and NEW.source_video_asset_id is distinct from OLD.source_video_asset_id then
    if NEW.source_video_asset_id=NEW.id then raise exception 'media_reference_unavailable' using errcode='P7501'; end if;
    perform media.l1_require_ready(NEW.source_video_asset_id,'video');
  end if;
  if OLD.status='ready' and (NEW.status<>'ready' or NEW.object_key is distinct from OLD.object_key or NEW.kind is distinct from OLD.kind)
    and current_setting('transaction_isolation')<>'read committed' then raise exception 'media_retention_isolation_required' using errcode='P7503'; end if;
  if OLD.status='ready' and (NEW.status<>'ready' or NEW.object_key is distinct from OLD.object_key or NEW.kind is distinct from OLD.kind)
    and exists(select 1 from media.asset_reference_matrix where asset_id=OLD.id and protects_retention) then
    raise exception 'media_retention_protected' using errcode='P7502';
  end if;
  return NEW;
end; $$;
create trigger media_l1_asset_guard before update of status,object_key,kind,source_video_asset_id on media.assets
  for each row execute function media.l1_asset_guard();
-- Inserts can carry derivation links too; ready/status writes are otherwise unchanged.
create function media.l1_asset_insert_guard() returns trigger language plpgsql as $$
begin
  if NEW.source_video_asset_id=NEW.id then raise exception 'media_reference_unavailable' using errcode='P7501'; end if;
  perform media.l1_require_ready(NEW.source_video_asset_id,'video');return NEW;
end; $$;
create trigger media_l1_asset_insert_guard before insert on media.assets for each row execute function media.l1_asset_insert_guard();

create function media.l1_derivation_event() returns trigger language plpgsql as $$
declare old_source uuid;
begin
  if TG_OP='UPDATE' then old_source:=OLD.source_video_asset_id; end if;
  if NEW.source_video_asset_id is distinct from old_source then
    insert into media.retention_events(asset_id,event,source_table,source_id,reason,details)
      select v.id,v.event,'media.assets',NEW.id,'Derived media ancestry changed; no hold release',
        jsonb_build_object('slot','source_video')
      from (values(old_source,'reference_removed'),(NEW.source_video_asset_id,'reference_added')) v(id,event)
      where v.id is not null;
  end if;
  return null;
end; $$;
create trigger media_l1_derivation_event after insert or update of source_video_asset_id on media.assets
  for each row execute function media.l1_derivation_event();

-- A retention manifest is NOT playback authorization or proof of payment.
create function media.l1_capture_plan(p_plan uuid) returns void language plpgsql as $$
declare p plans.plans%rowtype; basis record; hold_uuid uuid; new_hold boolean; inserted record;
begin
  select * into p from plans.plans where id=p_plan for no key update;
  if not found or not exists(select 1 from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id
    join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=p_plan and (i.video_asset_id is not null or i.image_asset_id is not null)) then return; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'media_retention_isolation_required' using errcode='P7503'; end if;
  for basis in
    select 'assigned:'||p.id||':'||p.athlete_id as basis_key,'assigned_plan'::text as kind,null::uuid as grant_id,null::uuid as beneficiary,
      p.athlete_id as athlete,false as needs_review,jsonb_build_object('planStatus',p.status,'athleteId',p.athlete_id) as snapshot
      where p.athlete_id is not null and not coalesce(p.is_template,false) and p.status='active' and coalesce(p.is_active,true)
    union all
    select 'grant:'||g.id||':'||p.id||':'||coalesce(g.user_id::text,'unknown'),case when g.access_type='purchased' then 'unverified_commercial'
      when g.access_type in ('assigned','coach_assigned','downloaded') then 'program_grant' else 'ambiguous_grant' end,
      g.id,g.user_id,null,coalesce(g.access_type not in ('assigned','coach_assigned','downloaded'),true),
      jsonb_build_object('accessType',g.access_type,'status',g.status,'startsAt',g.starts_at,'expiresAt',g.expires_at,'source',g.source,'license',g.license_snapshot)
      from library.program_access g where g.plan_id=p_plan and g.status in ('accessed','used','completed')
        and (g.expires_at is null or g.expires_at>now())
        -- Own copy receipts are history, not another person's acquired right.
        and not (g.access_type is not distinct from 'copied' and g.user_id is not distinct from p.created_by_user_id)
  loop
    insert into media.retention_holds(basis_key,basis_type,source_plan_id,source_program_access_id,beneficiary_user_id,
      source_owner_user_id,assigned_athlete_id,review_required,reason,basis_snapshot)
      values(basis.basis_key,basis.kind,p_plan,basis.grant_id,basis.beneficiary,p.created_by_user_id,basis.athlete,basis.needs_review,
        case when basis.needs_review then 'Existing grant requires review; no payment proof inferred' else 'Existing application grant or assigned plan; preserve snapshot media' end,basis.snapshot)
      on conflict(basis_key) do nothing returning id into hold_uuid;
    new_hold:=found;
    if not new_hold then select id into hold_uuid from media.retention_holds where basis_key=basis.basis_key; end if;
    if new_hold then insert into media.retention_events(hold_id,event,source_table,source_id,reason,details)
      values(hold_uuid,'hold_created','plans.plans',p_plan,'Acquired-use retention captured; not playback authorization',basis.snapshot); end if;
    for inserted in
      insert into media.hold_assets(hold_id,asset_id,plan_item_id,slot)
        select hold_uuid,v.asset,i.id,v.slot from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id
        join plans.plan_days d on d.id=s.plan_day_id cross join lateral(values(i.video_asset_id,'video'),(i.image_asset_id,'image')) v(asset,slot)
        where d.plan_id=p_plan and v.asset is not null order by v.asset,i.id,v.slot
        on conflict(hold_id,asset_id,plan_item_id,slot) do nothing returning asset_id,plan_item_id,slot
    loop
      insert into media.retention_events(asset_id,hold_id,event,source_table,source_id,reason,details)
        values(inserted.asset_id,hold_uuid,'manifest_asset_captured','plans.plan_items',inserted.plan_item_id,
          'Preserve independently acquired snapshot',jsonb_build_object('slot',inserted.slot));
    end loop;
  end loop;
end; $$;

create function media.l1_reference_event() returns trigger language plpgsql as $$
declare before_row jsonb; after_row jsonb; slot_name text; old_id uuid; new_id uuid; plan_uuid uuid;
begin
  before_row:=case when TG_OP<>'INSERT' then to_jsonb(OLD) else '{}'::jsonb end;
  after_row:=case when TG_OP<>'DELETE' then to_jsonb(NEW) else '{}'::jsonb end;
  foreach slot_name in array array['video','image'] loop
    old_id:=(before_row->>(slot_name||'_asset_id'))::uuid;new_id:=(after_row->>(slot_name||'_asset_id'))::uuid;
    if old_id is distinct from new_id then
      if old_id is not null then insert into media.retention_events(asset_id,event,source_table,source_id,reason,details)
        values(old_id,'reference_removed',TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,coalesce(NEW.id,OLD.id),'Source selection removed; no automatic hold release',jsonb_build_object('slot',slot_name)); end if;
      if new_id is not null then insert into media.retention_events(asset_id,event,source_table,source_id,reason,details)
        values(new_id,'reference_added',TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,NEW.id,'New source selection',jsonb_build_object('slot',slot_name)); end if;
    end if;
  end loop;
  if TG_TABLE_SCHEMA='plans' and TG_OP='UPDATE' and after_row->>'plan_session_id' is distinct from before_row->>'plan_session_id' then
    insert into media.retention_events(event,source_table,source_id,reason,details)
      values('reference_context_changed','plans.plan_items',NEW.id,'Moved snapshot; prior manifests remain retained',jsonb_build_object('oldSessionId',OLD.plan_session_id,'newSessionId',NEW.plan_session_id));
  end if;
  if TG_TABLE_SCHEMA='plans' and TG_OP<>'DELETE' then
    select d.plan_id into plan_uuid from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id where s.id=NEW.plan_session_id;
    perform media.l1_capture_plan(plan_uuid);
  end if;
  return null;
end; $$;
create trigger media_l1_reference_event after insert or update of video_asset_id,image_asset_id or delete on library.exercises
  for each row execute function media.l1_reference_event();
create trigger media_l1_reference_event after insert or update of video_asset_id,image_asset_id,plan_session_id or delete on plans.plan_items
  for each row execute function media.l1_reference_event();

create function media.l1_parent_move_event() returns trigger language plpgsql as $$
declare plan_uuid uuid;
begin
  if TG_TABLE_NAME='plan_days' then
    for plan_uuid in select distinct id from unnest(array[OLD.plan_id,NEW.plan_id]) id order by id loop perform media.l1_capture_plan(plan_uuid); end loop;
  else
    for plan_uuid in select distinct d.plan_id from plans.plan_days d where d.id in (OLD.plan_day_id,NEW.plan_day_id) order by d.plan_id loop perform media.l1_capture_plan(plan_uuid); end loop;
  end if;
  insert into media.retention_events(event,source_table,source_id,reason)
    values('reference_parent_moved',TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,NEW.id,'Re-evaluate retention for moved snapshot hierarchy');
  return null;
end; $$;
create trigger media_l1_parent_move_event after update of plan_id on plans.plan_days for each row execute function media.l1_parent_move_event();
create trigger media_l1_parent_move_event after update of plan_day_id on plans.plan_sessions for each row execute function media.l1_parent_move_event();

create function media.l1_plan_event() returns trigger language plpgsql as $$
begin
  perform media.l1_capture_plan(NEW.id);return null;
end; $$;
create trigger media_l1_plan_event after insert or update of athlete_id,is_template,status,is_active,created_by_user_id on plans.plans
  for each row execute function media.l1_plan_event();
create function media.l1_grant_event() returns trigger language plpgsql as $$
begin
  if TG_WHEN='BEFORE' then
    perform media.l1_capture_plan(OLD.plan_id);
    if TG_OP='UPDATE' then return NEW; end if;
  end if;
  insert into media.retention_events(event,source_table,source_id,reason,details)
    values('grant_'||lower(TG_OP),'library.program_access',coalesce(NEW.id,OLD.id),
      'Grant transition recorded; historical event alone is not an entitlement',
      jsonb_build_object('before',case when TG_OP<>'INSERT' then to_jsonb(OLD) else null end,'after',case when TG_OP<>'DELETE' then to_jsonb(NEW) else null end));
  if TG_WHEN='AFTER' then perform media.l1_capture_plan(NEW.plan_id); end if;
  if TG_OP='DELETE' then return OLD; end if;return NEW;
end; $$;
create trigger media_l1_grant_before before update or delete on library.program_access for each row execute function media.l1_grant_event();
create trigger media_l1_grant_after after insert or update on library.program_access for each row execute function media.l1_grant_event();
create function media.l1_plan_delete_guard() returns trigger language plpgsql as $$
begin
  if exists(select 1 from media.retention_holds where source_plan_id=OLD.id) then
    raise exception 'media_retention_protected' using errcode='P7502';
  end if;return OLD;
end; $$;
create trigger media_l1_plan_delete_guard before delete on plans.plans for each row execute function media.l1_plan_delete_guard();

-- Append-only: no L1 API, TTL or background process can release protection.
create trigger retention_holds_immutable before update or delete or truncate on media.retention_holds for each statement execute function media.reject_audit_mutation();
create trigger hold_assets_immutable before update or delete or truncate on media.hold_assets for each statement execute function media.reject_audit_mutation();
create trigger retention_events_immutable before update or delete or truncate on media.retention_events for each statement execute function media.reject_audit_mutation();
alter table media.retention_holds enable row level security;
alter table media.hold_assets enable row level security;
alter table media.retention_events enable row level security;
revoke all on media.retention_holds,media.hold_assets,media.retention_events,media.asset_reference_matrix from public;
do $$
declare fn record; role_name text; plan_uuid uuid;
begin
  for fn in select oid::regprocedure as signature from pg_proc where pronamespace='media'::regnamespace and proname like 'l1_%' loop
    execute format('revoke all on function %s from public',fn.signature);
  end loop;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=role_name) and role_name<>current_user then
      execute format('revoke all on media.retention_holds,media.hold_assets,media.retention_events,media.asset_reference_matrix from %I',role_name);
      for fn in select oid::regprocedure as signature from pg_proc where pronamespace='media'::regnamespace and proname like 'l1_%' loop
        execute format('revoke all on function %s from %I',fn.signature,role_name);
      end loop;
    end if;
  end loop;
  -- Backfill only R2-bearing plans, never legacy seed files or external storage.
  for plan_uuid in select distinct d.plan_id from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id
    join plans.plan_days d on d.id=s.plan_day_id where i.video_asset_id is not null or i.image_asset_id is not null order by d.plan_id loop
    perform media.l1_capture_plan(plan_uuid);
  end loop;
end; $$;
