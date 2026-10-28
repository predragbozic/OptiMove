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

export function emptySourceFieldsState() {
  return {
    // Bumped on every reset: an answer for an older view is dropped.
    generation: 0,
    list: { items: [], loaded: false, loading: false, error: null },
    detail: { id: null, field: null, verifications: [], loading: false, error: null },
    form: null,
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
export const fetchField = (id) => api(`${BASE}/${encodeURIComponent(id)}`);
function write(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
const actPath = (fieldId, revisionId, act) => `${BASE}/${encodeURIComponent(fieldId)}/revisions/${encodeURIComponent(revisionId)}/${act === "unit" ? "unit-verification" : "meaning-verification"}`;
export const verifyUnit = (fieldId, revisionId, body) => write(actPath(fieldId, revisionId, "unit"), body);
export const verifyMeaning = (fieldId, revisionId, body) => write(actPath(fieldId, revisionId, "meaning"), body);

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
};
export const OPERATORS = Object.freeze([">=", ">", "<=", "<"]);
export const OPERATOR_LABEL = { ">=": "At least (>=)", ">": "More than (>)", "<=": "At most (<=)", "<": "Less than (<)" };
export const hasBound = (revision) => revision?.parameterKind === "zone_bounds" || revision?.parameterKind === "event_threshold";
export const levelsText = (revision) => [revision?.supportsSession ? "Session" : "", revision?.supportsDrill ? "Drill" : ""].filter(Boolean).join(" and ") || "None";

// The revision a field reads from now: the active one, else the newest.
export function currentRevision(field) {
  const revisions = field?.revisions || [];
  return revisions.find((r) => r.state === "active") || revisions[0] || null;
}

// What a platform administrator may do with a revision now. The server checks
// it all again; a zone's meaning is never offered (C89, verification_model_unresolved).
export function unitActOffered(ctx, field, revision) {
  return Boolean(ctx?.mayVerify && field?.state === "active" && revision && revision.state !== "retired" && !revision.unitVerifiedAt);
}
export function meaningActOffered(ctx, field, revision) {
  return Boolean(ctx?.mayVerify && field?.state === "active" && revision && revision.state !== "retired" && !revision.meaningVerifiedAt && revision.parameterKind !== "zone_bounds");
}
// A zone revision's meaning waits for the zone model (phase 5).
export function meaningBlockedByZoneModel(ctx, field, revision) {
  return Boolean(ctx?.mayVerify && field?.state === "active" && revision && revision.state !== "retired" && !revision.meaningVerifiedAt && revision.parameterKind === "zone_bounds");
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
  if (threshold && !OPERATORS.includes(d.boundOperator)) errors.boundOperator = "Choose one.";
  if (Object.keys(errors).length) return { body: null, errors };
  return { errors, body: { requestKey: form.requestKey, ...(threshold ? { boundOperator: d.boundOperator } : {}), evidenceRef } };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------
// Check result sends the same request again; only these answers settle what
// happened to the first one (they come from the body itself, or after the
// server's request record showed that nothing was saved under the key).
const SETTLED_ON_CHECK = new Set([
  "invalid_body", "invalid_unit", "invalid_evidence_ref", "bound_unit_required", "bound_unit_not_allowed", "invalid_operator",
  "operator_required", "operator_not_allowed", "verification_model_unresolved", "unit_already_verified", "meaning_already_verified",
  "revision_retired",
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
  verification_model_unresolved: "Not saved: the meaning of a zone cannot be confirmed yet; how closed and open zones share one bound operator is not decided.",
  unit_already_verified: "Not saved: this unit was already confirmed, perhaps by someone else in the meantime. Check the confirmed unit below; if it is wrong, the correction is a new revision.",
  meaning_already_verified: "Not saved: this meaning was already confirmed, perhaps by someone else in the meantime. Check it below; if it is wrong, the correction is a new revision.",
  revision_retired: "Not saved: this revision is retired and is never changed.",
  try_again: "The server was busy. Nothing was saved. Try again.",
  internal_error: "The server could not save it. Nothing was saved. Try again.",
  request_key_reused: "An earlier save of this form may already be stored. Cancel and look at the revision before saving again.",
};
export function sourceFieldCodeText(info) {
  return CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was saved." : "No answer from the server.");
}
// The refusals after which the form no longer fits what is saved: it is closed
// and the field read again.
export const CLOSES_FORM = new Set([
  "notFound", "bound_unit_required", "bound_unit_not_allowed", "operator_required", "operator_not_allowed",
  "verification_model_unresolved", "unit_already_verified", "meaning_already_verified", "revision_retired",
]);
// The last question before a write-once act (OptiMove asks before every act
// it cannot take back: Bind, Reconnect, Unbind).
export function confirmQuestion(form, body) {
  const what = `${form.fieldName} (revision ${form.revisionNumber})`;
  const value = form.act === "unit"
    ? `as "${body.sourceUnit}"${body.sourceBoundUnit ? ` with bounds in "${body.sourceBoundUnit}"` : ""}`
    : body.boundOperator ? `with the operator ${body.boundOperator}` : "";
  return `Confirm the ${form.act === "unit" ? "unit" : "meaning"} of ${what}${value ? ` ${value}` : ""}, with the evidence ${body.evidenceRef}? It is saved once and never changed; a correction is a new revision.`;
}

// A refusal that names a field of the form.
export const FIELD_OF_CODE = { invalid_unit: "sourceUnit", invalid_evidence_ref: "evidenceRef", invalid_operator: "boundOperator" };
