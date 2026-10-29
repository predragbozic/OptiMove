create function media.l1_drive_file_id(p_url text) returns text language plpgsql immutable as $$
declare raw text:=btrim(p_url); file_id text;
begin
  file_id:=(regexp_match(raw,'drive\.google\.com/file/d/([^/?#]+)'))[1];
  if file_id is null and raw ~ 'drive\.google\.com' then file_id:=(regexp_match(raw,'[?&]id=([^&#]+)'))[1]; end if;
  if file_id is null then file_id:=(regexp_match(raw,'lh3\.googleusercontent\.com/d/([^/?#=]+)'))[1]; end if;
  if file_id ~ '^[A-Za-z0-9_-]{10,200}$' then return file_id; end if;
  return null;
end; $$;

create index plan_items_drive_video on plans.plan_items(media.l1_drive_file_id(video_url),plan_session_id) where video_source='legacy';
create index plan_items_drive_image on plans.plan_items(media.l1_drive_file_id(image_url),plan_session_id) where image_source='legacy';

create view media.l1_item_assets with (security_invoker=true) as
  select i.id,i.plan_session_id,
    case when i.video_source='asset' then i.video_asset_id when i.video_source='legacy' then video.asset_id end as video_asset_id,
    case when i.image_source='asset' then i.image_asset_id when i.image_source='legacy' then image.asset_id end as image_asset_id
  from plans.plan_items i
  left join media.drive_copies video on i.video_source='legacy' and video.kind='video' and video.drive_file_id=media.l1_drive_file_id(i.video_url)
  left join media.drive_copies image on i.image_source='legacy' and image.kind='image' and image.drive_file_id=media.l1_drive_file_id(i.image_url);

create or replace view media.asset_reference_matrix with (security_invoker=true) as
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
    from media.uploads u
  union all select c.asset_id,'drive_copy',c.asset_id,c.kind,null,null,null,null,true from media.drive_copies c
  union all select i.video_asset_id,'drive_plan_item',i.id,'video',p.exercise_id,i.id,d.plan_id,null,true
    from media.l1_item_assets i join plans.plan_items p on p.id=i.id join plans.plan_sessions s on s.id=i.plan_session_id
    join plans.plan_days d on d.id=s.plan_day_id where p.video_asset_id is null and i.video_asset_id is not null
  union all select i.image_asset_id,'drive_plan_item',i.id,'image',p.exercise_id,i.id,d.plan_id,null,true
    from media.l1_item_assets i join plans.plan_items p on p.id=i.id join plans.plan_sessions s on s.id=i.plan_session_id
    join plans.plan_days d on d.id=s.plan_day_id where p.image_asset_id is null and i.image_asset_id is not null;

create or replace function media.l1_capture_plan(p_plan uuid,p_item uuid default null,p_grant uuid default null) returns void language plpgsql as $$
declare p plans.plans%rowtype; basis record; hold_uuid uuid; new_hold boolean; member record; delta record;
begin
  if p_item is not null then
    select i.* into delta from media.l1_item_assets i join plans.plan_sessions ps on ps.id=i.plan_session_id
      join plans.plan_days d on d.id=ps.plan_day_id where i.id=p_item and d.plan_id=p_plan;
    if not found or (delta.video_asset_id is null and delta.image_asset_id is null) then return; end if;
  end if;
  select * into p from plans.plans where id=p_plan for no key update;
  if not found then return; end if;
  if p_item is null and not exists(select 1 from media.l1_item_assets i join plans.plan_sessions ps on ps.id=i.plan_session_id
    join plans.plan_days d on d.id=ps.plan_day_id where d.plan_id=p_plan and (i.video_asset_id is not null or i.image_asset_id is not null)) then return; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'media_retention_isolation_required' using errcode='P7503'; end if;
  for basis in
    select 'assigned:'||p.id||':'||p.athlete_id as basis_key,'assigned_plan'::text as kind,null::uuid as grant_id,null::uuid as beneficiary,
      p.athlete_id as athlete,false as needs_review,jsonb_build_object('planStatus',p.status,'athleteId',p.athlete_id) as snapshot
      where p_grant is null and p.athlete_id is not null and not coalesce(p.is_template,false) and p.status='active' and coalesce(p.is_active,true)
    union all
    select 'grant:'||g.id||':'||p.id||':'||coalesce(g.user_id::text,'unknown'),case when g.access_type='purchased' then 'unverified_commercial'
      when g.access_type in ('assigned','coach_assigned','downloaded') then 'program_grant' else 'ambiguous_grant' end,
      g.id,g.user_id,null,coalesce(g.access_type not in ('assigned','coach_assigned','downloaded'),true),
      jsonb_build_object('accessType',g.access_type,'status',g.status,'startsAt',g.starts_at,'expiresAt',g.expires_at,'source',g.source,'license',g.license_snapshot)
      from library.program_access g where g.plan_id=p_plan and g.status in ('accessed','used','completed')
        and (g.expires_at is null or g.expires_at>now()) and (p_grant is null or g.id=p_grant)
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
    if p_item is not null then
      perform media.l1_capture_members(hold_uuid,delta.id,delta.video_asset_id,delta.image_asset_id);
    else
      for member in select i.id,i.video_asset_id,i.image_asset_id from media.l1_item_assets i
        join plans.plan_sessions ps on ps.id=i.plan_session_id join plans.plan_days d on d.id=ps.plan_day_id
        where d.plan_id=p_plan and (i.video_asset_id is not null or i.image_asset_id is not null) order by i.id
      loop perform media.l1_capture_members(hold_uuid,member.id,member.video_asset_id,member.image_asset_id); end loop;
    end if;
  end loop;
end; $$;


create function media.l1_drive_plan_ids(p_file text,p_kind text) returns table(plan_id uuid) language sql stable as $$
  select distinct d.plan_id from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id join plans.plan_days d on d.id=s.plan_day_id
  where (p_kind='video' and i.video_source='legacy' and media.l1_drive_file_id(i.video_url)=p_file)
     or (p_kind='image' and i.image_source='legacy' and media.l1_drive_file_id(i.image_url)=p_file)
$$;

create function media.l1_lock_drive_import(p_file text,p_kind text) returns void language plpgsql as $$
declare plan_uuid uuid; locked_plans uuid[]:='{}'; saved jsonb; lock_key text:=p_file||':'||p_kind;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'media_retention_isolation_required' using errcode='P7503'; end if;
  saved:=coalesce(nullif(current_setting('media.drive_import_plans',true),''),'{}')::jsonb;
  if saved ? lock_key then
    select coalesce(array_agg(value::uuid),'{}') into locked_plans from jsonb_array_elements_text(saved->lock_key);
    if exists(select 1 from media.l1_drive_plan_ids(p_file,p_kind) where not(plan_id=any(locked_plans))) then
      raise exception 'drive_reference_set_changed' using errcode='40001';
    end if;
    return;
  end if;
  for plan_uuid in select plan_id from media.l1_drive_plan_ids(p_file,p_kind) order by plan_id loop
    perform 1 from plans.plans where id=plan_uuid for no key update nowait;
    locked_plans:=array_append(locked_plans,plan_uuid);
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('drive-copy:'||p_file||':'||p_kind,0));
  if exists(select 1 from media.l1_drive_plan_ids(p_file,p_kind) where not(plan_id=any(locked_plans))) then
    raise exception 'drive_reference_set_changed' using errcode='40001';
  end if;
  perform set_config('media.drive_import_plans',jsonb_set(saved,array[lock_key],to_jsonb(locked_plans))::text,true);
end; $$;

create function media.l1_drive_copy_insert() returns trigger language plpgsql as $$
declare plan_uuid uuid;
begin
  perform media.l1_lock_drive_import(NEW.drive_file_id,NEW.kind);
  perform media.l1_require_ready(NEW.asset_id,NEW.kind);
  return NEW;
end; $$;
create trigger media_l1_drive_copy_insert before insert on media.drive_copies for each row execute function media.l1_drive_copy_insert();

create function media.l1_drive_copy_capture() returns trigger language plpgsql as $$
declare plan_uuid uuid;
begin
  for plan_uuid in select plan_id from media.l1_drive_plan_ids(NEW.drive_file_id,NEW.kind) order by plan_id loop
    perform media.l1_capture_plan(plan_uuid);
  end loop;
  return null;
end; $$;
create trigger media_l1_drive_copy_capture after insert on media.drive_copies for each row execute function media.l1_drive_copy_capture();

create function media.l1_drive_item_guard() returns trigger language plpgsql as $$
declare plan_uuid uuid; reference record;
begin
  for plan_uuid in select distinct d.plan_id from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id
    where s.id=NEW.plan_session_id order by d.plan_id loop
    perform 1 from plans.plans where id=plan_uuid for no key update;
  end loop;
  for reference in select v.file_id,v.kind from (values
    (case when NEW.video_source='legacy' then media.l1_drive_file_id(NEW.video_url) end,'video'),
    (case when NEW.image_source='legacy' then media.l1_drive_file_id(NEW.image_url) end,'image')) v(file_id,kind)
    where v.file_id is not null order by v.file_id,v.kind loop
    if current_setting('transaction_isolation')<>'read committed' then raise exception 'media_retention_isolation_required' using errcode='P7503'; end if;
    perform pg_advisory_xact_lock(hashtextextended('drive-copy:'||reference.file_id||':'||reference.kind,0));
    perform media.l1_require_ready(c.asset_id,reference.kind) from media.drive_copies c
      where c.drive_file_id=reference.file_id and c.kind=reference.kind;
  end loop;
  return NEW;
end; $$;
create trigger media_l1_drive_item_guard before insert or update of video_url,image_url,video_source,image_source,plan_session_id on plans.plan_items
  for each row execute function media.l1_drive_item_guard();

create function media.l1_drive_item_capture() returns trigger language plpgsql as $$
declare plan_uuid uuid;
begin
  select d.plan_id into plan_uuid from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id where s.id=NEW.plan_session_id;
  perform media.l1_capture_plan(plan_uuid,NEW.id);
  return null;
end; $$;
create trigger media_l1_drive_item_capture after update of video_url,image_url,video_source,image_source on plans.plan_items
  for each row execute function media.l1_drive_item_capture();

revoke all on media.l1_item_assets from public;
do $$
declare role_name text; fn record; copy record; plan_uuid uuid;
begin
  for fn in select oid::regprocedure as signature from pg_proc where pronamespace='media'::regnamespace and proname like 'l1_%' loop
    execute format('revoke all on function %s from public',fn.signature);
  end loop;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=role_name) and role_name<>current_user then
      execute format('revoke all on media.l1_item_assets from %I',role_name);
      for fn in select oid::regprocedure as signature from pg_proc where pronamespace='media'::regnamespace and proname like 'l1_%' loop
        execute format('revoke all on function %s from %I',fn.signature,role_name);
      end loop;
    end if;
  end loop;
  for copy in select * from media.drive_copies order by drive_file_id,kind loop
    perform media.l1_require_ready(copy.asset_id,copy.kind);
    perform media.l1_lock_drive_import(copy.drive_file_id,copy.kind);
    for plan_uuid in select plan_id from media.l1_drive_plan_ids(copy.drive_file_id,copy.kind) order by plan_id loop
      perform media.l1_capture_plan(plan_uuid);
    end loop;
  end loop;
end; $$;
