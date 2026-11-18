# Runbook — migration v81: Ask athletes and "Skip days off" (K2b-2a-1)

File: `migrations_v2/202611191000_calendar_v81_athlete_questions.sql` (sha256 at the time of writing
`8fca6f4922be3d9b505818f09c870d28ccb23ace1152b2fdc02f0861f8bc178a`; the pull request names the final one). Plan: `docs/ai/central-calendar-k2b2-plan.md`, section 9.1 and
the manager's GO 9.1.13. Scripts beside this file: `calendar-questions-v81-preflight.sql`,
`calendar-questions-v81-postcheck.sql`, `calendar-questions-v81-rollback.sql`.

## What it does

- **New tables (`calendar`):** `club_question_settings` (the club's switch; no row = off),
  `event_questions` (an event's RPE / WELLNESS question, through a Training Load external schedule or a Tests
  schedule), `question_postponements` (the athlete's *Later*, append-only, its own request record),
  `question_assignment_skips` (a WELLNESS assignment made or turned `cancelled` because a Day off or an event's
  own WELLNESS covers the day).
- **New columns:** `calendar.event_types.default_questions` (null = derived from `default_expects`),
  `tests.test_schedules.skip_days_off` (default false; true only for a daily schedule),
  `calendar.settings_changes.subject_club_id` (the switch's change rows).
- **Widened CHECKs:** the event runner's operations gain `ask_question`, `remove_question`, `move_question`;
  the settings runner's gain `questions_switch` (subject `club`).
- **Replaced bodies (md5 preconditions in the file):**

  | Function | md5 before | md5 after |
  |---|---|---|
  | `tests.materialize_test_assignments_for_occurrence(uuid)` | `2d961f5acd6c6309baa51de868773ba4` | `15a79e10b95ef31b30286935f28b7db5` |
  | `calendar.settings_changes_before_insert()` | `75ed99731f6d61d19a8f0c2e473fedd1` | `b4189ddb507e607263ee6cb89760a891` |

  It also checks, without replacing it, that `calendar.lock_event_writer` is v54's body (`7ebf1bcf39cbb930fb913d89f25fd406`).
- **No row is written** (a fail-closed self-check at the end). After the deploy the switch is off everywhere and
  nothing of the feature shows.

## Dependencies (never its position)

v49 and v51 (the calendar), Tests v42 phase 1, the lock fix and phase 4, Training Load v4, v5 and v7. v81 needs the
Tests schema. It does **not** assume it is the last migration: v75 and v78–v80 may or may not be recorded
(preflight block 7 only reports them).

## Order of work (the ★★ path, plan 9)

1. The OptiMove manager's gate and the independent review on the frozen head.
2. The owner's order naming the file.
3. **Preflight, the same day:** `calendar-questions-v81-preflight.sql`, one block at a time, read-only. Every
   value as its comment says; block 3 is the md5 of the bodies above (the manager reads them on production).
4. The merge, then the deploy (`npm start` runs the migrator before the server).
5. **Post-check:** `calendar-questions-v81-postcheck.sql`, read-only.

## Rollback

`calendar-questions-v81-rollback.sql`, only on an explicit owner order, after the previous release serves again.
It refuses (nothing dropped) while the migrator runs, without v81 recorded, when a later migration whose file name
contains `calendar` or `tests` is recorded or either replaced body no longer has v81's md5, and once any row
depends on v81 (a switch row, a question, a postponement, a skip row, a schedule with `skip_days_off`, a type with
`default_questions`, a request or change of the new operations). It restores both bodies (checked by md5) and the
four CHECKs, and deletes v81's record. Rehearsed by `backend/tests/central-calendar-k2b2-migration.test.mjs`
(apply → rollback → the catalog identical → re-apply; every refusal; a later `training_load` migration does not stop
it).

## Known limits

- A raw write that bypasses the services can still write a question row in a transaction that also bumps the event
  (the guards check the shape, the owner, the window and the switch, not who wrote it).
- The audience of the notifications is the calendar's rule on the window's day; the module schedules ask by their
  own rule (current memberships, frozen at the first materialization). The two agree except for a membership that
  changes between the ask and the day.
