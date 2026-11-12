// MT-0 (docs/ai/mt-multiple-tracks-plan.md section 11; the owner's yes, 2026-11-12): an athlete whose tracks are identical
// copies of one recording is imported once, from the lowest track id, with that track's native identities; any difference in a
// consumed field keeps today's multiple_tracks. E1 is decided (2026-11-12): the deduplicated athlete's details (burst, brake) are
// imported exactly as GPEXE's details give them. Pure: no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGpexeImportPlan, classifyMappedPlan, identicalTracks, mappedMetricSpecs,
} from "../src/gpexeImportMapper.js";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { LEGACY_SPECS, activationRowFor } from "./support/gpexe-legacy-specs.mjs";

const oracle = LEGACY_SPECS.map((spec) => ({ raw: true, key: spec.key, levels: { full: true, drill: true }, extract: spec.extract }));

// Athlete 106: one recording sent twice (tracks 9207 and 9206, the higher listed first), with a whole-session row and drill 0
// on each track. Athletes 101 and 102 as the fixture has them.
function bundleWithDuplicate({ tracks = [9207, 9206], tweak = null } = {}) {
  const std = standardAthletes();
  const base = structuredClone(std[1]);
  const dup = { id: 106, tracks, parts: [] };
  for (const track of tracks) {
    for (const part of base.parts) dup.parts.push({ ...structuredClone(part), track });
  }
  const bundle = makeBundle({ sessionId: 7, athletes: [structuredClone(std[0]), structuredClone(std[1]), dup], detailsDrills: [0, 1] });
  if (tweak) tweak(bundle);
  return bundle;
}
const rowsOf = (bundle, athlete, track) => bundle.athleteSessions.filter((r) => String(r.athlete) === String(athlete) && (track === undefined || String(r.track) === String(track)));

test("1. identical tracks are one recording: one participant, from the lowest track id, with that track's native identities and the duplicateTracks label; no multiple_tracks anomaly", () => {
  const bundle = bundleWithDuplicate();
  const plan = buildGpexeImportPlan(bundle, { metricSpecs: oracle });
  assert.deepEqual(plan.participants.map((p) => p.gpexeAthleteId), ["101", "102", "106"]);
  assert.equal(plan.anomalies.some((a) => a.kind === "multiple_tracks"), false);
  const p = plan.participants.find((x) => x.gpexeAthleteId === "106");
  assert.deepEqual(p.duplicateTracks, { count: 2, usedTrackId: "9206", ignoredTrackIds: ["9207"] });
  const used = rowsOf(bundle, 106, 9206);
  const whole = used.find((r) => r.drill === null);
  const drill = used.find((r) => r.drill === 0);
  assert.deepEqual(p.results.map((r) => r.externalId).sort(), [`athlete_session:${whole.id}:full`, `athlete_session:${drill.id}:drill:0`].sort(),
    "exactly the identities a single-track import of track 9206 has");
  // The same values as the athlete it copies (102), whose single recording carries the same numbers.
  const p102 = plan.participants.find((x) => x.gpexeAthleteId === "102");
  const valuesOf = (x) => x.results.find((r) => r.level === "full").values.map((v) => [v.key, v.value]);
  assert.deepEqual(valuesOf(p), valuesOf(p102));
});

test("2. three identical tracks: count 3, the lowest used, the two others ignored", () => {
  const plan = buildGpexeImportPlan(bundleWithDuplicate({ tracks: [9310, 9302, 9305] }), { metricSpecs: oracle });
  assert.deepEqual(plan.participants.find((x) => x.gpexeAthleteId === "106").duplicateTracks, { count: 3, usedTrackId: "9302", ignoredTrackIds: ["9305", "9310"] });
});

test("3. fail closed: one difference in any compared field - the track's start, zone, a row field, a missing or extra level, /more/'s events or zones - keeps today's multiple_tracks", () => {
  const firstOf = (b, track, drill = null) => b.athleteSessions.find((r) => String(r.athlete) === "106" && String(r.track) === String(track) && r.drill === drill);
  const cases = {
    "track start": (b) => { b.tracks["9207"].utc_timestamp += 1; },
    "track naive timestamp": (b) => { b.tracks["9207"].timestamp = "2026-09-14T17:58:13"; b.tracks["9207"].utc_timestamp += 1; },
    "track zone": (b) => { b.tracks["9207"].timezone = "Europe/Berlin"; },
    "the ignored track is another athlete's": (b) => { b.tracks["9207"].athlete = 107; },
    "total_time": (b) => { firstOf(b, 9207).total_time += 1; },
    "total_distance": (b) => { firstOf(b, 9207).total_distance += 1; },
    "max_v": (b) => { firstOf(b, 9207).max_v += 0.1; },
    "is_stats_valid": (b) => { firstOf(b, 9207).is_stats_valid = false; },
    "drill total_distance": (b) => { firstOf(b, 9207, 0).total_distance += 1; },
    "drill /more/ events": (b) => { b.more[String(firstOf(b, 9207, 0).id)].events.acceleration_events_count = "99"; },
    "a drill row only on one track": (b) => { b.athleteSessions = b.athleteSessions.filter((r) => r !== firstOf(b, 9207, 0)); },
    "a second whole row on one track": (b) => { b.athleteSessions.push({ ...firstOf(b, 9207), id: 999999 }); b.more["999999"] = structuredClone(b.more[String(firstOf(b, 9207).id)]); b.more["999999"].athletesession_id = 999999; },
    "/more/ events": (b) => { b.more[String(firstOf(b, 9207).id)].events.acceleration_events_count = "99"; },
    "/more/ zones": (b) => { b.more[String(firstOf(b, 9207).id)].complementary_data.power[0].distance += 1; },
    "/more/ missing": (b) => { delete b.more[String(firstOf(b, 9207).id)]; },
    "a track not fetched": (b) => { delete b.tracks["9207"]; },
  };
  for (const [name, tweak] of Object.entries(cases)) {
    const bundle = bundleWithDuplicate({ tweak });
    const athleteRows = rowsOf(bundle, 106);
    assert.equal(identicalTracks(bundle, athleteRows, [...new Set(athleteRows.map((r) => String(r.track)))]), null, name);
    const plan = buildGpexeImportPlan(bundle, { metricSpecs: oracle });
    assert.deepEqual(plan.anomalies.filter((a) => a.gpexeAthleteId === "106").map((a) => a.kind), ["multiple_tracks"], name);
    assert.equal(plan.participants.some((x) => x.gpexeAthleteId === "106"), false, name);
  }
});

test("4. E1 (decided 2026-11-12): the deduplicated athlete's burst and brake are imported exactly as the details give them - once, not doubled, nothing left out", () => {
  const rows = ["gpexe_total_distance", "gpexe_burst_events", "gpexe_brake_events"].map((key, i) => activationRowFor(key, {}, i));
  const { specs } = mappedMetricSpecs(rows);
  const bundle = bundleWithDuplicate();
  // Distinct details for 106, so the assertion proves they are read for 106 itself (not copied from 102), once.
  for (const level of Object.keys(bundle.details ?? {})) {
    const players = bundle.details[level]?.players;
    if (players?.["102"]) players["106"] = { tot_burst_events: { unit: "number", value: 17 }, tot_brake_events: { unit: "number", value: 9 } };
  }
  const plan = buildGpexeImportPlan(bundle, { metricSpecs: specs });
  const valuesOf = (athlete, level = "full") => Object.fromEntries(plan.participants.find((x) => x.gpexeAthleteId === athlete).results.find((r) => r.level === level).values.map((v) => [v.variableKey, v.value]));
  const v106 = valuesOf("106");
  assert.deepEqual(Object.keys(v106).sort(), ["brake_events", "burst_events", "total_distance"]);
  assert.equal(Number(v106.burst_events), 17);
  assert.equal(Number(v106.brake_events), 9);
  assert.deepEqual(Object.keys(valuesOf("102")).sort(), ["brake_events", "burst_events", "total_distance"]);
  assert.equal(plan.leftOut.filter((r) => r.gpexeAthleteId === "106").length, 0, "nothing of the deduplicated athlete is left out");
  const required = mappedMetricSpecs(rows.map((r) => ({ ...r, requirement: "required" }))).specs;
  assert.deepEqual(classifyMappedPlan(buildGpexeImportPlan(bundle, { metricSpecs: required }), { importableIds: ["101", "102", "106"], activationCount: rows.length }), { block: null });
});

test("5. a session without a duplicate gives a plan with no duplicateTracks anywhere, and a differing pair stays multiple_tracks as the fixture always had it", () => {
  const plan = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes() }), { metricSpecs: oracle });
  assert.equal(JSON.stringify(plan).includes("duplicateTracks"), false);
  assert.deepEqual(plan.anomalies.map((a) => [a.kind, a.gpexeAthleteId]), [["multiple_tracks", "103"]]);
});
