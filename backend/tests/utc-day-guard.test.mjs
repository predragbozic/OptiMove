// The UTC-midnight guard of the calendar's date-bound suites (support/utc-day-guard.mjs), with a clock the test
// controls: a file never fixes its TODAY within the last minutes before UTC midnight, and fixes the new day once the
// midnight has passed. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { msToWaitBeforeUtcDay, utcDateOf, waitOutUtcMidnight } from "./support/utc-day-guard.mjs";

const MIDNIGHT = Date.UTC(2026, 10, 20); // 2026-11-20T00:00:00Z
const MIN = 60_000;

test("1. well before midnight: no wait", () => {
  assert.equal(msToWaitBeforeUtcDay(MIDNIGHT - 6 * MIN), 0);
  assert.equal(msToWaitBeforeUtcDay(Date.UTC(2026, 10, 19, 12)), 0);
});

test("2. inside the margin, up to the last millisecond: wait until just after midnight", () => {
  for (const before of [5 * MIN, 4 * MIN, MIN, 1_000, 1]) {
    const wait = msToWaitBeforeUtcDay(MIDNIGHT - before);
    assert.equal(wait, before + 5_000, `${before} ms before midnight`);
    assert.equal(utcDateOf(MIDNIGHT - before + wait), "2026-11-20", "the day after the wait is the new one");
  }
});

test("3. exactly at and just after midnight: no wait, the new day", () => {
  for (const after of [0, 1, 1_000, 18 * MIN]) {
    assert.equal(msToWaitBeforeUtcDay(MIDNIGHT + after), 0, `${after} ms after midnight`);
    assert.equal(utcDateOf(MIDNIGHT + after), "2026-11-20");
  }
});

test("4. waitOutUtcMidnight: just before midnight it sleeps past it and returns the new day; otherwise it does not sleep", async () => {
  let clock = MIDNIGHT - 30_000;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  const before = await waitOutUtcMidnight({ now: () => clock, sleep });
  assert.deepEqual(sleeps, [35_000]);
  assert.equal(before, "2026-11-20", "not 2026-11-19, the day that was ending");

  clock = MIDNIGHT + 2_000;
  sleeps.length = 0;
  assert.equal(await waitOutUtcMidnight({ now: () => clock, sleep }), "2026-11-20");
  assert.deepEqual(sleeps, [], "just after midnight it starts at once");

  clock = MIDNIGHT - 10 * MIN;
  assert.equal(await waitOutUtcMidnight({ now: () => clock, sleep }), "2026-11-19");
  assert.deepEqual(sleeps, [], "ten minutes before midnight it starts at once");
});

test("5. the margin's edge: one millisecond more than 5 minutes left starts at once, exactly 5 minutes waits", () => {
  // central-calendar-k2b2-questions takes about 10 s alone, far inside the 5 minutes.
  assert.equal(msToWaitBeforeUtcDay(MIDNIGHT - 5 * MIN - 1), 0);
  assert.equal(msToWaitBeforeUtcDay(MIDNIGHT - 5 * MIN), 5 * MIN + 5_000);
});
