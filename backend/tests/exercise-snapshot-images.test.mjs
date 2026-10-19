import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { completeCopiedExerciseImages, effectiveExerciseMediaSql } from "../src/exerciseSnapshotMedia.js";
import { applySnapshotImages, previewSnapshotImages, validateRepairIds } from "../src/exerciseSnapshotRepair.js";
import { copyBuilderSessionContents } from "../src/builderTreeBatch.js";

let database;
let client;
const owner = randomUUID();
const stranger = randomUUID();
const session = randomUUID();
const targetSession = randomUUID();
const section = randomUUID();
let original;
let privateCopy;
const picture = "https://example.com/1215.png";
const video = "https://drive.google.com/file/d/VIDEO_1215/view";

before(async () => {
  database = await createDisposableDatabase({ prefix: "snapshot_images", label: "repair" });
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  assert.equal((await client.query("select current_database() as name")).rows[0].name, database.name);
  await client.query(`
    create schema library; create schema plans;
    create table public.user_global_roles(user_id uuid,role text,is_active boolean);
    create table public.user_workspace_preferences(user_id uuid,workspace_type text);
    create table library.exercises(id uuid primary key default gen_random_uuid(),name text,aim text,
      execution_notes text,instruction text,owner_scope text,owner_user_id uuid,is_active boolean default true,
      source_exercise_id uuid,copy_parent_id uuid,image_url text,video_url text);
    create table library.exercise_collection_items(exercise_id uuid,collection_id uuid);
    create table library.exercise_collection_users(collection_id uuid,user_id uuid);
    create table library.exercise_collections(id uuid,access_all boolean,deleted_at timestamptz);
    create table plans.plans(id uuid primary key,created_by_user_id uuid);
    create table plans.plan_days(id uuid primary key,plan_id uuid);
    create table plans.plan_sessions(id uuid primary key,plan_day_id uuid);
    create table plans.plan_nodes(id uuid primary key default gen_random_uuid(),plan_session_id uuid,
      parent_id uuid,node_type text,name text,color text,icon_url text,short_note text,note text,node_order numeric);
    create table plans.plan_items(id uuid primary key default gen_random_uuid(),plan_session_id uuid,
      plan_node_id uuid,item_type text,exercise_id uuid,title text,description text,short_note text,note text,
      image_url text,video_url text,sets text,reps text,load text,item_order numeric,exercise_order numeric,source_row_ref text,
      updated_at timestamptz default now(),
      ${["domain", "category", "section"].flatMap((level) => [
        `${level}_name text`, `${level}_color text`, `${level}_icon_url text`,
        `${level}_short_note text`, `${level}_note text`, `${level}_order numeric`,
      ]).join(",")});
  `);
  const plan = randomUUID();
  const day = randomUUID();
  await client.query("insert into plans.plans values($1,$2)", [plan, owner]);
  await client.query("insert into plans.plan_days values($1,$2)", [day, plan]);
  await client.query("insert into plans.plan_sessions values($1,$3),($2,$3)", [session, targetSession, day]);
  await client.query("insert into plans.plan_nodes(id,plan_session_id,node_type,name,node_order) values($1,$2,'section','Exercises',1)", [section, session]);
});

beforeEach(async () => {
  await client.query("rollback");
  await client.query("delete from plans.plan_items; delete from library.exercises; delete from library.exercise_collection_items; delete from library.exercise_collection_users");
  original = randomUUID();
  privateCopy = randomUUID();
  await client.query(`insert into library.exercises(id,name,owner_scope,image_url,video_url)
    values($1,'Stolica na jednoj nozi','system',$2,$3)`, [original, picture, video]);
  await client.query(`insert into library.exercises(id,name,owner_scope,owner_user_id,source_exercise_id)
    values($1,'My copy','user',$2,$3)`, [privateCopy, owner, original]);
});

after(async () => {
  try { await client?.query("rollback"); await client?.end(); }
  finally { await database?.drop(); }
});

async function insertItem({ exerciseId = original, imageUrl = null, videoUrl = video, title = "Stolica na jednoj nozi" } = {}) {
  const result = await client.query(`insert into plans.plan_items
    (plan_session_id,plan_node_id,item_type,exercise_id,title,image_url,video_url,sets,note,item_order)
    values($1,$2,'exercise',$3,$4,$5,$6,'3','User note',1) returning *`,
  [session, section, exerciseId, title, imageUrl, videoUrl]);
  return result.rows[0];
}

async function start() {
  await client.query("begin isolation level read committed");
}

test("new snapshot resolves authorized original and inherited private-copy media", async () => {
  for (const exerciseId of [original, privateCopy]) {
    const result = await client.query(effectiveExerciseMediaSql, [owner, exerciseId]);
    assert.equal(result.rows[0].image_url, picture);
    assert.equal(result.rows[0].video_url, video);
  }
  assert.equal((await client.query(effectiveExerciseMediaSql, [stranger, privateCopy])).rowCount, 0);
  await client.query("update library.exercises set image_url=null,video_url=null where id=$1", [original]);
  const empty = (await client.query(effectiveExerciseMediaSql, [owner, privateCopy])).rows[0];
  assert.equal(empty.image_url, null);
  assert.equal(empty.video_url, null);
});

test("copy fills only NULL images, preserves explicit empties, videos, notes and source rows", async () => {
  const missing = await insertItem({ exerciseId: privateCopy });
  const custom = await insertItem({ imageUrl: "https://example.com/custom.png" });
  const cleared = await insertItem({ imageUrl: "" });
  const changedVideo = await insertItem({ videoUrl: "https://example.com/custom.mp4" });
  await start();
  const result = await completeCopiedExerciseImages(client.query.bind(client), [missing, custom, cleared, changedVideo], () => targetSession);
  assert.equal(result[0].image_url, picture);
  assert.equal(missing.image_url, null);
  for (const [index, item] of [missing, custom, cleared, changedVideo].entries()) {
    assert.deepEqual({ ...result[index], image_url: item.image_url }, item);
  }
  assert.equal(result[1].image_url, custom.image_url);
  assert.equal(result[2].image_url, "");
  assert.equal(result[3].image_url, null);
});

test("revoke, inactive ancestor and foreign private ancestry cannot supply new images", async () => {
  const item = await insertItem({ exerciseId: privateCopy });
  const collection = randomUUID();
  await client.query("insert into library.exercise_collection_items values($1,$2)", [original, collection]);
  await start();
  assert.equal((await completeCopiedExerciseImages(client.query.bind(client), [item], () => targetSession))[0].image_url, null);
  await client.query("insert into library.exercise_collection_users values($1,$2)", [collection, owner]);
  assert.equal((await completeCopiedExerciseImages(client.query.bind(client), [item], () => targetSession))[0].image_url, picture);
  await client.query("update library.exercises set is_active=false where id=$1", [original]);
  assert.equal((await completeCopiedExerciseImages(client.query.bind(client), [item], () => targetSession))[0].image_url, null);
  await client.query("update library.exercises set is_active=true,owner_scope='user',owner_user_id=$2 where id=$1", [original, stranger]);
  await client.query("update library.exercises set source_exercise_id=null,copy_parent_id=$2 where id=$1", [privateCopy, original]);
  assert.equal((await completeCopiedExerciseImages(client.query.bind(client), [item], () => targetSession))[0].image_url, null);
});

test("batched tree copies complete target snapshots without rewriting sources", async () => {
  const source = await insertItem();
  await start();
  await copyBuilderSessionContents(client, new Map([[session, targetSession]]), () => assert.fail("Unexpected legacy copy"));
  const copied = (await client.query("select * from plans.plan_items where plan_session_id=$1", [targetSession])).rows[0];
  assert.equal(copied.image_url, picture);
  assert.equal(copied.video_url, source.video_url);
  assert.equal(copied.note, source.note);
  assert.equal((await client.query("select image_url from plans.plan_items where id=$1", [source.id])).rows[0].image_url, null);
});

test("repair dry-run is read-only; apply and rollback are bounded and idempotent", async () => {
  const missing = await insertItem();
  const custom = await insertItem({ imageUrl: "https://example.com/custom.png" });
  await client.query("begin read only");
  const preview = await previewSnapshotImages(client, [missing.id, custom.id]);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].id, missing.id);
  assert.equal((await client.query("select image_url from plans.plan_items where id=$1", [missing.id])).rows[0].image_url, null);
  await client.query("rollback");
  await start();
  const journal = await applySnapshotImages(client, preview);
  assert.equal(journal.length, 1);
  assert.equal((await applySnapshotImages(client, preview)).length, 0);
  assert.equal((await applySnapshotImages(client, journal, { rollback: true })).length, 1);
  assert.equal((await applySnapshotImages(client, journal, { rollback: true })).length, 0);
  const restored = (await client.query("select * from plans.plan_items where id=$1", [missing.id])).rows[0];
  assert.deepEqual(restored, missing);
  assert.throws(() => validateRepairIds(Array.from({ length: 201 }, () => randomUUID())), /1-200/);
  assert.throws(() => validateRepairIds([missing.id, missing.id]), /distinct/);
});

test("repair refuses stale previews and revoke; rollback preserves subsequent user edits", async () => {
  const missing = await insertItem();
  await start();
  const preview = await previewSnapshotImages(client, [missing.id]);
  await client.query("update plans.plan_items set note='Changed' where id=$1", [missing.id]);
  await assert.rejects(applySnapshotImages(client, preview), /changed/);
  const revised = await previewSnapshotImages(client, [missing.id]);
  await client.query("update library.exercises set is_active=false where id=$1", [original]);
  await assert.rejects(applySnapshotImages(client, revised), /changed/);
  await client.query("update library.exercises set is_active=true where id=$1", [original]);
  const journal = await applySnapshotImages(client, revised);
  await client.query("update plans.plan_items set sets='5' where id=$1", [missing.id]);
  await assert.rejects(applySnapshotImages(client, journal, { rollback: true }), /changed/);
  assert.equal((await client.query("select sets from plans.plan_items where id=$1", [missing.id])).rows[0].sets, "5");
});

test("queued revoke cannot create a nested advisory-lock wait during image completion", async () => {
  const item = await insertItem();
  const outer = new pg.Client({ connectionString: database.url });
  const revoker = new pg.Client({ connectionString: database.url });
  let pending;
  await outer.connect();
  await revoker.connect();
  try {
    await outer.query("begin");
    await outer.query("select pg_advisory_xact_lock_shared(hashtextextended('exercise_collections',0))");
    await revoker.query("begin");
    pending = revoker.query("select pg_advisory_xact_lock(hashtextextended('exercise_collections',0))");
    const deadline = Date.now() + 2000;
    while (!(await client.query("select 1 from pg_locks where locktype='advisory' and not granted")).rowCount) {
      if (Date.now() > deadline) throw new Error("Revoke failed to queue");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await start();
    await client.query("set local statement_timeout='500ms'");
    const result = await completeCopiedExerciseImages(client.query.bind(client), [item], () => targetSession);
    assert.equal(result[0].image_url, null);
    await client.query("rollback");
  } finally {
    await outer.query("rollback");
    await pending;
    await revoker.query("rollback");
    await outer.end();
    await revoker.end();
  }
});

test("CLI dry-run, count gate, atomic stale-manifest refusal, apply replay and rollback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "optimove-image-repair-"));
  const script = fileURLToPath(new URL("../scripts/repair-snapshot-images.mjs", import.meta.url));
  const missing = await insertItem();
  const second = await insertItem();
  const invoke = (mode, input, output, count) => spawnSync(process.execPath,
    [script, mode, path.join(directory, input), path.join(directory, output), ...count === undefined ? [] : [String(count)]],
    { env: { ...process.env, DATABASE_URL: database.url }, encoding: "utf8", timeout: 10000 });
  try {
    await writeFile(path.join(directory, "ids.json"), JSON.stringify([missing.id, second.id]));
    assert.equal(invoke("dry-run", "ids.json", "preview.json").status, 0);
    const preview = JSON.parse(await readFile(path.join(directory, "preview.json"), "utf8"));
    assert.equal(preview.changedCount, 2);
    assert.equal(invoke("apply", "preview.json", "wrong-count.json", 1).status, 1);
    await client.query("update plans.plan_items set note='User edit' where id=$1", [preview.entries[1].id]);
    assert.equal(invoke("apply", "preview.json", "stale.json", 2).status, 1);
    assert.equal((await client.query("select count(*)::int as count from plans.plan_items where image_url is not null")).rows[0].count, 0);
    assert.equal(invoke("dry-run", "ids.json", "reviewed.json").status, 0);
    assert.equal(invoke("apply", "reviewed.json", "journal.json", 2).status, 0);
    assert.equal(invoke("apply", "reviewed.json", "replay.json", 2).status, 0);
    assert.equal(JSON.parse(await readFile(path.join(directory, "replay.json"), "utf8")).changedCount, 0);
    assert.equal(invoke("rollback", "journal.json", "rollback.json", 2).status, 0);
    assert.equal((await client.query("select count(*)::int as count from plans.plan_items where image_url is not null")).rows[0].count, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
