// Session roster commands (Phase 5a2): a coach decision per athlete, its
// removal, bulk decisions, Complete and Reopen.
//
// Contract: docs/ai/phase5a-discovery-and-contract.md, sections 3.3, 3.4, 3.6,
// 4 and 11 ("As built in 5a2"). Migration v26 holds the rules the database
// enforces whoever writes (append-only, canonical activity, the basis, one
// log row per completion revision, the automatic complete -> needs_review).
//
// Every command is ONE transaction with this lock order (v26 header):
//   1. training.lock_activity_decider(user, team, basis)   (42501 -> 403 not_a_team_coach)
//   2. the team import lock (gpexeImportWriter.lockTeamForImport) — a
//      decision and an import of the same team never interleave, so the
//      "measured is never overridden" check cannot miss an uncommitted import
//   3. Complete only: training.lock_roster_team(team, exclusive)
//   4. the alias set's activity rows FOR KEY SHARE, ascending
//   5. Complete only: training.lock_roster_completions(canonical, exclusive)
//   6. completion rows FOR UPDATE, ascending
//   7. the requestKey across the alias set, then checks, then writes, the
//      request row last.
// Before 1 the addressed activity, the team and the caller's basis in the
// ACTIVE workspace are resolved exactly as the roster read does
// (resolveRosterTarget): everything outside that path is the read's
// identical 404.
//
// Idempotency: a requestKey already used in the alias set with the same
// canonical body returns the stored answer (after 1-6, so the caller is
// authorized again and nothing is written); with another body it is
// 409 request_key_reused. A request that is refused writes nothing, so its
// key stays free.
//
// Answers carry stable codes only; a database message never reaches the
// client (the route maps anything unexpected to internal_error).
import crypto from "node:crypto";
import pg from "pg";
import { pool } from "./db.js";
import { lockTeamForImport } from "./gpexeImportWriter.js";
import {
  RosterError, decisionView, loadRosterSnapshot, publicAthlete, resolveRosterTarget,
} from "./activityRoster.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// Kinds a coach can choose in 5a2. manual_values and estimated exist in the
// schema but wait for 5b: 409 kind_not_available.
export const DECISION_KINDS = Object.freeze(["did_not_participate", "participated_no_values"]);
const LATER_KINDS = new Set(["manual_values", "estimated"]);
export const MAX_BULK_ATHLETES = 60;
export const MAX_NOTE_LENGTH = 500;
export const MAX_REOPEN_REASON_LENGTH = 500;
// A roster command never waits longer than this for a lock (the approval's
// unbounded waits are a recorded risk; these commands do not add to it).
const LOCK_TIMEOUT = "15s";

const notFound = () => new RosterError(404, "notFound", "Not found.");
const bad = (code, message) => new RosterError(400, code, message);
const conflict = (code, message, details) => new RosterError(409, code, message, details);

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Body validation (400s, before any database work). Each returns the
// canonical body: exactly what the request asks, in a fixed shape; its
// sha256 is the request hash.
// ---------------------------------------------------------------------------
function requestKeyOf(body) {
  if (!isUuid(body?.requestKey)) throw bad("invalid_request_key", "requestKey must be a UUID.");
  return body.requestKey.toLowerCase();
}

function kindOf(body) {
  const kind = body?.kind;
  if (typeof kind !== "string" || !(DECISION_KINDS.includes(kind) || LATER_KINDS.has(kind))) {
    throw bad("invalid_kind", "kind must be did_not_participate or participated_no_values.");
  }
  return kind;
}

function reasonOf(body, kind) {
  const reasonKey = body?.reasonKey;
  if (kind === "did_not_participate") {
    if (reasonKey === undefined || reasonKey === null || reasonKey === "") throw bad("reason_required", "A reason is required for Did not participate.");
    if (typeof reasonKey !== "string" || !REASON_KEY_PATTERN.test(reasonKey)) throw bad("unknown_reason", "Unknown reason.");
    return reasonKey;
  }
  if (reasonKey !== undefined && reasonKey !== null) throw bad("reason_not_allowed", "Only Did not participate takes a reason.");
  return null;
}

function noteOf(body) {
  const note = body?.note;
  if (note === undefined || note === null) return null;
  if (typeof note !== "string") throw bad("invalid_note", "note must be text.");
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) throw bad("note_too_long", `A note is at most ${MAX_NOTE_LENGTH} characters.`);
  return trimmed || null;
}

function expectedDecisionOf(value, { allowNull }) {
  if (value === null && allowNull) return null;
  if (!isUuid(value)) throw bad("invalid_expected_decision_id", allowNull ? "expectedDecisionId must be a UUID or null." : "expectedDecisionId must be a UUID.");
  return value.toLowerCase();
}

function expectedRevisionOf(body) {
  const v = body?.expectedRevision;
  if (!Number.isInteger(v) || v < 0) throw bad("invalid_expected_revision", "expectedRevision must be a whole number.");
  return v;
}

export function validateDecide(body, athleteId) {
  if (!isUuid(athleteId)) throw notFound();
  const requestKey = requestKeyOf(body);
  const kind = kindOf(body);
  const reasonKey = reasonOf(body, kind);
  const note = noteOf(body);
  if (!body || !Object.prototype.hasOwnProperty.call(body, "expectedDecisionId")) {
    throw bad("invalid_expected_decision_id", "expectedDecisionId is required (null when the athlete has no decision).");
  }
  const expectedDecisionId = expectedDecisionOf(body.expectedDecisionId, { allowNull: true });
  return { requestKey, canonical: { operation: "decide", athleteId: athleteId.toLowerCase(), kind, reasonKey, note, expectedDecisionId } };
}

export function validateClear(body, athleteId) {
  if (!isUuid(athleteId)) throw notFound();
  const requestKey = requestKeyOf(body);
  const expectedDecisionId = expectedDecisionOf(body?.expectedDecisionId, { allowNull: false });
  return { requestKey, canonical: { operation: "clear", athleteId: athleteId.toLowerCase(), expectedDecisionId } };
}

export function validateBulk(body) {
  const requestKey = requestKeyOf(body);
  const kind = kindOf(body);
  const reasonKey = reasonOf(body, kind);
  const note = noteOf(body);
  const list = body?.athletes;
  if (!Array.isArray(list) || list.length === 0) throw bad("invalid_athletes", "athletes must list 1 to 60 athletes.");
  if (list.length > MAX_BULK_ATHLETES) throw bad("too_many_athletes", `At most ${MAX_BULK_ATHLETES} athletes at once.`);
  const seen = new Set();
  const athletes = list.map((entry) => {
    if (!entry || typeof entry !== "object" || !isUuid(entry.athleteId) || !Object.prototype.hasOwnProperty.call(entry, "expectedDecisionId")) {
      throw bad("invalid_athletes", "Each athlete needs athleteId and expectedDecisionId.");
    }
    const athleteId = entry.athleteId.toLowerCase();
    if (seen.has(athleteId)) throw bad("duplicate_athlete", "An athlete is listed twice.");
    seen.add(athleteId);
    return { athleteId, expectedDecisionId: expectedDecisionOf(entry.expectedDecisionId, { allowNull: true }) };
  }).sort((a, b) => a.athleteId.localeCompare(b.athleteId));
  return { requestKey, canonical: { operation: "decide_bulk", kind, reasonKey, note, athletes } };
}

export function validateComplete(body) {
  const requestKey = requestKeyOf(body);
  const expectedRevision = expectedRevisionOf(body);
  const fp = body?.expectedFingerprint;
  if (typeof fp !== "string" || !FINGERPRINT_PATTERN.test(fp)) throw bad("invalid_expected_fingerprint", "expectedFingerprint must be the roster's rosterFingerprint.");
  return { requestKey, canonical: { operation: "complete", expectedRevision, expectedFingerprint: fp } };
}

export function validateReopen(body) {
  const requestKey = requestKeyOf(body);
  const expectedRevision = expectedRevisionOf(body);
  const raw = body?.reason;
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw bad("invalid_reason", "reason must be text.");
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason) throw bad("reason_required", "A reason is required to reopen a session.");
  if (reason.length > MAX_REOPEN_REASON_LENGTH) throw bad("reason_too_long", `A reason is at most ${MAX_REOPEN_REASON_LENGTH} characters.`);
  return { requestKey, canonical: { operation: "reopen", expectedRevision, reason } };
}

// sha256 of the canonical body with sorted keys.
export function requestHash(canonical) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
  };
  return crypto.createHash("sha256").update(JSON.stringify(sortKeys(canonical))).digest("hex");
}

// ---------------------------------------------------------------------------
// The transaction.
// ---------------------------------------------------------------------------

// The canonical activity and its alias set, with every alias row held FOR
// KEY SHARE (ascending). A merge or reparent takes those rows FOR UPDATE
// before it supersedes anything, so once this returns the alias set cannot
// change until the command ends; the loop covers a merge that committed
// between the resolve and the lock.
async function lockAliasSet(client, activityId) {
  const one = async (sql, params) => (await client.query(sql, params)).rows;
  const read = async () => {
    const canonicalId = String((await one(`select training.resolve_canonical_activity_id($1) as id`, [activityId]))[0].id);
    const aliasIds = (await one(`select activity_id from training.activity_alias_ids($1) order by activity_id`, [canonicalId])).map((r) => String(r.activity_id));
    return { canonicalId, aliasIds };
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const first = await read();
    await client.query(`select id from training.activities where id = any($1::uuid[]) order by id for key share`, [first.aliasIds]);
    const again = await read();
    if (again.canonicalId === first.canonicalId && again.aliasIds.join() === first.aliasIds.join()) return again;
  }
  throw new RosterError(503, "roster_busy", "The session is being changed. Try again.");
}

// Test seams only (backend/tests/activity-roster-5a2.test.mjs): pause a
// real command at a known point of its transaction, replace its COMMIT,
// make the check after an uncertain COMMIT fail or hang, and shorten the two
// bounds below. Never set in the app.
let testHooks = {};
export function setRosterCommandTestHooks(hooks) {
  testHooks = hooks ?? {};
}

// The COMMIT outcome, the same pattern as the GPEXE approval
// (gpexeImportService.js): the answer to the COMMIT is awaited at most
// COMMIT_ANSWER_TIMEOUT_MS; past that, or on any error that is not the
// server's own refusal, the outcome is unknown: the connection is destroyed
// FIRST (which also ends a COMMIT still waiting on it), then the request row
// is looked for on a new connection, the whole check bounded by
// UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS. Neither path leaves a pool connection
// or an open transaction behind.
export const COMMIT_ANSWER_TIMEOUT_MS = 15_000;
export const UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS = 5_000;

export const NOTHING_SAVED = "Nothing was saved. Try again.";
export const OUTCOME_UNKNOWN = "Not sure the change was saved. Try again with the same requestKey; it will not be saved twice.";

// A COMMIT the server itself answered with a refusal (a deferred check, a
// serialization failure): a certain rollback. Uncertain instead: a
// connection class (08xxx), an operator intervention / shutdown (57Pxx),
// 40003 statement_completion_unknown, a socket or driver error (ECONNRESET,
// EPIPE, ... - string codes, but not a server answer) and a timeout.
export function commitCertainlyRefused(error) {
  if (!(error instanceof pg.DatabaseError)) return false;
  const code = String(error.code ?? "");
  return !/^(08|57P)/.test(code) && code !== "40003";
}

function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function completionFromRow(row) {
  return row ? { status: row.status, revision: row.revision } : { status: "not_complete", revision: 0 };
}

async function runRosterCommand(ctx, activityId, { requestKey, canonical }, apply) {
  const hash = requestHash(canonical);
  const operation = canonical.operation;
  const client = await pool.connect();
  let commitSent = false;
  let broken = false;
  let released = false;
  let canonicalId = null;
  // A connection that dies while checked out (a terminated backend, a
  // network loss) emits 'error' on the client; without a listener that
  // would take the whole server down. The failing query rejects anyway.
  const onClientError = () => { broken = true; };
  client.on("error", onClientError);
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    const target = await resolveRosterTarget(client, ctx, activityId);
    const teamId = String(target.team.id);
    if (testHooks.beforeLocks) await testHooks.beforeLocks({ client, operation });

    try {
      await client.query(`select training.lock_activity_decider($1, $2, $3)`, [ctx.userId, teamId, target.basis]);
    } catch (error) {
      if (error?.code === "42501") throw new RosterError(403, "not_a_team_coach", "You may not decide on this team's roster.");
      throw error;
    }
    await lockTeamForImport(client, teamId);
    if (operation === "complete") await client.query(`select training.lock_roster_team($1, true)`, [teamId]);
    const aliasSet = await lockAliasSet(client, activityId);
    canonicalId = aliasSet.canonicalId;
    // A merge that committed between the unlocked resolve and the lock may
    // have moved the session to another canonical activity: the caller's
    // right is checked again on that one before anything about it (its id,
    // a stored answer) is answered. Another team is the identical 404.
    if (canonicalId !== target.canonicalId) {
      const again = await resolveRosterTarget(client, ctx, canonicalId);
      if (String(again.team.id) !== teamId || again.basis !== target.basis) throw notFound();
    }
    if (operation === "complete") await client.query(`select training.lock_roster_completions(array[$1]::uuid[], true)`, [canonicalId]);
    await client.query(
      `select activity_id from training.activity_completions where activity_id = any($1::uuid[]) order by activity_id for update`,
      [aliasSet.aliasIds],
    );

    const prior = (await client.query(
      `select request_hash, performed_by_user_id, result from training.activity_roster_requests where activity_id = any($1::uuid[]) and request_key = $2`,
      [aliasSet.aliasIds, requestKey],
    )).rows[0];
    if (prior) {
      // Another user's key is never "your change was saved".
      if (prior.request_hash !== hash || String(prior.performed_by_user_id) !== String(ctx.userId)) throw conflict("request_key_reused", "This requestKey was already used for a different request.");
      await client.query("rollback");
      return { status: 200, body: prior.result, replayed: true };
    }
    if (String(activityId) !== canonicalId) {
      throw conflict("activity_superseded", "This session was merged into another.", { canonicalActivityId: canonicalId });
    }

    const requestId = crypto.randomUUID();
    const snap = await loadRosterSnapshot(client, canonicalId);
    const cmd = {
      client, ctx, canonicalId, teamId, basis: target.basis, requestId, snap,
      // A complete session whose inputs changed without a trigger noticing
      // (the read's input_changed) is written down before anything else.
      async persistInputChanged() {
        if (!cmd.snap.inputChanged) return;
        await client.query(
          `select training.roster_record_change(array[$1]::uuid[], array[null]::uuid[], 'input_changed', $2, $3, false, 'fingerprint_on_write')`,
          [canonicalId, ctx.userId, requestId],
        );
        cmd.snap = await loadRosterSnapshot(client, canonicalId);
      },
    };
    const result = await apply(cmd, canonical);

    await client.query(
      `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [requestId, canonicalId, requestKey, hash, operation, ctx.userId, JSON.stringify(result)],
    );
    if (testHooks.beforeCommit) await testHooks.beforeCommit({ client, operation, canonicalId });
    commitSent = true;
    const committing = Promise.resolve().then(() => (testHooks.commit ? testHooks.commit(client) : client.query("commit")));
    committing.catch(() => {}); // a COMMIT that loses the race may still fail later
    await withinBound(committing, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    if (testHooks.afterCommit) await testHooks.afterCommit({ client, operation, canonicalId });
    return { status: 200, body: result };
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (error?.code === "55P03" || error?.code === "40P01") {
        throw new RosterError(503, "roster_busy", "The session is being changed. Try again.");
      }
      throw error;
    }
    console.error(`[roster] commit of ${operation} on activity ${activityId} failed: ${error?.code ?? ""} ${error?.message}`);
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      throw new RosterError(500, "internal_error", NOTHING_SAVED);
    }
    // Unknown outcome: the connection is not trusted any more. Destroy it
    // before the check (never return it to the pool).
    released = true;
    client.removeListener("error", onClientError);
    client.on("error", () => {});
    client.release(true);
    let found = null;
    try {
      found = await findStoredResult(canonicalId, requestKey, hash, ctx.userId, testHooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS);
    } catch (checkError) {
      console.error(`[roster] checking ${operation} on activity ${activityId} after an unconfirmed COMMIT failed: ${checkError?.message}`);
    }
    if (found) return { status: 200, body: found, verifiedAfterCommitError: true };
    throw new RosterError(503, "outcome_unknown", OUTCOME_UNKNOWN);
  } finally {
    if (!released) {
      client.removeListener("error", onClientError);
      client.release(broken ? true : undefined);
    }
  }
}

// Is the request committed? Bounded as a whole: getting a connection and the
// query share one deadline; a connection that arrives after the deadline is
// destroyed at once, and one whose query did not answer in time is
// destroyed instead of returned.
async function findStoredResult(canonicalId, requestKey, hash, userId, ms) {
  if (!canonicalId) return null;
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
  let bad = false;
  const onCheckerError = () => { bad = true; };
  checker.on("error", onCheckerError);
  try {
    if (testHooks.checkFault) {
      const fault = Promise.resolve().then(() => testHooks.checkFault(checker));
      fault.catch(() => {});
      await withinBound(fault, left());
    }
    const answer = checker.query({
      text: `select request_hash, performed_by_user_id, result from training.activity_roster_requests
              where activity_id in (select activity_id from training.activity_alias_ids(training.resolve_canonical_activity_id($1)))
                and request_key = $2`,
      values: [canonicalId, requestKey],
      query_timeout: left(),
    });
    answer.catch(() => {});
    const row = (await withinBound(answer, left())).rows[0];
    return row && row.request_hash === hash && String(row.performed_by_user_id) === String(userId) ? row.result : null;
  } catch (error) {
    bad = true;
    throw error;
  } finally {
    checker.removeListener("error", onCheckerError);
    if (bad) checker.on("error", () => {});
    checker.release(bad ? true : undefined);
  }
}

// ---------------------------------------------------------------------------
// Decisions.
// ---------------------------------------------------------------------------

// expectedDecisionId matches the athlete's current decision(s) across the
// alias set: one of the current ids, or null when there is none or the
// current one is 'cleared'. On a merge conflict either current id matches.
function expectedMatches(expected, currentDecisions) {
  if (expected === null) return currentDecisions.every((d) => d.decision_kind === "cleared");
  return currentDecisions.some((d) => String(d.id) === expected);
}

function currentStateView(athlete) {
  return {
    athleteId: athlete.athleteId,
    state: athlete.state,
    decision: athlete.decision,
    currentDecisionIds: athlete.decisionIds,
  };
}

// Why this athlete cannot get the decision, or null.
function decisionRefusal(athlete, kind, expected) {
  if (!athlete) return "not_on_roster";
  if (!expectedMatches(expected, athlete.currentDecisions)) return "decision_changed";
  if (kind !== "cleared" && athlete.measured) return "measured_record_exists";
  return null;
}

async function reasonIsActive(client, reasonKey) {
  if (reasonKey === null) return true;
  return (await client.query(`select 1 from training.participation_reasons where key = $1 and is_active`, [reasonKey])).rowCount === 1;
}

// Supersede every current decision of each athlete with the new one's id
// known in advance, then insert the new ones in ONE statement (one revision
// bump for the request), in the order the one-current partial index needs.
async function writeDecisions(cmd, rows, { kind, reasonKey, note }) {
  const { client } = cmd;
  const supersede = rows.flatMap((r) => r.currentDecisions.map((d) => [String(d.id), r.newId]));
  if (supersede.length) {
    await client.query(
      `update training.activity_athlete_decisions d
          set superseded_by_decision_id = m.new_id, superseded_at = now()
         from unnest($1::uuid[], $2::uuid[]) as m(old_id, new_id)
        where d.id = m.old_id`,
      [supersede.map((s) => s[0]), supersede.map((s) => s[1])],
    );
  }
  await client.query(
    `insert into training.activity_athlete_decisions
       (id, activity_id, athlete_id, owner_team_id, request_id, decision_kind, reason_key, note, decided_by_user_id, decided_by_basis)
     select m.id, $3, m.athlete_id, $4, $5, $6, $7, $8, $9, $10
       from unnest($1::uuid[], $2::uuid[]) as m(id, athlete_id)`,
    [rows.map((r) => r.newId), rows.map((r) => r.athleteId), cmd.canonicalId, cmd.teamId, cmd.requestId, kind, reasonKey, note, cmd.ctx.userId, cmd.basis],
  );
  const written = (await client.query(
    `select d.id, d.activity_id, d.athlete_id, d.decision_kind, d.reason_key, d.note, d.decided_by_user_id, d.decided_by_basis, d.decided_at,
            coalesce(nullif(u.display_name, ''), u.full_name) as decided_by_name
       from training.activity_athlete_decisions d left join public.users u on u.id = d.decided_by_user_id
      where d.id = any($1::uuid[]) order by d.athlete_id`,
    [rows.map((r) => r.newId)],
  )).rows;
  cmd.snap = await loadRosterSnapshot(client, cmd.canonicalId);
  return written;
}

function athleteById(snap, athleteId) {
  return snap.athletes.find((a) => a.athleteId === athleteId) ?? null;
}

async function applySingle(cmd, canonical, kind) {
  if (LATER_KINDS.has(kind)) throw conflict("kind_not_available", "Manual values and estimates come later.");
  if (!(await reasonIsActive(cmd.client, canonical.reasonKey ?? null))) throw bad("unknown_reason", "Unknown reason.");
  const athlete = athleteById(cmd.snap, canonical.athleteId);
  const refusal = decisionRefusal(athlete, kind, canonical.expectedDecisionId);
  if (refusal === "not_on_roster") throw conflict("not_on_roster", "This athlete is not on this session's roster.");
  if (refusal === "decision_changed") throw conflict("decision_changed", "This athlete's state changed.", { current: currentStateView(athlete) });
  if (refusal === "measured_record_exists") throw conflict("measured_record_exists", "This athlete has measured values.", { current: currentStateView(athlete) });
  if (kind === "cleared" && !athlete.currentDecisions.some((d) => d.decision_kind !== "cleared")) {
    throw conflict("nothing_to_clear", "This athlete has no state to remove.", { current: currentStateView(athlete) });
  }
  await cmd.persistInputChanged();
  const fresh = athleteById(cmd.snap, canonical.athleteId);
  const [written] = await writeDecisions(cmd, [{ athleteId: canonical.athleteId, newId: crypto.randomUUID(), currentDecisions: fresh.currentDecisions }], {
    kind, reasonKey: canonical.reasonKey ?? null, note: canonical.note ?? null,
  });
  const after = athleteById(cmd.snap, canonical.athleteId);
  return {
    decision: decisionView(written),
    athlete: after ? publicAthlete(after) : null,
    completion: cmd.snap.completion,
  };
}

export function decideAthlete(ctx, activityId, athleteId, body) {
  const validated = validateDecide(body, athleteId);
  return runRosterCommand(ctx, activityId, validated, (cmd, canonical) => applySingle(cmd, canonical, canonical.kind));
}

export function clearAthleteDecision(ctx, activityId, athleteId, body) {
  const validated = validateClear(body, athleteId);
  return runRosterCommand(ctx, activityId, validated, (cmd, canonical) => applySingle(cmd, canonical, "cleared"));
}

export function decideAthletesBulk(ctx, activityId, body) {
  const validated = validateBulk(body);
  return runRosterCommand(ctx, activityId, validated, async (cmd, canonical) => {
    if (LATER_KINDS.has(canonical.kind)) throw conflict("kind_not_available", "Manual values and estimates come later.");
    if (!(await reasonIsActive(cmd.client, canonical.reasonKey))) throw bad("unknown_reason", "Unknown reason.");
    // Every athlete is checked; any refusal refuses the whole request and
    // names every athlete that failed, with its current state.
    const failed = [];
    for (const entry of canonical.athletes) {
      const athlete = athleteById(cmd.snap, entry.athleteId);
      const refusal = decisionRefusal(athlete, canonical.kind, entry.expectedDecisionId);
      if (refusal) failed.push({ athleteId: entry.athleteId, error: refusal, ...(athlete ? { current: currentStateView(athlete) } : {}) });
    }
    if (failed.length) throw conflict("bulk_conflict", "Nothing was saved: some athletes changed.", { failed });
    await cmd.persistInputChanged();
    const rows = canonical.athletes.map((entry) => ({
      athleteId: entry.athleteId, newId: crypto.randomUUID(), currentDecisions: athleteById(cmd.snap, entry.athleteId).currentDecisions,
    }));
    const written = await writeDecisions(cmd, rows, { kind: canonical.kind, reasonKey: canonical.reasonKey, note: canonical.note });
    return {
      decisions: written.map(decisionView),
      athletes: canonical.athletes.map((e) => athleteById(cmd.snap, e.athleteId)).filter(Boolean).map(publicAthlete),
      completion: cmd.snap.completion,
    };
  });
}

// ---------------------------------------------------------------------------
// Complete and Reopen.
// ---------------------------------------------------------------------------
export function completeRoster(ctx, activityId, body) {
  const validated = validateComplete(body);
  return runRosterCommand(ctx, activityId, validated, async (cmd, canonical) => {
    const stored = completionFromRow(cmd.snap.completionRow);
    if (canonical.expectedRevision !== stored.revision) throw conflict("revision_changed", "The roster changed since you opened it.", { revision: stored.revision });
    if (stored.status === "complete" && !cmd.snap.inputChanged) throw conflict("already_complete", "This session is already complete.", { revision: stored.revision });
    await cmd.persistInputChanged();
    const { snap } = cmd;
    const current = completionFromRow(snap.completionRow);
    if (canonical.expectedFingerprint !== snap.fingerprint) {
      throw conflict("roster_changed", "The roster changed since you opened it.", { revision: current.revision });
    }
    if (snap.counts.total === 0) throw conflict("roster_empty", "Nobody is on this session's roster.");
    const needsStateAthleteIds = snap.athletes.filter((a) => a.group === "needs_state").map((a) => a.athleteId);
    if (needsStateAthleteIds.length) throw conflict("roster_incomplete", "Some athletes still need a state.", { needsStateAthleteIds, revision: current.revision });

    const revision = current.revision + 1;
    if (snap.completionRow) {
      await cmd.client.query(
        `update training.activity_completions
            set status = 'complete', revision = $2, completed_by_user_id = $3, completed_by_basis = $4, completed_at = now(),
                input_fingerprint = $5, needs_review_causes = '{}'
          where activity_id = $1`,
        [cmd.canonicalId, revision, ctx.userId, cmd.basis, snap.fingerprint],
      );
    } else {
      await cmd.client.query(
        `insert into training.activity_completions
           (activity_id, owner_team_id, status, revision, completed_by_user_id, completed_by_basis, completed_at, input_fingerprint)
         values ($1, $2, 'complete', 1, $3, $4, now(), $5)`,
        [cmd.canonicalId, cmd.teamId, ctx.userId, cmd.basis, snap.fingerprint],
      );
    }
    await cmd.client.query(
      `insert into training.activity_completion_log (activity_id, request_id, revision, from_status, to_status, cause, performed_by_user_id, detail)
       values ($1, $2, $3, $4, 'complete', 'completed', $5, $6)`,
      [cmd.canonicalId, cmd.requestId, revision, current.status, ctx.userId, JSON.stringify({ basis: cmd.basis, fingerprint: snap.fingerprint })],
    );
    cmd.snap = await loadRosterSnapshot(cmd.client, cmd.canonicalId);
    return { completion: cmd.snap.completion };
  });
}

export function reopenRoster(ctx, activityId, body) {
  const validated = validateReopen(body);
  return runRosterCommand(ctx, activityId, validated, async (cmd, canonical) => {
    const stored = completionFromRow(cmd.snap.completionRow);
    if (canonical.expectedRevision !== stored.revision) throw conflict("revision_changed", "The roster changed since you opened it.", { revision: stored.revision });
    if (stored.status === "not_complete") throw conflict("not_complete", "This session is not complete.", { revision: stored.revision });
    await cmd.persistInputChanged();
    const current = completionFromRow(cmd.snap.completionRow);
    const revision = current.revision + 1;
    await cmd.client.query(
      `update training.activity_completions
          set status = 'not_complete', revision = $2, completed_by_user_id = null, completed_by_basis = null, completed_at = null,
              input_fingerprint = null, needs_review_causes = '{}'
        where activity_id = $1`,
      [cmd.canonicalId, revision],
    );
    await cmd.client.query(
      `insert into training.activity_completion_log (activity_id, request_id, revision, from_status, to_status, cause, performed_by_user_id, detail)
       values ($1, $2, $3, $4, 'not_complete', 'reopened', $5, $6)`,
      [cmd.canonicalId, cmd.requestId, revision, current.status, ctx.userId, JSON.stringify({ basis: cmd.basis, reason: canonical.reason })],
    );
    cmd.snap = await loadRosterSnapshot(cmd.client, cmd.canonicalId);
    return { completion: cmd.snap.completion };
  });
}
