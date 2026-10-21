-- L1 READ-ONLY PREFLIGHT TEMPLATE. NOT EXECUTED IN PRODUCTION.
-- Requires separate owner approval. Use the exact deployment connection,
-- without displaying credentials. First confirm expected DB/project/role.
-- Run sections individually; on timeout/permission/missing relation: ROLLBACK,
-- report UNKNOWN/BLOCKED, do not grant privileges or increase limits automatically.
begin read only;
select current_database() as database_name,current_user as effective_role,session_user,
  current_setting('server_version') as server_version,
  current_setting('statement_timeout') as role_statement_timeout,
  current_setting('lock_timeout') as role_lock_timeout,
  current_setting('idle_in_transaction_session_timeout') as idle_transaction_timeout,
  current_setting('default_transaction_isolation') as default_isolation;
set local statement_timeout='10s';
set local lock_timeout='1s';

-- PG15+ is required. media schema and the baseline relations must exist.
select n.nspname,pg_get_userbyid(n.nspowner) as owner,
  has_schema_privilege(current_user,n.oid,'USAGE') as schema_usage,
  has_schema_privilege(current_user,n.oid,'CREATE') as schema_create
from pg_namespace n where n.nspname in ('media','library','plans','public');
select v.name,to_regclass(v.name) as relation
from (values('public.schema_migrations'),('public.migration_cutovers'),
 ('media.assets'),('media.uploads'),('library.exercises'),('library.program_access'),
 ('plans.plans'),('plans.plan_days'),('plans.plan_sessions'),('plans.plan_items'),
 ('media.retention_holds'),('media.hold_assets'),('media.retention_events'),
 ('media.asset_reference_matrix')) v(name);
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
 ('plans','plan_days'),('plans','plan_sessions'),('plans','plan_items'))
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
with slots as (
 select d.plan_id,count(*) filter(where i.video_asset_id is not null)
  +count(*) filter(where i.image_asset_id is not null) as slots
 from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id
 join plans.plan_days d on d.id=s.plan_day_id group by d.plan_id
), bases as (
 select p.id,s.slots,
 (case when p.athlete_id is not null and not coalesce(p.is_template,false)
   and p.status='active' and coalesce(p.is_active,true) then 1 else 0 end)
 + (select count(*) from library.program_access g where g.plan_id=p.id
   and g.status in ('accessed','used','completed') and (g.expires_at is null or g.expires_at>now())
   and not (g.access_type is not distinct from 'copied' and g.user_id is not distinct from p.created_by_user_id)) as bases
 from plans.plans p join slots s on s.plan_id=p.id where s.slots>0
)
select count(*) as r2_plans,coalesce(sum(slots),0) as item_media_slots,
 coalesce(sum(bases),0) as expected_holds,coalesce(sum(slots*bases),0) as expected_manifest_members,
 coalesce(max(slots*bases),0) as largest_plan_manifest from bases;

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
