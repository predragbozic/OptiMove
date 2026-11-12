// The pure part of the drag-and-drop board (J18, C112;
// docs/ai/c112-drag-mapping-contract.md, sections 3.5, 4.2, 6.1 and 15):
// what the GPEXE screen shows for a column (the display registry, R5), which
// two athletes a board shows (the pair rule, C117), and the placement hash.
// No database, no network: every number is exact decimal text, never a
// binary floating-point one.
import crypto from "node:crypto";
import { canonicalDecimal, compareDecimal } from "./sourceMetricExtractors.js";
import { convertAtStorageScale } from "./sourceMetricPreview.js";

// The registry's version, stored with every confirmation (T9).
export const DISPLAY_REGISTRY_VERSION = 1;
// At most this many pairs are offered for one board (pair = 0 .. count - 1).
export const PAIR_LIMIT = 200;

// n / 10^s as canonical decimal text, rounded to `places` decimals, half away
// from zero, always with exactly `places` decimals.
export function roundDecimal(text, places) {
  const canonical = canonicalDecimal(text);
  if (canonical === null) throw new Error("not a decimal");
  const negative = canonical.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? canonical.slice(1) : canonical).split(".");
  const padded = fracPart.padEnd(places + 1, "0");
  let n = BigInt(intPart + padded.slice(0, places));
  if (padded.charCodeAt(places) >= 53) n += 1n; // the next digit is 5 or more
  const digits = n.toString().padStart(places + 1, "0");
  const body = places > 0 ? `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}` : digits;
  return negative && n !== 0n ? `-${body}` : body;
}

// Seconds as the GPEXE screen shows a duration: minutes and seconds, the
// seconds rounded to the nearest one ("96:30"; the screen rounds seconds
// inconsistently, so the guide allows one second of difference).
function minutesSeconds(secondsText) {
  const whole = BigInt(roundDecimal(secondsText, 0));
  if (whole < 0n) return null;
  return `${whole / 60n}:${(whole % 60n).toString().padStart(2, "0")}`;
}

// One rule per column the registry knows (R5, the Rukovodilac, 2026-11-12:
// total_time, total_distance and max_v only, each with its evidence,
// docs/ai/gpexe-c97-unit-evidence.md). `sourceUnit` is the proven unit the
// rule reads; `units` is the closed list the database knows too
// (training_load.source_metric_display_unit_ok, v65). A column without a rule
// cannot be compared, so it cannot be placed as a new row.
const RULES = Object.freeze({
  "gpexe/rest_v1/athlete_session.total_time": Object.freeze({
    rule: "duration_mmss", sourceUnit: "s", units: Object.freeze(["mm:ss"]),
    show: (raw) => minutesSeconds(raw),
  }),
  "gpexe/rest_v1/athlete_session.total_distance": Object.freeze({
    rule: "distance_m", sourceUnit: "m", units: Object.freeze(["m"]),
    show: (raw) => roundDecimal(raw, 1),
  }),
  "gpexe/rest_v1/athlete_session.max_v": Object.freeze({
    rule: "speed_kmh", sourceUnit: "m/s", units: Object.freeze(["km/h"]),
    // m/s x 3.6, exactly, then to one decimal.
    show: (raw) => roundDecimal(convertAtStorageScale(raw, { scale: "36", divisor: "10", offset: "0" }), 1),
  }),
});

// Test seam (never set by the application): a suite's synthetic fields get a
// rule of the registry by their key, so the real rules are exercised on
// invented columns. Only a key of the form "<suite>.test.<id>" can use it.
const SYNTHETIC_TEST_KEY = /^[a-z0-9]+\.test\.[a-z0-9_.]+$/;
let testRuleFor = null;
export function setDisplayRuleFallbackForTests(fn) { testRuleFor = fn ?? null; }

// The display rule of a source field whose proven unit is `sourceUnit`, or
// null: { rule, units }.
export function displayRuleFor({ sourceSystem, apiFamily, sourceMetricKey, sourceUnit }) {
  const key = `${sourceSystem}/${apiFamily}/${sourceMetricKey}`;
  let entry = Object.hasOwn(RULES, key) ? RULES[key] : null;
  if (!entry && testRuleFor && typeof sourceMetricKey === "string" && SYNTHETIC_TEST_KEY.test(sourceMetricKey)) {
    const name = testRuleFor({ sourceSystem, apiFamily, sourceMetricKey });
    entry = Object.values(RULES).find((r) => r.rule === name) ?? null;
  }
  if (!entry || entry.sourceUnit !== sourceUnit) return null;
  return entry;
}

// What the GPEXE screen should show for a raw value, in `unit` of the rule;
// null when the unit is not the rule's or the value cannot be shown.
export function displayValue(entry, unit, raw) {
  if (!entry || !entry.units.includes(unit)) return null;
  return entry.show(raw);
}

const isZero = (text) => compareDecimal(text, "0") === 0;
// Whether two athletes' values can prove a column: both there, non-zero and
// different (C117).
export function distinctPair(a, b) {
  return a !== null && b !== null && !isZero(a) && !isZero(b) && compareDecimal(a, b) !== 0;
}

const keyOrder = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

// The pairs a board offers, best first (section 6.1). `athletes` is
// [{ key, named, values: Map<fieldId, text | null> }]; `fieldIds` the columns
// that can be placed. Only athletes OptiMove can name take part (R6). A pair
// is ranked by the number of columns where its two values are non-zero and
// different; a pair that proves no column is left out; ties are broken by the
// athletes' internal keys, which are never returned. The same input always
// gives the same order.
export function rankPairs(athletes, fieldIds) {
  const named = athletes.filter((a) => a.named).sort((x, y) => keyOrder(x.key, y.key));
  const pairs = [];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      let score = 0;
      for (const id of fieldIds) if (distinctPair(named[i].values.get(id) ?? null, named[j].values.get(id) ?? null)) score += 1;
      if (score > 0) pairs.push({ a: named[i], b: named[j], score });
    }
  }
  pairs.sort((x, y) => (y.score - x.score) || keyOrder(x.a.key, y.a.key) || keyOrder(x.b.key, y.b.key));
  return pairs.slice(0, PAIR_LIMIT);
}

// The placement hash (section 4.2): a concurrency token over what the admin
// saw, the two athletes' names included (the pair's index alone does not say
// who the pair is). Not a secret, no clock; recomputed by the server on every save. Never
// stored, never part of a request hash.
export function placementHash(parts) {
  const canonical = JSON.stringify([
    "j18.placement.v1",
    parts.bundleHash, parts.pairIndex, parts.pairLabels ?? null, parts.revisionId, parts.targetVersionId ?? null, parts.mappingVersionId ?? null,
    parts.conversion ?? "same", parts.displayRule ?? null, parts.displayUnit ?? null,
    parts.rawA ?? null, parts.storedA ?? null, parts.rawB ?? null, parts.storedB ?? null,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
