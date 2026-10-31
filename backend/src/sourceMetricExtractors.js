// The extractor registry (phase 7f, contract J12,
// docs/ai/phase7f-extractor-registry-contract.md). For every seeded source
// field, the one function that reads that field's value for one athlete from
// a stored GPEXE bundle, with a mapping version's source parameters. Pure: no
// database, no network, no file access.
//
// - Keyed by "<source_system>/<api_family>/<source_metric_key>": exactly the
//   ten gpexe / rest_v1 fields of v34 and v42. A field without an entry is
//   source_metric_unsupported; the e03 / api family has none.
// - extract() returns the value in the field's SOURCE unit, as the bundle
//   stores it (seconds, metres, m/s, counts): the version's conversion does the
//   rest (D6, D8). It never converts.
// - Its skips are today's codes of gpexeImportMapper.js, unchanged (F's table):
//   the same checks in the same order, with the version's bounds and
//   thresholds instead of hard-coded ones.
// - Every bound and threshold is compared as an exact decimal (R2): 25 equals
//   25.0, 2.5 equals "2.50", and 2.5 never equals 2.4999999. Nothing here is a
//   binary floating-point comparison.

export class ExtractorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Exact decimals
// ---------------------------------------------------------------------------
const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;
const EXPONENT_TEXT = /^(-?)([0-9]+)(?:\.([0-9]+))?e([+-]?[0-9]+)$/i;

// The decimal text of a JSON value: a finite number (its shortest round-trip
// form, with any exponent written out) or a plain decimal string; else null.
function decimalTextOf(raw) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const text = String(raw);
    const exp = EXPONENT_TEXT.exec(text);
    if (!exp) return text;
    const [, sign, intDigits, fracDigits = "", power] = exp;
    const digits = intDigits + fracDigits;
    const point = intDigits.length + Number(power);
    if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
    if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (typeof raw === "string" && NUMERIC_TEXT.test(raw)) return raw;
  return null;
}

// The one canonical text of a decimal (no leading or trailing zeros, no
// trailing point, no negative zero), or null for anything that is not one.
export function canonicalDecimal(raw) {
  const text = decimalTextOf(raw);
  if (text === null) return null;
  const negative = text.startsWith("-");
  let [intPart, fracPart = ""] = (negative ? text.slice(1) : text).split(".");
  intPart = intPart.replace(/^0+(?=[0-9])/, "");
  fracPart = fracPart.replace(/0+$/, "");
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative && body !== "0" ? `-${body}` : body;
}

function scaled(canonical) {
  const negative = canonical.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? canonical.slice(1) : canonical).split(".");
  const n = BigInt(intPart + fracPart);
  return { n: negative ? -n : n, s: fracPart.length };
}

// Compares two canonical decimal texts exactly: -1, 0 or 1.
export function compareDecimal(a, b) {
  const x = scaled(a);
  const y = scaled(b);
  const s = Math.max(x.s, y.s);
  const xa = x.n * 10n ** BigInt(s - x.s);
  const ya = y.n * 10n ** BigInt(s - y.s);
  return xa === ya ? 0 : xa < ya ? -1 : 1;
}

// True only when both are decimals with the same value.
export function sameDecimal(a, b) {
  const x = canonicalDecimal(a);
  return x !== null && x === canonicalDecimal(b);
}

// ---------------------------------------------------------------------------
// Today's reads (gpexeImportMapper.js), with the version's bounds
// ---------------------------------------------------------------------------
function finiteNumber(raw) {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// The distance of the ONE zone with exactly the version's extremes; lower and
// upper are canonical decimal texts (upper null: an open top). The checks and
// their order are zoneDistance's of the mapper. With pick "open_top" the zone
// is the only one whose upper extreme is null (J7's obligation for the
// .open_top key): none, or one with another lower extreme, is
// zone_boundary_missing; two are zone_boundary_ambiguous.
function zoneDistance(zones, configuredThresholds, lower, upper, pick) {
  if (!Array.isArray(configuredThresholds)) return { skip: "team_threshold_missing" };
  const configured = configuredThresholds.map(canonicalDecimal);
  if ([lower, upper].some((b) => b !== null && !configured.includes(b))) return { skip: "team_threshold_missing" };
  if (configured.some((t) => t !== null && compareDecimal(t, lower) > 0 && (upper === null || compareDecimal(t, upper) < 0))) {
    return { skip: "team_threshold_split" };
  }
  if (!Array.isArray(zones) || zones.length === 0) return { skip: "zones_missing" };
  const withExtremes = zones.filter((z) => Array.isArray(z?.extremes));
  let matching;
  if (pick === "open_top") {
    const openTop = withExtremes.filter((z) => (z.extremes[1] ?? null) === null);
    if (openTop.length > 1) return { skip: "zone_boundary_ambiguous" };
    matching = openTop.filter((z) => canonicalDecimal(z.extremes[0]) === lower);
  } else {
    matching = withExtremes.filter((z) => canonicalDecimal(z.extremes[0]) === lower
      && (upper === null ? (z.extremes[1] ?? null) === null : canonicalDecimal(z.extremes[1]) === upper));
  }
  if (matching.length > 1) return { skip: "zone_boundary_ambiguous" };
  if (matching.length === 0) return { skip: "zone_boundary_missing" };
  if (matching[0].is_ready !== true) return { skip: "zones_not_ready" };
  const distance = finiteNumber(matching[0].distance);
  return distance === null ? { skip: "zone_distance_missing" } : { value: distance };
}

function eventCount(events, prefix, thresholdValue, durationSeconds) {
  if (!events) return { skip: "events_missing" };
  if (!sameDecimal(events[`${prefix}_threshold_value`], thresholdValue)) return { skip: "threshold_mismatch" };
  if (!sameDecimal(events[`${prefix}_duration`], durationSeconds)) return { skip: "duration_mismatch" };
  const count = finiteNumber(events[`${prefix}_count`]);
  return count === null ? { skip: "count_missing" } : { value: count };
}

function detailsNumber(playerDetails, field) {
  if (!playerDetails) return { skip: "details_not_fetched" };
  const entry = playerDetails[field];
  if (!entry) return { skip: "field_missing" };
  if (entry.unit !== "number") return { skip: "unexpected_unit" };
  const value = finiteNumber(entry.value);
  return value === null ? { skip: "value_missing" } : { value };
}

// ---------------------------------------------------------------------------
// Parameter checks
// ---------------------------------------------------------------------------
const UNSUPPORTED = "parameters_unsupported";
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keysAre = (params, keys) => Object.keys(params).sort().join(",") === keys;

// Kind none: the version stores {} (v34); null is the same "no parameters".
function noParameters(params) {
  return params === null || (isPlainObject(params) && Object.keys(params).length === 0) ? null : UNSUPPORTED;
}

// A zone: {lower, operator, unit, upper}, lower a decimal, unit a text.
// shape "closed": operator between and an upper above lower; "open_top" and
// "open": operator >= and upper null.
function zoneParameters(params, shape) {
  if (!isPlainObject(params) || !keysAre(params, "lower,operator,unit,upper")) return null;
  if (typeof params.unit !== "string" || params.unit.length === 0) return null;
  const lower = canonicalDecimal(params.lower);
  if (lower === null) return null;
  if (shape === "closed") {
    if (params.operator !== "between") return null;
    const upper = canonicalDecimal(params.upper);
    if (upper === null || compareDecimal(lower, upper) >= 0) return null;
    return { lower, upper };
  }
  if (params.operator !== ">=" || params.upper !== null) return null;
  return { lower, upper: null };
}

// An event threshold: {duration_seconds, operator, threshold_value, unit},
// both numbers decimals, the duration not negative, the operator one-sided in
// the field's direction (either of the two; the registry never interprets the
// difference - GPEXE reports only the threshold it counted with).
function eventParameters(params, direction) {
  if (!isPlainObject(params) || !keysAre(params, "duration_seconds,operator,threshold_value,unit")) return null;
  if (typeof params.unit !== "string" || params.unit.length === 0) return null;
  const operators = direction === "up" ? [">=", ">"] : ["<=", "<"];
  if (!operators.includes(params.operator)) return null;
  const thresholdValue = canonicalDecimal(params.threshold_value);
  const durationSeconds = canonicalDecimal(params.duration_seconds);
  if (thresholdValue === null || durationSeconds === null || durationSeconds.startsWith("-")) return null;
  return { thresholdValue, durationSeconds };
}

// ---------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------
function entry(fields) {
  const { parse, read, ...rest } = fields;
  return Object.freeze({
    ...rest,
    checkParameters(sourceParameters) {
      return parse(sourceParameters) === null ? UNSUPPORTED : null;
    },
    extract(input, sourceParameters) {
      const parsed = parse(sourceParameters);
      if (parsed === null) throw new ExtractorError(UNSUPPORTED, "The version's source parameters do not fit this source field.");
      return read(input ?? {}, parsed);
    },
  });
}

function rowNumber(key, field) {
  return entry({
    key, valueShape: "number", parameterKind: "none", zone: null, direction: null,
    parse: (p) => (noParameters(p) === null ? {} : null),
    read: ({ row }) => {
      const value = finiteNumber(row?.[field]);
      return value === null ? { skip: `${field}_missing` } : { value };
    },
  });
}

function zoneEntry(key, list, thresholdField, zone) {
  const pick = zone === "open_top" ? "open_top" : "exact";
  return entry({
    key, valueShape: "zone_distance", parameterKind: "zone_bounds", zone, direction: null,
    parse: (p) => zoneParameters(p, zone === "closed" ? "closed" : "open"),
    read: ({ more, thresholds }, { lower, upper }) => zoneDistance(more?.complementary_data?.[list], thresholds?.[thresholdField], lower, upper, pick),
  });
}

function eventEntry(key, prefix, direction) {
  return entry({
    key, valueShape: "event_count", parameterKind: "event_threshold", zone: null, direction,
    parse: (p) => eventParameters(p, direction),
    read: ({ more }, { thresholdValue, durationSeconds }) => eventCount(more?.events, prefix, thresholdValue, durationSeconds),
  });
}

function detailsEntry(key, field) {
  return entry({
    key, valueShape: "unit_value_object", parameterKind: "none", zone: null, direction: null,
    parse: (p) => (noParameters(p) === null ? {} : null),
    read: ({ playerDetails }) => detailsNumber(playerDetails, field),
  });
}

const GPEXE_REST_V1 = "gpexe/rest_v1/";

export const EXTRACTORS = Object.freeze(Object.assign(Object.create(null), Object.fromEntries([
  rowNumber("athlete_session.total_time", "total_time"),
  rowNumber("athlete_session.total_distance", "total_distance"),
  rowNumber("athlete_session.max_v", "max_v"),
  zoneEntry("more.complementary_data.power.distance", "power", "power_thresholds", "closed"),
  zoneEntry("more.complementary_data.power.distance.open_top", "power", "power_thresholds", "open_top"),
  zoneEntry("more.complementary_data.speed.distance", "speed", "speed_thresholds", "open"),
  eventEntry("more.events.acceleration_events_count", "acceleration_events", "up"),
  eventEntry("more.events.deceleration_events_count", "deceleration_events", "down"),
  detailsEntry("details.players.tot_burst_events", "tot_burst_events"),
  detailsEntry("details.players.tot_brake_events", "tot_brake_events"),
].map((e) => [`${GPEXE_REST_V1}${e.key}`, e]))));

// Test seam (never set by the application). The suites written before phase
// 7f build their mappings on synthetic fields whose key has the form
// "<suite>.test.<id>"; a suite may let such a key, and only such a key, be
// answered by its own entry. A seeded key can never reach the fallback, and an
// architecture test proves that no module of backend/src sets it.
const SYNTHETIC_TEST_KEY = /^[a-z0-9]+\.test\.[a-z0-9_.]+$/;
let testFallback = null;
export function setExtractorFallbackForTests(fn) { testFallback = fn ?? null; }

// The entry of a source field, or null (source_metric_unsupported).
export function extractorFor({ sourceSystem, apiFamily, sourceMetricKey } = {}) {
  if (typeof sourceSystem !== "string" || typeof apiFamily !== "string" || typeof sourceMetricKey !== "string") return null;
  const key = `${sourceSystem}/${apiFamily}/${sourceMetricKey}`;
  if (Object.hasOwn(EXTRACTORS, key)) return EXTRACTORS[key];
  return testFallback && SYNTHETIC_TEST_KEY.test(sourceMetricKey) ? testFallback({ sourceSystem, apiFamily, sourceMetricKey }) ?? null : null;
}

// Whether a mapping version may read this field with these parameters (J12
// section 3): null, "source_metric_unsupported" (no entry, or the version's
// source revision has another value shape or parameter kind than the entry
// reads - a later revision may change them) or "parameters_unsupported" (the
// entry refuses the parameters). A test entry that declares no shape (null)
// accepts every revision.
export function extractabilityCode({ sourceSystem, apiFamily, sourceMetricKey, valueShape, parameterKind, sourceParameters }) {
  const extractor = extractorFor({ sourceSystem, apiFamily, sourceMetricKey });
  if (!extractor) return "source_metric_unsupported";
  if (extractor.valueShape !== null && (extractor.valueShape !== valueShape || extractor.parameterKind !== parameterKind)) {
    return "source_metric_unsupported";
  }
  return extractor.checkParameters(sourceParameters);
}
