import { beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { needsModuleMocksRelaunch, relaunchWithModuleMocks } from "./support/relaunch-with-module-mocks.mjs";

if (needsModuleMocksRelaunch()) {
  test("Builder summary response with isolated database mocks", () => {
    relaunchWithModuleMocks(import.meta.url);
  });
} else {
  let plans;
  let calls;
  let failWrite;
  let hasContent;
  let failDelete;
  let isolationLevel;
  let reuseLocks;
  let restricted;
  let reuseScopes;
  const rows = (values) => ({ rows: values, rowCount: values.length });
  async function query(sql, params = []) {
    calls.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();
    // Exercise reuse guard (afd31f09, lockExerciseReuse) and copied images (d9506ef6): both read
    // the transaction isolation first; reuse is allowed only under READ COMMITTED.
    if (normalized === "select current_setting('transaction_isolation') as isolation") return rows([{ isolation: isolationLevel }]);
    if (normalized === "set local lock_timeout = '2s'") return rows([]);
    if (normalized === "select pg_advisory_xact_lock_shared(hashtextextended('exercise_collections', 0))") { reuseLocks++; return rows([{}]); }
    // assertExerciseReuseAllowed: exercises of the plan the user may no longer reuse
    // ($2 = the plan ids the route asks about): it answers only for the plan being saved, so a
    // route that stops sending its plan would no longer be refused, and the test sees it
    if (normalized.startsWith("with recursive selected_nodes as")) {
      reuseScopes.push(params[1]);
      return rows(Array.isArray(params[1]) && params[1].includes("plan-1") ? restricted : []);
    }
    if (normalized.startsWith("select pi.id")) return rows([{ id: "item-1", plan_id: "plan-1", plan_node_id: "node-1" }]);
    if (normalized.startsWith("update plans.plan_items")) return rows([{ id: params[0], exercise_id: "exercise-1", title: "Squat (library text)", sets: params[1], reps: params[2], load: params[3], description: params[4] }]);
    // plan items in the reader's language (3ccf6149): the item still equals its exercise's text
    if (normalized.startsWith("select id, name, instruction, name_en, instruction_en from library.exercises")) {
      return rows(params[0].includes("exercise-1") ? [{ id: "exercise-1", name: "Squat (library text)", instruction: "Controlled", name_en: "Back squat", instruction_en: "Slow and controlled" }] : []);
    }
    if (normalized.startsWith("select p.id")) return rows(plans.has(params[0]) ? [plans.get(params[0])] : []);
    if (normalized.startsWith("select id from plans.plans")) return rows(plans.has(params[0]) ? [{ id: params[0] }] : []);
    if (normalized.startsWith("select id, created_by_user_id")) return rows([plans.get(params[0])]);
    if (normalized.includes("for update")) return rows([plans.get(params[0])]);
    if (normalized.startsWith("update plans.plans")) {
      if (failWrite) throw new Error("Write failed");
      const plan = plans.get(params[0]);
      plan.status = "active";
      return rows([{ ...plan, athlete_id: null }]);
    }
    if (normalized.startsWith("delete from plans.plans")) { plans.delete(params[0]); return rows([]); }
    if (/^delete from plans\.plan_(items|nodes|sessions|days)\b/.test(normalized)) {
      if (failDelete) throw new Error("Delete failed");
      return rows([]);
    }
    if (normalized.startsWith("insert into plans.plans")) {
      plans.set("copy-1", plan({ id: "copy-1" }));
      return rows([{ id: "copy-1" }]);
    }
    if (normalized.startsWith("insert into library.program_access")) return rows([]);
    if (normalized.includes("as has_content")) return rows([{ has_content: hasContent }]);
    if (normalized.startsWith("select pd.id as block_id")) return rows([{ block_id: "day-1", block_index: 1 }]);
    if (normalized.includes("where p.builder_batch_id")) return rows([...plans.values()]);
    if (normalized.startsWith("select") && normalized.includes("plans.plan_days")) return rows([]);
    if (["begin", "commit", "rollback", "release"].includes(normalized)) return rows([]);
    throw new Error(`Unexpected mock query: ${normalized}`);
  }
  mock.module("../src/db.js", { namedExports: { query, pool: { connect: async () => ({ query, release: () => calls.push({ sql: "release" }) }) } } });
  mock.module("../src/access.js", { namedExports: { athleteAccessPredicate: () => "false", athleteViewScopes: () => ({ clubIds: [], teamIds: [] }), programViewScopes: () => ({ clubIds: [], teamIds: [] }), canAccessAllAthletes: () => false, canAccessPlan: async () => true } });
  mock.module("../src/realtime.js", { namedExports: { emitRealtimeEvent() {} } });
  mock.module("../src/trainingLoadAccess.js", { namedExports: { isAthleteInWorkspaceScope() {}, resolveExternalScheduleWorkspaceScope() {} } });
  const { default: router } = await import("../src/routes/builder.js");
  const handler = (path, method = "post") => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  const submit = handler("/plans/:planId/submit");
  const edit = handler("/plans/:planId/edit");
  const duplicate = handler("/plans/:planId/duplicate");
  const updateItem = handler("/items/:itemId", "patch");
  const deletePlan = handler("/plans/:planId", "delete");
  const plan = (extra = {}) => ({ id: "plan-1", plan_type: "program", name: "Program", is_template: true, status: "draft", source_type: "builder", ...extra });
  beforeEach(() => { plans = new Map([["plan-1", plan()]]); calls = []; failWrite = false; failDelete = false; hasContent = true; isolationLevel = "read committed"; reuseLocks = 0; restricted = []; reuseScopes = []; });
  async function invoke(route, id = "plan-1", body = {}) {
    const result = { status: 200, headers: {} };
    const res = { status(value) { result.status = value; return this; }, setHeader(name, value) { result.headers[name] = value; }, json(value) { result.body = value; return this; } };
    await route({ params: { planId: id, itemId: "item-1" }, body, user: { id: "coach-1" } }, res, (error) => { result.error = error; });
    return result;
  }

  test("summary Save commits activation but skips reading the tree and batch", async () => {
    plans.get("plan-1").builder_batch_id = "batch-1";
    const result = await invoke(submit, "plan-1", { responseMode: "summary" });
    assert.equal(result.error, undefined);
    assert.equal(result.body.saved, true);
    assert.equal(result.body.plan.status, "active");
    assert.equal(result.body.blocks, undefined);
    assert.ok(calls.some(({ sql }) => sql === "commit"));
    assert.ok(!calls.some(({ sql }) => sql.includes("select pd.id as block_id") || sql.includes("where p.builder_batch_id")));
    assert.match(result.headers["Server-Timing"], /access;dur=.*response;dur=.*total;dur=/);
    assert.ok(reuseLocks > 0, "Save takes the exercise reuse lock (afd31f09)");
  });

  // The exercise reuse guard on Save (afd31f09): the mock answers its checks, so they are tested.
  test("Save outside READ COMMITTED is refused by the exercise reuse guard and nothing commits", async () => {
    isolationLevel = "repeatable read";
    const result = await invoke(submit, "plan-1", { responseMode: "summary" });
    assert.equal(result.error?.status, 409);
    assert.match(result.error.message, /READ COMMITTED/);
    // The empty-draft check commits its own short transaction first (by design). The activation
    // transaction (the last begin) runs the guard after its UPDATE and must end in rollback.
    const activation = calls.slice(calls.findLastIndex(({ sql }) => sql === "begin"));
    assert.ok(activation.some(({ sql }) => /^\s*update plans\.plans\b/.test(sql)));
    assert.ok(activation.some(({ sql }) => sql === "rollback"));
    assert.ok(!activation.some(({ sql }) => sql === "commit"));
  });

  test("Save with an exercise the coach may no longer reuse is refused and nothing commits", async () => {
    restricted = [{ id: "exercise-revoked", uses: 1 }];
    const result = await invoke(submit, "plan-1", { responseMode: "summary" });
    assert.equal(result.error?.status, 409);
    assert.equal(result.error.message, "exerciseAccessRevoked");
    assert.deepEqual(reuseScopes.at(-1), ["plan-1"], "the guard is asked about exactly the plan being saved");
    // The empty-draft check commits its own short transaction first (by design). The activation
    // transaction (the last begin) runs the guard after its UPDATE and must end in rollback.
    const activation = calls.slice(calls.findLastIndex(({ sql }) => sql === "begin"));
    assert.ok(activation.some(({ sql }) => /^\s*update plans\.plans\b/.test(sql)));
    assert.ok(activation.some(({ sql }) => sql === "rollback"));
    assert.ok(!activation.some(({ sql }) => sql === "commit"));
  });

  test("item response updates dose fields without reading the full draft", async () => {
    const result = await invoke(updateItem, "plan-1", { responseMode: "item", sets: "3", reps: "12", load: "20 kg", description: "Controlled" });
    assert.equal(result.error, undefined);
    // the English of the item's exercise comes along (3ccf6149), from one lookup of that exercise
    assert.deepEqual(result.body, { planId: "plan-1", item: { id: "item-1", sets: "3", reps: "12", load: "20 kg", description: "Controlled", titleEn: "Back squat", descriptionEn: "Slow and controlled" } });
    assert.equal(calls.length, 4);
    assert.equal(calls.filter(({ sql }) => sql.includes("from library.exercises where id = any")).length, 1);
    assert.ok(!calls.some(({ sql }) => sql.includes("select pd.id as block_id")));
  });

  test("older item clients and syncBatch requests still receive a full draft", async () => {
    for (const body of [{ sets: "3" }, { responseMode: "item", syncBatch: true, reps: "8" }]) {
      const result = await invoke(updateItem, "plan-1", body);
      assert.equal(result.error, undefined);
      assert.equal(result.body.plan.id, "plan-1");
      assert.equal(result.body.blocks.length, 1);
    }
  });

  test("compact item response does not bypass plan access", async () => {
    plans.clear();
    const result = await invoke(updateItem, "plan-1", { responseMode: "item", reps: "12" });
    assert.equal(result.status, 404);
    assert.ok(!calls.some(({ sql }) => sql.startsWith("update")));
  });

  test("discard deletes plan content in four scoped queries and commits before replying", async () => {
    const result = await invoke(deletePlan);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.body, { deleted: true, planId: "plan-1" });
    const deletes = calls.filter(({ sql }) => sql.startsWith("delete"));
    assert.equal(deletes.length, 5);
    assert.ok(deletes.every(({ params }) => params[0] === "plan-1"));
    assert.equal(calls.at(-2).sql, "commit");
    assert.equal(calls.at(-1).sql, "release");
  });

  test("discard failure rolls back and releases without reporting success", async () => {
    failDelete = true;
    const result = await invoke(deletePlan);
    assert.equal(result.error.message, "Delete failed");
    assert.equal(result.body, undefined);
    assert.equal(plans.has("plan-1"), true);
    assert.equal(calls.at(-2).sql, "rollback");
    assert.equal(calls.at(-1).sql, "release");
  });

  test("discard keeps the existing access gate", async () => {
    const result = await invoke(deletePlan, "missing-plan");
    assert.equal(result.status, 404);
    assert.equal(calls.length, 1);
  });

  test("default response stays a full draft for Assign and older clients", async () => {
    plans.get("plan-1").builder_batch_id = "batch-1";
    const result = await invoke(submit);
    assert.equal(result.error, undefined);
    assert.equal(result.body.plan.status, "active");
    assert.equal(result.body.blocks.length, 1);
    assert.equal(result.body.batch.id, "batch-1");
    assert.ok(calls.some(({ sql }) => sql.includes("select pd.id as block_id")));
  });

  test("summary contains the navigation context for a Weekly athlete", async () => {
    plans.set("plan-1", plan({ plan_type: "weekly", week_start: "2026-10-05", athlete_source_external_id: "19006", is_template: false }));
    const result = await invoke(submit, "plan-1", { responseMode: "summary" });
    assert.equal(result.error, undefined);
    assert.equal(result.body.plan.athleteId, "19006");
    assert.equal(result.body.plan.weekStart, "2026-10-05");
    assert.equal(result.body.plan.planType, "weekly");
  });

  test("summary Save applies an edit draft, returns the original id, and removes the draft", async () => {
    plans.set("plan-1", plan({ status: "active" }));
    plans.set("edit-1", plan({ id: "edit-1", is_edit_draft: true, edit_source_plan_id: "plan-1" }));
    const result = await invoke(submit, "edit-1", { responseMode: "summary" });
    assert.equal(result.error, undefined);
    assert.equal(result.body.plan.id, "plan-1");
    assert.equal(plans.has("edit-1"), false);
    assert.ok(!calls.some(({ sql }) => sql.includes("select pd.id as block_id")));
    assert.match(result.headers["Server-Timing"], /apply;dur=/);
  });

  test("failed activation rolls back instead of returning a successful summary", async () => {
    failWrite = true;
    const result = await invoke(submit, "plan-1", { responseMode: "summary" });
    assert.equal(result.error.message, "Write failed");
    assert.equal(result.body, undefined);
    assert.equal(calls.at(-2).sql, "rollback");
  });

  test("summary cannot bypass the existing not-found access gate", async () => {
    const result = await invoke(submit, "missing-plan", { responseMode: "summary" });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Draft program not found");
    assert.equal(calls.length, 1);
  });

  test("summary mode retains the existing empty-draft deletion response", async () => {
    hasContent = false;
    const result = await invoke(submit, "plan-1", { responseMode: "summary" });
    assert.equal(result.error, undefined);
    assert.equal(result.body.deleted, true);
    assert.equal(result.body.empty, true);
    assert.equal(result.body.saved, undefined);
    assert.equal(plans.has("plan-1"), false);
  });

  test("opening an existing draft retains the full response and adds timings", async () => {
    const result = await invoke(edit);
    assert.equal(result.error, undefined);
    assert.equal(result.body.blocks.length, 1);
    assert.match(result.headers["Server-Timing"], /access;dur=.*response;dur=.*total;dur=/);
  });

  test("Copy retains its draft and assignment response, with copy timings", async () => {
    const result = await invoke(duplicate);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 201);
    assert.equal(result.body.plan.id, "copy-1");
    assert.equal(result.body.plan.status, "draft");
    assert.equal(result.body.blocks.length, 1);
    assert.deepEqual(result.body.assignments, [{ athleteId: null, planId: "copy-1" }]);
    assert.match(result.headers["Server-Timing"], /copy;dur=/);
    assert.ok(calls.some(({ sql }) => sql === "commit"));
  });
}
