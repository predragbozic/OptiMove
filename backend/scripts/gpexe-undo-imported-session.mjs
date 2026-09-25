// Undo ONE imported GPEXE session — the rehearsal of the procedure, not a
// feature. There is deliberately no UI, no API route and no per-athlete
// variant: this script exists so the way back from a bad import is written
// down, executable and proven before anything is imported into a persistent
// database.
//
//   Dry run (default) — reports exactly what would be removed by running the
//   same statements in a normal transaction (protections disabled, exclusive
//   locks held on those tables for its duration) and rolling it back:
//     node backend/scripts/gpexe-undo-imported-session.mjs \
//       --database-url <url> --team-session 186942 --owner-team-id <uuid>
//
//   Apply — disposable test database only, same guard as the import CLI:
//     ... --apply --performed-by-user-id <uuid> --reason "bad drill mapping" --log undo.json
//
// Only a platform admin may run it, and only with a reason (owner decision
// 2026-09-18). The removal and one row in training_load.import_deletion_log
// (v21) are written in the same transaction; the log row names the session,
// the team, the admin, the reason and the rows removed, and cannot be
// changed afterwards. The CLI cannot authenticate whoever runs it: it checks
// that the user id given with --performed-by-user-id is an active platform
// admin, and the database checks it again when the log row is written.
//
// It refuses, rather than guessing, whenever the session is entangled with
// anything else: a manual correction, an activity that also carries another
// event or was merged/reparented, two events claiming the same GPEXE
// session, or coach work on the session's roster (v25 decisions, requests or
// completion: stable reason roster_decisions_exist). Every entry point checks that it is talking to a disposable
// database, not only the CLI wrapper.
//
// What it removes, in this order (everything for that one event):
//   activity_source_observations (v25, import by-products) ->
//   activity_component_metric_segment_links -> activity_components ->
//   activity_participant_metric_participant_links -> activity_participants ->
//   activity_metric_event_links -> activities (only when the activity has no
//   other event) ->
//   metric_values -> metric_source_identities.current_occasion_id (cleared) ->
//   metric_measurement_occasions -> metric_source_identities of this session ->
//   metric_event_participants -> metric_event_segments ->
//   metric_event_source_bindings -> metric_events ->
//   metric_import_batches that no other occasion uses.
// The GPEXE source connection and the metric definitions are NOT removed:
// they are not session-specific.
//
// Two rows are protected by design and are the reason this needs a written
// procedure at all: metric_values (v13 metric_values_immutable) and the event
// binding (v20); since v25 also the session's source observations, whose
// append-only trigger refuses a delete. These triggers (PROTECTED_TRIGGERS)
// are disabled INSIDE the transaction and
// re-enabled before it commits, so the protection is never off outside this
// one statement sequence. ALTER TABLE ... DISABLE TRIGGER is transactional in
// Postgres, so a rollback — from an error, a refusal, a dry run, or a lost
// connection — restores them without anything having to run; the explicit
// re-enable plus assertTriggersEnabled() covers the committing path, and the
// commit is refused if any of them is not enabled again.
// A manual correction anywhere in the session stops the undo: removing
// someone's hand-entered value is a separate decision.
//
// The log is written BEFORE the commit, with outcome "pending", and rewritten
// as "committed" afterwards. If the process dies in between, the file on disk
// still names the session, the scope and the reason; whether the transaction
// committed is then answered by a dry run against the database, which the
// runbook says to do. Writing the log only after the commit would have lost
// the record of a removal that did happen.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { parseArgs, describeApplyTarget, assertDisposableApplyTarget } from "./gpexe-import-pilot.mjs";

const DISPOSABLE_NAME = /^optimove_tests_gpexe_[a-z0-9_]+$/;

// Every exported function checks the target itself: these are delete
// statements, so "the CLI checked first" is not a guarantee a library caller
// inherits.
export async function assertDisposableClient(client) {
  const database = (await client.query("select current_database() as db")).rows[0].db;
  if (!DISPOSABLE_NAME.test(database)) {
    throw new Error(`refusing: ${database} is not a disposable GPEXE test database (optimove_tests_gpexe_*)`);
  }
  await assertDisposableApplyTarget(client, { database });
}

const PROTECTED_TRIGGERS = [
  ["training_load.metric_values", "metric_values_immutable"],
  ["training_load.metric_event_source_bindings", "metric_event_source_bindings_immutable"],
  ["training_load.metric_event_source_bindings", "metric_event_source_bindings_no_delete"],
  // v25: an import's source observations are its by-products and go with it.
  ["training.activity_source_observations", "activity_source_observations_append_only"],
];

// The stable reason the undo stops when a coach has already worked on the
// session's roster (v25 decisions, requests, completion): that is coach
// work, not an import by-product, and removing it is a separate decision.
export const ROSTER_DECISIONS_EXIST = "roster_decisions_exist";

export async function collectScope(client, { eventId }) {
  await assertDisposableClient(client);
  const one = async (sql, params = [eventId]) => (await client.query(sql, params)).rows;
  const event = (await one(
    `select e.id, e.source_connection_id, e.source_external_id, e.owner_team_id, e.occurred_date::text as occurred_date, c.source_system
     from training_load.metric_events e left join training_load.metric_source_connections c on c.id = e.source_connection_id
     where e.id = $1`,
  ))[0];
  if (!event) throw new Error(`no metric event ${eventId}`);
  const participants = await one(`select id from training_load.metric_event_participants where event_id = $1`);
  const participantIds = participants.map((r) => r.id);
  const occasions = participantIds.length
    ? await one(`select id, source_identity_id, entry_method, import_batch_id from training_load.metric_measurement_occasions where event_participant_id = any($1::uuid[])`, [participantIds])
    : [];
  const occasionIds = occasions.map((r) => r.id);
  const values = occasionIds.length
    ? await one(`select count(*)::int as c from training_load.metric_values where occasion_id = any($1::uuid[])`, [occasionIds])
    : [{ c: 0 }];
  const segments = await one(`select id from training_load.metric_event_segments where event_id = $1`);
  const binding = await one(`select event_id, source_connection_id, source_external_id, reference_set_external_id from training_load.metric_event_source_bindings where event_id = $1`);
  const identityIds = [...new Set(occasions.map((r) => r.source_identity_id).filter(Boolean))];
  // The session's own reservation identity has no occasion. It is found
  // through the EVENT's own connection and external id, not the binding's: a
  // binding may be absent (an import from before that guard existed) and the
  // reservation must be removed all the same.
  const reservation = event.source_connection_id && event.source_external_id
    ? await one(`select id from training_load.metric_source_identities where source_connection_id = $1 and source_external_id = $2`, [event.source_connection_id, event.source_external_id])
    : [];
  const activities = await one(
    `select distinct a.id, a.origin,
            (select count(*)::int
             from training.activity_participants ap2
             join training.activity_participant_metric_participant_links l2 on l2.activity_participant_id = ap2.id
             join training_load.metric_event_participants p2 on p2.id = l2.metric_event_participant_id
             where ap2.activity_id = a.id and p2.event_id <> $1) as participants_from_other_events
     from training.activities a
     join training.activity_participants ap on ap.activity_id = a.id
     join training.activity_participant_metric_participant_links l on l.activity_participant_id = ap.id
     join training_load.metric_event_participants p on p.id = l.metric_event_participant_id
     where p.event_id = $1`,
  );
  // An activity is reached by this session through its participants OR
  // through a direct event link, and removing it drops both kinds of link
  // row — so both have to be looked at before calling it ours alone.
  const reachedActivities = `
    select ap.activity_id from training.activity_participants ap
    join training.activity_participant_metric_participant_links pl on pl.activity_participant_id = ap.id
    join training_load.metric_event_participants p on p.id = pl.metric_event_participant_id
    where p.event_id = $1
    union
    select activity_id from training.activity_metric_event_links where metric_event_id = $1`;
  const otherEventLinks = await one(
    `select l.activity_id, l.metric_event_id, l.link_status from training.activity_metric_event_links l
     where l.activity_id in (${reachedActivities}) and l.metric_event_id <> $1`,
  );
  // Merged, reparented or superseded activities belong to a chain other rows
  // depend on; undoing one is not this procedure's business.
  const entangledActivities = await one(
    `select a.id, a.lifecycle_state, a.superseded_by_activity_id,
            (select count(*)::int from training.activity_participant_merge_log m where m.source_activity_id = a.id or m.target_activity_id = a.id) as merges,
            (select count(*)::int from training.activity_participant_reparent_log r where r.from_activity_id = a.id or r.to_activity_id = a.id) as reparents
     from training.activities a
     where a.id in (${reachedActivities})
       and (a.lifecycle_state = 'superseded' or a.superseded_by_activity_id is not null
            or exists (select 1 from training.activity_participant_merge_log m where m.source_activity_id = a.id or m.target_activity_id = a.id)
            or exists (select 1 from training.activity_participant_reparent_log r where r.from_activity_id = a.id or r.to_activity_id = a.id))`,
  );
  const batchIds = [...new Set(occasions.map((r) => r.import_batch_id).filter(Boolean))];
  // v25: the roster rows of every reached activity and of its whole alias
  // set. Observations are removed with the import; coach work stops it.
  const rosterAliases = `
    select aa.activity_id
      from (select distinct training.resolve_canonical_activity_id(r.activity_id) as canonical_id from (${reachedActivities}) r) c
      cross join lateral training.activity_alias_ids(c.canonical_id) aa`;
  const coachRosterWork = (await one(
    `select (select count(*)::int from training.activity_athlete_decisions where activity_id in (${rosterAliases})) as decisions,
            (select count(*)::int from training.activity_roster_requests where activity_id in (${rosterAliases})) as requests,
            (select count(*)::int from training.activity_completions where activity_id in (${rosterAliases})) as completions,
            (select count(*)::int from training.activity_completion_log where activity_id in (${rosterAliases})) as completion_log`,
  ))[0];
  const observationIds = (await one(
    `select id from training.activity_source_observations where activity_id in (${rosterAliases})`,
  )).map((r) => r.id);
  return {
    eventId,
    eventConnectionId: event.source_connection_id,
    eventOwnerTeamId: event.owner_team_id,
    eventOccurredDate: event.occurred_date,
    eventSourceSystem: event.source_system,
    eventExternalId: event.source_external_id,
    otherEventLinks,
    entangledActivities,
    participantIds,
    occasionIds,
    valueCount: values[0].c,
    segmentIds: segments.map((r) => r.id),
    identityIds: [...new Set([...identityIds, ...reservation.map((r) => r.id)])],
    binding: binding[0] ?? null,
    activities,
    batchIds,
    manualOccasionIds: occasions.filter((r) => r.entry_method === "manual").map((r) => r.id),
    coachRosterWork,
    observationIds,
  };
}

// The commit is only allowed once the database itself confirms that all the
// protections are back on (tgenabled 'O' = enabled).
export async function assertTriggersEnabled(client) {
  // Matched on schema, table AND trigger name: a same-named trigger on another
  // table must neither satisfy this check nor break it.
  const wanted = PROTECTED_TRIGGERS.map(([table, trigger]) => `${table}.${trigger}`);
  const rows = (await client.query(
    `select n.nspname || '.' || c.relname || '.' || t.tgname as name, t.tgenabled from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname || '.' || c.relname || '.' || t.tgname = any($1::text[])`,
    [wanted],
  )).rows;
  const found = new Map(rows.map((r) => [r.name, r.tgenabled]));
  const notEnabled = wanted.filter((name) => found.get(name) !== "O").map((name) => `${name}=${found.get(name) ?? "missing"}`);
  if (notEnabled.length) {
    throw new Error(`refusing to commit: protections are not back on (${notEnabled.join(", ")})`);
  }
}

// onBeforeVerify is a test hook: it runs after the protections are switched
// back on and before they are verified, so a test can prove the verification
// really guards the commit.
function assertUndoable(scope) {
  if (scope.manualOccasionIds.length) {
    throw new Error(`refusing: ${scope.manualOccasionIds.length} occasion(s) of this session were corrected manually — removing hand-entered values is a separate decision.`);
  }
  const sharedActivity = scope.activities.find((a) => a.participants_from_other_events > 0);
  if (sharedActivity) {
    throw new Error(`refusing: activity ${sharedActivity.id} also carries participants of another event — an activity is only removed when this session is its single source.`);
  }
  // An event link needs no participant link to exist
  // (trainingActivityMetricsLink.ensureConfirmedEventLink writes one on its
  // own), so the participant check above cannot see it.
  if (scope.otherEventLinks?.length) {
    const first = scope.otherEventLinks[0];
    throw new Error(`refusing: activity ${first.activity_id} is also linked to metric event ${first.metric_event_id} (${first.link_status}) — an activity is only removed when this session is its single source.`);
  }
  const work = scope.coachRosterWork;
  if (work && (work.decisions || work.requests || work.completions || work.completion_log)) {
    const error = new Error(`refusing (${ROSTER_DECISIONS_EXIST}): a coach has already worked on this session's roster (${work.decisions} decision(s), ${work.requests} request(s), ${work.completions} completion row(s), ${work.completion_log} completion log row(s)) — removing coach work is a separate, logged decision.`);
    error.code = ROSTER_DECISIONS_EXIST;
    throw error;
  }
  if (scope.entangledActivities?.length) {
    const first = scope.entangledActivities[0];
    throw new Error(`refusing: activity ${first.id} was merged, reparented or superseded (lifecycle ${first.lifecycle_state}, merges ${first.merges}, reparents ${first.reparents}) — removing it would break a chain another activity depends on.`);
  }
}

// The scope a caller passes in only names the event. What is actually
// checked and removed is collected again INSIDE the transaction, after the
// event row and then its activities are locked: a link added between an
// earlier look and this run is either visible here (and refused) or blocked
// until this transaction ends. Locking the event first and its activities
// second is the same direction the rest of the chain uses (event -> activity).
// Checked before anything is locked or disabled, with the role row read FOR
// SHARE so a concurrent revocation either lands first or waits for this run.
// The log trigger (v21) repeats the check when the row is written.
async function assertPlatformAdmin(client, userId) {
  const r = await client.query(
    `select 1 from public.user_global_roles r join public.users u on u.id = r.user_id
     where r.user_id = $1 and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
     for share of r`,
    [userId],
  );
  if (!r.rowCount) throw new Error(`refusing: user ${userId} is not an active platform admin — only a platform admin may undo an imported session.`);
}

export async function undoImportedSession(client, requested, { performedByUserId, reason, apply, onBeforeCommit, onBeforeVerify }) {
  await assertDisposableClient(client);
  if (!performedByUserId) throw new Error("refusing: the platform admin performing the undo must be named (performedByUserId).");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("refusing: a reason is required.");
  const removed = {};
  const run = async (label, sql, params) => {
    const r = await client.query(sql, params);
    removed[label] = (removed[label] || 0) + r.rowCount;
  };

  await client.query("begin");
  try {
    await assertPlatformAdmin(client, performedByUserId);
    const eventRow = await client.query(`select id from training_load.metric_events where id = $1 for update`, [requested.eventId]);
    if (!eventRow.rowCount) throw new Error(`no metric event ${requested.eventId}`);
    let scope = await collectScope(client, { eventId: requested.eventId });
    if (scope.activities.length) {
      await client.query(`select id from training.activities where id = any($1::uuid[]) order by id for update`, [scope.activities.map((a) => a.id)]);
      scope = await collectScope(client, { eventId: requested.eventId });
    }
    assertUndoable(scope);

    for (const [table, trigger] of PROTECTED_TRIGGERS) await client.query(`alter table ${table} disable trigger ${trigger}`);
    const activityIds = scope.activities.map((a) => a.id);
    if (scope.observationIds.length) {
      await run("activity_source_observations", `delete from training.activity_source_observations where id = any($1::uuid[])`, [scope.observationIds]);
    }
    if (activityIds.length) {
      await run("activity_component_metric_segment_links", `delete from training.activity_component_metric_segment_links l using training.activity_components c where c.id = l.activity_component_id and c.activity_id = any($1::uuid[])`, [activityIds]);
      await run("activity_components", `delete from training.activity_components where activity_id = any($1::uuid[])`, [activityIds]);
      // Only this event's links, never "every link of the activity": if a
      // foreign one were still there, deleting the activity below fails on
      // its foreign key and the whole run rolls back instead of taking it.
      await run("activity_participant_metric_participant_links", `delete from training.activity_participant_metric_participant_links l using training_load.metric_event_participants p where p.id = l.metric_event_participant_id and p.event_id = $1`, [scope.eventId]);
      await run("activity_participants", `delete from training.activity_participants where activity_id = any($1::uuid[])`, [activityIds]);
      await run("activity_metric_event_links", `delete from training.activity_metric_event_links where metric_event_id = $1`, [scope.eventId]);
      await run("activities", `delete from training.activities where id = any($1::uuid[])`, [activityIds]);
    }
    if (scope.occasionIds.length) {
      await run("metric_values", `delete from training_load.metric_values where occasion_id = any($1::uuid[])`, [scope.occasionIds]);
      await client.query(`update training_load.metric_source_identities set current_occasion_id = null where current_occasion_id = any($1::uuid[])`, [scope.occasionIds]);
      // One statement for the whole chain: occasions point at each other
      // through supersedes/superseded_by, and the referential checks run at
      // the end of the statement — so the order within it does not matter,
      // while deleting them one by one would.
      await run("metric_measurement_occasions", `delete from training_load.metric_measurement_occasions where id = any($1::uuid[])`, [scope.occasionIds]);
    }
    if (scope.identityIds.length) await run("metric_source_identities", `delete from training_load.metric_source_identities where id = any($1::uuid[])`, [scope.identityIds]);
    if (scope.participantIds.length) await run("metric_event_participants", `delete from training_load.metric_event_participants where id = any($1::uuid[])`, [scope.participantIds]);
    if (scope.segmentIds.length) await run("metric_event_segments", `delete from training_load.metric_event_segments where id = any($1::uuid[])`, [scope.segmentIds]);
    if (scope.binding) await run("metric_event_source_bindings", `delete from training_load.metric_event_source_bindings where event_id = $1`, [scope.eventId]);
    await run("metric_events", `delete from training_load.metric_events where id = $1`, [scope.eventId]);
    if (scope.batchIds.length) {
      await run("metric_import_batches", `delete from training_load.metric_import_batches b where b.id = any($1::uuid[]) and not exists (select 1 from training_load.metric_measurement_occasions o where o.import_batch_id = b.id)`, [scope.batchIds]);
    }
    // The database record of this removal, in the same transaction: it
    // commits with the removal or not at all.
    const removedTotal = Object.values(removed).reduce((sum, n) => sum + n, 0);
    const logRow = (await client.query(
      `insert into training_load.import_deletion_log
         (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id, owner_team_id, occurred_date, reference_set_external_id, removed_counts, removed_total)
       values ($1,'platform_admin',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, deleted_at`,
      [performedByUserId, reason.trim(), scope.eventId, scope.eventSourceSystem, scope.eventConnectionId, scope.eventExternalId, scope.eventOwnerTeamId, scope.eventOccurredDate, scope.binding?.reference_set_external_id ?? null, JSON.stringify(removed), removedTotal],
    )).rows[0];
    for (const [table, trigger] of PROTECTED_TRIGGERS) await client.query(`alter table ${table} enable trigger ${trigger}`);
    if (onBeforeVerify) await onBeforeVerify(client);
    await assertTriggersEnabled(client);

    const log = {
      performedAt: new Date().toISOString(),
      performedByUserId,
      authorizedVia: "platform_admin",
      reason: reason.trim(),
      // A dry run inserts the row too, then rolls it back: no id to point at.
      databaseLogId: apply ? logRow.id : null,
      teamId: scope.eventOwnerTeamId,
      applied: Boolean(apply),
      outcome: "pending",
      eventId: scope.eventId,
      sourceExternalId: scope.binding?.source_external_id ?? null,
      referenceSetExternalId: scope.binding?.reference_set_external_id ?? null,
      removed,
      removedTotal,
    };
    // Written to disk while the transaction is still open: a process that dies
    // during the commit must not leave a removal with no record of it.
    if (onBeforeCommit) await onBeforeCommit(log);
    if (apply) await client.query("commit");
    else await client.query("rollback");
    log.outcome = apply ? "committed" : "rolled_back";
    return log;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.teamSession || !opts.ownerTeamId) throw new Error("--team-session and --owner-team-id are required");
  // The log is part of the contract, not an option: an applied run has to
  // leave a record that names who ran it and why.
  // A dry run goes through the same checks as the real one (it runs the same
  // statements, the log insert included), so it needs the same identity.
  if (!opts.reason || !opts.performedByUserId) {
    throw new Error("--reason and --performed-by-user-id (an active platform admin) are required");
  }
  if (opts.apply && !opts.log) {
    throw new Error("--apply requires --log");
  }
  const target = describeApplyTarget(opts.databaseUrl);
  console.log(`Target: host ${target.host}, port ${target.port}, database ${target.database}`);
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    await assertDisposableApplyTarget(client, target);
    const events = (await client.query(
      `select e.id, e.event_name, e.occurred_date::text as occurred_date, c.state as connection_state
       from training_load.metric_events e
       join training_load.metric_source_connections c on c.id = e.source_connection_id
       where c.source_system = 'gpexe' and c.owner_team_id = $1 and e.source_external_id = $2
       order by e.id`,
      [opts.ownerTeamId, `team_session:${opts.teamSession}`],
    )).rows;
    if (!events.length) throw new Error(`no imported GPEXE event for team_session ${opts.teamSession} in team ${opts.ownerTeamId}`);
    // v20's uniqueness covers ACTIVE connections only, so an archived one can
    // leave a second event for the same session. Which of them to undo is a
    // decision — the importer refuses the same situation with duplicate_event.
    if (events.length > 1) {
      throw new Error(`ambiguous: ${events.length} events carry team_session ${opts.teamSession} in team ${opts.ownerTeamId} (connection states: ${events.map((e) => e.connection_state).join(", ")}) — resolve the connections first.`);
    }
    const event = events[0];
    const scope = await collectScope(client, { eventId: event.id });
    console.log(`Event ${event.id} "${event.event_name}" (${event.occurred_date})`);
    console.log(JSON.stringify({
      participants: scope.participantIds.length, occasions: scope.occasionIds.length, values: scope.valueCount,
      segments: scope.segmentIds.length, identities: scope.identityIds.length, activities: scope.activities.length,
      importBatches: scope.batchIds.length, manualCorrections: scope.manualOccasionIds.length,
    }, null, 2));
    // "wx" for the first write: the file may be the record of an earlier
    // applied run, and the runbook sends the operator back to this same
    // command to check the database afterwards. Only this run's own pending
    // record may be replaced, by its own second write.
    let mode = "wx";
    const writeLog = (log) => {
      if (!opts.log) return;
      const handle = fs.openSync(opts.log, mode);
      mode = "w";
      try {
        fs.writeFileSync(handle, JSON.stringify(log, null, 2));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    };
    const log = await undoImportedSession(client, scope, {
      performedByUserId: opts.performedByUserId, reason: opts.reason, apply: opts.apply,
      onBeforeCommit: (pending) => writeLog(pending),
    });
    writeLog(log);
    console.log(opts.apply ? "Applied." : "Dry run: the same statements ran and were rolled back; nothing was removed.");
    console.log(JSON.stringify(log, null, 2));
    return { event, scope, log };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
