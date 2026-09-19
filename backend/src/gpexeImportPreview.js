// Preview of one GPEXE import candidate (in-app import, phase F1): what an
// approved import would write or change, per athlete and per value, and why
// anything is left out. Nothing is written: the importer runs every
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
import { buildGpexeImportPlan, GpexeMappingError, GPEXE_METRIC_SPECS } from "./gpexeImportMapper.js";
import { importGpexePlanLocked, lockTeamForImport, GpexeImportError } from "./gpexeImportWriter.js";

// 2: changesToImported (phase F2).
export const PREVIEW_VERSION = 2;

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

const METRIC_BY_KEY = new Map(GPEXE_METRIC_SPECS.map((m) => [m.key, m]));

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
async function currentState(client, ownerTeamId, externalIds) {
  const rows = (await client.query(
    `select si.source_external_id, si.current_occasion_id, o.content_hash, o.entry_method,
            d.key as metric_key, v.value_numeric
     from training_load.metric_source_connections c
     join training_load.metric_source_identities si on si.source_connection_id = c.id
     left join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
     left join training_load.metric_values v on v.occasion_id = o.id
     left join training_load.metric_definitions d on d.id = v.metric_definition_id
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
    if (r.metric_key) byId.get(r.source_external_id).values.set(r.metric_key, r.value_numeric === null ? null : Number(r.value_numeric));
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

function valueDiff(result, outcome, previous) {
  const newByKey = new Map(result.values.map((v) => [v.metricKey, v.value]));
  const keys = new Set([...newByKey.keys(), ...(previous ? previous.values.keys() : [])]);
  return [...keys].sort().map((metricKey) => {
    const spec = METRIC_BY_KEY.get(metricKey);
    const next = newByKey.has(metricKey) ? newByKey.get(metricKey) : null;
    const prev = previous && previous.values.has(metricKey) ? previous.values.get(metricKey) : null;
    let change;
    if (outcome === "created") change = "new";
    else if (prev === null && next !== null) change = "added";
    else if (prev !== null && next === null) change = "missing_in_gpexe";
    else if (prev !== null && next !== null && Math.abs(prev - next) > 1e-9) change = "changed";
    else change = "same";
    return { metricKey, label: spec?.label ?? metricKey, unit: spec?.unit ?? null, previous: prev, value: next, change };
  });
}

export function blockedByMapping(bundle, error) {
  const preview = {
    version: PREVIEW_VERSION, status: "blocked", blocked: { code: error.code, message: error.message },
    session: sessionSummary(bundle, null), counts: {}, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [],
  };
  return { preview, previewHash: sha256Hex(canonicalJson({ preview, state: [] })), summary: null };
}

// Returns { preview, previewHash }. `client` must not be inside a
// transaction: this opens one, takes the team's import lock, reads everything
// the preview depends on, runs the import, and always rolls back — so the
// "before" values and the outcomes come from one locked snapshot.
export async function buildCandidatePreview(client, { bundle, ownerTeamId, performedByUserId }) {
  let plan;
  try {
    plan = buildGpexeImportPlan(bundle);
  } catch (error) {
    if (!(error instanceof GpexeMappingError)) throw error;
    return blockedByMapping(bundle, error);
  }
  await client.query("begin");
  try {
    await lockTeamForImport(client, ownerTeamId);
    const { preview, previewHash } = await previewLocked(client, { bundle, plan, ownerTeamId, performedByUserId });
    return { preview, previewHash };
  } finally {
    await client.query("rollback").catch(() => {});
  }
}

// The preview for a caller that has begun a transaction and taken
// lockTeamForImport(). It runs the import inside that transaction and leaves
// the transaction open: the preview rolls back; the approval in F2 compares
// previewHash with the approved one and commits only if they are equal.
// `summary` is the importer's own result (null when nothing was run).
export async function previewLocked(client, { bundle, plan, ownerTeamId, performedByUserId }) {
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

  let outcomes = new Map();
  let blocked = null;
  let summary = null;
  if (importable.length) {
    // A savepoint, so an import refused by an SQL error (e.g. a concurrent
    // connection conflict) leaves the caller's transaction usable and the
    // caller's own reads/commit decision well defined.
    await client.query("savepoint gpexe_preview_import");
    try {
      summary = await importGpexePlanLocked(
        client,
        { ...plan, participants: importable },
        {
          ownerTeamId, performedByUserId,
          athleteIdByGpexeId: new Map(importable.map((p) => [p.gpexeAthleteId, links.get(p.gpexeAthleteId)])),
          batchFilename: `gpexe import team_session:${sessionId}`,
        },
      );
      outcomes = new Map(summary.results.map((r) => [r.externalId, r]));
    } catch (error) {
      await client.query("rollback to savepoint gpexe_preview_import");
      if (!(error instanceof GpexeImportError)) throw error;
      blocked = { code: error.code, message: error.message };
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
        const values = valueDiff(result, outcome, previous);
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
    for (const skip of plan.metricSkips.filter((s) => s.gpexeAthleteId === gpexeAthleteId)) {
      counts.skippedValues += 1;
      entry.skippedValues.push({ level: skip.level, drillIndex: skip.drillIndex, metricKey: skip.metricKey, label: METRIC_BY_KEY.get(skip.metricKey)?.label ?? skip.metricKey, reason: skip.reason });
    }
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
    derivedNotImported: plan.derivedNotImported,
  };
  // Bound to the state the preview was computed against: F2 recomputes it
  // under the import lock and refuses the approval if anything differs.
  const state = [...before.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, s]) => [id, s.currentOccasionId, s.contentHash]);
  return { preview, previewHash: sha256Hex(canonicalJson({ preview, state })), summary };
}
