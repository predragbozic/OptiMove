// LO-1, the lock-order pull request: an exercise block write checks its
// caller's platform right with the users row locked before the role row
// (`for share of u, r`, routes/exerciseCollections.js beginBlockWrite), the
// order of the real platform-admin revocation (routes/organization.js,
// `for update of u, g`). The race runs the REAL revocation route against the
// REAL block write on a disposable database with the exercise collections'
// runtime fixture: the revocation queued on the admin's users row behind a
// peer, the block write started, the peer released. Users first, the write
// waits behind the revocation and answers the identical 404; role first, the
// two wait on each other (40P01).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { EXERCISE_COLLECTIONS_FIXTURE_SQL, addMediaSelectionFixture } from "./support/exercise-collections-fixture.mjs";

const blockAdminId = crypto.randomUUID();
const otherAdminId = crypto.randomUUID();
const revokerId = crypto.randomUUID();
const errors = [];
let database;
let client;
let pool;
let server;
let baseUrl;

before(async () => {
  database = await createDisposableDatabase({ prefix: "lock_order_lo1", label: "blocks" });
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  assert.equal((await client.query("select current_database() as name")).rows[0].name, database.name, "SAFETY: a disposable database only");
  await client.query(`
    create schema library;
    create table public.users (id uuid primary key, is_active boolean default true, display_name text, full_name text, email text);
    create table public.user_global_roles (
      id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id), role text, is_active boolean,
      granted_by_user_id uuid, revoked_at timestamptz, revoked_by_user_id uuid,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table library.exercises (
      id uuid primary key default gen_random_uuid(), name text, owner_scope text, owner_user_id uuid,
      is_active boolean default true, aim text, execution_notes text, instruction text, image_url text, video_url text,
      exercise_code text,slug text,created_by_user_id uuid,updated_at timestamptz default now()
    );
  `);
  await client.query("insert into public.users (id) values ($1),($2),($3)", [blockAdminId, otherAdminId, revokerId]);
  await client.query(EXERCISE_COLLECTIONS_FIXTURE_SQL);
  await addMediaSelectionFixture(client.query.bind(client));
  for (const id of [blockAdminId, otherAdminId, revokerId]) {
    await client.query("insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)", [id]);
  }
  process.env.DATABASE_URL = database.url;
  ({ pool } = await import("../src/db.js"));
  const { default: collectionsRouter } = await import("../src/routes/exerciseCollections.js");
  const { default: organizationRouter } = await import("../src/routes/organization.js");
  const app = express();
  app.use(express.json());
  app.use("/api/exercise-collections", (req, res, next) => {
    req.user = { id: blockAdminId };
    req.authz = { platformRoles: ["platform_admin"] };
    next();
  }, collectionsRouter);
  app.use("/api/organization", (req, res, next) => {
    req.user = { id: revokerId };
    req.authz = { platformRoles: ["platform_admin"], clubRoles: [], teamRoles: [], managedTeamIds: [] };
    next();
  }, organizationRouter);
  app.use((error, req, res, next) => {
    errors.push(`${error.code ?? ""} ${error.message}`);
    res.status(500).json({ error: "internal" });
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await pool?.end().catch(() => {});
  await client?.end().catch(() => {});
  await database?.drop();
});

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
async function waiters(pattern, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = (await client.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
                                       and query ~* $1 and pid <> pg_backend_pid()`, [pattern])).rows[0];
    if (row.n > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`nobody waits on a lock for /${pattern}/`);
}

test("1. a platform admin's block write against the real platform-admin revocation, queued behind it: the write is the identical 404 with no block saved, the revocation succeeds, and nothing deadlocks", async () => {
  const peer = new pg.Client({ connectionString: database.url });
  await peer.connect();
  await peer.query("begin");
  await peer.query("select 1 from public.users where id = $1 for update", [blockAdminId]);
  const revoking = call(`/api/organization/users/${blockAdminId}/global-roles/platform_admin`, { method: "DELETE" });
  await waiters("for update of u, g");
  const writing = call("/api/exercise-collections", { method: "POST", body: { name: `LO-1 block ${crypto.randomBytes(3).toString("hex")}`, exerciseIds: [], userIds: [] } });
  await waiters("for share of");
  await peer.query("commit");
  await peer.end();
  const [revoked, written] = await Promise.all([revoking, writing]);
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual([written.status, written.body], [404, { error: "notFound" }], written.text);
  assert.equal((await client.query("select count(*)::int as n from library.exercise_collections")).rows[0].n, 0, "no block saved");
  assert.equal((await client.query("select is_active from public.user_global_roles where user_id = $1", [blockAdminId])).rows[0].is_active, false);
  assert.deepEqual(errors.filter((e) => /40P01|deadlock/i.test(e)), [], "no 40P01");
});
