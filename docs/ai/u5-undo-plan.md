# U5 plan - in-app undo of an imported session (migration v57, ★★)

Status: Accepted (the *Rukovodilac*'s plan GO on head `aabfe3b8`, 2026-11-05, with the answers in section 7). Contract: `docs/ai/j19-u5-undo-contract.md` (decisions in section 9, as built in section 10). Triggers 1, 3, 4.

## 1. Discovery: what the CLI does not know (checked on `8e296a25`)

The CLI (`backend/scripts/gpexe-undo-imported-session.mjs`) was written at v21. Since then:

1. **Approvals (v23).** `gpexe_import_approvals` keeps `metric_event_id`, `activity_id`, `import_batch_id` as plain values (no FK), so the removal is not blocked and the approval stays as history. Good.
2. **The imported candidate is final** (v22/v23 `protect_gpexe_import_candidate`): its status and `imported_at` never change, it is never deleted, and `unique (owner_team_id, gpexe_team_session_id, bundle_hash)`. The check's staging (`gpexeImportService.js` ~1262, ~2221-2251) matches existing content by that key. So "a fresh pending candidate of the same content" (Q3) cannot be an INSERT or a status change today.
3. **Calendar links (v49).** `calendar.event_activity_links.activity_id` references `training.activities` (`on delete restrict`, rows are never deleted). An undo that deletes an activity a coach attached to a calendar event would fail on the FK, or, worse, be forced around. The CLI knows nothing of it.
4. **Provenance (v34), source observations (v25), roster work (v25)** the CLI already handles; the v53/v56 changes added no new reference to events or activities (grep of `references training_load.metric_*` / `training.activities` in `migrations_v2` after v25: only v34 provenance and v49 links).
5. **Triggers to except** (each true only inside the function's transaction): v13 `metric_values_immutable`, v20 `metric_event_source_bindings_immutable` and `_no_delete`, v25 `activity_source_observations_append_only`, v34 `metric_value_source_provenance_append_only`. The CLI disables exactly these five.

## 2. Design

**Function** `training_load.undo_imported_session(p_actor uuid, p_candidate_id uuid, p_request_key text, p_reason text, p_expected_preview_hash text)`; `SECURITY DEFINER`, `search_path` pinned, execute revoked from public. One transaction. It sets the transaction-local marker `optimove.session_undo_tx = txid_current()` (the v35 / v56 pattern); each of the five triggers gets one early return `if current_setting('optimove.session_undo_tx', true) = txid_current()::text then return old` for DELETE only (UPDATE stays refused). A session-level `SET` cannot satisfy it (the transaction id differs), a raw DELETE from anywhere else is still refused.

**Lock order** (written in the function header; users first per the lock-order rule): acting user row `FOR SHARE` -> role row `FOR SHARE` (`user_global_roles`, platform admin) -> the team's import lock (`lockTeamForImport` key, try-lock, `55P03` -> `try_again`) -> the request row (replay answered before any further lock) -> the candidate `FOR UPDATE` -> the event `FOR UPDATE` -> its activities `ORDER BY id FOR UPDATE`. That is the importer's own order (team lock -> candidate -> event -> activities), so a concurrent import of the same team waits for, or is waited on by, the undo.

**Re-checks inside the transaction**, each a stable refusal code: candidate belongs to the team and is `imported` and not already undone; the approval row names an event that exists and equals the event bound to `team_session:<id>` of the team's active connection; the actor is an active platform admin (first version); the CLI's refusals (`manual_occasion`, `shared_activity`, `other_event_link`, `entangled_activity`, `two_events_for_session`); `roster_decisions_exist` (Q4: refused first); **new:** `calendar_link_exists` (any `calendar.event_activity_links` row, live or ended, on a reached activity). Scope is collected again after the locks, as the CLI does.

**Removal**: the CLI's order, statement for statement, then the single `import_deletion_log` row (basis `platform_admin`, in this version only), and the request row.

**The candidate (Q3), the one real schema decision.** The imported row stays `imported` (history, finality trigger unchanged for status and `imported_at`). v57 adds two nullable columns to `gpexe_import_candidates`: `import_undone_at timestamptz`, `import_undone_by_request_id uuid` (both set together, once, only by the function, enforced by the same marker; a CHECK ties them and requires `status = 'imported'`). The unique key becomes partial: `(owner_team_id, gpexe_team_session_id, bundle_hash) where import_undone_at is null`. The check's staging and finalization lookups (five places in `gpexeImportService.js`) gain `and import_undone_at is null`, so the next *Find new sessions* sees the session's content as **new** and writes a fresh pending candidate through the normal path, with a fresh preview; nothing is inserted by the undo, and no check result is faked. The list shows an undone row as "Import undone" in the hidden replaced versions (never as Imported, never approvable: `candidate_undone`, in `approveCandidate` and the batch). The imported-athlete and `changesToImported` logic reads imported *results*, which no longer exist, so it needs no change.

**Request record** `training_load.session_undo_requests` (idempotency, like v36 / v56): `request_key`, actor, candidate, request hash, outcome, counts; a replay answers the saved outcome; the same key with another body is `request_key_reused`; append-only triggers. Bounded COMMIT 15 s and the F2 discipline (`outcome_unknown` with the key, verified by the request row on a new connection).

**Route + UI.** `GET .../candidates/:candidateId/undo-preview` (read-only scope: counts per table and the refusal the function would raise, nothing written, no locks beyond a share read) and `POST .../undo-import` `{ requestKey, reason, expected: { previewHash } }`; platform admin only, the identical 404 for everyone else, no-store. UI: on an imported session's review an administrator-only "Undo this import" (two steps: the scope, then the confirmation naming session, team, athletes and consequence, a mandatory reason); lost answer = *Result not confirmed* + *Check result*.

**Out of this PR (by decision):** clearing roster decisions (Q4 step 2); widening the audience to the link-making circle (Q1 step 2, after the first production undo); the roles system; per-athlete bulk undo (Q5).

## 3. Migration v57 contents and rollback

Functions (the undo, the five trigger bodies with the early return, the candidate guard with the undone columns), the two candidate columns + CHECK + the partial unique index (replacing the full one), the request table + triggers. md5 preconditions on the five trigger bodies and the candidate guard. Rollback script: refuses once any request row, undone candidate or function-written log row exists, or a later migration is recorded; rehearsed apply -> rollback -> identical v56 catalog -> re-apply. Read-only production preflight and post-check scripts. `git diff --check` clean (no trailing blank line at EOF).

## 4. Tests (T1 runner, disposable databases) and mutations

The CLI's two suites re-run against the function; every refusal code; actor matrix with the identical 404; two-session races in both orders (import of the same team while undoing; role revocation; Link/Unlink; a second undo of the same candidate); raw DELETE on each of the five tables refused outside the function and a session-level `SET` unable to satisfy the marker; lock order by recorded SQL order (the rule of PR #346) and a concurrent importer; lost COMMIT and replay; log exactness; staging after an undo writes a fresh pending candidate and the undone row is neither approvable nor listed as Imported; mutations of every guard, each trigger exception and the partial index; the existing candidate/staging/approval suites run unchanged.

## 5. Reviews and gates

`db-reviewer`, `security-reviewer`, `code-reviewer` (+ `ux-design-reviewer`, `mobile-qa` for the UI) on a frozen head; both ★★ GOs; the owner's order naming v57; the *Rukovodilac*'s preflight. **Production use** stays gated: a fresh restore-verified backup (J19 condition 1) and the owner-run first undo; the main session never runs it.

## 6. Questions for the *Rukovodilac*

1. Is the candidate design acceptable (mark the imported row undone, partial unique index, let the next check write the fresh pending candidate), rather than an INSERT by the function?
2. `calendar_link_exists` as a hard refusal (a coach must unlink the calendar event first), or should the function end the live links itself? Recommended: refuse.
3. One PR (migration, service, route, UI) or two (v57 + backend, then the screen as U5b, like 7i-B1/B2)? Recommended: two.

## 7. The *Rukovodilac*'s answers at the plan GO (2026-11-05)

1. **The candidate design is accepted** (the imported row stays `imported` + `import_undone_at` / `import_undone_request_id`, partial unique key). The owner's Q3 is that the session reappears as Ready at once, so **the function itself writes a fresh pending candidate of the same content in the same transaction when the raw snapshot is still available**, which the partial key allows. When the snapshot is gone the session waits for the next *Find new sessions*, and the screen says so in one sentence.
2. `calendar_link_exists` is a hard refusal, like the roster decisions; its message names what to remove.
3. Two pull requests: **v57 + backend (★★)**, then the screen **U5b**.
4. `SECURITY DEFINER` only with a fixed `search_path`, and the function checks the right itself (users row, then role row: the v54 order). The marker is valid only inside that function; a test shows it does not pass from outside.

As built: the function is not `SECURITY DEFINER` (like v35 / v56: the application's role owns the tables, and a definer function would add nothing but a second place for the search path to matter); the right is checked inside it, users first.
