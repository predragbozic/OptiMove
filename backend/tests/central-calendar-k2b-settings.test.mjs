// Central calendar K2b-1a: Settings -> Calendar — the club's event types,
// details and places, team colours, migration v51 and the settings API.
// Plan: docs/ai/central-calendar-k2b-plan.md (sections 2-6, 11-13).
//
// SKELETON (2026-11-01): the plan is accepted, the owner's answers to Q1-Q12
// are pending, so v51 and the routes do not exist yet. What runs now is the
// role matrix of the black-box scenarios and today's contract that K2b-1
// keeps (T2: GET /api/calendar/events/types grows additively). Every
// scenario and invariant of the plan's section 12 is listed below as a todo;
// each becomes a test with the code of its slice.
//
// One disposable database through the real runner (backend/tests/support/
// calendar-fixture.mjs); the real Express app over HTTP with real session
// cookies. Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { addDays, calendarRoleMatrix, startCalendarApp } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);
const SEEDED_KEYS = ["training", "match", "travel", "meeting", "day_off", "camp", "test"];

let env;
let m;

before(async () => {
  env = await startCalendarApp({ label: "k2b" });
  m = await calendarRoleMatrix(env, "k2b");
});

after(async () => {
  if (env) await env.stop();
});

const calendarOf = (cookie) => env.api(`/api/calendar?from=${FROM}&to=${TO}`, { cookie });
const typesOf = (cookie) => env.api("/api/calendar/events/types", { cookie });
const idsOf = (res) => res.body.types.map((t) => t.id).sort();

// ---------------------------------------------------------------------------
// 0. The fixture and today's contract
// ---------------------------------------------------------------------------
test("0a. the role matrix resolves to the workspaces the scenarios assume", async () => {
  const { roles, clubs, teams } = m;
  const expected = [
    ["clubAdmin", "club", clubs.c1],
    ["twoClubAdmin", "club", clubs.c1],
    ["teamCoach", "team", teams.t1],
    ["privateCoach", "private_coach", null],
    ["athlete", "athlete", null],
    ["platformAdmin", "platform", null],
    ["platformInClub", "club", clubs.c1],
    ["stranger", "club", clubs.c2],
  ];
  for (const [name, type, scopeId] of expected) {
    const res = await calendarOf(roles[name].cookie);
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    assert.equal(res.body.workspace.type, type, name);
    assert.equal(res.body.workspace.scopeId ? String(res.body.workspace.scopeId) : null, scopeId ? String(scopeId) : null, name);
  }
  // A revoked admin and the admin of an archived club have no workspace at
  // all: the calendar answers both the same way.
  const revoked = await calendarOf(roles.revokedAdmin.cookie);
  const archived = await calendarOf(roles.archivedAdmin.cookie);
  assert.equal(revoked.status, 403, revoked.text);
  assert.equal(archived.status, revoked.status);
  assert.deepEqual(archived.body, revoked.body);
});

test("0b. every club of the matrix holds the seven seeded type copies, the archived club included", async () => {
  for (const clubId of Object.values(m.clubs)) {
    const rows = await env.q(
      `select seed_key from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 order by sort_order`,
      [clubId],
    );
    assert.deepEqual(rows.map((r) => r.seed_key), SEEDED_KEYS);
  }
});

test("0c. GET /events/types today (T2 keeps `types` as it is): each workspace's own set, never another club's; the athlete and a role-less account 403", async () => {
  const { roles } = m;
  const c1 = await typesOf(roles.clubAdmin.cookie);
  assert.equal(c1.status, 200, c1.text);
  assert.deepEqual(c1.body.types.map((t) => t.key), SEEDED_KEYS);
  assert.ok(c1.body.types.every((t) => t.ownerScope === "club"));
  for (const name of ["twoClubAdmin", "teamCoach", "platformInClub"]) {
    const res = await typesOf(roles[name].cookie);
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    assert.deepEqual(idsOf(res), idsOf(c1), name);
  }
  const c2 = await typesOf(roles.stranger.cookie);
  assert.equal(c2.status, 200, c2.text);
  assert.equal(idsOf(c2).filter((id) => idsOf(c1).includes(id)).length, 0, "club 2's set shares no row with club 1's");
  for (const name of ["privateCoach", "platformAdmin"]) {
    const res = await typesOf(roles[name].cookie);
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    assert.deepEqual(res.body.types.map((t) => t.key), SEEDED_KEYS, name);
    assert.ok(res.body.types.every((t) => t.ownerScope === "system"), name);
  }
  for (const name of ["athlete", "revokedAdmin", "archivedAdmin"]) {
    const res = await typesOf(roles[name].cookie);
    assert.equal(res.status, 403, `${name}: ${res.text}`);
  }
});

// ---------------------------------------------------------------------------
// The plan's section 12, to be built with K2b-1a (and 1b where marked).
// ---------------------------------------------------------------------------
// 1. The migration
test.todo("1a. v51 is recorded once, with its objects, the seed exactly (system and per club) and every trigger enabled; the post-check reads as expected");
test.todo("1b. the rollback rehearsal: apply -> rollback -> the v50 catalog digest identical -> re-apply; every refusal (migrator lock, not recorded, a later migration, every kind of dependent row)");
test.todo("1c. the preflight blocks read their expected values on a v50 database");

// 2. Black-box scenarios by role (every settings route; bodies compared byte for byte)
test.todo("2a. the club admin of C1 reads and writes C1's catalog, C1's team colours and default places");
test.todo("2b. the admin of C1 and C2 in C1's workspace: a C2 id in a path is the identical 404, in a body the identical 400; a key reused in C2's workspace is request_key_reused; GET /settings lists C1 only");
test.todo("2c. the team coach of T1: GET /settings and every write 403 / the 404; the form's lists are C1's live set with T1's default place; another club's place in locationId is the 400");
test.todo("2d. the private coach: settings 403; the form has the system types and details and no places; locationId is the 400; a club's detail is the 400");
test.todo("2e. the athlete: every settings route 403 / 404");
test.todo("2f. the platform admin in the platform workspace: writes 403 workspace_required, reads 403");
test.todo("2g. a platform admin who also administers C1 (the only way into C1's workspace) writes there on the club_admin basis; the platform workspace has no club picker in K2b-1 (T6)");
test.todo("2h. a stranger, a revoked admin, the admin of an archived club, a team of an archived club: the 404 / 403 everywhere; a role revoked between the route's check and the lock is the 404 body");

// 3. Invariants (each also through a raw SQL write where the database holds it)
test.todo("3a. the read's canEdit equals the write verdict for every caller of the matrix");
test.todo("3b. the meaning freeze: once a detail has a value, label, unit, bounds and option labels refuse a change through the route and through raw SQL; required, description and new options still work");
test.todo("3c. a type's default list and an event's selection hold only details of the owner (raw insert refused)");
test.todo("3d. an archived type, detail, option or place is refused when newly chosen and kept where it already is; restore brings it back, or label_taken");
test.todo("3e. nothing of the catalog is deleted (raw DELETE and TRUNCATE refused); the last live type cannot be archived");
test.todo("3f. every catalog update needs its change row at COMMIT; a seed-shaped insert needs none, a seeded row's update does");
test.todo("3g. requestKey: a replay answers once and re-checks the right; the hash binds the club and the subject");
test.todo("3h. the colour keys: the database's closed list equals the server's and the frontend's palette");
test.todo("3i. T1: the standalone alignment is audited as align_sessions (K2a-1b's test 8 updated with it)");
test.todo("3j. a new club through POST /api/organization/clubs gets the full seed: types, details, options, the types' lists");

// 4. Concurrency (trigger 4)
test.todo("4a. a value racing a detail's edit, each side held, both orders");
test.todo("4b. a type archive racing an event create; a place archive racing an event that sets it");
test.todo("4c. two first PUT /teams/:id; two edits of one type (type_changed with current)");
test.todo("4d. the lost-COMMIT seam of the shared runner: verifiedAfterCommitError and outcome_unknown");
