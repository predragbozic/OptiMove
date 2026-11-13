// MT-A: the track choice of an athlete GPEXE recorded on more than one track (migration v67, gpexe_track_choices).
//
// Plan: docs/ai/mt-multiple-tracks-plan.md sections 5 and 8, with the Rukovodilac's decisions of 2026-11-12. The choice is
// written here and read by nobody else yet: the mapper and the preview apply it in MT-B. The database (v67) holds the rules
// whoever writes; this module is the only writer.
//
// Audience: whoever may approve the import for the team, through the approval's own function (lock_gpexe_import_approver,
// team mode of v56 included). Everyone else gets the identical 404 - the route's unlocked check, and the locked one here.
//
// The write is ONE transaction, in the approval's lock order (plan section 5, decided 2026-11-12):
//   1. the (author, request key) advisory lock (seed 67), then the replay: a saved answer wins over the present state;
//   2. the candidate FOR SHARE, only while it is open (pending or blocked) - an imported one is never locked here, since the
//      undo locks those after the team lock (v57); its snapshot available; the athlete has more than one track in it and they
//      are not one recording (MT-0);
//   3. the team's import lock (blocking, under the approval's lock_timeout: a wait is try_again);
//   4. the team and its club FOR SHARE (lockApprovalTeam: archived or moved is the identical 404);
//   5. the approver's rights FOR SHARE (lock_gpexe_import_approver), last as in the approval's step 6b;
//   6. the athlete's current choice FOR UPDATE, compared with expectedChoiceId;
//   7. the insert (v67's guard derives the right again), then a bounded COMMIT; an unknown outcome is looked up by the request
//      key on a new connection.
// Written under the team lock, a choice is serialised with every previewLocked (the check's preview, the J20-A1 recompute,
// the approval).
import { pool } from "./db.js";
import { lockTeamForImport } from "./gpexeImportWriter.js";
import { ApprovalTeamGoneError, canApproveGpexeImport, lockApprovalTeam } from "./gpexeImportAccess.js";
import { identicalTracks, trackSetFingerprint } from "./gpexeImportMapper.js";
import { isImportWaitError, isSessionEndedError, setImportTransactionBounds } from "./gpexeImportPreview.js";
import {
  COMMIT_ANSWER_TIMEOUT_MS, NOTHING_SAVED, OUTCOME_UNKNOWN, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS,
  commitCertainlyRefused, requestHash, withinBound,
} from "./activityRosterCommands.js";
import { GpexeImportServiceError } from "./gpexeImportService.js";

export const TRACK_CHOICES = Object.freeze(["track", "none", "cleared"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GPEXE_ID = /^(0|[1-9][0-9]{0,11})$/;
const REQUEST_LOCK_SEED = 67;
const TRY_AGAIN = "Another check, import or change of this team was running, or the server was busy. Nothing was saved; try again in a moment.";

let testHooks = {};
export function setTrackChoiceTestHooks(hooks) {
  testHooks = hooks ?? {};
}

function refusal(status, code, message, details) {
  const error = new GpexeImportServiceError(status, code, message);
  if (details) error.details = details;
  return error;
}
const notFound = () => refusal(404, "notFound", "Not found.");
const byNumber = (a, b) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0);

// The athlete's rows of this session, grouped by athlete exactly as the mapper groups them (buildGpexeImportPlan: the
// teamsession filter, then String(row.athlete)); no row is dropped here, so both sides see the same track set. (The mapper
// refuses the whole session for a non-canonical athlete id; such an athlete is simply never one this route can name.)
function athleteRowsOf(bundle) {
  const sessionId = String(bundle?.teamSession?.id ?? "");
  const byAthlete = new Map();
  for (const row of bundle?.athleteSessions ?? []) {
    if (String(row.teamsession) !== sessionId) continue;
    const athlete = String(row.athlete);
    if (!byAthlete.has(athlete)) byAthlete.set(athlete, []);
    byAthlete.get(athlete).push(row);
  }
  return byAthlete;
}

// The track set of one athlete that needs a choice: more than one track, and not one recording (MT-0). Otherwise null.
// A set with a track or row id that is not a canonical GPEXE id cannot be stored as a fingerprint: readable is false, the
// athlete is listed as not choosable and a choice is refused (tracks_not_readable) - it stays multiple_tracks, visibly.
export function trackSetOf(bundle, athleteRows) {
  const trackIds = [...new Set(athleteRows.map((r) => String(r.track)))].sort(byNumber);
  if (trackIds.length < 2) return null;
  if (identicalTracks(bundle, athleteRows, trackIds)) return null;
  // MT-B: the mapper's own fingerprint - one function, so the stored fingerprint and the mapper's comparison cannot drift.
  const fingerprint = trackSetFingerprint(athleteRows);
  const readable = fingerprint !== null;
  const tracks = trackIds.map((trackId) => {
    const rows = athleteRows.filter((r) => String(r.track) === trackId);
    const whole = rows.filter((r) => r.drill === null || r.drill === undefined);
    const track = bundle?.tracks?.[trackId] ?? null;
    const start = Number(track?.utc_timestamp);
    return {
      trackId,
      rowIds: rows.map((r) => String(r.id)).sort(byNumber),
      startedAt: Number.isFinite(start) ? new Date(start * 1000).toISOString() : null,
      timezone: typeof track?.timezone === "string" ? track.timezone : null,
      wholeSessionSeconds: whole.length === 1 && Number.isFinite(Number(whole[0].total_time)) ? Number(whole[0].total_time) : null,
      wholeSessionDistance: whole.length === 1 && Number.isFinite(Number(whole[0].total_distance)) ? Number(whole[0].total_distance) : null,
      drillIndexes: rows.filter((r) => r.drill !== null && r.drill !== undefined).map((r) => Number(r.drill)).sort((a, b) => a - b),
    };
  });
  return { tracks, fingerprint, readable };
}

function choiceView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    choice: row.choice,
    trackId: row.chosen_track_id ?? null,
    fingerprint: row.track_set_fingerprint,
    chosenAt: new Date(row.chosen_at).toISOString(),
    // MT-B (L4): who chose, by name only - the approver's audience; never the user id.
    chosenBy: { name: row.chosen_by_name ?? null },
    supersedesChoiceId: row.supersedes_choice_id ? String(row.supersedes_choice_id) : null,
  };
}

const CHOSEN_BY_NAME = `(select coalesce(u.display_name, u.full_name) from public.users u where u.id = c.chosen_by_user_id) as chosen_by_name`;
const CURRENT_SQL = `select c.*, ${CHOSEN_BY_NAME} from training_load.gpexe_track_choices c
  where c.owner_team_id = $1 and c.gpexe_team_session_id = $2 and c.gpexe_athlete_id = $3
    and not exists (select 1 from training_load.gpexe_track_choices n where n.supersedes_choice_id = c.id)`;

// Locked, only an open candidate (pending or blocked) is taken FOR SHARE: the undo locks imported candidates FOR UPDATE after
// the team lock (v57), so this transaction must never hold an imported one while it waits for the team lock. A candidate an
// approval makes 'imported' meanwhile no longer matches when its lock is granted (READ COMMITTED re-checks the row), and nothing
// of it stays locked.
const CANDIDATE_COLUMNS = "id, gpexe_team_session_id, raw_bundle, raw_purged_at, raw_expires_at, status, import_undone_at";
async function readCandidate(client, teamId, candidateId, { lock }) {
  return (await client.query(
    lock
      ? `select ${CANDIDATE_COLUMNS} from training_load.gpexe_import_candidates
          where id = $1 and owner_team_id = $2 and status in ('pending', 'blocked') for share`
      : `select ${CANDIDATE_COLUMNS} from training_load.gpexe_import_candidates where id = $1 and owner_team_id = $2`,
    [candidateId, teamId],
  )).rows[0] ?? null;
}
const snapshotAvailable = (row) => row.raw_bundle && !row.raw_purged_at && (!row.raw_expires_at || new Date(row.raw_expires_at) > new Date());

// The route's unlocked audience check: the approval's right (any basis), or the identical 404.
export async function assertTrackChoiceAudience(client, userId, teamId) {
  const right = await canApproveGpexeImport({ query: (text, params) => client.query(text, params) }, userId, teamId);
  if (!right.hasRight) throw notFound();
  return right;
}

export async function listTrackChoices(teamId, candidateId, { userId }) {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("set local statement_timeout = '10s'");
    await assertTrackChoiceAudience(client, userId, teamId);
    const row = await readCandidate(client, teamId, candidateId, { lock: false });
    if (!row) throw notFound();
    if (!snapshotAvailable(row)) throw refusal(409, "snapshot_expired_check_again", "The GPEXE data of this candidate has expired; find new sessions again.");
    const athletes = [];
    for (const [gpexeAthleteId, rows] of [...athleteRowsOf(row.raw_bundle).entries()].sort(([a], [b]) => byNumber(a, b))) {
      const set = trackSetOf(row.raw_bundle, rows);
      if (!set) continue;
      const current = (await client.query(CURRENT_SQL, [teamId, row.gpexe_team_session_id, gpexeAthleteId])).rows[0] ?? null;
      const view = choiceView(current);
      athletes.push({
        gpexeAthleteId,
        tracks: set.tracks.map(({ rowIds, ...t }) => t),
        choosable: set.readable,
        ...(set.readable ? {} : { notChoosableReason: "tracks_not_readable" }),
        // "Add them up" is MT-E: not offered in v1.
        sumOffered: false,
        sumReason: "not_available",
        currentChoice: view ? { ...view, stale: view.choice !== "cleared" && view.fingerprint !== set.fingerprint } : null,
      });
    }
    await client.query("commit");
    return { candidateId: String(row.id), gpexeTeamSessionId: String(row.gpexe_team_session_id), status: row.status, athletes };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function validateTrackChoiceBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw refusal(400, "invalid_body", "The body must be an object.");
  const allowed = new Set(["requestKey", "choice", "trackId", "expectedChoiceId"]);
  if (Object.keys(body).some((k) => !allowed.has(k))) throw refusal(400, "invalid_body", "The body may hold requestKey, choice, trackId and expectedChoiceId only.");
  const { requestKey, choice, trackId, expectedChoiceId } = body;
  if (typeof requestKey !== "string" || !UUID.test(requestKey)) throw refusal(400, "invalid_request_key", "requestKey must be a UUID.");
  if (!TRACK_CHOICES.includes(choice)) throw refusal(400, "invalid_choice", "choice must be track, none or cleared.");
  if (choice === "track") {
    if (typeof trackId !== "string" || !GPEXE_ID.test(trackId)) throw refusal(400, "invalid_track_id", "trackId must be a GPEXE track id.");
  } else if (trackId !== undefined && trackId !== null) {
    throw refusal(400, "invalid_track_id", "trackId is sent only with the choice track.");
  }
  if (!("expectedChoiceId" in body) || (expectedChoiceId !== null && (typeof expectedChoiceId !== "string" || !UUID.test(expectedChoiceId)))) {
    throw refusal(400, "invalid_expected_choice", "expectedChoiceId must be the current choice's id, or null when there is none.");
  }
  return {
    requestKey: requestKey.toLowerCase(),
    choice,
    trackId: choice === "track" ? trackId : null,
    expectedChoiceId: expectedChoiceId === null ? null : expectedChoiceId.toLowerCase(),
  };
}

async function readByRequest(client, userId, requestKey) {
  return (await client.query(
    `select c.*, ${CHOSEN_BY_NAME} from training_load.gpexe_track_choices c where c.chosen_by_user_id = $1 and c.request_key = $2`,
    [userId, requestKey],
  )).rows[0] ?? null;
}

async function findStoredChoice(userId, requestKey, hash, ms) {
  const deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now());
  const connecting = pool.connect();
  let checker;
  try {
    checker = await withinBound(connecting, left());
  } catch (error) {
    connecting.then((late) => late.release(true), () => {});
    throw error;
  }
  let broken = false;
  const onError = () => { broken = true; };
  checker.on("error", onError);
  try {
    const reading = (async () => {
      await checker.query("begin read only");
      await checker.query(`set local statement_timeout = ${Math.max(1, Math.floor(left()))}`);
      const found = await readByRequest(checker, userId, requestKey);
      await checker.query("commit");
      return found;
    })();
    reading.catch(() => {});
    const row = await withinBound(reading, left());
    return row && row.request_hash === hash ? row : null;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    checker.removeListener("error", onError);
    if (broken) checker.on("error", () => {});
    checker.release(broken ? true : undefined);
  }
}

export async function putTrackChoice(teamId, candidateId, gpexeAthleteId, { userId, body, expectedClubId = undefined }) {
  if (!GPEXE_ID.test(String(gpexeAthleteId))) throw notFound();
  let input = null;
  let hash = null;
  const client = await pool.connect();
  let commitSent = false;
  let broken = false;
  let released = false;
  const onClientError = () => { broken = true; };
  client.on("error", onClientError);
  try {
    await client.query("begin isolation level read committed");
    await setImportTransactionBounds(client);
    // The route's audience, unlocked (the fast 404); the right that counts is the one locked at step 5.
    await assertTrackChoiceAudience(client, userId, teamId);
    // MT-B (L3): the body only after the audience, so a malformed body outside it is the identical 404 too.
    input = validateTrackChoiceBody(body);
    hash = requestHash({ operation: "track_choice", teamId, candidateId, gpexeAthleteId: String(gpexeAthleteId), ...input, requestKey: undefined });
    // 1. The (author, key) lock and the replay.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('track-choice-request:' || $1::uuid::text || ':' || $2::uuid::text, ${REQUEST_LOCK_SEED}))`,
      [userId, input.requestKey],
    );
    const prior = await readByRequest(client, userId, input.requestKey);
    if (prior) {
      if (prior.request_hash !== hash) throw refusal(409, "request_key_reused", "This requestKey was already used for a different request.");
      await client.query("rollback");
      return { status: 200, body: { choice: choiceView(prior) }, replayed: true };
    }
    // 2. The candidate FOR SHARE (only while open) and the athlete's track set.
    const row = await readCandidate(client, teamId, candidateId, { lock: true });
    if (!row) {
      const seen = await readCandidate(client, teamId, candidateId, { lock: false });
      if (!seen) throw notFound();
      if (seen.status === "imported" && !seen.import_undone_at) {
        throw refusal(409, "choice_final_after_import", "This session was imported; its track choice is final. Undo the import first to change it.");
      }
      throw refusal(409, "candidate_not_open", "This version of the session is no longer the current one; open the current one.");
    }
    if (!snapshotAvailable(row)) throw refusal(409, "snapshot_expired_check_again", "The GPEXE data of this candidate has expired; find new sessions again.");
    const athleteRows = athleteRowsOf(row.raw_bundle).get(String(gpexeAthleteId));
    const set = athleteRows ? trackSetOf(row.raw_bundle, athleteRows) : null;
    if (!set) throw refusal(409, "not_multiple_tracks", "This athlete has one recording in this session; there is nothing to choose.");
    if (!set.readable) throw refusal(409, "tracks_not_readable", "GPEXE sent this athlete's tracks with ids OptiMove cannot read; no choice can be stored.");
    if (input.choice === "track" && !set.tracks.some((t) => t.trackId === input.trackId)) {
      throw refusal(409, "track_not_in_session", "This track is not one of the athlete's tracks in this session.");
    }
    if (testHooks.beforeTeamLock) await testHooks.beforeTeamLock({ client, teamId });
    // 3-4. The team's import lock, then the team and its club.
    await lockTeamForImport(client, teamId);
    await lockApprovalTeam(client, teamId, expectedClubId);
    // The choice is the session's (team, session, athlete), not this candidate's: once any version of the session is imported
    // and not undone, it is final (plan section 7). A plain read under the team lock, which an approval and an undo also take.
    const imported = (await client.query(
      `select exists (select 1 from training_load.gpexe_import_candidates
                       where owner_team_id = $1 and gpexe_team_session_id = $2 and status = 'imported' and import_undone_at is null) as yes`,
      [teamId, row.gpexe_team_session_id],
    )).rows[0].yes;
    if (imported) {
      throw refusal(409, "choice_final_after_import", "This session was imported; its track choice is final. Undo the import first to change it.");
    }
    // 5. The approver's rights, last (the approval's step 6b).
    await client.query(`select set_config('optimove.track_choice_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [userId]);
    let right;
    try {
      right = (await client.query(`select basis, grant_id from training_load.lock_gpexe_import_approver($1, $2) limit 1`, [userId, teamId])).rows[0];
    } catch (error) {
      if (error?.code === "42501") throw notFound();
      if (error?.code === "55000" && /team_import_pilot_mode/.test(String(error.message))) throw notFound();
      if (error?.code === "55000" && /team_import_switch_off/.test(String(error.message))) {
        throw refusal(409, "team_import_switch_off", "Imports are switched off for this team; a choice is made while they are on.");
      }
      throw error;
    }
    // 6. The athlete's current choice, FOR UPDATE.
    const current = (await client.query(`${CURRENT_SQL} for update of c`, [teamId, row.gpexe_team_session_id, String(gpexeAthleteId)])).rows[0] ?? null;
    const currentId = current ? String(current.id) : null;
    if (currentId !== input.expectedChoiceId) {
      throw refusal(409, "choice_changed", "The choice was changed since you opened it; review it again.", { currentChoice: choiceView(current) });
    }
    if (input.choice === "cleared" && (!current || current.choice === "cleared")) {
      throw refusal(409, "nothing_to_clear", "There is no choice to clear.");
    }
    // 7. The insert, then the bounded COMMIT.
    const inserted = (await client.query(
      `insert into training_load.gpexe_track_choices
         (owner_team_id, gpexe_team_session_id, gpexe_athlete_id, track_set_fingerprint, choice, chosen_track_id,
          chosen_by_user_id, chosen_basis, chosen_grant_id, supersedes_choice_id, request_key, request_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [teamId, row.gpexe_team_session_id, String(gpexeAthleteId), set.fingerprint, input.choice, input.trackId,
        userId, right.basis, right.grant_id ?? null, currentId, input.requestKey, hash],
    )).rows[0];
    const saved = await readByRequest(client, userId, input.requestKey);
    if (!saved || String(saved.id) !== String(inserted.id)) throw new Error("the inserted choice was not read back");
    if (testHooks.beforeCommit) await testHooks.beforeCommit({ client, teamId });
    commitSent = true;
    const committing = Promise.resolve().then(() => (testHooks.commit ? testHooks.commit(client) : client.query("commit")));
    committing.catch(() => {});
    await withinBound(committing, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    return { status: 201, body: { choice: choiceView(saved) } };
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (error instanceof GpexeImportServiceError) throw error;
      if (error instanceof ApprovalTeamGoneError) throw notFound();
      if (isImportWaitError(error) || isSessionEndedError(error)) {
        if (isSessionEndedError(error)) broken = true;
        throw refusal(409, "try_again", TRY_AGAIN);
      }
      // The unique backstops (one root per athlete, one successor per choice): another choice landed first.
      if (error?.code === "23505") throw refusal(409, "choice_changed", "The choice was changed since you opened it; review it again.");
      console.error(`[gpexe] a track choice on candidate ${candidateId} failed: ${error?.code ?? ""}`);
      throw refusal(500, "internal_error", NOTHING_SAVED);
    }
    console.error(`[gpexe] commit of a track choice on candidate ${candidateId} failed: ${error?.code ?? ""}`);
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      throw refusal(500, "internal_error", NOTHING_SAVED);
    }
    released = true;
    client.removeListener("error", onClientError);
    client.on("error", () => {});
    client.release(true);
    let found = null;
    try {
      found = await findStoredChoice(userId, input.requestKey, hash, testHooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS);
    } catch (checkError) {
      console.error(`[gpexe] checking a track choice after an unconfirmed COMMIT failed: ${checkError?.code ?? ""}`);
    }
    if (found) return { status: 201, body: { choice: choiceView(found) }, verifiedAfterCommitError: true };
    throw refusal(503, "outcome_unknown", OUTCOME_UNKNOWN, { retrySameRequest: true });
  } finally {
    if (!released) {
      client.removeListener("error", onClientError);
      client.release(broken ? true : undefined);
    }
  }
}
