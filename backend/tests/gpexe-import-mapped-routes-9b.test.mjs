// Phase 9, 9-B (contract J17 section 8.1): the arms that need the real
// server - a check through a team's binding (the fake server3 source), the
// approval through the real route, and what happens when the mapping
// activations change between the preview and the approval:
//   A2 - check, then approve: exactly the pre-9-B values (the frozen oracle),
//        one T6 row each, the T7 keys once, no definition;
//   B2 - the only activation ends after the preview: the approval answers
//        preview_changed, the stored preview becomes no_mapped_values, nothing
//        is written;
//   B3 - an Unbind and a new binding (no activation yet): the next check is
//        blocked no_mapped_values, nothing is written;
//   C  - a stored preview of version 2 (written before 9-B): the first approval
//        answers preview_changed and stores the v3 preview, the second imports
//        exactly once; a check that sees the session unchanged also refreshes it.
// On disposable optimove_tests_gpexe_* databases only; no GPEXE request, no
// credential (marker values of the fake source only).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { PLANTED, previewBundle } from "./support/preview-bundles.mjs";
import { LEGACY_SPECS } from "./support/gpexe-legacy-specs.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { activateBinding, definitionDigest, t7Keys } from "./support/mapped-world.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { canonicalDecimal } from "../src/sourceMetricExtractors.js";
import { convertAtStorageScale } from "../src/sourceMetricPreview.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const DAY = "2026-09-14";

let db;
let admin;
let server;
let apiBase;
let service;
let connections;
let resolver;
let activations;
let createSession;
let appPool;
let src;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mapped_routes_9b" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  activations = await import("../src/sourceMetricActivationService.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
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
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${path}`, {
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
  const id = (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${crypto.randomBytes(4).toString("hex")}@test.local`, label])).rows[0].id;
  if (platform) await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (team) await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, team]);
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [id, platform ? "platform" : "team", platform ? null : team]);
  return { id: String(id), cookie: `optimove_session=${await createSession(id)}` };
}

const ORACLE_SPECS = LEGACY_SPECS.map((s) => ({ raw: true, key: s.key, levels: { full: true, drill: true }, extract: s.extract }));
const athleteId = (n) => `${PLANTED.athletePrefix}${String(n).padStart(2, "0")}`;
// Each team its own GPEXE session id (the fake source serves a session id for one team at a time).
let nextSession = 48213900;
const bundleFor = (t) => previewBundle({ gpexeTeamId: Number(t.sourceTeamId), sessionId: (t.sessionId ??= nextSession++) });

let nextSourceTeam = 9601;
// A team bound to its own GPEXE team through the real routes, its three kept
// athletes linked (athlete 04 has two tracks and is left out by the gates),
// and the activations named (all eleven by default; none with `only: []`).
async function team({ only = null } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A01", "A02", "A03", "A04"] });
  const sourceTeamId = String(nextSourceTeam++);
  const padmin = await user("platform admin", { platform: true });
  const coach = await user("coach", { team: org.teamId });
  assert.equal((await api(`/gpexe/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const bound = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  const activated = only && only.length === 0 ? { started: {} } : await activateBinding(admin, bound.bindingId, { only });
  for (const n of [1, 2, 3]) {
    const r = await api(`/gpexe/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId: athleteId(n), athleteId: org.athleteIds[n - 1] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  return { ...org, sourceTeamId, padmin, coach, ...bound, started: activated.started, world: activated.world, platformAdminId: activated.platformAdminId };
}

async function check(t, bundles) {
  src.serve(t.sourceTeamId, bundles);
  const started = await api(`/gpexe/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: { from: DAY, to: DAY } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 400; i += 1) {
    const r = await api(`/gpexe/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.padmin.cookie });
    if (r.body.check?.status !== "running") return r.body.check;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the check did not finish");
}
const candidateRow = async (t) => (await q(`select * from training_load.gpexe_import_candidates where owner_team_id = $1 and status <> 'superseded' order by first_seen_at desc limit 1`, [t.teamId]))[0];
async function approve(t, candidateId, previewHash, cookie = t.padmin.cookie) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/approve`, { method: "POST", cookie, body: { previewHash } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
const teamValues = (teamId) => q(
  `select p.athlete_id, s.segment_order, v.metric_definition_id, v.value_numeric::text as value_text,
          pr.source_value_numeric::text as source_text, pr.mapping_version_id,
          mv.scale::text as scale, mv.scale_divisor::text as divisor, mv."offset"::text as "offset"
     from training_load.metric_values v
     left join training_load.metric_value_source_provenance pr on pr.metric_value_id = v.id
     left join training_load.source_metric_mapping_versions mv on mv.id = pr.mapping_version_id
     join training_load.metric_measurement_occasions o on o.id = v.occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join training_load.metric_events e on e.id = p.event_id
     left join training_load.metric_event_segments s on s.id = o.segment_id
    where e.owner_team_id = $1`, [teamId]);

test("A2. a check through the binding, then the real approval: exactly the pre-9-B values (the oracle) for the three kept athletes, each the exact conversion at the storage scale with its own T6 row, the T7 keys once, no definition created", async () => {
  const t = await team();
  const bundle = bundleFor(t);
  const digestBefore = await definitionDigest(admin);
  const checked = await check(t, [bundle]);
  assert.equal(checked.status, "succeeded", JSON.stringify(checked));
  const c = await candidateRow(t);
  assert.equal(c.status, "pending");
  assert.equal(c.preview.version, 3);
  assert.equal(c.preview.status, "ready", JSON.stringify(c.preview.blocked));
  const r = await approve(t, c.id, c.preview_hash);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // The oracle: the frozen specs on the same bundle, per (athlete, level, drill, legacy key).
  const plan = buildGpexeImportPlan(bundle, { metricSpecs: ORACLE_SPECS });
  const oracle = new Map();
  for (const p of plan.participants) for (const res of p.results) for (const v of res.values) oracle.set(`${p.gpexeAthleteId}|${res.drillIndex ?? ""}|${v.key}`, v.value);
  const keyOf = new Map(Object.entries(t.world).map(([legacyKey, m]) => [m.variableId, legacyKey]));
  const gpexeOf = new Map(t.athleteIds.slice(0, 3).map((a, i) => [a, athleteId(i + 1)]));
  const rows = await teamValues(t.teamId);
  const seen = new Set();
  for (const row of rows) {
    const legacyKey = keyOf.get(row.metric_definition_id);
    assert.ok(legacyKey, "every value is of a mapped variable");
    const drillIndex = row.segment_order === null || row.segment_order === undefined ? "" : String(row.segment_order - 1);
    const k = `${gpexeOf.get(row.athlete_id)}|${drillIndex}|${legacyKey}`;
    assert.ok(oracle.has(k), `${k} is a value the pre-9-B import wrote`);
    assert.ok(!seen.has(k), `${k} is written once`);
    seen.add(k);
    assert.ok(Math.abs(Number(row.value_text) - oracle.get(k)) <= 1e-9, `${k}: ${row.value_text} vs ${oracle.get(k)}`);
    assert.ok(row.source_text !== null, `${k} has its T6 row`);
    assert.equal(canonicalDecimal(row.value_text), canonicalDecimal(convertAtStorageScale(canonicalDecimal(row.source_text), { scale: row.scale, divisor: row.divisor, offset: row.offset })), `${k}: the stored value is the exact conversion of the stored source value`);
  }
  assert.equal(seen.size, oracle.size, "no value of the oracle is missing and none is added");
  assert.equal(Number((await q(`select count(*) from training_load.metric_value_source_provenance pr join training_load.metric_values v on v.id = pr.metric_value_id join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`, [t.teamId]))[0].count), rows.length, "one T6 row per value");
  assert.ok(rows.every((row) => row.source_text !== null && canonicalDecimal(row.source_text) !== null), "every source value is a decimal");
  const t7 = await t7Keys(admin, t.teamId);
  assert.equal(t7.length, 1);
  assert.deepEqual([t7[0].source_host_key, t7[0].source_instance_key], ["server3", t.sourceTeamId]);
  assert.equal(await definitionDigest(admin), digestBefore, "no definition, version or capability is created or changed");
});

test("B2. the only activation ends after the candidate was previewed: the approval answers preview_changed, the stored preview becomes no_mapped_values, and nothing is written", async () => {
  const t = await team({ only: ["gpexe_total_distance"] });
  await check(t, [bundleFor(t)]);
  const c = await candidateRow(t);
  assert.equal(c.preview.status, "ready");
  const ctx = { userId: t.platformAdminId, basis: "platform_admin", owner: { scope: "system", clubId: null } };
  for (const id of t.started.gpexe_total_distance) {
    await activations.endActivation({ ctx, activationId: id, body: { requestKey: crypto.randomUUID(), expectedState: "open", reason: "9-B test: ended after the preview." } });
  }
  const r = await approve(t, c.id, c.preview_hash);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "preview_changed");
  const after = await candidateRow(t);
  assert.equal(after.id, c.id);
  assert.equal(after.preview.status, "blocked");
  assert.equal(after.preview.blocked.code, "no_mapped_values");
  assert.notEqual(after.preview_hash, c.preview_hash);
  assert.equal((await teamValues(t.teamId)).length, 0, "nothing is written");
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id]))[0].n, 0);
});

test("B3. an Unbind and a new binding without activations: the next check is blocked no_mapped_values for the platform admin (data_setup_incomplete for the coach), and nothing is written", async () => {
  const t = await team();
  const unbind = await api(`/sources/gpexe/connections/${t.connectionId}/bindings/${t.bindingId}/unbind`, { method: "POST", cookie: t.padmin.cookie, body: { requestKey: crypto.randomUUID(), reason: "test: bind again", expected: { teamId: t.teamId, sourceTeamId: t.sourceTeamId } } });
  assert.equal(unbind.status, 200, JSON.stringify(unbind.body));
  const again = await api(`/sources/gpexe/connections/${t.connectionId}/bindings`, { method: "POST", cookie: t.padmin.cookie, body: { teamId: t.teamId, sourceTeamId: t.sourceTeamId } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.result.binding.bindingId, t.bindingId, "a new binding");
  const checked = await check(t, [bundleFor(t)]);
  assert.equal(checked.status, "succeeded", JSON.stringify(checked));
  const c = await candidateRow(t);
  assert.equal(c.status, "blocked");
  assert.equal(c.preview.blocked.code, "no_mapped_values", "the activations of the ended binding do not carry over");
  const listedBy = async (cookie) => (await api(`/gpexe/teams/${t.teamId}/candidates`, { cookie })).body.candidates.find((x) => x.id === c.id);
  assert.equal((await listedBy(t.padmin.cookie)).blockedSourceCode, "no_mapped_values");
  const coachView = await listedBy(t.coach.cookie);
  assert.equal(coachView.blockedCode, "data_setup_incomplete");
  assert.equal(coachView.blockedSourceCode, "data_setup_incomplete");
  assert.equal(coachView.previewHash, null, "D10: no hash of a blocked preview for a coach");
  const refused = await approve(t, c.id, c.preview_hash);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "blocked");
  assert.equal((await teamValues(t.teamId)).length, 0);
});

test("C. a stored version 2 preview (written before 9-B): the first approval answers preview_changed and stores the v3 preview, the second imports exactly once; a check that sees the session unchanged refreshes a v2 preview to v3 as well", async () => {
  const t = await team();
  const bundle = bundleFor(t);
  await check(t, [bundle]);
  const c = await candidateRow(t);
  const plantV2 = async (id) => {
    const v2 = { ...structuredClone((await q(`select preview from training_load.gpexe_import_candidates where id = $1`, [id]))[0].preview), version: 2 };
    const hash = crypto.createHash("sha256").update(`v2-${id}-${crypto.randomUUID()}`).digest("hex");
    await q(`update training_load.gpexe_import_candidates set preview = $2, preview_hash = $3 where id = $1`, [id, v2, hash]);
    return hash;
  };
  const v2Hash = await plantV2(c.id);
  const first = await approve(t, c.id, v2Hash);
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal(first.body.error, "preview_changed");
  const refreshed = await candidateRow(t);
  assert.equal(refreshed.preview.version, 3, "the stored preview is v3 now");
  assert.notEqual(refreshed.preview_hash, v2Hash);
  assert.equal((await teamValues(t.teamId)).length, 0, "nothing written by the refused approval");
  const second = await approve(t, c.id, refreshed.preview_hash);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const written = (await teamValues(t.teamId)).length;
  assert.ok(written > 0);
  const third = await approve(t, c.id, refreshed.preview_hash);
  assert.notEqual(third.status, 200, "an imported candidate is never imported again");
  assert.equal((await teamValues(t.teamId)).length, written);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id]))[0].n, 1);

  // Separately: a check that sees the session unchanged refreshes a v2 preview to v3; then one approval imports.
  const u = await team();
  const b2 = bundleFor(u);
  await check(u, [b2]);
  const cu = await candidateRow(u);
  await plantV2(cu.id);
  const again = await check(u, [b2]);
  assert.equal(again.status, "succeeded");
  assert.equal(again.candidatesUnchanged, 1, "the session is unchanged");
  const fresh = await candidateRow(u);
  assert.equal(fresh.id, cu.id, "the same candidate");
  assert.equal(fresh.preview.version, 3, "refreshed to v3 by the check");
  const ok = await approve(u, fresh.id, fresh.preview_hash);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where candidate_id = $1`, [fresh.id]))[0].n, 1);
});
