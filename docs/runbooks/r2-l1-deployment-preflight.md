# L1 integration, read-only preflight and recovery plan

Status: PR preparation only. No production SQL (including SELECT), Render/Supabase configuration change, deploy, R2 operation, GC or quota change has been performed or authorized. Every production step below requires separate approval. This is a plan, not an execution log.

## Reviewed release and migration order

Integration base: origin/main a585af8e61bbd5c950f61e0ddc060f415a624344, merge of PR #196. Rebase of local L1 commits onto that base completed without conflict. No #196 file is changed by L1. Phone metadata preparation and the 30-second inspection rule remain main's implementation.

Between the previous base 7704909 and a585af8, main added no migration and changed neither the migration runner nor backend dependency declarations. Relevant order remains:

1. 202610191100_media_storage_foundation.sql (BE-1).
2. 202610191300_media_upload_lifecycle.sql (BE-2).
3. 202610201100_media_reference_protection.sql (L1, the only new PR migration).

The runner scans the complete flat migrations_v2 directory, sorts names, rejects duplicate timestamp prefixes and verifies SHA-256 checksums of previously applied files. L1 is still unapplied/unpublished as a deployment: its file must never replace an earlier experimental 232692a database entry. If that name exists with a different checksum or partial objects exist without a ledger row, STOP; do not edit the ledger or rerun SQL manually.

L1 SQL SHA-256: a969eae0d3ef6c5ec45907db124e7250515feeea97c3309430bec292e06750c8. Offline inventory: 64 valid migrations, 63 main checksums unchanged, exactly one L1 addition.

## Pre-merge/production gates

| Gate | Evidence to collect after separate read-only approval | Required outcome |
| --- | --- | --- |
| Target and roles | Exact deployment connection for BOTH services; effective/session roles, DB/project identity, PG version, sanitized timeout settings. Do not print DATABASE_URL or secrets. | Correct shared project, PG15+, compatible runtime role, READ COMMITTED. |
| Privileges | USAGE/CREATE on media; source SELECT; TRIGGER on tables receiving triggers; REFERENCES/locking privileges and execute on existing audit guard. New objects owned by the effective migration role; runtime must inherit appropriate private rights. Prove complete source visibility using owner/BYPASSRLS and FORCE RLS/policies; SELECT permission alone can hide rows. | All required operations supported, no public privilege workaround. |
| Ledger/baseline | Existing cutover/baseline, complete schema_migrations listing and offline comparison against release checksums; expected source columns/FKs. | BE-1/BE-2 present, all pending migrations identified, L1 absent or exact reviewed checksum already applied. |
| References | Migration-equivalent aggregate validation of exercise/item/ancestry asset IDs, status and kind. | Zero invalid selections. Nonzero is BLOCKED, no automatic repair. |
| Scale | Estimated/exact source counts, R2-plan count, eligible hold/member estimate and largest plan. | Synthetic disposable rehearsal at comparable scale; otherwise duration UNKNOWN. |
| Contention | Long transactions, locks/waiters and visibility completeness. | No competing app writers or unresolved blockers at the migration window. Hidden activity is UNKNOWN. |
| Timeouts/startup | Actual Render start commands and effective MIGRATION_LOCK_TIMEOUT_MS / MIGRATION_STATEMENT_TIMEOUT_MS on both services; DB/role defaults and pooler mode. | Known bounded budget; compatible session semantics for runner advisory lock. |
| Release controls | Main auto-deploy and any cron/worker/preview startup processes sharing this DB. | Operator can prevent unintended deploys and stop all old app writers during the schema transition. |

Proposed queries are in r2-l1-preflight.sql. They are NOT run by tests or application startup and have not been executed in production. They use BEGIN READ ONLY, bounded SELECTs, SET LOCAL timeouts and ROLLBACK. Execute sections separately after approval; if any section errors, roll back and report FAIL/UNKNOWN. Some checks intentionally require existing BE-1 relations; stop if the preceding relation inventory is incomplete.

The supplied scale queries cannot measure DDL/backfill duration. Never run a migration, EXPLAIN ANALYZE of mutating SQL, temporary trigger or backfill rehearsal on production under read-only approval. Use synthetic data on disposable PostgreSQL matching counts/distribution to estimate time and headroom; production timing remains an estimate. Query-plan EXPLAIN without ANALYZE may later be approved read-only, but is not part of this execution.

Runner defaults in repository: lock timeout 30 seconds, statement timeout 120 seconds; advisory-lock polling can wait up to 5 minutes. They are not assumed to be current Render values. Trigger DDL retains locks until transaction commit; the complete backfill is the final DO statement and must fit its statement budget. Sum of statements, waiting for the runner lock, and app boot must fit the deploy/health-check window too. Do not silently increase any timeout; if estimates do not fit, stop and design a separately reviewed bounded backfill/release change.

## Proposed deployment sequence — NOT authorized now

1. Obtain read-only production preflight approval and resolve every FAIL/UNKNOWN needed for deployment. Separately approve the release window, write-drain mechanism and recovery authority.
2. BEFORE merge, the operator controls auto-deploy on BOTH Render services, plus any startup-triggering worker/cron/preview. No settings are changed in this task. Do not merge while auto-deploy can bypass the agreed window.
3. Record the exact reviewed release SHA and expected L1 SQL checksum. Preserve the current healthy release identity and verify existing recovery/backup availability without initiating backup/restore here.
4. Prevent all business writes through BOTH old backends before the new schema commits. A future approved operator action must provide a verifiable ingress maintenance/write block, or stop old processes and block their public entry points. Merely deploying one new service while an old service keeps serving writes is unsafe. There is no assumed in-app maintenance flag; if an effective drain cannot be provided, deployment is BLOCKED. Include background writers in the drain.
5. With old writes stopped, perform a separately approved manual deploy of OptiMove-eu to the reviewed SHA. Repository start is npm --prefix backend start (equivalent backend npm start): migrate.js completes before server.js. Confirm the actual Render command during preflight. One runner transaction applies L1 SQL and its ledger row atomically; the runner serializes other runners with its existing advisory lock.
6. Check first-service startup logs, /api/health HTTP 200, ok, expected commit and DB health; confirm one matching L1 ledger row and expected private objects using separately authorized read-only SQL. Health/ledger do not replace the write drain. Keep MEDIA_STORAGE_ENABLED unchanged.
7. Deploy OptiMove to the SAME reviewed SHA. Its runner must skip the already applied L1 with matching checksum. Confirm both commits, health and clean startup logs, and that there is still only one L1 ledger row.
8. Only after both services are on corrected L1 code and the operator approves reopening, restore the previous traffic policy. Authenticated mutation smoke checks are writes and need separate approval; they are not authorized by a read-only preflight. Do not enable media storage or any GC as part of this rollout.

## Failure during migration, before known commit

- Stop further deploy attempts, keep the write drain in place, retain the exact SHA, migration name/checksum and SQLSTATE/log timing. Do not dump request/user data or credentials into an incident log.
- Precondition/permission/lock/statement failure before COMMIT: runner rolls back L1 SQL and its ledger insertion and exits before starting the server. Verify absence of the L1 row AND L1 objects with a fresh, separately authorized read-only connection. Do not infer state from a generic Render Failed label; other releases or infrastructure may still be live.
- Absence is conclusive ONLY after independently proving the original runner has stopped, its PostgreSQL backend has no live migration/COMMIT transaction, the runner advisory lock is released, and no replacement/second-service/cron runner can start. Identify the original backend PID/session start and correlate deployment termination with read-only activity/lock observations; a generic Failed deploy, an empty ledger snapshot or a missing lock alone is insufficient. If visibility or process identity is incomplete, remain UNKNOWN with writes drained. Then repeat the ledger/object checks in a fresh read-only transaction.
- If both remain absent after that quiescence proof and all previously deployed migrations still match, the old main schema remains. A separately approved operator may resume the known healthy pre-L1 release/traffic only after verifying no newer runner committed. Fix the cause in disposable tests before a new attempt. Do not mark a failed migration as applied.
- Connection loss or timeout at COMMIT creates an UNKNOWN outcome. Query the ledger and object signatures using a fresh approved read-only session. Matching row plus complete objects means committed: use the post-commit path. Both absent in an initial fresh snapshot does NOT prove rollback: a still-running original COMMIT may become visible later. Use the quiescence proof and repeated fresh snapshot above before classifying rollback. Partial objects, an unexpected checksum or an unqueryable database means BLOCKED: keep writes stopped and investigate; never blindly replay SQL or alter the ledger.

## Problems after successful migration

1. Keep/restore the approved write drain across both services. Record whether the incident affects startup, authorization, latency/deadlocks or retention capture. Preserve immutable evidence and all R2 objects; no cleanup, quota repair or table deletion is a recovery action here.
2. Establish DB state by the matching ledger checksum and required function/trigger/view signatures. Confirm both backend SHAs; distinguish an old/new mixed-version lock issue from a migration defect.
3. Default recovery is roll-forward from this integrated L1 release. For an app defect, ship the smallest separately approved backend fix retaining plan-before-child/grant and upload-before-asset ordering. The runner skips already applied L1. For a DB defect, add a NEW timestamped corrective migration; never edit the applied L1 file or ledger. Any function/trigger correction must preserve hold/assets/audit rows and be rehearsed on disposable data representing the incident.
4. A previous backend alone is NOT a safe rollback: L1 triggers remain and the old Builder lock order can deadlock. MEDIA_STORAGE_ENABLED=false does not remove these triggers and is not a rollback; no flag change is authorized here. Even legacy copy/custom routes participate in ordering.
5. If roll-forward cannot be made ready, remain in the approved maintenance state and escalate for a separately reviewed coordinated app/schema recovery. There is no shipped destructive down migration, no approved trigger-disabling bypass and no permission to restore a shared production DB. Do not invent an emergency reversal that discards evidence or other users' concurrent work.
6. Reopen traffic only after both corrected services are healthy at the same release, ledger/signatures match, incident-specific disposable regression passes and the operator approves reopening. Any production mutation smoke test requires its own authorization.

## Local evidence and current limits

Run the integrated L1 and BE-3/Builder disposable suites plus the PR196 BE-2 media inspection/upload suite. Pure mocked Builder batching checks are allowed in isolation; persistent local OPTIMOVE suites are not. Migration naming/order/canonical bytes are checked without DB access. Integrated results: L1 24/24, BE-3/Builder 33/33, BE-2/PR196 31/31, isolated Builder batching 11/11 PASS. Both independent integrated reviews give READY for PR after the COMMIT-unknown clarification. See docs/backend/r2-l1-retention.md.

Current production results: UNKNOWN / NOT EXECUTED. Merge readiness and deployment authorization are separate; this PR cannot be treated as approval for production preflight or deployment.

Reference: [Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security) explains why grants and row visibility must be checked separately; it does not confirm this deployment role.
