// v80 (docs/ai/v80-condition-match-plan.md, section 1; the Rukovodilac's GO of 2026-11-19): the owner's confirmation of
// the team's event setting GPEXE shows for a GPEXE details event column (details.players.acceleration_events /
// deceleration_events). Such a count carries no threshold of its own; the column is matched to a variable with a
// condition only after a platform administrator, looking at GPEXE's team settings, enters the setting GPEXE shows and it
// equals the setting of the session the column was compared in (route O). The owner's step: two numbers and Confirm.
//
//   POST /fields/:fieldId/revisions/:revisionId/event-setting-confirmation  { requestKey, thresholdValue, durationSeconds }
//
// An active platform administrator in the platform workspace only; everyone else the identical 404 (ADR-006). One
// transaction: the request key (a replay answers the saved row; another body with the same key is request_key_reused),
// the acting user (the v35 setting, checked again by v80's guard), the revision FOR SHARE, the compared session's team
// setting, the insert. The row is append-only (v80).
import crypto from "node:crypto";
import { pool } from "./db.js";
import { mayVerify } from "./sourceFieldVerificationService.js";
import { conditionRuleFor, sourceRangeOf } from "./sourceConditionRules.js";
import { canonicalDecimal } from "./sourceMetricExtractors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/;
const CONTRACT = "source-event-setting/v1";
const STATEMENT_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
// The COMMIT's answer is awaited at most this long; after an error or that time the connection is closed and the row is
// looked for by its request key on another connection (the F2 rule of the reviewers' external-effect checks).
const COMMIT_WAIT_MS = 5_000;
const VERIFY_TIMEOUT_MS = 5_000;

// Test seam: runs right before the COMMIT is sent (null in production).
let beforeCommitForTests = null;
export function setEventSettingBeforeCommitForTests(fn) { beforeCommitForTests = fn ?? null; }

export class EventSettingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const NOT_FOUND = () => new EventSettingError(404, "not_found", "Not found.");
const refusal = (status, code, message) => new EventSettingError(status, code, message);

export const EVENT_SETTING_TEXT = Object.freeze({
  invalid_body: "Enter the threshold and the duration GPEXE shows for this team, as numbers.",
  not_an_event_column: "Only a GPEXE events value (acceleration or deceleration events) takes this confirmation.",
  not_compared: "Compare this value with GPEXE first; the confirmation is checked against the session you compared.",
  session_not_kept: "The session this value was compared in is no longer kept. Compare the value with GPEXE again first.",
  request_key_reused: "This request key was used for another confirmation.",
});
const differsText = (range) =>
  `GPEXE's setting for the session you compared is ${range.operator === ">=" ? "at or above" : "at or below"} ${range.value} m/s² lasting ${range.duration_seconds} s. Check the team's settings in GPEXE and enter what it shows.`;

function readBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw refusal(400, "invalid_body", EVENT_SETTING_TEXT.invalid_body);
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "durationSeconds,requestKey,thresholdValue") throw refusal(400, "invalid_body", EVENT_SETTING_TEXT.invalid_body);
  const text = (v) => (typeof v === "number" && Number.isFinite(v) ? canonicalDecimal(v) : typeof v === "string" ? v.trim() : null);
  const thresholdValue = text(body.thresholdValue);
  const durationSeconds = text(body.durationSeconds);
  if (typeof body.requestKey !== "string" || !UUID.test(body.requestKey) || !thresholdValue || !DECIMAL.test(thresholdValue)
      || !durationSeconds || !DECIMAL.test(durationSeconds) || durationSeconds.startsWith("-")) {
    throw refusal(400, "invalid_body", EVENT_SETTING_TEXT.invalid_body);
  }
  return { requestKey: body.requestKey.toLowerCase(), thresholdValue: canonicalDecimal(thresholdValue), durationSeconds: canonicalDecimal(durationSeconds) };
}

const answerOf = (row) => ({
  confirmation: {
    id: String(row.id), fieldId: String(row.source_metric_definition_id), revisionId: String(row.source_metric_version_id),
    event: row.event_kind, thresholdValue: row.threshold_value, durationSeconds: row.duration_seconds, confirmedAt: row.confirmed_at,
  },
});
const ROW = `id, source_metric_definition_id, source_metric_version_id, event_kind, trim_scale(threshold_value)::text as threshold_value,
  trim_scale(duration_seconds)::text as duration_seconds, confirmed_at, request_hash, confirmed_by_user_id`;

// The saved row of a request key, read on a connection of its own: a replay (the same writer and body) or a reused key.
async function savedAnswer(queryable, input, requestHash, ctx) {
  const saved = (await queryable.query(`select ${ROW} from training_load.source_metric_event_setting_confirmations where request_key = $1`, [input.requestKey])).rows[0];
  if (!saved) return null;
  if (saved.request_hash !== requestHash || String(saved.confirmed_by_user_id) !== String(ctx.userId)) {
    throw refusal(409, "request_key_reused", EVENT_SETTING_TEXT.request_key_reused);
  }
  return saved;
}

// After a COMMIT whose answer is lost or late: look the row up by its key on a new connection, bounded.
async function verifyAfterCommit(input, requestHash, ctx) {
  const client = await pool.connect();
  let broken = null;
  try {
    // A transaction-local bound: the pooled connection goes back without it (the DB re-review of v80).
    await client.query("begin read only");
    await client.query(`set local statement_timeout = '${VERIFY_TIMEOUT_MS}ms'`);
    const saved = await savedAnswer(client, input, requestHash, ctx);
    await client.query("rollback");
    return saved ? { status: 200, verified_after_commit_error: true, ...answerOf(saved) } : null;
  } catch (error) {
    await client.query("rollback").catch((e) => { broken = e; });
    throw error;
  } finally {
    client.release(broken ?? undefined);
  }
}

export async function confirmEventSetting({ ctx, fieldId: rawField, revisionId: rawRevision, body }) {
  if (!mayVerify(ctx)) throw NOT_FOUND();
  if (typeof rawField !== "string" || !UUID.test(rawField) || typeof rawRevision !== "string" || !UUID.test(rawRevision)) throw NOT_FOUND();
  const fieldId = rawField.toLowerCase();
  const revisionId = rawRevision.toLowerCase();
  const input = readBody(body);
  const requestHash = crypto.createHash("sha256").update(JSON.stringify({ contract: CONTRACT, fieldId, revisionId, thresholdValue: input.thresholdValue, durationSeconds: input.durationSeconds })).digest("hex");
  const client = await pool.connect();
  let broken = null;
  let commitSent = false;
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    // A replay: the same key answers the saved row (its writer's own), another body with it is refused.
    const saved = await savedAnswer(client, input, requestHash, ctx);
    if (saved) {
      await client.query("rollback");
      return { status: 200, ...answerOf(saved) };
    }
    await client.query(`select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [String(ctx.userId)]);
    // The revision (FOR SHARE: a retirement waits), of a GPEXE details events field, proven by its comparison (route O).
    const rev = (await client.query(
      `select r.id, r.state, r.parameter_kind, r.evidence_status, r.meaning_observation_id, d.source_system, d.api_family, d.source_metric_key
         from training_load.source_metric_definition_versions r
         join training_load.source_metric_definitions d on d.id = r.source_metric_definition_id
        where r.id = $1 and r.source_metric_definition_id = $2
          for share of r`,
      [revisionId, fieldId],
    )).rows[0];
    if (!rev || rev.source_system !== "gpexe" || rev.api_family !== "rest_v1") throw NOT_FOUND();
    const rule = conditionRuleFor(rev.source_metric_key);
    if (!rule || rule.kind !== "event" || rev.parameter_kind !== "none") throw refusal(409, "not_an_event_column", EVENT_SETTING_TEXT.not_an_event_column);
    if (rev.state !== "active" || rev.evidence_status !== "source_stated" || !rev.meaning_observation_id) throw refusal(409, "not_compared", EVENT_SETTING_TEXT.not_compared);
    // The compared session's team setting (route O's T9s session), while its bundle is kept.
    const session = (await client.query(
      `select c.raw_bundle -> 'teamThresholds' as thresholds
         from training_load.source_metric_confirmation_sessions s
         join training_load.gpexe_import_candidates c on c.id = s.candidate_id
        where s.confirmation_id = $1 and c.raw_purged_at is null and c.raw_expires_at > now()
        order by s.session_ordinal limit 1`,
      [rev.meaning_observation_id],
    )).rows[0];
    const read = sourceRangeOf(rule, session?.thresholds ?? null);
    if (!read || !read.setId) throw refusal(409, "session_not_kept", EVENT_SETTING_TEXT.session_not_kept);
    if (read.range.value !== input.thresholdValue || read.range.duration_seconds !== input.durationSeconds) {
      throw refusal(409, "setting_differs", differsText(read.range));
    }
    const row = (await client.query(
      `insert into training_load.source_metric_event_setting_confirmations
         (source_metric_definition_id, source_metric_version_id, event_kind, threshold_value, duration_seconds,
          observation_confirmation_id, threshold_set_id, confirmed_by_user_id, request_key, request_hash)
       values ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9, $10)
       returning ${ROW}`,
      [fieldId, revisionId, rule.event, input.thresholdValue, input.durationSeconds, rev.meaning_observation_id, read.setId, ctx.userId, input.requestKey, requestHash],
    )).rows[0];
    if (beforeCommitForTests) await beforeCommitForTests(client);
    commitSent = true;
    let timer;
    try {
      await Promise.race([
        client.query("commit"),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("commit_wait_exceeded"), { code: "commit_wait_exceeded" })), COMMIT_WAIT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { status: 201, ...answerOf(row) };
  } catch (error) {
    if (commitSent) {
      // The COMMIT was sent: never "nothing was written". This connection is not reused; the row is looked for by its key.
      broken = error;
      const verified = await verifyAfterCommit(input, requestHash, ctx).catch((e) => (e instanceof EventSettingError ? Promise.reject(e) : null));
      if (verified) return verified;
      throw refusal(503, "outcome_unknown", "We could not confirm whether this was saved. Check again with the same request.");
    }
    await client.query("rollback").catch((e) => { broken = e; });
    if (error instanceof EventSettingError) throw error;
    if (["55P03", "40P01", "57014"].includes(error?.code)) throw refusal(409, "try_again", "Someone else is changing this field now. Try again.");
    // A concurrent request with the same key committed first: its row is the answer (a replay), or the key is reused.
    if (error?.code === "23505") {
      const verified = await verifyAfterCommit(input, requestHash, ctx);
      if (verified) return { status: 200, confirmation: verified.confirmation };
      throw refusal(409, "request_key_reused", EVENT_SETTING_TEXT.request_key_reused);
    }
    // The database's own refusal of the actor (a right lost since the request began): the identical 404.
    if (error?.code === "42501") throw NOT_FOUND();
    throw error;
  } finally {
    client.release(broken ?? undefined);
  }
}
