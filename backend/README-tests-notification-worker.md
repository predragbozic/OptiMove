# Tests notifications worker (Phase 3A)

A periodic, idempotent job that generates WELLNESS occurrences/assignments
and sends the four in-app notification kinds (`athlete_invitation`,
`athlete_reminder`, `coach_digest`, `final_digest`) without anyone needing to
open the Tests page. See `backend/src/testsNotificationWorker.js` for the
actual logic and `backend/src/testsNotificationWorkerCli.js` for the CLI
wrapper.

## Running it manually, once

```bash
cd backend
npm run tests:notifications:worker
```

This runs exactly one cycle against whatever `DATABASE_URL` is set in your
environment (see `backend/.env` / `.env.example`), prints a JSON summary to
stdout, and exits. It is a normal one-shot Node script - nothing about it
stays running afterward.

## Recommended interval

**Every 5 minutes.** This is frequent enough that:

- an occurrence opens (and its invitation goes out) within 5 minutes of its
  real `opens_time`,
- a reminder fires within 5 minutes of its real trigger time
  (`due_at`/`closes_at` minus the configured offset),
- the coach's live completion digest stays reasonably current while an
  occurrence is open,

without running so often that it meaningfully increases database load. There
is nothing special about 5 minutes specifically - it is a reasonable default,
not a hard requirement of the code itself.

## Required environment variables

- `DATABASE_URL` - same connection string the web server and `migrate.js`
  already use. The worker opens its own short-lived `pg.Pool` (not the web
  server's pool - the worker is a separate process) and closes it when the
  cycle finishes.

No other environment variables are required. The worker never makes any
outbound network call (no email/SMS/push - see "Out of scope" below) - it is
DB-in, DB-out.

## What happens if two runs overlap

The CLI takes a **non-blocking** `pg_try_advisory_lock` before doing any
work (lock key `822027`, distinct from `migrate.js`'s own `822026`). If a
previous cycle is still running when the next scheduled run starts:

- the second invocation sees the lock is held, does **no work at all**, and
  exits 0 with `{ "ok": true, "skipped": true, "reason": "another worker
  cycle is already running" }`.
- it does **not** wait, retry, or queue - the run it skipped is fully
  covered by the cycle that's already in progress (or, if that one is
  unusually slow, by the very next scheduled invocation after it finishes).

This is safe by construction, not just by the lock: every phase of the
worker (occurrence generation, invitations, reminders, both digests) is
idempotent - a normal run that overlaps due to a slow prior cycle, if it
somehow raced past the lock, still wouldn't create duplicates, since every
send is deduplicated at the database level (`dedupe_key` unique constraint
on `tests.test_schedule_notification_dispatches`). The advisory lock exists
to avoid *wasted* concurrent work, not to prevent duplicates - duplicates
are already structurally impossible.

## Reading the summary (processed / sent / skipped / failed)

Every run prints one JSON object, e.g.:

```json
{
  "ok": true,
  "skipped": false,
  "startedAt": "2026-08-25T09:00:00.000Z",
  "occurrences": { "schedulesChecked": 4, "generated": 1, "skipped": 3 },
  "invitations": { "attempted": 12, "sent": 3, "alreadySent": 8, "noRecipient": 1, "failed": 0 },
  "reminders": { "attempted": 5, "sent": 1, "alreadySent": 4, "noRecipient": 0, "failed": 0 },
  "coachDigests": { "attempted": 4, "sent": 1, "unchanged": 3, "failed": 0 },
  "finalDigests": { "attempted": 1, "sent": 1, "alreadySent": 0, "failed": 0 },
  "errors": [],
  "finishedAt": "2026-08-25T09:00:01.240Z",
  "durationMs": 1240
}
```

- **`occurrences`** - how many active schedules were checked this cycle,
  how many newly generated an occurrence (their `opens_time` had just
  arrived), and how many were skipped (not due yet, or lost a race to a
  concurrent edit/delete - never an error either way).
- **`invitations` / `reminders`** - `attempted` is every eligible
  assignment the cycle looked at; `sent` is how many actually got a new
  notification this cycle; `alreadySent` is how many were correctly
  skipped because a prior cycle already sent them; `noRecipient` is athletes
  with no linked user account (reported, never a crash); `failed` is
  per-recipient errors that were caught, logged, and skipped without
  aborting the rest of the cycle.
- **`coachDigests`** - `sent` here means "the notification's text actually
  changed and was written" (first send or a real update); `unchanged` means
  the computed counts were identical to what's already showing, so nothing
  was touched (no wasted write, no read-state reset).
- **`finalDigests`** - same shape as invitations/reminders, but always
  one-shot per occurrence.
- **`errors`** - an array of `{ stage, occurrenceId, scheduleId?,
  assignmentId?, message }` entries for anything that failed and was
  skipped rather than aborting the cycle. An empty array is the normal,
  healthy case. The CLI exits with code `1` (instead of `0`) whenever this
  array is non-empty, specifically so an external scheduler's own
  failure-alerting can key off the process exit code without having to
  parse the JSON body itself.

## How to safely retry

Just run it again - `npm run tests:notifications:worker`. Every phase is
designed to be re-run from a cold start with no special flags or cleanup:

- Occurrence generation only ever generates what's missing (idempotent by
  construction - the same underlying service Today/check-in already use).
- Invitation/reminder/final-digest sends are claimed via
  `insert ... on conflict (dedupe_key) do nothing` - a retry after a crash
  mid-send finds nothing to redo for anything that already fully committed,
  and cleanly re-attempts anything that didn't (a crash before commit rolls
  the whole attempt back automatically - there is no way for a dispatch row
  to exist without a real notification behind it, or vice versa).
- The coach live digest is upserted, not appended - re-running never creates
  a second notification for the same occurrence/recipient, and never
  rewrites it unless the computed counts actually changed.

If a single recipient failed on the previous run (visible in that run's
`errors` array), running the worker again will naturally re-attempt exactly
that recipient - no manual bookkeeping needed.

## Render Cron / deployment status

**Not configured yet.** No Render Cron Job, GitHub Actions schedule, or any
other scheduler has been wired up to actually invoke this worker on a
recurring basis - that is a deliberate, separate follow-up, out of scope for
this phase. Until it exists, `npm run tests:notifications:worker` only runs
when someone (a person, or a future scheduler) invokes it directly.

## Out of scope for this phase

The worker only ever writes to `public.app_notifications` (the app's
existing generic in-app inbox, already read by the notification bell in the
UI). It never sends, and this phase never adds:

- email
- web/mobile push notifications
- SMS
- WhatsApp/Viber messages
- a "magic login" link for a notification recipient

These may be layered on top of `public.app_notifications` in a future phase,
but nothing in this worker assumes or depends on any of them existing.
