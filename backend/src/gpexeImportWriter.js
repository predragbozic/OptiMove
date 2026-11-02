// GPEXE import plan -> Training Load. Writes one plan from
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
//   ACTIVE gpexe connection per team (since 9-B the importer only uses it:
//   gpexeImportMapping.js locks it and writes its source-instance keys, T7).
//   v12's generic contract is unchanged:
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
// - Since phase 9 (9-B, contract J17) every value comes from an open mapping
//   activation of the team's binding (C55): the canonical definition and
//   version the mapping version pins, never one this writer creates (C46 -
//   it creates no definition, version or scope capability); the value is the
//   exact decimal text of the version's conversion at the storage scale, and
//   every value has its provenance row (T6) in the same function, naming the
//   activation, mapping version, binding, revision, source instance, source
//   unit and source value. The T6 trigger is the backstop of every one of
//   those facts.
// - The occasion content hash covers level, drill index, and per value the
//   canonical definition and version, the mapping version, value, unit, the
//   source value and unit, aggregation_role and coverage, so a value under a
//   new mapping version is never "unchanged" (needs_review, J17 step 11).
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
import { buildGpexeImportPlan, classifyMappedPlan, mappedMetricSpecs } from "./gpexeImportMapper.js";
import { prepareImportMapping } from "./gpexeImportMapping.js";
import { canonicalDecimal } from "./sourceMetricExtractors.js";
import { convertAtStorageScale } from "./sourceMetricPreview.js";

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
  const sorted = [...values].sort((a, b) => (String(a.metricDefinitionId) < String(b.metricDefinitionId) ? -1 : String(a.metricDefinitionId) > String(b.metricDefinitionId) ? 1 : 0));
  const canon = {
    level,
    drillIndex: drillIndex ?? null,
    values: sorted.map((v) => ({
      metricDefinitionId: v.metricDefinitionId,
      metricDefinitionVersionId: v.metricDefinitionVersionId,
      mappingVersionId: v.mappingVersionId,
      value: v.value,
      unit: v.unit,
      sourceValue: v.sourceValue,
      sourceUnit: v.sourceUnit,
      aggregationRole: v.aggregationRole,
      coverage: v.coverage,
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

async function insertOccasionWithValues(client, { participantId, segmentId, identityId, contentHash, sourceReportedAt, batch, performedByUserId, values, provenance, supersedesOccasionId = null, conflictStatus = null }) {
  const batchId = await batch.id();
  const occasion = await client.query(
    `insert into training_load.metric_measurement_occasions
       (event_participant_id, segment_id, entry_method, content_hash, source_identity_id, source_reported_at, import_batch_id, row_number, recorded_by_user_id, supersedes_occasion_id, import_conflict_status)
     values ($1,$2,'api_import',$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [participantId, segmentId, contentHash, identityId, sourceReportedAt, batchId, batch.nextRow(), performedByUserId, supersedesOccasionId, conflictStatus],
  );
  const occasionId = occasion.rows[0].id;
  if (values.length) {
    // The values, then one T6 row per value, in the same function (J17
    // section 3, step 10; C55). A value without its provenance row never
    // stays: a refused T6 row fails the statement and the transaction.
    const { text, params } = metricValuesInsert(occasionId, values);
    const inserted = await client.query(text, params);
    const idByDefinition = new Map(inserted.rows.map((row) => [String(row.metric_definition_id), row.id]));
    const t6 = metricValueProvenanceInsert(values.map((v) => ({ ...v, metricValueId: idByDefinition.get(String(v.metricDefinitionId)) })), provenance);
    const written = await client.query(t6.text, t6.params);
    if (written.rowCount !== values.length) throw new GpexeImportError("provenance_incomplete", "Not every imported value has its provenance row.");
  }
  return occasionId;
}

// Every value of one occasion in ONE statement, one row per value in the
// order of `values` - the rows, columns and parameters the per-value INSERT
// used to send, without one database round trip per value. The BEFORE INSERT
// row triggers of metric_values (validate_metric_value,
// check_metric_value_scope_capability) still fire once per row, in row order,
// and read only other tables (the definition, its version and capabilities,
// the occasion inserted by the statement before this one, its event and
// segment link), never metric_values itself; unique (occasion_id,
// metric_definition_id) is checked at each row as before. A refused row fails
// the whole statement, and with it the transaction, as the refused single
// INSERT did, and leaves no row behind.
// Where one statement differs from one per value - accepted by the owner on
// 2026-10-24 as limitations of this optimization, pinned in
// gpexe-import-values-batch.test.mjs, none of it reachable through this
// writer (its values are finite numbers, a definition and its version come
// from the same row): PostgreSQL converts every parameter before the first
// row runs and checks the foreign keys at the end of the statement, so of two
// refused values in one result the refusal reported can differ; and a
// parameter it cannot read is named in the error's `where` by its position in
// this statement. No code reads `where`, and every caller answers a database
// error with the same internal_error whatever its SQLSTATE (the check, the
// approval and the batch; only 42501 is told apart at approval).
// Parameter layout: $1 the occasion, then six per value - tests that replay
// the old per-value statements rely on it. Since 9-B a value is the exact
// decimal text of the mapping's conversion (never a JavaScript double), and
// the statement returns each row's id with its definition, which matches a
// T6 row to its value (unique (occasion_id, metric_definition_id), v13).
export function metricValuesInsert(occasionId, values) {
  for (const v of values) {
    if (typeof v.value !== "string" || canonicalDecimal(v.value) !== v.value) throw new GpexeImportError("value_not_decimal", "An imported value must be canonical decimal text.");
  }
  const params = [occasionId];
  const rows = values.map((v) => {
    const n = params.length;
    params.push(v.metricDefinitionId, v.metricDefinitionVersionId, v.value, v.unit, v.aggregationRole, v.coverage);
    return `($1,$${n + 1},$${n + 2},$${n + 3},$${n + 4},false,$${n + 5},$${n + 6})`;
  });
  return {
    text: `insert into training_load.metric_values
         (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage)
       values ${rows.join(",")}
     returning id, metric_definition_id`,
    params,
  };
}

// One T6 row per value (v34 metric_value_source_provenance), in one statement.
// provenance = { bindingId, connectionId }: the binding the import reads
// through and the team's Metrics Core source instance.
export function metricValueProvenanceInsert(values, provenance) {
  if (!provenance?.bindingId || !provenance?.connectionId) throw new GpexeImportError("provenance_missing", "An imported value needs its binding and source instance.");
  const params = [provenance.bindingId, provenance.connectionId];
  const rows = values.map((v) => {
    if (!v.metricValueId) throw new GpexeImportError("provenance_incomplete", "Not every imported value has its provenance row.");
    const n = params.length;
    params.push(v.metricValueId, v.activationId, v.mappingVersionId, v.mappingId, v.sourceMetricVersionId, v.sourceUnit, v.sourceValue);
    return `($${n + 1},$${n + 2},$${n + 3},$1,$${n + 4},$${n + 5},$2,$${n + 6},$${n + 7})`;
  });
  return {
    text: `insert into training_load.metric_value_source_provenance
         (metric_value_id, activation_id, mapping_version_id, source_team_binding_id, mapping_id, source_metric_version_id,
          metric_source_connection_id, source_unit, source_value_numeric)
       values ${rows.join(",")}`,
    params,
  };
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

// A supplement only ADDS values to an imported result: every value of the
// current occasion is present in the new result with the same definition,
// definition version, value (compared as exact decimal text, never as a
// double), unit, aggregation_role and coverage, and the same provenance -
// mapping version, source value and source unit (a value from before 9-B has
// no T6 row and is never part of a supplement) - and at least one value is
// new. Any removed or changed value is not a supplement. Returns the added
// values by definition and activation, or null.
function isPureSupplement(currentValues, newValues) {
  if (newValues.length <= currentValues.length) return null;
  const byDefinition = new Map(newValues.map((v) => [String(v.metricDefinitionId), v]));
  for (const row of currentValues) {
    const v = byDefinition.get(String(row.metric_definition_id));
    if (!v
      || String(row.metric_definition_version_id) !== String(v.metricDefinitionVersionId)
      || row.value_numeric === null || canonicalDecimal(row.value_numeric) !== v.value
      || row.unit_at_capture !== v.unit || row.aggregation_role !== v.aggregationRole || row.coverage !== v.coverage
      || row.mapping_version_id === null || String(row.mapping_version_id) !== String(v.mappingVersionId)
      || canonicalDecimal(row.source_value_numeric) !== v.sourceValue || row.source_unit !== v.sourceUnit) return null;
  }
  const currentIds = new Set(currentValues.map((r) => String(r.metric_definition_id)));
  return {
    addedValues: newValues
      .filter((v) => !currentIds.has(String(v.metricDefinitionId)))
      .map((v) => ({ metricDefinitionId: String(v.metricDefinitionId), activationId: String(v.activationId) }))
      .sort((a, b) => (a.metricDefinitionId < b.metricDefinitionId ? -1 : a.metricDefinitionId > b.metricDefinitionId ? 1 : 0)),
  };
}

// The new occasion supersedes the current one and becomes the identity's
// current occasion (same statement order the correction path always used).
async function supersede(client, { common, currentOccasionId, identityId }) {
  const occasionId = await insertOccasionWithValues(client, { ...common, supersedesOccasionId: currentOccasionId });
  await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id = $1 where id = $2 and superseded_by_occasion_id is null`, [occasionId, currentOccasionId]);
  await client.query(`update training_load.metric_source_identities set current_occasion_id = $1 where id = $2`, [occasionId, identityId]);
  return occasionId;
}

async function importResult(client, { result, identity, participantId, segmentId, sourceReportedAt, provenance, batch, performedByUserId }) {
  const values = result.values.map((v) => ({ ...v, ...roleForLevel(result.level) }));
  const contentHash = importedOccasionContentHash({ level: result.level, drillIndex: result.drillIndex, values });

  const common = { participantId, segmentId, identityId: identity.id, contentHash, sourceReportedAt, batch, performedByUserId, values, provenance };
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
    `select v.metric_definition_id, v.metric_definition_version_id, v.value_numeric::text as value_numeric, v.unit_at_capture, v.aggregation_role, v.coverage,
            p.mapping_version_id, p.source_value_numeric::text as source_value_numeric, p.source_unit
       from training_load.metric_values v
       left join training_load.metric_value_source_provenance p on p.metric_value_id = v.id
      where v.occasion_id = $1`,
    [current.id],
  )).rows;
  const currentMetricIds = new Set(currentValues.map((r) => String(r.metric_definition_id)));
  const sameMetricSet = currentMetricIds.size === values.length && values.every((v) => currentMetricIds.has(String(v.metricDefinitionId)));
  // D17: a current value under another mapping version, or with no
  // provenance (imported before 9-B), is never silently corrected: the
  // meaning of the stored fact may differ, so the new one waits for review.
  const sameMappings = currentValues.every((row) => {
    const v = values.find((x) => String(x.metricDefinitionId) === String(row.metric_definition_id));
    return row.mapping_version_id !== null && (!v || String(row.mapping_version_id) === String(v.mappingVersionId));
  });
  const reported = new Date(sourceReportedAt).getTime();
  const currentReported = current.source_reported_at ? new Date(current.source_reported_at).getTime() : null;
  const supplement = isPureSupplement(currentValues, values);

  let conflictStatus = null;
  if (current.entry_method === "manual") conflictStatus = "stale_resend_ignored";
  // Only an imported current occasion may be supplemented; a manual one was
  // handled above and must never be replaced by an import.
  else if (supplement && current.entry_method === "api_import" && currentReported !== null && reported >= currentReported) {
    const occasionId = await supersede(client, { common, currentOccasionId: current.id, identityId: identity.id });
    return { outcome: "supplemented", occasionId, addedValues: supplement.addedValues };
  } else if (!sameMetricSet || !sameMappings || currentReported === null || reported === currentReported) conflictStatus = "needs_review";
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

// The per-team import lock. Every import of a team — and the in-app preview,
// which must read the state it describes under the same lock — takes it
// first, inside its transaction.
// The key is built from the team id exactly as the database prints it
// (lower-case uuid), because v24's own refusal builds the same key from
// `owner_team_id::text`; a caller that passes an upper-case id must not end
// up on a different lock.
export async function lockTeamForImport(client, ownerTeamId) {
  ownerTeamId = String(ownerTeamId).toLowerCase();
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, ${IMPORT_LOCK_SEED}))`, [`gpexe-import-team:${ownerTeamId}`]);
}

function checkImportContext(plan, ctx) {
  const athleteIdByGpexeId = ctx.athleteIdByGpexeId instanceof Map ? ctx.athleteIdByGpexeId : new Map(Object.entries(ctx.athleteIdByGpexeId || {}));
  const unmapped = plan.participants.map((p) => p.gpexeAthleteId).filter((id) => !athleteIdByGpexeId.has(id));
  if (unmapped.length) throw new GpexeImportError("athlete_not_mapped", `GPEXE athlete(s) ${unmapped.join(", ")} have no OptiMove athlete mapping.`);
  if (!ctx.ownerTeamId || !ctx.performedByUserId) throw new GpexeImportError("context_missing", "ownerTeamId and performedByUserId are required.");
  return athleteIdByGpexeId;
}

// C55, before any write: every value comes from one of the locked open
// activations of the binding, at a level it covers, as the canonical version
// its mapping version pins, in the version's target unit, and is the exact
// conversion of its source value. The T6 trigger checks the same facts again
// for every row; this check gives the stable code.
function checkMappedValues(plan, mapping) {
  const byActivation = new Map(mapping.rows.map((row) => [row.activationId, row]));
  let count = 0;
  for (const participant of plan.participants) {
    for (const result of participant.results) {
      for (const v of result.values) {
        const row = byActivation.get(String(v.activationId));
        const covered = row && (result.level === "full" ? row.appliesToSession : row.appliesToDrill);
        if (!row || !covered
          || String(row.mappingVersionId) !== String(v.mappingVersionId)
          || String(row.metricDefinitionId) !== String(v.metricDefinitionId)
          || String(row.metricDefinitionVersionId) !== String(v.metricDefinitionVersionId)
          || row.targetUnit !== v.unit || row.revisionSourceUnit !== v.sourceUnit
          || convertAtStorageScale(v.sourceValue, { scale: row.scale, divisor: row.scaleDivisor, offset: row.offset }) !== v.value) {
          throw new GpexeImportError("mapping_not_usable", "A value does not come from an open activation of the team's binding.");
        }
        count += 1;
      }
    }
  }
  return count;
}

// The writer's own entry (9-B, D28; the pilot CLI, the disposable runs and the
// suites): one bundle, one transaction under the team import lock, through the
// team's mapping activations exactly as the approval writes it (J17 steps
// 3-10, without the approval's own steps). ctx = { ownerTeamId,
// performedByUserId, athleteIdByGpexeId: Map|object, batchFilename,
// bindingId? (default: the team's one active gpexe binding), onlyMapped? }.
// onlyMapped (tests) imports only the participants athleteIdByGpexeId names;
// otherwise every participant must be mapped (athlete_not_mapped).
// Test hooks: onLocked(client) runs right after the import lock is held;
// onResultImported(result) runs after each result is written, still inside
// the transaction.
export async function importGpexeBundle(client, bundle, ctx, hooks = {}) {
  if (!ctx?.ownerTeamId || !ctx?.performedByUserId) throw new GpexeImportError("context_missing", "ownerTeamId and performedByUserId are required.");
  // DB review F2 (9-B): READ COMMITTED for the read / lock / read-again
  // compare of the mapping rows (steps 4-5), pinned, not left to a default.
  await client.query("begin isolation level read committed");
  try {
    await lockTeamForImport(client, ctx.ownerTeamId);
    if (hooks.onLocked) await hooks.onLocked(client);
    const summary = await importGpexeBundleLocked(client, bundle, ctx, hooks);
    await client.query("commit");
    return summary;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export async function importGpexeBundleLocked(client, bundle, ctx, hooks = {}) {
  let bindingId = ctx.bindingId ?? null;
  if (!bindingId) {
    const bindings = (await client.query(
      `select id from training_load.source_team_bindings where team_id = $1 and source_system = 'gpexe' and state = 'active'`,
      [ctx.ownerTeamId],
    )).rows;
    bindingId = bindings.length === 1 ? String(bindings[0].id) : null;
  }
  const gates = buildGpexeImportPlan(bundle, { metricSpecs: [] });
  const mapping = await prepareImportMapping(client, {
    teamId: ctx.ownerTeamId, bindingId, sessionExternalId: gates.event.sourceExternalId, sourceTeamIdOfBundle: gates.gpexeTeamId,
  });
  if (mapping.block) throw new GpexeImportError(mapping.block, "The session cannot be imported through the team's mapping activations.");
  const specs = mappedMetricSpecs(mapping.rows);
  if (specs.block) throw new GpexeImportError(specs.block, "The session cannot be imported through the team's mapping activations.");
  const full = buildGpexeImportPlan(bundle, { metricSpecs: specs.specs });
  const athleteIdByGpexeId = ctx.athleteIdByGpexeId instanceof Map ? ctx.athleteIdByGpexeId : new Map(Object.entries(ctx.athleteIdByGpexeId || {}));
  const plan = ctx.onlyMapped ? { ...full, participants: full.participants.filter((p) => athleteIdByGpexeId.has(p.gpexeAthleteId)) } : full;
  const classified = classifyMappedPlan(plan, { importableIds: plan.participants.map((p) => p.gpexeAthleteId), activationCount: mapping.rows.length });
  if (classified.block) throw new GpexeImportError(classified.block, "The session cannot be imported through the team's mapping activations.");
  return importGpexePlanLocked(client, plan, { ...ctx, mapping }, hooks);
}

// The import itself, for a caller that has already begun the transaction,
// taken lockTeamForImport() and prepared the mapping context
// (gpexeImportMapping.js prepareImportMapping, with no block; ctx.mapping).
// It neither commits nor rolls back: the caller decides (the preview always
// rolls back; the approval commits after its own checks). It creates no
// metric definition (C46): every value names the canonical version its
// mapping version pins.
export async function importGpexePlanLocked(client, plan, ctx, { onResultImported } = {}) {
  const athleteIdByGpexeId = checkImportContext(plan, ctx);
  const mapping = ctx.mapping;
  if (!mapping || mapping.block || !mapping.connection || !mapping.binding) throw new GpexeImportError("mapping_not_usable", "The import has no usable mapping context.");
  if (checkMappedValues(plan, mapping) === 0) throw new GpexeImportError("no_mapped_values", "No value of the session comes from the team's mapping activations.");
  {
    await assertAthletesInTeam(client, ctx.ownerTeamId, plan.participants.map((p) => athleteIdByGpexeId.get(p.gpexeAthleteId)));
    const connection = { id: mapping.connection.id, created: mapping.connection.created === true };
    const provenance = { bindingId: mapping.binding.id, connectionId: mapping.connection.id };
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
          sourceReportedAt: plan.event.sourceReportedAt, provenance, batch, performedByUserId: ctx.performedByUserId,
        });
        results.push({ externalId: result.externalId, gpexeAthleteId: participant.gpexeAthleteId, ...outcome });
        if (onResultImported) await onResultImported(results[results.length - 1]);
      }
    }

    const counts = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    return {
      connectionId: connection.id, connectionCreated: connection.created, instanceKeysSet: mapping.connection.keysSet === true,
      thresholdsUsed: plan.thresholdsUsed,
      eventId: event.id, eventCreated: event.created, activityId,
      bindingCreated: binding.created, referenceSetHash: binding.hash, referenceSetWindowChanged: binding.windowChanged ?? false,
      boundReferenceSet: binding.storedReferenceSet,
      importBatchId: batchId, counts, results,
    };
  }
}
