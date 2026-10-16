# Exercise Library — final access and reuse semantics

For the subsequent administrator/private-copy policy and archive/media behavior,
see [classification, visibility and media](exercise-classification-visibility-media.md).

This is the current contract for the unmerged Exercise Library patch. It supersedes
the open product questions and unexecuted-test status in
`exercise-library-hardening-review.md`. It does not authorize a release.

## Confirmed ownership and revocation

- System exercises belong to the application. A coach's variation remains private,
  keeps its edits and `source_exercise_id`, and follows the canonical source's
  collection grants. Revoke hides it; regrant restores it if its ordinary owner/active
  conditions still hold. No variation is deleted or reset.
- `exerciseReuseScopeSql` requires the exercise to be active, its linked canonical
  system source (if any) to be active, and the caller to retain collection access.
  `exerciseReadScopeSql` adds Library ownership: system or the caller's own private
  exercise. Unknown/null activity fails closed in reuse checks.
- Existing historical and active assigned programs remain readable. Existing plan
  items and prescription/media snapshots are not automatically removed or rewritten.
  Athlete readers do not need coach Library grants for already assigned content.
- New occurrences or grants cannot reuse a revoked restricted exercise, including a
  personal variation whose canonical source is restricted.
- The separately confirmed future club-owned exercise model is not implemented in
  this patch. Do not use system-source provenance for club copies: its canonical
  source guard intentionally accepts only system sources.

## Backend operation matrix

| Boundary | Behavior after revoke |
|---|---|
| Exercise list/search/detail/visible-marked/favorite/tag reads and ordinary save/COW | Existing shared Library scope denies the source and its private variation. |
| Builder GET draft, plan GET weekly/program, Athlete plan reads | Existing plan access remains authoritative; no Library filtering of saved items. |
| Builder Library add | Current Library access required under the collection shared transaction lock. |
| Builder custom-exercise create | Creates a new user-owned exercise, not reuse of a submitted exercise ID. |
| Duplicate program/weekly plan | Reject entire new copied content transaction with 409 if any copied item is revoked. |
| Duplicate with assign intent | Same guard before new athlete plans, access receipts and notifications commit. |
| Repeated completed assignment request | Returning an existing result creates no new content; a fresh assignment request rechecks grants. |
| Block duplicate | Validate newly created block; rollback its tree if denied. |
| Same-plan day paste | Validate the replaced target day; rollback overwrite if denied. |
| Cross-plan block/day paste | Same guard, including program-to-weekly and weekly sources. |
| Session paste | Validate new session only; old revoked items elsewhere in the target do not cause unrelated denial. |
| Node/subtree paste, including a node holding a single exercise | One client/transaction; validate the new subtree and rollback all inserted nodes/items if denied. |
| Individual item copy | No separate item-copy route exists; node/subtree copying is the relevant copy boundary. |
| Item dose/description edit, item/node order move, ordinary metadata edit | Existing content remains editable; these APIs do not accept a replacement exercise or athlete identity. |
| New draft submit/activation | Check the plans actually transitioning to active; rollback publication if denied. |
| Explicit batch sync, implicit syncBatch fan-out, batch submit | Check newly copied sibling content; no revoked snapshot fan-out. |
| Open a same-plan edit draft | Preserve its existing snapshots; hidden edit draft represents the same plan, not a new assignment. |
| Apply a same-plan edit draft | Lock original plan and retain at most its existing count per revoked exercise ID; reject increased occurrences. |
| Template assignments and renewals | Transactional grant check for assigning coach before program_access writes. |
| Template metadata activation or active visibility expansion | Guard publication; ordinary same-scope metadata edits or deactivation do not require a new entitlement. |
| Template first use / renewal without valid approved access | Guard before granting use; an approval request alone grants no content and remains subject to guarded approval. |
| Continued use with existing valid approved access | Preserve that record and original expiry; do not convert usage into a license extension. A copied receipt is not an approved use/assignment entitlement. Expired approved statuses must request approval again or pass the new-use guard. |
| Organization single/bulk approval | Guard each approval transaction. Rejection does not create access. Existing bulk partial-success semantics are not redesigned. |

Reuse checks inspect actual target plan_items before commit, not just a pre-copy
source snapshot. Their collection shared advisory lock is the existing
`hashtextextended('exercise_collections', 0)`; revoke takes its exclusive side.
The transaction that acquires the lock first determines the order. A new reuse
that waits behind a confirmed revoke returns 409 without its content/grant writes.
Lock waits are bounded, and reuse fails closed outside READ COMMITTED.

The reuse predicate intentionally does not require Library ownership. The owner
explicitly reconfirmed on 2026-10-15 that authorized sharing of an author's active
private program snapshots remains allowed. Copying a program never grants direct
access to another coach's private Library row. Program authorization still runs
before the reuse guard; activity, canonical-source activity and collection rights
are mandatory even for another author's private snapshot.

On 2026-10-15 the owner also confirmed that deactivating a canonical system source
blocks new use of its private copies. Both Library and reuse now enforce this;
reactivating the source restores eligibility if other conditions hold, without
deleting or resetting the copy. Existing program readers and same-identity retained
item budgets remain unchanged. Source integrity migrations are unchanged.

This activity check is evaluated inside existing guarded transactions. The shared
collection lock still orders API grant/revoke and reuse. There is no checked-in
exercise-deactivation API; privileged SQL changing is_active does not automatically
take that advisory lock. Any future deactivation writer must join the same exclusive
locking protocol to promise the same concurrent completion ordering as revoke.

The internal `builderTreeBatch`/legacy copy helpers intentionally remain generic:
the same helpers are needed by legitimate same-identity edit round trips. Their
production API callers enforce the appropriate new-use boundary. No checked-in
plan-copy stored function was found. Privileged imports/raw SQL are not coach APIs.

## Minimal edit-identity distinction

Existing `is_edit_draft`/`edit_source_plan_id` supplies the identity distinction.
Only apply-back to that exact original plan can retain revoked occurrences. The
original is locked before measuring retained counts, and actual copied-back items
are checked before commit. This is a per-exercise count budget, not a new per-item
lineage/history model. New node/session/block copies are still denied even inside
an edit draft; copying/assigning that draft to another plan is also checked.
Future immutable per-item history would need a separate reviewed provenance design.

Implicit batch sync remains a subsequent transaction for existing ordinary mutation
routes. A shared outer transaction now validates source collection rights BEFORE
executing a mutation that requests fan-out to eligible draft siblings, holding the
same collection lock until the async handler and sync finish. An already revoked
source is rejected before metadata/custom exercise/item writes; a revoke arriving
later waits. There is no new lock namespace or request-lifetime session lock.
This prevents revoke-induced partial saves without redesigning every existing
Builder write transaction. It is not a promise of cross-transaction atomicity for
unrelated DB/transport failures. Awaited response handling propagates expected
409s instead of leaving an Express 4 request pending.

The request's server-created active guard is passed to inner copy/sync validators:
they validate entitlements but do not acquire another shared advisory lock on a
different connection behind a queued revoke. The outer owner alone releases the
lock after the handler finishes. Admission is bounded to
`floor((pool.max - 1) / 2)` guarded requests, leaving checkout headroom; excess
requests return 503 `builderBusy` before mutation. Implicit batch work needs a
pool of at least three connections (the existing default is ten). This bounds
wrapper-induced exhaustion, not all possible unrelated pool pressure.
Tests exercise a queued revoke and concurrent requests with an actual max=3 pool.
Context is selected from the matched route's real target; an unrelated payload
`targetSessionId` cannot redirect a node mutation's preflight. For deletion and
day overwrite, preflight excludes the content actually removed and includes the
authorized replacement source. Removing the last revoked occurrence can therefore
sync the remaining permitted content; removing unrelated content cannot bypass
the guard while a revoked occurrence remains.

## Active-user invariant

`server.js` installs `authMiddleware` before all routers and gates Library,
Builder, template, plan and organization routes with `requireAuth`.
`auth.js:getSessionUser` joins a valid unexpired session to `users.is_active=true`.
The SQL platform-admin exception separately requires an active platform_admin role.
No duplicate user-activity join was added. Tests use the real middleware to verify
that an existing admin session receives 401 after account deactivation.
This is a request-authentication invariant, not a new in-flight deactivation lock.

## Migration / rollback validation boundary

The original ownership migration is unchanged. The prepared source-integrity
migration is also unchanged in this final-access iteration. Its canonical system
source, immutable copy provenance, indexed inverse reference checks, row locking,
READ COMMITTED demotion requirement and fail-closed migration preflight remain.

Both files have now been executed by the official `applyNewMigration` per-file
runner in independently created/dropped databases on a dedicated loopback-only
PostgreSQL 17 test server. Guard tests cover invalid sources, source/copy races in
both READ COMMITTED orders and stale REPEATABLE READ snapshots. Rehearsal covers
checksum/idempotent skip, invalid-data and isolation refusal, empty-state rollback
inside an explicit transaction that is itself rolled back, and refusal to roll back
populated provenance without changing its rows.

These fixtures are a minimal legacy-schema contract, NOT a production schema clone.
The complete startup migration runner and M2b/v37 were not executed. This proves
isolated SQL behavior, not compatibility with an unknown deployed schema/ledger.
The original applied-state checks, production-size lock/index-build assessment,
DB grants/RLS audit and backup/restore/cutover remain separate release gates.
Code-only rollback to pre-ACL runtime and mixed old/new instances remain unsafe.
The empty-state rollback does not reconcile migration ledger entries; a committed
operator rollback/restart or post-use recovery needs a separate reviewed plan.
