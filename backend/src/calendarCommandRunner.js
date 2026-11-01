// The calendar's one command runner (K2b-1a, T3: extracted from K2a's
// runEventCommand, docs/ai/central-calendar-k2a-plan.md section 4.3 and
// docs/ai/central-calendar-k2b-plan.md section 6). The event commands
// (calendarEventService.js) and the Settings -> Calendar commands
// (calendarSettingsService.js) both run through it, so there is one copy of
// the transaction, the requestKey replay and the bounded COMMIT:
//   1. BEGIN; lock_timeout 15 s (55P03 / 40P01 anywhere → 409 try_again)
//   2. prepare(): who may write, the writer lock and the subject's lock — the
//      caller's; it returns the request hash and its own state
//   3. the requestKey replay, AFTER the locks (so the caller is authorized
//      again): the same key and the same request → the saved answer, read
//      again now; the same key and another request → 409 request_key_reused;
//      a refused request writes no row, so its key stays free
//   4. apply(), then writeRecord(): the request row and its change row(s)
//      (the database refuses a COMMIT without the pair)
//   5. a bounded COMMIT (the roster commands' discipline): an answer within
//      15 s, else the request row is looked for on a new connection for 5 s
//      → the saved outcome with verifiedAfterCommitError, or 503
//      outcome_unknown — never "nothing was saved" after a sent COMMIT.
// A same-key race (a double submit, a retry during an in-flight COMMIT) ends
// in the saved answer, never a 500; a failing lookup says try again.
import crypto from "node:crypto";
import { pool } from "./db.js";
import { EventError } from "./calendarEventAccess.js";
import {
  COMMIT_ANSWER_TIMEOUT_MS, commitCertainlyRefused, NOTHING_SAVED, OUTCOME_UNKNOWN, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS,
} from "./activityRosterCommands.js";

export const COMMAND_LOCK_TIMEOUT = "15s";

export const requestKeyReused = () => new EventError(409, "request_key_reused", "This requestKey was already used for a different request.");

export function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The request hash: sha256 of the canonical request bound to its resource.
export function hashOf(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const REQUESTS_TABLES = new Set(["calendar.event_requests", "calendar.settings_requests"]);

// spec:
//   userId, requestKey, operation, label (for the log)
//   requestsTable          calendar.event_requests | calendar.settings_requests
//   requestKeyConstraint   that table's unique (performed_by_user_id, request_key)
//   busyMessage            the try_again sentence
//   hooks                  the service's test seams (commit, commitTimeoutMs,
//                          checkTimeoutMs, checkFault)
//   prepare(client)        → { hash, ... } (throws EventError for a refusal)
//   sameRequest(prior, prepared) → boolean (the hash and the bound resource)
//   apply({ client, requestId, ...prepared }) → out
//   writeRecord({ client, requestId, out, prepared, hash }) — request + changes
//   answer(queryable, storedResult, extra) → { status, body }
//   respond(out) → { status, body }
//   mapError(error) → EventError | null (constraint names, before COMMIT)
//   beforeRequestRow(client, out, prepared), beforeCommit(client, out) — seams
export async function runCalendarCommand(spec) {
  const { userId, requestKey, operation, requestsTable, requestKeyConstraint, busyMessage, hooks = {} } = spec;
  if (!REQUESTS_TABLES.has(requestsTable)) throw new Error(`unknown requests table ${requestsTable}`);
  const client = await pool.connect();
  let commitSent = false;
  let broken = false;
  let released = false;
  let hash = null;
  const onClientError = () => { broken = true; };
  client.on("error", onClientError);
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${COMMAND_LOCK_TIMEOUT}'`);
    const prepared = await spec.prepare(client);
    hash = prepared.hash;

    const prior = (await client.query(
      `select * from ${requestsTable} where performed_by_user_id = $1 and request_key = $2`,
      [userId, requestKey],
    )).rows[0];
    if (prior) {
      if (!spec.sameRequest(prior, prepared)) throw requestKeyReused();
      const answer = await spec.answer(client, prior.result, { replayed: true });
      await client.query("rollback");
      return { ...answer, replayed: true };
    }

    const requestId = crypto.randomUUID();
    const out = await spec.apply({ client, requestId, ...prepared });
    if (spec.beforeRequestRow) await spec.beforeRequestRow(client, out, prepared);
    await spec.writeRecord({ client, requestId, out, prepared, hash });
    if (spec.beforeCommit) await spec.beforeCommit(client, out);
    commitSent = true;
    const committing = Promise.resolve().then(() => (hooks.commit ? hooks.commit(client) : client.query("commit")));
    committing.catch(() => {});
    await withinBound(committing, hooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    return spec.respond(out);
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (error?.code === "55P03" || error?.code === "40P01") throw new EventError(409, "try_again", busyMessage);
      const mapped = spec.mapError ? spec.mapError(error) : null;
      if (mapped) throw mapped;
      if (error?.code === "23505" && error.constraint === requestKeyConstraint && hash) {
        let found;
        try {
          found = await findStoredResult(requestsTable, userId, requestKey, hash, hooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS, hooks);
        } catch (checkError) {
          console.error(`[${spec.label}] checking a racing ${operation} failed: ${checkError?.message}`);
          throw new EventError(409, "try_again", busyMessage);
        }
        if (found) return { ...(await spec.answer(pool, found, { replayed: true })), replayed: true };
        throw requestKeyReused();
      }
      throw error;
    }
    console.error(`[${spec.label}] commit of ${spec.subject ?? operation} failed: ${error?.code ?? ""} ${error?.message}`);
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      throw new EventError(500, "internal_error", NOTHING_SAVED);
    }
    released = true;
    client.removeListener("error", onClientError);
    client.on("error", () => {});
    client.release(true);
    let found = null;
    try {
      found = await findStoredResult(requestsTable, userId, requestKey, hash, hooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS, hooks);
    } catch (checkError) {
      console.error(`[${spec.label}] checking ${operation} after an unconfirmed COMMIT failed: ${checkError?.message}`);
    }
    if (found) return { ...(await spec.answer(pool, found, { verifiedAfterCommitError: true })), verifiedAfterCommitError: true };
    throw new EventError(503, "outcome_unknown", OUTCOME_UNKNOWN);
  } finally {
    if (!released) {
      client.removeListener("error", onClientError);
      client.release(broken ? true : undefined);
    }
  }
}

// Is the request committed? Bounded as a whole on a new connection (the
// roster commands' findStoredResult). Returns the stored result, or null.
async function findStoredResult(requestsTable, userId, requestKey, hash, ms, hooks) {
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
  const onErr = () => { bad = true; };
  checker.on("error", onErr);
  try {
    if (hooks.checkFault) await hooks.checkFault(checker);
    const answer = checker.query({
      text: `select request_hash, result from ${requestsTable} where performed_by_user_id = $1 and request_key = $2`,
      values: [userId, requestKey],
      query_timeout: left(),
    });
    answer.catch(() => {});
    const row = (await withinBound(answer, left())).rows[0];
    return row && row.request_hash === hash ? row.result : null;
  } catch (error) {
    bad = true;
    throw error;
  } finally {
    checker.removeListener("error", onErr);
    if (bad) checker.on("error", () => {});
    checker.release(bad ? true : undefined);
  }
}
