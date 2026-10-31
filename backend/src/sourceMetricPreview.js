// The aggregate preview's pure part (phase 7e, contract J11,
// docs/ai/phase7e-aggregate-preview-contract.md, sections 3-5): one level's
// count, min and max, and D8's conversion of min and max at the storage scale.
// No database, no network: every number is an exact decimal (BigInt), never a
// binary floating-point one.
import { canonicalDecimal, compareDecimal } from "./sourceMetricExtractors.js";

// OD3 (decided 2026-10-30): with fewer athletes with a value, min and max are
// a single athlete's value and are not answered.
export const PREVIEW_MINIMUM_ATHLETES = 3;
// D8 (C39): a canonical value is stored at 9 decimals, half away from zero -
// the rule training_load.source_metric_value_matches() checks.
export const STORAGE_SCALE = 9;

function parts(text) {
  const canonical = canonicalDecimal(text);
  if (canonical === null) throw new Error("not a decimal");
  const negative = canonical.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? canonical.slice(1) : canonical).split(".");
  const n = BigInt(intPart + fracPart);
  return { n: negative ? -n : n, s: fracPart.length };
}
const pow10 = (k) => 10n ** BigInt(k);

// The canonical text of n / 10^s.
function textOf(n, s) {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(s + 1, "0");
  const body = s > 0 ? `${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}` : digits;
  return canonicalDecimal(negative ? `-${body}` : body);
}

// D8: canonical = (source x scale + offset x divisor) / divisor, computed
// exactly and rounded once to STORAGE_SCALE decimals, half away from zero.
// Every argument is decimal text (or a finite number); the divisor is > 0
// (the v34 CHECK).
export function convertAtStorageScale(source, { scale, divisor, offset }) {
  const x = parts(source);
  const a = parts(scale);
  const d = parts(divisor);
  const o = parts(offset);
  if (d.n <= 0n) throw new Error("the divisor is not positive");
  // x*a at scale x.s + a.s; o*d at scale o.s + d.s; their sum at scale s.
  const left = { n: x.n * a.n, s: x.s + a.s };
  const right = { n: o.n * d.n, s: o.s + d.s };
  const s = Math.max(left.s, right.s);
  const numerator = left.n * pow10(s - left.s) + right.n * pow10(s - right.s);
  // (numerator / 10^s) / (d.n / 10^d.s), scaled by 10^STORAGE_SCALE.
  const num = numerator * pow10(d.s + STORAGE_SCALE);
  const den = d.n * pow10(s);
  const negative = num < 0n;
  const magnitude = negative ? -num : num;
  let q = magnitude / den;
  if (2n * (magnitude % den) >= den) q += 1n;
  return textOf(negative ? -q : q, STORAGE_SCALE);
}

// One level of the answer (J11 section 3): `athletes` holds, per athlete the
// import keeps, the list of that athlete's values at this level (one at the
// session level, one per drill at the drill level). An athlete counts once
// when the list is not empty; min and max are over every value, in the
// source unit, and null below the minimum count.
export function previewLevel(athletes, factors) {
  const texts = [];
  let athletesWithValue = 0;
  for (const values of athletes) {
    if (values.length === 0) continue;
    athletesWithValue += 1;
    for (const value of values) {
      const text = canonicalDecimal(value);
      if (text === null) throw new Error("an extracted value is not a decimal");
      texts.push(text);
    }
  }
  if (athletesWithValue < PREVIEW_MINIMUM_ATHLETES) {
    return { athletesWithValue, min: null, max: null, minCanonical: null, maxCanonical: null };
  }
  let min = texts[0];
  let max = texts[0];
  for (const text of texts) {
    if (compareDecimal(text, min) < 0) min = text;
    if (compareDecimal(text, max) > 0) max = text;
  }
  return { athletesWithValue, min, max, minCanonical: convertAtStorageScale(min, factors), maxCanonical: convertAtStorageScale(max, factors) };
}
