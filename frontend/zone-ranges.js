// The range a numbered GPEXE zone is EXPECTED to cover, from the team zone limits of a stored session (the
// Rukovodilac's order of 2026-11-18: no one should have to open GPEXE to know what "zone 4" is). Never shown as a fact:
// the details' zone numbering is not proven (docs/ai/gpexe-details-coverage-plan.md), so every text says "expected" and
// points to Compare with GPEXE.
//
// Expected numbering, from one: with ascending limits t1 < … < tk, zone 1 is below t1, zone n (2..k) is t(n-1) to t(n),
// and zone k+1 is t(k) and above. GPEXE's own example: power limits 20 · 25 · 60 · 75 W/kg make zone 4 60–75 W/kg.
const NAME = /^athletesession(power|speed)zone_(distance|time|events)_([0-9]{1,2})$/;
const UNIT = { power: "W/kg", speed: "m/s" };

// A numbered zone from a GPEXE name or a source key (details.players.<name>); null for anything else, a relative speed
// zone included (its limits are per athlete, not the team's).
export function numberedZoneOf(nameOrKey) {
  const name = String(nameOrKey || "").slice(String(nameOrKey || "").lastIndexOf(".") + 1);
  const m = NAME.exec(name);
  return m ? { family: m[1], measure: m[2], number: Number(m[3]) } : null;
}

const fmt = (n) => String(Math.round(n * 100) / 100);

// "60–75 W/kg", "below 20 W/kg", "75 W/kg and above", or null when the limits do not reach that zone or are not the
// team's single set (limits that differ between teams, or none read).
export function expectedRange(zone, thresholds) {
  if (!zone || !thresholds) return null;
  const set = thresholds[zone.family];
  const list = Array.isArray(set) ? set : Array.isArray(set?.values) ? set.values : null;
  if (!list || list.length === 0 || !list.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const t = [...list].sort((a, b) => a - b);
  const unit = UNIT[zone.family];
  const n = zone.number;
  if (n < 1 || n > t.length + 1) return null;
  if (n === 1) return `below ${fmt(t[0])} ${unit}`;
  if (n === t.length + 1) return `${fmt(t[t.length - 1])} ${unit} and above`;
  return `${fmt(t[n - 2])}–${fmt(t[n - 1])} ${unit}`;
}

// The short text beside a zone: "expected 60–75 W/kg, confirm with Compare with GPEXE".
export function expectedRangeText(nameOrKey, thresholds) {
  const range = expectedRange(numberedZoneOf(nameOrKey), thresholds);
  return range ? `expected ${range}, confirm with Compare with GPEXE` : null;
}
