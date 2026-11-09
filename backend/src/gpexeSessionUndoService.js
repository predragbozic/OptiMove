// U5 (J19-U5, migration v57): the in-app undo of one imported GPEXE session.
//
// The removal itself is the database function training_load.undo_imported_session (it derives the acting user's right
// itself, takes the locks in the fixed order written in its header, removes what the maintenance CLI removes without
// disabling any trigger, writes one deletion-log row and one request row, marks the imported candidate undone and writes
// a fresh pending candidate when the snapshot is still available). This module calls it in a bounded transaction, turns
// its refusals into stable codes and sentences, and - after the COMMIT - recomputes the fresh candidate's preview.
//
//   * preview (undoPreview): the same function in a transaction that is ALWAYS rolled back - exactly the statements the
//     undo would run (the CLI's dry run); nothing is kept.
//   * undo (undoImport): requestKey (a UUID chosen by the client for this one undo) makes it idempotent; the COMMIT is
//     awaited at most 15 s and once sent the answer never says "nothing was removed": an unanswered one is
//     `503 outcome_unknown`, and repeating the same request returns the saved outcome.
// The first version is for an active platform admin only (J19-U5 section 9, Q1); the route decides the audience.
import { pool } from "./db.js";
import { GpexeImportServiceError } from "./gpexeImportService.js";
import { buildCandidatePreview } from "./gpexeImportPreview.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_BOUND_MS = 15_000;
let commitBoundMs = COMMIT_BOUND_MS;
let commitFault = null;
let beforeCommitHook = null;
let previewFault = null;
export function setUndoCommitBoundForTests(ms, fault = null) {
  commitBoundMs = ms ?? COMMIT_BOUND_MS;
  commitFault = fault;
}
export function setUndoBeforeCommitForTests(fn) { beforeCommitHook = fn ?? null; }
export function setUndoPreviewFaultForTests(fn) { previewFault = fn ?? null; }

function refusal(status, code, message, details) {
  const error = new GpexeImportServiceError(status, code, message);
  if (details) error.details = details;
  return error;
}

// One sentence per refusal of the function: what to remove or do first.
const SENTENCES = {
  candidate_not_found: [404, "Not found."],
  candidate_not_imported: [409, "This session has not been imported, so there is nothing to undo."],
  already_undone: [409, "This import was already undone."],
  approval_missing: [409, "The record of this import's approval is missing; contact a platform administrator."],
  event_mismatch: [409, "The stored import is not the one you reviewed. Open the session again."],
  event_missing: [409, "The imported data of this session is no longer there."],
  event_team_mismatch: [409, "The stored import does not belong to this team; contact a platform administrator."],
  event_session_mismatch: [409, "The stored import does not match this session; contact a platform administrator."],
  two_events_for_session: [409, "Two imports exist for this session. They have to be resolved by a platform administrator first."],
  manual_occasion: [409, "Some results of this session were corrected by hand. Removing hand-entered values is a separate decision."],
  shared_activity: [409, "This session's activity also holds data from another source, so it cannot be removed here."],
  other_event_link: [409, "This session's activity is also linked to another event, so it cannot be removed here."],
  entangled_activity: [409, "This session's activity was merged or moved, so it cannot be removed here."],
  // v60 (O1): roster work never blocks the undo. A coach's later work needs an explicit confirmation of the list shown.
  roster_work_needs_confirmation: [409, "A coach has changed attendance states or completion on this session since the import. Confirm the list to remove it with the import."],
  roster_work_changed: [409, "The coach's work on this session changed after you looked at it. Nothing was removed; review the list again."],
  roster_work_too_large: [409, "This session carries more roster decisions than can be listed in the log. Contact a platform administrator."],
  calendar_link_exists: [409, "This session is attached to a calendar event. Remove it from the calendar event first, then undo the import."],
  manual_write_request_exists: [409, "A manual entry refers to this session's data, so it cannot be removed here."],
  referenced_elsewhere: [409, "Other records still refer to this session's data. Nothing was removed."],
  request_key_reused: [409, "This request key was used for a different undo. Start the undo again."],
  invalid_reason: [400, "A reason of 1 to 500 characters without control characters is required."],
};

function parseDetail(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const COUNT_KEYS = ["decisions", "requests", "completions", "completionLog"];
const FINGERPRINT = /^[0-9a-f]{32}$/;
export const ROSTER_LIST_LIMIT = 60;

function countBlock(block) {
  const out = {};
  for (const key of COUNT_KEYS) out[key] = Number.isInteger(block?.[key]) && block[key] >= 0 ? block[key] : 0;
  return out;
}

// What the answer carries of the roster work: counts, the first ROSTER_LIST_LIMIT later decisions (ids and codes, never a note)
// and the fingerprint of the whole list (the confirmation sends it back). The database's list is bounded at 500.
export function projectRosterWork(work) {
  if (!work || typeof work !== "object") return null;
  const list = Array.isArray(work.laterDecisions) ? work.laterDecisions : [];
  return {
    importWritten: countBlock(work.importWritten),
    later: countBlock(work.later),
    laterDecisions: list.slice(0, ROSTER_LIST_LIMIT).map((d) => ({
      athleteId: String(d.athleteId), kind: String(d.kind), reasonCode: d.reasonCode == null ? null : String(d.reasonCode),
      decidedByUserId: String(d.decidedByUserId), decidedAt: String(d.decidedAt),
    })),
    laterDecisionsTotal: Number.isInteger(work.laterDecisionsTotal) ? work.laterDecisionsTotal : list.length,
    ...(typeof work.fingerprint === "string" && FINGERPRINT.test(work.fingerprint) ? { fingerprint: work.fingerprint } : {}),
  };
}

function mapDatabaseError(error) {
  if (error instanceof GpexeImportServiceError) return error;
  const message = String(error?.message || "");
  if (error?.code === "55000" && message.startsWith("session_undo:")) {
    const code = message.slice("session_undo:".length).trim();
    const known = SENTENCES[code];
    if (!known) return refusal(409, "undo_refused", "The undo was refused; nothing was changed.");
    const details = {};
    if (code === "roster_work_needs_confirmation" || code === "roster_work_changed" || code === "roster_work_too_large") {
      const work = projectRosterWork(parseDetail(error.detail));
      if (work) details.rosterWork = work;
    }
    // The constraint that stopped the removal is for the server log only (an administrator's support trail), never the answer.
    if (code === "referenced_elsewhere") console.error(`[gpexe] undo refused: referenced elsewhere (${String(error.detail || "unknown").slice(0, 120)})`);
    if (code === "calendar_link_exists" && error.detail && /^\d+$/.test(error.detail)) details.calendarLinks = Number(error.detail);
    return refusal(known[0], known[0] === 404 ? "notFound" : code, known[1], Object.keys(details).length ? details : undefined);
  }
  // The acting user's right was lost (or never held): the identical 404.
  if (error?.code === "42501") {
    // The identical 404 for a lost right; any other 42501 (a marker guard) is an integrity fault an operator must see.
    if (!/^user .* may not undo an imported session/.test(message)) console.error(`[gpexe] undo: unexpected 42501 (${message.slice(0, 80)})`);
    return refusal(404, "notFound", "Not found.");
  }
  if (error?.code === "22023") return refusal(400, "invalid_request", "Check the values sent.");
  if (error?.code === "55P03" || error?.code === "40P01" || error?.code === "57014") {
    return refusal(409, "try_again", "Another change was running; nothing was removed. Try again in a moment.");
  }
  return null;
}

async function inTransaction(fn, { keep }) {
  const client = await pool.connect();
  let released = false;
  const onError = () => {};
  client.on("error", onError);
  try {
    await client.query("begin isolation level read committed");
    // Bounded before the first lock (the importer's own bounds are 5 s / 10 s / 10 s).
    await client.query("select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '20s', true), set_config('idle_in_transaction_session_timeout', '15s', true)");
    const result = await fn(client);
    if (!keep) {
      await client.query("rollback");
      return result;
    }
    if (beforeCommitHook) await beforeCommitHook(client);
    let timer;
    const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("commit_unanswered"), { commitUnanswered: true })), commitBoundMs); });
    try {
      await Promise.race([commitFault ? commitFault(client) : client.query("commit"), bound]);
    } catch (error) {
      // No answer in time, or an error that is not a PostgreSQL error response (a dropped connection): the server may have
      // committed. Only an explicit PostgreSQL error (a five-character SQLSTATE) says the COMMIT did not happen.
      const answeredByServer = typeof error?.code === "string" && error.code.length === 5 && !error.commitUnanswered;
      if (!answeredByServer) {
        // Once the COMMIT was sent the answer is never "nothing was removed".
        client.release(true);
        released = true;
        throw refusal(503, "outcome_unknown", "The result is not confirmed: the server did not answer in time. Check the result with the same request before trying again.", { retrySameRequest: true });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return result;
  } catch (error) {
    if (!released) { try { await client.query("rollback"); } catch { client.release(true); released = true; } }
    throw error;
  } finally {
    client.off("error", onError);
    if (!released) client.release();
  }
}

function shapeResult(row) {
  return {
    eventId: row.event_id,
    removedCounts: row.removed_counts,
    removedTotal: row.removed_total,
    deletionLogId: row.deletion_log_id,
    newCandidateId: row.new_candidate_id ?? null,
    // Every candidate the undo marked undone: the requested one and any other approved version of the session (one event).
    undoneCandidateIds: row.undone_candidate_ids ?? [],
    // v60: what the roster held (counts, and the later decisions' list), so the screen can say what went with the session.
    rosterWork: projectRosterWork(row.roster_work),
  };
}

// The read-only scope: what the undo would remove, or the refusal it would raise. Nothing is kept.
export async function undoPreview(teamId, candidateId, { userId }) {
  try {
    return await inTransaction(async (client) => {
      if (previewFault) await previewFault(client);
      const row = (await client.query(
        `select * from training_load.undo_imported_session($1, $2, $3, gen_random_uuid(), 'preview', null, 'preview')`,
        [userId, teamId, candidateId],
      )).rows[0];
      const shaped = { ...shapeResult(row), wouldOfferAgain: Boolean(row.new_candidate_id) };
      // The list of a coach's later decisions names the athletes (an administrator reads it before confirming; ids mean nothing).
      const ids = [...new Set((shaped.rosterWork?.laterDecisions || []).map((d) => d.athleteId))];
      if (ids.length) {
        const names = new Map((await client.query(
          `select id, coalesce(nullif(display_name, ''), full_name) as name from public.athletes where id = any($1::uuid[])`, [ids],
        )).rows.map((r) => [String(r.id), r.name]));
        shaped.rosterWork.laterDecisions = shaped.rosterWork.laterDecisions.map((d) => ({ ...d, athleteName: names.get(d.athleteId) ?? null }));
      }
      return shaped;
    }, { keep: false });
  } catch (error) {
    const mapped = mapDatabaseError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

function checkBody({ requestKey, reason, expectedEventId, confirmRosterFingerprint }) {
  if (confirmRosterFingerprint !== undefined && confirmRosterFingerprint !== null && (typeof confirmRosterFingerprint !== "string" || !FINGERPRINT.test(confirmRosterFingerprint))) {
    throw refusal(400, "invalid_request", "confirmRosterFingerprint must be the fingerprint the review showed.");
  }
  if (typeof requestKey !== "string" || !UUID.test(requestKey)) throw refusal(400, "invalid_request", "requestKey must be a UUID chosen for this one undo.");
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw refusal(400, "invalid_request", "A reason of 1 to 500 characters without control characters is required.");
  }
  if (expectedEventId !== undefined && expectedEventId !== null && (typeof expectedEventId !== "string" || !UUID.test(expectedEventId))) {
    throw refusal(400, "invalid_request", "expected.eventId must be a UUID.");
  }
}

// After the COMMIT: the fresh candidate was written without a preview (the preview needs the team's mapping context). Best
// effort - a failure leaves the candidate without a preview hash, which cannot be approved, and the next search recomputes it.
async function refreshOfferedPreview(teamId, candidateId, userId) {
  try {
    const row = (await pool.query(
      `select c.id, c.raw_bundle, c.last_seen_check_id, k.source_path, k.source_binding_id
         from training_load.gpexe_import_candidates c
         left join training_load.gpexe_import_checks k on k.id = c.last_seen_check_id and k.owner_team_id = c.owner_team_id
        where c.id = $1 and c.owner_team_id = $2 and c.status = 'pending' and c.preview_hash is null and c.raw_bundle is not null`,
      [candidateId, teamId],
    )).rows[0];
    if (!row) return false;
    const importPath = row.source_path === "source_connection" && row.source_binding_id
      ? { path: "source_connection", bindingId: String(row.source_binding_id) } : null;
    const client = await pool.connect();
    let built;
    let lost = false;
    const onError = () => { lost = true; };
    client.on("error", onError);
    try {
      built = await buildCandidatePreview(client, { bundle: row.raw_bundle, ownerTeamId: teamId, performedByUserId: userId, importPath });
    } finally {
      client.removeListener("error", onError);
      client.release(lost ? true : undefined);
    }
    const status = built.preview.status === "blocked" ? "blocked" : "pending";
    const updated = await pool.query(
      `update training_load.gpexe_import_candidates
          set preview = $3, preview_hash = $4, preview_computed_at = now(), status = $5
        where id = $1 and owner_team_id = $2 and status = 'pending' and preview_hash is null and raw_bundle is not null`,
      [candidateId, teamId, built.preview, built.previewHash, status],
    );
    return updated.rowCount === 1;
  } catch (error) {
    console.error(`[gpexe] undo: the preview of the offered candidate was not recomputed (${error?.code ?? error?.name ?? "error"})`);
    return false;
  }
}

export async function undoImport(teamId, candidateId, { userId, requestKey, reason, expectedEventId = null, confirmRosterFingerprint = null }) {
  checkBody({ requestKey, reason, expectedEventId, confirmRosterFingerprint });
  let row;
  try {
    row = await inTransaction(async (client) => (await client.query(
      `select * from training_load.undo_imported_session($1, $2, $3, $4, $5, $6, $7)`,
      [userId, teamId, candidateId, requestKey, reason, expectedEventId, confirmRosterFingerprint ?? null],
    )).rows[0], { keep: true });
  } catch (error) {
    const mapped = mapDatabaseError(error);
    if (mapped) throw mapped;
    throw error;
  }
  const result = { ...shapeResult(row), replayed: row.replayed === true, offeredAgain: Boolean(row.new_candidate_id), previewReady: false };
  if (row.new_candidate_id) {
    // Also on a replay: a first call whose recomputation failed gets another try, and the answer says whether the
    // offered candidate has its preview now (without one it cannot be approved; the next search recomputes it).
    await refreshOfferedPreview(teamId, row.new_candidate_id, userId);
    try {
      result.previewReady = (await pool.query(`select preview_hash is not null as ready from training_load.gpexe_import_candidates where id = $1 and owner_team_id = $2`, [row.new_candidate_id, teamId])).rows[0]?.ready === true;
    } catch { result.previewReady = false; }
  }
  return result;
}
