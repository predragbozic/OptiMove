#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import { createHash } from "crypto";
import {
  Client,
  cleanText,
  normalize,
  readEnvFile,
  readWorkbook,
  safeDbLabel,
  workbookRows,
} from "./training_package_core.mjs";

const SOURCE_TYPE = "multi_athlete_cleaned_import";
const MANIFESTS = [
  "milos-milovic-102-cleaned-2026-08-18.json",
  "nikola-vujinivic-103-cleaned-2026-08-18.json",
  "nikola-petkovic-107-cleaned-2026-08-18.json",
  "zija-murina-131-cleaned-2026-08-18.json",
];
const TARGET_WEEKS = new Map([
  ["102", new Set(["2026-06-08", "2026-06-15", "2026-06-22"])],
  ["103", new Set(["2026-05-04", "2026-06-08"])],
  ["107", new Set(["2026-06-08"])],
]);

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function nullish(value) {
  const text = cleanText(value);
  return text || null;
}

function readManifest(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function weekName(weekStart) {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(start.getUTCDate())}.${pad(start.getUTCMonth() + 1)}-${pad(end.getUTCDate())}.${pad(end.getUTCMonth() + 1)}.${end.getUTCFullYear()}`;
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function normalizeNewPlan(manifest, rows, weekStart) {
  const weekRows = rows.filter((row) => row.weekStart === weekStart);
  const items = weekRows
    .map((row) => ({
      date: row.date,
      dayNote: nullish(row.dayNote),
      session: {
        amPm: nullish(row.amPm),
        bta: nullish(row.bta),
      },
      sectionPath: {
        domain: nullish(row.domain),
        category: nullish(row.category),
        section: nullish(row.section),
      },
      itemType: row.title ? "exercise" : "note",
      title: nullish(row.title || row.description || row.raw.program_note || row.raw.section_note || row.section || row.category || row.dayNote || "Note"),
      description: nullish(row.title ? (row.description || row.instruction) : (row.description || row.raw.program_note || row.raw.section_note || row.dayNote)),
      note: nullish(row.title ? [row.instruction && row.instruction !== row.description ? `instruction: ${row.instruction}` : "", row.duration ? `duration: ${row.duration}` : "", row.distance ? `distance: ${row.distance}` : "", row.rest ? `rest: ${row.rest}` : ""].filter(Boolean).join("\n") : (row.description || row.raw.program_note || row.raw.section_note || row.dayNote)),
      media: {
        imageUrl: nullish(row.imageUrl),
        videoUrl: nullish(row.videoUrl),
      },
      dose: {
        sets: nullish(row.sets),
        reps: nullish(row.reps),
        load: nullish(row.load),
      },
      order: {
        itemOrder: row.order ?? row.exerciseOrder ?? row.sourceRow,
        exerciseOrder: row.exerciseOrder ?? null,
        categoryOrder: row.categoryOrder ?? null,
        sectionOrder: row.sectionOrder ?? null,
      },
      exercise: row.title ? {
        keyType: row.exerciseCode ? "code" : "title",
        key: row.exerciseCode || normalize(row.title),
        expectedName: row.title,
      } : null,
    }))
    .sort((a, b) => compareTuple(
      [a.date, a.session.amPm || "", a.session.bta || "", a.order.categoryOrder ?? 999999, a.order.sectionOrder ?? 999999, a.order.exerciseOrder ?? a.order.itemOrder ?? 999999, a.title || ""],
      [b.date, b.session.amPm || "", b.session.bta || "", b.order.categoryOrder ?? 999999, b.order.sectionOrder ?? 999999, b.order.exerciseOrder ?? b.order.itemOrder ?? 999999, b.title || ""],
    ));
  const days = new Set(items.map((item) => item.date));
  const sessions = new Set(items.map((item) => `${item.date}|${item.session.amPm || ""}|${item.session.bta || ""}`));
  const sections = new Set(items.map((item) => `${item.date}|${item.session.amPm || ""}|${item.session.bta || ""}|${item.sectionPath.category || ""}|${item.sectionPath.section || ""}`).filter((key) => !key.endsWith("||")));
  return {
    plan: {
      name: weekName(weekStart),
      weekStart,
      sourceType: SOURCE_TYPE,
      sourceRef: `${manifest.packageId}:weekly:${weekStart}`,
      status: "draft",
      athleteSourceExternalId: manifest.targetAthlete.sourceExternalId,
    },
    counts: {
      days: days.size,
      sessions: sessions.size,
      sections: sections.size,
      exerciseItems: items.filter((item) => item.itemType === "exercise").length,
      noteItems: items.filter((item) => item.itemType === "note").length,
      totalItems: items.length,
    },
    items,
  };
}

async function existingPlanDetails(client, athleteSourceId, weekStart) {
  const result = await client.query(
    `select p.id, p.name, p.status, p.source_type, p.source_ref, p.created_at, p.updated_at, p.created_by_user_id,
            u.email as created_by_email, p.week_start::date::text as week_start, p.athlete_id,
            a.athlete_id, a.source_external_id,
            coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name)) as athlete_name,
            p.is_edit_draft, p.edit_source_plan_id, p.builder_batch_id, p.is_active
     from plans.plans p
     join public.athletes a on a.id = p.athlete_id
     left join public.users u on u.id = p.created_by_user_id
     where p.plan_type = 'weekly'
       and (a.athlete_id = $1 or a.source_external_id = $1)
       and p.week_start = $2::date
       and coalesce(p.is_active, true)
       and not coalesce(p.is_edit_draft, false)
     order by p.created_at`,
    [athleteSourceId, weekStart],
  );
  return result.rows;
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

async function childCounts(client, planId) {
  const result = await client.query(
    `select
       (select count(*)::int from plans.plan_days where plan_id = $1) as days,
       (select count(*)::int from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1) as sessions,
       (select count(*)::int from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and pn.node_type = 'section') as sections,
       (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and pi.item_type = 'exercise') as exercise_items,
       (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and pi.item_type = 'note') as note_items,
       (select count(*)::int from plans.plans where edit_source_plan_id = $1) as edit_drafts,
       (select count(*)::int from library.program_tags where plan_id = $1) as program_tags,
       case when to_regclass('library.program_reviews') is null then null else (select count(*)::int from library.program_reviews where plan_id = $1) end as program_reviews,
       case when to_regclass('library.program_access') is null then null else (select count(*)::int from library.program_access where plan_id = $1 or related_plan_id = $1) end as program_access`,
    [planId],
  );
  return result.rows[0];
}

async function builderSignals(client, planId) {
  const result = await client.query(
    `select greatest(
       coalesce((select max(updated_at) from plans.plans where id = $1), '-infinity'::timestamptz),
       coalesce((select max(updated_at) from plans.plan_days where plan_id = $1), '-infinity'::timestamptz),
       coalesce((select max(ps.updated_at) from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1), '-infinity'::timestamptz),
       coalesce((select max(pn.updated_at) from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1), '-infinity'::timestamptz),
       coalesce((select max(pi.updated_at) from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1), '-infinity'::timestamptz)
     ) as max_updated_at,
     (select created_at from plans.plans where id = $1) as plan_created_at,
     exists(select 1 from plans.plans where id = $1 and updated_at > created_at + interval '1 second') as plan_changed_after_create,
     exists(select 1 from plans.plan_days where plan_id = $1 and updated_at > created_at + interval '1 second') as day_changed_after_create,
     exists(
       select 1
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       where pd.plan_id = $1 and ps.updated_at > ps.created_at + interval '1 second'
     ) as session_changed_after_create,
     exists(
       select 1
       from plans.plan_nodes pn
       join plans.plan_sessions ps on ps.id = pn.plan_session_id
       join plans.plan_days pd on pd.id = ps.plan_day_id
       where pd.plan_id = $1 and pn.updated_at > pn.created_at + interval '1 second'
     ) as node_changed_after_create,
     exists(
       select 1
       from plans.plan_items pi
       join plans.plan_sessions ps on ps.id = pi.plan_session_id
       join plans.plan_days pd on pd.id = ps.plan_day_id
       where pd.plan_id = $1 and pi.updated_at > pi.created_at + interval '1 second'
     ) as item_changed_after_create`,
    [planId],
  );
  const row = result.rows[0];
  const childChangedAfterCreate = Boolean(row.day_changed_after_create || row.session_changed_after_create || row.node_changed_after_create || row.item_changed_after_create);
  return {
    maxUpdatedAt: row.max_updated_at,
    changedAfterCreate: Boolean(row.plan_changed_after_create || childChangedAfterCreate),
    planChangedAfterCreate: Boolean(row.plan_changed_after_create),
    childChangedAfterCreate,
  };
}

function diffPlans(oldPlan, newPlan) {
  const diffs = [];
  for (const key of ["days", "sessions", "sections", "exerciseItems", "noteItems", "totalItems"]) {
    if (oldPlan.counts[key] !== newPlan.counts[key]) diffs.push({ type: "count", key, old: oldPlan.counts[key], next: newPlan.counts[key] });
  }
  const oldItems = oldPlan.items;
  const newItems = newPlan.items;
  const max = Math.max(oldItems.length, newItems.length);
  let equalItems = 0;
  const samples = [];
  for (let index = 0; index < max; index += 1) {
    const oldItem = oldItems[index] || null;
    const newItem = newItems[index] || null;
    if (JSON.stringify(oldItem) === JSON.stringify(newItem)) {
      equalItems += 1;
    } else if (samples.length < 8) {
      samples.push({ index, old: oldItem, next: newItem });
    }
  }
  if (samples.length) diffs.push({ type: "item-samples", equalItems, comparedItems: max, samples });
  return {
    classification: diffs.length === 0 ? "identical" : equalItems > 0 ? "partial" : "different",
    equalItems,
    diffCount: diffs.length,
    samples: diffs,
  };
}

async function main() {
  const env = { ...readEnvFile("backend/.env"), ...process.env };
  const databaseUrl = process.env.LOCAL_DATABASE_URL || env.DATABASE_URL || "";
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin transaction read only");
    const manifestsDir = path.resolve("tools/manifests");
    const workbookPath = path.resolve("Program_cleaned.xlsx");
    const sheets = readWorkbook(workbookPath);
    const { rows } = workbookRows(sheets);
    const manifests = MANIFESTS.map((file) => readManifest(path.join(manifestsDir, file)));
    const report = {
      mode: "read-only",
      connection: safeDbLabel(databaseUrl),
      workbook: workbookPath,
      conflicts: [],
    };
    for (const manifest of manifests) {
      const athleteId = manifest.targetAthlete.sourceExternalId;
      const targetWeeks = TARGET_WEEKS.get(athleteId);
      if (!targetWeeks) continue;
      const selectedRows = selectRows(rows, manifest);
      for (const weekStart of targetWeeks) {
        const newPlan = normalizeNewPlan(manifest, selectedRows, weekStart);
        const existingPlans = await existingPlanDetails(client, athleteId, weekStart);
        for (const plan of existingPlans) {
          const oldPlan = await normalizeExistingPlan(client, plan.id);
          const counts = await childCounts(client, plan.id);
          const signals = await builderSignals(client, plan.id);
          const oldChecksum = sha256(oldPlan);
          const newChecksum = sha256(newPlan);
          const diff = diffPlans(oldPlan, newPlan);
          const belongsToEarlierImport = plan.source_type === "xlsx_weekly_import" && /Plan-program\.xlsx/i.test(plan.source_ref || "");
          const hasDependencies = Number(counts.edit_drafts) > 0 || Number(counts.program_tags) > 0 || Number(counts.program_reviews || 0) > 0 || Number(counts.program_access || 0) > 0;
          const recommendation = diff.classification === "identical"
            ? "KEEP/ADOPT"
            : hasDependencies || signals.changedAfterCreate
              ? "MANUAL REVIEW"
              : "REPLACE";
          report.conflicts.push({
            athlete: {
              sourceExternalId: athleteId,
              name: plan.athlete_name,
            },
            weekStart,
            plan: {
              id: plan.id,
              name: plan.name,
              status: plan.status,
              sourceType: plan.source_type,
              sourceRef: plan.source_ref,
              createdAt: plan.created_at,
              updatedAt: plan.updated_at,
              createdByUserId: plan.created_by_user_id,
              createdByEmail: plan.created_by_email,
            },
            counts: {
              existing: {
                days: oldPlan.counts.days,
                sessions: oldPlan.counts.sessions,
                sections: oldPlan.counts.sections,
                exerciseItems: oldPlan.counts.exerciseItems,
                noteItems: oldPlan.counts.noteItems,
                totalItems: oldPlan.counts.totalItems,
                physicalNodeSections: counts.sections,
              },
              incoming: newPlan.counts,
            },
            earlierImport: {
              appearsEarlierExcelImport: belongsToEarlierImport,
              reason: belongsToEarlierImport ? "source_type=xlsx_weekly_import and source_ref references Plan-program.xlsx" : "source identity does not match known earlier xlsx import marker",
              sameProgramCleanedPackage: false,
            },
            checksums: {
              existingNormalizedSha256: oldChecksum,
              incomingNormalizedSha256: newChecksum,
              equal: oldChecksum === newChecksum,
            },
            comparison: diff,
            dependencies: {
              editDrafts: counts.edit_drafts,
              programTags: counts.program_tags,
              programReviews: counts.program_reviews,
              programAccessAssignments: counts.program_access,
            },
            builderUsage: {
              maxUpdatedAt: signals.maxUpdatedAt,
              changedAfterCreate: signals.changedAfterCreate,
              planChangedAfterCreate: signals.planChangedAfterCreate,
              childChangedAfterCreate: signals.childChangedAfterCreate,
              likelyChangedThroughBuilder: signals.changedAfterCreate || Number(counts.edit_drafts) > 0,
            },
            recommendation,
            replacementGuard: {
              requiredOldPlanId: plan.id,
              requiredOldChecksum: oldChecksum,
              requiredOldSignature: {
                name: plan.name,
                status: plan.status,
                sourceType: plan.source_type,
                sourceRef: plan.source_ref,
                weekStart,
                counts: {
                  days: oldPlan.counts.days,
                  sessions: oldPlan.counts.sessions,
                  sections: oldPlan.counts.sections,
                  exerciseItems: oldPlan.counts.exerciseItems,
                  noteItems: oldPlan.counts.noteItems,
                },
              },
            },
          });
        }
      }
    }
    await client.query("rollback");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
