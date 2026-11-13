# Scaling a short recording (MT-D, migrations v68 and v69)

Plan: `docs/ai/mt-multiple-tracks-plan.md` sections 10 and 13, decided by the *Rukovodilac* on 2026-11-13.

## What it is

An athlete recorded for part of a session gets a yellow "Check" hint on the session review (6a). An example is a substituted
player: 20 of 40 minutes. Before the import, whoever may approve may choose **Scale the recorded part** with target minutes.
The default target is the session's longest recorded time.

- **The import** writes only this athlete's `max`, `last` and `none` values, as measured. The whole-session `sum` values are
  left out as `scaled_by_choice`, and an `avg` value is left out as `not_scaled`. Drill values are imported as measured.
- **The preview** carries `scaleRecording: { targetMinutes, recordedMinutes, values }`. It is part of the preview hash, so the
  approval binds exactly the numbers the coach saw.
  - It is `{ notPossible: "no_duration" | "not_shorter" }` when the team has no minutes variable or the recording is not
    shorter than the target.
  - In that case the athlete is imported as without a choice.
- **After the import,** the 6b save with `method: "scale_recording"` writes each sum as an estimate: measured × target ÷
  recorded. The duration becomes the target.
  - The basis is `{ measured, recordedMinutes, targetMinutes }`.
  - The numbers come from the imported candidate's stored preview, never from a second mapper run.
  - After the retention purge (90 days after the import) the save answers `409 scale_basis_expired`.
- **Behind `ESTIMATES_ENABLED`.** While it is off, the PUT refuses a scale (`409 scale_not_available`), so no athlete's sums
  are left out with no way to save them. The flag is turned on only after 6b-D, on a separate owner order.

## Routes

- `PUT …/candidates/:candidateId/track-choices/:gpexeAthleteId` (MT-A's) also takes
  `{ choice: "track", trackId, scaleTargetMinutes, … }`.
  - `scaleTargetMinutes`: a number, 0 < x ≤ 600, with at most two decimals. It is allowed with `track` only.
  - **One-track athlete:** a scale, or `cleared` to remove one. Without a scale the answer is still `not_multiple_tracks`.
  - **Multi-track athlete:** the scale rides on its picked track.
  - **MT-0 athlete** (identical tracks): no scale in v1, so `not_multiple_tracks`.
- `GET …/track-choices` also lists a one-track athlete that holds a choice, and answers `scaleAvailable` (the flag).
- `POST /api/training-activity/:activityId/estimates` takes `method: "scale_recording"`, with no `minutes` and no
  `sourceAthleteId`. It answers:
  - `scale_not_chosen` for an athlete without a scale;
  - `scale_not_possible` with the reason;
  - `scale_basis_expired`.
- The proposal answers `methods.scale_recording`.

## The migrations

- **v68** (`202611131300_training_load_v68_track_choice_scale.sql`) changes `gpexe_track_choices`:
  - `scale_target_minutes`, with the range CHECK;
  - `gpexe_track_choices_scale_on_track`;
  - the fingerprint CHECK accepts one track;
  - `gpexe_track_choices_one_track_scale`: a one-track row is a `track` row with a scale, or a `cleared` row.

  v67's guard is unchanged: it already checks the track against the fingerprint and the chain.
- **v69** (`202611131310_training_load_v69_scale_recording_estimates.sql`):
  - the method CHECK takes `scale_recording`;
  - `estimate_basis_ok` gets its branch, under an md5 gate on v63's body.

  v64's provenance guard already refuses any method other than `copy_athlete` or `team_average` for a non-`sum` variable. So
  `scale_recording` is sum-only without a body change.
- **Two files, not one.** Suites that build their database through v67 without v63 and v64 apply v68 alone: MT-B's preview
  reads `scale_target_minutes` on every check. U5's v57 rollback rehearsal needs v57's bodies.

## Deploy steps (★★)

1. Both GOs, and the owner's order naming both files.
2. The *Rukovodilac* runs `scale-recording-v68-v69-preflight.sql`, each block in a read-only transaction. Every boolean must be
   true.
3. Merge, then deploy. The migrator applies v68 and v69 at start-up.
4. Run `scale-recording-v68-v69-postcheck.sql`. Every boolean must be true. Block 4 must show nothing scaled.
5. Smoke without a login: `PUT …/track-choices/1` and `POST /api/training-activity/<zero>/estimates` answer 401.

## If v68 applies and v69 fails

The runner applies each file in its own transaction (`backend/src/migrate.js`: `begin`, the file, its record, `commit`). So if v69
fails, v68 stays committed and recorded, nothing of v69 remains, and the start command (`node src/migrate.js && node
src/server.js`) stops. The new server does not start, and Render keeps the previous deploy serving.

**That is a safe state.**
- The previous code (MT-B) never selects `scale_target_minutes`.
- It never writes a one-track or scaled choice. Its multi-track rows pass v68's CHECKs, and the wider fingerprint CHECK accepts
  every v67 row.
- Every check, recompute, approval and track-choice PUT works as before.

**The remedy:**
1. Read the runner's `ABORT applying …v69…` line (SQLSTATE and message) in the deploy log.
2. If a v69 precondition refused (another body of `estimate_basis_ok`, or the method CHECK missing or renamed): stop. Find out
   what changed the function or the CHECK before any new deploy. The *Rukovodilac* re-runs preflight block 3.
3. If it was a lock wait (`55P03`, the runner's 30 s `lock_timeout`): deploy the same commit again at a quiet moment. The runner
   skips the recorded v68 and applies v69.
4. If MT-D is abandoned instead: deploy a commit without MT-D's code and files, then run `scale-recording-v68-rollback.sql`. It
   refuses nothing at this point, because no scale or one-track choice can exist yet.

**Rollback:** first `scale-recording-v69-rollback.sql`, then `scale-recording-v68-rollback.sql`.
- Each refuses once what it removes is in use (a scaled estimate; a scaled or one-track choice) or a later migration is
  recorded.
- The deployed commit must no longer contain MT-D's code. The preview reads the scale column on every check, recompute and
  approval.
- Rehearsed in `backend/tests/scale-recording-mt-d.test.mjs`.
