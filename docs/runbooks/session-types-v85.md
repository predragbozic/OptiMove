# v85: session types (ST-1)

Migration `migrations_v2/202611201500_training_load_v85_session_types.sql`. The plan is `docs/ai/session-type-plan.md`,
merged as PR #699; section 14 records what was built. The files beside this one are:
- `session-types-v85-preflight.sql`;
- `session-types-v85-postcheck.sql`;
- `session-types-v85-rollback.sql`.

The rehearsal tool is `backend/scripts/session-types-v85-rehearsal.mjs`, with bash (`.sh`) and PowerShell (`.ps1`)
wrappers.

## What it does

- **The registry.** `training.activity_types` stays the one registry. It gains:
  - the owner: `system`, or `club` with its club;
  - the creator;
  - the archive (who and when; `is_active` is the flag);
  - a sort order and `updated_at`.

  The six system types carry the owner's labels: Full training, Game, Friendly game, Exercise, Compensation and RTP.
  `testing_session` and `recovery_session` are archived from the pickers, and the activities that hold them keep them.
- **The log.** `training.activity_type_changes` is append-only. It is also the request record of the routes.
- **The guards** (the acting user `optimove.session_type_actor`, with rights locked users first):
  - every type write needs its log row by COMMIT;
  - no delete, and key, owner and creator are write-once;
  - every write of `training.activities` takes only a type offered to its owner (a system type, or a type of the
    activity's own club), and a newly set type must be active;
  - `training_load.source_session_types`, the team's suggestion per source category, is seeded with
    `FULL TRAINING` → `training_session` for each team with an active gpexe binding.
- **What it does not change.** It changes no activity and no other row. The routes of the same pull request read and
  write the list (section 14 of the plan); nothing in the import uses the list before ST-2.

## Before the merge

1. **PostgreSQL 17 rehearsal** (production runs 17.6). This needs a PostgreSQL 17 server on loopback, `node`, and this
   repository with `npm --prefix backend ci` run once.
   - Linux / macOS: `backend/scripts/session-types-v85-rehearsal.sh --host 127.0.0.1 --port 5432 --user postgres --pg-bin /usr/lib/postgresql/17/bin`
   - Windows: `powershell -ExecutionPolicy Bypass -File backend\scripts\session-types-v85-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres -PgBin "C:\Program Files\PostgreSQL\17\bin"`

   It prints PASS or FAIL per step and `RESULT: PASS` at the end. It creates and drops only its own
   `optimove_tests_st1rehearsal_*` databases.
2. **Preflight**, read-only, each block as `begin transaction read only; <block>; rollback;`. Every ok column must be
   true. Keep block 3a for post-check block 6.
3. **Block 6 of the preflight, in git:** the 12-digit prefix `202611201500` is unique on the merge tree.

## After the deploy

- **Post-check**, read-only. Every ok column must be true. Block 6, the activities per type, must equal preflight
  block 3a: v85 writes no activity.
- The routes answer 401 without a login:
  - `GET /api/training-activity/session-types`;
  - `POST /api/training-activity/session-types` with `{}`.

## Rollback

`session-types-v85-rollback.sql`, one transaction, at a quiet moment, and only on its own approval.
- **Before running it:** the deployed commit no longer contains the v85 file, otherwise the next start applies v85
  again.
- **When it refuses**, changing nothing: once a type was added, renamed, archived or restored in the app, a club type
  exists, an activity holds one of the four new types, or a team suggestion was set. From then on v85 is forward-only.
- **What it restores:** the v1 labels ("Training session", "Match") and testing / recovery active again. The catalog
  and the type rows then equal those before v85; the rehearsal's step 6 and
  `backend/tests/session-types-v85-migration.test.mjs` test 1 check this.

## Known limits

- The guards prove that the row, the actor and the right agree. They do not stop whoever holds the database
  credentials (as v35 states it).
- A log row could be written without a type change, for example a "rename" log row naming the current label. It
  changes nothing.
- The Training Load calendar shows the key words until ST-5 reads the labels.
- The log guard checks `new_label` against the type row, not `old_label` against the label before. A `create` row for an
  existing type passes too. These are the limits of a trusted acting user, as in v35.
- Labels are unique per owner only, so a club type may carry a system type's name. ST-5's pickers name the owner.
- **Follow-up (code review, LOW):** the older metrics API's activity materializer (`backend/src/trainingActivityMetricsLink.js`)
  does not check `activityTypeKey` for being active. After v85, an archived key (`testing_session`, `recovery_session`)
  sent there by a hand-made API call meets the guard's 23514 and answers 500, with nothing written. No screen sends the
  field. The fix is `assertActivityTypeKeyValid` on that path, in a later pull request that touches it.
- The activity guard refuses moving an activity that holds a club type to another club's team (23514). That is the
  intended rule, and it cannot happen today: teams do not move between clubs (D43), and a reparent stays within one
  owner.
