// The team zone limits of a stored GPEXE session (the Rukovodilac's order of 2026-11-18: show a numbered zone's range
// so no one has to open GPEXE to know what "zone 4" is). The limits are the team threshold set the check read for that
// session, valid on its day (GET team/:id/thresholds/?valid_on=<session day>; the mapper checks the validity window), as
// the candidate's raw bundle keeps it. Read only; never a value of its own. Which range a numbered zone covers is
// EXPECTED, not proven (docs/ai/gpexe-details-coverage-plan.md: the details' zones are not reproduced by /more/'s), so
// every screen prints it as expected.
const numberList = (v) => (Array.isArray(v) && v.length > 0 && v.length <= 12 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? v : null);

// { power: [..] | null, speed: [..] | null } from a raw bundle; null when the bundle holds no set at all.
export function bundleZoneThresholds(rawBundle) {
  const t = rawBundle && typeof rawBundle === "object" ? rawBundle.teamThresholds : null;
  if (!t || typeof t !== "object") return null;
  const out = { power: numberList(t.power_thresholds), speed: numberList(t.speed_thresholds) };
  return out.power || out.speed ? out : null;
}

// Across several teams' newest sessions: one set per kind when every team carries the same, { differ: true } when they
// do not, null when none carries one. asOf is the newest of those sessions' start (the list has no session in view).
export function zoneThresholdsOf(rows) {
  const out = {};
  for (const kind of ["power", "speed"]) {
    const sets = rows.map((r) => numberList(r[kind])).filter(Boolean).map((v) => JSON.stringify(v));
    const distinct = [...new Set(sets)];
    out[kind] = distinct.length === 0 ? null : distinct.length === 1 && sets.length === rows.length ? { values: JSON.parse(distinct[0]) } : { differ: true };
  }
  const dates = rows.map((r) => r.session_started_at).filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
  out.asOf = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null;
  return out;
}
