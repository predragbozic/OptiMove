-- P3 reference-table storage. Additive on v94; v95/v96 are independent.
set local lock_timeout = '5s';
DO $$
begin
 if not exists(select 1 from public.schema_migrations where migration_name='migrations_v2/202611261000_training_load_v94_chart_shapes.sql' and checksum='2c018c784ace8edc1cb0c9b729d5e0143166d813477899f678060d6c6ac304cb') then
  raise exception using errcode='23514',message='v97 requires exact v94';
 end if;
 if (select md5(prosrc) from pg_proc where oid='training_load.dashboard_presentation_valid(jsonb)'::regprocedure) is distinct from '9ce11aa017244998674f357eac2d8c89' then
  raise exception using errcode='23514',message='v97 presentation prerequisite changed';
 end if;
end $$;

create table training_load.dashboard_reference_tables (
 id uuid primary key default gen_random_uuid(), club_id uuid not null references public.clubs(id),
 name text not null check(training_load.source_metric_text_ok(name,80)),
 revision integer not null default 1 check(revision>0), archived boolean not null default false,
 published_version_id uuid, created_by uuid not null references public.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(id,club_id)
);
create unique index dashboard_reference_table_name on training_load.dashboard_reference_tables(club_id,lower(name)) where not archived;
create table training_load.dashboard_reference_versions (
 id uuid primary key default gen_random_uuid(), table_id uuid not null references training_load.dashboard_reference_tables(id),
 version integer not null check(version>0), published boolean not null default false,
 created_by uuid not null references public.users(id), published_at timestamptz,
 unique(table_id,version), unique(table_id,id), check(published=(published_at is not null))
);
alter table training_load.dashboard_reference_tables add constraint dashboard_reference_published_fk foreign key(id,published_version_id)
 references training_load.dashboard_reference_versions(table_id,id) deferrable initially deferred;
create unique index dashboard_reference_one_draft on training_load.dashboard_reference_versions(table_id) where not published;
create table training_load.dashboard_reference_columns (
 version_id uuid not null references training_load.dashboard_reference_versions(id),
 definition_id uuid not null references training_load.metric_definitions(id),
 unit text, aggregation text not null check(aggregation in ('sum','avg','max','last','none','ratio')),
 data_level text not null check(data_level in ('session','component','day')),
 sort_order integer not null check(sort_order between 0 and 19),
 primary key(version_id,definition_id), unique(version_id,sort_order)
);
create table training_load.dashboard_reference_rows (
 version_id uuid not null references training_load.dashboard_reference_versions(id),
 position_id uuid not null references public.sport_positions(id),
 sort_order integer not null check(sort_order between 0 and 99),
 primary key(version_id,position_id), unique(version_id,sort_order)
);
create table training_load.dashboard_reference_value_kinds (
 version_id uuid not null references training_load.dashboard_reference_versions(id),
 key text not null check(key ~ '^[a-z][a-z0-9_]{0,39}$'),
 name text not null check(training_load.source_metric_text_ok(name,80)),
 sort_order integer not null check(sort_order between 0 and 19),
 primary key(version_id,key), unique(version_id,sort_order), unique(version_id,name)
);
create table training_load.dashboard_reference_cells (
 version_id uuid not null, position_id uuid not null, definition_id uuid not null, value_key text not null,
 value numeric not null check(value::text not in ('NaN','Infinity','-Infinity') and abs(value)<=1e15),
 primary key(version_id,position_id,definition_id,value_key),
 foreign key(version_id,position_id) references training_load.dashboard_reference_rows(version_id,position_id),
 foreign key(version_id,definition_id) references training_load.dashboard_reference_columns(version_id,definition_id),
 foreign key(version_id,value_key) references training_load.dashboard_reference_value_kinds(version_id,key)
);
create table training_load.dashboard_reference_requests (
 actor_id uuid not null references public.users(id), request_id uuid not null, table_id uuid references training_load.dashboard_reference_tables(id),
 club_id uuid not null references public.clubs(id), dashboard_id uuid, widget_id uuid,
 request_hash text not null check(length(request_hash)=64), receipt jsonb not null,
 created_at timestamptz not null default now(), primary key(actor_id,request_id)
);
create table training_load.dashboard_reference_usage (
 table_id uuid primary key references training_load.dashboard_reference_tables(id), first_used_at timestamptz not null default now()
);

-- All mutations enter one sanctioned function. A transaction-bound marker stops
-- accidental raw writers; the function rechecks the canonical-admin basis.
create function training_load.dashboard_reference_guard() returns trigger language plpgsql as $$
declare v uuid; is_published boolean;
begin
 if tg_table_name='dashboard_reference_requests' and tg_op='DELETE' then
  if current_setting('optimove.reference_retention',true)=txid_current()::text and old.created_at<now()-interval '14 days' then return old; end if;
 end if;
 if tg_table_name in ('dashboard_reference_usage','dashboard_reference_widget_usage') and tg_op<>'INSERT' then
  raise exception using errcode='23514',message='referenceUseImmutable'; end if;
 if current_setting('optimove.reference_writer',true) is distinct from txid_current()::text then
  raise exception using errcode='42501',message='referenceWriterRequired';
 end if;
 if tg_table_name='dashboard_reference_requests' then
  if tg_op<>'INSERT' then raise exception using errcode='23514',message='referenceReceiptImmutable'; end if;
 elsif tg_table_name='dashboard_reference_versions' then
  if tg_op<>'INSERT' and old.published then raise exception using errcode='23514',message='referenceVersionImmutable'; end if;
 elsif tg_table_name in ('dashboard_reference_columns','dashboard_reference_rows','dashboard_reference_value_kinds','dashboard_reference_cells') then
  if tg_op='DELETE' then v=old.version_id; else v=new.version_id; end if;
  if tg_op='UPDATE' and old.version_id<>new.version_id then raise exception using errcode='23514',message='referenceVersionImmutable'; end if;
  select published into is_published from training_load.dashboard_reference_versions where id=v;
  if is_published then raise exception using errcode='23514',message='referenceVersionImmutable'; end if;
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
DO $$
declare t text;
begin
 foreach t in array array['dashboard_reference_tables','dashboard_reference_versions','dashboard_reference_columns','dashboard_reference_rows','dashboard_reference_value_kinds','dashboard_reference_cells','dashboard_reference_requests','dashboard_reference_usage'] loop
  execute format('create trigger reference_write_guard before insert or update or delete on training_load.%I for each row execute function training_load.dashboard_reference_guard()',t);
 end loop;
end $$;

-- Publication and draft writes share the same current, readable metric contract.
create function training_load.dashboard_reference_column_available(p_club uuid,p_definition uuid,p_unit text,p_aggregation text,p_level text) returns boolean language sql stable as $$
 select exists(select 1 from training_load.metric_definitions d join training_load.metric_definition_versions dv on dv.id=d.current_version_id
 where d.id=p_definition and d.state='active' and dv.value_type='numeric' and dv.unit is not distinct from p_unit
 and (d.owner_scope='system' or d.owner_scope='club' and d.owner_club_id=p_club)
 and not exists(select 1 from training_load.metric_definition_club_hides h where h.metric_definition_id=d.id and h.club_id=p_club and h.shown_at is null)
 and exists(select 1 from training_load.metric_definition_scope_capabilities c where c.metric_definition_id=d.id and c.scope_level=p_level)
 and case when dv.calculation->>'kind'='ratio' then p_aggregation in ('ratio','max','last','none') else p_aggregation in ('sum','avg','max','last','none') end)
$$;
create function training_load.mutate_dashboard_reference(p_actor uuid,p_club uuid,p_request uuid,p_hash text,p_table uuid,p_revision integer,p_action text,p_payload jsonb)
returns jsonb language plpgsql as $$
declare t training_load.dashboard_reference_tables; v uuid; receipt jsonb; prior training_load.dashboard_reference_requests;
 x jsonb; n integer; basis text;
begin
 perform pg_advisory_xact_lock(hashtextextended('dashboard-reference:'||p_actor::text||':'||p_request::text,0));
 basis=training_load.source_metric_actor_basis(p_actor,p_club);
 if basis is null or p_club is null then raise exception using errcode='42501',message='notFound'; end if;
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_request is null or p_action is null or p_action not in ('create','draft','publish','archive') or (p_action<>'create' and (p_revision is null or p_revision<1)) then raise exception using errcode='23514',message='invalidRequest'; end if;
 select * into prior from training_load.dashboard_reference_requests where actor_id=p_actor and request_id=p_request;
 if found then
  if prior.request_hash<>p_hash then raise exception using errcode='23514',message='requestIdReused'; end if;
  if prior.club_id<>p_club or not exists(select 1 from training_load.dashboard_reference_tables where id=prior.table_id and club_id=p_club) then raise exception using errcode='42501',message='notFound'; end if;
  return prior.receipt;
 end if;
 perform set_config('optimove.reference_writer',txid_current()::text,true);
 if p_action='create' then
  perform pg_advisory_xact_lock(hashtextextended('reference-club-limit:'||p_club::text,0));
  if (select count(*) from training_load.dashboard_reference_tables where club_id=p_club and not archived)>=100 then raise exception using errcode='23514',message='referenceTableLimit'; end if;
  insert into training_load.dashboard_reference_tables(club_id,name,created_by) values(p_club,p_payload->>'name',p_actor) returning * into t;
  insert into training_load.dashboard_reference_versions(table_id,version,created_by) values(t.id,1,p_actor) returning id into v;
 else
  select * into t from training_load.dashboard_reference_tables where id=p_table and club_id=p_club for update;
  if not found then raise exception using errcode='42501',message='notFound'; end if;
  if t.revision<>p_revision then raise exception using errcode='23514',message='staleRevision'; end if;
  if t.archived then raise exception using errcode='23514',message='referenceArchived'; end if;
  select id into v from training_load.dashboard_reference_versions where table_id=t.id and not published for update;
  if p_action='draft' then
   if v is null then
    select coalesce(max(version),0)+1 into n from training_load.dashboard_reference_versions where table_id=t.id;
    insert into training_load.dashboard_reference_versions(table_id,version,created_by) values(t.id,n,p_actor) returning id into v;
   end if;
   if jsonb_typeof(p_payload->'columns') is distinct from 'array' or jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_typeof(p_payload->'valueKinds') is distinct from 'array' or jsonb_typeof(p_payload->'cells') is distinct from 'array'
    or jsonb_array_length(p_payload->'columns')>20 or jsonb_array_length(p_payload->'rows')>100 or jsonb_array_length(p_payload->'valueKinds')>20 or jsonb_array_length(p_payload->'cells')>300 or octet_length(p_payload::text)>60000 then
    raise exception using errcode='23514',message='invalidRequest';
   end if;
   delete from training_load.dashboard_reference_cells where version_id=v;
   delete from training_load.dashboard_reference_columns where version_id=v;
   delete from training_load.dashboard_reference_rows where version_id=v;
   delete from training_load.dashboard_reference_value_kinds where version_id=v;
   for x in select value from jsonb_array_elements(p_payload->'columns') loop
    if not training_load.dashboard_reference_column_available(p_club,(x->>'definitionId')::uuid,x->>'unit',x->>'aggregation',x->>'dataLevel') then
     raise exception using errcode='23514',message='referenceMetricMismatch';end if;
    insert into training_load.dashboard_reference_columns values(v,(x->>'definitionId')::uuid,x->>'unit',x->>'aggregation',x->>'dataLevel',(x->>'order')::integer);
   end loop;
   for x in select value from jsonb_array_elements(p_payload->'rows') loop
    if not exists(select 1 from public.sport_positions p where p.id=(x->>'positionId')::uuid and p.archived_at is null and not exists(select 1 from public.club_position_overrides o where o.position_id=p.id and o.club_id=p_club and o.hidden) and (p.owner_scope='system' or p.owner_club_id=p_club)) then
     raise exception using errcode='42501',message='notFound'; end if;
    insert into training_load.dashboard_reference_rows values(v,(x->>'positionId')::uuid,(x->>'order')::integer);
   end loop;
   for x in select value from jsonb_array_elements(p_payload->'valueKinds') loop
    insert into training_load.dashboard_reference_value_kinds values(v,x->>'key',x->>'name',(x->>'order')::integer);
   end loop;
   for x in select value from jsonb_array_elements(p_payload->'cells') loop
    insert into training_load.dashboard_reference_cells values(v,(x->>'positionId')::uuid,(x->>'definitionId')::uuid,x->>'valueKey',(x->>'value')::numeric);
   end loop;
  elsif p_action='publish' then
   if v is null or not exists(select 1 from training_load.dashboard_reference_cells where version_id=v) then raise exception using errcode='23514',message='referenceEmpty'; end if;
   if exists(select 1 from training_load.dashboard_reference_columns c where c.version_id=v and not training_load.dashboard_reference_column_available(p_club,c.definition_id,c.unit,c.aggregation,c.data_level))
    or exists(select 1 from training_load.dashboard_reference_rows r join public.sport_positions p on p.id=r.position_id where r.version_id=v and (p.archived_at is not null or p.owner_scope<>'system' and p.owner_club_id is distinct from p_club or exists(select 1 from public.club_position_overrides o where o.position_id=p.id and o.club_id=p_club and o.hidden))) then
    raise exception using errcode='23514',message='referenceMetricMismatch';end if;
   update training_load.dashboard_reference_versions set published=true,published_at=now() where id=v;
   update training_load.dashboard_reference_tables set published_version_id=v where id=t.id;
  elsif p_action='archive' then
   update training_load.dashboard_reference_tables set archived=true where id=t.id;
  else raise exception using errcode='23514',message='invalidRequest';
  end if;
  update training_load.dashboard_reference_tables set revision=revision+1,updated_at=now() where id=t.id returning * into t;
 end if;
 receipt=jsonb_build_object('id',t.id,'revision',t.revision,'publishedVersionId',t.published_version_id);
 insert into training_load.dashboard_reference_requests(actor_id,request_id,table_id,club_id,request_hash,receipt) values(p_actor,p_request,t.id,p_club,p_hash,receipt);
 -- Survives archive and draft deletion: rollback refuses after any real write.
 insert into training_load.dashboard_reference_usage(table_id) values(t.id) on conflict do nothing;
 return receipt;
end $$;

create function training_load.dashboard_reference_no_truncate() returns trigger language plpgsql as $$
begin raise exception using errcode='23514',message='referenceTruncateForbidden'; end $$;
DO $$ declare t text; begin
 foreach t in array array['dashboard_reference_tables','dashboard_reference_versions','dashboard_reference_columns','dashboard_reference_rows','dashboard_reference_value_kinds','dashboard_reference_cells','dashboard_reference_requests','dashboard_reference_usage'] loop
 execute format('create trigger reference_no_truncate before truncate on training_load.%I execute function training_load.dashboard_reference_no_truncate()',t);
 end loop;
end $$;
create function training_load.cleanup_dashboard_reference_requests(p_limit integer default 100) returns integer language plpgsql as $$
declare n integer; begin
 if p_limit is null or p_limit<1 or p_limit>1000 then raise exception using errcode='23514',message='invalidRequest'; end if;
 perform set_config('optimove.reference_retention',txid_current()::text,true);
 with expired as (select actor_id,request_id from training_load.dashboard_reference_requests where created_at<now()-interval '14 days' order by created_at,actor_id,request_id for update skip locked limit p_limit)
 delete from training_load.dashboard_reference_requests r using expired e where r.actor_id=e.actor_id and r.request_id=e.request_id;
 get diagnostics n=row_count; return n;
end $$;
create index dashboard_reference_receipt_expiry on training_load.dashboard_reference_requests(created_at,actor_id,request_id);
create table training_load.dashboard_reference_widget_usage(widget_id uuid primary key,first_used_at timestamptz not null default clock_timestamp());
create trigger reference_widget_usage_guard before insert or update or delete on training_load.dashboard_reference_widget_usage for each row execute function training_load.dashboard_reference_guard();
create trigger reference_widget_usage_truncate before truncate on training_load.dashboard_reference_widget_usage execute function training_load.dashboard_reference_no_truncate();

-- Keep the exact v94 bodies as independently named helpers. No existing config
-- changes meaning; v71 and older clients still call the original function OIDs.
DO $$ declare signature text; oldname text; newname text; expected text; begin
 for signature,oldname,newname,expected in values
 ('training_load.dashboard_presentation_valid(jsonb)','dashboard_presentation_valid','dashboard_reference_legacy_valid','9ce11aa017244998674f357eac2d8c89'),
 ('training_load.dashboard_presentation_assert_compatible(jsonb,text,text)','dashboard_presentation_assert_compatible','dashboard_reference_legacy_compatible','439d80f9e60bbf32479afdf58f102f4b'),
 ('training_load.dashboard_chart_shape_remap(jsonb,jsonb)','dashboard_chart_shape_remap','dashboard_reference_legacy_remap','ac6d865af34dcbfa510c66b0f1feb2da') loop
  if (select md5(prosrc) from pg_proc where oid=signature::regprocedure) is distinct from expected then raise exception 'v97 predecessor body changed: %',signature using errcode='23514'; end if;
  execute replace(pg_get_functiondef(signature::regprocedure),'FUNCTION training_load.'||oldname||'(','FUNCTION training_load.'||newname||'(');
 end loop;
end $$;
create function training_load.dashboard_reference_config_valid(v jsonb) returns boolean language plpgsql immutable as $$
declare a jsonb; seen text[]='{}'; k jsonb; begin
 if not training_load.dashboard_simple_object(v,array['schemaVersion','source','mode','clubId','tableId','versionId','teamId','axes'],array['schemaVersion','source','mode','clubId','axes'])
  or v->'schemaVersion' is distinct from '1'::jsonb or jsonb_typeof(v->'source') is distinct from 'string' or jsonb_typeof(v->'mode') is distinct from 'string' or v->>'source' not in ('preset','teamAverage') or v->>'mode' not in ('overlay','radar')
  or jsonb_typeof(v->'clubId') is distinct from 'string' or v->>'clubId' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  or jsonb_typeof(v->'axes') is distinct from 'array' then return false; end if;
 if jsonb_array_length(v->'axes') not between 1 and 20 then return false; end if;
 if v->>'source'='preset' then
  if jsonb_typeof(v->'tableId') is distinct from 'string' or jsonb_typeof(v->'versionId') is distinct from 'string' or not(v?'tableId' and v?'versionId') or v?'teamId' or v->>'tableId' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or v->>'versionId' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then return false; end if;
 else
  if jsonb_typeof(v->'teamId') is distinct from 'string' or v?'tableId' or v?'versionId' or not(v?'teamId') or v->>'teamId' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then return false; end if;
 end if;
 for a in select value from jsonb_array_elements(v->'axes') loop
  if not training_load.dashboard_simple_object(a,array['seriesId','anchorKey','valueKeys','band'],array['seriesId','valueKeys'])
   or jsonb_typeof(a->'seriesId') is distinct from 'string' or a->>'seriesId' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or jsonb_typeof(a->'valueKeys') is distinct from 'array' then return false; end if;
  if lower(a->>'seriesId')=any(seen) then return false; end if; seen=array_append(seen,lower(a->>'seriesId'));
  if jsonb_array_length(a->'valueKeys') not between 1 and 20 then return false; end if;
  for k in select value from jsonb_array_elements(a->'valueKeys') loop
   if jsonb_typeof(k) is distinct from 'string' or (k#>>'{}' !~ '^[a-z][a-z0-9_]{0,39}$' and not (v->>'source'='teamAverage' and k#>>'{}'='teamAverage')) then return false; end if;
  end loop;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(a->'valueKeys')) then return false; end if;
  if v->>'source'='preset' then
   if jsonb_typeof(a->'anchorKey') is distinct from 'string' or not(a?'anchorKey') or a->>'anchorKey' !~ '^[a-z][a-z0-9_]{0,39}$' then return false; end if;
  elsif a?'anchorKey' or a?'band' or a->'valueKeys'<>'["teamAverage"]'::jsonb then return false;
  end if;
  if a?'band' and (not training_load.dashboard_simple_object(a->'band',array['lowerKey','upperKey'],array['lowerKey','upperKey']) or jsonb_typeof(a#>'{band,lowerKey}') is distinct from 'string' or jsonb_typeof(a#>'{band,upperKey}') is distinct from 'string' or a#>>'{band,lowerKey}' !~ '^[a-z][a-z0-9_]{0,39}$' or a#>>'{band,upperKey}' !~ '^[a-z][a-z0-9_]{0,39}$') then return false; end if;
 end loop;
 return true;
end $$;
create or replace function training_load.dashboard_presentation_valid(p_config jsonb) returns boolean language plpgsql immutable parallel safe as $$
begin
 if p_config->'schemaVersion'='1'::jsonb and p_config?'referenceConfig' then
  return training_load.dashboard_reference_config_valid(p_config->'referenceConfig') and not(p_config?'tableFormatting') and training_load.dashboard_reference_legacy_valid(p_config-'referenceConfig');
 end if;
 return training_load.dashboard_reference_legacy_valid(p_config);
end $$;
create or replace function training_load.dashboard_presentation_assert_compatible(p_config jsonb,p_widget_type text,p_group_by text) returns void language plpgsql as $$
begin
 if not training_load.dashboard_presentation_valid(p_config) then raise exception 'invalidPresentation' using errcode='S2C02'; end if;
 perform training_load.dashboard_reference_legacy_compatible(p_config-'referenceConfig',p_widget_type,p_group_by);
 if p_config->'schemaVersion'='1'::jsonb and p_config?'referenceConfig' and (p_widget_type not in ('line_chart','bar_chart') or p_group_by not in ('athlete','cohort')) then raise exception 'referenceGroupingRequired' using errcode='S2C02'; end if;
end $$;
create or replace function training_load.dashboard_chart_shape_remap(p_config jsonb,p_map jsonb) returns jsonb language plpgsql immutable as $$
declare c jsonb; axes jsonb='[]';a jsonb; target text; begin
 c=training_load.dashboard_reference_legacy_remap(p_config,p_map);
 if c->'schemaVersion'='1'::jsonb and c?'referenceConfig' then
  for a in select value from jsonb_array_elements(c#>'{referenceConfig,axes}') loop
   target=p_map->>lower(a->>'seriesId'); if target is null then raise exception 'referenceSeriesRequired' using errcode='S2C02'; end if;
   axes=axes||jsonb_build_array(jsonb_set(a,'{seriesId}',to_jsonb(target)));
  end loop;
  c=jsonb_set(c,'{referenceConfig,axes}',axes);
 end if;
 return c;
end $$;

create function training_load.dashboard_reference_assert_widget(p_widget uuid) returns void language plpgsql as $$
declare w training_load.dashboard_widgets; c jsonb; a jsonb;s training_load.dashboard_widget_series; col training_load.dashboard_reference_columns; k text;
begin
 select * into w from training_load.dashboard_widgets where id=p_widget;
 if not found or w.presentation_config->'schemaVersion' is distinct from '1'::jsonb or not(w.presentation_config?'referenceConfig') then return; end if;
 c=w.presentation_config->'referenceConfig';
 if w.group_by='cohort' and c->>'source'<>'teamAverage' then raise exception 'referenceGroupSourceRequired' using errcode='S2C02'; end if;
 if not training_load.dashboard_reference_config_valid(c) then raise exception 'invalidReference' using errcode='S2C02'; end if;
 if c->>'source'='preset' then
  if not exists(select 1 from training_load.dashboard_reference_tables t join training_load.dashboard_reference_versions v on v.table_id=t.id where t.id=(c->>'tableId')::uuid and t.club_id=(c->>'clubId')::uuid and v.id=(c->>'versionId')::uuid and v.published) then raise exception 'referenceNotAvailable' using errcode='S2C02'; end if;
 else
  if not exists(select 1 from public.teams t join public.clubs cl on cl.id=t.club_id where t.id=(c->>'teamId')::uuid and t.club_id=(c->>'clubId')::uuid and coalesce(t.is_active,true) and coalesce(cl.is_active,true)) then raise exception 'referenceNotAvailable' using errcode='S2C02'; end if;
 end if;
 for a in select value from jsonb_array_elements(c->'axes') loop
  select * into s from training_load.dashboard_widget_series where id=(a->>'seriesId')::uuid and widget_id=w.id;
  if not found then raise exception 'referenceSeriesRequired' using errcode='S2C02'; end if;
  if s.resolution_status<>'resolved' then continue; end if;
  if s.metric_definition_id is null then raise exception 'referenceVariableRequired' using errcode='S2C02'; end if;
  if c->>'source'='preset' then
   select * into col from training_load.dashboard_reference_columns where version_id=(c->>'versionId')::uuid and definition_id=s.metric_definition_id;
   if not found or col.aggregation<>s.analytical_aggregation or col.data_level<>s.data_scope_level then raise exception 'referenceMetricMismatch' using errcode='S2C02'; end if;
   for k in select value#>>'{}' from jsonb_array_elements(a->'valueKeys') union select a->>'anchorKey' union select a#>>'{band,lowerKey}' where a?'band' union select a#>>'{band,upperKey}' where a?'band' loop
    if not exists(select 1 from training_load.dashboard_reference_value_kinds where version_id=(c->>'versionId')::uuid and key=k) then raise exception 'referenceValueRequired' using errcode='S2C02'; end if;
   end loop;
  end if;
 end loop;
 perform set_config('optimove.reference_writer',txid_current()::text,true);
 insert into training_load.dashboard_reference_widget_usage(widget_id) values(w.id) on conflict do nothing;
end $$;
create function training_load.dashboard_reference_deferred() returns trigger language plpgsql as $$
begin
 if tg_table_name='dashboard_widgets' then perform training_load.dashboard_reference_assert_widget(new.id);
 elsif tg_op='DELETE' then perform training_load.dashboard_reference_assert_widget(old.widget_id);
 else perform training_load.dashboard_reference_assert_widget(new.widget_id); end if;
 return null;
end $$;
create constraint trigger dashboard_reference_widget_check after insert or update on training_load.dashboard_widgets deferrable initially deferred for each row execute function training_load.dashboard_reference_deferred();
create constraint trigger dashboard_reference_series_check after insert or update or delete on training_load.dashboard_widget_series deferrable initially deferred for each row execute function training_load.dashboard_reference_deferred();

create function training_load.save_dashboard_reference_binding(p_actor uuid,p_club uuid,p_team uuid,p_request uuid,p_hash text,p_dashboard uuid,p_widget uuid,p_revision integer,p_group text,p_config jsonb) returns jsonb language plpgsql as $$
declare w training_load.dashboard_widgets; prior training_load.dashboard_reference_requests; presentation jsonb; result jsonb; basis text;
begin
 if p_request is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_revision is null or p_revision<1 or p_group is null or p_group not in ('athlete','cohort') then raise exception 'invalidRequest' using errcode='23514';end if;
 perform pg_advisory_xact_lock(hashtextextended('dashboard-reference:'||p_actor::text||':'||p_request::text,0));
 basis=training_load.metric_variable_change_basis(p_actor,p_club,p_team);
 if basis is null or p_club is null then raise exception 'notFound' using errcode='42501'; end if;
 if p_config is not null and (not training_load.dashboard_reference_config_valid(p_config) or p_config->>'clubId'<>p_club::text) then raise exception 'invalidReference' using errcode='23514'; end if;
 select * into prior from training_load.dashboard_reference_requests where actor_id=p_actor and request_id=p_request;
 if found then
  if prior.club_id<>p_club or prior.dashboard_id is distinct from p_dashboard or prior.widget_id is distinct from p_widget or prior.request_hash<>p_hash then raise exception 'requestIdReused' using errcode='23514'; end if;
  return prior.receipt;
 end if;
 perform 1 from training_load.dashboards where id=p_dashboard for update;
 if not found then raise exception 'notFound' using errcode='42501'; end if;
 perform training_load.assert_dashboard_writable(p_dashboard);
 perform 1 from training_load.dashboard_pages p join training_load.dashboard_widgets wi on wi.page_id=p.id where wi.id=p_widget and wi.dashboard_id=p_dashboard for update of p;
 select * into w from training_load.dashboard_widgets where id=p_widget and dashboard_id=p_dashboard for update;
 if not found then raise exception 'notFound' using errcode='42501'; end if;
 perform 1 from training_load.dashboard_widget_series where widget_id=w.id order by id for update;
 if w.revision<>p_revision then raise exception 'staleRevision' using errcode='23514'; end if;
 if w.presentation_config is not null and w.presentation_config->'schemaVersion' is distinct from '1'::jsonb then raise exception 'referencePresentationUnsupported' using errcode='23514'; end if;
 presentation=coalesce(w.presentation_config,'{"schemaVersion":1}'::jsonb)-'referenceConfig';
 if p_config is not null then presentation=jsonb_set(presentation-'chartShape'-'chartComposition','{referenceConfig}',p_config); end if;
 perform training_load.update_widget_content_with_presentation(w.id,w.revision,null,null,p_group,null,null,null,false,'replace',presentation);
 select jsonb_build_object('widgetId',id,'revision',revision) into result from training_load.dashboard_widgets where id=w.id;
 perform set_config('optimove.reference_writer',txid_current()::text,true);
 insert into training_load.dashboard_reference_requests(actor_id,request_id,table_id,club_id,dashboard_id,widget_id,request_hash,receipt) values(p_actor,p_request,(p_config->>'tableId')::uuid,p_club,p_dashboard,p_widget,p_hash,result);
 return result;
end $$;
