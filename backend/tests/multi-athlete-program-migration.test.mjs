import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sqlLegacyPlanChecksum, sqlLegacyPlanComponents } from "../../tools/legacy_plan_sql_signature.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.resolve(__dirname, "../../migrations");
const backendEnvPath = path.resolve(__dirname, "../.env");
if (!process.env.DATABASE_URL && fs.existsSync(backendEnvPath)) {
  const env = Object.fromEntries(
    fs.readFileSync(backendEnvPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([^#=]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1].trim(), match[2].trim()]),
  );
  if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
}
const migrationFiles = [
  "20260818_seed_multi_athlete_01_custom_exercises.sql",
  "20260818_seed_multi_athlete_02_zija_murina.sql",
  "20260818_seed_multi_athlete_03_milos_milovic_programs.sql",
  "20260818_seed_multi_athlete_04_nikola_vujinivic_programs.sql",
  "20260818_seed_multi_athlete_05_nikola_petkovic_programs.sql",
  "20260818_seed_multi_athlete_06_zija_murina_programs.sql",
];

const legacyConflictSourceRefs = new Map([
  ["102|2026-06-08", "Plan-program.xlsx athlete 102 week 2026-06-08"],
  ["102|2026-06-15", "Plan-program.xlsx athlete 102 week 2026-06-15"],
  ["102|2026-06-22", "Plan-program.xlsx athlete 102 week 2026-06-22"],
  ["102|2026-07-27", null],
  ["103|2026-05-04", "Plan-program.xlsx athlete 103 week 2026-05-04"],
  ["103|2026-06-08", "Plan-program.xlsx athlete 103 week 2026-06-08"],
  ["107|2026-06-08", "Plan-program.xlsx athlete 107 week 2026-06-08"],
]);

const approvedLegacyPlanIds = new Map([
  ["102|2026-06-08", "ab3e6829-867f-4354-9e26-17512a708d0c"],
  ["102|2026-06-15", "f96a45fc-ef37-479b-b1f5-d41640eb5d0c"],
  ["102|2026-06-22", "b563a71f-f9e7-4f7d-9f4d-8b6b6dbfcdb8"],
  ["102|2026-07-27", "ffb64c80-85ad-4658-9141-cb63574544ad"],
  ["103|2026-05-04", "1c4a8dc9-4db3-4efa-8a13-029137019929"],
  ["103|2026-06-08", "7879c375-7f52-455b-bf41-806126deec99"],
  ["107|2026-06-08", "b7a0d4b5-2d53-4510-b1e4-0281a197c7ef"],
]);

const { Client } = pg;

function filePath(file) {
  return path.join(migrationDir, file);
}

function decodeSqlJson(sql, variableName) {
  const pattern = new RegExp(`${variableName}\\s+jsonb\\s*:=\\s*'((?:''|[^'])*)'::jsonb`);
  const match = sql.match(pattern);
  assert.ok(match, `expected ${variableName} JSON payload`);
  return JSON.parse(match[1].replace(/''/g, "'"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function withSignatureClient(fn) {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for SQL legacy signature tests");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function firstReplacementWithItems(migrations) {
  for (const sql of migrations) {
    const replacements = decodeSqlJson(sql, "v_replacements");
    const replacement = replacements.find((candidate) => candidate.normalized?.items?.length);
    if (replacement) return replacement;
  }
  assert.fail("expected at least one legacy replacement fixture");
}

async function readMigration(file) {
  return readFile(filePath(file), "utf8");
}

test("multi-athlete migrations are registered in deploy runner order after Pankov programs", async () => {
  const { migrationPaths } = await import("../src/migrate.js");
  const pankovProgramsIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260818_seed_pankov_programs.sql");
  assert.notEqual(pankovProgramsIndex, -1, "Pankov programs migration must stay registered");

  const indexes = migrationFiles.map((file) => migrationPaths.findIndex((p) => path.basename(p) === file));
  indexes.forEach((index, i) => {
    assert.notEqual(index, -1, `${migrationFiles[i]} must be registered`);
    assert.ok(existsSync(migrationPaths[index]), `${migrationFiles[i]} path must exist`);
  });
  assert.deepEqual(indexes, indexes.toSorted((a, b) => a - b), "multi-athlete migrations must stay ordered");
  assert.equal(indexes[0], pankovProgramsIndex + 1, "custom prerequisites must run immediately after Pankov programs");
});

test("custom prerequisite migration seeds exactly 14 user-owned stable custom exercises", async () => {
  const sql = await readMigration(migrationFiles[0]);
  const customExercises = decodeSqlJson(sql, "v_custom_exercises");
  assert.equal(customExercises.length, 14);
  assert.equal(new Set(customExercises.map((exercise) => exercise.slug)).size, 14);
  for (const exercise of customExercises) {
    assert.equal(exercise.owner_scope, "user");
    assert.equal(exercise.is_active, true);
    assert.match(exercise.slug, /:custom:/);
  }
  assert.match(sql, /slug % exists with different content\/owner/);
  assert.doesNotMatch(sql, /DATABASE_URL|postgres:\/\/|supabase\.co|password/i);
});

test("program migrations embed final package counts and stable exercise resolution only", async () => {
  const expectedByAthlete = new Map([
    ["102", { plans: 14, days: 34, sessions: 50, sectionNodes: 169, exerciseItems: 953, noteItems: 36 }],
    ["103", { plans: 13, days: 30, sessions: 48, sectionNodes: 122, exerciseItems: 702, noteItems: 39 }],
    ["107", { plans: 13, days: 24, sessions: 42, sectionNodes: 99, exerciseItems: 580, noteItems: 32 }],
    ["131", { plans: 14, days: 24, sessions: 40, sectionNodes: 62, exerciseItems: 373, noteItems: 21 }],
  ]);
  const totals = { plans: 0, days: 0, sessions: 0, sectionNodes: 0, exerciseItems: 0, noteItems: 0 };
  const mapping = { code: 0, slug: 0, note: 0 };
  const sourceRefs = new Set();
  let replacementGuards = 0;
  const replacementSourceRefs = new Map();

  await withSignatureClient(async (client) => {
  for (const file of migrationFiles.slice(2)) {
    const sql = await readMigration(file);
    const expected = decodeSqlJson(sql, "v_expected");
    const plans = decodeSqlJson(sql, "v_plans");
    const days = decodeSqlJson(sql, "v_days");
    const sessions = decodeSqlJson(sql, "v_sessions");
    const nodes = decodeSqlJson(sql, "v_nodes");
    const items = decodeSqlJson(sql, "v_items");
    const required = decodeSqlJson(sql, "v_required_exercises");
    const replacements = decodeSqlJson(sql, "v_replacements");
    const athleteId = plans[0].source_external_id;

    assert.deepEqual(expected, expectedByAthlete.get(athleteId));
    assert.equal(plans.length, expected.plans);
    assert.equal(days.length, expected.days);
    assert.equal(sessions.length, expected.sessions);
    assert.equal(nodes.filter((node) => node.node_type === "section").length, expected.sectionNodes);
    assert.equal(items.filter((item) => item.item_type === "exercise").length, expected.exerciseItems);
    assert.equal(items.filter((item) => item.item_type === "note").length, expected.noteItems);

    for (const plan of plans) {
      assert.equal(plan.source_ref, `${plan.source_ref.split(":weekly:")[0]}:weekly:${plan.week_start}`);
      assert.equal(sourceRefs.has(plan.source_ref), false, `duplicate source_ref ${plan.source_ref}`);
      sourceRefs.add(plan.source_ref);
    }
    for (const item of items) {
      if (item.item_type === "note") {
        mapping.note += 1;
        assert.equal(item.exercise_key, null);
        continue;
      }
      assert.ok(["code", "slug"].includes(item.exercise_key_type), `stable exercise key required for row ${item.source_row_ref}`);
      mapping[item.exercise_key_type] += 1;
      assert.ok(required.some((exercise) => exercise.keyType === item.exercise_key_type && exercise.key === item.exercise_key));
    }

    for (const key of Object.keys(totals)) totals[key] += expected[key];
    replacementGuards += replacements.length;
    for (const replacement of replacements) {
      const key = `${replacement.athleteExternalId}|${replacement.weekStart}`;
      replacementSourceRefs.set(key, replacement.sourceRef);
      assert.equal(replacement.sourceRef, legacyConflictSourceRefs.get(key), `${key} must use the audited legacy source_ref`);
      assert.equal(replacement.approvedPlanId, approvedLegacyPlanIds.get(key), `${key} must use the approved legacy plan UUID`);
      if (key === "102|2026-07-27") {
        assert.equal(replacement.status, "active");
        assert.equal(replacement.sourceType, "builder");
        assert.equal(replacement.backupRequired, false);
        assert.equal(replacement.normalized, null);
        assert.equal(replacement.checksum, null);
        assert.deepEqual(replacement.counts, { days: 4, sessions: 8, sections: 25, exerciseItems: 117, noteItems: 8, totalItems: 125 });
      } else {
        assert.equal(replacement.status, "draft");
        assert.equal(replacement.sourceType, "xlsx_weekly_import");
        assert.ok(replacement.normalized, `${key} must embed normalized legacy content`);
        assert.deepEqual(replacement.normalized.counts, replacement.counts);
        assert.equal(replacement.checksum, await sqlLegacyPlanChecksum(client, replacement.normalized), `${key} checksum must match SQL canonical legacy signature`);
        assert.ok(replacement.auditChecksum, `${key} must retain previous audit checksum for diagnostics`);
        for (const item of replacement.normalized.items) {
          assert.equal(item.id, undefined, `${key} normalized item must not include item UUID`);
          assert.equal(item.exercise_id, undefined, `${key} normalized item must not include exercise UUID`);
          assert.equal(item.created_at, undefined, `${key} normalized item must not include created_at`);
          assert.equal(item.updated_at, undefined, `${key} normalized item must not include updated_at`);
          assert.equal(item.exercise_expected_name, undefined, `${key} normalized item must not depend on library exercise name`);
        }
      }
    }
    assert.doesNotMatch(sql, /DATABASE_URL|postgres:\/\/|supabase\.co|password/i);
    const embeddedUuids = [...sql.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((match) => match[0].toLowerCase());
    const allowedUuids = new Set(replacements.map((replacement) => replacement.approvedPlanId.toLowerCase()));
    assert.deepEqual([...new Set(embeddedUuids)].sort(), [...allowedUuids].sort(), "program migration may embed only the approved legacy plan UUIDs");
  }
  });

  assert.deepEqual(totals, { plans: 54, days: 112, sessions: 180, sectionNodes: 452, exerciseItems: 2608, noteItems: 128 });
  assert.equal(mapping.code + mapping.slug, 2608);
  assert.equal(mapping.note, 128);
  assert.equal(sourceRefs.size, 54);
  assert.equal(replacementGuards, 7);
  assert.deepEqual(replacementSourceRefs, legacyConflictSourceRefs);
});

test("Miloš program seed resolves the Pankov running custom exercise without depending on the stale slug", async () => {
  const exerciseSeedSql = await readMigration("20260818_seed_pankov_exercises.sql");
  const milosSql = await readMigration("20260818_seed_multi_athlete_03_milos_milovic_programs.sql");
  const required = decodeSqlJson(milosSql, "v_required_exercises");
  const running = required.find((exercise) => exercise.key === "kontinuirano-trcanje-12km-h-100m-30s-1000m-5min-custom-98677b");

  assert.ok(running, "Miloš package still references the legacy local running slug key");
  assert.equal(running.keyType, "slug");
  assert.equal(running.expectedName, "Kontinuirano trčanje (12km/h, 100m 30s, 1000m 5min)");
  assert.match(exerciseSeedSql, /"slug": "kontinuirano-trcanje-12km-h-100m-30s-1000m-5min-custom-pankov-exercises-2026-08-18"/);
  assert.doesNotMatch(exerciseSeedSql, /kontinuirano-trcanje-12km-h-100m-30s-1000m-5min-custom-98677b/);
  assert.match(milosSql, /r->>'key' = 'kontinuirano-trcanje-12km-h-100m-30s-1000m-5min-custom-98677b'/);
  assert.match(milosSql, /exercise_code is null\s+and name = r->>'expectedName'\s+and owner_user_id = v_coach_id\s+and owner_scope = 'user'/);
  assert.match(milosSql, /if v_match_count <> 1 then raise exception '%: required exercise %:% expected exactly one match, found %'/);
});

test("legacy conflict guard uses approved UUID, audited metadata, dependencies, and backup before delete", async () => {
  for (const file of migrationFiles.slice(2, 5)) {
    const sql = await readMigration(file);
    const replacements = decodeSqlJson(sql, "v_replacements");
    if (replacements.length === 0) continue;

    assert.match(sql, /v_conflict\.source_ref is not distinct from v_replacement->>'sourceRef'/, `${file} must compare exact audited source_ref including null`);
    assert.match(sql, /v_conflict\.id = \(v_replacement->>'approvedPlanId'\)::uuid/, `${file} must compare exact approved legacy UUID`);
    assert.match(sql, /v_conflict\.created_by_user_id = v_coach_id/, `${file} must require Predrag as creator`);
    assert.match(sql, /program access\/assignment dependencies/, `${file} must reject assigned/accessed legacy plans`);
    assert.match(sql, /active edit draft dependencies/, `${file} must reject edit-draft dependencies`);
    assert.doesNotMatch(sql, /source_ref is null/i, `${file} must not allow null legacy source_ref`);
    assert.match(sql, /v_normalized := public\.multi_seed_\d+_normalize_legacy_plan\(v_conflict\.id\)/);
    assert.match(sql, /INTERNAL_CANONICALIZATION_MISMATCH/);
    assert.match(sql, /v_expected_components := public\.multi_seed_\d+_legacy_plan_component_checksums\(v_replacement->'normalized'\)/);
    assert.doesNotMatch(sql, /legacy conflict normalized checksum mismatch/);
    assert.doesNotMatch(sql, /v_normalized is distinct from \(v_replacement->'normalized'\)/);
    assert.match(sql, /'reason', 'approved_authoritative_cleaned_replacement'/);
    assert.match(sql, /'actualChecksum', v_actual_checksum/);
    assert.match(sql, /'actualComponentChecksums', v_actual_components - 'full'/);
    assert.match(sql, /'expectedChecksum', v_replacement->>'checksum'/);
    assert.match(sql, /'differingComponents'/);
    assert.match(sql, /expectedComponentChecksums/);
    if (file.includes("milos_milovic")) {
      assert.match(sql, /approved_builder_active_no_expected_content/, `${file} must audit the approved active builder replacement without a local expected payload`);
    }
    assert.doesNotMatch(sql, /sort_created_at|pi\.created_at as sort_created_at/);
    assert.doesNotMatch(sql, /case when pi\.item_type = 'exercise' then nullif\(btrim\(e\.name\)/);

    const invariantIndex = sql.indexOf("INTERNAL_CANONICALIZATION_MISMATCH");
    const conflictCountIndex = sql.indexOf("select count(*) into v_conflict_count");
    const metadataIndex = sql.indexOf("legacy conflict identity/metadata mismatch");
    const dependencyIndex = sql.indexOf("program access/assignment dependencies");
    const backupValidationIndex = sql.indexOf("backup validation failed");
    const backupIndex = sql.indexOf("insert into public.data_migration_backups");
    const deleteIndex = sql.indexOf("delete from plans.plan_items");
    assert.ok(invariantIndex > 0 && invariantIndex < conflictCountIndex, `${file} internal canonicalization guard must run before reading conflicting plan`);
    assert.ok(conflictCountIndex < backupIndex, `${file} conflict read must still happen before backup`);
    assert.ok(metadataIndex > 0 && metadataIndex < backupIndex, `${file} metadata guard must run before backup`);
    assert.ok(dependencyIndex > metadataIndex && dependencyIndex < backupIndex, `${file} dependency guard must run before backup`);
    assert.ok(backupIndex < backupValidationIndex && backupValidationIndex < deleteIndex, `${file} backup must be validated before deletes`);
    assert.ok(backupIndex < deleteIndex, `${file} backup must be written before deletes`);
  }
});

test("legacy SQL signature ignores UUIDs and timestamps", async () => {
  const migrations = await Promise.all(migrationFiles.slice(2, 5).map(readMigration));
  const replacement = firstReplacementWithItems(migrations);

  const withEnvironmentOnlyChanges = clone(replacement.normalized);
  withEnvironmentOnlyChanges.items = withEnvironmentOnlyChanges.items.map((item, index) => ({
    ...item,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    exercise_id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    created_at: `2026-08-${String((index % 20) + 1).padStart(2, "0")}T12:00:00.000Z`,
    updated_at: `2026-09-${String((index % 20) + 1).padStart(2, "0")}T12:00:00.000Z`,
    exercise_expected_name: `Environment name ${index}`,
  }));

  await withSignatureClient(async (client) => {
    assert.equal(await sqlLegacyPlanChecksum(client, withEnvironmentOnlyChanges), await sqlLegacyPlanChecksum(client, replacement.normalized));
  });
});

test("legacy SQL component checksums change for business content changes", async () => {
  const migrations = await Promise.all(migrationFiles.slice(2, 5).map(readMigration));
  const replacement = firstReplacementWithItems(migrations);

  const doseChanged = clone(replacement.normalized);
  doseChanged.items[0].sets = `${doseChanged.items[0].sets || ""} changed`;

  const exerciseChanged = clone(replacement.normalized);
  exerciseChanged.items[0].exercise_key = `${exerciseChanged.items[0].exercise_key || "missing"}-changed`;

  const instructionChanged = clone(replacement.normalized);
  instructionChanged.items[0].description = `${instructionChanged.items[0].description || ""} changed`;

  const noteItem = replacement.normalized.items.findIndex((item) => item.item_type === "note" || item.note);
  const noteChanged = clone(replacement.normalized);
  const index = noteItem >= 0 ? noteItem : 0;
  noteChanged.items[index].note = `${noteChanged.items[index].note || ""} changed`;

  const sectionChanged = clone(replacement.normalized);
  sectionChanged.items[0].section_name = `${sectionChanged.items[0].section_name || ""} changed`;

  await withSignatureClient(async (client) => {
    const baseline = await sqlLegacyPlanComponents(client, replacement.normalized);
    const dose = await sqlLegacyPlanComponents(client, doseChanged);
    const exercise = await sqlLegacyPlanComponents(client, exerciseChanged);
    const instruction = await sqlLegacyPlanComponents(client, instructionChanged);
    const note = await sqlLegacyPlanComponents(client, noteChanged);
    const section = await sqlLegacyPlanComponents(client, sectionChanged);

    assert.notEqual(dose.full, baseline.full);
    assert.notEqual(dose.dose, baseline.dose);
    assert.notEqual(exercise.full, baseline.full);
    assert.notEqual(exercise.exercise_keys, baseline.exercise_keys);
    assert.notEqual(instruction.full, baseline.full);
    assert.notEqual(instruction.text_notes, baseline.text_notes);
    assert.notEqual(note.full, baseline.full);
    assert.notEqual(note.text_notes, baseline.text_notes);
    assert.notEqual(section.full, baseline.full);
    assert.notEqual(section.sections, baseline.sections);
  });
});

test("legacy conflict negative cases rollback before backup/delete", async () => {
  for (const file of migrationFiles.slice(2, 5)) {
    const sql = await readMigration(file);
    const replacements = decodeSqlJson(sql, "v_replacements");
    if (replacements.length === 0) continue;

    assert.match(sql, /if v_conflict_count > 1 then raise exception '%: more than one weekly conflict found/, `${file} must reject unexpected second plan`);
    assert.match(sql, /v_conflict\.id = \(v_replacement->>'approvedPlanId'\)::uuid/, `${file} must reject wrong UUID`);
    assert.match(sql, /v_conflict\.status = v_replacement->>'status'/, `${file} must reject wrong status slot`);
    assert.match(sql, /v_conflict\.source_type = v_replacement->>'sourceType'/, `${file} must reject unexpected source_type`);
    assert.match(sql, /v_conflict\.source_ref is not distinct from v_replacement->>'sourceRef'/, `${file} must reject same athlete/week with different source_ref`);
    assert.match(sql, /legacy conflict count guard mismatch/, `${file} must reject changed counts`);
    assert.match(sql, /program access\/assignment dependencies/, `${file} must reject assigned/accessed plans`);
    assert.match(sql, /backup validation failed/, `${file} must rollback if backup validation fails`);

    const backupIndex = sql.indexOf("insert into public.data_migration_backups");
    for (const guard of [
      "more than one weekly conflict found",
      "legacy conflict identity/metadata mismatch",
      "legacy conflict count guard mismatch",
      "program access/assignment dependencies",
    ]) {
      const guardIndex = sql.indexOf(guard);
      assert.ok(guardIndex > 0 && guardIndex < backupIndex, `${file} ${guard} must happen before backup/delete so rollback leaves no backup or delete residue`);
    }
  }
});

test("legacy conflict backups include enough tables for restore", async () => {
  for (const file of migrationFiles.slice(2, 5)) {
    const sql = await readMigration(file);
    if (!sql.includes("normalizedChecksum")) continue;
    for (const required of [
      "plans.plans",
      "plans.plan_days",
      "plans.plan_sessions",
      "plans.plan_nodes",
      "plans.plan_items",
      "plans.plan_items.exercise_refs",
      "library.program_tags",
      "plans.plans.edit_drafts",
    ]) {
      assert.match(sql, new RegExp(required.replace(/[.]/g, "\\.")), `${file} backup must include ${required}`);
    }
    assert.match(sql, /delete from plans\.plan_items/);
    assert.match(sql, /delete from plans\.plans/);
  }
});

test("Zija prerequisite resolves athlete 131 without user email dependency", async () => {
  const sql = await readMigration(migrationFiles[1]);
  assert.match(sql, /athlete_id = '131' or source_external_id = '131'/);
  assert.match(sql, /insert into public\.athletes/);
  assert.match(sql, /insert into public\.user_athletes/);
  assert.doesNotMatch(sql, /radovan|users\.email/i);
});
