// GPEXE -> Training Load import plan. Pure: no database, no network, no file
// access - it turns already-fetched GPEXE REST responses into a
// provider-neutral plan that gpexeImportWriter.js writes.
//
// Every rule below was verified against real GPEXE v6 responses (team 980,
// session 186942), not against the 2020 handbook, whose examples differ:
// - Naive timestamps (team_session.start_timestamp, track.timestamp,
//   thresholds validity) are UTC: track.timestamp equals track.utc_timestamp.
//   The local zone comes from track.timezone. validateTrackTimestamps()
//   re-checks this on every import so a server-side change can't silently
//   shift local dates.
// - Numeric athlete_session fields are SI (total_time s, total_distance m,
//   max_v m/s) regardless of the account's user_units; only formatted
//   strings follow user_units.
// - One athlete_session row per athlete, track and part: drill === null is
//   the whole session, drill === n is drill n. Every row's teamsession is
//   the parent session. The whole-session value already equals the sum of
//   the drills, so the two levels are stored separately and never added.
// - The /more/ answer carries per-row zone distances with each zone's
//   boundaries, and event counts with their thresholds.
//
// Since phase 9 (9-B, contract J17) the importer has no metric list of its
// own: every value comes from an open mapping activation of the team's GPEXE
// binding, read by the extractor registry (sourceMetricExtractors.js) with the
// version's source parameters, converted exactly at the storage scale and
// written as the version's pinned canonical variable. mappedMetricSpecs()
// turns the locked activation rows into those specs; buildGpexeImportPlan()
// applies them at the levels each version covers; classifyMappedPlan() sorts
// the outcome into the whole-candidate blocks and the values left out.
import { canonicalDecimal, compareDecimal, extractabilityCode, extractorFor, SKIP_CATEGORY } from "./sourceMetricExtractors.js";
import { convertAtStorageScale } from "./sourceMetricPreview.js";

export const GPEXE_SOURCE_SYSTEM = "gpexe";

// Only categories whose meaning is confirmed for the pilot are importable.
const ACTIVITY_TYPE_BY_CATEGORY = new Map([["FULL TRAINING", "training_session"]]);

// The one rule for a GPEXE athlete id, wherever it enters (the raw rows of
// a snapshot, the link route, the source-athletes SQL): "0" or a number
// without a leading zero, at most 12 digits. "104" is an id; "0104" is not
// the same athlete written differently - it is refused, never normalised.
export const GPEXE_ATHLETE_ID_PATTERN = "^(0|[1-9][0-9]{0,11})$";
export const GPEXE_ATHLETE_ID_RE = new RegExp(GPEXE_ATHLETE_ID_PATTERN);

export function isCanonicalGpexeAthleteId(value) {
  return typeof value === "string" && GPEXE_ATHLETE_ID_RE.test(value);
}

export class GpexeMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function finiteNumber(raw) {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// GPEXE may report a threshold as a number or as a numeric string. The set is
// stored and hashed as provenance, so it is normalized to numbers first: a
// changed representation of the same set must not read as a changed set.
function numberOrNull(raw) {
  return finiteNumber(raw);
}

function numberArrayOrNull(raw) {
  if (!Array.isArray(raw)) return null;
  const numbers = raw.map(finiteNumber);
  return numbers.some((n) => n === null) ? null : numbers;
}

function parseNaiveUtc(naive, field) {
  if (typeof naive !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(naive)) {
    throw new GpexeMappingError("invalid_timestamp", `${field} is not a naive ISO timestamp: ${naive}`);
  }
  const date = new Date(`${naive}Z`);
  if (Number.isNaN(date.getTime())) throw new GpexeMappingError("invalid_timestamp", `${field} is not a valid timestamp: ${naive}`);
  return date;
}

export function localDateInTimezone(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localTimeInTimezone(instant, timezone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
}

// Intl silently falls back to the machine's zone for an undefined timeZone,
// so a missing value must be rejected before the Intl check.
function validTimezone(timezone) {
  if (typeof timezone !== "string" || timezone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// track.timestamp (naive) must be the same instant as track.utc_timestamp
// (epoch seconds) — the evidence that naive GPEXE timestamps are UTC.
function validateTrackTimestamps(track) {
  const naive = parseNaiveUtc(track.timestamp, `track ${track.id} timestamp`);
  const epochMs = finiteNumber(track.utc_timestamp) * 1000;
  if (!Number.isFinite(epochMs) || Math.abs(naive.getTime() - epochMs) > 1000) {
    throw new GpexeMappingError("timestamp_semantics_changed", `track ${track.id}: timestamp ${track.timestamp} is not the UTC instant of utc_timestamp ${track.utc_timestamp}`);
  }
}

// The team threshold set must belong to the session's team and be valid at
// the session start (GET team/:id/thresholds/?valid_on=<session day>).
// Its id, validity window and the thresholds the import actually depends on
// are carried through the plan so the writer can store them with the event:
// which set was in force is a different fact from a metric's own static
// bounds in condition_description, and GPEXE can change a set later.
function validateTeamThresholds(thresholds, session, startInstant) {
  if (!thresholds) throw new GpexeMappingError("thresholds_missing", `team thresholds for team ${session.team} were not fetched.`);
  if (String(thresholds.team) !== String(session.team)) {
    throw new GpexeMappingError("thresholds_wrong_team", `thresholds ${thresholds.id} belong to team ${thresholds.team}, session team is ${session.team}.`);
  }
  const validFrom = parseNaiveUtc(thresholds.validity_start, "thresholds.validity_start");
  const validTo = thresholds.validity_end ? parseNaiveUtc(thresholds.validity_end, "thresholds.validity_end") : null;
  if (startInstant < validFrom || (validTo && startInstant >= validTo)) {
    throw new GpexeMappingError("thresholds_not_valid_for_session", `thresholds ${thresholds.id} (valid ${thresholds.validity_start} – ${thresholds.validity_end ?? "open"}) do not cover session start ${startInstant.toISOString()}.`);
  }
  // Field names verified on the real response for team 980, valid_on
  // 2026-09-14 (set 1473). A renamed or missing field would otherwise be
  // snapshotted as null and a later change of it would not be noticed, so an
  // incomplete set stops the import instead.
  const payload = {
    power_thresholds: numberArrayOrNull(thresholds.power_thresholds),
    speed_thresholds: numberArrayOrNull(thresholds.speed_thresholds),
    acceleration_events_threshold: numberOrNull(thresholds.acceleration_events_threshold),
    acceleration_events_duration: numberOrNull(thresholds.acceleration_events_duration),
    deceleration_events_threshold: numberOrNull(thresholds.deceleration_events_threshold),
    deceleration_events_duration: numberOrNull(thresholds.deceleration_events_duration),
  };
  const missing = Object.keys(payload).filter((k) => payload[k] === null);
  if (missing.length) {
    throw new GpexeMappingError("thresholds_payload_incomplete", `thresholds ${thresholds.id} is missing ${missing.join(", ")} — the set cannot be recorded as the provenance of this session.`);
  }
  return {
    id: String(thresholds.id),
    validityStart: validFrom.toISOString(),
    validityEnd: validTo ? validTo.toISOString() : null,
    payload,
  };
}

// ---------------------------------------------------------------------------
// The specs: one per open activation of the binding (J17 section 3, step 7)
// ---------------------------------------------------------------------------
const REQUIREMENTS = new Set(["required", "optional"]);

// rows: the locked activation rows of gpexeImportMapping.js
// (readOpenActivations), in T5 id order. Answers { specs } or
// { block, blockReason } - "mapping_not_usable" when a row cannot be read or
// written as it stands, "source_unit_mismatch" when the version's source unit
// is not its revision's proven unit (defence in depth beside the T6 guard).
// Never a bound, threshold or factor from code: every one is the version's.
export function mappedMetricSpecs(rows) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  const notUsable = (blockReason) => ({ block: "mapping_not_usable", blockReason });
  const seen = new Set();
  for (const activation of rows) {
    if (!REQUIREMENTS.has(activation.requirement)) return notUsable("requirement");
    if (activation.versionStatus !== "active") return notUsable("version_not_active");
    if (activation.fieldState !== "active" || activation.revisionState !== "active" || activation.revisionEvidence !== "verified") return notUsable("revision_not_usable");
    if (activation.definitionState !== "active" || activation.valueType !== "numeric") return notUsable("definition_not_usable");
    if (activation.definitionCurrentVersionId !== activation.metricDefinitionVersionId) return notUsable("definition_version_changed");
    if (!activation.appliesToSession && !activation.appliesToDrill) return notUsable("no_level");
    const extractor = extractorFor({ sourceSystem: activation.sourceSystem, apiFamily: activation.apiFamily, sourceMetricKey: activation.sourceMetricKey });
    if (!extractor) return notUsable("no_extractor");
    if (extractabilityCode({
      sourceSystem: activation.sourceSystem, apiFamily: activation.apiFamily, sourceMetricKey: activation.sourceMetricKey,
      valueShape: activation.revisionValueShape, parameterKind: activation.revisionParameterKind, sourceParameters: activation.sourceParameters,
    }) !== null) return notUsable("not_extractable");
    for (const [level, covered] of [["full", activation.appliesToSession], ["drill", activation.appliesToDrill]]) {
      if (!covered) continue;
      const key = `${activation.metricDefinitionId}|${level}`;
      if (seen.has(key)) return notUsable("target_twice");
      seen.add(key);
    }
    if ([activation.scale, activation.scaleDivisor, activation.offset].some((f) => canonicalDecimal(f) === null)) return notUsable("factors");
    if ([activation.minValue, activation.maxValue].some((b) => b !== null && b !== undefined && canonicalDecimal(b) === null)) return notUsable("range");
  }
  if (rows.some((activation) => activation.sourceUnit !== activation.revisionSourceUnit)) return { block: "source_unit_mismatch", blockReason: "source_unit" };
  const specs = rows.map((activation) => {
    const extractor = extractorFor({ sourceSystem: activation.sourceSystem, apiFamily: activation.apiFamily, sourceMetricKey: activation.sourceMetricKey });
    const sourceParameters = activation.sourceParameters;
    return Object.freeze({
      activationId: activation.activationId,
      mappingVersionId: activation.mappingVersionId,
      mappingId: activation.mappingId,
      sourceMetricVersionId: activation.sourceMetricVersionId,
      metricDefinitionId: activation.metricDefinitionId,
      metricDefinitionVersionId: activation.metricDefinitionVersionId,
      variableKey: activation.definitionKey,
      variableScope: activation.definitionOwnerScope,
      label: activation.definitionLabel,
      unit: activation.targetUnit,
      sourceUnit: activation.revisionSourceUnit,
      sourceMetricKey: activation.sourceMetricKey,
      sourceLabel: activation.sourceLabel,
      sourceParameterFingerprint: activation.sourceParameterFingerprint,
      requirement: activation.requirement,
      levels: Object.freeze({ full: activation.appliesToSession === true, drill: activation.appliesToDrill === true }),
      factors: Object.freeze({ scale: canonicalDecimal(activation.scale), divisor: canonicalDecimal(activation.scaleDivisor), offset: canonicalDecimal(activation.offset) }),
      range: Object.freeze({
        min: activation.minValue === null || activation.minValue === undefined ? null : canonicalDecimal(activation.minValue),
        max: activation.maxValue === null || activation.maxValue === undefined ? null : canonicalDecimal(activation.maxValue),
      }),
      extract: (input) => extractor.extract(input, sourceParameters),
    });
  });
  return { block: null, specs };
}

// bundle = {
//   teamSession: GET team_session/:id/,
//   athleteSessions: [GET athlete_session/:id/, ...] (whole + drill rows),
//   more: { [athleteSessionId]: GET athlete_session/:id/more/ },
//   tracks: { [trackId]: GET track/:id/ },
//   teamThresholds: GET team/:team/thresholds/?valid_on=<session day>,
//   details: { full: GET team_session/:id/details/, drills: { [n]: ...details/?drill=n } },
// }
//
// metricSpecs (required): the specs of mappedMetricSpecs(), or test / preview
// specs { raw: true, key, levels, extract } whose values are kept unconverted
// (the 7e preview and the characterisation oracle). A result exists only for a
// row whose level at least one spec covers; [] builds the gates alone.
// teamTimezone (v62, mixed_timezones (b)): the team's session time zone, set by a platform admin. It is used only when the
// tracks report more than one zone; a session whose tracks agree keeps its own zone (an away match keeps its real local
// time). Without it a mixed session is refused as before.
export function buildGpexeImportPlan(bundle, { metricSpecs, teamTimezone = null } = {}) {
  if (!Array.isArray(metricSpecs)) throw new TypeError("metricSpecs must be an array");
  const session = bundle?.teamSession;
  if (!session?.id) throw new GpexeMappingError("session_missing", "teamSession is required.");
  if (session.is_stats_valid !== true) throw new GpexeMappingError("session_stats_invalid", `team_session ${session.id} has is_stats_valid=${session.is_stats_valid}.`);
  const activityTypeKey = ACTIVITY_TYPE_BY_CATEGORY.get(session.category_name);
  if (!activityTypeKey) throw new GpexeMappingError("unsupported_category", `team_session ${session.id} category "${session.category_name}" is not importable in the pilot.`);
  const sessionId = String(session.id);
  const startInstant = parseNaiveUtc(session.start_timestamp, "team_session.start_timestamp");
  const endInstant = parseNaiveUtc(session.end_timestamp, "team_session.end_timestamp");
  const sourceReportedAt = parseNaiveUtc(session.updated_on, "team_session.updated_on");
  const drillsCount = Number(session.drills_count ?? 0);
  if (!Number.isInteger(drillsCount) || drillsCount < 0) throw new GpexeMappingError("invalid_drills_count", `drills_count ${session.drills_count} is not a non-negative integer.`);
  const thresholdsUsed = validateTeamThresholds(bundle.teamThresholds, session, startInstant);

  const anomalies = [];
  const rows = (bundle.athleteSessions || []).filter((row) => String(row.teamsession) === sessionId);
  const foreignRows = (bundle.athleteSessions || []).length - rows.length;
  if (foreignRows > 0) anomalies.push({ kind: "foreign_athlete_session_ignored", detail: `${foreignRows} row(s) belong to another team_session` });

  // Group by athlete; an athlete recorded on more than one track in the
  // same session (e.g. a device restart) is reported and not imported.
  const byAthlete = new Map();
  for (const row of rows) {
    const athleteId = String(row.athlete);
    // A row whose athlete id is not canonical is data the importer cannot
    // attribute; the session is refused rather than the id reinterpreted.
    if (!isCanonicalGpexeAthleteId(athleteId)) throw new GpexeMappingError("invalid_athlete_id", `athlete_session ${row.id} has athlete ${JSON.stringify(row.athlete)}, not a canonical GPEXE athlete id.`);
    if (!byAthlete.has(athleteId)) byAthlete.set(athleteId, []);
    byAthlete.get(athleteId).push(row);
  }

  const timezones = new Set();
  const participants = [];
  const leftOut = [];
  for (const [gpexeAthleteId, athleteRows] of [...byAthlete.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
    const trackIds = [...new Set(athleteRows.map((r) => String(r.track)))];
    if (trackIds.length > 1) {
      anomalies.push({ kind: "multiple_tracks", gpexeAthleteId, detail: `tracks ${trackIds.join(", ")} — not imported, needs review` });
      continue;
    }
    const track = bundle.tracks?.[trackIds[0]];
    if (!track) throw new GpexeMappingError("track_missing", `track ${trackIds[0]} for athlete ${gpexeAthleteId} was not fetched.`);
    if (String(track.athlete) !== gpexeAthleteId) throw new GpexeMappingError("track_athlete_mismatch", `track ${track.id} belongs to athlete ${track.athlete}, not ${gpexeAthleteId}.`);
    validateTrackTimestamps(track);
    if (!validTimezone(track.timezone)) throw new GpexeMappingError("invalid_timezone", `track ${track.id} timezone "${track.timezone}" is not recognized.`);
    timezones.add(track.timezone);

    const invalid = athleteRows.filter((r) => r.is_stats_valid !== true);
    if (invalid.length) {
      anomalies.push({ kind: "stats_invalid", gpexeAthleteId, detail: `athlete_session ${invalid.map((r) => r.id).join(", ")} has is_stats_valid!=true — athlete not imported` });
      continue;
    }
    const wholeRows = athleteRows.filter((r) => r.drill === null || r.drill === undefined);
    if (wholeRows.length !== 1) {
      anomalies.push({ kind: "whole_session_row_count", gpexeAthleteId, detail: `${wholeRows.length} whole-session rows — athlete not imported` });
      continue;
    }
    const drillRows = athleteRows.filter((r) => r.drill !== null && r.drill !== undefined);
    const drillIndexes = drillRows.map((r) => Number(r.drill));
    if (drillIndexes.some((i) => !Number.isInteger(i) || i < 0 || i >= drillsCount)) {
      throw new GpexeMappingError("drill_index_out_of_range", `athlete ${gpexeAthleteId} has drill index outside 0..${drillsCount - 1}.`);
    }
    if (new Set(drillIndexes).size !== drillIndexes.length) {
      throw new GpexeMappingError("duplicate_drill_row", `athlete ${gpexeAthleteId} has more than one row for the same drill.`);
    }

    const results = [];
    for (const row of [wholeRows[0], ...drillRows.sort((a, b) => a.drill - b.drill)]) {
      const level = row.drill === null || row.drill === undefined ? "full" : "drill";
      const drillIndex = level === "drill" ? Number(row.drill) : null;
      const more = bundle.more?.[String(row.id)];
      if (!more || String(more.athletesession_id) !== String(row.id)) {
        throw new GpexeMappingError("more_missing", `/more/ for athlete_session ${row.id} was not fetched.`);
      }
      const details = level === "full" ? bundle.details?.full : bundle.details?.drills?.[String(drillIndex)];
      const playerDetails = details?.players?.[gpexeAthleteId] ?? null;
      const covering = metricSpecs.filter((spec) => spec.levels?.[level] === true);
      if (covering.length === 0) continue;
      const values = [];
      for (const spec of covering) {
        const extracted = spec.extract({ row, more, thresholds: bundle.teamThresholds, playerDetails });
        const at = { gpexeAthleteId, athleteSessionId: String(row.id), level, drillIndex };
        if (extracted.skip) {
          // A mapped spec's extractor is the registry's, whose every code has a
          // category; a raw spec (the 7e preview, J11 R3) keeps its skip as it is.
          const category = SKIP_CATEGORY[extracted.skip] ?? null;
          if (!category && !spec.raw) throw new Error("an extractor answered an unknown skip code");
          leftOut.push({ ...at, ...(spec.raw ? { key: spec.key } : { activationId: spec.activationId }), category, code: extracted.skip });
          continue;
        }
        if (spec.raw) {
          values.push({ key: spec.key, value: extracted.value });
          continue;
        }
        const sourceValue = canonicalDecimal(extracted.value);
        if (sourceValue === null) throw new Error("an extracted value is not a decimal");
        // D8: exact, rounded once at the storage scale; the stored value is
        // this text, never a binary double (J17 section 3, step 10).
        const value = convertAtStorageScale(sourceValue, spec.factors);
        // R8: a converted value outside the pinned canonical version's limits is
        // left out (C110 form B); it is never returned, logged or written.
        if ((spec.range.min !== null && compareDecimal(value, spec.range.min) < 0)
          || (spec.range.max !== null && compareDecimal(value, spec.range.max) > 0)) {
          leftOut.push({ ...at, activationId: spec.activationId, category: "range", code: "canonical_value_out_of_range" });
          continue;
        }
        values.push({
          activationId: spec.activationId,
          mappingVersionId: spec.mappingVersionId,
          mappingId: spec.mappingId,
          sourceMetricVersionId: spec.sourceMetricVersionId,
          metricDefinitionId: spec.metricDefinitionId,
          metricDefinitionVersionId: spec.metricDefinitionVersionId,
          variableKey: spec.variableKey,
          variableScope: spec.variableScope,
          label: spec.label,
          unit: spec.unit,
          value,
          sourceValue,
          sourceUnit: spec.sourceUnit,
          sourceMetricKey: spec.sourceMetricKey,
          sourceParameterFingerprint: spec.sourceParameterFingerprint,
        });
      }
      results.push({
        externalId: level === "full" ? `athlete_session:${row.id}:full` : `athlete_session:${row.id}:drill:${drillIndex}`,
        athleteSessionId: String(row.id),
        level,
        drillIndex,
        values,
      });
    }

    // Whole-session totals already equal the sum of their drills when the
    // athlete has all drills; a mismatch is reported, never "fixed".
    if (drillsCount > 0 && drillRows.length === drillsCount) {
      for (const field of ["total_time", "total_distance"]) {
        const whole = finiteNumber(wholeRows[0][field]);
        const sum = drillRows.reduce((acc, r) => acc + (finiteNumber(r[field]) ?? 0), 0);
        if (whole !== null && Math.abs(whole - sum) > Math.max(1, whole * 0.001)) {
          anomalies.push({ kind: "whole_differs_from_drills", gpexeAthleteId, detail: `${field}: whole ${whole} vs drills ${sum}` });
        }
      }
    }
    participants.push({ gpexeAthleteId, timezone: track.timezone, results });
  }

  const mixed = timezones.size > 1;
  if (mixed && !validTimezone(teamTimezone)) throw new GpexeMappingError("mixed_timezones", `tracks report more than one timezone: ${[...timezones].join(", ")}.`);
  if (participants.length === 0) throw new GpexeMappingError("no_importable_participants", `team_session ${sessionId} has no importable athlete.`);
  // Each participant keeps its own track's zone; only the event's zone is chosen.
  const timezone = mixed ? teamTimezone : [...timezones][0];

  const segments = [];
  for (let drillIndex = 0; drillIndex < drillsCount; drillIndex += 1) {
    if (participants.some((p) => p.results.some((r) => r.drillIndex === drillIndex))) {
      segments.push({ drillIndex, order: drillIndex + 1, label: `Drill ${drillIndex + 1}` });
    }
  }

  return {
    sourceSystem: GPEXE_SOURCE_SYSTEM,
    gpexeTeamId: String(session.team),
    teamSessionId: sessionId,
    thresholdsUsed,
    event: {
      sourceExternalId: `team_session:${sessionId}`,
      name: `GPEXE ${session.category_name} ${localDateInTimezone(startInstant, timezone)} ${localTimeInTimezone(startInstant, timezone)}`,
      activityTypeKey,
      occurredInstant: startInstant.toISOString(),
      endedInstant: endInstant.toISOString(),
      occurredLocalDate: localDateInTimezone(startInstant, timezone),
      timezone,
      // Only for a mixed session: which zones the tracks reported, and that the team's zone was used. A single-zone
      // session's event (and so its preview and its hash) is byte for byte what it was.
      ...(mixed ? { timezoneSource: "team", trackTimezones: [...timezones].sort() } : {}),
      sourceReportedAt: sourceReportedAt.toISOString(),
    },
    segments,
    participants,
    anomalies,
    leftOut,
    // The preview hash's activation set (J17 section 3, step 11).
    activationSet: metricSpecs
      .filter((spec) => !spec.raw)
      .map((spec) => [spec.activationId, spec.mappingVersionId])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// Classification (J17 section 3, step 8; decision D3 of 9-B)
// ---------------------------------------------------------------------------
// The whole-candidate outcome of a mapped plan: the first block that applies
// to the athletes the import admits (the linked active members, importableIds;
// when none is linked, every participant, so a session nobody is linked to
// yet keeps today's "link athletes" answer when the mapping gives values):
// a threshold-contract skip, then a shape skip, then no value at all. Values
// left out (C110) never block.
export function classifyMappedPlan(plan, { importableIds, activationCount }) {
  if (!activationCount) return { block: "no_mapped_values" };
  const importable = new Set([...(importableIds ?? [])].map(String));
  const admitted = importable.size > 0 ? importable : new Set(plan.participants.map((p) => p.gpexeAthleteId));
  const records = plan.leftOut.filter((record) => admitted.has(record.gpexeAthleteId));
  if (records.some((record) => record.category === "threshold_contract")) return { block: "source_threshold_contract_mismatch" };
  if (records.some((record) => record.category === "shape")) return { block: "source_shape_mismatch" };
  const values = plan.participants
    .filter((p) => admitted.has(p.gpexeAthleteId))
    .reduce((n, p) => n + p.results.reduce((m, result) => m + result.values.length, 0), 0);
  if (values === 0) return { block: "no_mapped_values" };
  return { block: null };
}

// The reason of one value left out (C110, form B): a required value that is
// missing reads required_value_missing, a value outside the variable's
// limits canonical_value_out_of_range, any other the extractor's own code.
// sourceReason (the extractor's code) is for the two administrators only.
export function leftOutReason(spec, record) {
  if (record.category === "range") return { reason: "canonical_value_out_of_range", sourceReason: record.code };
  if (record.category === "missing" && spec?.requirement === "required") return { reason: "required_value_missing", sourceReason: record.code };
  return { reason: record.code, sourceReason: record.code };
}

// R12: the Link athletes helper values of one whole-session row, read through
// the three athlete_session extractors in the source units (s, m, m/s),
// independent of any activation; null where the row has none.
const HELPER_FIELDS = [
  ["totalTime", "athlete_session.total_time"],
  ["totalDistance", "athlete_session.total_distance"],
  ["maxV", "athlete_session.max_v"],
];
export function wholeRowHelperValues(row) {
  const out = {};
  for (const [name, sourceMetricKey] of HELPER_FIELDS) {
    const extracted = extractorFor({ sourceSystem: GPEXE_SOURCE_SYSTEM, apiFamily: "rest_v1", sourceMetricKey }).extract({ row: row ?? {} }, {});
    out[name] = extracted.skip ? null : extracted.value;
  }
  return out;
}

// Phase 7e (J11, R3): the values one extractor gives each athlete the import
// keeps, per level, through the import's own session and athlete gates - the
// plan above with one raw spec at both levels. Only a refusal's stable code
// leaves: the plan's messages, anomalies
// and skips name session, track, row and athlete ids, and none of them is
// returned. `extract` gets the plan's per-row input and returns { value } or
// { skip }.
// v62: `teamTimezone` is the candidate team's session time zone, so a mixed session passes the same gates as its import.
export function gpexeLevelValues(bundle, extract, { teamTimezone = null } = {}) {
  let plan;
  try {
    plan = buildGpexeImportPlan(bundle, { metricSpecs: [{ raw: true, key: "preview", levels: { full: true, drill: true }, extract }], teamTimezone });
  } catch (error) {
    if (error instanceof GpexeMappingError) return { code: error.code };
    throw error;
  }
  const valuesAt = (participant, level) => participant.results
    .filter((result) => result.level === level)
    .flatMap((result) => result.values.map((entry) => entry.value));
  return {
    code: null,
    athletes: plan.participants.map((participant) => ({ session: valuesAt(participant, "full"), drill: valuesAt(participant, "drill") })),
  };
}

// J18 (the drag-and-drop board, contract section 4.3 step 6): the session-level
// values of SEVERAL extractors in ONE plan, through the same gates, with each
// athlete's GPEXE athlete id as an internal key so the board can choose two
// athletes and name them. `extracts` is a list of the functions gpexeLevelValues
// takes; an athlete's `session[i]` is the list of values extracts[i] gave (one,
// or none). The key never leaves the board's service: no answer, URL, log line
// or stored row carries it.
export function gpexeSessionValuesKeyed(bundle, extracts, { teamTimezone = null } = {}) {
  let plan;
  try {
    plan = buildGpexeImportPlan(bundle, { metricSpecs: extracts.map((extract, index) => ({ raw: true, key: String(index), levels: { full: true, drill: false }, extract })), teamTimezone });
  } catch (error) {
    if (error instanceof GpexeMappingError) return { code: error.code };
    throw error;
  }
  return {
    code: null,
    athletes: plan.participants.map((participant) => {
      const session = extracts.map(() => []);
      for (const result of participant.results) {
        if (result.level !== "full") continue;
        for (const entry of result.values) session[Number(entry.key)].push(entry.value);
      }
      return { key: participant.gpexeAthleteId, session };
    }),
  };
}
