# L1 — Media reference and retention protection

Local implementation for review. Base: origin/main 7704909900c07da805fd6bc76219070d731d7277; branch codex/r2-l1-retention. No PR/push, deployment, production SQL, R2 operations, quota changes or GC activation.

## Scope and data model

Migration: migrations_v2/202610201100_media_reference_protection.sql. Depends on deployed BE-1/BE-2 tables and existing Builder/program_access schema. No frontend, upload transport, codec, playback or ownership API changes.

| Object | Purpose |
| --- | --- |
| media.asset_reference_matrix | Derived, security-invoker view of actual Library video/image selections, plan-item snapshots, derived-image ancestry, upload reservations and durable manifests. No cached refcount. |
| media.retention_holds | Immutable reason, basis snapshot, plan, beneficiary, original owner/athlete and review-required flag. |
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
| Active foreign copied or unknown grant type / missing source owner | Preserve conservatively as ambiguous_grant, review required. |
| Own copied receipt, requested/rejected/revoked grant, already-expired grant, usage-event history alone | Do not create a new acquired-right hold from that record alone. Actual exercise/item references still protect the asset. Previously captured holds are never automatically released. |

Grant transfer to another plan/user creates a distinct immutable manifest. Revoke, grant deletion, expiry after capture, source-owner/club deactivation, replacement/removal of a Library selection or replacement/deletion of an item never releases a captured hold. These records do not authorize playback or further copies; BE-3 still checks the current context and existing revoke/ownership rules.

Uncertainty remains explicit: old revoked/expired/historical records cannot prove what rights existed before L1. Backfill does not reconstruct missing facts. Existing structural references remain protected; a future GC must require review before removing those protections. Retention duration, post-subscription rules and verified commercial entitlements remain undecided. No 7/30/90-day policy is encoded.

## Database protection and concurrency

New/changed Library and item asset references, and new thumbnail ancestry/hold membership, lock and validate a ready asset of the correct kind. Raw SQL and bulk inserts receive the same status/kind protection as routes. Database triggers do not invent per-user authorization: trusted backend BE-3 checks still apply before a write. An unchanged existing selection and ordinary metadata edits do not acquire new rights.

Plan-item writes acquire plan locks before asset locks; capture uses FOR NO KEY UPDATE so concurrent FK key-share checks do not create a lock-upgrade cycle. Two-slot IDs and multi-plan move targets use sorted ordering. New refs and ready-to-unavailable/key/kind transitions serialize on the asset row. A protected ready asset cannot leave ready or change object key/kind. Existing FKs prevent removal of referenced metadata rows.

Reference creation, capture and ready-state transitions require READ COMMITTED. Repeatable-read/serializable attempts return P7503 rather than relying on a stale reference snapshot. General multi-row transactions may still deadlock or reach lock_timeout; PostgreSQL rolls the entire transaction back. Callers must retry the whole operation, never continue a failed transaction. No claim of globally deadlock-free arbitrary SQL is made.

| SQLSTATE | HTTP | Public code |
| --- | --- | --- |
| P7501 | 409 | media_reference_unavailable |
| P7502 | 409 | media_retention_protected |
| P7503 | 409 | media_retention_isolation_required |

A protected plan hard-delete returns 409 and its existing transactional child deletes roll back. FK RESTRICT on hold plan/beneficiary/owner/athlete prevents destructive cascades from erasing protection; hard user deletion may instead fail through the existing FK handler. L1 deliberately blocks destructive deletion rather than transferring ownership or implementing anonymization. Existing archive/deactivation behavior remains available. Deleting an exercise can clear its source FK without altering independent item snapshots.

The matrix covers present FK-backed selections, not JSON/string guesses. Future media reference tables require an explicit matrix/guard addition. A future GC must fail closed for unknown reference types, ambiguous entitlements and holds; it cannot treat an empty matrix as sufficient deletion authorization. No deletion candidate, retention-release function, R2 delete or quota-release path is shipped.

## Migration, privileges and recovery

The existing migration runner supplies one transaction and migration ledger entry. SQL passes its top-level transaction-control lexer. Preflight fails before creating L1 objects if existing selections/ancestry point to non-ready, missing or wrong-kind assets. Backfill visits only R2-bearing plans and adds immutable manifests for eligible current grants/assignments. It does not rewrite legacy URLs, plan selections, storage usage or limits.

Requires PostgreSQL 15+ for security_invoker views and a migration role that can create in media, create triggers on Library/Builder/program_access tables and read all referenced tables. Runtime invoker needs the corresponding private table/function rights; current BE-1 owner-role deployment is the intended arrangement. RLS is enabled and PUBLIC/anon/authenticated/service_role access explicitly removed; no SECURITY DEFINER functions or browser DB access are introduced. Non-superuser table-owner execution is tested; actual deployment privileges have not been rechecked in production for L1.

Trigger DDL/backfill takes database locks. Runner defaults are MIGRATION_LOCK_TIMEOUT_MS=30000 and MIGRATION_STATEMENT_TIMEOUT_MS=120000. Production cardinality/timing and configured overrides are UNKNOWN in this local task. Before any later merge/deploy approval: inspect actual roles, data consistency, lock contention, timeout overrides and startup migration ordering. This migration runs even with MEDIA_STORAGE_ENABLED=false, but needs no R2 credentials and does not turn the flag on.

Failure recovery: runner transaction rollback removes all new objects and manifests; the migration is not recorded. Fix/review the cause before retrying. This rollback and an invalid-reference preflight rejection were rehearsed on disposable PostgreSQL. No migration SQL or recovery operation was executed in production.

After a successful migration, an application rollback can leave the additive schema and protective triggers in place. Do not DROP the hold/audit tables to roll back: that would lose protected-right evidence. A complete schema reversal/release needs a separately approved forward migration and retention decision. L1 intentionally ships no destructive down migration.

## Verification and reviews

2026-10-20, local disposable PostgreSQL only. Both fixtures use the repository disposable-db helper, which rejects remote URLs/managed service roles/non-loopback server addresses before database creation. L1 exercises a non-superuser table-owner role and a separate denied role; random databases and roles are removed after tests.

- L1 media-retention-l1.test.mjs: 21/21 passed. Includes migration backfill/transaction rollback/preflight failure, raw/bulk guards, reference derivation, grant ambiguity, reassignment/transfer, immutable manifests, revoke/delete, source deactivation, snapshot preservation, private ACL/RLS, five blocking transaction interleavings, isolation rejection and item/session/day moves. Actual BE-2 service completion/cancel runs against a mock object store; fixture-only quota setup verifies existing accounting.
- BE-3/Builder media-binding-be3.test.mjs with MEDIA_L1_TEST=true: 25/25 passed, including ownership, revoke, H1, copies, custom exercises, legacy #188 behavior, playback/feature-off compatibility and transactional protected-delete HTTP 409.
- No broad suite, browser check, R2 integration or production execution. No performance claim for production backfill.

Code review and security review were separate self-review passes by the implementing agent, not independent reviews or additional agents. Findings fixed before delivery: plan/asset lock ordering and FK-compatible plan locks; nullable grant/owner ambiguity; separate manifests after reassignment/transfer; derived-source audit; protecting referenced asset kind; adaptation of the old corruption-fixture test to expect the stronger L1 rejection. ACL, invoker/RLS exposure, SQL parameterization, immutable evidence, delete cascades, payment assumptions, isolation and rollback were checked. No unresolved blocking finding in those passes; independent review remains the next review gate.

## PR #196 isolation

Read-only GitHub filename/metadata check: PR #196 open against main, head b6f50463b3b6471c82e99fbfbb4c6c8e2bf6ef7d. No exact changed-file overlap with L1. Its backend changes are mediaInspection.js, mediaInspectionWorker.js, media-upload-be2.test.mjs and media fixtures; L1 does not edit them. Its frontend preparation, WebCodecs/Mediabunny, upload API/runbook files are untouched. No PR branch checkout, fetch, patch, review comment or merge was performed. Semantic integration risk remains normal: inspected completion produces ready assets before BE-3 binds them; L1 leaves that transport/inspection lifecycle intact. Recheck file overlap if either branch changes before a future PR.

Ready for local review only. Stop here pending owner approval; no push/PR/merge/deploy is authorized.
