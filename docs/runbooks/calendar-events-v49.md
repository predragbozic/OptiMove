# Runbook: migration v49 — the central calendar's events (K2a-1a)

Plan and decisions: `docs/ai/central-calendar-k2a-plan.md` (sections 1.2, 4, 6 and 10; the owner's D18–D23 of
2026-10-30, the manager's technical decisions the same day).

- **v49** (`migrations_v2/202610311000_calendar_v49_events.sql`) creates the schema `calendar` with seven tables, the
  helper functions, the triggers and the writer lock:
  - `event_types` — the catalog (D4, D9): seven `system` rows and a copy of them per active club
    (`calendar.seed_club_event_types(club)`, also called by `POST /api/organization/clubs` for a new club); no row is
    updated until Settings → Calendar exists (K2b drops that guard trigger); a system row is never deleted; a club's
    unused copy goes with its club, a copy in use is kept by the events' foreign key.
  - `events` — owner club / team / user (never system), type, title, `day` and optional `end_day` (D22), optional times,
    IANA `timezone`, `location`, `status` planned / cancelled with the cancel facts, `expects` (D15, D19), `notes`,
    optional references to one external schedule (FK) and one test schedule (trigger-checked, see below),
    `revision`.
  - `event_targets` — athlete / team / club inside the owner, enforced by trigger whoever writes; at least one target
    at COMMIT (deferred constraint triggers).
  - `event_session_links` (the Builder link by slot key) and `event_activity_links` — tables only in K2a-1a; the attach
    commands are K2a-1b.
  - `event_requests` (the `requestKey` record) and `event_changes` (the change log): append-only; a request without
    its change row cannot be committed.
  - `calendar.lock_event_writer(user, owner_scope, owner_id, basis)` — the v25 / v26 pattern and order: the owner
    team, then its club, then the role row the basis rests on, then the acting user's row, all `FOR SHARE`; `42501`
    otherwise. Bases `platform_admin` (any owner, a private coach's events included — support), `club_admin` (the
    owner club, or the owner team's club — D18), `team_coach`, `private_coach`. An archived owner takes writes from
    the next level up only (plan 4.1): an archived team of an active club through `club_admin` or `platform_admin`,
    never `team_coach`; an archived club through `platform_admin` only — so an archived team's or club's events can
    still be cancelled, and nothing can be created for them.
  - No existing table, column, row or trigger is changed. The only writes outside the new schema: none.
- **The code** (one release with v49): `POST / PATCH /api/calendar/events`, `POST …/:id/cancel`, `GET …/types`,
  `GET …/:id` (`backend/src/routes/calendarEvents.js`, `calendarEventService.js`, `calendarEventAccess.js`); events
  as `kind: "event"` items of `GET /api/calendar` and the athlete's reduced view (D21) (`calendarQuery.js`,
  `calendarAccess.js`); the club seed on `POST /api/organization/clubs`.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets a database without v49. While
v49 is applied and the old server still serves during the deploy, the old server has no event route (`404`) and its
calendar read does not know the schema; nothing of the old server writes to it.

**Rules the database keeps whoever writes** (every one hit raw by `backend/tests/central-calendar-k2a-events.test.mjs`):
an event is never deleted and a cancelled event is final (its targets too); the owner is write-once; every write of
an event bumps `revision` by exactly one and needs, at COMMIT, its change row at that revision — and every request
row needs its change row; a target is inside the owner (an active team of the club, the club itself, a member of the
club or team by the v25 periods, a private coach's own `coach` athlete); at least one target at COMMIT; one live link
per plan slot and per activity; one planned event per referenced schedule; the catalog is read-only (`UPDATE`) until
K2b; every table refuses `TRUNCATE`. A type's or a schedule's reference is validated when it is set or changed, never
again on a later write: a test schedule the Tests module deleted, or a team moved to another club, never makes an
event uncancellable (the calendar read then shows the event alone).

**A club archived before v49** has no seeded event types (the seed copies the system set for every ACTIVE club). No
application route reactivates a club; a direct database reactivation would also need
`select calendar.seed_club_event_types(<club id>)` (idempotent by seed key), on the owner's order only.

**A club's hard delete.** The application only archives clubs. A hard delete (maintenance; the shared test suites'
cleanup) cascades the club's unused type copies; a club with events or with a type in use is stopped by the events'
own `RESTRICT` foreign keys, as it is by its schedules today.

**Known limits, recorded:** the link tables' triggers check the event's state and the plan's / activity's existence,
not that the plan or activity belongs to the event's owner — K2a-1b's commands check it, and K2a-1b adds the
at-COMMIT pairing of a link write with its change row; the `calendar` CHECKs call `training_load.source_metric_text_ok`,
so a later `create or replace` of that function must keep its contract for these columns too (v40's fail-closed block
names only its own columns); no `idle_in_transaction_session_timeout` is set for the event commands (as for the roster
commands).

**Why `test_schedule_id` has no foreign key.** The shared disposable test fixture (`backend/tests/_gpexe-disposable-db.mjs`)
carries no Tests schema; an FK to `tests.test_schedules` would stop every suite that applies the whole migration
list. The reference is checked by the `events_before_write` trigger at write time (the row must exist, and the
event's kind must be `test`), so the database still refuses a dangling reference whoever writes. A deleted test
schedule (the Tests module deletes a schedule without occurrences, `routes/tests.js`) leaves the event's reference
pointing at nothing; the calendar read then shows the event alone.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs
them there.

## Before the merge

The same day as the merge and deploy:

1. Run `docs/runbooks/calendar-events-v49-preflight.sql` one block at a time. Every value must be the expected one:
   - block 1 shows PostgreSQL 15 or later (`unique nulls not distinct`);
   - block 2 shows v48 (`202610301900_training_load_v48_mapping_activations.sql`, PR #295, the last migration before this one) recorded with the repository's checksum and no v49;
   - block 3 shows no `calendar` schema and none of its objects;
   - block 4 shows the tables and functions v49 references (`training_load.external_schedules`,
     `training_load.source_metric_text_ok`, `public.athlete_membership_periods`, `tests.test_schedules`,
     `training.activities`, `plans.plans`, `plans.plan_days`, `plans.plan_sessions`);
   - block 5 shows the migrator's role may create a schema;
   - block 6 records the number of active clubs (the post-check expects seven types per club);
   - block 7 must show a quiet moment (no other migration running, no lock on the referenced tables).
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request, the exact file
`migrations_v2/202610311000_calendar_v49_events.sql` and its sha256 (given in the pull request), with this preflight
the same day.

## Deploy order

1. The owner's preflight the same day.
2. The owner's order naming the pull request, the v49 file and its sha256.
3. The merge from exactly the reviewed head.
4. The deploy, started by the owner by hand.
5. `/api/health` serving the merge commit with `ok: true` three times; without a login `GET /api/calendar/events/types`,
   `GET /api/calendar/events/<zero uuid>`, `POST /api/calendar/events` (`{}`), `PATCH …/<zero uuid>` and
   `POST …/<zero uuid>/cancel` answer `401`; `GET /api/calendar?from=&to=` answers `401`.
6. The owner's read-only post-check, `docs/runbooks/calendar-events-v49-postcheck.sql`, one block at a time:
   - block 1: v49 recorded once with the repository's checksum, the last migration;
   - block 2: the seven tables, the functions and the triggers, every trigger enabled;
   - block 3: the seed — exactly seven `system` types and seven per active club, no other row;
   - block 4: no event, target, link, request or change row (nothing was written by the deploy);
   - block 5: no lock, no idle transaction on the new tables;
   - block 6: the Data API's roles hold no privilege on the `calendar` schema;
   - block 7: every active club has its seven types — a club the old server created during the deploy window has
     none, and the block names the idempotent repair (the seed function), to be run on the owner's order only.

## Rollback

`docs/runbooks/calendar-events-v49-rollback.sql` drops the schema `calendar` and the v49 record, in one transaction
with a 10 s `lock_timeout`. It first takes the migrator's advisory lock (refused while a migration runs), checks that
v49 is recorded, locks the seven tables `ACCESS EXCLUSIVE` in the writers' order, and then refuses once a later
`migrations_v2/` migration is recorded, while any event, target, link, request or change row exists, or while the
catalog holds a row that is not the seed as this file wrote it (a K2b edit). Rehearsed on a disposable database in
`backend/tests/central-calendar-k2a-events.test.mjs` (test 1b: apply → rollback → the catalog digest of the database before v49 identical →
re-apply, and every refusal). After a rollback the code of this release must not serve: the old server (before this
pull request) is the matching one.
