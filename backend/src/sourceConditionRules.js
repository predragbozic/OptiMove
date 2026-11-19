// v80 (docs/ai/v80-condition-match-plan.md, step B): which team setting of GPEXE gives a column without parameters its
// range, that range from a session's team threshold set, and whether it equals a variable's condition.
//
// A column without parameters (a GPEXE details value) has no range of its own: a numbered zone column counts within the
// team's zone limits, an event column with the team's event setting. The rule names which; the range is read from the
// team threshold set of the session (raw_bundle.teamThresholds, read "valid on the session day"); the match compares it
// with the variable's stored condition exactly - no tolerance, units through unit_conversions only (the caller's
// conversion in the D5 normal form), every number as the shortest decimal of GPEXE's double. Pure: no database, no
// clock, so the importer and the board use the same words.
import { canonicalDecimal } from "./sourceMetricExtractors.js";

// The zone numbering is GPEXE's team settings screen's (docs/ai/gpexe-field-inventory-plan.md 8.13, owner-stated): zone
// 1 from 0, each zone from its limit to the next, the top zone the last limit and above.
const ZONE_NAME = /^athletesession(power|speed)zone_(?:distance|time|events)_([1-9][0-9]?)$/;
const EVENT_NAME = /^(acceleration|deceleration)_events$/;
const DETAILS = "details.players.";
// GPEXE's own units of the limits: power W/kg, speed m/s, events m/s2 and seconds.
const LIMIT_UNIT = { power: "W/kg", speed: "m/s" };
const EVENT_UNIT = "m/s2";

// The rule of a GPEXE details column, or null (no rule: such a column never fills a variable with a condition).
export function conditionRuleFor(sourceMetricKey) {
  const key = String(sourceMetricKey || "");
  if (!key.startsWith(DETAILS)) return null;
  const name = key.slice(DETAILS.length);
  const zone = ZONE_NAME.exec(name);
  if (zone) return { kind: "zone", family: zone[1], zone: Number(zone[2]) };
  const event = EVENT_NAME.exec(name);
  if (event) return { kind: "event", event: event[1] };
  return null;
}

// A rule as stored (the database's condition_rule_shape_ok): canonical key order.
export function storedRule(rule) {
  return rule.kind === "zone" ? { family: rule.family, kind: "zone", zone: rule.zone } : { event: rule.event, kind: "event" };
}

// A details event column needs the owner's confirmation of the setting (the v80 plan, section 1).
export const needsEventConfirmation = (rule) => rule?.kind === "event";

const decimal = (v) => (typeof v === "number" && Number.isFinite(v) ? canonicalDecimal(v) : null);
const limitsOf = (list) => (Array.isArray(list) && list.length > 0 && list.length <= 12 && list.every((x) => typeof x === "number" && Number.isFinite(x))
  ? [...list].sort((a, b) => a - b) : null);

// The column's range in GPEXE's units, in the stored condition's shape: {operator, min, max, unit} for a closed zone,
// {operator: ">=", value, unit} for the top zone, {operator, value, duration_seconds, unit} for an event; null when the
// set does not carry it (no limits, a zone past the last limit or of no width, no event setting). The threshold set's id
// with it (null without one).
export function sourceRangeOf(rule, teamThresholds) {
  const t = teamThresholds && typeof teamThresholds === "object" ? teamThresholds : null;
  if (!rule || !t) return null;
  const setId = t.id === null || t.id === undefined ? null : String(t.id);
  if (rule.kind === "zone") {
    const limits = limitsOf(t[`${rule.family}_thresholds`]);
    if (!limits) return null;
    const n = rule.zone;
    const unit = LIMIT_UNIT[rule.family];
    if (n < 1 || n > limits.length + 1) return null;
    if (n === limits.length + 1) return { range: { operator: ">=", unit, value: decimal(limits[limits.length - 1]) }, setId };
    const lower = n === 1 ? 0 : limits[n - 2];
    const upper = limits[n - 1];
    if (!(upper > lower)) return null;
    return { range: { max: decimal(upper), min: decimal(lower), operator: "between", unit }, setId };
  }
  if (rule.kind === "event") {
    const value = t[`${rule.event}_events_threshold`];
    const duration = t[`${rule.event}_events_duration`];
    if (typeof value !== "number" || !Number.isFinite(value) || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
    return { range: { duration_seconds: decimal(duration), operator: rule.event === "acceleration" ? ">=" : "<=", unit: EVENT_UNIT, value: decimal(value) }, setId };
  }
  return null;
}

// Exact decimal arithmetic for the comparison (no float).
function dec(text) {
  const t = canonicalDecimal(text);
  if (t === null) return null;
  const negative = t.startsWith("-");
  const [i, f = ""] = (negative ? t.slice(1) : t).split(".");
  const n = BigInt(i + f);
  return { n: negative ? -n : n, s: f.length };
}
const pow10 = (k) => 10n ** BigInt(k);
const align = (a, b) => { const s = Math.max(a.s, b.s); return [a.n * pow10(s - a.s), b.n * pow10(s - b.s)]; };
const mul = (a, b) => ({ n: a.n * b.n, s: a.s + b.s });
const add = (a, b) => { const s = Math.max(a.s, b.s); const [x, y] = align(a, b); return { n: x + y, s }; };
const same = (a, b) => { const [x, y] = align(a, b); return x === y; };

// canonical == source x scale / divisor + offset, by multiplication only: canonical x divisor == source x scale + offset x divisor.
function equivalent(canonicalText, sourceText, f) {
  const c = dec(String(canonicalText));
  const s = dec(String(sourceText));
  if (!c || !s) return false;
  const scale = dec(f.scale);
  const divisor = dec(f.divisor);
  const offset = dec(f.offset);
  return same(mul(c, divisor), add(mul(s, scale), mul(offset, divisor)));
}

const IDENTITY = Object.freeze({ scale: "1", divisor: "1", offset: "0" });
const keysOf = (o) => Object.keys(o || {}).sort().join(",");

// Whether a variable's stored condition (condition_description) equals the column's range. `conversion` is the active
// unit conversion from the range's unit to the condition's (D5 normal form {scale, divisor, offset}), or null when the
// units are equal; another unit with no conversion never matches. The duration (seconds) is compared as it is.
export function conditionMatches(condition, range, conversion = null) {
  const cd = condition && typeof condition === "object" ? condition : null;
  if (!cd || !range || typeof cd.unit !== "string") return false;
  if (cd.unit !== range.unit && !conversion) return false;
  const f = cd.unit === range.unit ? IDENTITY : conversion;
  if (cd.operator !== range.operator) return false;
  if (range.operator === "between") {
    return keysOf(cd) === "max,min,operator,unit" && equivalent(cd.min, range.min, f) && equivalent(cd.max, range.max, f);
  }
  if ("duration_seconds" in range) {
    return keysOf(cd) === "duration_seconds,operator,unit,value" && equivalent(cd.value, range.value, f)
      && same(dec(String(cd.duration_seconds)) ?? { n: -1n, s: 0 }, dec(range.duration_seconds) ?? { n: -2n, s: 0 });
  }
  return keysOf(cd) === "operator,unit,value" && equivalent(cd.value, range.value, f);
}

// Whether two stored source ranges are the same (the importer's check of a session against an activation's match):
// the same keys and every value equal as exact decimals.
export function sameSourceRange(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || keysOf(a) !== keysOf(b)) return false;
  for (const k of Object.keys(a)) {
    if (k === "operator" || k === "unit") { if (a[k] !== b[k]) return false; continue; }
    const x = dec(String(a[k]));
    const y = dec(String(b[k]));
    if (!x || !y || !same(x, y)) return false;
  }
  return true;
}

// The range in plain words for a sentence (GPEXE's own units; speed shown in m/s as stored): "events at or above 2.5 m/s²
// lasting 0.3 s", "the zone 25–60 W/kg", "the zone 75 W/kg and above".
export function rangeWords(range) {
  if (!range) return "no setting";
  const unit = range.unit === "m/s2" ? "m/s²" : range.unit;
  if (range.operator === "between") return `the zone ${range.min}–${range.max} ${unit}`;
  if ("duration_seconds" in range) return `events ${range.operator === ">=" ? "at or above" : "at or below"} ${range.value} ${unit} lasting ${range.duration_seconds} s`;
  return `the zone ${range.value} ${unit} and above`;
}
