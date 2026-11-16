// G1 (docs/ai/gpexe-field-inventory-plan.md, section 8): the pure parts that need no migration - route C's body and the
// key, shape and levels the server derives (8.1), and which evidence statuses prove a revision (8.4).
import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(deriveField(body({ name: "id" })).sourceMetricKey, "details.players.id", "a structural list is per endpoint");
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
