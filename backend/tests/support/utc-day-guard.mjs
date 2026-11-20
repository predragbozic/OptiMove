// A test file that fixes "today" once (as a UTC date) while the server it
// talks to reads the real clock (Postgres current_date, new Date()) must not
// run across UTC midnight: its TODAY would then be a day behind the server's,
// and an all-day window of "today" (00:00 - 23:59) closes in the day's last
// minute. Such a file awaits waitOutUtcMidnight() before it fixes TODAY.
//
// The guard only decides WHEN the file starts; nothing in the application's
// clock is changed. The clock is a parameter, so the decision itself is tested
// with times just before and just after midnight (utc-day-guard.test.mjs).

const DAY_MS = 86_400_000;

// How long a file must wait before it may fix TODAY: 0 when more than
// `marginMs` is left before the next UTC midnight, otherwise the time until
// `settleMs` after that midnight.
export function msToWaitBeforeUtcDay(nowMs, { marginMs = 5 * 60_000, settleMs = 5_000 } = {}) {
  const nextMidnight = (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS;
  const left = nextMidnight - nowMs;
  return left > marginMs ? 0 : left + settleMs;
}

export function utcDateOf(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// Waits out the last `marginMs` before UTC midnight, then returns the UTC date.
export async function waitOutUtcMidnight({ now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ...options } = {}) {
  const wait = msToWaitBeforeUtcDay(now(), options);
  if (wait > 0) {
    console.log(`[utc-day-guard] ${Math.ceil(wait / 1000)} s before UTC midnight is too close; waiting until it has passed.`);
    await sleep(wait);
  }
  return utcDateOf(now());
}
