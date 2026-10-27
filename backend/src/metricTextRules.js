// The text rules of the Metrics Core admin APIs (M2, M3-0, R2, M2b), in one
// module without a database so a unit test can compare them with the
// frontend's copies (frontend/metric-variables-data.js).
//
// The lists are explicit, since PostgreSQL's regular expressions have no
// Unicode properties: the database twins source_metric_text_ok() and
// source_metric_unit_token_ok() (v34) take the same lists in v39 (Q10).

// C41 / C53, widened by Q10: the characters a bounded free-text value refuses
// (NUL too: a PostgreSQL text cannot hold it). C53's controls, invisible and
// bidi characters, plus every other default-ignorable code point (the
// combining grapheme joiner, the Hangul fillers, the Khmer inherent vowels,
// the Mongolian variation selectors, the variation selectors, the reserved
// U+FFF0-FFF8, the interlinear annotation marks U+FFF9-FFFB, the tag
// characters) and the blank braille pattern U+2800.
export const TEXT_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;

// A text made only of blanks (U+0020 and the other space separators) shows
// nothing: it is refused like an empty one (Q10).
export const TEXT_BLANK = /^[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]*$/u;

// The JavaScript twin of training_load.source_metric_unit_token_ok() (v34):
// 1-30 characters, no whitespace, no '|' or '=', no control, format or
// invisible character. Q10 adds the characters it adds to TEXT_FORBIDDEN.
export const UNIT_FORBIDDEN = /[\s|=\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u034f\u061c\u115f\u1160\u1680\u17b4\u17b5\u180b-\u180f\u2000-\u200f\u2028-\u202f\u205f-\u206f\u2800\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;

// One line of 1-max visible characters without surrounding spaces (C41, C53,
// Q10). The length counts code points, as PostgreSQL's char_length() does.
export function boundedText(value, max) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith(" ") || value.endsWith(" ")) return false;
  if ([...value].length > max) return false;
  return !TEXT_FORBIDDEN.test(value) && !TEXT_BLANK.test(value);
}

// A unit token (D3): 1-30 characters outside UNIT_FORBIDDEN.
export function unitTokenOk(value) {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return length >= 1 && length <= 30 && !UNIT_FORBIDDEN.test(value);
}
