import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { EXERCISE_COLLECTIONS_FIXTURE_SQL } from "./support/exercise-collections-fixture.mjs";

import {readFile} from 'node:fs/promises';
import {createMediaAccessService,decorateMediaRows} from '../src/exerciseMedia.js';
import {createR2UploadStore} from '../src/r2UploadStore.js';
import {createMediaStorageService,MediaStorageError} from '../src/mediaStorage.js';
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
      id uuid primary key default gen_random_uuid(), plan_id uuid, related_plan_id uuid, user_id uuid, access_type varchar,
      status varchar, expires_at timestamptz, starts_at timestamptz, source text, license_snapshot jsonb,
      accessed_at timestamptz, used_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
      unique(plan_id,user_id,access_type)
    );
    create table library.program_usage_events (program_access_id uuid,user_id uuid,event_type varchar,note text);
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
  for(const name of ['202610191100_media_storage_foundation.sql','202610191300_media_upload_lifecycle.sql','202610211000_media_drive_copies.sql'])await client.query(await readFile(new URL('../../migrations_v2/'+name,import.meta.url),'utf8'));
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
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
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

async function makeSection(ownerId) {
  const plan = await client.query("insert into plans.plans (created_by_user_id, name) values ($1,'Access test') returning id", [ownerId]);
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
 await client.query("update media.assets set status='deleting' where id=$1",[a.id]);assert.equal((await access({type:'exercise',id})).status,404);const pending=await ready({type:'exercise_create'},'video',coachId,'pending');assert.equal((await access({type:'upload',id:pending.uploadId})).status,404);await client.query('update library.exercises set is_active=false where id=$1',[id]);assert.equal((await access({type:'exercise',id})).status,404);
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

// ---- Drive copies (migration 202610211000) ------------------------------------
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
 await client.query("update media.assets set status='deleting' where id=$1",[copy]);
 assert.deepEqual((await access({type:'plan_item',id:item.id},['video'],true)).body,{},'an unready copy is not served');
 await client.query("update media.assets set status='ready' where id=$1",[copy]);await client.query('delete from media.drive_copies');
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
