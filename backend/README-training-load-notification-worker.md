# Training load (external RPE) notifications worker

A periodic, idempotent job that generates `training_load.external_*`
occurrences/assignments and sends three in-app notification kinds
(`training_load_external_invitation`, `training_load_external_reminder`,
`training_load_external_final_digest`) without anyone needing to open the
Training Load page. See `backend/src/trainingLoadNotificationWorker.js` for
the actual logic and `backend/src/trainingLoadNotificationWorkerCli.js` for
the CLI wrapper. Structurally a copy of `testsNotificationWorker.js`'s own
shape - see `backend/README-tests-notification-worker.md` for the sibling
job this mirrors.

Each of the three notification kinds is now genuinely per-schedule
configurable (`training_load.external_schedule_notification_rules`, exposed
in the "New RPE session" form's own Notifications section) - a coach can
turn any one of them off, and set the reminder's own offset, per schedule.
A schedule with no configured rows for a given kind (created before this
config existed, or via a raw fixture that bypassed the real create route)
is read as **enabled**, matching this worker's own original always-on
behavior - nothing silently goes quiet just because this migration ran.

## Running it manually, once

```bash
cd backend
npm run training-load:notifications:worker
```

This runs exactly one cycle against whatever `DATABASE_URL` is set in your
environment (see `backend/.env` / `.env.example`), prints a JSON summary to
stdout, and exits.

## Recommended interval

**Every 5 minutes** - the same cadence already recommended for the sibling
WELLNESS worker, for the same reasons: frequent enough that an occurrence
opens (and its invitation goes out, if enabled) within 5 minutes of its real
`opens_time`, and a reminder/final-digest fires within 5 minutes of its real
trigger time, without running so often that it meaningfully increases
database load. Nothing about 5 minutes is a hard requirement of the code
itself.

## Required environment variables

- `DATABASE_URL` - same connection string the web server and `migrate.js`
  already use. The worker opens its own short-lived `pg.Pool` (a separate
  process, not the web server's own pool) and closes it when the cycle
  finishes.

No other environment variables are required - no outbound network call of
any kind (no email/SMS/push), DB-in, DB-out.

## What happens if two runs overlap

The CLI takes a **non-blocking** `pg_try_advisory_lock` before doing any
work (lock key `822028`, distinct from `migrate.js`'s own `822026` and the
Tests worker's own `822027`). A second invocation while a prior cycle is
still running sees the lock held, does no work at all, and exits 0. Safe by
construction beyond just the lock, too - every phase (occurrence generation,
invitation, reminder, final digest) is idempotent, and every send is
deduplicated at the database level (`app_notifications.dedupe_key`).

## Render Cron / deployment status

**Not configured yet, in this branch.** No Render Cron Job, GitHub Actions
schedule, or any other scheduler has been wired up to invoke this worker on
a recurring basis - that is a deliberate, separate, out-of-scope-for-this-
branch follow-up (no merge, deploy, or production migration happens here).
Until a scheduler exists, `npm run training-load:notifications:worker` only
runs when someone (a person, or a future scheduler) invokes it directly -
**the "New RPE session" form's own Notifications section must never be
read, in a production deployment, as a guarantee that these messages will
actually go out on a schedule** until this step is done.

### Exact post-deploy step (once this branch is merged and deployed)

Create a Render **Cron Job** (Render dashboard -> New -> Cron Job) pointed
at this same repo/branch, with:

- **Command:** `cd backend && npm run training-load:notifications:worker`
- **Schedule:** `*/5 * * * *` (every 5 minutes - see "Recommended interval"
  above)
- **Environment:** the same `DATABASE_URL` the web service itself already
  uses (point it at the same Render Postgres instance/connection string -
  never a different database).

No code change is required to wire this up - the CLI already reads
`DATABASE_URL` from its environment and exits cleanly (`0` on a healthy run
with no errors, `1` if `summary.errors` is non-empty, so the Cron Job's own
failure-alerting can key off the process exit code).

## Out of scope for this phase

The worker only ever writes to `public.app_notifications` (the app's
existing generic in-app inbox). It never sends, and this phase never adds,
email/push/SMS/WhatsApp - see `backend/README-tests-notification-worker.md`
for the fuller rationale, identical here.
