// Training Load -> Data configuration -> Mappings (phase 8, J16:
// docs/ai/phase8-mappings-screen-contract.md). An administrator connects a
// source field to an OptiMove variable in a guided flow of three steps, submits
// the draft, and a platform administrator activates, replaces or disables a
// version; a version is switched on and off for the club's GPEXE teams by name,
// and checked against a saved session. Frontend only, over the routes of M2,
// 7b, 7c (reads), 7d, 7e and 7f: the screen never sends an owner, an actor or a
// basis, and the server answers everyone else with the same 404.
import { api } from "./api.js";
import { state } from "./state.js";
import { TEXT_FORBIDDEN, WRITE_BOUND_MS, errorInfo, newRequestKey, outcomeUnknown } from "./metric-variables-data.js";
import { notConfirmedForImport } from "./gpexe-import-data.js";

export { errorInfo, newRequestKey, outcomeUnknown };

const BASE = "/api/training-load/sources/metrics";
const CONNECTIONS = "/api/training-load/sources/gpexe/connections";
const CANDIDATES = "/api/training-load/gpexe/teams";

// Who is offered the screen (J16 section 2, C99): the platform workspace (a
// platform admin) or a club workspace (its admin, or a platform admin who also
// administers the club). A team workspace never. The server decides again.
export function mappingsContext(user = state.currentUser) {
  const ws = user?.activeWorkspace || null;
  if (!ws) return null;
  const available = Array.isArray(user?.availableWorkspaces) ? user.availableWorkspaces : [];
  // A platform workspace exists only for an active platform admin.
  const isPlatformAdmin = ws.type === "platform" || available.some((w) => w?.type === "platform");
  if (ws.type === "platform") return { owner: "system", clubId: null, clubName: "", isPlatformAdmin: true };
  if (ws.type === "club" && ws.scopeId) return { owner: "club", clubId: String(ws.scopeId), clubName: ws.label || "", isPlatformAdmin };
  return null;
}

const emptyList = () => ({ items: [], nextCursor: null, loaded: false, loading: false, loadingMore: false, error: null });
export function emptyMappingsState() {
  return {
    // Bumped on every reset: an answer for an older view is dropped.
    generation: 0,
    // "list" | "flow" | "detail"
    view: "list",
    list: emptyList(),
    // The reads the flow and the detail share: fields, the workspace's own
    // variables, the active unit conversions.
    refs: { fields: [], targets: [], conversions: [], loaded: false, loading: false, error: null },
    // Only the clubs' and teams' ids and names of /api/organization (J16 1).
    org: { clubs: [], teams: [], loaded: false, loading: false, error: null },
    // The GPEXE connections of a club: { [clubId]: { connections, loading, error } }.
    connections: {},
    detail: { id: null, mapping: null, nextCursor: null, loading: false, loadingMore: false, error: null },
    // A version's teams: the open (or all) activations, named.
    teams: { versionId: null, rows: [], showEnded: false, loading: false, error: null, truncated: false },
    // The guided flow (section 4).
    flow: null,
    // An open panel on the detail: activate, replace, disable, switch-on, preview.
    panel: null,
    // The one write in flight or not confirmed.
    write: null,
    notice: "",
    noticeKind: "",
  };
}
export function mappingsState() {
  if (!state.trainingLoad.mappings) state.trainingLoad.mappings = emptyMappingsState();
  return state.trainingLoad.mappings;
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------
const withCursor = (path, cursor) => (cursor ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : path);
export const fetchMappings = (cursor = null) => api(withCursor(`${BASE}/mappings`, cursor));
export const fetchMapping = (id, cursor = null) => api(withCursor(`${BASE}/mappings/${encodeURIComponent(id)}`, cursor));
export const fetchFields = () => api(`${BASE}/fields`);
export const fetchTargets = () => api(`${BASE}/targets`);
export const fetchConversions = (cursor = null) => api(withCursor(`${BASE}/conversions`, cursor));
export function fetchActivations({ versionId = null, bindingId = null, stateFilter = "open", cursor = null }) {
  const params = new URLSearchParams();
  if (versionId) params.set("versionId", versionId);
  if (bindingId) params.set("bindingId", bindingId);
  params.set("state", stateFilter);
  if (cursor) params.set("cursor", cursor);
  return api(`${BASE}/activations?${params.toString()}`);
}
export const fetchPreview = (mappingId, versionId, candidateId) =>
  api(`${BASE}/mappings/${encodeURIComponent(mappingId)}/versions/${encodeURIComponent(versionId)}/preview?candidateId=${encodeURIComponent(candidateId)}`);
export const fetchOrganization = () => api("/api/organization");
export const fetchConnections = (clubId) => api(`${CONNECTIONS}?clubId=${encodeURIComponent(clubId)}`);
// The list route only: the single-session route carries athlete names (J16 7).
export const fetchCandidates = (teamId, { includeSuperseded = false } = {}) =>
  api(`${CANDIDATES}/${encodeURIComponent(teamId)}/candidates${includeSuperseded ? "?includeSuperseded=true" : ""}`);

function write(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
const versionPath = (mappingId, versionId, act) => `${BASE}/mappings/${encodeURIComponent(mappingId)}/versions/${encodeURIComponent(versionId)}/${act}`;
// The path of every write the screen sends; the body is built in one place
// (the actions) and sent again unchanged by Check result.
export const WRITE_PATH = {
  create: () => `${BASE}/mappings`,
  draft: ({ mappingId }) => `${BASE}/mappings/${encodeURIComponent(mappingId)}/versions`,
  submit: ({ mappingId, versionId }) => versionPath(mappingId, versionId, "submit"),
  activate: ({ mappingId, versionId }) => versionPath(mappingId, versionId, "activate"),
  disable: ({ mappingId, versionId }) => versionPath(mappingId, versionId, "disable"),
  switchOn: () => `${BASE}/activations`,
  switchOff: ({ activationId }) => `${BASE}/activations/${encodeURIComponent(activationId)}/end`,
};
export const sendWrite = (act, target, body) => write(WRITE_PATH[act](target), body);

// The organization answer also carries athletes, users and join applications:
// only the clubs' and teams' ids and names are kept (J16 1, 10).
export function orgFacts(data) {
  const clubs = (Array.isArray(data?.clubs) ? data.clubs : []).map((c) => ({ id: String(c.id), name: String(c.name ?? "") }));
  const teams = (Array.isArray(data?.teams) ? data.teams : []).map((t) => ({
    id: String(t.id), name: String(t.name ?? ""), club_id: t.club_id ? String(t.club_id) : null, club_name: String(t.club_name ?? ""),
  }));
  return { clubs, teams };
}

// ---------------------------------------------------------------------------
// Names written by others, before a confirm or a review card (J16 9): control
// and format characters (bidi included) removed, blanks collapsed, at most 80
// characters, quoted by the caller. Escaping for HTML comes after.
// ---------------------------------------------------------------------------
const FORMAT_CHARS = new RegExp(TEXT_FORBIDDEN.source, "gu");
export function cleanName(value, max = 80) {
  const text = String(value ?? "").replace(FORMAT_CHARS, "").replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

// ---------------------------------------------------------------------------
// Exact decimals (the server's DECIMAL_INPUT and its equivalence rule)
// ---------------------------------------------------------------------------
export const DECIMAL = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/;
const absBig = (x) => (x < 0n ? -x : x);
function gcd(a, b) {
  a = absBig(a); b = absBig(b);
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}
function reduce(n, d) {
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
export function ratOf(text) {
  const s = String(text ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [int, frac = ""] = s.replace("-", "").split(".");
  const n = BigInt(int + frac) * (neg ? -1n : 1n);
  return reduce(n, 10n ** BigInt(frac.length));
}
const mul = (a, b) => reduce(a.n * b.n, a.d * b.d);
const sub = (a, b) => reduce(a.n * b.d - b.n * a.d, a.d * b.d);
const div = (a, b) => (b.n === 0n ? null : reduce(a.n * b.d, a.d * b.n));
// The rational as the server's decimal text, or null when it has no exact
// value within 9 decimals and 12 integer digits.
export function decText(r) {
  if (!r) return null;
  const scale = 10n ** 9n;
  if ((scale * r.n) % r.d !== 0n) return null;
  const scaled = (scale * r.n) / r.d;
  const neg = scaled < 0n;
  const digits = absBig(scaled).toString().padStart(10, "0");
  const int = digits.slice(0, -9).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-9).replace(/0+$/, "");
  if (int.length > 12) return null;
  const text = `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
  return text === "-0" ? "0" : text;
}
// The source value that the server's rule
//   canonical * divisor = source * scale + offset * divisor
// accepts for a canonical value, through a conversion (null: identity).
export function sourceValueFor(canonicalText, conversion) {
  const c = ratOf(canonicalText);
  if (!c) return null;
  if (!conversion) return decText(c);
  const ps = ratOf(conversion.scale);
  const pd = ratOf(conversion.scaleDivisor);
  const po = ratOf(conversion.offset ?? "0");
  if (!ps || !pd || !po) return null;
  return decText(div(mul(pd, sub(c, po)), ps));
}

// ---------------------------------------------------------------------------
// Fields (step 1)
// ---------------------------------------------------------------------------
export const SOURCE_LABEL = { gpexe: "GPEXE" };
export const sourceLabel = (sourceSystem) => SOURCE_LABEL[sourceSystem] || String(sourceSystem || "");
// The revision a draft is made from (R3): the active one, else the newest draft.
export function chosenRevision(field) {
  const revisions = field?.revisions || [];
  return revisions.find((r) => r.state === "active") || revisions.find((r) => r.state === "draft") || null;
}
export const hasBound = (revision) => revision?.parameterKind === "zone_bounds" || revision?.parameterKind === "event_threshold";
export const revisionVerified = (revision) => Boolean(revision && revision.state === "active" && revision.evidenceStatus === "verified");
// Whether a field can be chosen in step 1, and why not (J16 4.2).
export function fieldStatus(field) {
  if (!field) return { choosable: false, reason: "This field is not available." };
  if (field.state !== "active") return { choosable: false, reason: "This field is retired." };
  if (!field.extractorAvailable) return { choosable: false, reason: "OptiMove cannot read this field yet." };
  const revision = chosenRevision(field);
  if (!revision || !revision.sourceUnit) return { choosable: false, reason: "Its unit is not confirmed yet.", unitMissing: true };
  if (hasBound(revision) && (!revision.sourceBoundUnit || !revision.boundOperator)) {
    return { choosable: false, reason: "Its unit is not confirmed yet.", unitMissing: true };
  }
  return { choosable: true, reason: "", revision, meaningPending: !revisionVerified(revision) };
}

// ---------------------------------------------------------------------------
// Conversions and variables (steps 2 and 3)
// ---------------------------------------------------------------------------
// Exactly one active conversion of the pair, or null (none, or more than one).
export function conversionOf(conversions, from, to) {
  const rows = (conversions || []).filter((c) => c.fromUnit === from && c.toUnit === to);
  return rows.length === 1 ? rows[0] : null;
}
// "1 s = 1/60 min", "1 m/s = 3.6 km/h".
export function conversionWords(c) {
  if (!c) return "";
  const factor = String(c.scaleDivisor) === "1" ? `${c.scale}` : `${c.scale}/${c.scaleDivisor}`;
  const offset = c.offset && String(c.offset) !== "0" ? ` + ${c.offset}` : "";
  return `1 ${c.fromUnit} = ${factor}${offset} ${c.toUnit}`;
}
// The reverse pair and whether the two agree (7c R4): both without an
// offset and scale_a * scale_b = divisor_a * divisor_b.
export function reversePair(conversions, c) {
  if (!c) return null;
  const back = conversionOf(conversions, c.toUnit, c.fromUnit);
  if (!back) return null;
  // With an offset the two are not compared here (agree: null).
  if (![c.offset, back.offset].every((o) => !o || String(o) === "0")) return { conversion: back, agree: null };
  const parts = [c.scale, back.scale, c.scaleDivisor, back.scaleDivisor].map(ratOf);
  if (parts.some((p) => !p)) return { conversion: back, agree: null };
  const left = mul(parts[0], parts[1]);
  const right = mul(parts[2], parts[3]);
  return { conversion: back, agree: left.n === right.n && left.d === right.d };
}
// The kind of a variable's condition (the /targets shape).
export function conditionKind(params) {
  if (!params || typeof params !== "object") return "none";
  if ("duration_seconds" in params) return "event_threshold";
  if ("lower" in params) return "zone_bounds";
  return "none";
}
export const levelsOf = (revision, target) => ({
  session: Boolean(revision?.supportsSession && (target?.scopes || []).includes("session")),
  drill: Boolean(revision?.supportsDrill && (target?.scopes || []).includes("component")),
});
const READINESS = {
  canonical_not_numeric: "Not numeric, so no mapping can use it.",
  canonical_unit_missing: "It has no unit, so no mapping can use it.",
  canonical_unit_not_a_token: "Its unit is not a unit token, so no mapping can use it.",
};
// The bound values the field must hold for this variable, in the field's
// bound unit (J16 4.4), or null when one has no exact value there.
export function expectedBounds(revision, target, conversions) {
  const params = target?.currentVersion?.canonicalParameters || null;
  if (!hasBound(revision) || !params) return null;
  const conversion = revision.sourceBoundUnit === params.unit ? null : conversionOf(conversions, revision.sourceBoundUnit, params.unit);
  if (revision.parameterKind === "zone_bounds") {
    const lower = sourceValueFor(params.lower, conversion);
    const upper = params.upper === null || params.upper === undefined ? null : sourceValueFor(params.upper, conversion);
    if (lower === null || (params.upper !== null && params.upper !== undefined && upper === null)) return { exact: false, conversion, params };
    return { exact: true, conversion, params, lower, upper };
  }
  const thresholdValue = sourceValueFor(params.value, conversion);
  if (thresholdValue === null) return { exact: false, conversion, params };
  return { exact: true, conversion, params, thresholdValue, durationSeconds: params.duration_seconds };
}
// Whether a variable can be chosen for this field in step 2, why not, and its
// suggestion badge (J16 4.3).
export function targetStatus(target, revision, conversions) {
  if (!target.versionReady) return { choosable: false, reason: READINESS[target.notReadyCode] || "Not ready to be the target of a mapping." };
  const unit = target.currentVersion?.unit || null;
  const levels = levelsOf(revision, target);
  if (!levels.session && !levels.drill) return { choosable: false, reason: "It has no level this field supports." };
  let conversion = null;
  let badge = "same";
  if (unit !== revision.sourceUnit) {
    conversion = conversionOf(conversions, revision.sourceUnit, unit);
    if (!conversion) return { choosable: false, reason: `There is no conversion from ${revision.sourceUnit} to ${unit} yet.` };
    badge = "converted";
  }
  // A variable with a condition is filled only by a field with the same kind
  // of condition, and a field without one only fills a variable without one
  // (the screen's guard; the server checks the bounds again).
  if (conditionKind(target.currentVersion?.canonicalParameters || null) !== (revision.parameterKind || "none")) {
    return { choosable: false, reason: "Its condition does not match this field's." };
  }
  if (hasBound(revision)) {
    const params = target.currentVersion?.canonicalParameters || null;
    if (params.operator !== revision.boundOperator) {
      return { choosable: false, reason: "Its condition does not match this field's." };
    }
    if (params.unit !== revision.sourceBoundUnit && !conversionOf(conversions, revision.sourceBoundUnit, params.unit)) {
      return { choosable: false, reason: "Its condition does not match this field's." };
    }
    const expected = expectedBounds(revision, target, conversions);
    if (!expected?.exact) return { choosable: false, reason: "Its bound has no exact value in this field's unit." };
  }
  return { choosable: true, reason: "", badge, conversion, levels };
}
// The variables of step 2: the choosable ones with the field's own unit
// first, then those reached by a conversion, then the rest (R4).
export function orderedTargets(targets, revision, conversions) {
  const rank = (st) => (!st.choosable ? 2 : st.badge === "same" ? 0 : 1);
  return (targets || [])
    .map((target) => ({ target, status: targetStatus(target, revision, conversions) }))
    .sort((a, b) => rank(a.status) - rank(b.status) || String(a.target.label || "").localeCompare(String(b.target.label || "")));
}

// ---------------------------------------------------------------------------
// The draft (section 4.4)
// ---------------------------------------------------------------------------
export const NOTE_MAX = 500;
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
export function emptyFlowDraft() {
  return { session: false, drill: false, conversionNote: "", lower: "", upper: "", thresholdValue: "", durationSeconds: "" };
}
// The body of POST /mappings/:id/versions and its field errors.
export function buildDraftBody({ requestKey, revision, target, conversions, draft }) {
  const errors = {};
  const levels = levelsOf(revision, target);
  const session = levels.session && levels.drill ? Boolean(draft.session) : levels.session;
  const drillOn = levels.session && levels.drill ? Boolean(draft.drill) : levels.drill;
  if (!session && !drillOn) errors.levels = "Choose at least one level.";
  const unitsDiffer = (target.currentVersion?.unit || null) !== revision.sourceUnit;
  const note = oneLine(draft.conversionNote);
  if (unitsDiffer) {
    if (!note) errors.conversionNote = "Required, because the units differ.";
    else if ([...note].length > NOTE_MAX) errors.conversionNote = `At most ${NOTE_MAX} characters.`;
    else if (TEXT_FORBIDDEN.test(note)) errors.conversionNote = "Remove the hidden characters.";
  }
  let sourceParameters;
  const decimal = (name, value) => {
    const v = String(value ?? "").trim();
    if (!v) { errors[name] = "Required."; return null; }
    if (!DECIMAL.test(v)) { errors[name] = "A number with at most 9 decimals, for example 7 or 25.2."; return null; }
    return v;
  };
  if (revision.parameterKind === "zone_bounds") {
    const lower = decimal("lower", draft.lower);
    const upper = revision.boundOperator === "between" ? decimal("upper", draft.upper) : null;
    sourceParameters = { lower, upper };
  } else if (revision.parameterKind === "event_threshold") {
    sourceParameters = { thresholdValue: decimal("thresholdValue", draft.thresholdValue), durationSeconds: decimal("durationSeconds", draft.durationSeconds) };
    if (sourceParameters.durationSeconds && sourceParameters.durationSeconds.startsWith("-")) errors.durationSeconds = "Not below zero.";
  }
  if (Object.keys(errors).length) return { body: null, errors };
  return {
    errors,
    body: {
      requestKey,
      sourceRevisionId: revision.id,
      appliesToSession: session,
      appliesToDrill: drillOn,
      ...(unitsDiffer ? { conversionNote: note } : {}),
      ...(sourceParameters ? { sourceParameters } : {}),
    },
  };
}
export const REASON_MAX = 500;
export function reasonError(value) {
  const v = oneLine(value);
  if (!v) return "Required.";
  if ([...v].length > REASON_MAX) return `At most ${REASON_MAX} characters.`;
  if (TEXT_FORBIDDEN.test(v)) return "Remove the hidden characters.";
  return "";
}
export const cleanReason = (value) => oneLine(value);

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------
export const STATUS_LABEL = { draft: "Draft", needs_review: "Waiting for review", active: "Active", disabled: "Disabled" };
export const END_REASON_LABEL = {
  admin_ended: "Switched off by an administrator",
  mapping_version_replaced: "The version was replaced",
  mapping_version_disabled: "The version was disabled",
};
export const REQUIREMENT_LABEL = { required: "Required", optional: "Optional" };
export const REQUIREMENT_MEANING = "When imports use this mapping — Required: if an athlete the import admits has no value, the whole session is not imported. Optional: athletes without a value get no value for this variable; this alone does not stop the session from being imported.";
export const ACTS_SENTENCE = "Activating approves a version as the mapping's current one. Switching it on for a team lets that team's imports use it.";
export const FREE_TEXT_NOTE = "Do not enter athlete names, ids, dates of birth or measured values.";
// The list row's state in words, from the list summary (J16 4.1).
export function mappingStateText(m) {
  const latest = m?.latestVersion || null;
  if (!latest) return "No version yet";
  if (m.activeVersionId) {
    if (latest.id === m.activeVersionId) return `Active: version ${latest.versionNumber}`;
    if (latest.status === "needs_review") return `Active · version ${latest.versionNumber} waiting for review`;
    if (latest.status === "draft") return `Active · draft version ${latest.versionNumber}`;
    return "Active";
  }
  return STATUS_LABEL[latest.status] || latest.status;
}
// Whether a session cannot be imported as it stands (J16 7, R5): the server's
// word through the fail-closed helper, or any status but pending and blocked.
export function notForImport(candidate) {
  if (!candidate) return true;
  return notConfirmedForImport(candidate) || !["pending", "blocked"].includes(candidate.status);
}
export const notForImportBadge = (candidate) => (candidate?.status === "imported" ? "Already imported" : "Not confirmed for import");
export const NOT_FOR_IMPORT_SENTENCE = "This session cannot be imported as it stands. Its values are shown here only to check the mapping.";

// ---------------------------------------------------------------------------
// Refusals (J16 8)
// ---------------------------------------------------------------------------
// A Check result settles only on an answer the server gives after reading its
// request record or for the body itself: a stated refusal with a code. Busy,
// no access, signed out, a reused key and any 5xx say nothing about the first
// write.
const NEVER_SETTLES = new Set(["notFound", "try_again", "request_key_reused", "jsonRequired", "error", "no_answer"]);
export function checkSettles(info) {
  return info.status >= 400 && info.status < 500 && info.status !== 401 && info.status !== 403 && !NEVER_SETTLES.has(info.code);
}
export function checkNoteText(info) {
  if (outcomeUnknown(info)) return "No answer again. The result is still not confirmed.";
  if (info.status === 401) return "The check could not be done: you are signed out. Sign in again in a new tab, then Check result here.";
  if (info.code === "request_key_reused") return "The check could not be done: a save under this request is already stored with other values. Close without checking and look at the mapping.";
  if (info.code === "notFound") return "The check could not be done: this workspace has no access to it now. The result is still not confirmed.";
  if (info.code === "try_again") return "The check could not be done: the server was busy. The result is still not confirmed; Check result again in a moment.";
  return "The check could not be done. The result is still not confirmed; Check result again in a moment.";
}
const DRAFT_TEXT = {
  unit_not_proven: "The field's unit (or its bound) is not confirmed yet.",
  parameters_not_proven: "The field's unit (or its bound) is not confirmed yet.",
  source_metric_unsupported: "OptiMove cannot read this field with these settings.",
  parameters_unsupported: "OptiMove cannot read this field with these settings.",
  level_not_allowed: "The field or the variable does not allow this level.",
  conversion_unavailable: "There is no usable conversion between these units now.",
  bound_conversion_unavailable: "There is no usable conversion between these units now.",
  conversion_not_normal: "There is no usable conversion between these units now.",
  parameters_not_equivalent: "The bound does not match the variable's bound.",
  condition_description_unsupported: "The bound does not match the variable's bound.",
  canonical_not_numeric: "This variable cannot be the target of a mapping now.",
  canonical_unit_missing: "This variable cannot be the target of a mapping now.",
  canonical_unit_not_a_token: "This variable cannot be the target of a mapping now.",
  target_not_active: "This variable cannot be the target of a mapping now.",
  revision_not_usable: "The field changed; choose it again.",
  invalid_parameters: "The bound does not match the variable's bound.",
  conversion_note_required: "The units differ, so the conversion note is required.",
};
const ACT_TEXT = {
  create: {
    target_scope_mismatch: "This variable cannot be used here now.",
    target_not_active: "This variable cannot be used here now.",
    source_metric_retired: "This field is retired.",
  },
  draft: DRAFT_TEXT,
  submit: {
    version_not_draft: "This version changed meanwhile.",
    revision_not_usable: "This version changed meanwhile.",
  },
  activate: {
    version_not_submitted: "This mapping changed meanwhile.",
    active_version_changed: "This mapping changed meanwhile.",
    revision_not_verified: "The field's unit and meaning must be confirmed first.",
    canonical_version_changed: "The variable has a newer version: make a new version.",
    source_metric_target_taken: "This field already fills another variable. Only one of them can be active at a time.",
    ...Object.fromEntries(["target_not_active", "conversion_unavailable", "bound_conversion_unavailable", "level_not_allowed", "source_metric_unsupported", "parameters_unsupported"]
      .map((code) => [code, `This version cannot be activated now: ${DRAFT_TEXT[code]}`])),
  },
  disable: { version_status_changed: "This version changed meanwhile." },
  switchOn: { version_not_active: "This version is no longer active.", field_retired: "This version is no longer active." },
  switchOff: { activation_not_open: "This team was already switched off." },
};
// The refusals about one team of a batch: the team is named (J16 6).
export const TEAM_CODES = new Set(["binding_not_active", "binding_source_mismatch", "activation_exists", "variable_taken_on_binding"]);
export const TEAM_CODE_TEXT = {
  binding_not_active: "is no longer linked to GPEXE",
  binding_source_mismatch: "is linked to another source",
  activation_exists: "already gets this field",
  variable_taken_on_binding: "already has this variable at this level",
};
// The refusals after which the item on the screen is out of date: the form
// closes and the item is read again.
export const READ_AGAIN = new Set([
  "target_scope_mismatch", "target_not_active", "source_metric_retired", "revision_not_usable", "version_not_draft",
  "version_not_submitted", "active_version_changed", "canonical_version_changed", "version_status_changed",
  "version_not_active", "field_retired", "activation_not_open",
  "canonical_not_numeric", "canonical_unit_missing", "canonical_unit_not_a_token",
]);
const MAPPING_ACTS = new Set(["create", "draft", "submit", "activate", "disable"]);
export function refusalText(act, info) {
  if (info.code === "notFound") {
    return MAPPING_ACTS.has(act)
      ? "It is not available in this workspace now. Whether it was saved is not known: open the mapping again to see."
      : "It is not available in this workspace now. Whether it was saved is not known: open the version's teams again to see.";
  }
  if (info.code === "try_again") return "The server was busy. Nothing was saved. Try again.";
  if (info.code === "internal_error") return "The server could not save it. Nothing was saved. Try again.";
  if (info.code === "request_key_reused") return "An earlier save of this form may already be stored. Close it and look at the mapping before saving again.";
  if (info.code === "invalid_body" || info.code === "invalid_query") return "The screen sent something the server does not accept. Nothing was saved.";
  const text = ACT_TEXT[act]?.[info.code];
  if (text) return text;
  return info.status ? "It was not saved: the server refused it." : "No answer from the server.";
}
// The sentence for a refusal of a preview (J16 7).
export function previewRefusalText(info) {
  if (info.code === "notFound") return "This session is not available for this mapping in this workspace.";
  if (info.code === "snapshot_expired") return "The saved session is no longer available. Find it again in Imports.";
  if (info.code === "candidate_too_large") return "This session is too large to check here.";
  if (info.code === "candidate_source_mismatch") return "This session was not read through this field's source, so it cannot be checked with this mapping.";
  if (info.code === "source_metric_unsupported" || info.code === "parameters_unsupported") return "OptiMove cannot read this field with these settings.";
  if (info.code === "candidate_not_importable") return "This session cannot be read for this mapping.";
  if (info.code === "try_again") return "The server was busy. Try again.";
  return info.status ? "The session could not be checked." : "No answer from the server.";
}
