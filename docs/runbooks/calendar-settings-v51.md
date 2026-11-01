# Runbook: migration v51 — Settings → Calendar (K2b-1a)

Plan and decisions: `docs/ai/central-calendar-k2b-plan.md` (sections 2, 3, 6, 13 and 16; the owner's D28–D39 of
2026-11-01 and the manager's T1–T6).

- **v51** (`migrations_v2/202611011900_calendar_v51_settings.sql`) changes v49's objects without editing v49's file
  and adds nine tables to the schema `calendar`:
  - `event_types`: K2a's read-only guard (`event_types_k2a_read_only`) is dropped; `color_key` (the closed palette of
    twelve, `calendar.color_key_ok()`) and `revision` are added; the seven seeded types get today's kind icons; the
    `system` set is final (D35); `key` and the creation facts are write-once; a club keeps at least one live type.
  - `event_fields` (the details library, `system` + a copy per club), `event_field_options`, `event_type_fields` (a
    type's default details), `event_selected_fields` (one event's details — K2b-1b writes it), `event_field_values`
    (the coach's values — K2b-1b), `locations` (a club's places, D27), `team_settings` (a team's colour and default
    place), `settings_requests` and `settings_changes` (the catalog's request record and change log).
  - `events.location_id` (a library place) beside the one-off `location` text — never both.
  - v49's `event_requests.operation` and `event_changes.kind` CHECKs gain `set_fields` (K2b-1b) and `align_sessions`
    (T1: the standalone alignment is now audited with its own kind).
  - `calendar.seed_club_event_types(club)` is replaced: it also copies the details, their options and the types'
    lists. `POST /api/organization/clubs` keeps calling it, so the server that still runs during the deploy seeds a
    new club completely.
  - Rows written outside the `calendar` schema: none.
- **The code** (one release with v51): `GET /api/calendar/settings` and its writes
  (`backend/src/routes/calendarSettings.js`, `calendarSettingsService.js`); the calendar's one command runner
  (`calendarCommandRunner.js`, the event commands use it too); `GET /api/calendar/events/types` answers, additively,
  each type's `colorKey` and live `defaultFieldIds`, the workspace's `fields`, `locations` and `teamDefaults`;
  `GET /api/calendar`'s `teams[]` carry `colorKey`; an event's type is read `FOR SHARE` on create and edit.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`);
`npm start` runs the migrations before the server. **Lock footprint:** from its first statement to its COMMIT (expected
a few seconds: the seed is ten details, seventeen options and thirteen list entries per active club) v51 holds SHARE ROW
EXCLUSIVE on `public.clubs` (taken first, so no club is created meanwhile and `POST /clubs` cannot deadlock with it),
ACCESS EXCLUSIVE on `calendar.event_types`, `calendar.events`, `calendar.event_requests` and `calendar.event_changes`,
and SHARE ROW EXCLUSIVE on the tables its new foreign keys reference (`users`, `teams`, `locations`' and the catalog's
own); the old server's calendar traffic and writes to those tables queue behind it, and `lock_timeout = 5s` makes the
migration fail rather than queue behind a long transaction (preflight block 7 is the quiet-moment check). While v51 is applied and the old server still serves during the
deploy: its calendar reads and event writes work on v51 (no column they read or write changed; `events.location_id`
is null; the align command still writes `update`, which the widened CHECK keeps); it has no settings route (`404`).

**Rules the database keeps whoever writes** (each hit raw by `backend/tests/central-calendar-k2b-settings.test.mjs`):

- **The meaning freeze** (the owner's rule): once a detail has a value — a cleared one included, values are never
  deleted — its `label`, `unit`, `min_value`, `max_value` and its options' labels never change
  (`event_fields_answered_frozen`); `required`, `description`, a new option and hiding or showing an option (D30) stay
  allowed. A value writer holds the detail `FOR SHARE`, the detail's editor `FOR UPDATE`, so the two serialize.
- **Inside the owner:** a type lists its own owner's live details; an event takes its owner's details (a club or team
  event: the club's; a private coach's: the `system` set); a value only for a chosen detail, of its kind, inside its
  bounds, with a live option of that detail when set; a library place of the event owner's club (a private coach's
  event: none), live when set; a team's default place of the team's club, live when set.
- **Never deleted:** a club's type, detail or option is deleted only together with its club (a hard delete —
  maintenance and the shared test suites' cleanup, as v49); a place, a team setting and a value never. Every new table
  refuses `TRUNCATE`.
- **The audit at COMMIT:** every update of a type, detail, place or team setting bumps its `revision` by one and needs
  its `settings_changes` row at that revision, of the request's club; a request needs a change; an option or a list
  entry needs its parent written in the same transaction, and an event's chosen detail or value needs the event
  written (v49 then requires its change row).
- **Archive, never delete** (D37): an archived type, detail, option or place leaves every picker and stays where it is
  (an event keeps its type and place, a type its listed details, a value its option).

**Known limits, recorded:**
- A raw insert made in the seed's shape (`seed_key` set, `created_by_user_id` null) needs no change row, and an option
  or a list entry of a copy still exactly as seeded (revision 1) needs no parent write — what
  `seed_club_event_types` writes. No route writes either. Consequences (db review of K2b-1a, F4): a raw writer can add a
  `system` type, detail or option in the seed's shape (private coaches see it at once, and every later club copy takes
  it) — D35's "final" holds for updates, deletes and inserts in any other shape; the exception is keyed on the parent's
  state, so a raw update or delete of an option or a list entry of an unedited seeded copy is unaudited too; a `system`
  list entry is refused even in the seed's shape, so a later migration that adds one disables that trigger inside its
  own transaction. As for v35, there is no defence against whoever holds the application's database role.
- The guards that count or look for other rows (a club keeps one live type; a detail with values) assume READ COMMITTED,
  the application's isolation: a raw writer at REPEATABLE READ or SERIALIZABLE whose snapshot predates a concurrent
  write is outside their guarantee (the v31 note's rule).
- The pairing of a child row reads the parent's `xmin`: a write inside a savepoint carries a subtransaction's xid and
  is refused (fail-closed; no application path uses one).
- A club that was archived before v51 (or v49) and is made active again by a direct database write has no copies:
  `select calendar.seed_club_event_types('<club id>')` (idempotent by seed key), on the owner's order only.
- An address correction shows on every event of that place, past ones included (D34).
- The seeded types' `updated_at` changed with their icons; the rollback does not restore it.
- `calendar.color_key_ok()` holds the palette; a new colour is a later migration's `create or replace`, together with
  `backend/src/calendarColors.js` and the frontend's palette.

## Before the merge (owner or manager, read-only)

Run `docs/runbooks/calendar-settings-v51-preflight.sql` block by block in the Supabase SQL Editor. Every expected value
is in the file. Block 2 names the last migration (v50); block 3 proves the catalog is still exactly v49's seed (the
read-only guard in place, no icon); block 5 records the number of active clubs for the post-check; block 7 is the
quiet moment.

## After the deploy (read-only)

Run `docs/runbooks/calendar-settings-v51-postcheck.sql`. Expected: v51 last and once with its checksum; 16 tables, 48
functions, 61 triggers, none disabled, the read-only guard gone; ten system details, seventeen options, thirteen list
entries, every active club complete, every type with its icon; nothing written by the deploy; no lock; no Data API
grant; no club without details.

## Rollback (owner's order only)

`docs/runbooks/calendar-settings-v51-rollback.sql`, one transaction. It refuses while the migrator holds its lock,
when v51 is not recorded, when a later migration is recorded, and when any row depends on v51 (a settings request or
change, a club-made, changed or archived type or detail, a non-seed or hidden option, a place, a team setting, a
chosen detail or a value, an event with a library place, a request or change of kind `set_fields` or
`align_sessions`). Otherwise it drops v51's objects, restores v49's CHECKs, v49's `seed_club_event_types` and v49's
read-only guard verbatim, puts the icons back to null and deletes v51's record; the catalog digest is then v50's
(rehearsed in the suite's test 1b). The code of the K2b-1a release must not serve after it: deploy the previous
release first.
