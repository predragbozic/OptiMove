// Maintaining the unit conversions (phase 7c, J9): an active platform admin,
// in the platform workspace, creates an active conversion of an ordered unit
// pair or retires one (training_load.unit_conversions, v34 D5). There is no
// edit: a row is immutable, and a correction is a retirement followed by a new
// conversion. A retirement changes no mapping version - a version keeps its own
// copy of the factors (D5, C34). Contract:
// docs/ai/phase7c-unit-conversions-contract.md (accepted 2026-10-30).
//
// Every write is one bounded transaction of M2's machinery (adminWriteKit):
// the per-user advisory lock, the request record looked up before any row lock
// (the write's own T8 audit row, unit_conversion_create / _retire; a replay
// answers the current state after the right is checked again; the same key
// with another request is request_key_reused), the acting user as the v35
// transaction-local setting before the first write (the v47 guards require
// it), the right and the user FOR SHARE, and a bounded COMMIT whose lost answer
// is verified on another connection by the request record. Lock order (D, v34
// header: unit_conversions first, the acting user's rows last): the advisory
// lock -> the request record -> the pair's active row FOR SHARE (create) or the
// row FOR NO KEY UPDATE (retire) -> the role and user rows FOR SHARE -> the
// INSERT or UPDATE -> the T8 row -> the COMMIT (v47's deferred audit links).
//
// The numbers arrive as exact decimal text and stay decimal text: no binary
// floating-point number ever holds a factor. An answer never carries an acting
// user, a retirement reason or a seed marker's file name (C63).
import {
  adminWriteKit, canonicalDecimal, classifyDatabaseError, isNormalFormPair, SourceMetricMappingError,
} from "./sourceMetricMappingService.js";
import { evidenceRefOk } from "./sourceFieldVerificationService.js";
import { unitTokenOk } from "./metricTextRules.js";

const {
  runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, MESSAGES, plainObject, uuidField, boundedText, hashOf, UUID,
  encodeCursor, decodeCursor, cursorQuery, invalidCursor, LOWER_UUID,
} = adminWriteKit;

// GET /conversions answers in pages of this size (C68): the API grows the
// list, so a fixed cap would break the read at the next conversion.
export const CONVERSION_PAGE_SIZE = 100;
// R1: a number is at most 40 characters of text.
const NUMBER_MAX_LENGTH = 40;
// Plain decimal notation: no exponent, no '+', no leading zero.
const NUMBER_TEXT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

const TEXT = {
  invalid_unit: "The unit is not a unit token (1-30 characters, no space, '|' or '=').",
  invalid_evidence_ref: "evidenceRef is a repository path under docs/ with one heading anchor (docs/...#anchor), at most 300 characters.",
  units_equal: "fromUnit and toUnit differ; equal units need no conversion.",
  conversion_not_normal_form: "A factor is stored as (decimal, 1), or as (1, d) only when 1/d is not a terminating decimal; write 3.6 as (3.6, 1) and 1/60 as (1, 60).",
  conversion_exists: "An active conversion of this unit pair already exists; retire it first.",
  conversion_not_active: "The conversion is already retired.",
  expected_state: "expectedState is active: the state of the conversion this request retires.",
  reason: "reason is one line of 1-500 characters.",
};

// Q1: conversions are global (D5 has no owner), so their writes are an active
// platform admin's in the platform workspace only, the same predicate as M2b's
// mayVerify. Every other caller of a write route gets the identical 404 - the
// router asks this before it looks at the body, and each write asks it again.
export const mayMaintainConversions = (ctx) => ctx?.basis === "platform_admin" && ctx?.owner?.scope === "system";

// ---------------------------------------------------------------------------
// Read: the active conversions, in pages.
// ---------------------------------------------------------------------------
const CONVERSION_COLUMNS = `id, from_unit, to_unit, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as scale_divisor,
            trim_scale("offset")::text as "offset", evidence_ref, state, (seed_migration is not null) as seeded, created_at, retired_at`;
const listItem = (r) => ({
  id: r.id, fromUnit: r.from_unit, toUnit: r.to_unit, scale: r.scale, scaleDivisor: r.scale_divisor, offset: r.offset,
  evidenceRef: r.evidence_ref, seeded: r.seeded,
});
const conversionOut = (r) => ({ ...listItem(r), state: r.state, createdAt: r.created_at, retiredAt: r.retired_at });

// The cursor names the last row of a page by its id only: rows are never
// deleted (v34), so the id always finds the row's position in the order.
function conversionsCursorPosition(text) {
  const p = decodeCursor(text, "i,k,v");
  if (p.k !== "conversions" || typeof p.i !== "string" || !LOWER_UUID.test(p.i)) throw invalidCursor();
  return { id: p.i };
}

// GET /conversions - M2's audience (adminContext): the active rows only, in
// the byte order of the units, then the id; one page, the next after the
// cursor's row.
export async function listConversions({ ctx, query }) {
  void ctx;
  const after = cursorQuery(query, conversionsCursorPosition);
  return boundedRead(async (client) => {
    if (after && (await client.query(`select 1 from training_load.unit_conversions where id = $1`, [after.id])).rowCount === 0) throw invalidCursor();
    const rows = (await client.query(
      `select ${CONVERSION_COLUMNS}
         from training_load.unit_conversions c
        where c.state = 'active'
          and ($1::uuid is null or (c.from_unit collate "C", c.to_unit collate "C", c.id)
                > (select p.from_unit collate "C", p.to_unit collate "C", p.id from training_load.unit_conversions p where p.id = $1::uuid))
        order by c.from_unit collate "C", c.to_unit collate "C", c.id
        limit $2`,
      [after ? after.id : null, CONVERSION_PAGE_SIZE + 1],
    )).rows;
    const page = rows.slice(0, CONVERSION_PAGE_SIZE);
    const nextCursor = rows.length > CONVERSION_PAGE_SIZE ? encodeCursor({ v: 1, k: "conversions", i: page[page.length - 1].id }) : null;
    return { conversions: page.map(listItem), nextCursor };
  });
}

// ---------------------------------------------------------------------------
// Writes: create and retire.
// ---------------------------------------------------------------------------
// The write's own T8 audit row is the request record (D10): one key space with
// M2's other writes, so a key used for another operation is request_key_reused.
const CONVERSION_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, unit_conversion_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
const conversionIdsOf = (written) => ({ conversionId: written.unit_conversion_id ?? null });

// Only the allowlisted database refusals become a 4xx; everything else is a
// sanitized 500 (logged by its code only, by the router). v47's own guards and
// deferred links are backstops of a writer that should never meet them: a 500.
export function classifyConversionError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  if (error?.code === "23505" && error.constraint === "unit_conversions_one_active_pair") {
    return refusal(409, "conversion_exists", TEXT.conversion_exists);
  }
  if (error?.code === "23514" && error.constraint === "unit_conversions_units_are_tokens") return refusal(400, "invalid_unit", TEXT.invalid_unit);
  if (error?.code === "23514" && error.constraint === "unit_conversions_factors_normal_form") {
    return refusal(400, "conversion_not_normal_form", TEXT.conversion_not_normal_form);
  }
  if (error?.code === "23505" && error.constraint === "source_metric_audit_one_request_per_operation") return refusal(409, "try_again", MESSAGES.try_again);
  // try_again (55P03, 40P01, 57014, a request record taken meanwhile) and v34's
  // three exact actor texts (the identical 404), as every M2 write maps them.
  return classifyDatabaseError(error);
}

// A write's answer and a replay: the conversion as it is now.
async function conversionAnswer(executor, conversionId) {
  const row = (await executor.query(`select ${CONVERSION_COLUMNS} from training_load.unit_conversions where id = $1`, [conversionId])).rows[0];
  return row ? { conversion: conversionOut(row) } : null;
}

// The database's own rules, once more inside the write (the JavaScript twins
// decided before any lock; they must agree).
async function databaseAgrees(client, { fromUnit, toUnit, scale, scaleDivisor, evidenceRef }) {
  const row = (await client.query(
    `select training_load.source_metric_unit_token_ok($1) and training_load.source_metric_unit_token_ok($2) as units,
            training_load.source_metric_evidence_ref_ok($3) as evidence,
            training_load.source_metric_factor_pair_normal($4::numeric, $5::numeric) as normal`,
    [fromUnit, toUnit, evidenceRef, scale, scaleDivisor],
  )).rows[0];
  if (row.units !== true) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
  if (row.evidence !== true) throw refusal(400, "invalid_evidence_ref", TEXT.invalid_evidence_ref);
  if (row.normal !== true) throw refusal(400, "conversion_not_normal_form", TEXT.conversion_not_normal_form);
}

async function insertAuditRow(client, { action, conversionId, fromStatus = null, toStatus, reason = null, evidenceRef = null, ctx, operationId, requestKey, requestHash }) {
  await client.query(
    `insert into training_load.source_metric_audit
       (action, unit_conversion_id, from_status, to_status, reason, evidence_ref, performed_by_user_id, basis, operation_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, $7, 'platform_admin', $8, $9, $10)`,
    [action, conversionId, fromStatus, toStatus, reason, evidenceRef, ctx.userId, operationId, requestKey, requestHash],
  );
}

// Test seams (never set by the application): `writeHold` runs inside a write
// after every lock is taken and every check passed, right before the INSERT
// or UPDATE; `skipPreRead` leaves the create's locked pre-read out, so a
// concurrent create meets the unique index; `skipAudit` leaves the T8 row out,
// so v47's deferred link refuses the COMMIT.
let writeHold = null;
let skipPreRead = false;
let skipAudit = false;
export function setConversionWriteHoldForTests(fn) { writeHold = fn ?? null; }
export function setConversionSeamsForTests({ skipPreRead: noPreRead = false, skipAudit: noAudit = false } = {}) {
  skipPreRead = noPreRead;
  skipAudit = noAudit;
}

// One factor of the body: exact decimal text, 1-40 characters, a value equal
// to zero carries no sign. The sentence names the field, never the value.
function factorField(body, name, { positive }) {
  const value = body[name];
  if (typeof value !== "string" || value.length > NUMBER_MAX_LENGTH || !NUMBER_TEXT.test(value)) {
    throw refusal(400, "invalid_body", `${name} is a decimal string: digits with an optional point, no exponent, '+' or leading zero, at most 40 characters.`);
  }
  const canonical = canonicalDecimal(value);
  if (canonical === "0" && value.startsWith("-")) throw refusal(400, "invalid_body", `${name} is zero without a sign.`);
  if (positive && (canonical === "0" || canonical.startsWith("-"))) throw refusal(400, "invalid_body", `${name} is greater than zero.`);
  return canonical;
}

// POST /conversions
export async function createConversion({ ctx, body }) {
  if (!mayMaintainConversions(ctx)) throw NOT_FOUND();
  const keys = ["requestKey", "fromUnit", "toUnit", "scale", "scaleDivisor", "offset", "evidenceRef"];
  plainObject(body, keys, keys);
  const requestKey = uuidField(body.requestKey);
  if (!unitTokenOk(body.fromUnit) || !unitTokenOk(body.toUnit)) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
  const { fromUnit, toUnit } = body;
  if (fromUnit === toUnit) throw refusal(400, "invalid_body", TEXT.units_equal);
  const scale = factorField(body, "scale", { positive: true });
  const scaleDivisor = factorField(body, "scaleDivisor", { positive: true });
  const offset = factorField(body, "offset", { positive: false });
  if (!isNormalFormPair(scale, scaleDivisor)) throw refusal(400, "conversion_not_normal_form", TEXT.conversion_not_normal_form);
  if (!evidenceRefOk(body.evidenceRef)) throw refusal(400, "invalid_evidence_ref", TEXT.invalid_evidence_ref);
  const evidenceRef = body.evidenceRef;
  const action = "unit_conversion_create";
  // The numbers in their canonical text: "3.60" and "3.6" are one request.
  const requestHash = hashOf({ op: action, fromUnit, toUnit, scale, scaleDivisor, offset, evidenceRef });
  return runWrite({
    ctx, where: action, requestKey, requestHash, action, requests: CONVERSION_REQUESTS, classify: classifyConversionError, idsOf: conversionIdsOf,
    reread: (executor, record) => conversionAnswer(executor, record.unit_conversion_id),
    body: async (client, operationId) => {
      // The pair's active row FOR SHARE: it waits for a retirement in flight
      // and, under READ COMMITTED, then finds it retired.
      const existing = skipPreRead ? null : (await client.query(
        `select ${CONVERSION_COLUMNS} from training_load.unit_conversions where from_unit = $1 and to_unit = $2 and state = 'active' for share`,
        [fromUnit, toUnit],
      )).rows[0];
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      // A current row only once the right is confirmed again (the 7b rule).
      if (existing) throw refusal(409, "conversion_exists", TEXT.conversion_exists, { current: conversionOut(existing) });
      await databaseAgrees(client, { fromUnit, toUnit, scale, scaleDivisor, evidenceRef });
      if (writeHold) await writeHold(client, action);
      const conversionId = (await client.query(
        `insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", evidence_ref, created_by_user_id)
         values ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6, $7) returning id`,
        [fromUnit, toUnit, scale, scaleDivisor, offset, evidenceRef, ctx.userId],
      )).rows[0].id;
      if (!skipAudit) {
        await insertAuditRow(client, { action, conversionId, toStatus: "active", evidenceRef, ctx, operationId, requestKey, requestHash });
      }
      return { operation: action, unit_conversion_id: conversionId };
    },
  });
}

// POST /conversions/:conversionId/retire
export async function retireConversion({ ctx, conversionId: rawId, body }) {
  if (!mayMaintainConversions(ctx)) throw NOT_FOUND();
  if (typeof rawId !== "string" || !UUID.test(rawId)) throw NOT_FOUND();
  const conversionId = rawId.toLowerCase();
  const keys = ["requestKey", "expectedState", "reason"];
  plainObject(body, keys, keys);
  const requestKey = uuidField(body.requestKey);
  if (body.expectedState !== "active") throw refusal(400, "invalid_body", TEXT.expected_state);
  if (!boundedText(body.reason, 500)) throw refusal(400, "invalid_body", TEXT.reason);
  const reason = body.reason;
  const action = "unit_conversion_retire";
  const requestHash = hashOf({ op: action, conversionId, expectedState: "active", reason });
  return runWrite({
    ctx, where: action, requestKey, requestHash, action, requests: CONVERSION_REQUESTS, classify: classifyConversionError, idsOf: conversionIdsOf,
    reread: (executor, record) => conversionAnswer(executor, record.unit_conversion_id),
    body: async (client, operationId) => {
      // The row FOR NO KEY UPDATE: it conflicts with an activation's or a
      // draft's FOR SHARE on it, so either waits for the other.
      const row = (await client.query(`select ${CONVERSION_COLUMNS} from training_load.unit_conversions where id = $1 for no key update`, [conversionId])).rows[0];
      if (!row) throw NOT_FOUND();
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (row.state !== "active") throw refusal(409, "conversion_not_active", TEXT.conversion_not_active, { current: conversionOut(row) });
      // The database's text rule, once more inside the write (its twin decided
      // before any lock).
      if ((await client.query(`select training_load.source_metric_text_ok($1, 500) as ok`, [reason])).rows[0].ok !== true) {
        throw refusal(400, "invalid_body", TEXT.reason);
      }
      if (writeHold) await writeHold(client, action);
      // retired_at is the transaction's time, now() - never clock_timestamp():
      // v47 refuses any other (23514).
      await client.query(
        `update training_load.unit_conversions
            set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = $3
          where id = $1`,
        [conversionId, ctx.userId, reason],
      );
      if (!skipAudit) {
        await insertAuditRow(client, { action, conversionId, fromStatus: "active", toStatus: "retired", reason, ctx, operationId, requestKey, requestHash });
      }
      return { operation: action, unit_conversion_id: conversionId };
    },
  });
}
