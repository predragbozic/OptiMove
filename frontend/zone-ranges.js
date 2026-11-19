// The range a numbered GPEXE zone covers, from the team zone limits of a stored session (the Rukovodilac's order of
// 2026-11-18: no one should have to open GPEXE to know what "zone 4" is).
//
// Numbering, from one, as GPEXE's own team settings show it (the owner's screenshot of 2026-11-18, recorded in
// docs/ai/gpexe-field-inventory-plan.md 8.13 as owner-stated evidence, not a machine proof): zone 1 starts at 0, each zone
// runs from its limit to the next, and the top zone is the last limit and above. With power limits 20 · 25 · 60 · 75
// W/kg: Z1 0–20, Z2 20–25, Z3 25–60, Z4 60–75, Z5 75 and above. Compare with GPEXE stays the check before a zone
// field is used.
const NAME = /^athletesession(power|speed)zone_(distance|time|events)_([0-9]{1,2})$/;
// The unit GPEXE's own settings screen shows, and the factor from the stored limits: speed is stored in m/s and shown by
// GPEXE in km/h (the owner's second screenshot: 0, 19.8, 25.2 km/h = the stored 5.5 and 7 m/s).
const UNIT = { power: "W/kg", speed: "km/h" };
const FACTOR = { power: 1, speed: 3.6 };

// A numbered zone from a GPEXE name or a source key (details.players.<name>); null for anything else, a relative speed
// zone included (its limits are per athlete, not the team's).
export function numberedZoneOf(nameOrKey) {
  const name = String(nameOrKey || "").slice(String(nameOrKey || "").lastIndexOf(".") + 1);
  const m = NAME.exec(name);
  return m ? { family: m[1], measure: m[2], number: Number(m[3]) } : null;
}

const fmt = (n) => String(Math.round(n * 100) / 100);

// "60–75 W/kg", "0–20 W/kg", "75 W/kg and above", or null when the limits do not reach that zone or are not the team's
// single set (limits that differ between teams, or none read).
export function zoneRange(zone, thresholds) {
  if (!zone || !thresholds) return null;
  const set = thresholds[zone.family];
  const list = Array.isArray(set) ? set : Array.isArray(set?.values) ? set.values : null;
  if (!list || list.length === 0 || !list.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const t = [...list].sort((a, b) => a - b).map((x) => x * (FACTOR[zone.family] ?? 1));
  const unit = UNIT[zone.family];
  const n = zone.number;
  if (n < 1 || n > t.length + 1) return null;
  // A zone of no width (two equal limits, or a first limit of 0) has no range to show.
  if (n === 1) return t[0] > 0 ? `0–${fmt(t[0])} ${unit}` : null;
  if (n <= t.length && !(t[n - 1] > t[n - 2])) return null;
  if (n === t.length + 1) return `${fmt(t[t.length - 1])} ${unit} and above`;
  return `${fmt(t[n - 2])}–${fmt(t[n - 1])} ${unit}`;
}

// A zone's range from a GPEXE name or a source key, or null.
export function zoneRangeText(nameOrKey, thresholds) {
  return zoneRange(numberedZoneOf(nameOrKey), thresholds);
}

// v80 step A (the Rukovodilac's order of 2026-11-19): the team's acceleration or deceleration event setting beside an
// event column, as a zone column's range is beside it. GPEXE names such a column acceleration_events or
// deceleration_events (a details.players.<name> value); the setting is the team's (threshold in m/s2, duration in s) of the
// same set as the zone limits. A fact about the team's setting in GPEXE, not a proof that GPEXE counted the column with it
// (the owner-run comparison of docs/ai/v80-condition-match-plan.md, section 1).
const EVENT_NAME = /^(acceleration|deceleration)_events$/;
export function eventKindOf(nameOrKey) {
  const name = String(nameOrKey || "").slice(String(nameOrKey || "").lastIndexOf(".") + 1);
  const m = EVENT_NAME.exec(name);
  return m ? m[1] : null;
}
const shownUnit = (unit) => (unit === "m/s2" ? "m/s²" : unit);
const numberText = (n) => String(n);

// "Events above 2.5 m/s² lasting 0.3 s", "Events below -2.5 m/s² lasting 0.3 s", or null when the set carries no single
// setting for that kind (none read, or settings that differ between teams).
export function eventSettingText(nameOrKey, thresholds) {
  const kind = eventKindOf(nameOrKey);
  const set = kind && thresholds ? thresholds[kind] : null;
  if (!set || set.differ || typeof set.value !== "number" || typeof set.duration !== "number") return null;
  return `Events ${kind === "acceleration" ? "above" : "below"} ${numberText(set.value)} ${shownUnit("m/s2")} lasting ${numberText(set.duration)} s`;
}

// The line under a column of the board: "Zone 25–60 W/kg" or "Events above 2.5 m/s² lasting 0.3 s", or null.
export function columnSettingText(key, thresholds) {
  const zone = zoneRangeText(key, thresholds);
  return zone ? `Zone ${zone}` : eventSettingText(key, thresholds);
}

// What a variable with a condition counts, in plain words: "Counts only events at or above 2.5 m/s² lasting at least
// 0.3 s." (the board's shape of v42's three conditions; any other shape a general sentence).
const OPERATOR_WORDS = { ">=": "at or above", ">": "above", "<=": "at or below", "<": "below" };
export function conditionSentence(condition) {
  const c = condition || {};
  if (c.kind === "zone" && c.operator === "between") return `Counts only the zone ${c.lower}–${c.upper} ${shownUnit(c.unit)}.`;
  if (c.kind === "zone" && OPERATOR_WORDS[c.operator]) return `Counts only the zone ${OPERATOR_WORDS[c.operator]} ${c.value} ${shownUnit(c.unit)}.`;
  if (c.kind === "event_threshold" && OPERATOR_WORDS[c.operator]) {
    return `Counts only events ${OPERATOR_WORDS[c.operator]} ${c.value} ${shownUnit(c.unit)} lasting at least ${c.durationSeconds} s.`;
  }
  return "Counts only values under a condition.";
}
