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
import {
  adminWriteKit, canonicalDecimal, DECIMAL_INPUT, resolveMappingAdmin, SourceMetricMappingError, TEXT_LIMITS, classifyDatabaseError,
  MAX_COPIED_MAPPINGS, COPY_NOT_REPRODUCIBLE_MESSAGE, readSystemMappingsForCopy, lockSystemMappingsForCopy, copiedMappingRefusal,
  insertCopiedMappings, copiedMappingsOf,
} from "./sourceMetricMappingService.js";
import { lockHides } from "./sourceMetricActivationSteps.js";
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
  icon_unchanged: "The variable already has this icon.",
  // v53 (J15 sections 4.1 and 4.2).
  copy_source_not_system: "Only an OptiMove variable can be copied; this is the club's own variable.",
  source_not_active: "The OptiMove variable is archived.",
  source_version_changed: "The OptiMove variable has a new version. Load it again.",
  already_copied: "The club already has a copy of this variable.",
  copy_source_unsupported: "This OptiMove variable cannot be a club variable.",
  copy_mapping_not_reproducible: COPY_NOT_REPRODUCIBLE_MESSAGE,
  copy_too_large: "This variable has too many mappings to copy in one step.",
  hide_not_system: "Only an OptiMove variable can be hidden; the club archives its own variables.",
  variable_in_use: "The club's teams still use this variable; switch it off for them first.",
  label_required: "The OptiMove variable's name cannot be used here. Send a label: one line of 1-80 visible characters without surrounding spaces.",
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
// any other stored value (an older URL is never sent to this screen). A domain's
// and a category's icon (V4, J6.1) are read the same way.
export const ICON_PREFIX = "icon:";
export function iconOut(iconUrl) {
  if (typeof iconUrl !== "string" || !iconUrl.startsWith(ICON_PREFIX)) return null;
  const key = iconUrl.slice(ICON_PREFIX.length);
  return isIconKey(key) ? key : null;
}
// v53 (J15 sections 2.2 and 4.1): why a system variable cannot become a club
// variable, or null - the facts POST /variables could never create: not
// numeric, a unit or a condition unit that is not a unit token, an unsupported
// condition, a day level, no level at all.
export function copyUnsupportedReason(row) {
  const notReady = notReadyCodeOf(row);
  if (notReady === "canonical_not_numeric") return "not_numeric";
  if (notReady) return "unit";
  const condition = conditionOut(row);
  if (condition?.kind === "unsupported") return "condition";
  if (condition && !unitTokenOk(condition.unit)) return "unit";
  const scopes = row.scopes ?? [];
  if (scopes.includes("day")) return "day_level";
  if (scopes.length === 0) return "no_levels";
  return null;
}

// v53 (J15 section 4.4): a club's facts about the given system variables -
// hidden in the club, switched on for its teams, with a data source (an active
// system mapping version), the club's copy - and whether the club has a linked
// team (an active binding of a connection the club owns). Keyed by the
// workspace's club only; never another club's.
async function clubFactsOf(executor, clubId, ids) {
  if (ids.length === 0) return new Map();
  const linkedTeam = (await executor.query(
    `select 1 from training_load.source_team_bindings b
       join training_load.source_credential_connections c on c.id = b.connection_id
      where b.state = 'active' and c.owner_scope = 'club' and c.owner_club_id = $1 limit 1`,
    [clubId],
  )).rowCount > 0;
  const rows = (await executor.query(
    `select d.id::text as id,
            (select h.hidden_at from training_load.metric_definition_club_hides h
              where h.club_id = $1 and h.metric_definition_id = d.id and h.shown_at is null) as hidden_at,
            exists (select 1 from training_load.source_metric_mapping_activations a
                      join training_load.source_metric_mappings m on m.id = a.mapping_id
                     where a.metric_definition_id = d.id and a.ended_at is null and m.owner_key = 'system'
                       and training_load.source_metric_binding_club(a.source_team_binding_id) = $1) as used_by_teams,
            exists (select 1 from training_load.source_metric_mapping_versions v
                      join training_load.source_metric_mappings m on m.id = v.mapping_id
                     where m.metric_definition_id = d.id and m.owner_key = 'system' and v.status = 'active') as has_data_source,
            (select c.club_definition_id from training_load.metric_definition_copies c
              where c.club_id = $1 and c.system_definition_id = d.id) as copy_id
       from unnest($2::uuid[]) as d(id)`,
    [clubId, ids],
  )).rows;
  return new Map(rows.map((r) => [r.id, {
    hidden: r.hidden_at !== null, hiddenAt: r.hidden_at, usedByTeams: r.used_by_teams, hasDataSource: r.has_data_source,
    copyId: r.copy_id, linkedTeam,
  }]));
}
// The club facts of a page's system rows, in a club or a team workspace of a
// club (ctx.owner is the club); empty elsewhere (the platform workspace).
async function clubFactsForRows(executor, ctx, rows) {
  if (ctx.owner?.scope !== "club") return new Map();
  return clubFactsOf(executor, ctx.owner.clubId, rows.filter((r) => r.owner_scope === "system").map((r) => r.id));
}

// The acts on a system variable (J15 section 8.1): only in a club's own
// workspace with the admin view, never from the basis, never in a team
// workspace (view "coach") or the platform workspace; use, copy, hide, show.
function systemActionsOf(row, ctx, club) {
  if (!club || row.owner_scope !== "system" || ctx.view !== "admin" || ctx.owner?.scope !== "club" || row.state !== "active") return [];
  const actions = [];
  if (!club.hidden && club.hasDataSource && club.linkedTeam) actions.push("use");
  if (club.copyId === null && copyUnsupportedReason(row) === null) actions.push("copy");
  if (club.hidden) actions.push("show");
  else if (!club.usedByTeams) actions.push("hide");
  return actions;
}

// What this caller may do now with this variable; empty when it is not theirs.
function actionsOf(row, ctx, editable, club = null) {
  if (!editable) return systemActionsOf(row, ctx, club);
  const coach = ctx.basis === "team_coach";
  const actions = [];
  if (row.state === "active") {
    if (!(coach && row.pinned)) actions.push("rename");
    if (!row.pinned) actions.push("archive");
    if (!isCoachView(ctx) && !row.pinned) actions.push("newVersion");
    // J3b.11: every basis of a rename, a pinned variable too (display only).
    actions.push("icon");
  } else if (!row.pinned && !(coach && !coachArchived(row))) {
    actions.push("restore");
  }
  return actions;
}
// The reduced view of a team workspace (Q7): never the versions, the levels,
// the mapping readiness or the timestamps.
function reducedOut(row, ctx, club = null) {
  const editable = isOwn(row, ctx);
  const key = boundedOut(row.key, TEXT_LIMITS.key);
  const label = boundedOut(row.label, TEXT_LIMITS.label);
  const shortLabel = boundedOut(row.short_label, TEXT_LIMITS.shortLabel);
  const description = boundedOut(row.description, TEXT_LIMITS.description);
  return {
    id: row.id, key: key.text, label: label.text, shortLabel: shortLabel.text, description: description.text, icon: iconOut(row.icon_url),
    ownerScope: row.owner_scope, state: row.state, editable, actions: actionsOf(row, ctx, editable, club), labelsToken: labelsTokenOf(row),
    // v53 (J15 section 4.4): a team workspace of the club reads only the hide.
    ...(club && row.owner_scope === "system" ? { club: { hidden: club.hidden } } : {}),
    truncated: key.cut || label.cut || shortLabel.cut || description.cut,
  };
}
const viewOf = (row, ctx, clubs = null) => {
  const club = clubs?.get(String(row.id)) ?? null;
  return isCoachView(ctx) ? reducedOut(row, ctx, club) : variableOut(row, ctx, club);
};
// v53 (J15 section 4.4): club X's block on a system row in club X's workspace.
const clubBlockOf = (club) => ({ hidden: club.hidden, usedByTeams: club.usedByTeams, hasDataSource: club.hasDataSource, copyId: club.copyId });
function variableOut(row, ctx, club = null) {
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
    ownerScope: row.owner_scope, state: row.state, editable, actions: actionsOf(row, ctx, editable, club), labelsToken: labelsTokenOf(row),
    ...(club && row.owner_scope === "system" && ctx.owner?.scope === "club" ? { club: clubBlockOf(club) } : {}),
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
  const q = singleQuery(query, ["scope", "state", "cursor", "domainId", "categoryId", "hidden"]);
  const scope = q.scope ?? "own";
  const state = q.state ?? "active";
  if (!["own", "system"].includes(scope)) throw refusal(400, "invalid_query", "scope is own or system.");
  if (!["active", "archived", "all"].includes(state)) throw refusal(400, "invalid_query", "state is active, archived or all.");
  // v53 (J15 section 4.4, R10): the system list of a club's workspace or of a
  // team workspace of the club leaves out what the club hides (exclude, the
  // default), shows it too (include) or only it (only). It is bound into the
  // cursor like the other filters (h), and a cursor without it reads as
  // exclude, so every earlier cursor keeps its meaning.
  const hiddenApplies = scope === "system" && ctx.owner?.scope === "club";
  if (q.hidden !== undefined && (!hiddenApplies || !["exclude", "include", "only"].includes(q.hidden))) {
    throw refusal(400, "invalid_query", "hidden is exclude, include or only, on the system list of a club.");
  }
  const hidden = hiddenApplies ? (q.hidden ?? "exclude") : null;
  const hiddenKey = hidden && hidden !== "exclude" ? hidden : null;
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
    const keys = ["i", "k", "o", "sc", "st", "t", "v", ...(filterKey ? ["f"] : []), ...(hiddenKey ? ["h"] : [])].sort().join(",");
    const p = decodeCursor(q.cursor, keys);
    if (p.k !== "variables" || p.o !== ownerKeyOf(ctx) || p.sc !== scope || p.st !== state || (filterKey && p.f !== filterKey)
        || (hiddenKey && p.h !== hiddenKey)) throw invalidCursor();
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
    let hiddenSql = "";
    if (hidden && hidden !== "include") {
      params.push(ctx.owner.clubId);
      hiddenSql = `and ${hidden === "only" ? "" : "not "}exists (select 1 from training_load.metric_definition_club_hides h
                     where h.club_id = $${params.length}::uuid and h.metric_definition_id = d.id and h.shown_at is null)`;
    }
    params.push(after ? after.at : null, after ? after.id : null);
    const atIdx = params.length - 1;
    params.push(VARIABLE_PAGE_SIZES.variables + 1);
    const rows = (await client.query(
      `select ${VARIABLE_COLUMNS}, to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as cursor_at
         from ${VARIABLE_FROM}
        where ${owner}
          and ($${stateIdx}::text is null or d.state = $${stateIdx}::text)
          ${classified}
          ${hiddenSql}
          and ($${atIdx}::timestamp is null or (d.created_at, d.id) > (($${atIdx}::timestamp at time zone 'UTC'), $${atIdx + 1}::uuid))
        order by d.created_at, d.id
        limit $${params.length}`,
      params,
    )).rows;
    const page = rows.slice(0, VARIABLE_PAGE_SIZES.variables);
    const last = page[page.length - 1];
    const nextCursor = rows.length > VARIABLE_PAGE_SIZES.variables
      ? encodeCursor({ v: 1, k: "variables", o: ownerKeyOf(ctx), sc: scope, st: state, t: last.cursor_at, i: last.id,
        ...(filterKey ? { f: filterKey } : {}), ...(hiddenKey ? { h: hiddenKey } : {}) })
      : null;
    const clubs = await clubFactsForRows(client, ctx, page);
    return { variables: page.map((row) => viewOf(row, ctx, clubs)), nextCursor };
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
      const club = (await clubFactsForRows(client, ctx, [row])).get(String(row.id)) ?? null;
      return { variable: { ...reducedOut(row, ctx, club), classification: await variableClassification(client, ctx, id) }, nextCursor: null };
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
    const club = (await clubFactsForRows(client, ctx, [row])).get(String(row.id)) ?? null;
    const variable = variableOut(row, ctx, club);
    if (versions.some((v) => v.cut)) variable.truncated = true;
    const classification = await variableClassification(client, ctx, id);
    return { variable: { ...variable, versions: versions.map((v) => v.value), classification }, nextCursor };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const VARIABLE_REQUESTS = Object.freeze({
  find: `select operation, request_hash, metric_definition_id, metric_definition_version_id, owner_scope, owner_club_id, operation_id
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
async function insertRequest(client, { ctx, requestKey, requestHash, operation, definitionId, versionId, operationId = null }) {
  await client.query(
    `insert into training_load.metric_variable_requests
       (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_definition_version_id, operation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [requestKey, ctx.userId, operation, requestHash, ctx.owner.scope, ctx.owner.clubId, ctx.basis, definitionId, versionId, operationId],
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

// Test seams (never set by the application). writeHold runs inside a write's
// transaction at the named point. A point named after the operation comes after
// every lock and check, right before the first row is written; the others are
// variable_copy_before_locks (after the copy's plain read of the active set,
// before its locks), variable_copy_before_mappings and
// variable_copy_before_request (between the copy's writes), and
// variable_hide_before_hide_lock / variable_show_before_hide_lock (after the
// rights, before the hide lock). classifyObserver sees every raw error the
// copy's and the hide's classifiers receive, before they map it.
let writeHold = null;
export function setVariableWriteHoldForTests(fn) { writeHold = fn ?? null; }
let classifyObserver = null;
export function setVariableClassifyObserverForTests(fn) { classifyObserver = fn ?? null; }

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
// named only for the team_coach basis. `known` is the active workspace when
// the caller already resolved it (7h-V's activity read), so it is not
// resolved twice; null means "no workspace" (resolveMappingAdminWith's
// convention).
export async function resolveVariableEditor(req, known = undefined) {
  if (!req?.user?.id || !req.authz) return null;
  const workspace = known === undefined ? (await resolveActiveWorkspace(req.user.id, req.authz)).workspace : known;
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
// Exactly that text, nothing more (the Rukovodilac's D5 correction for v53): a
// 42501 with any other text - a missing right, another guard's wording, even
// the same words behind another prefix - is never "try again"; it stays
// ACTOR_REFUSALS' identical 404 or a sanitized 500, so a real refusal can never
// become an endless retry.
export const basisChangedError = (error) =>
  !(error instanceof SourceMetricMappingError) && error?.code === "42501" && error.message === BASIS_CHANGED;
function classifyChangeError(error) {
  if (basisChangedError(error)) {
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

// An icon of a request: a key of the library, or null for none.
function iconKeyField(value, field) {
  if (value === null) return null;
  if (!isIconKey(value)) throw invalidBody(`${field} is a key of the icon library, or null.`);
  return value;
}

// POST /variables/:id/icon - the icon of an active variable (I1, J3b.11): a
// library key, or null to remove it; expectedIconKey is the icon the caller
// saw (a read's `icon`: a key or null). Every basis of a rename may do it, a
// coach a pinned variable's too: an icon is display only and does not change
// what the variable means. v45 records it as the change kind `icon`.
export async function changeVariableIcon({ ctx, variableId, body }) {
  const id = variableIdOrNotFound(variableId);
  plainObject(body, ["requestKey", "expectedIconKey", "iconKey"], ["requestKey", "expectedIconKey", "iconKey"]);
  const requestKey = uuidField(body.requestKey);
  const expectedIconKey = iconKeyField(body.expectedIconKey, "expectedIconKey");
  const iconKey = iconKeyField(body.iconKey, "iconKey");
  const requestHash = hashOf({ contract: CONTRACT, operation: "variable_icon", variableId: id, body: { expectedIconKey, iconKey } });
  const stored = iconKey === null ? null : `${ICON_PREFIX}${iconKey}`;
  return runChange({
    ctx, variableId: id, operation: "variable_icon", requestKey, requestHash, reason: null,
    check: (row) => {
      if (row.state !== "active") throw refusal(409, "variable_not_active", TEXT.variable_not_active);
      if (iconOut(row.icon_url) !== expectedIconKey) throw refusal(409, "variable_changed", TEXT.variable_changed, { current: reducedOut(row, ctx) });
      if ((row.icon_url ?? null) === stored) throw refusal(409, "icon_unchanged", TEXT.icon_unchanged);
    },
    texts: () => [],
    update: () => ({ sql: "icon_url = $2", values: [stored] }),
  });
}

// ---------------------------------------------------------------------------
// v53 (phase 7i, J15 sections 2-5, C132-C140): a club copies a system
// variable, or hides it and shows it again. Club X's admin, or a platform
// admin, in club X's own workspace only: every other workspace - the platform
// workspace, a team workspace - and everyone else is the identical 404.
// ---------------------------------------------------------------------------
function clubWriteOnly(ctx) {
  adminOnly(ctx);
  if (ctx.owner?.scope !== "club" || typeof ctx.owner.clubId !== "string") throw NOT_FOUND();
}

// The database guards of v53 derive the basis again. Only the request
// record's exact "basis is not the acting user's own" (a stronger role granted
// after the rights were checked) is the request to repeat (try_again, as an R2
// change), and only the copy writes a request record: the copy and hide guards'
// own 42501 texts also cover a missing right, so they stay a sanitized 500 (D5
// as corrected by the Rukovodilac). The hide and the show write no request
// record, so no 42501 of theirs is ever try_again.

// POST /variables/:id/copy (J15 sections 2.2 and 4.1): one transaction writes
// the club variable (version 1 equal to the system variable's current version
// in every semantic fact, the same levels), its copy record, one club draft per
// active system mapping version with its link, the T8 rows of that operation
// and the variable_copy request record last. Locks in D's order (J15 section
// 5): the conversions, T2a and T2b, the system T3s, the system T4s, the
// system definition and its current version, its levels, then the rights;
// the state refusals only after the right.
const COPY_KEYS = ["requestKey", "expectedSourceVersionId", "key", "label", "shortLabel", "description", "iconKey"];
export async function copyVariable({ ctx, variableId, body }) {
  clubWriteOnly(ctx);
  const id = variableIdOrNotFound(variableId);
  plainObject(body, COPY_KEYS, ["requestKey", "expectedSourceVersionId"]);
  const requestKey = uuidField(body.requestKey);
  const expectedSourceVersionId = uuidField(body.expectedSourceVersionId);
  // The editable fields, by createVariable's rules; absent takes the system
  // variable's value (J15 2.2), null clears an optional one.
  if (body.label !== undefined && body.label !== null && !boundedText(body.label, TEXT_LIMITS.label)) {
    throw invalidBody("label is one line of 1-80 visible characters without surrounding spaces.");
  }
  if (body.shortLabel !== undefined) optionalText(body, "shortLabel", TEXT_LIMITS.shortLabel);
  if (body.description !== undefined) optionalText(body, "description", TEXT_LIMITS.description);
  if (body.key !== undefined && body.key !== null && (typeof body.key !== "string" || !KEY_RULE.test(body.key))) {
    throw invalidBody("key is lower-case letters, digits and underscores, a letter first, at most 63 characters.");
  }
  if (body.iconKey !== undefined && body.iconKey !== null && !isIconKey(body.iconKey)) throw invalidBody("iconKey is a key of the icon library.");
  // J15 section 4: the hash carries the workspace's club; an absent field is
  // left out (undefined), a null one stays null, so the two never hash alike.
  const requestHash = hashOf({
    contract: CONTRACT, operation: "variable_copy", clubId: ctx.owner.clubId, variableId: id,
    body: { expectedSourceVersionId, key: body.key, label: body.label, shortLabel: body.shortLabel, description: body.description, iconKey: body.iconKey },
  });
  const progress = { sourceMetricId: null };
  const classify = (error) => {
    if (classifyObserver) classifyObserver(error);
    if (error instanceof SourceMetricMappingError) return error;
    if (basisChangedError(error)) return refusal(409, "try_again", MESSAGES.try_again);
    if (error?.code === "23505" && error.constraint === "metric_definition_copies_one_per_club") return refusal(409, "already_copied", TEXT.already_copied);
    const variable = classifyVariableError(error);
    if (variable) return variable;
    const mapped = classifyDatabaseError(error);
    if (mapped && progress.sourceMetricId && mapped.status === 409 && mapped.code !== "try_again") {
      return refusal(409, "copy_mapping_not_reproducible", TEXT.copy_mapping_not_reproducible,
        { current: { sourceMetricId: progress.sourceMetricId, code: mapped.code } });
    }
    return mapped;
  };
  return runWrite({
    ctx, where: "variable_copy", requestKey, requestHash, action: "variable_copy",
    requests: VARIABLE_REQUESTS, classify, idsOf: variableIdsOf,
    reread: async (executor, record) => {
      const variable = await writableVariable(executor, ctx, record);
      if (!variable || !record.operation_id) return null;
      return { variable, copiedMappings: await copiedMappingsOf(executor, record.operation_id) };
    },
    body: async (client, operationId) => {
      // The plain read, before any lock: readable here (the system scope or
      // the club's own) - else the identical 404; the club's own variable is
      // no source (copy_source_not_system).
      const params = [id];
      const readable = readableSql(ctx, params);
      const plain = (await client.query(`select d.id, d.owner_scope from training_load.metric_definitions d where d.id = $1 and ${readable}`, params)).rows[0];
      if (!plain) throw NOT_FOUND();
      // The club's own variable is no source: a state, so answered only after
      // the right (J15 section 4), without the registry locks it does not need.
      if (plain.owner_scope !== "system") {
        if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
        throw refusal(409, "copy_source_not_system", TEXT.copy_source_not_system);
      }
      // The locks, in D's order.
      const versions = await readSystemMappingsForCopy(client, id);
      if (writeHold) await writeHold(client, "variable_copy_before_locks");
      const lockedMappings = await lockSystemMappingsForCopy(client, id, versions);
      const def = (await client.query(
        `select state, current_version_id from training_load.metric_definitions where id = $1 for share`, [id],
      )).rows[0];
      await client.query(`select 1 from training_load.metric_definition_versions where id = $1 for share`, [def.current_version_id]);
      await client.query(
        `select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 order by scope_level for share`, [id],
      );
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      // The states, answered only now (after the right), in J15 4.1's order.
      const row = (await client.query(`select ${VARIABLE_COLUMNS} from ${VARIABLE_FROM} where d.id = $1`, [id])).rows[0];
      if (def.state !== "active") throw refusal(409, "source_not_active", TEXT.source_not_active);
      if (def.current_version_id !== expectedSourceVersionId) {
        throw refusal(409, "source_version_changed", TEXT.source_version_changed, { current: { versionId: row.version_id, versionNumber: row.version_number } });
      }
      const existing = (await client.query(
        `select club_definition_id from training_load.metric_definition_copies where club_id = $1 and system_definition_id = $2`, [ctx.owner.clubId, id],
      )).rows[0];
      if (existing) throw refusal(409, "already_copied", TEXT.already_copied, { current: { variableId: existing.club_definition_id } });
      // The defaults (J15 2.2, as built): the system values when they pass
      // createVariable's rules; a key or a name that does not is asked for.
      const key = body.key ?? (KEY_RULE.test(row.key ?? "") ? row.key : null);
      if (key === null) throw refusal(400, "key_required", TEXT.key_required);
      const label = body.label ?? (boundedText(row.label, TEXT_LIMITS.label) ? row.label : null);
      if (label === null) throw refusal(400, "label_required", TEXT.label_required);
      const shortLabel = body.shortLabel !== undefined ? body.shortLabel : (boundedText(row.short_label, TEXT_LIMITS.shortLabel) ? row.short_label : null);
      const description = body.description !== undefined ? body.description : (boundedText(row.description, TEXT_LIMITS.description) ? row.description : null);
      const iconKey = body.iconKey !== undefined ? body.iconKey : iconOut(row.icon_url);
      const taken = await client.query(
        `select 1 from training_load.metric_definitions where owner_scope = 'club' and owner_club_id = $1 and key = $2`, [ctx.owner.clubId, key],
      );
      if (taken.rowCount > 0) throw refusal(409, "key_taken", TEXT.key_taken);
      const unsupported = copyUnsupportedReason(row);
      if (unsupported) throw refusal(409, "copy_source_unsupported", TEXT.copy_source_unsupported, { current: { reason: unsupported } });
      const notReproducible = await copiedMappingRefusal(client, versions, lockedMappings);
      if (notReproducible) throw refusal(409, "copy_mapping_not_reproducible", TEXT.copy_mapping_not_reproducible, { current: notReproducible });
      if (versions.length > MAX_COPIED_MAPPINGS) throw refusal(409, "copy_too_large", TEXT.copy_too_large, { limit: MAX_COPIED_MAPPINGS });
      if (writeHold) await writeHold(client, "variable_copy");
      // The writes (J15 section 5): the definition, version 1, the levels, the
      // copy row, the club T3s and T4s, the links, the T8 rows, the request row.
      const definitionId = (await client.query(
        `insert into training_load.metric_definitions (key, label, short_label, description, icon_url, owner_scope, owner_club_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, 'club', $6, $7) returning id`,
        [key, label, shortLabel, description, iconKey === null ? null : `${ICON_PREFIX}${iconKey}`, ctx.owner.clubId, ctx.userId],
      )).rows[0].id;
      const versionId = (await client.query(
        `insert into training_load.metric_definition_versions
           (metric_definition_id, version_number, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method, created_by_user_id)
         select $1, 1, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method, $2
           from training_load.metric_definition_versions where id = $3
         returning id`,
        [definitionId, ctx.userId, def.current_version_id],
      )).rows[0].id;
      await client.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, definitionId]);
      await client.query(
        `insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level)
         select $1, scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = $2 order by scope_level`,
        [definitionId, id],
      );
      await client.query(
        `insert into training_load.metric_definition_copies
           (club_definition_id, club_id, system_definition_id, system_version_id, copied_by_user_id, basis, operation_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [definitionId, ctx.owner.clubId, id, def.current_version_id, ctx.userId, ctx.basis, operationId],
      );
      if (writeHold) await writeHold(client, "variable_copy_before_mappings");
      await insertCopiedMappings(client, ctx, { clubDefinitionId: definitionId, clubVersionId: versionId, versions, operationId, progress });
      if (writeHold) await writeHold(client, "variable_copy_before_request");
      await insertRequest(client, { ctx, requestKey, requestHash, operation: "variable_copy", definitionId, versionId, operationId });
      return {
        operation: "variable_copy", metric_definition_id: definitionId, metric_definition_version_id: versionId,
        owner_scope: "club", owner_club_id: ctx.owner.clubId, operation_id: operationId,
      };
    },
  }).catch(async (error) => {
    // A copy that lost the race to another admin's: its first insert meets the
    // other copy's uncommitted rows at a unique index - the club key (key_taken)
    // before the copy row's (already_copied). When the other copy is now there,
    // the answer is already_copied naming it, as createMapping names its
    // mapping; a key_taken of the pre-check (no copy exists) stays key_taken.
    // The right is checked again (FOR SHARE) before the other copy is named: a
    // caller whose right went meanwhile gets the identical 404 (security review
    // of round 2).
    if (error instanceof SourceMetricMappingError && ["already_copied", "key_taken"].includes(error.code) && !error.details) {
      let rightLost = false;
      const current = await boundedRead(async (client) => {
        if (!(await rightsStillHold(client, ctx))) { rightLost = true; return null; }
        return (await client.query(
          `select club_definition_id from training_load.metric_definition_copies where club_id = $1 and system_definition_id = $2`, [ctx.owner.clubId, id],
        )).rows[0];
      }, { locks: true }).catch(() => undefined);
      if (rightLost) throw NOT_FOUND();
      if (current) throw refusal(409, "already_copied", TEXT.already_copied, { current: { variableId: current.club_definition_id } });
    }
    throw error;
  });
}

// POST /variables/:id/hide and /show (J15 sections 2.3 and 4.2): a desired
// state of club X for a system variable. The hide row is the request record
// of the hide, its show facts the request record of the show; one request key
// serves one act of one user (the guards' cross-act check). A no-op (the state
// already in force) writes nothing and is no request record: its key may act
// later. Locks: the definition FOR KEY SHARE, the rights, then the hide lock
// (after the rights, J15 section 5), then the plain reads and the write.
const HIDE_REQUESTS = Object.freeze({
  find: `select 'variable_hide' as operation, hide_request_hash as request_hash, metric_definition_id, club_id::text as club_id
           from training_load.metric_definition_club_hides where hidden_by_user_id = $1 and hide_request_key = $2
         union all
         select 'variable_show' as operation, show_request_hash as request_hash, metric_definition_id, club_id::text as club_id
           from training_load.metric_definition_club_hides where shown_by_user_id = $1 and show_request_key = $2`,
  exists: `select 1 from training_load.metric_definition_club_hides
            where (hidden_by_user_id = $1 and hide_request_key = $2) or (shown_by_user_id = $1 and show_request_key = $2)`,
});
const HIDE_GUARD_REFUSALS = new Map([
  ["metric_definition_club_hides: the variable is switched on for the club's teams", "variable_in_use"],
  ["metric_definition_club_hides: only a system variable is hidden", "hide_not_system"],
]);

// The answer of a hide or a show and of its replay: the state in force now in
// the workspace's club (J15 4.2: a repeat names the state this admin asked
// for, whoever changed it in between).
async function hideStateOf(executor, ctx, record) {
  if (String(record.club_id) !== ctx.owner.clubId) return null;
  const variableId = String(record.metric_definition_id);
  const system = await executor.query(`select 1 from training_load.metric_definitions where id = $1 and owner_scope = 'system'`, [variableId]);
  if (system.rowCount === 0) return null;
  const open = (await executor.query(
    `select hidden_at from training_load.metric_definition_club_hides where club_id = $1 and metric_definition_id = $2 and shown_at is null`,
    [ctx.owner.clubId, variableId],
  )).rows[0];
  return { variableId, hidden: Boolean(open), hiddenAt: open?.hidden_at ?? null, ...(record.noop ? { idempotent: true } : {}) };
}

async function setHidden({ ctx, variableId, body, hide }) {
  clubWriteOnly(ctx);
  const id = variableIdOrNotFound(variableId);
  plainObject(body, ["requestKey"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const operation = hide ? "variable_hide" : "variable_show";
  const requestHash = hashOf({ contract: CONTRACT, operation, clubId: ctx.owner.clubId, variableId: id, body: {} });
  const classify = (error) => {
    if (classifyObserver) classifyObserver(error);
    if (error instanceof SourceMetricMappingError) return error;
    if (error?.code === "23514" && !error.constraint && HIDE_GUARD_REFUSALS.has(error.message)) {
      const code = HIDE_GUARD_REFUSALS.get(error.message);
      return refusal(409, code, TEXT[code]);
    }
    if (error?.code === "23514" && !error.constraint && error.message === "metric_definition_club_hides: a request key serves one act only") {
      return refusal(409, "request_key_reused", "This requestKey was already used for a different request; use a new key.");
    }
    if (error?.code === "23505" && String(error.constraint ?? "").startsWith("metric_definition_club_hides_")) {
      return refusal(409, "try_again", MESSAGES.try_again);
    }
    return classifyVariableError(error);
  };
  return runWrite({
    ctx, where: operation, requestKey, requestHash, action: operation,
    requests: HIDE_REQUESTS, classify, idsOf: () => ({ variableId: id }),
    reread: (executor, record) => hideStateOf(executor, ctx, record),
    body: async (client) => {
      const params = [id];
      const readable = readableSql(ctx, params);
      const plain = (await client.query(`select d.id, d.owner_scope from training_load.metric_definitions d where d.id = $1 and ${readable}`, params)).rows[0];
      if (!plain) throw NOT_FOUND();
      // The club's own variable cannot be hidden: a state, answered only after the right.
      if (plain.owner_scope !== "system") {
        if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
        throw refusal(409, "hide_not_system", TEXT.hide_not_system);
      }
      // The definition FOR KEY SHARE (the guards read it plainly after the
      // hide lock: no row lock follows the hide lock), then the rights.
      await client.query(`select 1 from training_load.metric_definitions where id = $1 for key share`, [id]);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (writeHold) await writeHold(client, `${operation}_before_hide_lock`);
      await lockHides(client, [{ clubId: ctx.owner.clubId, definitionId: id }]);
      if (writeHold) await writeHold(client, operation);
      // The state, read after the hide lock (READ COMMITTED: a hide or a start
      // that committed before the lock was granted is seen).
      const open = (await client.query(
        `select id from training_load.metric_definition_club_hides where club_id = $1 and metric_definition_id = $2 and shown_at is null`,
        [ctx.owner.clubId, id],
      )).rows[0];
      const record = { metric_definition_id: id, club_id: ctx.owner.clubId };
      if (hide) {
        if (open) return { ...record, noop: true };
        const inUse = (await client.query(
          `select count(*)::int as n
             from training_load.source_metric_mapping_activations a
             join training_load.source_metric_mappings m on m.id = a.mapping_id
            where a.metric_definition_id = $1 and a.ended_at is null and m.owner_key = 'system'
              and training_load.source_metric_binding_club(a.source_team_binding_id) = $2`,
          [id, ctx.owner.clubId],
        )).rows[0].n;
        if (inUse > 0) throw refusal(409, "variable_in_use", TEXT.variable_in_use, { current: { activationCount: inUse } });
        await client.query(
          `insert into training_load.metric_definition_club_hides
             (club_id, metric_definition_id, hidden_by_user_id, hidden_basis, hide_request_key, hide_request_hash)
           values ($1, $2, $3, $4, $5, $6)`,
          [ctx.owner.clubId, id, ctx.userId, ctx.basis, requestKey, requestHash],
        );
        return record;
      }
      if (!open) return { ...record, noop: true };
      await client.query(
        `update training_load.metric_definition_club_hides
            set shown_by_user_id = $2, shown_basis = $3, show_request_key = $4, show_request_hash = $5, shown_at = now()
          where id = $1`,
        [open.id, ctx.userId, ctx.basis, requestKey, requestHash],
      );
      return record;
    },
  });
}
export const hideVariable = ({ ctx, variableId, body }) => setHidden({ ctx, variableId, body, hide: true });
export const showVariable = ({ ctx, variableId, body }) => setHidden({ ctx, variableId, body, hide: false });
