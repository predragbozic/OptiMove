// Regression: the numeric ordering of an athlete's external id (and of an exercise code) used to cast the digits to
// `integer`, so ONE athlete whose external id has 10+ digits (> 2147483647) made the whole list answer 500
// "value ... is out of range for type integer". The cast is `numeric` now (same order for short values, empty -> NULL).
// Sites: organization.js loadManagedAthletes, athletes.js (two lists), exercises.js (library search).
// Real server on a disposable database built from the legacy snapshot and the runner.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildDatabase, fixtures, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let db, k, srv, admin;

// External ids in the order the numeric sort must give; '' and 'no digits' sort last (NULL), by name then.
const EXTERNAL = ["3", "5", "10", "2147483647", "2147483648", "2607482921", "12345678901234567890", "99999999999999999999"];

before(async () => {
  db = await buildDatabase({ label: "athlete_order_long_id", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  const F = fixtures(k);
  srv = await startServer(db.url);
  const id = await F.user("pa");
  await F.grantPlatform(id);
  admin = { id, cookie: await srv.cookieFor(id) };
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const shuffled = [...EXTERNAL].reverse();
async function seedAthletes() {
  const byExternal = new Map();
  for (const [i, ext] of shuffled.entries()) {
    const r = await k.query(
      `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name)
       values ($1, $2, 'Lo', $3, $4) returning id`,
      [`ORD-${i}`, ext, `N${i}`, `Lo N${i}`],
    );
    byExternal.set(r.rows[0].id, ext);
  }
  // No digits at all: NULL in the order, last.
  const none = await k.query(
    `insert into public.athletes (athlete_id, first_name, last_name, full_name) values ('ABC', 'Lo', 'None', 'Lo None') returning id`,
  );
  byExternal.set(none.rows[0].id, "ABC");
  return byExternal;
}
const EXPECTED = [...EXTERNAL, "ABC"];
const seen = (ids, byExternal) => ids.filter((id) => byExternal.has(id)).map((id) => byExternal.get(id));

test("1. GET /api/organization lists athletes in numeric order of the external id, with 10- and 20-digit ids, answering 200", async () => {
  const byExternal = await seedAthletes();
  const res = await srv.api(admin.cookie, "/api/organization");
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(seen(res.body.athletes.map((a) => a.id), byExternal), EXPECTED);
});

test("2. GET /api/athletes (the admin list) answers 200 in the same numeric order", async () => {
  // The platform workspace lists no athletes (by design): the admin works in a club's workspace, the athletes are its members.
  const club = (await k.query(`insert into public.clubs (name, is_active) values ('Order club', true) returning id`)).rows[0].id;
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)`, [admin.id, club]);
  const rows = (await k.query(`select id, coalesce(source_external_id, athlete_id) as ext from public.athletes where athlete_id like 'ORD-%' or athlete_id = 'ABC'`)).rows;
  for (const r of rows) {
    await k.query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1, $2, 'club', 'active')`, [r.id, club]);
  }
  await k.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1, 'club', $2)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [admin.id, club],
  );
  const byExternal = new Map(rows.map((r) => [r.id, r.ext]));
  const ws = await srv.api(admin.cookie, "/api/organization");
  assert.equal(ws.body.activeWorkspace?.type, "club", "the club workspace is the active one");
  assert.equal(ws.body.activeWorkspace?.scopeId, club);
  const res = await srv.api(admin.cookie, "/api/athletes");
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(seen(res.body.adminRows.map((a) => a.athlete_uuid), byExternal), EXPECTED);
});

test("3. the exercise library search answers 200 and orders codes numerically with 10- and 20-digit codes", async () => {
  const codes = ["EX3", "EX5", "EX10", "EX2607482921", "EX12345678901234567890"];
  for (const [i, code] of [...codes].reverse().entries()) {
    await k.query(`insert into library.exercises (exercise_code, name) values ($1, $2)`, [code, `Zlong ${i}`]);
  }
  const res = await srv.api(admin.cookie, "/api/exercises?limit=200");
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.exercises.map((e) => e.exercise_code).filter((c) => codes.includes(c)), codes);
});
