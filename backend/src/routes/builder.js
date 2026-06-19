import { Router } from "express";
import { query } from "../db.js";

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
  try {
    const name = text(req.body?.name);
    const athleteExternalId = text(req.body?.athleteId);
    const isTemplate = Boolean(req.body?.isTemplate);
    if (!name) return res.status(400).json({ error: "Program name is required." });
    if (!isTemplate && !athleteExternalId) return res.status(400).json({ error: "Choose an athlete or create a template." });
    const athlete = athleteExternalId ? await findAthlete(athleteExternalId) : null;
    if (athleteExternalId && !athlete) return res.status(404).json({ error: "Athlete not found." });
    const created = await query(
      `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, note, is_template, status, source_type)
       values ('program', $1, $2, $3, $4, $5, 'draft', 'builder') returning id`,
      [req.user.id, athlete?.id || null, name, nullableText(req.body?.note), isTemplate],
    );
    res.status(201).json(await buildDraft(await getEditablePlan(req.user, created.rows[0].id)));
  } catch (error) { next(error); }
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
    await deleteBlockTree(block.id);
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

router.post("/nodes/:nodeId/exercises", async (req, res, next) => {
  try {
    const node = await getEditableNode(req.user, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Program node not found" });
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

router.post("/nodes/:nodeId/copy", async (req, res, next) => {
  try {
    const source = await getEditableNode(req.user, req.params.nodeId);
    const targetSession = await getEditableSession(req.user, req.body?.targetSessionId);
    if (!source || !targetSession) return res.status(404).json({ error: "Source node or target session not found" });
    const targetParentId = nullableText(req.body?.targetParentId);
    if (targetParentId && !(await isNodeInSession(targetParentId, targetSession.id))) return res.status(400).json({ error: "Target parent is outside target session." });
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
    `select pd.id as block_id, pd.block_index, pd.block_name, pd.block_type, pd.day_note,
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
    if (!blocks.has(row.block_id)) blocks.set(row.block_id, { id: row.block_id, index: row.block_index, name: row.block_name, type: row.block_type, note: row.day_note, sessions: [] });
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
  return { plan: { id: plan.id, name: plan.name, note: plan.note || "", isTemplate: plan.is_template, athleteId: plan.athlete_source_external_id || plan.athlete_id || "", athleteName: plan.athlete_name || "", status: plan.status }, blocks: [...blocks.values()] };
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
    `select p.id, p.name, p.note, p.is_template, p.status, a.athlete_id, a.source_external_id as athlete_source_external_id,
            coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name)) as athlete_name
     from plans.plans p left join public.athletes a on a.id = p.athlete_id
     where p.id = $1 and p.plan_type = 'program' and p.created_by_user_id = $2`, [planId, user.id],
  );
  return result.rows[0] || null;
}

async function requirePlan(user, planId, res) {
  const plan = await getEditablePlan(user, planId);
  if (!plan) { res.status(404).json({ error: "Draft program not found" }); return null; }
  return plan;
}

async function getEditableBlock(user, blockId) {
  const result = await query("select pd.id, p.id as plan_id from plans.plan_days pd join plans.plans p on p.id = pd.plan_id where pd.id = $1 and p.created_by_user_id = $2", [blockId, user.id]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { id: row.id, plan } : null;
}

async function getEditableSession(user, sessionId) {
  const result = await query("select ps.id, p.id as plan_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id where ps.id = $1 and p.created_by_user_id = $2", [sessionId, user.id]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { id: row.id, plan } : null;
}

async function getEditableNode(user, nodeId) {
  const result = await query("select pn.id, pn.plan_session_id, pn.node_type, pn.name, pn.node_order, p.id as plan_id from plans.plan_nodes pn join plans.plan_sessions ps on ps.id = pn.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id where pn.id = $1 and p.created_by_user_id = $2", [nodeId, user.id]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { ...row, plan } : null;
}

async function getEditableItem(user, itemId) {
  const result = await query("select pi.id, p.id as plan_id from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id where pi.id = $1 and p.created_by_user_id = $2", [itemId, user.id]);
  const row = result.rows[0]; if (!row) return null;
  const plan = await getEditablePlan(user, row.plan_id); return plan ? { id: row.id, plan } : null;
}

async function findAthlete(externalId) {
  const result = await query("select id from public.athletes where athlete_id = $1 or source_external_id = $1 limit 1", [externalId]);
  return result.rows[0] || null;
}

async function isNodeInSession(nodeId, sessionId) {
  const result = await query("select 1 from plans.plan_nodes where id = $1 and plan_session_id = $2", [nodeId, sessionId]);
  return result.rowCount > 0;
}

async function nextOrder(table, field, value, orderColumn) {
  const result = await query(`select coalesce(max(${orderColumn}), 0) + 1 as next_value from ${table} where ${field} = $1`, [value]);
  return Number(result.rows[0].next_value);
}

async function nextNodeOrder(sessionId, parentId) {
  const result = await query("select coalesce(max(node_order), 0) + 1 as next_value from plans.plan_nodes where plan_session_id = $1 and parent_id is not distinct from $2", [sessionId, parentId]);
  return Number(result.rows[0].next_value);
}

function text(value) { return String(value || "").trim(); }
function nullableText(value) { return text(value) || null; }
function phaseValue(value, allowed) { const clean = text(value).toUpperCase(); return allowed.includes(clean) ? clean : null; }

export default router;
