// Source observations (Phase 5a1): the source-neutral record that a source
// had a device record for a roster athlete in a session but the record was
// not usable, so the roster can say "No usable device record" with the
// source's reason after the source's own data (e.g. the GPEXE preview) has
// been purged. Contract: docs/ai/phase5a-discovery-and-contract.md, 3.5.
//
// Written by an import adapter INSIDE its import transaction, after the team
// import lock (gpexeImportService.approveCandidate), so it commits or rolls
// back with the import. It never names anyone (ids only), never turns an
// unlinked source athlete into an OptiMove athlete (the caller passes linked
// OptiMove athlete ids only), and never touches a coach decision.
//
// Only athletes on the activity's roster on the session date are recorded;
// anyone else is skipped silently (the database refuses them as well). A
// repeat is idempotent: one open observation per activity, athlete,
// connection and kind (partial unique index). A later successful import of
// the athlete resolves the open one.

export const RECORD_UNUSABLE = "record_unusable";

// unusable: [{ athleteId, reasonCode, adapterReason }]; imported: [athleteId].
// Returns { recorded, resolved } counts. `client` must be inside a
// transaction (it uses a savepoint). hooks.afterRosterCheck is a test hook.
export async function recordImportObservations(client, { activityId, sourceConnectionId, unusable = [], imported = [], adapterRef = {} }, hooks = {}) {
  const canonical = (await client.query(`select training.resolve_canonical_activity_id($1) as id`, [activityId])).rows[0]?.id;
  if (!canonical) return { recorded: 0, resolved: 0 };
  // Only a session of the connection's own team has this roster. A session
  // merged into another team's activity is skipped, never a failed import.
  const sameTeam = (await client.query(
    `select a.owner_scope = 'team' and c.owner_scope = 'team' and a.owner_team_id = c.owner_team_id as ok
       from training.activities a, training_load.metric_source_connections c
      where a.id = $1 and c.id = $2`,
    [canonical, sourceConnectionId],
  )).rows[0]?.ok === true;
  if (!sameTeam) return { recorded: 0, resolved: 0 };

  let resolved = 0;
  const importedIds = [...new Set(imported.map(String))];
  if (importedIds.length) {
    resolved = (await client.query(
      `update training.activity_source_observations
          set resolved_at = greatest(now(), observed_at)
        where activity_id in (select activity_id from training.activity_alias_ids($1))
          and athlete_id = any($2::uuid[]) and source_connection_id = $3
          and kind = 'record_unusable' and resolved_at is null`,
      [canonical, importedIds, sourceConnectionId],
    )).rowCount;
  }

  let recorded = 0;
  const importedSet = new Set(importedIds);
  const candidates = unusable.filter((u) => u.athleteId && !importedSet.has(String(u.athleteId)));
  if (candidates.length) {
    const onRoster = new Set((await client.query(
      `select athlete_id from training.activity_roster($1) where athlete_id = any($2::uuid[])`,
      [canonical, candidates.map((u) => String(u.athleteId))],
    )).rows.map((r) => String(r.athlete_id)));
    if (hooks.afterRosterCheck) await hooks.afterRosterCheck();
    for (const u of candidates) {
      if (!onRoster.has(String(u.athleteId))) continue;
      const ref = { ...adapterRef, ...(u.adapterReason ? { adapterReason: String(u.adapterReason) } : {}) };
      // Membership changes do not take the team import lock, so an athlete
      // can leave the roster between the check above and this insert; the
      // insert trigger then refuses him. That athlete is skipped, never a
      // failed import: a savepoint keeps the caller's transaction usable.
      await client.query("savepoint activity_source_observation");
      try {
        recorded += (await client.query(
          `insert into training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind, reason_code, adapter_ref)
           values ($1, $2, $3, 'record_unusable', $4, $5)
           on conflict (activity_id, athlete_id, source_connection_id, kind) where resolved_at is null do nothing`,
          [canonical, String(u.athleteId), sourceConnectionId, u.reasonCode, JSON.stringify(ref)],
        )).rowCount;
        await client.query("release savepoint activity_source_observation");
      } catch (error) {
        await client.query("rollback to savepoint activity_source_observation");
        if (!(error?.code === "P0001" && /is not on the roster/.test(error.message ?? ""))) throw error;
      }
    }
  }
  return { recorded, resolved };
}
