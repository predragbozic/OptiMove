// K4b: an athlete changes their own external (calendar) RPE answer while the
// question is open (contract docs/ai/central-calendar-k4b-contract.md, migration
// v83). The decision and every write are the sanctioned database function
// training_load.change_external_rpe(); this module only runs it in one bounded
// transaction and maps its outcome:
//   1. BEGIN; lock_timeout 5 s, statement_timeout 10 s (55P03 / 40P01 / 57014 →
//      409 try_again, nothing written)
//   2. the function (users first, then the submit's own lock order, the window
//      at the clock under the locks, the requestKey replay, the history row and
//      the change); any outcome but 'changed' wrote nothing and is rolled back
//   3. a bounded COMMIT (the roster commands' discipline): an answer within
//      15 s, else the history row of the request key is looked for on a new
//      connection for 5 s → 200 with verifiedAfterCommitError, or 503
//      outcome_unknown — never "nothing was saved" after a sent COMMIT
//   4. after a confirmed (or verified) COMMIT only: the realtime event
//      training_load_changed, the submit's event, to the athlete's user.
import { pool } from "./db.js";
import { emitRealtimeEvent } from "./realtime.js";
import {
  COMMIT_ANSWER_TIMEOUT_MS, commitCertainlyRefused, NOTHING_SAVED, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS, withinBound,
} from "./activityRosterCommands.js";

export const LOCK_TIMEOUT = "5s";
export const STATEMENT_TIMEOUT = "10s";

export const NOT_FOUND = Object.freeze({ error: "not_found", message: "Training session not found." });
export const ANSWER_LOCKED = "This answer can no longer be changed. The question is closed.";
export const NOT_ANSWERED = "There is no answer to change yet.";
export const ANSWER_CHANGED = "Your answer was changed on another screen. Check it and try again.";
export const OUTCOME_UNKNOWN_SENTENCE = "We can't tell yet whether your change was saved.";
export const REQUEST_KEY_REUSED = "This requestKey was already used for a different change.";

// Test seams: commit(client), commitTimeoutMs, checkTimeoutMs, checkFault(),
// emit(userId, event, payload), afterFunction(client).
export const testHooks = {};

export function formatChangedFeedback(state) {
  if (!state) return null;
  return {
    rpe: state.rpe,
    durationMinutes: state.durationMinutes,
    srpe: state.srpe,
    note: state.note || "",
    submittedAt: state.submittedAt,
    revision: state.revision,
    lastChangedAt: state.lastChangedAt,
    closesAt: state.closesAt,
  };
}

function emit(userId, assignmentId) {
  try {
    (testHooks.emit || emitRealtimeEvent)(userId, "training_load_changed", { externalAssignmentId: assignmentId });
  } catch (error) {
    console.error(`[rpe-change] realtime event after the COMMIT failed: ${error?.message}`);
  }
}

function mapOutcome(result) {
  const feedback = formatChangedFeedback(result.feedback);
  switch (result.outcome) {
    case "changed": return { status: 200, body: { outcome: "changed", feedback } };
    case "unchanged": return { status: 200, body: { outcome: "unchanged", feedback } };
    case "replayed": return { status: 200, body: { outcome: "replayed", feedback } };
    default: break;
  }
  switch (result.code) {
    case "not_answered": return { status: 409, body: { error: "not_answered", message: NOT_ANSWERED } };
    case "window_closed": return { status: 409, body: { error: "answer_locked", message: ANSWER_LOCKED, feedback } };
    case "answer_changed": return { status: 409, body: { error: "answer_changed", message: ANSWER_CHANGED, feedback } };
    case "request_key_reused": return { status: 409, body: { error: "request_key_reused", message: REQUEST_KEY_REUSED } };
    case "invalid": return { status: 400, body: { error: "invalid", message: "The change is not valid." } };
    default: return { status: 404, body: NOT_FOUND };
  }
}

// Is the change of this request key committed? Bounded as a whole on a new
// connection. Returns the answer's state, or null.
async function findCommittedChange({ userId, assignmentId, requestKey }) {
  const ms = testHooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS;
  const deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now());
  const connecting = pool.connect();
  let checker;
  try {
    checker = await withinBound(connecting, left());
  } catch (error) {
    connecting.then((late) => late.release(true)).catch(() => {});
    throw error;
  }
  let broken = false;
  try {
    if (testHooks.checkFault) await testHooks.checkFault();
    const row = (await withinBound(checker.query(
      `select training_load.rpe_change_state(h.session_feedback_id) as state
         from training_load.session_feedback_changes h
        where h.external_assignment_id = $1 and h.changed_by_user_id = $2 and h.request_key = $3`,
      [assignmentId, userId, requestKey],
    ), left())).rows[0];
    return row ? row.state : null;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    checker.release(broken ? true : undefined);
  }
}

// { userId, assignmentId, requestKey, rpe, durationMinutes, note, expectedRevision } → { status, body }
export async function changeExternalRpe(input) {
  const { userId, assignmentId, requestKey, rpe, durationMinutes, note, expectedRevision } = input;
  const client = await pool.connect();
  let commitSent = false;
  let broken = false;
  let released = false;
  const onClientError = () => { broken = true; };
  client.on("error", onClientError);
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const result = (await client.query(
      `select training_load.change_external_rpe($1, $2, $3, $4, $5, $6, $7) as r`,
      [userId, assignmentId, requestKey, rpe, durationMinutes, note, expectedRevision ?? null],
    )).rows[0].r;
    if (testHooks.afterFunction) await testHooks.afterFunction(client, result);
    if (result.outcome !== "changed") {
      await client.query("rollback").catch(() => { broken = true; });
      return mapOutcome(result);
    }
    commitSent = true;
    const committing = Promise.resolve().then(() => (testHooks.commit ? testHooks.commit(client) : client.query("commit")));
    committing.catch(() => {});
    await withinBound(committing, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    emit(userId, assignmentId);
    return mapOutcome(result);
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (["55P03", "40P01", "57014"].includes(error?.code)) {
        return { status: 409, body: { error: "try_again", message: NOTHING_SAVED } };
      }
      // The function and the history guard each read the clock; at the very edge of closes_at the function can pass
      // and the guard refuse. Nothing was written: the same answer as a closed window.
      if (error?.code === "23514" && /: the question is closed$/.test(String(error?.message))) {
        return { status: 409, body: { error: "answer_locked", message: ANSWER_LOCKED } };
      }
      throw error;
    }
    console.error(`[rpe-change] commit failed: ${error?.code ?? ""} ${error?.message}`);
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      return { status: 500, body: { error: "internal_error", message: NOTHING_SAVED } };
    }
    released = true;
    client.removeListener("error", onClientError);
    client.on("error", () => {});
    client.release(true);
    let state = null;
    try {
      state = await findCommittedChange({ userId, assignmentId, requestKey });
    } catch (checkError) {
      console.error(`[rpe-change] checking a change after an unconfirmed COMMIT failed: ${checkError?.message}`);
    }
    if (state) {
      emit(userId, assignmentId);
      return { status: 200, body: { outcome: "changed", feedback: formatChangedFeedback(state), verifiedAfterCommitError: true } };
    }
    return { status: 503, body: { error: "outcome_unknown", message: OUTCOME_UNKNOWN_SENTENCE } };
  } finally {
    if (!released) {
      client.removeListener("error", onClientError);
      client.release(broken ? true : undefined);
    }
  }
}
