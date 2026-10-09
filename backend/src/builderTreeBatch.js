const NODE_COLUMNS = "plan_session_id, parent_id, node_type, name, color, icon_url, short_note, note, node_order";
const ITEM_FIELDS = [
  "item_type", "exercise_id", "title", "description", "short_note", "note", "image_url", "video_url",
  "sets", "reps", "load", "item_order", "exercise_order", "source_row_ref",
  "domain_name", "category_name", "section_name", "domain_color", "category_color", "section_color",
  "domain_icon_url", "category_icon_url", "section_icon_url", "domain_short_note", "category_short_note", "section_short_note",
  "domain_note", "category_note", "section_note", "domain_order", "category_order", "section_order",
];

// Bound parameter count and memory even when a coach copies a large program.
async function insertRows(client, table, columns, rows, returning = false) {
  const created = [];
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const params = batch.flat();
    let parameter = 0;
    const values = batch.map((row) => `(${row.map(() => `$${++parameter}`).join(", ")})`);
    const result = await client.query(
      `insert into plans.${table} (${columns}) values ${values.join(", ")}${returning ? " returning id" : ""}`,
      params,
    );
    if (returning) created.push(...result.rows);
  }
  return created;
}

// All sessions share one read and one insert per tree level, not per session.
export async function copyBuilderSessionContents(client, sessionMap, copyLegacySession) {
  if (!sessionMap.size) return;
  const sessionIds = [...sessionMap.keys()];
  const nodes = await client.query(
    "select * from plans.plan_nodes where plan_session_id = any($1::uuid[]) order by node_order",
    [sessionIds],
  );
  const items = await client.query(
    "select * from plans.plan_items where plan_session_id = any($1::uuid[]) order by item_order",
    [sessionIds],
  );
  const sessionsWithNodes = new Set(nodes.rows.map((node) => node.plan_session_id));
  const children = new Map();
  for (const node of nodes.rows) {
    const key = node.parent_id || `root:${node.plan_session_id}`;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }
  const nodeMap = new Map();
  const sourceNodes = new Map(nodes.rows.map((node) => [node.id, node]));
  let parents = sessionIds.map((id) => `root:${id}`);
  while (parents.length) {
    const level = parents.flatMap((id) => children.get(id) || []).filter((node) =>
      !node.parent_id || sourceNodes.get(node.parent_id)?.plan_session_id === node.plan_session_id,
    );
    if (!level.length) break;
    const created = await insertRows(client, "plan_nodes", NODE_COLUMNS, level.map((node) => [
      sessionMap.get(node.plan_session_id), node.parent_id ? nodeMap.get(node.parent_id) : null,
      node.node_type, node.name, node.color, node.icon_url, node.short_note, node.note, node.node_order,
    ]), true);
    level.forEach((node, index) => nodeMap.set(node.id, created[index].id));
    parents = level.map((node) => node.id);
  }

  const legacyItems = new Map();
  const copiedItems = [];
  for (const item of items.rows) {
    if (!sessionsWithNodes.has(item.plan_session_id)) {
      if (!legacyItems.has(item.plan_session_id)) legacyItems.set(item.plan_session_id, []);
      legacyItems.get(item.plan_session_id).push(item);
      continue;
    }
    const targetNode = nodeMap.get(item.plan_node_id);
    if (!targetNode || sourceNodes.get(item.plan_node_id)?.plan_session_id !== item.plan_session_id) continue;
    copiedItems.push([sessionMap.get(item.plan_session_id), targetNode, ...ITEM_FIELDS.map((field) => item[field])]);
  }
  await insertRows(client, "plan_items", `plan_session_id, plan_node_id, ${ITEM_FIELDS.join(", ")}`, copiedItems);
  for (const [sourceId, rows] of legacyItems) {
    await copyLegacySession(client, sourceId, sessionMap.get(sourceId), rows);
  }
}

// Same child-before-parent delete order, in four queries for the whole plan.
// Caller owns the transaction and authorization; the plan row is retained.
export async function deleteBuilderPlanContent(client, planId) {
  const sessions = "select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1";
  await client.query(`delete from plans.plan_items where plan_session_id in (${sessions})`, [planId]);
  await client.query(`delete from plans.plan_nodes where plan_session_id in (${sessions})`, [planId]);
  await client.query("delete from plans.plan_sessions where plan_day_id in (select id from plans.plan_days where plan_id = $1)", [planId]);
  await client.query("delete from plans.plan_days where plan_id = $1", [planId]);
}
