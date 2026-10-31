# Runbook: migration v50 and ending a held source instance (phase 7g)

Contract: `docs/ai/phase7g-source-instance-end-contract.md` (J13; accepted with PR #297; OD5 decided on 2026-10-30, the
narrower reading; R1–R6 decided by the *Rukovodilac*). J13 names the migration v49 "if none comes between": the
calendar's events took v49 (`migrations_v2/202610311000_calendar_v49_events.sql`, PR #298), so it is **v50**.

- **v50** (`migrations_v2/202610311200_training_load_v50_source_instance_end.sql`): the database guard of the one write of
  `training_load.metric_source_connections.state` (v11; C76).
  - **A check before anything changes:** the body in force of `training_load.source_metric_audit_revision_guard()` is
    v48's (its md5); otherwise the migration refuses (`23514`) and changes nothing.
  - **The v11 state guard** (`metric_source_connections_v50_state_guard`, BEFORE UPDATE OF `state`, only when the state
    changes): `inactive → active` is always refused; `active → inactive` only for a team-owned row that already held its
    T7 keys before the UPDATE, with no owner change in it, by the acting user of the transaction (the v35 setting
    `optimove.source_metric_actor`) as an active platform admin, under the owner team's import lock (v24's
    `hold_gpexe_team_lock`), and only while the owner team has no active binding of the same source system, host and
    source team and no open activation on any of its bindings of it (an ended binding's open activation included, C58).
    An INSERT (the importer's) is untouched.
  - **At COMMIT** (`metric_source_connections_v50_audit_link_end`, deferred): an end has its `source_instance_end`
    audit row.
  - **The audit table (T8):** v48's revision guard gains the `source_instance_end` branch (the connection written in
    this transaction, now inactive, team-owned and keyed; the owner team, `active → inactive`, a reason, no evidence;
    by the acting platform admin; once per connection - the unique index `source_metric_audit_v50_instance_end_once`
    makes it physical). Every other line of v48's body stays byte for byte.
  - No table, column or data change.
- **The code** (one release with v50): `backend/src/sourceInstanceEndService.js` and the routes in
  `backend/src/routes/sourceMetrics.js`:
  - `GET /api/training-load/sources/metrics/source-instances[?state=active|inactive|all][&sourceSystem=…][&cursor=…]`
    lists the team-owned keyed instances in pages of 100;
  - `POST …/source-instances/:connectionId/end` `{ requestKey, reason, expected: { sourceSystem, sourceHostKey,
    sourceInstanceKey } }` ends one (200);
  - an active platform admin in the platform workspace only; everyone else gets the identical 404.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets v49 without v50.

**The code needs v50; v50 does not need the code.** The end route writes the audit row v50 checks, and v48 refuses
every `source_instance_end` row, so an end fails (`500`) on a database without v50 - which the deploy order rules out.
Without the new code, v50 changes nothing a writer does: no code changed `state` before phase 7g, and no code writes the
T7 keys before M4, so every connection answers `instance_not_held` until M4.

**v50 is written on v48's text**: it replaces v48's body of the audit guard, and the migration and the preflight check
that body's md5.

## Before the merge (the standing order for migration PRs)

`docs/ai/metrics-core-plan.md`, section 2, "Standing order for migration PRs", applies. The executor never calls a
Supabase connector tool and never touches the production database.

1. The *Rukovodilac* runs `docs/runbooks/source-instance-end-v50-preflight.sql` read-only, one block at a time, on the
   same UTC day as the merge. Every value must be the expected one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows v48 and v49 recorded with their checksums, v49 as the last migration, and no v50;
   - block 3 shows v48's revision guard, `source_metric_audit_row_ok` and `source_metric_audit_actor_guard` in force;
   - **block 4 is a hard assertion: `safe_to_merge = true` (no `source_instance_end` row and no keyed inactive
     connection).** Anything else: stop, do not merge, report. `keyed_connections` is expected to be 0 before M4;
   - block 5 shows no v50 object;
   - block 6 shows the migrator's role may create the objects and owns both tables, and every trigger of both tables
     enabled;
   - block 7 shows no actor default;
   - block 8 must show a quiet moment (no writer on either table, no session idle in a transaction).
2. Both ★★ GOs on the exact head, the *Rukovodilac*'s naming the four files with their sha256, then the
   *Rukovodilac*'s merge order (section 2, step 1).

## Deploy order

1. The merge from exactly the reviewed head.
2. The *Rukovodilac*'s notice to the owner that the next deploy migrates production (section 2, step 3), and the owner's
   „da” (or the owner's own deploy of exactly that commit).
3. The deploy of exactly that commit through the Render API by the *Rukovodilac* (step 6).
4. The *Rukovodilac*'s smoke (without a login, the two new routes answer `401`) and its read-only post-check.

No PR is merged into `main` from the merge until the deploy and the post-check have passed. While v50 runs, a session
that is inserting or updating a connection (the importer creating its connection) makes it wait, bounded by the
runner's `lock_timeout`; a reader never does. While the old server still serves during the deploy, it has no
source-instance route (`404`).

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before any instance is ended, run `docs/runbooks/source-instance-end-v50-postcheck.sql` one block at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 compares the three function bodies by md5;
   - block 3 shows the state guard (BEFORE UPDATE, with its WHEN clause) and the deferred link enabled;
   - block 4 shows the index valid;
   - block 5 shows no instance ended yet.

## A rollback

`docs/runbooks/source-instance-end-v50-rollback.sql` (rehearsed on disposable databases by
`backend/tests/source-instance-end-7g.test.mjs`). It refuses, changing nothing, once any `source_instance_end` row or
any keyed inactive connection exists: from then on the way forward is a new migration. Roll back newest first: v49's
rollback refuses while v50 is recorded. Before it is run anywhere real: a fresh restore-verified backup; the deployed
commit no longer carries v50 or the phase 7g routes; the owner's approval for that database.

## Ending an instance: what happens

- **Who:** an active platform admin in the platform workspace, with a reason. The reason is written to the audit row
  only.
- **What:** the connection's `state` turns `inactive`; nothing is deleted or moved, and every event, identity, value,
  provenance row and dashboard series keeps pointing to it (C36). An ended instance stays ended.
- **Refused while in use:** an active binding of the owner team to that source team (`instance_binding_active`), or an
  open activation on one of the owner team's bindings of it (`instance_in_use`; end it first). A check, an import, a
  bind, an Unbind or a settings change running for the owner team makes the end answer `try_again`.
- **Today nothing can be ended:** no code writes the T7 keys before M4, so every GPEXE connection answers
  `instance_not_held`.
