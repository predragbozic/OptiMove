// The structured reasons a candidate summary carries (Imports, phase 2b),
// derived from the stored preview alone. Pure: no database, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_CODES, REASON_CODES, blockedCodeFor, candidateReasons } from "../src/gpexeImportReasons.js";
import { GpexeMappingError } from "../src/gpexeImportMapper.js";
import { GpexeImportError } from "../src/gpexeImportWriter.js";
import fs from "node:fs";

const athlete = (over = {}) => ({
  gpexeAthleteId: "101", athleteId: "ath-1", participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null },
  notImported: null, blocksSession: false, results: [], skippedValues: [], notes: [], ...over,
});
const unlinked = (id) => athlete({ gpexeAthleteId: id, athleteId: null, notImported: { code: "athlete_not_linked", message: "x" } });
const preview = (over = {}) => ({ version: 2, status: "ready", blocked: null, session: { categoryName: "FULL TRAINING" }, counts: {}, changesToImported: [], athletes: [athlete()], teamAthletesWithoutGpexeRecord: [], ...over });

test("every code the GPEXE mapper and writer can throw maps to a neutral blocked code, and an unknown one is 'other'", () => {
  // Read the adapter sources: a code added later without a mapping shows up
  // here as 'other', which this test then names.
  const codes = new Set();
  for (const file of ["../src/gpexeImportMapper.js", "../src/gpexeImportWriter.js"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    // The literal may sit on the next line (the writer's threshold errors do).
    for (const m of text.matchAll(/new Gpexe(?:Mapping|Import)Error\(\s*"([a-z_]+)"/g)) codes.add(m[1]);
  }
  assert.ok(codes.size > 20, `found ${codes.size} adapter codes`);
  assert.ok(codes.has("source_reference_set_changed") && codes.has("reference_hash_version_outdated"), "the scan sees multi-line constructors");
  assert.equal(blockedCodeFor("source_reference_set_changed"), BLOCKED_CODES.conflicts_with_existing_data);
  assert.equal(blockedCodeFor("reference_hash_version_outdated"), BLOCKED_CODES.conflicts_with_existing_data);
  const unmapped = [...codes].filter((c) => blockedCodeFor(c) === BLOCKED_CODES.other);
  // Two writer codes describe a participant the preview never hands to the
  // writer (it filters to linked team athletes first): a bug, not a coach
  // reason, so 'other' with the admin step is the honest category.
  assert.deepEqual(unmapped.sort(), ["athlete_not_in_team", "athlete_not_mapped"]);
  for (const code of codes) assert.ok(Object.values(BLOCKED_CODES).includes(blockedCodeFor(code)), code);
  assert.equal(blockedCodeFor("something_new_nobody_mapped"), BLOCKED_CODES.other);
  assert.equal(blockedCodeFor(null), null);
  assert.equal(blockedCodeFor(""), null);
  // The classes really carry `code` the way the preview stores it.
  assert.equal(new GpexeMappingError("unsupported_category", "m").code, "unsupported_category");
  assert.equal(new GpexeImportError("duplicate_event", "m").code, "duplicate_event");
});

test("blocked: the neutral code, the adapter's own code and the session type; no per-athlete reasons", () => {
  const cases = [
    ["unsupported_category", BLOCKED_CODES.unsupported_session_type],
    ["identities_missing_from_source", BLOCKED_CODES.earlier_import_left_behind],
    ["thresholds_not_valid_for_session", BLOCKED_CODES.source_thresholds_unavailable],
    ["thresholds_missing", BLOCKED_CODES.source_thresholds_unavailable],
    ["session_stats_invalid", BLOCKED_CODES.source_marks_session_invalid],
    ["no_importable_participants", BLOCKED_CODES.no_importable_athlete],
    ["track_missing", BLOCKED_CODES.source_data_inconsistent],
    ["mixed_timezones", BLOCKED_CODES.source_data_inconsistent],
    ["duplicate_event", BLOCKED_CODES.conflicts_with_existing_data],
    ["binding_conflict", BLOCKED_CODES.conflicts_with_existing_data],
    ["brand_new_code", BLOCKED_CODES.other],
  ];
  for (const [sourceCode, blockedCode] of cases) {
    const r = candidateReasons("blocked", preview({ status: "blocked", blocked: { code: sourceCode, message: "server text" }, session: { categoryName: "OFFICIAL MATCH" }, athletes: [unlinked("104")] }));
    assert.deepEqual(r, { blockedCode, blockedSourceCode: sourceCode, sessionType: "OFFICIAL MATCH", reasons: [] }, sourceCode);
  }
  // A blocked row whose preview lost its code still says it is blocked.
  assert.equal(candidateReasons("blocked", preview({ status: "blocked", blocked: null })).blockedCode, BLOCKED_CODES.other);
  // A preview blocked by the mapper (blockedByMapping) has no athletes at all.
  const mapped = candidateReasons("blocked", { version: 2, status: "blocked", blocked: { code: "unsupported_category", message: "m" }, session: { categoryName: "OFFICIAL MATCH" }, counts: {}, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [] });
  assert.deepEqual([mapped.blockedCode, mapped.sessionType], [BLOCKED_CODES.unsupported_session_type, "OFFICIAL MATCH"]);
});

test("pending: one reason per kind with its count, in reading order; a clean session has none", () => {
  assert.deepEqual(candidateReasons("pending", preview()), { blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [] });

  const mixed = preview({
    athletes: [
      athlete(),
      unlinked("104"), unlinked("106"),
      athlete({ gpexeAthleteId: "103", gps: { status: "needs_manual_review", reason: { code: "multiple_tracks" } }, notImported: { code: "multiple_tracks", message: "x" } }),
      athlete({ gpexeAthleteId: "105", gps: { status: "not_valid", reason: { code: "stats_invalid" } }, notImported: { code: "stats_invalid", message: "x" } }),
      athlete({ gpexeAthleteId: "107", athleteId: "ath-gone", notImported: { code: "athlete_not_in_team", message: "x" } }),
    ],
    changesToImported: [{ outcome: "corrected" }, { outcome: "supplemented" }],
  });
  assert.deepEqual(candidateReasons("pending", mixed).reasons, [
    { code: REASON_CODES.athletes_not_linked, count: 2 },
    { code: REASON_CODES.athletes_not_in_team, count: 1 },
    { code: REASON_CODES.athletes_need_manual_review, count: 1 },
    { code: REASON_CODES.athletes_marked_invalid_by_source, count: 1 },
    { code: REASON_CODES.changes_to_imported_results, count: 2 },
  ]);
});

test("pending: when no recorded athlete is linked the reason is no_linked_athlete, whatever else is wrong with them", () => {
  const nobody = preview({
    status: "no_changes",
    athletes: [unlinked("104"), athlete({ gpexeAthleteId: "103", athleteId: null, gps: { status: "needs_manual_review", reason: { code: "multiple_tracks" } }, notImported: { code: "multiple_tracks", message: "x" } })],
  });
  assert.deepEqual(candidateReasons("pending", nobody).reasons, [
    { code: REASON_CODES.no_linked_athlete, count: 2 },
    { code: REASON_CODES.athletes_need_manual_review, count: 1 },
  ]);
  // One linked athlete is enough for "N not linked" instead.
  const one = preview({ athletes: [athlete(), unlinked("104")] });
  assert.deepEqual(candidateReasons("pending", one).reasons, [{ code: REASON_CODES.athletes_not_linked, count: 1 }]);
  // A session GPEXE recorded nobody in has no athlete reason.
  assert.deepEqual(candidateReasons("pending", preview({ athletes: [] })).reasons, []);
});

test("no preview (snapshot expired or purged), imported and superseded rows: nothing is claimed", () => {
  const empty = { blockedCode: null, blockedSourceCode: null, sessionType: null, reasons: [] };
  assert.deepEqual(candidateReasons("blocked", null), empty);
  assert.deepEqual(candidateReasons("pending", undefined), empty);
  assert.deepEqual(candidateReasons("imported", preview({ athletes: [unlinked("104")] })), { ...empty, sessionType: "FULL TRAINING" });
  assert.deepEqual(candidateReasons("superseded", preview({ athletes: [unlinked("104")] })), { ...empty, sessionType: "FULL TRAINING" });
});
