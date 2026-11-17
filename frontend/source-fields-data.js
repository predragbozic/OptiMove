// Training Load -> Data configuration -> Source fields (phase 6, M3; the
// contract is J4 of docs/ai/gpexe-metric-variable-mapping-discovery.md): the
// fields a source delivers (GPEXE rest_v1 today), their revisions and the
// evidence behind each one, over /api/training-load/sources/metrics/fields.
// An administrator of the platform or of a club reads them; only a platform
// administrator in the platform workspace confirms a revision's unit (F2) or
// its meaning (F3). The screen never sends an owner, an actor or a basis, and
// the server answers everyone else with the same 404. The revision lifecycle
// (L1-L5: a new revision, activate, retire, replace) is not part of this
// screen.
import { api } from "./api.js";
import { state } from "./state.js";
import { LIMITS, UNIT_FORBIDDEN, WRITE_BOUND_MS, errorInfo, newRequestKey, outcomeUnknown } from "./metric-variables-data.js";

export { errorInfo, newRequestKey, outcomeUnknown };

const BASE = "/api/training-load/sources/metrics/fields";

// Who is offered the screen (C80, C94): an administrator in the platform
// workspace (who may also confirm) or in a club workspace (who reads). A team
// workspace gets the Variables view only (C99). The server decides again on
// every request.
export function sourceFieldsContext(user = state.currentUser) {
  const ws = user?.activeWorkspace || null;
  if (!ws) return null;
  if (ws.type === "platform") return { mayVerify: true };
  if (ws.type === "club" && ws.scopeId) return { mayVerify: false, clubName: ws.label || "" };
  return null;
}

export function emptyInventory() {
  return {
    items: [], loaded: false, loading: false, loadingMore: false, error: null, nextCursor: null,
    endpoint: "", showSupported: false, search: "",
    // Team thresholds (P1): the platform workspace only, read when their fold opens.
    thresholds: { items: [], loaded: false, loading: false, error: null, open: false },
  };
}
export function emptySourceFieldsState() {
  return {
    // Bumped on every reset: an answer for an older view is dropped.
    generation: 0,
    list: { items: [], loaded: false, loading: false, error: null },
    detail: { id: null, field: null, verifications: [], loading: false, error: null },
    form: null,
    // I2 / I3: the names GPEXE sent that no source field covers yet (read-only).
    inventory: emptyInventory(),
    notice: "",
    // "" for what was saved; "warning" for a refusal or an unchecked result.
    noticeKind: "",
  };
}
export function sourceFieldsState() {
  if (!state.trainingLoad.sourceFields) state.trainingLoad.sourceFields = emptySourceFieldsState();
  return state.trainingLoad.sourceFields;
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------
export const fetchFields = () => api(BASE);
// I2 (docs/ai/gpexe-field-inventory-plan.md, section 7.2): one page of the field inventory.
const INVENTORY = "/api/training-load/sources/metrics/field-inventory";
export function fetchInventory({ endpoint = "", showSupported = false, cursor = null } = {}) {
  const query = new URLSearchParams();
  if (showSupported) query.set("state", "all");
  if (endpoint) query.set("endpoint", endpoint);
  if (cursor) query.set("cursor", cursor);
  const text = query.toString();
  return api(text ? `${INVENTORY}?${text}` : INVENTORY);
}
// Where a name comes from and what it holds, in plain words (I3; never a key or a code).
export const INVENTORY_ENDPOINTS = Object.freeze(["athlete_session", "details.session", "details.drill", "more.events", "more.complementary_data"]);
export const ENDPOINT_LABEL = {
  athlete_session: "Per athlete",
  "details.session": "Whole session",
  "details.drill": "Per drill",
  "more.events": "Events",
  "more.complementary_data": "Zones",
  team_thresholds: "Team zone limits",
};
export const KIND_LABEL = {
  number: "number",
  text: "text",
  boolean: "yes or no",
  null: "empty",
  unit_value_object: "number with unit",
  zone_list: "zone list",
  object: "group of values",
  list: "list",
};
// The search narrows the loaded names in place, by name, ignoring case.
export const inventoryMatches = (item, search) => !search || String(item.name || "").toLowerCase().includes(String(search).trim().toLowerCase());
export const fetchField = (id) => api(`${BASE}/${encodeURIComponent(id)}`);
function write(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
const actPath = (fieldId, revisionId, act) => `${BASE}/${encodeURIComponent(fieldId)}/revisions/${encodeURIComponent(revisionId)}/${act === "unit" ? "unit-verification" : "meaning-verification"}`;
export const verifyUnit = (fieldId, revisionId, body) => write(actPath(fieldId, revisionId, "unit"), body);
export const verifyMeaning = (fieldId, revisionId, body) => write(actPath(fieldId, revisionId, "meaning"), body);
// G1b: route C, a field created from a name of the inventory (platform admin, platform workspace).
export const createSourceField = (body) => write(BASE, body);

// ---------------------------------------------------------------------------
// What a revision is (v34's value sets)
// ---------------------------------------------------------------------------
export const VALUE_SHAPE_LABEL = {
  number: "A number",
  numeric_text: "A number written as text",
  unit_value_object: "A value with its unit",
  zone_distance: "A distance in a zone",
  event_count: "A count of events",
};
export const PARAMETER_KIND_LABEL = { none: "None", zone_bounds: "Zone bounds", event_threshold: "Event threshold" };
export const STATE_LABEL = { draft: "Draft", active: "Active", retired: "Retired" };
export const EVIDENCE_LABEL = {
  unproven: "Not proven",
  documented: "Documented",
  observed: "Observed",
  verified: "Verified",
  // G1 (D-INV-2): never "Verified" - the unit is GPEXE's own word, checked by an administrator on the board.
  source_stated: "Unit stated by GPEXE",
};
export const OPERATORS = Object.freeze([">=", ">", "<=", "<"]);
export const OPERATOR_LABEL = { ">=": "At least (>=)", ">": "More than (>)", "<=": "At most (<=)", "<": "Less than (<)" };
// A zone's operator (v42, C102, C103): the closed zones of a field take
// between, the open top zone >=; a field holds one shape of zone.
export const ZONE_OPERATORS = Object.freeze(["between", ">="]);
export const ZONE_OPERATOR_LABEL = {
  between: "Has an upper limit — a closed zone (between)",
  ">=": "Has no upper limit — the open top zone (>=)",
};
// A confirmed or chosen operator in the words of its choice, by the
// revision's kind (the detail and the last question say it the same way).
export function operatorWords(parameterKind, operator) {
  const label = parameterKind === "zone_bounds" ? ZONE_OPERATOR_LABEL[operator] : OPERATOR_LABEL[operator];
  return label || String(operator ?? "");
}
export const hasBound = (revision) => revision?.parameterKind === "zone_bounds" || revision?.parameterKind === "event_threshold";
export const levelsText = (revision) => [revision?.supportsSession ? "Session" : "", revision?.supportsDrill ? "Drill" : ""].filter(Boolean).join(" and ") || "None";

// The revision a field reads from now: the active one, else the newest.
export function currentRevision(field) {
  const revisions = field?.revisions || [];
  return revisions.find((r) => r.state === "active") || revisions[0] || null;
}

// What a platform administrator may do with a revision now. The server checks
// it all again.
export function unitActOffered(ctx, field, revision) {
  return Boolean(ctx?.mayVerify && field?.state === "active" && revision && revision.state !== "retired" && !revision.unitVerifiedAt);
}
export function meaningActOffered(ctx, field, revision) {
  return Boolean(ctx?.mayVerify && field?.state === "active" && revision && revision.state !== "retired" && !revision.meaningVerifiedAt);
}

// ---------------------------------------------------------------------------
// The two acts
// ---------------------------------------------------------------------------
// The JavaScript twin of training_load.source_metric_evidence_ref_ok() (v34,
// C40): a repository-relative docs/ path with one heading anchor, 1-300.
const EVIDENCE_REF = /^docs(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+#[A-Za-z0-9_-]+$/;
export const EVIDENCE_REF_MAX = 300;
export const EVIDENCE_EXAMPLE = "docs/ai/gpexe-evidence.md#total-distance";
export const evidenceRefOk = (value) => typeof value === "string" && value.length >= 1 && value.length <= EVIDENCE_REF_MAX && EVIDENCE_REF.test(value);

// ---------------------------------------------------------------------------
// G1b: creating a field from a name GPEXE sent (route C, docs/ai/gpexe-field-inventory-plan.md section 8.1)
// ---------------------------------------------------------------------------
// What happens next, said once on the form and once after the save (the Rukovodilac's wording).
export const CREATE_NEXT_STEP = "This field has no values yet. Its unit is confirmed on the board once new sessions carry it.";
export const FIELD_LABEL_MAX = 80;
// The levels a name's endpoint allows, and the one a per-drill name must keep.
export function createLevels(endpoint) {
  if (endpoint === "details.drill") return { supportsSession: false, supportsDrill: true, drillLocked: true };
  if (endpoint === "details.session") return { supportsSession: true, supportsDrill: false, drillLocked: false };
  return { supportsSession: true, supportsDrill: true, drillLocked: false };
}
// Offered only where the server said route C would take the name (never guessed here).
export const createOffered = (ctx, item) => Boolean(ctx?.mayVerify && item && item.creatable === true && item.covered === false);
export function openCreateFieldForm(item) {
  const levels = createLevels(item.endpoint);
  return {
    act: "create",
    requestKey: newRequestKey(),
    busy: false,
    unconfirmed: false,
    checkNote: "",
    dirty: false,
    errors: {},
    error: "",
    endpoint: item.endpoint,
    name: item.name,
    kind: item.kind || "",
    unitWord: item.unitWord || "",
    drillLocked: levels.drillLocked,
    fieldId: null,
    fieldName: item.name,
    draft: { label: "", supportsSession: levels.supportsSession, supportsDrill: levels.supportsDrill },
  };
}

export function openSourceFieldForm(act, { field, revision }) {
  return {
    act,
    requestKey: newRequestKey(),
    busy: false,
    unconfirmed: false,
    checkNote: "",
    dirty: false,
    errors: {},
    error: "",
    fieldId: field.id,
    fieldName: field.label || field.key || "",
    fieldKey: field.key || "",
    sourceSystem: field.sourceSystem || "",
    apiFamily: field.apiFamily || "",
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    valueShape: revision.valueShape,
    levels: levelsText(revision),
    parameterKind: revision.parameterKind,
    expectedSourceUnit: revision.expectedSourceUnit || "",
    expectedSourceBoundUnit: revision.expectedSourceBoundUnit || "",
    draft: act === "unit" ? { sourceUnit: "", sourceBoundUnit: "", evidenceRef: "" } : { boundOperator: "", evidenceRef: "" },
  };
}

function unitFieldError(value) {
  if (!value) return "Required.";
  if ([...value].length > LIMITS.unit) return `At most ${LIMITS.unit} characters.`;
  if (UNIT_FORBIDDEN.test(value)) return "No spaces, '|', '=' or hidden characters.";
  return "";
}
function evidenceError(value) {
  if (!value) return "Required.";
  if (value.length > EVIDENCE_REF_MAX) return `At most ${EVIDENCE_REF_MAX} characters.`;
  return evidenceRefOk(value) ? "" : `A path under docs/ with one heading anchor, for example ${EVIDENCE_EXAMPLE}.`;
}

// The request of the form and its field errors; `body` is null while a field
// is wrong. A unit or a reference is sent exactly as typed (only the blanks
// around it removed): the server and the database check the same rules.
export function buildSourceFieldRequest(form) {
  const d = form.draft;
  const errors = {};
  const set = (field, message) => { if (message) errors[field] = message; };
  if (form.act === "create") {
    // The label is sent without the blanks around it; the server checks the same rule (one line, visible characters).
    const label = String(d.label ?? "").trim();
    set("label", !label ? "Required." : [...label].length > FIELD_LABEL_MAX ? `At most ${FIELD_LABEL_MAX} characters.` : /[\r\n\t]/.test(label) ? "One line." : "");
    const supportsDrill = form.drillLocked ? true : d.supportsDrill === true;
    const supportsSession = d.supportsSession === true;
    if (!supportsSession && !supportsDrill) errors.levels = "Choose the session, the drill or both.";
    if (Object.keys(errors).length) return { body: null, errors };
    return { errors, body: { requestKey: form.requestKey, endpoint: form.endpoint, name: form.name, label, supportsSession, supportsDrill } };
  }
  const evidenceRef = String(d.evidenceRef ?? "").trim();
  set("evidenceRef", evidenceError(evidenceRef));
  if (form.act === "unit") {
    const sourceUnit = String(d.sourceUnit ?? "").trim();
    set("sourceUnit", unitFieldError(sourceUnit));
    const bound = form.parameterKind === "zone_bounds" || form.parameterKind === "event_threshold";
    const sourceBoundUnit = String(d.sourceBoundUnit ?? "").trim();
    if (bound) set("sourceBoundUnit", unitFieldError(sourceBoundUnit));
    if (Object.keys(errors).length) return { body: null, errors };
    return { errors, body: { requestKey: form.requestKey, sourceUnit, ...(bound ? { sourceBoundUnit } : {}), evidenceRef } };
  }
  const threshold = form.parameterKind === "event_threshold";
  const zone = form.parameterKind === "zone_bounds";
  if (threshold && !OPERATORS.includes(d.boundOperator)) errors.boundOperator = "Choose one.";
  if (zone && !ZONE_OPERATORS.includes(d.boundOperator)) errors.boundOperator = "Choose one of the two.";
  if (Object.keys(errors).length) return { body: null, errors };
  return { errors, body: { requestKey: form.requestKey, ...(threshold || zone ? { boundOperator: d.boundOperator } : {}), evidenceRef } };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------
// Check result sends the same request again; only these answers settle what
// happened to the first one (they come from the body itself, or after the
// server's request record showed that nothing was saved under the key).
const SETTLED_ON_CHECK = new Set([
  "invalid_body", "invalid_unit", "invalid_evidence_ref", "bound_unit_required", "bound_unit_not_allowed", "invalid_operator",
  "operator_required", "operator_not_allowed", "unit_already_verified", "meaning_already_verified", "revision_retired",
  // Route C's refusals, decided from the body and the inventory before anything is written.
  "name_not_observed", "name_not_supported", "shape_not_generic", "field_exists", "too_many_fields", "value_not_number",
]);
export const checkSettles = (info) => SETTLED_ON_CHECK.has(info.code);
export function checkNoteText(info) {
  if (outcomeUnknown(info)) return "No answer again. The result is still not confirmed.";
  if (info.status === 401) return "The check could not be done: you are signed out. Sign in again in a new tab, then Check result here. If you sign in on this page, open the field afterwards to see whether it was saved.";
  if (info.code === "request_key_reused") return "The check could not be done: a save under this request is already stored with other values. Close without checking and look at the revision.";
  if (info.code === "notFound") return "The check could not be done: this workspace has no access to it now. The result is still not confirmed.";
  if (info.code === "try_again") return "The check could not be done: the server was busy. The result is still not confirmed; Check result again in a moment.";
  return "The check could not be done. The result is still not confirmed; Check result again in a moment.";
}

const CODE_TEXT = {
  // A 404 to a write can come after a confirmed COMMIT (the right lost
  // meanwhile): it never says that nothing was saved, and says the outcome is
  // not known.
  notFound: "It is not available in this workspace now. Whether the confirmation was saved is not known: open the field from the platform workspace to see.",
  invalid_body: "Not saved: the server refused a value. Check the fields and save again.",
  invalid_unit: "Not saved: the server does not take this unit. A unit is 1-30 characters, without spaces, '|' or '='.",
  invalid_evidence_ref: "Not saved: the reference must be a path under docs/ with one heading anchor (docs/...#anchor), at most 300 characters.",
  bound_unit_required: "Not saved: this revision has a bound, so the bound's unit is confirmed together with the unit. The revision is read again.",
  bound_unit_not_allowed: "Not saved: this revision has no bound. The revision is read again.",
  invalid_operator: "Not saved: an event threshold takes a one-sided operator (>=, >, <=, <).",
  operator_required: "Not saved: this revision is an event threshold, so its operator is confirmed together with the meaning. The revision is read again.",
  operator_not_allowed: "Not saved: this revision has no bound. The revision is read again.",
  unit_already_verified: "Not saved: this unit was already confirmed, perhaps by someone else in the meantime. Check the confirmed unit below; if it is wrong, the correction is a new revision.",
  meaning_already_verified: "Not saved: this meaning was already confirmed, perhaps by someone else in the meantime. Check it below; if it is wrong, the correction is a new revision.",
  revision_retired: "Not saved: this revision is retired and is never changed.",
  try_again: "The server was busy. Nothing was saved. Try again.",
  internal_error: "The server could not save it. Nothing was saved. Try again.",
  request_key_reused: "An earlier save of this form may already be stored. Cancel and look at the revision before saving again.",
};
// The two operator texts of a zone revision (the form's kind; v42).
const ZONE_CODE_TEXT = {
  invalid_operator: "Not saved: a zone is either a closed zone (between) or the open top zone (>=).",
  operator_required: "Not saved: this revision is a zone, so its operator is confirmed together with the meaning. The revision is read again.",
};
// Route C's refusals (G1b), in the words of creating a field.
const CREATE_CODE_TEXT = {
  notFound: "It is not available in this workspace now. Whether the field was created is not known: open Source fields in the platform workspace to see.",
  invalid_body: "Not created: the server refused a value. Check the name and the levels, and save again.",
  name_not_observed: "Not created: GPEXE has not sent this name as a measured value. Find new sessions first.",
  name_not_supported: "Not created: this GPEXE name cannot become a field.",
  shape_not_generic: "Not created: only a number per athlete, or a whole-session or drill value with its unit, can become a field here.",
  value_not_number: "Not created: GPEXE sends this name as something other than a number, so a check could not keep it.",
  too_many_fields: "Not created: a check already keeps the most fields of this kind it can (64).",
  try_again: "The server was busy. Nothing was created. Try again.",
  internal_error: "The server could not create it. Nothing was created. Try again.",
  request_key_reused: "An earlier save of this form may already be stored. Cancel and look at the source fields before saving again.",
};
export function sourceFieldCodeText(info, form = null) {
  if (form?.act === "create") return CREATE_CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was created." : "No answer from the server.");
  if (form?.parameterKind === "zone_bounds" && ZONE_CODE_TEXT[info.code]) return ZONE_CODE_TEXT[info.code];
  return CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was saved." : "No answer from the server.");
}
// The refusals after which the form no longer fits what is saved: it is closed
// and the field read again.
export const CLOSES_FORM = new Set([
  "notFound", "bound_unit_required", "bound_unit_not_allowed", "operator_required", "operator_not_allowed",
  "unit_already_verified", "meaning_already_verified", "revision_retired",
]);
// The last question before a write-once act (OptiMove asks before every act
// it cannot take back: Bind, Reconnect, Unbind).
export function confirmQuestion(form, body) {
  if (form.act === "create") {
    return `Create the source field "${body.label}" from GPEXE's name ${body.name} (${ENDPOINT_LABEL[body.endpoint] || body.endpoint})? A field is kept: it cannot be removed here once it is created.`;
  }
  const what = `${form.fieldName} (revision ${form.revisionNumber})`;
  const value = form.act === "unit"
    ? `as "${body.sourceUnit}"${body.sourceBoundUnit ? ` with bounds in "${body.sourceBoundUnit}"` : ""}`
    : !body.boundOperator ? ""
    : form.parameterKind === "zone_bounds" ? `as "${operatorWords(form.parameterKind, body.boundOperator)}"`
    : `with the operator "${operatorWords(form.parameterKind, body.boundOperator)}"`;
  return `Confirm the ${form.act === "unit" ? "unit" : "meaning"} of ${what}${value ? ` ${value}` : ""}, with the evidence ${body.evidenceRef}? It is saved once and never changed; a correction is a new revision.`;
}

// A refusal that names a field of the form.
export const FIELD_OF_CODE = { invalid_unit: "sourceUnit", invalid_evidence_ref: "evidenceRef", invalid_operator: "boundOperator" };
