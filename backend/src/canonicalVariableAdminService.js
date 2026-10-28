// Canonical-variable administration (M3-0): the admin API for OptiMove's own
// canonical variables - Metrics Core definitions, independent of any source -
// under /api/training-load/sources/metrics/variables. It reads the variables of
// the active workspace's owner (and, in a club workspace, the system variables
// as a read-only reference), creates a variable with its version 1 and its
// levels in one transaction, and creates a new immutable semantic version of
// one. Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, decisions
// C80-C88 and section J3 (owner's decisions of 2026-10-14).
//
// Ownership comes from the active workspace only, exactly as in M2: the
// platform workspace is the system scope (an active platform admin); a club
// workspace is that club's scope (its active club admin, or a platform admin
// there). A body never names an owner, an actor, a basis, a value type, a state
// or a version number; a field this API does not take is 400 invalid_body.
//
// Every write is one bounded transaction of M2's machinery (adminWriteKit):
// the per-user advisory lock, the request record looked up before any row lock
// (a replay answers the current state after the right is checked again; the
// same key with another request is request_key_reused), the acting user as the
// v35 transaction-local setting before the first protected write (the v36
// request guard requires it), the right, the user and the club FOR SHARE, and a
// bounded COMMIT whose lost answer is verified on another connection by the
// request record (migration v36, training_load.metric_variable_requests). A
// write ends with exactly one request row in the same transaction.
//
// Lock order of a new version (the catalog writers' own order): the advisory
// lock -> the request record -> metric_definitions FOR UPDATE -> the role, user
// and club rows FOR SHARE -> the version insert and the repoint -> the request
// row. A create has no existing row to lock: the advisory lock -> the request
// record -> the role, user and club rows FOR SHARE -> its own new rows.
//
// The older /api/training-load/metrics catalog API keeps its own contract and
// callers (C82); this module neither calls nor changes it.
//
// R2 (decision C99, section J3b; migration v38) adds a rename, an archive and
// a restore of an existing variable, and a second audience for the reads and
// for those three writes: an active coach of an active team of the variable's
// club, in that team's workspace (club variables only; never a create, a new
// version, the key suggestion or the M2 routes). A team workspace reads the
// reduced view of Q7. Every write takes the definition FOR UPDATE, then the
// rights FOR SHARE (a coach: the stronger bases probed, then the team, the
// club and the role with the user), then its 409 checks; the database records
// the change itself (metric_variable_changes, written by a trigger) and the
// request row names that change.
import { adminWriteKit, canonicalDecimal, DECIMAL_INPUT, resolveMappingAdmin, SourceMetricMappingError, TEXT_LIMITS } from "./sourceMetricMappingService.js";
import { classificationFilterSql, variableClassification } from "./canonicalClassificationService.js";
import { resolveActiveWorkspace } from "./workspace.js";
import { unitTokenOk } from "./metricTextRules.js";
import { isIconKey } from "./iconKeys.js";

export { unitTokenOk };

const {
  runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, MESSAGES, plainObject, uuidField, boundedText, boundedOut,
  dec, decCmp, hashOf, encodeCursor, decodeCursor, invalidCursor, ownerKeyOf, CURSOR_AT, LOWER_UUID, UUID,
  CANONICAL_VERSION_COLUMNS, canonicalParametersOf, notReadyCodeOf,
} = adminWriteKit;

// The version of this request contract inside every request hash (C87).
const CONTRACT = "metric-variables/v1";
export const VARIABLE_PAGE_SIZES = Object.freeze({ variables: 100, versions: 50 });
// A key: lower-case ASCII, 1-63 characters, a letter first (C84). Metrics Core
// itself stores any text (v10, no limit); this is the admin API's rule.
export const KEY_RULE = /^[a-z][a-z0-9_]{0,62}$/;
const LEVELS = Object.freeze({ session: "session", drill: "component" });
const AGGREGATIONS = new Set(["sum", "avg", "max", "last", "none"]);
const ONE_SIDED = new Set([">=", ">", "<=", "<"]);
// v34's guard on metric_definitions (decision 9), exactly: a new version of a
// variable whose current version an active mapping version pins.
const PIN_GUARD = "metric_definitions: an active mapping version pins the current version; disable it first";
const KEY_CONSTRAINT = "metric_definitions_owner_scope_owner_user_id_owner_club_id__key";
const RETRY_CONSTRAINTS = new Set(["metric_variable_requests_one_per_key", "metric_definition_versions_metric_definition_id_version_num_key"]);

const TEXT = {
  key_taken: "A variable with this key already exists in this owner scope.",
  key_required: "No key can be made from this name. Send a key: lower-case letters, digits and underscores, a letter first, at most 63 characters.",
  invalid_unit: "The unit is not a unit token (1-30 characters, no space, '|' or '=').",
  invalid_condition: "The condition has no supported shape.",
  current_version_changed: "The variable's current version has changed. Load it again.",
  variable_not_active: "The variable is not active.",
  variable_pinned: "An active mapping version uses the variable's current version; no new version can replace it now.",
  version_unchanged: "The new version is the same as the current version.",
  rename_pinned: "An active mapping version uses this variable; only an administrator can rename it now.",
  archive_pinned: "An active mapping version uses this variable; it cannot be archived or restored now.",
  variable_changed: "The variable has changed since it was loaded. Load it again.",
  rename_unchanged: "The new names are the same as the current ones.",
  variable_active: "The variable is already active.",
  restore_by_admin: "An administrator archived this variable; only an administrator can restore it.",
};
// A rename's precondition: the server's SHA-256 of the stored label, short
// label, description and state (hex).
const LABELS_TOKEN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// The key a name suggests (C84), deterministic:
//   1. Unicode normalization (NFKD: canonical and compatibility decomposition);
//   2. the combining marks removed (č, ć, š, ž and every other letter that
//      decomposes lose their diacritic);
//   3. the explicit map of the Serbian Latin letters - đ and Đ do not
//      decompose and become "dj"; č, ć, š, ž are listed too, for any form that
//      reached this step undecomposed;
//   4. lower case;
//   5. every run of characters other than a-z and 0-9 (spaces and every other
//      separator) becomes one "_";
//   6. "_" runs merged, removed at the start and the end;
//   7. cut to 63 characters (and a trailing "_" removed); the result must pass
//      KEY_RULE, otherwise there is no suggestion (key_required).
// Not a transliteration: a Cyrillic or any other non-Latin letter becomes a
// separator, so a name in such a script needs an explicit key.
// ---------------------------------------------------------------------------
const SERBIAN_LATIN = new Map([["đ", "dj"], ["Đ", "dj"], ["č", "c"], ["Č", "c"], ["ć", "c"], ["Ć", "c"], ["š", "s"], ["Š", "s"], ["ž", "z"], ["Ž", "z"]]);
export function suggestVariableKey(label) {
  if (typeof label !== "string") return null;
  let text = label.normalize("NFKD").replace(/\p{M}/gu, "");
  text = [...text].map((ch) => SERBIAN_LATIN.get(ch) ?? ch).join("");
  text = text.toLowerCase();
  text = text.replace(/[^a-z0-9]+/g, "_");
  text = text.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (text.length > 63) text = text.slice(0, 63).replace(/_+$/, "");
  return KEY_RULE.test(text) ? text : null;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const invalidBody = (message) => refusal(400, "invalid_body", message);
const invalidCondition = () => refusal(400, "invalid_condition", TEXT.invalid_condition);
function optionalText(body, field, max) {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (!boundedText(value, max)) throw invalidBody(`${field} is one line of 1-${max} visible characters without surrounding spaces.`);
  return value;
}
function unitInput(value, onRefusal) {
  if (!unitTokenOk(value)) throw onRefusal();
  return value;
}
function decimalField(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DECIMAL_INPUT.test(value)) throw invalidBody(`${field} is a decimal string (at most 12 integer and 9 decimal digits, no exponent).`);
  return canonicalDecimal(value);
}
function conditionDecimal(value, { nonNegative = false } = {}) {
  if (typeof value !== "string" || !DECIMAL_INPUT.test(value)) throw invalidCondition();
  const text = canonicalDecimal(value);
  if (nonNegative && text.startsWith("-")) throw invalidCondition();
  return text;
}
// The condition of a version (C85): none, a zone or an event threshold, in
// exactly these shapes - never an arbitrary object. Returned in the API's
// normalized form, its keys always in this order.
function conditionInput(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidCondition();
  const keys = Object.keys(raw).sort().join(",");
  if (raw.kind === "zone" && raw.operator === "between") {
    if (keys !== "kind,lower,operator,unit,upper") throw invalidCondition();
    const lower = conditionDecimal(raw.lower);
    const upper = conditionDecimal(raw.upper);
    if (decCmp(dec(lower), dec(upper)) >= 0) throw invalidCondition();
    return { kind: "zone", operator: "between", lower, upper, unit: unitInput(raw.unit, invalidCondition) };
  }
  if (raw.kind === "zone" && ONE_SIDED.has(raw.operator)) {
    if (keys !== "kind,operator,unit,value") throw invalidCondition();
    return { kind: "zone", operator: raw.operator, value: conditionDecimal(raw.value), unit: unitInput(raw.unit, invalidCondition) };
  }
  if (raw.kind === "event_threshold" && ONE_SIDED.has(raw.operator)) {
    if (keys !== "durationSeconds,kind,operator,unit,value") throw invalidCondition();
    return {
      kind: "event_threshold", operator: raw.operator, value: conditionDecimal(raw.value),
      durationSeconds: conditionDecimal(raw.durationSeconds, { nonNegative: true }), unit: unitInput(raw.unit, invalidCondition),
    };
  }
  throw invalidCondition();
}
// The stored condition_description of a normalized condition: the shapes M2's
// canonicalParametersOf() reads, numbers as exact decimal text (made JSON
// numbers through numeric in SQL, never through a binary float).
function storedCondition(condition) {
  if (condition === null) return null;
  if (condition.kind === "zone" && condition.operator === "between") return { operator: "between", min: condition.lower, max: condition.upper, unit: condition.unit };
  if (condition.kind === "zone") return { operator: condition.operator, value: condition.value, unit: condition.unit };
  return { operator: condition.operator, value: condition.value, duration_seconds: condition.durationSeconds, unit: condition.unit };
}
// The SQL parameter of a condition: SQL NULL for none (never the JSON null).
const conditionParam = (condition) => (condition === null ? null : JSON.stringify(storedCondition(condition)));
const CONDITION_SQL = (param) => `case when ${param}::jsonb is null then null else (select jsonb_object_agg(e.key,
  case when e.key in ('operator', 'unit') then e.value else to_jsonb((e.value #>> '{}')::numeric) end) from jsonb_each(${param}::jsonb) e) end`;
function levelsInput(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2) throw invalidBody("levels is a non-empty list of session and drill.");
  const set = new Set(raw);
  // Own keys only: `in` would also accept an inherited name such as toString.
  if (set.size !== raw.length || [...set].some((level) => typeof level !== "string" || !Object.hasOwn(LEVELS, level))) {
    throw invalidBody("levels is a non-empty list of session and drill.");
  }
  return ["session", "drill"].filter((level) => set.has(level));
}
function aggregationInput(raw) {
  if (!AGGREGATIONS.has(raw)) throw invalidBody("dailyAggregationMethod is one of sum, avg, max, last, none.");
  return raw;
}
// The semantics of a version (unit, aggregation, bounds, condition) - shared by
// a create and a new version.
function semanticsInput(body) {
  const unit = unitInput(body.unit, () => refusal(400, "invalid_unit", TEXT.invalid_unit));
  const dailyAggregationMethod = aggregationInput(body.dailyAggregationMethod);
  const minValue = decimalField(body.minValue, "minValue");
  const maxValue = decimalField(body.maxValue, "maxValue");
  if (minValue !== null && maxValue !== null && decCmp(dec(minValue), dec(maxValue)) > 0) throw invalidBody("minValue is not above maxValue.");
  const condition = conditionInput(body.condition);
  return { unit, valueType: "numeric", dailyAggregationMethod, minValue, maxValue, condition };
}
// One deterministic text of a version's semantics (C83: no JSON key order is
// relied on - every value is placed by code, in a fixed order).
function semanticsKey(s) {
  const c = s.condition;
  const conditionPart = c === null ? null
    : c.kind === "unsupported" ? ["unsupported"]
      : [c.kind, c.operator, c.lower ?? c.value ?? null, c.upper ?? null, c.durationSeconds ?? null, c.unit];
  return JSON.stringify([s.unit, s.valueType, s.dailyAggregationMethod, s.minValue, s.maxValue, conditionPart]);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const VARIABLE_COLUMNS = `d.id, d.key, d.label, d.short_label, d.description, d.icon_url, d.owner_scope, d.owner_club_id, d.state, d.created_at, d.updated_at,
  ${CANONICAL_VERSION_COLUMNS}, v.daily_aggregation_method, trim_scale(v.min_value)::text as min_text, trim_scale(v.max_value)::text as max_text,
  v.created_at as version_created_at,
  (select array_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as scopes,
  exists (select 1 from training_load.source_metric_mapping_versions mv
           where mv.metric_definition_id = d.id and mv.metric_definition_version_id = d.current_version_id and mv.status = 'active') as pinned,
  lc.kind as last_change_kind, lc.basis as last_change_basis`;
// The most recent change of a definition (the largest seq, v38) and the basis
// of its request: Q8 lets a coach restore only an archive a coach made.
const VARIABLE_FROM = `training_load.metric_definitions d
  join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
  left join lateral (select c.kind, r.basis from training_load.metric_variable_changes c
                       left join training_load.metric_variable_requests r on r.metric_variable_change_id = c.id
                      where c.metric_definition_id = d.id order by c.seq desc limit 1) lc on true`;
const VERSION_ROW_COLUMNS = `${CANONICAL_VERSION_COLUMNS}, v.daily_aggregation_method, trim_scale(v.min_value)::text as min_text,
  trim_scale(v.max_value)::text as max_text, v.superseded_reason, v.created_at as version_created_at`;

// The API form of a stored condition_description: the three supported shapes,
// null for none, and only the marker {kind: "unsupported"} for any other shape
// (never the stored JSON).
function conditionOut(row) {
  if (row.cd_type === null || row.cd_type === undefined || row.cd_type === "null") return null;
  const canonical = canonicalParametersOf(row);
  if (!canonical) return { kind: "unsupported" };
  const p = canonical.params;
  if (canonical.kind === "zone_bounds" && p.operator === "between") return { kind: "zone", operator: "between", lower: p.lower, upper: p.upper, unit: p.unit };
  if (canonical.kind === "zone_bounds") return { kind: "zone", operator: p.operator, value: p.lower, unit: p.unit };
  return { kind: "event_threshold", operator: p.operator, value: p.value, durationSeconds: p.duration_seconds, unit: p.unit };
}
function versionOut(row, { current }) {
  const unit = boundedOut(row.unit, TEXT_LIMITS.unit);
  const reason = boundedOut(row.superseded_reason ?? null, TEXT_LIMITS.reason);
  return {
    value: {
      id: row.version_id, versionNumber: row.version_number, unit: unit.text, valueType: row.value_type,
      dailyAggregationMethod: row.daily_aggregation_method,
      minValue: row.min_text === null ? null : canonicalDecimal(row.min_text), maxValue: row.max_text === null ? null : canonicalDecimal(row.max_text),
      condition: conditionOut(row), ...(current === undefined ? {} : { current, reason: reason.text }), createdAt: row.version_created_at,
    },
    cut: unit.cut || reason.cut,
  };
}
const isOwn = (row, ctx) => row.owner_scope === ctx.owner.scope && (row.owner_scope === "system" || String(row.owner_club_id) === ctx.owner.clubId);
// A team workspace reads the reduced view (Q7), whoever the caller is.
const isCoachView = (ctx) => ctx.view === "coach";
// The rename precondition (J3b.2): computed from the stored row, never from
// the bounded output, so a value the output cuts can still be renamed.
const labelsTokenOf = (row) => hashOf([row.label, row.short_label ?? null, row.description ?? null, row.state]);
// A restore by a coach (Q8): the definition's most recent change is an archive
// whose request had the team_coach basis. An archive without a change row
// (legacy) is no coach's.
const coachArchived = (row) => row.last_change_kind === "archive" && row.last_change_basis === "team_coach";
// A variable's icon (Data configuration visual polish, PR-1): the key of the
// built-in library its icon_url names as `icon:<key>`; null for none and for
// any other stored value (an older URL is never sent to this screen).
const ICON_PREFIX = "icon:";
function iconOut(iconUrl) {
  if (typeof iconUrl !== "string" || !iconUrl.startsWith(ICON_PREFIX)) return null;
  const key = iconUrl.slice(ICON_PREFIX.length);
  return isIconKey(key) ? key : null;
}
// What this caller may do now with this variable; empty when it is not theirs.
function actionsOf(row, ctx, editable) {
  if (!editable) return [];
  const coach = ctx.basis === "team_coach";
  const actions = [];
  if (row.state === "active") {
    if (!(coach && row.pinned)) actions.push("rename");
    if (!row.pinned) actions.push("archive");
    if (!isCoachView(ctx) && !row.pinned) actions.push("newVersion");
  } else if (!row.pinned && !(coach && !coachArchived(row))) {
    actions.push("restore");
  }
  return actions;
}
// The reduced view of a team workspace (Q7): never the versions, the levels,
// the mapping readiness or the timestamps.
function reducedOut(row, ctx) {
  const editable = isOwn(row, ctx);
  const key = boundedOut(row.key, TEXT_LIMITS.key);
  const label = boundedOut(row.label, TEXT_LIMITS.label);
  const shortLabel = boundedOut(row.short_label, TEXT_LIMITS.shortLabel);
  const description = boundedOut(row.description, TEXT_LIMITS.description);
  return {
    id: row.id, key: key.text, label: label.text, shortLabel: shortLabel.text, description: description.text, icon: iconOut(row.icon_url),
    ownerScope: row.owner_scope, state: row.state, editable, actions: actionsOf(row, ctx, editable), labelsToken: labelsTokenOf(row),
    truncated: key.cut || label.cut || shortLabel.cut || description.cut,
  };
}
const viewOf = (row, ctx) => (isCoachView(ctx) ? reducedOut(row, ctx) : variableOut(row, ctx));
function variableOut(row, ctx) {
  const editable = isOwn(row, ctx);
  const key = boundedOut(row.key, TEXT_LIMITS.key);
  const label = boundedOut(row.label, TEXT_LIMITS.label);
  const shortLabel = boundedOut(row.short_label, TEXT_LIMITS.shortLabel);
  const description = boundedOut(row.description, TEXT_LIMITS.description);
  const version = versionOut(row, {});
  let mappingTarget;
  if (!editable) mappingTarget = { ready: false, notReadyCode: "target_scope_mismatch" };
  else if (row.state !== "active") mappingTarget = { ready: false, notReadyCode: "target_not_active" };
  else {
    const notReadyCode = notReadyCodeOf(row);
    mappingTarget = { ready: notReadyCode === null, notReadyCode };
  }
  return {
    id: row.id, key: key.text, label: label.text, shortLabel: shortLabel.text, description: description.text, icon: iconOut(row.icon_url),
    ownerScope: row.owner_scope, state: row.state, editable, actions: actionsOf(row, ctx, editable), labelsToken: labelsTokenOf(row),
    levels: ["session", "drill"].filter((level) => (row.scopes ?? []).includes(LEVELS[level])),
    currentVersion: version.value, mappingTarget, createdAt: row.created_at, updatedAt: row.updated_at,
    truncated: key.cut || label.cut || shortLabel.cut || description.cut || version.cut,
  };
}
// The semantics of a stored version, in the form semanticsKey() compares.
function storedSemantics(row) {
  return {
    unit: row.unit, valueType: row.value_type, dailyAggregationMethod: row.daily_aggregation_method,
    minValue: row.min_text === null ? null : canonicalDecimal(row.min_text), maxValue: row.max_text === null ? null : canonicalDecimal(row.max_text),
    condition: conditionOut(row),
  };
}

// The owner scopes a workspace reads: its own; in a club workspace also the
// system scope, as a read-only reference (C88). Never a team or user scope.
function ownerFilter(ctx, scope, params) {
  if (scope === "system" || ctx.owner.scope === "system") return `d.owner_scope = 'system'`;
  params.push(ctx.owner.clubId);
  return `(d.owner_scope = 'club' and d.owner_club_id = $${params.length}::uuid)`;
}
const readableSql = (ctx, params) => {
  if (ctx.owner.scope === "system") return `d.owner_scope = 'system'`;
  params.push(ctx.owner.clubId);
  return `(d.owner_scope = 'system' or (d.owner_scope = 'club' and d.owner_club_id = $${params.length}::uuid))`;
};
const writableSql = (ctx, params) => ownerFilter(ctx, "own", params);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function singleQuery(query, allowed) {
  const out = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!allowed.includes(key) || typeof value !== "string") throw refusal(400, "invalid_query", "The query carries a parameter this route does not take.");
    out[key] = value;
  }
  return out;
}

// GET /variables: one page of the active workspace's variables (scope=own,
// the default) or, in a club workspace, of the system variables as a
// read-only reference (scope=system); state=active (default) | archived | all.
// Keyset on (created_at, id), a fixed page of 100, an opaque cursor bound to
// the workspace's owner key, the scope and the state.
export async function listVariables({ ctx, query }) {
  const q = singleQuery(query, ["scope", "state", "cursor", "domainId", "categoryId"]);
  const scope = q.scope ?? "own";
  const state = q.state ?? "active";
  if (!["own", "system"].includes(scope)) throw refusal(400, "invalid_query", "scope is own or system.");
  if (!["active", "archived", "all"].includes(state)) throw refusal(400, "invalid_query", "state is active, archived or all.");
  // C6 (J6): at most one classification filter - a category, or a domain
  // (directly or through its categories).
  if (q.domainId !== undefined && q.categoryId !== undefined) throw refusal(400, "invalid_query", "domainId and categoryId are not combined.");
  let filter = null;
  for (const field of ["domainId", "categoryId"]) {
    if (q[field] === undefined) continue;
    if (!UUID.test(q[field])) throw refusal(400, "invalid_query", `${field} is a uuid.`);
    filter = { [field]: q[field].toLowerCase() };
  }
  const filterKey = filter ? (filter.domainId ? `d:${filter.domainId}` : `c:${filter.categoryId}`) : null;
  let after = null;
  if (q.cursor !== undefined) {
    // A filtered list's cursor carries its filter (f); an unfiltered one keeps
    // the earlier form.
    const p = decodeCursor(q.cursor, filterKey ? "f,i,k,o,sc,st,t,v" : "i,k,o,sc,st,t,v");
    if (p.k !== "variables" || p.o !== ownerKeyOf(ctx) || p.sc !== scope || p.st !== state || (filterKey && p.f !== filterKey)) throw invalidCursor();
    if (typeof p.t !== "string" || !CURSOR_AT.test(p.t)) throw invalidCursor();
    const instant = new Date(`${p.t.slice(0, 23)}Z`);
    if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 23) !== p.t.slice(0, 23) || instant.getUTCFullYear() < 2000) throw invalidCursor();
    if (typeof p.i !== "string" || !LOWER_UUID.test(p.i)) throw invalidCursor();
    after = { at: p.t, id: p.i };
  }
  return boundedRead(async (client) => {
    const params = [];
    const owner = ownerFilter(ctx, scope, params);
    params.push(state === "all" ? null : state);
    const stateIdx = params.length;
    const classified = filter ? `and ${classificationFilterSql(ctx, filter, params)}` : "";
    params.push(after ? after.at : null, after ? after.id : null);
    const atIdx = params.length - 1;
    params.push(VARIABLE_PAGE_SIZES.variables + 1);
    const rows = (await client.query(
      `select ${VARIABLE_COLUMNS}, to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as cursor_at
         from ${VARIABLE_FROM}
        where ${owner}
          and ($${stateIdx}::text is null or d.state = $${stateIdx}::text)
          ${classified}
          and ($${atIdx}::timestamp is null or (d.created_at, d.id) > (($${atIdx}::timestamp at time zone 'UTC'), $${atIdx + 1}::uuid))
        order by d.created_at, d.id
        limit $${params.length}`,
      params,
    )).rows;
    const page = rows.slice(0, VARIABLE_PAGE_SIZES.variables);
    const last = page[page.length - 1];
    const nextCursor = rows.length > VARIABLE_PAGE_SIZES.variables
      ? encodeCursor({ v: 1, k: "variables", o: ownerKeyOf(ctx), sc: scope, st: state, t: last.cursor_at, i: last.id, ...(filterKey ? { f: filterKey } : {}) })
      : null;
    return { variables: page.map((row) => viewOf(row, ctx)), nextCursor };
  });
}

// GET /variables/key-suggestion?label=: the key the name suggests and whether
// a variable of this workspace's owner already holds it (any state).
export async function suggestKey({ ctx, query }) {
  adminOnly(ctx);
  const q = singleQuery(query, ["label"]);
  if (!boundedText(q.label, TEXT_LIMITS.label)) throw refusal(400, "invalid_query", "label is one line of 1-80 visible characters without surrounding spaces.");
  const key = suggestVariableKey(q.label);
  if (key === null) throw refusal(400, "key_required", TEXT.key_required);
  return boundedRead(async (client) => {
    const params = [];
    const owner = writableSql(ctx, params);
    params.push(key);
    const taken = (await client.query(`select 1 from training_load.metric_definitions d where ${owner} and d.key = $${params.length} limit 1`, params)).rowCount === 1;
    return { key, taken };
  });
}

// GET /variables/:id: the variable (own, or the system reference in a club
// workspace) with one page of its versions, by number descending. A team
// workspace reads the reduced view, without versions (and takes no cursor).
export async function getVariable({ ctx, variableId, query }) {
  if (typeof variableId !== "string" || !UUID.test(variableId)) return null;
  const id = variableId.toLowerCase();
  if (isCoachView(ctx)) {
    singleQuery(query, []);
    return boundedRead(async (client) => {
      const params = [id];
      const readable = readableSql(ctx, params);
      const row = (await client.query(`select ${VARIABLE_COLUMNS} from ${VARIABLE_FROM} where d.id = $1 and ${readable}`, params)).rows[0];
      if (!row) return null;
      return { variable: { ...reducedOut(row, ctx), classification: await variableClassification(client, ctx, id) }, nextCursor: null };
    });
  }
  const q = singleQuery(query, ["cursor"]);
  let afterNumber = null;
  if (q.cursor !== undefined) {
    const p = decodeCursor(q.cursor, "d,k,n,o,v");
    if (p.k !== "variable_versions" || p.o !== ownerKeyOf(ctx) || p.d !== id) throw invalidCursor();
    if (!Number.isSafeInteger(p.n) || p.n < 1 || p.n > 2147483647) throw invalidCursor();
    afterNumber = p.n;
  }
  return boundedRead(async (client) => {
    const params = [id];
    const readable = readableSql(ctx, params);
    const row = (await client.query(`select ${VARIABLE_COLUMNS} from ${VARIABLE_FROM} where d.id = $1 and ${readable}`, params)).rows[0];
    if (!row) return null;
    const rows = (await client.query(
      `select ${VERSION_ROW_COLUMNS} from training_load.metric_definition_versions v
        where v.metric_definition_id = $1 and ($2::int is null or v.version_number < $2::int)
        order by v.version_number desc limit $3`,
      [id, afterNumber, VARIABLE_PAGE_SIZES.versions + 1],
    )).rows;
    const page = rows.slice(0, VARIABLE_PAGE_SIZES.versions);
    const nextCursor = rows.length > VARIABLE_PAGE_SIZES.versions
      ? encodeCursor({ v: 1, k: "variable_versions", o: ownerKeyOf(ctx), d: id, n: page[page.length - 1].version_number })
      : null;
    const versions = page.map((v) => versionOut(v, { current: v.version_id === row.version_id }));
    const variable = variableOut(row, ctx);
    if (versions.some((v) => v.cut)) variable.truncated = true;
    const classification = await variableClassification(client, ctx, id);
    return { variable: { ...variable, versions: versions.map((v) => v.value), classification }, nextCursor };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const VARIABLE_REQUESTS = Object.freeze({
  find: `select operation, request_hash, metric_definition_id, metric_definition_version_id, owner_scope, owner_club_id
           from training_load.metric_variable_requests where requested_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.metric_variable_requests where requested_by_user_id = $1 and request_key = $2`,
});
const variableIdsOf = (written) => ({ variableId: written.metric_definition_id ?? null, ...(written.operation === "variable_version_create" ? { versionId: written.metric_definition_version_id } : {}) });

// Only the allowlisted database refusals become a 4xx; everything else is a
// sanitized 500 (logged by its code only, by the router).
export function classifyVariableError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01" || code === "57014") {
    console.error(`[metric-variables] try_again (${code})`);
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "23505") {
    if (error.constraint === KEY_CONSTRAINT) return refusal(409, "key_taken", TEXT.key_taken);
    if (RETRY_CONSTRAINTS.has(error.constraint)) return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "23514" && !error.constraint && error.message === PIN_GUARD) return refusal(409, "variable_pinned", TEXT.variable_pinned);
  return null;
}

// The admin-only operations (create, a new version, the key suggestion) never
// run for a team workspace: their routes resolve the admin context, which has
// none; this repeats it here (defence in depth).
function adminOnly(ctx) {
  if (isCoachView(ctx) || ctx.basis === "team_coach") throw NOT_FOUND();
}

// A write's answer and a replay: the variable only when this workspace may
// write it (the record's owner is the workspace's owner).
async function writableVariable(executor, ctx, record) {
  if (record.owner_scope !== ctx.owner.scope || (record.owner_scope === "club" && String(record.owner_club_id) !== ctx.owner.clubId)) return null;
  const params = [record.metric_definition_id];
  const owner = writableSql(ctx, params);
  const row = (await executor.query(`select ${VARIABLE_COLUMNS} from ${VARIABLE_FROM} where d.id = $1 and ${owner}`, params)).rows[0];
  return row ? viewOf(row, ctx) : null;
}
async function writtenVersion(executor, record) {
  const row = (await executor.query(
    `select ${VERSION_ROW_COLUMNS}, d.current_version_id
       from training_load.metric_definition_versions v join training_load.metric_definitions d on d.id = v.metric_definition_id
      where v.id = $1 and v.metric_definition_id = $2`,
    [record.metric_definition_version_id, record.metric_definition_id],
  )).rows[0];
  return row ? versionOut(row, { current: row.current_version_id === row.version_id }).value : null;
}
async function insertRequest(client, { ctx, requestKey, requestHash, operation, definitionId, versionId }) {
  await client.query(
    `insert into training_load.metric_variable_requests
       (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_definition_version_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [requestKey, ctx.userId, operation, requestHash, ctx.owner.scope, ctx.owner.clubId, ctx.basis, definitionId, versionId],
  );
}
// The database's own unit rule, once more inside the write (the JavaScript twin
// decided before any lock; they must agree).
async function unitsAgree(client, units) {
  for (const unit of units) {
    const ok = (await client.query(`select training_load.source_metric_unit_token_ok($1) as ok`, [unit])).rows[0].ok;
    if (ok !== true) return false;
  }
  return true;
}

// Test seam (never set by the application): runs inside a write's transaction
// after every lock is taken and every check passed, right before the first row
// is written.
let writeHold = null;
export function setVariableWriteHoldForTests(fn) { writeHold = fn ?? null; }

// POST /variables - a canonical variable: the definition, its version 1 and
// its levels, in the workspace's owner scope, in one transaction.
export async function createVariable({ ctx, body }) {
  adminOnly(ctx);
  plainObject(body,
    ["requestKey", "label", "shortLabel", "description", "key", "iconKey", "unit", "levels", "dailyAggregationMethod", "minValue", "maxValue", "condition"],
    ["requestKey", "label", "unit", "levels", "dailyAggregationMethod"]);
  const requestKey = uuidField(body.requestKey);
  if (!boundedText(body.label, TEXT_LIMITS.label)) throw invalidBody("label is one line of 1-80 visible characters without surrounding spaces.");
  const label = body.label;
  const shortLabel = optionalText(body, "shortLabel", TEXT_LIMITS.shortLabel);
  const description = optionalText(body, "description", TEXT_LIMITS.description);
  let sentKey = null;
  if (body.key !== undefined && body.key !== null) {
    if (typeof body.key !== "string" || !KEY_RULE.test(body.key)) throw invalidBody("key is lower-case letters, digits and underscores, a letter first, at most 63 characters.");
    sentKey = body.key;
  }
  // An icon of the built-in library (PR-1): only a key of its current list,
  // stored as `icon:<key>`; never a URL, an alias or markup.
  let iconKey = null;
  if (body.iconKey !== undefined && body.iconKey !== null) {
    if (!isIconKey(body.iconKey)) throw invalidBody("iconKey is a key of the icon library.");
    iconKey = body.iconKey;
  }
  const levels = levelsInput(body.levels);
  const semantics = semanticsInput(body);
  const key = sentKey ?? suggestVariableKey(label);
  if (key === null) throw refusal(400, "key_required", TEXT.key_required);
  // A create without an icon hashes exactly as before the icon existed, so a
  // replay of an older request keeps its answer; an icon joins the hash only
  // when one is sent.
  const requestHash = hashOf({
    contract: CONTRACT, operation: "variable_create",
    body: {
      label, shortLabel, description, key: sentKey, unit: semantics.unit, levels, dailyAggregationMethod: semantics.dailyAggregationMethod,
      minValue: semantics.minValue, maxValue: semantics.maxValue, condition: semantics.condition,
      ...(iconKey === null ? {} : { iconKey }),
    },
  });
  return runWrite({
    ctx, where: "variable_create", requestKey, requestHash, action: "variable_create",
    requests: VARIABLE_REQUESTS, classify: classifyVariableError, idsOf: variableIdsOf,
    reread: async (executor, record) => {
      const variable = await writableVariable(executor, ctx, record);
      return variable ? { variable } : null;
    },
    body: async (client) => {
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const units = [semantics.unit, ...(semantics.condition ? [semantics.condition.unit] : [])];
      if (!(await unitsAgree(client, units))) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
      if (writeHold) await writeHold(client, "variable_create");
      const definitionId = (await client.query(
        `insert into training_load.metric_definitions (key, label, short_label, description, icon_url, owner_scope, owner_club_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [key, label, shortLabel, description, iconKey === null ? null : `${ICON_PREFIX}${iconKey}`, ctx.owner.scope, ctx.owner.clubId, ctx.userId],
      )).rows[0].id;
      const versionId = (await client.query(
        `insert into training_load.metric_definition_versions
           (metric_definition_id, version_number, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method, created_by_user_id)
         values ($1, 1, $2, 'numeric', $3::numeric, $4::numeric, ${CONDITION_SQL("$5")}, $6, $7) returning id`,
        [definitionId, semantics.unit, semantics.minValue, semantics.maxValue, conditionParam(semantics.condition),
          semantics.dailyAggregationMethod, ctx.userId],
      )).rows[0].id;
      await client.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, definitionId]);
      for (const level of levels) {
        await client.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, $2)`, [definitionId, LEVELS[level]]);
      }
      await insertRequest(client, { ctx, requestKey, requestHash, operation: "variable_create", definitionId, versionId });
      return { operation: "variable_create", metric_definition_id: definitionId, metric_definition_version_id: versionId, owner_scope: ctx.owner.scope, owner_club_id: ctx.owner.clubId };
    },
  });
}

// POST /variables/:id/versions - a new immutable semantic version of a
// variable of the workspace's owner; its current version must still be the one
// the caller saw (expectedCurrentVersionId, a precondition - not the request's
// identity). Key, owner and levels never change here.
export async function createVariableVersion({ ctx, variableId, body }) {
  adminOnly(ctx);
  if (typeof variableId !== "string" || !UUID.test(variableId)) throw NOT_FOUND();
  plainObject(body,
    ["requestKey", "expectedCurrentVersionId", "unit", "dailyAggregationMethod", "minValue", "maxValue", "condition", "reason"],
    ["requestKey", "expectedCurrentVersionId", "unit", "dailyAggregationMethod"]);
  const requestKey = uuidField(body.requestKey);
  const expectedCurrentVersionId = uuidField(body.expectedCurrentVersionId);
  const semantics = semanticsInput(body);
  const reason = optionalText(body, "reason", TEXT_LIMITS.reason);
  const id = variableId.toLowerCase();
  const requestHash = hashOf({
    contract: CONTRACT, operation: "variable_version_create", variableId: id,
    body: {
      expectedCurrentVersionId, unit: semantics.unit, dailyAggregationMethod: semantics.dailyAggregationMethod,
      minValue: semantics.minValue, maxValue: semantics.maxValue, condition: semantics.condition, reason,
    },
  });
  return runWrite({
    ctx, where: "variable_version_create", requestKey, requestHash, action: "variable_version_create",
    requests: VARIABLE_REQUESTS, classify: classifyVariableError, idsOf: variableIdsOf,
    reread: async (executor, record) => {
      const variable = await writableVariable(executor, ctx, record);
      if (!variable) return null;
      const version = await writtenVersion(executor, record);
      return version ? { variable, version } : null;
    },
    body: async (client) => {
      const params = [id];
      const owner = writableSql(ctx, params);
      const plain = (await client.query(`select d.id from training_load.metric_definitions d where d.id = $1 and ${owner}`, params)).rows[0];
      if (!plain) throw NOT_FOUND();
      const locked = (await client.query(
        `select id, owner_scope, owner_club_id, state, current_version_id from training_load.metric_definitions where id = $1 for update`, [id],
      )).rows[0];
      if (!locked || !isOwn(locked, ctx)) throw NOT_FOUND();
      if (locked.state !== "active") throw refusal(409, "variable_not_active", TEXT.variable_not_active);
      const current = (await client.query(
        `select ${VERSION_ROW_COLUMNS} from training_load.metric_definition_versions v where v.id = $1 and v.metric_definition_id = $2`,
        [locked.current_version_id, id],
      )).rows[0];
      if (!current || current.version_id !== expectedCurrentVersionId) {
        throw refusal(409, "current_version_changed", TEXT.current_version_changed,
          current ? { current: { versionId: current.version_id, versionNumber: current.version_number } } : undefined);
      }
      if (semanticsKey(storedSemantics(current)) === semanticsKey(semantics)) throw refusal(409, "version_unchanged", TEXT.version_unchanged);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const units = [semantics.unit, ...(semantics.condition ? [semantics.condition.unit] : [])];
      if (!(await unitsAgree(client, units))) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
      if (writeHold) await writeHold(client, "variable_version_create");
      const versionId = (await client.query(
        `insert into training_load.metric_definition_versions
           (metric_definition_id, version_number, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method,
            superseded_reason, created_by_user_id)
         select $1, (select coalesce(max(version_number), 0) + 1 from training_load.metric_definition_versions where metric_definition_id = $1),
                $2, 'numeric', $3::numeric, $4::numeric, ${CONDITION_SQL("$5")}, $6, $7, $8
         returning id`,
        [id, semantics.unit, semantics.minValue, semantics.maxValue, conditionParam(semantics.condition),
          semantics.dailyAggregationMethod, reason, ctx.userId],
      )).rows[0].id;
      await client.query(`update training_load.metric_definitions set current_version_id = $1, updated_at = now() where id = $2`, [versionId, id]);
      await insertRequest(client, { ctx, requestKey, requestHash, operation: "variable_version_create", definitionId: id, versionId });
      return { operation: "variable_version_create", metric_definition_id: id, metric_definition_version_id: versionId, owner_scope: ctx.owner.scope, owner_club_id: ctx.owner.clubId };
    },
  });
}

// ---------------------------------------------------------------------------
// R2 (C99, section J3b): who may change a variable, and the three writes.
// ---------------------------------------------------------------------------
// The context of the variable routes (the reads and the three writes). In the
// platform workspace and a club workspace exactly resolveMappingAdmin(). In a
// team workspace, from the database, never from the workspace list: the team
// active with a club, the club active, the user's active team_coach role on
// the team and the user active (Q6: an admin acts in a team workspace only as
// that team's coach). The owner is the team's club; the basis is the
// strongest the user holds for it - platform admin, then the club's admin,
// then the team's coach -, the one the database derives (v38). The team is
// named only for the team_coach basis.
export async function resolveVariableEditor(req) {
  if (!req?.user?.id || !req.authz) return null;
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (!workspace) return null;
  if (workspace.type !== "team") {
    const ctx = await resolveMappingAdmin(req, workspace);
    return ctx ? { ...ctx, view: "admin" } : null;
  }
  const teamId = workspace.scopeId ? String(workspace.scopeId).toLowerCase() : null;
  if (!teamId || !UUID.test(teamId)) return null;
  const userId = String(req.user.id);
  const row = (await boundedRead((client) => client.query(
    `select t.club_id,
            exists (select 1 from public.user_global_roles g
                     where g.user_id = u.id and g.role = 'platform_admin' and g.is_active = true) as platform_admin,
            exists (select 1 from public.user_club_roles a
                     where a.user_id = u.id and a.club_id = t.club_id and a.role = 'club_admin' and a.is_active = true) as club_admin
       from public.teams t
       join public.clubs c on c.id = t.club_id
       join public.user_team_roles r on r.team_id = t.id
       join public.users u on u.id = r.user_id
      where t.id = $1 and coalesce(t.is_active, true) and coalesce(c.is_active, true)
        and r.user_id = $2 and r.role = 'team_coach' and r.is_active = true and u.is_active = true`,
    [teamId, userId],
  ))).rows[0];
  if (!row) return null;
  const basis = row.platform_admin ? "platform_admin" : row.club_admin ? "club_admin" : "team_coach";
  return { userId, basis, owner: { scope: "club", clubId: String(row.club_id) }, view: "coach", ...(basis === "team_coach" ? { teamId } : {}) };
}

// v38's request guard derives the basis again when the request row is written.
// A stronger role granted after the rights were checked makes it differ from
// the basis this request writes: exactly that refusal is the request to repeat
// (J3b.2, try_again); every other database refusal stays a sanitized 500.
const BASIS_CHANGED = "metric variable request: the basis is not the acting user's own";
function classifyChangeError(error) {
  if (!(error instanceof SourceMetricMappingError) && error?.code === "42501" && error.message === BASIS_CHANGED) {
    console.error("[metric-variables] try_again (basis changed)");
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  return classifyVariableError(error);
}

// One R2 write (J3b.5): the definition read unlocked first (not this caller's:
// the identical 404, so a refused caller never waits for its lock), then FOR
// UPDATE, then the rights FOR SHARE - lost: the identical 404, before any
// answer that carries data -, then `check` (the route's 409s), the text rule
// on every value that changes (`texts`: [value, max, field, nullable]) and
// once more in the database, the UPDATE (the v38 trigger writes the change
// row) and the request row naming that change.
async function runChange({ ctx, variableId, operation, requestKey, requestHash, reason, check, update, texts }) {
  const id = variableId.toLowerCase();
  return runWrite({
    ctx, where: operation, requestKey, requestHash, action: operation,
    requests: VARIABLE_REQUESTS, classify: classifyChangeError, idsOf: variableIdsOf,
    reread: async (executor, record) => {
      const variable = await writableVariable(executor, ctx, record);
      return variable ? { variable } : null;
    },
    body: async (client) => {
      const params = [id];
      const owner = writableSql(ctx, params);
      const plain = (await client.query(`select d.id from training_load.metric_definitions d where d.id = $1 and ${owner}`, params)).rows[0];
      if (!plain) throw NOT_FOUND();
      const locked = (await client.query(
        `select id, owner_scope, owner_club_id from training_load.metric_definitions where id = $1 for update`, [id],
      )).rows[0];
      if (!locked || !isOwn(locked, ctx)) throw NOT_FOUND();
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const row = (await client.query(`select ${VARIABLE_COLUMNS} from ${VARIABLE_FROM} where d.id = $1`, [id])).rows[0];
      if (!row) throw NOT_FOUND();
      check(row);
      for (const [value, max, field = "reason", nullable = false] of [...texts(row), [reason, TEXT_LIMITS.reason]]) {
        if (value === null) continue;
        if (!boundedText(value, max)) throw invalidBody(textRuleMessage(field, max, nullable));
        const ok = (await client.query(`select training_load.source_metric_text_ok($1, $2) as ok`, [value, max])).rows[0].ok;
        if (ok !== true) throw invalidBody("A text is not one line of visible characters within its limit.");
      }
      if (writeHold) await writeHold(client, operation);
      const set = update(row);
      await client.query(`update training_load.metric_definitions set ${set.sql}, updated_at = now() where id = $1`, [id, ...set.values]);
      const changes = (await client.query(
        `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id()`, [id],
      )).rows;
      if (changes.length !== 1) throw new Error("variable change: not exactly one change row");
      await client.query(
        `insert into training_load.metric_variable_requests
           (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, basis_team_id,
            metric_definition_id, metric_variable_change_id, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [requestKey, ctx.userId, operation, requestHash, ctx.owner.scope, ctx.owner.clubId, ctx.basis,
          ctx.basis === "team_coach" ? ctx.teamId : null, id, changes[0].id, reason],
      );
      return { operation, metric_definition_id: id, owner_scope: ctx.owner.scope, owner_club_id: ctx.owner.clubId };
    },
  });
}
const variableIdOrNotFound = (variableId) => {
  if (typeof variableId !== "string" || !UUID.test(variableId)) throw NOT_FOUND();
  return variableId.toLowerCase();
};
const textRuleMessage = (field, max, nullable) =>
  `${field} is one line of 1-${max} visible characters without surrounding spaces${nullable ? ", or null" : ""}.`;
// A rename field: absent (unchanged), or its new value; null clears an
// optional one. Returns undefined for absent. Here only its type is checked:
// the text rule applies inside the write to a value that differs from the
// stored one, so a field sent with its stored value is exempt, as in v38's
// request guard (Q10).
function renameField(body, field, max, { nullable }) {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw invalidBody(textRuleMessage(field, max, nullable));
  return value;
}

// POST /variables/:id/rename - a new label, short label or description of an
// active variable; labelsToken is the token of the stored names the caller saw.
export async function renameVariable({ ctx, variableId, body }) {
  const id = variableIdOrNotFound(variableId);
  plainObject(body, ["requestKey", "labelsToken", "label", "shortLabel", "description"], ["requestKey", "labelsToken"]);
  const requestKey = uuidField(body.requestKey);
  if (typeof body.labelsToken !== "string" || !LABELS_TOKEN.test(body.labelsToken)) throw invalidBody("labelsToken is the token a read of the variable returned.");
  const labelsToken = body.labelsToken;
  const label = renameField(body, "label", TEXT_LIMITS.label, { nullable: false });
  const shortLabel = renameField(body, "shortLabel", TEXT_LIMITS.shortLabel, { nullable: true });
  const description = renameField(body, "description", TEXT_LIMITS.description, { nullable: true });
  if (label === undefined && shortLabel === undefined && description === undefined) throw invalidBody("A rename names at least one of label, shortLabel and description.");
  const sent = {
    labelsToken,
    ...(label === undefined ? {} : { label }), ...(shortLabel === undefined ? {} : { shortLabel }), ...(description === undefined ? {} : { description }),
  };
  const requestHash = hashOf({ contract: CONTRACT, operation: "variable_rename", variableId: id, body: sent });
  const next = (row) => ({
    label: label === undefined ? row.label : label,
    shortLabel: shortLabel === undefined ? row.short_label : shortLabel,
    description: description === undefined ? row.description : description,
  });
  return runChange({
    ctx, variableId: id, operation: "variable_rename", requestKey, requestHash, reason: null,
    check: (row) => {
      if (row.state !== "active") throw refusal(409, "variable_not_active", TEXT.variable_not_active);
      if (labelsTokenOf(row) !== labelsToken) throw refusal(409, "variable_changed", TEXT.variable_changed, { current: reducedOut(row, ctx) });
      const n = next(row);
      if (n.label === row.label && n.shortLabel === (row.short_label ?? null) && n.description === (row.description ?? null)) {
        throw refusal(409, "rename_unchanged", TEXT.rename_unchanged);
      }
      if (ctx.basis === "team_coach" && row.pinned) throw refusal(409, "variable_pinned", TEXT.rename_pinned);
    },
    // Only the values this rename changes are checked; one it leaves out, or
    // sends with its stored value, is exempt.
    texts: (row) => [
      [label, row.label, "label", TEXT_LIMITS.label, false],
      [shortLabel, row.short_label ?? null, "shortLabel", TEXT_LIMITS.shortLabel, true],
      [description, row.description ?? null, "description", TEXT_LIMITS.description, true],
    ].filter(([value, stored]) => value !== undefined && value !== stored)
      .map(([value, , field, max, nullable]) => [value, max, field, nullable]),
    update: (row) => {
      const n = next(row);
      return { sql: "label = $2, short_label = $3, description = $4", values: [n.label, n.shortLabel, n.description] };
    },
  });
}

// POST /variables/:id/archive - an active variable becomes archived (Q3: a
// reason is required). Decision 9 refuses a pinned one, for everyone.
export async function archiveVariable({ ctx, variableId, body }) {
  const id = variableIdOrNotFound(variableId);
  plainObject(body, ["requestKey", "reason"], ["requestKey", "reason"]);
  const requestKey = uuidField(body.requestKey);
  if (!boundedText(body.reason, TEXT_LIMITS.reason)) throw invalidBody("reason is one line of 1-500 visible characters without surrounding spaces.");
  const reason = body.reason;
  const requestHash = hashOf({ contract: CONTRACT, operation: "variable_archive", variableId: id, body: { reason } });
  return runChange({
    ctx, variableId: id, operation: "variable_archive", requestKey, requestHash, reason,
    check: (row) => {
      if (row.state !== "active") throw refusal(409, "variable_not_active", TEXT.variable_not_active);
      if (row.pinned) throw refusal(409, "variable_pinned", TEXT.archive_pinned);
    },
    texts: () => [],
    update: () => ({ sql: "state = 'archived'", values: [] }),
  });
}

// POST /variables/:id/restore - an archived variable becomes active again (Q3:
// a reason is optional). A coach restores only what a coach archived (Q8).
export async function restoreVariable({ ctx, variableId, body }) {
  const id = variableIdOrNotFound(variableId);
  plainObject(body, ["requestKey", "reason"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const reason = optionalText(body, "reason", TEXT_LIMITS.reason);
  const requestHash = hashOf({ contract: CONTRACT, operation: "variable_restore", variableId: id, body: { reason } });
  return runChange({
    ctx, variableId: id, operation: "variable_restore", requestKey, requestHash, reason,
    check: (row) => {
      if (row.state === "active") throw refusal(409, "variable_active", TEXT.variable_active);
      if (ctx.basis === "team_coach" && !coachArchived(row)) throw refusal(409, "restore_by_admin", TEXT.restore_by_admin);
      if (row.pinned) throw refusal(409, "variable_pinned", TEXT.archive_pinned);
    },
    texts: () => [],
    update: () => ({ sql: "state = 'active'", values: [] }),
  });
}
