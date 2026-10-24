// Owner-run, read-only probe: can GPEXE's grouped team-session details answer replace each athlete
// row's /more/ read without changing one imported value? (owner order 2026-10-23;
// docs/ai/gpexe-details-coverage-plan.md)
//
// A check reads `athlete_session/<id>/more/` once per athlete row - one row per athlete for the whole
// session and one per drill - and that is about 42 % of its requests. The details answer of a session
// (`rest/v1/team_session/<id>/details/`) and of one drill (`…/details/?drill=<i>`) carries many metrics
// of every athlete at once; the owner's old Google Apps Script read events and zone distances from it.
// That shows the endpoints were used, not that their values are the ones OptiMove imports. For one
// parent session, its drill 0 and two athletes, this probe compares in memory:
// - the acceleration and deceleration event counts, under the importer's own 2.5 m/s² / 0.3 s rule;
// - every power and speed zone distance of /more/ against the details key at the zone's position, and
//   the importer's power bands and speed band against the team thresholds of the day;
// - time, distance and top speed of the athlete list's rows against the details' fields, with the
//   relation and the unit word;
// - how the details' players map to the list's rows and to /more/'s row ids;
// - is_stats_valid, is_ready and missing values.
// Nothing is equal because of a field's name: a pair is equal only when both reads carry a finite
// number and the numbers are the same. A field name below is a hypothesis taken from the old script.
//
// What it sends: ONE credential exchange in the host's confirmed form, then ten GET requests for Team
// ID 980, and an eleventh only when the drill's `rest/v1` form does not answer: then the same drill in
// the `api/` form a check reads today (DETAILS_COVERAGE_MAX_REQUESTS = 12). A pause of 2 s before every
// read, no repeat, no redirect followed, a timeout per request, answers bounded at 5 MiB; the first 429
// ends the run.
// What it prints: statuses, kinds, closed words, counts and booleans. Never an id, a name, a date, a
// value, a URL, a header text, a unit text outside a closed list or a key outside a closed list; the
// players' athlete objects (names) are dropped as soon as an answer is parsed. The final guard
// refuses a report that contains the credential or the issued token. No database, nothing written.
import { pathToFileURL } from "node:url";
import { assertNoSecretInReport, describeResponse, discoveryProfile, DiscoveryUsageError } from "./gpexe-auth-discovery.mjs";
import { BUNDLE_FIELDS, readBounded, teamScopedPath } from "../src/gpexeRestV1Adapter.js";
import { redactGpexe } from "../src/gpexeClient.js";
import { GPEXE_METRIC_SPECS } from "../src/gpexeImportMapper.js";
import { dayOf, LIST_LIMIT, MAX_EXCHANGE_BYTES, maskProbePath, PROBE_HOST, PROBE_TEAM, REQUEST_TIMEOUT_MS, safeId } from "./gpexe-rest-v1-capability-probe.mjs";

// 1 exchange + list, parent, athlete list, 2 details, thresholds, 4 /more/ = 11; + the drill's api/ form only when its rest/v1 form fails.
export const DETAILS_COVERAGE_MAX_REQUESTS = 12;
export const DETAILS_COVERAGE_PAUSE_MS = 2_000;
export const DETAILS_COVERAGE_ATHLETES = 2;
export const DETAILS_COVERAGE_DRILL_INDEX = 0;
const LEVELS = Object.freeze(["whole", "drill"]);
// The drill's api/ form, exactly the read a check sends today (gpexeRestV1Adapter.js legacyDrillDetailsUrl), and nothing else under api/.
export const LEGACY_API_PREFIX = "api/";
export const LEGACY_DRILL_PATH = /^team_session\/(0|[1-9][0-9]{0,11})\/details\/\?drill=0$/;

// The importer's own rules for what it takes from /more/ and from a row, read from its metric specs,
// so the probe can never compare against a rule the importer does not apply.
export const IMPORTED_MORE_RULES = Object.freeze((() => {
  const events = [];
  const zones = [];
  for (const spec of GPEXE_METRIC_SPECS) {
    const c = spec.sourceContext ?? {};
    const ev = /^more\.events\.(acceleration|deceleration)_events_count$/.exec(c.field ?? "");
    if (ev) events.push(Object.freeze({ metric: ev[1], prefix: `${ev[1]}_events`, threshold: c.thresholdMps2, duration: c.minDurationS }));
    const zn = /^more\.complementary_data\.(power|speed)\[\]\.distance$/.exec(c.field ?? "");
    if (zn) zones.push(Object.freeze({ family: zn[1], band: Object.freeze([...c.gpexeZoneExtremes]), thresholdField: c.teamThresholdField }));
  }
  return Object.freeze({ events: Object.freeze(events), zones: Object.freeze(zones) });
})());
export const IMPORTED_ROW_SCALARS = Object.freeze(GPEXE_METRIC_SPECS
  .map((s) => /^athlete_session\.(total_time|total_distance|max_v)$/.exec(s.sourceContext?.field ?? "")?.[1]).filter(Boolean));

// The details' field names the old Google Apps Script read: hypotheses to test, never evidence.
export const DETAILS_EVENT_FIELDS = Object.freeze({ acceleration: "acceleration_events", deceleration: "deceleration_events" });
export const DETAILS_ZONE_PREFIX = Object.freeze({ power: "athletesessionpowerzone_distance_", speed: "athletesessionspeedzone_distance_" });
export const DETAILS_ROW_SCALARS = Object.freeze({ total_time: "average_time", total_distance: "total_distance", max_v: "max_values_speed" });
// A row value against a details value: the same number, or one of these fixed unit conversions.
export const SCALAR_RELATIONS = Object.freeze(["equal", "times_3_6", "divided_by_60", "divided_by_1000", "other", "missing"]);
// A unit text is printed only when it is one of these words; anything else is "<other>".
export const UNIT_WORDS = Object.freeze(["number", "n", "m", "km", "s", "min", "h", "m/s", "km/h", "m/s2", "m/s²", "W/kg", "W", "%", "bpm", "kcal"]);
// The only answer key names a request entry prints; every other key is only counted.
export const PRINTABLE_KEYS = Object.freeze([...new Set([
  ...BUNDLE_FIELDS.teamSession, "drills", ...BUNDLE_FIELDS.athleteSession, ...BUNDLE_FIELDS.more, ...BUNDLE_FIELDS.teamThresholds,
  "players", "teamsession", "drills_count", "token", "detail", "non_field_errors",
])]);
const AUTH_SCHEMES = Object.freeze(["Token", "Bearer", "Basic", "Digest"]);

class ProbeStop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
// The importer's own number rule (gpexeImportMapper.js finiteNumber), so a value counts here exactly
// when it would count there.
const finite = (raw) => {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// What a 429's Retry-After said, as a kind word and a bounded number of seconds; never the raw text.
export function retryAfterOf(value) {
  if (value === null || value === undefined || value === "") return { retryAfter: "absent", retryAfterS: null };
  const v = String(value).trim();
  if (/^[0-9]{1,9}$/.test(v)) return { retryAfter: "seconds", retryAfterS: Number(v) > 86_400 ? "over_day" : Number(v) };
  return { retryAfter: "other", retryAfterS: null };
}

// One details field of one athlete: its kind, its number (memory only) and its unit word.
export function detailsValue(player, key) {
  if (!has(player, key)) return { kind: "absent", value: null, unit: null };
  const v = player[key];
  if (typeof v === "number") return Number.isFinite(v) ? { kind: "bare_number", value: v, unit: null } : { kind: "other", value: null, unit: null };
  if (v === null) return { kind: "null", value: null, unit: null };
  if (!isPlainObject(v)) return { kind: "other", value: null, unit: null };
  const unit = !has(v, "unit") ? null : typeof v.unit === "string" && UNIT_WORDS.includes(v.unit) ? v.unit : "<other>";
  if (!has(v, "value")) return { kind: "object_without_value", value: null, unit };
  if (typeof v.value === "number" && Number.isFinite(v.value)) return { kind: "number", value: v.value, unit };
  return { kind: v.value === null ? "null_value" : "other_value", value: null, unit };
}
const numeric = (d) => d.kind === "number" || d.kind === "bare_number";
// Equal is the same number, nothing else. "withinRounding" says only whether a difference is below
// half a hundredth; it is printed for the owner and never makes a pair equal.
const pairOf = (moreValue, d) => (moreValue === null ? "missing_in_more" : !numeric(d) ? "missing_in_details" : moreValue === d.value ? "equal" : "differs");
const withinRounding = (a, b) => Math.abs(a - b) <= 0.005 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));

// A row value against a details value: which fixed relation holds, if any.
export function scalarRelation(rowValue, detailsNumber) {
  if (rowValue === null || detailsNumber === null) return "missing";
  if (rowValue === detailsNumber) return "equal";
  const close = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  if (close(rowValue * 3.6, detailsNumber)) return "times_3_6";
  if (close(rowValue / 60, detailsNumber)) return "divided_by_60";
  if (close(rowValue / 1000, detailsNumber)) return "divided_by_1000";
  return "other";
}

// The zones of one /more/ family, ascending by their lower bound; a zone whose bounds cannot be read
// keeps its place as unreadable. Bounds are numbers as they stand, as the importer compares them.
export function moreZones(more, family) {
  const list = isPlainObject(more?.complementary_data) && Array.isArray(more.complementary_data[family]) ? more.complementary_data[family] : null;
  if (!list) return null;
  const bound = (b) => (typeof b === "number" && Number.isFinite(b) ? b : null);
  return list.map((z) => {
    const ex = isPlainObject(z) && Array.isArray(z.extremes) && z.extremes.length >= 1 && z.extremes.length <= 2 ? z.extremes : null;
    const lower = ex ? bound(ex[0]) : null;
    const upper = ex ? bound(ex[1] ?? null) : null;
    const readable = ex !== null && lower !== null && ((ex[1] ?? null) === null || upper !== null);
    return { readable, lower, upper, distance: isPlainObject(z) ? finite(z.distance) : null, ready: isPlainObject(z) && z.is_ready === true };
  }).sort((a, b) => (a.lower ?? Infinity) - (b.lower ?? Infinity));
}

const thresholdList = (raw) => {
  if (!Array.isArray(raw)) return null;
  const list = raw.map(finite);
  return list.some((t) => t === null) ? null : list;
};
// The importer's guard for one band (gpexeImportMapper.js zoneDistance): both bounds are team
// thresholds, no threshold splits the band, exactly one /more/ zone has those bounds and it is ready.
export function bandStatus(zones, thresholds, [lower, upper]) {
  if (!thresholds || [lower, upper].some((b) => b !== null && !thresholds.includes(b))) return "team_threshold_missing";
  if (thresholds.some((t) => t > lower && (upper === null || t < upper))) return "team_threshold_split";
  if (!zones || zones.length === 0) return "zones_missing";
  const matching = zones.filter((z) => z.readable && z.lower === lower && z.upper === upper);
  if (matching.length > 1) return "zone_boundary_ambiguous";
  if (matching.length === 0) return "zone_boundary_missing";
  return matching[0].ready ? "ok" : "zones_not_ready";
}

// The readiness the details carry for one zone, at the zone's own level as the importer's
// `zones_not_ready` guard reads it: the zone value's own boolean `is_ready`. A flag on the player cannot
// say that one zone is not ready while others are, so it is only reported as `player`, never accepted.
export function detailsReadiness(player, key) {
  const v = isPlainObject(player) ? player[key] : undefined;
  if (isPlainObject(v) && typeof v.is_ready === "boolean") return { ready: v.is_ready, level: "zone" };
  if (isPlainObject(player) && typeof player.is_ready === "boolean") return { ready: null, level: "player" };
  return { ready: null, level: "none" };
}

// One athlete at one level: the details' events and zones against its /more/, and its list row's
// scalars against the details' fields. Nothing of either answer leaves this function but words.
export function comparePair({ more, player, row, thresholds }) {
  const out = { events: [], zones: {}, bands: [], scalars: [] };
  const events = isPlainObject(more?.events) ? more.events : null;
  for (const rule of IMPORTED_MORE_RULES.events) {
    const ruleAsImported = events !== null && events[`${rule.prefix}_threshold_value`] === rule.threshold && events[`${rule.prefix}_duration`] === rule.duration;
    const count = events ? finite(events[`${rule.prefix}_count`]) : null;
    const d = detailsValue(player, DETAILS_EVENT_FIELDS[rule.metric]);
    const status = !ruleAsImported ? "more_rule_not_as_imported" : pairOf(count, d);
    out.events.push({ metric: rule.metric, status, detailsKind: d.kind, detailsUnit: d.unit, nonZero: status === "equal" && count !== 0, withinRounding: status === "differs" ? withinRounding(count, d.value) : null });
  }
  for (const family of Object.keys(DETAILS_ZONE_PREFIX)) {
    const zones = moreZones(more, family);
    const detailsKeys = isPlainObject(player) ? Object.keys(player).filter((k) => k.startsWith(DETAILS_ZONE_PREFIX[family]) && /^\d{1,2}$/.test(k.slice(DETAILS_ZONE_PREFIX[family].length))) : [];
    const compared = (zones ?? []).map((z, position) => {
      const status = (base) => {
        if (!z.readable) return "zone_unreadable";
        if (!z.ready) return "not_ready";
        return pairOf(z.distance, detailsValue(player, `${DETAILS_ZONE_PREFIX[family]}${position + base}`));
      };
      const s0 = status(0);
      const s1 = status(1);
      const key = (base) => `${DETAILS_ZONE_PREFIX[family]}${position + base}`;
      const d0 = detailsValue(player, key(0));
      const d1 = detailsValue(player, key(1));
      const r0 = detailsReadiness(player, key(0));
      const r1 = detailsReadiness(player, key(1));
      return {
        position, base0: s0, base1: s1, nonZero: z.distance !== null && z.distance !== 0, moreReady: z.ready,
        detailsKind0: d0.kind, detailsUnit0: d0.unit, detailsReady0: r0.ready, readinessLevel0: r0.level,
        detailsKind1: d1.kind, detailsUnit1: d1.unit, detailsReady1: r1.ready, readinessLevel1: r1.level,
        withinRounding0: s0 === "differs" ? withinRounding(z.distance, d0.value) : null,
        withinRounding1: s1 === "differs" ? withinRounding(z.distance, d1.value) : null,
      };
    });
    const t = thresholdList(thresholds?.[`${family}_thresholds`]);
    const inner = zones && zones.every((z) => z.readable) ? zones.slice(1).map((z) => z.lower) : null;
    out.zones[family] = {
      moreZoneCount: zones ? zones.length : null, detailsZoneCount: detailsKeys.length, zones: compared,
      boundsFollowThresholds: inner && t ? inner.length === t.length && inner.every((b, i) => b === t[i]) : null,
    };
    for (const rule of IMPORTED_MORE_RULES.zones.filter((r) => r.family === family)) {
      out.bands.push({ family, band: rule.band.map((b) => (b === null ? "open" : String(b))).join("-"), status: bandStatus(zones, t, rule.band) });
    }
  }
  for (const field of IMPORTED_ROW_SCALARS) {
    const d = detailsValue(player, DETAILS_ROW_SCALARS[field]);
    const rowValue = finite(row?.[field]);
    out.scalars.push({ field, detailsField: DETAILS_ROW_SCALARS[field], relation: scalarRelation(rowValue, numeric(d) ? d.value : null), detailsKind: d.kind, detailsUnit: d.unit, nonZero: rowValue !== null && rowValue !== 0 });
  }
  return out;
}

const verdictOf = (verdict, reason = null) => ({ verdict, ...(reason !== null ? { reason } : {}) });
const plannedPairs = DETAILS_COVERAGE_ATHLETES * LEVELS.length;

// The events family: every compared count equal under the importer's rule, at least one not zero,
// all planned pairs, and the team's own event rule the importer applies.
export function eventsVerdict(pairs, teamRuleAsImported) {
  if (pairs.length === 0) return verdictOf("insufficient", "not_compared");
  const all = pairs.flatMap((p) => p.events);
  if (all.some((e) => e.status === "differs")) return verdictOf("differs");
  if (pairs.length < plannedPairs) return verdictOf("insufficient", "fewer_pairs_than_planned");
  if (all.some((e) => e.status !== "equal")) return verdictOf("insufficient", all.find((e) => e.status !== "equal").status);
  if (!all.some((e) => e.nonZero)) return verdictOf("insufficient", "only_zero_values");
  if (teamRuleAsImported !== true) return verdictOf("insufficient", "team_event_rule_not_as_imported");
  return verdictOf("same");
}

// A zone family: the details key number of a zone is its position in /more/'s ascending zones, from
// zero or from one. Every /more/ zone must be ready, and exactly one numbering must reproduce every
// zone of every pair, with at least one distance not zero. The importer's guards must also be possible
// without /more/: its bands pass in every pair, the zones' bounds follow the team thresholds in every
// pair (so a details zone can be placed by its number alone), and the details carry each zone's
// readiness at the zone's own level, equal to /more/'s. If both numberings meet a real difference, or
// the details call a ready zone not ready, the details do not reproduce /more/. A `same` proves the
// readiness of ready zones only: a zone /more/ calls not ready makes the family `insufficient` before
// this point, so `notReadyCaseObserved` is always false next to `same`, and the not-ready case stays
// unproven (an implementation must stay fail-closed for it).
export function zoneFamilyVerdict(pairs, family) {
  const zones = pairs.flatMap((p) => p.zones[family]?.zones ?? []);
  const usable = (base) => zones.length > 0 && zones.every((z) => z[base] === "equal");
  const differs = (base) => zones.some((z) => z[base] === "differs");
  const bases = ["base0", "base1"].filter(usable);
  const indexBase = bases.length === 1 ? (bases[0] === "base0" ? "zero" : "one") : bases.length === 2 ? "ambiguous" : "none";
  const out = (v) => ({ ...v, indexBase, notReadyCaseObserved: zones.some((z) => z.moreReady === false) });
  if (pairs.length === 0) return out(verdictOf("insufficient", "not_compared"));
  if (bases.length === 0 && differs("base0") && differs("base1")) return out(verdictOf("differs", "no_numbering_reproduces_more"));
  if (pairs.length < plannedPairs) return out(verdictOf("insufficient", "fewer_pairs_than_planned"));
  if (bases.length === 0) return out(verdictOf("insufficient", "values_missing_or_not_ready"));
  if (bases.length === 2) return out(verdictOf("insufficient", "numbering_ambiguous"));
  if (!zones.some((z) => z.nonZero)) return out(verdictOf("insufficient", "only_zero_values"));
  const bad = pairs.flatMap((p) => p.bands).find((b) => b.family === family && b.status !== "ok");
  if (bad) return out(verdictOf("insufficient", `band_${bad.status}`));
  if (pairs.some((p) => p.zones[family]?.boundsFollowThresholds !== true)) return out(verdictOf("insufficient", "bounds_not_derivable_from_thresholds"));
  const b = bases[0] === "base0" ? "0" : "1";
  if (zones.some((z) => z[`detailsReady${b}`] !== null && z[`detailsReady${b}`] !== z.moreReady)) return out(verdictOf("differs", "details_readiness_differs"));
  if (zones.some((z) => z[`readinessLevel${b}`] === "player")) return out(verdictOf("insufficient", "details_readiness_player_level_only"));
  if (zones.some((z) => z[`detailsReady${b}`] === null)) return out(verdictOf("insufficient", "details_readiness_not_carried"));
  return out(verdictOf("same"));
}

// The drill level: for each compared athlete the drill answers differ from the whole session's, in
// /more/ and in the details, so a server that ignored `?drill=` can never pass for a drill.
export function drillLevelVerdict(distinct) {
  if (distinct.length === 0) return verdictOf("insufficient", "not_compared");
  if (distinct.some((d) => d !== true)) return verdictOf("insufficient", "drill_not_distinguished");
  if (distinct.length < DETAILS_COVERAGE_ATHLETES) return verdictOf("insufficient", "fewer_athletes_than_planned");
  return verdictOf("same");
}

// The list rows' time, distance and top speed against the details' fields: `same` only when every
// pair is the same number; a pair under no fixed relation is a difference; a consistent unit
// conversion is reported and stays `insufficient`, since the importer reads the row's own unit.
export function scalarsVerdict(pairs) {
  const all = pairs.flatMap((p) => p.scalars);
  const relations = Object.fromEntries(IMPORTED_ROW_SCALARS.map((f) => [f, [...new Set(all.filter((s) => s.field === f).map((s) => s.relation))].sort()]));
  const units = Object.fromEntries(IMPORTED_ROW_SCALARS.map((f) => [f, [...new Set(all.filter((s) => s.field === f).map((s) => s.detailsUnit ?? "none"))].sort()]));
  const out = (v) => ({ ...v, relations, detailsUnits: units });
  if (pairs.length === 0) return out(verdictOf("insufficient", "not_compared"));
  if (all.some((s) => s.relation === "other")) return out(verdictOf("differs"));
  if (pairs.length < plannedPairs) return out(verdictOf("insufficient", "fewer_pairs_than_planned"));
  if (all.some((s) => s.relation === "missing")) return out(verdictOf("insufficient", "values_missing"));
  if (all.some((s) => s.relation !== "equal")) return out(verdictOf("insufficient", Object.values(relations).every((r) => r.length === 1) ? "consistent_unit_conversion" : "mixed_relations"));
  if (!all.some((s) => s.nonZero)) return out(verdictOf("insufficient", "only_zero_values"));
  return out(verdictOf("same"));
}

// The mapping: every key a canonical id, every athlete with a valid row of that level among the
// details' players, and every /more/ names the row it was read for (the run stops otherwise). An empty
// players map is a drill not computed yet, never a difference; athletes whose row the importer skips
// (statistics not valid) are not required; players without a row are counted, not a difference.
export function mappingVerdict(m, chosen) {
  if (!("wholePlayerKeysCanonical" in m)) return verdictOf("insufficient", "not_compared");
  if (m.wholePlayerKeysCanonical === false || m.drillPlayerKeysCanonical === false) return verdictOf("differs", "player_key_not_canonical");
  if (m.wholePlayersEmpty || m.drillPlayersEmpty) return verdictOf("insufficient", "details_players_empty");
  if (m.wholeMissingInDetails > 0 || m.drillMissingInDetails > 0) return verdictOf("differs", "players_missing_for_rows");
  if (m.pageComplete !== true) return verdictOf("insufficient", "athlete_list_page_incomplete");
  if (chosen < DETAILS_COVERAGE_ATHLETES) return verdictOf("insufficient", "fewer_athletes_than_planned");
  return verdictOf("same");
}

// The overall verdict on replacing /more/: a confirmed difference in any family is `differs`, even in
// a run that stopped later; `same` needs a run that ended as built and every family `same`; anything
// else is `insufficient` with its reason. The row scalars are reported beside it and do not decide it:
// a check keeps reading them from the rows.
export function overallVerdict(families, stoppedBy) {
  const deciding = ["events", "powerZones", "speedZones", "mapping", "drillLevel"];
  if (deciding.some((f) => families[f]?.verdict === "differs")) return verdictOf("differs");
  if (stoppedBy) return verdictOf("insufficient", stoppedBy);
  const notSame = deciding.find((f) => families[f]?.verdict !== "same");
  return notSame ? verdictOf("insufficient", `${notSame}_not_same`) : verdictOf("same");
}

// The run's request entry: closed words and bounded numbers only.
function describeSafely(res, body) {
  const d = describeResponse(res, body);
  const out = {
    status: d.status, bodyKind: d.bodyKind, arrayLength: d.arrayLength, headerCount: d.headerNames.length,
    authScheme: d.authScheme === null ? null : AUTH_SCHEMES.includes(d.authScheme) ? d.authScheme : "<other>",
    contentTypeJson: typeof d.contentType === "string" ? /^application\/json\b/i.test(d.contentType) : null,
    gpexeVersion: typeof d.gpexeVersion === "string" ? (/^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$/.test(d.gpexeVersion) ? d.gpexeVersion : "<unprintable>") : null,
    totalCount: typeof d.totalCount === "string" && /^\d{1,9}$/.test(d.totalCount) ? Number(d.totalCount) : d.totalCount === null ? null : "<unprintable>",
  };
  for (const [key, other] of [["fieldNames", "otherFieldCount"], ["resultFieldNames", "otherResultFieldCount"]]) {
    if (!Array.isArray(d[key])) continue;
    out[key] = d[key].filter((k) => PRINTABLE_KEYS.includes(k));
    if (out[key].length < d[key].length) out[other] = d[key].length - out[key].length;
  }
  return out;
}
const maskPath = (path, team) => maskProbePath(path, team).replace(/valid_on=[^&]*/g, "valid_on=<date>");
// Does a value name the probe team? null = an unknown shape.
const namesTeam = (value, team) => (safeId(value) === null ? null : safeId(value) === team);
// A failed request's error as a closed-shape word (a system code or a class name), else "error".
const errorWord = (e) => {
  const w = e?.name === "AbortError" ? "timeout" : (e?.code || e?.cause?.code || e?.name);
  return typeof w === "string" && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(w) ? w : "error";
};
// The numbers one answer gives one athlete on the compared fields, as one string for an in-memory
// comparison of the whole session with the drill; never printed.
const moreNumbers = (more) => JSON.stringify([
  ...IMPORTED_MORE_RULES.events.map((r) => (isPlainObject(more?.events) ? finite(more.events[`${r.prefix}_count`]) : null)),
  ...Object.keys(DETAILS_ZONE_PREFIX).flatMap((f) => (moreZones(more, f) ?? []).map((z) => z.distance)),
]);
const detailsNumbers = (player) => JSON.stringify(isPlainObject(player) ? Object.keys(player)
  .filter((k) => Object.values(DETAILS_EVENT_FIELDS).includes(k) || Object.values(DETAILS_ROW_SCALARS).includes(k) || Object.values(DETAILS_ZONE_PREFIX).some((pre) => k.startsWith(pre)))
  .sort().map((k) => [k, detailsValue(player, k).value]) : []);
// A details answer kept in memory without the players' athlete objects (names).
const withoutAthletes = (body) => ({ ...body, players: Object.fromEntries(Object.entries(body.players).map(([k, p]) => [k, isPlainObject(p) ? Object.fromEntries(Object.entries(p).filter(([f]) => f !== "athlete")) : p])) });

export function parseArgs(argv) {
  const opts = { host: PROBE_HOST, team: PROBE_TEAM };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--host", "--team"].includes(key) || value === undefined) throw new DiscoveryUsageError(`unknown or incomplete argument ${key}`);
    opts[key.slice(2)] = value;
  }
  // The options exist so that a wrong value is refused loudly, not so that another target can be chosen.
  if (opts.host !== PROBE_HOST) throw new DiscoveryUsageError(`this probe reads host ${PROBE_HOST} only`);
  if (opts.team !== PROBE_TEAM) throw new DiscoveryUsageError(`this probe reads Team ID ${PROBE_TEAM} only`);
  return opts;
}

// timeoutMs and sleep exist for the tests; the pause itself is fixed.
export async function runDetailsCoverageProbe({ host = PROBE_HOST, team = PROBE_TEAM, timeoutMs = REQUEST_TIMEOUT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}, env, fetchImpl = globalThis.fetch) {
  if (host !== PROBE_HOST) throw new DiscoveryUsageError(`this probe reads host ${PROBE_HOST} only`);
  if (team !== PROBE_TEAM) throw new DiscoveryUsageError(`this probe reads Team ID ${PROBE_TEAM} only`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) throw new DiscoveryUsageError(`timeoutMs is a whole number up to ${REQUEST_TIMEOUT_MS}`);
  const profile = discoveryProfile(host, "rest_v1");
  if (!profile.exchange) throw new DiscoveryUsageError(`host ${host} has no confirmed credential exchange`);
  const username = env.GPEXE_USERNAME;
  const password = env.GPEXE_PASSWORD;
  if (!username || !password) throw new DiscoveryUsageError("GPEXE_USERNAME and GPEXE_PASSWORD are not both set in this terminal");
  const api = profile.apiPrefix;
  const report = {
    source: "gpexe", hostKey: host, apiFamily: profile.apiFamily, teamId: team, mode: "details-coverage", ranAt: new Date().toISOString(),
    pauseMs: DETAILS_COVERAGE_PAUSE_MS, maxRequests: DETAILS_COVERAGE_MAX_REQUESTS, requests: [], stoppedBy: null,
  };
  let requests = 0;
  const countRequest = () => {
    requests += 1;
    if (requests > DETAILS_COVERAGE_MAX_REQUESTS) throw new ProbeStop("request_limit", `more than ${DETAILS_COVERAGE_MAX_REQUESTS} requests would be needed`);
  };
  // Everything compared, in memory; only the words and counts derived from it are printed.
  const run = { selection: {}, mapping: {}, pairs: [], thresholds: null, readiness: {}, chosen: 0, drillDistinct: [] };
  let issued = null;
  const letGo = (res) => {
    try {
      Promise.resolve(res?.body?.cancel?.()).catch(() => {});
    } catch {
      // A cancel that throws changes nothing.
    }
  };

  const done = () => {
    const pairs = run.pairs.map((p) => p.result);
    const families = {
      events: eventsVerdict(pairs, run.thresholds?.eventRuleAsImported ?? null),
      powerZones: zoneFamilyVerdict(pairs, "power"),
      speedZones: zoneFamilyVerdict(pairs, "speed"),
      mapping: mappingVerdict(run.mapping, run.chosen),
      drillLevel: drillLevelVerdict(run.drillDistinct),
    };
    report.coverage = {
      ...overallVerdict(families, report.stoppedBy),
      families, rowScalars: scalarsVerdict(pairs),
      selection: run.selection, mapping: run.mapping, thresholds: run.thresholds, readiness: run.readiness,
      pairs: run.pairs.map(({ athlete, level, result }) => ({ athlete, level, events: result.events, zones: result.zones, bands: result.bands, scalars: result.scalars })),
    };
    report.requestCount = report.requests.length;
    const text = assertNoSecretInReport(report, env);
    if (issued && text.includes(issued)) {
      const error = new Error("refusing to print: the report would contain the issued token");
      error.code = "secret_in_report";
      throw error;
    }
    return report;
  };

  // 1. The one exchange, in the host's confirmed form; a 429 on it ends the run like any other.
  countRequest();
  issued = await (async () => {
    const url = new URL(profile.exchange.path, profile.baseUrl);
    if (!url.href.startsWith(profile.baseUrl)) throw new DiscoveryUsageError("the exchange path left the host");
    const entry = { method: "POST", path: maskPath(profile.exchange.path, team), authenticated: false, bodyEncoding: profile.exchange.encoding };
    const form = profile.exchange.encoding === "form";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.href, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams({ username, password }).toString() : JSON.stringify({ username, password }),
      });
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      if (res.status === 429) {
        letGo(res);
        report.requests.push({ ...entry, status: 429 });
        report.rateLimit = { requestNumber: requests, ...retryAfterOf(header("retry-after")) };
        return null;
      }
      if (res.status >= 300 && res.status < 400) {
        letGo(res);
        report.requests.push({ ...entry, status: res.status, redirected: true });
        return null;
      }
      let body;
      try {
        const text = await readBounded(res, header("content-length"), MAX_EXCHANGE_BYTES);
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        report.requests.push({ ...entry, status: res.status, error: "answer_too_large_or_unreadable" });
        return null;
      }
      report.requests.push({ ...entry, ...describeSafely(res, body) });
      const field = profile.exchange.tokenField;
      return res.status === 200 && isPlainObject(body) && typeof body[field] === "string" && body[field] ? body[field] : null;
    } catch (e) {
      report.requests.push({ ...entry, error: errorWord(e) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  if (!issued) {
    report.stoppedBy = report.rateLimit ? "rate_limited" : "exchange_failed";
    return done();
  }

  // The ONLY read: GET, one relative resource path under a prefix of the same host, a pause before
  // it, a bounded body, no repeat, redirects refused, the first 429 the end of the run. Under `api/`
  // only the drill read a check sends today, and only after its rest/v1 form did not answer.
  const get = (resourcePath) => read(api, resourcePath);
  const getLegacyDrill = (resourcePath, parentId) => {
    if (!LEGACY_DRILL_PATH.test(resourcePath) || resourcePath !== `team_session/${parentId}/details/?drill=${DETAILS_COVERAGE_DRILL_INDEX}`) {
      throw new ProbeStop("path_refused", "not the drill read of a check for the confirmed parent");
    }
    return read(LEGACY_API_PREFIX, resourcePath);
  };
  async function read(prefix, resourcePath) {
    countRequest();
    await sleep(DETAILS_COVERAGE_PAUSE_MS);
    const url = new URL(`${prefix}${resourcePath}`, profile.baseUrl);
    if (!url.href.startsWith(`${profile.baseUrl}${prefix}`)) throw new ProbeStop("path_refused", "a path left its prefix");
    const entry = { method: "GET", path: maskPath(`${prefix}${resourcePath}`, team), authenticated: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url.href, { method: "GET", headers: { Authorization: `${profile.authScheme} ${issued}`, Accept: "application/json" }, redirect: "manual", signal: controller.signal });
      } catch (e) {
        report.requests.push({ ...entry, error: errorWord(e) });
        return { status: null };
      }
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      if (res.status === 429) {
        letGo(res);
        report.requests.push({ ...entry, status: 429 });
        report.rateLimit = { requestNumber: requests, ...retryAfterOf(header("retry-after")) };
        throw new ProbeStop("rate_limited", "the source asked to slow down; nothing more is sent");
      }
      if (res.status >= 300 && res.status < 400) {
        letGo(res);
        report.requests.push({ ...entry, status: res.status, redirected: true });
        return { status: res.status };
      }
      let body;
      try {
        const text = await readBounded(res, header("content-length"));
        body = text === "" ? undefined : redactGpexe(JSON.parse(text));
      } catch {
        report.requests.push({ ...entry, status: res.status, error: "answer_too_large_or_unreadable" });
        return { status: res.status };
      }
      report.requests.push({ ...entry, ...describeSafely(res, body) });
      return { status: res.status, body, totalCount: header("x-total-count") };
    } finally {
      clearTimeout(timer);
    }
  }
  const assertTeam = (rows, what) => {
    for (const row of rows) {
      if (!isPlainObject(row) || !("team" in row)) continue;
      const named = namesTeam(row.team, team);
      if (named === false) throw new ProbeStop("team_isolation_failed", `${what}: a row of another team was returned`);
      if (named === null) throw new ProbeStop("team_unknown_shape", `${what}: a row names its team in an unknown shape`);
    }
  };

  try {
    // 2. The session list of team 980 (one page). A parent: team 980, a readable id, named in no other
    //    row's `drills`, an explicit `drills` list of at least two entries (so a drill cannot be the
    //    whole session), valid statistics; repeats of one id count once. Of those, the one with the
    //    fewest drills (the first on the page among equals), so its athlete list most likely fits the
    //    one page read.
    const list = await get(teamScopedPath("team_session/", team, [["limit", LIST_LIMIT]]));
    if (list.status !== 200 || !Array.isArray(list.body)) throw new ProbeStop("session_list_unavailable", "the session list could not be read");
    const rows = list.body.filter(isPlainObject);
    assertTeam(rows, "session list");
    const named = new Set(rows.flatMap((r) => (Array.isArray(r.drills) ? r.drills.map(safeId).filter(Boolean) : [])));
    const candidates = rows.filter((r) => safeId(r.id) !== null && namesTeam(r.team, team) === true && !named.has(safeId(r.id))
      && Array.isArray(r.drills) && r.drills.length >= 2 && r.is_stats_valid === true);
    const seen = new Set();
    const distinct = candidates.filter((r) => !seen.has(safeId(r.id)) && seen.add(safeId(r.id)));
    if (distinct.length === 0) {
      run.selection = { listRows: rows.length, parentCandidates: 0, repeatedParentIds: candidates.length };
      throw new ProbeStop("no_parent_session", "the list page holds no parent with two drills and valid statistics");
    }
    const parentRow = distinct.reduce((best, r) => (r.drills.length < best.drills.length ? r : best));
    const parentId = safeId(parentRow.id);
    run.selection = { listRows: rows.length, parentCandidates: distinct.length, repeatedParentIds: candidates.length - distinct.length, parentDrills: parentRow.drills.length };

    // 3. The parent's own read: the same id, team 980, a drill count from 2 to 30, valid statistics, a day.
    const own = await get(`team_session/${parentId}/`);
    if (own.status !== 200 || !isPlainObject(own.body)) throw new ProbeStop("parent_not_confirmed", "the session's own read failed");
    assertTeam([own.body], "session");
    if (safeId(own.body.id) !== parentId) throw new ProbeStop("parent_id_mismatch", "the session's own read named another id");
    const drillsCount = own.body.drills_count;
    const day = dayOf(own.body.start_timestamp);
    if (namesTeam(own.body.team, team) !== true || !Number.isInteger(drillsCount) || drillsCount < 2 || drillsCount > 30 || own.body.is_stats_valid !== true || !day) {
      throw new ProbeStop("parent_not_confirmed", "the session's own read did not confirm team 980, its drills, valid statistics and a day");
    }
    run.readiness.parentStatsValid = true;

    // 4. Its athlete list (the first page): every row names this session, a readable id and athlete,
    //    and a drill that is none or an index of this session.
    const athletes = await get(`athlete_session/?teamsession=${parentId}&limit=${LIST_LIMIT}`);
    if (athletes.status !== 200 || !Array.isArray(athletes.body)) throw new ProbeStop("athlete_list_unavailable", "the athlete list could not be read");
    const arows = athletes.body.filter(isPlainObject);
    if (arows.length !== athletes.body.length) throw new ProbeStop("athlete_rows_unreadable", "an athlete row is not an object");
    if (arows.length === 0) throw new ProbeStop("athlete_list_empty", "the parent's athlete list holds no row");
    const levelOf = (r) => (r.drill === null || r.drill === undefined ? "whole" : Number.isInteger(r.drill) && r.drill >= 0 && r.drill < drillsCount ? `drill${r.drill}` : null);
    for (const r of arows) {
      const ts = safeId(r.teamsession);
      if (ts === null) throw new ProbeStop("rows_do_not_name_session", "an athlete row names no session in a readable way");
      if (ts !== parentId) throw new ProbeStop("team_isolation_failed", "athlete rows of another session were returned");
      if (safeId(r.id) === null || safeId(r.athlete) === null) throw new ProbeStop("row_identity_unreadable", "an athlete row's id or athlete is not readable");
      if (levelOf(r) === null) throw new ProbeStop("row_drill_unreadable", "an athlete row names a drill this session does not have");
    }
    const ids = arows.map((r) => safeId(r.id));
    if (new Set(ids).size !== ids.length) throw new ProbeStop("row_ids_repeated", "the athlete list names one row twice");
    const total = typeof athletes.totalCount === "string" && /^\d{1,9}$/.test(athletes.totalCount) ? Number(athletes.totalCount) : null;
    const drillLevel = `drill${DETAILS_COVERAGE_DRILL_INDEX}`;
    const athletesAt = (level, validOnly = false) => new Set(arows.filter((r) => levelOf(r) === level && (!validOnly || r.is_stats_valid === true)).map((r) => safeId(r.athlete)));
    run.mapping = { pageComplete: total !== null && total === arows.length, rowsOnPage: arows.length, rowsNameParent: true, rowIdsUnique: true };

    // 5. and 6. The details of the whole session and of drill 0, without the players' names. The drill
    //    is read in its rest/v1 form; only if that does not answer with players, once in the api/ form a
    //    check reads today. A 429 on either ends the run, and a refused credential (401, 403) too.
    const asDetails = (answer) => (answer.status === 200 && isPlainObject(answer.body) && isPlainObject(answer.body.players) ? withoutAthletes(answer.body) : null);
    const refused = (answer) => {
      if (answer.status === 401 || answer.status === 403) throw new ProbeStop("source_auth_rejected", "the source refused the credential");
      return answer;
    };
    const whole = asDetails(refused(await get(`team_session/${parentId}/details/`)));
    if (!whole) throw new ProbeStop("details_unavailable", "the whole session's details could not be read as players");
    const drillPath = `team_session/${parentId}/details/?drill=${DETAILS_COVERAGE_DRILL_INDEX}`;
    let drill = asDetails(refused(await get(drillPath)));
    run.selection.drillForm = "rest_v1";
    if (!drill) {
      run.selection.drillForm = "api";
      drill = asDetails(refused(await getLegacyDrill(drillPath, parentId)));
    }
    if (!drill) throw new ProbeStop("drill_details_unavailable", "the drill's details could not be read as players in either form");
    const keysCanonical = (players) => Object.keys(players).every((k) => safeId(k) === k);
    const missing = (players, level) => [...athletesAt(level, true)].filter((a) => !isPlainObject(players[a])).length;
    const extra = (players, level) => Object.keys(players).filter((k) => !athletesAt(level).has(k)).length;
    Object.assign(run.mapping, {
      wholePlayerKeysCanonical: keysCanonical(whole.players), drillPlayerKeysCanonical: keysCanonical(drill.players),
      wholePlayersEmpty: Object.keys(whole.players).length === 0, drillPlayersEmpty: Object.keys(drill.players).length === 0,
      wholeMissingInDetails: missing(whole.players, "whole"), drillMissingInDetails: missing(drill.players, drillLevel),
      wholeExtraInDetails: extra(whole.players, "whole"), drillExtraInDetails: extra(drill.players, drillLevel),
      wholeDetailsNamesParent: safeId(whole.teamsession) === parentId, drillDetailsNamesParent: safeId(drill.teamsession) === parentId,
      wholeDetailsDrillsCountMatches: whole.drills_count === drillsCount,
    });
    run.readiness.detailsHasReadinessKey = [whole, drill].some((d) => Object.values(d.players).some((p) => has(p, "is_ready") || has(p, "is_stats_valid")));
    run.readiness.detailsHasThresholdLikeKey = [whole, drill].some((d) => Object.values(d.players).some((p) => isPlainObject(p) && Object.keys(p).some((k) => /threshold|duration/i.test(k))));

    // 7. The team thresholds valid on the session's day: the bands' guard and the event rule.
    const th = await get(`team/${team}/thresholds/?valid_on=${day}`);
    if (th.status !== 200 || !isPlainObject(th.body)) throw new ProbeStop("thresholds_unavailable", "the team thresholds could not be read");
    assertTeam([th.body], "thresholds");
    if (namesTeam(th.body.team, team) !== true) throw new ProbeStop("team_unknown_shape", "the thresholds do not name the team in a readable way");
    const rule = (metric) => IMPORTED_MORE_RULES.events.find((e) => e.metric === metric);
    const eventRule = (metric) => finite(th.body[`${metric}_events_threshold`]) === rule(metric).threshold && finite(th.body[`${metric}_events_duration`]) === rule(metric).duration;
    run.thresholds = {
      eventRuleAsImported: eventRule("acceleration") && eventRule("deceleration"),
      accelerationRuleAsImported: eventRule("acceleration"), decelerationRuleAsImported: eventRule("deceleration"),
      powerThresholdsReadable: thresholdList(th.body.power_thresholds) !== null, speedThresholdsReadable: thresholdList(th.body.speed_thresholds) !== null,
    };

    // The athletes compared: in the list's order, one whole row and one drill-0 row each, valid
    // statistics on both, and an entry in both details answers.
    const order = [...new Set(arows.filter((r) => levelOf(r) === "whole").map((r) => safeId(r.athlete)))];
    const chosen = [];
    for (const athlete of order) {
      const at = (level) => arows.filter((r) => safeId(r.athlete) === athlete && levelOf(r) === level);
      const [w, d] = [at("whole"), at(drillLevel)];
      if (w.length !== 1 || d.length !== 1 || w[0].is_stats_valid !== true || d[0].is_stats_valid !== true) continue;
      if (!isPlainObject(whole.players[athlete]) || !isPlainObject(drill.players[athlete])) continue;
      chosen.push({ athlete, rows: { whole: w[0], drill: d[0] } });
      if (chosen.length === DETAILS_COVERAGE_ATHLETES) break;
    }
    run.chosen = chosen.length;
    run.readiness.rowsWithStatsNotValid = arows.filter((r) => r.is_stats_valid !== true).length;
    if (chosen.length === 0) throw new ProbeStop("no_comparable_athlete", "no athlete has a valid whole row, a valid drill-0 row and both details entries");

    // 8. to 11. /more/ of each chosen row, compared as soon as it arrives; then, per athlete, whether
    //    the drill's answers differ from the whole session's in /more/ and in the details.
    for (const [i, c] of chosen.entries()) {
      const seenNumbers = {};
      for (const level of LEVELS) {
        const row = c.rows[level];
        const rowId = safeId(row.id);
        const more = await get(`athlete_session/${rowId}/more/`);
        if (more.status !== 200 || !isPlainObject(more.body)) throw new ProbeStop("more_unavailable", "a row's /more/ could not be read");
        if (safeId(more.body.athletesession_id) !== rowId) throw new ProbeStop("more_id_mismatch", "a /more/ named another row");
        const player = (level === "whole" ? whole : drill).players[c.athlete];
        const result = comparePair({ more: more.body, player, row, thresholds: th.body });
        run.readiness.zonesNotReady = (run.readiness.zonesNotReady ?? 0)
          + Object.keys(DETAILS_ZONE_PREFIX).reduce((n, family) => n + (moreZones(more.body, family) ?? []).filter((z) => !z.ready).length, 0);
        run.pairs.push({ athlete: i + 1, level, result });
        seenNumbers[level] = { more: moreNumbers(more.body), details: detailsNumbers(player) };
      }
      run.drillDistinct.push(seenNumbers.whole.more !== seenNumbers.drill.more && seenNumbers.whole.details !== seenNumbers.drill.details);
    }
  } catch (e) {
    if (e instanceof ProbeStop) report.stoppedBy = e.code;
    else if (e instanceof DiscoveryUsageError) throw e;
    else report.stoppedBy = "unexpected_error";
  }
  return done();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runDetailsCoverageProbe(opts, process.env);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.name || "Error"}${e instanceof DiscoveryUsageError ? `: ${e.message}` : e?.code ? ` (${e.code})` : ""}\n`);
    process.exit(1);
  });
}
