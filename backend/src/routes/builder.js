import { Router } from "express";
import { randomUUID } from "crypto";
import { pool, query } from "../db.js";
import { athleteAccessPredicate, canAccessAllAthletes, canAccessPlan } from "../access.js";
import { emitRealtimeEvent } from "../realtime.js";

const router = Router();
const NODE_TYPES = new Set(["domain", "category", "section"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shared by POST /plans/:planId/submit (weekly plan / specific program
// draft -> active) and POST /plans/:planId/duplicate (Assign to athlete) -
// the two events that actually put a new/published plan in front of an
// athlete. Writes directly on the CALLER's own open transaction client, so
// the notification and the plan-status change that caused it commit or
// roll back together - never a plan silently activated with no
// notification, or vice versa (see the migration this depends on,
// 202608280900_app_notifications_dedupe_key.sql, for why a bare
// dedupe_key + ON CONFLICT DO NOTHING is enough here - every notification
// this writes is one-shot, never updated in place).
//
// `plans` is an array of { id, athlete_id, name, plan_type, week_start }
// rows - exactly what `returning id, athlete_id, name, plan_type,
// week_start` on the status-flip UPDATE (submit) or the per-target INSERT
// (duplicate/assign) already produces, so callers never need a second
// query just to build this list.
//
// Returns the recipient user ids that got a REAL new notification this
// call, for the caller to emit realtime events for AFTER commit - never
// thrown for a plan with no athlete_id, an athlete with no linked user_id
// (skipped, not fatal - the rest of a multi-athlete batch must never be
// brought down by one athlete's missing account), or a genuine dedupe-key
// conflict (an already-notified retry).
async function notifyPlanAssignments(client, plans, actorUserId) {
  const notifiedUserIds = [];
  for (const plan of plans) {
    if (!plan.athlete_id) continue;
    const athleteResult = await client.query(`select user_id from public.athletes where id = $1`, [plan.athlete_id]);
    const recipientUserId = athleteResult.rows[0]?.user_id;
    if (!recipientUserId) continue;

    const isWeekly = plan.plan_type === "weekly";
    const type = isWeekly ? "weekly_plan_assigned" : "specific_program_assigned";
    const title = isWeekly ? "New weekly plan" : "New program assigned";
    const body = isWeekly ? `${plan.name || "Weekly plan"} · week of ${plan.week_start}` : (plan.name || "Program");
    const metadata = isWeekly
      ? { planId: plan.id, planType: "weekly", weekStart: plan.week_start }
      : { planId: plan.id, planType: "program" };
    // One notification per (event kind, plan) ever - a retried
    // submit/assign for the exact same plan row always resolves to the
    // same dedupe_key, so a second attempt is a guaranteed no-op here
    // regardless of how it was triggered (double click, network retry,
    // two parallel requests). Namespaced (builder:v1:...) so this table's
    // dedupe_key values stay unambiguous if another feature ever writes
    // its own one-shot notifications into the same column.
    const dedupeKey = `builder:v1:${type}:${plan.id}`;
    const inserted = await client.query(
      `insert into public.app_notifications (recipient_user_id, actor_user_id, type, title, body, entity_type, entity_id, metadata, dedupe_key)
       values ($1, $2, $3, $4, $5, 'plan', $6, $7::jsonb, $8)
       on conflict (dedupe_key) where dedupe_key is not null do nothing
       returning id`,
      [recipientUserId, actorUserId, type, title, body, plan.id, JSON.stringify(metadata), dedupeKey],
    );
    if (inserted.rows[0]) notifiedUserIds.push(recipientUserId);
  }
  return notifiedUserIds;
}

function emitPlanAssignedRealtime(userIds) {
  for (const userId of userIds) emitRealtimeEvent(userId, "notifications_changed", { type: "plan_assigned" });
}

router.get("/drafts", async (req, res, next) => {
  try {
    const result = await query(
      `select
         coalesce(p.builder_batch_id::text, p.id::text) as group_key,
         p.plan_type,
         p.week_start,
         max(p.name) as name,
         bool_or(p.is_template) as is_template,
         max(p.updated_at) as updated_at,
         array_agg(p.id::text order by p.created_at) as plan_ids,
         array_agg(coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.source_external_id, a.athlete_id::text) order by p.created_at) as athlete_names
       from plans.plans p
       left join public.athletes a on a.id = p.athlete_id
       where p.created_by_user_id = $1
         and p.source_type = 'builder'
         and p.status = 'draft'
         and coalesce(p.is_active, true)
         and not coalesce(p.is_edit_draft, false)
       group by group_key, p.plan_type, p.week_start
       order by max(p.updated_at) desc`,
      [req.user.id],
    );
    const drafts = result.rows.map((row) => ({
      groupKey: row.group_key,
      openPlanId: row.plan_ids[0],
      planIds: row.plan_ids,
      planType: row.plan_type,
      weekStart: row.week_start || "",
      name: row.name,
      isTemplate: row.is_template,
      updatedAt: row.updated_at,
      athleteNames: (row.athlete_names || []).filter(Boolean),
    }));
    res.json({ drafts });
  } catch (error) { next(error); }
});

router.get("/plans/:planId", async (req, res, next) => {
  try {
    const plan = await getEditablePlan(req, req.params.planId);
    if (!plan) return res.status(404).json({ error: "Draft program not found" });
    res.json(await buildDraft(plan));
  } catch (error) { next(error); }
});

router.patch("/plans/:planId", async (req, res, next) => {
  try {
    const plan = await requirePlan(req, req.params.planId, res);
    if (!plan) return;
    const name = text(req.body?.name) || (plan.plan_type === "weekly" ? `Weekly plan ${plan.week_start}` : plan.name);
    const coverImageUrl = req.body?.coverImageUrl === undefined ? plan.cover_image_url : nullableText(req.body.coverImageUrl);
    await query("update plans.plans set name = $2, cover_image_url = $3, updated_at = now() where id = $1", [plan.id, name, coverImageUrl]);
    return respondWithDraft(req, res, req.user, plan);
  } catch (error) { next(error); }
});

router.post("/plans/:planId/sync-batch", async (req, res, next) => {
  try {
    const plan = await requirePlan(req, req.params.planId, res);
    if (!plan) return;
    if (plan.builder_batch_id && !plan.is_edit_draft) await syncBatchFromPlan(plan, req.user);
    const freshPlan = await getEditablePlan(req, plan.id);
    res.json(await buildDraft(freshPlan || plan));
  } catch (error) { next(error); }
});

router.post("/plans", async (req, res, next) => {
  let client;
  try {
    const requestedName = text(req.body?.name);
    const athleteExternalIds = requestedAthleteIds(req.body);
    const planType = text(req.body?.planType) === "weekly" ? "weekly" : "program";
    const weekStart = planType === "weekly" ? normalizedWeekStart(req.body?.weekStart) : null;
    if (planType === "program" && !requestedName) return res.status(400).json({ error: "Program name is required." });
    if (planType === "weekly" && !athleteExternalIds.length) return res.status(400).json({ error: "Choose at least one athlete for a weekly plan." });
    if (planType === "weekly" && !weekStart) return res.status(400).json({ error: "Choose a valid date for the weekly plan." });
    const name = requestedName || `Weekly plan ${weekStart}`;
    const { athletes, missing, archived } = await findRequestedAthletes(athleteExternalIds);
    if (missing.length) return res.status(404).json({ error: `Athlete not found: ${missing.join(", ")}` });
    if (archived.length) return res.status(400).json({ error: `Athlete is archived, restore them first: ${archived.join(", ")}` });
    const targets = athletes.length ? athletes : [null];
    const batchId = targets.length > 1 ? randomUUID() : null;
    const createdIds = [];
    client = await pool.connect();
    await client.query("begin");
    if (planType === "weekly") {
      const conflicts = [];
      for (const target of targets) {
        const conflict = await ensureWeeklySlot(client, req.user.id, target, weekStart);
        if (conflict) conflicts.push(conflict);
      }
      if (conflicts.length) {
        await client.query("rollback");
        client.release();
        client = null;
        return res.status(409).json({ error: conflicts.join(" ") });
      }
    }
    for (const target of targets) {
      const isTemplate = planType === "program" && !target;
      const created = await client.query(
        `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, cover_image_url, visibility, is_template, status, source_type, week_start, builder_batch_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'private', $9, 'draft', 'builder', $10, $11) returning id`,
        [planType, req.user.id, target?.id || null, name, nullableText(req.body?.note), nullableText(req.body?.iconUrl), nullableText(req.body?.color), nullableText(req.body?.coverImageUrl), isTemplate, weekStart, batchId],
      );
      createdIds.push(created.rows[0].id);
      if (planType === "weekly") await createWeeklyDays(client, created.rows[0].id, weekStart);
    }
    await client.query("commit");
    client.release();
    client = null;
    res.status(201).json(await buildDraft(await getEditablePlan(req, createdIds[0])));
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
});

router.post("/plans/:planId/submit", async (req, res, next) => {
  let client;
  try {
    const plan = await requirePlan(req, req.params.planId, res);
    if (!plan) return;
    // Re-editing an already-active plan: applyEditDraft() sets the
    // ORIGINAL plan back to 'active' (it never left that status from the
    // athlete's point of view), never a draft->active transition - this
    // must never reach the notification logic below, and it doesn't:
    // this branch returns before either does.
    if (plan.is_edit_draft && plan.edit_source_plan_id) {
      const updated = await applyEditDraft(req, plan);
      return res.json(await buildDraft(updated));
    }
    const shouldSyncBatch = wantsBatchSync(req, plan);
    if (shouldSyncBatch) await syncBatchFromPlan(plan, req.user);
    const emptyDraft = await removeEmptyDraftOnSubmit(req.user, plan, req);
    if (emptyDraft) return res.json(emptyDraft);

    client = await pool.connect();
    await client.query("begin");
    // `and status = 'draft'` on both statements below is what makes a
    // retried Submit (double click, network retry) a clean no-op instead
    // of a second notification attempt: a plan already flipped to
    // 'active' by an earlier, successful call to this same route simply
    // isn't returned here the second time, so notifyPlanAssignments never
    // even sees it again. The dedupe_key/ON CONFLICT inside
    // notifyPlanAssignments is the second, DB-level guarantee for the
    // genuine race case (two parallel requests both reading 'draft'
    // before either commits) - `for update` isn't needed on top of that
    // WHERE clause: whichever request's UPDATE commits first is the one
    // that actually matches `status = 'draft'`, the other's UPDATE
    // affects 0 rows once it proceeds.
    let activatedPlans;
    if (shouldSyncBatch) {
      const updated = await client.query(
        `update plans.plans
         set status = 'active', updated_at = now()
         where builder_batch_id = $1
           and created_by_user_id = $2
           and source_type = 'builder'
           and status = 'draft'
           and coalesce(is_active, true)
           and not coalesce(is_edit_draft, false)
         returning id, athlete_id, name, plan_type, week_start`,
        [plan.builder_batch_id, req.user.id],
      );
      activatedPlans = updated.rows;
    } else {
      const updated = await client.query(
        `update plans.plans set status = 'active', updated_at = now()
         where id = $1 and status = 'draft'
         returning id, athlete_id, name, plan_type, week_start`,
        [plan.id],
      );
      activatedPlans = updated.rows;
    }
    const notifiedUserIds = await notifyPlanAssignments(client, activatedPlans, req.user.id);
    await client.query("commit");
    client.release();
    client = null;
    // Only after commit - a realtime push implying a notification exists
    // must never fire ahead of the transaction that actually created it.
    emitPlanAssignedRealtime(notifiedUserIds);
    res.json(await buildDraft(await getEditablePlan(req, plan.id)));
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
});

router.post("/plans/:planId/duplicate", async (req, res, next) => {
  let client;
  try {
    const source = await getCopySource(req, req.params.planId);
    if (!source) return res.status(404).json({ error: "Program or template not found." });
    if (source.is_template && source.can_copy === false && !canAccessAllAthletes(req) && String(source.created_by_user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: "This template cannot be copied." });
    }
    // "Assign to athlete" (business-final) vs plain "Copy" (a working copy,
    // stays draft until the coach finishes it themselves) - both hit this
    // exact route; `intent` is the only thing that tells them apart. Plain
    // Copy is the default (an unrecognized/missing intent is never treated
    // as assign) so nothing about the existing Copy flow changes for a
    // client that doesn't send this field at all.
    const intent = text(req.body?.intent) === "assign" ? "assign" : "copy";
    const targetAthleteExternalIds = requestedAthleteIds(req.body);
    const { athletes: targetAthletes, missing, archived } = await findRequestedAthletes(targetAthleteExternalIds);
    if (missing.length) return res.status(404).json({ error: `Athlete not found: ${missing.join(", ")}` });
    if (archived.length) return res.status(400).json({ error: `Athlete is archived, restore them first: ${archived.join(", ")}` });
    if (intent === "assign" && !source.is_template) {
      return res.status(400).json({ error: "Only a template can be assigned to an athlete." });
    }
    if (intent === "assign" && !targetAthletes.length) {
      return res.status(400).json({ error: "Choose at least one athlete to assign this template to." });
    }
    const targetWeekStart = source.plan_type === "weekly" ? normalizedWeekStart(req.body?.weekStart) : null;
    if (source.plan_type === "weekly" && !targetAthletes.length) return res.status(400).json({ error: "Choose at least one athlete for a weekly plan copy." });
    if (source.plan_type === "weekly" && !targetWeekStart) return res.status(400).json({ error: "Choose the target week for this copy." });

    // "Assign to athlete" is business-final and must be safe against
    // retries/double-clicks/genuine parallel requests. app_notifications'
    // dedupe_key alone (keyed on a plan id) cannot stop a duplicate
    // ASSIGNMENT - each retried request would still build its own brand-new
    // plan id before that key ever comes into play. assignmentRequestId is
    // a client-minted UUID reused across retries of the SAME attempt (see
    // frontend/builder-actions.js's copyAssignmentRequestId) - see
    // migrations_v2/202608290900_builder_assignment_requests.sql for the
    // full mechanism: the request that wins the INSERT below owns the real
    // work, every other caller with the same id blocks on that row via
    // `select ... for update` (a plain row lock) until the owner's
    // transaction resolves, then either replays the stored result (same
    // user, same payload_key) or is rejected with 409 (different user or
    // payload - a reused id is never silently treated as "the same thing").
    let assignmentRequestId = null;
    let payloadKey = null;
    if (intent === "assign") {
      assignmentRequestId = text(req.body?.assignmentRequestId);
      if (!UUID_RE.test(assignmentRequestId)) {
        return res.status(400).json({ error: "assignmentRequestId (a UUID) is required for Assign to athlete." });
      }
      payloadKey = JSON.stringify({
        sourcePlanId: source.id,
        athleteIds: targetAthletes.map((athlete) => athlete.id).slice().sort(),
        weekStart: targetWeekStart || null,
      });
    }

    const targets = targetAthletes.length ? targetAthletes : [null];
    const batchId = targets.length > 1 ? randomUUID() : null;
    // "Assign" activates every created copy immediately, in the SAME
    // transaction as the copy itself - there is no intermediate draft state
    // an athlete could ever see for an assigned plan. A plain Copy is
    // unaffected: still always 'draft', exactly as before.
    const status = intent === "assign" ? "active" : "draft";
    const createdIds = [];
    const assignedPlans = [];
    client = await pool.connect();
    await client.query("begin");

    if (intent === "assign") {
      let claimed = false;
      let replay = null;
      // Bounded, not polling: each failed iteration only happens after a
      // `for update` block released by someone else's commit/rollback, so
      // 3 attempts comfortably covers even a rolled-back predecessor
      // freeing the slot back up for a genuine retry.
      for (let attempt = 0; attempt < 3 && !claimed && !replay; attempt += 1) {
        const inserted = await client.query(
          `insert into public.builder_assignment_requests (id, user_id, source_plan_id, payload_key)
           values ($1, $2, $3, $4)
           on conflict (id) do nothing
           returning id`,
          [assignmentRequestId, req.user.id, source.id, payloadKey],
        );
        if (inserted.rows[0]) { claimed = true; break; }
        const locked = await client.query(
          `select user_id, payload_key, status, result from public.builder_assignment_requests where id = $1 for update`,
          [assignmentRequestId],
        );
        const existing = locked.rows[0];
        if (!existing) continue; // the earlier claimant rolled back entirely - the slot is free again, retry the claim
        if (String(existing.user_id) !== String(req.user.id) || existing.payload_key !== payloadKey) {
          await client.query("rollback");
          client.release();
          client = null;
          return res.status(409).json({ error: "This assignment request id was already used with different parameters." });
        }
        // Same user, same payload: the row can only be sitting here
        // 'completed' with a real result - the claim below only ever
        // commits alongside that result (same transaction), so there is no
        // observable "committed but still pending" state to land on.
        replay = existing.result;
      }
      if (replay) {
        await client.query("commit");
        client.release();
        client = null;
        return res.status(201).json({ ...(await buildDraft(await getEditablePlan(req, replay.planId))), assignments: replay.assignments });
      }
      if (!claimed) {
        await client.query("rollback");
        client.release();
        client = null;
        return res.status(409).json({ error: "Could not process this assignment request, please retry." });
      }
    }

    if (source.plan_type === "weekly") {
      const conflicts = [];
      for (const target of targets) {
        const conflict = await ensureWeeklySlot(client, req.user.id, target, targetWeekStart);
        if (conflict) conflicts.push(conflict);
      }
      if (conflicts.length) {
        await client.query("rollback");
        client.release();
        client = null;
        return res.status(409).json({ error: conflicts.join(" ") });
      }
    }
    for (const target of targets) {
      const isTemplate = source.plan_type === "program" && !target;
      // Assign keeps the template's own name - the athlete is receiving
      // exactly that program, not "a copy of" it. Only a plain Copy still
      // gets the "copy" suffix, unchanged from before.
      const planName = intent === "assign" ? (source.name || "Program") : `${source.name || "Program"} copy`;
      const created = await client.query(
        `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, visibility, is_template, status, source_type, start_date, duration_days, week_start, builder_batch_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'private', $8, $9, 'builder', $10, $11, $12, $13)
         returning id`,
        [source.plan_type, req.user.id, target?.id || null, planName, source.note, source.icon_url, source.color, isTemplate, status, source.start_date, source.duration_days, targetWeekStart, batchId],
      );
      createdIds.push(created.rows[0].id);
      if (source.plan_type === "weekly") await copyWeeklyPlanTree(client, source.id, created.rows[0].id, targetWeekStart);
      else await copyProgramTree(client, source.id, created.rows[0].id);
      // target is never null here - intent === "assign" already required at
      // least one real athlete target above, so this loop only ever
      // produces real, athlete-owned rows when it's populating this list.
      if (intent === "assign" && target) {
        assignedPlans.push({ id: created.rows[0].id, athlete_id: target.id, name: planName, plan_type: source.plan_type, week_start: targetWeekStart });
      }
    }
    await client.query(
      `insert into library.program_access (plan_id, user_id, access_type, status, related_plan_id)
       values ($1, $2, 'copied', 'accessed', $3)
       on conflict (plan_id, user_id, access_type)
       do update set related_plan_id = excluded.related_plan_id,
                     status = case when library.program_access.status = 'revoked' then 'accessed' else library.program_access.status end,
                     accessed_at = now(),
                     updated_at = now()`,
      [source.id, req.user.id, createdIds[0]],
    );
    const notifiedUserIds = intent === "assign" ? await notifyPlanAssignments(client, assignedPlans, req.user.id) : [];
    // "assignments" lists every plan this call created (not just the first) -
    // required for a multi-athlete duplicate (e.g. the open-Builder "Assign
    // to athlete" flow, frontend/builder-actions.js) to be able to confirm
    // and link to EACH resulting Specific Program, not only the first one.
    // Purely additive: existing callers of this endpoint only ever read the
    // top-level plan/blocks/batch fields (the first created plan's own
    // draft shape, unchanged), so this doesn't affect them.
    const assignments = targets.map((target, index) => ({ athleteId: target?.externalId || null, planId: createdIds[index] }));
    if (intent === "assign") {
      // Marked 'completed' in the SAME transaction/commit as the plans and
      // notifications themselves - a rollback anywhere above undoes the
      // claim too, so a genuinely failed attempt leaves no idempotency
      // trace behind and the same requestId can cleanly retry the real work.
      await client.query(
        `update public.builder_assignment_requests set status = 'completed', result = $2::jsonb, updated_at = now() where id = $1`,
        [assignmentRequestId, JSON.stringify({ planId: createdIds[0], assignments })],
      );
    }
    await client.query("commit");
    client.release();
    client = null;
    emitPlanAssignedRealtime(notifiedUserIds);
    res.status(201).json({ ...(await buildDraft(await getEditablePlan(req, createdIds[0]))), assignments });
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
});

router.post("/plans/:planId/edit", async (req, res, next) => {
  let client;
  try {
    const plan = await getEditablePlan(req, req.params.planId);
    if (!plan) return res.status(404).json({ error: "Program not found or not editable." });
    if (plan.is_edit_draft) return res.json(await buildDraft(plan));
    if (plan.status === "draft" && plan.source_type === "builder" && !plan.edit_source_plan_id) {
      return res.json(await buildDraft(plan));
    }

    const existingDraft = await query(
      `select id
       from plans.plans
       where edit_source_plan_id = $1
         and is_edit_draft = true
         and created_by_user_id = $2
       order by updated_at desc
       limit 1`,
      [plan.id, req.user.id],
    );
    if (existingDraft.rows[0]) {
      return res.json(await buildDraft(await getEditablePlan(req, existingDraft.rows[0].id)));
    }

    client = await pool.connect();
    await client.query("begin");
    const created = await client.query(
      `insert into plans.plans (
        plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, visibility,
        is_template, status, source_type, start_date, duration_days, week_start,
        is_active, is_edit_draft, edit_source_plan_id, builder_batch_id
      )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', 'builder_edit_draft', $10, $11, $12, false, true, $13, $14)
       returning id`,
      [
        plan.plan_type, req.user.id, plan.athlete_uuid || null, plan.name, plan.note, plan.icon_url, plan.color,
        plan.visibility || "private", plan.is_template, plan.start_date, plan.duration_days, plan.week_start, plan.id, plan.builder_batch_id || null,
      ],
    );
    // preserveLogicalId: true - this is the FIRST leg of the live <-> edit-
    // draft round trip (the second leg is applyEditDraft's own call below).
    // A session copied here still represents the SAME real training
    // session the coach is about to edit, not a new one - see
    // copyDaySessions' own comment on why that distinction matters for
    // training_load.session_feedback's stable identity.
    if (plan.plan_type === "weekly") await copyWeeklyPlanTree(client, plan.id, created.rows[0].id, plan.week_start, { preserveLogicalId: true });
    else await copyProgramTree(client, plan.id, created.rows[0].id);
    await client.query("commit");
    client.release();
    client = null;
    res.json(await buildDraft(await getEditablePlan(req, created.rows[0].id)));
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
});

router.delete("/plans/:planId", async (req, res, next) => {
  try {
    const plan = await requirePlan(req, req.params.planId, res);
    if (!plan) return;
    const blocks = await query("select id from plans.plan_days where plan_id = $1", [plan.id]);
    for (const block of blocks.rows) await deleteBlockTree(block.id);
    await query("delete from plans.plans where id = $1", [plan.id]);
    res.json({ deleted: true, planId: plan.id });
  } catch (error) { next(error); }
});

router.post("/plans/:planId/blocks", async (req, res, next) => {
  try {
    const plan = await requirePlan(req, req.params.planId, res);
    if (!plan) return;
    if (plan.plan_type === "weekly") return res.status(400).json({ error: "Weekly plans already contain seven calendar days." });
    const next = await nextOrder("plans.plan_days", "plan_id", plan.id, "block_order");
    await query(
      `insert into plans.plan_days (plan_id, block_index, block_order, block_name, block_type, day_note)
       values ($1, $2, $3, $4, $5, $6)`,
      [plan.id, next, next, text(req.body?.name) || `Block ${next}`, text(req.body?.type) || "session", nullableText(req.body?.note)],
    );
    return respondWithDraft(req, res, req.user, plan, { status: 201 });
  } catch (error) { next(error); }
});

router.delete("/blocks/:blockId", async (req, res, next) => {
  try {
    const block = await getEditableBlock(req, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Program block not found" });
    if (block.plan.plan_type === "weekly") return res.status(400).json({ error: "Weekly plan days cannot be deleted." });
    await deleteBlockTree(block.id);
    return respondWithDraft(req, res, req.user, block.plan);
  } catch (error) { next(error); }
});

router.post("/blocks/:blockId/copy", async (req, res, next) => {
  let client;
  try {
    const block = await getEditableBlock(req, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Program block not found" });
    if (block.plan.plan_type === "weekly") return res.status(400).json({ error: "Weekly plans already contain seven calendar days." });
    const source = await query("select * from plans.plan_days where id = $1", [block.id]);
    const sourceDay = source.rows[0];
    if (!sourceDay) return res.status(404).json({ error: "Program block not found" });
    const nextBlockOrder = await nextOrder("plans.plan_days", "plan_id", block.plan.id, "block_order");
    client = await pool.connect();
    await client.query("begin");
    const created = await client.query(
      `insert into plans.plan_days (plan_id, block_index, block_order, block_name, block_type, day_note)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [block.plan.id, nextBlockOrder, nextBlockOrder, sourceDay.block_name ? `${sourceDay.block_name} copy` : null, sourceDay.block_type, sourceDay.day_note],
    );
    const newBlockId = created.rows[0].id;
    const sourceSessions = await client.query("select * from plans.plan_sessions where plan_day_id = $1 order by session_order", [block.id]);
    for (const session of sourceSessions.rows) {
      const createdSession = await client.query(
        // rpe_enabled is a content property (like am_pm/bta/name), always
        // copied unconditionally - see the migration's own header comment
        // on why this must never be selectively omitted the way
        // logical_session_id (an identity mechanism) is.
        "insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_time, session_order, name, rpe_enabled) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [newBlockId, session.am_pm, session.bta, session.session_time, session.session_order, session.name, session.rpe_enabled],
      );
      await copySessionContent(client, session.id, createdSession.rows[0].id);
    }
    await client.query("commit");
    client.release();
    client = null;
    return respondWithDraft(req, res, req.user, block.plan, { status: 201 });
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
});

// Content-only paste into a weekly day - replaces the target day's
// sessions/nodes/items with the source's, but never touches either day's
// own date/day_order row (a weekly plan always keeps its fixed 7 calendar
// days - this moves what's ON a day, not the day itself). Shared by both
// "days/:dayId/copy-into" (Phase 1: another day of the SAME weekly plan -
// both source and target resolved with WRITE access, allowCrossPlan stays
// false here on purpose: this route is "rearrange within the plan you're
// editing", never a channel to pull from a plan you merely have read/copy
// access to) and "blocks/:blockId/copy-into" (a block/day from a DIFFERENT
// Template, Specific Program, or - as of the "Weekly plan" source option -
// another Weekly plan; source resolved with READ/copy access via
// getCopySourceBlock, so allowCrossPlan is true there) below - once
// source/target are resolved, the copy itself doesn't care which one it was.
async function respondCopyIntoDay(req, res, next, source, target, { allowCrossPlan = false } = {}) {
  let client;
  try {
    if (!target) return res.status(404).json({ error: "Target day not found." });
    if (target.plan.plan_type !== "weekly") return res.status(400).json({ error: "Day paste is only available for weekly plans." });
    if (!source) return res.status(404).json({ error: "Source not found." });
    if (source.plan.id === target.plan.id && source.id === target.id) return res.status(400).json({ error: "Choose a different day to paste into." });
    if (!allowCrossPlan && source.plan.id !== target.plan.id) {
      return res.status(400).json({ error: "Pasting between different plans' days isn't supported on this route - use 'Copy from another plan' instead." });
    }

    client = await pool.connect();
    const hasContent = await dayHasContentWithClient(client, target.id);
    if (hasContent && req.body?.confirmOverwrite !== true) {
      client.release();
      client = null;
      return res.status(409).json({ error: "This day already has content. Paste again to confirm the overwrite." });
    }

    await client.query("begin");
    await deleteDayContentWithClient(client, target.id);
    await copyDaySessions(client, source.id, target.id);
    await client.query("commit");
    client.release();
    client = null;
    return respondWithDraft(req, res, req.user, target.plan);
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
}

router.post("/days/:dayId/copy-into/:targetDayId", async (req, res, next) => {
  const source = await getEditableBlock(req, req.params.dayId);
  const target = await getEditableBlock(req, req.params.targetDayId);
  return respondCopyIntoDay(req, res, next, source, target);
});

// Phase 2 (+ later, "Weekly plan" as a source): copy a block/day from a
// Template, Specific Program, or another Weekly plan (any plan the coach
// has read/copy access to, via getCopySourceBlock below - not necessarily
// one they can edit, e.g. a marketplace template) into a day of the weekly
// plan currently open in the Builder.
router.post("/blocks/:blockId/copy-into/:targetDayId", async (req, res, next) => {
  const source = await getCopySourceBlock(req, req.params.blockId);
  const target = await getEditableBlock(req, req.params.targetDayId);
  return respondCopyIntoDay(req, res, next, source, target, { allowCrossPlan: true });
});

// Lightweight per-block summary (id, label, session/item counts) for a
// plan the coach has read/copy access to - powers the "pick a block to
// copy" picker without fetching that plan's entire node/item tree the way
// buildDraft() would.
const PICKER_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Mirrors frontend/utils.js's weekDayName()/formatDate() - kept as a small,
// self-contained duplicate here rather than a shared import, since this is
// the one place a *display label* needs computing server-side (every other
// date-formatting call in this app happens in the browser). A weekly day
// with no block_name typed in has a real calendar date to fall back to; a
// program/template block never does (no `date` column meaning at all for
// those), so it keeps the plain "Block N" fallback.
function pickerBlockLabel(row) {
  if (row.block_name) return row.block_name;
  if (row.date) {
    const parsed = new Date(`${String(row.date).slice(0, 10)}T12:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      const weekday = PICKER_WEEKDAY_NAMES[parsed.getUTCDay()];
      const formatted = parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      return `${weekday}, ${formatted}`;
    }
  }
  return row.block_index != null ? `Block ${row.block_index}` : "Day";
}

router.get("/plans/:planId/blocks", async (req, res, next) => {
  try {
    const plan = await getCopySource(req, req.params.planId);
    if (!plan || !canCopyFromPlan(req, plan)) return res.status(404).json({ error: "Program not found." });
    const result = await query(
      `select pd.id, pd.block_index, pd.block_name, pd.day_note, pd.date,
              (select count(*)::int from plans.plan_sessions ps where ps.plan_day_id = pd.id) as session_count,
              (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps2 on ps2.id = pi.plan_session_id where ps2.plan_day_id = pd.id) as item_count
       from plans.plan_days pd
       where pd.plan_id = $1
       order by pd.block_order nulls last, pd.block_index nulls last, pd.day_order nulls last`,
      [plan.id],
    );
    res.json({
      blocks: result.rows.map((row) => ({
        id: row.id,
        name: pickerBlockLabel(row),
        note: row.day_note || "",
        sessionCount: row.session_count,
        itemCount: row.item_count,
      })),
    });
  } catch (error) { next(error); }
});

// Lightweight session list for a block/day the coach has read/copy access
// to - same shape/style as GET /plans/:planId/blocks one level down, powers
// the "drill into a day, then pick a whole session or go deeper" picker
// step. Field names (amPm/bta/time/name) match buildDraft()'s own session
// shape so the frontend can reuse sessionLabel() (builder-helpers.js)
// unchanged.
router.get("/blocks/:blockId/sessions", async (req, res, next) => {
  try {
    const block = await getCopySourceBlock(req, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Day not found." });
    const result = await query(
      `select ps.id, ps.am_pm, ps.bta, ps.session_time, ps.name,
              (select count(*)::int from plans.plan_items pi join plans.plan_nodes pn on pn.id = pi.plan_node_id where pn.plan_session_id = ps.id) as item_count
       from plans.plan_sessions ps
       where ps.plan_day_id = $1
       order by ps.session_order nulls last`,
      [block.id],
    );
    res.json({
      sessions: result.rows.map((row) => ({
        id: row.id,
        amPm: row.am_pm || "",
        bta: row.bta || "",
        time: row.session_time ? String(row.session_time).slice(0, 5) : "",
        name: row.name || "",
        itemCount: row.item_count,
      })),
    });
  } catch (error) { next(error); }
});

// Flat node list (no recursive CTE needed - the frontend nests it
// client-side exactly the way renderBuilderNodeTree already does,
// session.nodes.filter(node => node.parentId === parentId)) for a session
// the coach has read/copy access to - powers the "drill into a session,
// pick any domain/category/section" picker step.
router.get("/sessions/:sessionId/nodes", async (req, res, next) => {
  try {
    const session = await getCopySourceSession(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const result = await query(
      `select pn.id, pn.parent_id, pn.node_type, pn.name, pn.color, pn.icon_url,
              (select count(*)::int from plans.plan_items pi where pi.plan_node_id = pn.id) as item_count
       from plans.plan_nodes pn
       where pn.plan_session_id = $1
       order by pn.node_order nulls last`,
      [session.id],
    );
    res.json({
      nodes: result.rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id || "",
        type: row.node_type,
        name: row.name,
        iconUrl: row.icon_url || "",
        itemCount: row.item_count,
      })),
    });
  } catch (error) { next(error); }
});

// New session, appended to the target day (a day can already hold several
// sessions - AM/PM, for instance - so unlike whole-day paste this never
// overwrites anything and needs no confirm step). Source resolved with
// READ/copy access (getCopySourceSession) - the coach doesn't need edit
// rights on the plan they're copying FROM, only on the plan they're
// pasting INTO (getEditableBlock, unchanged).
router.post("/sessions/:sessionId/copy-into/:targetDayId", async (req, res, next) => {
  let client;
  try {
    const source = await getCopySourceSession(req, req.params.sessionId);
    if (!source) return res.status(404).json({ error: "Source session not found." });
    const target = await getEditableBlock(req, req.params.targetDayId);
    if (!target) return res.status(404).json({ error: "Target day not found." });
    if (target.plan.plan_type !== "weekly") return res.status(400).json({ error: "Session paste is only available for weekly plans." });

    client = await pool.connect();
    const nextOrderResult = await client.query(
      "select coalesce(max(session_order), -1) + 1 as next_order from plans.plan_sessions where plan_day_id = $1",
      [target.id],
    );
    await client.query("begin");
    const created = await client.query(
      // rpe_enabled: content property, always copied unconditionally.
      `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name, rpe_enabled)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [target.id, source.am_pm, source.bta, nextOrderResult.rows[0].next_order, source.name, source.rpe_enabled],
    );
    await copySessionContent(client, source.id, created.rows[0].id);
    await client.query("commit");
    client.release();
    client = null;
    return respondWithDraft(req, res, req.user, target.plan);
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
});

router.patch("/blocks/:blockId", async (req, res, next) => {
  try {
    const block = await getEditableBlock(req, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Program block not found" });
    await query(
      "update plans.plan_days set block_name = $2, day_note = $3, updated_at = now() where id = $1",
      [block.id, nullableText(req.body?.name), nullableText(req.body?.note)],
    );
    return respondWithDraft(req, res, req.user, block.plan);
  } catch (error) { next(error); }
});

router.post("/blocks/:blockId/sessions", async (req, res, next) => {
  try {
    const block = await getEditableBlock(req, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Program block not found" });
    const order = await nextOrder("plans.plan_sessions", "plan_day_id", block.id, "session_order");
    await query(
      `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_time, session_order, name) values ($1, $2, $3, $4, $5, $6)`,
      [block.id, phaseValue(req.body?.amPm, ["AM", "PM"]), phaseValue(req.body?.bta, ["B", "T", "A"]), sessionTimeValue(req.body?.time), order, nullableText(req.body?.name)],
    );
    return respondWithDraft(req, res, req.user, block.plan, { status: 201 });
  } catch (error) { next(error); }
});

router.patch("/sessions/:sessionId", async (req, res, next) => {
  try {
    const session = await getEditableSession(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Program session not found" });
    // amPm/bta are only touched when the request body actually includes the
    // key - a caller that PATCHes just {name, time} (e.g. an older client,
    // or a deliberate partial update) must never silently wipe the existing
    // AM/PM/training-phase classification. An included empty string ("",
    // what the coach's own "Time of day"/"Training phase" placeholder
    // option submits) is still a real, explicit clear - same as how an
    // empty name already clears the name field below.
    const amPm = req.body?.amPm !== undefined ? phaseValue(req.body.amPm, ["AM", "PM"]) : session.am_pm;
    const bta = req.body?.bta !== undefined ? phaseValue(req.body.bta, ["B", "T", "A"]) : session.bta;
    // rpeEnabled follows the exact same "only touched when the request
    // body actually includes the key" partial-update rule as amPm/bta
    // above - Builder's edit-draft session settings form is a staging
    // area (nothing is "live" until Submit), so no confirm-before-disable
    // check is needed here even if the session already has RPE results;
    // that gate belongs on the Training Load quick-toggle route instead
    // (see PATCH /api/training-load/sessions/:sessionId/rpe-enabled).
    const rpeEnabled = req.body?.rpeEnabled !== undefined ? Boolean(req.body.rpeEnabled) : session.rpe_enabled;
    await query(
      "update plans.plan_sessions set session_time = $2, name = $3, am_pm = $4, bta = $5, rpe_enabled = $6, updated_at = now() where id = $1",
      [session.id, sessionTimeValue(req.body?.time), nullableText(req.body?.name), amPm, bta, rpeEnabled],
    );
    return respondWithDraft(req, res, req.user, session.plan);
  } catch (error) { next(error); }
});

router.delete("/sessions/:sessionId", async (req, res, next) => {
  try {
    const session = await getEditableSession(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Program session not found" });
    await deleteSessionTree(session.id);
    return respondWithDraft(req, res, req.user, session.plan);
  } catch (error) { next(error); }
});

router.post("/sessions/:sessionId/nodes", async (req, res, next) => {
  try {
    const session = await getEditableSession(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Program session not found" });
    const nodeType = text(req.body?.nodeType).toLowerCase();
    const name = text(req.body?.name);
    const parentId = nullableText(req.body?.parentId);
    if (!NODE_TYPES.has(nodeType) || !name) return res.status(400).json({ error: "Node type and name are required." });
    if (parentId && !(await isNodeInSession(parentId, session.id))) return res.status(400).json({ error: "Parent node is outside this session." });
    if (!(await isAllowedNodePlacement(session.id, parentId, nodeType))) {
      return res.status(400).json({ error: "Use Domain → Category → Section. A Section may also sit directly under a Domain or session." });
    }
    const order = await nextNodeOrder(session.id, parentId);
    await query(
      `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [session.id, parentId, nodeType, name, nullableText(req.body?.color), nullableText(req.body?.iconUrl), nullableText(req.body?.shortNote), nullableText(req.body?.note), order],
    );
    return respondWithDraft(req, res, req.user, session.plan, { status: 201 });
  } catch (error) { next(error); }
});

router.delete("/nodes/:nodeId", async (req, res, next) => {
  try {
    const node = await getEditableNode(req, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
    await deleteNodeTree(node.id);
    return respondWithDraft(req, res, req.user, node.plan);
  } catch (error) { next(error); }
});

router.patch("/nodes/:nodeId", async (req, res, next) => {
  try {
    const node = await getEditableNode(req, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
    const name = text(req.body?.name) || node.name;
    const shortNote = req.body?.shortNote === undefined ? node.short_note : nullableText(req.body.shortNote);
    const note = req.body?.note === undefined ? node.note : nullableText(req.body.note);
    await query(
      "update plans.plan_nodes set name = $2, color = $3, icon_url = $4, short_note = $5, note = $6, updated_at = now() where id = $1",
      [node.id, name, nullableText(req.body?.color), nullableText(req.body?.iconUrl), shortNote, note],
    );
    await syncSessionItemSnapshots(node.plan_session_id);
    return respondWithDraft(req, res, req.user, node.plan);
  } catch (error) { next(error); }
});

// Refreshes the denormalized domain_/category_/section_ name+color+icon snapshot
// columns on every plan_item in a session from the current plan_nodes tree, so a
// rename doesn't leave already-linked exercises displaying the old name/color/icon.
async function syncSessionItemSnapshots(sessionId) {
  await query(
    `with recursive node_chain as (
       select id, parent_id, node_type, name, color, icon_url, short_note, note, id as leaf_id
       from plans.plan_nodes
       where plan_session_id = $1
       union all
       select pn.id, pn.parent_id, pn.node_type, pn.name, pn.color, pn.icon_url, pn.short_note, pn.note, nc.leaf_id
       from plans.plan_nodes pn
       join node_chain nc on pn.id = nc.parent_id
     ),
     ancestry as (
       select leaf_id,
         max(case when node_type = 'domain' then name end) as domain_name,
         max(case when node_type = 'domain' then color end) as domain_color,
         max(case when node_type = 'domain' then icon_url end) as domain_icon_url,
         max(case when node_type = 'domain' then short_note end) as domain_short_note,
         max(case when node_type = 'domain' then note end) as domain_note,
         max(case when node_type = 'category' then name end) as category_name,
         max(case when node_type = 'category' then color end) as category_color,
         max(case when node_type = 'category' then icon_url end) as category_icon_url,
         max(case when node_type = 'category' then short_note end) as category_short_note,
         max(case when node_type = 'category' then note end) as category_note,
         max(case when node_type = 'section' then name end) as section_name,
         max(case when node_type = 'section' then color end) as section_color,
         max(case when node_type = 'section' then icon_url end) as section_icon_url,
         max(case when node_type = 'section' then short_note end) as section_short_note,
         max(case when node_type = 'section' then note end) as section_note
       from node_chain
       group by leaf_id
     )
     update plans.plan_items pi
     set domain_name = a.domain_name, domain_color = a.domain_color, domain_icon_url = a.domain_icon_url,
         domain_short_note = a.domain_short_note, domain_note = a.domain_note,
         category_name = a.category_name, category_color = a.category_color, category_icon_url = a.category_icon_url,
         category_short_note = a.category_short_note, category_note = a.category_note,
         section_name = a.section_name, section_color = a.section_color, section_icon_url = a.section_icon_url,
         section_short_note = a.section_short_note, section_note = a.section_note,
         updated_at = now()
     from ancestry a
     where pi.plan_node_id = a.leaf_id and pi.plan_session_id = $1`,
    [sessionId],
  );
}

router.post("/nodes/:nodeId/move", async (req, res, next) => {
  try {
    const node = await getEditableNode(req, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
    const direction = text(req.body?.direction);
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: "Move direction is required." });
    const comparator = direction === 'up' ? '<' : '>';
    const sort = direction === 'up' ? 'desc' : 'asc';
    const neighborResult = await query(
      `select id, node_order
       from plans.plan_nodes
       where plan_session_id = $1
         and parent_id is not distinct from $2
         and node_order ${comparator} $3::numeric
       order by node_order ${sort}
       limit 1`,
      [node.plan_session_id, node.parent_id, node.node_order],
    );
    const neighbor = neighborResult.rows[0];
    if (!neighbor) return respondWithDraft(req, res, req.user, node.plan);
    await query(
      `update plans.plan_nodes
   set node_order = case when id = $1 then $2::numeric when id = $3 then $4::numeric end,
           updated_at = now()
       where id in ($1, $3)`,
      [node.id, neighbor.node_order, neighbor.id, node.node_order],
    );
    return respondWithDraft(req, res, req.user, node.plan);
  } catch (error) { next(error); }
});

router.post("/nodes/:nodeId/exercises", async (req, res, next) => {
  try {
    const node = await getEditableNode(req, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
    if (node.node_type !== "section") return res.status(400).json({ error: "Exercises can only be added to a section." });
    const exerciseResult = await query(
      `select id, name, aim, execution_notes, instruction, image_url, video_url
       from library.exercises where id = $1 and is_active = true`, [text(req.body?.exerciseId)],
    );
    const exercise = exerciseResult.rows[0];
    if (!exercise) return res.status(404).json({ error: "Exercise not found." });
    const order = await nextOrder("plans.plan_items", "plan_session_id", node.plan_session_id, "item_order");
    const ancestry = await getNodeAncestryMeta(node);
    await query(
      `insert into plans.plan_items (
        plan_session_id, plan_node_id, item_type, exercise_id, title, description, image_url, video_url,
        sets, reps, load, item_order, exercise_order,
        domain_name, domain_color, domain_icon_url, domain_short_note, domain_note, domain_order,
        category_name, category_color, category_icon_url, category_short_note, category_note, category_order,
        section_name, section_color, section_icon_url, section_short_note, section_note, section_order
      ) values ($1, $2, 'exercise', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28, $29)`,
      [node.plan_session_id, node.id, exercise.id, exercise.name,
        text(exercise.instruction) || text(exercise.execution_notes) || text(exercise.aim) || null,
        exercise.image_url, exercise.video_url, nullableText(req.body?.sets), nullableText(req.body?.reps), nullableText(req.body?.load), order,
        ancestry.domain?.name || null, ancestry.domain?.color || null, ancestry.domain?.icon_url || null, ancestry.domain?.short_note || null, ancestry.domain?.note || null, ancestry.domain?.node_order ?? null,
        ancestry.category?.name || null, ancestry.category?.color || null, ancestry.category?.icon_url || null, ancestry.category?.short_note || null, ancestry.category?.note || null, ancestry.category?.node_order ?? null,
        ancestry.section?.name || null, ancestry.section?.color || null, ancestry.section?.icon_url || null, ancestry.section?.short_note || null, ancestry.section?.note || null, ancestry.section?.node_order ?? null],
    );
    return respondWithDraft(req, res, req.user, node.plan, { status: 201 });
  } catch (error) { next(error); }
});

router.post("/nodes/:nodeId/custom-exercise", async (req, res, next) => {
  try {
    const node = await getEditableNode(req, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
    if (node.node_type !== "section") return res.status(400).json({ error: "Exercises can only be added to an exercise section." });
    const name = text(req.body?.name);
    if (!name) return res.status(400).json({ error: "Custom exercise name is required." });
    const created = await query(
      `insert into library.exercises (owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name, instruction, image_url, video_url, is_active)
       values ('user', $1, $1, concat('CUSTOM-', substring(gen_random_uuid()::text from 1 for 8)), concat('custom-', gen_random_uuid()), $2, $3, $4, $5, true)
       returning id, name, instruction, image_url, video_url`,
      [req.user.id, name, nullableText(req.body?.instruction), nullableText(req.body?.imageUrl), nullableText(req.body?.videoUrl)],
    );
    const exercise = created.rows[0];
    const order = await nextOrder("plans.plan_items", "plan_session_id", node.plan_session_id, "item_order");
    const ancestry = await getNodeAncestryMeta(node);
    await query(
      `insert into plans.plan_items (
        plan_session_id, plan_node_id, item_type, exercise_id, title, description, image_url, video_url,
        sets, reps, load, item_order, exercise_order,
        domain_name, domain_color, domain_icon_url, domain_short_note, domain_note, domain_order,
        category_name, category_color, category_icon_url, category_short_note, category_note, category_order,
        section_name, section_color, section_icon_url, section_short_note, section_note, section_order
      ) values ($1, $2, 'exercise', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28, $29)`,
      [node.plan_session_id, node.id, exercise.id, exercise.name, exercise.instruction, exercise.image_url, exercise.video_url,
        nullableText(req.body?.sets), nullableText(req.body?.reps), nullableText(req.body?.load), order,
        ancestry.domain?.name || null, ancestry.domain?.color || null, ancestry.domain?.icon_url || null, ancestry.domain?.short_note || null, ancestry.domain?.note || null, ancestry.domain?.node_order ?? null,
        ancestry.category?.name || null, ancestry.category?.color || null, ancestry.category?.icon_url || null, ancestry.category?.short_note || null, ancestry.category?.note || null, ancestry.category?.node_order ?? null,
        ancestry.section?.name || null, ancestry.section?.color || null, ancestry.section?.icon_url || null, ancestry.section?.short_note || null, ancestry.section?.note || null, ancestry.section?.node_order ?? null],
    );
    return respondWithDraft(req, res, req.user, node.plan, { status: 201 });
  } catch (error) { next(error); }
});

// Source resolved with READ/copy access (getCopySourceNode), not edit
// access - a coach doesn't need to be able to EDIT the plan they're
// copying a node FROM, only the one they're pasting INTO (targetSession,
// still getEditableSession/write-access, unchanged). Widening this from
// getEditableNode (its original, same-plan-only shape) is what makes the
// existing same-plan node clipboard/paste mechanism (builder-copy-node /
// renderNodePasteButton) work for a node picked from another plan too,
// with no new clipboard type or paste UI needed - the picker just sets the
// exact same clipboard shape same-plan copy already uses.
router.post("/nodes/:nodeId/copy", async (req, res, next) => {
  try {
    const source = await getCopySourceNode(req, req.params.nodeId);
    const targetSession = await getEditableSession(req, req.body?.targetSessionId);
    if (!source || !targetSession) return res.status(404).json({ error: "Source node or target session not found" });
    const targetParentId = nullableText(req.body?.targetParentId);
    if (targetParentId && !(await isNodeInSession(targetParentId, targetSession.id))) return res.status(400).json({ error: "Target parent is outside target session." });
    if (!(await isAllowedNodePlacement(targetSession.id, targetParentId, source.node_type))) {
      return res.status(400).json({ error: "Choose a compatible target for this copied structure." });
    }
    await copyNodeTree(source.id, targetSession.id, targetParentId);
    return respondWithDraft(req, res, req.user, targetSession.plan, { status: 201 });
  } catch (error) { next(error); }
});

router.patch("/items/:itemId", async (req, res, next) => {
  try {
    const item = await getEditableItem(req, req.params.itemId);
    if (!item) return res.status(404).json({ error: "Program item not found" });
    await query(
      `update plans.plan_items set sets = $2, reps = $3, load = $4, description = $5, updated_at = now() where id = $1`,
      [item.id, nullableText(req.body?.sets), nullableText(req.body?.reps), nullableText(req.body?.load), nullableText(req.body?.description)],
    );
    return respondWithDraft(req, res, req.user, item.plan);
  } catch (error) { next(error); }
});

router.post("/items/:itemId/move", async (req, res, next) => {
  try {
    const item = await getEditableItem(req, req.params.itemId);
    if (!item) return res.status(404).json({ error: "Program item not found" });
    const direction = text(req.body?.direction);
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: "Move direction is required." });
    const comparator = direction === 'up' ? '<' : '>';
    const sort = direction === 'up' ? 'desc' : 'asc';
    const neighborResult = await query(
      `select id, item_order from plans.plan_items where plan_node_id = $1 and item_order ${comparator} $2 order by item_order ${sort} limit 1`,
      [item.plan_node_id, item.item_order],
    );
    const neighbor = neighborResult.rows[0];
    if (!neighbor) return respondWithDraft(req, res, req.user, item.plan);
    await query(
      `update plans.plan_items set item_order = case when id = $1 then $2::numeric when id = $3 then $4::numeric end, updated_at = now() where id in ($1, $3)`,
      [item.id, neighbor.item_order, neighbor.id, item.item_order],
    );
    return respondWithDraft(req, res, req.user, item.plan);
  } catch (error) { next(error); }
});

router.delete("/items/:itemId", async (req, res, next) => {
  try {
    const item = await getEditableItem(req, req.params.itemId);
    if (!item) return res.status(404).json({ error: "Program item not found" });
    await query("delete from plans.plan_items where id = $1", [item.id]);
    return respondWithDraft(req, res, req.user, item.plan);
  } catch (error) { next(error); }
});

async function buildDraft(plan) {
  const result = await query(
    `select pd.id as block_id, pd.block_index, pd.block_name, pd.block_type, pd.date, pd.day_order, pd.day_note,
            ps.id as session_id, ps.am_pm, ps.bta, ps.session_time, ps.session_order, ps.name as session_name, ps.rpe_enabled,
            pn.id as node_id, pn.parent_id, pn.node_type, pn.name as node_name, pn.color, pn.icon_url, pn.short_note, pn.note, pn.node_order,
            pi.id as item_id, pi.exercise_id, pi.title, pi.description, pi.image_url, pi.video_url, pi.sets, pi.reps, pi.load, pi.item_order
     from plans.plan_days pd
     left join plans.plan_sessions ps on ps.plan_day_id = pd.id
     left join plans.plan_nodes pn on pn.plan_session_id = ps.id
     left join plans.plan_items pi on pi.plan_node_id = pn.id
     where pd.plan_id = $1
     order by pd.block_order nulls last, pd.block_index, ps.session_order nulls last, pn.node_order nulls last, pi.item_order nulls last`, [plan.id],
  );
  const blocks = new Map();
  result.rows.forEach((row) => {
    if (!blocks.has(row.block_id)) blocks.set(row.block_id, { id: row.block_id, index: row.block_index, name: row.block_name, type: row.block_type, date: row.date || "", dayOrder: Number(row.day_order || 0), note: row.day_note, sessions: [] });
    const block = blocks.get(row.block_id);
    if (!row.session_id) return;
    let session = block.sessions.find((value) => value.id === row.session_id);
    if (!session) { session = { id: row.session_id, amPm: row.am_pm || "", bta: row.bta || "", time: row.session_time ? String(row.session_time).slice(0, 5) : "", name: row.session_name || "", rpeEnabled: row.rpe_enabled !== false, nodes: [] }; block.sessions.push(session); }
    if (!row.node_id) return;
    let node = session.nodes.find((value) => value.id === row.node_id);
    if (!node) {
      node = { id: row.node_id, parentId: row.parent_id || "", type: row.node_type, name: row.node_name, color: row.color || "", iconUrl: row.icon_url || "", shortNote: row.short_note || "", note: row.note || "", order: Number(row.node_order || 0), items: [] };
      session.nodes.push(node);
    }
    if (row.item_id) node.items.push({ id: row.item_id, exerciseId: row.exercise_id, title: row.title, description: row.description || "", imageUrl: row.image_url || "", videoUrl: row.video_url || "", sets: row.sets || "", reps: row.reps || "", load: row.load || "", itemOrder: Number(row.item_order || 0) });
  });
  return {
    plan: {
      id: plan.id,
      planType: plan.plan_type,
      weekStart: plan.week_start || "",
      name: plan.name,
      note: plan.note || "",
      iconUrl: plan.icon_url || "",
      color: plan.color || "",
      coverImageUrl: plan.cover_image_url || "",
      visibility: plan.visibility || "private",
      isTemplate: plan.is_template,
      athleteId: plan.athlete_source_external_id || plan.athlete_id || "",
      athleteName: plan.athlete_name || "",
      status: plan.status,
      isEditDraft: Boolean(plan.is_edit_draft),
      editSourcePlanId: plan.edit_source_plan_id || "",
      batchId: plan.builder_batch_id || "",
    },
    blocks: [...blocks.values()],
    batch: await loadBuilderBatch(plan),
  };
}

function wantsBatchSync(req, plan) {
  return Boolean(
    !plan?.is_edit_draft &&
    (req.body?.syncBatch === true || req.body?.syncBatch === "true" || req.query?.syncBatch === "1"),
  );
}

async function respondWithDraft(req, res, user, plan, options = {}) {
  const currentPlan = await getEditablePlan(req, plan.id);
  const targetPlan = currentPlan || plan;
  // getEditablePlan() only needs to be called again if syncBatchFromPlan()
  // actually ran and could have changed the plan row it reads back (e.g.
  // builder_batch_id) - on every other mutation (the overwhelming majority)
  // targetPlan is already fresh, so re-fetching it a second time here was a
  // redundant round-trip on every single Builder edit.
  let freshPlan = targetPlan;
  if (wantsBatchSync(req, targetPlan)) {
    await syncBatchFromPlan(targetPlan, user);
    freshPlan = await getEditablePlan(req, targetPlan.id);
  }
  const draft = await buildDraft(freshPlan || targetPlan);
  if (options.status) return res.status(options.status).json(draft);
  return res.json(draft);
}

async function removeEmptyDraftOnSubmit(user, plan, req) {
  if (plan.is_edit_draft || plan.source_type !== "builder" || plan.status !== "draft") return null;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const targets = wantsBatchSync(req, plan) && plan.builder_batch_id
      ? await client.query(
        `select id
         from plans.plans
         where builder_batch_id = $1
           and created_by_user_id = $2
           and source_type = 'builder'
           and status = 'draft'
           and coalesce(is_active, true)
           and not coalesce(is_edit_draft, false)`,
        [plan.builder_batch_id, user.id],
      )
      : { rows: [{ id: plan.id }] };
    const deletedIds = [];
    for (const target of targets.rows) {
      const hasContent = plan.plan_type === "weekly"
        ? await planHasWeeklyTrainingContentWithClient(client, target.id)
        : await planHasBuilderContentWithClient(client, target.id);
      if (hasContent) continue;
      await deletePlanTreeWithClient(client, target.id);
      deletedIds.push(target.id);
    }
    await client.query("commit");
    if (!deletedIds.includes(plan.id)) return null;
    return {
      deleted: true,
      empty: true,
      planId: plan.id,
      deletedIds,
      message: "Empty draft was not saved.",
    };
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

// Training load hardening: batch-sync deletes-and-recreates a sibling's
// ENTIRE session tree from the source plan's own current content, always
// minting a fresh logical_session_id for every recreated session (never
// the source's own - that would make a DIFFERENT athlete's session look
// like it shares identity with the source athlete's one). That's exactly
// right for the ONLY scenario this mechanism was ever meant for: keeping
// not-yet-published sibling DRAFTS in sync with each other while a coach
// is still building a batch-assigned plan, before any of them has a real
// athlete-facing history yet. It is never safe once a sibling is ACTIVE
// (published) - an athlete could already have submitted real RPE against
// one of its real sessions, and wiping the tree would silently orphan
// that result and re-open the recreated session for a second, duplicate
// submission (training_load.session_feedback has no way to know the
// recreated session is "the same" one, since batch-sync never attempts
// the live<->edit-draft style identity-preservation applyEditDraft's own
// round trip does). So this only ever targets DRAFT siblings - an ACTIVE
// or ARCHIVED one is never touched, regardless of what the source plan's
// own status is.
async function syncBatchFromPlan(sourcePlan, user) {
  if (!sourcePlan?.id || sourcePlan.is_edit_draft) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const source = await client.query(
      `select id, builder_batch_id, created_by_user_id, plan_type, week_start, name, note, icon_url, color, start_date, duration_days
       from plans.plans
       where id = $1
         and created_by_user_id = $2
         and coalesce(is_active, true)
         and not coalesce(is_edit_draft, false)`,
      [sourcePlan.id, user.id],
    );
    const sourceRow = source.rows[0];
    if (!sourceRow?.builder_batch_id) {
      await client.query("rollback");
      return;
    }
    const siblings = await client.query(
      `select id, plan_type, week_start
       from plans.plans
       where builder_batch_id = $1
         and id <> $2
         and created_by_user_id = $3
         and coalesce(is_active, true)
         and not coalesce(is_edit_draft, false)
         and status = 'draft'
       order by created_at`,
      [sourceRow.builder_batch_id, sourceRow.id, user.id],
    );
    for (const sibling of siblings.rows) {
      if (sourceRow.plan_type === "weekly") {
        await copyWeeklyPlanTree(client, sourceRow.id, sibling.id, sibling.week_start || sourceRow.week_start);
      } else {
        const blocks = await client.query(
          "select id from plans.plan_days where plan_id = $1 order by block_order nulls last, block_index",
          [sibling.id],
        );
        for (const block of blocks.rows) await deleteBlockTreeWithClient(client, block.id);
        await copyProgramTree(client, sourceRow.id, sibling.id);
      }
      await client.query(
        `update plans.plans
         set name = $2,
             note = $3,
             icon_url = $4,
             color = $5,
             start_date = $6,
             duration_days = $7,
             updated_at = now()
         where id = $1`,
        [sibling.id, sourceRow.name, sourceRow.note, sourceRow.icon_url, sourceRow.color, sourceRow.start_date, sourceRow.duration_days],
      );
    }
    await client.query("commit");
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function applyEditDraft(req, draftPlan) {
  let client;
  try {
    client = await pool.connect();
    await client.query("begin");
    const source = await getEditablePlan(req, draftPlan.edit_source_plan_id);
    if (!source) throw new Error("Original program not found or not editable.");
    const sourceDays = await client.query("select id from plans.plan_days where plan_id = $1", [source.id]);
    for (const day of sourceDays.rows) await deleteBlockTreeWithClient(client, day.id);
    await client.query(
      `update plans.plans
       set name = $2,
           note = $3,
           icon_url = $4,
           color = $5,
           visibility = $6,
           is_template = $7,
           status = 'active',
           updated_at = now()
       where id = $1`,
      [source.id, draftPlan.name, draftPlan.note, draftPlan.icon_url, draftPlan.color, draftPlan.visibility || "private", draftPlan.is_template],
    );
    // preserveLogicalId: true - the SECOND leg of the round trip (see the
    // matching comment on the live -> edit-draft copy in POST /plans/
    // :planId/edit above). Everything else that recreates a weekly plan's
    // session tree (assign/duplicate to a new plan, batch-sync to a
    // sibling plan) is a genuinely different logical session and must
    // never pass this flag.
    if (draftPlan.plan_type === "weekly") await copyWeeklyPlanTree(client, draftPlan.id, source.id, draftPlan.week_start, { preserveLogicalId: true });
    else await copyProgramTree(client, draftPlan.id, source.id);
    const draftDays = await client.query("select id from plans.plan_days where plan_id = $1", [draftPlan.id]);
    for (const day of draftDays.rows) await deleteBlockTreeWithClient(client, day.id);
    await client.query("delete from plans.plans where id = $1", [draftPlan.id]);
    await client.query("commit");
    client.release();
    client = null;
    return await getEditablePlan(req, source.id);
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    throw error;
  }
}

// Copies every day AND every session across those days in two batched
// round trips total, instead of one INSERT per day PLUS one query-then-
// INSERT-per-session for every one of those days (a multi-week program's
// "open for editing"/"save" path used to mean dozens of sequential awaited
// queries just for the day/session skeleton, before a single node or item
// was ever touched - the dominant cost behind Edit/Copy taking 5-10s to
// open the Builder on a large program). Node/item content per session
// still goes through copySessionContent() (itself already a small,
// constant number of round trips per session, per the comment above it).
export async function copyProgramTree(client, sourcePlanId, targetPlanId) {
  const days = await client.query("select * from plans.plan_days where plan_id = $1 order by block_order nulls last, block_index", [sourcePlanId]);
  if (!days.rowCount) return;

  const dayValues = [];
  const dayParams = [];
  let dayColumn = 0;
  days.rows.forEach((day) => {
    const row = [targetPlanId, day.date, day.day_note, day.day_order, day.block_index, day.block_name, day.block_type, day.block_order];
    dayValues.push(`(${row.map(() => `$${++dayColumn}`).join(", ")})`);
    dayParams.push(...row);
  });
  const createdDays = await client.query(
    `insert into plans.plan_days (plan_id, date, day_note, day_order, block_index, block_name, block_type, block_order)
     values ${dayValues.join(", ")} returning id`,
    dayParams,
  );
  const sourceDayIdToTargetDayId = new Map();
  days.rows.forEach((day, index) => sourceDayIdToTargetDayId.set(day.id, createdDays.rows[index].id));

  const sessions = await client.query(
    "select * from plans.plan_sessions where plan_day_id = any($1::uuid[]) order by plan_day_id, session_order",
    [days.rows.map((day) => day.id)],
  );
  if (!sessions.rowCount) return;
  const sessionValues = [];
  const sessionParams = [];
  let sessionColumn = 0;
  sessions.rows.forEach((session) => {
    // rpe_enabled: content property, always copied unconditionally.
    const row = [sourceDayIdToTargetDayId.get(session.plan_day_id), session.am_pm, session.bta, session.session_order, session.name, session.rpe_enabled];
    sessionValues.push(`(${row.map(() => `$${++sessionColumn}`).join(", ")})`);
    sessionParams.push(...row);
  });
  const createdSessions = await client.query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name, rpe_enabled)
     values ${sessionValues.join(", ")} returning id`,
    sessionParams,
  );
  for (let index = 0; index < sessions.rows.length; index++) {
    await copySessionContent(client, sessions.rows[index].id, createdSessions.rows[index].id);
  }
}

async function copyWeeklyPlanTree(client, sourcePlanId, targetPlanId, targetWeekStart, { preserveLogicalId = false } = {}) {
  const existingTargetDays = await client.query("select id from plans.plan_days where plan_id = $1", [targetPlanId]);
  for (const targetDay of existingTargetDays.rows) await deleteBlockTreeWithClient(client, targetDay.id);
  await createWeeklyDays(client, targetPlanId, targetWeekStart);
  const sourceDays = await client.query("select * from plans.plan_days where plan_id = $1 order by day_order, block_index", [sourcePlanId]);
  const targetDays = await client.query("select * from plans.plan_days where plan_id = $1 order by day_order, block_index", [targetPlanId]);
  // Match by weekday alone (day_order normalized to 1=Monday..7=Sunday, the
  // exact convention createWeeklyDays() above just used to create all 7 of
  // targetPlanId's day rows: for loop index 0-6 it inserts day_order =
  // block_index = block_order = index+1 and date = weekStart + index, i.e.
  // date = weekStart + (day_order - 1)) - NOT by the old day_order+block_index
  // compound key. block_index was never a reliable second axis here: it's
  // set equal to day_order by createWeeklyDays(), but some existing weekly
  // plans (older/imported ones) carry a block_index that doesn't follow
  // that (e.g. null), so the old key routinely failed to match a source day
  // to the target weekday slot that (by day_order alone) was already
  // sitting right there - falling into the "insert a new day" branch below
  // for a date that createWeeklyDays() had, by construction, already
  // inserted, and crashing the whole copy on plan_days_plan_date_unique.
  const targetByWeekday = new Map(targetDays.rows.map((day) => [normalizedWeekday(day.day_order), day]));
  for (const sourceDay of sourceDays.rows) {
    const weekday = normalizedWeekday(sourceDay.day_order);
    let targetDay = targetByWeekday.get(weekday);
    if (!targetDay) {
      // Defensive only - createWeeklyDays() above always creates a row for
      // every weekday 1-7 in this same transaction, so every normalized
      // weekday should already have a match.
      const created = await client.query(
        `insert into plans.plan_days (plan_id, date, day_note, day_order, block_index, block_name, block_type, block_order)
         values ($1, $2::date + ($3::integer - 1), $4, $3, $5, $6, $7, $8)
         returning *`,
        [
          targetPlanId,
          targetWeekStart,
          weekday,
          sourceDay.day_note,
          sourceDay.block_index,
          sourceDay.block_name,
          sourceDay.block_type,
          sourceDay.block_order,
        ],
      );
      targetDay = created.rows[0];
      targetByWeekday.set(weekday, targetDay);
    }
    await client.query(
      `update plans.plan_days
       set date = $2::date + ($3::integer - 1),
           block_name = $4,
           block_type = $5,
           day_note = $6,
           block_order = $7,
           updated_at = now()
       where id = $1`,
      [
        targetDay.id,
        targetWeekStart,
        weekday,
        sourceDay.block_name,
        sourceDay.block_type,
        sourceDay.day_note,
        sourceDay.block_order,
      ],
    );
    await deleteDayContentWithClient(client, targetDay.id);
    await copyDaySessions(client, sourceDay.id, targetDay.id, { preserveLogicalId });
  }
}

// A weekly plan's day_order is meant to be the 1-indexed weekday within its
// week (1=Monday..7=Sunday) - see createWeeklyDays() above, the only place
// that creates a weekly plan's day_order values from scratch. Always clamps
// into 1-7 rather than trusting the raw value, since some existing plans
// (older/imported ones) carry day_order outside that range (0, negative, >7).
function normalizedWeekday(dayOrder) {
  const raw = Number(dayOrder) || 0;
  return (((raw - 1) % 7 + 7) % 7) + 1;
}

// Batch-inserts every session of one day in a single round trip instead of
// one INSERT per session (used both by copyWeeklyPlanTree's per-day loop
// below and directly by the day-to-day/cross-plan-block "paste" endpoints,
// where a day with several AM/PM/etc. sessions used to mean one sequential
// awaited query per session before any content was copied).
//
// preserveLogicalId (training_load/RPE hardening): plans.plan_sessions.
// logical_session_id is training_load.session_feedback's own stable
// dedup/lookup key (see migrations_v2/202608320900_..._v2_logical_
// session_identity.sql) - a copy that represents "the SAME real training
// session, just round-tripped through an edit" (the live<->edit-draft
// cycle, see copyWeeklyPlanTree below) must carry the source's own
// logical_session_id forward so an already-submitted RPE result is still
// recognized against the recreated row. Every OTHER copy (a genuinely
// different logical session - assign/duplicate to a new athlete, batch-
// sync to a sibling plan, day-to-day/cross-plan-block paste) must NOT
// inherit it - the default false here simply omits the column from the
// INSERT, so plans.plan_sessions' own `default gen_random_uuid()` mints a
// fresh identity, exactly as a brand-new session would get.
export async function copyDaySessions(client, sourceDayId, targetDayId, { preserveLogicalId = false } = {}) {
  const sessions = await client.query("select * from plans.plan_sessions where plan_day_id = $1 order by session_order", [sourceDayId]);
  if (!sessions.rowCount) return;
  // rpe_enabled is a CONTENT property (like am_pm/bta/name) - always
  // copied, in BOTH branches below. Unlike logical_session_id (an
  // identity mechanism, selectively preserved only for the live<->
  // edit-draft round trip), there is no copy path in this app where
  // silently re-enabling RPE on a session the coach explicitly turned it
  // off for would be the right default.
  const columns = preserveLogicalId
    ? "plan_day_id, am_pm, bta, session_order, name, rpe_enabled, logical_session_id"
    : "plan_day_id, am_pm, bta, session_order, name, rpe_enabled";
  const values = [];
  const params = [];
  let column = 0;
  sessions.rows.forEach((session) => {
    const row = preserveLogicalId
      ? [targetDayId, session.am_pm, session.bta, session.session_order, session.name, session.rpe_enabled, session.logical_session_id]
      : [targetDayId, session.am_pm, session.bta, session.session_order, session.name, session.rpe_enabled];
    values.push(`(${row.map(() => `$${++column}`).join(", ")})`);
    params.push(...row);
  });
  const created = await client.query(
    `insert into plans.plan_sessions (${columns})
     values ${values.join(", ")} returning id`,
    params,
  );
  for (let index = 0; index < sessions.rows.length; index++) {
    await copySessionContent(client, sessions.rows[index].id, created.rows[index].id);
  }
}

async function copyLegacySession(client, sourceSessionId, targetSessionId) {
  const items = await client.query("select * from plans.plan_items where plan_session_id = $1 order by item_order", [sourceSessionId]);
  if (!items.rows.length) return;
  const { nodesToInsert, itemSectionTempId } = planLegacyNodeTree(items.rows);
  const tempIdToRealId = await insertLegacyNodesBatch(client, targetSessionId, nodesToInsert);
  const values = [];
  const params = [];
  let column = 0;
  items.rows.forEach((item) => {
    const sectionId = tempIdToRealId.get(itemSectionTempId.get(item.id));
    const row = [
      targetSessionId, sectionId, item.item_type, item.exercise_id, item.title, item.description, item.short_note, item.note, item.image_url, item.video_url,
      item.sets, item.reps, item.load, item.item_order, item.exercise_order, item.source_row_ref,
      item.domain_name, item.category_name, item.section_name, item.domain_color, item.category_color, item.section_color,
      item.domain_icon_url, item.category_icon_url, item.section_icon_url, item.domain_short_note, item.category_short_note, item.section_short_note,
      item.domain_note, item.category_note, item.section_note, item.domain_order, item.category_order, item.section_order,
    ];
    values.push(`(${row.map(() => `$${++column}`).join(", ")})`);
    params.push(...row);
  });
  await client.query(
    `insert into plans.plan_items (
      plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url,
      sets, reps, load, item_order, exercise_order, source_row_ref,
      domain_name, category_name, section_name, domain_color, category_color, section_color,
      domain_icon_url, category_icon_url, section_icon_url, domain_short_note, category_short_note, section_short_note,
      domain_note, category_note, section_note, domain_order, category_order, section_order
    ) values ${values.join(", ")}`,
    params,
  );
}

// Builds the domain/category/section node tree implied by a flat list of legacy
// (import-sourced) plan_items in one in-memory pass, so the caller can create every
// node with a single batched insert instead of one round-trip per item.
function planLegacyNodeTree(items) {
  const nodesToInsert = [];
  const orderCounters = new Map();
  const keyToTempId = new Map();
  const itemSectionTempId = new Map();

  function ensureNode(parentTempId, type, name, color, iconUrl, shortNote, note) {
    const key = `${parentTempId || "root"}:${type}:${name}`;
    if (keyToTempId.has(key)) return keyToTempId.get(key);
    const counterKey = parentTempId || "root";
    const order = (orderCounters.get(counterKey) || 0) + 1;
    orderCounters.set(counterKey, order);
    const tempId = `t${nodesToInsert.length}`;
    nodesToInsert.push({ tempId, parentTempId: parentTempId || null, type, name, color, iconUrl, shortNote, note, order });
    keyToTempId.set(key, tempId);
    return tempId;
  }

  for (const item of items) {
    let parentTempId = null;
    if (item.domain_name) {
      parentTempId = ensureNode(null, "domain", item.domain_name, item.domain_color, item.domain_icon_url, item.domain_short_note, item.domain_note);
    }
    if (item.category_name) {
      parentTempId = ensureNode(parentTempId, "category", item.category_name, item.category_color, item.category_icon_url, item.category_short_note, item.category_note);
    }
    const sectionName = item.section_name || item.category_name || item.domain_name || "General";
    const sectionColor = item.section_name ? item.section_color : item.category_name ? item.category_color : item.domain_color;
    const sectionIcon = item.section_name ? item.section_icon_url : item.category_name ? item.category_icon_url : item.domain_icon_url;
    const sectionShortNote = item.section_name ? item.section_short_note : item.category_name ? item.category_short_note : item.domain_short_note;
    const sectionNote = item.section_name ? item.section_note : item.category_name ? item.category_note : item.domain_note;
    const sectionTempId = ensureNode(parentTempId, "section", sectionName, sectionColor, sectionIcon, sectionShortNote, sectionNote);
    itemSectionTempId.set(item.id, sectionTempId);
  }

  return { nodesToInsert, itemSectionTempId };
}

// Inserts a planned legacy node tree (see planLegacyNodeTree) in at most 3 batched
// round-trips (domain, then category, then section), resolving each level's
// parent_id from the previous level's real ids before inserting the next.
async function insertLegacyNodesBatch(client, sessionId, nodesToInsert) {
  const tempIdToRealId = new Map();
  for (const type of ["domain", "category", "section"]) {
    const batch = nodesToInsert.filter((node) => node.type === type);
    if (!batch.length) continue;
    const values = [];
    const params = [];
    let column = 0;
    batch.forEach((node) => {
      const parentRealId = node.parentTempId ? tempIdToRealId.get(node.parentTempId) : null;
      const row = [sessionId, parentRealId, node.type, node.name, node.color, node.iconUrl, node.shortNote, node.note, node.order];
      values.push(`(${row.map(() => `$${++column}`).join(", ")})`);
      params.push(...row);
    });
    const created = await client.query(
      `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
       values ${values.join(", ")} returning id`,
      params,
    );
    batch.forEach((node, index) => tempIdToRealId.set(node.tempId, created.rows[index].id));
  }
  return tempIdToRealId;
}

// Imported plans store their original grouping on each item. The first direct
// edit turns that grouping into the Builder node tree without copying the plan.
async function materializeLegacyPlan(client, planId) {
  const sessions = await client.query(
    `select ps.id
     from plans.plan_sessions ps
     join plans.plan_days pd on pd.id = ps.plan_day_id
     where pd.plan_id = $1
       and not exists (select 1 from plans.plan_nodes pn where pn.plan_session_id = ps.id)`,
    [planId],
  );
  for (const session of sessions.rows) {
    const items = await client.query("select * from plans.plan_items where plan_session_id = $1 order by item_order", [session.id]);
    if (!items.rows.length) continue;
    const { nodesToInsert, itemSectionTempId } = planLegacyNodeTree(items.rows);
    const tempIdToRealId = await insertLegacyNodesBatch(client, session.id, nodesToInsert);
    const values = [];
    const params = [];
    let column = 0;
    items.rows.forEach((item) => {
      const sectionId = tempIdToRealId.get(itemSectionTempId.get(item.id));
      values.push(`($${++column}, $${++column})`);
      params.push(item.id, sectionId);
    });
    await client.query(
      `update plans.plan_items as pi
       set plan_node_id = v.node_id::uuid, updated_at = now()
       from (values ${values.join(", ")}) as v(item_id, node_id)
       where pi.id = v.item_id::uuid`,
      params,
    );
  }
}

// Copies an entire session's node/item tree from source to target in a
// small, constant number of batched round-trips, instead of the one
// round-trip per node PLUS one round-trip per item that the recursive
// copyNodeTreeWithClient()/copyPlanItem() functions this replaced used to
// need (a program with dozens of domains/categories/sections/exercises
// meant hundreds of sequential awaited queries for a single block/program/
// weekly-plan copy - the dominant cost in both "open an existing program
// for editing" and "save"/"re-save", both of which copy the whole tree via
// this same path). Falls back to copyLegacySession() for a session that has
// items but no node tree yet (an import that was never opened in the
// Builder), exactly as the three callers' own pre-inlined checks used to.
//
// Node order is preserved exactly as-is from the source (node_order is a
// numeric column used only for sorting, tolerant of arbitrary/fractional
// values elsewhere in the app for exactly this reason - e.g. "move between"
// - so copying it verbatim instead of recomputing a fresh sequential value
// changes nothing observable) instead of recomputing a fresh value per node
// with an extra query, which is what this replaced.
export async function copySessionContent(client, sourceSessionId, targetSessionId) {
  const nodesResult = await client.query("select * from plans.plan_nodes where plan_session_id = $1 order by node_order", [sourceSessionId]);
  if (!nodesResult.rowCount) {
    await copyLegacySession(client, sourceSessionId, targetSessionId);
    return;
  }

  const nodesByParent = new Map();
  for (const sourceNode of nodesResult.rows) {
    const parentKey = sourceNode.parent_id || "root";
    if (!nodesByParent.has(parentKey)) nodesByParent.set(parentKey, []);
    nodesByParent.get(parentKey).push(sourceNode);
  }

  // Insert level by level (root nodes, then their children, then
  // grandchildren, ...) so each level's parent_id can be resolved from the
  // PREVIOUS level's real ids in one batched INSERT per level.
  const sourceIdToTargetId = new Map();
  let parentKeysAtThisLevel = ["root"];
  while (parentKeysAtThisLevel.length) {
    const levelNodes = parentKeysAtThisLevel.flatMap((parentKey) => nodesByParent.get(parentKey) || []);
    if (!levelNodes.length) break;
    const values = [];
    const params = [];
    let column = 0;
    levelNodes.forEach((sourceNode) => {
      const targetParentId = sourceNode.parent_id ? sourceIdToTargetId.get(sourceNode.parent_id) : null;
      const row = [targetSessionId, targetParentId, sourceNode.node_type, sourceNode.name, sourceNode.color, sourceNode.icon_url, sourceNode.short_note, sourceNode.note, sourceNode.node_order];
      values.push(`(${row.map(() => `$${++column}`).join(", ")})`);
      params.push(...row);
    });
    const created = await client.query(
      `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
       values ${values.join(", ")} returning id`,
      params,
    );
    levelNodes.forEach((sourceNode, index) => sourceIdToTargetId.set(sourceNode.id, created.rows[index].id));
    parentKeysAtThisLevel = levelNodes.map((sourceNode) => sourceNode.id);
  }

  const itemsResult = await client.query(
    "select * from plans.plan_items where plan_session_id = $1 and plan_node_id is not null order by item_order",
    [sourceSessionId],
  );
  if (!itemsResult.rowCount) return;
  const values = [];
  const params = [];
  let column = 0;
  itemsResult.rows.forEach((item) => {
    const targetNodeId = sourceIdToTargetId.get(item.plan_node_id);
    if (!targetNodeId) return; // orphaned reference - copyNodeTreeWithClient never reached these either
    const row = [
      targetSessionId, targetNodeId, item.item_type, item.exercise_id, item.title, item.description, item.short_note, item.note, item.image_url, item.video_url,
      item.sets, item.reps, item.load, item.item_order, item.exercise_order, item.source_row_ref,
      item.domain_name, item.category_name, item.section_name, item.domain_color, item.category_color, item.section_color,
      item.domain_icon_url, item.category_icon_url, item.section_icon_url, item.domain_short_note, item.category_short_note, item.section_short_note,
      item.domain_note, item.category_note, item.section_note, item.domain_order, item.category_order, item.section_order,
    ];
    values.push(`(${row.map(() => `$${++column}`).join(", ")})`);
    params.push(...row);
  });
  if (!values.length) return;
  await client.query(
    `insert into plans.plan_items (
      plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url,
      sets, reps, load, item_order, exercise_order, source_row_ref,
      domain_name, category_name, section_name, domain_color, category_color, section_color,
      domain_icon_url, category_icon_url, section_icon_url, domain_short_note, category_short_note, section_short_note,
      domain_note, category_note, section_note, domain_order, category_order, section_order
    ) values ${values.join(", ")}`,
    params,
  );
}

async function copyNodeTree(sourceId, targetSessionId, targetParentId) {
  const nodeResult = await query("select * from plans.plan_nodes where id = $1", [sourceId]);
  const source = nodeResult.rows[0];
  if (!source) return;
  const order = await nextNodeOrder(targetSessionId, targetParentId);
  const created = await query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [targetSessionId, targetParentId, source.node_type, source.name, source.color, source.icon_url, source.short_note, source.note, order],
  );
  const newNodeId = created.rows[0].id;
  const ancestry = await getNodeAncestryMeta({
    node_type: source.node_type, parent_id: targetParentId, name: source.name,
    color: source.color, icon_url: source.icon_url, short_note: source.short_note, note: source.note, node_order: order,
  });
  const sourceItems = await query("select * from plans.plan_items where plan_node_id = $1 order by item_order", [sourceId]);
  for (const item of sourceItems.rows) {
    const itemOrder = await nextOrder("plans.plan_items", "plan_session_id", targetSessionId, "item_order");
    await query(
      `insert into plans.plan_items (
        plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url,
        sets, reps, load, item_order, exercise_order,
        domain_name, domain_color, domain_icon_url, domain_short_note, domain_note, domain_order,
        category_name, category_color, category_icon_url, category_short_note, category_note, category_order,
        section_name, section_color, section_icon_url, section_short_note, section_note, section_order
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,
        $15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30,$31,$32)`,
      [targetSessionId, newNodeId, item.item_type, item.exercise_id, item.title, item.description, item.short_note, item.note, item.image_url, item.video_url, item.sets, item.reps, item.load, itemOrder,
        ancestry.domain?.name || null, ancestry.domain?.color || null, ancestry.domain?.icon_url || null, ancestry.domain?.short_note || null, ancestry.domain?.note || null, ancestry.domain?.node_order ?? null,
        ancestry.category?.name || null, ancestry.category?.color || null, ancestry.category?.icon_url || null, ancestry.category?.short_note || null, ancestry.category?.note || null, ancestry.category?.node_order ?? null,
        ancestry.section?.name || null, ancestry.section?.color || null, ancestry.section?.icon_url || null, ancestry.section?.short_note || null, ancestry.section?.note || null, ancestry.section?.node_order ?? null],
    );
  }
  const children = await query("select id from plans.plan_nodes where parent_id = $1 order by node_order", [sourceId]);
  for (const child of children.rows) await copyNodeTree(child.id, targetSessionId, newNodeId);
}

async function deleteBlockTree(blockId) {
  const sessions = await query("select id from plans.plan_sessions where plan_day_id = $1", [blockId]);
  for (const session of sessions.rows) await deleteSessionTree(session.id);
  await query("delete from plans.plan_days where id = $1", [blockId]);
}

async function deleteBlockTreeWithClient(client, blockId) {
  await deleteDayContentWithClient(client, blockId);
  await client.query("delete from plans.plan_days where id = $1", [blockId]);
}

// Any session at all counts as "has content" - even an empty session is a
// real planning decision a paste would silently destroy. Deliberately
// simpler than planHasBuilderContentWithClient/planHasWeeklyTrainingContentWithClient
// below (which also weigh day_note/block_name for a whole PLAN's "is this
// basically empty" question) - a day-to-day paste only ever replaces
// sessions/nodes/items, never the day's own date/day_note/day_order, so
// only sessions are relevant here.
async function dayHasContentWithClient(client, dayId) {
  const result = await client.query("select exists (select 1 from plans.plan_sessions where plan_day_id = $1) as has_content", [dayId]);
  return result.rows[0]?.has_content === true;
}

async function deleteDayContentWithClient(client, dayId) {
  const sessions = await client.query("select id from plans.plan_sessions where plan_day_id = $1", [dayId]);
  for (const session of sessions.rows) {
    await client.query("delete from plans.plan_items where plan_session_id = $1", [session.id]);
    await client.query("delete from plans.plan_nodes where plan_session_id = $1", [session.id]);
    await client.query("delete from plans.plan_sessions where id = $1", [session.id]);
  }
}

async function deletePlanTreeWithClient(client, planId) {
  const blocks = await client.query("select id from plans.plan_days where plan_id = $1", [planId]);
  for (const block of blocks.rows) await deleteBlockTreeWithClient(client, block.id);
  await client.query("delete from plans.plans where id = $1", [planId]);
}

async function planHasBuilderContentWithClient(client, planId) {
  const result = await client.query(
    `select exists (
       select 1
       from plans.plan_items pi
       join plans.plan_sessions ps on ps.id = pi.plan_session_id
       join plans.plan_days pd on pd.id = ps.plan_day_id
       where pd.plan_id = $1
     ) or exists (
       select 1
       from plans.plan_days pd
       join plans.plans p on p.id = pd.plan_id
       where pd.plan_id = $1
         and (
           nullif(trim(coalesce(pd.day_note, '')), '') is not null
           or nullif(trim(coalesce(pd.block_name, '')), '') is not null
           or (p.plan_type <> 'weekly' and coalesce(pd.block_type, 'session') <> 'session')
         )
     ) as has_content`,
    [planId],
  );
  return result.rows[0]?.has_content === true;
}

// A weekly plan counts as having content if it has at least one real
// plan_item OR at least one meaningfully-named plan_node - a coach who
// plans an entirely organizational day (e.g. an empty "Massage" domain,
// with no exercises under it) has still made a real planning decision, and
// submitting must not silently delete it. The plan_nodes.name IS NOT NULL
// column can never actually be blank today (POST /sessions/:sessionId/nodes
// rejects an empty name with 400 at creation time), but the
// nullif(trim(...)) guard is kept anyway so a node would still have to earn
// a real user-given name to count, rather than relying solely on that
// write-path validation remaining unchanged forever.
export async function planHasWeeklyTrainingContentWithClient(client, planId) {
  const result = await client.query(
    `select exists (
       select 1
       from plans.plan_items pi
       join plans.plan_sessions ps on ps.id = pi.plan_session_id
       join plans.plan_days pd on pd.id = ps.plan_day_id
       where pd.plan_id = $1
     ) or exists (
       select 1
       from plans.plan_nodes pn
       join plans.plan_sessions ps on ps.id = pn.plan_session_id
       join plans.plan_days pd on pd.id = ps.plan_day_id
       where pd.plan_id = $1
         and nullif(trim(coalesce(pn.name, '')), '') is not null
     ) as has_content`,
    [planId],
  );
  return result.rows[0]?.has_content === true;
}

async function deleteSessionTree(sessionId) {
  await query("delete from plans.plan_items where plan_session_id = $1", [sessionId]);
  await query("delete from plans.plan_nodes where plan_session_id = $1", [sessionId]);
  await query("delete from plans.plan_sessions where id = $1", [sessionId]);
}

async function deleteNodeTree(nodeId) {
  await query(
    `with recursive node_tree as (
       select id from plans.plan_nodes where id = $1
       union all
       select child.id from plans.plan_nodes child join node_tree parent on child.parent_id = parent.id
     ) delete from plans.plan_items where plan_node_id in (select id from node_tree)`, [nodeId],
  );
  await query("delete from plans.plan_nodes where id = $1", [nodeId]);
}

async function getEditablePlan(req, planId) {
  const result = await query(
    `select p.id, p.plan_type, p.week_start, p.name, p.note, p.icon_url, p.color, p.cover_image_url, p.visibility, p.is_template, p.status,
            p.source_type, p.start_date, p.duration_days, p.athlete_id as athlete_uuid, p.is_edit_draft, p.edit_source_plan_id,
            p.builder_batch_id,
            a.athlete_id, a.source_external_id as athlete_source_external_id,
            coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name)) as athlete_name
     from plans.plans p left join public.athletes a on a.id = p.athlete_id
     where p.id = $1
       and p.plan_type in ('program', 'weekly')
       and (
         p.created_by_user_id = $2
         or $3::boolean
         or exists (
           select 1
           from public.athletes managed_athlete
           where managed_athlete.id = p.athlete_id
             and ${athleteAccessPredicate("managed_athlete", "$2")}
         )
       )`, [planId, req.user.id, canAccessAllAthletes(req)],
  );
  return result.rows[0] || null;
}

async function getCopySource(req, planId) {
  if (!(await canAccessPlan(query, req, planId))) return null;
  const result = await query(
    // `is_active = true` alone excludes a plan's own currently-open edit
    // draft (POST /plans/:planId/edit inserts that hidden row with
    // is_active = FALSE on purpose, so it never shows up in normal plan
    // listings - see that route's insert a few hundred lines down). That
    // row is exactly what a coach is looking at while copying/pasting
    // within (or out of) the plan they're actively editing, so it must
    // still be a valid copy source. Every other plan-access query in this
    // file already treats is_active permissively (coalesce(is_active,
    // true)) - this one extra `or is_edit_draft = true` is what was
    // missing when getCopySource/getCopySourceNode/getCopySourceSession/
    // getCopySourceBlock were introduced, and is the root cause of
    // "Source node or target session not found" on same-plan AND
    // cross-plan copy alike, whenever the source plan had been edited
    // and re-opened at least once (i.e. almost always, for anything but a
    // brand-new never-yet-saved draft).
    `select id, created_by_user_id, athlete_id, plan_type, name, note, icon_url, color, is_template, start_date, duration_days, can_copy, can_edit_copy
     from plans.plans
     where id = $1 and plan_type in ('program', 'weekly') and (coalesce(is_active, true) or is_edit_draft = true)`,
    [planId],
  );
  return result.rows[0] || null;
}

// Same "this template opted out of being copied" rule POST /plans/:id/duplicate
// already enforces (line ~166 above) - reused here so Phase 2's block-copy
// picker/paste can never bypass it just because it reads at the block level
// instead of the whole-plan level.
function canCopyFromPlan(req, plan) {
  if (!plan) return false;
  if (plan.is_template && plan.can_copy === false && !canAccessAllAthletes(req) && String(plan.created_by_user_id) !== String(req.user.id)) return false;
  return true;
}

async function getCopySourceBlock(req, blockId) {
  const result = await query("select pd.id, pd.plan_id from plans.plan_days pd where pd.id = $1", [blockId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getCopySource(req, row.plan_id);
  if (!plan || !canCopyFromPlan(req, plan)) return null;
  return { id: row.id, plan };
}

// Read/copy-access counterparts of getEditableSession/getEditableNode below
// - byte-for-byte the same join path, but resolving the plan via
// getCopySource + canCopyFromPlan instead of getEditablePlan, exactly how
// getCopySourceBlock above already mirrors getEditableBlock. Power the
// session/node drill-down steps of the "Copy from another plan" picker
// (session and node-level copy only ever need to READ the source plan, not
// edit it) and, for getCopySourceNode, widen POST /nodes/:nodeId/copy so
// the existing same-plan node clipboard/paste mechanism works cross-plan
// too, with zero new clipboard type.
async function getCopySourceSession(req, sessionId) {
  const result = await query(
    "select ps.id, ps.am_pm, ps.bta, ps.session_time, ps.name, ps.rpe_enabled, pd.plan_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where ps.id = $1",
    [sessionId],
  );
  const row = result.rows[0]; if (!row) return null;
  const plan = await getCopySource(req, row.plan_id);
  if (!plan || !canCopyFromPlan(req, plan)) return null;
  return { ...row, plan };
}

async function getCopySourceNode(req, nodeId) {
  const result = await query(
    "select pn.id, pn.plan_session_id, pn.parent_id, pn.node_type, pn.name, pn.color, pn.icon_url, pn.short_note, pn.note, pn.node_order, pd.plan_id from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pn.id = $1",
    [nodeId],
  );
  const row = result.rows[0]; if (!row) return null;
  const plan = await getCopySource(req, row.plan_id);
  if (!plan || !canCopyFromPlan(req, plan)) return null;
  return { ...row, plan };
}

async function requirePlan(req, planId, res) {
  const plan = await getEditablePlan(req, planId);
  if (!plan) { res.status(404).json({ error: "Draft program not found" }); return null; }
  return plan;
}

async function getEditableBlock(req, blockId) {
  const result = await query("select pd.id, pd.plan_id from plans.plan_days pd where pd.id = $1", [blockId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(req, row.plan_id); return plan ? { id: row.id, plan } : null;
}

async function getEditableSession(req, sessionId) {
  const result = await query("select ps.id, ps.am_pm, ps.bta, ps.session_time, ps.name, ps.rpe_enabled, pd.plan_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where ps.id = $1", [sessionId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(req, row.plan_id);
  return plan ? { id: row.id, am_pm: row.am_pm, bta: row.bta, session_time: row.session_time, name: row.name, rpe_enabled: row.rpe_enabled, plan } : null;
}

async function getEditableNode(req, nodeId) {
  const result = await query("select pn.id, pn.plan_session_id, pn.parent_id, pn.node_type, pn.name, pn.color, pn.icon_url, pn.short_note, pn.note, pn.node_order, pd.plan_id from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pn.id = $1", [nodeId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(req, row.plan_id); return plan ? { ...row, plan } : null;
}

async function getNodeAncestryMeta(node) {
  const chain = { section: null, category: null, domain: null };
  let current = node;
  while (current) {
    if (current.node_type === "section" || current.node_type === "category" || current.node_type === "domain") {
      chain[current.node_type] = current;
    }
    if (!current.parent_id) break;
    const parentResult = await query(
      "select id, parent_id, node_type, name, color, icon_url, short_note, note, node_order from plans.plan_nodes where id = $1",
      [current.parent_id],
    );
    current = parentResult.rows[0] || null;
  }
  return chain;
}

async function getEditableItem(req, itemId) {
  const result = await query("select pi.id, pi.plan_node_id, pi.item_order, pd.plan_id from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pi.id = $1", [itemId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(req, row.plan_id); return plan ? { id: row.id, plan_node_id: row.plan_node_id, item_order: row.item_order, plan } : null;
}

async function findAthlete(externalId) {
  const result = await query(
    "select id, coalesce(is_active, true) as is_active from public.athletes where athlete_id = $1 or source_external_id = $1 limit 1",
    [externalId],
  );
  return result.rows[0] || null;
}

function requestedAthleteIds(body) {
  const ids = Array.isArray(body?.athleteIds) ? body.athleteIds : [];
  const withFallback = [...ids, body?.athleteId].map(text).filter(Boolean);
  return [...new Set(withFallback)];
}

async function findRequestedAthletes(externalIds) {
  const athletes = [];
  const missing = [];
  const archived = [];
  for (const externalId of externalIds) {
    const athlete = await findAthlete(externalId);
    if (!athlete) missing.push(externalId);
    else if (!athlete.is_active) archived.push(externalId);
    else athletes.push({ ...athlete, externalId });
  }
  return { athletes, missing, archived };
}

async function ensureWeeklySlot(client, userId, athlete, weekStart) {
  if (!athlete?.id) return "Choose an athlete for a weekly plan.";
  const existing = await client.query(
    `select p.id, p.created_by_user_id, p.source_type, p.status
     from plans.plans p
     where p.plan_type = 'weekly' and p.athlete_id = $1 and p.week_start = $2
       and coalesce(p.is_active, true)
       and not coalesce(p.is_edit_draft, false)
     order by p.created_at`,
    [athlete.id, weekStart],
  );

  for (const existingPlan of existing.rows) {
    if (
      existingPlan.source_type === "builder"
      && String(existingPlan.created_by_user_id) === String(userId)
    ) {
      const hasContent = await planHasWeeklyTrainingContentWithClient(client, existingPlan.id);
      if (!hasContent) {
        await deletePlanTreeWithClient(client, existingPlan.id);
        continue;
      }
    }
    return `Athlete ${athlete.externalId || athlete.id} already has a weekly plan for that week.`;
  }
  return "";
}

async function loadBuilderBatch(plan) {
  if (!plan.builder_batch_id) return null;
  const result = await query(
    `select p.id, p.name, p.plan_type, p.week_start, p.status,
            a.athlete_id, a.source_external_id as athlete_source_external_id,
            coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.source_external_id, a.athlete_id::text) as athlete_name
     from plans.plans p
     left join public.athletes a on a.id = p.athlete_id
     where p.builder_batch_id = $1
       and coalesce(p.is_active, true)
       and not coalesce(p.is_edit_draft, false)
     order by coalesce(a.athlete_id::text, a.source_external_id, p.name), p.created_at`,
    [plan.builder_batch_id],
  );
  return {
    id: plan.builder_batch_id,
    plans: result.rows.map((row) => ({
      id: row.id,
      name: row.name || "",
      planType: row.plan_type,
      weekStart: row.week_start || "",
      status: row.status || "",
      athleteId: row.athlete_source_external_id || row.athlete_id || "",
      athleteName: row.athlete_name || "Reusable template",
    })),
  };
}

async function isNodeInSession(nodeId, sessionId) {
  const result = await query("select 1 from plans.plan_nodes where id = $1 and plan_session_id = $2", [nodeId, sessionId]);
  return result.rowCount > 0;
}

async function isAllowedNodePlacement(sessionId, parentId, nodeType) {
  if (!parentId) return true;
  const result = await query("select node_type from plans.plan_nodes where id = $1 and plan_session_id = $2", [parentId, sessionId]);
  const parentType = result.rows[0]?.node_type;
  if (parentType === "domain") return nodeType === "category" || nodeType === "section";
  if (parentType === "category") return nodeType === "section";
  return false;
}

async function nextOrder(table, field, value, orderColumn) {
  const result = await query(`select coalesce(max(${orderColumn}), 0) + 1 as next_value from ${table} where ${field} = $1`, [value]);
  return Number(result.rows[0].next_value);
}

async function nextNodeOrder(sessionId, parentId) {
  const result = await query("select coalesce(max(node_order), 0) + 1 as next_value from plans.plan_nodes where plan_session_id = $1 and parent_id is not distinct from $2", [sessionId, parentId]);
  return Number(result.rows[0].next_value);
}

async function createWeeklyDays(client, planId, weekStart) {
  for (let index = 0; index < 7; index += 1) {
    await client.query(
      `insert into plans.plan_days (plan_id, date, day_order, block_index, block_order, block_name, block_type)
       values ($1, $2::date + $3::integer, $4::numeric, $4::integer, $4::numeric, null, 'session')`,
      [planId, weekStart, index, index + 1],
    );
  }
}

function normalizedWeekStart(value) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function text(value) { return String(value || "").trim(); }
function nullableText(value) { return text(value) || null; }
function phaseValue(value, allowed) { const clean = text(value).toUpperCase(); return allowed.includes(clean) ? clean : null; }
function sessionTimeValue(value) { return /^\d{2}:\d{2}$/.test(text(value)) ? text(value) : null; }

export default router;
