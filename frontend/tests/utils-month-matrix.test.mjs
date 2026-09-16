// Phase G: monthMatrixIso is the one shared Monday-first month grid behind
// both the Tests-module Dates picker and Training Load's "New RPE session"
// calendar (it replaced two identical private copies). These fixtures pin
// the edges a future change could silently move for both pickers at once.
import { test } from "node:test";
import assert from "node:assert/strict";

const { monthMatrixIso } = await import("../utils.js");

test("a month that starts on a Sunday gets six leading blanks (Monday-first grid)", () => {
  const cells = monthMatrixIso("2026-02"); // 1 Feb 2026 is a Sunday
  assert.deepEqual(cells.slice(0, 6), [null, null, null, null, null, null]);
  assert.equal(cells[6], "2026-02-01");
  assert.equal(cells.length, 35);
  assert.equal(cells.filter(Boolean).length, 28);
});

test("a month that ends on a Sunday has no trailing blanks", () => {
  const cells = monthMatrixIso("2026-05"); // 31 May 2026 is a Sunday
  assert.equal(cells.length, 35);
  assert.equal(cells[34], "2026-05-31");
  assert.equal(cells.filter((c) => c === null).length, 4, "only the 4 leading blanks (1 May 2026 is a Friday)");
});

test("a leap-year February yields 29 day cells, zero-padded ISO dates, whole 7-cell rows", () => {
  const cells = monthMatrixIso("2028-02"); // 1 Feb 2028 is a Tuesday
  assert.equal(cells[0], null);
  assert.equal(cells[1], "2028-02-01");
  assert.equal(cells.filter(Boolean).length, 29);
  assert.equal(cells.length % 7, 0);
  assert.ok(cells.filter(Boolean).every((iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso)));
});
