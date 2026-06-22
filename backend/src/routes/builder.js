import { Router } from "express";
import { pool, query } from "../db.js";

const router = Router();
const NODE_TYPES = new Set(["domain", "category", "section"]);

router.get("/plans/:planId", async (req, res, next) => {
  try {
    const plan = await getEditablePlan(req.user, req.params.planId);
    if (!plan) return res.status(404).json({ error: "Draft program not found" });
    res.json(await buildDraft(plan));
  } catch (error) { next(error); }
});

router.post("/plans", async (req, res, next) => {
  let client;
  try {
    const requestedName = text(req.body?.name);
    const athleteExternalId = text(req.body?.athleteId);
    const planType = text(req.body?.planType) === "weekly" ? "weekly" : "program";
    const weekStart = planType === "weekly" ? normalizedWeekStart(req.body?.weekStart) : null;
    // An unassigned program draft is the reusable-template workflow. Weekly
    // plans are always assigned to one athlete and one calendar week.
    const isTemplate = planType === "program" && !athleteExternalId;
    if (planType === "program" && !requestedName) return res.status(400).json({ error: "Program name is required." });
    if (planType === "weekly" && !athleteExternalId) return res.status(400).json({ error: "Choose an athlete for a weekly plan." });
    if (planType === "weekly" && !weekStart) return res.status(400).json({ error: "Choose a valid date for the weekly plan." });
    const name = requestedName || `Weekly plan ${weekStart}`;
    const athlete = athleteExternalId ? await findAthlete(athleteExternalId) : null;
    if (athleteExternalId && !athlete) return res.status(404).json({ error: "Athlete not found." });
    client = await pool.connect();
    await client.query("begin");
    if (planType === "weekly") {
      const existing = await client.query(
        `select p.id, p.created_by_user_id, p.source_type, p.status, count(pd.id)::int as day_count
         from plans.plans p left join plans.plan_days pd on pd.plan_id = p.id
         where p.plan_type = 'weekly' and p.athlete_id = $1 and p.week_start = $2
         group by p.id, p.created_by_user_id, p.source_type, p.status
         limit 1`,
        [athlete.id, weekStart],
      );
      const existingPlan = existing.rows[0];
      if (existingPlan?.day_count === 0 && existingPlan.source_type === "builder" && existingPlan.status === "draft" && String(existingPlan.created_by_user_id) === String(req.user.id)) {
        await client.query("delete from plans.plans where id = $1", [existingPlan.id]);
      } else if (existingPlan) {
        await client.query("rollback");
        client.release();
        client = null;
        return res.status(409).json({ error: "This athlete already has a weekly plan for that week." });
      }
    }
    const created = await client.query(
      `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, visibility, is_template, status, source_type, week_start)
       values ($1, $2, $3, $4, $5, $6, $7, 'private', $8, 'draft', 'builder', $9) returning id`,
      [planType, req.user.id, athlete?.id || null, name, nullableText(req.body?.note), nullableText(req.body?.iconUrl), nullableText(req.body?.color), isTemplate, weekStart],
    );
    if (planType === "weekly") await createWeeklyDays(client, created.rows[0].id, weekStart);
    await client.query("commit");
    client.release();
    client = null;
    res.status(201).json(await buildDraft(await getEditablePlan(req.user, created.rows[0].id)));
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
      client.release();
    }
    next(error);
  }
});

router.post("/plans/:planId/submit", async (req, res, next) => {
  try {
    const plan = await requirePlan(req.user, req.params.planId, res);
    if (!plan) return;
    await query("update plans.plans set status = 'published', updated_at = now() where id = $1", [plan.id]);
    res.json(await buildDraft(await getEditablePlan(req.user, plan.id)));
  } catch (error) { next(error); }
});

router.post("/plans/:planId/duplicate", async (req, res, next) => {
  let client;
  try {
    const source = await getCopySource(req.params.planId);
    if (!source) return res.status(404).json({ error: "Program or template not found." });
    const targetAthleteExternalId = text(req.body?.athleteId);
    const targetAthlete = targetAthleteExternalId ? await findAthlete(targetAthleteExternalId) : null;
    if (targetAthleteExternalId && !targetAthlete) return res.status(404).json({ error: "Athlete not found." });
    const targetWeekStart = source.plan_type === "weekly" ? normalizedWeekStart(req.body?.weekStart) : null;
    if (source.plan_type === "weekly" && !targetAthlete) return res.status(400).json({ error: "Choose an athlete for a weekly plan copy." });
    if (source.plan_type === "weekly" && !targetWeekStart) return res.status(400).json({ error: "Choose the target week for this copy." });
    const isTemplate = source.plan_type === "program" && !targetAthlete;
    client = await pool.connect();
    await client.query("begin");
    if (source.plan_type === "weekly") {
      const existing = await client.query(
        "select 1 from plans.plans where plan_type = 'weekly' and athlete_id = $1 and week_start = $2 limit 1",
        [targetAthlete.id, targetWeekStart],
      );
      if (existing.rowCount) {
        await client.query("rollback");
        client.release();
        client = null;
        return res.status(409).json({ error: "This athlete already has a weekly plan for that week." });
      }
    }
    const created = await client.query(
      `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, note, icon_url, color, visibility, is_template, status, source_type, start_date, duration_days, week_start)
       values ($1, $2, $3, $4, $5, $6, $7, 'private', $8, 'draft', 'builder', $9, $10, $11)
       returning id`,
      [source.plan_type, req.user.id, targetAthlete?.id || null, `${source.name || "Program"} copy`, source.note, source.icon_url, source.color, isTemplate, source.start_date, source.duration_days, targetWeekStart],
    );
    if (source.plan_type === "weekly") await copyWeeklyPlanTree(client, source.id, created.rows[0].id, targetWeekStart);
    else await copyProgramTree(client, source.id, created.rows[0].id);
    await client.query("commit");
    client.release();
    client = null;
    res.status(201).json(await buildDraft(await getEditablePlan(req.user, created.rows[0].id)));
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
    const plan = await getEditablePlan(req.user, req.params.planId);
    if (!plan) return res.status(404).json({ error: "Program not found or not editable." });
    client = await pool.connect();
    await client.query("begin");
    await materializeLegacyPlan(client, plan.id);
    await client.query("commit");
    client.release();
    client = null;
    res.json(await buildDraft(plan));
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
    const plan = await requirePlan(req.user, req.params.planId, res);
    if (!plan) return;
    const blocks = await query("select id from plans.plan_days where plan_id = $1", [plan.id]);
    for (const block of blocks.rows) await deleteBlockTree(block.id);
    await query("delete from plans.plans where id = $1", [plan.id]);
    res.json({ deleted: true, planId: plan.id });
  } catch (error) { next(error); }
});

router.post("/plans/:planId/blocks", async (req, res, next) => {
  try {
    const plan = await requirePlan(req.user, req.params.planId, res);
    if (!plan) return;
    if (plan.plan_type === "weekly") return res.status(400).json({ error: "Weekly plans already contain seven calendar days." });
    const next = await nextOrder("plans.plan_days", "plan_id", plan.id, "block_order");
    await query(
      `insert into plans.plan_days (plan_id, block_index, block_order, block_name, block_type, day_note)
       values ($1, $2, $3, $4, $5, $6)`,
      [plan.id, next, next, text(req.body?.name) || `Block ${next}`, text(req.body?.type) || "session", nullableText(req.body?.note)],
    );
    res.status(201).json(await buildDraft(plan));
  } catch (error) { next(error); }
});

router.delete("/blocks/:blockId", async (req, res, next) => {
  try {
    const block = await getEditableBlock(req.user, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Program block not found" });
    if (block.plan.plan_type === "weekly") return res.status(400).json({ error: "Weekly plan days cannot be deleted." });
    await deleteBlockTree(block.id);
    res.json(await buildDraft(block.plan));
  } catch (error) { next(error); }
});

router.patch("/blocks/:blockId", async (req, res, next) => {
  try {
    const block = await getEditableBlock(req.user, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Program block not found" });
    await query(
      "update plans.plan_days set block_name = $2, day_note = $3, updated_at = now() where id = $1",
      [block.id, nullableText(req.body?.name), nullableText(req.body?.note)],
    );
    res.json(await buildDraft(block.plan));
  } catch (error) { next(error); }
});

router.post("/blocks/:blockId/sessions", async (req, res, next) => {
  try {
    const block = await getEditableBlock(req.user, req.params.blockId);
    if (!block) return res.status(404).json({ error: "Program block not found" });
    const order = await nextOrder("plans.plan_sessions", "plan_day_id", block.id, "session_order");
    await query(
      `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, $2, $3, $4)`,
      [block.id, phaseValue(req.body?.amPm, ["AM", "PM"]), phaseValue(req.body?.bta, ["B", "T", "A"]), order],
    );
    res.status(201).json(await buildDraft(block.plan));
  } catch (error) { next(error); }
});

router.delete("/sessions/:sessionId", async (req, res, next) => {
  try {
    const session = await getEditableSession(req.user, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Program session not found" });
    await deleteSessionTree(session.id);
    res.json(await buildDraft(session.plan));
  } catch (error) { next(error); }
});

router.post("/sessions/:sessionId/nodes", async (req, res, next) => {
  try {
    const session = await getEditableSession(req.user, req.params.sessionId);
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
    res.status(201).json(await buildDraft(session.plan));
  } catch (error) { next(error); }
});

router.delete("/nodes/:nodeId", async (req, res, next) => {
  try {
    const node = await getEditableNode(req.user, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
    await deleteNodeTree(node.id);
    res.json(await buildDraft(node.plan));
  } catch (error) { next(error); }
});

router.post("/nodes/:nodeId/move", async (req, res, next) => {
  try {
    const node = await getEditableNode(req.user, req.params.nodeId);
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
         and node_order ${comparator} $3
       order by node_order ${sort}
       limit 1`,
      [node.plan_session_id, node.parent_id, node.node_order],
    );
    const neighbor = neighborResult.rows[0];
    if (!neighbor) return res.json(await buildDraft(node.plan));
    await query(
      `update plans.plan_nodes
       set node_order = case when id = $1 then $2 when id = $3 then $4 end,
           updated_at = now()
       where id in ($1, $3)`,
      [node.id, neighbor.node_order, neighbor.id, node.node_order],
    );
    res.json(await buildDraft(node.plan));
  } catch (error) { next(error); }
});

router.post("/nodes/:nodeId/exercises", async (req, res, next) => {
  try {
    const node = await getEditableNode(req.user, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
    if (node.node_type !== "section") return res.status(400).json({ error: "Exercises can only be added to a section." });
    const exerciseResult = await query(
      `select id, name, aim, execution_notes, instruction, image_url, video_url
       from library.exercises where id = $1 and is_active = true`, [text(req.body?.exerciseId)],
    );
    const exercise = exerciseResult.rows[0];
    if (!exercise) return res.status(404).json({ error: "Exercise not found." });
    const order = await nextOrder("plans.plan_items", "plan_session_id", node.plan_session_id, "item_order");
    await query(
      `insert into plans.plan_items (
        plan_session_id, plan_node_id, item_type, exercise_id, title, description, image_url, video_url,
        sets, reps, load, item_order, exercise_order, section_name, section_order
      ) values ($1, $2, 'exercise', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13)`,
      [node.plan_session_id, node.id, exercise.id, exercise.name,
        text(exercise.instruction) || text(exercise.execution_notes) || text(exercise.aim) || null,
        exercise.image_url, exercise.video_url, nullableText(req.body?.sets), nullableText(req.body?.reps), nullableText(req.body?.load), order,
        node.node_type === "section" ? node.name : null, node.node_type === "section" ? node.node_order : null],
    );
    res.status(201).json(await buildDraft(node.plan));
  } catch (error) { next(error); }
});

router.post("/nodes/:nodeId/custom-exercise", async (req, res, next) => {
  try {
    const node = await getEditableNode(req.user, req.params.nodeId);
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
    await query(
      `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, exercise_id, title, description, image_url, video_url, sets, reps, load, item_order, exercise_order, section_name, section_order)
       values ($1, $2, 'exercise', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13)`,
      [node.plan_session_id, node.id, exercise.id, exercise.name, exercise.instruction, exercise.image_url, exercise.video_url,
        nullableText(req.body?.sets), nullableText(req.body?.reps), nullableText(req.body?.load), order, node.name, node.node_order],
    );
    res.status(201).json(await buildDraft(node.plan));
  } catch (error) { next(error); }
});

router.post("/nodes/:nodeId/copy", async (req, res, next) => {
  try {
    const source = await getEditableNode(req.user, req.params.nodeId);
    const targetSession = await getEditableSession(req.user, req.body?.targetSessionId);
    if (!source || !targetSession) return res.status(404).json({ error: "Source node or target session not found" });
    const targetParentId = nullableText(req.body?.targetParentId);
    if (targetParentId && !(await isNodeInSession(targetParentId, targetSession.id))) return res.status(400).json({ error: "Target parent is outside target session." });
    if (!(await isAllowedNodePlacement(targetSession.id, targetParentId, source.node_type))) {
      return res.status(400).json({ error: "Choose a compatible target for this copied structure." });
    }
    await copyNodeTree(source.id, targetSession.id, targetParentId);
    res.status(201).json(await buildDraft(targetSession.plan));
  } catch (error) { next(error); }
});

router.patch("/items/:itemId", async (req, res, next) => {
  try {
    const item = await getEditableItem(req.user, req.params.itemId);
    if (!item) return res.status(404).json({ error: "Program item not found" });
    await query(
      `update plans.plan_items set sets = $2, reps = $3, load = $4, description = $5, updated_at = now() where id = $1`,
      [item.id, nullableText(req.body?.sets), nullableText(req.body?.reps), nullableText(req.body?.load), nullableText(req.body?.description)],
    );
    res.json(await buildDraft(item.plan));
  } catch (error) { next(error); }
});

router.post("/items/:itemId/move", async (req, res, next) => {
  try {
    const item = await getEditableItem(req.user, req.params.itemId);
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
    if (!neighbor) return res.json(await buildDraft(item.plan));
    await query(
      `update plans.plan_items set item_order = case when id = $1 then $2 when id = $3 then $4 end, updated_at = now() where id in ($1, $3)`,
      [item.id, neighbor.item_order, neighbor.id, item.item_order],
    );
    res.json(await buildDraft(item.plan));
  } catch (error) { next(error); }
});

router.delete("/items/:itemId", async (req, res, next) => {
  try {
    const item = await getEditableItem(req.user, req.params.itemId);
    if (!item) return res.status(404).json({ error: "Program item not found" });
    await query("delete from plans.plan_items where id = $1", [item.id]);
    res.json(await buildDraft(item.plan));
  } catch (error) { next(error); }
});

async function buildDraft(plan) {
  const result = await query(
    `select pd.id as block_id, pd.block_index, pd.block_name, pd.block_type, pd.date, pd.day_order, pd.day_note,
            ps.id as session_id, ps.am_pm, ps.bta, ps.session_order,
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
    if (!session) { session = { id: row.session_id, amPm: row.am_pm || "", bta: row.bta || "", nodes: [] }; block.sessions.push(session); }
    if (!row.node_id) return;
    let node = session.nodes.find((value) => value.id === row.node_id);
    if (!node) {
      node = { id: row.node_id, parentId: row.parent_id || "", type: row.node_type, name: row.node_name, color: row.color || "", iconUrl: row.icon_url || "", shortNote: row.short_note || "", note: row.note || "", order: Number(row.node_order || 0), items: [] };
      session.nodes.push(node);
    }
    if (row.item_id) node.items.push({ id: row.item_id, exerciseId: row.exercise_id, title: row.title, description: row.description || "", imageUrl: row.image_url || "", videoUrl: row.video_url || "", sets: row.sets || "", reps: row.reps || "", load: row.load || "", itemOrder: Number(row.item_order || 0) });
  });
  return { plan: { id: plan.id, planType: plan.plan_type, weekStart: plan.week_start || "", name: plan.name, note: plan.note || "", iconUrl: plan.icon_url || "", color: plan.color || "", visibility: plan.visibility || "private", isTemplate: plan.is_template, athleteId: plan.athlete_source_external_id || plan.athlete_id || "", athleteName: plan.athlete_name || "", status: plan.status }, blocks: [...blocks.values()] };
}

async function copyProgramTree(client, sourcePlanId, targetPlanId) {
  const days = await client.query("select * from plans.plan_days where plan_id = $1 order by block_order nulls last, block_index", [sourcePlanId]);
  for (const day of days.rows) {
    const createdDay = await client.query(
      `insert into plans.plan_days (plan_id, date, day_note, day_order, block_index, block_name, block_type, block_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [targetPlanId, day.date, day.day_note, day.day_order, day.block_index, day.block_name, day.block_type, day.block_order],
    );
    const sessions = await client.query("select * from plans.plan_sessions where plan_day_id = $1 order by session_order", [day.id]);
    for (const session of sessions.rows) {
      const createdSession = await client.query(
        "insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, $2, $3, $4) returning id",
        [createdDay.rows[0].id, session.am_pm, session.bta, session.session_order],
      );
      const nodes = await client.query("select * from plans.plan_nodes where plan_session_id = $1 order by node_order", [session.id]);
      if (nodes.rowCount) {
        for (const root of nodes.rows.filter((node) => !node.parent_id)) {
          await copyNodeTreeWithClient(client, root.id, createdSession.rows[0].id, null);
        }
      } else {
        await copyLegacySession(client, session.id, createdSession.rows[0].id);
      }
    }
  }
}

async function copyWeeklyPlanTree(client, sourcePlanId, targetPlanId, targetWeekStart) {
  await createWeeklyDays(client, targetPlanId, targetWeekStart);
  const sourceDays = await client.query("select * from plans.plan_days where plan_id = $1 order by day_order, block_index", [sourcePlanId]);
  const targetDays = await client.query("select * from plans.plan_days where plan_id = $1 order by day_order, block_index", [targetPlanId]);
  for (let index = 0; index < sourceDays.rows.length; index += 1) {
    const sourceDay = sourceDays.rows[index];
    const targetDay = targetDays.rows[index];
    if (!targetDay) continue;
    await client.query(
      "update plans.plan_days set block_name = $2, block_type = $3, day_note = $4, updated_at = now() where id = $1",
      [targetDay.id, sourceDay.block_name, sourceDay.block_type, sourceDay.day_note],
    );
    await copyDaySessions(client, sourceDay.id, targetDay.id);
  }
}

async function copyDaySessions(client, sourceDayId, targetDayId) {
  const sessions = await client.query("select * from plans.plan_sessions where plan_day_id = $1 order by session_order", [sourceDayId]);
  for (const session of sessions.rows) {
    const createdSession = await client.query(
      "insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, $2, $3, $4) returning id",
      [targetDayId, session.am_pm, session.bta, session.session_order],
    );
    const nodes = await client.query("select * from plans.plan_nodes where plan_session_id = $1 order by node_order", [session.id]);
    if (nodes.rowCount) {
      for (const root of nodes.rows.filter((node) => !node.parent_id)) {
        await copyNodeTreeWithClient(client, root.id, createdSession.rows[0].id, null);
      }
    } else {
      await copyLegacySession(client, session.id, createdSession.rows[0].id);
    }
  }
}

async function copyLegacySession(client, sourceSessionId, targetSessionId) {
  const items = await client.query("select * from plans.plan_items where plan_session_id = $1 order by item_order", [sourceSessionId]);
  const nodes = new Map();
  for (const item of items.rows) {
    let parentId = null;
    if (item.domain_name) {
      parentId = await ensureLegacyNode(client, nodes, targetSessionId, null, "domain", item.domain_name, item.domain_color, item.domain_icon_url, item.domain_short_note, item.domain_note);
    }
    if (item.category_name) {
      parentId = await ensureLegacyNode(client, nodes, targetSessionId, parentId, "category", item.category_name, item.category_color, item.category_icon_url, item.category_short_note, item.category_note);
    }
    const sectionName = item.section_name || item.category_name || item.domain_name || "General";
    const sectionColor = item.section_name ? item.section_color : item.category_name ? item.category_color : item.domain_color;
    const sectionIcon = item.section_name ? item.section_icon_url : item.category_name ? item.category_icon_url : item.domain_icon_url;
    const sectionShortNote = item.section_name ? item.section_short_note : item.category_name ? item.category_short_note : item.domain_short_note;
    const sectionNote = item.section_name ? item.section_note : item.category_name ? item.category_note : item.domain_note;
    const sectionId = await ensureLegacyNode(client, nodes, targetSessionId, parentId, "section", sectionName, sectionColor, sectionIcon, sectionShortNote, sectionNote);
    await copyPlanItem(client, item, targetSessionId, sectionId);
  }
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
    const nodes = new Map();
    for (const item of items.rows) {
      let parentId = null;
      if (item.domain_name) {
        parentId = await ensureLegacyNode(client, nodes, session.id, null, "domain", item.domain_name, item.domain_color, item.domain_icon_url, item.domain_short_note, item.domain_note);
      }
      if (item.category_name) {
        parentId = await ensureLegacyNode(client, nodes, session.id, parentId, "category", item.category_name, item.category_color, item.category_icon_url, item.category_short_note, item.category_note);
      }
      const sectionName = item.section_name || item.category_name || item.domain_name || "General";
      const sectionColor = item.section_name ? item.section_color : item.category_name ? item.category_color : item.domain_color;
      const sectionIcon = item.section_name ? item.section_icon_url : item.category_name ? item.category_icon_url : item.domain_icon_url;
      const sectionShortNote = item.section_name ? item.section_short_note : item.category_name ? item.category_short_note : item.domain_short_note;
      const sectionNote = item.section_name ? item.section_note : item.category_name ? item.category_note : item.domain_note;
      const sectionId = await ensureLegacyNode(client, nodes, session.id, parentId, "section", sectionName, sectionColor, sectionIcon, sectionShortNote, sectionNote);
      await client.query("update plans.plan_items set plan_node_id = $2, updated_at = now() where id = $1", [item.id, sectionId]);
    }
  }
}

async function ensureLegacyNode(client, nodes, sessionId, parentId, type, name, color, iconUrl, shortNote, note) {
  const key = `${parentId || "root"}:${type}:${name}`;
  if (nodes.has(key)) return nodes.get(key);
  const order = await nextNodeOrderWithClient(client, sessionId, parentId);
  const created = await client.query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [sessionId, parentId, type, name, color, iconUrl, shortNote, note, order],
  );
  const id = created.rows[0].id;
  nodes.set(key, id);
  return id;
}

async function copyNodeTreeWithClient(client, sourceId, targetSessionId, targetParentId) {
  const nodeResult = await client.query("select * from plans.plan_nodes where id = $1", [sourceId]);
  const source = nodeResult.rows[0];
  if (!source) return;
  const order = await nextNodeOrderWithClient(client, targetSessionId, targetParentId);
  const created = await client.query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [targetSessionId, targetParentId, source.node_type, source.name, source.color, source.icon_url, source.short_note, source.note, order],
  );
  const targetNodeId = created.rows[0].id;
  const items = await client.query("select * from plans.plan_items where plan_node_id = $1 order by item_order", [sourceId]);
  for (const item of items.rows) await copyPlanItem(client, item, targetSessionId, targetNodeId);
  const children = await client.query("select id from plans.plan_nodes where parent_id = $1 order by node_order", [sourceId]);
  for (const child of children.rows) await copyNodeTreeWithClient(client, child.id, targetSessionId, targetNodeId);
}

async function copyPlanItem(client, item, targetSessionId, targetNodeId) {
  await client.query(
    `insert into plans.plan_items (
      plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url,
      sets, reps, load, item_order, exercise_order, source_row_ref,
      domain_name, category_name, section_name, domain_color, category_color, section_color,
      domain_icon_url, category_icon_url, section_icon_url, domain_short_note, category_short_note, section_short_note,
      domain_note, category_note, section_note, domain_order, category_order, section_order
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22,
      $23, $24, $25, $26, $27, $28,
      $29, $30, $31, $32, $33, $34
    )`,
    [
      targetSessionId, targetNodeId, item.item_type, item.exercise_id, item.title, item.description, item.short_note, item.note, item.image_url, item.video_url,
      item.sets, item.reps, item.load, item.item_order, item.exercise_order, item.source_row_ref,
      item.domain_name, item.category_name, item.section_name, item.domain_color, item.category_color, item.section_color,
      item.domain_icon_url, item.category_icon_url, item.section_icon_url, item.domain_short_note, item.category_short_note, item.section_short_note,
      item.domain_note, item.category_note, item.section_note, item.domain_order, item.category_order, item.section_order,
    ],
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
  const sourceItems = await query("select * from plans.plan_items where plan_node_id = $1 order by item_order", [sourceId]);
  for (const item of sourceItems.rows) {
    const itemOrder = await nextOrder("plans.plan_items", "plan_session_id", targetSessionId, "item_order");
    await query(
      `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, exercise_id, title, description, short_note, note, image_url, video_url, sets, reps, load, item_order, exercise_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
      [targetSessionId, newNodeId, item.item_type, item.exercise_id, item.title, item.description, item.short_note, item.note, item.image_url, item.video_url, item.sets, item.reps, item.load, itemOrder],
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

async function getEditablePlan(user, planId) {
  const result = await query(
    `select p.id, p.plan_type, p.week_start, p.name, p.note, p.icon_url, p.color, p.visibility, p.is_template, p.status, a.athlete_id, a.source_external_id as athlete_source_external_id,
            coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name)) as athlete_name
     from plans.plans p left join public.athletes a on a.id = p.athlete_id
     where p.id = $1
       and p.plan_type in ('program', 'weekly')
       and (
         p.created_by_user_id = $2
         or $3 in ('admin', 'platform_admin', 'club_admin')
         or exists (
           select 1
           from public.athletes managed_athlete
           left join public.user_athletes ua on ua.athlete_id = managed_athlete.id and ua.is_active = true
           where managed_athlete.id = p.athlete_id
             and (managed_athlete.user_id = $2 or ua.user_id = $2)
         )
       )`, [planId, user.id, user.role_hint || ""],
  );
  return result.rows[0] || null;
}

async function getCopySource(planId) {
  const result = await query(
    `select id, athlete_id, plan_type, name, note, icon_url, color, is_template, start_date, duration_days
     from plans.plans
     where id = $1 and plan_type in ('program', 'weekly') and is_active = true`,
    [planId],
  );
  return result.rows[0] || null;
}

async function requirePlan(user, planId, res) {
  const plan = await getEditablePlan(user, planId);
  if (!plan) { res.status(404).json({ error: "Draft program not found" }); return null; }
  return plan;
}

async function getEditableBlock(user, blockId) {
  const result = await query("select pd.id, pd.plan_id from plans.plan_days pd where pd.id = $1", [blockId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { id: row.id, plan } : null;
}

async function getEditableSession(user, sessionId) {
  const result = await query("select ps.id, pd.plan_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where ps.id = $1", [sessionId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { id: row.id, plan } : null;
}

async function getEditableNode(user, nodeId) {
  const result = await query("select pn.id, pn.plan_session_id, pn.parent_id, pn.node_type, pn.name, pn.node_order, pd.plan_id from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pn.id = $1", [nodeId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { ...row, plan } : null;
}

async function getEditableItem(user, itemId) {
  const result = await query("select pi.id, pi.plan_node_id, pi.item_order, pd.plan_id from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pi.id = $1", [itemId]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { id: row.id, plan_node_id: row.plan_node_id, item_order: row.item_order, plan } : null;
}

async function findAthlete(externalId) {
  const result = await query("select id from public.athletes where athlete_id = $1 or source_external_id = $1 limit 1", [externalId]);
  return result.rows[0] || null;
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

async function nextNodeOrderWithClient(client, sessionId, parentId) {
  const result = await client.query("select coalesce(max(node_order), 0) + 1 as next_value from plans.plan_nodes where plan_session_id = $1 and parent_id is not distinct from $2", [sessionId, parentId]);
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

export default router;
