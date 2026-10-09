import { beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("Builder summary response with isolated database mocks", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  let plans;
  let calls;
  let failWrite;
  let hasContent;
  const rows = (values) => ({ rows: values, rowCount: values.length });
  async function query(sql, params = []) {
    calls.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("select p.id")) return rows(plans.has(params[0]) ? [plans.get(params[0])] : []);
    if (normalized.startsWith("select id, created_by_user_id")) return rows([plans.get(params[0])]);
    if (normalized.includes("for update")) return rows([plans.get(params[0])]);
    if (normalized.startsWith("update plans.plans")) {
      if (failWrite) throw new Error("Write failed");
      const plan = plans.get(params[0]);
      plan.status = "active";
      return rows([{ ...plan, athlete_id: null }]);
    }
    if (normalized.startsWith("delete from plans.plans")) { plans.delete(params[0]); return rows([]); }
    if (/^delete from plans\.plan_(items|nodes|sessions|days)\b/.test(normalized)) return rows([]);
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
  mock.module("../src/access.js", { namedExports: { athleteAccessPredicate: () => "false", canAccessAllAthletes: () => false, canAccessPlan: async () => true } });
  mock.module("../src/realtime.js", { namedExports: { emitRealtimeEvent() {} } });
  mock.module("../src/trainingLoadAccess.js", { namedExports: { isAthleteInWorkspaceScope() {}, resolveExternalScheduleWorkspaceScope() {} } });
  const { default: router } = await import("../src/routes/builder.js");
  const handler = (path) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods.post).route.stack[0].handle;
  const submit = handler("/plans/:planId/submit");
  const edit = handler("/plans/:planId/edit");
  const duplicate = handler("/plans/:planId/duplicate");
  const plan = (extra = {}) => ({ id: "plan-1", plan_type: "program", name: "Program", is_template: true, status: "draft", source_type: "builder", ...extra });
  beforeEach(() => { plans = new Map([["plan-1", plan()]]); calls = []; failWrite = false; hasContent = true; });
  async function invoke(route, id = "plan-1", body = {}) {
    const result = { status: 200, headers: {} };
    const res = { status(value) { result.status = value; return this; }, setHeader(name, value) { result.headers[name] = value; }, json(value) { result.body = value; return this; } };
    await route({ params: { planId: id }, body, user: { id: "coach-1" } }, res, (error) => { result.error = error; });
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
