// Calculated variables, step 4 (the owner's order of 2026-11-19; the plan docs/ai/calculated-variables-v79-plan.md, accepted by
// the Rukovodilac with O1-O6): migration v79, a ratio and a difference. On disposable optimove_tests_gpexe_* databases only
// (never OPTIMOVE): one migrated through v78 rehearses v79's preflight / apply / post-check / rollback / re-apply and the
// rollback's refusals; one migrated through v79 carries the raw-write guards, the API and a real import (the mapped world:
// duration in min from GPEXE's s, distance in m, the power zones). The routes (an athlete never sees them; a dashboard refuses a
// ratio) are tests 9-10 of calculated-variables-2b-routes.test.mjs (with the dashboard series' database backstop).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { createGpexeDisposableDb, createGpexePilotOrg, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { activateOn, bindTeam, ensureMappedSystem, platformAdmin } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V79 = "202611191200_training_load_v79_calculated_ratio_difference.sql";
const V79_NAME = `migrations_v2/${V79}`;
const UP_TO_PREV = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V79));
const RUNBOOK = (f) => path.resolve(ROOT, "docs/runbooks", f);
const ROLLBACK_PATH = RUNBOOK("calculated-variables-v79-rollback.sql");
const PREFLIGHT_PATH = RUNBOOK("calculated-variables-v79-preflight.sql");
const POSTCHECK_PATH = RUNBOOK("calculated-variables-v79-postcheck.sql");
const ZONES = ["gpexe_power_zone_25_60_distance", "gpexe_power_zone_60_75_distance", "gpexe_power_zone_75_plus_distance"];

let rdb, db, r, k, pa, world, variables;
const uid = () => crypto.randomBytes(4).toString("hex");
const key = () => crypto.randomUUID();
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const SYS = (userId) => ({ userId: String(userId), basis: "platform_admin", owner: { scope: "system", clubId: null } });

async function applyV79(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v79-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of [...UP_TO_PREV, V79]) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function runbook(c, file) {
  const text = (await fsp.readFile(file, "utf8")).split("\n").filter((line) => !line.startsWith("--")).join("\n");
  const out = [];
  for (const statement of text.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) out.push(...(await c.query(statement)).rows);
  return out;
}
// Every boolean true, and every count of something v79 adds 0.
const ZEROES = ["other_kinds", "ratio_or_difference_versions", "ratio_day_rules", "ratio_series"];
function allOk(blocks) {
  for (const row of blocks) {
    for (const [col, v] of Object.entries(row)) {
      if (typeof v === "boolean") assert.equal(v, true, `${col} in ${JSON.stringify(row)}`);
      if (ZEROES.includes(col)) assert.equal(Number(v), 0, `${col} in ${JSON.stringify(row)}`);
    }
  }
}

// A raw variable: a definition with its levels and version 1 (a system one unless a club is named).
async function variable(c, { unit = "m", day = "sum", calculation = null, levels = ["session"] } = {}) {
  const d = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope) values ($1, $1, 'system') returning id`, [`v79_${uid()}`])).id;
  for (const level of levels) await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, $2)`, [d, level]);
  const v = (await one(c, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, calculation)
    values ($1, 1, $2, 'numeric', $3, $4) returning id`, [d, unit, day, calculation ? JSON.stringify(calculation) : null])).id;
  await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [v, d]);
  return d;
}
const sum = (...inputs) => ({ kind: "sum", inputs });
const ratio = (n, d, scale = 1) => ({ kind: "ratio", inputs: [n, d], scale });
const difference = (a, b) => ({ kind: "difference", inputs: [a, b] });
async function attempt(c, fn) {
  await c.query("begin");
  try {
    const out = await fn(c);
    await c.query("rollback");
    return { ok: true, out };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    return { ok: false, error };
  }
}
function dbRefused(res, pattern) {
  assert.equal(res.ok, false, `expected a refusal: ${pattern}`);
  assert.equal(res.error.code, "23514", res.error.message);
  assert.match(res.error.message, pattern);
}
const newVersion = (c, d, { unit = "m", day = "sum", calculation = null, n = 2 } = {}) => c.query(
  `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, calculation)
   values ($1, $2, $3, 'numeric', $4, $5)`, [d, n, unit, day, calculation ? JSON.stringify(calculation) : null]);

before(async () => {
  // v80 (the condition match) comes after v79; the rehearsal database stops at v78 and applies v79 alone.
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V79), "v79 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v79rb", migrations: UP_TO_PREV }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "calc79" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  for (const c of [r, k]) await c.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  pa = await platformAdmin(k);
  world = await ensureMappedSystem(k, { platformAdminId: pa });
  variables = await import("../src/canonicalVariableAdminService.js");
});

after(async () => {
  try {
    const { pool } = await import("../src/db.js");
    await pool.end().catch(() => {});
  } finally {
    for (const c of [r, k]) await c?.end().catch(() => {});
    await rdb?.drop();
    await db?.drop();
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

test("1. v79 on a database through v78 (with a sum over two inputs): the preflight passes, it applies, the post-check passes, the rollback restores v78's catalog exactly, and it applies again; the rollback refuses once a ratio exists, changing nothing", async () => {
  const a = await variable(r);
  const b = await variable(r);
  await variable(r, { calculation: sum(a, b) });
  allOk(await runbook(r, PREFLIGHT_PATH));
  const before = await catalog(r);
  await applyV79(rdb.url);
  allOk(await runbook(r, POSTCHECK_PATH));
  assert.equal((await one(r, `select count(*)::int n from public.schema_migrations where migration_name = $1`, [V79_NAME])).n, 1);
  await r.query(await fsp.readFile(ROLLBACK_PATH, "utf8"));
  assert.deepEqual(await catalog(r), before, "the rollback restores v78's catalog exactly (bodies, comments, CHECKs)");
  allOk(await runbook(r, PREFLIGHT_PATH));
  await applyV79(rdb.url);
  allOk(await runbook(r, POSTCHECK_PATH));
  // A ratio exists: the narrowed CHECK and v78's guards could not hold it, so the rollback refuses and changes nothing.
  const minutes = await variable(r, { unit: "min" });
  await variable(r, { unit: "m/min", day: "ratio", calculation: ratio(a, minutes) });
  const atRefusal = await catalog(r);
  await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /v79 rollback refused: a ratio or a difference exists/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), atRefusal, "the refused rollback changed nothing");
  // A body replaced after v79 (as a later migration would): refused too.
  await r.query(`delete from training_load.metric_definition_versions where calculation ->> 'kind' = 'ratio'`).catch(() => {});
});

test("2. the version guard: a ratio's day rule is Ratio and its unit is its inputs' (numerator/denominator, or % over one unit); a difference has its inputs' unit and the day rule Sum; one level of nesting; a variable keeps its kind; an ordinary variable never takes Ratio; an input keeps its unit", async () => {
  const dist = await variable(k);
  const zone = await variable(k);
  const mins = await variable(k, { unit: "min" });
  const hmld = await variable(k, { calculation: sum(dist, zone) });
  // A ratio m/min, and over a sum (O1).
  const perMin = await variable(k, { unit: "m/min", day: "ratio", calculation: ratio(dist, mins) });
  const hmldPerMin = await variable(k, { unit: "m/min", day: "ratio", calculation: ratio(hmld, mins) });
  const share = await variable(k, { unit: "%", day: "ratio", calculation: ratio(hmld, dist, 100) });
  const rest = await variable(k, { calculation: difference(dist, hmld) });
  assert.ok(perMin && hmldPerMin && share && rest);
  const refusedCreate = async (opts, pattern) => dbRefused(await attempt(k, (c) => variable(c, opts)), pattern);
  // The day rule.
  await refusedCreate({ unit: "m/min", day: "sum", calculation: ratio(dist, mins) }, /a calculated ratio's day rule is Ratio/);
  await refusedCreate({ unit: "m/min", day: "avg", calculation: ratio(dist, mins) }, /a calculated ratio's day rule is Ratio/);
  await refusedCreate({ day: "ratio", calculation: difference(dist, zone) }, /a calculated version's day rule is Sum/);
  await refusedCreate({ day: "ratio" }, /only a calculated ratio has the day rule Ratio/);
  // The units: no conversion inside a formula (O3).
  await refusedCreate({ unit: "m/s", day: "ratio", calculation: ratio(dist, mins) }, /a ratio's unit is its numerator's unit \/ its denominator's unit/);
  await refusedCreate({ unit: "%", day: "ratio", calculation: ratio(dist, mins, 100) }, /a percentage divides two variables of one unit/);
  await refusedCreate({ unit: "m", day: "ratio", calculation: ratio(hmld, dist, 100) }, /a percentage divides two variables of one unit/);
  await refusedCreate({ unit: "min", calculation: difference(dist, mins) }, /every input is numeric with the calculated variable's unit/);
  // One level (O1): never a ratio or a difference over a ratio or a difference; a sum stays over ordinary variables.
  await refusedCreate({ unit: "m/min/min", day: "ratio", calculation: ratio(perMin, mins) }, /an input is not calculated itself, or is a sum used by a ratio or a difference/);
  await refusedCreate({ calculation: difference(rest, zone) }, /an input is not calculated itself, or is a sum used by a ratio or a difference/);
  await refusedCreate({ calculation: sum(hmld, zone) }, /an input is not calculated itself, or is a sum used by a ratio or a difference/);
  // The shape: a ratio's scale 1 or 100, exactly two inputs.
  await refusedCreate({ unit: "m/min", day: "ratio", calculation: { kind: "ratio", inputs: [dist, mins], scale: 10 } }, /metric_definition_versions_calculation_shape/);
  await refusedCreate({ unit: "m/min", day: "ratio", calculation: { kind: "ratio", inputs: [dist, mins] } }, /metric_definition_versions_calculation_shape/);
  await refusedCreate({ calculation: { kind: "difference", inputs: [dist, zone, mins] } }, /metric_definition_versions_calculation_shape|a ratio or a difference has exactly two inputs/);
  // A variable keeps its kind.
  dbRefused(await attempt(k, (c) => newVersion(c, hmld, { calculation: difference(dist, zone) })), /a calculated variable keeps its kind/);
  dbRefused(await attempt(k, (c) => newVersion(c, perMin, { calculation: difference(dist, zone) })), /a calculated variable keeps its kind/);
  const sameKind = await attempt(k, (c) => newVersion(c, perMin, { unit: "%", day: "ratio", calculation: ratio(zone, dist, 100) }));
  assert.equal(sameKind.ok, true, sameKind.error?.message);
  // An input keeps its unit: a ratio's (min) and a sum used by a ratio (HMLD's m).
  dbRefused(await attempt(k, (c) => newVersion(c, mins, { unit: "s" })), /a calculated variable uses this variable; its unit and type stay as they are/);
  dbRefused(await attempt(k, (c) => newVersion(c, hmld, { unit: "km", calculation: sum(dist, zone) })), /a calculated variable uses this variable; its unit and type stay as they are/);
  // ... and its day rule Sum.
  dbRefused(await attempt(k, (c) => newVersion(c, mins, { unit: "min", day: "max" })), /adds up this variable; its day rule stays Sum/);
});

// An imported team of the mapped world (time in min, distance in m, the zones), its occasions read back.
let teamCounter = 0;
async function importedTeam({ athletes = standardAthletes() } = {}) {
  const { importGpexeBundle } = await import("../src/gpexeImportWriter.js");
  const org = await createGpexePilotOrg(k, { athleteNames: ["Athlete A", "Athlete B", "Athlete C", "Athlete D"] });
  const sourceTeamId = String(9700 + (teamCounter += 1));
  const binding = await bindTeam(k, { teamId: org.teamId, clubId: org.clubId, sourceTeamId, by: pa });
  await activateOn(world, { bindingId: binding.bindingId, platformAdminId: pa });
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  const log = [];
  const query = client.query.bind(client);
  client.query = (...args) => { log.push(typeof args[0] === "string" ? args[0] : args[0]?.text ?? ""); return query(...args); };
  try {
    await importGpexeBundle(client, makeBundle({ gpexeTeamId: Number(sourceTeamId), athletes }), {
      ownerTeamId: org.teamId, performedByUserId: org.userId,
      athleteIdByGpexeId: { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] }, batchFilename: "v79 test",
    });
  } finally {
    await client.end();
  }
  return { org, log };
}
// Every current occasion of the team: its values by variable (non-derived) and its calculated rows.
async function occasionsOf(teamId) {
  return (await k.query(
    `select o.id, si.source_external_id as external_id,
            coalesce(jsonb_object_agg(v.metric_definition_id::text, jsonb_build_object('id', v.id, 'value', v.value_numeric::text)) filter (where v.id is not null), '{}'::jsonb) as all_values
       from training_load.metric_events e
       join training_load.metric_event_participants p on p.event_id = e.id
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       join training_load.metric_source_identities si on si.id = o.source_identity_id and si.current_occasion_id = o.id
       left join training_load.metric_values v on v.occasion_id = o.id
      where e.owner_team_id = $1
      group by o.id, si.source_external_id order by si.source_external_id`, [teamId])).rows;
}
const versionOf = async (d) => (await one(k, `select current_version_id as v from training_load.metric_definitions where id = $1`, [d])).v;
async function rawValue(c, occasionId, d, v, ids, unit) {
  return (await one(c, `insert into training_load.metric_values
      (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage, computed_by_ref)
      values ($1, $2, $3, $4, $5, true, 'derived_rollup', 'complete', $6) returning id`,
    [occasionId, d, await versionOf(d), v, unit, JSON.stringify({ formulaVersionId: String(await versionOf(d)), inputValueIds: ids })])).id;
}

test("3. the value guard (any writer): a ratio is exactly round(numerator * scale / denominator, 6) of its inputs in place, a sum's own value allowed as an input; a zero denominator and a difference below zero are no value; a sum never takes a derived value", async () => {
  const id = (name) => world[name].variableId;
  const { org } = await importedTeam();
  // Variables made after the import: the occasion carries their inputs and none of their values.
  const hmld = await variable(k, { levels: ["session", "component"], calculation: sum(...ZONES.map(id)) });
  const perMin = await variable(k, { unit: "m/min", day: "ratio", levels: ["session", "component"], calculation: ratio(hmld, id("gpexe_time_min")) });
  const share = await variable(k, { unit: "%", day: "ratio", levels: ["session", "component"], calculation: ratio(id("gpexe_power_zone_75_plus_distance"), id("gpexe_total_distance"), 100) });
  const rest = await variable(k, { levels: ["session", "component"], calculation: difference(id("gpexe_total_distance"), id("gpexe_power_zone_75_plus_distance")) });
  const below = await variable(k, { levels: ["session", "component"], calculation: difference(id("gpexe_power_zone_75_plus_distance"), id("gpexe_total_distance")) });
  const occ = (await occasionsOf(org.teamId)).find((o) => /athlete_session:\d+:full$/.test(o.external_id) && o.all_values[id("gpexe_time_min")]);
  assert.ok(occ, "an imported session with its inputs");
  const val = (name) => occ.all_values[id(name)];
  const [vDist, vMin, v75] = [val("gpexe_total_distance"), val("gpexe_time_min"), val("gpexe_power_zone_75_plus_distance")];
  const zoneIds = ZONES.map((z) => occ.all_values[id(z)].id);
  const hmldSum = ZONES.reduce((acc, z) => acc + Number(occ.all_values[id(z)].value), 0);
  await k.query("begin");
  try {
    const vHmld = await rawValue(k, occ.id, hmld, hmldSum, zoneIds, "m");
    const exact = (await one(k, `select round($1::numeric / $2::numeric, 6)::text as v`, [hmldSum, vMin.value])).v;
    assert.ok(await rawValue(k, occ.id, perMin, exact, [vHmld, vMin.id], "m/min"), "a ratio over a sum's own value");
    const pct = (await one(k, `select round($1::numeric * 100 / $2::numeric, 6)::text as v`, [v75.value, vDist.value])).v;
    assert.ok(await rawValue(k, occ.id, share, pct, [v75.id, vDist.id], "%"));
    assert.ok(await rawValue(k, occ.id, rest, Number(vDist.value) - Number(v75.value), [vDist.id, v75.id], "m"));
  } finally {
    await k.query("rollback");
  }
  const inTx = async (fn) => attempt(k, async (c) => fn(c));
  dbRefused(await inTx(async (c) => {
    const vHmld = await rawValue(c, occ.id, hmld, hmldSum, zoneIds, "m");
    return rawValue(c, occ.id, perMin, "1.5", [vHmld, vMin.id], "m/min");
  }), /exactly its calculation/);
  dbRefused(await inTx((c) => rawValue(c, occ.id, share, "1", [vDist.id, v75.id], "%")), /input values are named in the calculation's order/);
  dbRefused(await inTx((c) => rawValue(c, occ.id, below, Number(v75.value) - Number(vDist.value), [v75.id, vDist.id], "m")), /a difference below zero is no value/);
  dbRefused(await inTx(async (c) => {
    const vHmld = await rawValue(c, occ.id, hmld, hmldSum, zoneIds, "m");
    const hmld2 = await variable(c, { levels: ["session", "component"], calculation: sum(id("gpexe_power_zone_25_60_distance"), id("gpexe_power_zone_60_75_distance")) });
    return rawValue(c, occ.id, hmld2, hmldSum + Number(occ.all_values[id(ZONES[1])].value), [vHmld, occ.all_values[id(ZONES[1])].id], "m");
  }), /names one input value per input/);
});

test("4. a zero denominator is no value: the writer leaves the ratio out (and the value guard refuses one), while the sum and the difference of the same occasion are written", async () => {
  const id = (name) => world[name].variableId;
  const athletes = standardAthletes();
  athletes[0].parts[0].time = 0; // athlete 101's session: no minutes
  const perMin = (await variables.createVariable({ ctx: SYS(pa), body: { requestKey: key(), label: `Per min ${uid()}`, unit: "m/min", levels: ["session", "drill"],
    calculation: ratio(id("gpexe_total_distance"), id("gpexe_time_min")) } })).variable;
  try {
    const { org } = await importedTeam({ athletes });
    const rowsOf = await occasionsOf(org.teamId);
    const zeroOcc = rowsOf.find((o) => o.external_id.endsWith(":full") && o.all_values[id("gpexe_time_min")]?.value === "0");
    assert.ok(zeroOcc, "an occasion with zero minutes");
    assert.equal(zeroOcc.all_values[perMin.id], undefined, "no ratio over zero minutes");
    const withMinutes = rowsOf.filter((o) => Number(o.all_values[id("gpexe_time_min")]?.value) > 0 && o.all_values[id("gpexe_total_distance")]);
    assert.ok(withMinutes.length > 1);
    for (const o of withMinutes) assert.ok(o.all_values[perMin.id], `${o.external_id}: a ratio where there are minutes`);
    dbRefused(await attempt(k, (c) => rawValue(c, zeroOcc.id, perMin.id, 0, [zeroOcc.all_values[id("gpexe_total_distance")].id, zeroOcc.all_values[id("gpexe_time_min")].id], "m/min")),
      /a denominator above zero/);
  } finally {
    await variables.archiveVariable?.({ ctx: SYS(pa), variableId: perMin.id, body: { requestKey: key(), reason: "test" } }).catch(() => {});
  }
});

test("5. the API: a ratio's unit is its inputs' (the server names it), a percentage over one unit, a difference with its inputs' unit; the day rule follows the kind; one level; a variable keeps its kind; the read names kind, scale and inputs", async () => {
  const id = (name) => world[name].variableId;
  const create = (body) => variables.createVariable({ ctx: SYS(pa), body: { requestKey: key(), levels: ["session", "drill"], ...body } });
  const refused = async (body, code, message) => {
    const err = await create(body).then(() => null, (e) => e);
    assert.ok(err, `${code}: refused`);
    assert.equal(err.code ?? err.error, code, JSON.stringify(err));
    if (message) assert.match(err.message, message);
  };
  const hmld = (await create({ label: `HMLD ${uid()}`, unit: "m", calculation: sum(...ZONES.map(id)) })).variable;
  const perMin = (await create({ label: `m per min ${uid()}`, unit: "m/min", calculation: ratio(id("gpexe_total_distance"), id("gpexe_time_min")) })).variable;
  assert.deepEqual([perMin.currentVersion.unit, perMin.currentVersion.dailyAggregationMethod, perMin.currentVersion.calculation.kind, perMin.currentVersion.calculation.scale],
    ["m/min", "ratio", "ratio", 1]);
  assert.deepEqual(perMin.currentVersion.calculation.inputs.map((i) => i.id), [id("gpexe_total_distance"), id("gpexe_time_min")], "numerator first");
  const share = (await create({ label: `HMLD share ${uid()}`, unit: "%", calculation: ratio(hmld.id, id("gpexe_total_distance"), 100) })).variable;
  assert.equal(share.currentVersion.calculation.scale, 100);
  const rest = (await create({ label: `Below HMLD ${uid()}`, unit: "m", calculation: difference(id("gpexe_total_distance"), hmld.id) })).variable;
  assert.deepEqual([rest.currentVersion.dailyAggregationMethod, rest.currentVersion.calculation.kind], ["sum", "difference"]);
  // The unit the server names; the day rule; one level; the shape.
  await refused({ label: "x", unit: "m/s", calculation: ratio(id("gpexe_total_distance"), id("gpexe_time_min")) }, "calculation_ratio_unit", /: m\/min\.$/);
  await refused({ label: "x", unit: "%", calculation: ratio(id("gpexe_total_distance"), id("gpexe_time_min"), 100) }, "calculation_percentage_unit");
  await refused({ label: "x", unit: "m/min", dailyAggregationMethod: "sum", calculation: ratio(id("gpexe_total_distance"), id("gpexe_time_min")) }, "calculated_day_rule_fixed", /Ratio/);
  await refused({ label: "x", unit: "m", dailyAggregationMethod: "ratio", calculation: difference(id("gpexe_total_distance"), hmld.id) }, "calculated_day_rule_fixed");
  await refused({ label: "x", unit: "m", dailyAggregationMethod: "ratio" }, "invalid_body");
  await refused({ label: "x", unit: "m/min/min", calculation: ratio(perMin.id, id("gpexe_time_min")) }, "calculation_input_nested");
  await refused({ label: "x", unit: "m", calculation: sum(hmld.id, id("gpexe_total_distance")) }, "calculation_input_calculated");
  await refused({ label: "x", unit: "m", calculation: difference(id("gpexe_total_distance"), id("gpexe_time_min")) }, "calculation_unit_mismatch");
  await refused({ label: "x", unit: "m/min", calculation: { kind: "ratio", inputs: [id("gpexe_total_distance"), id("gpexe_time_min")], scale: 60 } }, "invalid_body");
  // A new version keeps the kind.
  const err = await variables.createVariableVersion({ ctx: SYS(pa), variableId: perMin.id,
    body: { requestKey: key(), expectedCurrentVersionId: perMin.currentVersion.id, unit: "m", calculation: difference(id("gpexe_total_distance"), hmld.id) } }).then(() => null, (e) => e);
  assert.equal(err?.code ?? err?.error, "calculation_kind_fixed", JSON.stringify(err));
  // A sum a ratio uses keeps its unit.
  const unitChange = await variables.createVariableVersion({ ctx: SYS(pa), variableId: hmld.id,
    body: { requestKey: key(), expectedCurrentVersionId: hmld.currentVersion.id, unit: "km", calculation: sum(...ZONES.map(id)) } }).then(() => null, (e) => e);
  assert.ok(unitChange, "refused");
  assert.match(String(unitChange.code ?? unitChange.error), /calculation_unit_mismatch|variable_used_by_calculation/);
  return { hmld, perMin, share, rest };
});

test("6. a real import writes every kind beside its inputs, sums first: m/min, HMLD per minute (a ratio over a sum), HMLD as % of distance and distance minus HMLD - each exactly its calculation of that occasion's own values, in place; a ratio's level runs two statements per occasion, a team with only sums one", async () => {
  const id = (name) => world[name].variableId;
  const create = async (label, unit, calculation) => (await variables.createVariable({ ctx: SYS(pa),
    body: { requestKey: key(), label: `${label} ${uid()}`, unit, levels: ["session", "drill"], calculation } })).variable;
  const hmld = await create("HMLD", "m", sum(...ZONES.map(id)));
  const perMin = await create("Metres per minute", "m/min", ratio(id("gpexe_total_distance"), id("gpexe_time_min")));
  const hmldPerMin = await create("HMLD per minute", "m/min", ratio(hmld.id, id("gpexe_time_min")));
  const share = await create("HMLD share", "%", ratio(hmld.id, id("gpexe_total_distance"), 100));
  const rest = await create("Below HMLD", "m", difference(id("gpexe_total_distance"), hmld.id));
  const { org, log } = await importedTeam();
  const occs = await occasionsOf(org.teamId);
  const num = (o, d) => (o.all_values[d] ? Number(o.all_values[d].value) : null);
  const round6 = (x) => Math.round(x * 1e6) / 1e6;
  let checked = 0;
  for (const o of occs) {
    const zones = ZONES.map((z) => num(o, id(z)));
    if (zones.some((z) => z === null)) continue;
    const h = zones.reduce((a, b) => a + b, 0);
    const dist = num(o, id("gpexe_total_distance"));
    const mins = num(o, id("gpexe_time_min"));
    assert.equal(num(o, hmld.id), h, `${o.external_id}: HMLD`);
    const expect = (d, v) => (v === null ? assert.equal(o.all_values[d], undefined, `${o.external_id}: no value`) : assert.ok(Math.abs(num(o, d) - v) < 1e-6, `${o.external_id}: ${num(o, d)} vs ${v}`));
    expect(perMin.id, dist !== null && mins > 0 ? round6(dist / mins) : null);
    expect(hmldPerMin.id, mins > 0 ? round6(h / mins) : null);
    expect(share.id, dist > 0 ? round6((h * 100) / dist) : null);
    expect(rest.id, dist !== null && dist - h >= 0 ? dist - h : null);
    // In place: the ratio names the sum's own value, then the minutes.
    if (o.all_values[hmldPerMin.id]) {
      const ref = (await one(k, `select computed_by_ref as r from training_load.metric_values where id = $1`, [o.all_values[hmldPerMin.id].id])).r;
      assert.deepEqual(ref.inputValueIds, [o.all_values[hmld.id].id, o.all_values[id("gpexe_time_min")].id]);
    }
    checked += 1;
  }
  assert.ok(checked >= 3, `checked ${checked} occasions`);
  // Two passes at a level where a ratio or a difference applies (sums, then the rest); never more.
  const inserts = log.filter((q) => /insert into training_load\.metric_values[\s\S]*derived_rollup/.test(q));
  // Every occasion here is at a level where both passes apply (a team with only sums sends one: calculated-variables-2b test 6).
  assert.equal(inserts.length, 2 * occs.length, `${inserts.length} calculated statements for ${occs.length} occasions`);
  for (const v of [hmld, perMin, hmldPerMin, share, rest]) {
    await variables.archiveVariable({ ctx: SYS(pa), variableId: v.id, body: { requestKey: key(), reason: "test done", expectedNamesToken: v.namesToken } }).catch(() => {});
  }
});
