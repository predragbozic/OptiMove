// The session type of each athlete in one session (ST-3 of docs/ai/session-type-plan.md, sections 3, 5 and 6;
// migration v89): the session's own type, an athlete's exception, the effective type, and how both stood at an earlier
// moment. A read module: it takes the caller's client (a snapshot, or a command's transaction after its locks), locks
// nothing and writes nothing. No pool import, so the pure parts load anywhere.
//
// The effective type of an athlete is the live exception of the athlete's canonical participant, otherwise the
// session's type - the rule of training.effective_activity_type(), repeated here for one session read at once.

// D7, option 1 (the owner, 2026-11-20): which past session types count toward an athlete's Own average. A game counts
// only games; a friendly counts friendlies and games; every other type, a club's own included, counts only itself.
// Deliberately one-directional: a game never counts a friendly.
const COMPARABLE_TYPES = Object.freeze({ friendly_match: Object.freeze(["friendly_match", "match"]) });
export function comparableSessionTypes(typeKey) {
  if (typeof typeKey !== "string" || !typeKey) return [];
  return [...(COMPARABLE_TYPES[typeKey] ?? [typeKey])];
}

// A world built without v89 (the suites that stop at an older migration) has no exception table: every athlete's type
// is then the session's, as before ST-3.
export async function participantTypesInstalled(client) {
  return (await client.query(`select to_regclass('training.participant_activity_types') is not null as installed`)).rows[0].installed === true;
}

const time = (value) => (value ? new Date(value).getTime() : null);
const iso = (value) => (value ? new Date(value).toISOString() : null);

// Everything about the types of one canonical activity. `withHistory` also reads the session's own type changes (only
// a reader that dates something against them needs it).
export async function readSessionTypeState(client, canonicalId, { withHistory = false } = {}) {
  const installed = await participantTypesInstalled(client);
  const sessionTypeKey = (await client.query(`select activity_type_key from training.activities where id = $1`, [canonicalId])).rows[0]?.activity_type_key ?? null;
  const byAthlete = new Map();
  let sessionChanges = [];
  if (installed) {
    // Every exception row of the alias set's participants, the ended ones too (history; what a merge or a reparent ended).
    const rows = (await client.query(
      `select ap.athlete_id, ap.id as participant_id, ap.merge_status, ap.activity_id = $1 as on_canonical,
              x.id, x.activity_type_key, x.reason, x.set_at, x.ended_at, x.end_cause,
              coalesce(nullif(u.display_name, ''), u.full_name) as set_by_name
         from training.activity_participants ap
         join training.participant_activity_types x on x.participant_id = ap.id
         left join public.users u on u.id = x.set_by_user_id
        where ap.activity_id in (select activity_id from training.activity_alias_ids($1))
        order by x.set_at, x.id`,
      [canonicalId],
    )).rows;
    for (const r of rows) {
      const athleteId = String(r.athlete_id);
      if (!byAthlete.has(athleteId)) byAthlete.set(athleteId, { rows: [], own: [], live: null });
      const entry = byAthlete.get(athleteId);
      const row = {
        activityTypeKey: r.activity_type_key, reason: r.reason ?? null, setAt: time(r.set_at), endedAt: time(r.ended_at),
        endCause: r.end_cause ?? null, setByName: r.set_by_name ?? null,
      };
      entry.rows.push(row);
      // `own`: the rows of the athlete's canonical participant in this session - the only ones that say what the
      // athlete's type HERE was at an earlier moment (a merged-in participant's rows belonged to another session).
      if (r.merge_status === "canonical" && r.on_canonical) {
        entry.own.push(row);
        if (row.endedAt === null) entry.live = row;
      }
    }
    if (withHistory) {
      // The correction log of THIS activity only (v1; v89 dates it by the wall clock): every type change through the
      // sanctioned function, whichever path called it. A session merged into this one keeps its own history apart.
      sessionChanges = (await client.query(
        `select old_values ->> 'activity_type_key' as old_type_key, new_values ->> 'activity_type_key' as new_type_key, changed_at
           from training.activity_field_correction_log
          where activity_id = $1 and old_values ->> 'activity_type_key' is distinct from new_values ->> 'activity_type_key'
          order by changed_at, id`,
        [canonicalId],
      )).rows.map((r) => ({ from: r.old_type_key ?? null, to: r.new_type_key ?? null, at: time(r.changed_at) }));
    }
  }
  return { installed, sessionTypeKey, byAthlete, sessionChanges };
}

// The athlete's effective type now.
export function effectiveTypeOf(state, athleteId) {
  return state.byAthlete.get(String(athleteId))?.live?.activityTypeKey ?? state.sessionTypeKey;
}

// The session's type as it stood at `at` (ms): the last change up to then gives it; with none before, the first later
// change's old type; with no change at all, today's.
function sessionTypeAt(state, at) {
  let before = null;
  for (const c of state.sessionChanges) if (c.at <= at) before = c;
  if (before) return before.to;
  const after = state.sessionChanges.find((c) => c.at > at);
  return after ? after.from : state.sessionTypeKey;
}

// The athlete's effective type as it stood at `at` (ms). Needs a state read `withHistory`.
export function effectiveTypeAt(state, athleteId, at) {
  const rows = state.byAthlete.get(String(athleteId))?.own ?? [];
  const then = rows.find((r) => r.setAt <= at && (r.endedAt === null || r.endedAt > at));
  return then ? then.activityTypeKey : sessionTypeAt(state, at);
}

// What the roster shows on an athlete's row: the effective type, the live exception, and - when there is none - the
// last exception a merge or a reparent ended (the roster's "changed under you" mark).
export function athleteSessionTypeView(state, athleteId) {
  const entry = state.byAthlete.get(String(athleteId));
  const live = entry?.live ?? null;
  const last = entry?.rows.length ? entry.rows[entry.rows.length - 1] : null;
  const ended = !live && last && last.endedAt !== null && (last.endCause === "merge" || last.endCause === "reparent")
    ? { activityTypeKey: last.activityTypeKey, cause: last.endCause, endedAt: iso(last.endedAt) }
    : null;
  return {
    effectiveKey: live?.activityTypeKey ?? state.sessionTypeKey,
    exception: live ? { activityTypeKey: live.activityTypeKey, reason: live.reason, setBy: live.setByName, setAt: iso(live.setAt) } : null,
    endedException: ended,
  };
}

// The labels of the given type keys (archived ones too: a session keeps an archived type).
export async function sessionTypeLabels(client, keys) {
  const wanted = [...new Set((keys || []).filter((k) => typeof k === "string" && k))];
  if (!wanted.length) return new Map();
  return new Map((await client.query(`select key, label from training.activity_types where key = any($1::text[])`, [wanted])).rows.map((r) => [r.key, r.label]));
}
