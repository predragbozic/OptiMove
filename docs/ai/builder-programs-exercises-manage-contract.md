# Builder, Programs and Exercises Manage contract

Proposal from the #788 merge `27f6418396c96d23757aa02f646d45d94075fff1`, for the Builder/Programs/Exercises stage of [R4 O7](roles-r4-contract.md). Keep the separate Dashboard stream and Training Load M-3 outside this packet. Reconfirm routes, migrations and deployed predecessor before each implementation. No slot is assigned. These are technical design clarifications and do not record a new owner approval.

## Authority and sequence

Native club and team staff must retain the current module View/use right, licence and requested resource relationship, and hold the relevant fixed Manage word at the **active native** scope. This adds a restriction to existing plan/athlete, template, exercise and media predicates. It does not grant access from a different workspace, a submitted owner, a view-only workspace or an inferred role. Preserve the exact existing platform and private-coach branches, athlete reads and external flows. Current access in [V-7](roles-v-steps-plan.md), [permissions.js](../../backend/src/permissions.js) and the existing [v84 registry](../../migrations_v2/202611201300_roles_v84_permission_roles.sql) is the authority baseline.

1. **Program editing.** Bridge and expose `programs.edit`. The edit branch of Submit and the combined Builder exercise-creation branch are included. Combined branches enforce the new word that has shipped and the existing gates for the other operation until its own word is enforced.
2. **Assignment and publication.** Bridge and expose `programs.assign` and `programs.publish` as a focused topic. They remain independent authorization checks and have separate negative evidence. Stage separately if compatibility cannot be proven together.
3. **Program RPE settings.** Bridge and expose `programs.rpe_settings` for Builder plan settings and propagation. Keep external schedules on the existing M-2 word and boundary.
4. **Exercise catalogue.** Bridge and expose `exercises.add` and `exercises.remove` with the Builder custom-exercise entry examined in the same packet. Exercise media follows as a separate provider/storage topic with `exercises.media.upload`. Review global Exercise Blocks and shared presets separately. The existing session-type catalogue authoring rules remain in place.

Each bridge is independently rollable with subsequent words disabled. Do not stage hidden words in application projection or role editing before every path for that word is checked.

## Programs route and effect matrix

`/api/plans` has read-only GETs here. Preserve its athlete and staff read behavior. Inventory mounted methods of [Builder](../../backend/src/routes/builder.js) and [Templates](../../backend/src/routes/templates.js), including commands reached by dispatch or through a shared service.

| Existing command under the indicated mount | Required checks and retained effects |
| --- | --- |
| Builder POST `/plans`, POST `/weekly-templates`, PATCH `/plans/:planId`, POST `/plans/:planId/edit` or `/duplicate`, DELETE `/plans/:planId` | `programs.edit` for content/draft structure, cleanup and deletion. Preserve existing source visibility and target ownership/access. A draft target continues through the existing athlete-scope checks. Creating or copying a draft has no assignment effect and uses Edit. `/duplicate` with `intent=assign` creates active copies, assigns them and records assignment notifications. Require both `programs.assign` and `programs.publish` for that branch before writing targets. Gate other combined operations by their actual effects. Recheck current owner, active workspace and permissions before disclosing an existing receipt. |
| Builder plan `/blocks`, `/weeks`, `/weeks/:week/move`, and child block/session/node/item create, move, patch, delete and copy routes | `programs.edit` for destination plus existing visibility/reuse for source exercise or content. Day/block/session copy-into and node copy need independent source vs destination assertions. Builder `/nodes/:nodeId/exercises` also retains current exercise reuse rights. |
| Builder POST `/plans/:planId/sync-batch` | Check actual nested operation and every affected plan/athlete before changes. Preserve sibling claim, atomicity and existing lifecycle. Inventory `respondWithDraft`: on flags that trigger `syncBatch`, the primary transaction commits first and the sync runs after it. Gate the primary write and later sync separately under their own clients and preserve their distinct failure results. Changing that two-phase behavior needs a separate contract decision. |
| Builder POST `/plans/:planId/submit` | Active-plan edit draft applies to the existing active plan under `programs.edit`, with no new activation or assignment notification. Draft activation requires `programs.publish`. If that transaction actually edits siblings or assigns new athletes, also require the corresponding word for those writes. Inventory the non-batch empty-draft deletion before the activation transaction and batch emptiness cleanup inside it: gate their destructive side effect with edit before deletion. Preserve no-op/repeat and source-changed outcomes. |
| Builder POST `/plans/:planId/assign-weekly`, Templates POST `/:planId/assignments` | `programs.assign` and existing source and target-athlete checks, in the same transaction as assignment. Account for assigned copies and any actual activation effect. Retain weekly slot lock, replacement confirmation, deduplicated durable notifications and post-commit realtime. Preserve ordinary partial success in Templates assignments. Resolve/authorize each athlete on the same client as its write and return the same neutral skipped outcome for an inaccessible or missing target, without exposing its name or existence. |
| Templates PATCH `/:planId/metadata`, POST `/:planId/tags`, DELETE `/:planId/tags/:tagId` | `programs.edit` for shared canonical template mutations, preserving author/manager and library constraints. Inspect the publish-state fields of metadata updates and gate actual publication separately. Keep POST `/:planId/use` usage records and POST `/:planId/reviews` on their existing library/participant authority. |
| Builder PATCH `/plans/:planId/training-load-settings`; POST to its `apply-to-training-sessions`, `turn-off-before-after`, `turn-off-all-rpe` children | `programs.rpe_settings`; recheck plan state/source and affected session scope under lock. Inventory equivalent changes through general plan/session PATCH or activation and explicitly include PATCH `/api/training-load/sessions/:sessionId/rpe-enabled` and PATCH `/api/training-load/sessions/:sessionId/training-load-enabled`. Both routes use the same existing `programs.rpe_settings` permission boundary and `plan_workspace_ownership` authority. Preserve the edit-draft cascade and personal behavior. An unresolved owner or unknown workspace grants no authority. Classify by effect so alternate endpoints cannot bypass the word. Preserve active/edit-draft and propagation semantics. |

Use one client through the authoritative authorization, write and existing receipt path. Derive scope hints before entity locks. Take the shared R4 club ceiling before row locks, lock the actor in the agreed order and check the actual words and resource ownership. Preserve the Builder exercise-reuse namespace and existing plan, draft, sibling, weekly-slot and child lock order. Record the order of those resources before inserting R4 locks. Lock/recheck both role state and current plan context before accessing a protected result or committing. For multiple plans and targets, keep deterministic order and prove all-or-nothing refusals for operations already atomic. Preserve the Templates assignment partial-success contract. Source View is separate from destination Edit. Preserve existing idempotency keys, version conflicts, notification dedupe and reload behavior; no generic request ledger is proposed. Test stale authorization while waiting and prove an aborted command changes neither plans/assignments nor notifications, media references or receipts.

## Exercise, media and preset routes

- **Catalogue:** at [`/api/exercises`](../../backend/src/routes/exercises.js), POST `/` and `/:exerciseId/copy`, PATCH `/:exerciseId` and PUT `/:exerciseId/classification` use `exercises.add` for authorized canonical create/edit/classification. Protect canonical exercise tag attachment/removal under the shared-edit boundary after verifying whether the tag itself is administered separately. Copy keeps source visibility/sharing and target creation separate. POST archive/restore and DELETE `/:exerciseId` use `exercises.remove`, preserving any narrower current requirements. DELETE `/:exerciseId/permanent` keeps its current more restrictive authority and media/usage checks. Preserve personal POST hidden, POST/DELETE favorite and POST visible-marked read/lookup behavior. Builder POST `/nodes/:nodeId/custom-exercise` actually inserts `library.exercises` and a plan item with possible media. It must check the applicable `programs.edit`, `exercises.add` and exercise media word where it attaches media, and commit all effects together.
- **Media:** [`/api/media`](../../backend/src/routes/mediaStorage.js) covers POST `/uploads`, GET `/uploads/:id`, POST `/uploads/:id/renew`, POST `/uploads/:id/complete` and DELETE `/uploads/:id`, plus canonical attachment through exercise writers. New native exercise reservations carry immutable originating workspace scope, declared purpose and intended effect, independent of the storage account shared across workspaces. Clip eligible legacy inflight reservations to a bounded drain window. Define which old writers can continue within it and which statuses/cleanup stay available after it. Check `exercises.media.upload` and current scope before reservation or URL minting, and again on the same transaction client as asset commit, receipt replay, status return or attachment. Keep provider calls outside database locks. Revoked or switched users cannot disclose status, renew or attach with the old scope. Preserve safe owner cleanup/cancellation after revocation without disclosing protected metadata or issuing another URL. A previously signed URL can still work within its lifetime; when finalization is denied, keep the object under the existing orphan/cleanup policy instead of exposing it as an exercise asset. Scope exercise media separately from program covers, downloads/access and `/api/admin/media` Drive import and storage administration.
- **Presets and access:** [`/api/exercise-collections`](../../backend/src/routes/exerciseCollections.js) includes collection CRUD, single/bulk exercise-block moves and user grants. Before a separate release classify collection authoring under `exercise_lists.manage`, system block authority under global `exercises.blocks.manage`, and grant changes by their existing target/permission boundary. [`/api/taxonomy`](../../backend/src/routes/taxonomy.js) node presets, template-tag definitions and library-kind writers are a separate `presets.manage` contract. Preserve `presets.use` reads and existing session-type catalogue authority. Do not let a shared preset role mutate program- or exercise-owned content through attachment endpoints.

## Evidence and rollout

- Enumerate actual mounted methods and fixed per-command checks, including protected statuses/replays and indirect dispatch. Parameterize exact-scope native success, wrong scope/same-club other team, mixed account, missing View/use, missing applicable Manage, closed licence, view-only, current platform/private/athlete behavior and foreign/missing parity where the current route requires it. Check reads and ordinary permitted operations still work without unrelated words. Assert unchanged rows on a denied combined write.
- Add real disposable HTTP and locked-state tests to existing `builder-tree-batch-routes.test.mjs`, `builder-weekly-assign.test.mjs`, `builder-weekly-slot-guard.test.mjs`, `builder-plan-assignment-notifications.test.mjs`, `program-access-batch-authorization.test.mjs` and `training-load-builder-edit-draft.test.mjs` as applicable. Keep `builder-exercise-access.test.mjs` and `media-storage-be1.test.mjs` baselines. Add missing exact route/permission cases as needed. Pin failures from dropping each fixed word, owner/target scope, owner recheck after waiting and replay authorization. Verify role removal racing Submit, copy and upload finalization, plus older tab retry. Pin media races where the same storage user switches teams mid-flight, permission disappears between provider verification and asset commit, and an old receipt/status/cancel is requested after revocation. Prove cleanup remains possible without metadata disclosure and no unauthorized asset/reference or duplicate receipt is written.
- Browser regressions include `roles-v7-view-programs-exercises.test.mjs`, `builder-weekly-assign.test.mjs`, `builder-weekly-save.test.mjs` and appropriate exercise/Settings flows. Verify the existing View experience, visible allowed actions and server rejection regardless of browser state. Run full backend disposable, frontend-fast, build and affected E2E.
- Pin the exact next deployed predecessor, permission bodies, grants and check registry when starting each bridge. If it needs a seed migration, request a slot then, preserve authored role state and audit revisions, and rehearse preflight/postcheck plus apply → rollback → identical relevant catalogue and data → reapply on isolated PG17. Record first checked use and refusal boundaries for real use, later migration, changed routines or staged seed. Prove old and bridge servers work on the migrated schema with sufficient existing rights and cannot edit/drop the staged seed. After all pre-bridge writers retire, rehearse bridge/exposure overlap with role removal, denied writes and denied replay, then role restoration. Require independent review and full gate. No runtime changes belong to this proposal.

## As-built checkpoint for Program RPE settings

The local RPE branch from 7d9ef14 wires current authorization to the direct staff
changes below. The rollout requires a separate migration reservation and an exact
deployed predecessor. The matrix describes the local runtime before that work.

| Route | Effective change and lock order |
| --- | --- |
| Builder PATCH /plans/:planId/training-load-settings | Weekly draft defaults. Native ceiling and current actor before the draft plan lock. Confirm the stored plan owner and current Builder access on the mutation client. |
| Builder POST /plans/:planId/training-load-settings/apply-to-training-sessions | Apply current locked defaults to the draft's existing T sessions. State and ownership checks match the default PATCH. |
| Builder POST /plans/:planId/training-load-settings/turn-off-before-after | Turn tracking and RPE off for existing B/A sessions in the draft. |
| Builder POST /plans/:planId/training-load-settings/turn-off-all-rpe | Turn only RPE off in the draft. |
| Builder PATCH /sessions/:sessionId | The presence of either explicit flag selects the draft-only RPE write boundary. The locked session must still belong to that plan. Non-RPE changes keep their existing checks. |
| Training Load PATCH /sessions/:sessionId/rpe-enabled and /training-load-enabled | Shared native ceiling, current actor and both View boundaries before the published-session lock. Match the stored plan owner. Preserve the existing-results confirmation and writePublishedSessionFlags cascade in the same transaction. |

New sessions inherit the plan defaults through the established T-phase
calculation. Ordinary copies preserve the source's effective flags. Workspace
planned-RPE defaults, external schedules, athlete feedback and Calendar's
independent alignment command keep their established authorization.

### Pending indirect effects before exposure

The direct bridge checkpoint is independent of this design. Preserve the
existing bridge behavior for indirect operations whose effective RPE changes
cannot be resolved from stable evidence. Hold role exposure for the RPE slice
until a separate provenance contract covers those operations, their tests,
and the old/bridge overlap. The current direct work needs no provenance
migration or new decision on its slot.

| Flow | Evidence and authorization before the first affected write |
| --- | --- |
| Single new-draft Submit | Activation promotes an existing draft without rewriting its flag columns. Use a recoverable creation baseline and a stable inherited source when available. Require RPE Manage for a proven pending policy change. If the draft cannot distinguish a staff edit from inherited defaults or an ordinary copy, retain the legacy bridge behavior and send that case to the provenance contract. |
| Edit-draft merge and Submit | After locking the draft, current live source and applicable live targets, compare each target’s actual defaults and session settings with the proposed result. Use retained logical session identity and the existing explicit batch correspondence where available. A live quick toggle that has already updated both copies is unchanged. Keep creation, deletion, rearrangement and inherited flags on their existing path when they introduce no effective RPE change. Before writing any target, verify current View, RPE Manage and exact ownership for every target with a proven policy change. |
| Explicit sync-batch and Submit’s atomic batch sync | Build the complete per-target effect set from the locked source and every current destination before the first tree/default write, deletion, activation or notification. The existing structured batch operations already provide stable correspondence for some retained sessions. Whole-tree replacements may lack sufficient evidence, especially for replacement sessions with new ids. Use stable identity and explicit source intent. Position, date, ordinal and display labels are insufficient to infer correspondence. Keep ambiguous indirect paths at the legacy bridge boundary until the provenance contract is approved. Never partially apply an already-atomic batch when an affected destination denies the change. |
| Automatic sync in respondWithDraft | The primary mutation commits first. Open a separate sync transaction, rebuild the current target effect set and recheck rights against the actual targets before propagation. On denial roll back the sync alone. Preserve the known committed primary result and use the established partial-outcome behavior; record any needed API change for review before implementation. |

Take shared club ceilings and actor locks before guarded plan/child row
locks while preserving the existing exercise-reuse advisory and ascending
draft/live/sibling order. The comparison runs against the now-current saved
flags and defaults. Native role edits, workspace changes, or a mismatched
target must take effect before the authorization result. Source read and
destination Manage are independent. Stable, unchanged effective settings
and automatic inherited copies need their existing content/assignment
rights.

Pin regressions for a proven changed policy versus unchanged inheritance
and moved sessions, a revoked actor after opening the draft, one denied
sibling with zero writes in the whole atomic operation, and a denied
post-commit propagation with the primary result preserved. Use both old
and bridge binaries before considering exposure. Cases without a stable
baseline remain explicitly open.

### Implemented local subset of indirect checks

The current Builder checkpoint covers retained weekly sessions keyed by
logical_session_id, source/target plan defaults where a scalar difference
can be proven, and the exact session ids and fields in existing live-batch
ops.update. Live session rows are locked before edit-draft copies, matching
the quick-toggle cascade. The check reads plan defaults again under the
existing plan locks and completes every changed target's ownership and
permission checks before mutation.

Whole-tree sync keeps its existing treatment of unpairable sessions. Its
weekly per-target default differences can be checked without inferring
session lineage. Atomic sync and Submit refuse before any sibling mutation
or notification. A separate post-commit sync checks scope inside that
transaction. A specific RPE refusal preserves the primary save and includes
the plain batchSyncMessage with the saved draft response. Other existing
sync failure paths retain their prior handling.

Unmatched additions and stale deleted-source rows, non-weekly copy legs,
first activation without a trustworthy creation baseline and whole-tree
session replacements remain open for the narrow provenance contract.
No role exposure is implied by this partial implementation.

Private coaching applies the stored owner even when the signed-in coach
created a club or team plan. For weekly RPE effects it admits the genuine
user-owned plan only, and checks each affected plan before live Submit or
batch sync. An explicit platform workspace retains its existing override.
For a legacy nonweekly session without a workspace ownership row, the
existing private editor can still change that session directly before
exposure. Never use that fallback when an ownership row names another
owner. Nonweekly direct and propagated settings need authoritative
ownership and provenance before the role word is exposed. A refused
post-commit batch shows its plain status below the draft header.
