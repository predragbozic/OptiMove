// Phase 7e test fixtures: a GPEXE bundle in the form the rest_v1 binding path
// stores it (gpexeRestV1Adapter.js: BUNDLE_FIELDS, projectMore,
// projectStoredDetails), built from the synthetic bundles of
// _gpexe-fixtures.mjs. The ids are planted and distinctive (12-digit athlete
// and track ids, an 8-digit session), so a leak scan can look for them.
import { makeBundle } from "../_gpexe-fixtures.mjs";
import { BUNDLE_FIELDS, projectMore, projectStoredDetails } from "../../src/gpexeRestV1Adapter.js";

export const PLANTED = Object.freeze({ athletePrefix: "7319041170", trackPrefix: "6622104500", sessionId: 48213907 });

const pick = (o, keys) => Object.fromEntries(keys.filter((x) => Object.hasOwn(o, x)).map((x) => [x, o[x]]));

export function restV1Stored(raw) {
  return JSON.parse(JSON.stringify(projectStoredDetails({
    teamSession: pick(raw.teamSession, BUNDLE_FIELDS.teamSession),
    teamThresholds: pick(raw.teamThresholds, BUNDLE_FIELDS.teamThresholds),
    athleteSessions: raw.athleteSessions.map((r) => pick(r, BUNDLE_FIELDS.athleteSession)),
    more: Object.fromEntries(Object.entries(raw.more).map(([id, m]) => [id, projectMore(m)])),
    tracks: Object.fromEntries(Object.entries(raw.tracks).map(([id, t]) => [id, pick(t, BUNDLE_FIELDS.track)])),
    details: raw.details,
  })));
}

const BASE = Object.freeze({ time: 2400, distance: 3000, maxV: 7.5, power: [2400, 200, 300, 60, 40], sprint: 12, acc: 20, dec: 18, burst: 9, brake: 7 });
const athlete = (n, whole, drills = []) => ({
  id: Number(`${PLANTED.athletePrefix}${String(n).padStart(2, "0")}`),
  tracks: [Number(`${PLANTED.trackPrefix}${String(n).padStart(2, "0")}`)],
  parts: [{ drill: null, ...BASE, ...whole }, ...drills.map((d) => ({ ...BASE, ...whole, ...d }))],
});

// Three athletes the import keeps (athlete 1 with two drills, 2 and 3 with one
// each) and a fourth it leaves out (recorded on two tracks). Athlete 1's
// whole-session time and max speed and its drill times sit one unit past the
// 9th decimal, so their canonical values round at the 10th place.
export function previewAthletes() {
  return [
    athlete(1, { time: 60.00000003, maxV: 1.000000001, distance: 2800, burst: 4, brake: 3, acc: 14, dec: 11, power: [2200, 150, 250, 50, 30], sprint: 10 },
      [{ drill: 0, time: 30.00000003, distance: 1400 }, { drill: 1, time: 30.00000003, distance: 1300 }]),
    athlete(2, { time: 1200, maxV: 6.2, distance: 3100, burst: 9, brake: 7, acc: 20, dec: 18, power: [2400, 200, 300, 60, 40], sprint: 12 }, [{ drill: 0, distance: 1500 }]),
    athlete(3, { time: 1800, maxV: 8.1, distance: 3600, burst: 12, brake: 9, acc: 26, dec: 21, power: [2500, 260, 340, 80, 55], sprint: 20 }, [{ drill: 1, distance: 1700 }]),
    {
      id: Number(`${PLANTED.athletePrefix}04`),
      tracks: [Number(`${PLANTED.trackPrefix}04`), Number(`${PLANTED.trackPrefix}05`)],
      parts: [{ drill: null, track: Number(`${PLANTED.trackPrefix}04`), ...BASE }, { drill: null, track: Number(`${PLANTED.trackPrefix}05`), ...BASE }],
    },
  ];
}

export function previewBundle({ gpexeTeamId, athletes = previewAthletes(), ...rest } = {}) {
  return restV1Stored(makeBundle({ sessionId: PLANTED.sessionId, gpexeTeamId, athletes, detailsDrills: [0, 1], ...rest }));
}
