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
       greatest(count(p.id) - count(distinct p.source_ref), 0)::int as duplicate_source_refs
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

function assertCanApply(report) {
  const problems = [];
  if (report.validationProblems.length) problems.push(...report.validationProblems);
  if (report.unresolvedRows.length) problems.push(`unresolved rows: ${report.unresolvedRows.length}`);
  if (report.weeklyConflicts.length) problems.push(`weekly conflicts: ${report.weeklyConflicts.length}`);
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

async function applyPackage(client, manifest, pkg, dryRunReport, customRegistry) {
  assertCanApply(dryRunReport);
  const expectedWeeks = Number(dryRunReport.expectedCounts.weeks || dryRunReport.totals.weeks);
  const changes = {
    customExercisesCreated: [],
    customExercisesExisting: [],
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
    assertCanApply(refreshedDryRun);

    if (refreshedDryRun.existingPackagePlans.length === expectedWeeks) {
      changes.plansExisting = refreshedDryRun.existingPackagePlans;
      await client.query("commit");
      return { ...changes, dbCountsAfterCommit: await packageDbCounts(client, pkg), idempotentSkip: true };
    }

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
      report.apply = await applyPackage(client, manifest, pkg, report, customRegistry);
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
