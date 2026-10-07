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
- `backend/src/gpexeImportService.js` — checks, candidates, retention, the approval (`approveCandidate`) and the batch approval (`approveCandidates`, Imports phase 4a);
- `backend/src/gpexeImportAccess.js` — who may do what;
- `backend/src/routes/gpexeImport.js` — the routes, under `/api/training-load/gpexe`;
- `backend/src/gpexeRetentionCli.js` — the retention CLI.

Schema: `migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql` (F1) and
`migrations_v2/202609201000_training_load_v23_gpexe_import_approval.sql` (F2).

Proof:
- `backend/tests/gpexe-in-app-import.test.mjs` — on a disposable database, through the real server;
- `backend/tests/gpexe-batch-approve.test.mjs` — the batch approval, the same way;
- `backend/tests/gpexe-client.test.mjs` — no network.

## Environment

| Variable | Meaning |
|---|---|
| `GPEXE_API_TOKEN` | The GPEXE API token. It is kept **only in the server environment**: Render's environment settings, or the local `backend/.env`. It never goes into the database, the browser or a log. Without it, "Check now" answers 503 `gpexe_token_missing`. |
| `GPEXE_IMPORT_APPLY_ENABLED` | `true` allows an approval to import, i.e. to write results and activities, in this environment (F2). Anything else refuses every approval with 409 `import_switch_off` before anything is written. **While it is off, "Check now" still writes its check record and the candidates.** The switch blocks writing results and activities, not every write to the database. The API reports its state and a sentence explaining it (`importSwitch`) with every candidate response, so the screens can say it. It is turned on only through the operational gate below, separately for each environment. |

The GPEXE host is fixed (`https://e03.gpexe.com/api/`). Requests are GET
only and redirects are refused, so the token cannot be sent anywhere else.

**Which credential a check uses (F3c2g, `docs/ai/source-connections-f3c2g-discovery.md`).** A
team with an **active source binding** (Settings → Data sources, F3c2e) reads only through that
binding's connection: the stored, encrypted token of the club's connection on the connection's
approved host (`server3` / `rest_v1`), bound to the approved GPEXE team. `GPEXE_API_TOKEN` is
not read for such a team, and nothing falls back to it: a connection that is not `verified`, a
retired host or a missing key answer `409` / `503 source_connection_unavailable` — with the
precise `reason` (`connection_not_usable`, `host_not_allowed`, `key_missing`,
`team_setting_missing`, `team_setting_mismatch`, `connection_foreign_club`, `binding_ambiguous`)
for an administrator of the platform or of the team's club, while a coach gets the stable code and
the sentence to contact an administrator — and write no check row; an unreadable credential is
found after the row exists (the decrypt happens once, right before the first request) and fails
the check with `credential_unreadable`, zero requests sent. The same facts — the binding, the
connection's state, its club, its host, the approved pair and a fingerprint of the stored
credential — are re-checked before and after every read of a running check, which stops with
`binding_ended`, `connection_not_usable`, `connection_credential_changed` (a Reconnect landed
meanwhile) or `host_not_allowed` when they change; a check running through the legacy token stops
with `binding_started` when a binding appears; `drill_set_incomplete` stops a check when the
source does not answer every drill of a session (nothing of that session is recorded). A `401`
from the source moves the connection to `needs_reconnect` with one `auto_invalidate` audit row
(basis `system`; written after the check's own outcome, never changing it; skipped and logged when
a Test / Reconnect holds the row at that moment — the attempt's own outcome then sets the state and
the next refused check re-applies it) and fails the check with `source_auth_rejected`; a `403`
fails the check with `source_access_refused` and changes no state; an administrator reconnects or
tests the connection, then the coach checks again. The binding path reports progress after every
request of the source, so a slow source never makes a live check look abandoned. The facts are
checked after every list (empty or not) and after every bundle too, and both paths keep the team in
the club it started in (`team_club_changed` / `team_not_available` otherwise). **After an Unbind
the team is not back on the legacy token:** until it is bound again a check answers
`409 source_connection_unavailable` (`binding_ended`), and `GPEXE_API_TOKEN` is read for no team
that ever had a binding. Since **v31** every check row records its path (`source_path`:
`legacy_env` or `source_connection`) and, on the connection path, the connection, binding, source
team and host key it read through — final from creation, never a credential; rows from before v31
read `legacy_env` (the only path that existed then), and the database itself refuses a `legacy_env`
row for a team that has or had a gpexe binding (the v31 trigger, under the team's import lock;
`gpexe_import_checks_legacy_path_never_bound`), whoever writes it — rows written before a team's
first binding stay as history. A check whose
start COMMIT was sent but not answered in time either runs (the row is found) or answers `503
check_outcome_unknown` — never "nothing was written"; read the team's checks before starting
another one. A team that **never had** a binding keeps the legacy path above (`legacy_env`), until F3c4
decides the variable's fate. A check started while a Test, Reconnect, bind, Unbind or Settings
change holds the team's lock answers `409 gpexe_change_busy`: retry. The server log names the path
of every check (`legacy_env`, or `source_connection` with the connection and binding ids), never a
secret; no API field carries it yet. **What a failed check shows, and to whom:** the precise code
stays on the check row; on the status (`lastCheck`) and on a check's detail a platform admin and an
active admin of the team's club see it with its own sentence, while a coach sees
`source_connection_unavailable` and the sentence to contact an administrator for every code that
describes the connection — the binding, the connection's state, club, host, key, adapter or
credential, a refused credential (`source_auth_rejected`) and a resource it may not read
(`source_access_refused`) included. A general source answer (`source_unavailable`,
`source_answer_unexpected`, `drill_set_incomplete`, …) and a team fact are shown to everyone as they
are. F3c4, when it retires the environment path, drops the `legacy_env` default; new code then
writes no legacy check and the historical legacy rows are not rewritten (owner, 2026-10-04).
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

## Source connections (F3c3): the club's account, in Settings

**Settings → Source connections** is where the club's GPEXE account lives (the F3c2d–F3c2f routes
under `/api/training-load/sources/gpexe/connections`). Who sees it: a platform admin (in the
platform workspace, choosing a club; or inside a club's workspace) and the owning club's admin
inside that club's workspace. A coach never sees it; a club admin in another workspace, another
club's admin, an archived club or a revoked role get the same 404 as a connection that does not
exist, and the screen says only that no source connections are available in this workspace.

The steps, each behind a form or a confirmation that names what it touches:

1. **Create connection** — the one approved host profile (`server3`, rest/v1) and an account
   label (a name for the screen, not the username).
2. **Connect account** — the GPEXE username and password, typed once. They travel in that one
   request; the server exchanges them for an access token, stores only the token encrypted, and
   drops the pair. OptiMove does not retain the username or password after this request; your
   browser or password manager may handle them according to its own settings (the field is marked
   `current-password`, a hint, not a guarantee). A double click sends one request. If the answer
   is lost, *Read current state* refreshes what is shown but does not confirm the attempt — the
   marker and the lock on other changes stay until you choose *Acknowledge uncertainty and
   continue* (nothing is sent by either); the pair is never sent a second time.
3. **Test connection** — the stored token is checked against the source (and every bound team is
   read); the state badge, the last verified time and any recorded problem are shown in plain
   language. After a verified Connect or Test the GPEXE teams the account sees are listed exactly
   as the server presents them: a club admin sees only those approved for one of the club's teams
   under Data sources; a platform admin sees the bounded, annotated list. The token and the
   source's own answer are never shown.
4. **Approve and bind** — the approved pair OptiMove team ↔ GPEXE Team ID is still set under
   **Settings → Data sources** by a platform admin (the F3b route, with reason and history); here a
   row with an approved pair offers *Bind*, the review names the source, the host, the club, the
   OptiMove team and the GPEXE team, and one confirmation creates one binding. The same pair again
   is the server's idempotent answer.
5. **Reconnect** — a new username and password, after a confirmation that names the source, the
   owning club and the number of bound teams; the old credential is never shown or recovered.
6. **Unbind** — a mandatory reason and a confirmation naming both teams; the team then reads
   nothing from GPEXE until it is bound again and **does not fall back to the environment token**;
   the ended binding stays as history. A lost answer is checked with the same `requestKey`, so an
   Unbind is never done twice.

Every refusal of the routes reads as a sentence; the code and the server's own sentence stay under
*Technical details*. A write in flight, or an outcome not yet confirmed, asks before the section
is left or the page is reloaded.

## One GPEXE athlete id

A GPEXE athlete id is `"0"` or digits without a leading zero, at most 12
(`GPEXE_ATHLETE_ID_PATTERN` in `backend/src/gpexeImportMapper.js`), wherever it enters:
the link route refuses anything else with `400 invalid_gpexe_athlete_id` before any lock or
write; the mapper refuses a snapshot whose row carries a non-canonical athlete id
(`invalid_athlete_id`, shown as inconsistent source data); the source-athletes list takes
only canonical ids from a preview entry or a raw row. `"0104"` is never read as athlete
`104`. The database check on `gpexe_athlete_links.gpexe_athlete_id` is the wider
`^[0-9]{1,12}$` (v22) and was left as is — no migration; tightening it is a separate
decision. A link row written before this rule is therefore listed as stored (never
hidden, never rewritten); before Phase 3b check the deployed table read-only:
`select count(*) from training_load.gpexe_athlete_links where gpexe_athlete_id !~
'^(0|[1-9][0-9]{0,11})$'` — the expected answer is 0.

## Who may do what

| Action | Who |
|---|---|
| Status, "Check now", candidates, previews, athlete links, source athletes | The team's coach, its club admin, a platform admin — in a workspace that contains the team, and only while the team is active. Anyone else, and anyone for an archived team (the platform admin included, on the administrative routes too), gets the same 404 as a team that does not exist. |
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

The coach's *Link athletes* screen (Imports phase 3b, Training Load → Data & Analysis →
Imports → "Link athletes") is built on this list: one row per GPEXE athlete with the last
session's helper values, a choice of the team's active, not-yet-linked athletes (same-name
athletes cannot be chosen), a confirmation of every pair, and one result per pair sent
through `POST …/athlete-links`; Unlink uses `POST …/athlete-links/:id/unlink`. A link is
never guessed and nothing is sent before the confirmation. After a link or an unlink the
links and this list are read again together; if that re-read fails, the screen keeps the
last list marked as possibly out of date and turns every new link/unlink off until *Try
again* succeeds.

`GET …/teams/:teamId/source-athletes` (Imports phase 3a) lists the team's GPEXE
athletes once each — every athlete seen in a snapshot that is still available (not purged, not expired) plus every athlete with
an active link — with `status` (`linked`, `unlinked`, or `linked_inactive` when the
linked OptiMove athlete is no longer an active member of the team), the link (the
OptiMove name comes only from it; GPEXE names are never stored, so none is returned),
`lastSeen` (with `evidence`, `candidateStatus` and the session's own
`sessionDrillsCount` from the raw snapshot's field) and the athlete's own helper values
for telling athletes apart (`values`: `duration` min, `distance` m, `maxSpeed` km/h from
the whole-session result of that sighting; a value the source did not give is `null`,
never a zero). "Last seen" is the newest session by session date among the team's
candidates whose snapshot is still available — not purged and not expired, the same rule
the candidate routes apply (`snapshotState`); same date: a current version before a
replaced one, then the later `last_seen_at`, then the larger candidate id. A session the
mapper refused (unsupported category, invalid statistics, inconsistent data) is stored
blocked with a preview that names no athlete; its raw snapshot's `athleteSessions[]`
is used only as a fallback (owner decision (b), 2026-09-24): it adds a GPEXE athlete no
available preview names, with `lastSeen` from the newest available refused session
(`candidateStatus: "blocked"`, `evidence: "raw_snapshot"`) and all values `null`; it
never replaces a preview sighting (`evidence: "preview"`) or its values, obeys the same
availability, team and tie-break rules, and takes only a canonical GPEXE athlete id. Read-only,
no GPEXE call, one SQL statement however many candidates or athletes
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
   candidate `imported` and keeps its snapshot 90 more days.
6. Records what the session roster needs to know (v25, Phase 5a1;
   `backend/src/activitySourceObservations.js`): for a **linked** GPEXE athlete
   whose record GPEXE itself marks unusable (two tracks or several
   whole-session rows → `needs_manual_review`; statistics not valid →
   `marked_invalid_by_source`) and who is on the session's roster on that
   date, an open `training.activity_source_observations` row
   (`record_unusable`, ids only in `adapter_ref`: the approval, the candidate
   and the adapter's reason code; never a name). An athlete this import wrote
   resolves his open one. An unlinked GPEXE athlete is never turned into an
   OptiMove athlete, and nothing here touches a coach's roster decision. Then
   commits.

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

## Approving several candidates at once (Imports phase 4a)

`POST /api/training-load/gpexe/teams/:teamId/imports` with
`{ "candidateIds": [...], "previewHashes": { "<candidateId>": "<previewHash>" } }`
approves and imports several **clean "Ready"** candidates of one team in one request.
**It is several single approvals, one after another — not one transaction and not
all-or-nothing.** Each candidate goes through `approveCandidate` exactly as above: its
own transaction, the approver's right `FOR SHARE`, the candidate `FOR UPDATE`, the team
import lock, the recomputed preview and its hash, the approval row, and the COMMIT with
its outcome check. The batch writes nothing itself and never calls GPEXE: it imports the
stored snapshots.

**The body.** `candidateIds` is required: 1 to **10** distinct candidate ids (UUIDs;
the same id in another letter case is a duplicate). `previewHashes` is required too:
for each of those ids, exactly once, the hash of the preview the approver saw — the
candidate list's `previewHash` (added to every list row in phase 4a). That is the same
binding as the single approval's `previewHash`: a preview recomputed after the list was
read (for example a link changed and the sessions were found again, which rewrites the
preview of the same candidate) is refused as `preview_changed` and never imported
unseen. No other field. Stable 400s, with nothing attempted: `invalid_body`,
`candidate_ids_required` (missing, not a list, empty), `invalid_candidate_id`,
`duplicate_candidate_id`, `too_many_candidates`, `preview_hashes_required`,
`preview_hashes_mismatch` (an id missing, extra or named twice), `invalid_preview_hash`,
`unknown_field`, and `accept_changes_not_allowed` — a change to an already imported
result is accepted only one candidate at a time, after its review.

A malformed candidate id is a **400** here, while a malformed id in a route path gets
the same 404 as a missing one. This is deliberate (owner's requirement for the batch
body): the ids are fields of the body, checked before anything is read, and a string
that is not an id names nothing in any team. A well-formed id that is missing or
another team's still gets the one `404 notFound` for the whole request.

**Before any candidate**, in this order, each with nothing attempted: the team's review
access (the same 404 as every GPEXE route), the body (400), the import switch (the
single approval's 409 `import_switch_off`), the caller's approver right (the single
approval's 403 `not_an_approver`, read live), and every id being a candidate of this
team (otherwise `404 notFound`, the same as a missing one — another team's candidate is
never named or imported). A server failure there is `500 internal_error`, without the
database's text.

**Which candidates are imported.** Just before its approval, each candidate's stored row
must be a clean "Ready" one: `pending`, snapshot available, its stored preview still
the one the approver saw, a `ready` preview with no change to an already imported
result and no reason on it (every athlete it would import is linked, in the team, and
needs no manual step — the same `reasons` the list shows). The approval is then sent
with that hash and `acceptChanges: false`, and `approveCandidate` checks all of it
again under its locks. Anything else is refused for
that candidate only.

**Two layers for the preview hash.** The entry test compares the stored
preview hash with the one sent for that candidate, and the approval is sent with the
hash the approver saw; `approveCandidate` compares it again under the candidate lock, so
the two layers are independent.

**The answer** is `200` with one result per candidate, in the order asked, and a
summary (`requested`, `imported`, `alreadyImported`, `refused`, `unknown`,
`notAttempted`). Each result has `candidateId`, `outcome`, `code` and `approvalId`, and
only known safe details, never a server message:

| `outcome` | `code` | Meaning | Details |
|---|---|---|---|
| `imported` | `null` | Imported and committed (or verified after an unconfirmed COMMIT). | `approvalId`, `commitConfirmation` |
| `already_imported` | `already_imported` | Imported before (perhaps by this same request sent earlier, or another approval at the same time). Nothing new was written; treat it as success. | `approvalId` when readable |
| `refused` | `superseded_by_newer_data`, `blocked`, `snapshot_expired_check_again`, `nothing_to_import`, `not_ready`, `changes_need_acceptance`, `preview_changed`, `notFound` | Not imported, for certain; the batch goes on with the next candidate. `preview_changed` also when the preview is not the one the approver saw. | `reviewAgain`, `changesToImported`, `reasons`, `blockedCode` |
| `refused` | `import_switch_off`, `not_an_approver`, `internal_error` | Not imported, for certain; the switch was turned off, the right was lost, or the server failed **before** a COMMIT — **the batch stops**. | — |
| `import_outcome_unknown` | `import_outcome_unknown` | The COMMIT was sent but not confirmed and the import could not be found yet. **It may or may not be imported. The batch stops.** | `approvalId`, `verify` (as in the 503 above) |
| `not_attempted` | `null` | The batch stopped before this candidate. Nothing was tried. | — |

`summary.refused` counts both kinds of refusal; whether the batch stopped is read from
the stopping `code` and the `not_attempted` results after it.

**Repeating the same request is safe**: an imported candidate answers
`already_imported` (from the stored status, or from the single approval's own check
under the candidate lock), never a second import; the rest are approved normally. After
an `import_outcome_unknown`, follow "When the outcome is uncertain" for that candidate,
or simply send the same request again.

**Limit: 10 candidates per request** (owner's ceiling without stronger evidence,
2026-09-24). Without lock contention the request lasts about the sum of its approvals;
an unconfirmed COMMIT can add 15 s + 5 s once, after which the batch stops. In the tests
two small approvals took well under half a second in total; a real session has more
athletes and drills. **The limit does not bound the worst case**: the open risk above
(unbounded lock waits before a COMMIT) applies to every candidate of a batch, so under
lock contention a batch can still wait without limit — now up to 10 times in one
request. Only condition 2 (a bound on the pre-COMMIT lock waits) bounds that, and it
matters more once batch approval is the usual path. Raising the limit needs measured
approval times on real sessions and a confirmed deployed request timeout.

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

## GPEXE names and dates of birth (administrators, v32)

Owner order of 2026-10-06. Discovery: `docs/ai/gpexe-athlete-identity-discovery.md`. Contract:
`docs/ai/source-connections-f3c2-contract.md` section 2.10.

**Reading the list is atomic.** The stored identities are read in one bounded transaction. The
connection, the binding, the team, the caller's role and user rows and the club are locked `FOR SHARE`
(in the write path's order) before the first identity row is read. They stay locked until the answer is
assembled. A revocation, an archive or an Unbind that commits first answers the identical 404; one
that comes later waits for the read.

**The GPEXE id on every administrator Imports screen** (owner order 2026-10-07): the id is shown only
under Technical details. Everywhere else an athlete is named one of three ways:
- a loaded athlete by its GPEXE name, with "(GPEXE athlete N)" added when two GPEXE athletes share the
  name; "Name not provided (GPEXE athlete N)" when GPEXE gave none;
- an athlete without a stored identity, while the team has some, as "Name not loaded (GPEXE athlete N)";
- every athlete, when the team has none, as "GPEXE athlete N".

N is the athlete's place in the team's GPEXE athlete list, in the order the server returns it; it is not
the GPEXE id. An athlete that list does not hold yet gets the next free number. Numbers need not be
consecutive inside one group, and they are never stored. The rule covers the Imports page (the linked
list and the last-link notice), Link athletes, the session review (rows, link controls, blocked steps,
changes), confirmations, results, errors, aria-labels and the unlink question.

The administrator's Imports view reads the stored identities with the team, with no GPEXE request. They
are dropped on leaving Imports or Training Load, a team or workspace switch, a status without the identity
right, or signing out, and an identity answer still in flight never brings them back. A name load in
flight or not confirmed keeps its key (no name) so *Check result* repeats the same request. A coach's screens keep the id,
as before, and show no sign of a snapshot.

**Who sees it.** Only these two can use the identity panel on *Link athletes*:
- a platform admin, in the platform workspace or the team's club workspace;
- the active admin of the team's club, in that club's workspace.

A coach sees the screen as before, with no trace of an identity. Every other caller gets the router's
identical 404: another club, a team workspace, an inactive admin, an archived team or club, and a team
without an active binding.

**What it does.** *Load names and dates of birth* first opens a confirmation. It says:
- how many athletes will be read, at most 50 per load;
- that the load only reads from GPEXE;
- that OptiMove deletes the answer from its database after at most 14 days, while a backup taken meanwhile can keep it longer.

The confirmation's button *Load names and dates of birth* then sends one `POST …/gpexe/teams/:teamId/athlete-identities/loads` with
`{ requestKey }` and nothing else. The server then works like this:
- **Which athletes:** it derives them itself from the team's stored candidates, using only those a
  **succeeded** check read through the team's **current** binding.
- **How they are read:** `rest/v1/athlete/<id>/`, through the binding's stored credential. At most 3
  requests at once; no retry, no redirect, no environment token.
- **Limits:** a 15 s timeout per request and a 45 s network budget for the whole load.
- **What is stored:** only the sanitized display name and the normalized date of birth, for exactly 336
  hours (14 days of elapsed time, whatever the session time zone). GPEXE's "no such athlete" (404) is
  counted in the load's answer (without its id) and is **never an identity**. Only a retry suppression is
  kept: binding, team, the canonical id, `observed_at` and `retry_after` = +24 hours exactly. There is no
  name, no date and nothing of the answer.
  - While it is active, the athlete is left out of the next loads' choice, so a run of 404s cannot starve
    the athletes behind it.
  - After it expires, the athlete is eligible again, but only for a new explicit load: there is no
    automatic retry, and nothing is sent to GPEXE because of a suppression.
  - Reading the screen never extends it.
  - It is deleted with the identities by an Unbind, a team or club archive and the purge
    `training_load.purge_expired_gpexe_athlete_identity_suppressions`.
  - The list answer reports `retryLaterCount`, a count only.

A check never reads an athlete record.

**What the answer says.** Counts only: names loaded, athletes GPEXE has no record for, athletes still
without a name, and dates of birth in a form OptiMove does not accept. The last count is in this answer
only. It is never stored, so a replay cannot repeat it. No name, date or id appears in the answer, a
log line, an audit row or an error.

**A lost answer.** No answer, a 503 `outcome_unknown` or an uncoded 5xx is shown as *Result not
confirmed*.
- *Check result* repeats the same requestKey. The server answers the saved counts, or says the load is
  still running.
- A load still `running` after 180 s is closed as abandoned. It saved nothing, so a new load can start.
- Nothing is ever sent by itself, and one key is never read twice.
- A team or workspace change keeps the key of a load whose result is not confirmed, in memory only and per
  OptiMove team: back on the same team *Check result* repeats it; another team never shows or sends it; a
  settled load removes it; signing out drops all. The kept state is the key and the Check result count -
  never a name, a date of birth or a GPEXE id.

**The source refuses.**
- **401:** the connection becomes *Needs reconnect*, with one `auto_invalidate` audit row whose trigger
  is `identity_read`, and nothing is saved.
- **403:** nothing is saved and the connection's state is unchanged.
- **An answer for another athlete id:** nothing at all is saved.
- **429, 5xx, timeout or an unreadable answer:** the load stops. What was already confirmed is kept,
  and the rest stays for a later load.

**When the snapshot is deleted (database triggers, same transaction):**
- an Unbind deletes that binding's rows;
- archiving a team deletes that team's rows;
- archiving a club deletes the rows of every team in it;
- the purge `training_load.purge_expired_gpexe_athlete_identities` deletes expired rows. It runs with the
  raw-snapshot purge (every check, the server at start and every 6 hours, and the CLI
  `npm --prefix backend run gpexe:retention`), and before every load.

Every read of the stored list purges too, and the identity purge runs before the raw one, so a failing
raw purge never keeps an expired identity. `GET …/gpexe/retention` and the CLI report
`expiredIdentitiesNotPurged`, which must be 0. The worst case: an expired row is never shown, and it
is physically deleted at the next of these runs (at most 6 h on a server that is awake).

A row is never updated: a reuse never extends `expires_at`. Readers never show or use an expired row,
even before the purge has run.

**Backups.** A database dump or a Supabase backup taken while identity rows exist keeps them under the
backup's own retention policy (the live table's 14 days are strict; a backup may follow a separate
policy). Before a restored copy is put to any use, the purge **must** be run until it returns 0:

```sql
select training_load.purge_expired_gpexe_athlete_identities(1000);
```

**Production-use gate (owner, 2026-10-07).** Before the first real identity load, the owner confirms
the legal basis and the notice for processing athletes' names and dates of birth, minors included. No
code decides this, and nothing here is a legal conclusion.

**Not here:** an automatic link, a preselection, or a search by name or date. Nothing is copied into an
OptiMove athlete profile.

**Browser storage:** none. The identity lives in the open screen's memory only. Closing the screen, a
team or workspace change, or signing out drops it.

## A refused date window (`source_filter_ignored`)

A check on the binding path reads the session list for the window from one day earlier (the look-back).
Every row the source returns must start inside that read - its day is the first ten characters of
`start_timestamp` - or the whole answer is refused as `source_filter_ignored`, with nothing recorded and no
retry. The check row's message then carries, after " Diagnostic: ", only counts and fixed words:

`op=session_list_by_date; rows=N; before_lookback=N; after_end=N; unreadable=N; outside_named_drill=N;
distance=under_3h:N,3h_to_24h:N,over_24h:N,unknown:N; tz=Z:N,offset:N,none:N,other:N.`

- `rows`: every row of the answer; `before_lookback` / `after_end` / `unreadable`: rows before the look-back
  day, after the last day, and with an empty or unreadable start;
- `outside_named_drill`: of the rows before the look-back day or after the last day (an unreadable row is
  never counted here), those a parent inside the asked period names as a drill;
- `distance`: how far each row outside starts from the nearest edge of the read (00:00:00 of the look-back
  day, 23:59:59 of the last day), on the naive time, in fixed buckets; `unknown` when it cannot be read;
- `tz`: the shape after the seconds of every row's `start_timestamp` - `Z`, an offset, none, or other.

Counts stop at 9999. No id, date, time, timestamp, name, URL or JSON is ever in it; a fixed-grammar guard
drops the description rather than let anything else through. A platform admin and the team's club admin
read it (Technical details); a coach gets the sentence before it. Reading it sends nothing to the source.

## Database pool checkout bound

The global PostgreSQL pool (`backend/src/db.js`) never lets a checkout wait without a bound:
`connectionTimeoutMillis` is **5 s**. A normal checkout takes milliseconds; 5 s means the pool's ten
connections stayed busy for that long.

**Why 5 s fits every HTTP budget.** The checkout is the first step of every flow below, so its bound adds
to the flow's existing worst case, which stays inside the client's bound:
- roster write (client 45 s): 5 s checkout + 15 s lock + 15 s COMMIT + 5 s outcome check = 40 s;
- identity load (client 90 s): 5 s claim + 45 s network budget + 5 s finalize checkout + 15 s COMMIT + 5 s
  verification = 75 s;
- source-connection attempt (client 150 s): 20 s user lock + 5 s checkout + 90 s network budget + 15 s
  COMMIT + 5 s verification = 135 s.

**What a timeout answers.** The stable code `pool_checkout_timeout` is internal; the routes answer:
- the source-connection routes (Create, Connect, Reconnect, Test, Bind, Unbind), the importer routes and
  the identity routes: `409 try_again` ("The server is busy right now. Your request was not carried out;
  try again in a moment."), `Retry-After: 5`. In these modules every checkout their own code does not
  catch is the first step of the requested operation, before any of it is written or sent (a check start
  may have closed an abandoned check of the team first - housekeeping any start does). The screens show
  their own sentences for `try_again`, which name a busy server as one possible cause;
- an identity load whose finalize checkout times out (after its GPEXE reads): nothing is saved; the
  request row is closed as failed (bounded) and the answer is `try_again`. When even that cannot check out,
  the row stays `running` and the answer is `503 outcome_unknown`: the screen keeps the key, *Check result*
  answers `identity_load_running` and, after 180 s, `identity_load_abandoned`; GPEXE is never read twice
  for one key. A *Check result* refused for any reason other than the original load's saved outcome (a
  busy server included) stays *Result not confirmed* with the same key;
- the roster command: `503 roster_busy`;
- login, forgot password and the verification resend each take ONE checkout, before anything about the
  email or password is known, and do the lookup and any transaction on it (owner's external review of
  PR #146): login answers the same `503 database_busy` whatever the password; forgot password and the
  resend answer their usual generic body (forgot through its timing floor), the same for an existing, a
  missing or an inactive account and for an existing or a missing pending application. The client is
  released before the timing floor and before the email; a fire-and-forget "mark sent" after a successful
  email is a later, separate checkout that never delays the answer;
- every other route: `503 database_busy` from the global handler, `Retry-After: 5`. It does not claim
  that nothing changed.

The log line names the code and the route only: no SQL, no value, no request body, no credential.

**Nothing stays held.** pg-pool removes a waiter that timed out from its queue, releases a client that
becomes free for it later, and ends a new connection that could not open in time. Express 4 drops a
rejected async route handler; `backend/src/expressAsyncErrors.js` hands such a rejection to the error
handler, so a route that checks out before its own `try` never ends the process.

`PG_POOL_CHECKOUT_TIMEOUT_MS` (an integer, 100 to 60000) exists for tests; production keeps the 5 s default.
Bounded checkouts the code already had (5 s or 15 s, each releasing a late client) are unchanged. The worker
CLIs keep their own pools; a service they import uses this pool and its bound.

**After the first deploy:** pg-pool applies the same 5 s to opening a new connection, so a cold connection to
the Supabase pooler that takes longer fails the same way. Watch the logs for `[db] pool_checkout_timeout`
lines; an occasional one on a cold start is that case, many in a row mean the pool was really exhausted.
Under exhaustion a background check, a purge or an out-of-transaction audit row may now fail instead of
waiting (each is caught and logged; a purge runs again on its schedule).

## Not in F1 and F2

- Any screen (F3).
- Turning the import switch on, and the first real import: only through the
  operational gate above, with the owner's decision for that environment.
- Athletes who trained without a GPS record: participation only, manual entry
  or an estimate. This comes after F1–F3.
- Periodic checks and notifications. They can later feed the same candidate
  queue.
