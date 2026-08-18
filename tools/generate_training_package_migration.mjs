#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import { createHash } from "crypto";
import { Client, parseArgs, readEnvFile, safeDbLabel } from "./training_package_core.mjs";
import { legacySignatureChecksum } from "./legacy_plan_signature.mjs";

const SOURCE_TYPE = "multi_athlete_cleaned_import";
const COACH_EMAIL = "predrag.bozic@rzsport.gov.rs";
const LOCAL_ENV_PATH = path.resolve("backend/.env");
const MIGRATION_DIR = path.resolve("migrations");
const MANIFEST_DIR = path.resolve("tools/manifests");
const BACKUP_DIR = path.resolve("tools/backups");

const ATHLETES = [
  { file: "milos_milovic", manifest: "milos-milovic-102-cleaned-2026-08-18.json", sourceExternalId: "102", expected: { plans: 14, days: 34, sessions: 50, sectionNodes: 169, exerciseItems: 953, noteItems: 36 } },
  { file: "nikola_vujinivic", manifest: "nikola-vujinivic-103-cleaned-2026-08-18.json", sourceExternalId: "103", expected: { plans: 13, days: 30, sessions: 48, sectionNodes: 122, exerciseItems: 702, noteItems: 39 } },
  { file: "nikola_petkovic", manifest: "nikola-petkovic-107-cleaned-2026-08-18.json", sourceExternalId: "107", expected: { plans: 13, days: 24, sessions: 42, sectionNodes: 99, exerciseItems: 580, noteItems: 32 } },
  { file: "zija_murina", manifest: "zija-murina-131-cleaned-2026-08-18.json", sourceExternalId: "131", expected: { plans: 14, days: 24, sessions: 40, sectionNodes: 62, exerciseItems: 373, noteItems: 21 } },
];

const PROGRAM_FILES = new Map([
  ["102", "20260818_seed_multi_athlete_03_milos_milovic_programs.sql"],
  ["103", "20260818_seed_multi_athlete_04_nikola_vujinivic_programs.sql"],
  ["107", "20260818_seed_multi_athlete_05_nikola_petkovic_programs.sql"],
  ["131", "20260818_seed_multi_athlete_06_zija_murina_programs.sql"],
]);

const PREREQ_FILE = "20260818_seed_multi_athlete_01_custom_exercises.sql";
const ZIJA_FILE = "20260818_seed_multi_athlete_02_zija_murina.sql";

const APPROVED_REPLACEMENTS = new Map([
  ["milos-milovic-102-cleaned-2026-08-18|2026-06-08", { athleteExternalId: "102", weekStart: "2026-06-08", status: "draft", sourceType: "xlsx_weekly_import", sourceRef: "Plan-program.xlsx athlete 102 week 2026-06-08", checksum: "289df1b838c057cd4132de68aaea38c34a8ccf4d46c050d2f89b4e5e4e47be69", counts: { days: 4, sessions: 4, exerciseItems: 98, noteItems: 0, totalItems: 98 } }],
  ["milos-milovic-102-cleaned-2026-08-18|2026-06-15", { athleteExternalId: "102", weekStart: "2026-06-15", status: "draft", sourceType: "xlsx_weekly_import", sourceRef: "Plan-program.xlsx athlete 102 week 2026-06-15", checksum: "80f3e59e087e8d8da5be36c9666ab9b104f159d58a4a73f96149b5f1bd5e4db7", counts: { days: 6, sessions: 6, exerciseItems: 179, noteItems: 0, totalItems: 179 } }],
  ["milos-milovic-102-cleaned-2026-08-18|2026-06-22", { athleteExternalId: "102", weekStart: "2026-06-22", status: "draft", sourceType: "xlsx_weekly_import", sourceRef: "Plan-program.xlsx athlete 102 week 2026-06-22", checksum: "c5dc46f7b2ae07fcf311524b5f81ed9a8bd8354d8dbfb0e8e2259740383b6d16", counts: { days: 1, sessions: 1, exerciseItems: 26, noteItems: 0, totalItems: 26 } }],
  ["nikola-vujinivic-103-cleaned-2026-08-18|2026-05-04", { athleteExternalId: "103", weekStart: "2026-05-04", status: "draft", sourceType: "xlsx_weekly_import", sourceRef: "Plan-program.xlsx athlete 103 week 2026-05-04", checksum: "3ca5576ccea42a8c2ba0ad6ca3a19fef1158578d87c47298ceef2da56cd8d4c7", counts: { days: 6, sessions: 9, exerciseItems: 121, noteItems: 0, totalItems: 126 } }],
  ["nikola-vujinivic-103-cleaned-2026-08-18|2026-06-08", { athleteExternalId: "103", weekStart: "2026-06-08", status: "draft", sourceType: "xlsx_weekly_import", sourceRef: "Plan-program.xlsx athlete 103 week 2026-06-08", checksum: "84fc203c52cb3e3c37251fbb08f9cd2f9ecab1155b1a46afa0617bad8d969ff7", counts: { days: 5, sessions: 5, exerciseItems: 135, noteItems: 0, totalItems: 135 } }],
  ["nikola-petkovic-107-cleaned-2026-08-18|2026-06-08", { athleteExternalId: "107", weekStart: "2026-06-08", status: "draft", sourceType: "xlsx_weekly_import", sourceRef: "Plan-program.xlsx athlete 107 week 2026-06-08", checksum: "1ecaf4bd0cb2d936e1b75a87a6d8e89387ca3a7b0bd39e3a0787ba38a96e5fbd", counts: { days: 1, sessions: 2, exerciseItems: 28, noteItems: 0, totalItems: 28 } }],
]);

function sqlString(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonLiteral(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function localDate(value) {
  if (!value) return null;
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  return String(value).slice(0, 10);
}

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? localDate(value) : value]));
}

function readManifest(fileName) {
  return JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, fileName), "utf8"));
}

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function cleanValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function numericText(value) {
  const text = cleanValue(value);
  if (text === null) return null;
  const number = Number(text);
  return Number.isFinite(number) ? String(number) : text;
}

function backupRows(backup, table) {
  return backup.tables?.[table] || [];
}

function legacySectionKey(item) {
  return [
    localDate(item.date),
    cleanValue(item.session_order),
    cleanValue(item.domain_name),
    cleanValue(item.category_name),
    cleanValue(item.section_name),
  ].join("|");
}

function normalizeBackupPlan(backup) {
  const days = backupRows(backup, "plans.plan_days");
  const sessions = backupRows(backup, "plans.plan_sessions");
  const nodes = backupRows(backup, "plans.plan_nodes");
  const items = backupRows(backup, "plans.plan_items");
  const exerciseRefs = backupRows(backup, "plans.plan_items.exercise_refs");
  const dayById = new Map(days.map((row) => [row.id, row]));
  const sessionById = new Map(sessions.map((row) => [row.id, row]));
  const nodeById = new Map(nodes.map((row) => [row.id, row]));
  const exerciseByItemId = new Map(exerciseRefs.map((row) => [row.plan_item_id, row]));
  const sectionKeys = new Set();

  const normalizedItems = items.map((item) => {
    const session = sessionById.get(item.plan_session_id) || {};
    const day = dayById.get(session.plan_day_id) || {};
    const node = nodeById.get(item.plan_node_id) || {};
    const exercise = exerciseByItemId.get(item.id) || {};
    const date = localDate(day.date);
    const normalized = {
      date,
      day_note: cleanValue(day.day_note),
      session_order: numericText(session.session_order),
      am_pm: cleanValue(session.am_pm),
      bta: cleanValue(session.bta),
      node_type: cleanValue(node.node_type),
      node_name: cleanValue(node.name),
      node_order: numericText(node.node_order),
      item_type: cleanValue(item.item_type),
      title: cleanValue(item.title),
      description: cleanValue(item.description),
      short_note: cleanValue(item.short_note),
      note: cleanValue(item.note),
      image_url: cleanValue(item.image_url),
      video_url: cleanValue(item.video_url),
      sets: cleanValue(item.sets),
      reps: cleanValue(item.reps),
      load: cleanValue(item.load),
      item_order: numericText(item.item_order),
      exercise_order: numericText(item.exercise_order),
      source_row_ref: cleanValue(item.source_row_ref),
      domain_name: cleanValue(item.domain_name),
      category_name: cleanValue(item.category_name),
      section_name: cleanValue(item.section_name),
      domain_color: cleanValue(item.domain_color),
      category_color: cleanValue(item.category_color),
      section_color: cleanValue(item.section_color),
      domain_icon_url: cleanValue(item.domain_icon_url),
      category_icon_url: cleanValue(item.category_icon_url),
      section_icon_url: cleanValue(item.section_icon_url),
      domain_short_note: cleanValue(item.domain_short_note),
      category_short_note: cleanValue(item.category_short_note),
      section_short_note: cleanValue(item.section_short_note),
      domain_note: cleanValue(item.domain_note),
      category_note: cleanValue(item.category_note),
      section_note: cleanValue(item.section_note),
      domain_order: numericText(item.domain_order),
      category_order: numericText(item.category_order),
      section_order: numericText(item.section_order),
      exercise_key_type: null,
      exercise_key: null,
    };
    if (normalized.item_type === "exercise") {
      if (cleanValue(exercise.exercise_code)) {
        normalized.exercise_key_type = "code";
        normalized.exercise_key = cleanValue(exercise.exercise_code);
      } else if (cleanValue(exercise.slug)) {
        normalized.exercise_key_type = "slug";
        normalized.exercise_key = cleanValue(exercise.slug);
      } else {
        normalized.exercise_key_type = "title";
        normalized.exercise_key = normalized.title;
      }
    }
    sectionKeys.add(legacySectionKey({ ...normalized, date }));
    return normalized;
  }).sort((a, b) => JSON.stringify([
    a.date,
    Number(a.session_order || 0),
    a.am_pm || "",
    a.bta || "",
    Number(a.node_order || 0),
    Number(a.item_order || 0),
    a.source_row_ref || "",
    a.title || "",
  ]).localeCompare(JSON.stringify([
    b.date,
    Number(b.session_order || 0),
    b.am_pm || "",
    b.bta || "",
    Number(b.node_order || 0),
    Number(b.item_order || 0),
    b.source_row_ref || "",
    b.title || "",
  ])));

  return {
    counts: {
      days: days.length,
      sessions: sessions.length,
      sections: sectionKeys.size,
      exerciseItems: normalizedItems.filter((item) => item.item_type === "exercise").length,
      noteItems: normalizedItems.filter((item) => item.item_type === "note").length,
      totalItems: normalizedItems.length,
    },
    items: normalizedItems,
  };
}

function findReplacementBackup(replacement) {
  if (!fs.existsSync(BACKUP_DIR)) throw new Error(`Missing backup directory ${BACKUP_DIR}`);
  const candidates = fs.readdirSync(BACKUP_DIR)
    .filter((file) => file.startsWith("multi-athlete-conflict-plan-") && file.endsWith(".json"))
    .map((file) => {
      const fullPath = path.join(BACKUP_DIR, file);
      const backup = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      return { file, fullPath, backup };
    })
    .filter(({ backup }) => backup.expectedGuard?.athleteId === replacement.athleteExternalId && backup.expectedGuard?.weekStart === replacement.weekStart)
    .sort((a, b) => a.file.localeCompare(b.file));
  if (candidates.length === 0) throw new Error(`Missing approved backup for athlete ${replacement.athleteExternalId} week ${replacement.weekStart}`);
  const { backup } = candidates.at(-1);
  const plan = backupRows(backup, "plans.plans")[0];
  if (!plan || plan.source_ref !== replacement.sourceRef) {
    throw new Error(`Backup source_ref mismatch for athlete ${replacement.athleteExternalId} week ${replacement.weekStart}`);
  }
  const normalized = normalizeBackupPlan(backup);
  for (const [key, value] of Object.entries(replacement.counts)) {
    if (normalized.counts[key] !== value) {
      throw new Error(`Backup count mismatch for athlete ${replacement.athleteExternalId} week ${replacement.weekStart}: ${key} expected ${value}, found ${normalized.counts[key]}`);
    }
  }
  return { ...replacement, auditChecksum: backup.normalizedChecksum || null, checksum: legacySignatureChecksum(normalized), counts: normalized.counts, normalized };
}

async function query(client, sql, params = []) {
  return (await client.query(sql, params)).rows.map(normalizeRow);
}

async function extractPayload(client, athleteConfig) {
  const manifest = readManifest(athleteConfig.manifest);
  const packageId = manifest.packageId;
  const sourceRefs = (await query(
    client,
    `select source_ref from plans.plans where source_type = $1 and source_ref like $2 order by week_start`,
    [SOURCE_TYPE, `${packageId}:weekly:%`],
  )).map((row) => row.source_ref);
  if (sourceRefs.length !== athleteConfig.expected.plans) {
    throw new Error(`${packageId}: expected ${athleteConfig.expected.plans} local plans, found ${sourceRefs.length}`);
  }

  const plans = await query(client, `select name, note, icon_url, color, week_start, start_date, duration_days, program_order, source_ref, source_external_id, visibility, library_scope, owner_type, access_model, can_copy, can_edit_copy, can_assign_to_athlete, athlete_can_view_directly, requires_approval, is_template, is_active from plans.plans where source_type = $1 and source_ref = any($2::text[]) order by week_start`, [SOURCE_TYPE, sourceRefs]);
  const days = await query(client, `select p.source_ref as plan_source_ref, pd.date, pd.day_note, pd.day_order, pd.source_row_ref, pd.block_index, pd.block_name, pd.block_type, pd.block_order from plans.plans p join plans.plan_days pd on pd.plan_id = p.id where p.source_type = $1 and p.source_ref = any($2::text[]) order by p.week_start, pd.block_order nulls last, pd.block_index, pd.date`, [SOURCE_TYPE, sourceRefs]);
  const sessions = await query(client, `select p.source_ref as plan_source_ref, pd.date, ps.am_pm, ps.bta, ps.session_order, ps.session_time from plans.plans p join plans.plan_days pd on pd.plan_id = p.id join plans.plan_sessions ps on ps.plan_day_id = pd.id where p.source_type = $1 and p.source_ref = any($2::text[]) order by p.week_start, pd.block_order nulls last, pd.block_index, ps.session_order`, [SOURCE_TYPE, sourceRefs]);
  const nodes = await query(client, `select p.source_ref as plan_source_ref, pd.date, ps.session_order, pn.node_type, pn.name, pn.color, pn.icon_url, pn.short_note, pn.note, pn.node_order, parent.node_type as parent_node_type, parent.name as parent_name, parent.node_order as parent_node_order from plans.plans p join plans.plan_days pd on pd.plan_id = p.id join plans.plan_sessions ps on ps.plan_day_id = pd.id join plans.plan_nodes pn on pn.plan_session_id = ps.id left join plans.plan_nodes parent on parent.id = pn.parent_id where p.source_type = $1 and p.source_ref = any($2::text[]) order by p.week_start, pd.block_order nulls last, pd.block_index, ps.session_order, pn.node_order`, [SOURCE_TYPE, sourceRefs]);
  const items = (await query(client, `select p.source_ref as plan_source_ref, pd.date, ps.session_order, pn.node_type, pn.name as node_name, pn.node_order, pi.item_type, pi.title, pi.description, pi.short_note, pi.note, pi.image_url, pi.video_url, pi.sets, pi.reps, pi.load, pi.item_order, pi.exercise_order, pi.source_row_ref, pi.domain_name, pi.category_name, pi.section_name, pi.domain_color, pi.category_color, pi.section_color, pi.domain_icon_url, pi.category_icon_url, pi.section_icon_url, pi.domain_short_note, pi.category_short_note, pi.section_short_note, pi.domain_note, pi.category_note, pi.section_note, pi.domain_order, pi.category_order, pi.section_order, e.exercise_code, e.slug as exercise_slug, e.name as exercise_name from plans.plans p join plans.plan_days pd on pd.plan_id = p.id join plans.plan_sessions ps on ps.plan_day_id = pd.id join plans.plan_items pi on pi.plan_session_id = ps.id left join plans.plan_nodes pn on pn.id = pi.plan_node_id left join library.exercises e on e.id = pi.exercise_id where p.source_type = $1 and p.source_ref = any($2::text[]) order by p.week_start, pd.block_order nulls last, pd.block_index, ps.session_order, pi.item_order`, [SOURCE_TYPE, sourceRefs])).map((row) => {
    if (row.item_type === "exercise") {
      if (row.exercise_code) {
        row.exercise_key_type = "code";
        row.exercise_key = String(row.exercise_code);
      } else if (row.exercise_slug) {
        row.exercise_key_type = "slug";
        row.exercise_key = row.exercise_slug;
      } else {
        throw new Error(`${packageId}: exercise item ${row.source_row_ref} has no stable exercise key`);
      }
      row.exercise_expected_name = row.exercise_name;
    } else {
      row.exercise_key_type = null;
      row.exercise_key = null;
      row.exercise_expected_name = null;
    }
    delete row.exercise_code;
    delete row.exercise_slug;
    delete row.exercise_name;
    return row;
  });

  const requiredExerciseKeys = [...new Map(items.filter((item) => item.exercise_key).map((item) => [
    `${item.exercise_key_type}:${item.exercise_key}`,
    { keyType: item.exercise_key_type, key: item.exercise_key, expectedName: item.exercise_expected_name },
  ])).values()].sort((a, b) => `${a.keyType}:${a.key}`.localeCompare(`${b.keyType}:${b.key}`));

  const replacements = plans
    .map((plan) => APPROVED_REPLACEMENTS.get(`${packageId}|${plan.week_start}`))
    .filter(Boolean)
    .map(findReplacementBackup);
  return {
    packageId,
    sourceType: SOURCE_TYPE,
    coachEmail: COACH_EMAIL,
    athleteExternalId: athleteConfig.sourceExternalId,
    expected: athleteConfig.expected,
    plans,
    days,
    sessions,
    nodes,
    items,
    requiredExerciseKeys,
    approvedReplacements: replacements,
    payloadChecksum: checksum({ packageId, plans, days, sessions, nodes, items, requiredExerciseKeys, replacements }),
  };
}

async function extractCustomExercises(client) {
  const rows = await query(client, `select slug, name, instruction, video_url, image_url, owner_scope, is_active from library.exercises where exercise_code is null and owner_scope = 'user' and (slug like 'multi-athlete-cleaned-2026-08-18:custom:%' or slug like 'milos-milovic-102-cleaned-2026-08-18:custom:%' or slug like 'nikola-vujinivic-103-cleaned-2026-08-18:custom:%') order by slug`);
  if (rows.length !== 14) throw new Error(`Expected 14 multi-athlete custom exercises, found ${rows.length}`);
  return rows;
}

function renderCustomExercisesSql(customExercises, payloadChecksum) {
  return `-- Seed shared multi-athlete custom exercises.
-- Generated from verified local package. Do not run manually outside the deploy migration runner.

begin;

create extension if not exists pgcrypto;

do $$
declare
  v_payload_checksum constant text := ${sqlString(payloadChecksum)};
  v_owner_email constant text := ${sqlString(COACH_EMAIL)};
  v_owner_id uuid;
  v_custom_exercises jsonb := ${jsonLiteral(customExercises)};
  r jsonb;
begin
  select id into v_owner_id from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true) limit 2;
  if v_owner_id is null or (select count(*) from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true)) <> 1 then
    raise exception 'Multi-athlete custom exercise seed: expected exactly one active owner user %', v_owner_email;
  end if;

  for r in select * from jsonb_array_elements(v_custom_exercises) loop
    if exists (select 1 from library.exercises where slug = r->>'slug') then
      if not exists (
        select 1 from library.exercises
        where slug = r->>'slug'
          and exercise_code is null
          and name = r->>'name'
          and owner_scope = 'user'
          and owner_user_id = v_owner_id
          and created_by_user_id = v_owner_id
          and instruction is not distinct from nullif(r->>'instruction', '')
          and video_url is not distinct from nullif(r->>'video_url', '')
          and image_url is not distinct from nullif(r->>'image_url', '')
          and coalesce(is_active, true) = coalesce((r->>'is_active')::boolean, true)
      ) then
        raise exception 'Multi-athlete custom exercise seed: slug % exists with different content/owner', r->>'slug';
      end if;
    else
      insert into library.exercises (owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name, instruction, video_url, image_url, is_active)
      values ('user', v_owner_id, v_owner_id, null, r->>'slug', r->>'name', nullif(r->>'instruction', ''), nullif(r->>'video_url', ''), nullif(r->>'image_url', ''), coalesce((r->>'is_active')::boolean, true));
    end if;
  end loop;

  if (
    select count(*) from library.exercises e
    where e.slug in (select value->>'slug' from jsonb_array_elements(v_custom_exercises) value)
      and e.owner_scope = 'user'
      and e.owner_user_id = v_owner_id
      and e.created_by_user_id = v_owner_id
      and e.exercise_code is null
      and coalesce(e.is_active, true)
  ) <> 14 then
    raise exception 'Multi-athlete custom exercise seed: expected 14 custom exercises after seed';
  end if;
end $$;

commit;
`;
}

function renderZijaSql() {
  return `-- Ensure Zija Murina athlete 131 and Predrag private coach relationship exist.
-- Generated for multi-athlete package prerequisites. Do not run manually outside the deploy migration runner.

begin;

create extension if not exists pgcrypto;

do $$
declare
  v_owner_email constant text := ${sqlString(COACH_EMAIL)};
  v_owner_id uuid;
  v_athlete_id uuid;
  v_count integer;
begin
  select id into v_owner_id from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true) limit 2;
  if v_owner_id is null or (select count(*) from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true)) <> 1 then
    raise exception 'Zija Murina seed: expected exactly one active owner user %', v_owner_email;
  end if;

  select count(*) into v_count from public.athletes where athlete_id = '131' or source_external_id = '131';
  if v_count > 1 then
    raise exception 'Zija Murina seed: expected at most one athlete row with athlete_id/source_external_id 131, found %', v_count;
  end if;

  if v_count = 0 then
    insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, image_url, user_id, club_id, team_id, is_active)
    values ('131', '131', 'Zija', 'Murina', 'Zija Murina', 'Zija Murina', null, null, null, null, true)
    returning id into v_athlete_id;
  else
    select id into v_athlete_id from public.athletes where athlete_id = '131' or source_external_id = '131' for update;
    if not exists (
      select 1 from public.athletes
      where id = v_athlete_id and coalesce(is_active, true)
        and coalesce(first_name, split_part(coalesce(display_name, full_name, ''), ' ', 1), '') = 'Zija'
        and coalesce(last_name, regexp_replace(coalesce(display_name, full_name, ''), '^\\S+\\s*', ''), '') = 'Murina'
    ) then
      raise exception 'Zija Murina seed: existing athlete 131 does not represent Zija Murina';
    end if;
  end if;

  insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
  values (v_owner_id, v_athlete_id, 'coach', true)
  on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now();
end $$;

commit;
`;
}

function renderProgramSql(payload) {
  const fnPrefix = `multi_seed_${payload.athleteExternalId}`;
  return `-- Seed ${payload.packageId} imported weekly plans.
-- Generated from verified local source package. Do not run manually outside the deploy migration runner.

begin;

create extension if not exists pgcrypto;

create table if not exists public.data_migration_backups (
  id uuid primary key default gen_random_uuid(),
  migration_id text not null,
  package_id text not null,
  entity_type text not null,
  original_entity_id uuid not null,
  payload jsonb not null,
  checksum text not null,
  created_at timestamptz not null default now(),
  unique (migration_id, original_entity_id)
);

drop function if exists public.${fnPrefix}_validate_package(text, jsonb, jsonb, uuid);
create function public.${fnPrefix}_validate_package(p_source_type text, p_plans jsonb, p_expected jsonb, p_athlete_id uuid)
returns void
language plpgsql
as $validate$
declare
  v_actual record;
begin
  select count(distinct p.id)::int as plans,
         count(distinct pd.id)::int as days,
         count(distinct ps.id)::int as sessions,
         count(distinct pn.id) filter (where pn.node_type = 'section')::int as section_nodes,
         count(distinct pi.id) filter (where pi.item_type = 'exercise')::int as exercise_items,
         count(distinct pi.id) filter (where pi.item_type = 'note')::int as note_items,
         count(distinct pi.id) filter (where pi.item_type = 'exercise' and pi.exercise_id is not null)::int as valid_exercise_refs,
         count(distinct p.source_ref)::int as distinct_source_refs,
         bool_and(p.status = 'draft') as all_draft,
         bool_and(p.athlete_id = p_athlete_id) as all_target_athlete
  into v_actual
  from plans.plans p
  left join plans.plan_days pd on pd.plan_id = p.id
  left join plans.plan_sessions ps on ps.plan_day_id = pd.id
  left join plans.plan_nodes pn on pn.plan_session_id = ps.id
  left join plans.plan_items pi on pi.plan_session_id = ps.id
  where p.source_type = p_source_type
    and p.source_ref in (select value->>'source_ref' from jsonb_array_elements(p_plans) value);

  if v_actual.plans <> (p_expected->>'plans')::int then raise exception '${payload.packageId}: plans expected %, found %', p_expected->>'plans', v_actual.plans; end if;
  if v_actual.days <> (p_expected->>'days')::int then raise exception '${payload.packageId}: days expected %, found %', p_expected->>'days', v_actual.days; end if;
  if v_actual.sessions <> (p_expected->>'sessions')::int then raise exception '${payload.packageId}: sessions expected %, found %', p_expected->>'sessions', v_actual.sessions; end if;
  if v_actual.section_nodes <> (p_expected->>'sectionNodes')::int then raise exception '${payload.packageId}: section nodes expected %, found %', p_expected->>'sectionNodes', v_actual.section_nodes; end if;
  if v_actual.exercise_items <> (p_expected->>'exerciseItems')::int then raise exception '${payload.packageId}: exercise items expected %, found %', p_expected->>'exerciseItems', v_actual.exercise_items; end if;
  if v_actual.note_items <> (p_expected->>'noteItems')::int then raise exception '${payload.packageId}: note items expected %, found %', p_expected->>'noteItems', v_actual.note_items; end if;
  if v_actual.valid_exercise_refs <> (p_expected->>'exerciseItems')::int then raise exception '${payload.packageId}: valid exercise refs expected %, found %', p_expected->>'exerciseItems', v_actual.valid_exercise_refs; end if;
  if v_actual.distinct_source_refs <> (p_expected->>'plans')::int then raise exception '${payload.packageId}: distinct source_refs expected %, found %', p_expected->>'plans', v_actual.distinct_source_refs; end if;
  if not coalesce(v_actual.all_draft, false) then raise exception '${payload.packageId}: not all plans are draft'; end if;
  if not coalesce(v_actual.all_target_athlete, false) then raise exception '${payload.packageId}: not all plans belong to target athlete'; end if;
end;
$validate$;

drop function if exists public.${fnPrefix}_normalize_legacy_plan(uuid);
create function public.${fnPrefix}_normalize_legacy_plan(p_plan_id uuid)
returns jsonb
language sql
stable
as $normalize$
  with item_rows as (
    select
      pd.date::text as date,
      nullif(btrim(pd.day_note), '') as day_note,
      nullif(ps.session_order::text, '') as session_order,
      nullif(btrim(ps.am_pm), '') as am_pm,
      nullif(btrim(ps.bta), '') as bta,
      nullif(btrim(pn.node_type), '') as node_type,
      nullif(btrim(pn.name), '') as node_name,
      nullif(pn.node_order::text, '') as node_order,
      nullif(btrim(pi.item_type), '') as item_type,
      nullif(btrim(pi.title), '') as title,
      nullif(btrim(pi.description), '') as description,
      nullif(btrim(pi.short_note), '') as short_note,
      nullif(btrim(pi.note), '') as note,
      nullif(btrim(pi.image_url), '') as image_url,
      nullif(btrim(pi.video_url), '') as video_url,
      nullif(btrim(pi.sets), '') as sets,
      nullif(btrim(pi.reps), '') as reps,
      nullif(btrim(pi.load), '') as load,
      nullif(pi.item_order::text, '') as item_order,
      nullif(pi.exercise_order::text, '') as exercise_order,
      nullif(btrim(pi.source_row_ref), '') as source_row_ref,
      nullif(btrim(pi.domain_name), '') as domain_name,
      nullif(btrim(pi.category_name), '') as category_name,
      nullif(btrim(pi.section_name), '') as section_name,
      nullif(btrim(pi.domain_color), '') as domain_color,
      nullif(btrim(pi.category_color), '') as category_color,
      nullif(btrim(pi.section_color), '') as section_color,
      nullif(btrim(pi.domain_icon_url), '') as domain_icon_url,
      nullif(btrim(pi.category_icon_url), '') as category_icon_url,
      nullif(btrim(pi.section_icon_url), '') as section_icon_url,
      nullif(btrim(pi.domain_short_note), '') as domain_short_note,
      nullif(btrim(pi.category_short_note), '') as category_short_note,
      nullif(btrim(pi.section_short_note), '') as section_short_note,
      nullif(btrim(pi.domain_note), '') as domain_note,
      nullif(btrim(pi.category_note), '') as category_note,
      nullif(btrim(pi.section_note), '') as section_note,
      nullif(pi.domain_order::text, '') as domain_order,
      nullif(pi.category_order::text, '') as category_order,
      nullif(pi.section_order::text, '') as section_order,
      case
        when pi.item_type = 'exercise' and e.exercise_code is not null then 'code'
        when pi.item_type = 'exercise' and e.slug is not null then 'slug'
        when pi.item_type = 'exercise' then 'title'
        else null
      end as exercise_key_type,
      case
        when pi.item_type = 'exercise' and e.exercise_code is not null then e.exercise_code::text
        when pi.item_type = 'exercise' and e.slug is not null then e.slug
        when pi.item_type = 'exercise' then nullif(btrim(pi.title), '')
        else null
      end as exercise_key,
      pd.block_order as sort_block_order,
      pd.block_index as sort_block_index,
      ps.session_order as sort_session_order,
      pn.node_order as sort_node_order,
      pi.item_order as sort_item_order
    from plans.plan_items pi
    join plans.plan_sessions ps on ps.id = pi.plan_session_id
    join plans.plan_days pd on pd.id = ps.plan_day_id
    left join plans.plan_nodes pn on pn.id = pi.plan_node_id
    left join library.exercises e on e.id = pi.exercise_id
    where pd.plan_id = p_plan_id
  ),
  normalized_items as (
    select jsonb_build_object(
      'date', date,
      'day_note', day_note,
      'session_order', session_order,
      'am_pm', am_pm,
      'bta', bta,
      'node_type', node_type,
      'node_name', node_name,
      'node_order', node_order,
      'item_type', item_type,
      'title', title,
      'description', description,
      'short_note', short_note,
      'note', note,
      'image_url', image_url,
      'video_url', video_url,
      'sets', sets,
      'reps', reps,
      'load', load,
      'item_order', item_order,
      'exercise_order', exercise_order,
      'source_row_ref', source_row_ref,
      'domain_name', domain_name,
      'category_name', category_name,
      'section_name', section_name,
      'domain_color', domain_color,
      'category_color', category_color,
      'section_color', section_color,
      'domain_icon_url', domain_icon_url,
      'category_icon_url', category_icon_url,
      'section_icon_url', section_icon_url,
      'domain_short_note', domain_short_note,
      'category_short_note', category_short_note,
      'section_short_note', section_short_note,
      'domain_note', domain_note,
      'category_note', category_note,
      'section_note', section_note,
      'domain_order', domain_order,
      'category_order', category_order,
      'section_order', section_order,
      'exercise_key_type', exercise_key_type,
      'exercise_key', exercise_key
    ) as item,
    date,
    sort_block_order,
    sort_block_index,
    sort_session_order,
    am_pm,
    bta,
    sort_node_order,
    sort_item_order,
    source_row_ref,
    exercise_key_type,
    exercise_key,
    title,
    description,
    note
    from item_rows
  )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'days', (select count(*)::int from plans.plan_days where plan_id = p_plan_id),
      'sessions', (select count(*)::int from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p_plan_id),
      'sections', (select count(distinct concat_ws('|', date, session_order, domain_name, category_name, section_name))::int from item_rows),
      'exerciseItems', (select count(*)::int from item_rows where item_type = 'exercise'),
      'noteItems', (select count(*)::int from item_rows where item_type = 'note'),
      'totalItems', (select count(*)::int from item_rows)
    ),
    'items', coalesce((select jsonb_agg(item order by date, sort_block_order nulls last, sort_block_index nulls last, sort_session_order nulls last, am_pm nulls last, bta nulls last, sort_node_order nulls last, sort_item_order nulls last, source_row_ref nulls last, exercise_key_type nulls last, exercise_key nulls last, title nulls last, description nulls last, note nulls last) from normalized_items), '[]'::jsonb)
  );
$normalize$;

do $$
declare
  v_migration_id constant text := ${sqlString(`20260818_seed_multi_athlete_${payload.athleteExternalId}_programs`)};
  v_package_id constant text := ${sqlString(payload.packageId)};
  v_source_type constant text := ${sqlString(payload.sourceType)};
  v_payload_checksum constant text := ${sqlString(payload.payloadChecksum)};
  v_coach_email constant text := ${sqlString(payload.coachEmail)};
  v_athlete_external_id constant text := ${sqlString(payload.athleteExternalId)};
  v_coach_id uuid;
  v_athlete_id uuid;
  v_existing_package_count integer;
  v_expected jsonb := ${jsonLiteral(payload.expected)};
  v_plans jsonb := ${jsonLiteral(payload.plans)};
  v_days jsonb := ${jsonLiteral(payload.days)};
  v_sessions jsonb := ${jsonLiteral(payload.sessions)};
  v_nodes jsonb := ${jsonLiteral(payload.nodes)};
  v_items jsonb := ${jsonLiteral(payload.items)};
  v_required_exercises jsonb := ${jsonLiteral(payload.requiredExerciseKeys)};
  v_replacements jsonb := ${jsonLiteral(payload.approvedReplacements)};
  r jsonb;
  v_plan_id uuid;
  v_day_id uuid;
  v_session_id uuid;
  v_parent_node_id uuid;
  v_node_id uuid;
  v_exercise_id uuid;
  v_match_count integer;
  v_conflict_count integer;
  v_conflict record;
  v_replacement jsonb;
  v_normalized jsonb;
  v_actual_checksum text;
  v_expected_sql_checksum text;
  v_diff_components text[];
  v_backup_payload jsonb;
  v_backup_checksum text;
begin
  select id into v_coach_id from public.users where lower(email) = lower(v_coach_email) and coalesce(is_active, true) limit 2;
  if v_coach_id is null or (select count(*) from public.users where lower(email) = lower(v_coach_email) and coalesce(is_active, true)) <> 1 then
    raise exception '%: expected exactly one active owner user %', v_package_id, v_coach_email;
  end if;

  select id into v_athlete_id from public.athletes where athlete_id = v_athlete_external_id or source_external_id = v_athlete_external_id limit 2;
  if v_athlete_id is null or (select count(*) from public.athletes where athlete_id = v_athlete_external_id or source_external_id = v_athlete_external_id) <> 1 then
    raise exception '%: expected exactly one athlete row with athlete_id/source_external_id %', v_package_id, v_athlete_external_id;
  end if;

  create temp table _multi_plan_map (source_ref text primary key, id uuid not null) on commit drop;
  create temp table _multi_day_map (plan_source_ref text not null, date date not null, id uuid not null, primary key (plan_source_ref, date)) on commit drop;
  create temp table _multi_session_map (plan_source_ref text not null, date date not null, session_order numeric not null, id uuid not null, primary key (plan_source_ref, date, session_order)) on commit drop;
  create temp table _multi_node_map (plan_source_ref text not null, date date not null, session_order numeric not null, node_type text not null, name text not null, node_order numeric not null, id uuid not null, primary key (plan_source_ref, date, session_order, node_type, name, node_order)) on commit drop;
  create temp table _multi_exercise_map (key_type text not null, key text not null, id uuid not null, primary key (key_type, key)) on commit drop;

  select count(*) into v_existing_package_count from plans.plans where source_type = v_source_type and source_ref in (select value->>'source_ref' from jsonb_array_elements(v_plans) value);
  if v_existing_package_count not in (0, (v_expected->>'plans')::int) then
    raise exception '%: partial package exists (% of % plans); refusing to continue', v_package_id, v_existing_package_count, (v_expected->>'plans')::int;
  end if;
  if v_existing_package_count = (v_expected->>'plans')::int then
    perform public.${fnPrefix}_validate_package(v_source_type, v_plans, v_expected, v_athlete_id);
    return;
  end if;

  for r in select * from jsonb_array_elements(v_plans) loop
    select count(*) into v_conflict_count
    from plans.plans p
    where p.athlete_id = v_athlete_id
      and p.created_by_user_id = v_coach_id
      and p.plan_type = 'weekly'
      and p.week_start = (r->>'week_start')::date
      and coalesce(p.is_active, true)
      and not coalesce(p.is_edit_draft, false)
      and not (p.source_type = v_source_type and p.source_ref = r->>'source_ref');
    if v_conflict_count > 1 then raise exception '%: more than one weekly conflict found for %', v_package_id, r->>'week_start'; end if;
    if v_conflict_count = 1 then
      select p.*,
             (select count(*)::int from plans.plan_days pd where pd.plan_id = p.id) as legacy_days,
             (select count(*)::int from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id) as legacy_sessions,
             (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id and pi.item_type = 'exercise') as legacy_exercise_items,
             (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id and pi.item_type = 'note') as legacy_note_items,
             (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id) as legacy_total_items
      into v_conflict
      from plans.plans p
      where p.athlete_id = v_athlete_id
        and p.created_by_user_id = v_coach_id
        and p.plan_type = 'weekly'
        and p.week_start = (r->>'week_start')::date
        and coalesce(p.is_active, true)
        and not coalesce(p.is_edit_draft, false)
        and not (p.source_type = v_source_type and p.source_ref = r->>'source_ref')
      for update;

      select value into v_replacement from jsonb_array_elements(v_replacements) value where value->>'weekStart' = r->>'week_start';
      if v_replacement is null then
        raise exception '%: unexpected weekly conflict for %, plan %, source_type %, status %', v_package_id, r->>'week_start', v_conflict.id, v_conflict.source_type, v_conflict.status;
      end if;
      if not (
        v_conflict.status = v_replacement->>'status'
        and v_conflict.source_type = v_replacement->>'sourceType'
        and v_conflict.source_ref = v_replacement->>'sourceRef'
      ) then
        raise exception '%: legacy conflict metadata/source_ref mismatch for %, plan %', v_package_id, r->>'week_start', v_conflict.id;
      end if;
      if not (
        v_conflict.legacy_days = (v_replacement#>>'{counts,days}')::int
        and v_conflict.legacy_sessions = (v_replacement#>>'{counts,sessions}')::int
        and public.${fnPrefix}_normalize_legacy_plan(v_conflict.id)#>>'{counts,sections}' = v_replacement#>>'{counts,sections}'
        and v_conflict.legacy_exercise_items = (v_replacement#>>'{counts,exerciseItems}')::int
        and v_conflict.legacy_note_items = (v_replacement#>>'{counts,noteItems}')::int
        and v_conflict.legacy_total_items = (v_replacement#>>'{counts,totalItems}')::int
      ) then
        raise exception '%: legacy conflict count/checksum guard mismatch for %, expected checksum %', v_package_id, r->>'week_start', v_replacement->>'checksum';
      end if;
      v_normalized := public.${fnPrefix}_normalize_legacy_plan(v_conflict.id);
      v_actual_checksum := encode(digest(v_normalized::text, 'sha256'), 'hex');
      v_expected_sql_checksum := encode(digest((v_replacement->'normalized')::text, 'sha256'), 'hex');
      if v_normalized is distinct from (v_replacement->'normalized') then
        select array_remove(array[
          case when v_normalized->'counts' is distinct from v_replacement->'normalized'->'counts' then 'counts' end,
          case when jsonb_array_length(coalesce(v_normalized->'items', '[]'::jsonb)) is distinct from jsonb_array_length(coalesce(v_replacement->'normalized'->'items', '[]'::jsonb)) then 'items.length' end,
          case when (select coalesce(jsonb_agg(jsonb_build_array(value->>'date', value->>'session_order', value->>'node_order', value->>'item_order', value->>'source_row_ref') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_normalized->'items', '[]'::jsonb)) with ordinality as t(value, ord))
             is distinct from (select coalesce(jsonb_agg(jsonb_build_array(value->>'date', value->>'session_order', value->>'node_order', value->>'item_order', value->>'source_row_ref') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_replacement->'normalized'->'items', '[]'::jsonb)) with ordinality as t(value, ord)) then 'order_or_source_rows' end,
          case when (select coalesce(jsonb_agg(jsonb_build_array(value->>'exercise_key_type', value->>'exercise_key') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_normalized->'items', '[]'::jsonb)) with ordinality as t(value, ord))
             is distinct from (select coalesce(jsonb_agg(jsonb_build_array(value->>'exercise_key_type', value->>'exercise_key') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_replacement->'normalized'->'items', '[]'::jsonb)) with ordinality as t(value, ord)) then 'exercise_keys' end,
          case when (select coalesce(jsonb_agg(jsonb_build_array(value->>'sets', value->>'reps', value->>'load') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_normalized->'items', '[]'::jsonb)) with ordinality as t(value, ord))
             is distinct from (select coalesce(jsonb_agg(jsonb_build_array(value->>'sets', value->>'reps', value->>'load') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_replacement->'normalized'->'items', '[]'::jsonb)) with ordinality as t(value, ord)) then 'dose' end,
          case when (select coalesce(jsonb_agg(jsonb_build_array(value->>'title', value->>'description', value->>'short_note', value->>'note') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_normalized->'items', '[]'::jsonb)) with ordinality as t(value, ord))
             is distinct from (select coalesce(jsonb_agg(jsonb_build_array(value->>'title', value->>'description', value->>'short_note', value->>'note') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_replacement->'normalized'->'items', '[]'::jsonb)) with ordinality as t(value, ord)) then 'text_or_notes' end,
          case when (select coalesce(jsonb_agg(jsonb_build_array(value->>'domain_name', value->>'category_name', value->>'section_name', value->>'domain_order', value->>'category_order', value->>'section_order') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_normalized->'items', '[]'::jsonb)) with ordinality as t(value, ord))
             is distinct from (select coalesce(jsonb_agg(jsonb_build_array(value->>'domain_name', value->>'category_name', value->>'section_name', value->>'domain_order', value->>'category_order', value->>'section_order') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_replacement->'normalized'->'items', '[]'::jsonb)) with ordinality as t(value, ord)) then 'sections' end,
          case when (select coalesce(jsonb_agg(jsonb_build_array(value->>'image_url', value->>'video_url') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_normalized->'items', '[]'::jsonb)) with ordinality as t(value, ord))
             is distinct from (select coalesce(jsonb_agg(jsonb_build_array(value->>'image_url', value->>'video_url') order by ord), '[]'::jsonb) from jsonb_array_elements(coalesce(v_replacement->'normalized'->'items', '[]'::jsonb)) with ordinality as t(value, ord)) then 'media' end
        ], null) into v_diff_components;
        raise exception '%: legacy conflict normalized checksum mismatch for %, plan %, status %, source_type %, source_ref %, expected checksum %, expected_sql_checksum %, actual checksum %, expected_counts %, actual_counts %, differing_components %',
          v_package_id,
          r->>'week_start',
          v_conflict.id,
          v_conflict.status,
          v_conflict.source_type,
          coalesce(v_conflict.source_ref, '<null>'),
          v_replacement->>'checksum',
          v_expected_sql_checksum,
          v_actual_checksum,
          v_replacement->'normalized'->'counts',
          v_normalized->'counts',
          coalesce(array_to_string(v_diff_components, ','), '<unknown>');
      end if;

      v_backup_payload := jsonb_build_object(
        'backupFormat', 'optimove-plan-backup/v1',
        'migrationId', v_migration_id,
        'packageId', v_package_id,
        'exportedAt', now(),
        'originalPlanUuid', v_conflict.id,
        'normalizedChecksum', v_replacement->>'checksum',
        'legacyAuditChecksum', v_replacement->>'auditChecksum',
        'expectedGuard', v_replacement - 'normalized',
        'normalizedContent', v_normalized,
        'tables', jsonb_build_object(
          'plans.plans', (select jsonb_agg(to_jsonb(p) order by p.id) from plans.plans p where p.id = v_conflict.id),
          'plans.plan_days', (select coalesce(jsonb_agg(to_jsonb(pd) order by pd.block_order nulls last, pd.block_index, pd.day_order, pd.created_at), '[]'::jsonb) from plans.plan_days pd where pd.plan_id = v_conflict.id),
          'plans.plan_sessions', (select coalesce(jsonb_agg(to_jsonb(ps) order by pd.block_order nulls last, pd.block_index, ps.session_order nulls last, ps.created_at), '[]'::jsonb) from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = v_conflict.id),
          'plans.plan_nodes', (select coalesce(jsonb_agg(to_jsonb(pn) order by ps.session_order nulls last, pn.node_order nulls last, pn.created_at), '[]'::jsonb) from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = v_conflict.id),
          'plans.plan_items', (select coalesce(jsonb_agg(to_jsonb(pi) order by ps.session_order nulls last, pi.item_order nulls last, pi.created_at), '[]'::jsonb) from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = v_conflict.id),
          'plans.plan_items.exercise_refs', (select coalesce(jsonb_agg(jsonb_build_object('plan_item_id', pi.id, 'exercise_id', pi.exercise_id, 'exercise_code', e.exercise_code, 'slug', e.slug, 'name', e.name) order by ps.session_order nulls last, pi.item_order nulls last, pi.created_at), '[]'::jsonb) from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id left join library.exercises e on e.id = pi.exercise_id where pd.plan_id = v_conflict.id),
          'library.program_tags', (select coalesce(jsonb_agg(to_jsonb(pt) order by pt.created_at, pt.tag_id), '[]'::jsonb) from library.program_tags pt where pt.plan_id = v_conflict.id),
          'plans.plans.edit_drafts', (select coalesce(jsonb_agg(to_jsonb(ep) order by ep.created_at), '[]'::jsonb) from plans.plans ep where ep.edit_source_plan_id = v_conflict.id)
        )
      );
      v_backup_checksum := encode(digest(v_backup_payload::text, 'sha256'), 'hex');
      insert into public.data_migration_backups (migration_id, package_id, entity_type, original_entity_id, payload, checksum)
      values (v_migration_id, v_package_id, 'plans.plans', v_conflict.id, v_backup_payload, v_backup_checksum)
      on conflict (migration_id, original_entity_id) do nothing;

      delete from library.program_tags where plan_id = v_conflict.id;
      delete from plans.plan_items pi using plans.plan_sessions ps, plans.plan_days pd where pi.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = v_conflict.id;
      delete from plans.plan_nodes pn using plans.plan_sessions ps, plans.plan_days pd where pn.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = v_conflict.id;
      delete from plans.plan_sessions ps using plans.plan_days pd where ps.plan_day_id = pd.id and pd.plan_id = v_conflict.id;
      delete from plans.plan_days where plan_id = v_conflict.id;
      delete from plans.plans where id = v_conflict.id;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(v_required_exercises) loop
    if r->>'keyType' = 'code' then
      select count(*), min(id::text)::uuid into v_match_count, v_exercise_id from library.exercises where exercise_code = r->>'key' and coalesce(is_active, true);
    else
      select count(*), min(id::text)::uuid into v_match_count, v_exercise_id from library.exercises where slug = r->>'key' and name = r->>'expectedName' and coalesce(is_active, true);
    end if;
    if v_match_count <> 1 then raise exception '%: required exercise %:% expected exactly one match, found %', v_package_id, r->>'keyType', r->>'key', v_match_count; end if;
    insert into _multi_exercise_map (key_type, key, id) values (r->>'keyType', r->>'key', v_exercise_id);
  end loop;

  for r in select * from jsonb_array_elements(v_plans) loop
    insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, week_start, start_date, duration_days, program_order, status, source_type, source_ref, source_external_id, is_template, visibility, library_scope, owner_type, access_model, can_copy, can_edit_copy, can_assign_to_athlete, athlete_can_view_directly, requires_approval, is_active)
    values ('weekly', v_coach_id, v_athlete_id, r->>'name', nullif(r->>'note', ''), nullif(r->>'icon_url', ''), nullif(r->>'color', ''), (r->>'week_start')::date, nullif(r->>'start_date', '')::date, nullif(r->>'duration_days', '')::int, nullif(r->>'program_order', '')::numeric, 'draft', v_source_type, r->>'source_ref', v_athlete_external_id, false, 'private', 'my', 'coach', 'free_forever', true, true, true, false, false, true)
    returning id into v_plan_id;
    insert into _multi_plan_map values (r->>'source_ref', v_plan_id);
  end loop;

  for r in select * from jsonb_array_elements(v_days) loop
    select id into v_plan_id from _multi_plan_map where source_ref = r->>'plan_source_ref';
    insert into plans.plan_days (plan_id, date, day_note, day_order, source_row_ref, block_index, block_name, block_type, block_order)
    values (v_plan_id, (r->>'date')::date, nullif(r->>'day_note', ''), nullif(r->>'day_order', '')::numeric, nullif(r->>'source_row_ref', ''), nullif(r->>'block_index', '')::int, nullif(r->>'block_name', ''), nullif(r->>'block_type', ''), nullif(r->>'block_order', '')::numeric)
    returning id into v_day_id;
    insert into _multi_day_map values (r->>'plan_source_ref', (r->>'date')::date, v_day_id);
  end loop;

  for r in select * from jsonb_array_elements(v_sessions) loop
    select id into v_day_id from _multi_day_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date;
    insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, session_time)
    values (v_day_id, nullif(r->>'am_pm', ''), nullif(r->>'bta', ''), nullif(r->>'session_order', '')::numeric, nullif(r->>'session_time', '')::time)
    returning id into v_session_id;
    insert into _multi_session_map values (r->>'plan_source_ref', (r->>'date')::date, (r->>'session_order')::numeric, v_session_id);
  end loop;

  for r in select * from jsonb_array_elements(v_nodes) loop
    select id into v_session_id from _multi_session_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date and session_order = (r->>'session_order')::numeric;
    v_parent_node_id := null;
    if nullif(r->>'parent_name', '') is not null then
      select id into v_parent_node_id from _multi_node_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date and session_order = (r->>'session_order')::numeric and node_type = r->>'parent_node_type' and name = r->>'parent_name' and node_order = (r->>'parent_node_order')::numeric;
    end if;
    insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
    values (v_session_id, v_parent_node_id, r->>'node_type', r->>'name', nullif(r->>'color', ''), nullif(r->>'icon_url', ''), nullif(r->>'short_note', ''), nullif(r->>'note', ''), (r->>'node_order')::numeric)
    returning id into v_node_id;
    insert into _multi_node_map values (r->>'plan_source_ref', (r->>'date')::date, (r->>'session_order')::numeric, r->>'node_type', r->>'name', (r->>'node_order')::numeric, v_node_id);
  end loop;

  for r in select * from jsonb_array_elements(v_items) loop
    select id into v_session_id from _multi_session_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date and session_order = (r->>'session_order')::numeric;
    v_node_id := null;
    if nullif(r->>'node_name', '') is not null then
      select id into v_node_id from _multi_node_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date and session_order = (r->>'session_order')::numeric and node_type = r->>'node_type' and name = r->>'node_name' and node_order = (r->>'node_order')::numeric;
    end if;
    v_exercise_id := null;
    if r->>'item_type' = 'exercise' then
      select id into v_exercise_id from _multi_exercise_map where key_type = r->>'exercise_key_type' and key = r->>'exercise_key';
      if v_exercise_id is null then raise exception '%: could not resolve item exercise %:% row %', v_package_id, r->>'exercise_key_type', r->>'exercise_key', r->>'source_row_ref'; end if;
    end if;
    insert into plans.plan_items (plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url, sets, reps, load, item_order, exercise_order, source_row_ref, domain_name, category_name, section_name, domain_color, category_color, section_color, domain_icon_url, category_icon_url, section_icon_url, domain_short_note, category_short_note, section_short_note, domain_note, category_note, section_note, domain_order, category_order, section_order)
    values (v_session_id, v_node_id, r->>'item_type', v_exercise_id, nullif(r->>'title', ''), nullif(r->>'description', ''), nullif(r->>'short_note', ''), nullif(r->>'note', ''), nullif(r->>'image_url', ''), nullif(r->>'video_url', ''), nullif(r->>'sets', ''), nullif(r->>'reps', ''), nullif(r->>'load', ''), nullif(r->>'item_order', '')::numeric, nullif(r->>'exercise_order', '')::numeric, nullif(r->>'source_row_ref', ''), nullif(r->>'domain_name', ''), nullif(r->>'category_name', ''), nullif(r->>'section_name', ''), nullif(r->>'domain_color', ''), nullif(r->>'category_color', ''), nullif(r->>'section_color', ''), nullif(r->>'domain_icon_url', ''), nullif(r->>'category_icon_url', ''), nullif(r->>'section_icon_url', ''), nullif(r->>'domain_short_note', ''), nullif(r->>'category_short_note', ''), nullif(r->>'section_short_note', ''), nullif(r->>'domain_note', ''), nullif(r->>'category_note', ''), nullif(r->>'section_note', ''), nullif(r->>'domain_order', '')::numeric, nullif(r->>'category_order', '')::numeric, nullif(r->>'section_order', '')::numeric);
  end loop;

  perform public.${fnPrefix}_validate_package(v_source_type, v_plans, v_expected, v_athlete_id);
end $$;

drop function public.${fnPrefix}_validate_package(text, jsonb, jsonb, uuid);
drop function public.${fnPrefix}_normalize_legacy_plan(uuid);

commit;
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.slice(2).includes("--generate")) args.generate = true;
  const databaseUrl = args.databaseUrl || process.env.LOCAL_DATABASE_URL || readEnvFile(LOCAL_ENV_PATH).DATABASE_URL || "";
  const label = safeDbLabel(databaseUrl);
  if (!label.appearsLocal) throw new Error("Refusing generator: database is not local.");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const customExercises = await extractCustomExercises(client);
    const payloads = [];
    for (const athlete of ATHLETES) payloads.push(await extractPayload(client, athlete));
    if (args.generate) {
      fs.mkdirSync(MIGRATION_DIR, { recursive: true });
      fs.writeFileSync(path.join(MIGRATION_DIR, PREREQ_FILE), renderCustomExercisesSql(customExercises, checksum(customExercises)), "utf8");
      fs.writeFileSync(path.join(MIGRATION_DIR, ZIJA_FILE), renderZijaSql(), "utf8");
      for (const payload of payloads) fs.writeFileSync(path.join(MIGRATION_DIR, PROGRAM_FILES.get(payload.athleteExternalId)), renderProgramSql(payload), "utf8");
    }
    console.log(JSON.stringify({
      mode: args.generate ? "generated" : "dry-run",
      migrations: [PREREQ_FILE, ZIJA_FILE, ...payloads.map((payload) => PROGRAM_FILES.get(payload.athleteExternalId))],
      customExercises: customExercises.map((exercise) => ({ name: exercise.name, slug: exercise.slug })),
      payloads: payloads.map((payload) => ({
        packageId: payload.packageId,
        athleteExternalId: payload.athleteExternalId,
        expected: payload.expected,
        counts: {
          plans: payload.plans.length,
          days: payload.days.length,
          sessions: payload.sessions.length,
          nodes: payload.nodes.length,
          sectionNodes: payload.nodes.filter((node) => node.node_type === "section").length,
          items: payload.items.length,
          exerciseItems: payload.items.filter((item) => item.item_type === "exercise").length,
          noteItems: payload.items.filter((item) => item.item_type === "note").length,
          requiredExerciseKeys: payload.requiredExerciseKeys.length,
          replacements: payload.approvedReplacements.length,
        },
      })),
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
