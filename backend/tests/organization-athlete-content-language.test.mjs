// An athlete's exercise language (owner, 2026-11-03): whoever may edit the
// athlete's profile today (canManageAthlete behind requireCoach: the team's
// coach, the club's admin, a platform admin) sets it with the profile, through
// PUT /api/organization/athletes/:athleteId; everyone else is refused exactly
// as that route refuses them today (an athlete by requireCoach, before the
// route). The athlete changes it in Account (PUT /api/auth/me/content-language).
// Also: before the migration (the local
// development database is migrated only on confirmation) GET /api/auth/me
// still answers, in Serbian.
//
// One disposable database through the real runner (support/calendar-
// fixture.mjs, which starts the whole app); the real routes over HTTP with real
// session cookies. Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { applyGpexeTestMigrations } from "./_gpexe-disposable-db.mjs";
import { calendarMigrations, calendarRoleMatrix, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

const MIGRATION = "202611031200_exercise_english_content.sql";

let env;
let m;

before(async () => {
  // Without the English migration first (test 1); test 2 applies it.
  env = await startCalendarApp({ label: "exenath" });
  // The scaffold carries only the columns the calendar reads; the routes
  // write the real tables' (the athlete's legacy pointer, the users' and
  // athletes' updated_at).
  await env.q(`alter table public.athletes
    add column if not exists club_id uuid, add column if not exists team_id uuid,
    add column if not exists athlete_id text, add column if not exists source_external_id text,
    add column if not exists first_name text, add column if not exists last_name text, add column if not exists image_url text,
    add column if not exists updated_at timestamptz not null default now()`);
  await env.q(`alter table public.users add column if not exists updated_at timestamptz not null default now()`);
  m = await calendarRoleMatrix(env, "exl");
});

after(async () => {
  if (env) await env.stop();
});

const q = (sql, params) => env.q(sql, params);
const languageOf = async (userId) => (await q(`select to_jsonb(u) ->> 'content_language' as language from public.users u where id = $1`, [userId]))[0].language;
const edit = (cookie, athlete, extra = {}) => env.api(`/api/organization/athletes/${athlete.athleteId}`, {
  method: "PUT", cookie, body: { fullName: athlete.name, ...extra },
});
const profile = async (athleteId) => (await q(`select full_name from public.athletes where id = $1`, [athleteId]))[0].full_name;

test("1. a database without the migration: /me still answers, in Serbian", async () => {
  const { roles } = m;
  assert.equal((await q(`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'content_language'`))[0].n, 0, "no column yet");
  for (const role of [roles.clubAdmin, roles.athlete]) {
    const me = await env.api("/api/auth/me", { cookie: role.cookie });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.user.contentLanguage, "sr");
  }
  await applyGpexeTestMigrations(env.db.url, [...calendarMigrations(), MIGRATION]);
  assert.equal((await q(`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'content_language'`))[0].n, 1, "the migration is applied");
});

test("2. the team's coach, the club's admin and a platform admin set the athlete's language with the profile; the athlete reads it on /me; a save without it leaves it", async () => {
  const { athletes, roles } = m;
  const athlete = athletes.athlete;
  const setBy = async (role, language) => {
    const res = await edit(role.cookie, athlete, { contentLanguage: language });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.athlete.content_language, language);
    assert.equal(await languageOf(athlete.userId), language);
  };
  const coach = await env.fx.coachOf(m.teams.t1, `exl coach ${uid()}`);
  await setBy(coach, "en");
  assert.equal((await env.api("/api/auth/me", { cookie: athlete.cookie })).body.user.contentLanguage, "en", "the athlete reads it");
  await setBy(roles.clubAdmin, "sr");
  await setBy(roles.platformAdmin, "en");
  // A save without the field changes nothing of it.
  await q(`update public.users set content_language = 'en' where id = $1`, [athlete.userId]);
  const plain = await edit(roles.clubAdmin.cookie, athlete);
  assert.equal(plain.status, 200, plain.text);
  assert.equal(Object.hasOwn(plain.body.athlete, "content_language"), false);
  assert.equal(await languageOf(athlete.userId), "en", "left as it was");
  // The athlete's own later change wins, and the coach's after it.
  assert.equal((await env.api("/api/auth/me/content-language", { method: "PUT", cookie: athlete.cookie, body: { contentLanguage: "sr" } })).status, 200);
  assert.equal(await languageOf(athlete.userId), "sr");
  await setBy(coach, "en");
});

test("3. the coach of another team, another club's admin and another athlete are refused exactly as the profile update refuses them, and nothing is written", async () => {
  const { athletes, roles } = m;
  const athlete = athletes.athlete;
  await q(`update public.users set content_language = 'sr' where id = $1`, [athlete.userId]);
  const otherTeamCoach = await env.fx.coachOf(m.teams.t2, `exl coach T2 ${uid()}`);
  for (const [label, role] of [["coach of another team", otherTeamCoach], ["another club's admin", roles.stranger], ["another athlete", athletes.athleteU1]]) {
    const without = await edit(role.cookie, athlete);
    const withField = await edit(role.cookie, athlete, { contentLanguage: "en" });
    const invalid = await edit(role.cookie, athlete, { contentLanguage: "de" });
    assert.equal(without.status, 403, `${label}: ${without.text}`);
    assert.deepEqual([withField.status, withField.body], [without.status, without.body], `${label}: the field changes nothing of the answer`);
    assert.deepEqual([invalid.status, invalid.body], [without.status, without.body], `${label}: not even an invalid value is checked before the right`);
    assert.equal(await languageOf(athlete.userId), "sr", `${label}: nothing written`);
  }
  // An unknown athlete: as today.
  const unknown = await env.api(`/api/organization/athletes/00000000-0000-0000-0000-000000000000`, { method: "PUT", cookie: roles.platformAdmin.cookie, body: { fullName: "Nobody", contentLanguage: "en" } });
  const unknownWithout = await env.api(`/api/organization/athletes/00000000-0000-0000-0000-000000000000`, { method: "PUT", cookie: roles.platformAdmin.cookie, body: { fullName: "Nobody" } });
  assert.deepEqual([unknown.status, unknown.body], [unknownWithout.status, unknownWithout.body]);
});

test("4. a value other than sr or en is a 400 with nothing written; an athlete without a login is a 400 with nothing written", async () => {
  const { athletes, roles } = m;
  const athlete = athletes.athlete;
  await q(`update public.users set content_language = 'sr' where id = $1`, [athlete.userId]);
  for (const bad of ["de", "EN", "", null, 1, ["en"]]) {
    const res = await edit(roles.clubAdmin.cookie, { ...athlete, name: "Renamed by a refused save" }, { contentLanguage: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(await languageOf(athlete.userId), "sr");
    assert.equal(await profile(athlete.athleteId), athlete.name, `${JSON.stringify(bad)}: the profile is not saved either`);
  }
  const noLogin = (await q(`insert into public.athletes (full_name, display_name, device_timezone) values ('exl no login', 'exl no login', 'UTC') returning id`))[0].id;
  await env.fx.addMembership({ athleteId: noLogin, clubId: m.clubs.c1, type: "club" });
  const res = await env.api(`/api/organization/athletes/${noLogin}`, { method: "PUT", cookie: roles.clubAdmin.cookie, body: { fullName: "exl renamed", contentLanguage: "en" } });
  assert.equal(res.status, 400, res.text);
  assert.match(res.body.error, /no login/);
  assert.equal(await profile(noLogin), "exl no login", "the profile is not saved either (one transaction)");
  const plain = await env.api(`/api/organization/athletes/${noLogin}`, { method: "PUT", cookie: roles.clubAdmin.cookie, body: { fullName: "exl renamed" } });
  assert.equal(plain.status, 200, plain.text);
});

test("5. only the athlete's own login is written: a body naming another user changes nothing of that user", async () => {
  const { athletes, roles } = m;
  const athlete = athletes.athlete;
  await q(`update public.users set content_language = 'sr' where id = any($1::uuid[])`, [[athlete.userId, roles.clubAdmin.id, athletes.athleteU1.userId]]);
  const res = await edit(roles.clubAdmin.cookie, athlete, { contentLanguage: "en", userId: roles.clubAdmin.id, user_id: athletes.athleteU1.userId });
  assert.equal(res.status, 200, res.text);
  assert.equal(await languageOf(athlete.userId), "en", "the athlete's login");
  assert.equal(await languageOf(roles.clubAdmin.id), "sr", "the caller's own row is untouched");
  assert.equal(await languageOf(athletes.athleteU1.userId), "sr", "another athlete's login is untouched");
});

// The brief: exactly who may edit the athlete today, no new rule. So a login
// that also holds a staff role (unlike PUT .../login-status, which refuses
// such an account because it toggles users.is_active) has its exercise
// language set like any other athlete's: a reversible display preference.
// Pinned here; the owner may choose to refuse it instead.
test("6. an athlete whose login also holds a staff role: the team's coach sets the language like any other athlete's", async () => {
  const { roles } = m;
  const staffAthlete = await env.fx.makeAthlete(`exl staff athlete ${uid()}`, { clubId: m.clubs.c1, teamId: m.teams.t1 });
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', true)`, [staffAthlete.userId, m.teams.t2]);
  const coach = await env.fx.coachOf(m.teams.t1, `exl coach multi ${uid()}`);
  const res = await edit(coach.cookie, staffAthlete, { contentLanguage: "en" });
  assert.equal(res.status, 200, res.text);
  assert.equal(await languageOf(staffAthlete.userId), "en");
  assert.equal(roles.clubAdmin.id !== staffAthlete.userId, true);
});
