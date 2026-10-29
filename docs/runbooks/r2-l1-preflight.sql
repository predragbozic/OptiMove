-- PR203 L1 + Drive + bridge READ-ONLY PREFLIGHT. NOT EXECUTED IN PRODUCTION.
-- Stage A works before any of the three new migrations. Stage B below requires
-- Drive to exist: run it separately ONLY after the inventory confirms its objects.
-- Requires separate owner approval. Use the exact deployment connection,
-- without displaying credentials. First confirm expected DB/project/role.
-- Run sections individually; on timeout/permission/missing relation: ROLLBACK,
-- report UNKNOWN/BLOCKED, do not grant privileges or increase limits automatically.
begin read only;
set local statement_timeout='10s';
set local lock_timeout='1s';
select current_database() as database_name,current_user as effective_role,session_user,
  current_setting('server_version') as server_version,
  current_setting('statement_timeout') as role_statement_timeout,
  current_setting('lock_timeout') as role_lock_timeout,
  current_setting('idle_in_transaction_session_timeout') as idle_transaction_timeout,
  current_setting('default_transaction_isolation') as default_isolation;

-- PG15+ is required. media schema and the baseline relations must exist.
select n.nspname,pg_get_userbyid(n.nspowner) as owner,
  has_schema_privilege(current_user,n.oid,'USAGE') as schema_usage,
  has_schema_privilege(current_user,n.oid,'CREATE') as schema_create
from pg_namespace n where n.nspname in ('media','library','plans','public');
select v.name,to_regclass(v.name) as relation
from (values('public.schema_migrations'),('public.migration_cutovers'),
 ('media.assets'),('media.uploads'),('library.exercises'),('library.program_access'),
 ('plans.plans'),('plans.plan_days'),('plans.plan_sessions'),('plans.plan_items'),
 ('media.storage_accounts'),('public.users'),('media.retention_holds'),('media.hold_assets'),('media.retention_events'),
 ('media.asset_reference_matrix'),('media.drive_copies'),('media.drive_copy_events'),('media.l1_item_assets')) v(name);
-- Stop before subsequent sections if baseline relations are missing.

-- Current effective deployment/runtime role must be able to create L1 objects,
-- attach triggers, read sources and acquire locks; no privilege repair is done here.
select n.nspname||'.'||c.relname as relation,pg_get_userbyid(c.relowner) as owner,
 c.relrowsecurity,c.relforcerowsecurity,pg_has_role(current_user,c.relowner,'USAGE') as inherits_owner,
 (select rolbypassrls from pg_roles where rolname=current_user) as role_bypasses_rls,
 has_table_privilege(current_user,c.oid,'SELECT') as can_select,
 has_table_privilege(current_user,c.oid,'UPDATE') as can_lock_rows,
 has_table_privilege(current_user,c.oid,'TRIGGER') as can_trigger,
 has_table_privilege(current_user,c.oid,'REFERENCES') as can_reference
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname,c.relname) in (('media','assets'),('media','uploads'),
 ('library','exercises'),('library','program_access'),('plans','plans'),
 ('plans','plan_days'),('plans','plan_sessions'),('plans','plan_items'),('public','users'),
 ('media','storage_accounts'),('media','retention_holds'),('media','hold_assets'),
 ('media','retention_events'),('media','drive_copies'),('media','drive_copy_events'))
order by 1;
select has_function_privilege(current_user,'media.reject_audit_mutation()','EXECUTE') as audit_guard_execute;
select migration_name,checksum,execution_time_ms,runner_version
from public.schema_migrations order by migration_name;
-- Compare ALL ledger checksums to the reviewed release files offline.
-- L1 must be absent before its first deployment; matching row is expected after.

-- Cheap estimates first; exact counts below may time out and must then be UNKNOWN.
select n.nspname||'.'||c.relname as relation,c.reltuples::bigint as estimated_rows,
 pg_total_relation_size(c.oid) as total_relation_bytes
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname,c.relname) in (('media','assets'),('media','uploads'),
 ('library','exercises'),('library','program_access'),('plans','plans'),
 ('plans','plan_items')) order by 1;
select 'assets' as relation,count(*) as rows from media.assets
union all select 'uploads',count(*) from media.uploads
union all select 'exercises',count(*) from library.exercises
union all select 'plans',count(*) from plans.plans
union all select 'plan_items',count(*) from plans.plan_items
union all select 'program_access',count(*) from library.program_access;

-- Exact migration precondition, aggregate only: no asset IDs, URLs or user data.
with refs as (
 select video_asset_id as id,'video'::text as kind from library.exercises where video_asset_id is not null
 union all select image_asset_id,'image' from library.exercises where image_asset_id is not null
 union all select video_asset_id,'video' from plans.plan_items where video_asset_id is not null
 union all select image_asset_id,'image' from plans.plan_items where image_asset_id is not null
 union all select source_video_asset_id,'video' from media.assets where source_video_asset_id is not null
)
select count(*) as selections,count(distinct r.id) as distinct_assets,
 count(*) filter(where a.id is null or a.status<>'ready' or a.kind<>r.kind) as invalid_selections
from refs r left join media.assets a on a.id=r.id;

-- Logical backfill scale. Matches L1's eligible CURRENT basis rules, not billing.
-- A hold has one member per asset and slot (unique hold_id,asset_id,slot), so the
-- expected members count each plan's DISTINCT assets per slot, not its item slots:
-- the same R2 video in two items is one member per hold.
with slots as (
 select d.plan_id,count(*) filter(where i.video_asset_id is not null)
  +count(*) filter(where i.image_asset_id is not null) as slots,
  count(distinct i.video_asset_id)+count(distinct i.image_asset_id) as members
 from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id
 join plans.plan_days d on d.id=s.plan_day_id group by d.plan_id
), bases as (
 select p.id,s.slots,s.members,
 (case when p.athlete_id is not null and not coalesce(p.is_template,false)
   and p.status='active' and coalesce(p.is_active,true) then 1 else 0 end)
 + (select count(*) from library.program_access g where g.plan_id=p.id
   and g.status in ('accessed','used','completed') and (g.expires_at is null or g.expires_at>now())
   and not (g.access_type is not distinct from 'copied' and g.user_id is not distinct from p.created_by_user_id)) as bases
 from plans.plans p join slots s on s.plan_id=p.id where s.slots>0
)
select count(*) as r2_plans,coalesce(sum(slots),0) as item_media_slots,
 coalesce(sum(bases),0) as expected_holds,coalesce(sum(members*bases),0) as expected_manifest_members,
 coalesce(max(members*bases),0) as largest_plan_manifest from bases;

-- Legacy Drive links with a blank other than a space at an edge (tab, line break,
-- no-break space, other Unicode blanks). The bridge (btrim: spaces only) and the
-- backend (driveFileIdOf, the same rule) read the file id of such a link as no
-- file when the blank follows the id: the link is never copied or served as a
-- copy and keeps playing from Drive. edge_blank_links counts every such link;
-- stays_on_drive counts the ones whose id the blank hides (a reader that strips
-- every blank would find a file). Fix the link in the row to have it copied.
-- Aggregate only: no ids, URLs or user data. Parser inlined, valid before the migrations;
-- the copy columns are read through to_jsonb so the query runs on any schema version.
with links as (
 select case when to_jsonb(e)->>'source_exercise_id' is not null or to_jsonb(e)->>'copy_parent_id' is not null then 'exercise_copy' else 'exercise' end as source,
  v.kind,btrim(v.url) as spaced,
  regexp_replace(v.url,'^[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$','','g') as stripped
 from library.exercises e cross join lateral (values ('video',e.video_source,e.video_url),('image',e.image_source,e.image_url)) v(kind,slot_source,url)
 where coalesce(v.slot_source,'legacy')='legacy' and v.url ~ '(drive\.google\.com|googleusercontent\.com)'
 union all
 select 'plan_item',v.kind,btrim(v.url),
  regexp_replace(v.url,'^[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$','','g')
 from plans.plan_items i cross join lateral (values ('video',i.video_source,i.video_url),('image',i.image_source,i.image_url)) v(kind,slot_source,url)
 where coalesce(v.slot_source,'legacy')='legacy' and v.url ~ '(drive\.google\.com|googleusercontent\.com)'
), parsed as (
 select source,kind,spaced<>stripped as edge_blank,
  coalesce((regexp_match(spaced,'drive\.google\.com/file/d/([^/?#]+)'))[1],
   case when spaced ~ 'drive\.google\.com' then (regexp_match(spaced,'[?&]id=([^&#]+)'))[1] end,
   (regexp_match(spaced,'lh3\.googleusercontent\.com/d/([^/?#=]+)'))[1]) ~ '^[A-Za-z0-9_-]{10,200}$' as spaced_names_file,
  coalesce((regexp_match(stripped,'drive\.google\.com/file/d/([^/?#]+)'))[1],
   case when stripped ~ 'drive\.google\.com' then (regexp_match(stripped,'[?&]id=([^&#]+)'))[1] end,
   (regexp_match(stripped,'lh3\.googleusercontent\.com/d/([^/?#=]+)'))[1]) ~ '^[A-Za-z0-9_-]{10,200}$' as stripped_names_file
 from links
)
select source,kind,count(*) as drive_form_links,
 count(*) filter(where edge_blank) as edge_blank_links,
 count(*) filter(where not coalesce(spaced_names_file,false) and coalesce(stripped_names_file,false)) as stays_on_drive
from parsed group by source,kind order by source,kind;

-- Advisory runner serialization does not prevent locks held by normal app traffic.
-- Do not kill sessions here and do not output raw query text (may contain data).
select pid,usename,state,xact_start,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers
from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
 and (xact_start is not null or cardinality(pg_blocking_pids(pid))>0)
order by xact_start nulls last;
select l.pid,n.nspname,c.relname,l.mode,l.granted
from pg_locks l join pg_class c on c.oid=l.relation
join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('media','library','plans') and l.pid<>pg_backend_pid()
order by n.nspname,c.relname,l.pid;
-- Observe ONLY: the runner uses the bigint advisory key 822026.
-- Never call pg_try_advisory_lock/pg_advisory_lock in a read-only preflight.
select l.pid,l.granted,a.backend_start,a.state,a.xact_start,a.wait_event_type,a.wait_event
from pg_locks l left join pg_stat_activity a on a.pid=l.pid
where l.locktype='advisory' and l.database=(select oid from pg_database where datname=current_database())
 and l.classid=0::oid and l.objid=822026::oid and l.objsubid=1;
-- For COMMIT-unknown recovery, absence of this lock alone is not proof:
-- correlate the original backend/process and repeat ledger/object checks after quiescence.
rollback;

-- STAGE B: run ONLY if media.drive_copies AND media.drive_copy_events exist.
-- This stage is valid both before and after bridge. No dependency on bridge
-- functions/views: normalization below matches the bridge function verbatim.
-- Abort/ROLLBACK on any missing privilege, hidden rows or timeout.
begin read only;
set local statement_timeout='10s';
set local lock_timeout='1s';

select c.relname,c.relrowsecurity,c.relforcerowsecurity,
 pg_get_userbyid(c.relowner) as owner,pg_has_role(current_user,c.relowner,'USAGE') as inherits_owner,
 has_table_privilege(current_user,c.oid,'SELECT') as can_select,
 has_table_privilege(current_user,c.oid,'UPDATE') as can_lock,
 pg_total_relation_size(c.oid) as total_bytes,c.reltuples::bigint as estimated_rows
from pg_class c where c.oid in ('media.drive_copies'::regclass,'media.drive_copy_events'::regclass);
select 'drive_copies' as relation,count(*) as rows from media.drive_copies
union all select 'drive_copy_events',count(*) from media.drive_copy_events;
select count(*) as mappings,
 count(*) filter(where a.id is null or a.status<>'ready' or a.kind<>m.kind or not coalesce(s.owner_platform,false)) as invalid_mappings
from media.drive_copies m left join media.assets a on a.id=m.asset_id
left join media.storage_accounts s on s.id=a.storage_account_id;
select count(*) as duplicate_file_kind_groups from
 (select drive_file_id,kind from media.drive_copies group by 1,2 having count(*)>1) x;
select count(*) as duplicate_asset_groups from
 (select asset_id from media.drive_copies group by 1 having count(*)>1) x;
select count(*) as duplicate_active_import_groups from
 (select purpose,context->>'driveFileId' from media.uploads
  where purpose in ('drive_import_video','drive_import_image') and status in ('reserved','verifying','cancelling')
  group by 1,2 having count(*)>1) x;
select count(*) filter(where (purpose in ('drive_import_video','drive_import_image'))
 <> coalesce(context->>'type'='drive_import',false)) as mismatched_import_context,
 count(*) filter(where purpose in ('drive_import_video','drive_import_image') and status in ('reserved','verifying','cancelling')) as active_imports
from media.uploads;
-- History is evidence, not a playback grant. Equal timestamps must not be used
-- to invent event ordering. Missing created events require review, not repair.
select count(*) as mappings_without_created_event from media.drive_copies m
where not exists(select 1 from media.drive_copy_events e where e.drive_file_id=m.drive_file_id
 and e.kind=m.kind and e.asset_id=m.asset_id and e.event='created');
select event,count(*) as rows from media.drive_copy_events group by event;

-- Effective snapshot slots plus entitlement fan-out BEFORE bridge backfill.
-- Own plan-item URL only; do not join today's exercise URL. Counts are not rights.
with raw_slots as (
 select i.id,i.plan_session_id,v.kind,v.source,v.asset_id,btrim(v.url) as url
 from plans.plan_items i cross join lateral (values
 ('video',i.video_source,i.video_asset_id,i.video_url),
 ('image',i.image_source,i.image_asset_id,i.image_url)) v(kind,source,asset_id,url)
), parsed as (
 select *,coalesce((regexp_match(url,'drive\.google\.com/file/d/([^/?#]+)'))[1],
 case when url ~ 'drive\.google\.com' then (regexp_match(url,'[?&]id=([^&#]+)'))[1] end,
 (regexp_match(url,'lh3\.googleusercontent\.com/d/([^/?#=]+)'))[1]) as file_id from raw_slots
), effective as (
 select p.*,case when p.source='asset' then p.asset_id when p.source='legacy' then m.asset_id end as effective_id
 from parsed p left join media.drive_copies m on m.kind=p.kind and m.drive_file_id=p.file_id
 and p.file_id ~ '^[A-Za-z0-9_-]{10,200}$'
), slots as (
 select d.plan_id,count(*) filter(where e.effective_id is not null) as slots,
 count(*) filter(where e.source='legacy' and e.effective_id is not null) as mapped_slots,
 count(*) filter(where e.source='legacy' and e.file_id ~ '^[A-Za-z0-9_-]{10,200}$' and e.effective_id is null) as unmapped_drive_slots
 from effective e join plans.plan_sessions s on s.id=e.plan_session_id
 join plans.plan_days d on d.id=s.plan_day_id group by d.plan_id
), bases as (
 select p.id,s.*,
 (case when p.athlete_id is not null and not coalesce(p.is_template,false)
 and p.status='active' and coalesce(p.is_active,true) then 1 else 0 end)
 + (select count(*) from library.program_access g where g.plan_id=p.id
 and g.status in ('accessed','used','completed') and (g.expires_at is null or g.expires_at>now())
 and not (g.access_type is not distinct from 'copied' and g.user_id is not distinct from p.created_by_user_id)) as bases
 from plans.plans p join slots s on s.plan_id=p.id
)
select count(*) filter(where slots>0) as effective_r2_plans,
 coalesce(sum(slots),0) as effective_item_slots,coalesce(sum(mapped_slots),0) as mapped_legacy_slots,
 coalesce(sum(unmapped_drive_slots),0) as future_unmapped_slots,
 coalesce(sum(bases) filter(where slots>0),0) as eligible_basis_upper_bound,
 coalesce(sum(slots*bases),0) as manifest_member_upper_bound,
 coalesce(sum(mapped_slots*bases),0) as mapped_member_upper_bound,
 coalesce(max(slots*bases),0) as largest_plan_manifest_upper_bound
from bases;
-- Upper bounds are logical slots x current eligible bases, not exact inserts:
-- repeated asset/slot deduplication and already-captured manifests reduce growth.
rollback;

-- STAGE C: metadata only, valid for every prefix (missing objects -> no rows).
begin read only;
set local statement_timeout='10s';
set local lock_timeout='1s';
select n.nspname,c.relname as table_name,ix.relname as index_name,
 i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) as definition
from pg_index i join pg_class c on c.oid=i.indrelid
join pg_namespace n on n.oid=c.relnamespace join pg_class ix on ix.oid=i.indexrelid
where (n.nspname,c.relname) in (('plans','plan_items'),('plans','plan_sessions'),('plans','plan_days'),
 ('library','program_access'),('media','uploads'),('media','storage_accounts'),
 ('media','drive_copies'),('media','drive_copy_events'),('media','hold_assets'),('media','retention_holds'))
order by 1,2,3;
select n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where not t.tgisinternal and n.nspname in ('media','plans','library') order by 1,2,3;
select c.conname,c.conrelid::regclass as relation,c.convalidated,pg_get_constraintdef(c.oid) as definition
from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
where n.nspname='media' order by 2,1;
select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,p.prosecdef,
 md5(pg_get_functiondef(p.oid)) as definition_md5,
 pg_get_userbyid(p.proowner) as owner,has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='media' order by 1,2;
select n.nspname,c.relname,c.reloptions
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='media' and c.relkind='v';
-- Before bridge, expression indexes/functions are expected absent. After bridge,
-- require valid/ready plan_items_drive_video and plan_items_drive_image and the
-- reviewed function/trigger signatures. Presence alone is not equivalence.
select n.nspname,c.relname,c.reltuples::bigint as estimated_rows,pg_total_relation_size(c.oid) as total_bytes
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='media' and c.relname in ('retention_holds','hold_assets','retention_events');
select r.rolname,d.datname,setting.value as timeout_or_isolation
from pg_db_role_setting s left join pg_roles r on r.oid=s.setrole
left join pg_database d on d.oid=s.setdatabase
cross join lateral unnest(s.setconfig) setting(value)
where s.setrole in (0,(select oid from pg_roles where rolname=current_user))
 and s.setdatabase in (0,(select oid from pg_database where datname=current_database()))
 and split_part(setting.value,'=',1) in ('statement_timeout','lock_timeout',
 'idle_in_transaction_session_timeout','idle_session_timeout','transaction_timeout','default_transaction_isolation');
rollback;
