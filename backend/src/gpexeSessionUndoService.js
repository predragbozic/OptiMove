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
//
// v60 (O1 of J20): the undo also removes the session's roster work. What the import itself wrote (requests with origin
// 'import') never blocks; LATER roster work (the Roster tab) is removed only with the fingerprint of exactly the list
// the administrator saw (laterRosterFingerprint): sending it IS the confirmation, and the function compares it under the
// team's import lock. The preview names both, so the screen can show two separate warnings.
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
  roster_work_needs_confirmation: [409, "Coaches changed this session's attendance after the import. Confirm that these later changes are removed too, then undo again."],
  roster_work_changed: [409, "The session's attendance changed since you reviewed it. Nothing was removed. Review the undo again."],
  calendar_link_exists: [409, "This session is attached to a calendar event. Remove it from the calendar event first, then undo the import."],
  manual_write_request_exists: [409, "A manual entry refers to this session's data, so it cannot be removed here."],
  referenced_elsewhere: [409, "Other records still refer to this session's data. Nothing was removed."],
  request_key_reused: [409, "This request key was used for a different undo. Start the undo again."],
  invalid_reason: [400, "A reason of 1 to 500 characters without control characters is required."],
};

function parseDetail(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function mapDatabaseError(error) {
  if (error instanceof GpexeImportServiceError) return error;
  const message = String(error?.message || "");
  if (error?.code === "55000" && message.startsWith("session_undo:")) {
    const code = message.slice("session_undo:".length).trim();
    const known = SENTENCES[code];
    if (!known) return refusal(409, "undo_refused", "The undo was refused; nothing was changed.");
    const details = {};
    if (code === "roster_work_needs_confirmation" || code === "roster_work_changed") {
      const work = parseDetail(error.detail);
      if (work) details.rosterWork = rosterFromScope(work);
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

const COUNT_KEYS = ["decisions", "requests", "completions", "completionLog"];
function counts(source, snake = false) {
  const out = {};
  for (const k of COUNT_KEYS) {
    const v = source?.[snake && k === "completionLog" ? "completion_log" : k];
    out[k] = Number.isInteger(v) && v >= 0 ? v : 0;
  }
  return out;
}
const total = (c) => COUNT_KEYS.reduce((n, k) => n + c[k], 0);
function listItems(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60).map((i) => ({
    athleteId: i?.athlete ?? null, kind: i?.kind ?? null, reasonCode: i?.reason_code ?? null, byUserId: i?.by ?? null, at: i?.at ?? null,
  }));
}
function rosterShape(importWritten, later, list, fingerprint, changes) {
  const laterTotal = total(later);
  return {
    importWritten: { ...importWritten, total: total(importWritten) },
    laterWork: { ...later, total: laterTotal, changes: Number.isInteger(changes) && changes >= 0 ? changes : null, list: listItems(list), fingerprint: laterTotal > 0 && typeof fingerprint === "string" ? fingerprint : null },
  };
}
// The function's rosterWork (refusal detail) and the deletion log's roster_work_removed, in one API shape. Only the scope
// (the preview and a refusal) carries the server's count of later changes; the log does not store it, so an undo's answer
// and its replay carry changes: null rather than a count capped at the list's 60.
function rosterFromScope(work) {
  return rosterShape(counts(work?.importWritten), counts(work?.laterWork), work?.laterWork?.list, work?.laterWork?.fingerprint, work?.laterWork?.changes);
}
function rosterFromLog(removed) {
  if (!removed || typeof removed !== "object") return rosterShape(counts(null), counts(null), [], null);
  return rosterShape(counts(removed.import_written, true), counts(removed.later, true), removed.later_list, removed.later_fingerprint);
}

// Names for the listed later changes (at most 60 athletes and users) and the reasons' labels: the administrator sees who,
// whom and why, never only ids or codes.
async function withNames(roster) {
  const list = roster?.laterWork?.list ?? [];
  if (!list.length) return roster;
  const athleteIds = [...new Set(list.map((i) => i.athleteId).filter((x) => typeof x === "string" && UUID.test(x)))];
  const userIds = [...new Set(list.map((i) => i.byUserId).filter((x) => typeof x === "string" && UUID.test(x)))];
  const reasonKeys = [...new Set(list.map((i) => i.reasonCode).filter((x) => typeof x === "string"))];
  try {
    const [athletes, users, reasons] = await Promise.all([
      athleteIds.length ? pool.query(`select id, coalesce(nullif(display_name, ''), full_name) as name from public.athletes where id = any($1::uuid[])`, [athleteIds]) : { rows: [] },
      userIds.length ? pool.query(`select id, coalesce(nullif(display_name, ''), full_name) as name from public.users where id = any($1::uuid[])`, [userIds]) : { rows: [] },
      reasonKeys.length ? pool.query(`select key, label from training.participation_reasons where key = any($1::text[])`, [reasonKeys]) : { rows: [] },
    ]);
    const rl = new Map(reasons.rows.map((r) => [r.key, r.label]));
    const an = new Map(athletes.rows.map((r) => [String(r.id), r.name]));
    const un = new Map(users.rows.map((r) => [String(r.id), r.name]));
    roster.laterWork.list = list.map((i) => ({
      ...i,
      athleteName: i.athleteId ? an.get(i.athleteId) ?? null : null,
      byName: i.byUserId ? un.get(i.byUserId) ?? null : null,
      reasonLabel: i.reasonCode ? rl.get(i.reasonCode) ?? null : null,
    }));
  } catch {
    // Names are a help; the ids and the counts stay.
  }
  return roster;
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
    rosterWork: rosterFromLog(row.roster_work_removed),
  };
}

// The read-only scope: what the undo would remove, or the refusal it would raise. Nothing is kept.
export async function undoPreview(teamId, candidateId, { userId }) {
  let preview;
  try {
    preview = await inTransaction(async (client) => {
      if (previewFault) await previewFault(client);
      const sql = `select * from training_load.undo_imported_session($1, $2, $3, gen_random_uuid(), 'preview', null, $4)`;
      let row;
      let scopeWork = null;
      await client.query("savepoint undo_preview");
      try {
        row = (await client.query(sql, [userId, teamId, candidateId, null])).rows[0];
      } catch (error) {
        // Later roster work asks for a confirmation: run the same undo once more, confirmed with the fingerprint the
        // function itself reported, so the preview shows everything it would remove (still rolled back).
        if (!(error?.code === "55000" && String(error.message) === "session_undo:roster_work_needs_confirmation")) throw error;
        scopeWork = parseDetail(error.detail);
        const fingerprint = scopeWork?.laterWork?.fingerprint;
        await client.query("rollback to savepoint undo_preview");
        if (typeof fingerprint !== "string") throw error;
        row = (await client.query(sql, [userId, teamId, candidateId, fingerprint])).rows[0];
      }
      const shaped = shapeResult(row);
      // The scope's own counts (with the server's count of later changes). Rolling back to the savepoint releases the team
      // lock, so the rerun takes it again and checks this same fingerprint under it: a change in between is roster_work_changed.
      if (scopeWork) shaped.rosterWork = rosterFromScope(scopeWork);
      return { ...shaped, wouldOfferAgain: Boolean(row.new_candidate_id), needsRosterConfirmation: shaped.rosterWork.laterWork.total > 0 };
    }, { keep: false });
  } catch (error) {
    const mapped = mapDatabaseError(error);
    if (mapped?.details?.rosterWork) await withNames(mapped.details.rosterWork);
    if (mapped) throw mapped;
    throw error;
  }
  await withNames(preview.rosterWork);
  return preview;
}

function checkBody({ requestKey, reason, expectedEventId, laterRosterFingerprint }) {
  if (typeof requestKey !== "string" || !UUID.test(requestKey)) throw refusal(400, "invalid_request", "requestKey must be a UUID chosen for this one undo.");
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw refusal(400, "invalid_request", "A reason of 1 to 500 characters without control characters is required.");
  }
  if (expectedEventId !== undefined && expectedEventId !== null && (typeof expectedEventId !== "string" || !UUID.test(expectedEventId))) {
    throw refusal(400, "invalid_request", "expected.eventId must be a UUID.");
  }
  // Sending the fingerprint confirms the later roster changes it names; there is no confirmation without one.
  if (laterRosterFingerprint !== undefined && laterRosterFingerprint !== null
      && (typeof laterRosterFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(laterRosterFingerprint))) {
    throw refusal(400, "invalid_request", "laterRosterFingerprint is the 64-character fingerprint of the later roster changes it confirms.");
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

export async function undoImport(teamId, candidateId, { userId, requestKey, reason, expectedEventId = null, laterRosterFingerprint = null }) {
  checkBody({ requestKey, reason, expectedEventId, laterRosterFingerprint });
  let row;
  try {
    row = await inTransaction(async (client) => (await client.query(
      `select * from training_load.undo_imported_session($1, $2, $3, $4, $5, $6, $7)`,
      [userId, teamId, candidateId, requestKey, reason, expectedEventId, laterRosterFingerprint ?? null],
    )).rows[0], { keep: true });
  } catch (error) {
    const mapped = mapDatabaseError(error);
    if (mapped?.details?.rosterWork) await withNames(mapped.details.rosterWork);
    if (mapped) throw mapped;
    throw error;
  }
  const result = { ...shapeResult(row), replayed: row.replayed === true, offeredAgain: Boolean(row.new_candidate_id), previewReady: false };
  await withNames(result.rosterWork);
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
