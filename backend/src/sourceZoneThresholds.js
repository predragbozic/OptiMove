// The team zone limits of a stored GPEXE session (the Rukovodilac's order of 2026-11-18: show a numbered zone's range
// so no one has to open GPEXE to know what "zone 4" is). The limits are the team threshold set the check read for that
// session, valid on its day (GET team/:id/thresholds/?valid_on=<session day>; the mapper checks the validity window), as
// the candidate's raw bundle keeps it. Read only; never a value of its own. Which range a numbered zone covers is shown
// as a fact on owner-stated evidence (GPEXE's own team settings screen, docs/ai/gpexe-field-inventory-plan.md 8.13: zones
// from 1, zone 1 from 0, each to the next limit); it is not a machine proof, and Compare with GPEXE stays the check before
// a zone field is used. No screen says "expected".
const numberList = (v) => (Array.isArray(v) && v.length > 0 && v.length <= 12 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? v : null);

// v80 step A (the Rukovodilac's order of 2026-11-19): the team's acceleration and deceleration event settings of the
// same set - the threshold (m/s2) and the duration (s) GPEXE counts an event with - shown as a fact beside an event column,
// as the zone limits are beside a zone column. Read only; whether a GPEXE details count was computed with them is the
// owner-run comparison of the v80 plan (docs/ai/v80-condition-match-plan.md, section 1), not this read.
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function eventSetting(t, prefix) {
  const value = finite(t[`${prefix}_events_threshold`]);
  const duration = finite(t[`${prefix}_events_duration`]);
  return value !== null && duration !== null && duration >= 0 ? { value, duration } : null;
}
const EVENT_KINDS = ["acceleration", "deceleration"];

// { power: [..] | null, speed: [..] | null, acceleration: {value, duration} | null, deceleration: .. } from a raw
// bundle; null when the bundle holds none of them.
export function bundleZoneThresholds(rawBundle) {
  const t = rawBundle && typeof rawBundle === "object" ? rawBundle.teamThresholds : null;
  if (!t || typeof t !== "object") return null;
  const out = { power: numberList(t.power_thresholds), speed: numberList(t.speed_thresholds) };
  for (const kind of EVENT_KINDS) out[kind] = eventSetting(t, kind);
  return out.power || out.speed || out.acceleration || out.deceleration ? out : null;
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
  // The event settings the same way: one setting when every team carries the same, { differ: true } otherwise.
  for (const kind of EVENT_KINDS) {
    const sets = rows.map((r) => (r[kind] && typeof r[kind] === "object" ? eventSetting(r[kind], kind) : null)).filter(Boolean)
      .map((v) => JSON.stringify(v));
    const distinct = [...new Set(sets)];
    out[kind] = distinct.length === 0 ? null : distinct.length === 1 && sets.length === rows.length ? JSON.parse(distinct[0]) : { differ: true };
  }
  const dates = rows.map((r) => r.session_started_at).filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
  out.asOf = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null;
  return out;
}
