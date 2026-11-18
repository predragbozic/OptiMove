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
  if (n === 1) return `0–${fmt(t[0])} ${unit}`;
  if (n === t.length + 1) return `${fmt(t[t.length - 1])} ${unit} and above`;
  return `${fmt(t[n - 2])}–${fmt(t[n - 1])} ${unit}`;
}

// A zone's range from a GPEXE name or a source key, or null.
export function zoneRangeText(nameOrKey, thresholds) {
  return zoneRange(numberedZoneOf(nameOrKey), thresholds);
}
