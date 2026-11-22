// K6 (docs/ai/central-calendar-k6-contract.md 5.2, H1-H5): K6 adds no route and no backend change; these pin the
// reads its switcher relies on, through the real routes. The rail roster (GET /api/admin/athletes) lists only the
// workspace's athletes, and GET /api/calendar?athleteIds narrows inside the scope: a forged id returns nothing, a
// team sent with it never widens the answer outside the scope, and the athlete read is a subset of the unfiltered
// read of the same range (H5: K6 shows nothing new, it only gathers one athlete's).
//
// One disposable database (optimove_tests_calendar_k6scope_*): the committed legacy-schema snapshot plus every
// migration of migrations_v2 through the real runner; the real Express app in-process with real session cookies;
// dropped at the end. Synthetic names only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase, dropDisposableDatabase } from "./support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./support/legacy-bootstrap.mjs";
import { runMigrations } from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, "../../migrations_v2");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (a local PostgreSQL server; a disposable database is created on it).");
const BASE_URL = process.env.DATABASE_URL;
const WEEK = "2026-11-02";
const SUNDAY = "2026-11-08";

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let w;

const uid = () => crypto.randomBytes(4).toString("hex");
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
async function api(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${pathname}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };

async function user(label, { workspace, scope = null, role } = {}) {
  const id = (await q(`insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,'Scope',$2,$3,$3) returning id`, [`${label}-${uid()}@example.invalid`, label, `Scope ${label}`]))[0].id;
  if (role) await q(role.sql, [id, ...role.params]);
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)`, [id, workspace, scope]);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function athlete(name, memberships) {
  const id = (await q(`insert into public.athletes (athlete_id, first_name, last_name, full_name, display_name, device_timezone) values (nextval('public.athlete_generated_id_seq')::text, $1, 'Scope', $1, $1, 'UTC') returning id`, [name]))[0].id;
  for (const m of memberships) {
    await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,$4,'active','2026-01-01T00:00:00Z')`, [id, m.clubId, m.teamId || null, m.teamId ? "team" : "club"]);
  }
  return id;
}
async function teamEvent(cookie, teamId, title) {
  const types = ok(await api("/api/calendar/events/types", { cookie }));
  const type = types.types.find((t) => t.kind === "training");
  return ok(await api("/api/calendar/events", { method: "POST", cookie, body: { requestKey: crypto.randomUUID(), timezone: "UTC", eventTypeId: type.id, title, day: WEEK, startTime: "10:00", endTime: "11:00", targets: [{ kind: "team", id: teamId }] } }), 201).event;
}
const calendar = (cookie, extra = "") => api(`/api/calendar?from=${WEEK}&to=${SUNDAY}&today=2026-11-20${extra}`, { cookie });
const items = (answer) => answer.days.flatMap((day) => day.items);
const rosterIds = async (cookie) => (ok(await api("/api/admin/athletes", { cookie })).adminRows || []).map((row) => String(row.athlete_uuid));

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "calendar", label: "k6scope", baseDatabaseUrl: BASE_URL });
  await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the disposable database");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((r) => server.listen(0, r));
  apiBase = `http://localhost:${server.address().port}`;

  // A club with teams A and B; another club with team C. a1 in A, b1 in B, x1 in A and in C; p1 a private coach's.
  const club = (await q(`insert into public.clubs (name) values ($1) returning id`, [`K6 Club ${uid()}`]))[0].id;
  const other = (await q(`insert into public.clubs (name) values ($1) returning id`, [`K6 Other ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [club]);
  await q(`select calendar.seed_club_event_types($1)`, [other]);
  const teamA = (await q(`insert into public.teams (club_id, name) values ($1,'A') returning id`, [club]))[0].id;
  const teamB = (await q(`insert into public.teams (club_id, name) values ($1,'B') returning id`, [club]))[0].id;
  const teamC = (await q(`insert into public.teams (club_id, name) values ($1,'C') returning id`, [other]))[0].id;
  const a1 = await athlete("Alpha", [{ clubId: club }, { clubId: club, teamId: teamA }]);
  const b1 = await athlete("Bravo", [{ clubId: club }, { clubId: club, teamId: teamB }]);
  const x1 = await athlete("Xray", [{ clubId: club }, { clubId: club, teamId: teamA }, { clubId: other }, { clubId: other, teamId: teamC }]);
  const p1 = await athlete("Papa", []);
  const coachA = await user("coachA", { workspace: "team", scope: teamA, role: { sql: `insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, params: [teamA] } });
  const coachB = await user("coachB", { workspace: "team", scope: teamB, role: { sql: `insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, params: [teamB] } });
  const clubAdmin = await user("clubAdmin", { workspace: "club", scope: club, role: { sql: `insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, params: [club] } });
  const otherAdmin = await user("otherAdmin", { workspace: "club", scope: other, role: { sql: `insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, params: [other] } });
  const privateCoach = await user("private", { workspace: "private_coach", role: { sql: `insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, params: [] } });
  await q(`insert into public.user_athletes (user_id, athlete_id, is_active) values ($1,$2,true)`, [privateCoach.id, p1]);
  const platform = await user("platform", { workspace: "platform", role: { sql: `insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, params: [] } });
  await teamEvent(coachA.cookie, teamA, "A training");
  await teamEvent(coachB.cookie, teamB, "B training");
  await teamEvent(otherAdmin.cookie, teamC, "C training");
  w = { club, teamA, teamB, teamC, a1, b1, x1, p1, coachA, clubAdmin, privateCoach, platform };
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (db) await dropDisposableDatabase({ name: db.name, adminUrl: db.adminUrl, baseDatabaseUrl: BASE_URL }).catch(() => {});
});

test("H1. a team coach of A: the roster lists a1 and x1, never b1; athleteIds=b1 returns no card, with B's teamIds too", async () => {
  const roster = await rosterIds(w.coachA.cookie);
  assert.ok(roster.includes(w.a1) && roster.includes(w.x1));
  assert.equal(roster.includes(w.b1), false);
  const only = ok(await calendar(w.coachA.cookie, `&athleteIds=${w.b1}`));
  assert.deepEqual(items(only), [], "b1 is outside A's scope");
  const widened = ok(await calendar(w.coachA.cookie, `&athleteIds=${w.b1}&teamIds=${w.teamB}`));
  assert.equal(items(widened).some((item) => item.title === "B training"), false, "a team sent with the athlete never widens the scope");
  assert.ok(items(widened).every((item) => !(item.teamIds || []).includes(w.teamB)));
});

test("H2. a club admin: the roster lists a1, b1 and x1 and no athlete of the other club; athleteIds of another club's athlete returns nothing", async () => {
  const roster = await rosterIds(w.clubAdmin.cookie);
  for (const id of [w.a1, w.b1, w.x1]) assert.ok(roster.includes(id));
  assert.equal(roster.includes(w.p1), false);
  const forged = ok(await calendar(w.clubAdmin.cookie, `&athleteIds=${w.p1}`));
  assert.deepEqual(items(forged), []);
  const random = ok(await calendar(w.clubAdmin.cookie, `&athleteIds=${crypto.randomUUID()}`));
  assert.deepEqual(items(random), [], "a forged id returns nothing");
});

test("H3. a private coach: only the own relationship's athletes", async () => {
  assert.deepEqual(await rosterIds(w.privateCoach.cookie), [w.p1]);
  const outside = await calendar(w.privateCoach.cookie, `&athleteIds=${w.a1}`);
  if (outside.status === 200) assert.deepEqual(items(outside.body), []);
});

test("H4. the platform workspace: the roster is empty (why K6 draws no strip there)", async () => {
  assert.deepEqual(await rosterIds(w.platform.cookie), []);
});

test("H5. for the team coach of A and the club admin, the athlete read of x1 is a subset of the unfiltered read: same keys, titles, rights, teams within, counts no larger; the other club's item is in both or in neither", async () => {
  for (const viewer of [w.coachA, w.clubAdmin]) {
    const all = items(ok(await calendar(viewer.cookie)));
    const hers = items(ok(await calendar(viewer.cookie, `&athleteIds=${w.x1}`)));
    assert.ok(hers.length > 0, "x1 has a card");
    for (const card of hers) {
      const same = all.find((entry) => entry.key === card.key);
      assert.ok(same, `${card.key}: in the unfiltered read`);
      assert.equal(card.title, same.title);
      assert.equal(card.canManage, same.canManage);
      assert.ok((card.teamIds || []).every((id) => (same.teamIds || []).includes(id)));
      assert.ok((card.athleteCount || 0) <= (same.athleteCount || 0));
    }
    // x1 is in the other club's team too: that club's item that targets her is in both reads or in neither (H5),
    // never only in hers.
    assert.equal(hers.some((card) => card.title === "C training"), all.some((card) => card.title === "C training"));
  }
});
