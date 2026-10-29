# L1 and Drive import integration

Local implementation only. No push, PR, merge, deploy, persistent database migration, R2 request, quota change or feature activation is authorized by this document.

## Reviewed sources

- PR #202: 52e4c18220214b67394d1b70fc8ec6c0af52c491, integration branch base.
- PR #197: 7d3b0a21c036215cc9d05024412f806bba7522d2. Its production Builder lock fixes, binding order, reference service, migration and tests are included as local uncommitted changes.
- Branch: codex/l1-drive-integration. Neither source branch is changed. No local merge or commit was performed.

## Smallest safe bridge

The two source migrations were byte-identical to #197 and #202 when this bridge was written; since 2026-10-29 L1 differs (one member per hold, asset and slot, PR #267, see below) and Drive is unchanged. New migration `202610291200_media_drive_reference_bridge.sql` depends on both. Normal runner order is foundation, lifecycle, L1, Drive, bridge. Disposable tests also apply Drive before L1, then the same bridge; this checks upgrades in either prior deployment order, not renaming historical migrations.

Renamed on 2026-10-29 (owner decision, before any of them was applied anywhere persistent): the three files now sort after `202610282300_training_load_v42_source_metric_zone_model.sql`, as `202610291000_media_reference_protection.sql` (L1), `202610291100_media_drive_copies.sql` (Drive) and `202610291200_media_drive_reference_bridge.sql` (bridge). The rename changed neither their relative order nor their SQL, so the runner applies them after v42 in name order, and a v38–v42 rollback's "a later migration is recorded" guard sees them as later.

Changed on 2026-10-29, still before any of them was applied anywhere persistent (external review MEDIUM-2, owner decision): in L1 a hold has one member per hold, asset and slot (`unique(hold_id,asset_id,slot)`); `plan_item_id` records the item that first captured the asset, and a repeated Builder Submit adds no member and no capture event. L1's SHA-256 is therefore new; Drive and the bridge are unchanged. The SHA-256 values in `r2-l1-deployment-preflight.md` are the current ones.

`media.l1_item_assets` resolves each plan item's own snapshot: explicit asset, mapped legacy Drive file of the same kind, or no asset. It does not consult today's exercise URL and does not rewrite a snapshot. Inherited exercise links continue to follow the existing authorized personalization logic; Builder snapshots their effective legacy URLs as before.

The reference matrix protects every extant mapping as a removable structural reference and reports resolved legacy plan items. A mapping alone creates no permanent hold. Existing L1 entitlement criteria are unchanged: current eligible assignment/grant bases capture resolved members, with commercial/ambiguous bases retaining their existing review-required classification. Requested/rejected/revoked/expired grants, self-copy receipts, orphan imports and audit history do not manufacture entitlements. An eligible independent copy/assignment retains its own evidence after source revoke or deletion.

Backfill checks existing mapped assets are ready and of the matching kind, then captures only eligible plans. New mapping INSERTs and legacy item/assignment/grant changes maintain capture. Removing a mapping never deletes acquired-use evidence. Holds are never consulted for playback. The bridge cannot reconstruct deleted legacy business rows or establish a revoked/expired entitlement that had no prior captured manifest; such history needs separate product/data review, not an invented hold.

## Concurrency contract

Import completion prelocks the sorted currently referenced plans with NOWAIT before storage account, upload and asset locking. A busy plan raises 55P03 and aborts this attempt immediately, releasing earlier plan locks; import cannot wait while holding another plan against Builder's draft-then-source submit order. It then holds the per-file `drive-copy:<id>:<kind>` transaction advisory lock. A fresh reference scan detects newly committed plans omitted from the initial set and raises SQLSTATE 40001; the completion releases its claim for retry without charging or inserting a mapping. The HTTP router already maps both codes to a retryable storage-busy response.

The DB mapping guard repeats validation using the transaction's previously locked plan set, without acquiring new plan locks after the asset. Direct SQL insertion uses the same guard but must not prelock assets first. Legacy item guards take their plan before the same per-file lock and ready-asset shared lock. Multi-slot file locks are sorted. Existing L1 grants, hierarchy moves and Builder operations keep their plan-before-child contract. Binder retains PR #197's upload-before-shared-asset order.

New legacy Drive references explicitly require READ COMMITTED before acquiring the file gate, even if the transaction's old snapshot sees no mapping. This fails closed with P7503 rather than letting a repeatable-read snapshot miss a newly committed mapping and its manifest capture.

Tests observe actual PostgreSQL waiters and NOWAIT-probe upload/asset/source-plan rows after import refuses a busy plan. They cover actual edit-draft HTTP submit against import, import/delete in both winning orders, concurrent edits, uncommitted new references, changing reference sets, multiple imports into one plan, and mapping versus asset transitions. This is evidence for these scenarios, not a guarantee that arbitrary administrative transactions cannot deadlock. A whole transaction must retry after serialization/deadlock abort.

## Authorization and URL preservation

Completed import upload previews require the original uploader, a current platform-admin role and the same extant mapping on the platform account. Removing the mapping denies new upload-context signatures even to its original administrator. Revoked administrators retaining coach capability are denied. Normal exercise/plan authorization remains authoritative for those contexts.

The existing PR #202 public-Drive-ID capability model is unchanged: an otherwise authorized legacy row containing a known Drive file ID can resolve its global copy. Revoking source Access or unsharing on Drive does not revoke this separate capability. Restricting newly pasted URLs to source grants would require a separate product/authorization change; it is not silently introduced by retention integration.

Legacy blank echoes are protected by either the current mapping or the append-only created-copy event for the stored Drive file and kind, including when storage is disabled. A changed nonempty link still selects that link. Explicit authorized `media: {video: {source: 'none'}}` (and the image equivalent) remains the removal operation and retains the historical URL without granting playback. Signed URLs already issued expire under the existing ten-minute lifetime; mapping removal does not invalidate a previously issued R2 URL.

## Migration and recovery plan — unexecuted for production

1. Review the final local diff, independent code/security/DB findings and disposable results. Obtain separate authorization for every later delivery/deployment step.
2. Before any later merge, control auto-deploy for both backends and all startup/worker writers. Follow the L1 preflight runbook: actual private privileges, complete row visibility, PG15+, READ COMMITTED, source consistency, counts, largest plan, grant fan-out, indexes, lock contention and effective migration/startup budgets must be measured separately. This task contacted no production system.
3. Rehearse the bridge at representative synthetic scale. Its indexed file scans and eligible-plan capture still have cost proportional to real references and grants. The backfill and expression-index creation hold locks inside the migration transaction; do not assume the runner's defaults fit production.
4. Drain writes through both old services before the schema transition. Apply the additive bridge only with both dependencies present. Never deploy a backend that calls `l1_lock_drive_import` against a pre-bridge schema. Roll out the same corrected integration code to both services before resuming writes. Keep feature flags/quota unchanged unless separately authorized.
5. Before migration COMMIT, ordinary failure rolls back new functions, view definitions, indexes and captured rows atomically. Disposable tests rehearse this. On lost COMMIT acknowledgment, keep writers drained, prove all original runners/transactions quiescent and verify ledger plus object signatures on a fresh authorized connection. Missing ledger in one snapshot does not prove rollback.
6. After known COMMIT, use roll-forward. There is no destructive down script for the bridge: removing it would discard protection contracts, while deleting manifests would destroy evidence. Do not revert only the application to #202 or pre-L1 code; those versions lack the integrated lock order. Retain the corrected backend and additive schema while preparing a reviewed forward fix.
7. To undo playback routing for a particular imported file, use the existing authorized mapping-removal operation with an audit reason after separate approval. Fresh reads return the stored Drive URL, while legitimate manifests and storage accounting remain. R2 deletion/GC and retention release are outside scope. The original Drive schema rollback is no longer applicable with a later bridge migration recorded, a platform account, or import history.

## Validation scope

Run from backend with `DATABASE_URL` and `MEDIA_TEST_DATABASE_URL` pointing only to the dedicated loopback test server and `MEDIA_L1_TEST=true`:

```
node --test --test-concurrency=1 tests/media-drive-l1-integration.test.mjs tests/media-binding-be3.test.mjs tests/media-drive-import.test.mjs tests/media-retention-l1.test.mjs tests/media-storage-be1.test.mjs tests/media-upload-be2.test.mjs tests/builder-tree-batch.test.mjs
```

Each DB suite creates and drops a unique disposable database. Object stores/signatures are simulated; real media inspection uses local fixtures. No live R2 request is part of these checks. Final measured counts and independent review results belong in the delivery report, not in assumptions about this runbook.

## PR #203 correction addendum

The current three-migration preflight, prefix recovery matrix and bounded verification-claim COMMIT contract are normative in [r2-l1-deployment-preflight.md](r2-l1-deployment-preflight.md). The earlier local-only status text above describes the original integration exercise; the user subsequently authorized this existing draft PR and targeted correction push only. No release or production operation is authorized. The two source migrations and bridge SQL remained byte-identical at that correction (L1 changed later, on 2026-10-29; see "Smallest safe bridge").

## Correction validation (local only)

- Existing Builder Submit/import NOWAIT, retry/reference-change, hold preservation and mapping-removal authorization regressions remain in the targeted suite.
- Added claim COMMIT faults: committed but response lost/hung, rolled back/refused, never sent, unreadable outcome, unavailable fresh connection, foreign token, parallel completion and abandoned lease recovery.
- Added final COMMIT/unreadable-outcome replay: one mapping and one quota charge.
- Preflight SQL executes on disposable PostgreSQL as a non-superuser for none/L1/L1+Drive/all-three prefixes. This validates syntax and applicability, not production privileges, data volumes or timing.
- Production credential rotation remains unconfirmed and blocks release. No production read or write was performed for these corrections.

Final targeted run: **140/140 PASS, 0 failed, 0 skipped**, 16.74 s (local PostgreSQL, non-superuser disposable databases, fake R2). Suites: `media-drive-import`, `media-drive-l1-integration`, `media-binding-be3`, `media-upload-be2`. Includes four preflight-prefix subtests with a synthetic mapped assignment/grant fan-out check. All three migration SHA-256 values matched the reviewed originals at that run; no migration file changed then (L1 changed later, on 2026-10-29; the current values are in `r2-l1-deployment-preflight.md`). `git diff --check` passes. No new independent review agent was used for this targeted correction.
