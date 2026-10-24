// The importer writes every value of one result with ONE multi-row INSERT
// (metricValuesInsert in gpexeImportWriter.js) instead of one INSERT per
// value (owner order 2026-10-24, option A of the preview analysis). This
// suite proves the change is invisible: on a disposable optimove_tests_gpexe_*
// database (never OPTIMOVE), every step runs twice from the same committed
// state - once as the code is now, once with each multi-row statement
// replayed as the old per-value statements, word for word, on the same
// connection - and the two must give the same preview, the same previewHash,
// the same rows after a real import, the same refusal for a bad value and the
// same state after a rollback. Besides the number of statements, the only
// differences are in refusals the writer cannot produce, pinned here (7.3,
// 8.x) and accepted by the owner on 2026-10-24 as limitations of the
// optimization: the parameter an error's `where` names, and which refusal
// comes first when one result holds two refused values.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { buildCandidatePreview } from "../src/gpexeImportPreview.js";
import { importGpexePlan, importGpexePlanLocked, lockTeamForImport, metricValuesInsert, GpexeImportError } from "../src/gpexeImportWriter.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

// The statement the importer sent once per value before this change, copied
// verbatim from gpexeImportWriter.js at bb6072b.
const LEGACY_VALUE_INSERT = `insert into training_load.metric_values
         (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage)
       values ($1,$2,$3,$4,$5,false,$6,$7)`;
const VALUE_INSERT = /^\s*insert into training_load\.metric_values\b/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A row's created_at in a refusal's detail is the transaction's own time.
const TIMESTAMP = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+\d\d(:\d\d)?/g;
const GPEXE_TEAM = 980;

let db;
let admin;
let org;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "valuesbatch" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  org = await createGpexePilotOrg(admin, { athleteNames: ["Values A", "Values B", "Values C", "Values D"] });
  await admin.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, $2, $3)`, [org.teamId, String(GPEXE_TEAM), org.userId]);
  // 101-103 are linked (103 has two tracks: left out with a reason), 104 is not.
  for (const [i, gpexeId] of ["101", "102", "103"].entries()) {
    await admin.query(
      `insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,$2,$3,$4)`,
      [org.teamId, gpexeId, org.athleteIds[i], org.userId],
    );
  }
});

after(async () => {
  if (admin) await admin.end();
  if (db) await db.drop();
});

// ---------------------------------------------------------------------------
// The two ways of sending the same work

// Counts every statement and, in legacy mode, replays each multi-row value
// INSERT as the old per-value statements in the same order on the same
// connection (a failing value stops the replay where the old loop stopped).
// `tamper` edits the parameters of the first value statement, the same way
// for both modes: a fault the writer itself cannot produce.
function driver(client, mode, { tamper = null } = {}) {
  const stats = { statements: 0, valueStatements: 0, values: 0 };
  let tampered = false;
  return {
    stats,
    query: async (text, params) => {
      if (typeof text === "string" && VALUE_INSERT.test(text)) {
        if (tamper && !tampered) {
          params = tamper([...params]);
          tampered = true;
        }
        const [occasionId, ...rest] = params;
        assert.equal(rest.length % 6, 0, "six parameters per value after the occasion");
        stats.values += rest.length / 6;
        if (mode === "legacy") {
          for (let i = 0; i < rest.length; i += 6) {
            stats.statements += 1;
            stats.valueStatements += 1;
            await client.query(LEGACY_VALUE_INSERT, [occasionId, ...rest.slice(i, i + 6)]);
          }
          return { rowCount: rest.length / 6, rows: [] };
        }
        stats.valueStatements += 1;
      }
      stats.statements += 1;
      return client.query(text, params);
    },
  };
}

async function withClient(fn) {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function linksMap() {
  return new Map(["101", "102", "103"].map((g, i) => [g, String(org.athleteIds[i])]));
}

function ctx() {
  return { ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: linksMap(), batchFilename: "gpexe values batch test" };
}

// The importable part of a plan, as the preview hands it to the writer.
function importablePlan(bundle) {
  const plan = buildGpexeImportPlan(bundle);
  return { ...plan, participants: plan.participants.filter((p) => linksMap().has(p.gpexeAthleteId)) };
}

// ---------------------------------------------------------------------------
// What is compared

// Row count of every table of the schemas the importer writes to.
async function tableCounts(client) {
  const tables = (await client.query(
    `select table_schema || '.' || table_name as t from information_schema.tables
      where table_schema in ('public','training','training_load') and table_type = 'BASE TABLE' order by 1`,
  )).rows.map((r) => r.t);
  const out = {};
  for (const t of tables) out[t] = Number((await client.query(`select count(*)::int as n from ${t}`)).rows[0].n);
  return out;
}

// The importer's rows by natural keys: no generated id, no transaction time.
// Batches are ranked by creation, so a step's new batch has the same rank in
// both runs.
async function importedRows(client) {
  const q = async (sql) => (await client.query(sql)).rows;
  return {
    values: await q(`
      with b as (select id, dense_rank() over (order by uploaded_at, filename) as batch from training_load.metric_import_batches)
      select si.source_external_id as ext, b.batch, o.row_number, o.content_hash, o.import_conflict_status as conflict,
             d.key, dv.version_number, v.value_numeric::text as value, v.value_boolean, v.value_text, v.unit_at_capture,
             v.is_derived, v.aggregation_role, v.coverage, v.computed_by_ref
        from training_load.metric_values v
        join training_load.metric_measurement_occasions o on o.id = v.occasion_id
        left join training_load.metric_source_identities si on si.id = o.source_identity_id
        left join b on b.id = o.import_batch_id
        join training_load.metric_definitions d on d.id = v.metric_definition_id
        join training_load.metric_definition_versions dv on dv.id = v.metric_definition_version_id
       order by ext, b.batch, o.row_number, d.key`),
    occasions: await q(`
      with b as (select id, dense_rank() over (order by uploaded_at, filename) as batch from training_load.metric_import_batches)
      select si.source_external_id as ext, b.batch, o.row_number, o.entry_method, o.content_hash, o.source_reported_at,
             o.import_conflict_status as conflict, p.athlete_id, s.segment_order,
             (select count(*)::int from training_load.metric_values v where v.occasion_id = o.id) as value_count,
             (select ob.row_number from training_load.metric_measurement_occasions ob where ob.id = o.supersedes_occasion_id) as supersedes_row,
             (o.superseded_by_occasion_id is not null) as superseded,
             (si.current_occasion_id = o.id) as is_current
        from training_load.metric_measurement_occasions o
        left join training_load.metric_source_identities si on si.id = o.source_identity_id
        left join b on b.id = o.import_batch_id
        join training_load.metric_event_participants p on p.id = o.event_participant_id
        left join training_load.metric_event_segments s on s.id = o.segment_id
       order by ext, b.batch, o.row_number`),
    identities: await q(`
      select si.source_external_id as ext, o.content_hash, o.row_number, o.import_conflict_status as conflict
        from training_load.metric_source_identities si
        left join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
       order by ext`),
    definitions: await q(`
      select d.key, d.label, d.state, v.version_number, v.unit, v.value_type, v.daily_aggregation_method, v.condition_description,
             array(select sc.scope_level from training_load.metric_definition_scope_capabilities sc where sc.metric_definition_id = d.id order by 1) as scopes
        from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id
       order by d.key`),
  };
}

// An importer summary with every generated id replaced by its first-seen
// position (the summary's arrays have a fixed order).
function normalizeIds(value) {
  const seen = new Map();
  return JSON.parse(JSON.stringify(value).replace(UUID, (id) => {
    const key = id.toLowerCase();
    if (!seen.has(key)) seen.set(key, `<id${seen.size}>`);
    return seen.get(key);
  }));
}

function errorFacts(error) {
  return {
    gpexe: error instanceof GpexeImportError,
    code: error.code ?? null,
    constraint: error.constraint ?? null,
    table: error.table ?? null,
    column: error.column ?? null,
    message: String(error.message).replace(UUID, "<id>"),
    detail: error.detail ? String(error.detail).replace(UUID, "<id>").replace(TIMESTAMP, "<ts>") : null,
    where: error.where ? String(error.where).replace(UUID, "<id>") : null,
  };
}

// The preview of a bundle, once each way, from the same committed state.
async function previewBothWays(bundle) {
  const out = {};
  for (const mode of ["legacy", "batched"]) {
    out[mode] = await withClient(async (client) => {
      const before = await tableCounts(client);
      const d = driver(client, mode);
      const { preview, previewHash } = await buildCandidatePreview(d, { bundle, ownerTeamId: org.teamId, performedByUserId: org.userId });
      const afterCounts = await tableCounts(client);
      assert.deepEqual(afterCounts, before, `${mode}: the preview rolled back without a trace`);
      return { preview, previewHash, stats: d.stats };
    });
  }
  return out;
}

// Content hashes by first-seen position. Only for a run that creates the
// metric definitions itself: an occasion's content_hash covers each value's
// definition and version id, and two runs that each create the definitions
// get different generated ids, so the hashes differ whatever wrote the
// values (test 3b compares them exactly once the definitions exist).
function normalizeHashes(rows) {
  const seen = new Map();
  const mark = (h) => {
    if (h === null || h === undefined) return h;
    if (!seen.has(h)) seen.set(h, `<hash${seen.size}>`);
    return seen.get(h);
  };
  return Object.fromEntries(Object.entries(rows).map(([k, list]) => [k, list.map((r) => ("content_hash" in r ? { ...r, content_hash: mark(r.content_hash) } : r))]));
}

// A real import, once each way, inside a transaction that is read and then
// rolled back, so both start from the same committed state.
async function importBothWays(plan, { definitionsCreatedInRun = false } = {}) {
  const out = {};
  for (const mode of ["legacy", "batched"]) {
    out[mode] = await withClient(async (client) => {
      const before = await tableCounts(client);
      const d = driver(client, mode);
      await client.query("begin");
      try {
        await lockTeamForImport(client, org.teamId);
        const summary = await importGpexePlanLocked(d, plan, ctx());
        assert.equal(summary.definitionsCreated.length > 0, definitionsCreatedInRun, `${mode}: definitions created in this run`);
        const rows = await importedRows(client);
        return { summary: normalizeIds(summary), rows: definitionsCreatedInRun ? normalizeHashes(rows) : rows, counts: await tableCounts(client), stats: d.stats };
      } finally {
        await client.query("rollback");
        assert.deepEqual(await tableCounts(client), before, `${mode}: the rollback left nothing behind`);
      }
    });
  }
  return out;
}

function assertSameImport(both, label) {
  assert.deepEqual(both.batched.summary, both.legacy.summary, `${label}: the same importer summary`);
  assert.deepEqual(both.batched.rows, both.legacy.rows, `${label}: the same rows`);
  assert.deepEqual(both.batched.counts, both.legacy.counts, `${label}: the same number of rows in every table`);
  assert.equal(both.batched.stats.values, both.legacy.stats.values, `${label}: the same values written`);
}

function assertSamePreview(both, label) {
  assert.deepEqual(both.batched.preview, both.legacy.preview, `${label}: the same preview`);
  assert.equal(both.batched.previewHash, both.legacy.previewHash, `${label}: the same previewHash`);
}

async function commitImport(bundle) {
  return withClient((client) => importGpexePlan(client, importablePlan(bundle), ctx()));
}

// ---------------------------------------------------------------------------
// Fixtures: one session with two drills; the second drill's burst / brake
// arrive later (supplemented), then GPEXE corrects one value.
const START = "2026-10-20T09:00:00";
function bundle({ updatedOn = "2026-10-20T11:00:00.000", detailsDrills = [0], distance101 = 3000 } = {}) {
  const athletes = standardAthletes();
  athletes[0].parts[0].distance = distance101;
  athletes.push({
    id: 104, tracks: [9005],
    parts: [{ drill: null, time: 1800, distance: 2000, maxV: 6.8, power: [1700, 120, 100, 20, 10], sprint: 4, acc: 9, dec: 8, burst: 3, brake: 2 }],
  });
  return makeBundle({ sessionId: 8101, gpexeTeamId: GPEXE_TEAM, start: START, updatedOn, drillsCount: 2, athletes, detailsDrills });
}

// ---------------------------------------------------------------------------

test("1. metricValuesInsert: one row per value in the given order, $1 the occasion, six parameters per value, is_derived false", () => {
  const values = [
    { metricDefinitionId: "d1", metricDefinitionVersionId: "v1", value: 1.5, unit: "m", aggregationRole: "source_rollup", coverage: "complete" },
    { metricDefinitionId: "d2", metricDefinitionVersionId: "v2", value: 0, unit: "n", aggregationRole: "standalone", coverage: "not_applicable" },
  ];
  const { text, params } = metricValuesInsert("occ", values);
  assert.deepEqual(params, ["occ", "d1", "v1", 1.5, "m", "source_rollup", "complete", "d2", "v2", 0, "n", "standalone", "not_applicable"]);
  assert.match(text, /\(occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage\)/);
  assert.match(text, /values \(\$1,\$2,\$3,\$4,\$5,false,\$6,\$7\),\(\$1,\$8,\$9,\$10,\$11,false,\$12,\$13\)$/);
  assert.equal((text.match(/\(\$1,/g) || []).length, 2, "exactly one row per value");
});

test("2. first import: the same preview and previewHash both ways; one value statement per result instead of one per value", async () => {
  const both = await previewBothWays(bundle());
  assertSamePreview(both, "first import");
  assert.equal(both.batched.preview.status, "ready");
  const created = both.batched.preview.counts.created;
  assert.ok(created >= 5, `results created (${created})`);
  const { legacy, batched } = { legacy: both.legacy.stats, batched: both.batched.stats };
  assert.equal(batched.values, legacy.values);
  assert.equal(legacy.valueStatements, legacy.values, "the old way: one statement per value");
  assert.equal(batched.valueStatements, created, "the new way: one statement per result");
  assert.equal(legacy.statements - batched.statements, legacy.values - created, "no other statement changed");
});

test("3. first import written for real (the definitions created in the same transaction): the same summary, rows and table counts both ways", async () => {
  assertSameImport(await importBothWays(importablePlan(bundle()), { definitionsCreatedInRun: true }), "first import");
  const summary = await commitImport(bundle());
  assert.ok(summary.counts.created >= 5);
});

test("3b. a new session once the definitions exist: the same preview, previewHash and rows, content hashes included", async () => {
  const b = makeBundle({ sessionId: 8102, gpexeTeamId: GPEXE_TEAM, start: "2026-10-21T09:00:00", drillsCount: 2, athletes: standardAthletes(), detailsDrills: [0, 1] });
  const previews = await previewBothWays(b);
  assertSamePreview(previews, "new session");
  assert.equal(previews.batched.preview.status, "ready");
  const both = await importBothWays(importablePlan(b));
  assertSameImport(both, "new session");
  assert.ok(both.batched.summary.results.every((r) => r.outcome === "created"));
  assert.ok(both.batched.stats.valueStatements < both.legacy.stats.valueStatements);
});

test("4. the same session again (unchanged): nothing written either way, the same preview and previewHash", async () => {
  const both = await previewBothWays(bundle());
  assertSamePreview(both, "unchanged");
  assert.equal(both.batched.preview.status, "no_changes");
  assert.equal(both.batched.stats.valueStatements, 0);
  assert.equal(both.legacy.stats.valueStatements, 0);
  assertSameImport(await importBothWays(importablePlan(bundle())), "unchanged");
});

test("5. supplemented, corrected, needs_review, stale_resend_ignored and *_already_recorded: the same preview, previewHash and rows at every step", async () => {
  const steps = [
    { label: "supplemented", b: bundle({ detailsDrills: [0, 1] }), outcome: "supplemented" },
    { label: "corrected", b: bundle({ detailsDrills: [0, 1], updatedOn: "2026-10-21T08:00:00.000", distance101: 3050 }), outcome: "corrected" },
    { label: "needs_review", b: bundle({ detailsDrills: [0, 1], updatedOn: "2026-10-21T08:00:00.000", distance101: 3075 }), outcome: "needs_review" },
    { label: "stale_resend_ignored", b: bundle({ detailsDrills: [0, 1], updatedOn: "2026-10-20T10:00:00.000", distance101: 2990 }), outcome: "stale_resend_ignored" },
    { label: "already recorded", b: bundle({ detailsDrills: [0, 1], updatedOn: "2026-10-21T08:00:00.000", distance101: 3075 }), outcome: "needs_review_already_recorded" },
  ];
  for (const step of steps) {
    const both = await previewBothWays(step.b);
    assertSamePreview(both, step.label);
    const imported = await importBothWays(importablePlan(step.b));
    assertSameImport(imported, step.label);
    const outcomes = new Set(imported.batched.summary.results.map((r) => r.outcome));
    assert.ok(outcomes.has(step.outcome), `${step.label}: the importer reports ${step.outcome} (${[...outcomes].join(", ")})`);
    await commitImport(step.b);
  }
});

test("6. a result with no values and a result with one value: the same rows either way", async () => {
  const plan = importablePlan(bundle({ detailsDrills: [0, 1], updatedOn: "2026-10-22T08:00:00.000", distance101: 3100 }));
  const empty = plan.participants[0].results.find((r) => r.level === "full");
  empty.values = [];
  const single = plan.participants[1].results.find((r) => r.level === "full");
  single.values = single.values.slice(0, 1);
  const both = await importBothWays(plan);
  assertSameImport(both, "empty and single values");
  const lastBatch = Math.max(...both.batched.rows.occasions.map((x) => Number(x.batch)));
  const occasion = (r) => both.batched.rows.occasions.find((o) => o.ext === r.externalId && Number(o.batch) === lastBatch);
  assert.equal(occasion(empty)?.value_count, 0, "the empty occasion is written without values");
  assert.equal(occasion(single)?.value_count, 1, "the one value is written");
});

// A value the database refuses: the same error (code, constraint, column,
// message, trigger context), the same rollback to the preview's savepoint
// with a usable transaction afterwards, nothing left behind - and a real
// import refused the same way.
// `code` is what the database answers for that value, checked on its own as
// well: a change that treated both ways alike (a swallowed error) must not
// pass just because the two agree.
const FAULTS = [
  { label: "a numeric value that is null (validate_metric_value trigger)", code: "P0001", message: /value_type=numeric requires value_numeric only/, apply: (r) => { r.values[2] = { ...r.values[2], value: null }; } },
  { label: "the same metric twice in one result (unique occasion/definition)", code: "23505", message: /metric_values_occasion_id_metric_definition_id_key/, apply: (r) => { r.values.push({ ...r.values[0] }); } },
  // The ONE difference between the two ways, reported to the owner (PR
  // description): a parameter PostgreSQL cannot read as a number is named by
  // its position in the statement, and the second value of a result is $4 of
  // its own INSERT but $10 of the shared one. Code, message, detail and every
  // other field stay the same. Unreachable through the mapper, which emits
  // finite numbers only, and no code reads an error's `where`.
  { label: "a value that is not a number (numeric input)", code: "22P02", message: /invalid input syntax for type numeric/, apply: (r) => { r.values[1] = { ...r.values[1], value: "not-a-number" }; },
    knownWhere: { legacy: /^unnamed portal parameter \$4\b/, batched: /^unnamed portal parameter \$10\b/ } },
  // Without a definition the version is missing too: the scope trigger
  // refuses the row before the NOT NULL check would.
  { label: "a metric the plan has no definition for (no definition, no version)", code: "P0001", message: /has no declared scope_capability/, apply: (r) => { r.values[3] = { ...r.values[3], metricKey: "gpexe_unknown_metric" }; } },
  { label: "a refused value as the LAST of the result", code: "P0001", message: /value_type=numeric requires value_numeric only/, apply: (r) => { r.values[r.values.length - 1] = { ...r.values[r.values.length - 1], value: null }; } },
  // Below the writer (a definition and its version come from the same row):
  // the second value carries the third value's version.
  { label: "a version of another definition (composite foreign key)", code: "23503", message: /metric_values_definition_version_fk/, apply: () => {},
    tamper: (params) => { params[1 + 6 * 1 + 1] = params[1 + 6 * 2 + 1]; return params; } },
];

for (const [i, fault] of FAULTS.entries()) {
  test(`7.${i + 1} refused value - ${fault.label}: the same error and no trace, in a preview savepoint and in a real import`, async () => {
    // A new session, so every result takes the insert path.
    const b = makeBundle({ sessionId: 8200 + i, gpexeTeamId: GPEXE_TEAM, start: `2026-10-${String(10 + i).padStart(2, "0")}T09:00:00`, drillsCount: 2, athletes: standardAthletes().slice(0, 2), detailsDrills: [0, 1] });
    // Built outside the import, so a mapping refusal can never stand in for
    // the database's.
    const faulty = () => {
      const plan = importablePlan(b);
      fault.apply(plan.participants[0].results[0]);
      return plan;
    };
    assert.ok(faulty().participants[0].results[0].values.length >= 4, "the fixture maps");
    const seen = {};
    for (const mode of ["legacy", "batched"]) {
      seen[mode] = await withClient(async (client) => {
        const before = await tableCounts(client);
        const d = driver(client, mode, { tamper: fault.tamper ?? null });
        // As previewLocked runs it: a savepoint inside the locked transaction.
        await client.query("begin");
        let savepointError;
        try {
          await lockTeamForImport(client, org.teamId);
          await client.query("savepoint gpexe_preview_import");
          try {
            await importGpexePlanLocked(d, faulty(), ctx());
          } catch (error) {
            savepointError = error;
            await client.query("rollback to savepoint gpexe_preview_import");
          }
          assert.ok(savepointError, `${mode}: the import is refused`);
          assert.equal((await client.query("select 1 as ok")).rows[0].ok, 1, `${mode}: the transaction is usable after the savepoint rollback`);
        } finally {
          await client.query("rollback");
        }
        // As the approval runs it: its own transaction, rolled back on error.
        let importError;
        try {
          await importGpexePlan(driver(client, mode, { tamper: fault.tamper ?? null }), faulty(), ctx());
        } catch (error) {
          importError = error;
        }
        assert.ok(importError, `${mode}: the real import is refused`);
        assert.deepEqual(await tableCounts(client), before, `${mode}: nothing left behind`);
        return { savepoint: errorFacts(savepointError), real: errorFacts(importError) };
      });
    }
    if (fault.knownWhere) {
      for (const where of ["savepoint", "real"]) {
        for (const mode of ["legacy", "batched"]) {
          assert.match(seen[mode][where].where, fault.knownWhere[mode], `${mode} ${where}: the parameter PostgreSQL names`);
          seen[mode][where].where = "<parameter position>";
        }
      }
    }
    assert.deepEqual(seen.batched, seen.legacy, "the same refusal both ways");
    for (const where of ["savepoint", "real"]) {
      assert.equal(seen.batched[where].gpexe, false, `${where}: the database's own error, passed on`);
      assert.equal(seen.batched[where].code, fault.code, `${where}: SQLSTATE`);
      assert.match(seen.batched[where].message, fault.message, `${where}: message`);
    }
  });
}

// Two refused values in one result: which refusal comes first is the second
// and third reported difference (code review of 452aa57). One statement
// converts every parameter before its first row and checks its foreign keys
// at its end, while the old loop met each value's own refusal in turn. The
// writer cannot produce either case (a value is a finite number; a
// definition and its version come from the same row), so the tests build
// them below the writer, and they pin the refusal each way gives: a change
// in it can no longer pass unnoticed.
const MULTI_FAULTS = [
  {
    label: "a value of another definition's version (composite foreign key) before a null value",
    // Row 1 carries row 2's version: valid for the triggers, refused by
    // metric_values_definition_version_fk - after its own statement in the
    // old loop, at the end of the one statement in the new way, which row 3's
    // trigger has already ended.
    tamper: (params) => { params[1 + 6 * 1 + 1] = params[1 + 6 * 2 + 1]; return params; },
    apply: (r) => { r.values[3] = { ...r.values[3], value: null }; },
    expect: {
      legacy: { code: "23503", constraint: "metric_values_definition_version_fk" },
      batched: { code: "P0001", constraint: null, message: /value_type=numeric requires value_numeric only/ },
    },
  },
  {
    label: "a null value before a value that is not a number",
    // The new statement's parameters are converted before row 0's trigger
    // runs; the old loop reached row 0's trigger first.
    apply: (r) => { r.values[0] = { ...r.values[0], value: null }; r.values[2] = { ...r.values[2], value: "x" }; },
    expect: {
      legacy: { code: "P0001", constraint: null, message: /value_type=numeric requires value_numeric only/ },
      batched: { code: "22P02", constraint: null, message: /invalid input syntax for type numeric/ },
    },
  },
];

for (const [i, fault] of MULTI_FAULTS.entries()) {
  test(`8.${i + 1} two refused values in one result - ${fault.label}: each way refuses (pinned), nothing is left behind`, async () => {
    const b = makeBundle({ sessionId: 8300 + i, gpexeTeamId: GPEXE_TEAM, start: `2026-10-${String(16 + i).padStart(2, "0")}T09:00:00`, drillsCount: 2, athletes: standardAthletes().slice(0, 2), detailsDrills: [0, 1] });
    const faulty = () => {
      const plan = importablePlan(b);
      fault.apply(plan.participants[0].results[0]);
      return plan;
    };
    assert.ok(faulty().participants[0].results[0].values.length >= 4, "the fixture maps");
    for (const mode of ["legacy", "batched"]) {
      await withClient(async (client) => {
        const before = await tableCounts(client);
        let refused;
        try {
          await importGpexePlan(driver(client, mode, { tamper: fault.tamper ?? null }), faulty(), ctx());
        } catch (error) {
          refused = errorFacts(error);
        }
        assert.ok(refused, `${mode}: the import is refused`);
        const want = fault.expect[mode];
        assert.equal(refused.gpexe, false, `${mode}: the database's own error`);
        assert.equal(refused.code, want.code, `${mode}: SQLSTATE`);
        assert.equal(refused.constraint, want.constraint, `${mode}: constraint`);
        if (want.message) assert.match(refused.message, want.message, `${mode}: message`);
        assert.deepEqual(await tableCounts(client), before, `${mode}: nothing left behind`);
      });
    }
  });
}
