// Training Load METRICS correction round 2, point 2: a REAL end-to-end
// Builder HTTP flow — create -> publish -> record a real measurement ->
// open a real edit-draft -> submit it back — proving resolveParticipantLink
// (trainingLoadMetricsMeasurements.js) resolves the LIVE published session
// (never an ordinary unpublished draft, never a hidden edit-draft copy
// sharing the same logical_session_id) all the way through the real
// create/publish/edit/submit round trip a coach would actually perform,
// not just a hand-built fixture row.
//
// Unlike training-load-builder-edit-draft.test.mjs (the sibling file for
// training_load's own RPE feature, which runs directly against the real
// local OPTIMOVE database), this branch's own training_load.metric_*
// tables (migrations_v2 v10-v13) are NOT applied to local OPTIMOVE yet —
// they are this feature's own new, unreleased migrations. Applying them
// there would be a real, semi-permanent schema change to shared dev
// infrastructure, which this correction round's own constraints rule out
// (no writes to OPTIMOVE, no migration changes outside a disposable
// database). routes/builder.js's create/submit/edit routes, however, read
// and write dozens of plans.plans/plan_days/plan_sessions/
// app_notifications columns that only exist in an actual OPTIMOVE-shaped
// database and are no part of migrations_v2 — reconstructing that schema
// from scratch in a hand-written fixture would be exactly the "large,
// fragile undertaking" that sibling file's own header already warns
// against.
//
// This file instead builds a throwaway, uniquely-named CLONE database:
// a schema-only pg_dump of local OPTIMOVE (real structure, zero rows —
// see makeIsolatedClone below) plus a DATA-only dump of just
// public.schema_migrations/public.migration_cutovers (so the real record
// of which migrations are already applied, and the real legacy-cutover
// fingerprint, come along — never fabricated), then the real migrate.js
// runner applies ONLY this branch's own new v10-v13 files on top. Real
// schema, real HTTP flow, zero writes to OPTIMOVE, dropped in after().
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const baseUrl = new URL(ORIGINAL_DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();

function dbUrlFor(name) {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
}
function refuseForbidden(name, url) {
  if (name.toLowerCase() === "optimove" || /monitoring2/i.test(url)) {
    throw new Error("SAFETY: refusing to run against a forbidden database name");
  }
}

// Locates pg_dump/psql — not guaranteed to be on PATH on Windows. Reports
// a concrete, actionable blocker rather than silently falling back to
// applying migrations directly on OPTIMOVE.
const PG_BIN_CANDIDATES = [
  process.env.PG_BIN_DIR,
  "C:\\Program Files\\PostgreSQL\\17\\bin",
  "C:\\Program Files\\PostgreSQL\\16\\bin",
  "C:\\Program Files\\PostgreSQL\\15\\bin",
].filter(Boolean);
async function resolvePgBinary(name) {
  for (const dir of PG_BIN_CANDIDATES) {
    const candidate = path.join(dir, `${name}.exe`);
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  try {
    await execFileAsync(name, ["--version"]);
    return name; // already on PATH
  } catch {
    throw new Error(
      `BLOCKER: could not locate ${name} (checked ${PG_BIN_CANDIDATES.join(", ")} and PATH). ` +
        `Set PG_BIN_DIR to your PostgreSQL bin directory to run this test — refusing to fall back to ` +
        `applying migrations directly on OPTIMOVE.`,
    );
  }
}

// Builds a throwaway database that is a real schema-only clone of local
// OPTIMOVE (see this file's own header) — real plans.plans/plan_days/
// plan_sessions/app_notifications structure, zero rows, plus the REAL
// already-applied-migrations record so migrate.js's runner only applies
// this branch's own new v10-v13 files, never re-running or reinterpreting
// anything already deployed.
async function makeIsolatedClone(label) {
  const pgDump = await resolvePgBinary("pg_dump");
  const psql = await resolvePgBinary("psql");

  const name = `optimove_tlmetrics_builderflow_${label}_${crypto.randomBytes(6).toString("hex")}`;
  const url = dbUrlFor(name);
  refuseForbidden(name, url);

  const tmpDir = await fsp.mkdtemp(path.join(path.resolve(__dirname, "../../../"), ".tlmetrics-clone-"));
  const schemaFile = path.join(tmpDir, "schema.sql");
  const dataFile = path.join(tmpDir, "migration_tracking.sql");
  try {
    await execFileAsync(pgDump, ["--schema-only", "--no-owner", "--no-privileges", "-f", schemaFile, ORIGINAL_DATABASE_URL]);
    await execFileAsync(pgDump, ["--data-only", "--no-owner", "--table=public.schema_migrations", "--table=public.migration_cutovers", "-f", dataFile, ORIGINAL_DATABASE_URL]);

    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const cur = await admin.query("select current_database() as db");
    assert.equal(cur.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres database");
    await admin.query(`create database "${name}"`);
    await admin.end();

    await execFileAsync(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-f", schemaFile]);
    await execFileAsync(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-f", dataFile]);

    await runner.runMigrations({ databaseUrl: url, migrationsRoot: path.resolve(__dirname, "../../migrations_v2") });

    return { name, url };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}
async function dropClone({ name }) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists "${name}"`);
  await admin.end();
}

let db, server, apiBaseUrl, query, pool, createSession, hashPassword;

before(async () => {
  db = await makeIsolatedClone("primary");
  process.env.DATABASE_URL = db.url;
  const dbModule = await import("../src/db.js");
  query = dbModule.query;
  pool = dbModule.pool;
  const authModule = await import("../src/auth.js");
  createSession = authModule.createSession;
  hashPassword = authModule.hashPassword;
  const serverModule = await import("../src/server.js");

  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBaseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await dropClone(db);
});

async function api(urlPath, { method = "GET", cookie, body } = {}) {
  const res = await fetch(`${apiBaseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function uid() {
  return crypto.randomBytes(4).toString("hex");
}
async function makeCoachWithClub() {
  const clubResult = await query(`insert into public.clubs (name) values ($1) returning id`, [`TL metrics edit-draft clone club ${uid()}`]);
  const clubId = clubResult.rows[0].id;
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Coach', $2, 'TL Metrics Coach', 'TL Metrics Coach', 'club_admin', true) returning id`,
    [`tl-metrics-editdraft-coach-${uid()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const coachId = userResult.rows[0].id;
  await query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [coachId, clubId]);
  const token = await createSession(coachId);
  return { coachId, clubId, cookie: `optimove_session=${token}` };
}
async function makeAthleteInClub(clubId) {
  const externalId = `tlmetedit${Math.floor(Math.random() * 900000 + 100000)}`;
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Athlete', $2, 'TL Metrics Athlete', 'TL Metrics Athlete', 'athlete', true) returning id`,
    [`tl-metrics-editdraft-athlete-${uid()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const userId = userResult.rows[0].id;
  const athleteResult = await query(
    `insert into public.athletes (user_id, athlete_id, source_external_id, first_name, last_name, full_name, display_name, device_timezone, is_active)
     values ($1,$2,$2,'TL','Athlete','TL Metrics Athlete','TL Metrics Athlete','UTC',true) returning id`,
    [userId, externalId],
  );
  const athleteId = athleteResult.rows[0].id;
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  const token = await createSession(userId);
  return { athleteId, externalId, cookie: `optimove_session=${token}` };
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
function mondayOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDate(d);
}
const TODAY_DATE = new Date();
TODAY_DATE.setUTCHours(0, 0, 0, 0);
const TODAY = isoDate(TODAY_DATE);
const WEEK_START = mondayOf(TODAY);

let sysAdminCookie;
async function ensureSystemDefinition() {
  const sysAdminId = (await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1,'TL','SysAdmin',$2,'TL SysAdmin','TL SysAdmin','user',true) returning id`,
    [`tl-metrics-editdraft-sysadmin-${uid()}@test.local`, hashPassword("irrelevant-password-123")],
  )).rows[0].id;
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [sysAdminId]);
  const token = await createSession(sysAdminId);
  sysAdminCookie = `optimove_session=${token}`;
  const res = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: sysAdminCookie,
    body: { key: `tl_metrics_editdraft_distance_${uid()}`, label: "Edit-draft Distance", ownerScope: "system", unit: "m", valueType: "numeric" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.row;
}

test("a real Builder create -> publish -> measurement -> edit-draft -> submit HTTP flow preserves the measurement's identity and historical snapshot, and correctly re-targets the recreated live session for a NEW measurement", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const def = await ensureSystemDefinition();

  // 1) CREATE, through the real route — a weekly plan for this athlete.
  const createRes = await api("/api/builder/plans", {
    method: "POST", cookie: coach.cookie,
    body: { planType: "weekly", weekStart: WEEK_START, athleteIds: [athlete.externalId] },
  });
  assert.equal(createRes.status, 201, `expected the plan to be created, got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
  const livePlanId = createRes.body.plan.id;
  assert.equal(createRes.body.plan.status, "draft", "a freshly created plan starts as an unpublished draft");

  // Real ownership snapshot inserted automatically by POST /plans itself —
  // no manual stamping needed (unlike a hand-built raw-SQL fixture).
  const ownershipRow = await query(`select owner_scope, owner_club_id from training_load.plan_workspace_ownership where plan_id = $1`, [livePlanId]);
  assert.equal(ownershipRow.rows[0]?.owner_scope, "club");
  assert.equal(ownershipRow.rows[0]?.owner_club_id, coach.clubId);

  // Add one real session into the plan's first day (a weekly plan's own
  // "block" IS one of its 7 auto-created plan_days rows — see
  // getEditableBlock's own header in routes/builder.js).
  const todayDayRow = await query(`select id from plans.plan_days where plan_id = $1 and date = $2`, [livePlanId, TODAY]);
  const todayDayId = todayDayRow.rows[0].id;
  const addSessionRes = await api(`/api/builder/blocks/${todayDayId}/sessions`, { method: "POST", cookie: coach.cookie, body: { name: "Metrics edit-draft session" } });
  assert.equal(addSessionRes.status, 201, `expected the session to be added, got ${addSessionRes.status}: ${JSON.stringify(addSessionRes.body)}`);
  const sessionRow = await query(`select id, logical_session_id from plans.plan_sessions where plan_day_id = $1`, [todayDayId]);
  const sessionId = sessionRow.rows[0].id;
  const logicalSessionId = sessionRow.rows[0].logical_session_id;
  assert.ok(logicalSessionId, "a real session insert must get a real logical_session_id");

  // A session with no nodes at all is "empty" (planHasWeeklyTrainingContentWithClient)
  // and would get silently DELETED by submit's own removeEmptyDraftOnSubmit
  // guard instead of published — add one real section node so this plan
  // has genuine content, exactly like a coach would before publishing.
  const addNodeRes = await api(`/api/builder/sessions/${sessionId}/nodes`, { method: "POST", cookie: coach.cookie, body: { nodeType: "section", name: "Warm-up" } });
  assert.equal(addNodeRes.status, 201, `expected the section node to be added, got ${addNodeRes.status}: ${JSON.stringify(addNodeRes.body)}`);

  // Before publishing, resolveParticipantLink must reject this session —
  // already proven at the query level by the disposable-DB suite's own
  // test 21c; this file's own focus is the full real round trip once
  // published, so it proceeds straight to that.

  // 2) PUBLISH, through the real route — draft -> active.
  const submitRes = await api(`/api/builder/plans/${livePlanId}/submit`, { method: "POST", cookie: coach.cookie });
  assert.equal(submitRes.status, 200, `expected the plan to publish, got ${submitRes.status}: ${JSON.stringify(submitRes.body)}`);
  assert.equal(submitRes.body.plan.status, "active");

  // 3) MEASUREMENT, through the real training-load-metrics route, linked
  // to the just-published live session.
  const measureRes = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coach.cookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: TODAY, scopeLevel: "session",
      participants: [{ athleteId: athlete.athleteId, timezone: "UTC", logicalSessionId, values: [{ metricDefinitionId: def.id, metricDefinitionVersionId: def.current_version_id, value: 4200 }] }],
    },
  });
  assert.equal(measureRes.status, 201, `expected the measurement to be accepted against the live published session, got ${measureRes.status}: ${JSON.stringify(measureRes.body)}`);
  const occasionId = measureRes.body.participants[0].occasionIds[0];

  const beforeDetail = await api(`/api/training-load/metrics/occasions/${occasionId}`, { cookie: coach.cookie });
  assert.equal(beforeDetail.status, 200);
  assert.equal(beforeDetail.body.occasion.linked_session_name_snapshot, "Metrics edit-draft session");

  // 4) EDIT-DRAFT, through the real route — opens a genuinely separate
  // draft plan row, copying the session tree with logical_session_id
  // preserved (copyWeeklyPlanTree's own preserveLogicalId: true).
  const editRes = await api(`/api/builder/plans/${livePlanId}/edit`, { method: "POST", cookie: coach.cookie });
  assert.equal(editRes.status, 200, `expected the edit-draft to open, got ${editRes.status}: ${JSON.stringify(editRes.body)}`);
  const draftPlanId = editRes.body.plan.id;
  assert.notEqual(draftPlanId, livePlanId, "the edit-draft is a genuinely different plan row while it's open");

  // While the edit-draft is open, its OWN copy of the session shares the
  // SAME logical_session_id as the live one — resolveParticipantLink must
  // still resolve the LIVE row (is_edit_draft=false), never the draft
  // copy, for a measurement submitted DURING the edit.
  const midEditMeasure = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coach.cookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: TODAY, scopeLevel: "session",
      participants: [{ athleteId: athlete.athleteId, timezone: "UTC", logicalSessionId, values: [{ metricDefinitionId: def.id, metricDefinitionVersionId: def.current_version_id, value: 100 }] }],
    },
  });
  assert.equal(midEditMeasure.status, 201, `expected a measurement during the open edit-draft to still resolve the LIVE session, got ${midEditMeasure.status}: ${JSON.stringify(midEditMeasure.body)}`);
  const midEditDetail = await api(`/api/training-load/metrics/occasions/${midEditMeasure.body.participants[0].occasionIds[0]}`, { cookie: coach.cookie });
  assert.equal(midEditDetail.body.occasion.linked_session_name_snapshot, "Metrics edit-draft session", "must resolve the LIVE session's own name, never the open draft's copy");

  // 5) SUBMIT the edit-draft back, through the real route — no content
  // change, the exact real-world "opened Edit, then clicked Save and
  // finish" trigger for applyEditDraft()'s delete-and-recreate of the
  // live plan's entire session tree.
  const submitDraftRes = await api(`/api/builder/plans/${draftPlanId}/submit`, { method: "POST", cookie: coach.cookie });
  assert.equal(submitDraftRes.status, 200, `expected the edit-draft to apply back onto the live plan, got ${submitDraftRes.status}: ${JSON.stringify(submitDraftRes.body)}`);
  assert.equal(submitDraftRes.body.plan.id, livePlanId, "applyEditDraft() re-activates the ORIGINAL live plan id, not a new one");

  const recreatedSessionRow = await query(
    `select ps.id, ps.logical_session_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1`,
    [livePlanId],
  );
  const newSessionId = recreatedSessionRow.rows[0].id;
  assert.notEqual(newSessionId, sessionId, "applyEditDraft really did delete and recreate the session row");
  assert.equal(recreatedSessionRow.rows[0].logical_session_id, logicalSessionId, "the recreated session keeps the SAME logical_session_id — this is exactly what makes the earlier measurements still resolvable");

  // 6) Both earlier measurements must still exist, unaffected — their
  // snapshot and identity survive the physical row's deletion/recreation.
  const afterDetail = await api(`/api/training-load/metrics/occasions/${occasionId}`, { cookie: coach.cookie });
  assert.equal(afterDetail.status, 200);
  assert.equal(afterDetail.body.occasion.linked_session_name_snapshot, "Metrics edit-draft session", "the ORIGINAL measurement's snapshot survives the session row being deleted and recreated");
  assert.equal(Number(afterDetail.body.values[0].value_numeric), 4200);

  // 7) A genuinely NEW measurement submitted AFTER the round trip, using
  // the SAME logical_session_id, must resolve to the RECREATED live
  // session (the new physical row) — never fail, never silently attach to
  // the old, now-orphaned row.
  const afterEditMeasure = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coach.cookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: TODAY, scopeLevel: "session",
      participants: [{ athleteId: athlete.athleteId, timezone: "UTC", logicalSessionId, values: [{ metricDefinitionId: def.id, metricDefinitionVersionId: def.current_version_id, value: 4400 }] }],
    },
  });
  assert.equal(afterEditMeasure.status, 201, `expected a fresh measurement after the edit round trip to resolve the recreated live session, got ${afterEditMeasure.status}: ${JSON.stringify(afterEditMeasure.body)}`);
  const afterEditDetail = await api(`/api/training-load/metrics/occasions/${afterEditMeasure.body.participants[0].occasionIds[0]}`, { cookie: coach.cookie });
  assert.equal(afterEditDetail.body.occasion.linked_session_name_snapshot, "Metrics edit-draft session");

  // Manual SQL rename/delete (the disposable-DB suite's own test 13)
  // remains a useful, narrower additional check — this file's own value
  // is proving the SAME invariant survives the REAL Builder mechanics end
  // to end, not replacing that check.
});
