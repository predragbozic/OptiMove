# GPEXE import from the app — F1 (check, candidates, preview) and F2 (approve and import)

F1 lets a coach press **"Check now"**, see the GPEXE sessions of the team as
import candidates, and open a preview of what an import would write or change.
**A check writes no result, no event and no activity.**

F2 adds the approval: an approver approves one candidate **as a whole**, and
that approval is what imports it. It is the only step that writes results,
events and activities, and only while `GPEXE_IMPORT_APPLY_ENABLED` is on
(see "Turning the import switch on"). The screens are phase F3.

Code:
- `backend/src/gpexeClient.js` — the read-only GPEXE client;
- `backend/src/gpexeImportPreview.js` — the preview;
- `backend/src/gpexeImportService.js` — checks, candidates, retention, and the approval (`approveCandidate`);
- `backend/src/gpexeImportAccess.js` — who may do what;
- `backend/src/routes/gpexeImport.js` — the routes, under `/api/training-load/gpexe`;
- `backend/src/gpexeRetentionCli.js` — the retention CLI.

Schema: `migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql` (F1) and
`migrations_v2/202609201000_training_load_v23_gpexe_import_approval.sql` (F2).

Proof:
- `backend/tests/gpexe-in-app-import.test.mjs` — on a disposable database, through the real server;
- `backend/tests/gpexe-client.test.mjs` — no network.

## Environment

| Variable | Meaning |
|---|---|
| `GPEXE_API_TOKEN` | The GPEXE API token. It is kept **only in the server environment**: Render's environment settings, or the local `backend/.env`. It never goes into the database, the browser or a log. Without it, "Check now" answers 503 `gpexe_token_missing`. |
| `GPEXE_IMPORT_APPLY_ENABLED` | `true` allows an approval to import, i.e. to write results and activities, in this environment (F2). Anything else refuses every approval with 409 `import_switch_off` before anything is written. **While it is off, "Check now" still writes its check record and the candidates.** The switch blocks writing results and activities, not every write to the database. The API reports its state and a sentence explaining it (`importSwitch`) with every candidate response, so the screens can say it. It is turned on only through the operational gate below, separately for each environment. |

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
   - The status route shows the right (`viewer.canApprove`). The approval
     checks it again in its own transaction, and holds it until it commits.

### Refusals when connecting or linking

The connection a team reads from decides what every GPEXE athlete number and
session id in that team means, so it is only changeable while nothing depends
on it. Both the application and the database (migration v24) refuse the rest,
and the database refuses it whoever writes it, psql included.

| Answer | What it means | What to do |
|---|---|---|
| 400 `change_reason_required` / `change_reason_too_long` | A change of an existing connection carries no reason, or one longer than 500 characters. | Repeat with a short reason. A first connection needs none, but one given is kept. |
| 409 `gpexe_team_taken` | That GPEXE team already feeds another OptiMove team. | Check the number. One GPEXE team feeds one OptiMove team. |
| 409 `gpexe_team_change_blocked` | The team already has a check, a session found by a check, an athlete link, an approval or imported GPEXE data from its current GPEXE team. | The connection stays. Moving a team to another GPEXE team is not supported; it would make existing links and sessions describe other people. |
| 409 `gpexe_orphan_data` | No connection is recorded, yet the team already carries GPEXE data (after a restore, or a manual change). | **Not solved by this runbook.** A platform admin decides what happens to that data before the team is connected; the decision belongs with the Disconnect work, which is not designed yet. Do not disable the triggers to force it. |
| 409 `gpexe_change_busy` | A check, an import or a connection change is running for that team. | Try again when it has finished. |
| 409 `gpexe_team_not_configured` | An athlete link (or a check) was asked for before the team has a GPEXE team. | Connect the team first. |

Deleting a connection is refused as well: there is no Disconnect yet, and the
migration that designs it decides what happens to the candidates, links,
approvals and imported events of that team.

## Who may do what

| Action | Who |
|---|---|
| Status, "Check now", candidates, previews, athlete links, source athletes | The team's coach, its club admin, a platform admin — in a workspace that contains the team. Anyone else gets the same 404 as a team that does not exist. |
| Connect the GPEXE team; grant and revoke approvers; read retention status | An active platform admin |
| Approve a candidate, which imports it (F2) | An active platform admin, or a coach with an active grant for the team who still coaches it, in a workspace that contains the team. A team manager without the right gets 403 `not_an_approver`; anyone else the same 404. |

## What a check does

1. It purges expired raw snapshots first (see Retention).
2. It lists the team's parent sessions in the window. The default window is the
   last 14 days, and the maximum is 31.
   - Drills are part of their parent, not candidates of their own.
   - The list is read from one day earlier. That way a drill whose parent
     started the evening before is still recognized as a drill.
   - **Lists are read to the end.** GPEXE pages with headers: the body is a
     plain array, `X-Total-Count` gives the total, and `Link: <…>; rel="next"`
     gives the next page. A `{count, next, results}` body is accepted too.
   - Every next page is followed, **however short the page before it was**.
   - The list must end complete: exactly the reported number of rows, and no id
     twice.
   - The check fails with a stable code instead of returning part of the list
     when:
     - the total is missing (`list_shape_unclear`);
     - the body has another shape (`list_shape_unclear`);
     - a row has no id (`list_shape_unclear`);
     - another page is announced after all rows (`list_shape_unclear`);
     - the total changes between pages (`list_changed`);
     - a row comes twice (`list_changed`);
     - rows are missing at the end (`list_incomplete`);
     - the next page is outside the API (`list_incomplete`);
     - there are more than 20 pages (`list_incomplete`);
     - a session claims more than 30 drills (`drills_count_out_of_range`).
3. For each session it fetches the full snapshot and hashes it. It then stores
   or refreshes **one candidate per (team, session, content)**:
   - **The same content seen again** refreshes the same row, so repeated
     checks never create duplicates.
   - **New content** creates a new candidate. The older candidates of that
     session that were never imported are marked `superseded`.
   - **A candidate that was already imported** with the same content only gets
     its "last seen" time updated.
4. Before storing the candidate, it computes the preview. The importer runs every statement of a real import
   and then **rolls the transaction back**, so the preview is exactly what the
   approval would do against the same state, and nothing remains.

The candidate list (`GET …/candidates`) is one query over the stored rows, however
many candidates there are (`candidateSummary` in `backend/src/gpexeImportService.js`):
`status` and `snapshot` come from the row's columns; `previewStatus`, `counts`,
`changesToImported` and, since Imports phase 2b, `blockedCode`, `blockedSourceCode`,
`sessionType` and `reasons` come from the row's stored preview
(`backend/src/gpexeImportReasons.js`), so the list never reads a candidate's detail.
`blockedCode` and the reason codes are source-neutral names of what the coach has to
deal with; the adapter's own code stays in `blockedSourceCode`. The server's sentences
stay in the single-candidate answer's `preview` (`blocked.message` and its resolution
steps, the per-athlete `notImported` and `gps.reason` messages, the change messages);
the list carries none of them.

`GET …/teams/:teamId/source-athletes` (Imports phase 3a) lists the team's GPEXE
athletes once each — every athlete seen in a snapshot that is still available (not purged, not expired) plus every athlete with
an active link — with `status` (`linked`, `unlinked`, or `linked_inactive` when the
linked OptiMove athlete is no longer an active member of the team), the link (the
OptiMove name comes only from it; GPEXE names are never stored, so none is returned),
`lastSeen` and helper values for telling athletes apart (`duration` min, `distance` m,
`maxSpeed` km/h from the whole-session result of that sighting, `drillsCount` from the
raw snapshot's own field; a value the source did not give is `null`, never a zero).
"Last seen" is the newest session by session date among the team's candidates whose
snapshot is still available — not purged and not expired, the same rule the candidate
routes apply (`snapshotState`); same date: a current version before a replaced one, then
the later `last_seen_at`, then the larger candidate id. A session the mapper refused
(unsupported category, invalid statistics, inconsistent data) is stored with a preview
that names no athlete, so it yields no sighting: an athlete seen only in such sessions
is listed only if linked (owner decision pending on whether the raw snapshot should
count). Read-only, no GPEXE call, one SQL statement however many candidates or athletes
(`listSourceAthletes` in `backend/src/gpexeImportService.js`); the team filter applies
to candidates, links and memberships alike.

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
  on two tracks), stops the whole session. Importing the others would leave
  that athlete's old values in place without review. The preview then:
  - says `identities_missing_from_source`;
  - names the athlete in `blocked.gpexeAthleteIds`;
  - marks the athlete `blocksSession: true`.

  Nothing is written until that is resolved. `blocked.resolution` gives one
  step per blocking athlete. It names the OptiMove athlete the earlier results
  belong to (`previousAthleteId`):

  | Why the athlete is left out | `action` | What to do |
  |---|---|---|
  | `athlete_not_linked` | `relink_athlete` | Link the GPEXE athlete again to `previousAthleteId`, then "Check now". |
  | `athlete_not_in_team` | `restore_team_membership` | Make `previousAthleteId` an active team member again, then "Check now"; or undo the earlier import. |
  | two tracks, invalid statistics | `fix_in_gpexe_or_undo` | Correct the data in GPEXE, then "Check now"; or undo the earlier import. |
  | no longer in GPEXE at all | `undo_earlier_import` | Undo the earlier import. |

  "Undo the earlier import" is the platform-admin procedure in
  `docs/runbooks/gpexe-undo-imported-session.md`. For a persistent database it
  needs its own approval first.

- **Athletes of the team with no GPEXE row:** participation unknown, no GPS
  record, **no reason**. "GPS was not worn" is only ever stated when the data
  shows it; a coach-entered reason comes after F1–F3.
- **A manual correction** on a value is never replaced by an import; the
  preview marks it.
- **Changes to results that were already imported** are listed on their own,
  in `changesToImported` (and counted in `counts.changesToImported`). Each
  entry names the athlete, the result, the outcome, what the import does to
  it, and the values that differ (previous next to new). Every outcome that
  writes to an already imported result is listed:

  | Outcome | `effect` | The GPEXE version becomes current |
  |---|---|---|
  | `corrected` | `replaces_current_values` | yes; the old values stay in the history |
  | `supplemented` | `adds_values_to_imported_result` | yes; the existing values stay the same, new ones are added |
  | `needs_review` | `conflicting_version_flagged` | no; stored as a conflicting version for review |
  | `stale_resend_ignored` | `older_or_manual_version_flagged` | no; the current (newer or manual) values stay |

  `unchanged` and an already recorded conflict write nothing and are not
  listed. An outcome with no rule in this table stops the preview with an
  error instead of being left out silently.
- The preview stores athlete ids, not names. Names are read at request time,
  for the team's own athletes only.

## Approving a candidate (F2)

`POST /api/training-load/gpexe/teams/:teamId/candidates/:candidateId/approve`

```json
{ "previewHash": "<the previewHash of the candidate as you reviewed it>", "acceptChanges": true }
```

- **The whole candidate or nothing.** There is no choosing athletes: the
  approval imports exactly what the preview shows, and the athletes it leaves
  out stay out, with their reasons.
- **`acceptChanges`** must be `true` when the preview lists
  `changesToImported`. Without it the answer is 409 `changes_need_acceptance`
  (with the number of changes), and nothing is written. The approval records
  how many changes there were and that they were accepted.

### What the server does, in one transaction

1. Holds the approver's right (`training_load.lock_gpexe_import_approver`):
   an active platform admin, or an active grant for the team whose holder
   still actively coaches it. The role, grant and user rows are held
   `FOR SHARE`, so a revoke, the end of the role or deactivating the user
   waits until the approval has finished.
2. Locks the candidate row (`FOR UPDATE`) and checks, before anything is
   written, that:
   - it is `pending` (not `imported`, `superseded`, or `blocked`);
   - its snapshot has not expired;
   - its stored `preview_hash` is the one the approver sent;
   - its preview would write something;
   - changes to imported results are accepted.
3. Takes the team's import lock, runs the import, and **recomputes the
   preview from what the import did** (`previewLocked`).
4. Compares the recomputed preview hash with the approved one. **If they
   differ, the whole transaction is rolled back**, including every row the
   import had already written in step 3, and no approval is recorded.
5. Records the approval (`training_load.gpexe_import_approvals`: who, on which
   basis and grant, which content and preview, the accepted changes, the
   event, activity and batch written, and the importer's counts). Marks the
   candidate `imported` and keeps its snapshot 90 more days. Commits.

Lock order: role and grant rows → candidate → team import lock → the
importer's own order. A check running at the same time only takes the team
import lock for its preview and the candidate row afterwards, so the two
cannot deadlock.

The database checks the same rules again, whoever writes: an approval row is
refused for a user without the right, a basis the user does not hold, a
candidate that is not pending, an expired snapshot, a preview hash that is
not the candidate's, or a number of accepted changes other than the one the
candidate's preview lists. A candidate becomes `imported` only from `pending`
and only with its approval recorded, and it is never inserted as `imported`. Approval rows are never changed or deleted,
and the table refuses TRUNCATE. Two approvals of the same candidate at the
same time: the second waits for the candidate row and is then refused with
409 `already_imported`.

### Refusals

| Answer | When | What to do |
|---|---|---|
| 409 `import_switch_off` | The switch is off in this environment. | Nothing, until the operational gate below is passed. |
| 403 `not_an_approver` | The caller manages the team but may not approve. | A platform admin grants the right, or approves. |
| 409 `already_imported` | It was imported already, perhaps by a second approval at the same time. | Nothing. |
| 409 `superseded_by_newer_data` | GPEXE has newer data for the session. | Review the newer candidate (`reviewAgain`). |
| 409 `blocked` | The preview is blocked. | Follow `blocked.resolution`, then "Check now". |
| 409 `snapshot_expired_check_again` | The raw data expired. | "Check now" again. |
| 409 `nothing_to_import` | The import would write nothing. | Nothing. |
| 409 `changes_need_acceptance` | Changes to imported results were not accepted. | Review them and send `acceptChanges: true`. |
| 409 `preview_changed` | The preview is not the one reviewed, or what the import would do changed between the review and the approval. | Open `reviewAgain.href`, review the candidate again, approve the new `previewHash`. |
| 500 `internal_error` | Anything unexpected **before the COMMIT was sent**, e.g. a database guard firing. Nothing was imported; the server log has the detail. | Report it; do not retry blindly. |
| 503 `import_outcome_unknown` | The COMMIT was sent but not confirmed, and the import could not be found yet. **It may or may not have been imported.** | Follow "When the outcome is uncertain" below. |

When `preview_changed` comes from step 4, the candidate is given the
preview recomputed in step 3, so reopening it shows what an import would do
now. If the stored GPEXE data can no longer be imported at all (the
importer's rules changed since the check), the candidate becomes `blocked`
with that reason instead. Nothing else of that attempt remains.

### What a successful answer says

`200` with `outcome: "imported"`, the approval (`approval.id`, who, when,
basis, accepted changes) and the write report (`import`: event, activity,
batch, counts). `commitConfirmation` is:

- `confirmed` — the database confirmed the COMMIT;
- `verified_after_commit_error` — the COMMIT's answer was lost, and the
  approval was then found committed on another connection.

After the import, the answer also carries the candidate as it is now. If
reading it fails, the import still stands: `candidate` is `null` and
`candidateReadError` (`candidate_read_failed`) says so and links the
candidate. Never read a failed candidate read as a failed import.

### When the outcome is uncertain (503 `import_outcome_unknown`)

Once the COMMIT has been sent, the answer never says "nothing was imported":
a lost answer means the outcome is unknown. The approval waits at most 15
seconds for the COMMIT's answer; an answer that never comes is treated like
a lost one, and the connection is closed first. The server first looks for the
approval on another connection, for at most 5 seconds; if it is there, the
answer is a normal 200 (`verified_after_commit_error`). If it is not there,
the check fails, or the 5 seconds pass, the answer is 503 with `verify`. The
connection whose COMMIT went unanswered is closed, not reused.

1. Open `verify.approvalHref` (`GET /teams/:teamId/approvals/:approvalId`).
   `200` means the import was committed; the approval shows what was
   written. `404` means that approval does not exist (yet).
2. Open `verify.candidateHref`. `status: "imported"` with `approval.id`
   equal to `verify.approvalId` means imported; `status: "pending"` and
   `approval: null` mean not imported.
3. If both say "not imported", approving again is safe. If it was imported
   in the meantime, the approval answers 409 `already_imported` and writes
   nothing; otherwise it imports once.

Never undo or re-enter data by hand because of a 503: first check as above.

**Open risk (recorded in the F2 reviews, not fixed in F2):**
- The waits **before** the COMMIT are not bounded: the approver's role and
  grant rows, the candidate row, and the team import lock. If another
  approval or import of the same team holds them, a new approval waits
  until it finishes.
- On a real network stall (not a clean close), the server may notice the
  dead connection only through TCP keepalive. Until then, the abandoned
  transaction keeps those locks, and a retried approval waits.
- Before regular imports: give these waits a bound (`lock_timeout` and
  `idle_in_transaction_session_timeout` for the approval transaction) with
  a stable refusal code, and confirm the deployed request timeout (Render
  and any proxy). Today the COMMIT alone can take up to 15 s plus the 5 s
  check.

**Before undoing an import on a persistent database** (not allowed today:
the undo script accepts only disposable databases): the undo script must
first take the same team import lock as the approval
(`gpexeImportWriter.lockTeamForImport`), so an undo and an approval of the
same team cannot run at the same time. Found in the F2 database review;
recorded as a precondition, not changed in F2.

## Turning the import switch on (operational gate)

Owner decision 2026-09-18, for the first controlled import in each
environment:

- `GPEXE_IMPORT_APPLY_ENABLED` stays off in an environment **until a fresh
  backup of that environment exists and its restore was verified**. Local
  OPTIMOVE and the deployed (Supabase) database are **separate decisions**,
  each with its own backup.
- For the local OPTIMOVE database the backup is taken and verified with
  `backend/scripts/gpexe-backup-verify.mjs`
  (`docs/runbooks/gpexe-backup-verify.md`). For Supabase, how the backup and
  the restore check are done is decided together with that environment's
  decision.
- **The app never says a backup was checked.** It only shows whether the
  switch is on (`importSwitch`). Nothing in the code or the database checks a
  backup; this gate is a person following this runbook.
- Every time the switch is turned on, add a row below **before** turning it
  on, and complete it when it is turned off again. A switch that stays on is
  not the plan: before regular self-service imports, a separate mechanism
  that reliably checks how fresh the backup is will be proposed.

| Environment | Backup path or identifier | `.verify.json` (path, sha256) | Verified at | Confirmed by | Switch on at | Switch off at |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |

No row yet: the switch has not been turned on in any environment.

## Checking the real GPEXE API (read only)

Before F1 is called ready, the owner runs this probe in their own terminal.
The token never leaves that terminal. It opens no database and writes
nothing. There are two separate checks:

```
$env:GPEXE_API_TOKEN = $env:GPEXE_TOKEN
node backend/scripts/gpexe-api-probe.mjs --team 980 --from 2026-09-14 --to 2026-09-14 --session 186942
node backend/scripts/gpexe-api-probe.mjs --team 980 --from 2026-09-14 --to 2026-09-14 --session 186942 --mode hash
```

- **`--mode paging`** is the default. It is quick: a handful of requests, and a
  limit of 90 s. It shows how the session list and the session's athlete rows
  are paged, and whether both are read complete.
- **`--mode hash`** fetches the whole session twice, so it takes 2 requests per
  athlete row, plus tracks and drills. Its limit is 600 s. It shows:
  - whether the content hash is the same on both fetches;
  - if not, which fields changed;
  - what the importer would make of the session.

**Progress** goes to stderr:
- the phase;
- every request as it starts and ends, with every number in its path masked;
- how many requests are done, and the seconds elapsed;
- a line every 10 s while a request is still waiting.

Each request waits at most 30 s and is tried twice. **The whole run stops at
`--max-seconds`.** What was found up to then is still printed, with
`"timedOut": true` and the phase it stopped in, and the exit code is 2.

**What is never printed:** a name, an athlete id, a value or the token.
- Category names are free text, so they are counted, not printed.
- A path that changed between two fetches shows `<id>` instead of an id key.
- Error messages are masked the same way.

## Retention of raw GPEXE data (owner decision 2026-09-18)

| Candidate | Raw snapshot and preview kept |
|---|---|
| never approved (pending, blocked, superseded) | **30 days** after it was last seen by a check |
| imported (F2) | **90 days** after the import (the approval sets it) |

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

## Not in F1 and F2

- Any screen (F3).
- Turning the import switch on, and the first real import: only through the
  operational gate above, with the owner's decision for that environment.
- Athletes who trained without a GPS record: participation only, manual entry
  or an estimate. This comes after F1–F3.
- Periodic checks and notifications. They can later feed the same candidate
  queue.
