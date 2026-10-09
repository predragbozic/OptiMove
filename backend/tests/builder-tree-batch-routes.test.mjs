import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("Builder tree batching route integration with isolated database mocks", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  const result = (rows) => ({ rows, rowCount: rows.length });
  let client;
  let source;
  async function query(sql, params) {
    if (sql.includes("select p.id")) return result([{ ...source, id: params[0] }]);
    if (sql.includes("where edit_source_plan_id")) return result([]);
    if (sql.includes("select pd.id as block_id")) return result([]);
    throw new Error(`Unexpected external query: ${sql}`);
  }
  mock.module("../src/db.js", { namedExports: { query, pool: { connect: async () => client } } });
  mock.module("../src/access.js", { namedExports: { athleteAccessPredicate: () => "false", canAccessAllAthletes: () => false, canAccessPlan: async () => true } });
  const { default: router, copyProgramTree, copyDaySessions, copySessionContent } = await import("../src/routes/builder.js");
  const edit = router.stack.find((layer) => layer.route?.path === "/plans/:planId/edit").route.stack[0].handle;

  function makeClient(days, sessions, { failContent = false } = {}) {
    const calls = [];
    const inserts = { plan_days: [], plan_sessions: [], plan_nodes: [], plan_items: [] };
    let nextId = 0;
    const nodes = sessions.map((session) => ({ id: `node-${session.id}`, plan_session_id: session.id, parent_id: null,
      node_type: "section", name: "Section", node_order: 1 }));
    const items = sessions.map((session) => ({ id: `item-${session.id}`, plan_session_id: session.id,
      plan_node_id: `node-${session.id}`, item_type: "exercise", sets: "3", reps: "12" }));
    return { calls, inserts, release() { calls.push({ sql: "release" }); }, async query(sql, params = []) {
      const clean = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: clean, params });
      if (["begin", "commit", "rollback"].includes(clean)) return result([]);
      if (clean.startsWith("delete from plans.plan_")) return result([]);
      if (clean.startsWith("insert into plans.plans")) return result([{ id: "edit-draft" }]);
      if (clean.startsWith("insert into training_load.plan_workspace_ownership")) return result([]);
      if (clean.startsWith("update plans.plan_days")) return result([]);
      if (clean.startsWith("select * from plans.plan_days")) {
        return result(params[0] === "source" ? days : inserts.plan_days);
      }
      if (clean.startsWith("select * from plans.plan_sessions")) {
        const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
        return result(sessions.filter((session) => ids.includes(session.plan_day_id)));
      }
      if (clean.startsWith("select * from plans.plan_nodes")) {
        if (failContent) throw new Error("content failed");
        return result(nodes.filter((node) => params[0].includes(node.plan_session_id)));
      }
      if (clean.startsWith("select * from plans.plan_items")) return result(items.filter((item) => params[0].includes(item.plan_session_id)));
      if (clean.includes("from generate_series")) {
        inserts.plan_days.push(...Array.from({ length: 7 }, (_, i) => ({ id: `day-${i}`, day_order: i + 1 })));
        return result([]);
      }
      const match = clean.match(/^insert into plans\.(plan_days|plan_sessions|plan_nodes|plan_items) \(([^)]+)\)/);
      if (match) {
        const columns = match[2].split(", ");
        const rows = [];
        for (let offset = 0; offset < params.length; offset += columns.length) {
          const row = Object.fromEntries(columns.map((column, i) => [column, params[offset + i]]));
          row.id = `created-${nextId++}`;
          rows.push(row);
        }
        inserts[match[1]].push(...rows);
        return result(rows);
      }
      throw new Error(`Unexpected transaction query: ${clean}`);
    } };
  }

  const session = (id, day) => ({ id, plan_day_id: day, am_pm: "PM", bta: "AT", session_time: "16:30:00",
    session_order: 1, name: id, rpe_enabled: false, training_load_enabled: false, logical_session_id: `logical-${id}` });

  test("program copies batch content across all sessions and preserve time and flags", async () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ id: `source-day-${i}`, block_index: i + 1 }));
    const sessions = days.flatMap((day, i) => [session(`am-${i}`, day.id), session(`pm-${i}`, day.id)]);
    client = makeClient(days, sessions);
    await copyProgramTree(client, "source", "target");
    assert.equal(client.calls.length, 8); // four skeleton + two reads + one node/item insert
    assert.equal(client.inserts.plan_sessions.length, 14);
    assert.equal(client.inserts.plan_items.length, 14);
    for (const copied of client.inserts.plan_sessions) {
      assert.equal(copied.session_time, "16:30:00");
      assert.equal(copied.rpe_enabled, false);
      assert.equal(copied.training_load_enabled, false);
      assert.ok(!Object.hasOwn(copied, "logical_session_id"));
    }
  });

  test("14-session content copy drops from 56 sequential queries to four", async () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ id: `source-day-${i}`, block_index: i + 1 }));
    const sessions = days.flatMap((day, i) => [session(`am-${i}`, day.id), session(`pm-${i}`, day.id)]);
    const oldClient = makeClient(days, sessions);
    for (const row of sessions) await copySessionContent(oldClient, row.id, `target-${row.id}`);
    assert.equal(oldClient.calls.length, 56);
    const newClient = makeClient(days, sessions);
    await copyProgramTree(newClient, "source", "target");
    assert.equal(newClient.calls.length - 4, 4);
    assert.equal(newClient.inserts.plan_items.length, oldClient.inserts.plan_items.length);
  });

  test("day session collector preserves identity only when explicitly requested", async () => {
    for (const preserveLogicalId of [false, true]) {
      client = makeClient([], [session("session", "source-day")]);
      const contentCopies = new Map();
      await copyDaySessions(client, "source-day", "target-day", { preserveLogicalId, contentCopies });
      assert.equal(client.calls.length, 2);
      assert.equal(contentCopies.get("session"), client.inserts.plan_sessions[0].id);
      assert.equal(client.inserts.plan_sessions[0].logical_session_id, preserveLogicalId ? "logical-session" : undefined);
      assert.equal(client.inserts.plan_sessions[0].rpe_enabled, false);
      assert.equal(client.inserts.plan_sessions[0].training_load_enabled, false);
    }
  });

  test("weekly edit batches content, matches weekdays despite legacy indices, and retains session identity", async () => {
    source = { id: "source", plan_type: "weekly", status: "active", week_start: "2026-10-05", source_type: "builder" };
    const days = [{ id: "old-monday", day_order: 1, block_index: null }, { id: "monday", day_order: 8, block_index: 99 },
      { id: "sunday", day_order: 0, block_index: null }];
    client = makeClient(days, days.map((day) => session(day.id, day.id)));
    const response = { setHeader() {}, json(body) { this.body = body; } };
    let failure;
    await edit({ params: { planId: "source" }, user: { id: "coach" } }, response, (error) => { failure = error; });
    assert.equal(failure, undefined);
    assert.equal(client.inserts.plan_days.length, 7);
    assert.deepEqual(client.inserts.plan_sessions.map((row) => row.name), ["monday", "sunday"]);
    assert.deepEqual(client.inserts.plan_sessions.map((row) => row.logical_session_id), ["logical-monday", "logical-sunday"]);
    assert.equal(client.inserts.plan_items.length, 2);
    assert.equal(client.calls.filter(({ sql }) => sql.startsWith("select * from plans.plan_nodes")).length, 1);
    assert.ok(client.calls.some(({ sql }) => sql === "commit"));
    assert.equal(response.body.plan.id, "edit-draft");
  });

  test("weekly content failure rolls back creation and never returns success", async () => {
    source = { id: "source", plan_type: "weekly", status: "active", week_start: "2026-10-05" };
    client = makeClient([{ id: "monday", day_order: 1 }], [session("session", "monday")], { failContent: true });
    const response = { setHeader() {}, json(body) { this.body = body; } };
    let failure;
    await edit({ params: { planId: "source" }, user: { id: "coach" } }, response, (error) => { failure = error; });
    assert.match(failure.message, /content failed/);
    assert.equal(response.body, undefined);
    assert.ok(client.calls.some(({ sql }) => sql === "rollback"));
    assert.ok(!client.calls.some(({ sql }) => sql === "commit"));
  });
}
