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
