# A team's session time zone (migration v62, mixed_timezones (b))

Migration: `migrations_v2/202611111200_training_load_v62_team_session_timezone.sql`.
Preflight: `team-session-timezone-v62-preflight.sql` · post-check: `team-session-timezone-v62-postcheck.sql` ·
rollback: `team-session-timezone-v62-rollback.sql` (all read-only except the rollback; rehearsed in
`backend/tests/team-session-timezone-v62.test.mjs`).

## Why

A GPEXE session whose GPS units report more than one time zone (for example one unit set up abroad) was refused
(`mixed_timezones`): the event's date, time and name need one zone. On 2026-11-11 the owner decided (relayed by the
*Rukovodilac*):

- option A2: a team's session time zone in its own table, not a column on `gpexe_team_settings` (v24's guard on that row
  would cancel a write that changes only the zone);
- First team's zone is **Europe/Sarajevo**;
- the team's zone applies **only when the zones are mixed**. A session whose units agree keeps its own zone, so an away
  match keeps its real local time.

## What changes

- **The importer** (`buildGpexeImportPlan(bundle, { teamTimezone })`): for a mixed session with the team's zone set, the
  event's zone, date and name come from the team's zone; each participant keeps its own track's zone, as before. Without
  the zone the session is refused as before. A single-zone session is byte for byte what it was, so its preview hash and
  any imported event are unchanged.
- **The preview** of such a session carries `session.timezone`, `session.timezoneSource = "team"` and
  `session.trackTimezones`; the review says which zone was used and why. A single-zone session's preview has none of them.
- **The writer** is unchanged. A session imported as single-zone that is later re-sent with a track in another zone maps
  to the team's zone; if that differs from the stored event zone the writer refuses with `event_changed` (needs review),
  never a silent move.
- **Who sets it:** a platform admin, in Settings > Data sources, next to the GPEXE pair, with a mandatory reason
  (`GET` / `PUT /api/training-load/gpexe/teams/:teamId/session-timezone` with `{ timezone, reason }`; `timezone: null`
  clears it). A coach and a club admin get the settings' 403; another, missing or archived team the identical 404.
- **Concurrency:** the write takes the team's import lock (`lock_timeout` 3 s, then `409 gpexe_change_busy`), and the
  database trigger holds it too (`hold_gpexe_team_lock`), so a zone never changes under a running check, preview or
  approval of that team. Every importer path reads the zone under that lock.
- **The database:** the zone must be one PostgreSQL knows (`pg_timezone_names`); the team of a row is final; a row is
  never deleted (clearing writes NULL); every value is kept in `gpexe_team_session_timezone_history` (append-only, no
  TRUNCATE). No existing table, function or trigger changes, so there is no md5 gate.

## Deploy

1. The *Rukovodilac* runs the preflight (each block in a read-only transaction): all `ok` true. Block 6 reports how many
   candidates are blocked by mixed zones today.
2. The owner's order naming the migration file; the merge; the deploy.
3. The post-check: all `ok` true, no zone row yet.
4. A platform admin sets First team's zone to Europe/Sarajevo in Settings > Data sources, with a reason.
5. A search of the blocked session's dates previews it through the team's zone; the coach reviews and imports it as any
   other session.

## Rollback

`team-session-timezone-v62-rollback.sql` drops the two tables and four functions and the v62 record. It refuses while the
migrator runs, without v62 or under a later migration, and once any zone or history row exists. A session imported
through the team's zone keeps that zone on its event either way. Before running it: a fresh restore-verified backup, a
deployed commit without the v62 file and without the code that reads the table, and the owner's approval for that database.
