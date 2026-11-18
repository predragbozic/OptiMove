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
import { zoneRange } from "./zone-ranges.js";
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
    items: [], loaded: false, loading: false, loadingMore: false, error: null, nextCursor: null, zoneThresholds: null,
    endpoint: "", showSupported: false, search: "",
    // The owner's rule (2026-11-18): the plain view first; GPEXE's own names, counts, sources and the names that are not
    // values are one click away, never the default.
    technical: false,
    // Team thresholds (P1): the platform workspace only, read when their fold opens.
    thresholds: { items: [], loaded: false, loading: false, error: null, open: false },
  };
}
export function emptySourceFieldsState() {
  return {
    // Bumped on every reset: an answer for an older view is dropped.
    generation: 0,
    list: { items: [], loaded: false, loading: false, error: null },
    detail: { id: null, field: null, verifications: [], observations: null, observationsError: null, loading: false, error: null },
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
// The search narrows the loaded names in place, by name or readable name, ignoring case.
export const inventoryMatches = (item, search) => {
  const q = String(search || "").trim().toLowerCase();
  return !q || String(item.name || "").toLowerCase().includes(q) || readableName(item).toLowerCase().includes(q);
};

// The owner's first use of the list (2026-11-18): a readable name first, the unit (never GPEXE's word), the zone's own
// fact, and the names that are not values folded away; grouped by quantity.
const ZONE_FAMILY = { power: "Power", speed: "Speed", relativespeed: "Relative speed", jumpheight: "Jump height", heartrate: "Heart rate", metabolicpower: "Metabolic power" };
const MEASURE = { distance: "distance", time: "time", events: "events" };
const capitalize = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
// A numbered zone reads "Power zone 4 · distance", or with the team's limits "Power zone 4 · 60–75 W/kg · distance".
export function readableName(item, thresholds = null) {
  const z = item?.zone;
  if (z && Number.isInteger(z.number)) {
    const range = thresholds ? zoneRange(z, thresholds) : null;
    return `${ZONE_FAMILY[z.family] || capitalize(z.family)} zone ${z.number} · ${range ? `${range} · ` : ""}${MEASURE[z.measure] || z.measure}`;
  }
  const name = String(item?.name || "").replace(/^athlete_?session_?/, "").replace(/_+/g, " ").trim();
  return capitalize(name) || String(item?.name || "");
}
export const QUANTITIES = Object.freeze([
  ["distance", "Distance", ["m"]], ["time", "Time", ["s"]], ["power", "Power", ["W/kg"]], ["energy", "Energy", ["J/kg"]],
  ["speed", "Speed", ["m/s"]], ["acceleration", "Acceleration", ["m/s2"]], ["count", "Counts", ["count"]],
]);
export function quantityOf(item) {
  const hit = QUANTITIES.find(([, , units]) => units.includes(item?.unit));
  return hit ? hit[0] : "other";
}
export const QUANTITY_LABEL = { ...Object.fromEntries(QUANTITIES.map(([key, label]) => [key, label])), other: "Other values" };
// The units GPEXE's settings screen shows: speed limits are stored in m/s and shown in km/h (× 3.6).
const ZONE_THRESHOLD = { power: ["Power", "W/kg", 1], speed: ["Speed", "km/h", 3.6] };
// The team limits of one zone family, said once in the list (the UX review: once, not in every group). Each zone row
// shows its own expected range beside it (the Rukovodilac's order of 2026-11-18), always marked expected. The list has
// no session in view, so the limits are those of the newest saved session of each linked team, with that day. The limits
// are the platform admin's only (P1).
export function zoneLimitsNote(family, zoneThresholds, day = "") {
  const pair = ZONE_THRESHOLD[family];
  const set = pair && zoneThresholds ? zoneThresholds[family] : null;
  if (!set) return "";
  if (set.differ) return `${pair[0]} zone limits differ between teams, so no zone's range is shown.`;
  return Array.isArray(set.values)
    ? `${pair[0]} zone limits of the team: ${set.values.map((v) => String(Math.round(v * pair[2] * 100) / 100)).join(" · ")} ${pair[1]}${day ? `, from the newest saved session (${day})` : ""}. Zone 1 starts at 0 and each zone runs to the next limit, as GPEXE's team settings show.`
    : "";
}
// Values first by quantity, zones together in zone order; the rest is "not values".
// merge (the plain view): one row per GPEXE name. GPEXE sends many values both for the whole session and per drill (and
// some per athlete too); with the sources hidden, two rows of one plain name could not be told apart. The row kept is
// one in use if any is, then the whole session's, then a drill's, then a per-athlete one; Use this value on it opens
// the form with both levels when GPEXE sends both (openCreateFieldForm's siblings).
const MERGE_ORDER = ["details.session", "details.drill", "athlete_session", "more.events", "more.complementary_data"];
function mergeByName(values) {
  const rank = (i) => (i.covered ? 0 : 1) * 10 + (MERGE_ORDER.indexOf(i.endpoint) + 1 || 9);
  const best = new Map();
  for (const item of values) {
    const kept = best.get(item.name);
    if (!kept || rank(item) < rank(kept)) best.set(item.name, item);
  }
  return values.filter((item) => best.get(item.name) === item);
}
export function inventoryGroups(items, { merge = false } = {}) {
  const all = items.filter((i) => i.isValue === true);
  const values = merge ? mergeByName(all) : all;
  const other = items.filter((i) => i.isValue !== true);
  const order = [...QUANTITIES.map(([key]) => key), "other"];
  const sortKey = (i) => [i.zone ? 0 : 1, i.zone?.family || "", i.zone?.measure || "", i.zone?.number ?? 0, readableName(i).toLowerCase()];
  const cmp = (a, b) => { const x = sortKey(a); const y = sortKey(b); for (let k = 0; k < x.length; k += 1) { if (x[k] < y[k]) return -1; if (x[k] > y[k]) return 1; } return 0; };
  const groups = order.map((key) => ({ key, label: QUANTITY_LABEL[key], items: values.filter((i) => quantityOf(i) === key).sort(cmp) })).filter((g) => g.items.length);
  return { groups, other };
}
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
// G1b-2 (plan section 8.2): the platform's comparison of a generic field - the teams (the platform board's list), one
// comparison (route 8), the tick (route O) and the stored comparisons (route 10).
export const fetchBoardTeams = () => api("/api/training-load/sources/metrics/board/teams");
export function fetchObservation(fieldId, { teamId = null, candidateId = null, pair = null } = {}) {
  const query = new URLSearchParams();
  if (teamId) query.set("teamId", teamId);
  if (candidateId) query.set("candidateId", candidateId);
  if (pair !== null && pair !== undefined) query.set("pair", String(pair));
  return api(`${BASE}/${encodeURIComponent(fieldId)}/observation?${query.toString()}`);
}
export const confirmObservedField = (fieldId, revisionId, body) => write(`${BASE}/${encodeURIComponent(fieldId)}/revisions/${encodeURIComponent(revisionId)}/observed-confirmation`, body);
export const fetchObservations = (fieldId) => api(`${BASE}/${encodeURIComponent(fieldId)}/observations`);

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

// G1b-2: the comparison is offered on the active revision of a created whole-session or drill field (a value GPEXE sends
// with its unit word) whose unit and meaning are not proven yet. A per-athlete value carries no word: a document
// confirms it. The server decides again.
export function observeOffered(ctx, field, revision) {
  return Boolean(ctx?.mayVerify && field?.state === "active" && String(field?.key || "").startsWith("details.players.")
    && revision && revision.state === "active" && revision.evidenceStatus === "unproven" && revision.parameterKind === "none"
    && !revision.unitVerifiedAt && !revision.meaningVerifiedAt);
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
export const CREATE_NEXT_STEP = "Nothing is imported yet. After the next Find new sessions brings this value, open it here and use Compare with GPEXE once. Then you can put it on a variable.";
// A per-athlete value carries no unit word, so the board never offers its unit: a document confirms it (the wording of
// the UX review of G1b-1, approved by the Rukovodilac on 2026-11-17).
export const CREATE_NEXT_STEP_ROW = "Nothing is imported yet. GPEXE sends no unit with this value, so it cannot be checked against GPEXE here. Ask your developer to confirm its unit before you put it on a variable.";
export const createNextStep = (endpoint) => (endpoint === "athlete_session" ? CREATE_NEXT_STEP_ROW : CREATE_NEXT_STEP);
export const FIELD_LABEL_MAX = 80;
// The levels a name's endpoint allows, and the one a per-drill name must keep.
export function createLevels(endpoint) {
  if (endpoint === "details.drill") return { supportsSession: false, supportsDrill: true, drillLocked: true };
  if (endpoint === "details.session") return { supportsSession: true, supportsDrill: false, drillLocked: false };
  return { supportsSession: true, supportsDrill: true, drillLocked: false };
}
// Offered only where the server said route C would take the name (never guessed here).
export const createOffered = (ctx, item) => Boolean(ctx?.mayVerify && item && item.creatable === true && item.covered === false);
// `siblings`: the loaded inventory. A details name GPEXE sends both for the whole session and per drill becomes one key
// (details.players.<name>, plan 8.1), so the form opens with both levels (the code review of G1b-1, MEDIUM).
const DETAILS = ["details.session", "details.drill"];
export function openCreateFieldForm(item, siblings = [], thresholds = null) {
  const levels = createLevels(item.endpoint);
  const both = DETAILS.includes(item.endpoint) && siblings.some((other) => other !== item && other.name === item.name && DETAILS.includes(other.endpoint) && other.endpoint !== item.endpoint);
  if (both) { levels.supportsSession = true; levels.supportsDrill = true; }
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
    // The plain name and unit the list showed, for the form's title; the name in OptiMove starts as that name.
    readable: readableName(item, thresholds),
    unit: item.unit || "",
    drillLocked: levels.drillLocked,
    bothLevels: both,
    fieldId: null,
    fieldName: item.name,
    draft: { label: readableName(item, thresholds).slice(0, FIELD_LABEL_MAX), supportsSession: levels.supportsSession, supportsDrill: levels.supportsDrill },
  };
}

// G1b-2: the comparison form - a team, then the comparison the server reads (route 8), then the tick (route O).
export function openObserveForm({ field, revision }) {
  return {
    act: "observe",
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
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    expectedSourceUnit: revision.expectedSourceUnit || "",
    teams: { items: [], loaded: false, loading: false, error: "", truncated: false },
    observation: null,
    observationLoading: false,
    observationError: "",
    draft: { teamId: "", attested: false },
  };
}

// What the admin compares (plan section 8.10): each athlete's number as GPEXE should show it, never more than that. The
// two athletes are named by OptiMove's own link or GPEXE's name; their ids never reach the screen.
export const RULE_SCREEN = { duration_mmss: "minutes:seconds" };
export function observationLines(o) {
  if (!o) return [];
  const names = o.pair?.labels || [];
  return [o.values?.a, o.values?.b].map((side, i) => {
    const name = names[i] || `Athlete ${i + 1}`;
    if (!side || side.raw === null) return { name, text: "No value." };
    if (o.displayRule === "as_sent") return { name, text: `GPEXE may show this rounded or in another unit. Compare the number: ${side.raw} ${o.unit}.` };
    if (o.displayRule === "duration_mmss") return { name, text: `GPEXE should show ${side.shown} (minutes:seconds).` };
    return { name, text: `GPEXE should show ${side.shown} ${o.displayUnit}.` };
  });
}
export const DURATION_HOURS_NOTE = "For a long value GPEXE may show hours as well: 1:36:30 is 96:30.";
export function observationWordText(o) {
  if (!o?.word) return "";
  return `GPEXE sends this value in ${o.unit}.`;
}
// Why a comparison cannot be ticked (unit_not_stated's reasons; the server's codes, in plain words).
export function observationReasonText(o) {
  const words = (o?.words || []).map((w) => (w === null || w === undefined ? "none" : `"${w}"`));
  switch (o?.reason) {
    case "words_disagree": return `The two athletes' values carry different unit words (${words.join(" and ")}), so this session cannot confirm the unit. Try Other athletes or another team.`;
    case "word_unknown": return `GPEXE sends a unit word OptiMove does not know${o.words?.[0] ? ` (${words[0]})` : ""}. Only a document can confirm this field's unit (Confirm the unit). OptiMove cannot import its values until it knows GPEXE's unit word for it.`;
    case "expected_unit_differs": return `GPEXE sends this value here as ${words[0]}, which is not the unit the field was created with${o.expectedUnit ? ` (${o.expectedUnit})` : ""}. Another GPEXE account may send it differently: confirm the unit with a document.`;
    // With words (a details value that came without one) the field cannot import either; an athlete-row field can.
    case "no_unit_word": return `GPEXE sends no unit with this value. A platform administrator confirms it with a document (Confirm the unit).${Array.isArray(o.words) ? " OptiMove cannot import its values until it knows GPEXE's unit word for it." : ""}`;
    default: return "";
  }
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
  if (form.act === "observe") {
    const o = form.observation;
    if (!o || !o.confirmable || !o.values?.a?.raw || !o.values?.b?.raw) return { body: null, errors: { attested: "Show a comparison of two athletes first." } };
    if (d.attested !== true) return { body: null, errors: { attested: "Tick this only after comparing both athletes with the GPEXE screen." } };
    return { errors, body: { requestKey: form.requestKey, session: { candidateId: o.session.candidateId, pairs: [...o.pair.positions], placementHash: o.placementHash }, attested: true } };
  }
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
  // Route O's refusals: nothing is written with them.
  "field_has_parameters", "field_has_evidence", "revision_not_active", "unit_not_stated", "board_changed", "binding_not_active", "pair_not_comparable",
  "not_enough_athletes", "snapshot_expired", "candidate_source_mismatch", "candidate_not_importable", "candidate_too_large", "session_start_unknown",
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
  invalid_body: "Not created: the server refused a value. Check the name and the levels, and choose Create field again.",
  // A create that lost a race: the field exists, the answer names none (plan 8.9: the losing writer gets no current).
  field_exists: "This field already exists, so nothing was created. The source fields are read again below.",
  name_not_observed: "Not created: GPEXE has not sent this name as a measured value. Find new sessions first.",
  name_not_supported: "Not created: this GPEXE name cannot become a field.",
  shape_not_generic: "Not created: only a number per athlete, or a whole-session or drill value with its unit, can become a field here.",
  value_not_number: "Not created: GPEXE sends this name as something other than a number, so a check could not keep it.",
  too_many_fields: "Not created: a check already keeps the most fields of this kind it can (64).",
  try_again: "The server was busy. Nothing was created. Try again.",
  internal_error: "The server could not create it. Nothing was created. Try again.",
  request_key_reused: "An earlier save of this form may already be stored. Cancel and look at the source fields before saving again.",
};
// Route O's refusals (G1b-2), in the words of the comparison.
const OBSERVE_CODE_TEXT = {
  notFound: "It is not available in this workspace now. Whether the comparison was saved is not known: open the field from the platform workspace to see.",
  invalid_body: "Not saved: the server refused the comparison. Read it again and tick once more.",
  board_changed: "Not saved: the session or the field changed since you compared. The comparison is read again; compare once more.",
  unit_not_stated: "Not saved: GPEXE does not state a unit OptiMove can read for this field in this session.",
  unit_already_verified: "Not saved: this field's unit is already confirmed, perhaps by someone else in the meantime. The field is read again.",
  field_has_evidence: "Not saved: this field already carries other evidence; its unit is confirmed with a document. The field is read again.",
  field_has_parameters: "Not saved: this field has parameters; its unit is confirmed with a document.",
  revision_not_active: "Not saved: this revision is no longer the field's active one. The field is read again.",
  binding_not_active: "Not saved: the team is no longer linked to GPEXE. Choose another team.",
  pair_not_comparable: "Not saved: these two athletes can no longer be compared. The comparison is read again.",
  try_again: "The server was busy. Nothing was saved. Try again.",
  internal_error: "The server could not save it. Nothing was saved. Try again.",
  request_key_reused: "An earlier save of this comparison may already be stored. Close and look at the field before saving again.",
};
// A comparison the server could not read (route 8), in plain words.
export function observationReadText(info) {
  const texts = {
    notFound: "This team or field is not available now.",
    no_stored_session: "This team has no saved session yet. Run a search in Imports first.",
    no_comparable_session: "None of this team's latest saved sessions has two named athletes with different values of this field. Choose another team, or link the team's athletes in Imports.",
    not_enough_athletes: "OptiMove needs two athletes it can name, with different values of this field. Link the team's athletes in Imports (Link athletes).",
    unit_not_stated: "GPEXE sends no unit with this value. A platform administrator confirms it with a document (Confirm the unit).",
    unit_already_verified: "This field's unit is already confirmed.",
    field_has_evidence: "This field already carries other evidence; its unit is confirmed with a document.",
    field_has_parameters: "This field has parameters; its unit is confirmed with a document.",
    snapshot_expired: "The saved session is no longer available. Run a new search in Imports.",
    candidate_source_mismatch: "This session was not read through the team's current GPEXE link.",
    candidate_not_importable: "The import would not take this GPEXE session.",
    candidate_too_large: "The saved session is too large to read.",
    pair_out_of_range: "No other pair of athletes has different values of this field.",
    try_again: "The server was busy. Try again in a moment.",
  };
  return texts[info.code] || (info.status ? "The comparison could not be read." : "No answer from the server.");
}
export function sourceFieldCodeText(info, form = null) {
  if (form?.act === "observe") return OBSERVE_CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was saved." : "No answer from the server.");
  if (form?.act === "create") return CREATE_CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was created." : "No answer from the server.");
  if (form?.parameterKind === "zone_bounds" && ZONE_CODE_TEXT[info.code]) return ZONE_CODE_TEXT[info.code];
  return CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was saved." : "No answer from the server.");
}
// The refusals after which the form no longer fits what is saved: it is closed
// and the field read again.
export const CLOSES_FORM = new Set([
  "notFound", "bound_unit_required", "bound_unit_not_allowed", "operator_required", "operator_not_allowed",
  "unit_already_verified", "meaning_already_verified", "revision_retired",
  // Route O (G1b-2): the comparison no longer fits the field.
  "field_has_parameters", "field_has_evidence", "revision_not_active",
]);
// Route O's refusals after which the comparison is read again (the form stays).
export const REREADS_OBSERVATION = new Set(["board_changed", "pair_not_comparable", "unit_not_stated", "binding_not_active"]);
// The last question before a write-once act (OptiMove asks before every act
// it cannot take back: Bind, Reconnect, Unbind).
export function confirmQuestion(form, body) {
  if (form.act === "observe") {
    const o = form.observation;
    // The owner's rule: the decision in plain words; GPEXE's word and name stay under Technical details.
    return `Save ${o.unit} as the unit of ${form.fieldName}? Both athletes' numbers match GPEXE. You can't change it here later.`;
  }
  if (form.act === "create") {
    return `Use ${body.label}${form.unit ? ` (${form.unit})` : ""} in OptiMove? Once added, it cannot be removed here.`;
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

// One state per row of the list, in plain words (the owner's rule of 2026-11-18): in use, can be added, or not yet.
export function inventoryState(item, ctx) {
  if (item?.covered) return "In use";
  if (createOffered(ctx, item)) return "Not used yet";
  // A club cannot add a value (the list says there is nothing to do); the platform cannot add this one yet.
  return ctx?.mayVerify ? "Can't be added yet" : "Not imported yet";
}
