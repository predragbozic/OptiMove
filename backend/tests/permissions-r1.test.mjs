// Roles plan, step R1: the permission catalog, its groups, the basic roles'
// starting sets and can(). No behaviour change: for every permission
// routes/organization.js checks, can() answers what the predicate it replaced
// answered, for every authorization state in the matrix below. No database is
// reached: can() is a pure function of the authorization context.
//
// Section c (the old role tables keep one word each) reads source text. Its
// limits: it sees a statement that names user_club_roles / user_team_roles
// right after its verb, in the application, the scripts, the tools, e2e and the
// two migration folders. It does not see SQL built at run time from a variable
// table name, a write made inside a database function or trigger body whose
// text is not in those folders (the legacy-schema snapshot, a function created
// by hand), or a write through a view. The CHECK constraints of R2 close that.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.DATABASE_URL, undefined, "Run through the unit test runner, which scrubs database targets");
// permissions.js imports authz.js, which imports db.js, which needs a URL even
// to construct its lazy pool. This unreachable loopback placeholder is never
// connected to.
process.env.DATABASE_URL = "postgresql://permissions_fixture@127.0.0.1:1/permissions_no_database";
const { pool } = await import("../src/db.js");
let databaseAttempts = 0;
const originalQuery = pool.query;
const originalConnect = pool.connect;
pool.query = async () => { databaseAttempts++; throw new Error("Unexpected database access in the permissions test"); };
pool.connect = async () => { databaseAttempts++; throw new Error("Unexpected database checkout in the permissions test"); };
const {
  canAssignClubRole,
  canAssignTeamRole,
  canManageClub,
  canManageTeamById,
  isPlatformAdministrator,
} = await import("../src/authz.js");
const {
  BASIC_ROLE_PERMISSIONS,
  can: canR2,
  clubScope,
  GLOBAL_SCOPE,
  PERMISSION_GROUPS,
  PERMISSIONS,
  teamScope,
} = await import("../src/permissions.js");
// Roles R2 (contract test 32): can() reads the role items the loader brings
// from the database (authz.rolePermissions). The b-tests that call can() with
// hand-built contexts holding no role items (b2, b2x, b2y, b2z, b3, b8) run
// unchanged against R1's own function, kept as the oracle; b2r runs b2's
// comparison again against R2's can() over the same contexts with the seeded
// role items; b4, b6 and b7 test R2's can() with their changed expectations.
// The comparison over contexts loaded from a seeded database is
// permission-roles-v84-equivalence.test.mjs (tests 31 and 31a).
const { canR1, withSeededRoleItems } = await import("./support/permissions-r1-oracle.mjs");
const can = canR1;

after(async () => {
  try {
    assert.equal(databaseAttempts, 0, "can() and the catalog never touch the database");
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await pool.end();
    delete process.env.DATABASE_URL;
  }
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORGANIZATION_JS = fs.readFileSync(path.join(REPO_ROOT, "backend/src/routes/organization.js"), "utf8");

// ---------------------------------------------------------------------------
// a. Catalog integrity
// ---------------------------------------------------------------------------

// The plan's section 3 table, word by word, with where a role carrying the
// word may be assigned.
const PLAN_CATALOG = {
  "org.view": ["club", "team"],
  "org.teams.manage": ["club"],
  "org.club.edit": ["club"], // the 52nd word: the owner's decision of 2026-11-19
  "athletes.view": ["club", "team"],
  "athletes.manage": ["club", "team"],
  "athletes.remove": ["club", "team"],
  "athletes.logins.manage": ["club", "team"],
  "athletes.library_access": ["club", "team"],
  "accounts.manage": ["club"],
  "staff.assign": ["club"],
  "roles.manage": ["club"],
  "join_links.manage": ["club", "team"],
  "programs.view": ["club", "team"],
  "programs.edit": ["club", "team"],
  "programs.assign": ["club", "team"],
  "programs.publish": ["club", "team"],
  "programs.rpe_settings": ["club", "team"],
  "presets.use": ["club", "team"],
  "presets.manage": ["club", "team"],
  "exercise_lists.manage": ["club", "team"],
  "exercises.use": ["club", "team"],
  "exercises.add": ["club", "team"],
  "exercises.media.upload": ["club", "team"],
  "exercises.remove": ["club", "team"],
  "exercises.blocks.manage": ["global"],
  "calendar.view": ["club", "team"],
  "calendar.events.manage": ["club", "team"],
  "calendar.settings.manage": ["club"],
  "load.view.team": ["club", "team"],
  "load.view.athlete": ["club", "team"],
  "load.schedule.manage": ["club", "team"],
  "load.roster.decide": ["club", "team"],
  "load.estimates.manage": ["club", "team"],
  "load.activities.manage": ["club", "team"],
  "dashboards.view": ["club", "team"],
  "dashboards.manage": ["club", "team"],
  "import.check": ["club", "team"],
  "import.link": ["club", "team"],
  "import.approve": ["team"],
  "import.undo": ["team"],
  "tests.view": ["club", "team"],
  "tests.results.view": ["club", "team"],
  "tests.schedule.manage": ["club", "team"],
  "tests.library.manage": ["global"],
  "messages.send": ["club", "team"],
  "variables.view": ["club", "team"],
  "variables.rename_archive": ["club", "team"],
  "variables.manage": ["club"],
  "mappings.manage": ["club"],
  "sources.connect": ["club"],
  "platform.metrics.manage": ["global"],
  "platform.admin": ["global"],
};
const PLATFORM_ONLY = ["exercises.blocks.manage", "platform.admin", "platform.metrics.manage", "tests.library.manage"];
const SYSTEM_ROLE_ONLY = ["accounts.manage", "roles.manage", "staff.assign"];
const GROUP_KEYS = [
  "organization", "athletes", "programs", "exercises", "presets", "calendar",
  "training_load", "dashboards", "imports", "tests", "messages", "data_configuration",
];
const ALL_WORDS = Object.keys(PERMISSIONS);

test("a1. the catalog is exactly the plan's 51 words and org.club.edit (52), each with its scope types", () => {
  assert.equal(Object.keys(PLAN_CATALOG).length, 52);
  assert.equal(ALL_WORDS.length, 52);
  assert.equal(new Set(ALL_WORDS).size, 52);
  assert.deepEqual([...ALL_WORDS].sort(), Object.keys(PLAN_CATALOG).sort());
  for (const word of ALL_WORDS) {
    assert.deepEqual([...PERMISSIONS[word].scopeTypes], PLAN_CATALOG[word], `scope types of ${word}`);
    assert.match(word, /^[a-z_]+(\.[a-z_]+)+$/, `shape of ${word}`);
  }
});

test("a2. platform-only and system-role-only words are exactly the listed ones; a platform-only word is assigned globally and nothing else is", () => {
  assert.deepEqual(ALL_WORDS.filter((w) => PERMISSIONS[w].platformOnly).sort(), PLATFORM_ONLY);
  assert.deepEqual(ALL_WORDS.filter((w) => PERMISSIONS[w].systemRoleOnly).sort(), SYSTEM_ROLE_ONLY);
  for (const word of ALL_WORDS) {
    const entry = PERMISSIONS[word];
    assert.equal(entry.scopeTypes.includes("global"), entry.platformOnly, `${word}: global scope if and only if platform-only`);
    assert.ok(!(entry.platformOnly && entry.systemRoleOnly), `${word}: never both flags`);
    assert.equal(typeof entry.platformOnly, "boolean");
    assert.equal(typeof entry.systemRoleOnly, "boolean");
  }
});

test("a3. twelve groups; every word belongs to exactly one group, and that group is its module", () => {
  assert.deepEqual(PERMISSION_GROUPS.map((g) => g.key), GROUP_KEYS);
  const seen = new Map();
  for (const group of PERMISSION_GROUPS) {
    assert.ok(group.label, `label of ${group.key}`);
    for (const word of group.permissions) {
      assert.ok(Object.hasOwn(PERMISSIONS, word), `${group.key} names the unknown word ${word}`);
      assert.ok(!seen.has(word), `${word} is in two groups`);
      seen.set(word, group.key);
      assert.equal(PERMISSIONS[word].module, group.key, `module of ${word}`);
    }
  }
  assert.equal(seen.size, 52, "every catalog word is in a group");
});

test("a4. levels: start with Off, name only the group's own catalog words, are cumulative, and hold no platform-only word", () => {
  for (const group of PERMISSION_GROUPS) {
    assert.ok(group.levels.length >= 2, `${group.key} has a level besides Off`);
    assert.equal(group.levels[0].key, "off");
    assert.deepEqual([...group.levels[0].permissions], []);
    assert.equal(new Set(group.levels.map((l) => l.key)).size, group.levels.length, `${group.key}: unique level keys`);
    for (let i = 1; i < group.levels.length; i++) {
      const level = group.levels[i];
      const previous = group.levels[i - 1];
      assert.ok(level.label, `${group.key}.${level.key} has a label`);
      assert.equal(new Set(level.permissions).size, level.permissions.length, `${group.key}.${level.key}: no word twice`);
      assert.ok(level.permissions.length > previous.permissions.length, `${group.key}.${level.key} adds something`);
      for (const word of previous.permissions) assert.ok(level.permissions.includes(word), `${group.key}.${level.key} includes ${word} of the level before`);
      for (const word of level.permissions) {
        assert.ok(group.permissions.includes(word), `${group.key}.${level.key} names ${word}, which is not this group's`);
        assert.ok(!PERMISSIONS[word].platformOnly, `${group.key}.${level.key} holds the platform-only word ${word}`);
      }
    }
    // The top level is the whole group, except what only the platform holds.
    const top = group.levels[group.levels.length - 1].permissions;
    assert.deepEqual([...top].sort(), group.permissions.filter((w) => !PERMISSIONS[w].platformOnly).sort(), `${group.key}: the top level`);
  }
});

test("a5. the plan's own notes on the ladders hold", () => {
  const level = (groupKey, levelKey) => PERMISSION_GROUPS.find((g) => g.key === groupKey).levels.find((l) => l.key === levelKey).permissions;
  // variables.rename_archive is in no level below Variables.
  assert.ok(!level("data_configuration", "view").includes("variables.rename_archive"));
  assert.ok(level("data_configuration", "variables").includes("variables.rename_archive"));
  // The three non-delegable words sit only at the top of Organization and staff.
  for (const word of SYSTEM_ROLE_ONLY) {
    assert.ok(!level("organization", "manage_teams").includes(word));
    assert.ok(level("organization", "manage_staff").includes(word));
  }
  assert.deepEqual([...level("imports", "check_link")], ["import.check", "import.link"]);
  assert.deepEqual([...level("tests", "results")], ["tests.view", "tests.results.view"]);
});

test("a6. the catalog, the groups and the basic sets are frozen", () => {
  assert.ok(Object.isFrozen(PERMISSIONS));
  for (const word of ALL_WORDS) {
    assert.ok(Object.isFrozen(PERMISSIONS[word]), word);
    assert.ok(Object.isFrozen(PERMISSIONS[word].scopeTypes), word);
  }
  assert.ok(Object.isFrozen(PERMISSION_GROUPS));
  for (const group of PERMISSION_GROUPS) {
    assert.ok(Object.isFrozen(group) && Object.isFrozen(group.permissions) && Object.isFrozen(group.levels), group.key);
    for (const level of group.levels) assert.ok(Object.isFrozen(level) && Object.isFrozen(level.permissions), `${group.key}.${level.key}`);
  }
  assert.ok(Object.isFrozen(BASIC_ROLE_PERMISSIONS));
  for (const role of Object.keys(BASIC_ROLE_PERMISSIONS)) assert.ok(Object.isFrozen(BASIC_ROLE_PERMISSIONS[role]), role);
  assert.ok(Object.isFrozen(GLOBAL_SCOPE));
});

// ---------------------------------------------------------------------------
// b. Old predicate against can(), for every permission organization.js uses
// ---------------------------------------------------------------------------

const CLUB_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const CLUB_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const TEAM_T1 = "aaaaaaaa-1111-4000-8000-000000000001"; // in club A
const TEAM_T2 = "bbbbbbbb-2222-4000-8000-000000000002"; // in club B
const UNKNOWN_ID = "cccccccc-9999-4000-8000-00000000000c";

// The shape loadAuthorizationContext returns. managedTeamIds is what it loads:
// the teams of the clubs the account holds club_admin in, and nothing else.
function context({ platform = false, clubRoles = [], teamRoles = [], independentCoach = false, athlete = false, userId = "user", managedTeamIds: extraManagedTeamIds = [] } = {}) {
  const managedTeamIds = [...extraManagedTeamIds];
  for (const row of clubRoles) {
    if (row.role !== "club_admin") continue;
    if (row.clubId === CLUB_A) managedTeamIds.push(TEAM_T1);
    if (row.clubId === CLUB_B) managedTeamIds.push(TEAM_T2);
  }
  return {
    userId,
    roleHint: null,
    platformRoles: platform ? ["platform_admin"] : [],
    clubRoles,
    teamRoles,
    managedTeamIds,
    isIndependentCoach: independentCoach,
    isAthlete: athlete,
    athleteId: athlete ? "athlete" : null,
  };
}

const CONTEXTS = {
  "no user": context({ userId: null }),
  "athlete only": context({ athlete: true }),
  "independent coach": context({ independentCoach: true }),
  "platform admin": context({ platform: true }),
  "club admin of A": context({ clubRoles: [{ clubId: CLUB_A, role: "club_admin" }] }),
  "club admin of A and B": context({ clubRoles: [{ clubId: CLUB_A, role: "club_admin" }, { clubId: CLUB_B, role: "club_admin" }] }),
  "team coach of T1": context({ teamRoles: [{ teamId: TEAM_T1, role: "team_coach" }] }),
  "team coach of T2": context({ teamRoles: [{ teamId: TEAM_T2, role: "team_coach" }] }),
  "club admin of A and team coach of T2": context({ clubRoles: [{ clubId: CLUB_A, role: "club_admin" }], teamRoles: [{ teamId: TEAM_T2, role: "team_coach" }] }),
  "club admin of A and team coach of T1": context({ clubRoles: [{ clubId: CLUB_A, role: "club_admin" }], teamRoles: [{ teamId: TEAM_T1, role: "team_coach" }] }),
  "platform admin and club admin of A": context({ platform: true, clubRoles: [{ clubId: CLUB_A, role: "club_admin" }] }),
  "platform admin, independent coach and athlete": context({ platform: true, independentCoach: true, athlete: true }),
  // Rows whose word is not the basic one (old data shown read-only): they give nothing.
  "other words: club_manager of A, team_trainer of T1": context({ clubRoles: [{ clubId: CLUB_A, role: "club_manager" }], teamRoles: [{ teamId: TEAM_T1, role: "team_trainer" }] }),
  "other words everywhere, with an athlete profile": context({
    athlete: true,
    independentCoach: true,
    clubRoles: [{ clubId: CLUB_A, role: "team_coach" }, { clubId: CLUB_B, role: "coach" }],
    teamRoles: [{ teamId: TEAM_T1, role: "club_admin" }, { teamId: TEAM_T2, role: "team_admin" }],
  }),
};

const SCOPES = {
  global: [["global", GLOBAL_SCOPE, null]],
  club: [CLUB_A, CLUB_B, UNKNOWN_ID, "", undefined, null, "not-a-uuid"].map((id) => [`club ${String(id)}`, clubScope(id), id]),
  team: [TEAM_T1, TEAM_T2, UNKNOWN_ID, "", undefined, null, "not-a-uuid"].map((id) => [`team ${String(id)}`, teamScope(id), id]),
};

// Contexts loadAuthorizationContext cannot produce (the id columns are NOT NULL
// uuids), kept to pin can()'s own guards: a role row or a managed team without
// an id must give nothing at global scope and nothing at a scope without an id.
const DEGENERATE_CONTEXTS = {
  "a team coach row without a team id": context({ teamRoles: [{ teamId: undefined, role: "team_coach" }] }),
  "a club admin row without a club id, managing a team without an id": context({ clubRoles: [{ clubId: undefined, role: "club_admin" }], managedTeamIds: [undefined] }),
  "rows with null and empty ids": context({
    clubRoles: [{ clubId: null, role: "club_admin" }, { clubId: "", role: "club_admin" }],
    teamRoles: [{ teamId: null, role: "team_coach" }, { teamId: "", role: "team_coach" }],
    managedTeamIds: [null, ""],
  }),
};
const isNoId = (id) => id === undefined || id === null || id === "";
// Which teams each club of the matrix has, for the seeded contexts of R2.
const TEAMS_OF_CLUB = { [CLUB_A]: [TEAM_T1], [CLUB_B]: [TEAM_T2] };
const seeded = (authz) => withSeededRoleItems(authz, TEAMS_OF_CLUB);

// The predicates of authz.js that the call sites of routes/organization.js used before R1.
const OLD = {
  isPlatformAdministrator: (authz) => isPlatformAdministrator(authz),
  canManageClub,
  canManageTeamById,
  canAssignClubRole,
  canAssignTeamRole,
};
// Which resource each old predicate was given, so the table cannot pair a club
// predicate with a team scope.
const OLD_SCOPE_TYPE = {
  isPlatformAdministrator: "global",
  canManageClub: "club",
  canAssignClubRole: "club",
  canManageTeamById: "team",
  canAssignTeamRole: "team",
};

// EVERY can() call of routes/organization.js, per handler and in source order:
// [permission, the exact scope expression, "!can" (the guard refuses unless it
// passes) or "can" (its value is used as it is), the predicate that stood there
// before R1]. A handler is `METHOD path` for a route and the function's name
// for a named function. b1 extracts the first three from the source and
// compares them with this table; b2 compares can() with the fourth.
const ROUTE_TABLE = {
  "GET /": [
    ["platform.admin", "GLOBAL_SCOPE", "can", "isPlatformAdministrator"],
    ["staff.assign", "clubScope(club.id)", "can", "canAssignClubRole"],
    ["staff.assign", "teamScope(team.id)", "can", "canAssignTeamRole"],
  ],
  // Roles R4-2 (contract 5.1): GET / for a view workspace. No predicate stood here before (the route was behind
  // requireCoach); for an account of the old tables org.view on a club is the club's admin, on a team its managers.
  viewWorkspaceOrganization: [
    ["org.view", "clubScope(scopeId)", "can", "canManageClub"],
    ["org.view", "teamScope(scopeId)", "can", "canManageTeamById"],
  ],
  "GET /clubs-summary": [["platform.admin", "GLOBAL_SCOPE", "can", "isPlatformAdministrator"]],
  "POST /users/:userId/email-change/request": [["accounts.manage", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "POST /users/:userId/email-change/resend": [["accounts.manage", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "POST /users/:userId/email-change/cancel": [["accounts.manage", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "GET /users/:userId/account": [["accounts.manage", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "GET /users/:userId/email-change/status": [["accounts.manage", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "POST /users/:userId/password-reset/send": [["accounts.manage", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "PUT /users/:userId/global-roles/:role": [["platform.admin", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "DELETE /users/:userId/global-roles/:role": [["platform.admin", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "POST /clubs": [["platform.admin", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "PUT /clubs/:clubId": [["org.club.edit", "clubScope(req.params.clubId)", "!can", "canManageClub"]],
  "DELETE /clubs/:clubId": [["platform.admin", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "POST /teams": [["org.teams.manage", "clubScope(clubId)", "!can", "canManageClub"]],
  "PUT /teams/:teamId": [
    ["org.view", "teamScope(req.params.teamId)", "!can", "canManageTeamById"],
    ["org.teams.manage", "clubScope(String(team.club_id))", "!can", "canManageClub"],
  ],
  "PUT /teams/:teamId/restore": [
    ["platform.admin", "GLOBAL_SCOPE", "can", "isPlatformAdministrator"],
    ["org.teams.manage", "clubScope(String(row.club_id))", "!can", "canManageClub"],
  ],
  "DELETE /teams/:teamId": [
    ["platform.admin", "GLOBAL_SCOPE", "can", "isPlatformAdministrator"],
    ["org.teams.manage", "clubScope(String(row.club_id))", "!can", "canManageClub"],
  ],
  "POST /teams/:teamId/athletes": [
    ["athletes.manage", "teamScope(teamId)", "!can", "canManageTeamById"],
    ["platform.admin", "GLOBAL_SCOPE", "can", "isPlatformAdministrator"],
  ],
  "DELETE /athletes/:athleteId/archive-profile": [["athletes.remove", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "PUT /athletes/:athleteId/restore-profile": [["athletes.remove", "GLOBAL_SCOPE", "!can", "isPlatformAdministrator"]],
  "DELETE /teams/:teamId/athletes/:athleteId": [["athletes.remove", "teamScope(req.params.teamId)", "!can", "canManageTeamById"]],
  "PUT /teams/:teamId/athletes/:athleteId/restore": [["athletes.manage", "teamScope(req.params.teamId)", "!can", "canManageTeamById"]],
  "DELETE /clubs/:clubId/athletes/:athleteId": [["athletes.remove", "clubScope(req.params.clubId)", "!can", "canManageClub"]],
  "PUT /clubs/:clubId/athletes/:athleteId/restore": [["athletes.manage", "clubScope(req.params.clubId)", "!can", "canManageClub"]],
  grantClubAdminRole: [["staff.assign", "clubScope(clubId)", "!can", "canAssignClubRole"]],
  revokeClubAdminRole: [["staff.assign", "clubScope(clubId)", "!can", "canAssignClubRole"]],
  grantTeamCoachRole: [["staff.assign", "teamScope(teamId)", "!can", "canAssignTeamRole"]],
  revokeTeamCoachRole: [["staff.assign", "teamScope(teamId)", "!can", "canAssignTeamRole"]],
  // The club's admin seeing its club's members in Settings > Users (2026-11-22); no predicate stood here before, the
  // club's admin predicate is the one it means.
  clubMembersViewClubId: [["staff.assign", "clubScope(workspace.scopeId)", "can", "canAssignClubRole"]],
  resolveAthleteClubTeam: [
    ["athletes.manage", "clubScope(clubId)", "!can", "canManageClub"],
    ["athletes.manage", "teamScope(teamId)", "!can", "canManageTeamById"],
  ],
};

function scopeTypeOfSourceExpression(expression) {
  if (expression === "GLOBAL_SCOPE") return "global";
  if (expression.startsWith("clubScope(")) return "club";
  if (expression.startsWith("teamScope(")) return "team";
  return `unrecognised: ${expression}`;
}

const CALL_SITES = Object.entries(ROUTE_TABLE).flatMap(([handler, sites]) => sites.map(([permission, scopeExpression, shape, oldName], index) => ({
  handler, index, permission, scopeExpression, shape, oldName, scopeType: scopeTypeOfSourceExpression(scopeExpression), old: OLD[oldName],
})));
// One row per (permission, scope type) the file uses, with the predicate it replaced.
const REPLACED = [...new Map(CALL_SITES.map((s) => [`${s.permission} @ ${s.scopeType}`, { permission: s.permission, scopeType: s.scopeType, oldName: s.oldName, old: s.old }])).values()];
const USED_WORDS = [...new Set(REPLACED.map((r) => r.permission))].sort();

// The source with every comment blanked (same length, same lines), so a can()
// written in a comment is never taken for a call. Strings are kept.
function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (two === "//") { while (i < n && text[i] !== "\n") { out += " "; i++; } continue; }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch; i++;
      while (i < n && text[i] !== ch) { if (text[i] === "\\") { out += text[i]; i++; } out += text[i]; i++; }
      out += text[i] ?? ""; i++;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

// handler -> [[permission, scope expression, "!can" | "can"]], from the code.
function extractCanCalls(source) {
  const code = stripComments(source);
  // Top-level declarations start in column 0; nothing nested does.
  const heads = [...code.matchAll(/^(?:router\.(get|put|post|delete|patch)\(\s*"([^"]+)"|(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\()/gm)]
    .map((m) => ({ at: m.index, key: m[1] ? `${m[1].toUpperCase()} ${m[2]}` : m[3] }));
  const table = {};
  let recognised = 0;
  for (const m of code.matchAll(/(!?)(?<![\w.$])can\(\s*req\.authz\s*,\s*"([^"]+)"\s*,\s*/g)) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    for (; j < code.length && depth > 0; j++) {
      if (code[j] === "(") depth++;
      else if (code[j] === ")") depth--;
    }
    const head = heads.filter((h) => h.at < m.index).pop();
    (table[head ? head.key : "(outside any handler)"] ||= []).push([m[2], code.slice(start, j - 1).trim(), m[1] === "!" ? "!can" : "can"]);
    recognised++;
  }
  return { table, recognised, anyCanCall: [...code.matchAll(/(?<![\w.$])can\s*\(/g)].length, code };
}

test("b1. the per-call-site table is exactly the can() calls of routes/organization.js: handler, order, word, scope expression, negation", () => {
  const { table, recognised, anyCanCall, code } = extractCanCalls(ORGANIZATION_JS);
  assert.equal(code.length, ORGANIZATION_JS.length);
  // Every can( in the code is a recognised call: req.authz, a literal word, then the scope.
  assert.equal(recognised, anyCanCall, "every can() call names req.authz and a literal permission");
  const expected = Object.fromEntries(Object.entries(ROUTE_TABLE).map(([handler, sites]) => [handler, sites.map(([word, scope, shape]) => [word, scope, shape])]));
  assert.deepEqual(table, expected);
  assert.deepEqual(Object.keys(table), Object.keys(ROUTE_TABLE), "handlers in source order");
  assert.equal(Object.keys(ROUTE_TABLE).length, 31);
  assert.equal(CALL_SITES.length, 39);
  // The comment that mentions can() is not a call: the raw text has one more.
  assert.equal([...ORGANIZATION_JS.matchAll(/(?<![\w.$])can\(req\.authz\b/g)].length, 40);
  for (const site of CALL_SITES) {
    assert.ok(Object.hasOwn(PERMISSIONS, site.permission), `${site.handler}: ${site.permission} is a catalog word`);
    assert.ok(OLD[site.oldName], `${site.handler}: ${site.oldName} is a predicate of authz.js`);
    assert.equal(site.scopeType, OLD_SCOPE_TYPE[site.oldName], `${site.handler} #${site.index}: ${site.oldName} was given a ${OLD_SCOPE_TYPE[site.oldName]} resource`);
  }
  // A (word, scope type) pair replaced one predicate everywhere, so REPLACED loses nothing.
  for (const site of CALL_SITES) {
    const row = REPLACED.find((r) => r.permission === site.permission && r.scopeType === site.scopeType);
    assert.equal(row.oldName, site.oldName, `${site.handler} #${site.index}`);
  }
});

test("b1x. the extraction's own rule: a comment is no call, a changed word, scope, negation or order is seen", () => {
  const sample = [
    'router.put("/x/:id", async (req, res) => {',
    '  // if (!can(req.authz, "platform.admin", GLOBAL_SCOPE)) never counted',
    '  /* can(req.authz, "org.view", teamScope(id)) */',
    '  const text = "can(req.authz, \\"org.view\\", GLOBAL_SCOPE) // in a string";',
    '  if (!can(req.authz, "org.view", teamScope(req.params.id))) return res.status(403).json({});',
    '  if (!row.club_id || !can(req.authz, "org.teams.manage", clubScope(String(row.club_id)))) return;',
    '});',
    'async function helper(req, id) {',
    '  return can(req.authz, "staff.assign", teamScope(id)) ? 1 : 2;',
    '}',
  ].join("\n");
  const { table, recognised, anyCanCall } = extractCanCalls(sample);
  assert.deepEqual(table, {
    "PUT /x/:id": [["org.view", "teamScope(req.params.id)", "!can"], ["org.teams.manage", "clubScope(String(row.club_id))", "!can"]],
    helper: [["staff.assign", "teamScope(id)", "can"]],
  });
  assert.equal(recognised, 3);
  // The text inside a string is kept, so a can( written in a string is counted here and
  // recognised nowhere: b1 would fail on it rather than skip it (fail closed).
  assert.equal(anyCanCall, 4);
  // A call the pattern does not recognise (a dynamic word, another authz) is counted by anyCanCall only.
  const odd = extractCanCalls('function f(req, word) {\n  return can(req.authz, word, GLOBAL_SCOPE) || can(other, "org.view", GLOBAL_SCOPE);\n}');
  assert.equal(odd.recognised, 0);
  assert.equal(odd.anyCanCall, 2);
});

test("b2. at every call site, can() equals the predicate that stood there, for every context and every resource", () => {
  let compared = 0;
  for (const site of CALL_SITES) {
    const where = `${site.handler} #${site.index}: ${site.permission} (was ${site.oldName})`;
    for (const [contextName, authz] of Object.entries(CONTEXTS)) {
      for (const [scopeName, scope, id] of SCOPES[site.scopeType]) {
        const expected = site.old(authz, id);
        assert.equal(typeof expected, "boolean");
        assert.equal(can(authz, site.permission, scope), expected, `${where} on ${scopeName} for "${contextName}"`);
        compared++;
      }
    }
    // Contexts the loader cannot produce: the old predicate's answer wherever the resource has an id,
    // and nothing where it has none (the old text comparison would have matched "undefined" with "undefined").
    for (const [contextName, authz] of Object.entries(DEGENERATE_CONTEXTS)) {
      for (const [scopeName, scope, id] of SCOPES[site.scopeType]) {
        const expected = site.scopeType !== "global" && isNoId(id) ? false : site.old(authz, id);
        assert.equal(can(authz, site.permission, scope), expected, `${where} on ${scopeName} for "${contextName}"`);
        compared++;
      }
    }
  }
  const global = CALL_SITES.filter((s) => s.scopeType === "global").length;
  assert.equal(global, 17);
  assert.equal(compared, (global * 1 + (CALL_SITES.length - global) * 7) * (Object.keys(CONTEXTS).length + Object.keys(DEGENERATE_CONTEXTS).length));
});

test("b2r. (R2) b2 again against R2's can() over the same contexts with the seeded role items: every call site, every context, every resource", () => {
  let compared = 0;
  for (const site of CALL_SITES) {
    for (const [contextName, authz] of Object.entries({ ...CONTEXTS, ...DEGENERATE_CONTEXTS })) {
      for (const [scopeName, scope] of SCOPES[site.scopeType]) {
        assert.equal(canR2(seeded(authz), site.permission, scope), canR1(authz, site.permission, scope),
          `${site.handler} #${site.index}: ${site.permission} on ${scopeName} for "${contextName}"`);
        compared++;
      }
    }
  }
  assert.ok(compared > 0);
});

test("b2x. a scope without an id is no resource: nobody but a platform admin passes it, whatever rows the context holds", () => {
  const everyContext = { ...CONTEXTS, ...DEGENERATE_CONTEXTS };
  for (const [name, authz] of Object.entries(everyContext)) {
    const platform = authz.platformRoles.length > 0;
    for (const word of ALL_WORDS) {
      for (const id of [undefined, null, ""]) {
        assert.equal(can(authz, word, clubScope(id)), platform, `${name}: ${word} on a club ${String(id)}`);
        assert.equal(can(authz, word, teamScope(id)), platform, `${name}: ${word} on a team ${String(id)}`);
        assert.equal(can(authz, word, { type: "club" }), platform, `${name}: ${word} on a club scope with no id field`);
      }
      // Global scope never falls through to a role row, with or without an id on the scope object.
      assert.equal(can(authz, word, GLOBAL_SCOPE), platform, `${name}: ${word} globally`);
      assert.equal(can(authz, word, { type: "global", id: TEAM_T1 }), platform, `${name}: ${word} globally, a stray id ignored`);
    }
  }
  // The degenerate rows really are the ones the old text comparison would have matched.
  assert.equal(canManageTeamById(DEGENERATE_CONTEXTS["a team coach row without a team id"], undefined), true);
  assert.equal(canManageClub(DEGENERATE_CONTEXTS["rows with null and empty ids"], ""), true);
});

test("b2y. PUT /teams/:teamId: whoever passes only the first gate (org.view on the team) is refused by the second (org.teams.manage on the team's club)", () => {
  assert.deepEqual(ROUTE_TABLE["PUT /teams/:teamId"].map(([word, scope]) => `${word} ${scope}`), ["org.view teamScope(req.params.teamId)", "org.teams.manage clubScope(String(team.club_id))"]);
  const coach = CONTEXTS["team coach of T1"];
  assert.equal(can(coach, "org.view", teamScope(TEAM_T1)), true, "the team's coach passes the first gate, as today");
  assert.equal(can(coach, "org.teams.manage", clubScope(CLUB_A)), false, "and is refused by the club check");
  assert.equal(can(coach, "org.teams.manage", teamScope(TEAM_T1)), false, "org.teams.manage is not the coach's at the team either");
  // For every context and both teams: the edit goes through exactly for a platform admin and the admin of the team's club.
  const clubOf = { [TEAM_T1]: CLUB_A, [TEAM_T2]: CLUB_B };
  let onlyFirstGate = 0;
  for (const [name, authz] of Object.entries({ ...CONTEXTS, ...DEGENERATE_CONTEXTS })) {
    for (const team of [TEAM_T1, TEAM_T2]) {
      const first = can(authz, "org.view", teamScope(team));
      const second = can(authz, "org.teams.manage", clubScope(clubOf[team]));
      const mayEdit = authz.platformRoles.length > 0 || authz.clubRoles.some((r) => r.role === "club_admin" && r.clubId === clubOf[team]);
      assert.equal(first && second, mayEdit, `${name}: edit of ${team}`);
      assert.ok(first || !second, `${name}: nobody passes the club check without passing the team check (${team})`);
      if (first && !second) onlyFirstGate++;
    }
  }
  assert.ok(onlyFirstGate >= 3, "the matrix holds accounts that pass only the first gate (the teams' coaches)");
  // The transitional note stands at that gate.
  assert.match(ORGANIZATION_JS, /\/\/ Transitional \(roles R1\): "org\.view" reproduces today's first gate[^\n]*\n(?:\s*\/\/[^\n]*\n)+\s*if \(!can\(req\.authz, "org\.view", teamScope\(req\.params\.teamId\)\)\)/);
});

test("b2z. every (word, scope type) organization.js checks is one the word may be assigned for, or one of the two stated conventions", () => {
  const classified = REPLACED.map((r) => {
    const assignable = PERMISSIONS[r.permission].scopeTypes;
    let basis;
    if (assignable.includes(r.scopeType)) basis = "assignable";
    else if (r.scopeType === "global") basis = "convention 1: global scope, a platform admin only";
    else if (r.scopeType === "team" && assignable.includes("club")) basis = "convention 2: a club's word at a team of that club";
    else basis = "NOT COVERED";
    return `${r.permission} @ ${r.scopeType}: ${basis}`;
  }).sort();
  assert.deepEqual(classified, [
    "accounts.manage @ global: convention 1: global scope, a platform admin only",
    "athletes.manage @ club: assignable",
    "athletes.manage @ team: assignable",
    "athletes.remove @ club: assignable",
    "athletes.remove @ global: convention 1: global scope, a platform admin only",
    "athletes.remove @ team: assignable",
    "org.club.edit @ club: assignable",
    "org.teams.manage @ club: assignable",
    "org.view @ club: assignable",
    "org.view @ team: assignable",
    "platform.admin @ global: assignable",
    "staff.assign @ club: assignable",
    "staff.assign @ team: convention 2: a club's word at a team of that club",
  ]);
  // Convention 1 for every word, convention 2 never for the team's own coach unless the word is the coach's too.
  for (const [name, authz] of Object.entries(CONTEXTS)) {
    for (const word of ALL_WORDS) assert.equal(can(authz, word, GLOBAL_SCOPE), authz.platformRoles.length > 0, `${name}: ${word}`);
  }
  assert.equal(can(CONTEXTS["club admin of A"], "staff.assign", teamScope(TEAM_T1)), true);
  assert.equal(can(CONTEXTS["team coach of T1"], "staff.assign", teamScope(TEAM_T1)), false);
  // permissions.js states both conventions for the SQL twin of R2.
  const permissionsSource = fs.readFileSync(path.join(REPO_ROOT, "backend/src/permissions.js"), "utf8");
  assert.match(permissionsSource, /global scope = a platform admin only, WHATEVER the word/);
  assert.match(permissionsSource, /a club's word holds at a team under that club/);
  assert.match(permissionsSource, /SQL twin of R2[\s\S]{0,80}must copy exactly/);
});

test("b3. the expected answers themselves, spelled out for the main cases", () => {
  const c = CONTEXTS;
  const yes = (name, permission, scope) => assert.equal(can(c[name], permission, scope), true, `${name}: ${permission}`);
  const no = (name, permission, scope) => assert.equal(can(c[name], permission, scope), false, `${name}: ${permission}`);
  // The club's admin: its club and its club's teams, never another club.
  yes("club admin of A", "org.teams.manage", clubScope(CLUB_A));
  no("club admin of A", "org.teams.manage", clubScope(CLUB_B));
  yes("club admin of A", "staff.assign", clubScope(CLUB_A));
  yes("club admin of A", "staff.assign", teamScope(TEAM_T1));
  no("club admin of A", "staff.assign", teamScope(TEAM_T2));
  yes("club admin of A", "athletes.remove", teamScope(TEAM_T1));
  no("club admin of A", "athletes.remove", teamScope(TEAM_T2));
  // The team's coach: day-to-day work on its own team, never the club's decisions.
  yes("team coach of T1", "athletes.manage", teamScope(TEAM_T1));
  yes("team coach of T1", "athletes.remove", teamScope(TEAM_T1));
  yes("team coach of T1", "org.view", teamScope(TEAM_T1));
  no("team coach of T1", "athletes.manage", teamScope(TEAM_T2));
  no("team coach of T1", "athletes.manage", clubScope(CLUB_A));
  no("team coach of T1", "staff.assign", teamScope(TEAM_T1));
  no("team coach of T1", "staff.assign", clubScope(CLUB_A));
  no("team coach of T1", "org.teams.manage", clubScope(CLUB_A));
  // Scopes stay apart: a club admin of A who coaches T2 in club B.
  yes("club admin of A and team coach of T2", "athletes.manage", teamScope(TEAM_T2));
  no("club admin of A and team coach of T2", "staff.assign", teamScope(TEAM_T2));
  no("club admin of A and team coach of T2", "org.teams.manage", clubScope(CLUB_B));
  // Global scope: a platform admin only, whatever else the account holds.
  for (const name of Object.keys(c)) {
    const platform = c[name].platformRoles.length > 0;
    for (const word of ALL_WORDS) assert.equal(can(c[name], word, GLOBAL_SCOPE), platform, `${name}: ${word} globally`);
  }
  // A role row with another word gives nothing, anywhere.
  for (const name of ["other words: club_manager of A, team_trainer of T1", "other words everywhere, with an athlete profile", "no user", "athlete only", "independent coach"]) {
    for (const word of ALL_WORDS) {
      for (const type of ["club", "team"]) {
        for (const [scopeName, scope] of SCOPES[type]) assert.equal(can(c[name], word, scope), false, `${name}: ${word} on ${scopeName}`);
      }
    }
  }
});

test("b4. (R2) a platform admin passes every permission in every scope; a permission no module has moved to passes for nobody else - apart from roles.manage, which the seed gives to a club's admin at its club and its club's teams", () => {
  const notUsed = ALL_WORDS.filter((w) => !USED_WORDS.includes(w));
  assert.equal(notUsed.length, 52 - USED_WORDS.length);
  assert.ok(notUsed.includes("roles.manage"), "no call site of organization.js names roles.manage");
  const adminOf = (authz, id) => authz.clubRoles.some((r) => r.role === "club_admin" && r.clubId === id);
  for (const [name, plain] of Object.entries(CONTEXTS)) {
    const authz = seeded(plain);
    const platform = authz.platformRoles.length > 0;
    for (const type of ["global", "club", "team"]) {
      for (const [scopeName, scope] of SCOPES[type]) {
        for (const word of ALL_WORDS) {
          if (platform) assert.equal(canR2(authz, word, scope), true, `${name}: ${word} on ${scopeName}`);
        }
        for (const word of notUsed) {
          if (platform) continue;
          // The one changed expectation (O1 (b)): roles.manage for a club's admin, by convention 2 also at its teams.
          const club = type === "club" ? scope.id : type === "team" ? Object.keys(TEAMS_OF_CLUB).find((c) => TEAMS_OF_CLUB[c].includes(scope.id)) : null;
          const expected = word === "roles.manage" && club != null && adminOf(authz, club);
          assert.equal(canR2(authz, word, scope), expected, `${name}: ${word} on ${scopeName}`);
        }
      }
    }
  }
});

test("b5. the basic sets: platform admin everything; club admin and team coach hold only words organization.js uses, and exactly the derived ones", () => {
  assert.deepEqual(Object.keys(BASIC_ROLE_PERMISSIONS).sort(), ["club_admin", "platform_admin", "team_coach"]);
  assert.deepEqual([...BASIC_ROLE_PERMISSIONS.platform_admin].sort(), [...ALL_WORDS].sort());
  assert.deepEqual([...BASIC_ROLE_PERMISSIONS.club_admin].sort(), ["athletes.manage", "athletes.remove", "org.club.edit", "org.teams.manage", "org.view", "staff.assign"]);
  assert.deepEqual([...BASIC_ROLE_PERMISSIONS.team_coach].sort(), ["athletes.manage", "athletes.remove", "org.view"]);
  for (const role of ["club_admin", "team_coach"]) {
    const words = BASIC_ROLE_PERMISSIONS[role];
    assert.equal(new Set(words).size, words.length, `${role}: no word twice`);
    for (const word of words) {
      assert.ok(Object.hasOwn(PERMISSIONS, word), `${role}: ${word} is a catalog word`);
      assert.ok(USED_WORDS.includes(word), `${role}: ${word} is used by organization.js`);
      assert.ok(!PERMISSIONS[word].platformOnly, `${role}: ${word} is not platform-only`);
    }
  }
  // Plan 2.1 rule 7: nothing a team coach holds exceeds the club admin; rule 5: a coach never holds a non-delegable word.
  for (const word of BASIC_ROLE_PERMISSIONS.team_coach) {
    assert.ok(BASIC_ROLE_PERMISSIONS.club_admin.includes(word), `club admin also holds ${word}`);
    assert.ok(!PERMISSIONS[word].systemRoleOnly, `team coach does not hold ${word}`);
    assert.ok(PERMISSIONS[word].scopeTypes.includes("team"), `${word} may be assigned for a team`);
  }
  // The derivation's other direction: a word checked for a club or a team is in the Club admin set.
  for (const row of REPLACED) {
    if (row.scopeType !== "global") assert.ok(BASIC_ROLE_PERMISSIONS.club_admin.includes(row.permission), row.permission);
  }
});

test("b6. (R2) an unknown permission or scope is a programming error: can() throws, also for a platform admin; the scope type private no longer throws (O9)", () => {
  for (const authz of [CONTEXTS["platform admin"], CONTEXTS["club admin of A"], CONTEXTS["no user"]].map(seeded)) {
    for (const word of ["org.teams.managee", "", undefined, null, "toString", "constructor", "__proto__", "hasOwnProperty", "ORG.VIEW", "org.view "]) {
      assert.throws(() => canR2(authz, word, clubScope(CLUB_A)), /Unknown permission/, `word ${String(word)}`);
    }
    for (const scope of [undefined, null, {}, { type: "platform" }, { id: CLUB_A }, "club", { type: "Club", id: CLUB_A }, { type: "Private", id: CLUB_A }]) {
      assert.throws(() => canR2(authz, "org.view", scope), /Unknown permission scope type/, `scope ${JSON.stringify(scope)}`);
    }
    // No word has a private scope row in R2 and the Independent coach role has no items:
    // a private check passes for a platform admin only.
    assert.equal(canR2(authz, "org.view", { type: "private", id: CLUB_A }), authz.platformRoles.length > 0);
  }
});

test("b7. (R2) can() reads only the roles of the authorization context: never a workspace, role_hint, or anything else; R2 adds rolePermissions to the fields it may read", () => {
  const ALLOWED = new Set(["platformRoles", "clubRoles", "teamRoles", "managedTeamIds", "rolePermissions"]);
  for (const [name, plain] of Object.entries(CONTEXTS)) {
    const authz = seeded(plain);
    const read = new Set();
    // No workspace field exists on this object at all; reading one (or any other field) throws.
    const guarded = new Proxy({ platformRoles: authz.platformRoles, clubRoles: authz.clubRoles, teamRoles: authz.teamRoles, managedTeamIds: authz.managedTeamIds, rolePermissions: authz.rolePermissions }, {
      get(target, property) {
        if (typeof property === "string" && !ALLOWED.has(property)) throw new Error(`can() read authz.${property}`);
        read.add(property);
        return target[property];
      },
      has(target, property) {
        throw new Error(`can() probed authz for ${String(property)}`);
      },
    });
    for (const row of REPLACED) {
      for (const [scopeName, scope, id] of SCOPES[row.scopeType]) {
        assert.equal(canR2(guarded, row.permission, scope), row.old(authz, id), `${row.permission} on ${scopeName} for "${name}"`);
      }
    }
    assert.ok(read.has("platformRoles"));
  }
  // The same account answers the same whatever workspace fields a caller might attach.
  for (const workspace of [{ type: "club", scopeId: CLUB_B }, { type: "team", scopeId: TEAM_T2 }, { type: "platform", scopeId: null }, { type: "athlete" }]) {
    const withWorkspace = { ...seeded(CONTEXTS["club admin of A"]), activeWorkspace: workspace, workspace, activeWorkspaceType: workspace.type, activeWorkspaceScopeId: workspace.scopeId };
    assert.equal(canR2(withWorkspace, "org.teams.manage", clubScope(CLUB_A)), true);
    assert.equal(canR2(withWorkspace, "org.teams.manage", clubScope(CLUB_B)), false);
    assert.equal(canR2(withWorkspace, "staff.assign", teamScope(TEAM_T2)), false);
    assert.equal(canR2(withWorkspace, "platform.admin", GLOBAL_SCOPE), false);
  }
});

test("b8. ids are compared as text, as the old predicates compare them", () => {
  const numeric = context({ clubRoles: [{ clubId: 7, role: "club_admin" }], teamRoles: [{ teamId: 9, role: "team_coach" }] });
  assert.equal(can(numeric, "org.teams.manage", clubScope("7")), canManageClub(numeric, "7"));
  assert.equal(can(numeric, "org.teams.manage", clubScope("7")), true);
  assert.equal(can(numeric, "athletes.manage", teamScope("9")), canManageTeamById(numeric, "9"));
  assert.equal(can(numeric, "athletes.manage", teamScope("9")), true);
  assert.equal(can(numeric, "athletes.manage", teamScope("7")), false, "a club id is not a team id");
  assert.equal(can(numeric, "org.teams.manage", clubScope("9")), false, "a team id is not a club id");
});

test("b9. routes/organization.js no longer imports the predicates can() replaced, and keeps the listed ones", () => {
  const authzImport = ORGANIZATION_JS.match(/import \{([^}]*)\} from "\.\.\/authz\.js";/);
  assert.ok(authzImport, "the authz.js import");
  const names = authzImport[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
  // isPlatformAdministrator: the list loaders' SQL branches, the mixed clubRoles.length checks, canManageAthlete(s),
  // setUserLoginStatus's target rule, the response's isPlatformAdmin fact. Nothing else of authz.js's predicates:
  // PUT /clubs/:clubId, the last canManageClub call, checks "org.club.edit" since the owner's decision of 2026-11-19.
  assert.deepEqual(names, ["isPlatformAdministrator", "loadAuthorizationContext"]);
  const code = stripComments(ORGANIZATION_JS);
  for (const gone of ["canManageClub", "canManageTeam", "canManageTeamById", "canAssignClubRole", "canAssignTeamRole", "canUsePlatformAdministration", "authzCanManageClub", "authzCanManageTeam", "authzCanAssignClubRole", "authzCanAssignTeamRole"]) {
    assert.doesNotMatch(code, new RegExp(`\\b${gone}\\b`), `${gone} is neither defined, imported nor called in the code`);
  }
  // Not in the SQL text the file sends either (a comment inside a query named the removed wrappers).
  assert.doesNotMatch(ORGANIZATION_JS, /canManageTeam\b|authzCanManage|authzCanAssign/);
  assert.match(ORGANIZATION_JS, /import \{ can, clubScope, GLOBAL_SCOPE, teamScope \} from "\.\.\/permissions\.js";/);
});

// ---------------------------------------------------------------------------
// c. The old role tables keep one word each (plan 2.1, rule 2)
// ---------------------------------------------------------------------------

// Application code, scripts and tools: no file may write another word. The two
// migration folders: only the allowlisted historical files write these tables
// at all, and each of them only the right literal.
const SCANNED_DIRS = ["backend/src", "backend/scripts", "tools", "e2e"];
const MIGRATION_DIRS = ["migrations", "migrations_v2"];
const MIGRATION_WRITERS = ["migrations/20260730_backfill_club_admin_scope.sql"];
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".sql", ".sh", ".json"]);
const ROLE_TABLES = { user_club_roles: "club_admin", user_team_roles: "team_coach" };

function sourceFiles(dir) {
  const out = [];
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name)) && entry.name !== "package-lock.json") out.push(rel);
  }
  return out;
}

// A .sql file's `--` comments are not statements (a commented-out example is no write).
function withoutSqlLineComments(text) {
  return text.replace(/--[^\n]*/g, (comment) => " ".repeat(comment.length));
}

// Every statement that writes one of the two tables, with its text up to the
// end of the statement: a `;`, the backtick that closes a JavaScript template,
// or 3000 characters.
function roleTableWrites(text) {
  const writes = [];
  const pattern = /\b(insert\s+into|update|merge\s+into|copy|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(user_club_roles|user_team_roles)"?(?![\w])/gi;
  for (const match of text.matchAll(pattern)) {
    const rest = text.slice(match.index, match.index + 3000);
    const end = rest.search(/[`;]/);
    writes.push({ verb: match[1].toLowerCase().replace(/\s+/g, " "), table: match[2].toLowerCase(), statement: end === -1 ? rest : rest.slice(0, end), index: match.index });
  }
  return writes;
}

// Splits at top-level commas: not inside parentheses, not inside a quoted string.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end + 1;
      current += text.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

// The index just past the parenthesis that closes the one opened at `open`; -1 when it never closes.
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "'") { const end = text.indexOf("'", i + 1); i = end === -1 ? text.length : end; continue; }
    if (text[i] === "(") depth++;
    if (text[i] === ")") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// Does a SET clause assign the role column: `role = ...`, `"role" = ...`, or a tuple `(role, x) = (...)`?
function setsRole(setClause) {
  if (/(^|[\s,])"?role"?\s*=/i.test(setClause)) return true;
  for (const tuple of setClause.matchAll(/\(([^()]*)\)\s*=/g)) {
    if (splitTopLevel(tuple[1]).some((column) => column.replace(/"/g, "").trim().toLowerCase() === "role")) return true;
  }
  return false;
}

// An UPDATE's SET clause: from `set` to the first FROM / WHERE / RETURNING that is
// not inside parentheses or a quoted string (a subselect's own FROM does not end it).
function updateSetClause(statement) {
  const set = statement.match(/\bset\b/i);
  if (!set) return null;
  const rest = statement.slice(set.index + set[0].length);
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "'") { const end = rest.indexOf("'", i + 1); i = end === -1 ? rest.length : end; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^(from|where|returning)\b/i.test(rest.slice(i, i + 10)) && (i === 0 || !/[\w$."]/.test(rest[i - 1]))) return rest.slice(0, i);
  }
  return rest;
}

// null when the statement can only leave the table's one word in `role`;
// otherwise why not. Anything it cannot read is a problem (fail closed).
function roleWriteProblem({ verb, table, statement }) {
  const word = ROLE_TABLES[table];
  const literal = `'${word}'`;
  if (verb === "delete from" || verb.startsWith("truncate")) return null; // removes rows, writes no word
  if (verb === "insert into") {
    const head = statement.match(/^insert\s+into\s+[\w."]+\s*\(/i);
    if (!head) return "an insert without a column list";
    const columnsEnd = closingParen(statement, head[0].length - 1);
    if (columnsEnd === -1) return "an insert whose column list does not close";
    const columns = splitTopLevel(statement.slice(head[0].length, columnsEnd - 1)).map((c) => c.replace(/"/g, "").toLowerCase());
    const at = columns.indexOf("role");
    if (at === -1) return "an insert without the role column";
    let rest = statement.slice(columnsEnd);
    const source = rest.match(/^\s*(?:overriding\s+\w+\s+value\s+)?(values|select)\b/i);
    if (!source) return "an insert that is neither `values` nor `select`";
    rest = rest.slice(source[0].length);
    let tail;
    if (source[1].toLowerCase() === "values") {
      // Every top-level tuple of the VALUES list, however many.
      let position = 0;
      let rows = 0;
      for (;;) {
        const open = rest.slice(position).match(/^\s*\(/);
        if (!open) return rows === 0 ? "an insert whose VALUES has no row" : "an insert whose VALUES list could not be read";
        const start = position + open[0].length - 1;
        const close = closingParen(rest, start);
        if (close === -1) return "an insert whose VALUES row does not close";
        const values = splitTopLevel(rest.slice(start + 1, close - 1));
        rows++;
        if (values.length !== columns.length) return `an insert whose row ${rows} could not be matched to its columns`;
        if (values[at] !== literal) return `an insert whose role in row ${rows} is ${values[at]}, not the literal ${literal}`;
        position = close;
        const comma = rest.slice(position).match(/^\s*,/);
        if (!comma) break;
        position += comma[0].length;
      }
      tail = rest.slice(position);
    } else {
      // insert ... select <list> from ...: one plain select, the role item a literal.
      const from = rest.search(/\bfrom\b/i);
      const conflictAt = rest.search(/\bon\s+conflict\b/i);
      const listEnd = from === -1 ? (conflictAt === -1 ? rest.length : conflictAt) : from;
      const list = rest.slice(0, listEnd);
      if (/\b(union|intersect|except)\b/i.test(rest)) return "an insert ... select with a set operation";
      if (/^\s*(distinct|all)\b/i.test(list)) return "an insert ... select with distinct / all";
      const items = splitTopLevel(list);
      if (items.length !== columns.length) return "an insert ... select whose list could not be matched to its columns";
      if (items[at] !== literal) return `an insert ... select whose role is ${items[at]}, not the literal ${literal}`;
      tail = rest.slice(listEnd);
    }
    const conflict = tail.match(/\bdo\s+update\s+set\b([\s\S]*)$/i);
    if (conflict && setsRole(conflict[1])) return "an upsert that sets role";
    return null;
  }
  if (verb === "update") {
    const set = updateSetClause(statement);
    if (set === null) return "an update without a readable SET";
    if (setsRole(set)) return "an update that sets role";
    return null;
  }
  return `a ${verb} statement`;
}

function scanRoleWrites(dirs) {
  const found = [];
  const problems = [];
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      const raw = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      const text = file.endsWith(".sql") ? withoutSqlLineComments(raw) : raw;
      for (const write of roleTableWrites(text)) {
        const line = text.slice(0, write.index).split("\n").length;
        found.push(`${file}:${write.verb}:${write.table}`);
        const problem = roleWriteProblem(write);
        if (problem) problems.push(`${file}:${line}: ${problem}`);
      }
    }
  }
  return { found, problems };
}

test("c1. every write of user_club_roles / user_team_roles in the code writes only 'club_admin' / 'team_coach'", () => {
  const { found, problems } = scanRoleWrites(SCANNED_DIRS);
  assert.deepEqual(problems, []);
  // The scan really sees the writers: the grant and revoke of each table in organization.js.
  for (const expected of [
    "backend/src/routes/organization.js:insert into:user_club_roles",
    "backend/src/routes/organization.js:update:user_club_roles",
    "backend/src/routes/organization.js:insert into:user_team_roles",
    "backend/src/routes/organization.js:update:user_team_roles",
  ]) assert.equal(found.filter((f) => f === expected).length, 1, expected);
  // Nothing else in the application writes them: a new writer is added to this list on purpose.
  // The v84 rehearsal plants one row of each table in its own disposable database (the literals checked above); the v85
  // rehearsal (session types, ST-1) plants one club_admin row the same way, and so does the v87 rehearsal (positions); the v89 rehearsal
  // (a session type per athlete, ST-3) plants one team_coach row, and so does the v88 rehearsal (manual values, ST-4);
  // the v92 rehearsal (roles R4-1) plants one club_admin and one team_coach row in its own disposable database.
  assert.deepEqual([...new Set(found.filter((f) => f.startsWith("backend/")).map((f) => f.split(":")[0]))].sort(),
    ["backend/scripts/athlete-positions-v87-rehearsal.mjs", "backend/scripts/calendar-event-delete-v93-rehearsal.mjs", "backend/scripts/manual-values-v88-rehearsal.mjs", "backend/scripts/participant-session-types-v89-rehearsal.mjs", "backend/scripts/permission-roles-v84-rehearsal.mjs", "backend/scripts/roles-layers-v92-rehearsal.mjs", "backend/scripts/session-types-v85-rehearsal.mjs", "backend/src/routes/organization.js"]);
});

test("c1m. the migrations: only the allowlisted historical file writes these tables, and only the right literal", () => {
  const { found, problems } = scanRoleWrites(MIGRATION_DIRS);
  assert.deepEqual(problems, []);
  assert.deepEqual([...new Set(found.map((f) => f.split(":")[0]))].sort(), MIGRATION_WRITERS, "a migration that writes a role table is added to the allowlist on purpose");
  // The one historical writer: the club_admin backfill, an insert ... select of the literal, whose upsert leaves role alone.
  assert.deepEqual(found, ["migrations/20260730_backfill_club_admin_scope.sql:insert into:user_club_roles"]);
  const backfill = withoutSqlLineComments(fs.readFileSync(path.join(REPO_ROOT, MIGRATION_WRITERS[0]), "utf8"));
  const [write] = roleTableWrites(backfill);
  assert.match(write.statement, /^insert into public\.user_club_roles \(user_id, club_id, role, is_active\)\s+select u\.id, c\.id, 'club_admin', true\s+from /);
  assert.equal(roleWriteProblem(write), null);
  assert.ok(sourceFiles("migrations").length > 10 && sourceFiles("migrations_v2").length > 50, "both folders were read");
});

test("c2. the scan's own rule: it refuses every other shape of write", () => {
  const problem = (sql) => {
    const writes = roleTableWrites(sql);
    assert.equal(writes.length, 1, sql);
    return roleWriteProblem(writes[0]);
  };
  assert.equal(problem("insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)"), null);
  assert.equal(problem("insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'team_coach') on conflict (user_id, team_id, role) do update set is_active = true`"), null);
  assert.equal(problem("insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'team_coach'), ($3, $4, 'team_coach'),\n ($5, coalesce($6, $7), 'team_coach')"), null);
  assert.equal(problem("insert into public.user_club_roles (user_id, club_id, role, is_active)\nselect u.id, c.id, 'club_admin', true\nfrom public.clubs c join public.users u on u.id = c.created_by_user_id\nwhere u.role_hint in ('club_admin', 'club_manager')\non conflict (user_id, club_id, role) do update set is_active = true, updated_at = now();"), null);
  assert.equal(problem("update public.user_club_roles set is_active = false, revoked_at = now() where user_id = $2 and role = 'club_admin'"), null);
  assert.equal(problem("update public.user_club_roles r set (is_active, updated_at) = (false, now()) from public.users u where u.id = r.user_id and r.role = 'club_admin'"), null);
  assert.equal(problem("delete from public.user_team_roles where user_id = $1"), null);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'director')"), /not the literal 'club_admin'/);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'team_coach')"), /not the literal 'club_admin'/);
  assert.match(problem("insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'club_admin')"), /not the literal 'team_coach'/);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, $3)"), /not the literal/);
  assert.match(problem("INSERT INTO user_team_roles (user_id, team_id, role) VALUES ($1, $2, $3)"), /not the literal/);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id) values ($1, $2)"), /without the role column/);
  assert.match(problem("insert into public.user_club_roles select * from staging"), /without a column list/);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) table staging"), /neither `values` nor `select`/);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin') on conflict (user_id, club_id, role) do update set role = excluded.role"), /upsert that sets role/);
  assert.match(problem("update public.user_club_roles set role = $1 where user_id = $2"), /update that sets role/);
  assert.match(problem("update public.user_team_roles set is_active = true, role = 'assistant' where user_id = $2"), /update that sets role/);
  assert.match(problem("update only public.user_team_roles set \"role\"='x'"), /update that sets role/);
  assert.match(problem("copy public.user_club_roles from stdin"), /copy statement/);
  // A migration-style insert of another word (a `;` ends the statement, a `--` comment is no statement).
  const migration = withoutSqlLineComments("-- insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'x');\nbegin;\ninsert into public.user_club_roles (user_id, club_id, role, is_active)\nvalues ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'director', true);\ncommit;");
  assert.match(problem(migration), /role in row 1 is 'director', not the literal 'club_admin'/);
  // A tuple SET, in an update and in an upsert.
  assert.match(problem("update public.user_club_roles set (role, is_active) = ('director', true) where user_id = $1"), /update that sets role/);
  assert.match(problem("update public.user_team_roles set (is_active, \"role\") = (select true, 'assistant')"), /update that sets role/);
  assert.match(problem("insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach') on conflict (user_id, team_id, role) do update set (is_active, role) = (true, 'assistant')"), /upsert that sets role/);
  // A subselect in the SET clause does not end it: the assignment after it is still read.
  assert.match(problem("update public.user_club_roles set updated_at = (select now() from public.users limit 1), role = 'director' where user_id = $1"), /update that sets role/);
  assert.equal(problem("update public.user_club_roles set updated_at = (select now() from public.users where true limit 1), is_active = false where user_id = $1 and role = 'club_admin'"), null);
  assert.equal(problem("update public.user_team_roles set is_active = false\nfrom public.teams t\nwhere t.id = team_id and role = 'team_coach' returning role"), null);
  // A multi-row VALUES whose later row has another word, however far from the first row.
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin'), ($3, $4, 'director')"), /role in row 2 is 'director'/);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')\n\n\n      ,\n\n   ($3, $4, 'club_admin'), (coalesce($5, ($6)), $7, $8)"), /role in row 3 is \$8/);
  assert.match(problem("insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'team_coach'), ($3, $4)"), /row 2 could not be matched/);
  // An insert ... select with another literal, a computed word, or a second select.
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role, is_active) select u.id, c.id, 'director', true from public.clubs c join public.users u on true"), /select whose role is 'director'/);
  assert.match(problem("insert into public.user_club_roles (user_id, club_id, role) select u.id, c.id, u.role_hint from public.users u, public.clubs c"), /select whose role is u\.role_hint/);
  assert.match(problem("insert into public.user_team_roles (user_id, team_id, role) select $1, $2, 'team_coach' union all select $1, $3, 'assistant'"), /set operation/);
  assert.match(problem("insert into public.user_team_roles (user_id, team_id, role) select s.* from staging s"), /could not be matched to its columns/);
});

test("c3. the four :role routes of organization.js refuse any other word before anything else", () => {
  const routes = [
    ["put", "/users/:userId/club-roles/:clubId/:role", "club_admin", "Unsupported club role.", "grantClubAdminRole"],
    ["delete", "/users/:userId/club-roles/:clubId/:role", "club_admin", "Unsupported club role.", "revokeClubAdminRole"],
    ["put", "/users/:userId/team-roles/:teamId/:role", "team_coach", "Unsupported team role.", "grantTeamCoachRole"],
    ["delete", "/users/:userId/team-roles/:teamId/:role", "team_coach", "Unsupported team role.", "revokeTeamCoachRole"],
  ];
  const squeeze = (text) => text.replace(/\s+/g, " ");
  const source = squeeze(ORGANIZATION_JS);
  for (const [method, route, word, error, service] of routes) {
    const head = `router.${method}("${route}", async (req, res, next) => { try { `
      + `if (clean(req.params.role) !== "${word}") return res.status(400).json({ error: "${error}" }); `
      + `const result = await ${service}(req, `;
    assert.equal(source.split(head).length - 1, 1, `${method.toUpperCase()} ${route}: the word check is the handler's first statement`);
  }
  // No other route takes a role word for these two tables.
  const roleRoutes = [...ORGANIZATION_JS.matchAll(/router\.(\w+)\("([^"]*(?:club-roles|team-roles)[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(roleRoutes, [
    "delete /users/:userId/club-roles/:clubId/:role",
    "delete /users/:userId/team-roles/:teamId/:role",
    "post /club-roles",
    "post /team-roles",
    "put /users/:userId/club-roles/:clubId/:role",
    "put /users/:userId/team-roles/:teamId/:role",
  ]);
  // The two legacy POST routes read no role word from the request at all.
  for (const [route, service] of [["/club-roles", "grantClubAdminRole"], ["/team-roles", "grantTeamCoachRole"]]) {
    const start = ORGANIZATION_JS.indexOf(`router.post("${route}"`);
    const body = ORGANIZATION_JS.slice(start, ORGANIZATION_JS.indexOf("\n});", start));
    assert.ok(body.includes(`await ${service}(req, userId, `), `${route} goes through ${service}`);
    assert.doesNotMatch(body, /\brole\b/i, `${route} reads no role word`);
  }
  // The four services write a literal and filter on it (their statements are also covered by c1).
  for (const [service, table, word] of [
    ["grantClubAdminRole", "user_club_roles", "club_admin"], ["revokeClubAdminRole", "user_club_roles", "club_admin"],
    ["grantTeamCoachRole", "user_team_roles", "team_coach"], ["revokeTeamCoachRole", "user_team_roles", "team_coach"],
  ]) {
    const start = ORGANIZATION_JS.indexOf(`async function ${service}(`);
    assert.ok(start > 0, service);
    const body = ORGANIZATION_JS.slice(start, ORGANIZATION_JS.indexOf("\n}\n", start));
    const writes = roleTableWrites(body);
    assert.equal(writes.length, 1, `${service} writes once`);
    assert.equal(writes[0].table, table);
    assert.equal(roleWriteProblem(writes[0]), null);
    assert.ok(writes[0].statement.includes(`'${word}'`), `${service} names '${word}'`);
  }
});

test("32a. (R2) no fallback to the constant: a club admin's hand-built context without rolePermissions passes nothing but what a platform admin passes; a context whose role tables could not be read throws for anyone but a platform admin", () => {
  const bare = CONTEXTS["club admin of A"];
  for (const word of ALL_WORDS) {
    for (const type of ["club", "team"]) {
      for (const [scopeName, scope] of SCOPES[type]) assert.equal(canR2(bare, word, scope), false, `${word} on ${scopeName}`);
    }
  }
  const unavailable = { ...bare, rolePermissions: Object.freeze({ unavailable: true }) };
  assert.throws(() => canR2(unavailable, "org.view", clubScope(CLUB_A)), (e) => e.status === 503 && e.code === "permissions_unavailable");
  assert.throws(() => canR2(unavailable, "platform.admin", GLOBAL_SCOPE), (e) => e.code === "permissions_unavailable");
  const platform = { ...CONTEXTS["platform admin"], rolePermissions: Object.freeze({ unavailable: true }) };
  for (const word of ALL_WORDS) assert.equal(canR2(platform, word, clubScope(CLUB_A)), true, word);
});

test("32b. (R2) scope type is part of the match: an entry held at club scope does not grant a team scope with the same id, and a team entry does not grant a club scope with the same id", () => {
  const ctx = (entry) => ({ platformRoles: [], rolePermissions: Object.freeze([Object.freeze(entry)]) });
  const atClub = ctx({ scopeType: "club", scopeId: CLUB_A, words: ["org.view"], teamIds: [] });
  assert.equal(canR2(atClub, "org.view", clubScope(CLUB_A)), true, "control: the club entry grants its club");
  assert.equal(canR2(atClub, "org.view", teamScope(CLUB_A)), false, "a club id passed with scope type team grants nothing");
  const atTeam = ctx({ scopeType: "team", scopeId: TEAM_T1, words: ["org.view"], teamIds: [] });
  assert.equal(canR2(atTeam, "org.view", teamScope(TEAM_T1)), true, "control: the team entry grants its team");
  assert.equal(canR2(atTeam, "org.view", clubScope(TEAM_T1)), false, "a team id passed with scope type club grants nothing");
});
