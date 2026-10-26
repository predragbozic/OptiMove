// Training Load -> Data configuration -> Variables (M3a, decisions C80-C88):
// the administrator's screen over the canonical-variable admin API of M3-0
// (/api/training-load/sources/metrics/variables, J3). A canonical variable is a
// Metrics Core definition the source data is later mapped to; this screen
// lists them, shows one with its versions, creates one and adds a new
// immutable semantic version. It never sends an owner, an actor or a basis:
// the server derives the owner from the active workspace (the platform
// workspace: the system variables; a club workspace: that club's own) and
// answers everyone else with the same 404.
import { api } from "./api.js";
import { state } from "./state.js";

const BASE = "/api/training-load/sources/metrics/variables";

// The unit tokens the screen suggests (C85); any unit token is accepted.
export const UNIT_SUGGESTIONS = Object.freeze(["s", "min", "m", "km", "m/s", "km/h", "count", "W/kg"]);
export const AGGREGATIONS = Object.freeze([
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "max", label: "Highest" },
  { value: "last", label: "Latest" },
  { value: "none", label: "Keep each value (no day value)" },
]);
export const OPERATORS = Object.freeze([
  { value: ">=", label: "at least (≥)" },
  { value: ">", label: "more than (>)" },
  { value: "<=", label: "at most (≤)" },
  { value: "<", label: "less than (<)" },
]);
export const CONDITION_KINDS = Object.freeze([
  { value: "none", label: "No condition" },
  { value: "zone_between", label: "Zone between two levels" },
  { value: "zone_one_sided", label: "Zone above or below one level" },
  { value: "event_threshold", label: "Effort past a threshold (event)" },
]);
export const LEVELS = Object.freeze([
  { value: "session", label: "Session" },
  { value: "drill", label: "Drill" },
]);
// The admin API's input limits (C86).
export const LIMITS = Object.freeze({ label: 80, shortLabel: 20, description: 500, key: 63, unit: 30, reason: 500 });

// The same rules the server applies (J3), checked here first so a coach sees
// the problem at the field; the server checks them again.
const DECIMAL = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/;
const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const UNIT_FORBIDDEN = /[\s|=\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u061c\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/u;
const TEXT_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;

export function emptyVariablesState() {
  return {
    // Bumped on every reset: an answer for an older view is dropped.
    generation: 0,
    scope: "own",
    stateFilter: "active",
    list: { items: [], nextCursor: null, loaded: false, loading: false, loadingMore: false, error: null },
    detail: { id: null, variable: null, nextCursor: null, loading: false, loadingMore: false, error: null },
    form: null,
    notice: "",
  };
}

function v() {
  if (!state.trainingLoad.variables) state.trainingLoad.variables = emptyVariablesState();
  return state.trainingLoad.variables;
}
export { v as variablesState };

// Who is looking, from the active workspace the client already holds (/me).
// The platform workspace is a platform admin's; a club workspace is its club
// admin's or a platform admin's for support (C80). The server decides again
// on every request and answers anyone else with the same 404.
export function variablesContext(user = state.currentUser) {
  const ws = user?.activeWorkspace || null;
  if (!ws) return null;
  if (ws.type === "platform") return { owner: "system", clubId: null, clubName: "" };
  if (ws.type === "club" && ws.scopeId) return { owner: "club", clubId: String(ws.scopeId), clubName: ws.label || "" };
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export function listUrl({ scope, stateFilter, cursor = null }) {
  const params = new URLSearchParams({ scope, state: stateFilter });
  if (cursor) params.set("cursor", cursor);
  return `${BASE}?${params.toString()}`;
}
export const detailUrl = (id, cursor = null) => `${BASE}/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
export const keySuggestionUrl = (label) => `${BASE}/key-suggestion?label=${encodeURIComponent(label)}`;

export const fetchVariables = (query) => api(listUrl(query));
export const fetchVariable = (id, cursor) => api(detailUrl(id, cursor));
export const fetchKeySuggestion = (label) => api(keySuggestionUrl(label));

// ---------------------------------------------------------------------------
// Writes: every write carries a request key, so a lost answer is checked by
// sending the very same request again (the server replays it, never writes
// twice).
// ---------------------------------------------------------------------------
export function newRequestKey() {
  return globalThis.crypto.randomUUID();
}
// A write still open after this bound is a lost answer, never a refusal. The
// server's own worst case is under it: the pool checkout (5 s), the user lock
// (5 s), a few statements (10 s each), the bounded COMMIT (15 s), its check
// (5 s) and the answer's read (8 s).
export const WRITE_BOUND_MS = 90_000;
function write(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
export const createVariable = (body) => write(BASE, body);
export const createVersion = (id, body) => write(`${BASE}/${encodeURIComponent(id)}/versions`, body);

export function errorInfo(error) {
  const data = error?.data && typeof error.data === "object" ? error.data : null;
  const status = Number(error?.status) || 0;
  return {
    status,
    // No answer (the network, a lost connection) is its own code: the screen
    // never claims a write failed when it cannot know.
    code: data?.error || (status ? "error" : "no_answer"),
    message: typeof data?.message === "string" ? data.message : "",
    current: data?.current || null,
  };
}

// The 5xx answers the service writes itself with a stated outcome; any other
// 5xx (a proxy, a restart, a body that is not JSON) or no answer says nothing
// about whether the write landed.
export function outcomeUnknown(info) {
  if (info.code === "no_answer" || info.code === "outcome_unknown") return true;
  return info.status >= 500 && info.code !== "internal_error";
}

// Check result sends the same request again. Only these answers settle what
// happened to the first one: the server gives them after its request record
// showed that no write was saved under the key, or for the body itself, which
// is the same as the first time. Every other answer (busy, a server error, no
// access, signed out) comes before that record is read, so the first write
// stays not confirmed.
const SETTLED_ON_CHECK = new Set([
  "invalid_body", "invalid_unit", "invalid_condition", "key_required", "key_taken",
  "current_version_changed", "variable_not_active", "variable_pinned", "version_unchanged",
]);
export const checkSettles = (info) => SETTLED_ON_CHECK.has(info.code);
export function checkNoteText(info) {
  if (outcomeUnknown(info)) return "No answer again. The result is still not confirmed.";
  if (info.status === 401) return "The check could not be done: you are signed out. Sign in again in a new tab, then Check result here. If you sign in on this page, look for it in the list afterwards.";
  // A save under this request is stored with other values: no check can settle it.
  if (info.code === "request_key_reused") return "The check could not be done: a save under this request is already stored with other values. Close without checking and look for it in the list.";
  if (info.code === "notFound") return "The check could not be done: this workspace has no access to variables now. The result is still not confirmed.";
  if (info.code === "try_again") return "The check could not be done: the server was busy. The result is still not confirmed; Check result again in a moment.";
  return "The check could not be done. The result is still not confirmed; Check result again in a moment.";
}

const CODE_TEXT = {
  notFound: "Variables are not available in this workspace.",
  invalid_unit: "The unit must be 1-30 characters, without spaces, '|' or '='.",
  invalid_condition: "The condition is not complete. Check its values and unit.",
  key_required: "No key can be made from this name (a key uses only the letters a-z, digits and underscores). Enter a custom key under Technical details, starting with a letter.",
  key_taken: "Another variable here already uses this key (an archived one counts too). Change the key under Technical details, or the name.",
  try_again: "The server was busy. Nothing was saved. Try again.",
  internal_error: "The server could not save it. Nothing was saved. Try again.",
  current_version_changed: "A new version was saved in the meantime (perhaps your own earlier one). Your changes were not saved: check the versions below, then open New version again.",
  variable_not_active: "This variable is archived, so it cannot get a new version.",
  variable_pinned: "An active mapping uses the current version, so it cannot be replaced now.",
  version_unchanged: "Nothing changed: these values are the same as the current version's.",
  request_key_reused: "An earlier save of this form may already be stored. Cancel and check the list before saving again.",
  invalid_query: "The list could not be read with these settings. Reload.",
};
export function codeText(info) {
  // The server's own sentence names API fields; the form says it in its words.
  if (info.code === "invalid_body") return "Not saved: the server refused a value. Check the fields and save again.";
  return CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was saved." : "No answer from the server.");
}

const READINESS_TEXT = {
  target_not_active: "Archived, so no mapping can use it.",
  target_scope_mismatch: "A system variable: source data is mapped to it only in the platform workspace.",
  canonical_not_numeric: "Not numeric, so no mapping can use it.",
  canonical_unit_missing: "It has no unit, so no mapping can use it.",
  canonical_unit_not_a_token: "Its unit is not a unit token, so no mapping can use it.",
};
export function readinessText(target) {
  if (!target) return "";
  if (target.ready) return "Ready to be the target of a mapping.";
  return READINESS_TEXT[target.notReadyCode] || "Not ready to be the target of a mapping.";
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
export const aggregationLabel = (value) => AGGREGATIONS.find((a) => a.value === value)?.label || value || "";
export const levelLabel = (value) => LEVELS.find((l) => l.value === value)?.label || value;
const OPERATOR_SIGN = { ">=": "≥", ">": ">", "<=": "≤", "<": "<" };

export function conditionSummary(condition) {
  if (!condition) return "None";
  if (condition.kind === "zone" && condition.operator === "between") return `Zone ${condition.lower}–${condition.upper} ${condition.unit}`;
  if (condition.kind === "zone") return `Zone ${OPERATOR_SIGN[condition.operator] || condition.operator} ${condition.value} ${condition.unit}`;
  if (condition.kind === "event_threshold") {
    return `Effort ${OPERATOR_SIGN[condition.operator] || condition.operator} ${condition.value} ${condition.unit} for at least ${condition.durationSeconds} s`;
  }
  return "Stored in a format this screen cannot show";
}

export function rangeSummary(version) {
  const min = version?.minValue ?? null;
  const max = version?.maxValue ?? null;
  if (min === null && max === null) return "Any value";
  if (min !== null && max !== null) return `${min} to ${max}`;
  return min !== null ? `At least ${min}` : `At most ${max}`;
}

// ---------------------------------------------------------------------------
// The form: a create or a new version, kept in state so a repaint (a
// condition kind or level change) never loses what was typed.
// ---------------------------------------------------------------------------
export function emptyDraft() {
  return {
    label: "", shortLabel: "", description: "", key: "",
    unit: "", levels: ["session"], dailyAggregationMethod: "",
    minValue: "", maxValue: "",
    conditionKind: "none", conditionOperator: ">=", conditionLower: "", conditionUpper: "", conditionValue: "", conditionDuration: "", conditionUnit: "",
    reason: "",
  };
}

// A new version starts from the current version's whole semantics: the API
// replaces every field, so what is not sent is cleared (J3).
export function draftFromVersion(version) {
  const draft = emptyDraft();
  draft.unit = version?.unit || "";
  draft.dailyAggregationMethod = version?.dailyAggregationMethod || "";
  draft.minValue = version?.minValue ?? "";
  draft.maxValue = version?.maxValue ?? "";
  const c = version?.condition || null;
  if (!c) draft.conditionKind = "none";
  else if (c.kind === "zone" && c.operator === "between") Object.assign(draft, { conditionKind: "zone_between", conditionLower: c.lower, conditionUpper: c.upper, conditionUnit: c.unit });
  else if (c.kind === "zone") Object.assign(draft, { conditionKind: "zone_one_sided", conditionOperator: c.operator, conditionValue: c.value, conditionUnit: c.unit });
  else if (c.kind === "event_threshold") Object.assign(draft, { conditionKind: "event_threshold", conditionOperator: c.operator, conditionValue: c.value, conditionDuration: c.durationSeconds, conditionUnit: c.unit });
  // A condition stored in another shape: the coach chooses it again, it is
  // never cleared silently.
  else draft.conditionKind = "unsupported";
  return draft;
}

export function openForm(mode, { variable = null } = {}) {
  const current = variable?.currentVersion || null;
  return {
    mode,
    variableId: variable?.id || null,
    variableLabel: variable?.label || "",
    expectedCurrentVersionId: current?.id || null,
    draft: mode === "version" ? draftFromVersion(current) : emptyDraft(),
    dirty: false,
    requestKey: newRequestKey(),
    busy: false,
    unconfirmed: false,
    // Why the last Check result did not settle the outcome.
    checkNote: "",
    errors: {},
    error: "",
    keyHint: { key: "", taken: false, required: false, loading: false, label: "" },
  };
}

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const decimalText = (value) => String(value ?? "").trim().replace(",", ".");

function textError(value, max, { required = false } = {}) {
  if (!value) return required ? "Required." : "";
  if ([...value].length > max) return `At most ${max} characters.`;
  if (TEXT_FORBIDDEN.test(value)) return "Contains a character that cannot be saved.";
  return "";
}
export function unitError(value) {
  if (!value) return "Required.";
  if ([...value].length > LIMITS.unit) return `At most ${LIMITS.unit} characters.`;
  if (UNIT_FORBIDDEN.test(value)) return "No spaces, '|' or '='.";
  return "";
}
function decimalError(value) {
  if (!value) return "";
  return DECIMAL.test(value) ? "" : "A number such as 12 or 7.5 (at most 9 decimals).";
}
// Two valid decimals compared exactly (at most 12 + 9 digits, more than a
// binary float holds): as integers of the ninth decimal.
function decimalCompare(a, b) {
  const scaled = (text) => {
    const negative = text.startsWith("-");
    const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
    const value = BigInt(whole + fraction.padEnd(9, "0"));
    return negative ? -value : value;
  };
  const x = scaled(a);
  const y = scaled(b);
  return x === y ? 0 : x > y ? 1 : -1;
}

// The request body of the draft and its field errors; `body` is null while any
// field is wrong. Numbers stay exact decimal text, never a binary float.
export function buildRequest(form) {
  const d = form.draft;
  const errors = {};
  const isCreate = form.mode === "create";
  const label = oneLine(d.label);
  const shortLabel = oneLine(d.shortLabel);
  const description = oneLine(d.description);
  const key = String(d.key ?? "").trim();
  const unit = String(d.unit ?? "").trim();
  const minValue = decimalText(d.minValue);
  const maxValue = decimalText(d.maxValue);
  const reason = oneLine(d.reason);
  if (isCreate) {
    const set = (field, message) => { if (message) errors[field] = message; };
    set("label", textError(label, LIMITS.label, { required: true }));
    set("shortLabel", textError(shortLabel, LIMITS.shortLabel));
    set("description", textError(description, LIMITS.description));
    if (key && !KEY.test(key)) errors.key = "Lower-case letters, digits and underscores, starting with a letter, at most 63.";
    if (!LEVELS.some((level) => d.levels.includes(level.value))) errors.levels = "Choose at least one.";
  } else {
    const message = textError(reason, LIMITS.reason);
    if (message) errors.reason = message;
  }
  const unitMessage = unitError(unit);
  if (unitMessage) errors.unit = unitMessage;
  if (!AGGREGATIONS.some((a) => a.value === d.dailyAggregationMethod)) errors.dailyAggregationMethod = "Choose one.";
  if (decimalError(minValue)) errors.minValue = decimalError(minValue);
  if (decimalError(maxValue)) errors.maxValue = decimalError(maxValue);
  if (!errors.minValue && !errors.maxValue && minValue && maxValue && decimalCompare(minValue, maxValue) > 0) errors.maxValue = "Not below the minimum.";

  let condition = null;
  const cUnit = String(d.conditionUnit ?? "").trim();
  const need = (field, value) => {
    const message = value ? decimalError(value) : "Required.";
    if (message) errors[field] = message;
    return value;
  };
  if (d.conditionKind === "unsupported") errors.conditionKind = "Choose the condition again.";
  else if (d.conditionKind !== "none") {
    const unitMsg = unitError(cUnit);
    if (unitMsg) errors.conditionUnit = unitMsg;
    if (!OPERATORS.some((op) => op.value === d.conditionOperator) && d.conditionKind !== "zone_between") errors.conditionOperator = "Choose one.";
    if (d.conditionKind === "zone_between") {
      const lower = need("conditionLower", decimalText(d.conditionLower));
      const upper = need("conditionUpper", decimalText(d.conditionUpper));
      if (!errors.conditionLower && !errors.conditionUpper && decimalCompare(lower, upper) >= 0) errors.conditionUpper = "Above the lower value.";
      condition = { kind: "zone", operator: "between", lower, upper, unit: cUnit };
    } else if (d.conditionKind === "zone_one_sided") {
      condition = { kind: "zone", operator: d.conditionOperator, value: need("conditionValue", decimalText(d.conditionValue)), unit: cUnit };
    } else if (d.conditionKind === "event_threshold") {
      let durationSeconds = need("conditionDuration", decimalText(d.conditionDuration));
      // "-0" is zero, as the server reads it; any other negative value is refused.
      if (!errors.conditionDuration && durationSeconds.startsWith("-")) {
        if (decimalCompare(durationSeconds, "0") === 0) durationSeconds = durationSeconds.slice(1);
        else errors.conditionDuration = "Zero or more.";
      }
      condition = { kind: "event_threshold", operator: d.conditionOperator, value: need("conditionValue", decimalText(d.conditionValue)), durationSeconds, unit: cUnit };
    } else {
      errors.conditionKind = "Choose one.";
    }
  }
  if (Object.keys(errors).length) return { body: null, errors };

  const semantics = { unit, dailyAggregationMethod: d.dailyAggregationMethod, ...(minValue ? { minValue } : {}), ...(maxValue ? { maxValue } : {}), ...(condition ? { condition } : {}) };
  if (isCreate) {
    return {
      errors,
      body: {
        requestKey: form.requestKey,
        label,
        ...(shortLabel ? { shortLabel } : {}),
        ...(description ? { description } : {}),
        ...(key ? { key } : {}),
        levels: LEVELS.map((level) => level.value).filter((level) => d.levels.includes(level)),
        ...semantics,
      },
    };
  }
  return {
    errors,
    body: { requestKey: form.requestKey, expectedCurrentVersionId: form.expectedCurrentVersionId, ...semantics, ...(reason ? { reason } : {}) },
  };
}
