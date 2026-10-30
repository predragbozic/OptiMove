// Source metric mapping administration (M2): the read API of the source
// metric catalog, the canonical targets and the unit conversions, and the
// writes of the mapping contract - a mapping identity (T3), a draft mapping
// version (T4), its submission (draft -> needs_review) and, from phase 7b,
// its activation (needs_review -> active; with the replacement of the
// mapping's active version in the same transaction, D6) and its disable.
// Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, section C,
// D2-D10, E, G and "M2 HTTP contract" (approved by the owner on 2026-10-13);
// phase 7b: docs/ai/phase7b-mapping-transitions-contract.md (J8, C104).
// Schema: migrations v34 (M1), v35 and v43. Nothing here writes a T5
// activation or a T6 fact, confirms a unit or a meaning, retires a source
// revision, or talks to a source.
//
// Ownership comes from the caller's active workspace only (owner decision
// 2026-10-13): the platform workspace is the system scope (a platform admin
// only); a club workspace is that club's scope (its active club admin, or a
// platform admin there for support). A body never names an owner.
//
// Lock order of a write (discovery document, section D; v34 header), held
// to the COMMIT: the per-user advisory lock (one write of this user at a
// time, bounded) -> unit_conversions rows (FOR SHARE, ascending id) -> T2a
// -> T2b -> T3 -> T4 -> metric_definitions (FOR SHARE) -> its scope
// capabilities (FOR SHARE) -> the acting user's role, user and club rows
// (FOR SHARE). Every statement and lock wait is bounded; 55P03 / 40P01 /
// 57014 answer try_again; the COMMIT's answer is awaited a bounded time and,
// if lost, verified on a second connection by the request key
// (verified_after_commit_error or outcome_unknown). The answer of a committed
// write is read on a new, bounded connection after the right is checked
// again (the replay rule). Every read is bounded too (boundedRead).
//
// The database guards these writes too (v35, decisions C73-C79): every write
// transaction carries its acting user as the transaction-local setting
// optimove.source_metric_actor; the database then checks the row's user,
// owner scope and basis, and that every write has its audit row at COMMIT.
// A guard reached through this service is a programming error: it answers a
// sanitized 500, never the database's text.
//
// Responses carry no acting user's id, no SQL, no trigger text and no free
// text beyond the M1-bounded label, evidence references and conversion note.
import crypto from "node:crypto";
import pg from "pg";
import { pool } from "./db.js";
import { boundedText } from "./metricTextRules.js";
import {
  SourceMetricMappingError, refusal, TRY_AGAIN_TEXT, UUID, resolveMappingAdminWith, rightsStillHold, ownerKeyOf, readableOwnerKeys,
  setRightsHoldForTests, mayTransitionMappings,
} from "./sourceMetricAccess.js";

export { SourceMetricMappingError, mayTransitionMappings };
const { DatabaseError } = pg;
// v35: the acting user of a write transaction, bound to that transaction's id
// (a session-level setting or one from another transaction is refused).
const ACTOR_CONTEXT_SQL = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
// A COMMIT that PostgreSQL itself refused with an ordinary ERROR before its
// commit record (a deferred v35 audit link, a deadlock, a serialization
// failure): a certain rollback, nothing written. Uncertain - verified by the
// request key instead - is everything else: a FATAL or PANIC answer, an answer
// without a backend routine (a connection pooler's own error), a connection
// class (08), an operator intervention or shutdown (57P), an internal error
// (XX), 40003 statement_completion_unknown, a socket or driver error and a
// timeout. Stricter than activityRosterCommands.js commitCertainlyRefused,
// because the deployed database is reached through a pooler.
function commitCertainlyRefused(error) {
  if (!(error instanceof DatabaseError)) return false;
  if (error.severity !== "ERROR" || typeof error.routine !== "string" || error.routine === "") return false;
  const code = String(error.code ?? "");
  return !/^(08|57P|XX)/.test(code) && code !== "40003";
}
const NOT_FOUND = () => refusal(404, "notFound", "Not found.");

// The list caps of the approved contract, for the catalogs M2 does not write:
// a longer result is refused, never cut, so a client never takes a partial
// list for the whole one.
export const LIST_CAPS = Object.freeze({ fields: 100, revisionsPerField: 20, targets: 200, conversions: 100 });
// The mappings and a mapping's versions grow by M2's own writes, so they are
// read in pages of a fixed size, by an opaque cursor (owner decision,
// external review 2026-10-13).
export const PAGE_SIZES = Object.freeze({ mappings: 100, versions: 50 });
// A read's bounds: every statement on the server, and the whole read on the
// client (it covers a stalled network too).
export const READ_STATEMENT_TIMEOUT_MS = 5_000;
export const READ_ANSWER_TIMEOUT_MS = 8_000;
export const ROW_LOCK_TIMEOUT_MS = 2_000;
export const USER_LOCK_WAIT_MS = 5_000;
export const STATEMENT_TIMEOUT_MS = 10_000;
export const COMMIT_ANSWER_TIMEOUT_MS = 15_000;
export const UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS = 5_000;
export const CONVERSION_NOTE_MAX_LENGTH = 500;

const SOURCE_SYSTEM = /^[a-z][a-z0-9_]{1,30}$/;
const API_FAMILIES = new Set(["api", "rest_v1"]);
// A parameter value (owner decision 2026-10-13): a JSON string in plain
// decimal notation, at most 12 integer and 9 decimal digits, no exponent.
export const DECIMAL_INPUT = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/;
// A numeric as PostgreSQL prints it (::text of a finite numeric).
const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;

// ---------------------------------------------------------------------------
// Test seams (never set by the application).
// ---------------------------------------------------------------------------
let commitFault = null;
let uncertainCheckFault = null;
let writeHold = null;
let rereadFault = null;
let readFault = null;
let beforeLocksHold = null;
let readStatementTimeoutMs = READ_STATEMENT_TIMEOUT_MS;
let readAnswerTimeoutMs = READ_ANSWER_TIMEOUT_MS;
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
export function setMappingRightsHoldForTests(fn) { setRightsHoldForTests(fn); }
// Runs in the read after a confirmed COMMIT, once the right is confirmed
// again (to make that read fail or stall), with the read's client.
export function setMappingRereadFaultForTests(fn) { rereadFault = fn ?? null; }
// Runs first in every bounded read, with its client (to stall or break it).
export function setMappingReadFaultForTests(fn) { readFault = fn ?? null; }
// Runs inside a version create after its plain reads, before the first lock.
export function setMappingBeforeLocksHoldForTests(fn) { beforeLocksHold = fn ?? null; }
export function setMappingReadBoundsForTests({ statementTimeoutMs = READ_STATEMENT_TIMEOUT_MS, answerTimeoutMs = READ_ANSWER_TIMEOUT_MS } = {}) {
  readStatementTimeoutMs = statementTimeoutMs; readAnswerTimeoutMs = answerTimeoutMs;
}
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

// A bounded read (the F3c2d discipline): its own short transaction -
// REPEATABLE READ READ ONLY, so every statement of one answer sees one
// snapshot; READ COMMITTED when it holds FOR SHARE locks, so a lock sees the
// latest committed row -, a server bound on every statement and lock wait,
// and a client bound on the whole read (a stalled network included). The
// checkout itself is bounded by the pool (db.js). A read that ran past its
// client bound, or whose ROLLBACK did not answer, never goes back to the
// pool: its connection is closed. A bound reached answers try_again; a known
// refusal thrown by `work` passes unchanged.
async function boundedRead(work, { locks = false } = {}) {
  const client = await pool.connect();
  const release = guardClient(client);
  let finished = false;
  const run = (async () => {
    await client.query(locks ? "begin isolation level read committed" : "begin isolation level repeatable read read only");
    await client.query(`set local statement_timeout = '${readStatementTimeoutMs}ms'`);
    await client.query(`set local lock_timeout = '${ROW_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${readAnswerTimeoutMs * 2}ms'`);
    if (readFault) await readFault(client);
    const value = await work(client);
    await client.query("commit");
    return value;
  })();
  run.then(() => { finished = true; }, () => { finished = true; });
  let failure;
  try {
    const value = await withinBound(run, readAnswerTimeoutMs);
    release();
    return value;
  } catch (error) {
    failure = error;
  }
  let dead = !finished;
  if (!dead) await withinBound(client.query("rollback"), 2_000).catch(() => { dead = true; });
  release(dead);
  if (!finished) {
    console.error("[source-metric-mappings] try_again (read bound)");
    throw refusal(409, "try_again", MESSAGES.try_again);
  }
  throw classifyDatabaseError(failure) ?? failure;
}

// ---------------------------------------------------------------------------
// Access (sourceMetricAccess.js, phase 7a): the context resolver bound to
// this service's bounded read. rightsStillHold, ownerKeyOf and
// readableOwnerKeys come from there too.
// ---------------------------------------------------------------------------
export function resolveMappingAdmin(req, known = undefined) {
  return resolveMappingAdminWith(boundedRead, req, known);
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
function decimalInput(value, { nonNegative = false } = {}) {
  if (typeof value !== "string" || !DECIMAL_INPUT.test(value)) throw refusal(400, "invalid_parameters", "A parameter value is a decimal string (at most 12 integer and 9 decimal digits, no exponent).");
  const canonical = canonicalDecimal(value);
  if (nonNegative && canonical.startsWith("-")) throw refusal(400, "invalid_parameters", "durationSeconds is never negative.");
  return canonical;
}
const hashOf = (value) => crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

// The output bounds of a canonical variable's text (C86). Metrics Core's own
// columns are unbounded text (v10), so the bounds are the canonical-variable
// admin API's input limits; a longer value - written through the older
// /api/training-load/metrics API - is cut at its limit, and `truncated` says so.
export const TEXT_LIMITS = Object.freeze({ label: 80, shortLabel: 20, description: 500, key: 63, unit: 30, reason: 500 });
function boundedOut(text, max) {
  if (text === null || text === undefined) return { text: null, cut: false };
  const chars = [...String(text)];
  return chars.length <= max ? { text: String(text), cut: false } : { text: chars.slice(0, max).join(""), cut: true };
}
function boundedLabels(key, label) {
  const k = boundedOut(key, TEXT_LIMITS.key);
  const l = boundedOut(label, TEXT_LIMITS.label);
  return { key: k.text, label: l.text, truncated: k.cut || l.cut };
}

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
  // v34's transition texts (lines 1176, 1181 and 1202), the backstop of
  // phase 7b's own checks under the locks (J8, section 2). The one text of
  // line 1181 covers an inactive definition and a moved current version; the
  // service's own check tells target_not_active from canonical_version_changed.
  ["source_metric_mapping_versions: the source revision must be active and verified", [409, "revision_not_verified"]],
  ["source_metric_mapping_versions: the canonical definition must be active with the pinned version current", [409, "canonical_version_changed"]],
  ["source_metric_mapping_versions: a mapping version with an open activation is not disabled", [409, "activation_open"]],
]);
// The v34 actor refusals (migration lines 175, 190 and 1166), exactly.
const ACTOR_REFUSALS = new Set([
  "source metric mapping: the acting user is not an active platform admin",
  "source metric mapping: the acting user is not an active admin of the mapping's club",
  "source metric mapping: the acting user may not submit this mapping version",
]);
const MESSAGES = {
  try_again: TRY_AGAIN_TEXT,
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
  version_not_submitted: "Only a submitted version (needs_review) is activated.",
  active_version_changed: "The mapping's active version is not the one this request names; read the mapping again.",
  version_status_changed: "The version is not in the status this request names; read the mapping again.",
  revision_not_verified: "The source revision of this version is not active and verified.",
  canonical_version_changed: "The canonical variable has a newer current version than this mapping version pins; create a new mapping version.",
  source_metric_target_taken: "Another mapping of this owner already has an active version for this source field and parameters.",
  activation_open: "The mapping version has an open activation; it is not changed before the activation ends.",
};
export function classifyDatabaseError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01" || code === "57014") {
    console.error(`[source-metric-mappings] try_again (${code})`);
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  // Only the three exact v34 actor refusals are the 404 (the right changed
  // under the request); any other 42501 - a missing grant, the seed marker, or
  // any other text, even with the same beginning - is a 500. Code-only log: a
  // refusal here means the service's own check and the trigger disagreed. A
  // migration that rewords one of them must update ACTOR_REFUSALS (a reword
  // fails closed, as a 500).
  if (code === "42501" && ACTOR_REFUSALS.has(error.message)) {
    console.error("[source-metric-mappings] db_actor_refusal (42501)");
    return NOT_FOUND();
  }
  if (code === "23505") {
    if (error.constraint === "source_metric_mappings_pair_key") return refusal(409, "mapping_exists", "A mapping of this source metric to this canonical definition already exists.");
    // Phase 7b (J8, section 2): two mappings of one owner lock different T3
    // rows, so the index decides between two activations of the same field and
    // parameters; one active version per mapping cannot race behind the T3
    // lock and is the backstop (its current state is read after the rollback).
    if (error.constraint === "source_metric_mapping_versions_one_active_target_per_owner") return refusal(409, "source_metric_target_taken", MESSAGES.source_metric_target_taken);
    if (error.constraint === "source_metric_mapping_versions_one_active_per_mapping") return refusal(409, "active_version_changed", MESSAGES.active_version_changed);
    if (error.constraint === "source_metric_mapping_versions_number_key" || error.constraint === "source_metric_audit_one_request_per_key") return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "23514" && !error.constraint && TRIGGER_REFUSALS.has(error.message)) {
    const [status, refusalCode] = TRIGGER_REFUSALS.get(error.message);
    return refusal(status, refusalCode, MESSAGES[refusalCode]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page cursors: base64url of a small JSON object, opaque to a client and
// strictly validated on the way in - exactly its keys, its version, its kind,
// the workspace's owner key (and the mapping) it was issued for, and a
// position of the right shape. Anything else is 400 invalid_query.
// ---------------------------------------------------------------------------
const CURSOR_TEXT = /^[A-Za-z0-9_-]{1,400}$/;
const CURSOR_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalidCursor = () => refusal(400, "invalid_query", "The cursor is not valid for this list.");
function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodeCursor(text, keys) {
  if (typeof text !== "string" || !CURSOR_TEXT.test(text)) throw invalidCursor();
  let payload;
  try { payload = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { throw invalidCursor(); }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalidCursor();
  if (Object.keys(payload).sort().join(",") !== keys) throw invalidCursor();
  if (payload.v !== 1) throw invalidCursor();
  return payload;
}
// The query of a paged list: only `cursor`, once, or nothing.
function cursorQuery(query, position) {
  const keys = Object.keys(query ?? {});
  for (const key of keys) if (key !== "cursor") throw refusal(400, "invalid_query", "The query carries a parameter this route does not take.");
  if (!keys.includes("cursor")) return null;
  return position(query.cursor);
}
function mappingsCursorPosition(text, ctx) {
  const p = decodeCursor(text, "i,k,o,s,t,v");
  if (p.k !== "mappings" || p.o !== ownerKeyOf(ctx) || typeof p.s !== "boolean") throw invalidCursor();
  if (typeof p.t !== "string" || !CURSOR_AT.test(p.t)) throw invalidCursor();
  const instant = new Date(`${p.t.slice(0, 23)}Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 23) !== p.t.slice(0, 23)) throw invalidCursor();
  // A cursor's instant is a created_at of this system, never before 2000; it
  // also keeps year 0 (valid in JavaScript, not in PostgreSQL) from the query.
  if (instant.getUTCFullYear() < 2000) throw invalidCursor();
  if (typeof p.i !== "string" || !LOWER_UUID.test(p.i)) throw invalidCursor();
  return { clubPart: p.s, at: p.t, id: p.i };
}
function versionsCursorPosition(text, ctx, mappingId) {
  const p = decodeCursor(text, "k,m,n,o,v");
  if (p.k !== "versions" || p.o !== ownerKeyOf(ctx) || p.m !== mappingId) throw invalidCursor();
  if (!Number.isSafeInteger(p.n) || p.n < 1 || p.n > 2147483647) throw invalidCursor();
  return { number: p.n };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function tooLarge(limit) {
  return refusal(409, "result_too_large", "The result is larger than this route returns at once.", { limit });
}

// A source field's revision as every read shows it (M2 /fields, the M2b field
// detail and verification answers): the proof facts, never a verifier's id.
const REVISION_COLUMNS = `id, source_metric_definition_id, revision_number, state, value_shape, parameter_kind, supports_session, supports_drill,
            expected_source_unit, source_unit, expected_source_bound_unit, source_bound_unit, bound_operator,
            evidence_status, evidence_ref, unit_evidence_ref, meaning_evidence_ref, unit_verified_at, meaning_verified_at`;
function revisionOut(r) {
  return {
    id: r.id, revisionNumber: r.revision_number, state: r.state, valueShape: r.value_shape, parameterKind: r.parameter_kind,
    supportsSession: r.supports_session, supportsDrill: r.supports_drill, expectedSourceUnit: r.expected_source_unit, sourceUnit: r.source_unit,
    expectedSourceBoundUnit: r.expected_source_bound_unit, sourceBoundUnit: r.source_bound_unit, boundOperator: r.bound_operator,
    evidenceStatus: r.evidence_status, evidenceRef: r.evidence_ref, unitEvidenceRef: r.unit_evidence_ref, meaningEvidenceRef: r.meaning_evidence_ref,
    unitVerifiedAt: r.unit_verified_at, meaningVerifiedAt: r.meaning_verified_at,
  };
}

export async function listFields({ ctx, query }) {
  void ctx;
  for (const key of Object.keys(query ?? {})) if (!["sourceSystem", "apiFamily"].includes(key)) throw refusal(400, "invalid_query", "The query carries a parameter this route does not take.");
  const sourceSystem = query?.sourceSystem ?? null;
  const apiFamily = query?.apiFamily ?? null;
  if (sourceSystem !== null && (typeof sourceSystem !== "string" || !SOURCE_SYSTEM.test(sourceSystem))) throw refusal(400, "invalid_query", "sourceSystem is not a source system key.");
  if (apiFamily !== null && (typeof apiFamily !== "string" || !API_FAMILIES.has(apiFamily))) throw refusal(400, "invalid_query", "apiFamily is api or rest_v1.");
  return boundedRead(async (client) => {
  const fields = (await client.query(
    `select id, source_system, api_family, source_metric_key, source_label, state
       from training_load.source_metric_definitions
      where ($1::text is null or source_system = $1) and ($2::text is null or api_family = $2)
      order by source_system collate "C", api_family collate "C", source_metric_key collate "C"
      limit $3`,
    [sourceSystem, apiFamily, LIST_CAPS.fields + 1],
  )).rows;
  if (fields.length > LIST_CAPS.fields) throw tooLarge(LIST_CAPS.fields);
  const revisions = fields.length === 0 ? [] : (await client.query(
    `select ${REVISION_COLUMNS}
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
      revisions: list.map(revisionOut),
    };
  });
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
  const rows = await boundedRead(async (client) => (await client.query(
    `select d.id, d.owner_scope, d.key, d.label, ${CANONICAL_VERSION_COLUMNS},
            (select array_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as scopes
       from training_load.metric_definitions d
       join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
      where d.state = 'active'
        and (($1::text = 'system' and d.owner_scope = 'system') or ($1::text = 'club' and d.owner_scope = 'club' and d.owner_club_id = $2::uuid))
      order by d.id
      limit $3`,
    [ctx.owner.scope, ctx.owner.clubId, LIST_CAPS.targets + 1],
  )).rows);
  if (rows.length > LIST_CAPS.targets) throw tooLarge(LIST_CAPS.targets);
  return rows.map((row) => {
    const notReadyCode = notReadyCodeOf(row);
    const canonical = canonicalParametersOf(row);
    return {
      id: row.id, ownerScope: row.owner_scope, ...boundedLabels(row.key, row.label),
      currentVersion: { id: row.version_id, versionNumber: row.version_number, unit: row.unit_is_token ? row.unit : null, canonicalParameters: canonical ? canonical.params : null },
      scopes: row.scopes ?? [], versionReady: notReadyCode === null, notReadyCode,
    };
  });
}

export async function listConversions({ ctx }) {
  void ctx;
  const rows = await boundedRead(async (client) => (await client.query(
    `select id, from_unit, to_unit, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as scale_divisor,
            trim_scale("offset")::text as "offset", evidence_ref
       from training_load.unit_conversions where state = 'active'
      order by from_unit collate "C", to_unit collate "C"
      limit $1`,
    [LIST_CAPS.conversions + 1],
  )).rows);
  if (rows.length > LIST_CAPS.conversions) throw tooLarge(LIST_CAPS.conversions);
  return rows.map((r) => ({ id: r.id, fromUnit: r.from_unit, toUnit: r.to_unit, scale: r.scale, scaleDivisor: r.scale_divisor, offset: r.offset, evidenceRef: r.evidence_ref }));
}

// A mapping version as the API returns it: numbers as exact decimal text,
// parameter numbers as text too; when it was submitted, activated and
// disabled (R2), but no acting user and no disable reason (C63).
const PARAMS_AS_TEXT = (column) => `(select coalesce(jsonb_object_agg(e.key, case jsonb_typeof(e.value) when 'number' then to_jsonb(trim_scale((e.value #>> '{}')::numeric)::text) else e.value end), '{}'::jsonb) from jsonb_each(${column}) e)`;
const VERSION_COLUMNS = `v.id, v.mapping_id, v.version_number, v.status, v.source_metric_version_id, v.metric_definition_version_id,
  v.source_unit, v.target_unit, trim_scale(v.scale)::text as scale, trim_scale(v.scale_divisor)::text as scale_divisor, trim_scale(v."offset")::text as "offset",
  v.parameter_kind, ${PARAMS_AS_TEXT("v.source_parameters")} as source_parameters, ${PARAMS_AS_TEXT("v.canonical_parameters")} as canonical_parameters,
  trim_scale(v.parameter_scale)::text as parameter_scale, trim_scale(v.parameter_scale_divisor)::text as parameter_scale_divisor,
  trim_scale(v.parameter_offset)::text as parameter_offset, v.parameter_fingerprint, v.applies_to_session, v.applies_to_drill,
  v.conversion_note, v.created_at, v.submitted_at, v.activated_at, v.disabled_at`;
function publicVersion(v) {
  return {
    id: v.id, mappingId: v.mapping_id, versionNumber: v.version_number, status: v.status, sourceRevisionId: v.source_metric_version_id,
    metricDefinitionVersionId: v.metric_definition_version_id, sourceUnit: v.source_unit, targetUnit: v.target_unit,
    scale: v.scale, scaleDivisor: v.scale_divisor, offset: v.offset, parameterKind: v.parameter_kind,
    sourceParameters: v.source_parameters, canonicalParameters: v.canonical_parameters,
    parameterScale: v.parameter_scale, parameterScaleDivisor: v.parameter_scale_divisor, parameterOffset: v.parameter_offset,
    parameterFingerprint: v.parameter_fingerprint, appliesToSession: v.applies_to_session, appliesToDrill: v.applies_to_drill,
    conversionNote: v.conversion_note, createdAt: v.created_at, submittedAt: v.submitted_at,
    activatedAt: v.activated_at, disabledAt: v.disabled_at,
  };
}
// B3 (M3-0): the source field's own label (1-80 by its CHECK, D2) and the
// canonical target's key and label, cut to the admin API's limits (C86).
const MAPPING_COLUMNS = `m.id, m.owner_scope, m.owner_key, m.source_metric_definition_id, d.source_metric_key, d.api_family, d.source_label,
  m.metric_definition_id, md.key as target_key, md.label as target_label, m.created_at`;
const publicMappingBase = (m) => ({
  id: m.id, ownerScope: m.owner_scope, sourceMetric: { id: m.source_metric_definition_id, key: m.source_metric_key, apiFamily: m.api_family, label: m.source_label },
  metricDefinitionId: m.metric_definition_id, target: boundedLabels(m.target_key, m.target_label), createdAt: m.created_at,
});

// GET /mappings: one page in the stable order (system first, then the club's
// own; created_at; id), the next page after the cursor's position - keyset,
// so a stable snapshot is read without a gap or a duplicate. The cursor is
// bound to the workspace's owner key.
export async function listMappings({ ctx, query }) {
  const after = cursorQuery(query, (payload) => mappingsCursorPosition(payload, ctx));
  return boundedRead(async (client) => {
    const rows = (await client.query(
      `select ${MAPPING_COLUMNS}, (m.owner_scope <> 'system') as club_part,
              to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as cursor_at
         from training_load.source_metric_mappings m
         join training_load.source_metric_definitions d on d.id = m.source_metric_definition_id
         join training_load.metric_definitions md on md.id = m.metric_definition_id
        where m.owner_key = any($1::text[])
          and ($2::boolean is null or ((m.owner_scope <> 'system'), m.created_at, m.id) > ($2::boolean, ($3::timestamp at time zone 'UTC'), $4::uuid))
        order by (m.owner_scope <> 'system'), m.created_at, m.id
        limit $5`,
      [readableOwnerKeys(ctx), after ? after.clubPart : null, after ? after.at : null, after ? after.id : null, PAGE_SIZES.mappings + 1],
    )).rows;
    const page = rows.slice(0, PAGE_SIZES.mappings);
    const last = page[page.length - 1];
    const nextCursor = rows.length > PAGE_SIZES.mappings
      ? encodeCursor({ v: 1, k: "mappings", o: ownerKeyOf(ctx), s: last.club_part, t: last.cursor_at, i: last.id })
      : null;
    return { mappings: await summarize(client, page), nextCursor };
  });
}

// The bounded summary of mappings (the list's shape and the answer of a
// mapping write): the latest version, the active version and the counts per
// status - never the version list, so it does not depend on any list cap.
async function summarize(executor, mappings) {
  if (mappings.length === 0) return [];
  const ids = mappings.map((m) => m.id);
  const latest = new Map((await executor.query(
    `select distinct on (mapping_id) mapping_id, id, version_number, status, created_at, submitted_at
       from training_load.source_metric_mapping_versions where mapping_id = any($1::uuid[])
      order by mapping_id, version_number desc`,
    [ids],
  )).rows.map((r) => [r.mapping_id, r]));
  const counts = new Map((await executor.query(
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

// A write's answer and a replay: the mapping only when this workspace may
// write it (its owner key is the workspace's), in the bounded summary shape.
async function writableMappingSummary(executor, ctx, mappingId) {
  const m = (await executor.query(
    `select ${MAPPING_COLUMNS}
       from training_load.source_metric_mappings m
       join training_load.source_metric_definitions d on d.id = m.source_metric_definition_id
         join training_load.metric_definitions md on md.id = m.metric_definition_id
      where m.id = $1 and m.owner_key = $2`,
    [mappingId, ownerKeyOf(ctx)],
  )).rows[0];
  return m ? (await summarize(executor, [m]))[0] : null;
}
// A version for a write's answer and a replay: only when this workspace may
// write its mapping; one row, no list.
async function writableVersion(executor, ctx, mappingId, versionId) {
  const v = (await executor.query(
    `select ${VERSION_COLUMNS} from training_load.source_metric_mapping_versions v
       join training_load.source_metric_mappings m on m.id = v.mapping_id
      where v.id = $1 and v.mapping_id = $2 and m.owner_key = $3`,
    [versionId, mappingId, ownerKeyOf(ctx)],
  )).rows[0];
  return v ? publicVersion(v) : null;
}

// GET /mappings/:id: the mapping with one page of its versions (every
// status), by number descending; the next page after the cursor's number.
// The cursor is bound to this mapping and the workspace's owner key.
export async function getMapping({ ctx, mappingId, query }) {
  if (typeof mappingId !== "string" || !UUID.test(mappingId)) return null;
  const id = mappingId.toLowerCase();
  const after = cursorQuery(query, (payload) => versionsCursorPosition(payload, ctx, id));
  return boundedRead(async (client) => {
    const m = (await client.query(
      `select ${MAPPING_COLUMNS}
         from training_load.source_metric_mappings m
         join training_load.source_metric_definitions d on d.id = m.source_metric_definition_id
         join training_load.metric_definitions md on md.id = m.metric_definition_id
        where m.id = $1 and m.owner_key = any($2::text[])`,
      [id, readableOwnerKeys(ctx)],
    )).rows[0];
    if (!m) return null;
    const rows = (await client.query(
      `select ${VERSION_COLUMNS} from training_load.source_metric_mapping_versions v
        where v.mapping_id = $1 and ($2::int is null or v.version_number < $2::int)
        order by v.version_number desc limit $3`,
      [m.id, after ? after.number : null, PAGE_SIZES.versions + 1],
    )).rows;
    const page = rows.slice(0, PAGE_SIZES.versions);
    const nextCursor = rows.length > PAGE_SIZES.versions
      ? encodeCursor({ v: 1, k: "versions", o: ownerKeyOf(ctx), m: m.id, n: page[page.length - 1].version_number })
      : null;
    return { mapping: { ...publicMappingBase(m), versions: page.map(publicVersion) }, nextCursor };
  });
}

// ---------------------------------------------------------------------------
// Writes: one bounded transaction each, the request key's audit row as the
// request record (D10), the replay answered from the current state.
// ---------------------------------------------------------------------------
// Where a write's request record lives: M2's own writes use their T8 audit row;
// the canonical-variable admin API (M3-0, v36) its metric_variable_requests row.
// `find` answers (operation, request_hash) plus the ids the reread needs; the
// operation_id lets a replacement's replay name the version it replaced (R7).
const MAPPING_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, mapping_id, mapping_version_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
// The ids a committed write names when its answer could not be read (readError).
const mappingIdsOf = (written) => ({ mappingId: written.mapping_id ?? null, ...(written.mapping_version_id ? { versionId: written.mapping_version_id } : {}) });
async function runWrite({ ctx, where, requestKey, requestHash, action, body: operation, reread, requests = MAPPING_REQUESTS, classify = classifyDatabaseError, idsOf = mappingIdsOf }) {
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
    const earlier = (await client.query(requests.find, [ctx.userId, requestKey])).rows[0];
    if (earlier) {
      if (earlier.operation !== action || earlier.request_hash !== requestHash) throw refusal(409, "request_key_reused", "This requestKey was already used for a different request; use a new key.");
      // A replay is a read of the current state, after the right is checked again.
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const current = await reread(client, earlier);
      await finish();
      if (!current) throw NOT_FOUND();
      return { ...current, replayed: true };
    }
    // The acting user of this write, for the v35 database guards (C75):
    // local to this transaction (gone at its COMMIT or ROLLBACK), bound to
    // its id, from the authenticated session only - never from the body. Set
    // before the first protected write; a replay, which writes nothing, sets
    // none.
    await client.query(ACTOR_CONTEXT_SQL, [String(ctx.userId).toLowerCase()]);
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
      // PostgreSQL itself refused the COMMIT with an ordinary ERROR (a
      // deferred v35 audit link, a deadlock): the transaction is rolled back
      // and nothing was written - a definite refusal. Every other COMMIT error
      // is verified by the request key below.
      if (commitCertainlyRefused(commitError)) throw classify(commitError) ?? commitError;
      console.error(`[source-metric-mappings] the COMMIT of ${where} was not confirmed (${commitError?.code ?? ""}); checking the request record`);
      let found = false;
      try { found = await requestIsCommitted(ctx.userId, requestKey, requests.exists); } catch { found = false; }
      if (!found) throw refusal(503, "outcome_unknown", "The database did not confirm this request, and it could not be verified yet. Repeat it with the same requestKey.", { requestKey });
      return { ...(await answerAfterCommit(ctx, written, reread, idsOf)), replayed: false, commitConfirmation: "verified_after_commit_error" };
    }
    return { ...(await answerAfterCommit(ctx, written, reread, idsOf)), replayed: false };
  } catch (error) {
    await finish();
    // An allowlisted refusal becomes its stable code; anything else goes up
    // unchanged and the router answers it as a sanitized 500 internal_error.
    throw classify(error) ?? error;
  } finally {
    if (!released) await finish(true);
  }
}
// The answer of a committed write (the replay rule; owner's external review
// of 2026-10-13): on a new, bounded connection the caller's right, user and
// club are checked again FOR SHARE and held while the answer is read. A right
// lost meanwhile answers the identical 404 and shows nothing of the resource.
// A read that fails or runs past its bound never turns the answer into a
// failure: it keeps its status with readError, and names the ids of what was
// written only once the right was confirmed again (a replay with the same
// requestKey answers the rest).
async function answerAfterCommit(ctx, written, reread, idsOf) {
  let rightConfirmed = false;
  let outcome = null;
  try {
    outcome = await boundedRead(async (client) => {
      if (!(await rightsStillHold(client, ctx))) return { lost: true };
      rightConfirmed = true;
      if (rereadFault) await rereadFault(client);
      return { current: await reread(client, written) };
    }, { locks: true });
  } catch { /* the answer below */ }
  if (outcome?.lost) throw NOT_FOUND();
  if (outcome?.current) return outcome.current;
  if (!rightConfirmed) return { readError: true };
  return { readError: true, ...idsOf(written) };
}
async function requestIsCommitted(userId, requestKey, existsSql) {
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
    const answer = client.query({ text: existsSql, values: [userId, requestKey], query_timeout: left() });
    answer.catch(() => {});
    return (await withinBound(answer, left())).rowCount === 1;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    release(broken);
  }
}

// The operation's keyed T8 row; `reason` for a disable and a replacement (R7).
async function insertRequestRecord(client, { action, mappingId, mappingVersionId = null, fromStatus = null, toStatus = null, reason = null, ctx, operationId, requestKey, requestHash }) {
  await client.query(
    `insert into training_load.source_metric_audit
       (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [action, mappingId, mappingVersionId, fromStatus, toStatus, reason, ctx.userId, ctx.basis, operationId, requestKey, requestHash],
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
      const mapping = await writableMappingSummary(executor, ctx, record.mapping_id);
      return mapping ? { mapping } : null;
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
      const existing = (await boundedRead((client) => client.query(
        `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2 and owner_key = $3`,
        [sourceMetricId, metricDefinitionId, ownerKeyOf(ctx)],
      )).catch(() => ({ rows: [] }))).rows[0];
      if (existing) error.details = { current: { mappingId: existing.id } };
    }
    throw error;
  });
}

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

// The facts of a source revision a version is built from (owner's external
// review of 2026-10-13: compared again under FOR SHARE).
const REVISION_FACTS = Object.freeze(["source_metric_definition_id", "parameter_kind", "supports_session", "supports_drill", "source_unit", "source_bound_unit", "bound_operator"]);

// A plain read (the row is locked later, in the lock order).
async function activeConversion(client, fromUnit, toUnit) {
  const rows = (await client.query(
    `select id, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as scale_divisor, trim_scale("offset")::text as "offset"
       from training_load.unit_conversions where from_unit = $1 and to_unit = $2 and state = 'active'
      order by id`,
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
      const version = await writableVersion(executor, ctx, record.mapping_id, record.mapping_version_id);
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
        valueConversion = await activeConversion(client, sourceUnit, targetUnit);
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
          boundConversion = await activeConversion(client, revision.source_bound_unit, canonical.unit);
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
      if (beforeLocksHold) await beforeLocksHold(client);
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
      // v34 keeps every other fact read above final once it was seen as this
      // read accepted it (C42; a unit proof and a meaning proof are written
      // once, and a proven unit or operator is never NULL again). They are
      // compared again anyway, so a later migration that allows a change can
      // never slip a stale fact into the version: the request is repeated.
      for (const column of REVISION_FACTS) {
        if (lockedRevision[column] !== revision[column]) throw refusal(409, "try_again", MESSAGES.try_again);
      }
      await client.query(`select 1 from training_load.source_metric_mappings where id = $1 for no key update`, [id]);
      const lockedTarget = (await client.query(
        `select state, current_version_id from training_load.metric_definitions where id = $1 for share`, [mapping.metric_definition_id],
      )).rows[0];
      if (!lockedTarget || lockedTarget.state !== "active" || lockedTarget.current_version_id !== target.version_id) {
        throw refusal(409, "try_again", MESSAGES.try_again);
      }
      // The canonical levels again, under FOR SHARE of the scope capability
      // rows (after metric_definitions, the v34 order): a level removed since
      // the plain read is refused, and a removal waits for this version.
      const lockedScopes = (await client.query(
        `select scope_level from training_load.metric_definition_scope_capabilities
          where metric_definition_id = $1 order by scope_level for share`,
        [mapping.metric_definition_id],
      )).rows.map((r) => r.scope_level);
      if ((body.appliesToSession && !lockedScopes.includes("session")) || (body.appliesToDrill && !lockedScopes.includes("component"))) {
        throw refusal(409, "level_not_allowed", MESSAGES.level_not_allowed);
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
      const version = await writableVersion(executor, ctx, record.mapping_id, record.mapping_version_id);
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

// ---------------------------------------------------------------------------
// Phase 7b (J8, C104): activate, replace and disable a mapping version - an
// active platform admin's only, in the workspace of the mapping's owner
// (mayTransitionMappings; the routes ask it before the body). Each is one
// bounded transaction of runWrite in J8's lock order (section 4): the
// per-user lock and the request record; for an activation the active
// unit_conversions rows of the value and bound pairs in one statement, in
// ascending id, FOR SHARE (v34's own function, C52); T2a and T2b FOR SHARE;
// T3 FOR NO KEY UPDATE (it serializes every transition of one mapping, a
// submission and the revision lifecycle's pinned step); the T4 rows FOR
// UPDATE in ascending id; the open T5 activations counted; for an activation
// metric_definitions and its scope capability rows FOR SHARE; the acting
// user's rows FOR SHARE. The states are compared under those locks, but a
// state refusal is answered only after the right is confirmed again, so a
// caller who lost it sees the identical 404, never `current`. Then the
// writes - the status changes, then the T8 rows with the keyed one last - and
// the bounded COMMIT. The disable reason is written and audited, never
// returned (C63).
// ---------------------------------------------------------------------------
export const TRANSITION_REASON_MAX_LENGTH = 500;
const EXPECTED_STATUSES = new Set(["draft", "needs_review", "active"]);
const INVALID_REASON = "reason is one line of 1-500 visible characters without surrounding spaces.";

// Test seam (never set by the application): "split_operation" writes the
// replaced version's mapping_status row under another operation_id, so v43's
// deferred G1 refuses the COMMIT (J8 section 8: a definite COMMIT refusal).
let transitionAuditFault = null;
export function setMappingTransitionAuditFaultForTests(kind) { transitionAuditFault = kind ?? null; }

function transitionPath(mappingId, versionId) {
  if (typeof mappingId !== "string" || !UUID.test(mappingId) || typeof versionId !== "string" || !UUID.test(versionId)) throw NOT_FOUND();
  return { mId: mappingId.toLowerCase(), vId: versionId.toLowerCase() };
}
function transitionReason(value) {
  if (!boundedText(value, TRANSITION_REASON_MAX_LENGTH)) throw refusal(400, "invalid_body", INVALID_REASON);
  return value;
}
// The database's own text rule, once more inside the write (v40 makes the
// JavaScript twin the same rule; the audit column's CHECK is the backstop).
async function databaseTextAgrees(client, reason) {
  if ((await client.query(`select training_load.source_metric_text_ok($1, $2) as ok`, [reason, TRANSITION_REASON_MAX_LENGTH])).rows[0].ok !== true) {
    throw refusal(400, "invalid_body", INVALID_REASON);
  }
}

// The version and its mapping, a plain read to learn the units and ids (every
// column but the status is immutable, v34); the owner is the workspace's.
async function transitionTarget(client, ctx, mId, vId) {
  const v = (await client.query(
    `select v.id, v.mapping_id, v.status, v.source_metric_definition_id, v.source_metric_version_id, v.metric_definition_id,
            v.metric_definition_version_id, v.parameter_fingerprint, v.owner_key, v.source_unit, v.target_unit,
            trim_scale(v.scale)::text as scale, trim_scale(v.scale_divisor)::text as scale_divisor, trim_scale(v."offset")::text as "offset",
            v.parameter_kind, v.source_parameters ->> 'unit' as source_bound_unit, v.canonical_parameters ->> 'unit' as canonical_bound_unit,
            trim_scale(v.parameter_scale)::text as parameter_scale, trim_scale(v.parameter_scale_divisor)::text as parameter_scale_divisor,
            trim_scale(v.parameter_offset)::text as parameter_offset, v.applies_to_session, v.applies_to_drill
       from training_load.source_metric_mapping_versions v
       join training_load.source_metric_mappings m on m.id = v.mapping_id
      where v.id = $1 and v.mapping_id = $2 and m.owner_key = $3`,
    [vId, mId, ownerKeyOf(ctx)],
  )).rows[0];
  if (!v) throw NOT_FOUND();
  return v;
}

// T2a and T2b of the version FOR SHARE (J8 section 4, step 3).
async function lockRevision(client, v) {
  await client.query(`select 1 from training_load.source_metric_definitions where id = $1 for share`, [v.source_metric_definition_id]);
  return (await client.query(
    `select state, evidence_status from training_load.source_metric_definition_versions where id = $1 for share`, [v.source_metric_version_id],
  )).rows[0];
}

// The T4 rows FOR UPDATE in ascending id (step 5), and their open T5
// activations, counted (step 6; no T5 writer exists before phase 7d).
async function lockVersions(client, ids) {
  const sorted = [...new Set(ids)].sort();
  const locked = new Map((await client.query(
    `select id, status from training_load.source_metric_mapping_versions where id = any($1::uuid[]) order by id for update`, [sorted],
  )).rows.map((r) => [r.id, r.status]));
  const open = (await client.query(
    `select count(*)::int as n from training_load.source_metric_mapping_activations where mapping_version_id = any($1::uuid[]) and ended_at is null`, [sorted],
  )).rows[0].n;
  return { locked, open };
}

// C52: under the conversion locks taken first, the value pair and the bound
// pair each hold exactly one active row with the version's own factors (the
// identity needs none), as v34's activation checks them again.
async function conversionsHold(client, v) {
  const holds = async (from, to, scale, divisor, offset) => from === to || (await client.query(
    `select count(*)::int as n from training_load.unit_conversions
      where from_unit = $1 and to_unit = $2 and state = 'active'
        and scale = $3::numeric and scale_divisor = $4::numeric and "offset" = $5::numeric`,
    [from, to, scale, divisor, offset],
  )).rows[0].n === 1;
  if (!(await holds(v.source_unit, v.target_unit, v.scale, v.scale_divisor, v.offset))) return "conversion_unavailable";
  if (v.parameter_kind !== "none"
      && !(await holds(v.source_bound_unit, v.canonical_bound_unit, v.parameter_scale, v.parameter_scale_divisor, v.parameter_offset))) {
    return "bound_conversion_unavailable";
  }
  return null;
}

async function activeVersionOf(executor, ctx, mappingId) {
  return (await executor.query(
    `select v.id from training_load.source_metric_mapping_versions v
       join training_load.source_metric_mappings m on m.id = v.mapping_id
      where v.mapping_id = $1 and v.status = 'active' and m.owner_key = $2`,
    [mappingId, ownerKeyOf(ctx)],
  )).rows[0]?.id ?? null;
}

// The answer of an activation (and its replay): the version and, for a
// replacement, the version it replaced - the operation's own mapping_status
// row active -> disabled of another version of the same mapping (R7).
async function activationAnswer(executor, ctx, record) {
  const version = await writableVersion(executor, ctx, record.mapping_id, record.mapping_version_id);
  if (!version) return null;
  const replaced = (await executor.query(
    `select mapping_version_id from training_load.source_metric_audit
      where operation_id = $1 and action = 'mapping_status' and from_status = 'active' and to_status = 'disabled'
        and mapping_id = $2 and mapping_version_id <> $3`,
    [record.operation_id, record.mapping_id, record.mapping_version_id],
  )).rows[0];
  return { version, replaced: replaced ? replaced.mapping_version_id : null };
}

// A1: POST /mappings/:mappingId/versions/:versionId/activate - needs_review ->
// active. With expectedActiveVersionId (the active version the caller saw) and
// a reason, the same transaction disables that version first (D6, Q3); with
// null, a mapping that has an active version is active_version_changed, never
// an automatic replacement.
export async function activateVersion({ ctx, mappingId, versionId, body }) {
  if (!mayTransitionMappings(ctx)) throw NOT_FOUND();
  const { mId, vId } = transitionPath(mappingId, versionId);
  plainObject(body, ["requestKey", "expectedActiveVersionId", "reason"], ["requestKey", "expectedActiveVersionId"]);
  const requestKey = uuidField(body.requestKey);
  const expectedActiveVersionId = body.expectedActiveVersionId === null ? null : uuidField(body.expectedActiveVersionId);
  let reason = null;
  if (expectedActiveVersionId === null) {
    if ("reason" in body) throw refusal(400, "invalid_body", "reason is given only when the activation replaces the active version.");
  } else {
    if (!("reason" in body)) throw refusal(400, "invalid_body", "A replacement of the active version needs a reason.");
    reason = transitionReason(body.reason);
  }
  const replacing = expectedActiveVersionId !== null;
  const action = replacing ? "mapping_version_replaced" : "mapping_status";
  const requestHash = hashOf({ route: "mapping_activate", mappingId: mId, versionId: vId, toStatus: "active", expectedActiveVersionId, reason });
  return runWrite({
    ctx, where: replacing ? "mapping_version_replace" : "mapping_version_activate", requestKey, requestHash, action,
    reread: (executor, record) => activationAnswer(executor, ctx, record),
    body: async (client, operationId) => {
      const v = await transitionTarget(client, ctx, mId, vId);
      // Step 2: the conversion rows, in one statement (v34's own function).
      await client.query(`select training_load.source_metric_lock_conversions($1, $2, $3, $4)`,
        [v.source_unit, v.target_unit, v.source_bound_unit, v.canonical_bound_unit]);
      const revision = await lockRevision(client, v);
      await client.query(`select 1 from training_load.source_metric_mappings where id = $1 for no key update`, [mId]);
      const active = (await client.query(
        `select id from training_load.source_metric_mapping_versions where mapping_id = $1 and status = 'active'`, [mId],
      )).rows[0]?.id ?? null;
      const { locked, open } = await lockVersions(client, active ? [vId, active] : [vId]);
      const md = (await client.query(
        `select state, current_version_id from training_load.metric_definitions where id = $1 for share`, [v.metric_definition_id],
      )).rows[0];
      const scopes = (await client.query(
        `select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 order by scope_level for share`,
        [v.metric_definition_id],
      )).rows.map((r) => r.scope_level);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      // The states, answered only now (after the right).
      const status = locked.get(vId);
      if (status !== "needs_review") throw refusal(409, "version_not_submitted", MESSAGES.version_not_submitted, { current: { status } });
      if (active !== expectedActiveVersionId) throw refusal(409, "active_version_changed", MESSAGES.active_version_changed, { current: { activeVersionId: active } });
      if (!revision || revision.state !== "active" || revision.evidence_status !== "verified") throw refusal(409, "revision_not_verified", MESSAGES.revision_not_verified);
      if (!md || md.state !== "active") throw refusal(409, "target_not_active", MESSAGES.target_not_active);
      if (md.current_version_id !== v.metric_definition_version_id) throw refusal(409, "canonical_version_changed", MESSAGES.canonical_version_changed);
      const conversion = await conversionsHold(client, v);
      if (conversion) throw refusal(409, conversion, MESSAGES[conversion]);
      if ((v.applies_to_session && !scopes.includes("session")) || (v.applies_to_drill && !scopes.includes("component"))) {
        throw refusal(409, "level_not_allowed", MESSAGES.level_not_allowed);
      }
      if (open > 0) throw refusal(409, "activation_open", MESSAGES.activation_open);
      // Another mapping of the same owner with an active version of the same
      // field and parameters (C33): a plain read; the index decides a race.
      const taken = await client.query(
        `select 1 from training_load.source_metric_mapping_versions
          where status = 'active' and source_metric_definition_id = $1 and parameter_fingerprint = $2 and owner_key = $3 and mapping_id <> $4`,
        [v.source_metric_definition_id, v.parameter_fingerprint, v.owner_key, mId],
      );
      if (taken.rowCount > 0) throw refusal(409, "source_metric_target_taken", MESSAGES.source_metric_target_taken);
      if (replacing) await databaseTextAgrees(client, reason);
      if (writeHold) await writeHold(client, replacing ? "mapping_version_replace" : "mapping_version_activate");
      // The writes: N disabled first (one active version per mapping), then
      // N+1 activated; N's audit row, then N+1's keyed row last.
      if (replacing) {
        await client.query(
          `update training_load.source_metric_mapping_versions
              set status = 'disabled', disabled_by_user_id = $2, disabled_at = clock_timestamp(), disabled_basis = $3, disable_reason = $4
            where id = $1`,
          [active, ctx.userId, ctx.basis, reason],
        );
      }
      await client.query(
        `update training_load.source_metric_mapping_versions
            set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = $3
          where id = $1`,
        [vId, ctx.userId, ctx.basis],
      );
      if (replacing) {
        // The replaced version's own row: no request key (one request record
        // per operation, source_metric_audit_request_pair), its own insert.
        await client.query(
          `insert into training_load.source_metric_audit
             (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
           values ('mapping_status', $1, $2, 'active', 'disabled', $3, $4, $5, $6)`,
          [mId, active, reason, ctx.userId, ctx.basis, transitionAuditFault === "split_operation" ? crypto.randomUUID() : operationId],
        );
      }
      await insertRequestRecord(client, { action, mappingId: mId, mappingVersionId: vId, fromStatus: "needs_review", toStatus: "active", reason, ctx, operationId, requestKey, requestHash });
      return { mapping_id: mId, mapping_version_id: vId, operation_id: operationId };
    },
  }).catch(async (error) => {
    // The one-active-per-mapping backstop: the current active version, read
    // after the rollback (a version of this caller's own mapping).
    if (error instanceof SourceMetricMappingError && error.code === "active_version_changed" && !error.details) {
      const current = await boundedRead((client) => activeVersionOf(client, ctx, mId)).catch(() => undefined);
      if (current !== undefined) error.details = { current: { activeVersionId: current } };
    }
    throw error;
  });
}

// A2: POST /mappings/:mappingId/versions/:versionId/disable - draft,
// needs_review or active -> disabled, with a reason. expectedStatus is the
// status the caller saw, so a stale screen never disables a version that
// moved meanwhile.
export async function disableVersion({ ctx, mappingId, versionId, body }) {
  if (!mayTransitionMappings(ctx)) throw NOT_FOUND();
  const { mId, vId } = transitionPath(mappingId, versionId);
  plainObject(body, ["requestKey", "expectedStatus", "reason"], ["requestKey", "expectedStatus", "reason"]);
  const requestKey = uuidField(body.requestKey);
  if (typeof body.expectedStatus !== "string" || !EXPECTED_STATUSES.has(body.expectedStatus)) {
    throw refusal(400, "invalid_body", "expectedStatus is draft, needs_review or active: the status of the version this request disables.");
  }
  const expectedStatus = body.expectedStatus;
  const reason = transitionReason(body.reason);
  const requestHash = hashOf({ route: "mapping_disable", mappingId: mId, versionId: vId, toStatus: "disabled", expectedStatus, reason });
  return runWrite({
    ctx, where: "mapping_version_disable", requestKey, requestHash, action: "mapping_status",
    reread: async (executor, record) => {
      const version = await writableVersion(executor, ctx, record.mapping_id, record.mapping_version_id);
      return version ? { version } : null;
    },
    body: async (client, operationId) => {
      const v = await transitionTarget(client, ctx, mId, vId);
      await lockRevision(client, v);
      await client.query(`select 1 from training_load.source_metric_mappings where id = $1 for no key update`, [mId]);
      const { locked, open } = await lockVersions(client, [vId]);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const status = locked.get(vId);
      if (status !== expectedStatus) throw refusal(409, "version_status_changed", MESSAGES.version_status_changed, { current: { status } });
      if (open > 0) throw refusal(409, "activation_open", MESSAGES.activation_open);
      await databaseTextAgrees(client, reason);
      if (writeHold) await writeHold(client, "mapping_version_disable");
      await client.query(
        `update training_load.source_metric_mapping_versions
            set status = 'disabled', disabled_by_user_id = $2, disabled_at = clock_timestamp(), disabled_basis = $3, disable_reason = $4
          where id = $1`,
        [vId, ctx.userId, ctx.basis, reason],
      );
      await insertRequestRecord(client, { action: "mapping_status", mappingId: mId, mappingVersionId: vId, fromStatus: status, toStatus: "disabled", reason, ctx, operationId, requestKey, requestHash });
      return { mapping_id: mId, mapping_version_id: vId, operation_id: operationId };
    },
  });
}

// ---------------------------------------------------------------------------
// The machinery the canonical-variable admin service (M3-0,
// canonicalVariableAdminService.js) and the source-field verification service
// (M2b, sourceFieldVerificationService.js) share with M2: one bounded write and read
// discipline, one request-record rule, one right re-check under FOR SHARE, the
// same input checks and page cursors - never a second copy. Not a public API
// of the routes.
// ---------------------------------------------------------------------------
export const adminWriteKit = Object.freeze({
  runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, MESSAGES, plainObject, uuidField, boundedText, boundedOut,
  dec, decCmp, hashOf, encodeCursor, decodeCursor, cursorQuery, invalidCursor, ownerKeyOf, CURSOR_AT, LOWER_UUID, UUID,
  CANONICAL_VERSION_COLUMNS, canonicalParametersOf, notReadyCodeOf, REVISION_COLUMNS, revisionOut,
});
