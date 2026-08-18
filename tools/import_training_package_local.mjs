#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import { createHash } from "crypto";
import {
  assertLocalDatabase,
  Client,
  cleanText,
  DEFAULT_EXCEL_PATH,
  normalize,
  parseArgs,
  readEnvFile,
  readWorkbook,
  safeDbLabel,
  slugify,
  workbookRows,
} from "./training_package_core.mjs";

const SOURCE_TYPE = "multi_athlete_cleaned_import";
const PACKAGE_DATE = "2026-08-18";
const BACKUP_DIR = path.resolve("tools/backups");
const APPROVED_REPLACEMENTS = new Map([
  ["milos-milovic-102-cleaned-2026-08-18|2026-06-08", {
    athleteId: "102",
    weekStart: "2026-06-08",
    planId: "ab3e6829-867f-4354-9e26-17512a708d0c",
    status: "draft",
    sourceType: "xlsx_weekly_import",
    checksum: "289df1b838c057cd4132de68aaea38c34a8ccf4d46c050d2f89b4e5e4e47be69",
  }],
  ["milos-milovic-102-cleaned-2026-08-18|2026-06-15", {
    athleteId: "102",
    weekStart: "2026-06-15",
    planId: "f96a45fc-ef37-479b-b1f5-d41640eb5d0c",
    status: "draft",
    sourceType: "xlsx_weekly_import",
    checksum: "80f3e59e087e8d8da5be36c9666ab9b104f159d58a4a73f96149b5f1bd5e4db7",
  }],
  ["milos-milovic-102-cleaned-2026-08-18|2026-06-22", {
    athleteId: "102",
    weekStart: "2026-06-22",
    planId: "b563a71f-f9e7-4f7d-9f4d-8b6b6dbfcdb8",
    status: "draft",
    sourceType: "xlsx_weekly_import",
    checksum: "c5dc46f7b2ae07fcf311524b5f81ed9a8bd8354d8dbfb0e8e2259740383b6d16",
  }],
  ["nikola-vujinivic-103-cleaned-2026-08-18|2026-05-04", {
    athleteId: "103",
    weekStart: "2026-05-04",
    planId: "1c4a8dc9-4db3-4efa-8a13-029137019929",
    status: "draft",
    sourceType: "xlsx_weekly_import",
    checksum: "3ca5576ccea42a8c2ba0ad6ca3a19fef1158578d87c47298ceef2da56cd8d4c7",
  }],
  ["nikola-vujinivic-103-cleaned-2026-08-18|2026-06-08", {
    athleteId: "103",
    weekStart: "2026-06-08",
    planId: "7879c375-7f52-455b-bf41-806126deec99",
    status: "draft",
    sourceType: "xlsx_weekly_import",
    checksum: "84fc203c52cb3e3c37251fbb08f9cd2f9ecab1155b1a46afa0617bad8d969ff7",
  }],
  ["nikola-petkovic-107-cleaned-2026-08-18|2026-06-08", {
    athleteId: "107",
    weekStart: "2026-06-08",
    planId: "b7a0d4b5-2d53-4510-b1e4-0281a197c7ef",
    status: "draft",
    sourceType: "xlsx_weekly_import",
    checksum: "1ecaf4bd0cb2d936e1b75a87a6d8e89387ca3a7b0bd39e3a0787ba38a96e5fbd",
  }],
]);

function readManifest(filePath) {
  if (!filePath) throw new Error("--manifest <path> is required.");
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function weekName(weekStart) {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(start.getUTCDate())}.${pad(start.getUTCMonth() + 1)}-${pad(end.getUTCDate())}.${pad(end.getUTCMonth() + 1)}.${end.getUTCFullYear()}`;
}

function stableHash(value) {
  return createHash("sha1").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 10);
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function backupChecksum(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function localDateString(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function jsonReady(value, key = "") {
  if (value instanceof Date) {
    if (["week_start", "start_date", "available_until", "date"].includes(key)) return localDateString(value);
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => jsonReady(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, jsonReady(entryValue, entryKey)]));
  }
  return value;
}

function nullish(value) {
  const text = cleanText(value);
  return text || null;
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function sessionSortValue(session) {
  const amPmRank = session.amPm === "AM" ? 1 : session.amPm === "PM" ? 3 : 2;
  const btaRank = session.bta === "B" ? 1 : session.bta === "T" ? 2 : session.bta === "A" ? 3 : 4;
  return [amPmRank, btaRank, session.firstRow];
}

function customContent(row) {
  return {
    name: row.title,
    instruction: row.instruction || row.description || "",
    imageUrl: row.imageUrl || "",
    videoUrl: row.videoUrl || "",
  };
}

function customSlug({ packageId, title, content, shared }) {
  const prefix = shared ? `multi-athlete-cleaned-${PACKAGE_DATE}` : packageId;
  return `${prefix}:custom:${slugify(title).slice(0, 72)}:${stableHash(content)}`;
}

function selectRows(allRows, manifest) {
  const selection = manifest.rowSelection || {};
  const athleteId = String(selection.athleteId || manifest.targetAthlete?.sourceExternalId || "");
  const athleteName = normalize(selection.athlete || manifest.targetAthlete?.expectedNameForAuditOnly || "");
  return allRows.filter((row) => (
    (!selection.sheet || row.sheet === selection.sheet)
    && (!athleteId || row.athleteId === athleteId)
    && (!athleteName || normalize(row.athlete) === athleteName)
  ));
}

async function loadDbIndex(client) {
  const athletes = await client.query(
    `select id, athlete_id, source_external_id, full_name, display_name, user_id, is_active
     from public.athletes`,
  );
  const exercises = await client.query(
    `select id, exercise_code, slug, name, owner_scope, owner_user_id, created_by_user_id, instruction, image_url, video_url, is_active
     from library.exercises
     where coalesce(is_active, true)
     order by created_at, id`,
  );
  const users = await client.query("select id, email, is_active from public.users");
  const exerciseByCode = new Map();
  const exercisesByName = new Map();
  const exerciseBySlug = new Map();
  for (const row of exercises.rows) {
    if (row.exercise_code) exerciseByCode.set(String(row.exercise_code), row);
    if (row.slug) exerciseBySlug.set(row.slug, row);
    const key = normalize(row.name);
    if (!exercisesByName.has(key)) exercisesByName.set(key, []);
    exercisesByName.get(key).push(row);
  }
  return { athletes: athletes.rows, exercises: exercises.rows, exerciseByCode, exercisesByName, exerciseBySlug, users: users.rows };
}

function buildGlobalCustomRegistry(allRows, dbIndex, manifests) {
  const byTitle = new Map();
  for (const manifest of manifests) {
    for (const row of selectRows(allRows, manifest)) {
      if (!row.title || row.exerciseCode) continue;
      const exact = dbIndex.exercisesByName.get(normalize(row.title)) || [];
      if (exact.length === 1) continue;
      const titleKey = normalize(row.title);
      const content = customContent(row);
      const contentKey = stableHash(content);
      if (!byTitle.has(titleKey)) byTitle.set(titleKey, new Map());
      const byContent = byTitle.get(titleKey);
      if (!byContent.has(contentKey)) {
        byContent.set(contentKey, {
          title: row.title,
          content,
          manifests: new Set(),
          sourceRows: [],
          existingCandidates: exact.map((match) => ({ id: match.id, exerciseCode: match.exercise_code, name: match.name })),
        });
      }
      const entry = byContent.get(contentKey);
      entry.manifests.add(manifest.packageId);
      entry.sourceRows.push(row.sourceRow);
    }
  }

  const definitions = [];
  const byRow = new Map();
  for (const byContent of byTitle.values()) {
    for (const entry of byContent.values()) {
      const shared = byContent.size === 1 && entry.manifests.size > 1;
      const packageId = [...entry.manifests].sort()[0];
      const definition = {
        name: entry.title,
        slug: customSlug({ packageId, title: entry.title, content: entry.content, shared }),
        shared,
        packageIds: [...entry.manifests].sort(),
        sourceRows: entry.sourceRows.sort((a, b) => a - b),
        content: entry.content,
        existingCandidates: entry.existingCandidates,
      };
      definitions.push(definition);
      for (const sourceRow of entry.sourceRows) byRow.set(sourceRow, definition);
    }
  }
  return { definitions: definitions.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)), byRow };
}

function resolveAthlete(manifest, dbIndex) {
  const sourceId = String(manifest.targetAthlete?.sourceExternalId || manifest.rowSelection?.athleteId || "");
  const matches = dbIndex.athletes.filter((athlete) => String(athlete.athlete_id || "") === sourceId || String(athlete.source_external_id || "") === sourceId);
  if (matches.length !== 1) throw new Error(`Manifest ${manifest.packageId}: expected exactly one athlete with athlete_id/source_external_id ${sourceId}, found ${matches.length}.`);
  if (matches[0].is_active === false) throw new Error(`Manifest ${manifest.packageId}: athlete ${sourceId} is not active.`);
  return matches[0];
}

function resolveCoach(manifest, dbIndex) {
  const email = String(manifest.ownerCoach || "").toLowerCase();
  const matches = dbIndex.users.filter((user) => String(user.email || "").toLowerCase() === email && user.is_active !== false);
  if (matches.length !== 1) throw new Error(`Manifest ${manifest.packageId}: expected exactly one active owner ${manifest.ownerCoach}, found ${matches.length}.`);
  return matches[0];
}

function resolveExercise(row, dbIndex, customRegistry) {
  if (!row.title) return { status: "note" };
  if (row.exerciseCode) {
    const match = dbIndex.exerciseByCode.get(row.exerciseCode);
    if (!match) return { status: "missing-code", exerciseCode: row.exerciseCode, title: row.title };
    return { status: "code", exerciseId: match.id, exerciseName: match.name, exerciseCode: match.exercise_code };
  }
  const exact = dbIndex.exercisesByName.get(normalize(row.title)) || [];
  if (exact.length === 1) return { status: "exact-title", exerciseId: exact[0].id, exerciseName: exact[0].name, exerciseCode: exact[0].exercise_code };
  const custom = customRegistry.byRow.get(row.sourceRow);
  if (!custom) throw new Error(`No custom definition for unresolved row ${row.sourceRow}: ${row.title}`);
  const existingBySlug = dbIndex.exerciseBySlug.get(custom.slug);
  return {
    status: "custom",
    customSlug: custom.slug,
    customName: custom.name,
    exerciseId: existingBySlug?.id || null,
    reason: exact.length ? "ambiguous-title" : "missing-title",
  };
}

function noteText(row) {
  return row.description || row.raw.program_note || row.raw.section_note || row.raw.category_note || row.raw.domain_note || row.dayNote || row.section || row.category || "Note";
}

function itemDescription(row) {
  return row.description || row.instruction || null;
}

function itemNote(row) {
  const parts = [];
  if (row.instruction && row.instruction !== row.description) parts.push(`instruction: ${row.instruction}`);
  if (row.duration) parts.push(`duration: ${row.duration}`);
  if (row.distance) parts.push(`distance: ${row.distance}`);
  if (row.rest) parts.push(`rest: ${row.rest}`);
  return parts.length ? parts.join("\n") : null;
}

function buildPackage(manifest, selectedRows, dbIndex, customRegistry) {
  const invalidRows = [];
  const plans = new Map();
  for (const row of selectedRows) {
    if (!row.date) invalidRows.push({ row: row.sourceRow, problem: "missing or invalid date", dateText: row.dateText });
    if (row.planType && !["weekly", "program"].includes(row.planType)) {
      invalidRows.push({ row: row.sourceRow, problem: "unsupported plan_type", planType: row.planType });
    }
    if (!row.weekStart) continue;
    if (!plans.has(row.weekStart)) {
      plans.set(row.weekStart, {
        weekStart: row.weekStart,
        sourceRef: `${manifest.packageId}:weekly:${row.weekStart}`,
        name: weekName(row.weekStart),
        rows: [],
        days: new Map(),
      });
    }
    plans.get(row.weekStart).rows.push({ ...row, resolvedExercise: resolveExercise(row, dbIndex, customRegistry) });
  }
  for (const plan of plans.values()) {
    for (const row of plan.rows) {
      if (!plan.days.has(row.date)) plan.days.set(row.date, { date: row.date, dayNote: row.dayNote, rows: [], sessions: new Map() });
      plan.days.get(row.date).rows.push(row);
    }
    for (const day of plan.days.values()) {
      for (const row of day.rows) {
        const key = `${row.amPm || ""}|${row.bta || ""}|${row.dayNote || ""}`;
        if (!day.sessions.has(key)) day.sessions.set(key, { amPm: row.amPm || "", bta: row.bta || "", dayNote: row.dayNote || "", firstRow: row.sourceRow, rows: [] });
        day.sessions.get(key).rows.push(row);
      }
    }
  }
  return { manifest, invalidRows, plans: [...plans.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)) };
}

function planSummary(plan) {
  const sessions = [...plan.days.values()].reduce((sum, day) => sum + day.sessions.size, 0);
  const dbSectionNodes = [...plan.days.values()].reduce((sum, day) => sum + [...day.sessions.values()].reduce((sessionSum, session) => {
    const keys = new Set(session.rows.filter((row) => row.section).map((row) => `${row.category}|${row.section}`));
    return sessionSum + keys.size;
  }, 0), 0);
  const excelSections = new Set(plan.rows.map((row) => `${row.category}|${row.section}`).filter((key) => key !== "|")).size;
  return {
    name: plan.name,
    weekStart: plan.weekStart,
    sourceRef: plan.sourceRef,
    days: plan.days.size,
    sessions,
    excelSections,
    dbSectionNodes,
    exerciseItems: plan.rows.filter((row) => row.title).length,
    noteItems: plan.rows.filter((row) => !row.title).length,
    sourceRows: plan.rows.length,
  };
}

function totals(pkg) {
  const summaries = pkg.plans.map(planSummary);
  return {
    weeks: summaries.length,
    days: summaries.reduce((sum, plan) => sum + plan.days, 0),
    sessions: summaries.reduce((sum, plan) => sum + plan.sessions, 0),
    excelSections: summaries.reduce((sum, plan) => sum + plan.excelSections, 0),
    dbSectionNodes: summaries.reduce((sum, plan) => sum + plan.dbSectionNodes, 0),
    exerciseItems: summaries.reduce((sum, plan) => sum + plan.exerciseItems, 0),
    noteItems: summaries.reduce((sum, plan) => sum + plan.noteItems, 0),
    totalItems: summaries.reduce((sum, plan) => sum + plan.exerciseItems + plan.noteItems, 0),
  };
}

function exerciseMappingSummary(pkg) {
  const counts = { code: 0, "exact-title": 0, custom: 0, note: 0, "missing-code": 0 };
  for (const plan of pkg.plans) {
    for (const row of plan.rows) counts[row.resolvedExercise.status] = (counts[row.resolvedExercise.status] || 0) + 1;
  }
  return counts;
}

function validateManifestCounts(pkg) {
  const actual = totals(pkg);
  const expected = pkg.manifest.expectedCounts || {};
  const problems = [];
  const compare = { rows: actual.totalItems, weeks: actual.weeks, days: actual.days, sessions: actual.sessions, exerciseItems: actual.exerciseItems, noteItems: actual.noteItems };
  for (const [key, actualValue] of Object.entries(compare)) {
    if (expected[key] !== undefined && Number(expected[key]) !== Number(actualValue)) problems.push(`${key}: expected ${expected[key]}, found ${actualValue}`);
  }
  return { actual, expected, problems };
}

async function localConflicts(client, pkg, athleteId) {
  const conflicts = [];
  for (const plan of pkg.plans) {
    const existing = await client.query(
      `select id, name, plan_type, week_start, status, source_type, source_ref, is_active, is_edit_draft,
              (select count(*)::int from plans.plan_days pd where pd.plan_id = p.id) as days,
              (select count(*)::int from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id) as sessions,
              (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id) as items
       from plans.plans p
       where p.athlete_id = $1
         and p.plan_type = 'weekly'
         and p.week_start = $2::date
         and coalesce(p.is_active, true)
         and not coalesce(p.is_edit_draft, false)
         and not (p.source_type = $3 and p.source_ref = $4)
       order by created_at`,
      [athleteId, plan.weekStart, SOURCE_TYPE, plan.sourceRef],
    );
    if (existing.rows.length) conflicts.push({ incoming: planSummary(plan), existing: existing.rows });
  }
  return conflicts;
}

async function packagePlans(client, pkg) {
  const refs = pkg.plans.map((plan) => plan.sourceRef);
  if (!refs.length) return [];
  const result = await client.query(
    `select id, name, week_start, status, source_type, source_ref
     from plans.plans
     where source_type = $1 and source_ref = any($2::text[])
     order by week_start`,
    [SOURCE_TYPE, refs],
  );
  return result.rows;
}

async function packageDbCounts(client, pkg) {
  const refs = pkg.plans.map((plan) => plan.sourceRef);
  if (!refs.length) return { weeks: 0, days: 0, sessions: 0, dbSectionNodes: 0, exerciseItems: 0, noteItems: 0, totalItems: 0, orphanItems: 0, invalidExerciseRefs: 0, duplicateSourceRefs: 0 };
  const result = await client.query(
    `select
       count(distinct p.id)::int as weeks,
       count(distinct pd.id)::int as days,
       count(distinct ps.id)::int as sessions,
       count(distinct pn.id) filter (where pn.node_type = 'section')::int as db_section_nodes,
       count(distinct pi.id) filter (where pi.item_type = 'exercise')::int as exercise_items,
       count(distinct pi.id) filter (where pi.item_type = 'note')::int as note_items,
       count(distinct pi.id)::int as total_items,
       count(distinct pi.id) filter (where pi.plan_session_id is null)::int as orphan_items,
       count(distinct pi.id) filter (where pi.item_type = 'exercise' and pi.exercise_id is null)::int as invalid_exercise_refs,
       (select coalesce(sum(ref_count - 1), 0)::int
        from (
          select source_ref, count(*)::int as ref_count
          from plans.plans
          where source_type = $1 and source_ref = any($2::text[])
          group by source_ref
          having count(*) > 1
        ) duplicates) as duplicate_source_refs
     from plans.plans p
     left join plans.plan_days pd on pd.plan_id = p.id
     left join plans.plan_sessions ps on ps.plan_day_id = pd.id
     left join plans.plan_nodes pn on pn.plan_session_id = ps.id
     left join plans.plan_items pi on pi.plan_session_id = ps.id
     where p.source_type = $1 and p.source_ref = any($2::text[])`,
    [SOURCE_TYPE, refs],
  );
  const row = result.rows[0];
  return {
    weeks: Number(row.weeks),
    days: Number(row.days),
    sessions: Number(row.sessions),
    dbSectionNodes: Number(row.db_section_nodes),
    exerciseItems: Number(row.exercise_items),
    noteItems: Number(row.note_items),
    totalItems: Number(row.total_items),
    orphanItems: Number(row.orphan_items),
    invalidExerciseRefs: Number(row.invalid_exercise_refs),
    duplicateSourceRefs: Number(row.duplicate_source_refs),
  };
}

async function tableExists(client, regclass) {
  const result = await client.query("select to_regclass($1) as table_name", [regclass]);
  return Boolean(result.rows[0]?.table_name);
}

async function queryRows(client, sql, params = []) {
  return (await client.query(sql, params)).rows;
}

async function normalizeExistingPlan(client, planId) {
  const items = await client.query(
    `select pd.date::date::text as date, pd.day_note,
            ps.session_order, ps.am_pm, ps.bta,
            pn.node_type, pn.name as node_name, pn.node_order,
            parent.node_type as parent_node_type, parent.name as parent_node_name,
            pi.item_type, pi.title, pi.description, pi.note, pi.image_url, pi.video_url,
            pi.sets, pi.reps, pi.load, pi.item_order, pi.exercise_order,
            pi.domain_name, pi.category_name, pi.section_name,
            e.exercise_code, e.name as exercise_name, e.slug as exercise_slug
     from plans.plan_items pi
     join plans.plan_sessions ps on ps.id = pi.plan_session_id
     join plans.plan_days pd on pd.id = ps.plan_day_id
     left join plans.plan_nodes pn on pn.id = pi.plan_node_id
     left join plans.plan_nodes parent on parent.id = pn.parent_id
     left join library.exercises e on e.id = pi.exercise_id
     where pd.plan_id = $1
     order by pd.date, ps.session_order nulls last, ps.am_pm, ps.bta, pn.node_order nulls last, pi.item_order nulls last, pi.created_at`,
    [planId],
  );
  const normalizedItems = items.rows.map((row) => ({
    date: row.date,
    dayNote: nullish(row.day_note),
    session: {
      amPm: nullish(row.am_pm),
      bta: nullish(row.bta),
    },
    sectionPath: {
      domain: nullish(row.domain_name),
      category: nullish(row.category_name || (row.parent_node_type === "category" ? row.parent_node_name : null)),
      section: nullish(row.section_name || (row.node_type === "section" ? row.node_name : null)),
    },
    itemType: row.item_type,
    title: nullish(row.title),
    description: nullish(row.description),
    note: nullish(row.note),
    media: {
      imageUrl: nullish(row.image_url),
      videoUrl: nullish(row.video_url),
    },
    dose: {
      sets: nullish(row.sets),
      reps: nullish(row.reps),
      load: nullish(row.load),
    },
    order: {
      itemOrder: row.item_order === null ? null : Number(row.item_order),
      exerciseOrder: row.exercise_order === null ? null : Number(row.exercise_order),
      categoryOrder: null,
      sectionOrder: null,
    },
    exercise: row.item_type === "exercise" ? {
      keyType: row.exercise_code ? "code" : "title",
      key: row.exercise_code ? String(row.exercise_code) : normalize(row.exercise_name || row.title),
      expectedName: row.exercise_name || row.title,
      slug: row.exercise_slug || null,
    } : null,
  }));
  const days = new Set(normalizedItems.map((item) => item.date));
  const sessions = new Set(normalizedItems.map((item) => `${item.date}|${item.session.amPm || ""}|${item.session.bta || ""}`));
  const sections = new Set(normalizedItems.map((item) => `${item.date}|${item.session.amPm || ""}|${item.session.bta || ""}|${item.sectionPath.category || ""}|${item.sectionPath.section || ""}`).filter((key) => !key.endsWith("||")));
  return {
    counts: {
      days: days.size,
      sessions: sessions.size,
      sections: sections.size,
      exerciseItems: normalizedItems.filter((item) => item.itemType === "exercise").length,
      noteItems: normalizedItems.filter((item) => item.itemType === "note").length,
      totalItems: normalizedItems.length,
    },
    items: normalizedItems,
  };
}

async function loadPlanBackupPayload(client, planId, guard, normalizedChecksum) {
  const planRows = await queryRows(client, "select * from plans.plans where id = $1", [planId]);
  const days = await queryRows(client, "select * from plans.plan_days where plan_id = $1 order by block_order nulls last, block_index, day_order, created_at", [planId]);
  const sessions = await queryRows(client, "select ps.* from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 order by pd.block_order nulls last, pd.block_index, ps.session_order nulls last, ps.created_at", [planId]);
  const nodes = await queryRows(client, "select pn.* from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 order by ps.session_order nulls last, pn.node_order nulls last, pn.created_at", [planId]);
  const items = await queryRows(client, "select pi.* from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 order by ps.session_order nulls last, pi.item_order nulls last, pi.created_at", [planId]);
  const itemExerciseRefs = await queryRows(
    client,
    `select pi.id as plan_item_id, pi.exercise_id, e.exercise_code, e.slug, e.name
     from plans.plan_items pi
     join plans.plan_sessions ps on ps.id = pi.plan_session_id
     join plans.plan_days pd on pd.id = ps.plan_day_id
     left join library.exercises e on e.id = pi.exercise_id
     where pd.plan_id = $1
     order by ps.session_order nulls last, pi.item_order nulls last, pi.created_at`,
    [planId],
  );
  const programTags = await queryRows(client, "select * from library.program_tags where plan_id = $1 order by created_at, tag_id", [planId]);
  const editDrafts = await queryRows(client, "select * from plans.plans where edit_source_plan_id = $1 order by created_at", [planId]);
  const optionalTables = {};
  for (const tableName of ["library.program_reviews", "library.program_access", "library.program_usage_events", "reviews.plan_reviews", "reviews.plan_comments"]) {
    if (!(await tableExists(client, tableName))) {
      optionalTables[tableName] = { tableMissing: true };
      continue;
    }
    if (tableName === "library.program_access") {
      optionalTables[tableName] = await queryRows(client, "select * from library.program_access where plan_id = $1 or related_plan_id = $1 order by created_at", [planId]);
    } else if (tableName === "library.program_usage_events") {
      optionalTables[tableName] = await queryRows(
        client,
        `select pue.*
         from library.program_usage_events pue
         join library.program_access pa on pa.id = pue.program_access_id
         where pa.plan_id = $1 or pa.related_plan_id = $1
         order by pue.created_at`,
        [planId],
      );
    } else {
      optionalTables[tableName] = await queryRows(client, `select * from ${tableName} where plan_id = $1 order by created_at`, [planId]);
    }
  }
  const payload = jsonReady({
    backupFormat: "optimove-plan-backup/v1",
    packageId: "multi-athlete-cleaned-2026-08-18",
    exportedAt: new Date().toISOString(),
    originalPlanUuid: planId,
    normalizedChecksum,
    expectedGuard: guard,
    tables: {
      "plans.plans": planRows,
      "plans.plan_days": days,
      "plans.plan_sessions": sessions,
      "plans.plan_nodes": nodes,
      "plans.plan_items": items,
      "plans.plan_items.exercise_refs": itemExerciseRefs,
      "library.program_tags": programTags,
      "plans.plans.edit_drafts": editDrafts,
      ...optionalTables,
    },
    counts: {
      plans: planRows.length,
      days: days.length,
      sessions: sessions.length,
      nodes: nodes.length,
      items: items.length,
      exerciseItems: items.filter((row) => row.item_type === "exercise").length,
      noteItems: items.filter((row) => row.item_type === "note").length,
      programTags: programTags.length,
      editDrafts: editDrafts.length,
      programAccess: Array.isArray(optionalTables["library.program_access"]) ? optionalTables["library.program_access"].length : null,
      programUsageEvents: Array.isArray(optionalTables["library.program_usage_events"]) ? optionalTables["library.program_usage_events"].length : null,
    },
  });
  return { ...payload, sha256: backupChecksum(payload) };
}

function writePlanBackup(backup) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const safeWeek = backup.expectedGuard.weekStart;
  const outputPath = path.join(BACKUP_DIR, `multi-athlete-conflict-plan-${backup.originalPlanUuid}-${safeWeek}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
  return outputPath;
}

async function deletePlanTree(client, planId) {
  if (await tableExists(client, "library.program_usage_events")) {
    await client.query(
      `delete from library.program_usage_events pue
       using library.program_access pa
       where pue.program_access_id = pa.id and (pa.plan_id = $1 or pa.related_plan_id = $1)`,
      [planId],
    );
  }
  await client.query("delete from library.program_tags where plan_id = $1", [planId]);
  if (await tableExists(client, "library.program_reviews")) await client.query("delete from library.program_reviews where plan_id = $1", [planId]);
  if (await tableExists(client, "library.program_access")) await client.query("delete from library.program_access where plan_id = $1 or related_plan_id = $1", [planId]);
  if (await tableExists(client, "reviews.plan_reviews")) await client.query("delete from reviews.plan_reviews where plan_id = $1", [planId]);
  if (await tableExists(client, "reviews.plan_comments")) await client.query("delete from reviews.plan_comments where plan_id = $1", [planId]);
  await client.query("delete from plans.plan_items pi using plans.plan_sessions ps, plans.plan_days pd where pi.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = $1", [planId]);
  await client.query("delete from plans.plan_nodes pn using plans.plan_sessions ps, plans.plan_days pd where pn.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = $1", [planId]);
  await client.query("delete from plans.plan_sessions ps using plans.plan_days pd where ps.plan_day_id = pd.id and pd.plan_id = $1", [planId]);
  await client.query("delete from plans.plan_days where plan_id = $1", [planId]);
  await client.query("delete from plans.plans where id = $1", [planId]);
}

function approvedReplacementFor(manifest, conflict) {
  const key = `${manifest.packageId}|${conflict.incoming.weekStart}`;
  const guard = APPROVED_REPLACEMENTS.get(key);
  if (!guard) return null;
  const matches = conflict.existing.filter((row) => row.id === guard.planId);
  if (matches.length !== 1 || conflict.existing.length !== 1) return null;
  return guard;
}

function approvedConflicts(report, manifest, allowReplacement) {
  if (!allowReplacement) return [];
  const approved = [];
  for (const conflict of report.weeklyConflicts) {
    const guard = approvedReplacementFor(manifest, conflict);
    if (guard) approved.push({ conflict, guard });
  }
  return approved;
}

async function dryRun(client, manifest, pkg, dbIndex, customRegistry) {
  const athlete = resolveAthlete(manifest, dbIndex);
  const coach = resolveCoach(manifest, dbIndex);
  const validation = validateManifestCounts(pkg);
  const conflicts = await localConflicts(client, pkg, athlete.id);
  const existingPlans = await packagePlans(client, pkg);
  const customsForPackage = customRegistry.definitions.filter((custom) => custom.packageIds.includes(manifest.packageId));
  return {
    mode: "dry-run",
    packageId: manifest.packageId,
    sourceType: SOURCE_TYPE,
    athlete: {
      uuid: athlete.id,
      athleteId: athlete.athlete_id,
      sourceExternalId: athlete.source_external_id,
      displayName: athlete.display_name || athlete.full_name,
      isActive: athlete.is_active,
      hasUser: Boolean(athlete.user_id),
    },
    owner: { email: manifest.ownerCoach, userId: coach.id, ownerScope: "user" },
    status: manifest.defaultStatus || "draft",
    totals: validation.actual,
    expectedCounts: validation.expected,
    validationProblems: validation.problems,
    planSummaries: pkg.plans.map(planSummary),
    exerciseMapping: exerciseMappingSummary(pkg),
    customDefinitions: customsForPackage.map((custom) => ({
      name: custom.name,
      slug: custom.slug,
      shared: custom.shared,
      usage: custom.sourceRows.length,
      packageIds: custom.packageIds,
    })),
    unresolvedRows: pkg.invalidRows,
    weeklyConflicts: conflicts,
    existingPackagePlans: existingPlans,
    dbCounts: await packageDbCounts(client, pkg),
  };
}

function assertCanApply(report, manifest, options = {}) {
  const problems = [];
  if (report.validationProblems.length) problems.push(...report.validationProblems);
  if (report.unresolvedRows.length) problems.push(`unresolved rows: ${report.unresolvedRows.length}`);
  const approved = approvedConflicts(report, manifest, options.replaceApprovedConflicts);
  if (report.weeklyConflicts.length !== approved.length) problems.push(`weekly conflicts: ${report.weeklyConflicts.length}, approved for replacement: ${approved.length}`);
  if (report.exerciseMapping["missing-code"]) problems.push(`missing exercise codes: ${report.exerciseMapping["missing-code"]}`);
  const expectedWeeks = Number(report.expectedCounts.weeks || report.totals.weeks);
  if (report.existingPackagePlans.length && report.existingPackagePlans.length !== expectedWeeks) {
    problems.push(`partial package exists: ${report.existingPackagePlans.length}/${expectedWeeks} plans`);
  }
  if (problems.length) throw new Error(`Refusing --apply-local for ${report.packageId}: ${problems.join("; ")}`);
}

async function ensureCustomExercises(client, customDefinitions, coachId) {
  const changes = { created: [], existing: [] };
  for (const custom of customDefinitions) {
    const existing = await client.query(
      `select id, name, slug, owner_scope, owner_user_id
       from library.exercises
       where exercise_code is null and slug = $1
       for update`,
      [custom.slug],
    );
    if (existing.rowCount > 1) throw new Error(`Custom exercise slug ${custom.slug} is not unique.`);
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (row.name !== custom.name || row.owner_scope !== "user" || String(row.owner_user_id) !== String(coachId)) {
        throw new Error(`Existing custom exercise ${custom.slug} does not match expected name/owner.`);
      }
      changes.existing.push({ id: row.id, name: row.name, slug: row.slug });
      continue;
    }
    const inserted = await client.query(
      `insert into library.exercises (
         owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name, instruction, image_url, video_url, is_active
       ) values ('user', $1, $1, null, $2, $3, $4, $5, $6, true)
       returning id, name, slug`,
      [coachId, custom.slug, custom.name, cleanText(custom.content.instruction) || null, cleanText(custom.content.imageUrl) || null, cleanText(custom.content.videoUrl) || null],
    );
    changes.created.push(inserted.rows[0]);
  }
  return changes;
}

async function replaceApprovedConflicts(client, manifest, refreshedDryRun, athlete) {
  const approved = approvedConflicts(refreshedDryRun, manifest, true);
  const replacements = [];
  for (const { conflict, guard } of approved) {
    const locked = await client.query(
      `select p.id, p.name, p.status, p.source_type, p.source_ref, p.week_start::date::text as week_start,
              a.athlete_id, a.source_external_id
       from plans.plans p
       join public.athletes a on a.id = p.athlete_id
       where p.id = $1
       for update`,
      [guard.planId],
    );
    if (locked.rowCount !== 1) throw new Error(`Approved replacement guard failed: plan ${guard.planId} was not found.`);
    const plan = locked.rows[0];
    const foundAthleteIds = [plan.athlete_id, plan.source_external_id].filter((value) => value !== null && value !== undefined).map(String);
    const problems = [];
    if (!foundAthleteIds.includes(String(guard.athleteId))) problems.push(`athlete expected ${guard.athleteId}, found athlete_id/source_external_id ${foundAthleteIds.join("/")}`);
    if (String(athlete.id) !== String(conflict.existing[0].athlete_id || athlete.id)) problems.push("athlete UUID changed during replacement check");
    if (plan.week_start !== guard.weekStart) problems.push(`week_start expected ${guard.weekStart}, found ${plan.week_start}`);
    if (plan.status !== guard.status) problems.push(`status expected ${guard.status}, found ${plan.status}`);
    if (plan.source_type !== guard.sourceType) problems.push(`source_type expected ${guard.sourceType}, found ${plan.source_type}`);
    if (problems.length) throw new Error(`Approved replacement guard failed for ${guard.planId}: ${problems.join("; ")}`);

    const normalized = await normalizeExistingPlan(client, guard.planId);
    const normalizedChecksum = sha256(normalized);
    if (normalizedChecksum !== guard.checksum) {
      throw new Error(`Approved replacement checksum failed for ${guard.planId}: expected ${guard.checksum}, found ${normalizedChecksum}`);
    }
    const backup = await loadPlanBackupPayload(client, guard.planId, guard, normalizedChecksum);
    const backupPath = writePlanBackup(backup);
    await deletePlanTree(client, guard.planId);
    replacements.push({
      packageId: manifest.packageId,
      weekStart: guard.weekStart,
      oldPlanId: guard.planId,
      oldPlanName: plan.name,
      normalizedChecksum,
      backupPath,
      backupSha256: backup.sha256,
      incomingSourceRef: conflict.incoming.sourceRef,
    });
  }
  return replacements;
}

async function applyPackage(client, manifest, pkg, dryRunReport, customRegistry, options = {}) {
  assertCanApply(dryRunReport, manifest, options);
  const expectedWeeks = Number(dryRunReport.expectedCounts.weeks || dryRunReport.totals.weeks);
  const changes = {
    customExercisesCreated: [],
    customExercisesExisting: [],
    replacedConflicts: [],
    plansInserted: [],
    plansExisting: [],
    daysInserted: 0,
    sessionsInserted: 0,
    categoryNodesInserted: 0,
    sectionNodesInserted: 0,
    exerciseItemsInserted: 0,
    noteItemsInserted: 0,
  };

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`training-package:${manifest.packageId}`]);
    const dbIndex = await loadDbIndex(client);
    const athlete = resolveAthlete(manifest, dbIndex);
    const coach = resolveCoach(manifest, dbIndex);
    const refreshedDryRun = await dryRun(client, manifest, pkg, dbIndex, customRegistry);
    assertCanApply(refreshedDryRun, manifest, options);

    if (refreshedDryRun.existingPackagePlans.length === expectedWeeks) {
      changes.plansExisting = refreshedDryRun.existingPackagePlans;
      await client.query("commit");
      return { ...changes, dbCountsAfterCommit: await packageDbCounts(client, pkg), idempotentSkip: true };
    }

    if (options.replaceApprovedConflicts && refreshedDryRun.weeklyConflicts.length) {
      changes.replacedConflicts = await replaceApprovedConflicts(client, manifest, refreshedDryRun, athlete);
    }

    const afterReplacementDryRun = await dryRun(client, manifest, pkg, await loadDbIndex(client), customRegistry);
    assertCanApply(afterReplacementDryRun, manifest, { replaceApprovedConflicts: false });

    const customForPackage = customRegistry.definitions.filter((custom) => custom.packageIds.includes(manifest.packageId));
    const customChanges = await ensureCustomExercises(client, customForPackage, coach.id);
    changes.customExercisesCreated = customChanges.created;
    changes.customExercisesExisting = customChanges.existing;
    const activeDbIndex = await loadDbIndex(client);

    for (const plan of pkg.plans) {
      const existing = await client.query("select id, name from plans.plans where source_type = $1 and source_ref = $2 limit 1", [SOURCE_TYPE, plan.sourceRef]);
      if (existing.rows[0]) {
        changes.plansExisting.push({ id: existing.rows[0].id, name: existing.rows[0].name, sourceRef: plan.sourceRef });
        continue;
      }
      const insertedPlan = await client.query(
        `insert into plans.plans (
           plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, week_start, start_date, duration_days,
           program_order, status, source_type, source_ref, source_external_id, is_template, visibility, library_scope,
           owner_type, access_model, can_copy, can_edit_copy, can_assign_to_athlete, athlete_can_view_directly,
           requires_approval, is_active
         ) values (
           'weekly', $1, $2, $3, $4, $5, null, $6::date, null, $7, null,
           'draft', $8, $9, $10, false, 'private', 'my',
           'coach', 'free_forever', true, true, true, false, false, true
         )
         returning id`,
        [
          coach.id,
          athlete.id,
          plan.name,
          plan.rows.find((row) => row.raw.program_note)?.raw.program_note || null,
          plan.rows.find((row) => row.raw.program_icon_url)?.raw.program_icon_url || null,
          plan.weekStart,
          manifest.expectedCounts?.programDurationDays || null,
          SOURCE_TYPE,
          plan.sourceRef,
          manifest.targetAthlete.sourceExternalId,
        ],
      );
      const planId = insertedPlan.rows[0].id;
      changes.plansInserted.push({ id: planId, name: plan.name, weekStart: plan.weekStart, sourceRef: plan.sourceRef });

      for (const day of [...plan.days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
        const dayOrder = new Date(`${day.date}T00:00:00Z`).getUTCDay() || 7;
        const insertedDay = await client.query(
          `insert into plans.plan_days (plan_id, date, day_note, day_order, source_row_ref, block_index, block_name, block_type, block_order)
           values ($1, $2::date, $3, $4::numeric, $5, $4::integer, $3, 'session', $4::numeric)
           returning id`,
          [planId, day.date, day.dayNote || null, dayOrder, Math.min(...day.rows.map((row) => row.sourceRow)).toString()],
        );
        changes.daysInserted += 1;

        const sortedSessions = [...day.sessions.values()].sort((a, b) => compareTuple(sessionSortValue(a), sessionSortValue(b)));
        for (let sessionIndex = 0; sessionIndex < sortedSessions.length; sessionIndex += 1) {
          const session = sortedSessions[sessionIndex];
          const insertedSession = await client.query(
            "insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, $2, $3, $4) returning id",
            [insertedDay.rows[0].id, session.amPm || null, session.bta || null, sessionIndex + 1],
          );
          const sessionId = insertedSession.rows[0].id;
          changes.sessionsInserted += 1;
          const nodeMap = new Map();
          const sortedRows = [...session.rows].sort((a, b) => compareTuple(
            [a.categoryOrder ?? 999999, a.sectionOrder ?? 999999, a.exerciseOrder ?? a.order ?? 999999, a.sourceRow],
            [b.categoryOrder ?? 999999, b.sectionOrder ?? 999999, b.exerciseOrder ?? b.order ?? 999999, b.sourceRow],
          ));
          for (const row of sortedRows) {
            let parentId = null;
            if (row.category) {
              const key = `category:${row.category}`;
              if (!nodeMap.has(key)) {
                const insertedNode = await client.query(
                  `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
                   values ($1, null, 'category', $2, $3, $4, $5, $6, $7) returning id`,
                  [sessionId, row.category, row.raw.category_color || null, row.raw.category_icon_url || null, row.raw.category_short_note || null, row.raw.category_note || null, row.categoryOrder ?? nodeMap.size + 1],
                );
                nodeMap.set(key, insertedNode.rows[0].id);
                changes.categoryNodesInserted += 1;
              }
              parentId = nodeMap.get(key);
            }
            if (row.section) {
              const key = `section:${row.category}|${row.section}`;
              if (!nodeMap.has(key)) {
                const insertedNode = await client.query(
                  `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
                   values ($1, $2, 'section', $3, $4, $5, $6, $7, $8) returning id`,
                  [sessionId, parentId, row.section, row.raw.section_color || null, row.raw.section_icon_url || null, row.raw.section_short_note || null, row.raw.section_note || null, row.sectionOrder ?? nodeMap.size + 1],
                );
                nodeMap.set(key, insertedNode.rows[0].id);
                changes.sectionNodesInserted += 1;
              }
              parentId = nodeMap.get(key);
            }

            let exerciseId = null;
            let itemType = "note";
            let title = noteText(row);
            let description = noteText(row);
            let note = noteText(row);
            if (row.title) {
              itemType = "exercise";
              title = row.title;
              description = itemDescription(row);
              note = itemNote(row);
              const resolved = resolveExercise(row, activeDbIndex, customRegistry);
              if (resolved.status === "code" || resolved.status === "exact-title") exerciseId = resolved.exerciseId;
              else if (resolved.status === "custom") exerciseId = activeDbIndex.exerciseBySlug.get(resolved.customSlug)?.id;
              if (!exerciseId) throw new Error(`Could not resolve exercise for row ${row.sourceRow}: ${row.title}`);
            }

            await client.query(
              `insert into plans.plan_items (
                 plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url,
                 sets, reps, load, item_order, exercise_order, source_row_ref,
                 domain_name, category_name, section_name, domain_color, category_color, section_color,
                 domain_icon_url, category_icon_url, section_icon_url,
                 domain_short_note, category_short_note, section_short_note,
                 domain_note, category_note, section_note, domain_order, category_order, section_order
               ) values (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
               )`,
              [
                sessionId, parentId, itemType, exerciseId, title, description, row.raw.category_short_note || row.raw.section_short_note || null, note,
                row.imageUrl || null, row.videoUrl || null, row.sets || null, row.reps || null, row.load || null,
                row.order ?? row.exerciseOrder ?? row.sourceRow, row.exerciseOrder, row.sourceRow.toString(),
                row.domain || null, row.category || null, row.section || null,
                row.raw.domain_color || null, row.raw.category_color || null, row.raw.section_color || null,
                row.raw.domain_icon_url || null, row.raw.category_icon_url || null, row.raw.section_icon_url || null,
                row.raw.domain_short_note || null, row.raw.category_short_note || null, row.raw.section_short_note || null,
                row.raw.domain_note || null, row.raw.category_note || null, row.raw.section_note || null,
                row.domainOrder, row.categoryOrder, row.sectionOrder,
              ],
            );
            if (itemType === "exercise") changes.exerciseItemsInserted += 1;
            else changes.noteItemsInserted += 1;
          }
        }
      }
    }

    const found = await packageDbCounts(client, pkg);
    const expected = totals(pkg);
    const problems = [];
    for (const key of ["weeks", "days", "sessions", "dbSectionNodes", "exerciseItems", "noteItems", "totalItems"]) {
      if (found[key] !== expected[key]) problems.push(`${key}: expected ${expected[key]}, found ${found[key]}`);
    }
    if (found.orphanItems !== 0) problems.push(`orphanItems: ${found.orphanItems}`);
    if (found.invalidExerciseRefs !== 0) problems.push(`invalidExerciseRefs: ${found.invalidExerciseRefs}`);
    if (found.duplicateSourceRefs !== 0) problems.push(`duplicateSourceRefs: ${found.duplicateSourceRefs}`);
    if (problems.length) throw new Error(`Post-insert validation failed for ${manifest.packageId}: ${problems.join("; ")}`);

    await client.query("commit");
    return { ...changes, dbCountsAfterCommit: found, idempotentSkip: false };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifest);
  const workbookPath = path.resolve(args.excel || args.workbook || manifest.excelPath || DEFAULT_EXCEL_PATH);
  const env = readEnvFile();
  const databaseUrl = args.databaseUrl || process.env.LOCAL_DATABASE_URL || env.DATABASE_URL || "";
  assertLocalDatabase(databaseUrl);

  const manifestDir = path.dirname(path.resolve(args.manifest));
  const registryManifests = manifest.registryManifestPaths
    ? manifest.registryManifestPaths.map((manifestPath) => readManifest(path.resolve(manifestDir, manifestPath)))
    : [manifest];
  const sheets = readWorkbook(workbookPath);
  const { rows, sheetReports } = workbookRows(sheets);
  const selectedRows = selectRows(rows, manifest);
  if (!selectedRows.length) throw new Error(`Manifest ${manifest.packageId}: selected 0 workbook rows.`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  client.safeLabel = safeDbLabel(databaseUrl);
  try {
    const dbIndex = await loadDbIndex(client);
    const customRegistry = buildGlobalCustomRegistry(rows, dbIndex, registryManifests);
    const pkg = buildPackage(manifest, selectedRows, dbIndex, customRegistry);
    const report = await dryRun(client, manifest, pkg, dbIndex, customRegistry);
    report.connection = client.safeLabel;
    report.workbook = { path: workbookPath, sheets: sheetReports };
    if (args.applyLocal) {
      report.mode = "apply-local";
      report.replaceApprovedConflicts = args.replaceApprovedConflicts !== undefined;
      report.apply = await applyPackage(client, manifest, pkg, report, customRegistry, {
        replaceApprovedConflicts: args.replaceApprovedConflicts !== undefined,
      });
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
