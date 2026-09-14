# Testing evidence

What counts as "tested" and how to prove it — applies whenever a task's Definition of
Done includes test results.

## Order of operations

1. Run the fail-fast, targeted tests for exactly what changed first.
2. Then run the relevant regression scope (the module's suite, or the full suite for a
   cross-cutting change) and, if frontend was touched, the production build.
3. Only if a test fails: determine whether it's a regression from this change or a
   pre-existing failure (see below).

## Claims that require a real run

- **"Tests pass"** — state the exact command run and the exact pass/fail counts from
  actual output in this session. Never state this from memory or assumption.
- **UI / pointer / drag / resize / mobile claims** — a static code read (regex, grep,
  reading the file) is not evidence something works in a browser. These need an actual
  browser check (manual or automated) before being called correct.
- **Concurrency / race-condition claims** — if the protection is implemented at the DB
  level (e.g. a sanctioned function that locks a row before checking), that's the
  authoritative guard; a route-level pre-check is an optimization for the common case,
  not a substitute. Don't claim a race is fixed just because a route checks first —
  confirm the DB-level lock/constraint exists behind it.
- **Cross-workspace / access claims** — verify actual behavior (test or browser), not
  "the route looks like it has a check." A wrong/foreign resource id should produce the
  same response as a nonexistent one (info-hiding 404) — don't claim that's proven
  without a test or a live check that confirms it.

## Baseline regression (only when something fails)

Run this only to answer "did my change cause this, or was it already broken" — not for
an all-green run, which needs no baseline.

- Isolated, uniquely-named, detached worktree from the exact `origin/main` ref (see
  `git-safety.md` for the exact command and cleanup requirement).
- If the same failure reproduces identically on that clean baseline, it's pre-existing —
  say so explicitly, with the command and output that proves it, and don't fix it as part
  of an unrelated task's scope unless asked.
- If it does NOT reproduce, it's a regression from the current change — fix it before
  calling the task done.
- Never label something "pre-existing" without having actually run this baseline check —
  a guess based on "this file wasn't in my diff" is not the same as a reproduced baseline
  failure.

## Delivery report

Any report that claims tests were run must include the exact command(s) and the exact
pass/fail numbers from that session's actual output — not a remembered or estimated
count, and not a number carried over from a previous session without re-running.
