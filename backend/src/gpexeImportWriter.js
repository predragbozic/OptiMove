// GPEXE import plan -> Training Load (pilot). Writes one plan from
// gpexeImportMapper.js in ONE transaction on a caller-owned pg client.
// Deliberately does not import db.js: the caller decides which database
// the client is connected to (see backend/scripts/gpexe-import-pilot.mjs for the
// guard that only allows a disposable test database in this phase).
//
// Idempotency and concurrency:
// - The whole import runs under a transaction-scoped advisory lock keyed
//   by the owner team, taken before any read. Two concurrent imports for
//   the same team therefore serialize completely: the second one only
//   starts reading after the first has committed, and finds every row
//   the first one wrote. The unique (source_connection_id,
//   source_external_id) constraint on metric_source_identities stays the
//   last-resort backstop.
// - All source identities of the plan are locked before the event and any
//   occasion (see lockPlanIdentities), matching the v13 lock order used by
//   the manual correction path.
// - A re-import that no longer contains a previously imported result stops
//   with identities_missing_from_source instead of leaving it effective.
// - Database backstops (v20), in addition to the advisory lock:
//   metric_source_identities is unique on (connection, external_id) — the
//   plan also reserves one identity for the session itself
//   (team_session:<id>), so two first imports serialize in the database and
//   not only on the advisory lock; a BEFORE INSERT guard on metric_events
//   refuses a second event for the same gpexe connection and
//   source_external_id, whoever writes it, so the duplicate row cannot come
//   into existence at all; metric_event_source_bindings is unique on
//   (connection, external_id) and holds one row per event;
//   metric_source_connections has a partial unique index that allows one
//   ACTIVE gpexe connection per team. v12's generic contract is unchanged:
//   metric_events itself still carries descriptive provenance only.
//   Drill segment links are additionally protected by
//   activity_component_metric_links_one_confirmed_idx.
// - The binding also stores WHICH GPEXE threshold set produced the session
//   (id, validity window, the thresholds themselves, and a hash). A
//   re-import whose set differs stops with source_reference_set_changed:
//   restating what stored values mean is a separate decision, never an
//   automatic rewrite.
// - Each imported result set has its own source identity:
//   athlete_session:<id>:full and athlete_session:<id>:drill:<n>.
// - The occasion content hash covers level, drill index, and per value the
//   metric key, definition/version, value, unit, aggregation_role, coverage
//   and the GPEXE source context (field, source unit, thresholds), so a
//   change in meaning is never treated as "unchanged".
// - Imported values are GPEXE's own values: is_derived is always false.
//
// Re-import of an existing identity (current occasion kept or superseded):
//   same hash                               -> unchanged (no write)
//   current occasion was entered manually   -> stale_resend_ignored (flagged)
//   every current value unchanged, only new metrics added, source_reported_at
//   not older (e.g. drill details fetched later)
//                                           -> supplemented (supersedes)
//   newer source_reported_at, same metrics  -> corrected (supersedes)
//   same/missing source_reported_at, or any other change of the metric set
//                                           -> needs_review (flagged)
//   older source_reported_at                -> stale_resend_ignored (flagged)
// A flagged result with the same hash and status is written only once.
import crypto from "crypto";

export class GpexeImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const IMPORT_LOCK_SEED = 21;

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
  return out;
}

// Hash of the external reference set (GPEXE team thresholds) exactly as the
// plan carries it: id, validity window and the thresholds the import depends
// on. Stored with the event so a later import can tell "same set" from "the
// source redefined the set" without comparing free-form JSON by eye.
// The mapper normalizes those thresholds to numbers first, so a set GPEXE
// re-serializes differently (5.5 vs "5.5") still hashes the same.
export const REFERENCE_SET_HASH_VERSION = 1;

export function referenceSetHash(thresholdsUsed) {
  // Only what changes MEANING: the set's identity and its thresholds. The
  // validity window is stored but not hashed — GPEXE closes an open window
  // when a successor set is created, and that must not stop a re-import of a
  // session whose thresholds are unchanged. REFERENCE_SET_HASH_VERSION is
  // stored next to the hash, never mixed into it, so a future change of this
  // rule is recognizable instead of looking like a changed source.
  const canon = {
    externalId: String(thresholdsUsed.id),
    payload: thresholdsUsed.payload ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(canon))).digest("hex");
}

export function importedOccasionContentHash({ level, drillIndex, values }) {
  const sorted = [...values].sort((a, b) => a.metricKey.localeCompare(b.metricKey));
  const canon = {
    level,
    drillIndex: drillIndex ?? null,
    values: sorted.map((v) => ({
      metricKey: v.metricKey,
      metricDefinitionId: v.metricDefinitionId,
      metricDefinitionVersionId: v.metricDefinitionVersionId,
      value: v.value,
      unit: v.unit,
      aggregationRole: v.aggregationRole,
      coverage: v.coverage,
      sourceContext: v.sourceContext ?? null,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(canon))).digest("hex");
}

// A whole-session value is the device's own session total; a drill value is
// a raw per-part value (training_activity_v3 aggregation_role contract).
function roleForLevel(level) {
  return level === "full" ? { aggregationRole: "source_rollup", coverage: "complete" } : { aggregationRole: "standalone", coverage: "not_applicable" };
}

async function assertAthletesInTeam(client, ownerTeamId, athleteIds) {
  const r = await client.query(
    `select a.id from public.athletes a
     where a.id = any($1::uuid[])
       and exists (select 1 from public.athlete_memberships m
                   where m.athlete_id = a.id and m.team_id = $2 and m.membership_type = 'team' and m.status = 'active')`,
    [athleteIds, ownerTeamId],
  );
  const found = new Set(r.rows.map((row) => String(row.id)));
  const missing = athleteIds.filter((id) => !found.has(String(id)));
  if (missing.length) throw new GpexeImportError("athlete_not_in_team", `athlete(s) ${missing.join(", ")} have no active membership in team ${ownerTeamId}.`);
}

async function ensureSourceConnection(client, { sourceSystem, ownerTeamId }) {
  const existing = await client.query(
    `select id from training_load.metric_source_connections
     where source_system = $1 and owner_scope = 'team' and owner_team_id = $2 and state = 'active'`,
    [sourceSystem, ownerTeamId],
  );
  if (existing.rowCount > 1) throw new GpexeImportError("ambiguous_source_connection", `team ${ownerTeamId} has ${existing.rowCount} active ${sourceSystem} connections.`);
  if (existing.rowCount === 1) return { id: existing.rows[0].id, created: false };
  try {
    const inserted = await client.query(
      `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ($1,'team',$2) returning id`,
      [sourceSystem, ownerTeamId],
    );
    return { id: inserted.rows[0].id, created: true };
  } catch (error) {
    // v20 partial unique index: one active gpexe connection per team.
    if (error.code === "23505") {
      throw new GpexeImportError("source_connection_conflict", `another import created an active ${sourceSystem} connection for team ${ownerTeamId} at the same time — retry the import.`);
    }
    throw error;
  }
}

function conditionDescriptionFor(metric) {
  return { source: "gpexe", definition: metric.definition, sourceContext: metric.sourceContext };
}

// Existing definitions are reused only when their current version has the
// same label, unit, value type, daily aggregation, GPEXE source context
// (condition_description) and the needed scope capabilities; anything else
// stops the import rather than writing under a changed meaning.
async function ensureMetricDefinitions(client, { metrics, ownerTeamId, performedByUserId, scopeLevels }) {
  const byKey = new Map();
  const created = [];
  // FOR SHARE on every existing definition, sorted, BEFORE reading the fields
  // the reuse decision depends on: it conflicts with the FOR UPDATE that
  // archiveDefinition / createDefinitionVersion / setDefinitionScopeCapabilities
  // take first, so a catalog change either commits before the reads below (and
  // is seen) or waits until this import commits. Same pattern as
  // resolveValueEntries in trainingLoadMetricsMeasurements.js; it also covers
  // the FOR KEY SHARE the manual value-write paths take.
  await client.query(
    `select id from training_load.metric_definitions
     where owner_scope = 'team' and owner_team_id = $1 and key = any($2::text[])
     order by id for share`,
    [ownerTeamId, metrics.map((m) => m.key)],
  );
  for (const metric of metrics) {
    const existing = await client.query(
      `select d.id, d.label, d.state, d.current_version_id, v.unit, v.value_type, v.daily_aggregation_method, v.condition_description,
              coalesce((select array_agg(sc.scope_level) from training_load.metric_definition_scope_capabilities sc where sc.metric_definition_id = d.id), array[]::varchar[]) as scope_capabilities
       from training_load.metric_definitions d
       join training_load.metric_definition_versions v on v.id = d.current_version_id
       where d.owner_scope = 'team' and d.owner_team_id = $1 and d.key = $2`,
      [ownerTeamId, metric.key],
    );
    const row = existing.rows[0];
    if (row) {
      const caps = new Set(row.scope_capabilities);
      const sameCondition = JSON.stringify(canonicalize(row.condition_description)) === JSON.stringify(canonicalize(conditionDescriptionFor(metric)));
      if (row.state !== "active" || row.label !== metric.label || row.unit !== metric.unit || row.value_type !== "numeric"
        || row.daily_aggregation_method !== metric.dailyAggregationMethod || !sameCondition || scopeLevels.some((s) => !caps.has(s))) {
        throw new GpexeImportError("metric_definition_mismatch", `existing definition ${metric.key} (state ${row.state}, label ${row.label}, unit ${row.unit}, aggregation ${row.daily_aggregation_method}, scopes ${[...caps].join("/")}) does not match the import mapping.`);
      }
      byKey.set(metric.key, { metricDefinitionId: row.id, metricDefinitionVersionId: row.current_version_id });
      continue;
    }
    const definition = await client.query(
      `insert into training_load.metric_definitions (key, label, short_label, description, owner_scope, owner_team_id, created_by_user_id)
       values ($1,$2,$3,$4,'team',$5,$6) returning id`,
      [metric.key, metric.label, metric.label, `Imported from GPEXE: ${metric.sourceContext.field}`, ownerTeamId, performedByUserId],
    );
    const definitionId = definition.rows[0].id;
    const version = await client.query(
      `insert into training_load.metric_definition_versions
         (metric_definition_id, version_number, unit, value_type, condition_description, daily_aggregation_method, created_by_user_id)
       values ($1,1,$2,'numeric',$3,$4,$5) returning id`,
      [definitionId, metric.unit, JSON.stringify(conditionDescriptionFor(metric)), metric.dailyAggregationMethod, performedByUserId],
    );
    await client.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [version.rows[0].id, definitionId]);
    for (const scopeLevel of scopeLevels) {
      await client.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,$2)`, [definitionId, scopeLevel]);
    }
    byKey.set(metric.key, { metricDefinitionId: definitionId, metricDefinitionVersionId: version.rows[0].id });
    created.push(metric.key);
  }
  return { byKey, created };
}

async function ensureEvent(client, { plan, connectionId, ownerTeamId, performedByUserId }) {
  const existing = await client.query(
    `select id, occurred_date::text as occurred_date, occurred_instant, event_timezone_snapshot, scope_level, owner_scope, owner_team_id
     from training_load.metric_events where source_connection_id = $1 and source_external_id = $2`,
    [connectionId, plan.event.sourceExternalId],
  );
  if (existing.rowCount > 1) throw new GpexeImportError("duplicate_event", `${existing.rowCount} events exist for ${plan.event.sourceExternalId}.`);
  const row = existing.rows[0];
  if (row) {
    const same = row.occurred_date === plan.event.occurredLocalDate
      && new Date(row.occurred_instant).toISOString() === plan.event.occurredInstant
      && row.event_timezone_snapshot === plan.event.timezone
      && row.scope_level === "session" && row.owner_scope === "team" && String(row.owner_team_id) === String(ownerTeamId);
    if (!same) throw new GpexeImportError("event_changed", `event for ${plan.event.sourceExternalId} exists with a different date/time/timezone/owner — needs review.`);
    return { id: row.id, created: false };
  }
  try {
    const inserted = await client.query(
      `insert into training_load.metric_events
         (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, created_by_user_id, event_timezone_snapshot)
       values ($1,$2,$3,'session','team',$4,$5,$6,$7,$8) returning id`,
      [plan.event.name, plan.event.occurredLocalDate, plan.event.occurredInstant, ownerTeamId, connectionId, plan.event.sourceExternalId, performedByUserId, plan.event.timezone],
    );
    return { id: inserted.rows[0].id, created: true };
  } catch (error) {
    // The v20 guard on metric_events, raised as unique_violation.
    if (error.code === "23505") {
      throw new GpexeImportError("event_conflict", `another writer created an event for ${plan.event.sourceExternalId} at the same time — retry the import.`);
    }
    throw error;
  }
}

// v20: the binding is what makes "one event per GPEXE team_session" a
// database guarantee, and it records the threshold set the session was
// imported under. Written right after the event and before any occasion, so
// the event row is locked no later than the occasion trigger would lock it.
async function ensureSourceBinding(client, { eventId, eventCreated, connectionId, plan, performedByUserId }) {
  const hash = referenceSetHash(plan.thresholdsUsed);
  const existing = await client.query(
    `select event_id, reference_set_external_id, reference_valid_from, reference_valid_to, reference_hash, reference_hash_version
     from training_load.metric_event_source_bindings
     where source_connection_id = $1 and source_external_id = $2 for update`,
    [connectionId, plan.event.sourceExternalId],
  );
  const row = existing.rows[0];
  if (row) {
    if (String(row.event_id) !== String(eventId)) {
      // Unreachable while the v20 metric_events guard stands (a second event
      // for this key cannot exist); kept as the check that would catch it if
      // that guard were ever relaxed.
      throw new GpexeImportError("binding_event_mismatch", `${plan.event.sourceExternalId} is already bound to another event.`);
    }
    if (row.reference_hash_version !== REFERENCE_SET_HASH_VERSION) {
      // The stored hash was computed by a different rule, so it says nothing
      // about whether the source changed. Deciding what to do with such a row
      // is its own task, not something an import may assume.
      const error = new GpexeImportError(
        "reference_hash_version_outdated",
        `${plan.event.sourceExternalId} was bound under reference hash version ${row.reference_hash_version}, this importer writes version ${REFERENCE_SET_HASH_VERSION} — the two cannot be compared.`,
      );
      error.storedReferenceSet = { externalId: row.reference_set_external_id, hashVersion: row.reference_hash_version };
      throw error;
    }
    if (row.reference_hash !== hash) {
      const error = new GpexeImportError(
        "source_reference_set_changed",
        `${plan.event.sourceExternalId} was imported under GPEXE threshold set ${row.reference_set_external_id} (valid ${row.reference_valid_from?.toISOString?.() ?? row.reference_valid_from} – ${row.reference_valid_to?.toISOString?.() ?? row.reference_valid_to ?? "open"}), the source now reports set ${plan.thresholdsUsed.id} — needs a decision before re-import.`,
      );
      error.storedReferenceSet = { externalId: row.reference_set_external_id, validFrom: row.reference_valid_from, validTo: row.reference_valid_to, hash: row.reference_hash };
      error.incomingReferenceSet = { externalId: plan.thresholdsUsed.id, validFrom: plan.thresholdsUsed.validityStart, validTo: plan.thresholdsUsed.validityEnd, hash };
      throw error;
    }
    const windowChanged = (row.reference_valid_to?.toISOString?.() ?? null) !== (plan.thresholdsUsed.validityEnd ?? null)
      || (row.reference_valid_from?.toISOString?.() ?? null) !== (plan.thresholdsUsed.validityStart ?? null);
    // Same set, same thresholds, a moved validity window: the values keep
    // their meaning, so the import continues and the recorded (immutable)
    // window stays as it was, reported rather than rewritten.
    return {
      created: false, hash, windowChanged,
      // What the immutable row actually records, so a caller reports that and
      // not the set it happens to be holding.
      storedReferenceSet: {
        externalId: row.reference_set_external_id,
        validFrom: row.reference_valid_from?.toISOString?.() ?? row.reference_valid_from ?? null,
        validTo: row.reference_valid_to?.toISOString?.() ?? row.reference_valid_to ?? null,
        hash: row.reference_hash,
        hashVersion: row.reference_hash_version,
      },
    };
  }
  if (!eventCreated) {
    throw new GpexeImportError("binding_missing", `event ${eventId} for ${plan.event.sourceExternalId} exists without a source binding — its values were imported before this guard existed, or by another writer; recording a threshold set for them now would be a guess.`);
  }
  try {
    await client.query(
      `insert into training_load.metric_event_source_bindings
         (event_id, source_connection_id, source_external_id, reference_set_external_id, reference_valid_from, reference_valid_to, reference_payload, reference_hash, reference_hash_version, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [eventId, connectionId, plan.event.sourceExternalId, String(plan.thresholdsUsed.id), plan.thresholdsUsed.validityStart, plan.thresholdsUsed.validityEnd, JSON.stringify(plan.thresholdsUsed.payload ?? null), hash, REFERENCE_SET_HASH_VERSION, performedByUserId],
    );
  } catch (error) {
    if (error.code === "23505") {
      // Reachable as a concurrent import of this same session that committed
      // between the select above and this insert; the event guard makes a
      // genuinely different event impossible.
      throw new GpexeImportError("binding_conflict", `${plan.event.sourceExternalId} was bound by a concurrent import — retry.`);
    }
    throw error;
  }
  return {
    created: true, hash,
    storedReferenceSet: {
      externalId: String(plan.thresholdsUsed.id), validFrom: plan.thresholdsUsed.validityStart,
      validTo: plan.thresholdsUsed.validityEnd, hash, hashVersion: REFERENCE_SET_HASH_VERSION,
    },
  };
}

async function ensureSegments(client, { eventId, segments }) {
  const byDrillIndex = new Map();
  for (const segment of segments) {
    const existing = await client.query(`select id from training_load.metric_event_segments where event_id = $1 and segment_order = $2`, [eventId, segment.order]);
    if (existing.rowCount > 1) throw new GpexeImportError("duplicate_segment", `event ${eventId} has ${existing.rowCount} segments with order ${segment.order}.`);
    const id = existing.rows[0]?.id
      ?? (await client.query(`insert into training_load.metric_event_segments (event_id, label, segment_order) values ($1,$2,$3) returning id`, [eventId, segment.label, segment.order])).rows[0].id;
    byDrillIndex.set(segment.drillIndex, { ...segment, segmentId: id });
  }
  return byDrillIndex;
}

async function ensureParticipants(client, { eventId, participants, athleteIdByGpexeId }) {
  const byGpexeId = new Map();
  for (const participant of participants) {
    const athleteId = athleteIdByGpexeId.get(participant.gpexeAthleteId);
    const existing = await client.query(`select id, athlete_timezone_snapshot from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [eventId, athleteId]);
    let id = existing.rows[0]?.id;
    if (id && existing.rows[0].athlete_timezone_snapshot !== participant.timezone) {
      throw new GpexeImportError("participant_timezone_changed", `participant ${athleteId} was imported with timezone ${existing.rows[0].athlete_timezone_snapshot}, now ${participant.timezone}.`);
    }
    if (!id) {
      id = (await client.query(
        `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,$3) returning id`,
        [eventId, athleteId, participant.timezone],
      )).rows[0].id;
    }
    byGpexeId.set(participant.gpexeAthleteId, id);
  }
  return byGpexeId;
}

// One drill component per segment, linked the same way
// trainingActivityMetricsLink.js resolveOrCreateComponentLink links a source
// segment (component-scope values require this confirmed link to exist).
async function ensureDrillComponents(client, { activityId, segmentsByDrillIndex, performedByUserId }) {
  for (const segment of segmentsByDrillIndex.values()) {
    const linked = await client.query(
      `select l.activity_component_id, c.activity_id from training.activity_component_metric_segment_links l
       join training.activity_components c on c.id = l.activity_component_id
       where l.metric_event_segment_id = $1 and l.link_status = 'confirmed'`,
      [segment.segmentId],
    );
    if (linked.rowCount) {
      const canonical = await client.query(`select training.resolve_canonical_activity_id($1) as id`, [linked.rows[0].activity_id]);
      if (String(canonical.rows[0].id) !== String(activityId)) throw new GpexeImportError("segment_linked_elsewhere", `segment ${segment.segmentId} is linked to a component of another activity.`);
      continue;
    }
    const component = await client.query(
      `insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin, sort_order)
       values ($1,'drill',$2,'api_source',$3) returning id`,
      [activityId, segment.label, segment.order],
    );
    await client.query(
      `insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
       values ($1,$2,'automatic','confirmed',$3,now(),$3)`,
      [component.rows[0].id, segment.segmentId, performedByUserId],
    );
  }
}

async function insertOccasionWithValues(client, { participantId, segmentId, identityId, contentHash, sourceReportedAt, batch, performedByUserId, values, supersedesOccasionId = null, conflictStatus = null }) {
  const batchId = await batch.id();
  const occasion = await client.query(
    `insert into training_load.metric_measurement_occasions
       (event_participant_id, segment_id, entry_method, content_hash, source_identity_id, source_reported_at, import_batch_id, row_number, recorded_by_user_id, supersedes_occasion_id, import_conflict_status)
     values ($1,$2,'api_import',$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [participantId, segmentId, contentHash, identityId, sourceReportedAt, batchId, batch.nextRow(), performedByUserId, supersedesOccasionId, conflictStatus],
  );
  const occasionId = occasion.rows[0].id;
  for (const v of values) {
    await client.query(
      `insert into training_load.metric_values
         (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage)
       values ($1,$2,$3,$4,$5,false,$6,$7)`,
      [occasionId, v.metricDefinitionId, v.metricDefinitionVersionId, v.value, v.unit, v.aggregationRole, v.coverage],
    );
  }
  return occasionId;
}

// Every identity of the plan is created and locked (FOR UPDATE, ordered by
// id) before the event, participants, activity links or any occasion are
// touched. The v13 lock order is identity -> batch -> participant -> event ->
// segment (lock_ancestors_before_occasion_insert), and the manual correction
// path (correctImportedOccasionManually) locks one identity and then the
// event; locking an identity after this transaction already holds the event
// would let the two deadlock.
async function lockPlanIdentities(client, { connectionId, externalIds }) {
  const sorted = [...new Set(externalIds)].sort();
  for (const externalId of sorted) {
    await client.query(
      `insert into training_load.metric_source_identities (source_connection_id, source_external_id) values ($1,$2)
       on conflict (source_connection_id, source_external_id) do nothing`,
      [connectionId, externalId],
    );
  }
  const rows = (await client.query(
    `select id, source_external_id, current_occasion_id from training_load.metric_source_identities
     where source_connection_id = $1 and source_external_id = any($2::text[]) order by id for update`,
    [connectionId, sorted],
  )).rows;
  if (rows.length !== sorted.length) throw new GpexeImportError("identity_lock_failed", `locked ${rows.length} of ${sorted.length} source identities.`);
  return new Map(rows.map((row) => [row.source_external_id, row]));
}

// Identities of this source connection whose current value belongs to this
// event but that the new plan no longer contains (athlete now invalid or on
// two tracks, drill removed or renumbered). They would stay effective, so
// the pilot stops and reports them instead of silently keeping them.
// Those identities are not in the plan, so they are not locked here: the
// reported set is a snapshot at this read. The import never writes to them.
async function assertNoIdentitiesMissingFromSource(client, { connectionId, eventId, externalIds }) {
  const missing = (await client.query(
    `select si.source_external_id from training_load.metric_source_identities si
     join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     where si.source_connection_id = $1 and p.event_id = $2 and not (si.source_external_id = any($3::text[]))
     order by si.source_external_id`,
    [connectionId, eventId, externalIds],
  )).rows.map((row) => row.source_external_id);
  if (missing.length) {
    const error = new GpexeImportError("identities_missing_from_source", `previously imported result(s) are no longer in the GPEXE source: ${missing.join(", ")} — needs review before re-import.`);
    error.missingExternalIds = missing;
    throw error;
  }
}

// A supplement only ADDS metrics to an imported result: every value of the
// current occasion is present in the new result with the same definition,
// definition version (which carries the GPEXE source context), value, unit,
// aggregation_role and coverage, and at least one metric is new. Any
// removed or changed value is not a supplement. Returns the added metric
// keys, or null.
function isPureSupplement(currentValues, newValues) {
  if (newValues.length <= currentValues.length) return null;
  const byDefinition = new Map(newValues.map((v) => [String(v.metricDefinitionId), v]));
  for (const row of currentValues) {
    const v = byDefinition.get(String(row.metric_definition_id));
    if (!v
      || String(row.metric_definition_version_id) !== String(v.metricDefinitionVersionId)
      || row.value_numeric === null || Number(row.value_numeric) !== v.value
      || row.unit_at_capture !== v.unit || row.aggregation_role !== v.aggregationRole || row.coverage !== v.coverage) return null;
  }
  const currentIds = new Set(currentValues.map((r) => String(r.metric_definition_id)));
  return { addedMetricKeys: newValues.filter((v) => !currentIds.has(String(v.metricDefinitionId))).map((v) => v.metricKey).sort() };
}

// The new occasion supersedes the current one and becomes the identity's
// current occasion (same statement order the correction path always used).
async function supersede(client, { common, currentOccasionId, identityId }) {
  const occasionId = await insertOccasionWithValues(client, { ...common, supersedesOccasionId: currentOccasionId });
  await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id = $1 where id = $2 and superseded_by_occasion_id is null`, [occasionId, currentOccasionId]);
  await client.query(`update training_load.metric_source_identities set current_occasion_id = $1 where id = $2`, [occasionId, identityId]);
  return occasionId;
}

async function importResult(client, { result, identity, participantId, segmentId, sourceReportedAt, definitions, batch, performedByUserId }) {
  const values = result.values.map((v) => ({ ...v, ...definitions.byKey.get(v.metricKey), ...roleForLevel(result.level) }));
  const contentHash = importedOccasionContentHash({ level: result.level, drillIndex: result.drillIndex, values });

  const common = { participantId, segmentId, identityId: identity.id, contentHash, sourceReportedAt, batch, performedByUserId, values };
  if (!identity.current_occasion_id) {
    const occasionId = await insertOccasionWithValues(client, common);
    await client.query(`update training_load.metric_source_identities set current_occasion_id = $1 where id = $2`, [occasionId, identity.id]);
    return { outcome: "created", occasionId };
  }

  const current = (await client.query(
    `select id, event_participant_id, segment_id, entry_method, content_hash, source_reported_at from training_load.metric_measurement_occasions where id = $1`,
    [identity.current_occasion_id],
  )).rows[0];
  if (String(current.event_participant_id) !== String(participantId) || String(current.segment_id ?? "") !== String(segmentId ?? "")) {
    throw new GpexeImportError("identity_target_changed", `${result.externalId} was imported for a different participant/segment.`);
  }
  if (current.content_hash === contentHash) return { outcome: "unchanged", occasionId: current.id };

  const currentValues = (await client.query(
    `select metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage
     from training_load.metric_values where occasion_id = $1`,
    [current.id],
  )).rows;
  const currentMetricIds = new Set(currentValues.map((r) => String(r.metric_definition_id)));
  const sameMetricSet = currentMetricIds.size === values.length && values.every((v) => currentMetricIds.has(String(v.metricDefinitionId)));
  const reported = new Date(sourceReportedAt).getTime();
  const currentReported = current.source_reported_at ? new Date(current.source_reported_at).getTime() : null;
  const supplement = isPureSupplement(currentValues, values);

  let conflictStatus = null;
  if (current.entry_method === "manual") conflictStatus = "stale_resend_ignored";
  // Only an imported current occasion may be supplemented; a manual one was
  // handled above and must never be replaced by an import.
  else if (supplement && current.entry_method === "api_import" && currentReported !== null && reported >= currentReported) {
    const occasionId = await supersede(client, { common, currentOccasionId: current.id, identityId: identity.id });
    return { outcome: "supplemented", occasionId, addedMetricKeys: supplement.addedMetricKeys };
  } else if (!sameMetricSet || currentReported === null || reported === currentReported) conflictStatus = "needs_review";
  else if (reported < currentReported) conflictStatus = "stale_resend_ignored";

  if (conflictStatus) {
    const alreadyFlagged = await client.query(
      `select id from training_load.metric_measurement_occasions where source_identity_id = $1 and content_hash = $2 and import_conflict_status = $3`,
      [identity.id, contentHash, conflictStatus],
    );
    if (alreadyFlagged.rowCount) return { outcome: `${conflictStatus}_already_recorded`, occasionId: alreadyFlagged.rows[0].id };
    const occasionId = await insertOccasionWithValues(client, { ...common, conflictStatus });
    return { outcome: conflictStatus, occasionId };
  }

  const occasionId = await supersede(client, { common, currentOccasionId: current.id, identityId: identity.id });
  return { outcome: "corrected", occasionId };
}

// ctx = { ownerTeamId, performedByUserId, athleteIdByGpexeId: Map|object, batchFilename }
// Test hooks: onLocked(client) runs right after the import lock is held;
// onResultImported(result) runs after each result is written, still inside
// the transaction.
export async function importGpexePlan(client, plan, ctx, { onLocked, onResultImported } = {}) {
  const athleteIdByGpexeId = ctx.athleteIdByGpexeId instanceof Map ? ctx.athleteIdByGpexeId : new Map(Object.entries(ctx.athleteIdByGpexeId || {}));
  const unmapped = plan.participants.map((p) => p.gpexeAthleteId).filter((id) => !athleteIdByGpexeId.has(id));
  if (unmapped.length) throw new GpexeImportError("athlete_not_mapped", `GPEXE athlete(s) ${unmapped.join(", ")} have no OptiMove athlete mapping.`);
  if (!ctx.ownerTeamId || !ctx.performedByUserId) throw new GpexeImportError("context_missing", "ownerTeamId and performedByUserId are required.");

  await client.query("begin");
  try {
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, ${IMPORT_LOCK_SEED}))`, [`gpexe-import-team:${ctx.ownerTeamId}`]);
    if (onLocked) await onLocked(client);

    await assertAthletesInTeam(client, ctx.ownerTeamId, plan.participants.map((p) => athleteIdByGpexeId.get(p.gpexeAthleteId)));
    const connection = await ensureSourceConnection(client, { sourceSystem: plan.sourceSystem, ownerTeamId: ctx.ownerTeamId });
    // Always both levels, so a later session with drills can reuse the
    // definitions a session without drills created.
    const scopeLevels = ["session", "component"];
    const definitions = await ensureMetricDefinitions(client, { metrics: plan.metrics, ownerTeamId: ctx.ownerTeamId, performedByUserId: ctx.performedByUserId, scopeLevels });
    // The session itself is reserved as an identity too: its row is what two
    // concurrent first imports collide on inside the database, independently
    // of the advisory lock. It never receives an occasion.
    const externalIds = [plan.event.sourceExternalId, ...plan.participants.flatMap((p) => p.results.map((r) => r.externalId))];
    const identities = await lockPlanIdentities(client, { connectionId: connection.id, externalIds });
    const event = await ensureEvent(client, { plan, connectionId: connection.id, ownerTeamId: ctx.ownerTeamId, performedByUserId: ctx.performedByUserId });
    const binding = await ensureSourceBinding(client, { eventId: event.id, eventCreated: event.created, connectionId: connection.id, plan, performedByUserId: ctx.performedByUserId });
    if (!event.created) await assertNoIdentitiesMissingFromSource(client, { connectionId: connection.id, eventId: event.id, externalIds });
    const segmentsByDrillIndex = await ensureSegments(client, { eventId: event.id, segments: plan.segments });
    const participantIds = await ensureParticipants(client, { eventId: event.id, participants: plan.participants, athleteIdByGpexeId });

    // Existing sanctioned SQL path: creates/reuses the activity, its
    // participants and the confirmed event/participant links, under its own
    // per-event advisory lock.
    const activity = await client.query(`select training.materialize_activity_group_from_metric_event($1, $2, $3, $4) as id`, [event.id, plan.event.activityTypeKey, plan.event.name, ctx.performedByUserId]);
    const activityId = (await client.query(`select training.resolve_canonical_activity_id($1) as id`, [activity.rows[0].id])).rows[0].id;
    await ensureDrillComponents(client, { activityId, segmentsByDrillIndex, performedByUserId: ctx.performedByUserId });

    let batchId = null;
    let rowNumber = 0;
    const batch = {
      id: async () => {
        if (!batchId) {
          batchId = (await client.query(
            `insert into training_load.metric_import_batches (uploaded_by_user_id, owner_scope, owner_team_id, filename) values ($1,'team',$2,$3) returning id`,
            [ctx.performedByUserId, ctx.ownerTeamId, ctx.batchFilename ?? null],
          )).rows[0].id;
        }
        return batchId;
      },
      nextRow: () => {
        rowNumber += 1;
        return rowNumber;
      },
    };

    const results = [];
    for (const participant of plan.participants) {
      for (const result of participant.results) {
        const segmentId = result.level === "drill" ? segmentsByDrillIndex.get(result.drillIndex)?.segmentId : null;
        if (result.level === "drill" && !segmentId) throw new GpexeImportError("segment_missing", `no segment for drill ${result.drillIndex}.`);
        const outcome = await importResult(client, {
          result, identity: identities.get(result.externalId), participantId: participantIds.get(participant.gpexeAthleteId), segmentId,
          sourceReportedAt: plan.event.sourceReportedAt, definitions, batch, performedByUserId: ctx.performedByUserId,
        });
        results.push({ externalId: result.externalId, gpexeAthleteId: participant.gpexeAthleteId, ...outcome });
        if (onResultImported) await onResultImported(results[results.length - 1]);
      }
    }
    await client.query("commit");

    const counts = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    return {
      connectionId: connection.id, connectionCreated: connection.created,
      definitionsCreated: definitions.created, thresholdsUsed: plan.thresholdsUsed,
      eventId: event.id, eventCreated: event.created, activityId,
      bindingCreated: binding.created, referenceSetHash: binding.hash, referenceSetWindowChanged: binding.windowChanged ?? false,
      boundReferenceSet: binding.storedReferenceSet,
      importBatchId: batchId, counts, results,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
