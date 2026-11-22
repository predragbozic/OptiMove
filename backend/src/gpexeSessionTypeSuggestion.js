// ST-2 (docs/ai/session-type-plan.md section 4): the team's suggestion follows the approver's choice.
//
// After a confirmed approval whose session type was the approver's choice, the team's suggestion for that source
// category (training_load.source_session_types, v85) is set to the chosen type - in its own short transaction, after
// the import's COMMIT is confirmed. It never takes the team's import lock and never touches the import. Best effort: a
// refusal of v85's guard (the approver is not a manager of the team, the type was archived a moment ago), a busy row or
// a lost connection leaves the suggestion as it was, and the import stays committed. The acting user is the approver
// (optimove.session_type_actor, the setting v85's guard reads). Only the import service calls this.
import { pool } from "./db.js";
import { isSessionTypeKey, SESSION_TYPE_SOURCE_SYSTEM, usableCategory } from "./gpexeSessionType.js";

export const SUGGESTION_WRITE_BOUND_MS = 5_000;
let suggestionWriteFault = null;
// Tests: fault(client) runs inside the transaction, before the write.
export function setSuggestionWriteFaultForTests(fn) {
  suggestionWriteFault = fn ?? null;
}

function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Never throws. { written: true } or { written: false, reason }.
export async function recordTeamSessionTypeSuggestion({ teamId, userId, categoryName, activityTypeKey }) {
  const category = usableCategory(categoryName);
  if (!category || !isSessionTypeKey(activityTypeKey)) return { written: false, reason: "not_recordable" };
  let client;
  let destroyed = false;
  const onError = () => {};
  try {
    client = await pool.connect();
    client.on("error", onError);
    const work = (async () => {
      await client.query("begin");
      await client.query(`select set_config('lock_timeout', '2s', true), set_config('statement_timeout', '3s', true), set_config('idle_in_transaction_session_timeout', '5s', true)`);
      await client.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [userId]);
      if (suggestionWriteFault) await suggestionWriteFault(client);
      await client.query(
        `insert into training_load.source_session_types (owner_team_id, source_system, category_name, activity_type_key, set_by_user_id, seeded)
         values ($1, $2, $3, $4, $5, false)
         on conflict (owner_team_id, source_system, category_name)
         do update set activity_type_key = excluded.activity_type_key, set_by_user_id = excluded.set_by_user_id, seeded = false`,
        [teamId, SESSION_TYPE_SOURCE_SYSTEM, category, activityTypeKey, userId],
      );
      await client.query("commit");
    })();
    work.catch(() => {}); // a statement that loses the race with the bound may still fail later
    await withinBound(work, SUGGESTION_WRITE_BOUND_MS);
    return { written: true };
  } catch (error) {
    // The code only (this importer's log rule): never an error's text.
    console.error(`[gpexe] the session type suggestion of team ${teamId} was not updated (${typeof error?.code === "string" ? error.code : "no answer"}); the import is committed`);
    if (client) {
      // A server answer leaves an aborted transaction to roll back; anything else leaves a connection that is not reused.
      if (typeof error?.code === "string") {
        try { await withinBound(client.query("rollback"), 2_000); } catch { destroyed = true; }
      } else {
        destroyed = true;
      }
    }
    return { written: false, reason: "failed" };
  } finally {
    if (client) {
      // A closed connection keeps its listener: a late socket error must never end the process.
      if (!destroyed) client.removeListener("error", onError);
      client.release(destroyed ? true : undefined);
    }
  }
}
