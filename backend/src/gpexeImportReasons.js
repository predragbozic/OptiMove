// Structured reasons on a candidate summary (Imports, phase 2b): why a
// session as a whole cannot be imported (blockedCode) and what keeps it out
// of "Ready to import" (reasons). Both are derived from the candidate's
// stored preview, the column the list query already reads for every row, so
// the list answers them without a per-candidate read.
//
// The codes are source-neutral: they name what the coach has to deal with,
// not what the GPEXE adapter reported. The adapter's own code stays next to
// them as blockedSourceCode, for Technical details only - it is not a UX
// contract, and neither is any server message.

// Why the whole session cannot be imported. `null` while nothing blocks it.
export const BLOCKED_CODES = Object.freeze({
  // The source records session types OptiMove does not import (a match).
  // Nothing to do; the session stays out for good.
  unsupported_session_type: "unsupported_session_type",
  // Results of this session imported earlier would now be left behind (an
  // athlete unlinked, out of the team, or needing manual review). The
  // detail carries one step per athlete.
  earlier_import_left_behind: "earlier_import_left_behind",
  // The source's per-team thresholds (speed and power zones) are missing or
  // do not cover the session's date.
  source_thresholds_unavailable: "source_thresholds_unavailable",
  // The source itself marks the session's statistics as not valid.
  source_marks_session_invalid: "source_marks_session_invalid",
  // No recorded athlete can be imported (none linked, or every one has a
  // data problem).
  no_importable_athlete: "no_importable_athlete",
  // The source sent incomplete or inconsistent data for the session.
  source_data_inconsistent: "source_data_inconsistent",
  // The import conflicts with data already in OptiMove (a duplicate event,
  // a changed binding, ...). A platform admin has to look at it.
  conflicts_with_existing_data: "conflicts_with_existing_data",
  // A code this mapping does not know. Same step as a conflict.
  other: "other",
});

// What keeps a pending session out of "Ready to import", one entry per kind
// with how many athletes or results it concerns, in the order the coach
// should read them.
export const REASON_CODES = Object.freeze({
  // No recorded athlete of the session is linked to an OptiMove athlete:
  // an import would write nothing. Listed instead of athletes_not_linked.
  no_linked_athlete: "no_linked_athlete",
  athletes_not_linked: "athletes_not_linked",
  athletes_not_in_team: "athletes_not_in_team",
  athletes_need_manual_review: "athletes_need_manual_review",
  athletes_marked_invalid_by_source: "athletes_marked_invalid_by_source",
  // Results imported earlier that this import would write to; each must be
  // accepted explicitly.
  changes_to_imported_results: "changes_to_imported_results",
});

// GPEXE adapter codes (gpexeImportMapper.js / gpexeImportWriter.js) by the
// neutral category they belong to.
const SOURCE_CODE_TO_BLOCKED = new Map([
  ["unsupported_category", BLOCKED_CODES.unsupported_session_type],
  ["identities_missing_from_source", BLOCKED_CODES.earlier_import_left_behind],
  ...["thresholds_missing", "thresholds_wrong_team", "thresholds_not_valid_for_session", "thresholds_payload_incomplete"]
    .map((c) => [c, BLOCKED_CODES.source_thresholds_unavailable]),
  ["session_stats_invalid", BLOCKED_CODES.source_marks_session_invalid],
  ["no_importable_participants", BLOCKED_CODES.no_importable_athlete],
  ...["session_missing", "invalid_timestamp", "timestamp_semantics_changed", "invalid_timezone", "mixed_timezones", "invalid_drills_count",
    "drill_index_out_of_range", "duplicate_drill_row", "track_missing", "track_athlete_mismatch", "more_missing", "invalid_athlete_id"]
    .map((c) => [c, BLOCKED_CODES.source_data_inconsistent]),
  ...["ambiguous_source_connection", "source_connection_conflict", "binding_conflict", "binding_event_mismatch", "binding_missing",
    "context_missing", "duplicate_event", "duplicate_segment", "event_changed", "event_conflict", "identity_lock_failed",
    "identity_target_changed", "metric_definition_mismatch", "participant_timezone_changed", "segment_linked_elsewhere", "segment_missing",
    "source_reference_set_changed", "reference_hash_version_outdated"]
    .map((c) => [c, BLOCKED_CODES.conflicts_with_existing_data]),
]);

export function blockedCodeFor(sourceCode) {
  if (typeof sourceCode !== "string" || !sourceCode) return null;
  return SOURCE_CODE_TO_BLOCKED.get(sourceCode) ?? BLOCKED_CODES.other;
}

// The per-athlete reason of one preview athlete entry, or null when the
// athlete is imported (or only left out because the whole session is).
function athleteReason(athlete) {
  const gps = athlete?.gps?.status;
  if (gps === "needs_manual_review") return REASON_CODES.athletes_need_manual_review;
  if (gps === "not_valid") return REASON_CODES.athletes_marked_invalid_by_source;
  const code = athlete?.notImported?.code;
  if (code === "athlete_not_linked") return REASON_CODES.athletes_not_linked;
  if (code === "athlete_not_in_team") return REASON_CODES.athletes_not_in_team;
  return null;
}

// { blockedCode, blockedSourceCode, sessionType, reasons } for one candidate
// row. `preview` is the stored preview when the snapshot is available, null
// otherwise (then nothing is known, as for previewStatus and counts).
export function candidateReasons(status, preview) {
  const empty = { blockedCode: null, blockedSourceCode: null, sessionType: null, reasons: [] };
  if (!preview) return empty;
  const sessionType = preview.session?.categoryName ?? null;
  if (status === "blocked" || preview.status === "blocked") {
    const sourceCode = preview.blocked?.code ?? null;
    return { blockedCode: blockedCodeFor(sourceCode) ?? BLOCKED_CODES.other, blockedSourceCode: sourceCode, sessionType, reasons: [] };
  }
  if (status !== "pending") return { ...empty, sessionType };

  const athletes = Array.isArray(preview.athletes) ? preview.athletes : [];
  const counts = new Map();
  for (const athlete of athletes) {
    const code = athleteReason(athlete);
    if (code) counts.set(code, (counts.get(code) || 0) + 1);
  }
  const reasons = [];
  const linked = athletes.filter((a) => a.athleteId).length;
  if (athletes.length && !linked) reasons.push({ code: REASON_CODES.no_linked_athlete, count: athletes.length });
  else if (counts.has(REASON_CODES.athletes_not_linked)) reasons.push({ code: REASON_CODES.athletes_not_linked, count: counts.get(REASON_CODES.athletes_not_linked) });
  for (const code of [REASON_CODES.athletes_not_in_team, REASON_CODES.athletes_need_manual_review, REASON_CODES.athletes_marked_invalid_by_source]) {
    if (counts.has(code)) reasons.push({ code, count: counts.get(code) });
  }
  const changes = Array.isArray(preview.changesToImported) ? preview.changesToImported.length : 0;
  if (changes) reasons.push({ code: REASON_CODES.changes_to_imported_results, count: changes });
  return { blockedCode: null, blockedSourceCode: null, sessionType, reasons };
}
