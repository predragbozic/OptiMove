# Track choices of a multi-track athlete (MT-A, migration v67)

Plan: `docs/ai/mt-multiple-tracks-plan.md` sections 5 and 8, with the *Rukovodilac*'s decisions of 2026-11-12.

## What it is

GPEXE sometimes records one athlete on two or more tracks in one session (a device restart). If the tracks are identical
copies of one recording, MT-0 imports the athlete once. Otherwise the athlete is left out as `multiple_tracks`, and the
whole session needs a review. MT-A stores the reviewer's decision about such an athlete:

- **Use one track** (`track`, with the track id);
- **None**: nothing from GPEXE for this athlete;
- **Clear the choice** (`cleared`): the athlete is `multiple_tracks` again.

Each decision is one row of `training_load.gpexe_track_choices`, append-only. A later decision supersedes the current one,
and the current choice is the row no later row supersedes. The table holds only ids (team, session, athlete, track), the
server-computed track-set fingerprint, who decided, on which right, and when. It stores no GPEXE name and no value.

**Nothing reads a choice yet.** The mapper and the preview apply it in MT-B. "Add them up" comes in MT-E, and scaling a
short recording in MT-D, under its own migration.

## Routes

Both routes sit under `/api/training-load/gpexe/teams/:teamId/candidates/:candidateId`.

- `GET …/track-choices` lists the session's multi-track athletes that MT-0 does not take as one recording. For each:
  - its tracks: start, zone, whole-session time and distance, drill indexes;
  - `sumOffered: false`;
  - `choosable` (false, with `notChoosableReason: "tracks_not_readable"`, when a track or row id is not a canonical GPEXE id:
    no fingerprint can be stored, so the athlete stays `multiple_tracks`, visibly);
  - the current choice, marked `stale` when GPEXE's tracks changed since it was made.
- `PUT …/track-choices/:gpexeAthleteId` takes `{ requestKey, choice, trackId?, expectedChoiceId }`:
  - **201** with the choice;
  - **200** with `replayed: true` for the same key and body;
  - **201** with `verifiedAfterCommitError` when the request key confirms a lost COMMIT;
  - **503** `outcome_unknown`: send the same request again; it is never saved twice.
- **Refusals** (409, nothing written):
  - `request_key_reused`;
  - `choice_changed` (with `currentChoice`);
  - `nothing_to_clear`;
  - `not_multiple_tracks`;
  - `track_not_in_session`;
  - `tracks_not_readable`;
  - `choice_final_after_import`: any version of the session is imported and not undone. The choice belongs to the session, so
    a newer candidate of an imported session is refused too. This is read under the team lock. Undo the import first;
  - `candidate_not_open` (a replaced version, or an import already undone: open the current candidate);
  - `snapshot_expired_check_again`;
  - `team_import_switch_off`;
  - `try_again`.

**Audience.** Whoever may approve the import for the team, through `lock_gpexe_import_approver`: a platform admin, a coach
with an approver grant, and in team mode (v56) the club's admin and the team's coach. Everyone else gets the identical 404.
That includes a right revoked during the request, and pilot mode for a club admin or a coach without a grant. A choice needs
the team's import switch on, as an approval does.

## Lock order

This is the approval's order (plan section 5):

1. the (author, request key) advisory lock, seed 67, then the replay;
2. the candidate FOR SHARE, **only while it is pending or blocked**;
3. the team's import lock (blocking, under the approval's `lock_timeout`; a wait answers `try_again`);
4. the team and its club FOR SHARE;
5. the approver's rights, last;
6. the athlete's current choice FOR UPDATE;
7. the insert, then a bounded COMMIT.

Step 2 never locks an imported candidate. The undo (v57) locks imported candidates FOR UPDATE after the team lock, so holding
one here while waiting for the team lock could deadlock. A candidate an approval imports meanwhile no longer matches when the
lock is granted, and nothing of it stays locked.

Proof is in `backend/tests/gpexe-track-choices-mt-a.test.mjs`:
- tests 10 and 11 record the SQL order of the PUT, the approval, the J20-A1 recompute and the check finalization, and read the
  undo's body;
- test 7 shows that a PUT on an imported candidate answers at once while another transaction holds the team lock and that
  candidate.

## The database guard (v67)

- The author is the transaction's acting user (`optimove.track_choice_actor`). The basis and grant are the ones
  `lock_gpexe_import_approver` gives under lock.
- A first choice supersedes nothing, and a later one supersedes the athlete's current one. The successor and the single root
  are each backstopped by a unique index.
- `cleared` clears a choice that is not already cleared.
- A chosen track is one of the fingerprint's tracks.
- UPDATE, DELETE and TRUNCATE are refused, the session undo included: a choice is not import data, and it stays after an undo.
- **Stated limits** (security review, LOW):
  - The guard proves the author and the right for the row's team. It does not bind the session id or the fingerprint to a
    candidate of that team; the service, the only writer, does that. As with v35, code that can set the actor setting through
    the application's pool is not stopped by the guard.
  - A replay by an approver is answered before the locked right and the team switch are checked. It returns only the saved
    choice, which the same person can read through the GET anyway.

## Deploy steps (★★)

1. Both GOs, and the owner's order naming `migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql`. The file
   takes the next free number at PR time.
2. The *Rukovodilac* runs the read-only preflight `gpexe-track-choices-v67-preflight.sql`, each block in a read-only
   transaction. Every boolean must be true.
3. Merge, then deploy. The migrator applies v67 at start-up.
4. The read-only post-check `gpexe-track-choices-v67-postcheck.sql`: every boolean must be true. Block 4 must show no choice.
5. Smoke without a login: `GET …/track-choices` and `PUT …/track-choices/1` (zero UUIDs) answer 401.

**Rollback:** `gpexe-track-choices-v67-rollback.sql`. It refuses once a choice exists, or once a later migration is recorded.
It was rehearsed in `backend/tests/gpexe-track-choices-v67.test.mjs` (apply, rollback, the exact catalog, re-apply).
