// Boundary-condition coverage for the local-date math the Weekly view's
// "default to today" behavior depends on (utils.js/weekly-plan.js). All of
// these use LOCAL Date getters (getFullYear/getMonth/getDate/getDay), never
// UTC ones - verified explicitly here, since a UTC-based implementation
// would show the wrong day/week for part of every day near midnight,
// depending on the user's timezone offset from UTC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDateIso, weekMondayIso } from "../utils.js";
import { todayWeekIndex } from "../weekly-plan.js";

function withMockedNow(t, isoUtcInstant, tz, fn) {
  const originalTz = process.env.TZ;
  process.env.TZ = tz;
  t.mock.timers.enable({ apis: ["Date"], now: new Date(isoUtcInstant).getTime() });
  try {
    fn();
  } finally {
    t.mock.timers.reset();
    process.env.TZ = originalTz;
  }
}

test("1. today in the middle of the week (Wednesday) resolves to that week's Monday", (t) => {
  withMockedNow(t, "2026-08-19T12:00:00Z", "UTC", () => {
    assert.equal(localDateIso(), "2026-08-19");
    assert.equal(weekMondayIso(localDateIso()), "2026-08-17");
  });
});

test("2. Sunday belongs to the week that STARTED the previous Monday, not the upcoming one", (t) => {
  withMockedNow(t, "2026-08-16T12:00:00Z", "UTC", () => {
    assert.equal(localDateIso(), "2026-08-16"); // a Sunday
    assert.equal(weekMondayIso(localDateIso()), "2026-08-10", "Sunday 2026-08-16's week must start Monday 2026-08-10, six days earlier");
  });
});

test("3. Monday is the start of its own new week (the week→Monday rollover)", (t) => {
  withMockedNow(t, "2026-08-17T12:00:00Z", "UTC", () => {
    assert.equal(localDateIso(), "2026-08-17"); // a Monday
    assert.equal(weekMondayIso(localDateIso()), "2026-08-17", "Monday must be its own week start, not the previous week's");
  });
});

test("4. a week that spans a month boundary (Mon 2026-08-31 -> Sun 2026-09-06) resolves correctly from either side", (t) => {
  withMockedNow(t, "2026-09-01T12:00:00Z", "UTC", () => {
    assert.equal(localDateIso(), "2026-09-01"); // a Tuesday, in September
    assert.equal(weekMondayIso(localDateIso()), "2026-08-31", "the week containing Sept 1 starts in August");
  });
});

test("5. a week that spans a year boundary (Mon 2026-12-28 -> Sun 2027-01-03) resolves correctly", (t) => {
  withMockedNow(t, "2027-01-01T12:00:00Z", "UTC", () => {
    assert.equal(localDateIso(), "2027-01-01"); // a Friday, New Year's Day
    assert.equal(weekMondayIso(localDateIso()), "2026-12-28", "the week containing Jan 1 2027 starts in December 2026");
  });
});

test("6. local date ahead of UTC date (late evening UTC, timezone far east of UTC) uses the LOCAL day, not the UTC day", (t) => {
  // 2026-08-20T23:30 UTC: in Kiritimati (UTC+14) local time has already
  // rolled over to 2026-08-21.
  withMockedNow(t, "2026-08-20T23:30:00Z", "Pacific/Kiritimati", () => {
    const utcDate = new Date().toISOString().slice(0, 10);
    assert.equal(utcDate, "2026-08-20");
    assert.equal(localDateIso(), "2026-08-21", "the local calendar date is a day ahead of the UTC date here");
    assert.equal(weekMondayIso(localDateIso()), "2026-08-17", "the week must be computed from the local date (Fri 08-21), not the UTC date (Thu 08-20) - same week here, but the source date must be local");
  });
});

test("7. local date behind UTC date (late evening UTC, timezone far west of UTC) uses the LOCAL day, not the UTC day", (t) => {
  // 2026-08-17T23:30 UTC (a Monday in UTC): in Honolulu (UTC-10) local time
  // is still 2026-08-17T13:30 the PREVIOUS day is not it here - pick an
  // instant where UTC has already crossed into Monday but Honolulu has not.
  withMockedNow(t, "2026-08-17T05:30:00Z", "Pacific/Honolulu", () => {
    const utcDate = new Date().toISOString().slice(0, 10);
    assert.equal(utcDate, "2026-08-17"); // UTC already Monday
    assert.equal(localDateIso(), "2026-08-16", "Honolulu (UTC-10) local calendar date is still Sunday when UTC has already turned Monday");
    assert.equal(weekMondayIso(localDateIso()), "2026-08-10", "must use the LOCAL Sunday (still last week) not the UTC Monday (would wrongly jump to the new week a day early)");
  });
});

test("8. todayWeekIndex picks the week for today's LOCAL date even when that's a DIFFERENT week than the UTC date", (t) => {
  // 2026-08-17T05:30 UTC is already Monday in UTC (week starting 08-17),
  // but Honolulu (UTC-10) local time is still Sunday 08-16 (the PREVIOUS
  // week, starting 08-10) - a UTC-based implementation would pick the wrong
  // week entirely here, not just the wrong day within the same week.
  withMockedNow(t, "2026-08-17T05:30:00Z", "Pacific/Honolulu", () => {
    const weeks = [
      { weekStart: "2026-08-10", days: [{ date: "2026-08-16" }] }, // contains the correct LOCAL date
      { weekStart: "2026-08-17", days: [{ date: "2026-08-17" }] }, // contains the WRONG UTC date
    ];
    assert.equal(localDateIso(), "2026-08-16");
    assert.equal(todayWeekIndex(weeks), 0, "must land on the week containing the local date (index 0), not the UTC date (index 1)");
  });
});
