// Q10 - the text rules of the Metrics Core admin APIs (backend/src/metricTextRules.js:
// labels, short labels, descriptions, reasons and notes, and unit tokens) and the
// frontend's copies (frontend/metric-variables-data.js). Unit test, no database:
// every code point U+0000-U+10FFFF is compared. Contract:
// docs/ai/gpexe-metric-variable-mapping-discovery.md, C53 and J3b.4.5 (Q10).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as rules from "../src/metricTextRules.js";
import * as front from "../../frontend/metric-variables-data.js";

const ch = (cp) => String.fromCodePoint(cp);
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
const LAST = 0x10ffff;

// The lists as C53 left them (v34), verbatim: Q10 only adds to them.
const C53_TEXT = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;
const C53_UNIT = /[\s|=\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u061c\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/u;

// What Q10 adds, to both lists: [name, first, last].
const GROUPS = [
  ["the combining grapheme joiner", 0x034f, 0x034f],
  ["the Hangul choseong and jungseong fillers", 0x115f, 0x1160],
  ["the Khmer inherent vowels", 0x17b4, 0x17b5],
  ["the Mongolian free variation selectors 1-3", 0x180b, 0x180d],
  ["the Mongolian free variation selector 4", 0x180f, 0x180f],
  ["the reserved default-ignorable U+2065", 0x2065, 0x2065],
  ["the blank braille pattern", 0x2800, 0x2800],
  ["the Hangul filler", 0x3164, 0x3164],
  ["the variation selectors", 0xfe00, 0xfe0f],
  ["the halfwidth Hangul filler", 0xffa0, 0xffa0],
  ["the reserved U+FFF0-FFF8 and the interlinear annotation marks", 0xfff0, 0xfffb],
  ["the shorthand format controls", 0x1bca0, 0x1bca3],
  ["the musical symbol format controls", 0x1d173, 0x1d17a],
  ["the tags and the variation selectors supplement", 0xe0000, 0xe0fff],
];
const inGroups = (cp) => GROUPS.some(([, first, last]) => cp >= first && cp <= last);
// The blanks a text may not start or end with (the space separators).
const BLANKS = new Set([0x20, 0xa0, 0x1680, 0x202f, 0x205f, 0x3000]);
for (let cp = 0x2000; cp <= 0x200a; cp += 1) BLANKS.add(cp);

test("1. every character Q10 adds is refused in a text and in a unit token, by the rules and by the services' checks", () => {
  for (const [name, first, last] of GROUPS) {
    for (let cp = first; cp <= last; cp += 1) {
      const c = ch(cp);
      assert.ok(rules.TEXT_FORBIDDEN.test(c), `${name}: ${hex(cp)} in a text`);
      assert.ok(rules.UNIT_FORBIDDEN.test(c), `${name}: ${hex(cp)} in a unit`);
      assert.equal(rules.boundedText(`a${c}b`, 80), false, `${name}: ${hex(cp)} inside a label`);
      assert.equal(rules.unitTokenOk(`m${c}`), false, `${name}: ${hex(cp)} inside a unit`);
    }
  }
});

test("2. the lists are exactly C53's plus Q10's groups: nothing C53 refused becomes allowed, nothing else is refused", () => {
  let text = 0;
  let unit = 0;
  for (let cp = 0; cp <= LAST; cp += 1) {
    const c = ch(cp);
    const wantText = C53_TEXT.test(c) || inGroups(cp);
    const wantUnit = C53_UNIT.test(c) || inGroups(cp);
    if (rules.TEXT_FORBIDDEN.test(c) !== wantText) assert.fail(`text: ${hex(cp)} should be ${wantText ? "refused" : "allowed"}`);
    if (rules.UNIT_FORBIDDEN.test(c) !== wantUnit) assert.fail(`unit: ${hex(cp)} should be ${wantUnit ? "refused" : "allowed"}`);
    if (wantText) text += 1;
    if (wantUnit) unit += 1;
  }
  // The groups hold 4,149 code points; C53 held 96 (text) and 116 (unit), and
  // a unit's list already held U+2065.
  assert.equal(text, 96 + 4149);
  assert.equal(unit, 116 + 4149 - 1);
});

test("3. the frontend's copies hold exactly the server's characters (every code point); every blank is one the form's oneLine() removes", () => {
  for (let cp = 0; cp <= LAST; cp += 1) {
    const c = ch(cp);
    if (front.TEXT_FORBIDDEN.test(c) !== rules.TEXT_FORBIDDEN.test(c)) assert.fail(`text: ${hex(cp)} differs between the server and the frontend`);
    if (front.UNIT_FORBIDDEN.test(c) !== rules.UNIT_FORBIDDEN.test(c)) assert.fail(`unit: ${hex(cp)} differs between the server and the frontend`);
    if (rules.TEXT_EDGE_BLANK.test(c) !== BLANKS.has(cp)) assert.fail(`blank: ${hex(cp)} should be ${BLANKS.has(cp) ? "a blank" : "no blank"}`);
  }
  for (const cp of BLANKS) assert.match(ch(cp), /^\s$/, `${hex(cp)} is whitespace to oneLine()`);
});

test("4. a text made only of blanks, or starting or ending with a blank, is refused; blanks between visible characters are not", () => {
  for (const cp of BLANKS) {
    assert.equal(rules.boundedText(ch(cp), 80), false, `${hex(cp)} alone`);
    assert.equal(rules.boundedText(`${ch(cp)}${ch(cp)}`, 80), false, `${hex(cp)} twice`);
    assert.equal(rules.boundedText(`${ch(cp)}Total`, 80), false, `${hex(cp)} leading`);
    assert.equal(rules.boundedText(`Total${ch(cp)}`, 80), false, `${hex(cp)} trailing`);
    assert.equal(rules.boundedText(`a${ch(cp)}b`, 80), true, `${hex(cp)} between letters`);
  }
  assert.equal(rules.boundedText("\u3000\u00a0\u2003", 80), false, "a mix of blanks");
  assert.equal(rules.boundedText("", 80), false);
  assert.equal(rules.boundedText(" a", 80), false, "a leading space");
  assert.equal(rules.boundedText("a ", 80), false, "a trailing space");
});

test("5. ordinary names, emoji without a variation selector and long astral text pass; a variation selector or a tag does not", () => {
  for (const ok of ["Total distance", "Ukupno ubrzanja \u010c \u0107 \u0111 \u0161 \u017e", "\u0414\u0438\u0441\u0442\u0430\u043d\u0446\u0438\u044f", "\u8ddd\u96e2", "Sprint \u{1f600}", "\u2764", "m/s\u00b2", "Acc&Dec"]) {
    assert.equal(rules.boundedText(ok, 80), true, ok);
  }
  assert.equal(rules.boundedText("\u2764\ufe0f", 80), false, "an emoji with VS16 is refused (Q10)");
  assert.equal(rules.boundedText(`a${ch(0xe0041)}`, 80), false, "a tag character");
  assert.equal(rules.boundedText("\u{1f600}".repeat(80), 80), true, "the limit counts code points");
  assert.equal(rules.boundedText("\u{1f600}".repeat(81), 80), false);
  assert.equal(rules.boundedText(42, 80), false);
  for (const ok of ["km/h", "W/kg", "m/s\u00b2", "count", "%"]) assert.equal(rules.unitTokenOk(ok), true, ok);
  for (const bad of ["", "m s", "a|b", "a=b", "x".repeat(31), `m${ch(0x3164)}`, ch(0x2800), `km${ch(0xe0020)}`, null]) {
    assert.equal(rules.unitTokenOk(bad), false, JSON.stringify(bad));
  }
});
