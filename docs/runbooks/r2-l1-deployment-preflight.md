# PR #203 — three-migration deployment preflight and recovery

This is an unexecuted production procedure. No production SQL, deploy, configuration change, rotation, import or GC is authorized by this document. PR #203 remains draft; PR #204 is unchanged. Current implementation corrections are local/disposable-tested and do not establish production readiness.

## Exact package

Baseline BE-1 `202610191100_media_storage_foundation.sql` and BE-2 `202610191300_media_upload_lifecycle.sql` must already match the ledger. New migrations, in runner order, all after `202610282300_training_load_v42_source_metric_zone_model.sql` (renamed on 2026-10-29 with their SQL unchanged; see `r2-l1-drive-integration.md`):

| Migration | SHA-256 |
| --- | --- |
| `202610291000_media_reference_protection.sql` (L1) | `a969eae0d3ef6c5ec45907db124e7250515feeea97c3309430bec292e06750c8` |
| `202610291100_media_drive_copies.sql` (Drive) | `e13159397c59d5c9235781754df2fc8b32b00d95afe95bbb2c665af837b9fd91` |
| `202610291200_media_drive_reference_bridge.sql` (bridge) | `3841c051c9fd217be8e32d4af33878c3ffaace669815f4286d4e749ae6432367` |

Each migration and its ledger entry commit in a separate transaction. The package is NOT atomic. Compare the entire ledger with the release inventory; stop for an unexpected pending migration, checksum mismatch, non-prefix state or unledgered partial objects. Never edit applied SQL or the ledger.

## Gates before any release authorization

| Gate | Evidence and required result |
| --- | --- |
| Credential incident | The earlier DB password disclosure is unresolved until the operator confirms controlled rotation and fresh successful connections for both web services and cleanup cron. No such confirmation is available here: UNKNOWN / release BLOCKER. Do not print credentials or attempt rotation in this task. |
| Identity / visibility | Separately authorized read-only checks on the actual deployment connection of BOTH services: expected shared project, effective/session roles, PG15+, READ COMMITTED. Complete owner/BYPASSRLS visibility and FORCE RLS/policy review, not SELECT grants alone. |
| Privileges | CREATE/USAGE on media; source relation ownership (ALTER and replacing triggers/views), SELECT/UPDATE/TRIGGER/REFERENCES, audit-guard EXECUTE. Include storage_accounts, uploads, assets, users, exercises, program_access, plan hierarchy, and every already-present L1/Drive relation. Runtime must inherit private owner rights; security-invoker bridge functions/views require source visibility. No public grant workaround. |
| Ledger / objects | Checksums above plus all baseline files match; relation, column, constraint, trigger, function and index inventory agrees with the committed prefix. Check valid/ready indexes, not just their names. |
| References / Drive | Zero missing, non-ready or wrong-kind explicit assets and mapped copies. No duplicate active imports per file/kind, inconsistent purpose/context, duplicate mappings/assets or unexplained created/removed history. Existing mapping/history alone must not be treated as acquired playback rights. |
| Scale | Source counts, mapped legacy slots, eligible assignment/grant fan-out, largest plan, existing holds/members and growth. Bridge estimate must include mapped legacy snapshots, not merely explicit asset columns. Future not-yet-imported mappings are a separate forecast, not today's backfill. |
| Locks | No uncontrolled writers, long transactions, active imports or unresolved blockers; include BOTH web services, cron, previews and any manual importer. Observe only; never lock rows, terminate sessions or acquire advisory locks during preflight. |
| Budgets | Actual role/DB timeouts, migration environment overrides, connection acquisition/pooler/session behavior, app startup/health-check deadline and cron runner command must be confirmed separately. Repository defaults are NOT proof of deployment settings. |

Use `r2-l1-preflight.sql`, stages A then B (B only after Drive relations exist). Queries return metadata/aggregates only, under bounded read-only transactions. A missing relation or timeout is UNKNOWN; roll back, do not repair or increase limits automatically. No production query was executed for these corrections.

## Lock ordering and duration

The runner serializes migration runners with advisory key 822026, but does not serialize application writers. Repository defaults: lock timeout 30 s, statement timeout 120 s, advisory wait up to 5 min. Each DDL statement retains acquired locks until its migration commits. L1 trigger creation/backfill, Drive ALTER TABLE/constraint validation/indexes, and bridge's non-concurrent expression indexes/backfill all need an approved write-drain window. The bridge backfill is one DO statement; its full fan-out must fit the per-statement budget. Total package time plus runner wait and app boot must fit the real deployment deadline.

Import completion locks sorted existing plans NOWAIT BEFORE account/upload/asset, then takes the per-file gate and rescans references. 55P03 and 40001 abort the WHOLE completion transaction and are retryable; no charge or mapping survives its rollback. Builder retains its draft/source order; the NOWAIT rule avoids waiting on source while holding a conflicting plan. New references require READ COMMITTED and share the file gate. Retry must restart the entire transaction, never retry a statement inside an aborted transaction. Tests cover actual Builder Submit/import, fresh references, shared plans and zero observed deadlocks; arbitrary administrative SQL is not certified.

Read-only counts cannot measure DDL duration. Rehearse synthetic data matching counts, per-plan fan-out, mapped fraction and index sizes on disposable PostgreSQL; never copy sensitive rows. Record hardware/PG version and elapsed time per migration. Small fixture timings are functional evidence only: production duration stays UNKNOWN until comparable-scale rehearsal and actual budget checks pass.

## Operator sequence (requires separate approval)

1. Close credential and all required FAIL/UNKNOWN gates. Record exact reviewed SHA, checksum inventory, current healthy release, approved recovery authority and backup availability; no backup/restore is initiated here.
2. Control auto-deploy/startup on both web services, cleanup cron, previews and manual importers BEFORE merge. Stop/drain all writers and verify transactions/imports are quiescent. A feature flag alone is not a write drain.
3. Run one authorized migration/deployment runner for the reviewed release. Never start the integrated server against a pre-bridge schema: it calls bridge functions. Keep all other writers stopped throughout all three commits.
4. On success, verify all three matching ledger entries exactly once, required objects/indexes/private privileges, expected reference/hold counts, clean logs and /api/health HTTP 200, ok, commit and DB health.
5. Deploy the second service to exactly the same SHA; its runner must skip matching migrations. Verify both SHAs/health and the unchanged ledger. Keep MEDIA_STORAGE_ENABLED and all quotas unchanged.
6. Reopen writes only after operator approval. Re-enable cron only with verified release/environment and schedule controls. Production mutation smoke checks need separate authorization.

## Recovery matrix — committed prefix, not deploy label

| Proven committed new prefix | Failed next step | Safe action while writers remain drained | Rollback restrictions |
| --- | --- | --- | --- |
| None | L1 or earlier startup | After proving original runners/transactions stopped and no replacement can start, verify baseline ledger AND absence of new objects on a fresh connection. Resolve cause and rerun exact reviewed release. Previous baseline backend may resume only after this proof and separate approval. | An empty ledger snapshot while COMMIT may be in flight is NOT proof of rollback. |
| L1 only | Drive | L1 remains committed. Repair cause and roll forward with the unchanged Drive and bridge files using the corrected backend. Verify L1 objects/hold evidence before retry. | Returning to the old backend is unsafe: L1 triggers remain and require corrected lock ordering. No destructive L1 down script. |
| L1 + Drive | Bridge | Both remain committed. Preserve mapping/events/platform accounting; resolve bridge failure and roll forward. Verify mappings still ready/matching before retry. Do not expose the integrated server yet. | Drive's old down script is not a package rollback; account/import history or later dependencies make it unsafe. Never drop mappings/manifests to make deployment pass. |
| All three | App boot, second service or subsequent defect | Verify exact ledger/object signatures; retain schema/evidence and deploy the same reviewed integrated release or separately approved minimal forward fix. DB fixes get NEW timestamped migrations, rehearsed disposable. | Old backend alone is unsafe; turning media off does not remove triggers. No trigger bypass, manifest deletion or shared DB restore without a separately reviewed recovery. |

For ANY lost migration COMMIT response, stop automatic retries, keep writers drained, identify the original backend/process, prove it and any replacement runner quiescent and observe advisory lock release. Only then re-read ledger AND object signatures on a fresh approved connection. Missing advisory lock alone is insufficient. Unknown visibility or a non-prefix/partial state remains BLOCKED; never guess rollback, edit a ledger row or manually execute a migration fragment.

After known commit, prefer roll-forward. Mapping removal with an authorized audit reason is a separately approved playback-routing operation, not a schema rollback: old Drive URLs remain, historical L1 holds/accounting stay, and no new playback entitlement is granted by a hold. Existing signed URLs live until their existing TTL expires. R2 deletion, GC and retention release remain out of scope.

## Upload COMMIT recovery contract

Claim COMMIT is bounded (default 15 s); a lost response destroys that connection. A fresh transaction locks the upload to observe the settled outcome. Only this invocation's matching, unexpired verification token may continue inspection, with authorization rechecked; completed returns idempotent 200. Unconfirmed/refused claim returns 503 `verification_outcome_unknown`, `retryable:true`. Another live claim returns 202; after its two-minute lease expires, a retry may atomically claim a new fenced token (only while the upload itself has not expired), so an abandoned worker cannot strand the upload indefinitely. Retry with bounded backoff, do not busy-loop. Cleanup still fences expired uploads.

Final completion COMMIT recovery remains: proven completed -> 200; proven uncommitted verifying -> retryable failure/reset under the same token; unreadable -> explicit unknown. No duplicate quota/mapping/event is created by replay. Reconciliation failure never authorizes inspection or guesses that a write did not land.
