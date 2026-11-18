// I1: the in-memory collector of field names (backend/src/sourceFieldInventory.js) - kinds, the answer's unit word, the
// name guard, the per-endpoint and total bounds, one count per answer, and that it never throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFieldCollector, isStructuralField, MAX_PER_ENDPOINT, STRUCTURAL_FIELDS, valueKind } from "../src/sourceFieldInventory.js";

test("kinds: number, text, boolean, null, unit_value_object, zone_list, object, list", () => {
  assert.equal(valueKind(1.5), "number");
  assert.equal(valueKind("x"), "text");
  assert.equal(valueKind(true), "boolean");
  assert.equal(valueKind(null), "null");
  assert.equal(valueKind({ unit: "m", value: 3 }), "unit_value_object");
  assert.equal(valueKind([{ extremes: [0, 1], distance: 3 }]), "zone_list");
  assert.equal(valueKind({ a: 1 }), "object");
  assert.equal(valueKind([1, 2]), "list");
  assert.equal(valueKind(Infinity), "text");
});

test("names only, once per answer: a details answer's metrics over every athlete count as one answer; the unit word is the answer's own and must be a unit token", () => {
  const c = createFieldCollector();
  c.observe("details.session", { players: { 101: { speed_x: { unit: "m/s", value: 7 }, bad_unit: { unit: "has space", value: 1 } }, 102: { speed_x: { unit: "m/s", value: 8 } } } });
  c.observe("details.session", { players: { 103: { speed_x: { unit: "m/s", value: 9 } } } });
  const rows = c.rows();
  const speed = rows.find((r) => r.name === "speed_x");
  assert.deepEqual([speed.endpoint, speed.kind, speed.unitWord, speed.answers], ["details.session", "unit_value_object", "m/s", 2]);
  assert.equal(rows.find((r) => r.name === "bad_unit").unitWord, null, "a unit that is not a token is not kept");
  assert.doesNotMatch(JSON.stringify(rows), /\b10[123]\b|"7"|"8"|"9"/, "no athlete id and no value");
});

test("the name guard: not an identifier, too long, or a prototype key is never kept, only counted", () => {
  const c = createFieldCollector();
  c.observe("athlete_session", { "bad-name": 1, ["x".repeat(65)]: 1, constructor: 1, ok_name: 1 });
  assert.deepEqual(c.rows().map((r) => r.name), ["ok_name"]);
  assert.equal(c.rejected, 3);
});

test("more: events and complementary_data under their own endpoints", () => {
  const c = createFieldCollector();
  c.observe("more", { athletesession_id: 5, events: { acc_count: 3 }, complementary_data: { power: [{ extremes: [0, 20], distance: 10 }] } });
  assert.deepEqual(c.rows().map((r) => `${r.endpoint}:${r.name}:${r.kind}`), ["more.complementary_data:power:zone_list", "more.events:acc_count:number"]);
});

test("bounds: at most MAX_PER_ENDPOINT names per endpoint, so at most six times that per check; the rest is counted, never kept", () => {
  const c = createFieldCollector();
  const many = (n, prefix) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 1]));
  c.observe("athlete_session", many(MAX_PER_ENDPOINT + 5, "a"));
  assert.equal(c.rows().filter((r) => r.endpoint === "athlete_session").length, MAX_PER_ENDPOINT);
  assert.equal(c.dropped, 5);
  for (const endpoint of ["team_thresholds", "details.session", "details.drill", "more.events", "more.complementary_data"]) {
    if (endpoint.startsWith("details")) c.observe(endpoint, { players: { 1: many(MAX_PER_ENDPOINT, `${endpoint.slice(-3)}`) } });
    else if (endpoint.startsWith("more")) c.observe("more", { [endpoint === "more.events" ? "events" : "complementary_data"]: many(MAX_PER_ENDPOINT, endpoint.slice(-3)) });
    else c.observe(endpoint, many(MAX_PER_ENDPOINT, "t"));
  }
  assert.equal(c.rows().length, 6 * MAX_PER_ENDPOINT);
});

test("never throws: odd answers and a throwing getter are ignored", () => {
  const c = createFieldCollector();
  const hostile = {};
  Object.defineProperty(hostile, "boom", { enumerable: true, get() { throw new Error("no"); } });
  assert.doesNotThrow(() => c.observe("athlete_session", hostile));
  assert.doesNotThrow(() => c.observe("details.session", null));
  assert.doesNotThrow(() => c.observe("unknown", { a: 1 }));
  assert.deepEqual(c.rows().filter((r) => r.name === "a"), [], "an unknown endpoint records nothing");
});

test("the unit word is v40's unit token exactly: every character the database refuses drops the word, never the name", () => {
  const c = createFieldCollector();
  const odd = ["m\u200b", "m\u00ad", "m\u202e", "m\u3164", "\u2800", "m\ufe0f", "m\u{e0041}", "m\u2060", "m\u00a0", "m|s", "m=s", "x".repeat(31)];
  const players = Object.fromEntries(odd.map((unit, i) => [`f${i}`, { unit, value: 1 }]));
  c.observe("details.session", { players: { 1: { ...players, ok_unit: { unit: "km/h", value: 1 } } } });
  for (const row of c.rows()) assert.equal(row.unitWord, row.name === "ok_unit" ? "km/h" : null, row.name);
  assert.equal(c.rows().length, odd.length + 1);
});

test("structural keys (the Rukovodilac's decision (b)): an identifier, a reference or a timestamp is never recorded, a measured value beside it is", () => {
  const c = createFieldCollector();
  c.observe("athlete_session", {
    id: 7, athlete: 101, teamsession: 5001, track: 9001, drill: null, team: 77, start_timestamp: "2026-09-14T18:08:12",
    end_timestamp: "2026-09-14T19:19:35", created_on: "x", updated_on: "y", is_stats_valid: true, total_distance: 3000,
  });
  c.observe("team_thresholds", { id: 1473, team: 77, validity_start: "2025-01-01T00:00:00", validity_end: null, speed_thresholds: [5.5, 7], use_hr_min: true });
  // A details players' map: the same names are measured values there, never on the structural list.
  c.observe("details.session", { players: { 101: { id: 1, team: 2, tot_burst_events: { unit: "number", value: 3 } } } });
  assert.deepEqual(c.rows().map((r) => `${r.endpoint}:${r.name}`), [
    "athlete_session:is_stats_valid", "athlete_session:total_distance",
    "details.session:id", "details.session:team", "details.session:tot_burst_events",
    "team_thresholds:speed_thresholds", "team_thresholds:use_hr_min",
  ]);
  assert.equal(c.rejected, 0, "a structural key is skipped, not counted as a refused name");
  assert.deepEqual(Object.keys(STRUCTURAL_FIELDS).sort(), ["athlete_session", "team_thresholds"]);
  assert.ok(isStructuralField("athlete_session", "teamsession"));
  // 2026-11-18: by name on every endpoint too (route C and the list); the collector still skips only the exact pairs.
  for (const name of ["id", "athlete", "athlete_session_id", "are_values_visible", "is_x_visible", "validity_end", "start_timestamp"]) assert.ok(isStructuralField("details.session", name), name);
  for (const name of ["metabolic_power", "athletesessionpowerzone_distance_4", "idle_time", "video"]) assert.ok(!isStructuralField("details.session", name), name);
  assert.ok(Object.isFrozen(STRUCTURAL_FIELDS) && Object.isFrozen(STRUCTURAL_FIELDS.athlete_session));
});
