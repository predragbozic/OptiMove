# GPEXE athlete identity (name and date of birth): discovery

Owner order of 2026-10-06, after PR #143 (merged `2458ac5`, deploy confirmed). Base: `origin/main`
`2458ac5`. The confirmed source is `rest/v1/athlete/<id>/` with `first_name`, `last_name`, `name`,
`short_name` and `birthdate`. `birthdate` was null in the one record read, so its format is not proven.
No new probe is run: the boundaries are in `docs/ai/gpexe-rest-v1-compatibility.md` section 4b.

This document records what the code, the schema and the open PR #142 say, before any code is written.
Everything below was read from the checked-out repository. Nothing was read from a deployed or persistent
database, and no GPEXE request was sent.

## 1. Existing tables

| Table (migration) | What it holds | What matters here |
|---|---|---|
| `training_load.gpexe_import_checks` (v22, v24, v31) | One row per *Find new sessions* run | `status` (`running` / `succeeded` / `failed`). Since v31 also `source_path` (`legacy_env` / `source_connection`) with `source_connection_id`, `source_binding_id`, `source_team_id` and `source_host_key`, final from creation. |
| `training_load.gpexe_import_candidates` (v22, v23) | One row per (team, session, content) | `raw_bundle` (the projected snapshot) and `preview` (the mapper's result), both cleared by the purge. `raw_expires_at` / `raw_purged_at`. `first_seen_check_id` / `last_seen_check_id`. |
| Source athletes (no table) | `listSourceAthletes()` in `backend/src/gpexeImportService.js` | Derived on every read from the available candidates (not purged, not expired, with a preview): `preview.athletes[].gpexeAthleteId`, plus the raw rows of a blocked session. No GPEXE name is stored anywhere. |
| `training_load.gpexe_athlete_links` (v22) | team ↔ GPEXE athlete id ↔ OptiMove athlete | Two partial unique indexes: one active link per GPEXE id and per athlete in a team. A trigger requires an active team membership. Rows are never deleted, only unlinked. The application refuses a non-canonical id (PR #118). |
| `training_load.source_team_bindings` (v27) | team ↔ connection ↔ source team, `active` / `ended` | One active binding per team and source. Rows never disappear. The immutability trigger allows only the end. |
| `training_load.source_credential_connections` (v27, v29) | The club's encrypted credential and its state | `verified` is the only state an import reads through (F3c2g). |
| `training_load.source_connection_audit` (v27) | Append-only audit | `auto_invalidate` with basis `system` is the 401 pattern of an import read. |

## 2. Where the athletes of the bound team come from, without a client id

A check that read through the binding (`source_path = 'source_connection'`) stores a candidate whose
bundle the F3c2c adapter built only from a session it confirmed as the bound team's, and from athlete rows
that the confirmed session's own list named. The preview's `athletes[].gpexeAthleteId` is checked against
the canonical pattern by the mapper. So the server can derive the set of athlete ids on its own:

- the candidates of the team that are still available (`raw_purged_at is null`, `raw_expires_at > now()`,
  `preview is not null`);
- of these, only candidates first or last seen by a check that **succeeded** and read through **the
  team's current active binding** (`source_path = 'source_connection'`, `source_binding_id` = the active
  binding). A legacy-path candidate, a candidate of an ended binding or one seen only by a failed check
  gives no id;
- the canonical ids of their preview athletes (`^(0|[1-9][0-9]{0,11})$`, the same rule as everywhere).

Raw rows of a blocked session and link-only athletes are left out. They are not part of a successful
check of this binding. The client sends no id: the POST body is `{ requestKey }` and nothing else.

## 3. Authorization and workspace on *Link athletes* today

- `resolveGpexeTeamAccess()` (`backend/src/gpexeImportAccess.js`) is used by every route of the GPEXE
  router. The team must be active, and the caller must manage it (team coach, club admin of the team's
  club, or platform admin) in a workspace that contains it: platform for a platform admin, the team
  workspace, or the club workspace for a platform admin or the club's admin. Anything else gets
  `404 {error:"notFound"}`.
- `adminViewerOf()` in the router: a platform admin, or the admin of the team's club, sees the precise
  connection codes. A coach gets the stable code.
- The source-connection admin rule (`resolveConnectionAdmin()` in
  `backend/src/sourceConnectionService.js`): a platform admin only in the platform or a club workspace;
  a club admin only in their own club's workspace. `rightsStillHold()` re-reads the right and the club
  `FOR SHARE` before any write.
- **Identity follows the stricter, connection-admin rule.** It is open to a platform admin in the platform
  workspace or in the team's club workspace, and to the active admin of the team's club in that club's
  workspace. A team workspace, a coach, another club, an inactive admin, an archived team or club, and a
  team without an active binding all get the same `404 {error:"notFound"}` the router gives today. The
  right is read live on every request, and again `FOR SHARE` before any write.

## 4. The requestKey / outcome_unknown pattern

- **Unbind (F3c2f):** a client-chosen UUID. Its request record is the audit row of the successful Unbind.
  A replay is answered behind the user and connection locks, and the right is re-checked even on a
  replay. A refusal is not a request record.
- **The F2 / F3c2d COMMIT discipline:** the COMMIT answer is awaited at most 15 s. After an error or that
  time, the record is looked for on another connection (at most 5 s). The answer is then
  `verified_after_commit_error`, or `503 outcome_unknown` naming what to check. "Nothing was written" is
  never said after the COMMIT was sent.
- **Frontend (5a3b, F3c3):** "Result not confirmed · Check result" repeats the same key and never sends
  by itself. A double click sends one request. A write in flight locks the other writes.
- The identity load needs its own request record, because the audit table has no fitting action and its
  CHECK would have to change. A small table, `gpexe_athlete_identity_requests`, holds the key, the team,
  the binding, the user, `running` / `completed` / `failed`, counts only, and a stable code. A partial
  unique index allows one `running` load per team, so two loads cannot run in parallel. A `running` row
  older than the action's maximum duration is closed as `failed` / `abandoned` by the next load or replay.

## 5. Retention of the raw snapshot

`training_load.purge_expired_gpexe_raw(p_limit)` (v22) is plain SQL. Any runner calls it: every check,
the web server at start and every 6 hours (`startGpexeRetentionSchedule`), and the CLI
`npm --prefix backend run gpexe:retention` for an external scheduler. Readers already treat an expired
snapshot as gone. The identity snapshot follows the same shape: `purge_expired_gpexe_athlete_identities`
is called by `runRetention()` (and therefore by all three runners) and by every identity load. Every read
filters on `expires_at > now()`, so an expired row is never shown or used, even before it is deleted.
`retentionStatus()` reports expired identity rows that are still stored, and the CLI fails when there are
any.

## 6. Unbind and archive paths that must remove the snapshots

- **Unbind:** `unbindTeam()` turns the binding `active → ended`. The only other writer is a raw SQL
  UPDATE, which the v27 trigger allows only for that change. A database `AFTER UPDATE` trigger on
  `source_team_bindings` deletes the identity rows of the ended binding in the same transaction, whoever
  ends it.
- **Team archive:** `DELETE /api/organization/teams/:id` sets `public.teams.is_active = false`. An
  `AFTER UPDATE OF is_active` trigger on `public.teams` deletes that team's identity rows. There is a
  precedent: v27 already has a trigger on `public.teams`.
- **Club archive:** `DELETE /api/organization/clubs/:id` sets `public.clubs.is_active = false`. An
  `AFTER UPDATE OF is_active` trigger on `public.clubs` deletes the identity rows of every team of that
  club.
- **Display stops at once anyway:** every identity read joins the active binding, the active team and
  the active club, and the route resolves the team as active first.
- **Ordering against a load:** the load's write transaction locks the connection, the binding, the team
  and the club `FOR SHARE`, in that order, before it inserts. An Unbind (`FOR UPDATE` on the binding) or
  an archive (the row's UPDATE) is therefore ordered against it either way. If the end comes first, the
  load sees it and writes nothing. If the load comes first, the trigger deletes what it wrote.

## 7. Migration and rollback

A new migration is needed: **v32**, `migrations_v2/202610061000_training_load_v32_gpexe_athlete_identities.sql`.

- **Tables:** `training_load.gpexe_athlete_identities` (the snapshot) and
  `training_load.gpexe_athlete_identity_requests` (the request record).
- **Triggers:**
  - an insert check on the snapshot;
  - a refusal of every update;
  - the three delete triggers of section 6.
- **Function:** the purge.

No existing table, row or constraint changes. The rollback is
`docs/runbooks/gpexe-athlete-identities-v32-rollback.sql`. It is forward-safe:

- it refuses while a later migration is recorded;
- it deletes the snapshot rows itself, because they are a 14-day cache that may never outlive the feature;
- it refuses while a request row exists that is not `failed`, because that row is the load history;
- it drops exactly what v32 created, so the catalog returns to v31.

It is rehearsed on a disposable database: apply → invariants → rollback → identical prior catalog →
reapply → a failing last statement leaves nothing behind.

**Application encryption of the two personal columns** is decided in the security / database review, not
assumed. The proposal is plaintext:

- `public.athletes` already holds names and `birth_date` in plaintext;
- the snapshot holds one sanitized display name and one date for at most 14 days;
- there is no search on either column, so no index is needed;
- a column key would add a second key purpose with rotation, and it does not protect against the
  application server itself.

The open risk is backups, which can outlive the 14 days, and it is recorded.

**Decision after the reviews:** plaintext. The database review and the security review both recommend
against application encryption, for these reasons:
- the only key ring lives in the same environment as the database credential;
- it would defeat the database CHECK guards and the server-side date comparison;
- it does not fix the backups.

The runbook therefore states the backup exposure and the purge before a restored copy is used.

## 8. Relation to the open PR #142

PR #142 (`docs/gpexe-pilot-retest-and-link-discovery`, head `fdbe8db`) changes only
`docs/ai/CURRENT_STATE.md` and `docs/runbooks/gpexe-owner-pilot-f3c3.md`. It is not touched here.

- **The runbook:** this PR does not edit `gpexe-owner-pilot-f3c3.md`. The read-only review steps stay
  valid: the identity load is a separate, explicit administrator action, and nothing in those steps
  presses it.
- **`CURRENT_STATE.md`:** both PRs edit it. This PR edits it in its own places: the top line, a new
  paragraph after the PR #143 record, the deploy list and "Most likely next step". Whichever merges second
  needs a mechanical rebase of those lines. There is no conflict of content.
- **One sentence of PR #142 will be superseded:** "GPEXE names are never stored". After this PR, an
  administrator may store the sanitized GPEXE name and date of birth for 14 days, by an explicit action.
  The source-athletes list and its helper values are unchanged, and a coach still sees no name. This PR
  says so where it records the feature, so the two documents do not contradict each other once both are
  merged.
