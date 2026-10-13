// Source metric mapping administration (M2): the read API of the source
// metric catalog, the canonical targets and the unit conversions, and the
// first writes of the mapping contract - a mapping identity (T3), a draft
// mapping version (T4) and its submission (draft -> needs_review).
// Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, section C,
// D2-D10, E, G and "M2 HTTP contract" (approved by the owner on 2026-10-13).
// Schema: migration v34 (M1). Nothing here activates a version, writes a T5
// activation or a T6 fact, confirms a unit or a meaning, retires or disables
// anything, or talks to a source.
//
// Ownership comes from the caller's active workspace only (owner decision
// 2026-10-13): the platform workspace is the system scope (a platform admin
// only); a club workspace is that club's scope (its active club admin, or a
// platform admin there for support). A body never names an owner.
//
// Lock order of a write (discovery document, section D; v34 header), held
// to the COMMIT: the per-user advisory lock (one write of this user at a
// time, bounded) -> unit_conversions rows (FOR SHARE, ascending id) -> T2a
// -> T2b -> T3 -> T4 -> metric_definitions (FOR SHARE) -> the acting user's
// role, user and club rows (FOR SHARE). Every statement and lock wait is
// bounded; 55P03 / 40P01 / 57014 answer try_again; the COMMIT's answer is
// awaited a bounded time and, if lost, verified on a second connection by
// the request key (verified_after_commit_error or outcome_unknown).
//
// Responses carry no acting user's id, no SQL, no trigger text and no free
// text beyond the M1-bounded label, evidence references and conversion note.
import crypto from "node:crypto";
import { pool } from "./db.js";
import { isPlatformAdministrator, holdsClubAdminRole } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";

export class SourceMetricMappingError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "SourceMetricMappingError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
const refusal = (status, code, message, details) => new SourceMetricMappingError(status, code, message, details);
const NOT_FOUND = () => refusal(404, "notFound", "Not found.");

// The list caps of the approved contract: a longer result is refused, never
// cut, so a client never takes a partial list for the whole one.
export const LIST_CAPS = Object.freeze({ fields: 100, revisionsPerField: 20, targets: 200, conversions: 100, mappings: 100, versionsPerMapping: 50 });
export const ROW_LOCK_TIMEOUT_MS = 2_000;
export const USER_LOCK_WAIT_MS = 5_000;
export const STATEMENT_TIMEOUT_MS = 10_000;
export const COMMIT_ANSWER_TIMEOUT_MS = 15_000;
export const UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS = 5_000;
export const CONVERSION_NOTE_MAX_LENGTH = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_SYSTEM = /^[a-z][a-z0-9_]{1,30}$/;
const API_FAMILIES = new Set(["api", "rest_v1"]);
// A parameter value (owner decision 2026-10-13): a JSON string in plain
// decimal notation, at most 12 integer and 9 decimal digits, no exponent.
export const DECIMAL_INPUT = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/;
// A numeric as PostgreSQL prints it (::text of a finite numeric).
const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;
// C41 / C53: the characters a bounded free-text column refuses (NUL too:
// a PostgreSQL text cannot hold it).
const TEXT_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;

// ---------------------------------------------------------------------------
// Test seams (never set by the application).
// ---------------------------------------------------------------------------
let commitFault = null;
let uncertainCheckFault = null;
let writeHold = null;
let rightsHold = null;
let commitTimeoutMs = COMMIT_ANSWER_TIMEOUT_MS;
let uncertainCheckTimeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS;
let userLockWaitMs = USER_LOCK_WAIT_MS;
export function setMappingCommitForTests({ fault = null, timeoutMs = COMMIT_ANSWER_TIMEOUT_MS, checkFault = null, checkTimeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS } = {}) {
  commitFault = fault; commitTimeoutMs = timeoutMs; uncertainCheckFault = checkFault; uncertainCheckTimeoutMs = checkTimeoutMs;
}
// Runs inside a write's transaction after every lock is taken and every
// check passed, right before the first row is written.
export function setMappingWriteHoldForTests(fn) { writeHold = fn ?? null; }
// Runs inside a write's transaction right before the caller's right is
// checked again under FOR SHARE (after every registry lock).
export function setMappingRightsHoldForTests(fn) { rightsHold = fn ?? null; }
export function setMappingUserLockWaitForTests(ms) { userLockWaitMs = ms ?? USER_LOCK_WAIT_MS; }

function guardClient(client) {
  const onClientError = () => {};
  client.on("error", onClientError);
  return (destroy = false) => {
    client.removeListener("error", onClientError);
    client.release(destroy ? true : undefined);
  };
}
function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Access: one context per request, from the active workspace.
// ---------------------------------------------------------------------------
export async function resolveMappingAdmin(req) {
  if (!req?.user?.id || !req.authz) return null;
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (!workspace) return null;
  const userId = String(req.user.id);
  const scopeId = workspace.scopeId ? String(workspace.scopeId) : null;
  let ctx = null;
  if (isPlatformAdministrator(req.authz)) {
    if (workspace.type === "platform") return { userId, basis: "platform_admin", owner: { scope: "system", clubId: null } };
    if (workspace.type === "club" && scopeId) ctx = { userId, basis: "platform_admin", owner: { scope: "club", clubId: scopeId } };
  } else if (workspace.type === "club" && scopeId && holdsClubAdminRole(req.authz, scopeId)) {
    ctx = { userId, basis: "club_admin", owner: { scope: "club", clubId: scopeId } };
  }
  if (!ctx || !UUID.test(scopeId)) return null;
  // A club scope needs an active club (fail-closed, whatever the workspace
  // list admitted); writes check it again under FOR SHARE.
  const club = await pool.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true)`, [scopeId]);
  return club.rowCount === 1 ? ctx : null;
}
const ownerKeyOf = (ctx) => (ctx.owner.scope === "system" ? "system" : ctx.owner.clubId);
// Readable: the system scope always; a club's own scope in its workspace.
const readableOwnerKeys = (ctx) => (ctx.owner.scope === "system" ? ["system"] : ["system", ctx.owner.clubId]);

// The caller's right and, for a club scope, the club, under FOR SHARE (after
// every registry row of the lock order).
async function rightsStillHold(client, ctx) {
  if (rightsHold) await rightsHold(client);
  const right = ctx.basis === "platform_admin"
    ? await client.query(
      `select 1 from public.user_global_roles g join public.users u on u.id = g.user_id
        where g.user_id = $1 and g.role = 'platform_admin' and g.is_active = true and u.is_active = true for share of g, u`,
      [ctx.userId],
    )
    : await client.query(
      `select 1 from public.user_club_roles r join public.users u on u.id = r.user_id
        where r.user_id = $1 and r.club_id = $2 and r.role = 'club_admin' and r.is_active = true and u.is_active = true for share of r, u`,
      [ctx.userId, ctx.owner.clubId],
    );
  if (right.rowCount === 0) return false;
  if (ctx.owner.scope === "club") {
    const club = await client.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true) for share`, [ctx.owner.clubId]);
    if (club.rowCount === 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Exact decimals (BigInt; never a binary floating-point number).
// ---------------------------------------------------------------------------
function dec(text) {
  if (typeof text !== "string" || !NUMERIC_TEXT.test(text)) throw new Error("not a decimal");
  const negative = text.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? text.slice(1) : text).split(".");
  const n = BigInt(intPart + fracPart);
  return { n: negative ? -n : n, s: fracPart.length };
}
const pow10 = (k) => 10n ** BigInt(k);
function align(a, b) {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
}
const decMul = (a, b) => ({ n: a.n * b.n, s: a.s + b.s });
const decAdd = (a, b) => { const [x, y, s] = align(a, b); return { n: x + y, s }; };
const decCmp = (a, b) => { const [x, y] = align(a, b); return x === y ? 0 : x < y ? -1 : 1; };
const decIsOne = (a) => decCmp(a, { n: 1n, s: 0 }) === 0;
// The one canonical text of a decimal: no trailing fractional zeros, no
// trailing point, no negative zero - the same text trim_scale() prints.
export function canonicalDecimal(text) {
  const { n, s } = dec(text);
  if (n === 0n) return "0";
  const negative = n < 0n;
  let digits = (negative ? -n : n).toString();
  let scale = s;
  while (scale > 0 && digits.endsWith("0")) { digits = digits.slice(0, -1); scale -= 1; }
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  }
  return negative ? `-${digits}` : digits;
}

// D5 normal form of a factor pair (scale, divisor), both > 0 with one of them
// 1 (the database CHECK): (f, 1) whenever f is a terminating decimal, else
// (1, d) - so (1, d) is the normal form only when 1/d does not terminate,
// that is when d's digits carry a prime factor other than 2 and 5.
export function isNormalFormPair(scaleText, divisorText) {
  const scale = dec(scaleText);
  const divisor = dec(divisorText);
  if (scale.n <= 0n || divisor.n <= 0n) return false;
  if (decIsOne(divisor)) return true;
  if (!decIsOne(scale)) return false;
  let p = divisor.n;
  while (p % 2n === 0n) p /= 2n;
  while (p % 5n === 0n) p /= 5n;
  return p !== 1n;
}

// Section E, "Parameter fingerprint", version 1: the same text the database
// computes; the database value stays the authority (a test proves they agree).
export function parameterFingerprint(kind, params) {
  if (kind === "none") return "";
  const keys = Object.keys(params).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const text = kind + keys.map((key) => `|${key}=${params[key] === null ? "null" : String(params[key])}`).join("");
  return `v1:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------
function plainObject(body, allowed, required) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw refusal(400, "invalid_body", "A JSON object body is required.");
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw refusal(400, "invalid_body", "The body carries a field this request does not take.");
  for (const key of required) if (!(key in body)) throw refusal(400, "invalid_body", "The body misses a required field.");
  return body;
}
function uuidField(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw refusal(400, "invalid_body", "An id field must be a UUID.");
  return value.toLowerCase();
}
function boundedText(value, max) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith(" ") || value.endsWith(" ")) return false;
  if ([...value].length > max) return false;
  return !TEXT_FORBIDDEN.test(value);
}
function decimalInput(value, { nonNegative = false } = {}) {
  if (typeof value !== "string" || !DECIMAL_INPUT.test(value)) throw refusal(400, "invalid_parameters", "A parameter value is a decimal string (at most 12 integer and 9 decimal digits, no exponent).");
  const canonical = canonicalDecimal(value);
  if (nonNegative && canonical.startsWith("-")) throw refusal(400, "invalid_parameters", "durationSeconds is never negative.");
  return canonical;
}
const hashOf = (value) => crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Database refusals: only the allowlisted ones become a 4xx.
// ---------------------------------------------------------------------------
const TRIGGER_REFUSALS = new Map([
  ["source_metric_mappings: the canonical definition must be active", [409, "target_not_active"]],
  ["source_metric_mappings: a system mapping targets a system definition", [409, "target_scope_mismatch"]],
  ["source_metric_mappings: a club mapping targets a definition of the same club", [409, "target_scope_mismatch"]],
  ["source_metric_mapping_versions: the source revision does not belong to the mapping's source metric", [409, "revision_not_usable"]],
  ["source_metric_mapping_versions: a mapping version needs a draft or active source revision with a proven unit", [409, "revision_not_usable"]],
  ["source_metric_mapping_versions: the source revision is retired", [409, "revision_not_usable"]],
  ["source_metric_mapping_versions: a level outside the revision's levels", [409, "level_not_allowed"]],
  ["source_metric_mapping_versions: the session level is not a scope of the canonical definition", [409, "level_not_allowed"]],
  ["source_metric_mapping_versions: the drill level is not a scope of the canonical definition", [409, "level_not_allowed"]],
  ["source_metric_mapping_versions: the canonical version is not numeric", [409, "canonical_not_numeric"]],
  ["source_metric_mapping_versions: canonical_unit_missing", [409, "canonical_unit_missing"]],
  ["source_metric_mapping_versions: canonical_unit_not_a_token", [409, "canonical_unit_not_a_token"]],
  ["source_metric_mapping_versions: the conversion must equal the active unit conversion of its unit pair", [409, "conversion_unavailable"]],
  ["source_metric_mapping_versions: the bound conversion must equal the active unit conversion of its unit pair", [409, "bound_conversion_unavailable"]],
  ["source_metric_mapping_versions: the canonical condition description has no supported shape", [409, "condition_description_unsupported"]],
  ["source_metric_mapping_versions: the source and canonical bounds are not equivalent", [409, "parameters_not_equivalent"]],
  ["source_metric_mapping_versions: the source and canonical thresholds are not equivalent", [409, "parameters_not_equivalent"]],
]);
const MESSAGES = {
  try_again: "Another change is running. Nothing was changed; try again in a moment.",
  target_not_active: "The canonical definition is not active.",
  target_scope_mismatch: "This canonical definition is not of the owner scope of this workspace.",
  revision_not_usable: "The source revision is not a draft or active revision of this mapping's source metric.",
  level_not_allowed: "A chosen level is not supported by the source revision or the canonical definition.",
  canonical_not_numeric: "The canonical definition's current version is not numeric.",
  canonical_unit_missing: "The canonical definition's current version has no unit.",
  canonical_unit_not_a_token: "The canonical definition's unit is not a unit token.",
  conversion_unavailable: "No active unit conversion exists for this unit pair.",
  bound_conversion_unavailable: "No active unit conversion exists for the bound unit pair.",
  condition_description_unsupported: "The canonical condition description has no supported shape for this parameter kind.",
  parameters_not_equivalent: "The source parameters are not equivalent to the canonical parameters.",
};
export function classifyDatabaseError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01" || code === "57014") return refusal(409, "try_again", MESSAGES.try_again);
  if (code === "42501") return NOT_FOUND();
  if (code === "23505") {
    if (error.constraint === "source_metric_mappings_pair_key") return refusal(409, "mapping_exists", "A mapping of this source metric to this canonical definition already exists.");
    if (error.constraint === "source_metric_mapping_versions_number_key" || error.constraint === "source_metric_audit_one_request_per_key") return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "23514" && !error.constraint && TRIGGER_REFUSALS.has(error.message)) {
    const [status, refusalCode] = TRIGGER_REFUSALS.get(error.message);
    return refusal(status, refusalCode, MESSAGES[refusalCode]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function tooLarge(limit) {
  return refusal(409, "result_too_large", "The result is larger than this route returns at once.", { limit });
}

export async function listFields({ ctx, query }) {
  void ctx;
  for (const key of Object.keys(query ?? {})) if (!["sourceSystem", "apiFamily"].includes(key)) throw refusal(400, "invalid_query", "The query carries a parameter this route does not take.");
  const sourceSystem = query?.sourceSystem ?? null;
  const apiFamily = query?.apiFamily ?? null;
  if (sourceSystem !== null && (typeof sourceSystem !== "string" || !SOURCE_SYSTEM.test(sourceSystem))) throw refusal(400, "invalid_query", "sourceSystem is not a source system key.");
  if (apiFamily !== null && (typeof apiFamily !== "string" || !API_FAMILIES.has(apiFamily))) throw refusal(400, "invalid_query", "apiFamily is api or rest_v1.");
  const fields = (await pool.query(
    `select id, source_system, api_family, source_metric_key, source_label, state
       from training_load.source_metric_definitions
      where ($1::text is null or source_system = $1) and ($2::text is null or api_family = $2)
      order by source_system collate "C", api_family collate "C", source_metric_key collate "C"
      limit $3`,
    [sourceSystem, apiFamily, LIST_CAPS.fields + 1],
  )).rows;
  if (fields.length > LIST_CAPS.fields) throw tooLarge(LIST_CAPS.fields);
  const revisions = fields.length === 0 ? [] : (await pool.query(
    `select id, source_metric_definition_id, revision_number, state, value_shape, parameter_kind, supports_session, supports_drill,
            expected_source_unit, source_unit, expected_source_bound_unit, source_bound_unit, bound_operator,
            evidence_status, evidence_ref, unit_evidence_ref, meaning_evidence_ref, unit_verified_at, meaning_verified_at
       from training_load.source_metric_definition_versions
      where source_metric_definition_id = any($1::uuid[])
      order by source_metric_definition_id, revision_number desc`,
    [fields.map((f) => f.id)],
  )).rows;
  const byField = new Map(fields.map((f) => [f.id, []]));
  for (const r of revisions) byField.get(r.source_metric_definition_id).push(r);
  return fields.map((f) => {
    const list = byField.get(f.id);
    if (list.length > LIST_CAPS.revisionsPerField) throw tooLarge(LIST_CAPS.revisionsPerField);
    return {
      id: f.id, sourceSystem: f.source_system, apiFamily: f.api_family, key: f.source_metric_key, label: f.source_label, state: f.state,
      revisions: list.map((r) => ({
        id: r.id, revisionNumber: r.revision_number, state: r.state, valueShape: r.value_shape, parameterKind: r.parameter_kind,
        supportsSession: r.supports_session, supportsDrill: r.supports_drill, expectedSourceUnit: r.expected_source_unit, sourceUnit: r.source_unit,
        expectedSourceBoundUnit: r.expected_source_bound_unit, sourceBoundUnit: r.source_bound_unit, boundOperator: r.bound_operator,
        evidenceStatus: r.evidence_status, evidenceRef: r.evidence_ref, unitEvidenceRef: r.unit_evidence_ref, meaningEvidenceRef: r.meaning_evidence_ref,
        unitVerifiedAt: r.unit_verified_at, meaningVerifiedAt: r.meaning_verified_at,
      })),
    };
  });
}

// The parts of a canonical version the API reads, never the raw
// condition_description: numbers as their exact numeric text.
const CANONICAL_VERSION_COLUMNS = `v.id as version_id, v.version_number, v.value_type, v.unit,
  (v.unit is not null and char_length(v.unit) between 1 and 30) as unit_present,
  coalesce(training_load.source_metric_unit_token_ok(v.unit), false) as unit_is_token,
  jsonb_typeof(v.condition_description) as cd_type,
  case when jsonb_typeof(v.condition_description) = 'object'
       then (select array_agg(k order by k collate "C") from jsonb_object_keys(v.condition_description) as k) end as cd_keys,
  case when jsonb_typeof(v.condition_description) = 'object' then jsonb_typeof(v.condition_description -> 'operator') end as cd_operator_type,
  case when jsonb_typeof(v.condition_description) = 'object' then v.condition_description ->> 'operator' end as cd_operator,
  case when jsonb_typeof(v.condition_description) = 'object' then jsonb_typeof(v.condition_description -> 'unit') end as cd_unit_type,
  case when jsonb_typeof(v.condition_description) = 'object' then v.condition_description ->> 'unit' end as cd_unit,
  case when jsonb_typeof(v.condition_description) = 'object' then coalesce(training_load.source_metric_unit_token_ok(v.condition_description ->> 'unit'), false) end as cd_unit_is_token,
  case when jsonb_typeof(v.condition_description -> 'min') = 'number' then (v.condition_description ->> 'min')::numeric::text end as cd_min,
  case when jsonb_typeof(v.condition_description -> 'max') = 'number' then (v.condition_description ->> 'max')::numeric::text end as cd_max,
  case when jsonb_typeof(v.condition_description -> 'value') = 'number' then (v.condition_description ->> 'value')::numeric::text end as cd_value,
  case when jsonb_typeof(v.condition_description -> 'duration_seconds') = 'number' then (v.condition_description ->> 'duration_seconds')::numeric::text end as cd_duration`;

// The normalized canonical parameters of a condition_description (section E;
// the same shapes source_metric_check_parameters accepts), or null.
function canonicalParametersOf(row) {
  if (row.cd_type !== "object" || !Array.isArray(row.cd_keys) || row.cd_operator_type !== "string" || row.cd_unit_type !== "string" || row.cd_unit_is_token !== true) return null;
  const keys = row.cd_keys.join(",");
  if (row.cd_operator === "between" && keys === "max,min,operator,unit" && row.cd_min !== null && row.cd_max !== null) {
    const lower = canonicalDecimal(row.cd_min);
    const upper = canonicalDecimal(row.cd_max);
    if (decCmp(dec(lower), dec(upper)) >= 0) return null;
    return { kind: "zone_bounds", params: { operator: "between", lower, upper, unit: row.cd_unit } };
  }
  if ([">=", ">", "<=", "<"].includes(row.cd_operator) && keys === "operator,unit,value" && row.cd_value !== null) {
    return { kind: "zone_bounds", params: { operator: row.cd_operator, lower: canonicalDecimal(row.cd_value), upper: null, unit: row.cd_unit } };
  }
  if ([">=", ">", "<=", "<"].includes(row.cd_operator) && keys === "duration_seconds,operator,unit,value" && row.cd_value !== null && row.cd_duration !== null) {
    return { kind: "event_threshold", params: { operator: row.cd_operator, value: canonicalDecimal(row.cd_value), duration_seconds: canonicalDecimal(row.cd_duration), unit: row.cd_unit } };
  }
  return null;
}
function notReadyCodeOf(row) {
  if (row.value_type !== "numeric") return "canonical_not_numeric";
  if (!row.unit_present) return "canonical_unit_missing";
  if (!row.unit_is_token) return "canonical_unit_not_a_token";
  return null;
}

export async function listTargets({ ctx }) {
  const rows = (await pool.query(
    `select d.id, d.owner_scope, ${CANONICAL_VERSION_COLUMNS},
            (select array_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as scopes
       from training_load.metric_definitions d
       join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
      where d.state = 'active'
        and (($1::text = 'system' and d.owner_scope = 'system') or ($1::text = 'club' and d.owner_scope = 'club' and d.owner_club_id = $2::uuid))
      order by d.id
      limit $3`,
    [ctx.owner.scope, ctx.owner.clubId, LIST_CAPS.targets + 1],
  )).rows;
  if (rows.length > LIST_CAPS.targets) throw tooLarge(LIST_CAPS.targets);
  return rows.map((row) => {
    const notReadyCode = notReadyCodeOf(row);
    const canonical = canonicalParametersOf(row);
    return {
      id: row.id, ownerScope: row.owner_scope,
      currentVersion: { id: row.version_id, versionNumber: row.version_number, unit: row.unit_is_token ? row.unit : null, canonicalParameters: canonical ? canonical.params : null },
      scopes: row.scopes ?? [], versionReady: notReadyCode === null, notReadyCode,
    };
  });
}

export async function listConversions({ ctx }) {
  void ctx;
  const rows = (await pool.query(
    `select id, from_unit, to_unit, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as scale_divisor,
            trim_scale("offset")::text as "offset", evidence_ref
       from training_load.unit_conversions where state = 'active'
      order by from_unit collate "C", to_unit collate "C"
      limit $1`,
    [LIST_CAPS.conversions + 1],
  )).rows;
  if (rows.length > LIST_CAPS.conversions) throw tooLarge(LIST_CAPS.conversions);
  return rows.map((r) => ({ id: r.id, fromUnit: r.from_unit, toUnit: r.to_unit, scale: r.scale, scaleDivisor: r.scale_divisor, offset: r.offset, evidenceRef: r.evidence_ref }));
}

// A mapping version as the API returns it: numbers as exact decimal text,
// parameter numbers as text too; no acting user, no disable reason.
const PARAMS_AS_TEXT = (column) => `(select coalesce(jsonb_object_agg(e.key, case jsonb_typeof(e.value) when 'number' then to_jsonb(trim_scale((e.value #>> '{}')::numeric)::text) else e.value end), '{}'::jsonb) from jsonb_each(${column}) e)`;
const VERSION_COLUMNS = `v.id, v.mapping_id, v.version_number, v.status, v.source_metric_version_id, v.metric_definition_version_id,
  v.source_unit, v.target_unit, trim_scale(v.scale)::text as scale, trim_scale(v.scale_divisor)::text as scale_divisor, trim_scale(v."offset")::text as "offset",
  v.parameter_kind, ${PARAMS_AS_TEXT("v.source_parameters")} as source_parameters, ${PARAMS_AS_TEXT("v.canonical_parameters")} as canonical_parameters,
  trim_scale(v.parameter_scale)::text as parameter_scale, trim_scale(v.parameter_scale_divisor)::text as parameter_scale_divisor,
  trim_scale(v.parameter_offset)::text as parameter_offset, v.parameter_fingerprint, v.applies_to_session, v.applies_to_drill,
  v.conversion_note, v.created_at, v.submitted_at`;
function publicVersion(v) {
  return {
    id: v.id, mappingId: v.mapping_id, versionNumber: v.version_number, status: v.status, sourceRevisionId: v.source_metric_version_id,
    metricDefinitionVersionId: v.metric_definition_version_id, sourceUnit: v.source_unit, targetUnit: v.target_unit,
    scale: v.scale, scaleDivisor: v.scale_divisor, offset: v.offset, parameterKind: v.parameter_kind,
    sourceParameters: v.source_parameters, canonicalParameters: v.canonical_parameters,
    parameterScale: v.parameter_scale, parameterScaleDivisor: v.parameter_scale_divisor, parameterOffset: v.parameter_offset,
    parameterFingerprint: v.parameter_fingerprint, appliesToSession: v.applies_to_session, appliesToDrill: v.applies_to_drill,
    conversionNote: v.conversion_note, createdAt: v.created_at, submittedAt: v.submitted_at,
  };
}
const MAPPING_COLUMNS = `m.id, m.owner_scope, m.owner_key, m.source_metric_definition_id, d.source_metric_key, d.api_family, m.metric_definition_id, m.created_at`;
const publicMappingBase = (m) => ({ id: m.id, ownerScope: m.owner_scope, sourceMetric: { id: m.source_metric_definition_id, key: m.source_metric_key, apiFamily: m.api_family }, metricDefinitionId: m.metric_definition_id, createdAt: m.created_at });

export async function listMappings({ ctx }) {
  const mappings = (await pool.query(
    `select ${MAPPING_COLUMNS}
       from training_load.source_metric_mappings m
       join training_load.source_metric_definitions d on d.id = m.source_metric_definition_id
      where m.owner_key = any($1::text[])
      order by (m.owner_scope <> 'system'), m.created_at, m.id
      limit $2`,
    [readableOwnerKeys(ctx), LIST_CAPS.mappings + 1],
  )).rows;
  if (mappings.length > LIST_CAPS.mappings) throw tooLarge(LIST_CAPS.mappings);
  if (mappings.length === 0) return [];
  const ids = mappings.map((m) => m.id);
  const latest = new Map((await pool.query(
    `select distinct on (mapping_id) mapping_id, id, version_number, status, created_at, submitted_at
       from training_load.source_metric_mapping_versions where mapping_id = any($1::uuid[])
      order by mapping_id, version_number desc`,
    [ids],
  )).rows.map((r) => [r.mapping_id, r]));
  const counts = new Map((await pool.query(
    `select mapping_id,
            count(*) filter (where status = 'draft')::int as draft, count(*) filter (where status = 'needs_review')::int as needs_review,
            count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'disabled')::int as disabled,
            (array_agg(id) filter (where status = 'active'))[1] as active_version_id
       from training_load.source_metric_mapping_versions where mapping_id = any($1::uuid[]) group by mapping_id`,
    [ids],
  )).rows.map((r) => [r.mapping_id, r]));
  return mappings.map((m) => {
    const l = latest.get(m.id);
    const c = counts.get(m.id);
    return {
      ...publicMappingBase(m),
      latestVersion: l ? { id: l.id, versionNumber: l.version_number, status: l.status, createdAt: l.created_at, submittedAt: l.submitted_at } : null,
      activeVersionId: c?.active_version_id ?? null,
      versionCounts: { draft: c?.draft ?? 0, needs_review: c?.needs_review ?? 0, active: c?.active ?? 0, disabled: c?.disabled ?? 0 },
    };
  });
}

async function readMapping(executor, ctx, mappingId) {
  if (typeof mappingId !== "string" || !UUID.test(mappingId)) return null;
  const m = (await executor.query(
    `select ${MAPPING_COLUMNS}
       from training_load.source_metric_mappings m
       join training_load.source_metric_definitions d on d.id = m.source_metric_definition_id
      where m.id = $1 and m.owner_key = any($2::text[])`,
    [mappingId, readableOwnerKeys(ctx)],
  )).rows[0];
  if (!m) return null;
  const versions = (await executor.query(
    `select ${VERSION_COLUMNS} from training_load.source_metric_mapping_versions v
      where v.mapping_id = $1 order by v.version_number desc limit $2`,
    [m.id, LIST_CAPS.versionsPerMapping + 1],
  )).rows;
  if (versions.length > LIST_CAPS.versionsPerMapping) throw tooLarge(LIST_CAPS.versionsPerMapping);
  return { ...publicMappingBase(m), versions: versions.map(publicVersion) };
}
export async function getMapping({ ctx, mappingId }) {
  return readMapping(pool, ctx, mappingId);
}
async function readVersion(executor, ctx, mappingId, versionId) {
  const v = (await executor.query(
    `select ${VERSION_COLUMNS} from training_load.source_metric_mapping_versions v
       join training_load.source_metric_mappings m on m.id = v.mapping_id
      where v.id = $1 and v.mapping_id = $2 and m.owner_key = any($3::text[])`,
    [versionId, mappingId, readableOwnerKeys(ctx)],
  )).rows[0];
  return v ? publicVersion(v) : null;
}

// ---------------------------------------------------------------------------
// Writes: one bounded transaction each, the request key's audit row as the
// request record (D10), the replay answered from the current state.
// ---------------------------------------------------------------------------
async function runWrite({ ctx, where, requestKey, requestHash, action, body: operation, reread }) {
  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  const finish = async (destroy = false) => {
    if (released) return;
    released = true;
    let dead = destroy;
    if (!destroy) await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
    release(dead);
  };
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${STATEMENT_TIMEOUT_MS * 3}ms'`);
    await client.query(`set local lock_timeout = '${userLockWaitMs}ms'`);
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 34))`, [`source-metric-mapping:${ctx.userId}`]);
    await client.query(`set local lock_timeout = '${ROW_LOCK_TIMEOUT_MS}ms'`);
    // The request record of this user and key, before any registry lock.
    const earlier = (await client.query(
      `select action, request_hash, mapping_id, mapping_version_id
         from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
      [ctx.userId, requestKey],
    )).rows[0];
    if (earlier) {
      if (earlier.action !== action || earlier.request_hash !== requestHash) throw refusal(409, "request_key_reused", "This requestKey was already used for a different request; use a new key.");
      // A replay is a read of the current state, after the right is checked again.
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const current = await reread(client, earlier);
      await finish();
      if (!current) throw NOT_FOUND();
      return { ...current, replayed: true };
    }
    const operationId = crypto.randomUUID();
    const written = await operation(client, operationId);
    // The bounded COMMIT (the F2 discipline).
    let commitError = null;
    try {
      const commit = commitFault ? commitFault(client) : client.query("commit");
      commit.catch(() => {});
      await withinBound(commit, commitTimeoutMs);
      released = true;
      release();
    } catch (error) {
      commitError = error;
      released = true;
      release(true);
    }
    if (commitError) {
      console.error(`[source-metric-mappings] the COMMIT of ${where} was not confirmed (${commitError?.code ?? ""}); checking the request record`);
      let found = false;
      try { found = await requestIsCommitted(ctx.userId, requestKey); } catch { found = false; }
      if (!found) throw refusal(503, "outcome_unknown", "The database did not confirm this request, and it could not be verified yet. Repeat it with the same requestKey.", { requestKey });
      return { ...(await rereadAfterCommit(ctx, written, reread)), replayed: false, commitConfirmation: "verified_after_commit_error" };
    }
    return { ...(await rereadAfterCommit(ctx, written, reread)), replayed: false };
  } catch (error) {
    await finish();
    // An allowlisted refusal becomes its stable code; anything else goes up
    // unchanged and the router answers it as a sanitized 500 internal_error.
    throw classifyDatabaseError(error) ?? error;
  } finally {
    if (!released) await finish(true);
  }
}
async function rereadAfterCommit(ctx, written, reread) {
  try {
    const current = await reread(pool, written);
    if (current) return current;
  } catch { /* the answer below */ }
  return { readError: true, mappingId: written.mapping_id ?? null, ...(written.mapping_version_id ? { versionId: written.mapping_version_id } : {}) };
}
async function requestIsCommitted(userId, requestKey) {
  const deadline = Date.now() + uncertainCheckTimeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const connecting = pool.connect();
  let client;
  try {
    client = await withinBound(connecting, left());
  } catch (error) {
    connecting.then((late) => late.release(true), () => {});
    throw error;
  }
  const release = guardClient(client);
  let broken = false;
  try {
    if (uncertainCheckFault) {
      const fault = Promise.resolve().then(() => uncertainCheckFault(client));
      fault.catch(() => {});
      await withinBound(fault, left());
    }
    const answer = client.query({ text: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`, values: [userId, requestKey], query_timeout: left() });
    answer.catch(() => {});
    return (await withinBound(answer, left())).rowCount === 1;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    release(broken);
  }
}

async function insertRequestRecord(client, { action, mappingId, mappingVersionId = null, fromStatus = null, toStatus = null, ctx, operationId, requestKey, requestHash }) {
  await client.query(
    `insert into training_load.source_metric_audit
       (action, mapping_id, mapping_version_id, from_status, to_status, performed_by_user_id, basis, operation_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [action, mappingId, mappingVersionId, fromStatus, toStatus, ctx.userId, ctx.basis, operationId, requestKey, requestHash],
  );
}

// POST /mappings - a mapping identity (T3) in the workspace's owner scope.
export async function createMapping({ ctx, body }) {
  plainObject(body, ["requestKey", "sourceMetricId", "metricDefinitionId"], ["requestKey", "sourceMetricId", "metricDefinitionId"]);
  const requestKey = uuidField(body.requestKey);
  const sourceMetricId = uuidField(body.sourceMetricId);
  const metricDefinitionId = uuidField(body.metricDefinitionId);
  const requestHash = hashOf({ route: "mapping_create", sourceMetricId, metricDefinitionId });
  return runWrite({
    ctx, where: "mapping_create", requestKey, requestHash, action: "mapping_create",
    reread: async (executor, record) => {
      const mapping = await readMapping(executor, ctx, record.mapping_id);
      return mapping && writableBy(ctx, mapping) ? { mapping } : null;
    },
    body: async (client, operationId) => {
      // T2a, then the canonical definition, both FOR SHARE (lock order).
      const field = (await client.query(
        `select id, state from training_load.source_metric_definitions where id = $1 for share`, [sourceMetricId],
      )).rows[0];
      if (!field) throw NOT_FOUND();
      const md = (await client.query(
        `select id, owner_scope, owner_club_id, state from training_load.metric_definitions where id = $1 for share`, [metricDefinitionId],
      )).rows[0];
      if (!md) throw NOT_FOUND();
      if (md.owner_scope === "system") {
        if (ctx.owner.scope !== "system") throw refusal(409, "target_scope_mismatch", MESSAGES.target_scope_mismatch);
      } else if (!(md.owner_scope === "club" && ctx.owner.scope === "club" && String(md.owner_club_id) === ctx.owner.clubId)) {
        throw NOT_FOUND();
      }
      if (field.state !== "active") throw refusal(409, "source_metric_retired", "The source metric is retired.");
      if (md.state !== "active") throw refusal(409, "target_not_active", MESSAGES.target_not_active);
      const existing = (await client.query(
        `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2`,
        [sourceMetricId, metricDefinitionId],
      )).rows[0];
      if (existing) throw refusal(409, "mapping_exists", "A mapping of this source metric to this canonical definition already exists.", { current: { mappingId: existing.id } });
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (writeHold) await writeHold(client, "mapping_create");
      const mapping = (await client.query(
        `insert into training_load.source_metric_mappings (source_metric_definition_id, source_system, api_family, metric_definition_id, owner_scope, owner_club_id, created_by_user_id)
         select d.id, d.source_system, d.api_family, $2, $3, $4, $5 from training_load.source_metric_definitions d where d.id = $1
         returning id`,
        [sourceMetricId, metricDefinitionId, ctx.owner.scope, ctx.owner.clubId, ctx.userId],
      )).rows[0];
      await insertRequestRecord(client, { action: "mapping_create", mappingId: mapping.id, ctx, operationId, requestKey, requestHash });
      return { mapping_id: mapping.id };
    },
  }).catch(async (error) => {
    // A pair created meanwhile by another request: name the existing mapping
    // (same owner, so visible), read after the rollback.
    if (error instanceof SourceMetricMappingError && error.code === "mapping_exists" && !error.details) {
      const existing = (await pool.query(
        `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2 and owner_key = $3`,
        [sourceMetricId, metricDefinitionId, ownerKeyOf(ctx)],
      ).catch(() => ({ rows: [] }))).rows[0];
      if (existing) error.details = { current: { mappingId: existing.id } };
    }
    throw error;
  });
}
// Writable in this workspace: the mapping's owner is the workspace's owner.
// readMapping already admits a club mapping only in that club's workspace, so
// for a mapping it returned an equal owner scope means the same owner.
const writableBy = (ctx, mapping) => mapping.ownerScope === ctx.owner.scope;

// The parameters of a version, checked against the revision's kind and
// operator; values canonical (owner decision 2026-10-13).
function sourceParametersFor(kind, operator, boundUnit, input) {
  if (kind === "none") {
    if (input !== undefined) throw refusal(400, "invalid_parameters", "This source revision takes no parameters.");
    return {};
  }
  if (input === undefined || input === null || typeof input !== "object" || Array.isArray(input)) throw refusal(400, "invalid_parameters", "This source revision needs its parameters.");
  const keys = Object.keys(input).sort().join(",");
  if (kind === "zone_bounds") {
    if (keys !== "lower,upper") throw refusal(400, "invalid_parameters", "Zone parameters are exactly lower and upper.");
    const lower = decimalInput(input.lower);
    const upper = input.upper === null ? null : decimalInput(input.upper);
    if ((operator === "between") !== (upper !== null)) throw refusal(400, "invalid_parameters", "upper is set exactly for a between zone.");
    if (upper !== null && decCmp(dec(lower), dec(upper)) >= 0) throw refusal(400, "invalid_parameters", "lower is below upper.");
    return { operator, lower, upper, unit: boundUnit };
  }
  if (kind === "event_threshold") {
    if (keys !== "durationSeconds,thresholdValue") throw refusal(400, "invalid_parameters", "Threshold parameters are exactly thresholdValue and durationSeconds.");
    return { operator, threshold_value: decimalInput(input.thresholdValue), duration_seconds: decimalInput(input.durationSeconds, { nonNegative: true }), unit: boundUnit };
  }
  throw refusal(400, "invalid_parameters", "Unknown parameter kind.");
}
// The request's canonical body for the hash: numerically equal inputs give
// the same hash, so they replay the same request.
function canonicalParameterInput(input) {
  if (input === undefined) return null;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw refusal(400, "invalid_parameters", "sourceParameters is an object.");
  const out = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === null) out[key] = null;
    else if (typeof value === "string" && DECIMAL_INPUT.test(value)) out[key] = canonicalDecimal(value);
    else throw refusal(400, "invalid_parameters", "A parameter value is a decimal string (at most 12 integer and 9 decimal digits, no exponent).");
  }
  return out;
}

// A parameter object whose number fields arrive as exact decimal text: the
// texts become JSON numbers through numeric, never through a binary float.
function NUMERIC_PARAMS(param) {
  return `(select coalesce(jsonb_object_agg(e.key, case when e.key in ('operator', 'unit') or jsonb_typeof(e.value) = 'null' then e.value else to_jsonb((e.value #>> '{}')::numeric) end), '{}'::jsonb) from jsonb_each(${param}::jsonb) e)`;
}

async function activeConversion(client, fromUnit, toUnit, lock) {
  const rows = (await client.query(
    `select id, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as scale_divisor, trim_scale("offset")::text as "offset"
       from training_load.unit_conversions where from_unit = $1 and to_unit = $2 and state = 'active'
      order by id ${lock ? "for share" : ""}`,
    [fromUnit, toUnit],
  )).rows;
  return rows.length === 1 ? rows[0] : null;
}

// POST /mappings/:mappingId/versions - a draft mapping version (T4).
export async function createVersion({ ctx, mappingId, body }) {
  if (typeof mappingId !== "string" || !UUID.test(mappingId)) throw NOT_FOUND();
  plainObject(body, ["requestKey", "sourceRevisionId", "appliesToSession", "appliesToDrill", "conversionNote", "sourceParameters"], ["requestKey", "sourceRevisionId", "appliesToSession", "appliesToDrill"]);
  const requestKey = uuidField(body.requestKey);
  const sourceRevisionId = uuidField(body.sourceRevisionId);
  if (typeof body.appliesToSession !== "boolean" || typeof body.appliesToDrill !== "boolean") throw refusal(400, "invalid_body", "appliesToSession and appliesToDrill are booleans.");
  if (!body.appliesToSession && !body.appliesToDrill) throw refusal(400, "invalid_body", "At least one of appliesToSession and appliesToDrill is true.");
  const conversionNote = body.conversionNote === undefined ? null : body.conversionNote;
  if (conversionNote !== null && !boundedText(conversionNote, CONVERSION_NOTE_MAX_LENGTH)) throw refusal(400, "invalid_body", "conversionNote is one line of 1-500 visible characters without surrounding spaces.");
  const parameterInput = canonicalParameterInput(body.sourceParameters);
  const id = mappingId.toLowerCase();
  const requestHash = hashOf({ route: "mapping_version_create", mappingId: id, sourceRevisionId, appliesToSession: body.appliesToSession, appliesToDrill: body.appliesToDrill, conversionNote, sourceParameters: parameterInput });
  return runWrite({
    ctx, where: "mapping_version_create", requestKey, requestHash, action: "mapping_version_create",
    reread: async (executor, record) => {
      const mapping = await readMapping(executor, ctx, record.mapping_id);
      if (!mapping || !writableBy(ctx, mapping)) return null;
      const version = await readVersion(executor, ctx, record.mapping_id, record.mapping_version_id);
      return version ? { version } : null;
    },
    body: async (client, operationId) => {
      // Plain reads first, to learn the units; then the locks in order.
      const mapping = (await client.query(
        `select id, owner_scope, owner_key, source_metric_definition_id, metric_definition_id from training_load.source_metric_mappings where id = $1`, [id],
      )).rows[0];
      if (!mapping || mapping.owner_key !== ownerKeyOf(ctx)) throw NOT_FOUND();
      const revisionSql = `select id, source_metric_definition_id, state, parameter_kind, supports_session, supports_drill, source_unit, source_bound_unit, bound_operator
                             from training_load.source_metric_definition_versions where id = $1`;
      const revision = (await client.query(revisionSql, [sourceRevisionId])).rows[0];
      if (!revision || revision.source_metric_definition_id !== mapping.source_metric_definition_id || !["draft", "active"].includes(revision.state)) {
        throw refusal(409, "revision_not_usable", MESSAGES.revision_not_usable);
      }
      if (revision.source_unit === null) throw refusal(409, "unit_not_proven", "The source revision's unit is not proven.");
      if (revision.parameter_kind !== "none" && (revision.source_bound_unit === null || revision.bound_operator === null)) {
        throw refusal(409, "parameters_not_proven", "The source revision's bound unit or operator is not proven.");
      }
      if ((body.appliesToSession && !revision.supports_session) || (body.appliesToDrill && !revision.supports_drill)) {
        throw refusal(409, "level_not_allowed", MESSAGES.level_not_allowed);
      }
      const source = sourceParametersFor(revision.parameter_kind, revision.bound_operator, revision.source_bound_unit, body.sourceParameters);
      const canonicalSql = `select d.state, d.current_version_id, ${CANONICAL_VERSION_COLUMNS},
                                   (select array_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as scopes
                              from training_load.metric_definitions d
                              left join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
                             where d.id = $1`;
      const target = (await client.query(canonicalSql, [mapping.metric_definition_id])).rows[0];
      if (!target || target.state !== "active" || !target.version_id) throw refusal(409, "target_not_active", MESSAGES.target_not_active);
      const notReady = notReadyCodeOf(target);
      if (notReady) throw refusal(409, notReady, MESSAGES[notReady]);
      const scopes = target.scopes ?? [];
      if ((body.appliesToSession && !scopes.includes("session")) || (body.appliesToDrill && !scopes.includes("component"))) {
        throw refusal(409, "level_not_allowed", MESSAGES.level_not_allowed);
      }
      // The value conversion: the identity for equal units, else exactly the
      // one active row of the pair, in the D5 normal form.
      const sourceUnit = revision.source_unit;
      const targetUnit = target.unit;
      let factors = { scale: "1", scale_divisor: "1", offset: "0" };
      let valueConversion = null;
      if (sourceUnit !== targetUnit) {
        valueConversion = await activeConversion(client, sourceUnit, targetUnit, false);
        if (!valueConversion) throw refusal(409, "conversion_unavailable", MESSAGES.conversion_unavailable);
        if (!isNormalFormPair(valueConversion.scale, valueConversion.scale_divisor)) throw refusal(409, "conversion_not_normal", "The active unit conversion of this unit pair is not in the normal form.");
        factors = { scale: valueConversion.scale, scale_divisor: valueConversion.scale_divisor, offset: valueConversion.offset };
        if (conversionNote === null) throw refusal(400, "conversion_note_required", "The units differ, so conversionNote is required.");
      }
      // The canonical parameters and the bound conversion (section E).
      let canonical = {};
      let parameterFactors = { scale: "1", scale_divisor: "1", offset: "0" };
      let boundConversion = null;
      if (revision.parameter_kind !== "none") {
        const derived = canonicalParametersOf(target);
        if (!derived || derived.kind !== revision.parameter_kind) throw refusal(409, "condition_description_unsupported", MESSAGES.condition_description_unsupported);
        canonical = derived.params;
        if (canonical.operator !== revision.bound_operator) throw refusal(409, "parameters_not_equivalent", MESSAGES.parameters_not_equivalent);
        if (revision.source_bound_unit !== canonical.unit) {
          boundConversion = await activeConversion(client, revision.source_bound_unit, canonical.unit, false);
          if (!boundConversion) throw refusal(409, "bound_conversion_unavailable", MESSAGES.bound_conversion_unavailable);
          if (!isNormalFormPair(boundConversion.scale, boundConversion.scale_divisor)) throw refusal(409, "conversion_not_normal", "The active unit conversion of the bound unit pair is not in the normal form.");
          parameterFactors = { scale: boundConversion.scale, scale_divisor: boundConversion.scale_divisor, offset: boundConversion.offset };
        }
        const ps = dec(parameterFactors.scale);
        const pd = dec(parameterFactors.scale_divisor);
        const po = dec(parameterFactors.offset);
        const equivalent = (canonicalText, sourceText) => decCmp(decMul(dec(canonicalText), pd), decAdd(decMul(dec(sourceText), ps), decMul(po, pd))) === 0;
        const ok = revision.parameter_kind === "zone_bounds"
          ? equivalent(canonical.lower, source.lower) && (canonical.upper === null) === (source.upper === null) && (canonical.upper === null || equivalent(canonical.upper, source.upper))
          : equivalent(canonical.value, source.threshold_value) && decCmp(dec(canonical.duration_seconds), dec(source.duration_seconds)) === 0;
        if (!ok) throw refusal(409, "parameters_not_equivalent", MESSAGES.parameters_not_equivalent);
      }
      // The locks, in the order of section D, and the facts again under them.
      const conversionIds = [...new Set([valueConversion?.id, boundConversion?.id].filter(Boolean))].sort();
      if (conversionIds.length > 0) {
        const held = new Set((await client.query(
          `select id from training_load.unit_conversions where id = any($1::uuid[]) and state = 'active' order by id for share`, [conversionIds],
        )).rows.map((r) => r.id));
        if (valueConversion && !held.has(valueConversion.id)) throw refusal(409, "conversion_unavailable", MESSAGES.conversion_unavailable);
        if (boundConversion && !held.has(boundConversion.id)) throw refusal(409, "bound_conversion_unavailable", MESSAGES.bound_conversion_unavailable);
      }
      const lockedRevision = (await client.query(`${revisionSql} for share`, [sourceRevisionId])).rows[0];
      if (!lockedRevision || !["draft", "active"].includes(lockedRevision.state)) throw refusal(409, "revision_not_usable", MESSAGES.revision_not_usable);
      await client.query(`select 1 from training_load.source_metric_mappings where id = $1 for no key update`, [id]);
      const lockedTarget = (await client.query(
        `select state, current_version_id from training_load.metric_definitions where id = $1 for share`, [mapping.metric_definition_id],
      )).rows[0];
      if (!lockedTarget || lockedTarget.state !== "active" || lockedTarget.current_version_id !== target.version_id) {
        throw refusal(409, "try_again", MESSAGES.try_again);
      }
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (writeHold) await writeHold(client, "mapping_version_create");
      const expectedFingerprint = parameterFingerprint(revision.parameter_kind, source);
      const sourceJson = revision.parameter_kind === "none" ? {} : source;
      const inserted = (await client.query(
        `insert into training_load.source_metric_mapping_versions
           (mapping_id, source_metric_definition_id, metric_definition_id, source_metric_version_id, version_number, metric_definition_version_id,
            conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, conversion_note, parameter_kind,
            source_parameters, canonical_parameters, parameter_scale, parameter_scale_divisor, parameter_offset,
            applies_to_session, applies_to_drill, created_by_user_id)
         select $1, $2, $3, $4,
                (select coalesce(max(version_number), 0) + 1 from training_load.source_metric_mapping_versions where mapping_id = $1),
                $5, 'numeric_linear', $6::numeric, $7::numeric, $8::numeric, $9, $10, $11, $12,
                ${NUMERIC_PARAMS("$13")}, ${NUMERIC_PARAMS("$14")},
                $15::numeric, $16::numeric, $17::numeric, $18, $19, $20
         returning id, parameter_fingerprint`,
        [id, mapping.source_metric_definition_id, mapping.metric_definition_id, sourceRevisionId, target.version_id,
          factors.scale, factors.scale_divisor, factors.offset, sourceUnit, targetUnit, conversionNote, revision.parameter_kind,
          JSON.stringify(sourceJson), JSON.stringify(canonical), parameterFactors.scale, parameterFactors.scale_divisor, parameterFactors.offset,
          body.appliesToSession, body.appliesToDrill, ctx.userId],
      )).rows[0];
      if (inserted.parameter_fingerprint !== expectedFingerprint) throw new Error("fingerprint_disagrees");
      await insertRequestRecord(client, { action: "mapping_version_create", mappingId: id, mappingVersionId: inserted.id, toStatus: "draft", ctx, operationId, requestKey, requestHash });
      return { mapping_id: id, mapping_version_id: inserted.id };
    },
  });
}
// POST /mappings/:mappingId/versions/:versionId/submit - draft -> needs_review.
export async function submitVersion({ ctx, mappingId, versionId, body }) {
  if (typeof mappingId !== "string" || !UUID.test(mappingId) || typeof versionId !== "string" || !UUID.test(versionId)) throw NOT_FOUND();
  plainObject(body, ["requestKey"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const mId = mappingId.toLowerCase();
  const vId = versionId.toLowerCase();
  const requestHash = hashOf({ route: "mapping_status", mappingId: mId, versionId: vId, toStatus: "needs_review" });
  return runWrite({
    ctx, where: "mapping_status", requestKey, requestHash, action: "mapping_status",
    reread: async (executor, record) => {
      const mapping = await readMapping(executor, ctx, record.mapping_id);
      if (!mapping || !writableBy(ctx, mapping)) return null;
      const version = await readVersion(executor, ctx, record.mapping_id, record.mapping_version_id);
      return version ? { version } : null;
    },
    body: async (client, operationId) => {
      const plain = (await client.query(
        `select v.id, v.source_metric_version_id, m.owner_key from training_load.source_metric_mapping_versions v
           join training_load.source_metric_mappings m on m.id = v.mapping_id
          where v.id = $1 and v.mapping_id = $2`,
        [vId, mId],
      )).rows[0];
      if (!plain || plain.owner_key !== ownerKeyOf(ctx)) throw NOT_FOUND();
      // T2b -> T3 -> T4 (the lock order the transition trigger repeats).
      const revision = (await client.query(
        `select state from training_load.source_metric_definition_versions where id = $1 for share`, [plain.source_metric_version_id],
      )).rows[0];
      await client.query(`select 1 from training_load.source_metric_mappings where id = $1 for share`, [mId]);
      const version = (await client.query(
        `select status from training_load.source_metric_mapping_versions where id = $1 for update`, [vId],
      )).rows[0];
      if (version.status !== "draft") throw refusal(409, "version_not_draft", "Only a draft version is submitted.", { current: { status: version.status } });
      if (!revision || !["draft", "active"].includes(revision.state)) throw refusal(409, "revision_not_usable", MESSAGES.revision_not_usable);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (writeHold) await writeHold(client, "mapping_status");
      await client.query(
        `update training_load.source_metric_mapping_versions
            set status = 'needs_review', submitted_by_user_id = $2, submitted_at = clock_timestamp(), submitted_basis = $3
          where id = $1`,
        [vId, ctx.userId, ctx.basis],
      );
      await insertRequestRecord(client, { action: "mapping_status", mappingId: mId, mappingVersionId: vId, fromStatus: "draft", toStatus: "needs_review", ctx, operationId, requestKey, requestHash });
      return { mapping_id: mId, mapping_version_id: vId };
    },
  });
}
