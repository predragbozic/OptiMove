// Undo ONE imported GPEXE session — the rehearsal of the procedure, not a
// feature. There is deliberately no UI, no API route and no per-athlete
// variant: this script exists so the way back from a bad import is written
// down, executable and proven before anything is imported into a persistent
// database.
//
//   Dry run (default) — reports exactly what would be removed, opens a
//   read-only transaction and rolls it back:
//     node backend/scripts/gpexe-undo-imported-session.mjs \
//       --database-url <url> --team-session 186942 --owner-team-id <uuid>
//
//   Apply — disposable test database only, same guard as the import CLI:
//     ... --apply --performed-by-user-id <uuid> --reason "bad drill mapping" --log undo.json
//
// What it removes, in this order (everything for that one event):
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
// binding (v20). Both triggers are disabled INSIDE the transaction and
// re-enabled before it commits, so the protection is never off outside this
// one statement sequence. A manual correction anywhere in the session stops
// the undo: removing someone's hand-entered value is a separate decision.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { parseArgs, describeApplyTarget, assertDisposableApplyTarget } from "./gpexe-import-pilot.mjs";

const PROTECTED_TRIGGERS = [
  ["training_load.metric_values", "metric_values_immutable"],
  ["training_load.metric_event_source_bindings", "metric_event_source_bindings_immutable"],
  ["training_load.metric_event_source_bindings", "metric_event_source_bindings_no_delete"],
];

export async function collectScope(client, { eventId }) {
  const one = async (sql, params = [eventId]) => (await client.query(sql, params)).rows;
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
  // The session's own reservation identity has no occasion, so it is found
  // through the binding's connection and external id instead.
  const reservation = binding.length
    ? await one(`select id from training_load.metric_source_identities where source_connection_id = $1 and source_external_id = $2`, [binding[0].source_connection_id, binding[0].source_external_id])
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
  const batchIds = [...new Set(occasions.map((r) => r.import_batch_id).filter(Boolean))];
  return {
    eventId,
    participantIds,
    occasionIds,
    valueCount: values[0].c,
    segmentIds: segments.map((r) => r.id),
    identityIds: [...new Set([...identityIds, ...reservation.map((r) => r.id)])],
    binding: binding[0] ?? null,
    activities,
    batchIds,
    manualOccasionIds: occasions.filter((r) => r.entry_method === "manual").map((r) => r.id),
  };
}

export async function undoImportedSession(client, scope, { performedByUserId, reason, apply }) {
  if (scope.manualOccasionIds.length) {
    throw new Error(`refusing: ${scope.manualOccasionIds.length} occasion(s) of this session were corrected manually — removing hand-entered values is a separate decision.`);
  }
  const sharedActivity = scope.activities.find((a) => a.participants_from_other_events > 0);
  if (sharedActivity) {
    throw new Error(`refusing: activity ${sharedActivity.id} also carries participants of another event — an activity is only removed when this session is its single source.`);
  }
  const removed = {};
  const run = async (label, sql, params) => {
    const r = await client.query(sql, params);
    removed[label] = (removed[label] || 0) + r.rowCount;
  };

  await client.query("begin");
  try {
    for (const [table, trigger] of PROTECTED_TRIGGERS) await client.query(`alter table ${table} disable trigger ${trigger}`);
    const activityIds = scope.activities.map((a) => a.id);
    if (activityIds.length) {
      await run("activity_component_metric_segment_links", `delete from training.activity_component_metric_segment_links l using training.activity_components c where c.id = l.activity_component_id and c.activity_id = any($1::uuid[])`, [activityIds]);
      await run("activity_components", `delete from training.activity_components where activity_id = any($1::uuid[])`, [activityIds]);
      await run("activity_participant_metric_participant_links", `delete from training.activity_participant_metric_participant_links l using training.activity_participants ap where ap.id = l.activity_participant_id and ap.activity_id = any($1::uuid[])`, [activityIds]);
      await run("activity_participants", `delete from training.activity_participants where activity_id = any($1::uuid[])`, [activityIds]);
      await run("activity_metric_event_links", `delete from training.activity_metric_event_links where activity_id = any($1::uuid[])`, [activityIds]);
      await run("activities", `delete from training.activities where id = any($1::uuid[])`, [activityIds]);
    }
    if (scope.occasionIds.length) {
      await run("metric_values", `delete from training_load.metric_values where occasion_id = any($1::uuid[])`, [scope.occasionIds]);
      await client.query(`update training_load.metric_source_identities set current_occasion_id = null where current_occasion_id = any($1::uuid[])`, [scope.occasionIds]);
      // Superseded chains point at each other, so they go newest-first.
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
    for (const [table, trigger] of PROTECTED_TRIGGERS) await client.query(`alter table ${table} enable trigger ${trigger}`);

    const log = {
      performedAt: new Date().toISOString(),
      performedByUserId: performedByUserId ?? null,
      reason: reason ?? null,
      applied: Boolean(apply),
      eventId: scope.eventId,
      sourceExternalId: scope.binding?.source_external_id ?? null,
      referenceSetExternalId: scope.binding?.reference_set_external_id ?? null,
      removed,
    };
    if (apply) await client.query("commit");
    else await client.query("rollback");
    return log;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.teamSession || !opts.ownerTeamId) throw new Error("--team-session and --owner-team-id are required");
  const target = describeApplyTarget(opts.databaseUrl);
  console.log(`Target: host ${target.host}, port ${target.port}, database ${target.database}`);
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    await assertDisposableApplyTarget(client, target);
    const event = (await client.query(
      `select e.id, e.event_name, e.occurred_date::text as occurred_date from training_load.metric_events e
       join training_load.metric_source_connections c on c.id = e.source_connection_id
       where c.source_system = 'gpexe' and c.owner_team_id = $1 and e.source_external_id = $2`,
      [opts.ownerTeamId, `team_session:${opts.teamSession}`],
    )).rows[0];
    if (!event) throw new Error(`no imported GPEXE event for team_session ${opts.teamSession} in team ${opts.ownerTeamId}`);
    const scope = await collectScope(client, { eventId: event.id });
    console.log(`Event ${event.id} "${event.event_name}" (${event.occurred_date})`);
    console.log(JSON.stringify({
      participants: scope.participantIds.length, occasions: scope.occasionIds.length, values: scope.valueCount,
      segments: scope.segmentIds.length, identities: scope.identityIds.length, activities: scope.activities.length,
      importBatches: scope.batchIds.length, manualCorrections: scope.manualOccasionIds.length,
    }, null, 2));
    const log = await undoImportedSession(client, scope, { performedByUserId: opts.performedByUserId, reason: opts.reason, apply: opts.apply });
    console.log(opts.apply ? "Applied." : "Dry run: the same statements ran and were rolled back; nothing was removed.");
    console.log(JSON.stringify(log, null, 2));
    if (opts.log) fs.writeFileSync(opts.log, JSON.stringify(log, null, 2));
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
