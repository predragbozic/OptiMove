// I1 (docs/ai/gpexe-field-inventory-plan.md, sections 1 and 6): the names of the fields a source answer carries, collected
// in memory by a check from the answers it already reads, never a value, an athlete id, a session id, a date or raw JSON.
// The adapter calls observe() right after it accepted (projected) an answer; the check's finalization writes the result
// in one statement (training_load.source_field_observations, migration v70), only when the check succeeds.
//
// Bounds: a name must be an identifier (the projection's own METRIC_NAME rule) and never a prototype key; at most
// MAX_PER_ENDPOINT names per endpoint, so at most 6 x 300 = 1,800 per check; the rest is counted (rejected / dropped), never
// kept. The unit word is v40's unit token exactly (metricTextRules.unitTokenOk, the twin of
// training_load.source_metric_unit_token_ok), so no word the database refuses ever reaches the write.

import { unitTokenOk } from "./metricTextRules.js";

export const FIELD_ENDPOINTS = Object.freeze(["athlete_session", "more.events", "more.complementary_data", "details.session", "details.drill", "team_thresholds"]);
export const VALUE_KINDS = Object.freeze(["number", "text", "boolean", "null", "unit_value_object", "zone_list", "object", "list"]);
export const MAX_PER_ENDPOINT = 300;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function valueKind(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "text";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "text";
  if (Array.isArray(v)) return v.length && v.every((z) => isPlainObject(z) && Object.prototype.hasOwnProperty.call(z, "extremes")) ? "zone_list" : "list";
  if (isPlainObject(v)) return Object.prototype.hasOwnProperty.call(v, "unit") && Object.prototype.hasOwnProperty.call(v, "value") ? "unit_value_object" : "object";
  return "text";
}

function unitWordOf(v) {
  if (!isPlainObject(v) || typeof v.unit !== "string") return null;
  return unitTokenOk(v.unit) ? v.unit : null;
}

export function createFieldCollector() {
  const fields = new Map(); // `${endpoint}\u0000${name}` -> { endpoint, name, kind, unitWord, answers }
  const perEndpoint = new Map();
  let rejected = 0;
  let dropped = 0;

  function note(endpoint, name, value, seen) {
    if (typeof name !== "string" || !NAME.test(name) || PROTOTYPE_KEYS.has(name)) { rejected += 1; return; }
    const key = `${endpoint}\u0000${name}`;
    if (seen.has(key)) return; // once per answer
    seen.add(key);
    let entry = fields.get(key);
    if (!entry) {
      if ((perEndpoint.get(endpoint) || 0) >= MAX_PER_ENDPOINT) { dropped += 1; return; }
      entry = { endpoint, name, kind: valueKind(value), unitWord: unitWordOf(value), answers: 0 };
      fields.set(key, entry);
      perEndpoint.set(endpoint, (perEndpoint.get(endpoint) || 0) + 1);
    } else {
      // The latest answer's shape, and its unit word when it carries one.
      entry.kind = valueKind(value);
      const word = unitWordOf(value);
      if (word !== null) entry.unitWord = word;
    }
    entry.answers += 1;
  }

  // One accepted source answer of an endpoint. `answer` is the raw body the adapter just projected.
  function observe(endpoint, answer) {
    try {
      if (!isPlainObject(answer)) return;
      const seen = new Set();
      if (endpoint === "athlete_session" || endpoint === "team_thresholds") {
        for (const [name, value] of Object.entries(answer)) note(endpoint, name, value, seen);
      } else if (endpoint === "more") {
        if (isPlainObject(answer.events)) for (const [name, value] of Object.entries(answer.events)) note("more.events", name, value, seen);
        if (isPlainObject(answer.complementary_data)) for (const [name, value] of Object.entries(answer.complementary_data)) note("more.complementary_data", name, value, seen);
      } else if (endpoint === "details.session" || endpoint === "details.drill") {
        if (!isPlainObject(answer.players)) return;
        for (const metrics of Object.values(answer.players)) {
          if (!isPlainObject(metrics)) continue;
          for (const [name, value] of Object.entries(metrics)) note(endpoint, name, value, seen);
        }
      }
    } catch {
      // Collecting names never fails a check.
    }
  }

  function rows() {
    return [...fields.values()].sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return { observe, rows, get rejected() { return rejected; }, get dropped() { return dropped; } };
}
