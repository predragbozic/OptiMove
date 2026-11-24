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
 actor_id uuid not null references public.users(id), request_id uuid not null, table_id uuid not null references training_load.dashboard_reference_tables(id),
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
 if current_setting('optimove.reference_writer',true) is distinct from txid_current()::text then
  raise exception using errcode='42501',message='referenceWriterRequired';
 end if;
 if tg_table_name='dashboard_reference_requests' then
  if tg_op<>'INSERT' then raise exception using errcode='23514',message='referenceReceiptImmutable'; end if;
 elsif tg_table_name='dashboard_reference_versions' then
  if tg_op<>'INSERT' and old.published then raise exception using errcode='23514',message='referenceVersionImmutable'; end if;
 elsif tg_table_name in ('dashboard_reference_columns','dashboard_reference_rows','dashboard_reference_value_kinds','dashboard_reference_cells') then
  if tg_op='DELETE' then v=old.version_id; else v=new.version_id; end if;
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

create function training_load.mutate_dashboard_reference(p_actor uuid,p_club uuid,p_request uuid,p_hash text,p_table uuid,p_revision integer,p_action text,p_payload jsonb)
returns jsonb language plpgsql as $$
declare t training_load.dashboard_reference_tables; v uuid; receipt jsonb; prior training_load.dashboard_reference_requests;
 x jsonb; n integer; basis text;
begin
 perform pg_advisory_xact_lock(hashtextextended('dashboard-reference:'||p_actor::text||':'||p_request::text,0));
 basis=training_load.source_metric_actor_basis(p_actor,p_club);
 if basis is null or p_club is null then raise exception using errcode='42501',message='notFound'; end if;
 if p_hash !~ '^[a-f0-9]{64}$' or p_request is null then raise exception using errcode='23514',message='invalidRequest'; end if;
 select * into prior from training_load.dashboard_reference_requests where actor_id=p_actor and request_id=p_request;
 if found then
  if prior.request_hash<>p_hash then raise exception using errcode='23514',message='requestIdReused'; end if;
  if not exists(select 1 from training_load.dashboard_reference_tables where id=prior.table_id and club_id=p_club) then raise exception using errcode='42501',message='notFound'; end if;
  return prior.receipt;
 end if;
 perform set_config('optimove.reference_writer',txid_current()::text,true);
 if p_action='create' then
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
    or jsonb_array_length(p_payload->'columns')>20 or jsonb_array_length(p_payload->'rows')>100 or jsonb_array_length(p_payload->'valueKinds')>20 or jsonb_array_length(p_payload->'cells')>20000 then
    raise exception using errcode='23514',message='invalidRequest';
   end if;
   delete from training_load.dashboard_reference_cells where version_id=v;
   delete from training_load.dashboard_reference_columns where version_id=v;
   delete from training_load.dashboard_reference_rows where version_id=v;
   delete from training_load.dashboard_reference_value_kinds where version_id=v;
   for x in select value from jsonb_array_elements(p_payload->'columns') loop
    if not exists(select 1 from training_load.metric_definitions d where d.id=(x->>'definitionId')::uuid and d.state='active' and (d.owner_scope='system' or (d.owner_scope='club' and d.owner_club_id=p_club))) then
     raise exception using errcode='42501',message='notFound'; end if;
    insert into training_load.dashboard_reference_columns values(v,(x->>'definitionId')::uuid,x->>'unit',x->>'aggregation',x->>'dataLevel',(x->>'order')::integer);
   end loop;
   for x in select value from jsonb_array_elements(p_payload->'rows') loop
    if not exists(select 1 from public.sport_positions p where p.id=(x->>'positionId')::uuid and p.archived_at is null and (p.owner_scope='system' or p.owner_club_id=p_club)) then
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
   update training_load.dashboard_reference_versions set published=true,published_at=now() where id=v;
   update training_load.dashboard_reference_tables set published_version_id=v where id=t.id;
  elsif p_action='archive' then
   update training_load.dashboard_reference_tables set archived=true where id=t.id;
  else raise exception using errcode='23514',message='invalidRequest';
  end if;
  update training_load.dashboard_reference_tables set revision=revision+1,updated_at=now() where id=t.id returning * into t;
 end if;
 receipt=jsonb_build_object('id',t.id,'revision',t.revision,'publishedVersionId',t.published_version_id);
 insert into training_load.dashboard_reference_requests(actor_id,request_id,table_id,request_hash,receipt) values(p_actor,p_request,t.id,p_hash,receipt);
 -- Survives archive and draft deletion: rollback refuses after any real write.
 insert into training_load.dashboard_reference_usage(table_id) values(t.id) on conflict do nothing;
 return receipt;
end $$;
