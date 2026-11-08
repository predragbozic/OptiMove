// The read-only import check (docs/runbooks/gpexe-import-check.sql, 17 blocks) run
// before it is handed over, as the first window's two files were:
//   0 - the file's shape: LF, a comment-only header, blocks 1..17, each one plain
//       SELECT with no parameter, meta-command or write;
//   1 - on a world built like production's pilot (the three system variables under
//       their production keys, Required; one team bound to GPEXE team 980 on
//       server3; its switch on; a granted coach) before any import: blocks 1-8
//       show their expected values, blocks 9-17 find no approval;
//   2 - after one approval through the single-candidate route: every block;
//   3 - after a second import (a second session): the checked approval is the
//       newest, every block shows that import's numbers;
//   4 - after the undo (v57) of the newest import: the checked approval is the
//       earlier one again, and block 8 counts the undone candidate;
//   5 - what the file must stop on, planted (and rolled back) one at a time.
// On disposable optimove_tests_gpexe_* databases only; no GPEXE request (the fake
// server3 source), no credential (its marker values only).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, DISPOSABLE_DB_NAME_PATTERN} from "./_gpexe-disposable-db.mjs";
import { PLANTED, previewBundle } from "./support/preview-bundles.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { verifyRevisionRow } from "./support/source-revisions.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(ROOT, "docs/runbooks/gpexe-import-check.sql");
const DAY = "2026-09-14";
const SOURCE_TEAM = "980";
const gpexeAthlete = (n) => `${PLANTED.athletePrefix}${String(n).padStart(2, "0")}`;

// The pilot of O6 (a), under the keys, units and conversions production uses
// (the Rukovodilac's read of 2026-11-02, J17 section 12.2).
const PILOT = [
  { key: "duration", label: "Duration", field: "athlete_session.total_time", sourceUnit: "s", unit: "min", daily: "sum", note: "Seconds to minutes." },
  { key: "total_distance", label: "Total distance", field: "athlete_session.total_distance", sourceUnit: "m", unit: "m", daily: "sum" },
  { key: "maximal_running_speed", label: "Maximal running speed", field: "athlete_session.max_v", sourceUnit: "m/s", unit: "km/h", daily: "max", maxValue: "40", note: "Metres per second to kilometres per hour." },
];

// Every block's output columns, exactly: a new printed column (an email, a credential,
// a stored source answer) fails a test before review.
const COLUMNS = {
  1: ["null_checksums", "last_migration", "previous_migration", "v2_rows"],
  2: ["running_checks", "running_identity_loads", "staged_observations", "idle_in_transaction", "import_table_write_locks", "advisory_locks"],
  3: ["what", "team_name", "enabled", "mode", "changed_utc", "recorded_on", "age_days"],
  4: ["source_system", "source_team_id", "binding_state", "team_name", "team_active", "club_active", "host_key", "api_family", "connection_owner_scope", "connection_club_is_team_club", "connection_state", "open_activations", "open_required"],
  5: ["user_id", "name", "basis", "role_granted_utc", "role_changed_utc", "revoked_at_null"],
  6: ["grant_id", "team_name", "user_id", "name", "granted_utc", "user_active", "gives_the_right_now", "also_platform_admin"],
  7: ["non_canonical_links"],
  8: ["approvals_total", "approvals_last_14_days", "checked_first_imports_last_14_days", "approvals_into_existing_events_last_14_days", "undone_candidates", "imported_without_approval", "approvals_without_event", "newest_approval_utc", "checked_approval_id"],
  9: ["checked_approvals", "team_bindings", "bound_to", "open_activations", "requirements", "approval_id", "approved_by_user_id", "approved_by_name", "approved_utc", "approval_basis", "no_grant", "changes_to_imported", "changes_accepted", "results_imported", "import_count_keys", "import_ids_recorded"],
  10: ["gpexe_session_id", "candidate_status", "imported_in_the_approval", "same_content", "stored_preview_is_the_approved_one", "preview_version", "preview_status", "drill_parameter_effect", "live_imported_of_the_session"],
  11: ["preview_results", "approval_results", "preview_results_created", "batch_occasions", "event_occasions", "preview_values", "written_values", "event_values", "t6_rows_of_the_import", "t6_rows_of_the_event", "preview_left_out", "preview_left_out_entries", "imported_athletes", "event_participants", "preview_changes_to_imported"],
  12: ["preview_values", "stored_values", "unmatched", "differing"],
  13: ["team_bindings", "team_instances", "values_of_the_import", "t6_rows", "values_without_t6", "t6_other_binding", "t6_other_instance", "t6_not_an_open_activation", "t6_not_the_pinned_version", "t6_outside_the_approval", "values_not_on_a_system_variable", "role_or_coverage_wrong", "activations_used", "open_activations"],
  14: ["instance_state", "source_host_key", "source_instance_key", "keys_are_the_bindings", "is_the_event_instance", "is_the_event_binding_instance", "identities_elsewhere", "rows_with_these_keys", "created_in_the_approval"],
  15: ["left_out_entries", "left_out_with_a_stored_value", "left_out_stored_as_zero", "left_out_by_reason"],
  16: ["gpexe_team_definitions", "gpexe_named_definitions", "definitions_written_by_the_approval", "versions_written_by_the_approval"],
  17: ["event_is_the_session", "event_owner_scope", "event_of_the_team", "scope_level", "event_created_in_the_approval", "threshold_binding_rows", "batch_ok", "activity_origin", "activity_lifecycle", "activity_of_the_team", "activity_created_in_the_approval", "confirmed_event_links", "activity_participants", "event_participants", "event_segments", "drill_components", "gpexe_events_of_the_instance", "identities_of_the_results", "session_identities_without_occasion", "occasions_not_plain_created", "roster_decisions"],
};

let db;
let admin;
let ro;
let server;
let apiBase;
let service;
let connections;
let resolver;
let createSession;
let appPool;
let src;
const S = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "import_check_sql" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: not a disposable database");
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  ro = new pg.Client({ connectionString: db.url }); // the connector's session
  await ro.connect();
  for (const c of [admin, ro]) assert.equal((await c.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  // The legacy columns of public.user_global_roles production has
  // (migrations/20260802_user_global_roles.sql) and the test scaffold leaves out.
  await admin.query(`alter table public.user_global_roles
                       add column if not exists granted_by_user_id uuid references public.users(id) on delete set null,
                       add column if not exists created_at timestamptz not null default now(),
                       add column if not exists updated_at timestamptz not null default now()`);
  // Block 2 counts an autovacuum's lock on the import's tables: none may run
  // on them while this test asserts a quiet moment.
  for (const table of ["gpexe_import_checks", "gpexe_import_candidates", "gpexe_import_approvals", "gpexe_import_check_observations",
    "source_team_bindings", "source_metric_mapping_activations", "metric_source_connections", "metric_value_source_provenance", "metric_values"]) {
    await admin.query(`alter table training_load.${table} set (autovacuum_enabled = false)`);
  }
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is not on the disposable database");
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((resolve) => { timer = setTimeout(resolve, 5_000); })]);
    clearTimeout(timer);
  }
  await ro?.end().catch(() => {});
  await admin?.end().catch(() => {});
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
});

// ---- the files --------------------------------------------------------------

// The numbered blocks of a file, as the runbooks number them ("-- N. " at the
// start of a line; the header before block 1 holds comments only).
async function fileBlocks(file) {
  const text = await fsp.readFile(file, "utf8");
  const parts = text.split(/^(?=-- \d+\. )/m);
  return { text, header: parts[0], blocks: parts.slice(1).map((part) => ({ n: Number(part.match(/^-- (\d+)\./)[1]), part })) };
}
const sqlOf = (part) => part.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n").trim();

// Every block sent exactly as the connector sends it: one call of
// "begin transaction read only;", the block verbatim, "rollback;".
async function readOnlyBlocks(client, file, numbers = null) {
  const { blocks } = await fileBlocks(file);
  const out = {};
  for (const { n, part } of blocks) {
    if (numbers && !numbers.includes(n)) continue;
    let res;
    try {
      res = await client.query(`begin transaction read only;\n${part}\nrollback;`);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw new Error(`${path.basename(file)} block ${n}: ${error.message}`);
    }
    assert.ok(Array.isArray(res) && res.length === 3, `${path.basename(file)} block ${n} is exactly one statement`);
    assert.equal(res[0].command, "BEGIN");
    assert.equal(res[2].command, "ROLLBACK");
    if (COLUMNS[n]) assert.deepEqual(res[1].fields.map((f) => f.name), COLUMNS[n], `${path.basename(file)} block ${n}: exactly its columns`);
    else console.log("COLS", n, JSON.stringify(res[1].fields.map((f) => f.name)));
    out[n] = res[1].rows;
  }
  return out;
}

async function planted(fn, client = admin) {
  await client.query("begin");
  try {
    await client.query("set local session_replication_role = replica");
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

// ---- the world --------------------------------------------------------------

async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;

async function user(label, { platform = false, team = null } = {}) {
  const id = (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`,
    [`${label.replace(/\s+/g, "-")}-${crypto.randomBytes(4).toString("hex")}@test.local`, label])).rows[0].id;
  if (platform) await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (team) await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, team]);
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [id, platform ? "platform" : "team", platform ? null : team]);
  return { id: String(id), cookie: `optimove_session=${await createSession(id)}`, name: label };
}

// The three pilot fields confirmed, their system variables, mappings and
// active versions, written through the real M3-0, M2 and 7b services.
async function pilotSystem(platformAdminId) {
  const variables = await import("../src/canonicalVariableAdminService.js");
  const mappings = await import("../src/sourceMetricMappingService.js");
  const ctx = { userId: String(platformAdminId), basis: "platform_admin", owner: { scope: "system", clubId: null } };
  const key = () => crypto.randomUUID();
  const out = {};
  for (const p of PILOT) {
    const rev = (await q(
      `select d.id as "fieldId", r.id as "revId"
         from training_load.source_metric_definitions d
         join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.revision_number = 1
        where d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.source_metric_key = $1`, [p.field]))[0];
    await verifyRevisionRow(admin, {
      fieldId: rev.fieldId, revisionId: rev.revId, by: platformAdminId,
      unit: p.sourceUnit, unitRef: "docs/ai/test-evidence.md#unit", meaning: true, meaningRef: "docs/ai/test-evidence.md#meaning",
    });
    const variable = (await variables.createVariable({
      ctx,
      body: {
        requestKey: key(), key: p.key, label: p.label, unit: p.unit, levels: ["session", "drill"], dailyAggregationMethod: p.daily,
        ...(p.maxValue ? { maxValue: p.maxValue } : {}),
      },
    })).variable;
    const mapping = (await mappings.createMapping({ ctx, body: { requestKey: key(), sourceMetricId: rev.fieldId, metricDefinitionId: variable.id } })).mapping;
    const version = (await mappings.createVersion({
      ctx, mappingId: mapping.id, body: { requestKey: key(), sourceRevisionId: rev.revId, appliesToSession: true, appliesToDrill: true, ...(p.note ? { conversionNote: p.note } : {}) },
    })).version;
    await mappings.submitVersion({ ctx, mappingId: mapping.id, versionId: version.id, body: { requestKey: key() } });
    await mappings.activateVersion({ ctx, mappingId: mapping.id, versionId: version.id, body: { requestKey: key(), expectedActiveVersionId: null } });
    out[p.key] = { mappingId: mapping.id, versionId: version.id, variableId: variable.id };
  }
  return out;
}

async function activate(system, { bindingId, platformAdminId, requirement = "required" }) {
  const activations = await import("../src/sourceMetricActivationService.js");
  const ctx = { userId: String(platformAdminId), basis: "platform_admin", owner: { scope: "system", clubId: null } };
  for (const m of Object.values(system)) {
    await activations.startActivations({
      ctx,
      body: { requestKey: crypto.randomUUID(), mappingId: m.mappingId, versionId: m.versionId, bindings: [{ bindingId, requirement }], reason: "9-R test activation." },
    });
  }
}

async function check(t, bundles) {
  src.serve(SOURCE_TEAM, bundles);
  const started = await api(`/gpexe/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: { from: DAY, to: DAY } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 400; i += 1) {
    const r = await api(`/gpexe/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.padmin.cookie });
    if (r.body.check?.status !== "running") return r.body.check;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the check did not finish");
}

async function approve(t, candidateId, previewHash) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/approve`, { method: "POST", cookie: t.padmin.cookie, body: { previewHash } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}

// The preview's own numbers, counted in JS (block 5's and 6's other side).
function previewNumbers(preview) {
  const athletes = preview.athletes ?? [];
  const created = athletes.flatMap((a) => a.results ?? []).filter((r) => r.outcome === "created");
  return {
    results: created.length,
    values: created.flatMap((r) => r.values).filter((v) => v.value !== null).length,
    leftOut: athletes.flatMap((a) => a.skippedValues ?? []).length,
    athletes: athletes.filter((a) => a.notImported === null).length,
  };
}

// ---- tests ------------------------------------------------------------------

// ---- tests ------------------------------------------------------------------

test("0. the file: LF only, a comment-only header, blocks numbered 1..17 once each, every block one plain SELECT with no parameter, meta-command or write", async () => {
  const name = path.basename(CHECK);
  const { text, header, blocks } = await fileBlocks(CHECK);
  assert.ok(!text.includes("\r"), `${name} has LF line endings`);
  assert.equal(header.split("\n").filter((line) => line.trim() && !line.startsWith("--")).length, 0, `${name}: the header holds comments only`);
  assert.deepEqual(blocks.map((b) => b.n), Array.from({ length: 17 }, (_, i) => i + 1), `${name}: blocks 1..17, in order, once each`);
  for (const { n, part } of blocks) {
    const sql = sqlOf(part);
    const where = `${name} block ${n}`;
    assert.match(sql, /^(select|with)\b/i, `${where} starts with select or with`);
    assert.equal(sql.split(";").length - 1, 1, `${where} has exactly one semicolon`);
    assert.ok(sql.endsWith(";"), `${where} ends with its semicolon`);
    assert.doesNotMatch(sql, /\$\d/, `${where} has no placeholder`);
    assert.doesNotMatch(sql, /^\s*\\/m, `${where} has no psql meta-command`);
    assert.doesNotMatch(sql, /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|call|do|vacuum|lock|set_config|nextval|setval|pg_advisory\w*|for\s+(update|share|no\s+key\s+update|key\s+share))\b/i, `${where} writes or locks nothing`);
    assert.doesNotMatch(sql, /\b(email|password_hash|credential_\w+|grant_reason|revoke_reason|error_message|change_reason)\b/i, `${where} reads no email, credential or free text`);
    assert.doesNotMatch(sql, /\braw_bundle\b(?!\s+is\s+not\s+null)/i, `${where} prints no stored source answer`);
  }
  assert.equal(Object.keys(COLUMNS).length, 17);
});

test("1. before any import, on a world built like production's pilot: blocks 1-8 show their expected values and blocks 9-17 find no approval to check", async () => {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A01", "A02", "A03", "A04"] });
  await admin.query(`update public.teams set name = 'First team' where id = $1`, [org.teamId]);
  const padmin = await user("Pilot Admin", { platform: true });
  const coach = await user("Pilot Coach", { team: org.teamId });
  assert.equal((await api(`/gpexe/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: SOURCE_TEAM } })).status, 200);
  src.show(SOURCE_TEAM);
  const bound = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId: SOURCE_TEAM });
  await enableTeamImportSwitch(admin, org.teamId, padmin.id);
  const system = await pilotSystem(padmin.id);
  await activate(system, { bindingId: bound.bindingId, platformAdminId: padmin.id });
  for (const n of [1, 2, 3]) {
    const r = await api(`/gpexe/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId: gpexeAthlete(n), athleteId: org.athleteIds[n - 1] } });
    assert.equal(r.status, 201, r.text);
  }
  const granted = await user("Granted Coach", { team: org.teamId });
  await admin.query(`insert into training_load.gpexe_import_approvers (owner_team_id, user_id, granted_by_user_id, grant_reason) values ($1,$2,$3,'import check test grant')`,
    [org.teamId, granted.id, padmin.id]);
  S.t = { ...org, ...bound, padmin, coach, granted, system };
  const checked = await check(S.t, [
    previewBundle({ gpexeTeamId: Number(SOURCE_TEAM), sessionId: 48213901 }),
    previewBundle({ gpexeTeamId: Number(SOURCE_TEAM), sessionId: 48213902, start: "2026-09-14T08:08:12" }),
  ]);
  assert.equal(checked.status, "succeeded", JSON.stringify(checked));
  S.candidates = await q(`select id, gpexe_team_session_id, preview, preview_hash, drill_parameter_effect from training_load.gpexe_import_candidates
                           where owner_team_id = $1 and status <> 'superseded' order by session_started_at desc, id`, [org.teamId]);
  assert.equal(S.candidates.length, 2);
  for (const c of S.candidates) {
    assert.equal(c.preview.version, 3);
    assert.equal(c.preview.status, "ready", JSON.stringify(c.preview.blocked));
  }
  const day = (back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  for (const [kind, back] of [["backup", 0], ["restore_probe", 3]]) {
    const rec = await api("/gpexe/import-prerequisites", { method: "POST", cookie: padmin.cookie, body: { kind, recordedOn: day(back), note: "import check test" } });
    assert.equal(rec.status, 201, rec.text);
  }

  const all = await readOnlyBlocks(ro, CHECK);
  S.before = all;
  const migrations = (await q(`select count(*)::text as n from public.schema_migrations where migration_name like 'migrations_v2/%'`))[0].n;
  const last = (await q(`select migration_name from public.schema_migrations where migration_name like 'migrations_v2/%' order by migration_name collate "C" desc limit 2`)).map((r) => r.migration_name);
  assert.deepEqual(all[1], [{ null_checksums: "0", last_migration: last[0], previous_migration: last[1], v2_rows: migrations }]);
  assert.deepEqual(all[2], [{ running_checks: "0", running_identity_loads: "0", staged_observations: "0", idle_in_transaction: "0", import_table_write_locks: "0", advisory_locks: all[2][0].advisory_locks }]);
  const sw = all[3].find((r) => r.what === "team_switch");
  assert.equal(sw.team_name, "First team");
  assert.equal(sw.enabled, true);
  assert.equal(sw.mode, "pilot");
  assert.ok([0, 1].includes(all[3].find((r) => r.what === "recorded_backup").age_days));
  assert.ok([3, 4].includes(all[3].find((r) => r.what === "recorded_restore_probe").age_days));
  assert.equal(all[3].length, 3, "one team switch and two recorded dates");
  assert.deepEqual(all[4].map((r) => [r.source_team_id, r.binding_state, r.team_name, r.team_active, r.club_active, r.host_key, r.api_family, r.connection_owner_scope,
    r.connection_club_is_team_club, r.open_activations, r.open_required]),
  [["980", "active", "First team", true, true, "server3", "rest_v1", "club", true, "3", "3"]]);
  assert.deepEqual(all[5].map((r) => [r.name, r.basis, r.revoked_at_null]), [["Pilot Admin", "platform_admin", true]]);
  assert.deepEqual(all[6].map((r) => [r.name, r.team_name, r.gives_the_right_now, r.also_platform_admin]), [["Granted Coach", "First team", true, false]]);
  assert.deepEqual(all[7], [{ non_canonical_links: "0" }]);
  assert.deepEqual({ ...all[8][0], advisory: undefined }, { approvals_total: "0", approvals_last_14_days: "0", checked_first_imports_last_14_days: "0",
    approvals_into_existing_events_last_14_days: "0", undone_candidates: "0", imported_without_approval: "0", approvals_without_event: "0",
    newest_approval_utc: null, checked_approval_id: null, advisory: undefined });
  assert.equal(all[9][0].checked_approvals, "0");
  for (const n of [10, 14, 17]) assert.deepEqual(all[n], [], `block ${n} has no row without an approval to check`);
  for (const n of [12, 13, 15, 16]) {
    assert.ok(Object.entries(all[n][0]).every(([k, v]) => k === "left_out_by_reason" || v === "0"), `block ${n} shows only zeros without an approval to check`);
  }
});

// The numbers the checked approval's blocks must show.
async function expectChecked(approval, candidate, eventId, { identitiesPlusOne = true } = {}) {
  const all = await readOnlyBlocks(ro, CHECK);
  const n = previewNumbers(candidate.preview);
  assert.ok(n.results > 0 && n.values > 0);
  assert.equal(all[8][0].checked_approval_id, approval.id);
  assert.deepEqual({ ...all[9][0], approved_utc: undefined }, {
    checked_approvals: "1", team_bindings: "1", bound_to: "980 @ server3", open_activations: "3", requirements: "required", approval_id: approval.id,
    approved_by_user_id: S.t.padmin.id, approved_by_name: "Pilot Admin", approved_utc: undefined, approval_basis: "platform_admin", no_grant: true,
    changes_to_imported: 0, changes_accepted: false, results_imported: n.results, import_count_keys: "created", import_ids_recorded: true });
  assert.deepEqual(all[10], [{
    gpexe_session_id: candidate.gpexe_team_session_id, candidate_status: "imported", imported_in_the_approval: true, same_content: true,
    stored_preview_is_the_approved_one: true, preview_version: "3", preview_status: "ready", drill_parameter_effect: candidate.drill_parameter_effect,
    live_imported_of_the_session: "1" }]);
  assert.deepEqual(all[11], [{
    preview_results: n.results, approval_results: n.results, preview_results_created: String(n.results), batch_occasions: String(n.results),
    event_occasions: String(n.results), preview_values: String(n.values), written_values: String(n.values), event_values: String(n.values),
    t6_rows_of_the_import: String(n.values), t6_rows_of_the_event: String(n.values), preview_left_out: n.leftOut,
    preview_left_out_entries: String(n.leftOut), imported_athletes: String(n.athletes), event_participants: String(n.athletes),
    preview_changes_to_imported: 0 }]);
  assert.deepEqual(all[12], [{ preview_values: String(n.values), stored_values: String(n.values), unmatched: "0", differing: "0" }]);
  assert.deepEqual(all[13], [{
    team_bindings: "1", team_instances: "1", values_of_the_import: String(n.values), t6_rows: String(n.values), values_without_t6: "0",
    t6_other_binding: "0", t6_other_instance: "0", t6_not_an_open_activation: "0", t6_not_the_pinned_version: "0",
    t6_outside_the_approval: "0", values_not_on_a_system_variable: "0", role_or_coverage_wrong: "0", activations_used: "3", open_activations: "3" }]);
  assert.deepEqual(all[14], [{
    instance_state: "active", source_host_key: "server3", source_instance_key: "980", keys_are_the_bindings: true, is_the_event_instance: true,
    is_the_event_binding_instance: true, identities_elsewhere: "0", rows_with_these_keys: "1", created_in_the_approval: all[14][0].created_in_the_approval }]);
  assert.deepEqual(all[15], [{ left_out_entries: String(n.leftOut), left_out_with_a_stored_value: "0", left_out_stored_as_zero: "0",
    left_out_by_reason: n.leftOut === 0 ? {} : all[15][0].left_out_by_reason }]);
  assert.deepEqual(all[16], [{ gpexe_team_definitions: "0", gpexe_named_definitions: "0", definitions_written_by_the_approval: "0", versions_written_by_the_approval: "0" }]);
  const drills = (await q(`select count(*)::text as n from training_load.metric_event_segments where event_id = $1`, [eventId]))[0].n;
  assert.ok(Number(drills) > 0, "the session has drills");
  assert.deepEqual({ ...all[17][0], gpexe_events_of_the_instance: undefined }, {
    event_is_the_session: true, event_owner_scope: "team", event_of_the_team: true, scope_level: "session", event_created_in_the_approval: true,
    threshold_binding_rows: "1", batch_ok: true, activity_origin: "source_import", activity_lifecycle: "confirmed", activity_of_the_team: true,
    activity_created_in_the_approval: true, confirmed_event_links: "1", activity_participants: String(n.athletes), event_participants: String(n.athletes),
    event_segments: drills, drill_components: drills, gpexe_events_of_the_instance: undefined, identities_of_the_results: String(n.results),
    session_identities_without_occasion: "1", occasions_not_plain_created: "0", roster_decisions: "0" });
  return all;
}

test("2. after one approval through the single route: every block of the file shows its expected value", async () => {
  const t = S.t;
  const target = S.candidates[0];
  const r = await approve(t, target.id, target.preview_hash);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.outcome, "imported");
  const approvalRow = (await q(`select id from training_load.gpexe_import_approvals`))[0];
  assert.equal(approvalRow.id, r.body.approval.id);
  const all = await expectChecked(approvalRow, target, r.body.import.eventId);
  assert.deepEqual(all[8][0].approvals_total, "1");
  assert.equal(all[8][0].checked_first_imports_last_14_days, "1");
  assert.equal(all[17][0].gpexe_events_of_the_instance, "1");
  S.first = { approval: approvalRow, candidate: target, eventId: r.body.import.eventId };
});

test("3. after a second import: the checked approval is the newest, and its blocks show that import's numbers", async () => {
  const t = S.t;
  const target = S.candidates[1];
  const r = await approve(t, target.id, target.preview_hash);
  assert.equal(r.status, 200, r.text);
  const approvalRow = (await q(`select id from training_load.gpexe_import_approvals where candidate_id = $1`, [target.id]))[0];
  const all = await expectChecked(approvalRow, target, r.body.import.eventId);
  assert.equal(all[8][0].approvals_total, "2");
  assert.equal(all[8][0].checked_first_imports_last_14_days, "2");
  assert.equal(all[17][0].gpexe_events_of_the_instance, "2");
  S.second = { approval: approvalRow, candidate: target, eventId: r.body.import.eventId };
});

test("4. after the undo (v57) of the newest import: the checked approval is the earlier one again, and block 8 counts the undone candidate", async () => {
  const t = S.t;
  const undo = await import("../src/gpexeSessionUndoService.js");
  const done = await undo.undoImport(t.teamId, S.second.candidate.id, { userId: t.padmin.id, requestKey: crypto.randomUUID(), reason: "Wrong link, test.", expectedEventId: S.second.eventId });
  assert.ok(done.removedTotal > 0);
  const all = await expectChecked(S.first.approval, S.first.candidate, S.first.eventId);
  assert.equal(all[8][0].undone_candidates, "1");
  assert.equal(all[8][0].approvals_total, "2");
  assert.equal(all[8][0].checked_first_imports_last_14_days, "1");
  assert.equal(all[8][0].imported_without_approval, "0");
  assert.equal(all[8][0].approvals_without_event, "0", "an undone import's approval is not counted as missing its event");
  assert.equal(all[17][0].gpexe_events_of_the_instance, "1");
});

// The helpers the planted cases use: the same blocks inside a transaction the test opened (rolled back by the caller).
async function blocksOf(client, numbers) {
  const { blocks } = await fileBlocks(CHECK);
  const out = {};
  for (const { n, part } of blocks) if (numbers.includes(n)) out[n] = (await client.query(part)).rows;
  return out;
}

test("5. the file stops on what it must stop on, planted one at a time and rolled back", async () => {
  const t = S.t;
  const base = await blocksOf(admin, [8, 9]);
  assert.equal(base[9][0].approval_id, S.first.approval.id, "the checked approval is the first import (the second was undone)");

  // A running check, and a long idle session is not planted (needs a second connection): block 2.
  const running = await planted(async () => {
    await admin.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to) values ($1,$2,$3,$3)`, [t.teamId, t.coach.id, DAY]);
    return blocksOf(admin, [2]);
  });
  assert.equal(running[2][0].running_checks, "1");

  // A second team whose switch is on: block 3 lists it.
  const second = await planted(async () => {
    const other = (await admin.query(`insert into public.teams (club_id, name) select club_id, 'Second team' from public.teams where id = $1 returning id`, [t.teamId])).rows[0];
    await admin.query("select set_config('optimove.team_import_tx', txid_current()::text, true)");
    await admin.query(`insert into training_load.gpexe_team_import_switch (owner_team_id, enabled, mode, changed_by_user_id, change_reason) values ($1, true, 'pilot', $2, 'planted')`, [other.id, t.padmin.id]);
    return blocksOf(admin, [3]);
  });
  assert.equal(second[3].filter((r) => r.what === "team_switch" && r.enabled === true).length, 2, "both enabled teams are listed");

  // An approver grant that is revoked is not listed; one whose coach role is off is listed and does not give the right.
  const grant = await planted(async () => {
    await admin.query(`update public.user_team_roles set is_active = false where user_id = $1`, [t.granted.id]);
    return blocksOf(admin, [6]);
  });
  assert.equal(grant[6][0].gives_the_right_now, false);

  // A non-canonical athlete link.
  const link = await planted(async () => {
    await admin.query(`update training_load.gpexe_athlete_links set gpexe_athlete_id = '007' where id = (select id from training_load.gpexe_athlete_links order by id limit 1)`);
    return blocksOf(admin, [7]);
  });
  assert.equal(link[7][0].non_canonical_links, "1");

  // A candidate that is imported but has no approval.
  const orphan = await planted(async () => {
    await admin.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() where id = (select id from training_load.gpexe_import_candidates where status = 'pending' limit 1)`);
    return blocksOf(admin, [8]);
  });
  assert.equal(orphan[8][0].imported_without_approval, "1");

  // An approval whose event is gone (and whose candidate is still imported).
  const noEvent = await planted(async () => {
    await admin.query(`update training_load.gpexe_import_approvals set metric_event_id = gen_random_uuid() where id = $1`, [S.first.approval.id]);
    return blocksOf(admin, [8, 9]);
  });
  assert.equal(noEvent[8][0].approvals_without_event, "1");
  assert.equal(noEvent[9][0].checked_approvals, "0", "an approval whose event is not its own is not the checked approval");

  // A newer approval into an existing event (changes accepted) is counted and read by a person, not value-checked.
  const changes = await planted(async () => {
    await admin.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() where id = (select id from training_load.gpexe_import_candidates where status = 'pending' order by id limit 1)`);
    await admin.query(
      `insert into training_load.gpexe_import_approvals (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id,
                                                         approval_basis, changes_to_imported, changes_accepted, metric_event_id, activity_id, import_batch_id, import_counts, approved_at)
       select c.id, c.owner_team_id, c.gpexe_team_session_id, c.bundle_hash, c.preview_hash, a.approved_by_user_id,
              a.approval_basis, 0, false, a.metric_event_id, a.activity_id, a.import_batch_id, a.import_counts, a.approved_at + interval '1 minute'
         from (select * from training_load.gpexe_import_candidates where status = 'imported' and import_undone_at is null and id <> $2 order by imported_at desc limit 1) c, training_load.gpexe_import_approvals a where a.id = $1`, [S.first.approval.id, S.first.candidate.id]);
    return blocksOf(admin, [8, 9]);
  });
  assert.equal(changes[8][0].approvals_into_existing_events_last_14_days, "1");
  assert.equal(changes[9][0].approval_id, S.first.approval.id, "the checked approval stays the first import");

  // An approval that carries changes to imported results is not value-checked: counted, read by a person.
  const withChanges = await planted(async () => {
    await admin.query(`update training_load.gpexe_import_approvals set changes_to_imported = 1, changes_accepted = true where id = $1`, [S.first.approval.id]);
    return blocksOf(admin, [8, 9]);
  });
  assert.equal(withChanges[9][0].checked_approvals, "0");
  assert.equal(withChanges[8][0].approvals_into_existing_events_last_14_days, "1");

  // A value without its T6 row.
  const missingT6 = await planted(async () => {
    await admin.query(`delete from training_load.metric_value_source_provenance where metric_value_id = (
                         select p.metric_value_id from training_load.metric_value_source_provenance p order by p.metric_value_id limit 1)`);
    return blocksOf(admin, [11, 13]);
  });
  assert.notEqual(missingT6[11][0].t6_rows_of_the_import, missingT6[11][0].written_values);
  assert.equal(missingT6[13][0].values_without_t6, "1");

  // A stored value that differs from its preview entry.
  const changed = await planted(async () => {
    await admin.query(`update training_load.metric_values set value_numeric = value_numeric + 1
                        where id = (select p.metric_value_id from training_load.metric_value_source_provenance p order by p.metric_value_id limit 1)`);
    return blocksOf(admin, [12]);
  });
  assert.equal(changed[12][0].differing, "1");
  assert.equal(changed[12][0].unmatched, "0");

  // A left-out entry planted into the approved preview where a value is stored, then that value made a zero.
  const leftOut = async (zero) => planted(async () => {
    const row = (await admin.query(
      `select c.id, ath.ordinality - 1 as idx, ath.a ->> 'athleteId' as athlete_id
         from training_load.gpexe_import_candidates c
         join training_load.gpexe_import_approvals ap on ap.candidate_id = c.id and ap.id = $1,
              jsonb_array_elements(c.preview -> 'athletes') with ordinality as ath(a, ordinality)
        where ath.a ->> 'notImported' is null limit 1`, [S.first.approval.id])).rows[0];
    const activation = (await admin.query(
      `select a.id, a.metric_definition_id from training_load.source_metric_mapping_activations a
         join training_load.metric_definitions d on d.id = a.metric_definition_id
        where a.source_team_binding_id = $1 and a.ended_at is null and d.key = 'duration'`, [t.bindingId])).rows[0];
    await admin.query(
      `update training_load.gpexe_import_candidates
          set preview = jsonb_set(preview, array['athletes', $2::text, 'skippedValues'],
                                  jsonb_build_array(jsonb_build_object('level', 'full', 'drillIndex', null, 'activationId', $3::text, 'reason', 'required_value_missing')))
        where id = $1`, [row.id, String(row.idx), activation.id]);
    if (zero) {
      await admin.query(
        `update training_load.metric_values v set value_numeric = 0
           from training_load.metric_measurement_occasions o, training_load.metric_event_participants p
          where v.occasion_id = o.id and o.event_participant_id = p.id and p.event_id = $1 and p.athlete_id::text = $2
            and o.segment_id is null and v.metric_definition_id = $3`, [S.first.eventId, row.athlete_id, activation.metric_definition_id]);
    }
    return blocksOf(admin, [15]);
  });
  const stored = await leftOut(false);
  assert.deepEqual(stored[15], [{ left_out_entries: "1", left_out_with_a_stored_value: "1", left_out_stored_as_zero: "0", left_out_by_reason: { required_value_missing: 1 } }]);
  assert.equal((await leftOut(true))[15][0].left_out_stored_as_zero, "1");

  // An occasion of the approved event outside the import's batch.
  const outsideBatch = await planted(async () => {
    await admin.query(`update training_load.metric_measurement_occasions set import_batch_id = null
                        where id = (select o.id from training_load.metric_measurement_occasions o
                                      join training_load.metric_values v on v.occasion_id = o.id
                                      join training_load.metric_event_participants p on p.id = o.event_participant_id
                                     where p.event_id = $1 order by o.id limit 1)`, [S.first.eventId]);
    return blocksOf(admin, [11]);
  });
  assert.ok(Number(outsideBatch[11][0].event_values) > Number(outsideBatch[11][0].written_values), "event_values counts by the event, not the batch");

  // Other T7 keys on the team's instance.
  const keys = await planted(async () => {
    await admin.query(`update training_load.metric_source_connections set source_instance_key = '981' where owner_team_id = $1 and source_system = 'gpexe'`, [t.teamId]);
    return blocksOf(admin, [14]);
  });
  assert.equal(keys[14][0].keys_are_the_bindings, false);
  assert.equal(keys[14][0].rows_with_these_keys, "0");

  // A team-owned gpexe_* definition written in the approval.
  const definition = await planted(async () => {
    await admin.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_team_id, created_at)
                       select 'gpexe_time_min', 'TIME', 'team', $1, approved_at from training_load.gpexe_import_approvals where id = $2`, [t.teamId, S.first.approval.id]);
    return blocksOf(admin, [16]);
  });
  assert.equal(definition[16][0].gpexe_team_definitions, "1");
  assert.equal(definition[16][0].definitions_written_by_the_approval, "1");
});
