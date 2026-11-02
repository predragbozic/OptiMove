// Preview of one GPEXE import candidate (in-app import, phase F1; preview
// version 3 since 9-B): what an approved import would write or change, per
// athlete and per value, and why anything is left out. Nothing is written: the importer runs every
// statement of a real import under the team's import lock, and the
// transaction is then rolled back, so the preview is exactly what the
// approval in F2 would do against the same state.
//
// Owner decisions 2026-09-18:
//   * participation and the GPS measurement are shown separately; a missing
//     value is never a zero;
//   * "GPS was not worn / not valid" is only stated when the GPEXE data says
//     so (or, later, a coach enters it) — an athlete of the team with no
//     GPEXE row is "no GPS record, participation unknown", nothing more;
//   * an athlete who needs manual review (e.g. two tracks in one session) or
//     is not linked to an OptiMove athlete is left out with that reason and
//     does not stop the others.
import crypto from "node:crypto";
import { buildGpexeImportPlan, classifyMappedPlan, GpexeMappingError, leftOutReason, mappedMetricSpecs } from "./gpexeImportMapper.js";
import { ImportBindingNotActiveError, prepareImportMapping } from "./gpexeImportMapping.js";
import { importGpexePlanLocked, lockTeamForImport, GpexeImportError } from "./gpexeImportWriter.js";
import { canonicalDecimal, compareDecimal } from "./sourceMetricExtractors.js";

// 2: changesToImported (phase F2). 3: values through mapping activations (9-B,
// J17 section 4): each value names its activation, mapping version, canonical
// variable, source field and source value; values left out are listed with
// their reason (C110); the preview hash binds the activation set.
export const PREVIEW_VERSION = 3;

// Switch condition 2 (J17 section 9): the server-side bounds of every
// transaction that takes the team import lock to run the importer - the
// approval (gpexeImportService.approveCandidate) and the check-time preview
// (buildCandidatePreview). Set as SET LOCAL right after BEGIN, before the
// first lock, so they end with the transaction and never stay on a pooled
// connection:
//   * lock_timeout bounds every lock wait (the approver's role and grant rows,
//     the candidate row, the team's advisory import lock, the importer's own
//     rows): 55P03;
//   * statement_timeout bounds every statement: 57014. PostgreSQL does not
//     apply it to the deferred trigger and constraint work a COMMIT runs, so
//     the approval fires that work first with SET CONSTRAINTS ALL IMMEDIATE
//     (a bounded statement before the COMMIT); the COMMIT itself keeps the
//     approval's 15 s client bound on its answer;
//   * idle_in_transaction_session_timeout ends a session whose transaction
//     waits on the client (FATAL 25P03; the connection is closed).
// Every server-side wait is then bounded; the approval and the check map
// 55P03 / 57014 / 40P01 before a COMMIT to their own stable codes, nothing
// written. These are server bounds only: a statement whose answer is lost on
// the network is bounded by TCP and the deployed request timeout, not here
// (only the approval's COMMIT has a client-side bound). The statement bound is far above the measured cost
// (backend/tests/gpexe-import-bounds-9-0.test.mjs, "Arm A1 commits under the
// production bounds"), and the lock bound is longer than a normal check-time
// preview holds the team lock.
export const IMPORT_LOCK_TIMEOUT_MS = 5_000;
export const IMPORT_STATEMENT_TIMEOUT_MS = 10_000;
export const IMPORT_IDLE_IN_TRANSACTION_MS = 10_000;
const DEFAULT_IMPORT_BOUNDS = Object.freeze({
  lockTimeoutMs: IMPORT_LOCK_TIMEOUT_MS,
  statementTimeoutMs: IMPORT_STATEMENT_TIMEOUT_MS,
  idleInTransactionMs: IMPORT_IDLE_IN_TRANSACTION_MS,
});
let importBounds = DEFAULT_IMPORT_BOUNDS;
// Tests shorten the bounds (whole milliseconds, 1 to 600000); null restores them.
export function setImportTransactionBoundsForTests(bounds) {
  if (!bounds) {
    importBounds = DEFAULT_IMPORT_BOUNDS;
    return;
  }
  const next = { ...DEFAULT_IMPORT_BOUNDS, ...bounds };
  for (const value of Object.values(next)) {
    if (!Number.isInteger(value) || value < 1 || value > 600_000) throw new Error("import transaction bounds must be whole milliseconds, 1 to 600000");
  }
  importBounds = Object.freeze(next);
}
export function importTransactionBounds() {
  return importBounds;
}
// One round trip; set_config(..., true) is SET LOCAL.
export async function setImportTransactionBounds(client) {
  const b = importBounds;
  await client.query(
    `select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true),
            set_config('idle_in_transaction_session_timeout', $3, true)`,
    [`${b.lockTimeoutMs}ms`, `${b.statementTimeoutMs}ms`, `${b.idleInTransactionMs}ms`],
  );
}
// A bounded wait before a COMMIT: a lock not granted in time, a statement
// ended by its bound, or a deadlock the server broke.
const IMPORT_WAIT_CODES = new Set(["55P03", "57014", "40P01"]);
export function isImportWaitError(error) {
  return IMPORT_WAIT_CODES.has(error?.code);
}
// The server ended the session (the idle-in-transaction bound, an
// administrator's kill, a shutdown), or the connection is gone: the open
// transaction ended with it, nothing of it committed.
const SESSION_ENDED_CODES = new Set(["25P03", "57P01", "57P02", "57P03"]);
export function isSessionEndedError(error) {
  return SESSION_ENDED_CODES.has(error?.code)
    || /Connection terminated|not queryable|Client was closed/i.test(String(error?.message ?? ""));
}

// What an approved import does to a result that was ALREADY imported, per
// importer outcome. Every one of these has to be accepted explicitly
// (acceptChanges) before the approval writes anything (owner, 2026-09-18).
// "unchanged" and "*_already_recorded" write nothing and are not listed.
export const CHANGE_TO_IMPORTED = {
  corrected: { effect: "replaces_current_values", newVersionBecomesCurrent: true, message: "GPEXE reports newer values; the imported values are replaced (the old ones stay in the history)." },
  supplemented: { effect: "adds_values_to_imported_result", newVersionBecomesCurrent: true, message: "GPEXE now has more values for this result; they are added, the existing values stay the same." },
  needs_review: { effect: "conflicting_version_flagged", newVersionBecomesCurrent: false, message: "GPEXE reports different values without a newer report time; they are stored as a conflicting version for review, the current values stay." },
  stale_resend_ignored: { effect: "older_or_manual_version_flagged", newVersionBecomesCurrent: false, message: "The current values are older-dated GPEXE data or a manual correction; the GPEXE version is stored flagged, the current values stay." },
};

// The acceptance rule for what the importer did to a result that was
// already imported: null when it wrote nothing, the rule otherwise. An
// outcome with no rule stops the preview instead of going unlisted.
export function changeToImportedRule(outcome) {
  if (outcome === "unchanged" || outcome.endsWith("_already_recorded")) return null;
  const rule = CHANGE_TO_IMPORTED[outcome];
  if (!rule) throw new Error(`gpexe preview: outcome ${outcome} on an imported result has no acceptance rule`);
  return rule;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// The athlete-level reason a GPEXE athlete is not measured/imported, from the
// mapper's anomalies. Only what the data itself shows.
const ATHLETE_ANOMALY = {
  multiple_tracks: { gps: "needs_manual_review", review: true, message: "Recorded on more than one track in this session; needs manual review." },
  stats_invalid: { gps: "not_valid", review: false, message: "GPEXE marks this athlete's statistics as not valid." },
  whole_session_row_count: { gps: "needs_manual_review", review: true, message: "GPEXE has more than one whole-session row for this athlete; needs manual review." },
};

// The whole-candidate blocks of a mapped import (J17 sections 3 and 6), each
// with one fixed sentence for the two administrators. A coach reads the
// stable sentence instead (gpexeImportAudience.js).
export const BLOCK_MESSAGES = Object.freeze({
  mapping_not_usable: "This session can't be imported through the team's mappings and GPEXE binding as they stand.",
  source_threshold_contract_mismatch: "GPEXE's team thresholds or zones for this session are not the ones a mapping is defined for.",
  source_unit_mismatch: "A mapping's source unit is not the proven unit of its GPEXE field.",
  source_shape_mismatch: "GPEXE sent a mapped value in another shape than its field has.",
  no_mapped_values: "No value of this session can be imported: either no mapping switched on for this team gives a value for this session, or every mapped value was left out (see Left out under each athlete).",
  source_instance_held: "Another team's GPEXE source instance holds this GPEXE team.",
  source_instance_changed: "This team's GPEXE source instance names another GPEXE team.",
  session_imported_under_another_instance: "This session was imported earlier under another GPEXE source instance.",
});

// The plain words of a value left out (C110, form B): the same for every
// viewer; the code itself is for the two administrators only.
const LEFT_OUT_MESSAGES = Object.freeze({
  required_value_missing: "Required value missing.",
  canonical_value_out_of_range: "Outside the variable's limits.",
  missing: "GPEXE has no value for this.",
  threshold_contract: "GPEXE's thresholds do not match this mapping.",
  shape: "GPEXE sent this value in another shape.",
});

async function activeLinks(client, ownerTeamId) {
  const rows = (await client.query(
    `select gpexe_athlete_id, athlete_id from training_load.gpexe_athlete_links
     where owner_team_id = $1 and unlinked_at is null`,
    [ownerTeamId],
  )).rows;
  return new Map(rows.map((r) => [String(r.gpexe_athlete_id), String(r.athlete_id)]));
}

async function activeTeamAthleteIds(client, ownerTeamId) {
  return (await client.query(
    `select distinct m.athlete_id from public.athlete_memberships m
     where m.team_id = $1 and m.membership_type = 'team' and m.status = 'active'`,
    [ownerTeamId],
  )).rows.map((r) => String(r.athlete_id));
}

// Current imported values of the identities this plan would touch: what
// "old" means in the preview, and the state the preview hash is bound to.
// Keyed by canonical definition (9-B): a value is exact decimal text.
async function currentState(client, ownerTeamId, externalIds) {
  const rows = (await client.query(
    `select si.source_external_id, si.current_occasion_id, o.content_hash, o.entry_method,
            v.metric_definition_id, d.key as definition_key, d.label as definition_label, d.owner_scope as definition_owner_scope,
            v.value_numeric::text as value_numeric, v.unit_at_capture, p.mapping_version_id
     from training_load.metric_source_connections c
     join training_load.metric_source_identities si on si.source_connection_id = c.id
     left join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
     left join training_load.metric_values v on v.occasion_id = o.id
     left join training_load.metric_definitions d on d.id = v.metric_definition_id
     left join training_load.metric_value_source_provenance p on p.metric_value_id = v.id
     where c.source_system = 'gpexe' and c.owner_scope = 'team' and c.owner_team_id = $1 and c.state = 'active'
       and si.source_external_id = any($2::text[])`,
    [ownerTeamId, externalIds],
  )).rows;
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.source_external_id)) {
      byId.set(r.source_external_id, {
        currentOccasionId: r.current_occasion_id ? String(r.current_occasion_id) : null,
        contentHash: r.content_hash ?? null,
        entryMethod: r.entry_method ?? null,
        values: new Map(),
      });
    }
    if (r.metric_definition_id) {
      byId.get(r.source_external_id).values.set(String(r.metric_definition_id), {
        value: r.value_numeric === null ? null : canonicalDecimal(r.value_numeric),
        variableKey: r.definition_key,
        label: r.definition_label,
        variableScope: r.definition_owner_scope,
        unit: r.unit_at_capture,
        mappingVersionId: r.mapping_version_id === null ? null : String(r.mapping_version_id),
      });
    }
  }
  return byId;
}

function sessionSummary(bundle, plan) {
  const s = bundle?.teamSession ?? {};
  return {
    gpexeTeamSessionId: s.id !== undefined ? String(s.id) : null,
    categoryName: s.category_name ?? null,
    startTimestamp: s.start_timestamp ?? null,
    drillsCount: Number(s.drills_count ?? 0),
    name: plan?.event?.name ?? null,
    occurredLocalDate: plan?.event?.occurredLocalDate ?? null,
  };
}

// The value entries of one result (J17 section 4; decision D13 of 9-B): every
// value the import writes, and every value the result had before, compared
// as exact decimal text. A value the result had that the import does not
// write is left_out (its activation left it out), not_mapped (no activation
// covers its variable at this level any more) or missing_in_gpexe.
function valueEntry(v) {
  return {
    activationId: v.activationId,
    mappingVersionId: v.mappingVersionId,
    metricDefinitionId: String(v.metricDefinitionId),
    variableKey: v.variableKey,
    variableScope: v.variableScope,
    label: v.label,
    unit: v.unit,
    value: v.value,
    sourceMetricKey: v.sourceMetricKey,
    sourceParameterFingerprint: v.sourceParameterFingerprint,
    sourceValue: v.sourceValue,
    sourceUnit: v.sourceUnit,
  };
}
function valueDiff(result, outcome, previous, { specsByDefinitionAtLevel, leftOutDefinitions }) {
  const next = new Map(result.values.map((v) => [String(v.metricDefinitionId), v]));
  const definitions = new Set([...next.keys(), ...(previous ? previous.values.keys() : [])]);
  const entries = [];
  for (const definitionId of definitions) {
    const v = next.get(definitionId) ?? null;
    const prev = previous?.values.get(definitionId) ?? null;
    const prevValue = prev?.value ?? null;
    let change;
    if (outcome === "created") change = "new";
    else if (prevValue === null && v) change = "added";
    else if (prevValue !== null && !v) {
      change = leftOutDefinitions.has(definitionId) ? "left_out" : specsByDefinitionAtLevel.has(definitionId) ? "missing_in_gpexe" : "not_mapped";
    } else if (prevValue !== null && v && compareDecimal(prevValue, v.value) !== 0) change = "changed";
    else change = "same";
    const base = v ? valueEntry(v) : {
      activationId: null, mappingVersionId: prev?.mappingVersionId ?? null, metricDefinitionId: definitionId,
      variableKey: prev?.variableKey ?? null, variableScope: prev?.variableScope ?? null, label: prev?.label ?? null, unit: prev?.unit ?? null,
      value: null, sourceMetricKey: null, sourceParameterFingerprint: null, sourceValue: null, sourceUnit: null,
    };
    entries.push({ ...base, previous: prevValue, change });
  }
  return entries.sort((a, b) => (a.metricDefinitionId < b.metricDefinitionId ? -1 : a.metricDefinitionId > b.metricDefinitionId ? 1 : 0));
}

function hashOf(preview, state, activationSet) {
  return sha256Hex(canonicalJson({ preview, state, activations: activationSet ?? [] }));
}

// A session the import's own gates refuse (the mapper's GpexeMappingError):
// nothing about its athletes can be said.
export function blockedByMapping(bundle, error, { activationSet = [], unactivated = [] } = {}) {
  const preview = {
    version: PREVIEW_VERSION, status: "blocked", blocked: { code: error.code, message: error.message },
    session: sessionSummary(bundle, null), counts: {}, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [],
    unmappedSourceFields: 0, unactivatedSourceMetrics: [...unactivated], unactivatedSourceMetricCount: unactivated.length,
  };
  return { preview, previewHash: hashOf(preview, [], activationSet), summary: null };
}

// Tests hold the check-time preview right after it took the team lock (to
// let a bound end it).
let checkPreviewHold = null;
export function setCheckPreviewHoldForTests(fn) {
  checkPreviewHold = fn ?? null;
}

// Returns { preview, previewHash }. `client` must not be inside a
// transaction: this opens one, takes the team's import lock, reads and locks
// the team's mapping context (J17 steps 3-6), reads everything the preview
// depends on, runs the import, and always rolls back - so the "before" values
// and the outcomes come from one locked snapshot (R10). importPath is the
// check's source identity (sourceImportCredentialResolver.importSourceIdentity):
// a legacy_env check has no binding, so its candidates are mapping_not_usable
// (C2); a binding found ended under the lock throws
// ImportBindingNotActiveError, and a mapping that changed under the locks
// ImportMappingChangedError - the caller fails the check, nothing staged.
export async function buildCandidatePreview(client, { bundle, ownerTeamId, performedByUserId, importPath = null }) {
  let gates;
  try {
    gates = buildGpexeImportPlan(bundle, { metricSpecs: [] });
  } catch (error) {
    if (!(error instanceof GpexeMappingError)) throw error;
    return blockedByMapping(bundle, error);
  }
  // DB review F2 (9-B): READ COMMITTED for the read / lock / read-again
  // compare of the mapping rows (steps 4-5), pinned, not left to a default.
  await client.query("begin isolation level read committed");
  try {
    // Switch condition 2: bounded before the team lock (see above).
    await setImportTransactionBounds(client);
    await lockTeamForImport(client, ownerTeamId);
    if (checkPreviewHold) await checkPreviewHold(client);
    const bindingId = importPath?.path === "source_connection" ? importPath.bindingId : null;
    const mapping = await prepareImportMapping(client, {
      teamId: ownerTeamId, bindingId, sessionExternalId: gates.event.sourceExternalId, sourceTeamIdOfBundle: gates.gpexeTeamId,
    });
    if (bindingId && mapping.blockReason === "binding_not_active") throw new ImportBindingNotActiveError();
    const { preview, previewHash } = await previewLocked(client, { bundle, mapping, ownerTeamId, performedByUserId });
    return { preview, previewHash };
  } finally {
    await client.query("rollback").catch(() => {});
  }
}

// The preview for a caller that has begun a transaction, taken
// lockTeamForImport() and prepared the mapping context (prepareImportMapping,
// J17 steps 3-6). It runs the import inside that transaction (in a savepoint)
// and leaves the transaction open: the check-time preview rolls back; the
// approval compares previewHash with the approved one and commits only if
// they are equal. `summary` is the importer's own result (null when nothing
// was run). The plan is built only now, after the locks (J17 step 7).
export async function previewLocked(client, { bundle, mapping, ownerTeamId, performedByUserId }) {
  const activationSet = mapping?.activationSet ?? [];
  const unactivated = mapping?.unactivated ?? [];
  let gates;
  try {
    gates = buildGpexeImportPlan(bundle, { metricSpecs: [] });
  } catch (error) {
    if (!(error instanceof GpexeMappingError)) throw error;
    return blockedByMapping(bundle, error, { activationSet, unactivated });
  }
  let plan = gates;
  let blocked = null;
  let specs = [];
  const block = (code) => ({ code, message: BLOCK_MESSAGES[code] ?? BLOCK_MESSAGES.mapping_not_usable });
  if (!mapping || mapping.block) {
    blocked = block(mapping?.block ?? "mapping_not_usable");
  } else {
    const built = mappedMetricSpecs(mapping.rows);
    if (built.block) blocked = block(built.block);
    else {
      specs = built.specs;
      try {
        plan = buildGpexeImportPlan(bundle, { metricSpecs: specs });
      } catch (error) {
        if (!(error instanceof GpexeMappingError)) throw error;
        return blockedByMapping(bundle, error, { activationSet, unactivated });
      }
    }
  }

  const links = await activeLinks(client, ownerTeamId);
  const teamAthletes = await activeTeamAthleteIds(client, ownerTeamId);
  const sessionId = String(bundle.teamSession.id);
  const gpexeRowsByAthlete = new Map();
  for (const row of bundle.athleteSessions || []) {
    if (String(row.teamsession) !== sessionId) continue;
    const id = String(row.athlete);
    if (!gpexeRowsByAthlete.has(id)) gpexeRowsByAthlete.set(id, []);
    gpexeRowsByAthlete.get(id).push(row);
  }

  const importable = plan.participants.filter((p) => links.has(p.gpexeAthleteId) && teamAthletes.includes(links.get(p.gpexeAthleteId)));
  const externalIds = plan.participants.flatMap((p) => p.results.map((r) => r.externalId));
  const before = await currentState(client, ownerTeamId, externalIds);

  if (!blocked) {
    const classified = classifyMappedPlan(plan, { importableIds: importable.map((p) => p.gpexeAthleteId), activationCount: mapping.rows.length });
    if (classified.block) blocked = block(classified.block);
  }

  let outcomes = new Map();
  let summary = null;
  if (!blocked && importable.length) {
    // A savepoint, so an import refused by an SQL error (e.g. a concurrent
    // connection conflict) leaves the caller's transaction usable and the
    // caller's own reads/commit decision well defined.
    await client.query("savepoint gpexe_preview_import");
    try {
      summary = await importGpexePlanLocked(
        client,
        { ...plan, participants: importable },
        {
          ownerTeamId, performedByUserId, mapping,
          athleteIdByGpexeId: new Map(importable.map((p) => [p.gpexeAthleteId, links.get(p.gpexeAthleteId)])),
          batchFilename: `gpexe import team_session:${sessionId}`,
        },
      );
      outcomes = new Map(summary.results.map((r) => [r.externalId, r]));
    } catch (error) {
      await client.query("rollback to savepoint gpexe_preview_import");
      if (!(error instanceof GpexeImportError)) throw error;
      blocked = { code: error.code, message: error.code in BLOCK_MESSAGES ? BLOCK_MESSAGES[error.code] : error.message };
      // Results imported earlier that this import would leave behind (the
      // athlete is now unlinked, out of the team, or needs manual review):
      // the session waits, and the athletes causing it are named.
      if (error.missingExternalIds) {
        const athleteByRow = new Map((bundle.athleteSessions || []).map((r) => [String(r.id), String(r.athlete)]));
        blocked.gpexeAthleteIds = [...new Set(error.missingExternalIds.map((id) => athleteByRow.get(String(id).split(":")[1])).filter(Boolean))].sort();
        blocked.unknownExternalIds = error.missingExternalIds.filter((id) => !athleteByRow.has(String(id).split(":")[1]));
        // Which OptiMove athlete those earlier results belong to: what the
        // resolution step has to name.
        const owners = (await client.query(
          `select si.source_external_id, p.athlete_id
             from training_load.metric_source_connections c
             join training_load.metric_source_identities si on si.source_connection_id = c.id
             join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
             join training_load.metric_event_participants p on p.id = o.event_participant_id
            where c.source_system = 'gpexe' and c.owner_scope = 'team' and c.owner_team_id = $1 and c.state = 'active'
              and si.source_external_id = any($2::text[])`,
          [ownerTeamId, error.missingExternalIds],
        )).rows;
        blocked.previousAthleteByGpexeId = {};
        for (const row of owners) {
          const gpexeId = athleteByRow.get(String(row.source_external_id).split(":")[1]);
          if (gpexeId) blocked.previousAthleteByGpexeId[gpexeId] = String(row.athlete_id);
        }
      }
      summary = null;
    }
  }

  const anomaliesByAthlete = new Map();
  for (const a of plan.anomalies) {
    if (!a.gpexeAthleteId) continue;
    if (!anomaliesByAthlete.has(a.gpexeAthleteId)) anomaliesByAthlete.set(a.gpexeAthleteId, []);
    anomaliesByAthlete.get(a.gpexeAthleteId).push(a);
  }
  const participantById = new Map(plan.participants.map((p) => [p.gpexeAthleteId, p]));
  const specByActivation = new Map(specs.map((spec) => [spec.activationId, spec]));
  const counts = { created: 0, unchanged: 0, supplemented: 0, corrected: 0, needs_review: 0, stale_resend_ignored: 0, already_recorded: 0, skippedValues: 0, athletesNotImported: 0, athletesManualReview: 0, changesToImported: 0 };
  const changesToImported = [];

  const athletes = [];
  for (const gpexeAthleteId of [...gpexeRowsByAthlete.keys()].sort((a, b) => Number(a) - Number(b))) {
    const athleteId = links.get(gpexeAthleteId) ?? null;
    const participant = participantById.get(gpexeAthleteId) ?? null;
    const anomaly = (anomaliesByAthlete.get(gpexeAthleteId) || []).map((a) => ({ kind: a.kind, ...(ATHLETE_ANOMALY[a.kind] || {}), detail: a.detail }));
    const blocking = anomaly.find((a) => a.gps);
    const entry = {
      gpexeAthleteId,
      athleteId,
      // GPEXE has a row for this athlete in this session.
      participation: { status: "recorded_by_gpexe" },
      gps: blocking
        ? { status: blocking.gps, reason: { code: blocking.kind, message: blocking.message, source: "gpexe_data" } }
        : { status: "measured", reason: null },
      notImported: null,
      blocksSession: Boolean(blocked?.gpexeAthleteIds?.includes(gpexeAthleteId)),
      results: [],
      skippedValues: [],
      notes: anomaly.filter((a) => !a.gps).map((a) => ({ code: a.kind, detail: a.detail })),
    };
    if (blocking?.review) counts.athletesManualReview += 1;
    if (blocking) entry.notImported = { code: blocking.kind, message: blocking.message };
    else if (!athleteId) entry.notImported = { code: "athlete_not_linked", message: "This GPEXE athlete is not linked to an OptiMove athlete of the team." };
    else if (!teamAthletes.includes(athleteId)) entry.notImported = { code: "athlete_not_in_team", message: "The linked OptiMove athlete is no longer an active member of the team." };
    else if (blocked) entry.notImported = { code: "session_blocked", message: "The whole session is blocked; see the reason above." };
    if (entry.notImported) counts.athletesNotImported += 1;

    if (participant) {
      for (const result of participant.results) {
        const outcome = entry.notImported ? null : (outcomes.get(result.externalId)?.outcome ?? null);
        const previous = before.get(result.externalId) ?? null;
        if (outcome) {
          const bucket = outcome.endsWith("_already_recorded") ? "already_recorded" : outcome;
          counts[bucket] = (counts[bucket] || 0) + 1;
        }
        const atLevel = specs.filter((spec) => spec.levels[result.level]);
        const leftOutHere = plan.leftOut.filter((r) => r.gpexeAthleteId === gpexeAthleteId && r.athleteSessionId === result.athleteSessionId && r.level === result.level);
        const values = valueDiff(result, outcome, previous, {
          specsByDefinitionAtLevel: new Set(atLevel.map((spec) => String(spec.metricDefinitionId))),
          leftOutDefinitions: new Set(leftOutHere.map((r) => specByActivation.get(r.activationId)).filter(Boolean).map((spec) => String(spec.metricDefinitionId))),
        });
        entry.results.push({
          externalId: result.externalId,
          level: result.level,
          drillIndex: result.drillIndex,
          outcome: outcome ?? "not_imported",
          ...(previous?.entryMethod === "manual" ? { manualCorrectionKept: true } : {}),
          values,
        });
        // A result imported before that this import would write to: listed
        // on its own, with the values that differ, for acceptChanges.
        const change = outcome && previous?.currentOccasionId ? changeToImportedRule(outcome) : null;
        if (change) {
          changesToImported.push({
            gpexeAthleteId, athleteId, externalId: result.externalId, level: result.level, drillIndex: result.drillIndex,
            outcome, ...change,
            ...(previous.entryMethod === "manual" ? { manualCorrectionKept: true } : {}),
            values: values.filter((v) => v.change !== "same"),
          });
        }
      }
    }
    // The values left out of this athlete (C110 form B, D12): listed for
    // every participant, for information; a Left-out entry never sets
    // notImported and never carries the value.
    for (const record of plan.leftOut.filter((r) => r.gpexeAthleteId === gpexeAthleteId && r.activationId)) {
      const spec = specByActivation.get(record.activationId);
      if (!spec) continue;
      const { reason, sourceReason } = leftOutReason(spec, record);
      counts.skippedValues += 1;
      entry.skippedValues.push({
        level: record.level, drillIndex: record.drillIndex,
        activationId: spec.activationId, mappingVersionId: spec.mappingVersionId, sourceParameterFingerprint: spec.sourceParameterFingerprint,
        variableKey: spec.variableKey, variableScope: spec.variableScope, label: spec.label, unit: spec.unit, sourceMetricKey: spec.sourceMetricKey,
        reason,
        message: LEFT_OUT_MESSAGES[reason] ?? LEFT_OUT_MESSAGES[record.category] ?? LEFT_OUT_MESSAGES.missing,
        sourceReason,
      });
    }
    // D29 (the Rukovodilac's condition, 2026-11-02): an athlete the import keeps
    // whose every mapped value was left out still counts as a participant (the
    // participation is recorded), and is marked so the review never shows that
    // athlete as imported with data - only with the Left-out entries and reasons.
    if (participant && entry.skippedValues.length > 0 && participant.results.every((r) => r.values.length === 0)) entry.allValuesLeftOut = true;
    athletes.push(entry);
  }

  // Athletes of the team with no GPEXE row in this session: nothing is known
  // about their participation, and a missing value is not a zero.
  const linkedWithRows = new Set([...gpexeRowsByAthlete.keys()].map((g) => links.get(g)).filter(Boolean));
  const teamAthletesWithoutGpexeRecord = teamAthletes
    .filter((id) => !linkedWithRows.has(id))
    .sort()
    .map((athleteId) => ({ athleteId, participation: { status: "unknown" }, gps: { status: "no_record", reason: null } }));

  // For a session blocked by earlier imported results, one concrete step per
  // athlete that lifts the block. Undoing an earlier import is only rehearsed
  // on disposable databases today; the step says so.
  if (blocked?.code === "identities_missing_from_source") {
    const byId = new Map(athletes.map((a) => [a.gpexeAthleteId, a]));
    const UNDO = "Or a platform admin undoes the earlier import of this session (docs/runbooks/gpexe-undo-imported-session.md; for a persistent database that needs its own approval first), and the session is checked again.";
    blocked.resolution = (blocked.gpexeAthleteIds || []).map((gpexeAthleteId) => {
      const entry = byId.get(gpexeAthleteId);
      const cause = entry?.notImported?.code ?? "missing_in_gpexe";
      const previousAthleteId = blocked.previousAthleteByGpexeId?.[gpexeAthleteId] ?? null;
      let action;
      let step;
      if (cause === "athlete_not_linked") {
        action = "relink_athlete";
        step = `Link GPEXE athlete ${gpexeAthleteId} again to the OptiMove athlete its earlier results belong to (previousAthleteId), then press "Check now".`;
      } else if (cause === "athlete_not_in_team") {
        action = "restore_team_membership";
        step = `Make the OptiMove athlete (previousAthleteId) an active member of the team again, then press "Check now". ${UNDO}`;
      } else {
        action = "fix_in_gpexe_or_undo";
        step = `Correct this athlete's data in GPEXE (one track, valid statistics), then press "Check now". ${UNDO}`;
      }
      return { gpexeAthleteId, previousAthleteId, cause, action, step };
    });
    if (blocked.unknownExternalIds?.length) {
      blocked.resolution.push({
        gpexeAthleteId: null, previousAthleteId: null, cause: "missing_in_gpexe", action: "undo_earlier_import",
        step: `GPEXE no longer lists ${blocked.unknownExternalIds.length} earlier imported result(s) of this session at all. ${UNDO}`,
      });
    }
  }

  counts.changesToImported = changesToImported.length;
  const writes = counts.created + counts.supplemented + counts.corrected + counts.needs_review + counts.stale_resend_ignored;
  const status = blocked ? "blocked" : writes > 0 ? "ready" : "no_changes";
  const preview = {
    version: PREVIEW_VERSION,
    status,
    blocked,
    session: sessionSummary(bundle, plan),
    thresholdsUsed: plan.thresholdsUsed ? { id: plan.thresholdsUsed.id ?? null } : null,
    counts,
    // Non-empty: the approval must carry acceptChanges = true.
    changesToImported,
    athletes,
    teamAthletesWithoutGpexeRecord,
    anomalies: plan.anomalies.filter((a) => !a.gpexeAthleteId),
    // Section F rows 1-2 (J17 section 4). The rest_v1 snapshot holds only the
    // fields the extractor registry reads (the adapter's BUNDLE_FIELDS), so no
    // field without a source-metric identity reaches it: the count is 0 by
    // construction. The known fields with no open activation on the binding
    // are named for the two administrators (the projection keeps only the
    // count for everyone else).
    unmappedSourceFields: 0,
    unactivatedSourceMetrics: [...unactivated],
    unactivatedSourceMetricCount: unactivated.length,
  };
  // Bound to the state the preview was computed against and to the activation
  // set (J17 step 11): the approval recomputes it under the same locks and
  // refuses if anything differs.
  const state = [...before.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, s]) => [id, s.currentOccasionId, s.contentHash]);
  return { preview, previewHash: hashOf(preview, state, activationSet), summary };
}
