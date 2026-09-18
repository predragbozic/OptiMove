# GPEXE import from the app — phase F1 (check, candidates, preview)

F1 lets a coach press **"Check now"**, see the GPEXE sessions of the team as
import candidates, and open a preview of what an import would write or change.
**F1 writes no result, no event and no activity.** Approving and importing a
candidate is phase F2; the screens are phase F3.

Code:
- `backend/src/gpexeClient.js` — the read-only GPEXE client;
- `backend/src/gpexeImportPreview.js` — the preview;
- `backend/src/gpexeImportService.js` — checks, candidates and retention;
- `backend/src/gpexeImportAccess.js` — who may do what;
- `backend/src/routes/gpexeImport.js` — the routes, under `/api/training-load/gpexe`;
- `backend/src/gpexeRetentionCli.js` — the retention CLI.

Schema: `migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql`.

Proof:
- `backend/tests/gpexe-in-app-import.test.mjs` — on a disposable database, through the real server;
- `backend/tests/gpexe-client.test.mjs` — no network.

## Environment

| Variable | Meaning |
|---|---|
| `GPEXE_API_TOKEN` | The GPEXE API token. It is kept **only in the server environment**: Render's environment settings, or the local `backend/.env`. It never goes into the database, the browser or a log. Without it, "Check now" answers 503 `gpexe_token_missing`. |
| `GPEXE_IMPORT_APPLY_ENABLED` | `true` allows an approved import to write results and activities in this environment (F2). **While it is off, "Check now" still writes its check record and the candidates.** The switch blocks writing results and activities, not every write to the database. The API reports its state and a sentence explaining it (`importSwitch`) with every candidate response, so the screens can say it. The deployed database gets `true` only after its provider backups and a restore on their side have been confirmed. |

The GPEXE host is fixed (`https://e03.gpexe.com/api/`). Requests are GET
only and redirects are refused, so the token cannot be sent anywhere else.
Personal fields the importer does not need are removed before anything is
kept: names on tracks, birth date, weight, picture, e-mail, notes, weather,
coordinates, who submitted a session, and roles.

## Setting up a team

1. **A platform admin** connects the OptiMove team to its GPEXE team
   (`PUT /teams/:teamId/settings {gpexeTeamId}`). One GPEXE team feeds at most
   one OptiMove team. Every value the setting ever had is kept in
   `gpexe_team_settings_history`.
2. **The team's coach** (or the club admin) links each GPEXE athlete to an
   OptiMove athlete of the team (`POST /teams/:teamId/athlete-links`).
   - A link is never guessed, and the athlete must be an active member of the
     team.
   - Unlinking keeps the row, so the history of who linked whom stays.
   - An unlinked GPEXE athlete is shown in the preview and left out of the
     import, with that reason.
3. **Approver grants.** Only a platform admin grants or revokes the right to
   approve GPEXE imports for a team
   (`POST /teams/:teamId/approvers {userId, reason}` and `.../revoke {reason}`).
   - It can be granted only to an active coach of that team.
   - The coach role alone never gives the right.
   - If the coach loses the role, the right ends even though the grant row
     stays.
   - Grants are never deleted; a revoke keeps who, when and why.
   - F1 only shows the right (`viewer.canApprove`). In F2 the approval checks
     it again, in its own transaction.

## Who may do what

| Action | Who |
|---|---|
| Status, "Check now", candidates, previews, athlete links | The team's coach, its club admin, a platform admin — in a workspace that contains the team. Anyone else gets the same 404 as a team that does not exist. |
| Connect the GPEXE team; grant and revoke approvers; read retention status | An active platform admin |
| Approve an import (F2) | An active platform admin, or a coach with an active grant for the team who still coaches it |

## What a check does

1. It purges expired raw snapshots first (see Retention).
2. It lists the team's parent sessions in the window. The default window is the
   last 14 days, and the maximum is 31.
   - Drills are part of their parent, not candidates of their own.
   - The list is read from one day earlier. That way a drill whose parent
     started the evening before is still recognized as a drill.
   - Lists are paged to the end.
   - A list that cannot be completed, or a session that claims more than 30
     drills, fails the check with a stable code. It is never cut short.
3. For each session it fetches the full snapshot and hashes it. It then stores
   or refreshes **one candidate per (team, session, content)**:
   - **The same content seen again** refreshes the same row, so repeated
     checks never create duplicates.
   - **New content** creates a new candidate. The older candidates of that
     session that were never imported are marked `superseded`.
   - **A candidate that was already imported** with the same content only gets
     its "last seen" time updated.
4. Before storing the candidate, it computes the preview. The importer runs every statement of a real import
   and then **rolls the transaction back**, so the preview is exactly what F2
   would do against the same state, and nothing remains.

Only one check runs per team at a time.
- A running check reports progress after every GPEXE request.
- A check that stops reporting for 15 minutes — for example because the
  server restarted — is closed as `abandoned` by the next check.
- If the old run was only slow, it notices it was closed and stops. It writes
  nothing more.

The preview reads everything it shows under the team's import lock, in the same
transaction as the rolled-back import. The "before" values and the outcomes
therefore come from one state.

## What the preview shows

- **Per athlete:**
  - participation and the GPS measurement **separately**;
  - each result: whole session, and each drill;
  - its outcome: `created`, `unchanged`, `supplemented`, `corrected`,
    `needs_review`, ... or `not_imported`;
  - each value with **previous** and **new** next to each other.
- **Every value left out**, with the mapper's reason (e.g. `details_not_fetched`,
  `team_threshold_missing`). A left-out value is absent, **never a zero**.
- **Athletes not imported**, with the reason:
  - `multiple_tracks` — two tracks in one session. This is manual review, and
    it does not stop the others;
  - `stats_invalid` — GPEXE marks the statistics invalid;
  - `athlete_not_linked`;
  - `athlete_not_in_team`.
- **One exception, on purpose.** An athlete whose results for that session were
  **already imported**, and who is now left out (unlinked, out of the team, or
  on two tracks), stops the whole session. Importing the others would leave his
  old values in place without review. The preview then:
  - says `identities_missing_from_source`;
  - names him in `blocked.gpexeAthleteIds`;
  - marks him `blocksSession: true`.

  Nothing is written until that is resolved.
- **Athletes of the team with no GPEXE row:** participation unknown, no GPS
  record, **no reason**. "GPS was not worn" is only ever stated when the data
  shows it; a coach-entered reason comes after F1–F3.
- **A manual correction** on a value is never replaced by an import; the
  preview marks it.
- The preview stores athlete ids, not names. Names are read at request time,
  for the team's own athletes only.

## Retention of raw GPEXE data (owner decision 2026-09-18)

| Candidate | Raw snapshot and preview kept |
|---|---|
| never approved (pending, blocked, superseded) | **30 days** after it was last seen by a check |
| imported (F2) | **90 days** after the import |

What stays after the purge:
- the content hash;
- the source mapping;
- the decision;
- who approved it;
- the write report (F2).

The tables that hold history refuse TRUNCATE: athlete links, approver grants,
settings history and candidates. An imported candidate's row is never deleted.

**The purge must not depend on one process running every day.**
- It works in short batches: 200 rows at a time, oldest first, skipping rows
  another session is holding. It repeats until nothing expired is left.
- It runs:
1. on every "Check now";
2. in the web server, 30 s after start and every 6 hours;
3. through `npm --prefix backend run gpexe:retention`, meant for an **external
   scheduler**. On Render that is a Cron Job running this command daily. Locally
   it is Windows Task Scheduler. This command exits 1 if the purge fails or if
   an expired snapshot is still stored.

**Expiry does not wait for the purge.** Once `raw_expires_at` has passed:
- the app shows the snapshot as gone and returns no preview;
- the candidate carries the blocker `snapshot_expired_check_again`;
- F2 refuses to approve it.

A new check of the same data stores the snapshot again with a fresh 30 days.
That is the only way back.

**Watching it:**
- `GET /api/training-load/gpexe/retention` is for platform admins only;
  everyone else gets 404. It reports:
  - `expiredNotPurged` (must be 0) and `healthy`;
  - the last successful run, and the last failed one.
- Every run is recorded in `training_load.gpexe_retention_runs`.

## Not in F1

- Approving or importing a candidate (F2).
- Any screen (F3).
- Athletes who trained without a GPS record: participation only, manual entry
  or an estimate. This comes after F1–F3.
- Periodic checks and notifications. They can later feed the same candidate
  queue.
