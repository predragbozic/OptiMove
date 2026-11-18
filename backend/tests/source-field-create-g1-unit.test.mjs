// G1 (docs/ai/gpexe-field-inventory-plan.md, section 8): the pure parts that need no migration - route C's body and the
// key, shape and levels the server derives (8.1), and which evidence statuses prove a revision (8.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveField, FieldCreateRefusal, parseCreateFieldBody } from "../src/sourceFieldCreate.js";
import { PROVEN_STATUSES, revisionProven, statusProven } from "../src/sourceFieldEvidence.js";

const KEY = "0b0e8a52-2f2c-4b2b-9d7e-4a8f2c1d3e4f";
const body = (over = {}) => ({ requestKey: KEY, endpoint: "details.session", name: "metabolic_power", label: "Metabolic power", supportsSession: true, supportsDrill: true, ...over });
const refused = (fn, status, code) => assert.throws(fn, (e) => e instanceof FieldCreateRefusal && e.status === status && e.code === code, `${status} ${code}`);

test("route C's body: every key known and required, the types right, the label one bounded line, a level at least", () => {
  assert.deepEqual(parseCreateFieldBody(body()), { ...body(), requestKey: KEY });
  assert.equal(parseCreateFieldBody(body({ requestKey: KEY.toUpperCase() })).requestKey, KEY, "the key is kept lower case");
  for (const bad of [null, [], "x", body({ extra: 1 }), body({ sourceMetricKey: "athlete_session.x" })]) refused(() => parseCreateFieldBody(bad), 400, "invalid_body");
  for (const key of ["requestKey", "endpoint", "name", "label", "supportsSession", "supportsDrill"]) {
    const b = body(); delete b[key];
    refused(() => parseCreateFieldBody(b), 400, "invalid_body");
  }
  refused(() => parseCreateFieldBody(body({ requestKey: "not-a-uuid" })), 400, "invalid_body");
  refused(() => parseCreateFieldBody(body({ name: "bad-name" })), 400, "invalid_body");
  refused(() => parseCreateFieldBody(body({ name: "x".repeat(65) })), 400, "invalid_body");
  refused(() => parseCreateFieldBody(body({ supportsSession: "yes" })), 400, "invalid_body");
  refused(() => parseCreateFieldBody(body({ supportsSession: false, supportsDrill: false })), 400, "invalid_body");
  for (const label of ["", " lead", "trail ", "two\nlines", "x".repeat(81), 7]) refused(() => parseCreateFieldBody(body({ label })), 400, "invalid_body");
  assert.equal(parseCreateFieldBody(body({ label: "x".repeat(80) })).label.length, 80);
});

test("the key, shape and levels are derived from the endpoint and the observed name; never typed", () => {
  assert.deepEqual(deriveField(body()), { sourceMetricKey: "details.players.metabolic_power", valueShape: "unit_value_object", parameterKind: "none", supportsSession: true, supportsDrill: true });
  assert.equal(deriveField(body({ endpoint: "details.drill" })).sourceMetricKey, "details.players.metabolic_power", "one field for the session and the drill answer");
  assert.deepEqual(deriveField(body({ endpoint: "athlete_session", name: "average_v" })), { sourceMetricKey: "athlete_session.average_v", valueShape: "number", parameterKind: "none", supportsSession: true, supportsDrill: true });
  for (const endpoint of ["more.events", "more.complementary_data", "team_thresholds", "anything", "__proto__", "constructor"]) refused(() => deriveField(body({ endpoint })), 409, "shape_not_generic");
  for (const [endpoint, name] of [["athlete_session", "teamsession"], ["athlete_session", "id"], ["athlete_session", "start_timestamp"]]) refused(() => deriveField(body({ endpoint, name })), 409, "name_not_observed");
  // 2026-11-18 (the owner's first use): a reference, a group, a flag or a time is refused on every endpoint.
  for (const name of ["id", "athlete", "athlete_session_id", "are_values_visible", "validity_start"]) refused(() => deriveField(body({ name })), 409, "name_not_observed");
  for (const name of ["Zeta_count", "speedMax", "HR"]) refused(() => deriveField(body({ name })), 409, "name_not_supported");
  refused(() => deriveField(body({ endpoint: "details.drill", supportsDrill: false })), 400, "invalid_body");
});

test("proven is verified or source_stated, with a unit; nothing else opens a field", () => {
  assert.deepEqual([...PROVEN_STATUSES], ["verified", "source_stated"]);
  for (const s of ["verified", "source_stated"]) assert.equal(statusProven(s), true);
  for (const s of ["unproven", "documented", "observed", null, undefined, "VERIFIED"]) assert.equal(statusProven(s), false);
  assert.equal(revisionProven({ evidence_status: "source_stated", source_unit: "count" }), true);
  assert.equal(revisionProven({ evidence_status: "verified", source_unit: null }), false);
  assert.equal(revisionProven({ evidence_status: "observed", source_unit: "m" }), false);
  assert.equal(revisionProven(null), false);
});

// v74's T2a guard holds a write only when it carries an acting user (plan section 8.9, a recorded limit of C74's
// class). This proves no application write can reach T2a without one: the only file of backend/src that inserts into
// training_load.source_metric_definitions is route C's service, and its insert runs inside M2's runWrite, which sets
// the transaction's acting user before the first protected write.

test("architecture: route C's service is the only application writer of T2a, and it writes inside runWrite (the acting user set first)", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
  walk(src);
  const writesT2a = /\b(insert\s+into|update|delete\s+from)\s+training_load\.source_metric_definitions\b(?!_)/i;
  const writers = files.filter((f) => writesT2a.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(src, f));
  assert.deepEqual(writers, ["sourceFieldCreateService.js"]);
  const text = fs.readFileSync(path.join(src, "sourceFieldCreateService.js"), "utf8");
  const runAt = text.indexOf("return runWrite({");
  const insertAt = text.search(/insert into training_load\.source_metric_definitions\b(?!_)/);
  assert.ok(runAt > 0 && insertAt > runAt, "the insert is inside runWrite's body");
  const kit = fs.readFileSync(path.join(src, "sourceMetricMappingService.js"), "utf8");
  const body = kit.slice(kit.indexOf("async function runWrite("));
  assert.ok(body.indexOf("ACTOR_CONTEXT_SQL") > 0 && body.indexOf("ACTOR_CONTEXT_SQL") < body.indexOf("await operation(client, operationId)"),
    "runWrite sets the acting user before it runs the operation");
});

test("v74 takes every lock before its first change, in the writers' order (T4, T2a, T2b, T9, T9i, T8 NOWAIT last), within lock_timeout - the recorded SQL order (migrations.md, PR #346)", async () => {
  const { readFileSync } = await import("node:fs");
  const file = new URL("../../migrations_v2/202611161200_training_load_v74_generic_source_fields.sql", import.meta.url);
  // Top-level statements only: dollar-quoted bodies and comments removed, then split on ';'.
  const top = readFileSync(file, "utf8").replace(/\$\$[\s\S]*?\$\$/g, "$$$$").replace(/--[^\n]*/g, "")
    .split(";").map((t) => t.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
  const idx = (re) => top.findIndex((t) => re.test(t));
  const timeout = idx(/^set local lock_timeout = '5s'$/);
  const locks = [
    /^lock table training_load\.source_metric_mapping_versions in share row exclusive mode$/,
    /^lock table training_load\.source_metric_definitions in share row exclusive mode$/,
    /^lock table training_load\.source_metric_definition_versions in access exclusive mode$/,
    /^lock table training_load\.source_metric_confirmations in access exclusive mode$/,
    /^lock table training_load\.source_metric_confirmation_items in access exclusive mode$/,
    /^lock table training_load\.source_metric_audit in access exclusive mode nowait$/,
  ].map(idx);
  assert.equal(timeout, 0, "the lock timeout is the first statement");
  assert.ok(locks.every((i) => i > 0), `every lock is taken: ${locks}`);
  assert.deepEqual([...locks].sort((a, b) => a - b), locks, "in the writers' order");
  assert.equal(top.filter((t) => t.startsWith("lock table")).length, locks.length, "no other lock statement");
  const firstChange = idx(/^(create|alter|drop|insert|update|delete|comment|do )/);
  assert.ok(firstChange > Math.max(...locks), `every lock before the first change (${firstChange})`);
});
