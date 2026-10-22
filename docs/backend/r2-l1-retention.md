# L1 — Media reference and retention protection

Integrated PR candidate. Base: origin/main a585af8e61bbd5c950f61e0ddc060f415a624344 (PR #196); branch codex/r2-l1-retention. Owner authorized integration, push and PR preparation only. No deploy, production SQL, R2 operation, quota change or GC activation.

## Scope and data model

Migration: migrations_v2/202610201100_media_reference_protection.sql. Depends on deployed BE-1/BE-2 tables and existing Builder/program_access schema. No frontend, upload transport, codec, playback authorization or ownership API changes. BE-3 binding changes only its transaction lock order. This migration is still unpublished/local, so the original L1 migration is corrected in place; it is not an upgrade script for a database that applied commit 232692a.

| Object | Purpose |
| --- | --- |
| media.asset_reference_matrix | Derived, security-invoker view of actual Library video/image selections, plan-item snapshots, derived-image ancestry, upload reservations and durable manifests. No cached refcount. |
| media.retention_holds | Immutable reason, basis snapshot, historical plan/beneficiary/owner/athlete UUIDs and review-required flag. No FK to deletable business rows. |
| media.hold_assets | Immutable asset/slot/item provenance for each hold. Item/grant UUIDs deliberately survive their source row deletion. |
| media.retention_events | Append-only reference, ancestry, grant and manifest events with reason, transaction ID and database role. |
| backend/src/mediaReferences.js | Internal platform-admin inspection service and safe mapping of DB rejection codes. No new HTTP endpoint or hold-release API. |

A single physical asset may have many matrix rows and holds; storage accounting remains BE-1/BE-2 responsibility. No copying of files or reassignment of the storage account. Archived exercises and historical plan items remain structural references while those rows exist. Completed upload history is informational, not a permanent retention right; reserved/verifying/cancelling uploads remain protective. Derived image ancestry conservatively protects its source while the link exists.

Audit is evidence of a transition, not an entitlement. It is not a GC root. Audit FKs intentionally preserve media metadata rows; a future GC would tombstone metadata rather than delete those rows. Human actor attribution is not added: new events record the trusted database role/transaction; existing request authorization remains authoritative.

## Retention basis and ambiguities

| Existing application state | L1 treatment |
| --- | --- |
| Active, non-template, active-status plan assigned to athlete | Capture assigned-plan manifest. Reassignment creates a separate beneficiary manifest. |
| accessed/used/completed, unexpired assigned/coach_assigned/downloaded program_access grant | Capture application-grant manifest and current license snapshot; this is not proof of payment. |
| Active purchased grant | Preserve with unverified_commercial and review_required=true; never infer a real purchase. |
| Active foreign copied or unknown grant type (including copied receipt with missing source owner) | Preserve conservatively as ambiguous_grant, review required. |
| Own copied receipt, requested/rejected/revoked grant, already-expired grant, usage-event history alone | Do not create a new acquired-right hold from that record alone. Actual exercise/item references still protect the asset. Previously captured holds are never automatically released. |

Grant transfer to another plan/user creates a distinct immutable manifest. Revoke, grant deletion, expiry after capture, source-owner/club deactivation, replacement/removal of a Library selection or replacement/deletion of an item never releases a captured hold. These records do not authorize playback or further copies; BE-3 still checks the current context and existing revoke/ownership rules.

Uncertainty remains explicit: old revoked/expired/historical records cannot prove what rights existed before L1. Backfill does not reconstruct missing facts. Existing structural references remain protected; a future GC must require review before removing those protections. Retention duration, post-subscription rules and verified commercial entitlements remain undecided. No 7/30/90-day policy is encoded.

## Approved behavior and deletion

Templates Access remains attached to its original template. Revoke deletes only its grant. Deleting the template removes its original content/grants as on main, while independent Builder copies and athlete assignments remain separate plans with independent media selections. Deleting a program from an athlete profile still physically deletes that plan and its item tree; the athlete loses that context. An immutable hold is never used by BE-3 as playback authorization.

Historical source_plan_id, source_program_access_id, beneficiary_user_id, source_owner_user_id and assigned_athlete_id do not reference live business rows. RESTRICT remains only inside the private media evidence/asset graph. No plan-delete guard remains. A source_plan_deleted event preserves why evidence exists after business deletion. Revoke/reject record grant transitions without recapturing the old plan. Existing manifests were already captured by backfill, activation, assignment and item changes.

Hard deletion of a user may still be blocked by pre-existing BE-1 storage/upload/audit FKs; L1 adds no new user/athlete deletion blocker and does not change ownership or accounting. Ordinary account deactivation/athlete archive is unchanged. No detached playback endpoint or reconstruction of a deleted template is introduced. Future perpetual content access would need separate product approval.

## Database protection and concurrency

New/changed Library/item selections, derived-source links and manifest membership validate ready assets of the correct kind using FOR SHARE. These reader locks are mutually compatible but conflict with unavailable-status/object-key/kind updates. The transition guard rechecks live references using READ COMMITTED. An unchanged snapshot/metadata edit does not acquire new rights. SQL guardrails supplement, rather than replace, existing backend ownership and revoke authorization.

Builder custom operations lock plan before node/exercise. Section, block, day and session copy entries lock the target plan and recheck target membership before child/FK writes. Program duplicate locks its source before copying and the copied-grant upsert. This matches plan DELETE's plan-before-children order, including legacy/flag-off custom operations.

BE-3 binder locks uploader-owned uploads in sorted ID order before taking sorted asset FOR SHARE locks, matching BE-2 completion's upload-before-asset order. The upload row still serializes first exercise_create binding. The binder never mutates an asset or upgrades a shared asset lock.

Active-grant INSERT/UPDATE captures that grant; approve/use/assignment application paths already lock plan first. Revoke/reject do not need a plan lock and cannot invert DELETE's grant cascade. Raw administrative multi-row SQL must also follow plan-before-child/grant lock order; general arbitrary transactions can still deadlock and must retry as a whole after PostgreSQL abort. L1 does not promise globally deadlock-free arbitrary SQL.

Item triggers call capture_plan with the changed item ID: primary-key lookup and at most two media candidates per applicable basis. They do not rescan the whole plan. capture_members excludes existing manifest members before INSERT, avoiding repeated BEFORE guard work that ON CONFLICT alone would still execute. Full capture remains for backfill, activation/new entitlement and hierarchy moves. Cost is linear in items times applicable rights; many distinct rights still increase work and production backfill timing is unmeasured.

Reference/capture/ready-state transitions require READ COMMITTED. Other isolation levels return P7503 rather than accepting a stale reference snapshot. HTTP mapping remains P7501 -> 409 media_reference_unavailable, P7502 -> 409 media_retention_protected (asset transitions only, not business DELETE), P7503 -> 409 media_retention_isolation_required.

The matrix covers current FK-backed selections, not guessed JSON/string references. A future GC must fail closed for unknown references, ambiguous rights and retained manifests. Historical audit alone is not a perpetual right. No GC, R2 deletion, quota release, hold release or retention deadline is implemented.

## Migration, privileges and recovery

The existing migration runner supplies one transaction and migration ledger entry. SQL passes its top-level transaction-control lexer. Preflight fails before creating L1 objects if existing selections/ancestry point to non-ready, missing or wrong-kind assets. Backfill visits only R2-bearing plans and adds immutable manifests for eligible current grants/assignments. It does not rewrite legacy URLs, plan selections, storage usage or limits.

Requires PostgreSQL 15+ for security_invoker views and a migration role that can create in media, create triggers on Library/Builder/program_access tables and read all referenced tables. Runtime invoker needs the corresponding private table/function rights; current BE-1 owner-role deployment is the intended arrangement. RLS is enabled and PUBLIC/anon/authenticated/service_role access explicitly removed; no SECURITY DEFINER functions or browser DB access are introduced. Non-superuser table-owner execution is tested; actual deployment privileges have not been rechecked in production for L1.

Trigger DDL/backfill takes database locks. Runner defaults are MIGRATION_LOCK_TIMEOUT_MS=30000 and MIGRATION_STATEMENT_TIMEOUT_MS=120000. Production cardinality/timing and configured overrides are UNKNOWN in this local task. Before any later merge/deploy approval: inspect actual roles, data consistency, lock contention, timeout overrides and startup migration ordering. This migration runs even with MEDIA_STORAGE_ENABLED=false, but needs no R2 credentials and does not turn the flag on.

Failure recovery: runner transaction rollback removes all new objects and manifests; the migration is not recorded. Fix/review the cause before retrying. This rollback and an invalid-reference preflight rejection were rehearsed on disposable PostgreSQL. No migration SQL or recovery operation was executed in production.

After successful migration, prefer roll-forward and keep the corrected backend lock ordering. An application-only rollback to old main while retaining the new triggers can reintroduce the reviewed lock inversions; it is not claimed to be a validated rollback. A full reversal requires a separately reviewed forward migration and a retention-safe recovery plan. Never DROP immutable manifests/audit as a shortcut. No destructive down migration is shipped. Startup/preflight and post-commit operational recovery must be approved before any production rollout.

## Verification and independent reviews

Local disposable PostgreSQL only. Fixtures use the repository safety helper, which validates loopback URLs/server addresses and rejects managed service roles before creation. L1 also runs as a non-superuser table owner plus a denied outsider role; random databases and roles are removed afterwards. No production SQL was executed.

- L1 media-retention-l1.test.mjs: 24/24 PASS. Backfill, runner-compatible SQL, transactional rollback/preflight failure, private privileges, immutable evidence, unknown commercial grants, reassignment/transfer, user/athlete/plan deletion, snapshot/derivation matrix, revoke/reject-versus-delete races, status/reference races, isolation rejection and hierarchy relocation. Disposable instrumentation confirms 40 inserted items invoke delta membership capture 40 times, not N-squared. Existing BE-2 completion/cancellation accounting is checked with a mock object store; fixture-only quota setup does not change application quota logic.
- BE-3 media-binding-be3.test.mjs with MEDIA_L1_TEST=true: 33/33 PASS, covering existing ownership/copy/H1/revoke/legacy behavior, actual HTTP template/assigned-program DELETE and Access revoke, independent athlete snapshots, shared R2 assets, custom DELETE races with flag on/off, section-copy/DELETE, repeated program-copy/grant-upsert/DELETE, binder waiting on completion, and block/day/session copy regressions.
- Integrated PR #196 media-upload-be2.test.mjs: 31/31 PASS, including real container inspection/metadata fixtures and the 30-second rule, on a disposable database with mock R2.
- Isolated builder-tree-batch.test.mjs: 11/11 PASS. Its pre-existing main fixture cap of 17k parameters was stale after four media snapshot columns were added; cap updated to a conservative 20k. Production batching code is unchanged.
- Offline migration check: 64 SQL files, 63 historical checksums unchanged, one new L1 migration; canonical UTF-8, unique sorted prefixes and runner transaction-control checks passed. L1 SHA-256: a969eae0d3ef6c5ec45907db124e7250515feeea97c3309430bec292e06750c8.
- Persistent local OPTIMOVE suites were deliberately not executed. No broad suite, browser check, real R2 operation or production backfill benchmark.

Two separate agents, neither an implementer, performed independent read-only code and security reviews. Both final verdicts: READY for the reviewed local correction, no remaining API blockers. Their initial additional findings were fixed before the final reviews: revoke grant-row/plan cascade inversion, section-copy child-FK/plan inversion, and repeated plain-copy grant-upsert/source-plan inversion. They did not execute tests or modify code. The implementing agent executed the disposable tests. Final added block/day/session regression changes affect tests only.

## Integration, preflight and remaining risks

Rebased onto a585af8e61bbd5c950f61e0ddc060f415a624344 with no conflicts. PR #196's complete file set, including backend inspection/worker and frontend phone preparation, is unchanged by L1. No intervening main migrations or runner/dependency changes were introduced. Final independent integrated code and security reviews: READY for PR. The security review's COMMIT-unknown recovery finding was fixed: absence of ledger/objects is not treated as rollback until original runners/transactions are quiescent, the advisory lock is released, replacement runners prevented and a fresh state check repeated.

Deployment/read-only production preflight and recovery are specified in [the runbook](../runbooks/r2-l1-deployment-preflight.md); [proposed SQL](../runbooks/r2-l1-preflight.sql) is a template only and was NOT executed in production. All actual production privilege/count/lock/timing results remain UNKNOWN. Runbook requires controlled auto-deploy and draining both old services' writers through the schema transition, and roll-forward after commit; old backend alone is not a safe rollback.

Remaining gates: separate approval and execution of production privilege/data/lock/timeout preflight; comparable-scale disposable backfill timing; operator-approved write-drain/recovery mechanism; future retention-release/GC policy. General raw SQL lock-order violations can abort and require complete retry. No R2 object, feature flag or storage quota is changed. Immutable evidence remains conservatively protected without granting playback.

READY for PR review. Push/PR preparation is authorized; merge, deploy, production SQL and feature-flag changes remain prohibited pending further owner approval.
