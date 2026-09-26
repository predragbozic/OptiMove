# Migration v26 — roster decisions, completion and the automatic needs review (Phase 5a2)

`migrations_v2/202609252000_training_load_v26_activity_roster_decisions.sql`.
Contract: `docs/ai/phase5a-discovery-and-contract.md` (section 11, "As built in 5a2").
Needs v25 (`docs/runbooks/activity-roster-v25.md`).

## What it adds

Only functions, triggers and one index; no table, column or row of v25 changes.

- `training.lock_roster_team(team, exclusive)` and
  `training.lock_roster_completions(ids[], exclusive)` — transaction advisory
  locks. Every writer that can change a roster takes them **shared**; Complete
  takes them **exclusive** before it recomputes the roster.
- `training.lock_activity_decider` redefined: every basis also holds the team's club (active) `FOR SHARE` (order team → club → role → user), so archiving the parent club waits for any decision in flight and refuses every basis afterwards. The rollback restores the v25 definition.
- `training.roster_record_change(...)` — the one place a roster change becomes
  a completion change (`complete → needs_review`, a new cause on
  `needs_review`, or, for a coach decision, a revision bump that also creates
  the completion row). One log row per revision; the same cause on a session
  already under review writes nothing.
- 14 statement-level triggers, one per input table and operation (see the table below).
- `training.activity_roster_needs_state(activity)` — the SQL twin of the read
  model's "Needs a state".
- Audit rules raw SQL cannot skip: one log row per completion revision (unique
  index + a check at commit), a log row describes the completion row it
  follows, each cause allows only its own transition, `completed` / `reopened`
  carry the request, the user and a basis the user holds, a completion row
  starts at revision 1 and becomes complete only over a non-empty roster
  where nobody needs a state, and a new decision is the only current one of
  its athlete in the whole alias set.

| Input (table, operation) | Cause |
|---|---|
| `activity_athlete_decisions` insert | `decision_changed` |
| `metric_measurement_occasions` insert; update of `import_conflict_status` / `superseded_by_occasion_id` | `measurement_changed` |
| `metric_source_identities.current_occasion_id` update | `measurement_changed` |
| `activity_participant_metric_participant_links` confirmed insert; `link_status` change to / from confirmed | `link_changed` |
| `activity_metric_event_links` confirmed insert; `link_status` change to / from confirmed | `link_changed` |
| `activity_participants.activity_id` update (reparent; source and target) | `roster_changed` |
| `activity_participants` merge (`merge_status` / `superseded_by_participant_id`) | `activity_merged` |
| `activities.superseded_by_activity_id` set (the survivor) | `activity_merged` |
| `activities.started_at` / `occurred_local_date` / `timezone_snapshot` change | `roster_changed` |
| `activity_source_observations` insert / resolve | `record_unusable` or `change_pending` (the kind) |
| `athlete_membership_periods` insert / close over the date of a complete or needs-review session of the team | `roster_changed` |
| (a read found a changed fingerprint that no trigger saw; the next command writes it) | `input_changed` |

## Lock order

A roster command: `lock_activity_decider` (team, role, user and, for a club
admin, club rows `FOR SHARE`) → team import advisory lock → *Complete only:*
`lock_roster_team(exclusive)` → the alias set's activity rows `FOR KEY SHARE`,
ascending → *Complete only:* `lock_roster_completions(exclusive)` → completion
rows `FOR UPDATE`, ascending → request key, checks, writes, request row last.

Writers reach the shared completion lock and the completion rows from their
own position (an import after its team lock; a reparent or merge after its
activity rows `FOR UPDATE`; a link writer after its activity row; a
membership change after its membership row and `lock_roster_team(shared)`),
and none takes an earlier lock of the list afterwards, so there is no cycle.
Roster commands set `lock_timeout = 15s` (answer `503 roster_busy`, nothing
written); the COMMIT's answer is awaited at most 15 s and the check after an
uncertain COMMIT at most 5 s (answer `503 outcome_unknown`). The GPEXE approval's own unbounded waits (Separate tasks, condition
2) are unchanged; a writer that waits behind a paused Complete waits as long
as that Complete.

## Applying it

Never automatically on a persistent database. Merging the PR applies v26 to
the deployed database on the next deploy (`npm start` runs
`node src/migrate.js` first). The local OPTIMOVE database is at v21 and needs
v22–v25 first, a fresh restore-verified backup and its own approval.

Rehearsed on disposable databases only (`backend/tests/activity-roster-5a2.test.mjs`,
test 56): v26 applied by the runner on a v25 copy; the rollback below returned
the functions, triggers and indexes to exactly v25 (catalog digest) and kept
every row; v26 applied again identically; a v26 that fails at its last
statement left nothing and was not recorded.

## Rolling it back

Prefer a roll-forward fix. `docs/runbooks/activity-roster-v26-rollback.sql`,
one transaction, only:

1. after the application is back on a commit without Phase 5a2;
2. with a fresh, restore-verified backup of that database;
3. with the owner's approval for that database.

It removes only v26's functions, triggers and index, and restores the v25
`lock_activity_decider`. Decisions, requests,
completions and their log stay (history); the v25 read keeps reading them.
From then on a complete session is no longer downgraded by a trigger; the
read's fingerprint comparison still reports it as needs review
(`input_changed`) when its inputs changed.
