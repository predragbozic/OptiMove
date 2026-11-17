// G1, route C (docs/ai/gpexe-field-inventory-plan.md, section 8.1): the pure part of creating a generic source field from
// the inventory - the body's shape and the key, value shape and levels the server derives. Nothing here reads the
// database; the service checks that the name was observed (source_field_observations), is not taken (T2a), and writes.
// The key is never typed: it is built from the endpoint and the observed name only.
import { boundedText } from "./metricTextRules.js";
import { isStructuralField } from "./sourceFieldInventory.js";
import { DANGEROUS_FIELD_NAMES } from "./sourcePinnedFields.js";

export const LABEL_MAX_LENGTH = 80;
// The generic plain shapes (Q4): one row number, one details {unit, value}. Zones and events stay code.
// The value kinds a check keeps for each generic shape (the inventory's kinds, sourceFieldInventory.js): a number in an
// athlete row, a value with its unit in the details, or no value. G1b's "Create field" is offered only for a name every
// connection saw in one of these.
export const KEPT_VALUE_KINDS = Object.freeze({
  number: Object.freeze(["number", "null"]),
  unit_value_object: Object.freeze(["unit_value_object", "null"]),
});
export const GENERIC_ENDPOINTS = Object.freeze({
  athlete_session: Object.freeze({ prefix: "athlete_session.", valueShape: "number" }),
  "details.session": Object.freeze({ prefix: "details.players.", valueShape: "unit_value_object" }),
  "details.drill": Object.freeze({ prefix: "details.players.", valueShape: "unit_value_object" }),
});
// T2a's key CHECK (v34): `^[a-z][a-z0-9_.]{1,120}$`. A name must keep the whole key inside it (decision (e)).
const T2A_KEY = /^[a-z][a-z0-9_.]{1,120}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ["requestKey", "endpoint", "name", "label", "supportsSession", "supportsDrill"];

export class FieldCreateRefusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (message) => new FieldCreateRefusal(400, "invalid_body", message);

// The body, checked before any lock: every key known, every type right. Answers what the service writes.
export function parseCreateFieldBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("The body is a JSON object.");
  for (const key of Object.keys(body)) if (!KEYS.includes(key)) throw bad(`The body carries a key this route does not take (${KEYS.join(", ")}).`);
  for (const key of KEYS) if (!Object.prototype.hasOwnProperty.call(body, key)) throw bad(`${key} is required.`);
  if (typeof body.requestKey !== "string" || !UUID.test(body.requestKey)) throw bad("requestKey is a UUID.");
  if (typeof body.endpoint !== "string") throw bad("endpoint is text.");
  if (typeof body.name !== "string" || !NAME.test(body.name)) throw bad("name is a GPEXE field name (letters, digits and _).");
  if (typeof body.supportsSession !== "boolean" || typeof body.supportsDrill !== "boolean") throw bad("supportsSession and supportsDrill are true or false.");
  if (!body.supportsSession && !body.supportsDrill) throw bad("The field supports the session, the drill or both.");
  if (!boundedText(body.label, LABEL_MAX_LENGTH)) throw bad(`label is one line of 1-${LABEL_MAX_LENGTH} visible characters without surrounding spaces.`);
  return { requestKey: body.requestKey.toLowerCase(), endpoint: body.endpoint, name: body.name, label: body.label, supportsSession: body.supportsSession, supportsDrill: body.supportsDrill };
}

// The field the server would create: its key, value shape and levels, or the refusal (section 8.1's table).
export function deriveField({ endpoint, name, supportsSession, supportsDrill }) {
  const generic = Object.prototype.hasOwnProperty.call(GENERIC_ENDPOINTS, endpoint) ? GENERIC_ENDPOINTS[endpoint] : null;
  if (!generic) throw new FieldCreateRefusal(409, "shape_not_generic", "Only a per-athlete number or a whole-session or drill value with its unit can be created here; zones and events are added in code.");
  if (isStructuralField(endpoint, name)) throw new FieldCreateRefusal(409, "name_not_observed", "This name is an identifier or a time, not a value GPEXE measured.");
  // G2: a name a check could never keep (an object key of every JavaScript object) is never created.
  if (DANGEROUS_FIELD_NAMES.has(name)) throw new FieldCreateRefusal(409, "name_not_supported", "This GPEXE name cannot become a field.");
  const key = `${generic.prefix}${name}`;
  if (!T2A_KEY.test(key)) throw new FieldCreateRefusal(409, "name_not_supported", "This GPEXE name cannot become a field yet (only lower-case names are supported).");
  if (endpoint === "details.drill" && !supportsDrill) throw bad("A name GPEXE sends per drill supports the drill level.");
  return { sourceMetricKey: key, valueShape: generic.valueShape, parameterKind: "none", supportsSession, supportsDrill };
}
