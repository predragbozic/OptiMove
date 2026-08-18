import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  ["103|2026-05-04", "Plan-program.xlsx athlete 103 week 2026-05-04"],
  ["103|2026-06-08", "Plan-program.xlsx athlete 103 week 2026-06-08"],
  ["107|2026-06-08", "Plan-program.xlsx athlete 107 week 2026-06-08"],
]);

function filePath(file) {
  return path.join(migrationDir, file);
}

function decodeSqlJson(sql, variableName) {
  const pattern = new RegExp(`${variableName}\\s+jsonb\\s*:=\\s*'((?:''|[^'])*)'::jsonb`);
  const match = sql.match(pattern);
  assert.ok(match, `expected ${variableName} JSON payload`);
  return JSON.parse(match[1].replace(/''/g, "'"));
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
      assert.equal(replacement.status, "draft");
      assert.equal(replacement.sourceType, "xlsx_weekly_import");
      assert.ok(replacement.normalized, `${key} must embed normalized legacy content`);
      assert.deepEqual(replacement.normalized.counts, replacement.counts);
    }
    assert.doesNotMatch(sql, /DATABASE_URL|postgres:\/\/|supabase\.co|password/i);
    assert.doesNotMatch(sql, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "program migration must not embed local UUIDs");
  }

  assert.deepEqual(totals, { plans: 54, days: 112, sessions: 180, sectionNodes: 452, exerciseItems: 2608, noteItems: 128 });
  assert.equal(mapping.code + mapping.slug, 2608);
  assert.equal(mapping.note, 128);
  assert.equal(sourceRefs.size, 54);
  assert.equal(replacementGuards, 6);
  assert.deepEqual(replacementSourceRefs, legacyConflictSourceRefs);
});

test("legacy conflict guard uses audited source_ref and normalized content before backup/delete", async () => {
  for (const file of migrationFiles.slice(2, 5)) {
    const sql = await readMigration(file);
    const replacements = decodeSqlJson(sql, "v_replacements");
    if (replacements.length === 0) continue;

    assert.match(sql, /v_conflict\.source_ref = v_replacement->>'sourceRef'/, `${file} must compare exact audited source_ref`);
    assert.doesNotMatch(sql, /source_ref is null/i, `${file} must not allow null legacy source_ref`);
    assert.match(sql, /v_normalized := public\.multi_seed_\d+_normalize_legacy_plan\(v_conflict\.id\)/);
    assert.match(sql, /v_normalized is distinct from \(v_replacement->'normalized'\)/);
    assert.match(sql, /legacy conflict normalized checksum mismatch/);

    const metadataIndex = sql.indexOf("legacy conflict metadata/source_ref mismatch");
    const checksumIndex = sql.indexOf("legacy conflict normalized checksum mismatch");
    const backupIndex = sql.indexOf("insert into public.data_migration_backups");
    const deleteIndex = sql.indexOf("delete from plans.plan_items");
    assert.ok(metadataIndex > 0 && metadataIndex < backupIndex, `${file} metadata guard must run before backup`);
    assert.ok(checksumIndex > metadataIndex && checksumIndex < backupIndex, `${file} normalized guard must run before backup`);
    assert.ok(backupIndex < deleteIndex, `${file} backup must be written before deletes`);
  }
});

test("legacy conflict negative cases rollback before backup/delete", async () => {
  for (const file of migrationFiles.slice(2, 5)) {
    const sql = await readMigration(file);
    const replacements = decodeSqlJson(sql, "v_replacements");
    if (replacements.length === 0) continue;

    assert.match(sql, /if v_conflict_count > 1 then raise exception '%: more than one weekly conflict found/, `${file} must reject unexpected second plan`);
    assert.match(sql, /v_conflict\.status = v_replacement->>'status'/, `${file} must reject active or assigned-status slot`);
    assert.match(sql, /v_conflict\.source_type = v_replacement->>'sourceType'/, `${file} must reject unexpected source_type`);
    assert.match(sql, /v_conflict\.source_ref = v_replacement->>'sourceRef'/, `${file} must reject same athlete/week with different source_ref`);
    assert.match(sql, /v_normalized is distinct from \(v_replacement->'normalized'\)/, `${file} must reject changed item checksum`);

    const backupIndex = sql.indexOf("insert into public.data_migration_backups");
    for (const guard of [
      "more than one weekly conflict found",
      "legacy conflict metadata/source_ref mismatch",
      "legacy conflict count/checksum guard mismatch",
      "legacy conflict normalized checksum mismatch",
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
