import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { EXERCISE_COLLECTIONS_FIXTURE_SQL } from "./support/exercise-collections-fixture.mjs";

import {readFile} from 'node:fs/promises';
import {mediaRetentionDatabaseError} from '../src/mediaReferences.js';
import {createMediaAccessService,decorateMediaRows} from '../src/exerciseMedia.js';
import {createR2UploadStore} from '../src/r2UploadStore.js';
import {createMediaStorageService,MediaStorageError} from '../src/mediaStorage.js';
import {createOracleMediaAccessService} from './support/media-access-oracle.mjs';
let accessService;
const coachId = crypto.randomUUID();
const otherCoachId = crypto.randomUUID();
const athleteUserId = crypto.randomUUID();
let database;
let client;
let pool;
let server;
let baseUrl;
let sectionId;
let foreignSectionId;
const exercises = {};

before(async () => {
  database = await createDisposableDatabase({ prefix: "media_be3", label: "primary" });
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  assert.equal((await client.query("select current_database() as name")).rows[0].name, database.name);
  await client.query(`
    create schema plans;
    create schema library;
    create table public.users (id uuid primary key, is_active boolean default true, display_name text, full_name text, email text);
    create table public.user_global_roles (id uuid primary key default gen_random_uuid(), user_id uuid, role text, is_active boolean);
    create table public.athletes (
      id uuid primary key, user_id uuid, athlete_id text, source_external_id text,
      display_name text, full_name text, first_name text, last_name text,
      is_active boolean default true, created_at timestamptz default now()
    );
    create table public.user_athletes (user_id uuid, athlete_id uuid, is_active boolean, relationship_type text);
    create table public.user_team_roles (user_id uuid, team_id uuid, is_active boolean);
    create table public.user_club_roles (user_id uuid, club_id uuid, is_active boolean);
    create table public.athlete_memberships (athlete_id uuid, team_id uuid, club_id uuid, membership_type text, status text);
    create table plans.plans (
      id uuid primary key default gen_random_uuid(), created_by_user_id uuid,
      plan_type text default 'program', week_start date, name text, note text, icon_url text,
      color text, cover_image_url text, visibility text default 'private', is_template boolean default true,
      status text default 'draft', source_type text default 'builder', start_date date, duration_days integer,
      athlete_id uuid, is_edit_draft boolean default false, edit_source_plan_id uuid, builder_batch_id uuid,
      track_training_load_default boolean default false, request_rpe_default boolean default false,
      is_active boolean default true, can_copy boolean default true, can_edit_copy boolean default true,
      can_assign_to_athlete boolean default true, library_scope text default 'my',
      is_free boolean default true, price_cents integer, athlete_can_view_directly boolean default false,
      requires_approval boolean default false, access_model text default 'free_forever', access_duration_days integer,
      subscription_period text, owner_type text, library_category text, available_until date,
      created_at timestamptz default now(), updated_at timestamptz default now()
    );
    create table plans.plan_days (
      id uuid primary key default gen_random_uuid(), plan_id uuid references plans.plans(id),
      block_index integer default 1, block_name text, block_type text, date date, day_order numeric,
      day_note text, block_order numeric
    );
    create table plans.plan_sessions (
      id uuid primary key default gen_random_uuid(), plan_day_id uuid references plans.plan_days(id),
      am_pm text, bta text, session_time time, session_order numeric, name text,
      rpe_enabled boolean default false, training_load_enabled boolean default false,
      logical_session_id uuid default gen_random_uuid()
    );
    create table plans.plan_nodes (
      id uuid primary key default gen_random_uuid(), plan_session_id uuid references plans.plan_sessions(id),
      parent_id uuid, node_type text default 'section', name text default 'Exercises', color text,
      icon_url text, short_note text, note text, node_order numeric default 1
    );
    create table library.exercises (
      id uuid primary key default gen_random_uuid(), name text, owner_scope text, owner_user_id uuid,
      is_active boolean default true, aim text, execution_notes text, instruction text, image_url text, video_url text,
      exercise_code text,slug text,created_by_user_id uuid,updated_at timestamptz default now()
    );
    create table plans.plan_items (
      id uuid primary key default gen_random_uuid(), plan_session_id uuid references plans.plan_sessions(id),
      plan_node_id uuid references plans.plan_nodes(id), item_type text, exercise_id uuid references library.exercises(id),
      title text, description text, short_note text, note text, source_row_ref text,
      image_url text, video_url text, sets text, reps text, load text, updated_at timestamptz default now(),
      item_order numeric, exercise_order numeric,
      ${["domain", "category", "section"].flatMap((level) => [
        `${level}_name text`, `${level}_color text`, `${level}_icon_url text`,
        `${level}_short_note text`, `${level}_note text`, `${level}_order numeric`,
      ]).join(", ")}
    );
  `);
  await client.query(`
    create table public.athlete_library_access (
      athlete_id uuid,
      ${["can_view_coach_library","can_view_team_library","can_view_club_library","can_view_optimove_library",
        "can_view_marketplace","can_view_coach_profiles","can_view_club_coach_profiles","can_view_public_coach_profiles",
        "can_contact_visible_coaches","can_view_assigned_exercises","can_view_coach_exercise_library",
        "can_view_team_exercise_library","can_view_club_exercise_library","can_view_optimove_exercise_library",
        "can_view_exercise_groups","free_only","require_approval","selected_programs_only"].map((field) => field + " boolean").join(",")}
    );
    create table library.program_access (
      id uuid primary key default gen_random_uuid(), plan_id uuid references plans.plans(id) on delete cascade, related_plan_id uuid references plans.plans(id) on delete set null, user_id uuid, access_type varchar,
      status varchar, expires_at timestamptz, starts_at timestamptz, source text, license_snapshot jsonb,
      accessed_at timestamptz, used_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
      unique(plan_id,user_id,access_type)
    );
    create table library.program_usage_events (program_access_id uuid references library.program_access(id) on delete cascade,user_id uuid,event_type varchar,note text);
    create table public.builder_assignment_requests (id uuid primary key,user_id uuid,source_plan_id uuid,payload_key text,
      status text default 'pending',result jsonb,updated_at timestamptz default now());
    create table public.app_notifications (
      id uuid primary key default gen_random_uuid(), recipient_user_id uuid,actor_user_id uuid,type text,title text,body text,
      entity_type text,entity_id uuid,metadata jsonb,dedupe_key text,href text,read_at timestamptz,created_at timestamptz default now()
    );
    create unique index notification_dedupe on public.app_notifications(dedupe_key) where dedupe_key is not null;
    create view plans.v_plan_summary as select p.*,p.id as plan_id from plans.plans p;
    create view plans.v_program_plan_items as
      select p.id as plan_id, day.block_index, day.id as plan_block_id, day.block_name,
        session.id as plan_session_id, session.session_order, item.id as plan_item_id,
        item.title,item.description,item.sets,item.reps,item.load,item.item_order,item.exercise_id
      from plans.plans p join plans.plan_days day on day.plan_id=p.id
      join plans.plan_sessions session on session.plan_day_id=day.id
      join plans.plan_items item on item.plan_session_id=session.id;
  `);
  await client.query("insert into public.users (id) values ($1),($2),($3)", [coachId, otherCoachId, athleteUserId]);
  await client.query(`  create table library.places (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create unique index fixture_places_global_name_unique on library.places (lower(name));
  create table library.complexity_levels (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar, rank smallint,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.starting_positions (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.attractors (
    id uuid primary key default gen_random_uuid(), kind varchar not null default 'local', name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.domains (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar, description text, color varchar, icon_url text,
    is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid,
    short_note text, note text
  );
  create table library.categories (
    id uuid primary key default gen_random_uuid(), domain_id uuid references library.domains(id), name varchar not null, slug varchar, description text, color varchar, icon_url text,
    is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid,
    short_note text, note text
  );
  create table library.sections (
    id uuid primary key default gen_random_uuid(), category_id uuid references library.categories(id), name varchar not null, slug varchar, description text, color varchar, icon_url text,
    is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid,
    short_note text, note text
  );
  create table library.body_parts (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.movement_patterns (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.tags (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );

  create table library.exercise_domains (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    domain_id uuid not null references library.domains(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_categories (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    category_id uuid not null references library.categories(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_sections (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    section_id uuid not null references library.sections(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_body_parts (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    body_part_id uuid not null references library.body_parts(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_movement_patterns (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    movement_pattern_id uuid not null references library.movement_patterns(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_tags (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    tag_id uuid not null references library.tags(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_favorites (
    user_id uuid not null references public.users(id), exercise_id uuid not null references library.exercises(id) on delete cascade,
    created_at timestamptz not null default now(), primary key (user_id, exercise_id)
  );
  create table library.filter_hidden (
    id uuid primary key default gen_random_uuid(), kind varchar not null, item_id uuid not null, user_id uuid not null references public.users(id),
    created_at timestamptz not null default now(), unique(kind,item_id,user_id)
  );
`);
  await client.query("alter table library.exercises add column owner_club_id uuid,add column place_id uuid,add column complexity_level_id uuid,add column starting_position_id uuid,add column attractor_id uuid");
  await client.query(EXERCISE_COLLECTIONS_FIXTURE_SQL);
  await client.query("create table public.clubs(id uuid primary key)");
  for(const name of ['202610191100_media_storage_foundation.sql','202610191300_media_upload_lifecycle.sql','202610291100_media_drive_copies.sql',...(process.env.MEDIA_L1_TEST==='true'?['202610291000_media_reference_protection.sql','202610291200_media_drive_reference_bridge.sql']:[])])await client.query(await readFile(new URL('../../migrations_v2/'+name,import.meta.url),'utf8'));
  process.env.MEDIA_STORAGE_ENABLED='true';
  await client.query("insert into public.user_global_roles (user_id,role,is_active) values ($1,'platform_admin',true)", [otherCoachId]);
  for (const [key, ownerScope, ownerId, active] of [
    ["own", "user", coachId, true],
    ["foreign", "user", otherCoachId, true],
    ["system", "system", null, true],
    ["inactive", "user", coachId, false],
    ["inactiveSystem", "system", null, false],
  ]) {
    const result = await client.query(
      `insert into library.exercises (name, owner_scope, owner_user_id, is_active, instruction, image_url)
       values ($1,$2,$3,$4,'Original instruction','https://example.com/exercise.png') returning id`,
      [key, ownerScope, ownerId, active],
    );
    exercises[key] = result.rows[0].id;
  }
  sectionId = await makeSection(coachId);
  foreignSectionId = await makeSection(otherCoachId);
  process.env.DATABASE_URL = database.url;
  ({ pool } = await import("../src/db.js"));
  const { default: builderRouter } = await import("../src/routes/builder.js");
  const { default: collectionsRouter } = await import("../src/routes/exerciseCollections.js");
  const { default: exercisesRouter } = await import("../src/routes/exercises.js");
  const { default: templatesRouter } = await import("../src/routes/templates.js");
  const { default: plansRouter } = await import("../src/routes/plans.js");
  const { default: organizationRouter } = await import("../src/routes/organization.js");
  const app = express();
  app.use(express.json());
  app.use("/api/builder", (req, res, next) => {
    req.user = { id: coachId };
    req.authz = { platformRoles: [],capabilities:{coachWorkspace:true} };
    next();
  }, builderRouter);
  app.use("/api/exercise-collections", (req, res, next) => {
    req.user = { id: req.headers["x-test-coach"]==='true'?coachId:otherCoachId };
    req.authz = { platformRoles: ["platform_admin"] };
    next();
  }, collectionsRouter);
  app.use(["/api/templates", "/api/plans", "/api/organization"], (req, res, next) => {
    const athlete = req.headers["x-test-athlete"] === "true";
    req.user = { id: athlete ? athleteUserId : coachId };
    req.authz = { platformRoles: [], clubRoles: [], teamRoles: [], managedTeamIds: [], isAthlete: athlete, capabilities: { coachWorkspace: !athlete } };
    next();
  });
  app.use("/api/templates", templatesRouter);
  app.use("/api/exercises", (req, res, next) => { req.user = { id: coachId }; req.authz = { platformRoles: [],capabilities:{coachWorkspace:true} }; next(); }, exercisesRouter);
  app.use("/api/plans", plansRouter);
  app.use("/api/organization", organizationRouter);
  accessService=createMediaAccessService({pool,store:{signGet:async a=>({url:'https://private.test/'+a.id,expiresAt:new Date(Date.now()+600000).toISOString()})}});
  const {createMediaStorageRouter}=await import('../src/routes/mediaStorage.js');
  app.use('/api/media',(req,_res,next)=>{const athlete=req.headers['x-test-athlete']==='true';req.user={id:athlete?athleteUserId:coachId};req.authz={platformRoles:[],isAthlete:athlete,capabilities:{coachWorkspace:!athlete}};next();},createMediaStorageRouter({service:createMediaStorageService(pool),access:accessService}));
  app.use((error, req, res, next) => {error=mediaRetentionDatabaseError(error)||error;res.status(error.status || 500).json({ error: error.message,code:error.code });});
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } finally {
    try { await pool?.end(); }
    finally {
      try { await client?.end(); }
      finally { await database?.drop(); }
    }
  }
});

beforeEach(async () => {process.env.MEDIA_STORAGE_ENABLED='true';await client.query('delete from plans.plan_items');});

async function makeSection(ownerId,planId=crypto.randomUUID()) {
  const plan = await client.query("insert into plans.plans (id,created_by_user_id, name) values ($2,$1,'Access test') returning id", [ownerId,planId]);
  const day = await client.query("insert into plans.plan_days (plan_id) values ($1) returning id", [plan.rows[0].id]);
  const session = await client.query("insert into plans.plan_sessions (plan_day_id) values ($1) returning id", [day.rows[0].id]);
  return (await client.query("insert into plans.plan_nodes (plan_session_id) values ($1) returning id", [session.rows[0].id])).rows[0].id;
}

async function addExercise(exerciseId, extra = {}, targetSectionId = sectionId) {
  const response = await fetch(`${baseUrl}/api/builder/nodes/${targetSectionId}/exercises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exerciseId, sets: "3", reps: "8", load: "20 kg", ...extra }),
  });
  return { status: response.status, body: await response.json() };
}

async function itemCount() {
  return (await client.query("select count(*)::integer as count from plans.plan_items")).rows[0].count;
}

async function request(path,body,{method='POST',athlete=false}={}) {
 const r=await fetch(baseUrl+path,{method,headers:{'Content-Type':'application/json','X-Test-Coach':'true',...(athlete?{'X-Test-Athlete':'true'}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};
}
const selected=id=>({source:'asset',mediaId:id});
async function exercise(name='Media exercise',scope='user',owner=coachId) {
 return (await client.query("insert into library.exercises(name,owner_scope,owner_user_id,video_url,image_url) values($1,$2,$3,'https://legacy.test/old.mp4','https://legacy.test/old.png') returning id",[name,scope,owner])).rows[0].id;
}
async function ready(context={type:'exercise_create'},kind='video',owner=coachId,status='ready') {
 const account=await createMediaStorageService(pool).ensureAccount({type:'user',id:owner}),id=crypto.randomUUID(),uploadId=crypto.randomUUID(),key='private/'+id;
 await client.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,$3,$4,$5,$6,1,$7)",[id,key,kind,account,owner,status,kind==='video'?'video/mp4':'image/png']);
 await client.query("insert into media.uploads(id,asset_id,storage_account_id,uploaded_by_user_id,idempotency_key,request_fingerprint,context,purpose,temporary_object_key,expected_size_bytes,expected_mime_type,reserved_bytes,status,expires_at) values($1,$2,$3,$4,$5,'fixture',$6,$7,$8,1,$9,1,$10,now()+interval '10 minutes')",[uploadId,id,account,owner,crypto.randomUUID(),context,kind==='video'?'exercise_video':'exercise_image',key,kind==='video'?'video/mp4':'image/png',status==='ready'?'completed':'reserved']);return {id,uploadId};
}
const patch=(id,media)=>request('/api/exercises/'+id,{name:'Updated',media},{method:'PATCH'});
const access=(context,slots=['video'],athlete=false)=>request('/api/media/access',{context,slots},{athlete});
async function oneItem(id){return (await client.query('select * from plans.plan_items where exercise_id=$1 order by id limit 1',[id])).rows[0];}

test('attach/replace/remove preserve independent snapshots and retained legacy URLs',async()=>{
 const id=await exercise(),a=await ready({type:'exercise_edit',exerciseId:id});const saved=await patch(id,{video:selected(a.id)});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.media.video.mediaId,a.id);assert.equal(saved.body.videoUrl,'');
 assert.equal((await addExercise(id)).status,201);const item=await oneItem(id);assert.equal(item.video_asset_id,a.id);
 const b=await ready({type:'exercise_edit',exerciseId:id});assert.equal((await patch(id,{video:selected(b.id)})).status,200);assert.equal((await oneItem(id)).video_asset_id,a.id);assert.equal((await access({type:'plan_item',id:item.id})).body.video.mediaId,a.id);
 assert.equal((await patch(id,{video:{source:'none'}})).body.media.video.source,'none');const row=(await client.query('select * from library.exercises where id=$1',[id])).rows[0];assert.equal(row.video_url,'https://legacy.test/old.mp4');assert.equal(row.video_asset_id,null);assert.equal((await oneItem(id)).video_asset_id,a.id);
});
test('foreign/wrong-context/unverified/wrong-kind media and conflicting payloads cannot bind',async()=>{
 const id=await exercise(),other=await exercise();for(const [owner,ctx,kind,state,status] of [[otherCoachId,id,'video','ready',404],[coachId,other,'video','ready',404],[coachId,id,'video','pending',409],[coachId,id,'image','ready',415]]){const a=await ready({type:'exercise_edit',exerciseId:ctx},kind,owner,state);assert.equal((await patch(id,{video:selected(a.id)})).status,status);}
 assert.equal((await request('/api/exercises/'+id,{name:'Temporary URL',videoUrl:'https://private.test/a?X-Amz-Signature=temporary'},{method:'PATCH'})).status,400);
 assert.equal((await request('/api/exercises/'+id,{name:'Conflict',videoUrl:'https://other.test',media:{video:{source:'none'}}},{method:'PATCH'})).status,400);
});
test('new/copy bindings fix the first target and require copies to use their own uploads',async()=>{
 const a=await ready(),created=await request('/api/exercises',{name:'New media',media:{video:selected(a.id)}});assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.id;assert.equal((await patch(id,{video:selected(a.id)})).status,200);
 assert.equal((await request('/api/exercises',{name:'Second target',media:{video:selected(a.id)}})).status,404);assert.equal((await request('/api/exercises/'+id+'/copy',{name:'Illegal copy',media:{video:selected(a.id)}})).status,404);
 const own=await ready(),copy=await request('/api/exercises/'+id+'/copy',{name:'Own copy',media:{video:selected(own.id)}});assert.equal(copy.status,201,JSON.stringify(copy.body));assert.equal(copy.body.copyParentId,id);assert.equal(copy.body.media.video.mediaId,own.id);
});
test('parallel first bindings have exactly one winner',async()=>{const a=await ready(),r=await Promise.all(['Race A','Race B'].map(name=>request('/api/exercises',{name,media:{video:selected(a.id)}})));assert.deepEqual(r.map(x=>x.status).sort(),[201,404]);assert.equal((await client.query('select count(*) from library.exercises where video_asset_id=$1',[a.id])).rows[0].count,'1');});
test('Builder custom saves library/item references atomically and rolls back denied attachments',async()=>{
 const a=await ready(),r=await request('/api/builder/nodes/'+sectionId+'/custom-exercise',{name:'Custom upload',media:{video:selected(a.id)}});assert.equal(r.status,201,JSON.stringify(r.body));const item=(await client.query('select * from plans.plan_items where video_asset_id=$1',[a.id])).rows[0];assert.ok(item);assert.equal((await client.query('select video_asset_id from library.exercises where id=$1',[item.exercise_id])).rows[0].video_asset_id,a.id);
 const bad=await ready({type:'exercise_create'},'video',otherCoachId);assert.equal((await request('/api/builder/nodes/'+sectionId+'/custom-exercise',{name:'Must rollback',media:{video:selected(bad.id)}})).status,404);assert.equal((await client.query("select count(*) from library.exercises where name='Must rollback'")).rows[0].count,'0');
});
test('revoke denies Library/new reuse while an assigned plan snapshot retains playback',async()=>{
 const id=await exercise('Granted system','system',null),a=await ready({type:'exercise_edit',exerciseId:id},'video',otherCoachId);await client.query("update library.exercises set video_source='asset',video_asset_id=$2 where id=$1",[id,a.id]);const block=(await client.query("insert into library.exercise_collections(name) values('Restricted') returning id")).rows[0].id;
 await client.query('insert into library.exercise_collection_items values($1,$2)',[block,id]);await client.query('insert into library.exercise_collection_users values($1,$2)',[block,coachId]);assert.equal((await addExercise(id)).status,201);const item=await oneItem(id),plan=(await client.query('select d.plan_id from plans.plan_days d join plans.plan_sessions s on s.plan_day_id=d.id where s.id=$1',[item.plan_session_id])).rows[0].plan_id,athlete=crypto.randomUUID();
 await client.query('insert into public.athletes(id,user_id,is_active) values($1,$2,true)',[athlete,athleteUserId]);await client.query("update plans.plans set athlete_id=$2,is_template=false,status='active' where id=$1",[plan,athlete]);assert.equal((await access({type:'exercise',id})).status,200);await client.query('delete from library.exercise_collection_users where collection_id=$1',[block]);
 assert.equal((await access({type:'exercise',id})).status,404);assert.equal((await addExercise(id)).status,404);assert.equal((await access({type:'plan_item',id:item.id},['video'],true)).body.video.mediaId,a.id);await client.query('update public.athletes set user_id=null where id=$1',[athlete]);assert.equal((await access({type:'plan_item',id:item.id},['video'],true)).status,404);
});
test('playback denies foreign/pending/inactive/deleting media and feature-off requests',async()=>{
 const foreign=await exercise('Foreign','user',otherCoachId),id=await exercise(),a=await ready({type:'exercise_edit',exerciseId:id});await patch(id,{video:selected(a.id)});assert.equal((await access({type:'exercise',id:foreign})).status,404);assert.equal((await access({type:'exercise',id})).status,200);
 if(process.env.MEDIA_L1_TEST==='true'){await assert.rejects(client.query("update media.assets set status='deleting' where id=$1",[a.id]),e=>e.code==='P7502');assert.equal((await access({type:'exercise',id})).status,200);}else{await client.query("update media.assets set status='deleting' where id=$1",[a.id]);assert.equal((await access({type:'exercise',id})).status,404);}const pending=await ready({type:'exercise_create'},'video',coachId,'pending');assert.equal((await access({type:'upload',id:pending.uploadId})).status,404);await client.query('update library.exercises set is_active=false where id=$1',[id]);assert.equal((await access({type:'exercise',id})).status,404);
 process.env.MEDIA_STORAGE_ENABLED='false';assert.equal((await access({type:'upload',id:a.uploadId})).status,503);assert.equal((await patch(id,{video:{source:'none'}})).status,503);
});
test('ready upload preview is uploader-only and rechecks its bound exercise',async()=>{const a=await ready();assert.equal((await access({type:'upload',id:a.uploadId})).body.video.mediaId,a.id);const foreign=await ready({type:'exercise_create'},'video',otherCoachId);assert.equal((await access({type:'upload',id:foreign.uploadId})).status,404);const saved=await request('/api/exercises',{name:'Preview target',media:{video:selected(a.id)}});assert.equal(saved.status,201);await client.query('update library.exercises set is_active=false where id=$1',[saved.body.id]);assert.equal((await access({type:'upload',id:a.uploadId})).status,404);});
test('batch has indexed results and a 50-context bound; coverSlides use private descriptors',async()=>{
 const id=await exercise('Cover media'),a=await ready({type:'exercise_edit',exerciseId:id},'image');await patch(id,{image:selected(a.id)});const batch=await request('/api/media/access/batch',{requests:[{context:{type:'exercise',id},slots:['image']},{context:{type:'exercise',id:crypto.randomUUID()},slots:['image']}]});assert.equal(batch.status,200);assert.equal(batch.body.results[0].media.image.mediaId,a.id);assert.equal(batch.body.results[1].error.code,'resource_not_found');assert.equal((await request('/api/media/access/batch',{requests:Array(51).fill({})})).status,400);
 const cover=await request('/api/exercise-collections/catalog',undefined,{method:'GET'});assert.equal(cover.status,200,JSON.stringify(cover.body));const slide=cover.body.other.coverSlides.find(s=>s.media?.image.mediaId===a.id);assert.ok(slide);assert.deepEqual(slide.media.accessContext,{type:'exercise',id});assert.equal(slide.imageUrl,'');assert.equal(JSON.stringify(cover.body).includes('X-Amz-'),false);
});
test('node copy retains snapshot media IDs after the exercise changes',async()=>{const node=await makeSection(coachId),id=await exercise(),a=await ready({type:'exercise_edit',exerciseId:id});await patch(id,{video:selected(a.id)});assert.equal((await addExercise(id,{},node)).status,201);await patch(id,{video:{source:'none'}});const session=(await client.query('select plan_session_id from plans.plan_nodes where id=$1',[node])).rows[0].plan_session_id,copied=await request('/api/builder/nodes/'+node+'/copy',{targetSessionId:session});assert.equal(copied.status,201,JSON.stringify(copied.body));const rows=(await client.query('select video_asset_id,video_source from plans.plan_items where exercise_id=$1',[id])).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.video_source==='asset' && r.video_asset_id===a.id));});
test('GET signer uses ten minutes and leaves Range unsigned for HTML5 seek',async()=>{const store=createR2UploadStore({R2_ACCOUNT_ID:'a'.repeat(32),R2_ACCESS_KEY_ID:'test',R2_SECRET_ACCESS_KEY:'not-real',R2_BUCKET:'optimove-exercise-videos'}),signed=await store.signGet({object_key:'private/video',mime_type:'video/mp4'}),url=new URL(signed.url);assert.equal(url.searchParams.get('X-Amz-Expires'),'600');assert.equal(url.searchParams.get('X-Amz-SignedHeaders'),'host');assert.equal(url.searchParams.get('response-cache-control'),'private, no-store');assert.ok(!signed.url.includes('not-real'));});

test('session copy preserves snapshot IDs in both tree and legacy item paths',async()=>{
 for(const legacy of [false,true]) {
  const node=await makeSection(coachId),target=await makeSection(coachId),id=await exercise(),a=await ready({type:'exercise_edit',exerciseId:id});await patch(id,{video:selected(a.id)});assert.equal((await addExercise(id,{},node)).status,201);
  const source=(await client.query('select plan_session_id from plans.plan_nodes where id=$1',[node])).rows[0].plan_session_id,targetDay=(await client.query('select s.plan_day_id from plans.plan_nodes n join plans.plan_sessions s on s.id=n.plan_session_id where n.id=$1',[target])).rows[0].plan_day_id;
  if(legacy){await client.query('update plans.plan_items set plan_node_id=null where plan_session_id=$1',[source]);await client.query('delete from plans.plan_nodes where plan_session_id=$1',[source]);}
  await patch(id,{video:{source:'none'}});const dest=(await client.query('select id from plans.plan_sessions where plan_day_id=$1',[targetDay])).rows[0].id;const {copySessionContent}=await import('../src/routes/builder.js');await client.query('begin');try{await copySessionContent(client,source,dest);await client.query('commit');}catch(e){await client.query('rollback');throw e;}const rows=(await client.query('select * from plans.plan_items where exercise_id=$1',[id])).rows;assert.equal(rows.length,2);assert.ok(rows.every(v=>v.video_asset_id===a.id && v.video_source==='asset'));
 }
});

test('batched session copy and saved program descriptors preserve media references',async()=>{
 const node=await makeSection(coachId),target=await makeSection(coachId),id=await exercise(),a=await ready({type:'exercise_edit',exerciseId:id});await patch(id,{video:selected(a.id)});await addExercise(id,{},node);
 const source=(await client.query('select plan_session_id from plans.plan_nodes where id=$1',[node])).rows[0].plan_session_id,dest=(await client.query('select plan_session_id from plans.plan_nodes where id=$1',[target])).rows[0].plan_session_id;
 const {copyBuilderSessionContents}=await import('../src/builderTreeBatch.js');await client.query('begin');try{await copyBuilderSessionContents(client,new Map([[source,dest]]),()=>{throw new Error('Unexpected legacy path');});await client.query('commit');}catch(e){await client.query('rollback');throw e;}
 const rows=(await client.query('select * from plans.plan_items where exercise_id=$1',[id])).rows;assert.equal(rows.length,2);assert.ok(rows.every(v=>v.video_asset_id===a.id));const plan=(await client.query('select plan_id from plans.plan_days where id=(select plan_day_id from plans.plan_sessions where id=$1)',[dest])).rows[0].plan_id;
 const r=await request('/api/plans/'+plan+'/program',undefined,{method:'GET'});assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(JSON.stringify(r.body).includes(a.id));assert.ok(JSON.stringify(r.body).includes('plan_item'));
});

test('flag-off legacy custom flow remains functional and never revives a retained private URL',async()=>{
 const id=await exercise(),a=await ready({type:'exercise_edit',exerciseId:id});await patch(id,{video:selected(a.id)});process.env.MEDIA_STORAGE_ENABLED='false';
 const detail=await request('/api/exercises/'+id,undefined,{method:'GET'});assert.equal(detail.status,200);assert.equal(detail.body.media.video.source,'asset');assert.equal(detail.body.videoUrl,'');
 const legacy=await request('/api/builder/nodes/'+sectionId+'/custom-exercise',{name:'Legacy remains',videoUrl:'https://youtu.be/abcdefghijk'});assert.equal(legacy.status,201,JSON.stringify(legacy.body));const row=(await client.query("select * from library.exercises where name='Legacy remains'")).rows[0];assert.equal(row.video_source,'legacy');assert.equal(row.video_url,'https://youtu.be/abcdefghijk');
});

test('system/club binding follows existing administrator rights and the actual storage owner',async()=>{
 const {bindExerciseMedia}=await import('../src/exerciseMedia.js'),actor={user:{id:otherCoachId},authz:{platformRoles:['platform_admin'],capabilities:{coachWorkspace:true}}};
 for(const scope of ['system','club']) {
  const id=await exercise('Administrator media',scope,null),a=await ready({type:'exercise_edit',exerciseId:id},'video',otherCoachId);
  if(scope==='club') {
   const club=crypto.randomUUID();await client.query('insert into public.clubs(id) values($1)',[club]);await client.query('update library.exercises set owner_club_id=$2 where id=$1',[id,club]);
   await client.query('begin');try{await assert.rejects(bindExerciseMedia(client,actor,id,{media:{video:selected(a.id)}}),e=>e.code==='resource_not_found');}finally{await client.query('rollback');}
   const account=await createMediaStorageService(pool).ensureAccount({type:'club',id:club});await client.query('update media.assets set storage_account_id=$2 where id=$1',[a.id,account]);await client.query('update media.uploads set storage_account_id=$2 where asset_id=$1',[a.id,account]);
  }
  await client.query('begin');try{await bindExerciseMedia(client,actor,id,{media:{video:selected(a.id)}});await client.query('commit');}catch(e){await client.query('rollback');throw e;}
  assert.equal((await client.query('select video_asset_id from library.exercises where id=$1',[id])).rows[0].video_asset_id,a.id);
 }
});

async function h1AssetExercise() {
 const id=await exercise('H1 exercise'),video=await ready({type:'exercise_edit',exerciseId:id}),image=await ready({type:'exercise_edit',exerciseId:id},'image');
 assert.equal((await patch(id,{video:selected(video.id),image:selected(image.id)})).status,200);
 return {id,video,image};
}
async function h1MediaRow(id) {return (await client.query('select video_source,video_asset_id,video_url,image_source,image_asset_id,image_url from library.exercises where id=$1',[id])).rows[0];}

test('H1: metadata-only and unchanged retained URL echoes preserve both asset selections',async()=>{
 const {id}=await h1AssetExercise(),before=await h1MediaRow(id);
 for(const fields of [{},{videoUrl:before.video_url,imageUrl:before.image_url},{videoUrl:' '+before.video_url+' ',imageUrl:' '+before.image_url+' '}]) {
  const r=await request('/api/exercises/'+id,{name:'Renamed',instruction:'Changed description',...fields},{method:'PATCH'});assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(await h1MediaRow(id),before);assert.equal(r.body.media.video.mediaId,before.video_asset_id);assert.equal(r.body.media.image.mediaId,before.image_asset_id);
 }
});

test('H1: empty/null/whitespace implicit URL fields never remove an asset or erase retained links',async()=>{
 const {id}=await h1AssetExercise(),before=await h1MediaRow(id);
 for(const empty of ['',null,'   ']){const r=await request('/api/exercises/'+id,{name:'Ordinary save',videoUrl:empty,imageUrl:empty},{method:'PATCH'});assert.equal(r.status,200);assert.deepEqual(await h1MediaRow(id),before);}
});

test('H1: explicit asset/none/legacy choices remain authoritative and omitted slots stay unchanged',async()=>{
 const {id,video,image}=await h1AssetExercise(),replacement=await ready({type:'exercise_edit',exerciseId:id});
 assert.equal((await patch(id,{video:selected(replacement.id)})).status,200);assert.equal((await h1MediaRow(id)).video_asset_id,replacement.id);assert.equal((await h1MediaRow(id)).image_asset_id,image.id);
 assert.equal((await patch(id,{video:{source:'none'},image:{source:'none'}})).status,200);const none=await h1MediaRow(id);assert.equal(none.video_source,'none');assert.equal(none.image_source,'none');
 assert.equal((await request('/api/exercises/'+id,{name:'Keep removed',videoUrl:none.video_url,imageUrl:''},{method:'PATCH'})).status,200);assert.deepEqual(await h1MediaRow(id),none);
 assert.equal((await patch(id,{video:selected(video.id),image:selected(image.id)})).status,200);
 const before=await h1MediaRow(id);assert.equal((await patch(id,{video:{source:'legacy',url:before.video_url},image:{source:'legacy',url:before.image_url}})).status,200);const legacy=await h1MediaRow(id);assert.equal(legacy.video_source,'legacy');assert.equal(legacy.image_source,'legacy');assert.equal(legacy.video_asset_id,null);assert.equal(legacy.image_asset_id,null);
});

test('H1: genuinely changed nonempty implicit legacy URLs still switch only their own slot',async()=>{
 for(const slot of ['video','image']){
  const {id}=await h1AssetExercise(),before=await h1MediaRow(id),url='https://changed.test/'+slot,other=slot==='video'?'image':'video';
  const r=await request('/api/exercises/'+id,{name:'New legacy media',[slot+'Url']:url},{method:'PATCH'});assert.equal(r.status,200);const after=await h1MediaRow(id);assert.equal(after[slot+'_source'],'legacy');assert.equal(after[slot+'_asset_id'],null);assert.equal(after[slot+'_url'],url);assert.equal(after[other+'_source'],'asset');assert.equal(after[other+'_asset_id'],before[other+'_asset_id']);
 }
});

test('H1: Builder add/copy and private-copy round trips retain R2 snapshots after ordinary saves',async()=>{
 const {id,video,image}=await h1AssetExercise(),before=await h1MediaRow(id),node=await makeSection(coachId);
 assert.equal((await addExercise(id,{},node)).status,201);assert.equal((await request('/api/exercises/'+id,{name:'Renamed for Builder',videoUrl:before.video_url,imageUrl:''},{method:'PATCH'})).status,200);assert.equal((await addExercise(id,{},node)).status,201);
 const session=(await client.query('select plan_session_id from plans.plan_nodes where id=$1',[node])).rows[0].plan_session_id,r=await request('/api/builder/nodes/'+node+'/copy',{targetSessionId:session});assert.equal(r.status,201);const items=(await client.query('select * from plans.plan_items where exercise_id=$1',[id])).rows;assert.equal(items.length,4);assert.ok(items.every(i=>i.video_asset_id===video.id && i.image_asset_id===image.id));
 const ownVideo=await ready(),ownImage=await ready({type:'exercise_create'},'image'),copy=await request('/api/exercises/'+id+'/copy',{name:'Own private copy',media:{video:selected(ownVideo.id),image:selected(ownImage.id)}});assert.equal(copy.status,201);const copyBefore=await h1MediaRow(copy.body.id);
 assert.equal((await request('/api/exercises/'+copy.body.id,{name:'Edited private copy',instruction:'Notes',videoUrl:'',imageUrl:''},{method:'PATCH'})).status,200);assert.deepEqual(await h1MediaRow(copy.body.id),copyBefore);assert.equal((await addExercise(copy.body.id)).status,201);const item=await oneItem(copy.body.id);assert.equal(item.video_asset_id,ownVideo.id);assert.equal(item.image_asset_id,ownImage.id);assert.deepEqual(await h1MediaRow(id),before);
});

test('H1: Builder custom R2 exercise survives an ordinary Library editor save',async()=>{
 const video=await ready(),image=await ready({type:'exercise_create'},'image'),r=await request('/api/builder/nodes/'+sectionId+'/custom-exercise',{name:'H1 custom',media:{video:selected(video.id),image:selected(image.id)}});assert.equal(r.status,201);
 const item=(await client.query('select * from plans.plan_items where video_asset_id=$1',[video.id])).rows[0],before=await h1MediaRow(item.exercise_id);assert.equal((await request('/api/exercises/'+item.exercise_id,{name:'Custom renamed',videoUrl:'',imageUrl:null},{method:'PATCH'})).status,200);assert.deepEqual(await h1MediaRow(item.exercise_id),before);const snapshot=await oneItem(item.exercise_id);assert.equal(snapshot.video_asset_id,video.id);assert.equal(snapshot.image_asset_id,image.id);
});

test('main #188: Builder add keeps the effective inherited legacy image on a private copy',async()=>{
 const source=await exercise('Inherited cover source','system',null),copy=await request('/api/exercises/'+source+'/copy',{name:'Inherited private image'});assert.equal(copy.status,201,JSON.stringify(copy.body));
 assert.equal((await client.query('select image_url from library.exercises where id=$1',[copy.body.id])).rows[0].image_url,null);
 assert.equal((await addExercise(copy.body.id)).status,201);const item=await oneItem(copy.body.id);assert.equal(item.image_source,'legacy');assert.equal(item.image_url,'https://legacy.test/old.png');assert.equal(item.video_url,'https://legacy.test/old.mp4');
});

test('main #188: image completion preserves asset/none snapshot choices instead of filling legacy URLs',async()=>{
 const id=await exercise('R2 snapshot'),a=await ready({type:'exercise_edit',exerciseId:id},'image');await patch(id,{image:selected(a.id)});await addExercise(id);const item=await oneItem(id);
 const {completeCopiedExerciseImages}=await import('../src/exerciseSnapshotMedia.js');
 for(const selection of [{image_source:'asset',image_asset_id:a.id},{image_source:'none',image_asset_id:null},{image_source:'legacy',image_asset_id:null,video_source:'asset',video_asset_id:crypto.randomUUID()}]){
  const snapshot={...item,...selection,image_url:null};await client.query('begin');try{assert.deepEqual(await completeCopiedExerciseImages(client.query.bind(client),[snapshot],()=>item.plan_session_id),[snapshot]);}finally{await client.query('rollback');}
 }
});

test('main #188: a mixed private copy snapshots inherited legacy image alongside its own R2 video',async()=>{
 const source=await exercise('Mixed media source','system',null),video=await ready(),copy=await request('/api/exercises/'+source+'/copy',{name:'Mixed media private copy',media:{video:selected(video.id)}});assert.equal(copy.status,201);
 assert.equal((await addExercise(copy.body.id)).status,201);const item=await oneItem(copy.body.id);assert.equal(item.video_source,'asset');assert.equal(item.video_asset_id,video.id);assert.equal(item.image_source,'legacy');assert.equal(item.image_url,'https://legacy.test/old.png');
});

if(process.env.MEDIA_L1_TEST==='true') {
 async function planOf(node){return (await client.query('select d.plan_id from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id where s.id=(select plan_session_id from plans.plan_nodes where id=$1)',[node])).rows[0].plan_id;}
 async function assignedSection(){const node=await makeSection(coachId),plan=await planOf(node),athlete=crypto.randomUUID();await client.query('insert into public.athletes(id,user_id,is_active) values($1,$2,true)',[athlete,athleteUserId]);await client.query("insert into public.user_athletes(user_id,athlete_id,is_active,relationship_type) values($1,$2,true,'coach')",[coachId,athlete]);await client.query("update plans.plans set athlete_id=$2,is_template=false,status='active' where id=$1",[plan,athlete]);return {node,plan,athlete};}
 async function cloneToAthlete(source){const target=await assignedSection();const {copyProgramTree}=await import('../src/routes/builder.js');await client.query('begin');try{await copyProgramTree(client,source,target.plan);await client.query('commit');}catch(e){await client.query('rollback');throw e;}return target;}
 async function assetItem(plan,asset){return (await client.query('select i.* from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=$1 and i.video_asset_id=$2',[plan,asset])).rows[0];}
 async function evidence(plan){return (await client.query('select count(*) from media.hold_assets m join media.retention_holds h on h.id=m.hold_id where h.source_plan_id=$1',[plan])).rows[0].count;}
 async function waitBlockedQuery(fragment){for(let n=0;n<150;n++){const r=await client.query('select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and position($1 in query)>0 and cardinality(pg_blocking_pids(pid))>0',[fragment]);if(r.rowCount)return;await new Promise(r=>setTimeout(r,10));}throw Error('Blocked route query not observed: '+fragment);}
 // Pause after a real route query has obtained its locks, without changing application code.
 async function pauseQueries(match,count,work){let release,arrived;const gate=new Promise(r=>release=r),ready=new Promise(r=>arrived=r),wrapped=new Map();let hits=0;
 const hook=c=>{if(wrapped.has(c))return;const query=c.query;wrapped.set(c,query);c.query=function(...args){const result=query.apply(this,args);if(typeof args.at(-1)==='function'||hits>=count||!match(String(args[0])))return result;hits++;return Promise.resolve(result).then(async value=>{if(hits===count)arrived();await gate;return value;});};};pool.on('acquire',hook);
 try{await work({ready,release,wait:async()=>{await Promise.race([ready,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Route pause was not reached')),3000);t.unref();})]);}});}finally{release();pool.off('acquire',hook);for(const [c,q] of wrapped)c.query=q;}
 }
 test('L1 HTTP: deleting assigned program removes its rows/access but preserves another athlete and detached evidence',async()=>{
 const {id,video}=await h1AssetExercise(),target=await assignedSection();assert.equal((await addExercise(id,{},target.node)).status,201);const copy=await cloneToAthlete(target.plan),oldItem=await assetItem(target.plan,video.id),otherItem=await assetItem(copy.plan,video.id),before=await evidence(target.plan);
 assert.equal((await access({type:'plan_item',id:otherItem.id},['video'],true)).status,200);const r=await request('/api/builder/plans/'+target.plan,undefined,{method:'DELETE'});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal((await client.query('select count(*) from plans.plans where id=$1',[target.plan])).rows[0].count,'0');assert.equal((await access({type:'plan_item',id:oldItem.id},['video'],true)).status,404);assert.equal((await access({type:'plan_item',id:otherItem.id},['video'],true)).status,200);assert.equal(await evidence(target.plan),before);assert.equal((await client.query("select count(*) from media.retention_events where source_id=$1 and event='source_plan_deleted'",[target.plan])).rows[0].count,'1');
 });
 test('L1 HTTP: template deletion cascades original grants but not independent Builder copies',async()=>{
 const {id,video}=await h1AssetExercise(),node=await makeSection(coachId),source=await planOf(node);await addExercise(id,{},node);const copy=await cloneToAthlete(source),original=await assetItem(source,video.id),retained=await assetItem(copy.plan,video.id);await client.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'downloaded','accessed')",[source,athleteUserId]);const before=await evidence(source);
 const r=await request('/api/builder/plans/'+source,undefined,{method:'DELETE'});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal((await client.query('select count(*) from library.program_access where plan_id=$1',[source])).rows[0].count,'0');assert.equal((await access({type:'plan_item',id:original.id},['video'],true)).status,404);assert.equal((await access({type:'plan_item',id:retained.id},['video'],true)).status,200);assert.equal(await evidence(source),before);assert.ok(Number(before)>0);
 });
 test('L1 HTTP: Revoke removes only its original Access; assigned snapshot remains authorized',async()=>{
 const {id,video}=await h1AssetExercise(),node=await makeSection(coachId),source=await planOf(node);await addExercise(id,{},node);const copy=await cloneToAthlete(source),original=await assetItem(source,video.id),retained=await assetItem(copy.plan,video.id);
 await client.query("update plans.plans set status='active',visibility='public',library_scope='optimove',athlete_can_view_directly=true,requires_approval=true where id=$1",[source]);await client.query('insert into public.athlete_library_access(athlete_id,can_view_optimove_library,require_approval,free_only) values($1,true,true,true)',[copy.athlete]);const grant=(await client.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'coach_assigned','accessed') returning id",[source,athleteUserId])).rows[0].id;
 assert.equal((await access({type:'plan_item',id:original.id},['video'],true)).status,200);const before=await evidence(source),r=await request('/api/organization/program-access/'+grant+'/revoke',{});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal((await client.query('select count(*) from library.program_access where id=$1',[grant])).rows[0].count,'0');assert.equal((await access({type:'plan_item',id:original.id},['video'],true)).status,404);assert.equal((await access({type:'plan_item',id:retained.id},['video'],true)).status,200);assert.equal(await evidence(source),before);
 });
 test('L1 concurrent HTTP: custom exercise holds plan before node while DELETE waits, including feature-off legacy',async()=>{
 for(const withMedia of [false,true]){const target=await assignedSection(),a=withMedia?await ready():null;process.env.MEDIA_STORAGE_ENABLED=String(withMedia);let custom,deleted;
 await pauseQueries(sql=>sql.includes('select id from plans.plan_nodes where id=$1 for update'),1,async gate=>{
 custom=request('/api/builder/nodes/'+target.node+'/custom-exercise',{name:'Concurrent custom',...(a?{media:{video:selected(a.id)}}:{})});try{await gate.wait();deleted=request('/api/builder/plans/'+target.plan,undefined,{method:'DELETE'});await waitBlockedQuery('select id from plans.plans where id = $1 for update');}finally{gate.release();}assert.equal((await custom).status,201);const r=await deleted;assert.equal(r.status,200,JSON.stringify(r.body));});process.env.MEDIA_STORAGE_ENABLED='true';}
 });
 test('L1 concurrent HTTP: opposite shared videos in two assigned plans complete without cross-plan deadlock',async()=>{
 const first=await h1AssetExercise(),second=await h1AssetExercise(),p=await assignedSection(),q=await assignedSection();await addExercise(second.id,{},p.node);await addExercise(first.id,{},q.node);
 await pauseQueries(sql=>sql.includes('insert into plans.plan_items ('),2,async gate=>{const jobs=[addExercise(first.id,{},p.node),addExercise(second.id,{},q.node)];try{await gate.wait();}finally{gate.release();}for(const r of await Promise.all(jobs))assert.equal(r.status,201,JSON.stringify(r.body));});assert.ok(await assetItem(p.plan,first.video.id));assert.ok(await assetItem(q.plan,second.video.id));assert.equal(await evidence(p.plan),'4');assert.equal(await evidence(q.plan),'4');
 });
 test('L1 concurrent HTTP: section copy locks target plan before child FK locks while DELETE waits',async()=>{
 const source=await assignedSection(),target=await assignedSection(),media=await h1AssetExercise();await addExercise(media.id,{},source.node);const session=(await client.query('select plan_session_id from plans.plan_nodes where id=$1',[target.node])).rows[0].plan_session_id;
 await pauseQueries(sql=>sql.includes('insert into plans.plan_nodes'),1,async gate=>{const copying=request('/api/builder/nodes/'+source.node+'/copy',{targetSessionId:session});let deleting;try{await gate.wait();deleting=request('/api/builder/plans/'+target.plan,undefined,{method:'DELETE'});await waitBlockedQuery('select id from plans.plans where id = $1 for update');}finally{gate.release();}const copied=await copying;assert.equal(copied.status,201,JSON.stringify(copied.body));const r=await deleting;assert.equal(r.status,200,JSON.stringify(r.body));});assert.ok(await assetItem(source.plan,media.video.id));assert.equal(await evidence(target.plan),'2');
 });
 test('L1 concurrent HTTP: repeated program copy upsert locks source before grant while DELETE waits',async()=>{
 const node=await makeSection(coachId),source=await planOf(node),media=await h1AssetExercise();await addExercise(media.id,{},node);const first=await request('/api/builder/plans/'+source+'/duplicate',{});assert.equal(first.status,201,JSON.stringify(first.body));
 let second;await pauseQueries(sql=>sql.includes('insert into library.program_access (plan_id, user_id, access_type, status, related_plan_id)'),1,async gate=>{const copying=request('/api/builder/plans/'+source+'/duplicate',{});let deleting;try{await gate.wait();deleting=request('/api/builder/plans/'+source,undefined,{method:'DELETE'});await waitBlockedQuery('select id from plans.plans where id = $1 for update');}finally{gate.release();}second=await copying;assert.equal(second.status,201,JSON.stringify(second.body));const r=await deleting;assert.equal(r.status,200,JSON.stringify(r.body));});
 for(const copy of [first,second]){const row=await assetItem(copy.body.plan.id,media.video.id);assert.ok(row);assert.equal((await access({type:'plan_item',id:row.id})).status,200);}
 });
 test('L1 HTTP: block copy, day paste and session paste preserve R2 snapshots after target plan locking',async()=>{
 for(const mode of ['block','day','session']){const source=await assignedSection(),media=await h1AssetExercise();await addExercise(media.id,{},source.node);const src=(await client.query('select s.id as session,d.id as day from plans.plan_nodes n join plans.plan_sessions s on s.id=n.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where n.id=$1',[source.node])).rows[0];
 // A copy inside the same assigned plan adds no member: membership is one row per hold, asset and slot
 // (owner decision, MEDIUM-2), and the 2 existing members keep the asset protected.
 // The copy itself must keep the R2 snapshot: both items, the original and the copy, carry both assets.
 if(mode==='block'){const r=await request('/api/builder/blocks/'+src.day+'/copy',{});assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(await evidence(source.plan),'2');
  const carrying=(await client.query('select count(*) filter(where i.video_asset_id=$2)::int as video,count(*) filter(where i.image_asset_id=$3)::int as image from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=$1',[source.plan,media.video.id,media.image.id])).rows[0];
  assert.deepEqual(carrying,{video:2,image:2},'the copied block keeps its R2 video and picture');}
 else{const target=await assignedSection();await client.query("update plans.plans set plan_type='weekly' where id=$1",[target.plan]);const targetDay=(await client.query('select d.id from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id where s.id=(select plan_session_id from plans.plan_nodes where id=$1)',[target.node])).rows[0].id;
 const path=mode==='day'?'/api/builder/blocks/'+src.day+'/copy-into/'+targetDay:'/api/builder/sessions/'+src.session+'/copy-into/'+targetDay,r=await request(path,{confirmOverwrite:true});assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(await assetItem(target.plan,media.video.id));assert.equal(await evidence(target.plan),'2');}}
 });
 test('Drive L1 HTTP: Builder copy/assignment, Access revoke, source deletion and mapping rollback preserve independent rights',async()=>{
 const id=await driveExercise(),node=await makeSection(coachId),source=await planOf(node);await addExercise(id,{},node);
 const video=await driveCopy('1DriveVideoFile0000000000AB'),copy=await cloneToAthlete(source);
 const legacyItem=async plan=>(await client.query('select i.* from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=$1 and i.exercise_id=$2',[plan,id])).rows[0];
 const original=await legacyItem(source),retained=await legacyItem(copy.plan);
 await client.query("update plans.plans set status='active',visibility='public',library_scope='optimove',athlete_can_view_directly=true,requires_approval=true where id=$1",[source]);
 await client.query('insert into public.athlete_library_access(athlete_id,can_view_optimove_library,require_approval,free_only) values($1,true,true,true)',[copy.athlete]);
 const grant=(await client.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'coach_assigned','accessed') returning id",[source,athleteUserId])).rows[0].id;
 assert.equal((await access({type:'plan_item',id:original.id},['video'],true)).body.video.mediaId,video);
 const sourceEvidence=await evidence(source),copyEvidence=await evidence(copy.plan);assert.ok(Number(sourceEvidence)>0);assert.ok(Number(copyEvidence)>0);
 assert.equal((await request('/api/organization/program-access/'+grant+'/revoke',{})).status,200);
 assert.equal((await access({type:'plan_item',id:original.id},['video'],true)).status,404);
 assert.equal((await access({type:'plan_item',id:retained.id},['video'],true)).body.video.mediaId,video);
 assert.equal((await request('/api/builder/plans/'+source,undefined,{method:'DELETE'})).status,200);
 assert.equal(await evidence(source),sourceEvidence);assert.equal(await evidence(copy.plan),copyEvidence);
 await client.query('delete from media.drive_copies where asset_id=$1',[video]);
 assert.deepEqual((await access({type:'plan_item',id:retained.id},['video'],true)).body,{});
 assert.equal((await access({type:'plan_item',id:original.id},['video'],true)).status,404);
 await assert.rejects(client.query("update media.assets set status='deleting' where id=$1",[video]),error=>error.code==='P7502');
 });
 test('Drive L1 concurrent HTTP: import refuses busy edit draft without blocking actual submit and completes on retry',async()=>{
 const source='00000000-0000-4000-8000-000000000001',node=await makeSection(coachId,source),exerciseId=await driveExercise();
 await addExercise(exerciseId,{},node);await client.query("update plans.plans set status='active' where id=$1",[source]);
 const opened=await request('/api/builder/plans/'+source+'/edit',{});assert.equal(opened.status,200,JSON.stringify(opened.body));
 const draft=(await client.query('select id from plans.plans where is_edit_draft and edit_source_plan_id=$1',[source])).rows[0].id;assert.ok(source<draft);
 const {createMediaUploadService}=await import('../src/mediaUploads.js'),{createDriveCopyService}=await import('../src/driveCopies.js');
 const storage=createMediaStorageService(pool),platform=await storage.ensureAccount({type:'platform'}),actor={user:{id:otherCoachId},authz:{platformRoles:['platform_admin'],capabilities:{coachWorkspace:true}}};
 await client.query('update media.storage_accounts set override_limit_bytes=1000000 where id=$1',[platform]);
 const objects=new Map(),store={assertConfigured(){},async signPut(){return {};},async head(key){return objects.get(key);},async tombstone(){}};
 const imports=createMediaUploadService({pool,storage,store,driveCopies:createDriveCopyService({pool}),inspect:async()=>({durationSeconds:2,width:320,height:240,videoCodec:'h264'})});
 const started=await imports.importInitiate(actor,{driveFileId:'1DriveVideoFile0000000000AB',kind:'video',file:{name:'test.mp4',sizeBytes:'60',mimeType:'video/mp4'}},crypto.randomUUID());
 const upload=(await client.query('select * from media.uploads where id=$1',[started.uploadId])).rows[0];objects.set(upload.temporary_object_key,{sizeBytes:'60',mimeType:'video/mp4',etag:'fixture'});
 await pauseQueries(sql=>sql.includes('from plans.plans where id = $1 for update')&&sql.includes('is_edit_draft'),1,async gate=>{
  const submitting=request('/api/builder/plans/'+draft+'/submit',{});
  try {
   await gate.wait();await assert.rejects(imports.complete(actor,started.uploadId),error=>error.code==='55P03'&&error.message.startsWith('could not obtain lock on row'));
   await client.query('begin');try {
    await client.query('select id from plans.plans where id=$1 for update nowait',[source]);
    await client.query('select id from media.uploads where id=$1 for update nowait',[started.uploadId]);
    await client.query('select id from media.assets where id=$1 for update nowait',[started.mediaId]);
   } finally {await client.query('rollback');}
  } finally {gate.release();}
  const saved=await submitting;assert.equal(saved.status,200,JSON.stringify(saved.body));
 });
 assert.equal((await imports.complete(actor,started.uploadId)).httpStatus,200);
 assert.equal((await client.query('select count(*) from media.drive_copies where asset_id=$1',[started.mediaId])).rows[0].count,'1');
 });
 test('L1 concurrent HTTP: binder waits for upload completion before locking its asset',async()=>{
 const id=await exercise(),a=await ready({type:'exercise_edit',exerciseId:id},'video',coachId,'pending'),writer=await pool.connect();let binding;try{await writer.query('begin');await writer.query("set local lock_timeout='2s'");await writer.query('select id from media.uploads where id=$1 for update',[a.uploadId]);binding=patch(id,{video:selected(a.id)});await waitBlockedQuery('select id from media.uploads where asset_id=any');await writer.query("update media.assets set status='ready' where id=$1",[a.id]);await writer.query("update media.uploads set status='completed' where id=$1",[a.uploadId]);await writer.query('commit');const r=await binding;assert.equal(r.status,200,JSON.stringify(r.body));}finally{await writer.query('rollback');writer.release();if(binding)await binding;}
 });
}

test('Drive rollback: blank legacy saves preserve recorded URLs, while explicit none remains authorized',async()=>{
 const id=await driveExercise(),asset=await driveCopy('1DriveVideoFile0000000000AB');
 await client.query("insert into media.drive_copy_events(drive_file_id,kind,asset_id,event,performed_by_user_id) values('1DriveVideoFile0000000000AB','video',$1,'created',$2)",[asset,otherCoachId]);
 assert.equal((await detail(id)).videoUrl,'');
 await client.query('delete from media.drive_copies where asset_id=$1',[asset]);
 for(const enabled of ['true','false']) {
  process.env.MEDIA_STORAGE_ENABLED=enabled;
  const saved=await request('/api/exercises/'+id,{name:'Saved after rollback',videoUrl:''},{method:'PATCH'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal((await client.query('select video_url from library.exercises where id=$1',[id])).rows[0].video_url,DRIVE_VIDEO);
 }
 process.env.MEDIA_STORAGE_ENABLED='true';
 const removed=await patch(id,{video:{source:'none'}});assert.equal(removed.status,200);
 assert.equal((await detail(id)).media.video.source,'none');
 assert.equal((await client.query('select video_url from library.exercises where id=$1',[id])).rows[0].video_url,DRIVE_VIDEO);
});

test('Drive import previews recheck platform role, uploader and mapping independently of coach capability',{skip:process.env.MEDIA_L1_TEST!=='true'},async()=>{
 const {createMediaUploadService}=await import('../src/mediaUploads.js');
 const {createDriveCopyService}=await import('../src/driveCopies.js');
 const req={user:{id:otherCoachId},authz:{platformRoles:['platform_admin'],capabilities:{coachWorkspace:true}}};
 const objects=new Map(),store={assertConfigured(){},async signPut(){return {};},async head(key){return objects.get(key);},async tombstone(){}};
 await driveExercise();
 const storage=createMediaStorageService(pool),platform=await storage.ensureAccount({type:'platform'});
 await client.query('update media.storage_accounts set override_limit_bytes=1000000 where id=$1',[platform]);
 const service=createMediaUploadService({pool,storage,store,driveCopies:createDriveCopyService({pool}),inspect:async()=>({durationSeconds:2,width:320,height:240,videoCodec:'h264'})});
 const started=await service.importInitiate(req,{driveFileId:'1DriveVideoFile0000000000AB',kind:'video',file:{name:'video.mp4',sizeBytes:'60',mimeType:'video/mp4'}},crypto.randomUUID());
 const upload=(await client.query('select * from media.uploads where id=$1',[started.uploadId])).rows[0];
 objects.set(upload.temporary_object_key,{sizeBytes:'60',mimeType:'video/mp4',etag:'fixture'});
 await service.complete(req,started.uploadId);
 const body={context:{type:'upload',id:started.uploadId},slots:['video']};
 assert.equal((await accessService.access(req,body)).video.mediaId,started.mediaId);
 const revoked={...req,authz:{platformRoles:[],capabilities:{coachWorkspace:true}}};
 await assert.rejects(accessService.access(revoked,body),error=>error.code==='resource_not_found');
 await assert.rejects(service.status(revoked,started.uploadId),error=>error.code==='operation_not_allowed');
 await assert.rejects(accessService.access({...req,user:{id:coachId}},body),error=>error.code==='resource_not_found');
 await client.query('delete from media.drive_copies where asset_id=$1',[started.mediaId]);
 await assert.rejects(accessService.access(req,body),error=>error.code==='resource_not_found');
 await assert.rejects(accessService.access(revoked,body),error=>error.code==='resource_not_found');
});

// ---- Drive copies (migration 202610291100) ------------------------------------
// A legacy Drive link whose file has a ready copy in the platform account reads
// and plays as that asset (exercise, private copy, plan item); nothing is rewritten.
const DRIVE_VIDEO='https://drive.google.com/file/d/1DriveVideoFile0000000000AB/view?usp=sharing';
const DRIVE_IMAGE='https://drive.google.com/open?id=1DriveImageFile0000000000CD';
async function driveCopy(driveId,kind='video',status='ready') {
 const account=await createMediaStorageService(pool).ensureAccount({type:'platform'}),id=crypto.randomUUID();
 await client.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,$3,$4,$5,$6,1,$7)",[id,'assets/'+id,kind,account,otherCoachId,status,kind==='video'?'video/mp4':'image/jpeg']);
 await client.query('insert into media.drive_copies(drive_file_id,kind,asset_id,created_by_user_id) values($1,$2,$3,$4)',[driveId,kind,id,otherCoachId]);
 return id;
}
async function driveExercise(owner=coachId,extra={}) {
 return (await client.query("insert into library.exercises(name,owner_scope,owner_user_id,video_url,image_url) values('Drive exercise',$4,$1,$2,$3) returning id",[owner,extra.video??DRIVE_VIDEO,extra.image??DRIVE_IMAGE,extra.scope??'user'])).rows[0].id;
}
const detail=async id=>(await request('/api/exercises/'+id,undefined,{method:'GET'})).body;
beforeEach(async()=>{await client.query('delete from media.drive_copies');});

test('Drive copy: an exercise whose legacy Drive video has a ready copy reads and plays as that asset; its image without a copy stays the Drive link',async()=>{
 const id=await driveExercise();
 let body=await detail(id);
 assert.equal(body.media.video.source,'legacy');assert.equal(body.media.video.url,DRIVE_VIDEO);
 const copy=await driveCopy('1DriveVideoFile0000000000AB');
 body=await detail(id);
 assert.deepEqual(body.media.video,{source:'asset',mediaId:copy,kind:'video'});
 assert.equal(body.videoUrl,'','the Drive link is not offered beside the copy');
 assert.equal(body.media.image.source,'legacy');assert.equal(body.media.image.url,DRIVE_IMAGE);
 const played=await access({type:'exercise',id},['video','image']);
 assert.equal(played.status,200);assert.equal(played.body.video.mediaId,copy);assert.equal(played.body.image,undefined,'no copy, nothing signed');
 assert.equal((await client.query('select video_source from library.exercises where id=$1',[id])).rows[0].video_source,'legacy','the row is not rewritten');
});

test('Drive copy: the ?id= form, an image copy and a personal copy of a system exercise inheriting its link all resolve; a foreign exercise stays 404',async()=>{
 const id=await driveExercise(null,{scope:'system'}),image=await driveCopy('1DriveImageFile0000000000CD','image');
 assert.deepEqual((await detail(id)).media.image,{source:'asset',mediaId:image,kind:'image'});
 const video=await driveCopy('1DriveVideoFile0000000000AB');
 const copyRow=(await client.query("insert into library.exercises(name,owner_scope,owner_user_id,source_exercise_id) values('Private copy','user',$1,$2) returning id",[coachId,id])).rows[0].id;
 const played=await access({type:'exercise',id:copyRow},['video','image']);
 assert.equal(played.status,200);assert.equal(played.body.video.mediaId,video);assert.equal(played.body.image.mediaId,image);
 const foreign=await driveExercise(otherCoachId);
 assert.equal((await access({type:'exercise',id:foreign})).status,404,'a copy never widens who may play a row');
});

test('Drive copy: a plan item with the legacy Drive snapshot plays the copy for its athlete; the decorator describes it; removal and an unready copy fall back to Drive',async()=>{
 const id=await driveExercise();assert.equal((await addExercise(id)).status,201);
 const item=await oneItem(id);assert.equal(item.video_source,'legacy');assert.equal(item.video_url,DRIVE_VIDEO);
 const plan=(await client.query('select d.plan_id from plans.plan_days d join plans.plan_sessions s on s.plan_day_id=d.id where s.id=$1',[item.plan_session_id])).rows[0].plan_id,athlete=crypto.randomUUID();
 await client.query('insert into public.athletes(id,user_id,is_active) values($1,$2,true)',[athlete,athleteUserId]);await client.query("update plans.plans set athlete_id=$2,is_template=false,status='active' where id=$1",[plan,athlete]);
 assert.deepEqual((await access({type:'plan_item',id:item.id},['video'],true)).body,{},'no copy yet: nothing to sign, Drive as before');
 const copy=await driveCopy('1DriveVideoFile0000000000AB');
 assert.equal((await access({type:'plan_item',id:item.id},['video'],true)).body.video.mediaId,copy);
 const rows=[{plan_item_id:item.id,video_url:item.video_url,image_url:item.image_url}];
 await decorateMediaRows(rows,'plan_item',(sql,params)=>pool.query(sql,params));
 assert.deepEqual(rows[0].media.video,{source:'asset',mediaId:copy,kind:'video'});assert.equal(rows[0].video_url,'');
 assert.equal((await client.query('select video_source from plans.plan_items where id=$1',[item.id])).rows[0].video_source,'legacy','the plan item is not rewritten');
 if(process.env.MEDIA_L1_TEST==='true') {
  await assert.rejects(client.query("update media.assets set status='deleting' where id=$1",[copy]),error=>error.code==='P7502');
  assert.equal((await access({type:'plan_item',id:item.id},['video'],true)).body.video.mediaId,copy);
 } else {
  await client.query("update media.assets set status='deleting' where id=$1",[copy]);
  assert.deepEqual((await access({type:'plan_item',id:item.id},['video'],true)).body,{});
  await client.query("update media.assets set status='ready' where id=$1",[copy]);
 }
 await client.query('delete from media.drive_copies');
 const back=[{plan_item_id:item.id,video_url:item.video_url}];
 await decorateMediaRows(back,'plan_item',(sql,params)=>pool.query(sql,params));
 assert.equal(back[0].media.video.source,'legacy');assert.equal(back[0].media.video.url,DRIVE_VIDEO);
 await client.query('update public.athletes set user_id=null where id=$1',[athlete]);await driveCopy('1DriveVideoFile0000000000AB');
 assert.equal((await access({type:'plan_item',id:item.id},['video'],true)).status,404,'the plan rule still decides');
});

test('Drive copy: with media storage off nothing is mapped, and a none slot never turns into a copy',async()=>{
 const id=await driveExercise();await driveCopy('1DriveVideoFile0000000000AB');
 process.env.MEDIA_STORAGE_ENABLED='false';
 const off=await detail(id);assert.notEqual(off.media?.video?.source,'asset');assert.equal(off.videoUrl,DRIVE_VIDEO);
 process.env.MEDIA_STORAGE_ENABLED='true';
 await client.query("update library.exercises set video_source='none' where id=$1",[id]);
 assert.deepEqual((await detail(id)).media.video,{source:'none'});
 assert.deepEqual((await access({type:'exercise',id})).body,{},'a none slot signs nothing');
});

test('Drive copy: an editor echoing the blank link fields keeps the Drive link of a copied slot; an uncopied link is cleared as before',async()=>{
 const id=await driveExercise();await driveCopy('1DriveVideoFile0000000000AB');
 const saved=await request('/api/exercises/'+id,{name:'Renamed',videoUrl:'',imageUrl:''},{method:'PATCH'});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 const stored=(await client.query('select video_source,video_url,image_url from library.exercises where id=$1',[id])).rows[0];
 assert.equal(stored.video_source,'legacy');assert.equal(stored.video_url,DRIVE_VIDEO,'the copied slot keeps its Drive link');
 assert.equal(stored.image_url,null,'the image has no copy: a blank link clears it, as before');
 const changed=await request('/api/exercises/'+id,{name:'Relinked',videoUrl:'https://youtu.be/dQw4w9WgXcQ'},{method:'PATCH'});
 assert.equal(changed.status,200);assert.equal((await client.query('select video_url from library.exercises where id=$1',[id])).rows[0].video_url,'https://youtu.be/dQw4w9WgXcQ','a new link still replaces it');
});

// ---- Option A (owner, 2026-10-30): the batch authorizes its contexts together --
// One transaction per batch, the contexts of a type authorized at once. It must
// answer every context exactly as the old per-context access() did: the oracle
// is that implementation, kept unchanged in support/media-access-oracle.mjs.
const fixedStore={signGet:async asset=>({url:'https://private.test/'+asset.id,expiresAt:'2030-01-01T00:00:00.000Z'})};
const authzOf=(roles,athlete,coach)=>({platformRoles:roles,clubRoles:[],teamRoles:[],managedTeamIds:[],isAthlete:athlete,capabilities:{coachWorkspace:coach}});
const people={
 coach:{user:{id:coachId},authz:authzOf([],false,true)},
 athlete:{user:{id:athleteUserId},authz:authzOf([],true,false)},
 admin:{user:{id:otherCoachId},authz:authzOf(['platform_admin'],false,true)},
 revokedAdmin:{user:{id:otherCoachId},authz:authzOf([],false,true)},
 noWorkspace:{user:{id:coachId},authz:authzOf([],false,false)},
 // An athlete account that is also a coach: its own template needs no approval.
 coachAthlete:{user:{id:coachId},authz:authzOf([],true,true)},
};
// A pool whose clients record every statement they send.
function recordingPool() {
 const statements=[];
 return {statements,async connect(){const c=await pool.connect();return {query:(sql,params)=>{statements.push(typeof sql==='string'?sql:sql.text);return c.query(sql,params);},release:(...args)=>c.release(...args)};}};
}
const accessServices=(target=pool)=>({fresh:createMediaAccessService({pool:target,store:fixedStore}),oracle:createOracleMediaAccessService({pool:target,store:fixedStore})});
const outcomeOf=async promise=>{try{return {media:await promise};}catch(e){if(!(e instanceof MediaStorageError))throw e;return {error:{code:e.code,status:e.status,retryable:Boolean(e.retryable)}};}};
async function planSession(owner,fields={}) {
 const plan=(await client.query("insert into plans.plans(created_by_user_id,name) values($1,'Matrix plan') returning id",[owner])).rows[0].id;
 for(const [column,value] of Object.entries(fields))await client.query(`update plans.plans set ${column}=$2 where id=$1`,[plan,value]);
 const day=(await client.query('insert into plans.plan_days(plan_id) values($1) returning id',[plan])).rows[0].id;
 return {plan,session:(await client.query('insert into plans.plan_sessions(plan_day_id) values($1) returning id',[day])).rows[0].id};
}
async function planItem(session,{video=null,image=null,videoAsset=null}={}) {
 return (await client.query("insert into plans.plan_items(plan_session_id,item_type,title,video_source,video_asset_id,video_url,image_url) values($1,'exercise','Matrix item',$2,$3,$4,$5) returning id",
  [session,videoAsset?'asset':'legacy',videoAsset,video,image])).rows[0].id;
}
// Every context class the rules tell apart, in one mixed list of requests.
async function seedMatrix() {
 const ex={},items={},uploads={};
 const imageCopy=await driveCopy('1DriveImageFile0000000000CD','image'),videoCopy=await driveCopy('1DriveVideoFile0000000000AB');
 ex.own=await exercise('Own R2');const ownVideo=await ready({type:'exercise_edit',exerciseId:ex.own});
 await client.query("update library.exercises set video_source='asset',video_asset_id=$2,image_url=$3 where id=$1",[ex.own,ownVideo.id,DRIVE_IMAGE]);
 ex.legacy=await exercise('Plain legacy');
 ex.videoIdAsImage=await driveExercise(coachId,{image:DRIVE_VIDEO});
 ex.foreign=await driveExercise(otherCoachId);
 ex.system=await driveExercise(null,{scope:'system'});
 ex.inactive=(await client.query("insert into library.exercises(name,owner_scope,owner_user_id,is_active,video_url) values('Inactive','user',$1,false,$2) returning id",[coachId,DRIVE_VIDEO])).rows[0].id;
 ex.club=(await client.query("insert into library.exercises(name,owner_scope,owner_club_id,video_url) values('Club','club',$1,$2) returning id",[crypto.randomUUID(),DRIVE_VIDEO])).rows[0].id;
 ex.restricted=await driveExercise(null,{scope:'system'});ex.granted=await driveExercise(null,{scope:'system'});
 const blocked=(await client.query("insert into library.exercise_collections(name) values('Matrix restricted') returning id")).rows[0].id,granted=(await client.query("insert into library.exercise_collections(name) values('Matrix granted') returning id")).rows[0].id;
 await client.query('insert into library.exercise_collection_items values($1,$2),($3,$4)',[blocked,ex.restricted,granted,ex.granted]);
 await client.query('insert into library.exercise_collection_users values($1,$2)',[granted,coachId]);
 ex.privateCopy=(await client.query("insert into library.exercises(name,owner_scope,owner_user_id,source_exercise_id) values('Inherits a readable source','user',$1,$2) returning id",[coachId,ex.system])).rows[0].id;
 ex.copyOfOwn=(await client.query("insert into library.exercises(name,owner_scope,owner_user_id,copy_parent_id) values('Inherits own','user',$1,$2) returning id",[coachId,ex.videoIdAsImage])).rows[0].id;
 ex.copyOfForeign=(await client.query("insert into library.exercises(name,owner_scope,owner_user_id,copy_parent_id) values('Inherits a foreign one','user',$1,$2) returning id",[coachId,ex.foreign])).rows[0].id;
 ex.pendingAsset=await exercise('Pending asset');const pending=await ready({type:'exercise_edit',exerciseId:ex.pendingAsset},'video',coachId,'pending');
 await client.query("update library.exercises set video_source='asset',video_asset_id=$2 where id=$1",[ex.pendingAsset,pending.id]);
 ex.wrongKind=await exercise('Image slot holds a video');
 await client.query("update library.exercises set image_source='asset',image_asset_id=$2 where id=$1",[ex.wrongKind,ownVideo.id]);
 const athleteLinked=crypto.randomUUID(),athleteRevoked=crypto.randomUUID();
 await client.query('insert into public.athletes(id,user_id,is_active) values($1,$2,true),($3,null,true)',[athleteLinked,athleteUserId,athleteRevoked]);
 await client.query('delete from public.athlete_library_access');
 await client.query('insert into public.athlete_library_access(athlete_id,require_approval) values($1,true)',[athleteLinked]);
 const own=await planSession(coachId),foreignPlan=await planSession(otherCoachId);
 const assigned=await planSession(coachId,{athlete_id:athleteLinked,is_template:false,status:'active'}),revoked=await planSession(coachId,{athlete_id:athleteRevoked,is_template:false,status:'active'});
 const needsApproval=await planSession(coachId,{athlete_id:athleteLinked,plan_type:'program',is_template:true,requires_approval:true,status:'active'});
 const approved=await planSession(coachId,{athlete_id:athleteLinked,plan_type:'program',is_template:true,requires_approval:true,status:'active'});
 await client.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'assigned','accessed')",[approved.plan,athleteUserId]);
 const inactive=await planSession(coachId,{is_active:false}),editDraft=await planSession(coachId,{is_active:false,is_edit_draft:true});
 items.ownAsset=await planItem(own.session,{videoAsset:ownVideo.id,image:DRIVE_VIDEO});
 items.ownDrive=await planItem(own.session,{video:DRIVE_VIDEO,image:DRIVE_IMAGE});
 items.ownLegacy=await planItem(own.session,{video:'https://legacy.test/old.mp4'});
 for(const [key,target] of Object.entries({foreign:foreignPlan,assigned,revoked,needsApproval,approved,inactive,editDraft}))items[key]=await planItem(target.session,{video:DRIVE_VIDEO,image:DRIVE_IMAGE});
 uploads.coach=(await ready()).uploadId;
 uploads.other=(await ready({type:'exercise_create'},'video',otherCoachId)).uploadId;
 uploads.pending=(await ready({type:'exercise_create'},'video',coachId,'pending')).uploadId;
 uploads.boundInactive=(await ready({type:'exercise_edit',exerciseId:ex.inactive})).uploadId;
 uploads.boundOwn=(await ready({type:'exercise_edit',exerciseId:ex.own},'image')).uploadId;
 const platform=await createMediaStorageService(pool).ensureAccount({type:'platform'});uploads.drive=crypto.randomUUID();
 await client.query("insert into media.uploads(id,asset_id,storage_account_id,uploaded_by_user_id,idempotency_key,request_fingerprint,context,purpose,temporary_object_key,expected_size_bytes,expected_mime_type,reserved_bytes,status,expires_at) values($1,$2,$3,$4,$5,'fixture',$6,'drive_import_video',$7,1,'video/mp4',1,'completed',now()+interval '10 minutes')",
  [uploads.drive,videoCopy,platform,otherCoachId,crypto.randomUUID(),{type:'drive_import',driveFileId:'1DriveVideoFile0000000000AB'},'tmp/'+uploads.drive]);
 // An import whose Drive copy is no longer mapped: nothing to preview, even for the admin.
 const unmapped=crypto.randomUUID();uploads.driveUnmapped=crypto.randomUUID();
 await client.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,'video',$3,$4,'ready',1,'video/mp4')",[unmapped,'assets/'+unmapped,platform,otherCoachId]);
 await client.query("insert into media.uploads(id,asset_id,storage_account_id,uploaded_by_user_id,idempotency_key,request_fingerprint,context,purpose,temporary_object_key,expected_size_bytes,expected_mime_type,reserved_bytes,status,expires_at) values($1,$2,$3,$4,$5,'fixture',$6,'drive_import_video',$7,1,'video/mp4',1,'completed',now()+interval '10 minutes')",
  [uploads.driveUnmapped,unmapped,platform,otherCoachId,crypto.randomUUID(),{type:'drive_import',driveFileId:'1DriveUnmappedFile00000000EF'},'tmp/'+uploads.driveUnmapped]);
 const both=['video','image'];
 const requests=[
  ...Object.values(ex).map(id=>({context:{type:'exercise',id},slots:both})),
  ...Object.values(items).map(id=>({context:{type:'plan_item',id},slots:both})),
  ...Object.values(uploads).map(id=>({context:{type:'upload',id},slots:['video','image']})),
  {context:{type:'exercise',id:ex.own},slots:['image']},{context:{type:'plan_item',id:items.ownDrive},slots:['video']},
  {context:{type:'exercise',id:crypto.randomUUID()},slots:['video']},{context:{type:'plan_item',id:crypto.randomUUID()},slots:['video']},
  {context:{type:'upload',id:crypto.randomUUID()},slots:['video']},{context:{type:'exercise',id:'not-a-uuid'},slots:['video']},
  {context:{type:'exercise',id:ex.own},slots:['audio']},{context:{type:'exercise',id:ex.own},slots:[]},{context:{type:'nope',id:ex.own},slots:['video']},
 ];
 return {ex,items,uploads,requests,assets:{ownVideo:ownVideo.id,imageCopy,videoCopy}};
}

test('option A: the set-based batch answers every context class exactly as the old per-context access, for every kind of requester, and single access() is a batch of one',async()=>{
 const matrix=await seedMatrix(),{fresh,oracle}=accessServices();
 assert.ok(matrix.requests.length<=50,'one batch');
 for(const [who,req] of Object.entries(people)) {
  const expected=await oracle.batch(req,{requests:matrix.requests});
  assert.deepEqual(await fresh.batch(req,{requests:matrix.requests}),expected,`${who}: the whole batch`);
  for(const [index,request] of matrix.requests.entries())assert.deepEqual(await outcomeOf(fresh.access(req,request)),await outcomeOf(oracle.access(req,request)),`${who}: access() of request ${index}`);
 }
 // The fixture is meaningful: the rules grant and refuse where they should.
 const answer=async(who,type,id,slots=['video','image'])=>(await fresh.batch(people[who],{requests:[{context:{type,id},slots}]})).results[0];
 const {ex,items,uploads,assets}=matrix,denied={code:'resource_not_found',status:404,retryable:false};
 assert.deepEqual((await answer('coach','exercise',ex.own)).media,{video:{source:'asset',mediaId:assets.ownVideo,mimeType:'video/mp4',...await fixedStore.signGet({id:assets.ownVideo})},image:{source:'asset',mediaId:assets.imageCopy,mimeType:'image/jpeg',...await fixedStore.signGet({id:assets.imageCopy})}});
 assert.deepEqual(Object.keys((await answer('coach','exercise',ex.videoIdAsImage)).media),['video'],'a video copy never plays as an image');
 assert.deepEqual((await answer('coach','exercise',ex.legacy)).media,{},'a link without a copy signs nothing');
 for(const key of ['granted','system','privateCopy','copyOfOwn'])assert.ok((await answer('coach','exercise',ex[key])).media,`coach plays ${key}`);
 for(const key of ['foreign','inactive','club','restricted','copyOfForeign','pendingAsset','wrongKind'])assert.deepEqual((await answer('coach','exercise',ex[key])).error,denied,`coach is refused ${key}`);
 assert.ok((await answer('admin','exercise',ex.club)).media,'a platform admin plays a club exercise');
 for(const key of ['ownAsset','ownDrive','ownLegacy','editDraft'])assert.ok((await answer('coach','plan_item',items[key])).media,`coach plays item ${key}`);
 for(const key of ['foreign','inactive'])assert.deepEqual((await answer('coach','plan_item',items[key])).error,denied,`coach is refused item ${key}`);
 for(const key of ['assigned','approved'])assert.ok((await answer('athlete','plan_item',items[key])).media,`athlete plays item ${key}`);
 for(const key of ['revoked','needsApproval','ownAsset'])assert.deepEqual((await answer('athlete','plan_item',items[key])).error,denied,`athlete is refused item ${key}`);
 assert.ok((await answer('coachAthlete','plan_item',items.needsApproval)).media,'the template\'s own coach, also an athlete, needs no approval');
 assert.deepEqual((await answer('athlete','exercise',ex.own)).error,denied,'no exercise outside a coach workspace');
 for(const key of ['coach','boundOwn'])assert.ok((await answer('coach','upload',uploads[key])).media,`uploader previews ${key}`);
 for(const key of ['other','pending','boundInactive','drive'])assert.deepEqual((await answer('coach','upload',uploads[key])).error,denied,`coach is refused upload ${key}`);
 assert.equal((await answer('admin','upload',uploads.drive,['video'])).media.video.mediaId,assets.videoCopy,'the importing platform admin previews the copy');
 assert.deepEqual((await answer('revokedAdmin','upload',uploads.drive,['video'])).error,denied,'a revoked platform role previews nothing');
 assert.deepEqual((await answer('admin','upload',uploads.driveUnmapped,['video'])).error,denied,'an import without its Drive mapping previews nothing');
 assert.deepEqual((await answer('noWorkspace','upload',uploads.coach,['video'])).error,denied);
 assert.deepEqual((await fresh.batch(people.coach,{requests:[{context:{type:'exercise',id:'not-a-uuid'},slots:['video']}]})).results[0].error,{code:'invalid_request',status:400,retryable:false});
 // A duplicated context answers at every index.
 const twice=await fresh.batch(people.coach,{requests:[{context:{type:'exercise',id:ex.own},slots:['video']},{context:{type:'exercise',id:ex.own},slots:['video']}]});
 assert.deepEqual(twice.results[0].media,twice.results[1].media);
 // With media storage off every request answers 503 on its own, as before.
 const enabled=process.env.MEDIA_STORAGE_ENABLED;
 try {
  process.env.MEDIA_STORAGE_ENABLED='false';
  assert.deepEqual(await fresh.batch(people.coach,{requests:matrix.requests.slice(0,3)}),await oracle.batch(people.coach,{requests:matrix.requests.slice(0,3)}));
  await assert.rejects(fresh.access(people.coach,matrix.requests[0]),e=>e.code==='media_storage_disabled' && e.status===503);
 } finally {if(enabled===undefined)delete process.env.MEDIA_STORAGE_ENABLED;else process.env.MEDIA_STORAGE_ENABLED=enabled;}
 await assert.rejects(fresh.batch(people.coach,{requests:Array(51).fill(matrix.requests[0])}),e=>e.code==='invalid_request');
 await assert.rejects(fresh.batch(people.coach,{requests:[]}),e=>e.code==='invalid_request');
});

// The split the old loop made: a MediaStorageError (also one from signing)
// stays on its request, any other error fails the whole call.
test('option A: a signing error stays on its request when it is a MediaStorageError and fails the whole call otherwise, as before',async()=>{
 const matrix=await seedMatrix(),failing=matrix.assets.imageCopy;
 const storeThrowing=kind=>({signGet:async asset=>{
  if(asset.id===failing)throw kind==='plain'?new Error('boom'):Object.assign(new MediaStorageError(503,'media_storage_unavailable'),{retryable:true});
  return fixedStore.signGet(asset);
 }});
 const requests=[{context:{type:'exercise',id:matrix.ex.own},slots:['video','image']},{context:{type:'exercise',id:matrix.ex.system},slots:['video']}];
 for(const kind of ['plain','typed']) {
  const fresh=createMediaAccessService({pool,store:storeThrowing(kind)}),oracle=createOracleMediaAccessService({pool,store:storeThrowing(kind)});
  if(kind==='plain') {
   for(const service of [fresh,oracle])await assert.rejects(service.batch(people.coach,{requests}),/boom/);
   await assert.rejects(fresh.access(people.coach,requests[0]),/boom/);
   continue;
  }
  const result=await fresh.batch(people.coach,{requests});
  assert.deepEqual(result,await oracle.batch(people.coach,{requests}));
  assert.deepEqual(result.results[0],{index:0,error:{code:'media_storage_unavailable',status:503,retryable:true}},'the request whose image could not be signed answers that, nothing of its video');
  assert.ok(result.results[1].media.video,'the next request is answered');
 }
});

test('option A: a batch of 50 sends a bounded number of statements, not one transaction per context',async t=>{
 const copy=await driveCopy('1DriveVideoFile0000000000AB'),exerciseIds=[],{session}=await planSession(coachId),itemIds=[];
 for(let index=0;index<50;index+=1) {
  exerciseIds.push(await driveExercise());
  itemIds.push(await planItem(session,index%2?{video:DRIVE_VIDEO}:{videoAsset:copy}));
 }
 const count=async(kind,ids,who='coach')=>{
  const recorded={fresh:recordingPool(),oracle:recordingPool()};
  const requests=ids.map(id=>({context:{type:kind,id},slots:['video','image']}));
  const freshResult=await accessServices(recorded.fresh).fresh.batch(people[who],{requests});
  const oracleResult=await accessServices(recorded.oracle).oracle.batch(people[who],{requests});
  assert.deepEqual(freshResult,oracleResult);
  assert.equal(freshResult.results.filter(r=>r.media?.video?.mediaId===copy).length,50,'every context plays');
  return {fresh:recorded.fresh.statements.length,oracle:recorded.oracle.statements.length};
 };
 // begin, statement_timeout, the isolation check, lock_timeout, the reuse lock,
 // the exercises, their Drive copies, the assets, commit.
 const exercises=await count('exercise',exerciseIds);
 assert.ok(exercises.fresh<=9,`50 exercises: ${exercises.fresh} statements`);
 // ... the items and their plan instead of the exercises, and the plan's own access check once.
 const planItems=await count('plan_item',itemIds);
 assert.ok(planItems.fresh<=11,`50 items of one plan: ${planItems.fresh} statements`);
 assert.ok(exercises.oracle>=50*8 && planItems.oracle>=50*8,'the old loop: a transaction per context');
 t.diagnostic(`statements for 50 exercises: ${exercises.oracle} before, ${exercises.fresh} now; for 50 items of one plan: ${planItems.oracle} before, ${planItems.fresh} now`);
});

test('option A: one foreign context in a batch of 50 answers alone, exactly like a missing one, and never fails or shows the others',async()=>{
 const copy=await driveCopy('1DriveVideoFile0000000000AB'),ids=[];
 for(let index=0;index<49;index+=1)ids.push(await driveExercise());
 const foreign=await driveExercise(otherCoachId),missing=crypto.randomUUID(),{fresh}=accessServices();
 const result=await fresh.batch(people.coach,{requests:[...ids,foreign].map(id=>({context:{type:'exercise',id},slots:['video']}))});
 assert.equal(result.results.length,50);
 assert.ok(result.results.slice(0,49).every((r,index)=>r.index===index && r.media.video.mediaId===copy));
 const alone=await fresh.batch(people.coach,{requests:[{context:{type:'exercise',id:missing},slots:['video']}]});
 assert.deepEqual(result.results[49],{index:49,error:alone.results[0].error},'a foreign context reads as a missing one');
 assert.equal(JSON.stringify(result.results[49]).includes(foreign),false);
});

test('option A: the locks are the old ones, taken once per batch - the reuse lock shared, FOR SHARE on assets only and in id order, the statement timeout first',async()=>{
 const matrix=await seedMatrix(),recorded=recordingPool();
 await accessServices(recorded).fresh.batch(people.admin,{requests:matrix.requests});
 const sql=recorded.statements.map(s=>s.replace(/\s+/g,' ').trim().toLowerCase());
 assert.deepEqual(sql.slice(0,2),['begin',"set local statement_timeout='10s'"]);
 assert.equal(sql.filter(s=>s.includes('pg_advisory_xact_lock_shared')).length,1,'the reuse lock once');
 assert.equal(sql.filter(s=>s.includes('for update')).length,0,'no row is locked for update');
 const sharing=sql.filter(s=>s.includes('for share'));
 assert.equal(sql.filter(s=>s.includes('from media.assets a ')).length,1,'the assets are read once');
 assert.equal(sharing.filter(s=>/from media\.assets a .* order by a\.id for share of a$/.test(s)).length,1,'that read locks them FOR SHARE, in id order');
 assert.ok(sharing.every(s=>/from media\.assets a .* order by a\.id for share of a$/.test(s) || /from media\.drive_copies c .* for share of c$/.test(s)),'FOR SHARE only on assets and an import preview\'s Drive copy, as before');
 assert.equal(sql.at(-1),'commit');
 // A writer holding the reuse lock exclusively makes the batch wait at most
 // lock_timeout, then fail as a whole, as the old loop did.
 const holder=new pg.Client({connectionString:database.url});await holder.connect();
 try {
  await holder.query('begin');await holder.query("select pg_advisory_xact_lock(hashtextextended('exercise_collections',0))");
  const {fresh,oracle}=accessServices();
  for(const service of [fresh,oracle])await assert.rejects(service.batch(people.coach,{requests:matrix.requests}),e=>e.code==='55P03');
 } finally {await holder.query('rollback').catch(()=>{});await holder.end();}
});
