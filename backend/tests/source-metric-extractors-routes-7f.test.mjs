// Phase 7f - the extractor registry through the real routes: T4 create (POST
// /mappings/:id/versions), A1 (POST /mappings/:id/versions/:id/activate) and
// GET /fields, GET /fields/:fieldId. Contract:
// docs/ai/phase7f-extractor-registry-contract.md (J12), sections 3 and 7.
// Through the real HTTP stack on one disposable optimove_tests_gpexe_* database
// migrated through the last test migration (never OPTIMOVE, never a GPEXE
// request). The seeded gpexe / rest_v1 fields are the database's own (v34, v42);
// their revisions are confirmed here by the shared fixtures, on this database
// only. This suite does NOT let synthetic keys through the registry, except for
// two A1 cases that build a version as one made before phase 7f.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";
import { verifyRevisionRow, writeRevision } from "./support/source-revisions.mjs";
import { EXTRACTORS, extractorFor, setExtractorFallbackForTests } from "../src/sourceMetricExtractors.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";

let db, k, server, apiBase, service, dbModule, appPool, createSession;
const W = {};
const responses = [];

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "x7f" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  setExtractorFallbackForTests(null);
  service?.setMappingRightsHoldForTests(null);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();
async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const post = (p, cookie, body) => api(p, { method: "POST", cookie, body });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const isNotFound = (res, label) => { assert.equal(res.status, 404, `${label}: ${res.text}`); assert.deepEqual(res.body, { error: "notFound" }, label); };

async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
async function platformAdmin() {
  const id = await user("platform-admin");
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await workspace(id, "platform", null);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdmin(clubId) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(`insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;

// A seeded gpexe / rest_v1 field and its revision 1.
async function seeded(sourceMetricKey) {
  return one(`select d.id as "fieldId", r.id as "revId" from training_load.source_metric_definitions d
                join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.revision_number = 1
               where d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.source_metric_key = $1`, [sourceMetricKey]);
}
// The unit act and the meaning act on a revision (the shared fixture, every guard on).
const confirm = (f, { unit, boundUnit = null, operator = null }) => verifyRevisionRow(k, {
  fieldId: f.fieldId, revisionId: f.revId, by: W.pa.id, unit, boundUnit, unitRef: UNIT_REF, meaning: true, operator, meaningRef: MEANING_REF,
});
// A synthetic test field of gpexe / <apiFamily> whose revision 1 is active and verified.
async function synthetic({ apiFamily = "rest_v1", valueShape = "number", parameterKind = "none", unit = "s", boundUnit = null, operator = null } = {}) {
  const fieldId = (await one(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe',$1,$2,'7f test field',$3) returning id`,
    [apiFamily, `x7f.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape, parameterKind, evidenceRef: COMPAT, unit, boundUnit, unitRef: UNIT_REF, meaning: true, operator, meaningRef: MEANING_REF, state: "active" });
  return { fieldId, revId };
}
// A system canonical variable through the M3-0 API.
async function variable({ unit = "s", condition } = {}) {
  const res = await post("/variables", W.pa.cookie, { requestKey: key(), label: `Extractor variable ${uid()}`, unit, levels: ["session", "drill"], dailyAggregationMethod: "sum", ...(condition ? { condition } : {}) });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
async function mapping(f, target, owner = W.pa) {
  return ok(await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id }), 201).mapping.id;
}
const versionBody = (f, sourceParameters, requestKey = key()) => ({ requestKey, sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true, ...(sourceParameters === undefined ? {} : { sourceParameters }) });
const createVersion = (mappingId, f, sourceParameters, cookie = W.pa.cookie, requestKey = key()) => post(`/mappings/${mappingId}/versions`, cookie, versionBody(f, sourceParameters, requestKey));
const submit = (mappingId, versionId) => post(`/mappings/${mappingId}/versions/${versionId}/submit`, W.pa.cookie, { requestKey: key() });
const activate = (mappingId, versionId, cookie = W.pa.cookie) => post(`/mappings/${mappingId}/versions/${versionId}/activate`, cookie, { requestKey: key(), expectedActiveVersionId: null });
const t4Count = async () => (await one(`select count(*)::int as n from training_load.source_metric_mapping_versions`)).n;
const auditCount = async () => (await one(`select count(*)::int as n from training_load.source_metric_audit`)).n;
const statusOf = async (versionId) => (await one(`select status from training_load.source_metric_mapping_versions where id = $1`, [versionId])).status;
const SYNTHETIC = Object.freeze({ key: "synthetic", valueShape: null, parameterKind: null, zone: null, direction: null, checkParameters: () => null, extract: () => ({ skip: "x" }) });

async function world() {
  W.pa = await platformAdmin();
  W.clubA = await club("Club A");
  W.caA = await clubAdmin(W.clubA);
}

// Every refusal names its code only, never a key's parameter or number.
function codeOnly(res) {
  for (const needle of ["75", "5.5", "2.5", "W/kg", "m/s2", "lower", "upper", "threshold_value"]) assert.ok(!res.text.includes(needle), `${needle} in ${res.text}`);
}

test("1. the registry against the seed: the ten gpexe / rest_v1 fields of v34 and v42, revision 1 of each with the entry's value shape and parameter kind; no seeded field without an entry, no entry without a field; the suite runs without the test seam", async () => {
  const rows = (await k.query(
    `select d.source_metric_key, r.value_shape, r.parameter_kind, d.seed_migration
       from training_load.source_metric_definitions d
       join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.revision_number = 1
      where d.source_system = 'gpexe' and d.seed_migration is not null
      order by 1`,
  )).rows;
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => `gpexe/rest_v1/${r.source_metric_key}`).sort(), Object.keys(EXTRACTORS).sort());
  for (const r of rows) {
    const e = extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: r.source_metric_key });
    assert.ok(e, r.source_metric_key);
    assert.deepEqual([e.valueShape, e.parameterKind], [r.value_shape, r.parameter_kind], r.source_metric_key);
  }
  assert.equal(extractorFor({ sourceSystem: "gpexe", apiFamily: "rest_v1", sourceMetricKey: "x7f.test.f00" }), null, "no fallback is set in this suite");
});

test("2. GET /fields and GET /fields/:fieldId carry extractorAvailable: true for the ten seeded fields, false for a field the registry does not read; the field's key set is exact", async () => {
  const f = await synthetic();
  const list = ok(await api("/fields", { cookie: W.pa.cookie })).fields;
  const byKey = new Map(list.map((x) => [x.key, x]));
  for (const k10 of Object.keys(EXTRACTORS)) assert.equal(byKey.get(k10.replace("gpexe/rest_v1/", "")).extractorAvailable, true, k10);
  const mine = list.find((x) => x.id === f.fieldId);
  assert.equal(mine.extractorAvailable, false);
  assert.deepEqual(Object.keys(mine).sort(), ["apiFamily", "extractorAvailable", "id", "key", "label", "revisions", "sourceSystem", "state"]);
  const seededTime = await seeded("athlete_session.total_time");
  const one1 = ok(await api(`/fields/${seededTime.fieldId}`, { cookie: W.pa.cookie }));
  assert.equal(one1.field.extractorAvailable, true);
  assert.deepEqual(Object.keys(one1.field).sort(), ["apiFamily", "extractorAvailable", "id", "key", "label", "revisions", "sourceSystem", "state"]);
  assert.equal(ok(await api(`/fields/${f.fieldId}`, { cookie: W.pa.cookie })).field.extractorAvailable, false);
  // The same boolean for a club admin (a fact of code, the same for every reader).
  assert.equal(ok(await api(`/fields/${seededTime.fieldId}`, { cookie: W.caA.cookie })).field.extractorAvailable, true);
});

test("3. T4 create: a field the registry does not read is 409 source_metric_unsupported with nothing written (no version, no audit row, the key free); an api-family field too; a caller outside the mapping's scope still gets the identical 404", async () => {
  const f = await synthetic();
  const target = await variable();
  const m = await mapping(f, target);
  const [t4, audit] = [await t4Count(), await auditCount()];
  const requestKey = key();
  const res = await createVersion(m, f, undefined, W.pa.cookie, requestKey);
  refused(res, 409, "source_metric_unsupported");
  codeOnly(res);
  assert.deepEqual([await t4Count(), await auditCount()], [t4, audit], "nothing written");
  assert.equal((await one(`select count(*)::int as n from training_load.source_metric_audit where request_key = $1`, [requestKey])).n, 0);
  refused(await createVersion(m, f, undefined, W.pa.cookie, requestKey), 409, "source_metric_unsupported");
  // The api family has no entry, even for a key the rest_v1 family reads.
  const apiField = await synthetic({ apiFamily: "api" });
  const mApi = await mapping(apiField, await variable());
  refused(await createVersion(mApi, apiField), 409, "source_metric_unsupported");
  // The 404s come first: a club admin, and an unknown mapping.
  isNotFound(await createVersion(m, f, undefined, W.caA.cookie), "a club admin on a system mapping");
  isNotFound(await createVersion(crypto.randomUUID(), f), "an unknown mapping");
  // The registry's 409 comes before the target side's: a field in seconds into a
  // variable in metres has no conversion, and still answers the registry's code.
  const mNoConversion = await mapping(f, await variable({ unit: "m" }));
  refused(await createVersion(mNoConversion, f), 409, "source_metric_unsupported");
});

test("4. T4 create on seeded fields: a field without parameters and the open top zone are created; a >= confirmed on the closed power key, between on the speed key and >= on the deceleration key are 409 parameters_unsupported before anything is written", async () => {
  // Kind none: total_time in seconds into a variable in seconds.
  const time = await seeded("athlete_session.total_time");
  await confirm(time, { unit: "s" });
  const mTime = await mapping(time, await variable({ unit: "s" }));
  const vTime = ok(await createVersion(mTime, time), 201).version;
  assert.deepEqual(vTime.sourceParameters, {});
  // The open top zone, >= 75 W/kg.
  const openTop = await seeded("more.complementary_data.power.distance.open_top");
  await confirm(openTop, { unit: "m", boundUnit: "W/kg", operator: ">=" });
  const mTop = await mapping(openTop, await variable({ unit: "m", condition: { kind: "zone", operator: ">=", value: "75", unit: "W/kg" } }));
  ok(await createVersion(mTop, openTop, { lower: "75", upper: null }), 201);
  // An acceleration count, >= 2.5 m/s2 for 0.3 s.
  const acc = await seeded("more.events.acceleration_events_count");
  await confirm(acc, { unit: "count", boundUnit: "m/s2", operator: ">=" });
  const mAcc = await mapping(acc, await variable({ unit: "count", condition: { kind: "event_threshold", operator: ">=", value: "2.5", durationSeconds: "0.3", unit: "m/s2" } }));
  ok(await createVersion(mAcc, acc, { thresholdValue: "2.5", durationSeconds: "0.3" }), 201);
  // The operators the registry refuses for their key's shape (J7's obligation).
  const closed = await seeded("more.complementary_data.power.distance");
  await confirm(closed, { unit: "m", boundUnit: "W/kg", operator: ">=" });
  const mClosed = await mapping(closed, await variable({ unit: "m", condition: { kind: "zone", operator: ">=", value: "75", unit: "W/kg" } }));
  const speed = await seeded("more.complementary_data.speed.distance");
  await confirm(speed, { unit: "m", boundUnit: "m/s", operator: "between" });
  const mSpeed = await mapping(speed, await variable({ unit: "m", condition: { kind: "zone", operator: "between", lower: "5.5", upper: "7", unit: "m/s" } }));
  const dec = await seeded("more.events.deceleration_events_count");
  await confirm(dec, { unit: "count", boundUnit: "m/s2", operator: ">=" });
  const mDec = await mapping(dec, await variable({ unit: "count", condition: { kind: "event_threshold", operator: ">=", value: "-2.5", durationSeconds: "0.3", unit: "m/s2" } }));
  const [t4, audit] = [await t4Count(), await auditCount()];
  const r1 = await createVersion(mClosed, closed, { lower: "75", upper: null });
  refused(r1, 409, "parameters_unsupported");
  codeOnly(r1);
  refused(await createVersion(mSpeed, speed, { lower: "5.5", upper: "7" }), 409, "parameters_unsupported");
  refused(await createVersion(mDec, dec, { thresholdValue: "-2.5", durationSeconds: "0.3" }), 409, "parameters_unsupported");
  assert.deepEqual([await t4Count(), await auditCount()], [t4, audit], "nothing written");
  // The input checks of M2 still answer first (400 before 409).
  refused(await createVersion(mClosed, closed, { lower: "x" }), 400, "invalid_parameters");
  // A supported field still meets the target side's refusals after the registry:
  // burst events (a count) into a variable in metres has no conversion.
  const burst = await seeded("details.players.tot_burst_events");
  await confirm(burst, { unit: "count" });
  refused(await createVersion(await mapping(burst, await variable({ unit: "m" })), burst), 409, "conversion_unavailable");
});

test("5. T4 create: a later revision of a seeded field with another value shape is source_metric_unsupported (the registry reads only the shape of its entry)", async () => {
  const distance = await seeded("athlete_session.total_distance");
  const r2 = await writeRevision(k, { fieldId: distance.fieldId, by: W.pa.id, revisionNumber: 2, valueShape: "unit_value_object", parameterKind: "none", evidenceRef: COMPAT, unit: "m", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "draft" });
  const m = await mapping(distance, await variable({ unit: "m" }));
  refused(await createVersion(m, { fieldId: distance.fieldId, revId: r2 }), 409, "source_metric_unsupported");
  // Revision 1, the entry's own shape, is still created.
  await confirm(distance, { unit: "m" });
  ok(await createVersion(m, distance), 201);
});

test("6. A1: a supported version is activated; a version made before phase 7f (built here with the test seam) is refused at A1 with 409 source_metric_unsupported or parameters_unsupported, after the 404s, after the right and after the state refusals, with nothing written", async () => {
  // A supported version (max_v, m/s) activates.
  const maxV = await seeded("athlete_session.max_v");
  await confirm(maxV, { unit: "m/s" });
  const mMax = await mapping(maxV, await variable({ unit: "m/s" }));
  const vMax = ok(await createVersion(mMax, maxV), 201).version;
  ok(await submit(mMax, vMax.id));
  ok(await activate(mMax, vMax.id));
  assert.equal(await statusOf(vMax.id), "active");
  // A version of a field the registry does not read, made "before 7f".
  const f = await synthetic();
  const m = await mapping(f, await variable());
  setExtractorFallbackForTests(() => SYNTHETIC);
  let v;
  try {
    v = ok(await createVersion(m, f), 201).version;
  } finally {
    setExtractorFallbackForTests(null);
  }
  // A draft: the state refusal comes before the registry's.
  refused(await activate(m, v.id), 409, "version_not_submitted");
  ok(await submit(m, v.id));
  // Outside the scope: the identical 404 (a club admin may not run A1 at all).
  isNotFound(await activate(m, v.id, W.caA.cookie), "a club admin");
  // The right is checked again before the registry: a revoked platform admin gets the 404.
  service.setMappingRightsHoldForTests(async (client) => { await client.query(`update public.user_global_roles set is_active = false where user_id = $1`, [W.pa.id]); });
  try {
    isNotFound(await activate(m, v.id), "the right revoked during A1");
  } finally {
    service.setMappingRightsHoldForTests(null);
    await k.query(`update public.user_global_roles set is_active = true where user_id = $1`, [W.pa.id]);
  }
  const [t4, audit] = [await t4Count(), await auditCount()];
  const res = await activate(m, v.id);
  refused(res, 409, "source_metric_unsupported");
  codeOnly(res);
  assert.equal(await statusOf(v.id), "needs_review");
  assert.deepEqual([await t4Count(), await auditCount()], [t4, audit], "nothing written");
  // A zone version made "before 7f" with an operator its entry refuses: the real
  // closed-power entry answers for the synthetic key at A1.
  const z = await synthetic({ valueShape: "zone_distance", parameterKind: "zone_bounds", unit: "m", boundUnit: "W/kg", operator: ">=" });
  const mz = await mapping(z, await variable({ unit: "m", condition: { kind: "zone", operator: ">=", value: "75", unit: "W/kg" } }));
  setExtractorFallbackForTests(() => SYNTHETIC);
  let vz;
  try {
    vz = ok(await createVersion(mz, z, { lower: "75", upper: null }), 201).version;
  } finally {
    setExtractorFallbackForTests(null);
  }
  ok(await submit(mz, vz.id));
  setExtractorFallbackForTests(() => EXTRACTORS["gpexe/rest_v1/more.complementary_data.power.distance"]);
  try {
    const rz = await activate(mz, vz.id);
    refused(rz, 409, "parameters_unsupported");
    codeOnly(rz);
  } finally {
    setExtractorFallbackForTests(null);
  }
  assert.equal(await statusOf(vz.id), "needs_review");
});

test("7. no answer of this suite carries a stack, a database text or a parameter of a refused version", () => {
  for (const text of responses) {
    assert.doesNotMatch(text, /at [a-zA-Z]+ \(|error: |violates|source_metric_check_parameters/, text);
  }
});
