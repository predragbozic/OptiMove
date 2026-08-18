import fs from "fs";
import { createHash } from "crypto";
import { createRequire } from "module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { Client } = require("pg");

const PACKAGE_ID = "pankov-cleaned-2026-08-18";
const SOURCE_TYPE = "pankov_cleaned_import";
const COACH_EMAIL = "predrag.bozic@rzsport.gov.rs";
const ATHLETE_EMAIL = "radovan.pankov@example.com";
const ATHLETE_EXTERNAL_ID = "101";
const MIGRATION_FILE = new URL("../migrations/20260818_seed_pankov_programs.sql", import.meta.url);
const LOCAL_ENV_PATH = new URL("../backend/.env", import.meta.url);

function fileURLToPath(url) {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

function readEnvFile(url) {
  if (!fs.existsSync(url)) return {};
  return Object.fromEntries(
    fs.readFileSync(url, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([^#=]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1].trim(), match[2].trim()]),
  );
}

function localDate(value) {
  if (!value) return null;
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  return String(value).slice(0, 10);
}

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value instanceof Date) return [key, localDate(value)];
    return [key, value];
  }));
}

async function main() {
  const databaseUrl = process.env.LOCAL_DATABASE_URL || readEnvFile(LOCAL_ENV_PATH).DATABASE_URL || "";
  const parsed = new URL(databaseUrl);
  if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname)) throw new Error("Refusing generator: database is not local.");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sourceRefs = ["2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"].map((week) => `${PACKAGE_ID}:weekly:${week}`);
    const plans = (await client.query(
      `select name, note, icon_url, color, week_start, start_date, duration_days, program_order, source_ref, source_external_id,
              visibility, library_scope, owner_type, access_model, can_copy, can_edit_copy, can_assign_to_athlete,
              athlete_can_view_directly, requires_approval, is_template, is_active
       from plans.plans
       where source_type = $1 and source_ref = any($2::text[])
       order by week_start`,
      [SOURCE_TYPE, sourceRefs],
    )).rows.map(normalizeRow);
    const days = (await client.query(
      `select p.source_ref as plan_source_ref, pd.date, pd.day_note, pd.day_order, pd.source_row_ref,
              pd.block_index, pd.block_name, pd.block_type, pd.block_order
       from plans.plans p
       join plans.plan_days pd on pd.plan_id = p.id
       where p.source_type = $1 and p.source_ref = any($2::text[])
       order by p.week_start, pd.block_order nulls last, pd.block_index`,
      [SOURCE_TYPE, sourceRefs],
    )).rows.map(normalizeRow);
    const sessions = (await client.query(
      `select p.source_ref as plan_source_ref, pd.date, ps.am_pm, ps.bta, ps.session_order, ps.session_time
       from plans.plans p
       join plans.plan_days pd on pd.plan_id = p.id
       join plans.plan_sessions ps on ps.plan_day_id = pd.id
       where p.source_type = $1 and p.source_ref = any($2::text[])
       order by p.week_start, pd.block_order nulls last, pd.block_index, ps.session_order`,
      [SOURCE_TYPE, sourceRefs],
    )).rows.map(normalizeRow);
    const nodes = (await client.query(
      `select p.source_ref as plan_source_ref, pd.date, ps.session_order, pn.node_type, pn.name, pn.color, pn.icon_url,
              pn.short_note, pn.note, pn.node_order,
              parent.node_type as parent_node_type, parent.name as parent_name, parent.node_order as parent_node_order
       from plans.plans p
       join plans.plan_days pd on pd.plan_id = p.id
       join plans.plan_sessions ps on ps.plan_day_id = pd.id
       join plans.plan_nodes pn on pn.plan_session_id = ps.id
       left join plans.plan_nodes parent on parent.id = pn.parent_id
       where p.source_type = $1 and p.source_ref = any($2::text[])
       order by p.week_start, pd.block_order nulls last, pd.block_index, ps.session_order, pn.node_order`,
      [SOURCE_TYPE, sourceRefs],
    )).rows.map(normalizeRow);
    const items = (await client.query(
      `select p.source_ref as plan_source_ref, pd.date, ps.session_order,
              pn.node_type, pn.name as node_name, pn.node_order,
              pi.item_type, pi.title, pi.description, pi.short_note, pi.note, pi.image_url, pi.video_url,
              pi.sets, pi.reps, pi.load, pi.item_order, pi.exercise_order, pi.source_row_ref,
              pi.domain_name, pi.category_name, pi.section_name,
              pi.domain_color, pi.category_color, pi.section_color,
              pi.domain_icon_url, pi.category_icon_url, pi.section_icon_url,
              pi.domain_short_note, pi.category_short_note, pi.section_short_note,
              pi.domain_note, pi.category_note, pi.section_note,
              pi.domain_order, pi.category_order, pi.section_order,
              e.exercise_code, e.slug as exercise_slug, e.name as exercise_name
       from plans.plans p
       join plans.plan_days pd on pd.plan_id = p.id
       join plans.plan_sessions ps on ps.plan_day_id = pd.id
       join plans.plan_items pi on pi.plan_session_id = ps.id
       left join plans.plan_nodes pn on pn.id = pi.plan_node_id
       left join library.exercises e on e.id = pi.exercise_id
       where p.source_type = $1 and p.source_ref = any($2::text[])
       order by p.week_start, pd.block_order nulls last, pd.block_index, ps.session_order, pi.item_order`,
      [SOURCE_TYPE, sourceRefs],
    )).rows.map((row) => {
      const ready = normalizeRow(row);
      if (ready.item_type === "exercise") {
        if (ready.exercise_code) {
          ready.exercise_key_type = "code";
          ready.exercise_key = String(ready.exercise_code);
        } else if (ready.exercise_slug) {
          ready.exercise_key_type = "slug";
          ready.exercise_key = ready.exercise_slug;
        } else {
          throw new Error(`Exercise item ${ready.source_row_ref} has no code or slug.`);
        }
        ready.exercise_expected_name = ready.exercise_name;
      } else {
        ready.exercise_key_type = null;
        ready.exercise_key = null;
        ready.exercise_expected_name = null;
      }
      delete ready.exercise_code;
      delete ready.exercise_slug;
      delete ready.exercise_name;
      return ready;
    });
    const customExercises = (await client.query(
      `select slug, name, aim, execution_notes, instruction, video_url, image_url, image_mime_type,
              owner_scope, is_active
       from library.exercises
       where exercise_code is null and slug like $1
       order by name`,
      [`${PACKAGE_ID}:custom:%`],
    )).rows.map(normalizeRow);
    const requiredExerciseKeys = [...new Map(items.filter((item) => item.exercise_key).map((item) => [
      `${item.exercise_key_type}:${item.exercise_key}`,
      { keyType: item.exercise_key_type, key: item.exercise_key, expectedName: item.exercise_expected_name },
    ])).values()]
      .sort((a, b) => `${a.keyType}:${a.key}`.localeCompare(`${b.keyType}:${b.key}`));
    const payload = {
      packageId: PACKAGE_ID,
      sourceType: SOURCE_TYPE,
      coachEmail: COACH_EMAIL,
      athleteEmail: ATHLETE_EMAIL,
      athleteExternalId: ATHLETE_EXTERNAL_ID,
      expected: { plans: 7, days: 25, sessions: 47, excelSections: 84, exerciseItems: 670, noteItems: 13, customExercises: 16 },
      plans,
      days,
      sessions,
      nodes,
      items,
      customExercises,
      requiredExerciseKeys,
    };
    const checksum = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    const sql = renderSql(payload, checksum);
    fs.writeFileSync(MIGRATION_FILE, sql, "utf8");
    console.log(JSON.stringify({
      migration: fileURLToPath(MIGRATION_FILE),
      checksum,
      counts: {
        plans: plans.length,
        days: days.length,
        sessions: sessions.length,
        nodes: nodes.length,
        items: items.length,
        exerciseItems: items.filter((item) => item.item_type === "exercise").length,
        noteItems: items.filter((item) => item.item_type === "note").length,
        customExercises: customExercises.length,
        requiredExerciseKeys: requiredExerciseKeys.length,
      },
    }, null, 2));
  } finally {
    await client.end();
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonLiteral(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function renderSql(payload, checksum) {
  return `-- Seed Radovan Pankov imported weekly plans from local package ${payload.packageId}.
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

drop function if exists public.pankov_seed_validate_package(text, jsonb, jsonb, uuid);
create function public.pankov_seed_validate_package(p_source_type text, p_plans jsonb, p_expected jsonb, p_athlete_id uuid)
returns void
language plpgsql
as $validate$
declare
  v_actual record;
begin
  select count(distinct p.id)::int as plans,
         count(distinct pd.id)::int as days,
         count(distinct ps.id)::int as sessions,
         count(distinct pi.id) filter (where pi.item_type = 'exercise')::int as exercise_items,
         count(distinct pi.id) filter (where pi.item_type = 'note')::int as note_items,
         count(distinct e.id) filter (where e.slug like 'pankov-cleaned-2026-08-18:custom:%')::int as custom_exercises,
         count(distinct pi.id) filter (where pi.item_type = 'exercise' and pi.exercise_id is not null)::int as valid_exercise_refs,
         count(distinct p.source_ref)::int as distinct_source_refs,
         bool_and(p.status = 'draft') as all_draft,
         bool_and(p.athlete_id = p_athlete_id) as all_target_athlete
  into v_actual
  from plans.plans p
  left join plans.plan_days pd on pd.plan_id = p.id
  left join plans.plan_sessions ps on ps.plan_day_id = pd.id
  left join plans.plan_items pi on pi.plan_session_id = ps.id
  left join library.exercises e on e.id = pi.exercise_id
  where p.source_type = p_source_type
    and p.source_ref in (select value->>'source_ref' from jsonb_array_elements(p_plans) value);

  if v_actual.plans <> (p_expected->>'plans')::int then raise exception 'Pankov package validation failed: plans expected %, found %', p_expected->>'plans', v_actual.plans; end if;
  if v_actual.days <> (p_expected->>'days')::int then raise exception 'Pankov package validation failed: days expected %, found %', p_expected->>'days', v_actual.days; end if;
  if v_actual.sessions <> (p_expected->>'sessions')::int then raise exception 'Pankov package validation failed: sessions expected %, found %', p_expected->>'sessions', v_actual.sessions; end if;
  if v_actual.exercise_items <> (p_expected->>'exerciseItems')::int then raise exception 'Pankov package validation failed: exercise items expected %, found %', p_expected->>'exerciseItems', v_actual.exercise_items; end if;
  if v_actual.note_items <> (p_expected->>'noteItems')::int then raise exception 'Pankov package validation failed: note items expected %, found %', p_expected->>'noteItems', v_actual.note_items; end if;
  if v_actual.custom_exercises <> (p_expected->>'customExercises')::int then raise exception 'Pankov package validation failed: custom exercises expected %, found %', p_expected->>'customExercises', v_actual.custom_exercises; end if;
  if v_actual.valid_exercise_refs <> (p_expected->>'exerciseItems')::int then raise exception 'Pankov package validation failed: valid exercise refs expected %, found %', p_expected->>'exerciseItems', v_actual.valid_exercise_refs; end if;
  if v_actual.distinct_source_refs <> (p_expected->>'plans')::int then raise exception 'Pankov package validation failed: distinct source_refs expected %, found %', p_expected->>'plans', v_actual.distinct_source_refs; end if;
  if not coalesce(v_actual.all_draft, false) then raise exception 'Pankov package validation failed: not all plans are draft'; end if;
  if not coalesce(v_actual.all_target_athlete, false) then raise exception 'Pankov package validation failed: not all plans belong to target athlete'; end if;
end;
$validate$;

do $$
declare
  v_migration_id constant text := '20260818_seed_pankov_programs';
  v_package_id constant text := ${sqlString(payload.packageId)};
  v_source_type constant text := ${sqlString(payload.sourceType)};
  v_payload_checksum constant text := ${sqlString(checksum)};
  v_coach_id uuid;
  v_athlete_id uuid;
  v_existing_package_count integer;
  v_conflict record;
  v_conflict_count integer;
  v_backup_payload jsonb;
  v_backup_checksum text;
  v_expected jsonb := ${jsonLiteral(payload.expected)};
  v_custom_exercises jsonb := ${jsonLiteral(payload.customExercises)};
  v_plans jsonb := ${jsonLiteral(payload.plans)};
  v_days jsonb := ${jsonLiteral(payload.days)};
  v_sessions jsonb := ${jsonLiteral(payload.sessions)};
  v_nodes jsonb := ${jsonLiteral(payload.nodes)};
  v_items jsonb := ${jsonLiteral(payload.items)};
  v_required_exercises jsonb := ${jsonLiteral(payload.requiredExerciseKeys)};
  r jsonb;
  v_plan_id uuid;
  v_day_id uuid;
  v_session_id uuid;
  v_parent_node_id uuid;
  v_node_id uuid;
  v_exercise_id uuid;
  v_actual record;
begin
  select id into v_coach_id
  from public.users
  where lower(email) = lower(${sqlString(payload.coachEmail)}) and coalesce(is_active, true)
  limit 2;
  if v_coach_id is null or (select count(*) from public.users where lower(email) = lower(${sqlString(payload.coachEmail)}) and coalesce(is_active, true)) <> 1 then
    raise exception 'Pankov package %: expected exactly one active owner user %', v_package_id, ${sqlString(payload.coachEmail)};
  end if;

  select a.id into v_athlete_id
  from public.athletes a
  join public.users u on u.id = a.user_id
  where (a.athlete_id = ${sqlString(payload.athleteExternalId)} or a.source_external_id = ${sqlString(payload.athleteExternalId)})
    and lower(u.email) = lower(${sqlString(payload.athleteEmail)})
    and coalesce(a.is_active, true)
  limit 2;
  if v_athlete_id is null or (
    select count(*)
    from public.athletes a
    join public.users u on u.id = a.user_id
    where (a.athlete_id = ${sqlString(payload.athleteExternalId)} or a.source_external_id = ${sqlString(payload.athleteExternalId)})
      and lower(u.email) = lower(${sqlString(payload.athleteEmail)})
      and coalesce(a.is_active, true)
  ) <> 1 then
    raise exception 'Pankov package %: expected exactly one active athlete 101 linked to %', v_package_id, ${sqlString(payload.athleteEmail)};
  end if;

  create temp table _pankov_plan_map (source_ref text primary key, id uuid not null) on commit drop;
  create temp table _pankov_day_map (plan_source_ref text not null, date date not null, id uuid not null, primary key (plan_source_ref, date)) on commit drop;
  create temp table _pankov_session_map (plan_source_ref text not null, date date not null, session_order numeric not null, id uuid not null, primary key (plan_source_ref, date, session_order)) on commit drop;
  create temp table _pankov_node_map (plan_source_ref text not null, date date not null, session_order numeric not null, node_type text not null, name text not null, node_order numeric not null, id uuid not null, primary key (plan_source_ref, date, session_order, node_type, name, node_order)) on commit drop;
  create temp table _pankov_exercise_map (key_type text not null, key text not null, id uuid not null, primary key (key_type, key)) on commit drop;

  select count(*) into v_existing_package_count
  from plans.plans
  where source_type = v_source_type
    and source_ref in (select value->>'source_ref' from jsonb_array_elements(v_plans) value);

  if v_existing_package_count not in (0, (v_expected->>'plans')::int) then
    raise exception 'Pankov package %: partial package exists (% of % plans); refusing to continue', v_package_id, v_existing_package_count, (v_expected->>'plans')::int;
  end if;

  if v_existing_package_count = (v_expected->>'plans')::int then
    perform 1
    from plans.plans
    where source_type = v_source_type
      and source_ref in (select value->>'source_ref' from jsonb_array_elements(v_plans) value)
      and (status <> 'draft' or athlete_id <> v_athlete_id or created_by_user_id <> v_coach_id or coalesce(athlete_can_view_directly, false));
    if found then
      raise exception 'Pankov package %: existing package rows do not match expected draft/owner/athlete visibility', v_package_id;
    end if;
    perform public.pankov_seed_validate_package(v_source_type, v_plans, v_expected, v_athlete_id);
    return;
  end if;

  select count(*) into v_conflict_count
  from plans.plans p
  where p.athlete_id = v_athlete_id
    and p.created_by_user_id = v_coach_id
    and p.plan_type = 'weekly'
    and p.week_start = date '2026-07-20'
    and coalesce(p.is_active, true)
    and not coalesce(p.is_edit_draft, false);

  if v_conflict_count > 1 then
    raise exception 'Pankov package %: more than one existing 2026-07-20 weekly conflict found', v_package_id;
  end if;
  if v_conflict_count = 1 then
    select p.*,
           (select count(*)::int from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id) as sessions,
           (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id and pi.item_type = 'exercise') as exercise_items
    into v_conflict
    from plans.plans p
    where p.athlete_id = v_athlete_id
      and p.created_by_user_id = v_coach_id
      and p.plan_type = 'weekly'
      and p.week_start = date '2026-07-20'
      and coalesce(p.is_active, true)
      and not coalesce(p.is_edit_draft, false)
    for update;
    if not (
      v_conflict.name = 'KOmpetitive 2026-07-20'
      and v_conflict.source_type = 'builder'
      and v_conflict.source_ref is null
      and v_conflict.sessions = 1
      and v_conflict.exercise_items = 7
    ) then
      raise exception 'Pankov package %: unexpected 2026-07-20 conflict signature for plan %, refusing replacement', v_package_id, v_conflict.id;
    end if;

    v_backup_payload := jsonb_build_object(
      'backupFormat', 'optimove-plan-backup/v1',
      'migrationId', v_migration_id,
      'packageId', v_package_id,
      'exportedAt', now(),
      'tables', jsonb_build_object(
        'plans.plans', (select jsonb_agg(to_jsonb(p) order by p.id) from plans.plans p where p.id = v_conflict.id),
        'plans.plan_days', (select coalesce(jsonb_agg(to_jsonb(pd) order by pd.block_order nulls last, pd.block_index, pd.created_at), '[]'::jsonb) from plans.plan_days pd where pd.plan_id = v_conflict.id),
        'plans.plan_sessions', (select coalesce(jsonb_agg(to_jsonb(ps) order by ps.session_order nulls last, ps.created_at), '[]'::jsonb) from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = v_conflict.id),
        'plans.plan_nodes', (select coalesce(jsonb_agg(to_jsonb(pn) order by pn.node_order nulls last, pn.created_at), '[]'::jsonb) from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = v_conflict.id),
        'plans.plan_items', (select coalesce(jsonb_agg(to_jsonb(pi) order by pi.item_order nulls last, pi.created_at), '[]'::jsonb) from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = v_conflict.id),
        'library.program_tags', (select coalesce(jsonb_agg(to_jsonb(pt) order by pt.created_at, pt.tag_id), '[]'::jsonb) from library.program_tags pt where pt.plan_id = v_conflict.id),
        'library.program_reviews', (select case when to_regclass('library.program_reviews') is null then jsonb_build_object('tableMissing', true) else coalesce((select jsonb_agg(to_jsonb(pr) order by pr.created_at) from library.program_reviews pr where pr.plan_id = v_conflict.id), '[]'::jsonb) end),
        'library.program_access', (select case when to_regclass('library.program_access') is null then jsonb_build_object('tableMissing', true) else coalesce((select jsonb_agg(to_jsonb(pa) order by pa.created_at) from library.program_access pa where pa.plan_id = v_conflict.id or pa.related_plan_id = v_conflict.id), '[]'::jsonb) end)
      )
    );
    v_backup_checksum := encode(digest(v_backup_payload::text, 'sha256'), 'hex');
    insert into public.data_migration_backups (migration_id, package_id, entity_type, original_entity_id, payload, checksum)
    values (v_migration_id, v_package_id, 'plans.plans', v_conflict.id, v_backup_payload, v_backup_checksum)
    on conflict (migration_id, original_entity_id) do nothing;

    delete from library.program_tags where plan_id = v_conflict.id;
    if to_regclass('library.program_reviews') is not null then
      delete from library.program_reviews where plan_id = v_conflict.id;
    end if;
    if to_regclass('library.program_access') is not null then
      delete from library.program_access where plan_id = v_conflict.id or related_plan_id = v_conflict.id;
    end if;
    delete from plans.plan_items pi using plans.plan_sessions ps, plans.plan_days pd where pi.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = v_conflict.id;
    delete from plans.plan_nodes pn using plans.plan_sessions ps, plans.plan_days pd where pn.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = v_conflict.id;
    delete from plans.plan_sessions ps using plans.plan_days pd where ps.plan_day_id = pd.id and pd.plan_id = v_conflict.id;
    delete from plans.plan_days where plan_id = v_conflict.id;
    delete from plans.plans where id = v_conflict.id;
  end if;

  for r in select * from jsonb_array_elements(v_custom_exercises) loop
    if exists (select 1 from library.exercises where slug = r->>'slug') then
      if not exists (
        select 1 from library.exercises
        where slug = r->>'slug'
          and exercise_code is null
          and name = r->>'name'
          and coalesce(owner_scope, '') = coalesce(r->>'owner_scope', 'user')
          and owner_user_id = v_coach_id
          and created_by_user_id = v_coach_id
          and aim is not distinct from nullif(r->>'aim', '')
          and execution_notes is not distinct from nullif(r->>'execution_notes', '')
          and instruction is not distinct from nullif(r->>'instruction', '')
          and video_url is not distinct from nullif(r->>'video_url', '')
          and image_url is not distinct from nullif(r->>'image_url', '')
          and image_mime_type is not distinct from nullif(r->>'image_mime_type', '')
          and coalesce(is_active, true) = coalesce((r->>'is_active')::boolean, true)
      ) then
        raise exception 'Pankov package %: custom exercise slug % exists with different content', v_package_id, r->>'slug';
      end if;
    else
      insert into library.exercises (
        owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name,
        aim, execution_notes, instruction, video_url, image_url, image_mime_type, is_active
      ) values (
        coalesce(r->>'owner_scope', 'user'), v_coach_id, v_coach_id, null, r->>'slug', r->>'name',
        nullif(r->>'aim', ''), nullif(r->>'execution_notes', ''), nullif(r->>'instruction', ''),
        nullif(r->>'video_url', ''), nullif(r->>'image_url', ''), nullif(r->>'image_mime_type', ''),
        coalesce((r->>'is_active')::boolean, true)
      );
    end if;
  end loop;

  for r in select * from jsonb_array_elements(v_required_exercises) loop
    if r->>'keyType' = 'code' then
      select id into v_exercise_id from library.exercises where exercise_code = r->>'key' and coalesce(is_active, true);
    else
      select id into v_exercise_id from library.exercises where slug = r->>'key' and name = r->>'expectedName' and coalesce(is_active, true);
    end if;
    if v_exercise_id is null then
      raise exception 'Pankov package %: required exercise %:% was not found', v_package_id, r->>'keyType', r->>'key';
    end if;
    insert into _pankov_exercise_map (key_type, key, id) values (r->>'keyType', r->>'key', v_exercise_id);
  end loop;

  for r in select * from jsonb_array_elements(v_plans) loop
    insert into plans.plans (
      plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, week_start, start_date, duration_days,
      program_order, status, source_type, source_ref, source_external_id, is_template, visibility, library_scope,
      owner_type, access_model, can_copy, can_edit_copy, can_assign_to_athlete, athlete_can_view_directly,
      requires_approval, is_active
    ) values (
      'weekly', v_coach_id, v_athlete_id, r->>'name', nullif(r->>'note', ''), nullif(r->>'icon_url', ''),
      nullif(r->>'color', ''), (r->>'week_start')::date, nullif(r->>'start_date', '')::date,
      nullif(r->>'duration_days', '')::int, nullif(r->>'program_order', '')::numeric,
      'draft', v_source_type, r->>'source_ref', ${sqlString(payload.athleteExternalId)}, false, 'private', 'my',
      'coach', 'free_forever', true, true, true, false, false, true
    ) returning id into v_plan_id;
    insert into _pankov_plan_map values (r->>'source_ref', v_plan_id);
  end loop;

  for r in select * from jsonb_array_elements(v_days) loop
    select id into v_plan_id from _pankov_plan_map where source_ref = r->>'plan_source_ref';
    insert into plans.plan_days (plan_id, date, day_note, day_order, source_row_ref, block_index, block_name, block_type, block_order)
    values (v_plan_id, (r->>'date')::date, nullif(r->>'day_note', ''), nullif(r->>'day_order', '')::numeric,
            nullif(r->>'source_row_ref', ''), nullif(r->>'block_index', '')::int, nullif(r->>'block_name', ''),
            nullif(r->>'block_type', ''), nullif(r->>'block_order', '')::numeric)
    returning id into v_day_id;
    insert into _pankov_day_map values (r->>'plan_source_ref', (r->>'date')::date, v_day_id);
  end loop;

  for r in select * from jsonb_array_elements(v_sessions) loop
    select id into v_day_id from _pankov_day_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date;
    insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, session_time)
    values (v_day_id, nullif(r->>'am_pm', ''), nullif(r->>'bta', ''), nullif(r->>'session_order', '')::numeric, nullif(r->>'session_time', '')::time)
    returning id into v_session_id;
    insert into _pankov_session_map values (r->>'plan_source_ref', (r->>'date')::date, (r->>'session_order')::numeric, v_session_id);
  end loop;

  for r in select * from jsonb_array_elements(v_nodes) loop
    select id into v_session_id from _pankov_session_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date and session_order = (r->>'session_order')::numeric;
    v_parent_node_id := null;
    if nullif(r->>'parent_name', '') is not null then
      select id into v_parent_node_id
      from _pankov_node_map
      where plan_source_ref = r->>'plan_source_ref'
        and date = (r->>'date')::date
        and session_order = (r->>'session_order')::numeric
        and node_type = r->>'parent_node_type'
        and name = r->>'parent_name'
        and node_order = (r->>'parent_node_order')::numeric;
    end if;
    insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
    values (v_session_id, v_parent_node_id, r->>'node_type', r->>'name', nullif(r->>'color', ''), nullif(r->>'icon_url', ''),
            nullif(r->>'short_note', ''), nullif(r->>'note', ''), (r->>'node_order')::numeric)
    returning id into v_node_id;
    insert into _pankov_node_map values (r->>'plan_source_ref', (r->>'date')::date, (r->>'session_order')::numeric, r->>'node_type', r->>'name', (r->>'node_order')::numeric, v_node_id);
  end loop;

  for r in select * from jsonb_array_elements(v_items) loop
    select id into v_session_id from _pankov_session_map where plan_source_ref = r->>'plan_source_ref' and date = (r->>'date')::date and session_order = (r->>'session_order')::numeric;
    v_node_id := null;
    if nullif(r->>'node_name', '') is not null then
      select id into v_node_id from _pankov_node_map
      where plan_source_ref = r->>'plan_source_ref'
        and date = (r->>'date')::date
        and session_order = (r->>'session_order')::numeric
        and node_type = r->>'node_type'
        and name = r->>'node_name'
        and node_order = (r->>'node_order')::numeric;
    end if;
    v_exercise_id := null;
    if r->>'item_type' = 'exercise' then
      select id into v_exercise_id from _pankov_exercise_map where key_type = r->>'exercise_key_type' and key = r->>'exercise_key';
      if v_exercise_id is null then
        raise exception 'Pankov package %: could not resolve item exercise %:% row %', v_package_id, r->>'exercise_key_type', r->>'exercise_key', r->>'source_row_ref';
      end if;
    end if;
    insert into plans.plan_items (
      plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url,
      sets, reps, load, item_order, exercise_order, source_row_ref,
      domain_name, category_name, section_name, domain_color, category_color, section_color,
      domain_icon_url, category_icon_url, section_icon_url,
      domain_short_note, category_short_note, section_short_note,
      domain_note, category_note, section_note, domain_order, category_order, section_order
    ) values (
      v_session_id, v_node_id, r->>'item_type', v_exercise_id, nullif(r->>'title', ''), nullif(r->>'description', ''),
      nullif(r->>'short_note', ''), nullif(r->>'note', ''), nullif(r->>'image_url', ''), nullif(r->>'video_url', ''),
      nullif(r->>'sets', ''), nullif(r->>'reps', ''), nullif(r->>'load', ''),
      nullif(r->>'item_order', '')::numeric, nullif(r->>'exercise_order', '')::numeric, nullif(r->>'source_row_ref', ''),
      nullif(r->>'domain_name', ''), nullif(r->>'category_name', ''), nullif(r->>'section_name', ''),
      nullif(r->>'domain_color', ''), nullif(r->>'category_color', ''), nullif(r->>'section_color', ''),
      nullif(r->>'domain_icon_url', ''), nullif(r->>'category_icon_url', ''), nullif(r->>'section_icon_url', ''),
      nullif(r->>'domain_short_note', ''), nullif(r->>'category_short_note', ''), nullif(r->>'section_short_note', ''),
      nullif(r->>'domain_note', ''), nullif(r->>'category_note', ''), nullif(r->>'section_note', ''),
      nullif(r->>'domain_order', '')::numeric, nullif(r->>'category_order', '')::numeric, nullif(r->>'section_order', '')::numeric
    );
  end loop;

  perform public.pankov_seed_validate_package(v_source_type, v_plans, v_expected, v_athlete_id);
end $$;

drop function public.pankov_seed_validate_package(text, jsonb, jsonb, uuid);

commit;
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
