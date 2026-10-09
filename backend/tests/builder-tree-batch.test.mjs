import { test } from "node:test";
import assert from "node:assert/strict";
import { copyBuilderSessionContents, deleteBuilderPlanContent, copyBuilderDaySessions, updateBuilderWeeklyDays } from "../src/builderTreeBatch.js";

function fixture(sessionCount, itemsPerSession = 2) {
  const sessionMap = new Map();
  const nodes = [];
  const items = [];
  for (let i = 0; i < sessionCount; i++) {
    const sessionId = `session-${i}`;
    sessionMap.set(sessionId, `target-${i}`);
    for (const [level, type] of ["domain", "category", "section"].entries()) {
      nodes.push({ id: `${sessionId}-${level}`, plan_session_id: sessionId,
        parent_id: level ? `${sessionId}-${level - 1}` : null, node_type: type,
        name: `${type}-${i}`, node_order: level + 0.5, color: "#123456", note: "node note" });
    }
    for (let j = 0; j < itemsPerSession; j++) {
      items.push({ id: `${sessionId}-item-${j}`, plan_session_id: sessionId, plan_node_id: `${sessionId}-2`,
        item_type: "exercise", exercise_id: `exercise-${j}`, title: "Knee extension", sets: "3", reps: "12",
        load: "20 kg", item_order: j + 0.5, exercise_order: j, source_row_ref: "import row",
        description: "description", image_url: "image", video_url: "video", section_name: "Section", note: "item note" });
    }
  }
  return { sessionMap, nodes, items };
}

function database(source) {
  const calls = [];
  const inserted = { plan_nodes: [], plan_items: [] };
  async function query(sql, params) {
    calls.push({ sql, params });
    const result = (rows) => ({ rows, rowCount: rows.length });
    if (sql.startsWith("select")) {
      assert.ok(sql.includes("any($1::uuid[])"));
      assert.deepEqual(params, [[...source.sessionMap.keys()]]);
      return result(sql.includes("plans.plan_nodes") ? source.nodes : source.items);
    }
    const match = sql.match(/^insert into plans\.(plan_nodes|plan_items) \(([^)]+)\)/);
    assert.ok(match, sql);
    const columns = match[2].split(", ");
    assert.equal(params.length % columns.length, 0);
    assert.ok(params.length <= 17000, "batch must stay below PostgreSQL parameter limits");
    const rows = [];
    for (let offset = 0; offset < params.length; offset += columns.length) {
      const row = Object.fromEntries(columns.map((column, i) => [column, params[offset + i]]));
      row.id = `new-${match[1]}-${inserted[match[1]].length}`;
      if (match[1] === "plan_nodes" && row.parent_id) {
        assert.ok(inserted.plan_nodes.some((parent) => parent.id === row.parent_id && parent.plan_session_id === row.plan_session_id));
      }
      inserted[match[1]].push(row);
      rows.push({ id: row.id });
    }
    return result(rows);
  }
  return { query, calls, inserted };
}

test("tree copy uses six queries for one or 48 structured sessions", async () => {
  for (const count of [1, 48]) {
    const source = fixture(count);
    const db = database(source);
    await copyBuilderSessionContents(db, source.sessionMap, () => assert.fail("unexpected legacy copy"));
    assert.equal(db.calls.length, 6);
    assert.equal(db.inserted.plan_nodes.length, count * 3);
    assert.equal(db.inserted.plan_items.length, count * 2);
    for (const item of db.inserted.plan_items) {
      const section = db.inserted.plan_nodes.find((node) => node.id === item.plan_node_id);
      assert.equal(section.plan_session_id, item.plan_session_id);
      assert.equal(section.node_type, "section");
      for (const field of ["exercise_id", "title", "sets", "reps", "load", "note", "description", "image_url", "video_url", "section_name", "source_row_ref"]) {
        assert.equal(item[field], source.items.find((original) => original.exercise_order === item.exercise_order)[field]);
      }
    }
  }
});

test("large copies chunk inserts without losing parent mapping or exercise doses", async () => {
  const source = fixture(501, 3);
  const db = database(source);
  await copyBuilderSessionContents(db, source.sessionMap, () => assert.fail("unexpected legacy copy"));
  assert.equal(db.inserted.plan_nodes.length, 1503);
  assert.equal(db.inserted.plan_items.length, 1503);
  assert.equal(db.calls.length, 12);
  assert.ok(db.inserted.plan_items.every((item) => item.sets === "3" && item.reps === "12"));
});

test("mixed legacy and empty sessions reuse fetched items and preserve the existing legacy callback", async () => {
  const source = fixture(1);
  source.sessionMap.set("legacy", "new-legacy");
  source.sessionMap.set("empty", "new-empty");
  const legacyItem = { id: "legacy-item", plan_session_id: "legacy", section_name: "Imported" };
  source.items.push(legacyItem);
  const db = database(source);
  const calls = [];
  await copyBuilderSessionContents(db, source.sessionMap, async (...args) => calls.push(args));
  assert.deepEqual(calls, [[db, "legacy", "new-legacy", [legacyItem]]]);
  assert.equal(db.calls.length, 6);
});

test("empty session maps do no work and empty sessions need only two reads", async () => {
  const source = fixture(0);
  const db = database(source);
  await copyBuilderSessionContents(db, source.sessionMap, () => assert.fail("legacy"));
  assert.equal(db.calls.length, 0);
  source.sessionMap.set("empty", "target");
  await copyBuilderSessionContents(db, source.sessionMap, () => assert.fail("legacy"));
  assert.equal(db.calls.length, 2);
});

test("orphan, cyclic, detached and cross-session references are not copied", async () => {
  const source = fixture(2);
  source.nodes.push({ id: "orphan", parent_id: "missing", plan_session_id: "session-0" });
  source.nodes.push({ id: "cycle", parent_id: "cycle", plan_session_id: "session-0" });
  source.nodes.push({ id: "cross", parent_id: "session-1-0", plan_session_id: "session-0" });
  for (const nodeId of [null, "missing", "orphan", "cycle", "cross", "session-1-2"]) {
    source.items.push({ plan_session_id: "session-0", plan_node_id: nodeId, title: "invalid" });
  }
  const db = database(source);
  await copyBuilderSessionContents(db, source.sessionMap, () => assert.fail("legacy"));
  assert.equal(db.inserted.plan_nodes.length, 6);
  assert.equal(db.inserted.plan_items.length, 4);
});

test("insert failures propagate to the caller's transaction without further writes", async () => {
  const source = fixture(2);
  const db = database(source);
  const failing = { query: async (sql, params) => {
    if (sql.startsWith("insert")) throw new Error("database failure");
    return db.query(sql, params);
  } };
  await assert.rejects(copyBuilderSessionContents(failing, source.sessionMap, () => assert.fail("legacy")), /database failure/);
  assert.equal(db.calls.length, 2);
  assert.equal(db.inserted.plan_items.length, 0);
});

test("plan replacement deletes children before parents in four plan-scoped queries", async () => {
  const calls = [];
  await deleteBuilderPlanContent({ query: async (sql, params) => calls.push({ sql, params }) }, "target-plan");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ sql }) => sql.match(/^delete from plans\.(\w+)/)[1]),
    ["plan_items", "plan_nodes", "plan_sessions", "plan_days"]);
  for (const call of calls) {
    assert.deepEqual(call.params, ["target-plan"]);
    assert.ok(call.sql.includes("plan_id = $1"));
    assert.ok(!call.sql.includes("training_load"));
  }
});

test("delete failures propagate without starting a separate transaction", async () => {
  const calls = [];
  await assert.rejects(deleteBuilderPlanContent({ query: async (sql) => {
    calls.push(sql);
    if (calls.length === 2) throw new Error("delete failure");
  } }, "target-plan"), /delete failure/);
  assert.equal(calls.length, 2);
});

test("Weekly session skeleton needs two queries for 48 sessions and bounds large insert batches", async () => {
  for (const count of [48, 501]) {
    const dayMap = new Map([["day-a", "target-a"], ["day-b", "target-b"]]);
    const sessions = Array.from({ length: count }, (_, i) => ({ id: `session-${i}`, plan_day_id: i % 2 ? "day-a" : "day-b",
      name: `Session ${i}`, session_order: i, session_time: "10:30:00", am_pm: "AM", bta: "BT",
      rpe_enabled: false, training_load_enabled: false, logical_session_id: `logical-${i}` }));
    const calls = [];
    const inserted = [];
    const client = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith("select")) {
        assert.deepEqual(params, [["day-a", "day-b"]]);
        return { rows: sessions };
      }
      const fields = sql.match(/\(([^)]+)\)/)[1].split(", ");
      const rows = [];
      for (let offset = 0; offset < params.length; offset += fields.length) {
        const row = Object.fromEntries(fields.map((field, i) => [field, params[offset + i]]));
        row.id = `target-session-${inserted.length}`;
        rows.push(row);
        inserted.push(row);
      }
      return { rows };
    } };
    const map = await copyBuilderDaySessions(client, dayMap, { preserveLogicalId: true });
    assert.equal(calls.length, count === 48 ? 2 : 3);
    assert.equal(map.size, count);
    for (const [i, row] of inserted.entries()) {
      assert.equal(row.plan_day_id, dayMap.get(sessions[i].plan_day_id));
      assert.equal(row.logical_session_id, sessions[i].logical_session_id);
      assert.equal(row.rpe_enabled, false);
      assert.equal(row.training_load_enabled, false);
      assert.equal(map.get(sessions[i].id), row.id);
    }
  }
});

test("empty Weekly skeleton and metadata patches do not query the database", async () => {
  const client = { query: () => assert.fail("unexpected query") };
  assert.equal((await copyBuilderDaySessions(client, new Map())).size, 0);
  await updateBuilderWeeklyDays(client, [], "2026-10-12");
});

test("Weekly metadata patch is parameterized and preserves nulls and fractional order", async () => {
  const patches = [{ id: "target-day", weekday: 7, block_name: "Sunday's session", block_type: null, day_note: null, block_order: 1.5 }];
  const calls = [];
  await updateBuilderWeeklyDays({ query: async (sql, params) => calls.push({ sql, params }) }, patches, "2026-10-12");
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].params[0]), patches);
  assert.equal(calls[0].params[1], "2026-10-12");
  assert.ok(calls[0].sql.includes("jsonb_to_recordset($1::jsonb)"));
  assert.ok(calls[0].sql.includes("$2::date + (d.weekday - 1)"));
  assert.ok(!calls[0].sql.includes("Sunday's"));
});
