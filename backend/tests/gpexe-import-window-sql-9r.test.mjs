// Phase 9, 9-R (contract J17 section 10.3 steps 11 and 16, section 10.4): the
// read-only pre-switch preflight and the post-import check of the import
// window, run before they are handed over:
//   0 - the files' shape: LF, a comment-only header, blocks 1..N, each one plain
//       SELECT with no parameter, no meta-command and no write;
//   1 - the preflight on a world built like production's pilot (the three
//       system variables of O6 under their production keys, Required, at both
//       levels; one team bound to GPEXE team 980 on server3; one succeeded
//       check), each block sent exactly as the connector sends it
//       (begin transaction read only; block; rollback);
//   2 - one approval through the single-candidate route with the switch on,
//       then off, and the post-check the same way; the preflight run again
//       shows what it would stop on;
//   3 - what each file must stop on, planted (and rolled back) one at a time.
// On disposable optimove_tests_gpexe_* databases only; no GPEXE request (the
// fake server3 source), no credential (its marker values only).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { PLANTED, previewBundle } from "./support/preview-bundles.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { verifyRevisionRow } from "./support/source-revisions.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREFLIGHT = path.join(ROOT, "docs/runbooks/gpexe-import-window-preflight.sql");
const POSTCHECK = path.join(ROOT, "docs/runbooks/gpexe-import-window-postcheck.sql");
const V51 = "migrations_v2/202611011900_calendar_v51_settings.sql";
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

// Every block's output columns, exactly: a new printed column (an email, a
// credential, a stored source answer) fails a test before review.
const COLUMNS = {
  [PREFLIGHT]: {
    1: ["v51_rows", "v51_checksum_ok", "later_rows", "last_migration", "v2_rows"],
    2: ["running_checks", "running_identity_loads", "staged_observations"],
    3: ["idle_in_transaction", "import_table_write_locks", "advisory_locks"],
    4: ["source_system", "source_team_id", "binding_state", "team_name", "team_active", "club_active", "host_key", "api_family",
      "connection_owner_scope", "connection_club_is_team_club", "connection_state", "open_activations", "open_required"],
    5: ["variable_key", "source_metric_key", "requirement", "applies_to_session", "applies_to_drill", "version_number", "version_status",
      "source_unit", "target_unit", "scale", "scale_divisor", "value_offset", "revision_number", "revision_state", "evidence_status",
      "revision_source_unit", "variable_scope", "variable_state", "variable_unit", "min_value", "max_value", "as_decided"],
    6: ["first_team_bindings", "active_instances", "active_keys", "other_keys", "inactive_with_the_keys", "keys_held_elsewhere"],
    7: ["non_canonical_links"],
    8: ["approvals", "imported_candidates", "t6_rows", "gpexe_events", "import_batches", "gpexe_team_definitions", "gpexe_named_definitions"],
    9: ["candidate_id", "gpexe_session_id", "session_started_utc", "last_check_status", "last_check_is_newest", "last_check_through_the_binding",
      "drill_parameter_effect", "preview_version", "preview_status", "blocked_code", "results_created", "left_out_values", "changes_to_imported",
      "snapshot_available", "snapshot_expires_utc", "approval_id"],
    10: ["first_team_bindings", "actionable", "actionable_v3_ready", "imported", "pending", "blocked", "superseded", "newest_check_status",
      "newest_check_through_the_binding"],
    11: ["user_id", "name", "basis", "role_granted_utc", "role_changed_utc", "revoked_at_null"],
    12: ["first_team_bindings", "grant_id", "user_id", "name", "basis", "granted_utc", "user_active", "active_team_coach", "gives_the_right_now",
      "also_platform_admin"],
    13: ["first_team_bindings", "active_platform_admins", "unrevoked_grants", "grants_giving_the_right_now", "may_approve_now",
      "unrevoked_grants_all_teams"],
    14: ["row_no", "table_name", "row_count", "newest_utc", "time_column"],
  },
  [POSTCHECK]: {
    1: ["v51_rows", "v51_checksum_ok", "later_rows", "last_migration", "v2_rows"],
    2: ["approvals_total", "running_checks", "running_identity_loads", "team_checks_since_approval"],
    3: ["approvals_total", "first_team_bindings", "approval_of_the_first_team", "bound_to", "open_activations", "requirements", "approval_id",
      "approved_by_user_id", "approved_by_name", "approved_utc", "approval_basis", "no_grant", "changes_to_imported", "changes_accepted",
      "results_imported", "import_count_keys", "import_ids_recorded"],
    4: ["gpexe_session_id", "candidate_status", "imported_in_the_approval", "same_content", "stored_preview_is_the_approved_one",
      "preview_version", "preview_status", "drill_parameter_effect", "imported_candidates_total", "other_imported_candidates"],
    5: ["preview_results", "approval_results", "preview_results_created", "batch_occasions", "event_occasions", "preview_values",
      "written_values", "event_values", "t6_rows_of_the_import", "t6_rows_total", "preview_left_out", "preview_left_out_entries",
      "imported_athletes", "event_participants", "preview_changes_to_imported"],
    6: ["preview_values", "stored_values", "unmatched", "differing"],
    7: ["team_bindings", "team_instances", "values_of_the_import", "t6_rows", "values_without_t6", "t6_other_binding", "t6_other_instance",
      "t6_not_an_open_activation", "t6_not_the_pinned_version", "t6_outside_the_approval", "values_not_on_a_system_variable",
      "role_or_coverage_wrong", "activations_used", "open_activations"],
    8: ["instance_state", "source_host_key", "source_instance_key", "keys_are_the_bindings", "is_the_event_instance",
      "is_the_event_binding_instance", "identities_elsewhere", "rows_with_these_keys", "created_in_the_approval"],
    9: ["approvals_total", "left_out_entries", "left_out_with_a_stored_value", "left_out_stored_as_zero", "left_out_by_reason"],
    10: ["approvals_total", "gpexe_team_definitions", "gpexe_named_definitions", "definitions_written_by_the_approval",
      "versions_written_by_the_approval"],
    11: ["event_is_the_session", "event_owner_scope", "event_of_the_team", "scope_level", "event_created_in_the_approval",
      "threshold_binding_rows", "batch_ok", "activity_origin", "activity_lifecycle", "activity_of_the_team", "activity_created_in_the_approval",
      "confirmed_event_links", "activity_participants", "event_participants", "event_segments", "drill_components", "gpexe_events_total",
      "identities", "identities_without_occasion", "occasions_not_plain_created", "roster_decisions"],
  },
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

// Both files are pinned to v51 as written (their headers): the first window ran
// them on production at v51, and its record names their sha256. A later
// migration on main makes them stale for the NEXT window, which re-issues them
// before its step 11; the files as written are checked on the world they were
// pinned to, so the world is built through v51 only.
const THROUGH_V51 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(path.basename(V51)) + 1);

before(async () => {
  assert.equal(THROUGH_V51.at(-1), path.basename(V51), "the test migrations carry v51");
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "window_sql_9r", migrations: THROUGH_V51 });
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
  // Block 3 counts an autovacuum's lock on the import's tables: none may run
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
    assert.deepEqual(res[1].fields.map((f) => f.name), COLUMNS[file][n], `${path.basename(file)} block ${n}: exactly its columns`);
    out[n] = res[1].rows;
  }
  return out;
}

// The same blocks inside a transaction the test opened (a planted case, rolled
// back by the caller).
async function blocksIn(client, file, numbers) {
  const { blocks } = await fileBlocks(file);
  const out = {};
  for (const { n, part } of blocks) if (numbers.includes(n)) out[n] = (await client.query(part)).rows;
  return out;
}
async function planted(fn) {
  await admin.query("begin");
  try {
    await admin.query("set local session_replication_role = replica");
    return await fn();
  } finally {
    await admin.query("rollback");
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

test("0. both files: LF only, a comment-only header, blocks numbered 1..N once each, every block one plain SELECT with no parameter, meta-command or write", async () => {
  for (const [file, count] of [[PREFLIGHT, 14], [POSTCHECK, 11]]) {
    const name = path.basename(file);
    const { text, header, blocks } = await fileBlocks(file);
    assert.ok(!text.includes("\r"), `${name} has LF line endings`);
    assert.equal(header.split("\n").filter((line) => line.trim() && !line.startsWith("--")).length, 0, `${name}: the header holds comments only`);
    assert.deepEqual(blocks.map((b) => b.n), Array.from({ length: count }, (_, i) => i + 1), `${name}: blocks 1..${count}, in order, once each`);
    for (const { n, part } of blocks) {
      const sql = sqlOf(part);
      const where = `${name} block ${n}`;
      assert.match(sql, /^(select|with)\b/i, `${where} starts with select or with`);
      assert.equal(sql.split(";").length - 1, 1, `${where} has exactly one semicolon`);
      assert.ok(sql.endsWith(";"), `${where} ends with its semicolon`);
      assert.doesNotMatch(sql, /\$\d/, `${where} has no placeholder`);
      assert.doesNotMatch(sql, /^\s*\\/m, `${where} has no psql meta-command`);
      assert.doesNotMatch(sql, /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|call|do|vacuum|lock|set_config|nextval|setval|pg_advisory\w*|for\s+(update|share|no\s+key\s+update|key\s+share))\b/i, `${where} writes nothing and takes no lock`);
      assert.doesNotMatch(sql, /\b(email|password_hash|credential_\w+|grant_reason|revoke_reason|error_message)\b/i, `${where} reads no email, credential or free text`);
      assert.doesNotMatch(sql, /\braw_bundle\b(?!\s+is\s+not\s+null)/i, `${where} prints no stored source answer`);
      assert.equal(Object.keys(COLUMNS[file]).length, count);
    }
  }
});

test("1. step 11 on a world built like production's pilot: every block of the preflight, sent as the connector sends it, shows its expected value", async () => {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A01", "A02", "A03", "A04"] });
  await admin.query(`update public.teams set name = 'First team' where id = $1`, [org.teamId]);
  const padmin = await user("Pilot Admin", { platform: true });
  const coach = await user("Pilot Coach", { team: org.teamId });
  assert.equal((await api(`/gpexe/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: SOURCE_TEAM } })).status, 200);
  src.show(SOURCE_TEAM);
  const bound = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId: SOURCE_TEAM });
  const system = await pilotSystem(padmin.id);
  await activate(system, { bindingId: bound.bindingId, platformAdminId: padmin.id });
  for (const n of [1, 2, 3]) {
    const r = await api(`/gpexe/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId: gpexeAthlete(n), athleteId: org.athleteIds[n - 1] } });
    assert.equal(r.status, 201, r.text);
  }
  // A granted coach of the team (an approver grant the owner must accept).
  const granted = await user("Granted Coach", { team: org.teamId });
  await admin.query(`insert into training_load.gpexe_import_approvers (owner_team_id, user_id, granted_by_user_id, grant_reason) values ($1,$2,$3,'9-R test grant')`,
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

  const pre = await readOnlyBlocks(ro, PREFLIGHT);
  S.pre = pre;
  assert.deepEqual(pre[1], [{ v51_rows: "1", v51_checksum_ok: true, later_rows: "0", last_migration: V51, v2_rows: (await q(`select count(*)::text as n from public.schema_migrations where migration_name like 'migrations_v2/%'`))[0].n }]);
  assert.deepEqual(pre[2], [{ running_checks: "0", running_identity_loads: "0", staged_observations: "0" }]);
  assert.equal(pre[3][0].idle_in_transaction, "0");
  assert.equal(pre[3][0].import_table_write_locks, "0");
  assert.deepEqual(pre[4], [{
    source_system: "gpexe", source_team_id: "980", binding_state: "active", team_name: "First team", team_active: true, club_active: true,
    host_key: "server3", api_family: "rest_v1", connection_owner_scope: "club", connection_club_is_team_club: true, connection_state: "verified",
    open_activations: "3", open_required: "3",
  }]);
  assert.deepEqual(pre[5].map((r) => [r.variable_key, r.source_metric_key, r.as_decided]), [
    ["duration", "athlete_session.total_time", true],
    ["maximal_running_speed", "athlete_session.max_v", true],
    ["total_distance", "athlete_session.total_distance", true],
  ]);
  assert.deepEqual(pre[5].map((r) => [r.scale, r.scale_divisor, r.value_offset, r.source_unit, r.target_unit, r.max_value]), [
    ["1", "60", "0", "s", "min", null], ["3.6", "1", "0", "m/s", "km/h", "40"], ["1", "1", "0", "m", "m", null],
  ]);
  assert.deepEqual(pre[6], [{ first_team_bindings: "1", active_instances: "0", active_keys: null, other_keys: "0", inactive_with_the_keys: "0", keys_held_elsewhere: "0" }]);
  assert.deepEqual(pre[7], [{ non_canonical_links: "0" }]);
  assert.deepEqual(pre[8], [{ approvals: "0", imported_candidates: "0", t6_rows: "0", gpexe_events: "0", import_batches: "0", gpexe_team_definitions: "0", gpexe_named_definitions: "0" }]);
  assert.deepEqual(pre[9].map((r) => r.candidate_id).sort(), S.candidates.map((c) => c.id).sort(), "every actionable candidate, by id");
  for (const r of pre[9]) {
    const c = S.candidates.find((x) => x.id === r.candidate_id);
    assert.equal(r.gpexe_session_id, c.gpexe_team_session_id);
    assert.equal(r.last_check_status, "succeeded");
    assert.equal(r.last_check_is_newest, true);
    assert.equal(r.last_check_through_the_binding, true);
    assert.equal(r.drill_parameter_effect, c.drill_parameter_effect);
    assert.ok(["confirmed", "not_required"].includes(r.drill_parameter_effect));
    assert.equal(r.preview_version, "3");
    assert.equal(r.preview_status, "ready");
    assert.equal(r.blocked_code, null);
    assert.equal(Number(r.results_created), previewNumbers(c.preview).results);
    assert.equal(Number(r.left_out_values), previewNumbers(c.preview).leftOut);
    assert.equal(r.changes_to_imported, 0);
    assert.equal(r.snapshot_available, true);
    assert.equal(r.approval_id, null);
    const source = (await q(`select to_char(session_started_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as started,
                                    to_char(raw_expires_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as expires
                               from training_load.gpexe_import_candidates where id = $1`, [r.candidate_id]))[0];
    assert.equal(r.session_started_utc, source.started, "the date the owner recognises the session by");
    assert.equal(r.snapshot_expires_utc, source.expires);
    assert.ok(r.session_started_utc.startsWith(DAY));
  }
  assert.deepEqual(pre[10], [{ first_team_bindings: "1", actionable: "2", actionable_v3_ready: "2", imported: "0", pending: "2", blocked: "0", superseded: "0", newest_check_status: "succeeded", newest_check_through_the_binding: true }]);
  const admins = await q(`select r.user_id::text as id from public.user_global_roles r join public.users u on u.id = r.user_id
                           where r.role = 'platform_admin' and r.is_active and u.is_active`);
  assert.deepEqual(pre[11].map((r) => r.user_id).sort(), admins.map((a) => a.id).sort(), "every active platform admin");
  const pilot = pre[11].find((r) => r.user_id === padmin.id);
  assert.equal(pilot.name, "Pilot Admin");
  assert.equal(pilot.basis, "platform_admin");
  assert.equal(pilot.revoked_at_null, true);
  assert.match(pilot.role_granted_utc, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(pre[12].length, 1);
  assert.match(pre[12][0].grant_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...pre[12][0], grant_id: undefined, granted_utc: undefined }, {
    first_team_bindings: "1", grant_id: undefined, user_id: granted.id, name: "Granted Coach", basis: "team_grant", granted_utc: undefined,
    user_active: true, active_team_coach: true, gives_the_right_now: true, also_platform_admin: false,
  });
  assert.deepEqual(pre[13], [{ first_team_bindings: "1", active_platform_admins: String(admins.length), unrevoked_grants: "1", grants_giving_the_right_now: "1", may_approve_now: String(admins.length + 1), unrevoked_grants_all_teams: "1" }]);
  const fresh = Object.fromEntries(pre[14].map((r) => [Number(r.row_no), r]));
  assert.equal(pre[14].length, 38);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 34]) {
    assert.equal(fresh[n].row_count, "0", `freshness row ${n} (${fresh[n].table_name}) is empty before the approval`);
    assert.equal(fresh[n].newest_utc, null, `freshness row ${n} has no time before the approval`);
  }
  assert.ok(Number(fresh[35].row_count) >= 3 && Number(fresh[36].row_count) >= 1, "the freeze rows count the activations and the binding");
});

test("2. steps 13-16: one approval through the single route with the switch on, then off: every block of the post-check shows its expected value, and the preflight run again would stop", async () => {
  const t = S.t;
  const target = S.candidates[0];
  const r = await approve(t, target.id, target.preview_hash);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.outcome, "imported");
  assert.equal(process.env.GPEXE_IMPORT_APPLY_ENABLED, undefined, "the switch is off again");
  const n = previewNumbers(target.preview);
  assert.ok(n.results > 0 && n.values > 0);
  const approvalRow = (await q(`select id, approved_by_user_id::text as by from training_load.gpexe_import_approvals`))[0];
  assert.equal(approvalRow.id, r.body.approval.id);

  const post = await readOnlyBlocks(ro, POSTCHECK);
  assert.deepEqual(post[1], S.pre[1], "the migrations are unchanged");
  assert.deepEqual(post[2], [{ approvals_total: "1", running_checks: "0", running_identity_loads: "0", team_checks_since_approval: "0" }]);
  assert.deepEqual({ ...post[3][0], approved_utc: undefined }, {
    approvals_total: "1", first_team_bindings: "1", approval_of_the_first_team: true, bound_to: "980 @ server3", open_activations: "3",
    requirements: "required", approval_id: approvalRow.id, approved_by_user_id: t.padmin.id, approved_by_name: "Pilot Admin", approved_utc: undefined,
    approval_basis: "platform_admin", no_grant: true, changes_to_imported: 0, changes_accepted: false, results_imported: n.results,
    import_count_keys: "created", import_ids_recorded: true,
  });
  assert.deepEqual(post[4], [{
    gpexe_session_id: target.gpexe_team_session_id, candidate_status: "imported", imported_in_the_approval: true, same_content: true,
    stored_preview_is_the_approved_one: true, preview_version: "3", preview_status: "ready", drill_parameter_effect: target.drill_parameter_effect,
    imported_candidates_total: "1", other_imported_candidates: "0",
  }]);
  assert.deepEqual(post[5], [{
    preview_results: n.results, approval_results: n.results, preview_results_created: String(n.results), batch_occasions: String(n.results),
    event_occasions: String(n.results), preview_values: String(n.values), written_values: String(n.values), event_values: String(n.values),
    t6_rows_of_the_import: String(n.values), t6_rows_total: String(n.values), preview_left_out: n.leftOut,
    preview_left_out_entries: String(n.leftOut), imported_athletes: String(n.athletes), event_participants: String(n.athletes),
    preview_changes_to_imported: 0,
  }]);
  assert.deepEqual(post[6], [{ preview_values: String(n.values), stored_values: String(n.values), unmatched: "0", differing: "0" }]);
  assert.deepEqual(post[7], [{
    team_bindings: "1", team_instances: "1", values_of_the_import: String(n.values), t6_rows: String(n.values), values_without_t6: "0",
    t6_other_binding: "0", t6_other_instance: "0", t6_not_an_open_activation: "0", t6_not_the_pinned_version: "0",
    t6_outside_the_approval: "0", values_not_on_a_system_variable: "0", role_or_coverage_wrong: "0", activations_used: "3", open_activations: "3",
  }]);
  assert.deepEqual(post[8], [{
    instance_state: "active", source_host_key: "server3", source_instance_key: "980", keys_are_the_bindings: true, is_the_event_instance: true,
    is_the_event_binding_instance: true, identities_elsewhere: "0", rows_with_these_keys: "1", created_in_the_approval: true,
  }]);
  assert.deepEqual(post[9], [{ approvals_total: "1", left_out_entries: String(n.leftOut), left_out_with_a_stored_value: "0", left_out_stored_as_zero: "0",
    left_out_by_reason: n.leftOut === 0 ? {} : post[9][0].left_out_by_reason }]);
  assert.deepEqual(post[10], [{ approvals_total: "1", gpexe_team_definitions: "0", gpexe_named_definitions: "0", definitions_written_by_the_approval: "0", versions_written_by_the_approval: "0" }]);
  const drills = (await q(`select count(*)::text as n from training_load.metric_event_segments where event_id = $1`, [r.body.import.eventId]))[0].n;
  assert.ok(Number(drills) > 0, "the session has drills");
  assert.deepEqual(post[11], [{
    event_is_the_session: true, event_owner_scope: "team", event_of_the_team: true, scope_level: "session", event_created_in_the_approval: true,
    threshold_binding_rows: "1", batch_ok: true, activity_origin: "source_import", activity_lifecycle: "confirmed", activity_of_the_team: true,
    activity_created_in_the_approval: true, confirmed_event_links: "1", activity_participants: String(n.athletes), event_participants: String(n.athletes),
    event_segments: drills, drill_components: drills, gpexe_events_total: "1", identities: String(n.results + 1), identities_without_occasion: "1",
    occasions_not_plain_created: "0", roster_decisions: "0",
  }]);

  // The preflight run again now: block 8 and the freshness rows name the import.
  const again = await readOnlyBlocks(ro, PREFLIGHT);
  assert.deepEqual(again[8], [{ approvals: "1", imported_candidates: "1", t6_rows: String(n.values), gpexe_events: "1", import_batches: "1", gpexe_team_definitions: "0", gpexe_named_definitions: "0" }]);
  assert.deepEqual(again[9].map((x) => x.candidate_id), [S.candidates[1].id], "the imported candidate is no longer actionable");
  const approvedAt = (await q(`select to_char(approved_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as t from training_load.gpexe_import_approvals`))[0].t;
  const fresh = Object.fromEntries(again[14].map((x) => [Number(x.row_no), x]));
  for (const row of [1, 2, 3, 4, 5, 8, 9, 10, 11]) assert.equal(fresh[row].newest_utc, approvedAt, `freshness row ${row} names the approval's time`);
  assert.equal(again[6][0].active_keys, "server3 / 980");
  assert.equal(again[6][0].other_keys, "0");
  S.approval = approvalRow;
  S.eventId = r.body.import.eventId;
});

test("3a. the preflight stops on what it must stop on: a second binding with an open activation, a running check, a non-canonical link, other T7 keys, an activation not as decided, a candidate not actionable", async () => {
  const t = S.t;
  // A second binding with an open activation (a copy of one of the First team's).
  const two = await planted(async () => {
    const b2 = (await admin.query(
      `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id)
       select gen_random_uuid(), connection_id, source_system, '981', bound_by_user_id from training_load.source_team_bindings where id = $1 returning id, team_id`,
      [t.bindingId])).rows[0];
    await admin.query(
      `insert into training_load.source_metric_mapping_activations
         (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
          applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
       select mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, $2, $3,
              applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason
         from training_load.source_metric_mapping_activations where source_team_binding_id = $1 and ended_at is null limit 1`,
      [t.bindingId, b2.id, b2.team_id]);
    return blocksIn(admin, PREFLIGHT, [4, 6, 9, 10, 12, 13]);
  });
  assert.equal(two[4].length, 2, "block 4 lists both bindings");
  for (const b of [6, 10, 12, 13]) assert.equal(two[b][0].first_team_bindings, "2", `block ${b} shows two First-team candidates`);
  assert.equal(two[9].length, 0, "block 9 lists nothing for an ambiguous team");
  assert.equal(two[12].length, 1);
  assert.equal(two[12][0].grant_id, null, "block 12 says so itself instead of listing no grant");

  const running = await planted(async () => {
    await admin.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to) values ($1,$2,$3,$3)`,
      [t.teamId, t.coach.id, DAY]);
    return blocksIn(admin, PREFLIGHT, [2]);
  });
  assert.equal(running[2][0].running_checks, "1");

  const link = await planted(async () => {
    await admin.query(`update training_load.gpexe_athlete_links set gpexe_athlete_id = '07' where id = (select id from training_load.gpexe_athlete_links order by id limit 1)`);
    return blocksIn(admin, PREFLIGHT, [7]);
  });
  assert.deepEqual(link[7], [{ non_canonical_links: "1" }]);

  const keys = await planted(async () => {
    await admin.query(`update training_load.metric_source_connections set source_instance_key = '981' where owner_team_id = $1 and source_system = 'gpexe'`, [t.teamId]);
    return blocksIn(admin, PREFLIGHT, [6]);
  });
  assert.equal(keys[6][0].other_keys, "1");
  assert.equal(keys[6][0].active_keys, "server3 / 981");

  const optional = await planted(async () => {
    await admin.query(`update training_load.source_metric_mapping_activations set requirement = 'optional'
                        where id = (select a.id from training_load.source_metric_mapping_activations a
                                      join training_load.metric_definitions d on d.id = a.metric_definition_id
                                     where a.source_team_binding_id = $1 and a.ended_at is null and d.key = 'total_distance')`, [t.bindingId]);
    return blocksIn(admin, PREFLIGHT, [4, 5]);
  });
  assert.equal(optional[4][0].open_required, "2");
  assert.deepEqual(optional[5].map((r) => [r.variable_key, r.as_decided]), [["duration", true], ["maximal_running_speed", true], ["total_distance", false]]);

  // A conversion other than the decided one (3.7 instead of 3.6 for the speed).
  const factor = await planted(async () => {
    await admin.query(`update training_load.source_metric_mapping_versions set scale = 3.7 where id = $1`, [t.system.maximal_running_speed.versionId]);
    return blocksIn(admin, PREFLIGHT, [5]);
  });
  assert.deepEqual(factor[5].map((r) => [r.variable_key, r.scale, r.as_decided]), [["duration", "1", true], ["maximal_running_speed", "3.7", false], ["total_distance", "1", true]]);

  const notActionable = await planted(async () => {
    await admin.query(`update training_load.gpexe_import_candidates set drill_parameter_effect = 'not_observed' where id = $1`, [S.candidates[1].id]);
    return blocksIn(admin, PREFLIGHT, [9, 10]);
  });
  assert.equal(notActionable[9].length, 0);
  assert.equal(notActionable[10][0].actionable, "0");

  // A candidate whose last sighting is a failed check of the team.
  const failedCheck = await planted(async () => {
    const id = (await admin.query(
      `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to, status, finished_at, error_code)
       values ($1,$2,$3,$3,'failed', now(), 'internal_error') returning id`, [t.teamId, t.coach.id, DAY])).rows[0].id;
    await admin.query(`update training_load.gpexe_import_candidates set last_seen_check_id = $2 where id = $1`, [S.candidates[1].id, id]);
    return blocksIn(admin, PREFLIGHT, [9, 10]);
  });
  assert.equal(failedCheck[9].length, 0);
  assert.equal(failedCheck[10][0].actionable, "0");
  assert.equal(failedCheck[10][0].newest_check_status, "failed");

  // An ended activation is not open.
  const ended = await planted(async () => {
    await admin.query(`update training_load.source_metric_mapping_activations
                          set ended_at = now(), ended_by_user_id = activated_by_user_id, ended_basis = 'platform_admin', end_reason = 'admin_ended'
                        where id = (select a.id from training_load.source_metric_mapping_activations a
                                      join training_load.metric_definitions d on d.id = a.metric_definition_id
                                     where a.source_team_binding_id = $1 and a.ended_at is null and d.key = 'duration')`, [t.bindingId]);
    return blocksIn(admin, PREFLIGHT, [4, 5]);
  });
  assert.equal(ended[4][0].open_activations, "2");
  assert.deepEqual(ended[5].map((r) => r.variable_key), ["maximal_running_speed", "total_distance"]);

  // An inactive user's admin role and a revoked grant are not listed.
  const rights = await planted(async () => {
    await admin.query(`update public.users set is_active = false where id = $1`, [t.padmin.id]);
    await admin.query(`update training_load.gpexe_import_approvers set revoked_at = now(), revoked_by_user_id = $2, revoke_reason = '9-R test'
                        where owner_team_id = $1`, [t.teamId, t.padmin.id]);
    return blocksIn(admin, PREFLIGHT, [11, 12, 13]);
  });
  assert.ok(!rights[11].some((r) => r.user_id === t.padmin.id), "an inactive user is not an active platform admin");

  // The migrations: a later migration recorded, v51's checksum changed, v51 missing (both files' block 1).
  const later = await planted(async () => {
    await admin.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/202611021000_later.sql', repeat('a', 64), '9-R test')`);
    return { pre: await blocksIn(admin, PREFLIGHT, [1]), post: await blocksIn(admin, POSTCHECK, [1]) };
  });
  for (const r of [later.pre[1][0], later.post[1][0]]) {
    assert.equal(r.later_rows, "1");
    assert.equal(r.last_migration, "migrations_v2/202611021000_later.sql");
    assert.equal(r.v51_checksum_ok, true);
  }
  const checksum = await planted(async () => {
    await admin.query(`update public.schema_migrations set checksum = repeat('b', 64) where migration_name = $1`, [V51]);
    return { pre: await blocksIn(admin, PREFLIGHT, [1]), post: await blocksIn(admin, POSTCHECK, [1]) };
  });
  for (const r of [checksum.pre[1][0], checksum.post[1][0]]) assert.equal(r.v51_checksum_ok, false);
  const missing = await planted(async () => {
    await admin.query(`delete from public.schema_migrations where migration_name = $1`, [V51]);
    return { pre: await blocksIn(admin, PREFLIGHT, [1]), post: await blocksIn(admin, POSTCHECK, [1]) };
  });
  for (const r of [missing.pre[1][0], missing.post[1][0]]) {
    assert.equal(r.v51_rows, "0");
    assert.equal(r.v51_checksum_ok, null);
    assert.notEqual(r.last_migration, V51);
  }

  // A running identity load (block 2 of both files).
  const identity = await planted(async () => {
    await admin.query(`insert into training_load.gpexe_athlete_identity_requests (owner_team_id, binding_id, requested_by_user_id, request_key, targets)
                       values ($1,$2,$3,gen_random_uuid(),1)`, [t.teamId, t.bindingId, t.coach.id]);
    return { pre: await blocksIn(admin, PREFLIGHT, [2]), post: await blocksIn(admin, POSTCHECK, [2]) };
  });
  assert.equal(identity.pre[2][0].running_identity_loads, "1");
  assert.equal(identity.post[2][0].running_identity_loads, "1");

  // A real other session: idle in a transaction that holds a write lock on an
  // import table and an advisory lock, while the connector's session runs
  // block 3; a plain read lock alone is not counted.
  const other = new pg.Client({ connectionString: db.url });
  const elsewhereUrl = new URL(db.url);
  elsewhereUrl.pathname = "/postgres"; // the server's maintenance database: only an advisory lock, nothing written
  const elsewhere = new pg.Client({ connectionString: elsewhereUrl.toString() });
  try {
    await other.connect();
    assert.equal((await other.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
    await elsewhere.connect();
    assert.equal((await elsewhere.query("select current_database() as db")).rows[0].db, "postgres", "SAFETY: not the maintenance database");
    assert.equal((await elsewhere.query("select pg_try_advisory_lock(9120) as ok")).rows[0].ok, true, "the advisory lock is free");
    await other.query("begin");
    await other.query("select count(*) from training_load.metric_values");
    const reading = await readOnlyBlocks(ro, PREFLIGHT, [3]);
    assert.equal(reading[3][0].idle_in_transaction, "1");
    assert.equal(reading[3][0].import_table_write_locks, "0", "a plain read is not a write lock");
    await other.query("lock table training_load.metric_values in row exclusive mode");
    await other.query("select pg_advisory_xact_lock(9119)");
    const writing = await readOnlyBlocks(ro, PREFLIGHT, [3]);
    assert.equal(writing[3][0].idle_in_transaction, "1");
    assert.equal(writing[3][0].import_table_write_locks, "1");
    assert.equal(writing[3][0].advisory_locks, "1", "an advisory lock in another database is not counted");
  } finally {
    await other.query("rollback").catch(() => {});
    await other.end().catch(() => {});
    await elsewhere.query("select pg_advisory_unlock_all()").catch(() => {});
    await elsewhere.end().catch(() => {});
  }

  // The First team's instance with no keys yet (written before M4): block 6
  // accepts it, block 14 counts it in row 6 and not in row 7.
  const noKeys = await planted(async () => {
    await admin.query(`update training_load.metric_source_connections set source_host_key = null, source_instance_key = null
                        where owner_team_id = $1 and source_system = 'gpexe'`, [t.teamId]);
    return blocksIn(admin, PREFLIGHT, [6, 14]);
  });
  assert.equal(noKeys[6][0].active_instances, "1");
  assert.equal(noKeys[6][0].active_keys, "NULL / NULL");
  assert.equal(noKeys[6][0].other_keys, "0");
  const rowsNoKeys = Object.fromEntries(noKeys[14].map((r) => [Number(r.row_no), r]));
  assert.equal(rowsNoKeys[6].row_count, "1");
  assert.notEqual(rowsNoKeys[6].newest_utc, null);
  assert.equal(rowsNoKeys[7].row_count, "0");
  assert.deepEqual(rights[12].map((r) => [r.first_team_bindings, r.grant_id]), [["1", null]], "a revoked grant is not listed");
  assert.equal(rights[13][0].unrevoked_grants, "0");
});

test("3b. the post-check stops on what it must stop on: a second approval, a value without its T6 row, another candidate imported, a stored value where the preview left one out, a zero there", async () => {
  const t = S.t;
  const second = await planted(async () => {
    await admin.query(
      `insert into training_load.gpexe_import_approvals (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id,
                                                         approval_basis, changes_to_imported, changes_accepted, metric_event_id, activity_id, import_batch_id, import_counts)
       select c.id, c.owner_team_id, c.gpexe_team_session_id, c.bundle_hash, c.preview_hash, a.approved_by_user_id,
              a.approval_basis, 0, false, a.metric_event_id, a.activity_id, a.import_batch_id, a.import_counts
         from training_load.gpexe_import_candidates c, training_load.gpexe_import_approvals a where c.id = $1`, [S.candidates[1].id]);
    return blocksIn(admin, POSTCHECK, [2, 3, 4, 5, 7, 9, 10, 11]);
  });
  for (const b of [2, 3, 9, 10]) assert.equal(second[b][0].approvals_total, "2", `block ${b} shows the second approval itself`);
  assert.equal(second[3][0].approval_of_the_first_team, false);
  assert.equal(second[3][0].approval_id, null);
  assert.equal(second[4].length, 0);
  assert.equal(second[5][0].written_values, "0");
  assert.equal(second[11].length, 0);

  const missingT6 = await planted(async () => {
    await admin.query(`delete from training_load.metric_value_source_provenance where metric_value_id = (
                         select p.metric_value_id from training_load.metric_value_source_provenance p order by p.metric_value_id limit 1)`);
    return blocksIn(admin, POSTCHECK, [5, 7]);
  });
  assert.notEqual(missingT6[5][0].t6_rows_of_the_import, missingT6[5][0].written_values);
  assert.equal(missingT6[7][0].values_without_t6, "1");

  const otherImported = await planted(async () => {
    await admin.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() where id = $1`, [S.candidates[1].id]);
    return blocksIn(admin, POSTCHECK, [4]);
  });
  assert.equal(otherImported[4][0].imported_candidates_total, "2");
  assert.equal(otherImported[4][0].other_imported_candidates, "1");

  // A Left-out entry planted into the approved preview where a value is stored
  // (the athlete of the first created whole-session result, the duration
  // activation), then that value made a zero.
  const leftOut = async (zero) => planted(async () => {
    const row = (await admin.query(
      `select c.id, ath.ordinality - 1 as idx, ath.a ->> 'athleteId' as athlete_id
         from training_load.gpexe_import_candidates c
         join training_load.gpexe_import_approvals ap on ap.candidate_id = c.id,
              jsonb_array_elements(c.preview -> 'athletes') with ordinality as ath(a, ordinality)
        where ath.a ->> 'notImported' is null limit 1`)).rows[0];
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
            and o.segment_id is null and v.metric_definition_id = $3`, [S.eventId, row.athlete_id, activation.metric_definition_id]);
    }
    return blocksIn(admin, POSTCHECK, [9]);
  });
  const stored = await leftOut(false);
  assert.deepEqual(stored[9], [{ approvals_total: "1", left_out_entries: "1", left_out_with_a_stored_value: "1", left_out_stored_as_zero: "0", left_out_by_reason: { required_value_missing: 1 } }]);
  const zeroed = await leftOut(true);
  assert.equal(zeroed[9][0].left_out_stored_as_zero, "1");

  // The drill branch: a Left-out entry at the first drill result's level and
  // index, where a value is stored.
  const drillLeftOut = await planted(async () => {
    const row = (await admin.query(
      `select c.id, ath.idx - 1 as a_idx, (r.res ->> 'drillIndex')::int as drill_index
         from training_load.gpexe_import_candidates c
         join training_load.gpexe_import_approvals ap on ap.candidate_id = c.id,
              jsonb_array_elements(c.preview -> 'athletes') with ordinality as ath(a, idx),
              jsonb_array_elements(ath.a -> 'results') as r(res)
        where ath.a ->> 'notImported' is null and r.res ->> 'level' = 'drill' and r.res ->> 'outcome' = 'created'
        order by ath.idx, (r.res ->> 'drillIndex')::int limit 1`)).rows[0];
    const activation = (await admin.query(
      `select a.id from training_load.source_metric_mapping_activations a
         join training_load.metric_definitions d on d.id = a.metric_definition_id
        where a.source_team_binding_id = $1 and a.ended_at is null and d.key = 'total_distance'`, [t.bindingId])).rows[0];
    await admin.query(
      `update training_load.gpexe_import_candidates
          set preview = jsonb_set(preview, array['athletes', $2::text, 'skippedValues'],
                                  jsonb_build_array(jsonb_build_object('level', 'drill', 'drillIndex', $3::int, 'activationId', $4::text, 'reason', 'required_value_missing')))
        where id = $1`, [row.id, String(row.a_idx), row.drill_index, activation.id]);
    return blocksIn(admin, POSTCHECK, [9]);
  });
  assert.equal(drillLeftOut[9][0].left_out_entries, "1");
  assert.equal(drillLeftOut[9][0].left_out_with_a_stored_value, "1", "the drill branch finds the stored drill value");

  // An occasion of the approved event outside the import's batch: the event's
  // values and the batch's values differ.
  const outsideBatch = await planted(async () => {
    await admin.query(`update training_load.metric_measurement_occasions set import_batch_id = null
                        where id = (select o.id from training_load.metric_measurement_occasions o
                                      join training_load.metric_values v on v.occasion_id = o.id
                                     where o.import_batch_id is not null order by o.id limit 1)`);
    return blocksIn(admin, POSTCHECK, [5]);
  });
  assert.ok(Number(outsideBatch[5][0].event_values) > Number(outsideBatch[5][0].written_values), "event_values counts by the event, not the batch");

  // A check running after the approval (post-check block 2).
  const runningAfter = await planted(async () => {
    await admin.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to) values ($1,$2,$3,$3)`,
      [t.teamId, t.coach.id, DAY]);
    return blocksIn(admin, POSTCHECK, [2]);
  });
  assert.equal(runningAfter[2][0].running_checks, "1");
  assert.equal(runningAfter[2][0].team_checks_since_approval, "1");

  // A stored value that differs from its preview entry.
  const changed = await planted(async () => {
    await admin.query(`update training_load.metric_values set value_numeric = value_numeric + 1
                        where id = (select p.metric_value_id from training_load.metric_value_source_provenance p order by p.metric_value_id limit 1)`);
    return blocksIn(admin, POSTCHECK, [6]);
  });
  assert.equal(changed[6][0].differing, "1");
  assert.equal(changed[6][0].unmatched, "0");

  // A preview result that did not import (outcome not_imported): its values
  // are not values of the import.
  const notImported = await planted(async () => {
    const r = (await admin.query(
      `select c.id, ath.idx - 1 as a_idx, jsonb_array_length(ath.a -> 'results' -> 0 -> 'values') as k
         from training_load.gpexe_import_candidates c
         join training_load.gpexe_import_approvals ap on ap.candidate_id = c.id,
              jsonb_array_elements(c.preview -> 'athletes') with ordinality as ath(a, idx)
        where ath.a ->> 'notImported' is null limit 1`)).rows[0];
    await admin.query(`update training_load.gpexe_import_candidates set preview = jsonb_set(preview, array['athletes', $2::text, 'results', '0', 'outcome'], '"not_imported"') where id = $1`,
      [r.id, String(r.a_idx)]);
    return { k: Number(r.k), rows: await blocksIn(admin, POSTCHECK, [5, 6]) };
  });
  assert.ok(notImported.k > 0);
  assert.equal(Number(notImported.rows[5][0].preview_values), Number(notImported.rows[5][0].written_values) - notImported.k);
  assert.equal(notImported.rows[6][0].unmatched, String(notImported.k));

  // A stored value under another athlete than its preview entry.
  const otherAthlete = await planted(async () => {
    await admin.query(`update training_load.metric_event_participants set athlete_id = $2
                        where id = (select id from training_load.metric_event_participants where event_id = $1 order by id limit 1)`, [S.eventId, t.athleteIds[3]]);
    return blocksIn(admin, POSTCHECK, [6]);
  });
  assert.ok(Number(otherAthlete[6][0].differing) > 0);

  // A T6 row naming an open activation of another binding.
  const foreignActivation = await planted(async () => {
    const b2 = (await admin.query(
      `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id)
       select gen_random_uuid(), connection_id, source_system, '981', bound_by_user_id from training_load.source_team_bindings where id = $1 returning id, team_id`,
      [t.bindingId])).rows[0];
    const a2 = (await admin.query(
      `insert into training_load.source_metric_mapping_activations
         (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
          applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
       select mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, $2, $3,
              applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason
         from training_load.source_metric_mapping_activations where source_team_binding_id = $1 and ended_at is null limit 1 returning id`,
      [t.bindingId, b2.id, b2.team_id])).rows[0];
    await admin.query(`update training_load.metric_value_source_provenance set activation_id = $1
                        where metric_value_id = (select metric_value_id from training_load.metric_value_source_provenance order by metric_value_id limit 1)`, [a2.id]);
    return blocksIn(admin, POSTCHECK, [7]);
  });
  assert.equal(foreignActivation[7][0].t6_not_an_open_activation, "1");

  // Other T7 keys on the team's instance.
  const keys = await planted(async () => {
    await admin.query(`update training_load.metric_source_connections set source_instance_key = '981' where owner_team_id = $1 and source_system = 'gpexe'`, [t.teamId]);
    return blocksIn(admin, POSTCHECK, [8]);
  });
  assert.equal(keys[8][0].keys_are_the_bindings, false);
  assert.equal(keys[8][0].rows_with_these_keys, "0");

  // An administrator's variable created after the approval is not the import's.
  const later = await planted(async () => {
    await admin.query(`insert into training_load.metric_definitions (key, label, owner_scope, created_at) values ('later_variable', 'Later', 'system', now() + interval '1 second')`);
    return blocksIn(admin, POSTCHECK, [10]);
  });
  assert.equal(later[10][0].definitions_written_by_the_approval, "0");

  // A team-owned gpexe_* definition written in the approval, and a check of the team after the approval.
  const definition = await planted(async () => {
    await admin.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_team_id, created_at)
                       select 'gpexe_time_min', 'TIME', 'team', $1, approved_at from training_load.gpexe_import_approvals`, [t.teamId]);
    await admin.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to, status, finished_at)
                       values ($1,$2,$3,$3,'succeeded', now() + interval '1 second')`, [t.teamId, t.coach.id, DAY]);
    return blocksIn(admin, POSTCHECK, [2, 10]);
  });
  assert.equal(definition[10][0].gpexe_team_definitions, "1");
  assert.equal(definition[10][0].definitions_written_by_the_approval, "1");
  assert.equal(definition[2][0].team_checks_since_approval, "1");
});
