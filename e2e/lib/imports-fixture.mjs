// The GPEXE sessions the e2e fake source serves for the Imports scenario (invented data, the backend tests' bundle
// builder). GPEXE athletes 101..103 are linked by the scenario; 121 stays unlinked until the coach links it from the row.
import { makeBundle, standardAthletes } from "../../backend/tests/_gpexe-fixtures.mjs";

export const SESSION_READY = 9101; // 101, 102, 103: everyone linked - importable as it is
export const SESSION_NEEDS_LINK = 9102; // 101, 102 and 121: 121 has no link yet

const proto = standardAthletes()[0];
function athlete(id, sessionId) {
  const a = structuredClone(proto);
  a.id = id;
  a.tracks = [sessionId * 100 + (id % 100)];
  for (const p of a.parts) delete p.track;
  return a;
}

export function importsBundles(sourceTeam = 7001) {
  const mk = (sessionId, day, ids) => makeBundle({
    sessionId, gpexeTeamId: Number(sourceTeam), start: `${day}T09:08:12`, updatedOn: `${day}T11:18:09.337`,
    category: "FULL TRAINING", athletes: ids.map((id) => athlete(id, sessionId)), detailsDrills: [0, 1],
  });
  return [mk(SESSION_READY, "2026-11-04", [101, 102, 103]), mk(SESSION_NEEDS_LINK, "2026-11-05", [101, 102, 121])];
}

// G1b-1: the Imports sessions with one more per-athlete number and one more details value, names no source field covers,
// so Source fields offers "Create field" on them (the source fields scenario only; the importer keeps neither).
export function inventoryBundles(sourceTeam = 7001) {
  return importsBundles(sourceTeam).map((bundle) => {
    bundle.athleteSessions.forEach((row, i) => { row.e2e_hsr_distance = 100 + i; });
    for (const part of [bundle.details.full, ...Object.values(bundle.details.drills)]) {
      Object.values(part.players).forEach((values, i) => {
        values.e2e_metabolic_power = { unit: "power", value: 12.5 };
        // G1b-2: two names whose values differ by athlete, so the platform can compare two of them with the GPEXE screen.
        values.e2e_metabolic_energy = { unit: "energy", value: 410.5 + 20 * i };
        values.e2e_work_energy = { unit: "energy_std", value: 1200 + 75 * i };
        // The readable list (2026-11-18): zone names, and names that are not values (a reference, a flag).
        values.athletesessionpowerzone_distance_4 = { unit: "distance", value: 310 + i };
        values.athletesessionrelativespeedzone_distance_3 = { unit: "distance", value: 120 + i };
        values.athlete_session_id = 5000 + i;
        values.are_values_visible = true;
      });
    }
    return bundle;
  });
}

// v80 step C: the inventory sessions with a GPEXE details acceleration events count (different per athlete, so it can be
// compared), under the team's default events setting (2.5 m/s² lasting 0.3 s).
export function eventsBundles(sourceTeam = 7001) {
  return inventoryBundles(sourceTeam).map((bundle) => {
    for (const part of [bundle.details.full, ...Object.values(bundle.details.drills)]) {
      Object.values(part.players).forEach((values, i) => { values.acceleration_events = { unit: "number", value: 14 + 3 * i }; });
    }
    return bundle;
  });
}

// U6a-3: three sessions with only linked athletes (101..103), all Ready - the batch series scenario.
export const SERIES_SESSIONS = [9111, 9112, 9113];
export function seriesBundles(sourceTeam = 7001) {
  return SERIES_SESSIONS.map((sessionId, i) => makeBundle({
    sessionId, gpexeTeamId: Number(sourceTeam), start: `2026-11-0${i + 2}T09:08:12`, updatedOn: `2026-11-0${i + 2}T11:18:09.337`,
    category: "FULL TRAINING", athletes: [101, 102, 103].map((id) => athlete(id, sessionId)), detailsDrills: [0, 1],
  }));
}

// K5-4, the calendar's GPS marks: two sessions waiting on 05.11.2026 (one Ready, one that needs athlete 121 linked)
// and one on 04.11.2026 the scenario imports, so that day has nothing waiting.
export const K54_SESSIONS = { ready: 9161, needs: 9162, imported: 9163 };
export function calendarMarkBundles(sourceTeam = 7001) {
  const mk = (sessionId, start, ids) => makeBundle({
    sessionId, gpexeTeamId: Number(sourceTeam), start, updatedOn: `${start.slice(0, 10)}T20:18:09.337`,
    category: "FULL TRAINING", athletes: ids.map((id) => athlete(id, sessionId)), detailsDrills: [0, 1],
  });
  return [
    mk(K54_SESSIONS.ready, "2026-11-05T09:08:12", [101, 102, 103]),
    mk(K54_SESSIONS.needs, "2026-11-05T17:08:12", [101, 102, 121]),
    mk(K54_SESSIONS.imported, "2026-11-04T09:08:12", [101, 102, 103]),
  ];
}

// J18, the board: one Ready session whose three linked athletes have different values, so the board finds two
// athletes it can tell apart (the Imports scenario's athletes are copies of one).
export const SESSION_BOARD = 9121;
export function boardBundles(sourceTeam = 7001) {
  const athletes = standardAthletes().map((a) => {
    for (const p of a.parts) delete p.track;
    return { ...a, tracks: [SESSION_BOARD * 100 + (a.id % 100)] };
  });
  return [makeBundle({
    sessionId: SESSION_BOARD, gpexeTeamId: Number(sourceTeam), start: "2026-11-04T09:08:12", updatedOn: "2026-11-04T11:18:09.337",
    category: "FULL TRAINING", athletes, detailsDrills: [0, 1],
  })];
}

// Fix flow slice 2: one session in which GPEXE recorded athlete 103 on two tracks that differ (a real restart; the backend
// tests' standard athletes), 101 and 102 on one track each. The session needs a look until a recording is chosen.
export const SESSION_MULTI_TRACK = 9131;
export function multiTrackBundles(sourceTeam = 7001) {
  const athletes = standardAthletes().map((a) => structuredClone(a));
  athletes[0].tracks = [SESSION_MULTI_TRACK * 10 + 1];
  athletes[1].tracks = [SESSION_MULTI_TRACK * 10 + 2];
  for (const a of athletes.slice(0, 2)) for (const part of a.parts) delete part.track;
  return [makeBundle({
    sessionId: SESSION_MULTI_TRACK, gpexeTeamId: Number(sourceTeam), start: "2026-11-04T09:08:12", updatedOn: "2026-11-04T11:18:09.337",
    category: "FULL TRAINING", athletes, detailsDrills: [0, 1],
  })];
}

// PR #587: one session whose GPS units report two time zones (athlete 101's track in Europe/Stockholm, the others in the
// fixtures' own zone): it stays out of the import (mixed_timezones) until the team has a session time zone.
export const SESSION_MIXED_TZ = 9141;
export function mixedTimezoneBundles(sourceTeam = 7001) {
  const bundle = makeBundle({
    sessionId: SESSION_MIXED_TZ, gpexeTeamId: Number(sourceTeam), start: "2026-11-04T09:08:12", updatedOn: "2026-11-04T11:18:09.337",
    category: "FULL TRAINING", athletes: [101, 102, 103].map((id) => athlete(id, SESSION_MIXED_TZ)), detailsDrills: [0, 1],
  });
  const first = Object.keys(bundle.tracks).sort()[0];
  bundle.tracks[first].timezone = bundle.tracks[first].timezone === "Europe/Stockholm" ? "Europe/Sarajevo" : "Europe/Stockholm";
  return [bundle];
}
