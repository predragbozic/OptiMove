# P1 Pages — refreshed contract and delivery plan

Status: PLAN ONLY, 2026-11-22; owner confirmation required before code.
Level: **RISKY** (Page model, backfill, access, transactions).
Inspected main: `a5647dce2867a4a890f1c782dbe7d86b0906a2d7` (#715).
One focused implementation PR is proposed, on a fresh main branch. This docs PR adds no
SQL file, table, route, application code or production setting.

## 1. Confirmed scope and baseline

Order: P1 Pages -> P2 all seven gallery forms/output -> P3 references/Radar. P1 includes
copy-to-page; browser PDF belongs to P2. Simple multi-variable tables are a separate later
contract. English UI. Pages inherit dashboard rights; no per-page permissions.

P1 covers Home, create/rename/reorder/delete-empty, page-local period/defaults/layout,
Simple/Advanced on the selected Page, copy-to-page and whole-dashboard clone preserving
Pages. No gallery, threshold/Radar persistence, PDF, new role word, GPS/import change or
cross-dashboard/workspace widget copy/move.

P3 decision recorded, NOT implemented here: several named target TABLES under Training Load
> Data configuration beside Variables & mappings; rows keyed to the other stream's position
registry (v87), columns are variables, each cell has an extensible set of named target
values (minimum/maximum/target and later names). Coach selects table and values for lines,
bands or Radar. Manual entry first; later import fills the SAME contract/storage. Missing
targets stay unavailable. Team/individual rows are later. Ask the owner for the position
contract at P3; P1 creates no position list or dependency on v87's data.

Sources inspected: ADR-002/003/005/006, migration rules; v15-v19 functions/schema, v71
Simple/presentation/receipt SQL, v79 ratios, v84 roles, v85 session types;
trainingLoadDashboardAccess/Catalog/Widgets/Query.js; dashboardShellFilter.js;
dashboardSimple/{schema,previewContext,previewBinding,saveService,saveRequest,retention}.js.

- No persisted Page model exists on main; pages:false and a dormant context schema do not
  implement Pages. Existing writes lock dashboard -> widget -> series.
- owner_scope and data_workspace remain separate. Existing dashboard view/manage predicates
  and active data-workspace checks remain authoritative; no role_hint/body workspace.
- Preserve v71 receipts/retention, ratio math/coverage/conflicts, built-ins and v84 fail-closed
  role loading. No expansion of athlete calculated/estimate visibility or Simple's pilot.
- #696 shellFilter remains a separate hard AND on authorized facts, OR within selections,
  current active membership, max 200 raw IDs, constrained-empty and preview binding.
  It is never stored as Page/widget defaults or used as a source of facts.
- Historical production counts of six widgets/six series are NOT current evidence. The
  owner obtains fresh read-only counts/digests before production preflight.

## 2. Schema, defaults and invariants

New training_load.dashboard_pages: id, dashboard_id, name, position, is_home, revision,
defaults_revision, period_config, default_filter, timestamps. Add dashboards.pages_revision
for navigation CAS and dashboard_widgets.page_id (NOT NULL after backfill).

- Exactly one Home per dashboard/template: partial UNIQUE(dashboard_id) WHERE is_home
  plus a deferred check requiring a Home for each surviving dashboard. Dashboard deletion
  in the same transaction is exempt. Home identity/parent cannot change or be deleted;
  initial name "Home", position 0. Its label may be renamed under the ordinary name rule.
- Max 20 Pages including Home, enforced in DB under a dashboard lock. Nonempty deletion
  returns stable pageNotEmpty; no cascade option. Empty Home deletion is also refused.
- Name: 1-80 Unicode characters, case-insensitive unique per dashboard, no trimming or
  invisible/control/edge-space characters. Reuse v84 permission_text_ok/textOk semantics
  and one DB normalization rule in validation/tests.
- Composite FK (dashboard_id,page_id) must reference the same dashboard's Page. Existing
  widget parent is immutable except migration backfill; P1 copies, never moves it.
- Period is fixed/relative with explicit IANA zone and server evaluatedAt. Home starts
  period_config=NULL, inventing no dates/timezone. Legacy requests' explicit dateFrom/To
  continue to override a configured Home period. A new Page's shared period is chosen on
  Create; GET never saves resolved dates or defaults.

### Home/default bridge: explicit proposal for this plan's approval

Each Page owns its filter defaults. Home is canonical; dashboards.default_filter remains
its legacy projection. Backfill copies the exact JSON into Home without changing the
existing dashboard row. Sanctioned Home-default writes update both in one transaction;
legacy metadata writes likewise update Home. A deferred equality check prevents drift.
Other Pages have independent default_filter objects and do not silently change with Home.
New Page defaults are explicit (empty unless the user chooses to copy), never shell state.

Thus old GET/PATCH/query/Simple filter behavior stays coherent, without an ambiguous extra
dashboard-default layer in Page queries. Page precedence: Page defaults -> runtime keys ->
widget override, then shell AND. Home initial state gives the same effective legacy filter.
This bridge is a proposed contract requiring confirmation, not a claim about current code.

### Exactly one Home creator

One AFTER INSERT dashboards trigger calls ensure_dashboard_home(), covering create_dashboard,
old cloneDashboard raw inserts and system-template inserts. No application fallback creator.
Historical backfill explicitly creates the existing Homes under the same invariants.
A BEFORE INSERT widget trigger supplies Home only if page_id is omitted. An explicit Page
is validated, never coerced. FK/internal triggers are never disabled.

## 3. Revisions and scoped constraints

Retain exact current widget revision behavior, including v71 presentation updates and
series changes. Dashboard revision retains current metadata/archive/widget-set/layout
bumps and per-row counts; do not add a dashboard bump for every content/series edit.

| Write | Dashboard revision | pages_revision | Page revision | defaults_revision | Widget revision |
| --- | --- | --- | --- | --- | --- |
| Backfill | unchanged | initialized without a revision write | Home starts 1 | starts 1 | unchanged |
| Create/rename/reorder/delete-empty Page | unchanged | bumps on actual navigation change | affected live Page bumps | unchanged | unchanged |
| Page defaults | Home filter uses legacy metadata bump; other Pages unchanged | unchanged | bumps | bumps | unchanged |
| Widget insert/delete | existing set bump | unchanged | target Page bumps | unchanged | current behavior |
| Widget layout | existing layout bump | unchanged | target Page bumps | unchanged | current behavior |
| Content/presentation/series | current behavior, no extra parent bump | unchanged | target Page bumps | unchanged | current behavior |
| Shell/personal period/read | unchanged | unchanged | unchanged | unchanged | unchanged |

No-op and replay add no bumps. Page layout uses expectedPageRevision; widget/series edits
keep expectedWidgetRevision; shared defaults use expectedPageDefaultsRevision; navigation
uses expectedPagesRevision. Failure rolls back the whole operation. Page revision is an
additional cache/CAS signal, not a substitute for widget CAS.

Order/mobile-order unique constraints and overlap/layout-set checks become Page-local;
retain legacy constraint NAMES referenced by old SET CONSTRAINTS statements, changing the
scoped definitions. Grid/type bounds stay. Same coordinates on different Pages are valid.
Series cap, axis/unit/source/metric visibility, resolution and aggregations remain per
widget/series, not per Page. New Page bump triggers are activated after backfill and run
under a Page lock already acquired by a sanctioned writer.

Legacy layout CAS remains expectedDashboardRevision and its adapter checks the Home widget
set only. Another Page's structural/layout change can make that old global CAS stale;
reload/refusal is safe. Rehearse the deployed frontend's exact read -> layout save -> read
-> stale attempt and v71 content/series sequence, comparing precise responses/revision
deltas. Monotonic revision counters alone do not prove compatibility.

## 4. Lock order and sanctioned writes

Ancillary order: request advisory/idempotency, live user then session/role/workspace locks
(current v71/v84 order), then **dashboard -> page -> widget -> series**. Multiple parents
at each level lock in ascending UUID order before the next level. Same-dashboard A->B and
B->A copy lock both Pages sorted. Catalog locks retain the stable v71 order, all before
the first write. A trigger after locking a widget cannot establish page-before-widget.

Proposed new SECURITY INVOKER functions (signatures frozen with SQL before review):

- ensure_dashboard_home(), assert_page_writable(), mutate_dashboard_page() for Page
  create/rename/reorder/defaults/delete-empty;
- page_replace_dashboard_layout(), page_update_widget_layout(), page_create_widget(),
  page_update_widget_content(), page_delete_widget();
- page_add_series(), page_update_series(), page_resolve_series_binding(),
  page_delete_series(), page_reorder_series();
- save_simple_page_widget() using the existing Simple request ledger;
- copy_dashboard_page_widget(); guard_dashboard_page_requests() and bounded
  cleanup_dashboard_page_requests(limit) for a new Page-operation ledger.

Review/change with exact signature/body gates: create_dashboard, update_dashboard_metadata,
replace_dashboard_layout, update_widget_layout, create_widget, update_widget_content,
delete_widget, add_series, update_series, resolve_series_binding, delete_series,
reorder_series, archive_dashboard, v19 delete_dashboard, v71 create_widget_with_presentation,
update_widget_content_with_presentation, save_simple_widget, and parent/revision/overlap/
compatibility helpers. set/clear_active_dashboard keeps dashboard identity, not Page state.
Legacy public signatures/return columns stay unchanged and Home-only; internal locking
must include Page before widget. No unported writer may reach non-Home by widget ID.

cloneDashboard() remains ADR-003's ONLY documented raw composite exception. Extend its ADR
entry for Pages, lock source dashboard/Pages before reads, use the single Home creator on
the target, map other Pages, re-resolve template bindings for the destination workspace,
and clone widgets/series/presentation in one transaction. During old-server overlap only
Home exists, so its old raw clone statements remain safe.

System-template Home creation uses the same trigger. Preserve current structure visibility,
Advanced management and clone requirement for data/Simple queries. Whole-dashboard delete
removes Pages in its transaction and retains v19's exactly-one deletion log and append-only
guards. Deleting an empty Page is not whole-dashboard deletion.

## 5. API, access, UI and queries

New /api/training-load/dashboards/:dashboardId/pages namespace: list/detail/capabilities,
create, rename/defaults, reorder, delete-empty, query; Page-local layout/widget/series
routes; copy-to-page; Page-aware Simple capabilities/metrics/validate/preview/save/status.
Freeze a full method/path/operation matrix in the implementation PR. No second auth chain
before the global one. With P1 off, NO Page-writing HTTP route is mounted; prove it by
route enumeration and a mutation bypassing the mount gate, not just a disabled button.

Page has no owner/rights list. Structural reads use canViewDashboardRow, structural writes
canManageDashboardRow, as dashboard management does today. Data queries and Simple
preview/save additionally require bound data_workspace to match the once-resolved active
workspace. Copy revalidates definitions against the stored dashboard workspace; navigation
and copying config never query facts. Use current v84 loaders/predicates, no new raw role
list, permission word, role_hint, or body-supplied workspace. Preserve fail-closed loading
and live-authority checks. Simple's current MODE/platform-pilot gate applies to EVERY new
Simple/runtime path; Pages do not widen its audience.

Well-formed foreign-parent Page IDs, missing Pages and Pages of invisible dashboards give
identical 404 {"error":"notFound"} bodies/application headers. Anonymous handling remains
that of the parent router. Ownership and data-workspace checks stay independently tested.

Old clients omit page id: their read/query/layout/widget/series operations mean Home,
with unchanged envelopes/validation and no other Page's widgets. SQL wrappers enforce
Home even past the JS adapter. New clients use explicit Page routes. Keep existing
active-dashboard storage; selected Page is personal UI/cache state keyed by user/workspace/
dashboard, with no DB write on read.

UI: one navigation, create/rename/reorder/delete-empty and copy destination picker; keyboard
and mobile controls at 390/1280 and 360 input/touch checks. Clear Home identity. No UUIDs,
SQL, JSON or technical codes in coach/admin panels. Nonempty deletion: "This page still
has widgets. Remove them before deleting the page." Stale edit: "This page changed. Reload
it before saving." One next action; server capability, not client role guessing, offers
Simple. No PDF or gallery implementation in P1.

Capture Page period/defaults once per query. Preserve #696 shell null/empty, 200 total,
current membership and extra AND semantics. Preview and saved query use the same scope;
tokens bind Page id/defaults revision, period/filter, shell and resolved cohort. Ratios,
coverage, comparisons and built-ins use that scope; no after-the-fact client filtering.
Cache/generation keys include identity/workspace/dashboard/Page, Page/default/widget
revisions, resolved period, runtime and shell. Changing Page/period/shell clears old results
and preview; late responses cannot repaint/save another Page. Back/reopen restores personal
Page only inside the authorized dashboard.

## 6. Receipts and copy

Never mutate/truncate/re-hash existing v71 receipts. Legacy hashes and token bindings remain
byte-compatible for Home while its configuration/revisions are unchanged; adding Home alone
must not invalidate an old preview. Ingest an old request before migration and replay it
afterwards. New Page Simple input binds pageId/defaults revision and new receipts may carry
Page identity; old receipts lacking it mean Home. Replay returns the original stored receipt,
not a recomputation; status follows existing live actor/dashboard/widget access policy.

Page CRUD/default/reorder and copy use a separate Page-operation ledger: initiator/requestId
unique, workspace/parent/operation/canonical hash, receipt in the same write transaction.
Same id/input replays, changed input conflicts; live access is revalidated before replay.
Include status/recovery for unknown outcomes. Use v71's request/retention timing policy.
Guard UPDATE, young DELETE and TRUNCATE; permit only bounded expired cleanup. Wire cleanup
into the existing retention tick, isolated from other purges, with an actual schedule-call
test. No new cron and no receipt deletion to enable rollback.

Copy stays within one dashboard. Required source Page/widget + expected source widget
revision, destination Page + expected destination Page revision, requestId. New widget and
series IDs; preserve compatible content/display/presentation/source policies and revalidate
bindings. Source unchanged; no measurements copied. Allocate a free destination layout
position and append Page-local order. Incompatibility/forbidden binding is refused with a
plain next step, not silently stripped. Lost responses use the same requestId/status.
Cross-dashboard/workspace copy and moves are outside P1.

## 7. Migration slot and backfill

Request **ONE fresh migration slot** for this coherent schema, compatibility functions,
Page writers/ledger/copy and constraints. Candidate label is the next free AFTER v87
(v88 only if the owner confirms it free); nothing is reserved by this plan. The unique
12-digit prefix comes from the owner. v86/v87 are taken; no v75 or old draft number/prefix
reuse. If a separate second migration proves necessary, return with its reason/order before
writing it; do not silently add a slot.

Before SQL: obtain the assigned filename and exact v86/v87 filenames/checksums. Use an
explicit baseline/allowed-file manifest, not max(version) or wildcards. Require actual
committed prerequisites including v71/v79/v84/v85. Independent v86/v87 may be recorded or
absent and in either pre-P1 order only after their contracts confirm no dependency;
function/trigger drift still aborts. Position data is not a P1 dependency.

Use the runner's transaction; no outer BEGIN/COMMIT in the SQL. lock_timeout=5s, initially
statement_timeout=30s (prove adequate in rehearsal; larger budget needs review). Acquire
parent table locks: dashboards then dashboard_widgets, then needed series DDL locks.
ACCESS EXCLUSIVE on dashboards/widgets lasts until COMMIT: acknowledge the brief read/write
pause. Widget table first could deadlock an existing dashboard-first writer. Preflight
quiet-moment block rejects long transactions/lock waits; timeout aborts rather than leaving
partial work. Measure duration and row counts, do not extrapolate the historic six widgets.

### Explicit trigger/body gate, then zero-revision backfill

The migration itself reads pg_trigger user triggers on dashboard_widgets and requires an
EXACT reviewed set by name, function signature, md5(prosrc), enabled state, trigger definition
and constraint timing. Unknown added/removed/changed triggers abort before backfill.
Candidate set from this inspected source (rebuild/confirm on fresh implementation main):

- dashboard_widgets_bump_parent_on_insert; dashboard_widgets_bump_parent_on_delete;
- dashboard_widgets_protect_dashboard_id;
- dashboard_widgets_validate_layout;
- dashboard_widgets_revalidate_series_on_type_change;
- dashboard_widgets_lock_dashboard_before_layout_write;
- dashboard_widgets_check_no_overlap;
- dashboard_widgets_bump_revision;
- dashboard_widgets_guard_presentation.

Also gate EVERY replaced existing function by exact signature and prior body MD5; provide
old/new body manifests and order. Another track's update stops migration, never gets
silently overwritten. This is an SQL gate, not only a runbook preflight.

Under the locks, snapshot counts and sorted per-dashboard row digests. Create exactly one
Home per existing dashboard, exact legacy filter JSON, NULL period. Temporarily disable
ONLY those explicitly listed user triggers on dashboard_widgets in the same transaction;
backfill ONLY page_id; re-enable ALL listed triggers before installing reviewed Page-aware
bodies/new triggers. No session_replication_role, superuser assumption, DISABLE TRIGGER ALL/
USER or disabled internal/FK trigger. Prove the needed DDL with a non-superuser table-owner
role equivalent to Supabase postgres, not only a local superuser.

Final SQL assertion: complete expected old+new trigger set enabled 'O', definitions/function
MD5s equal new manifest, or abort the transaction. A failure also rolls back disable states.
Postcheck repeats enabled/hash checks independently. Install Page revision bump paths after
backfill. Existing widget bytes change ONLY page_id; series and old dashboard/widget
revisions, timestamps, content, display/presentation and layout remain identical. New Page/
navigation counters initialize without legacy bump triggers.

Home creation/defaulting must exist before COMMIT. Atomically validate scoped uniqueness,
overlap and composite FKs; no committed nullable/unassigned widget or disabled invariant.

## 8. Old-server deploy-gap rehearsal

npm start migrates before switching to the new server, while the old build may serve.
Freeze the ACTUAL previous deployed build SHA with the owner (UNKNOWN here), start that
unmodified build against the migrated disposable DB with Pages off, and prove all seven:

| Previous-build flow | Required result |
| --- | --- |
| Create dashboard | exactly one automatic Home, current response/revision |
| Create widget without page_id | database assigns Home, normal layout/series checks |
| Layout save | Home-only set, exact old dashboard CAS/deltas; stale rejected |
| Clone/dashboard/system template | old raw inserts, one Home, preserved bindings |
| Delete dashboard | Page FK cleanup, exactly one v19 log row in same transaction |
| v71 save/status/replay | original signatures/hashes/receipts; pre-migration request ingested and replayed after |
| Old frontend read/query | identical Home widget IDs/order/layout and envelope, no mixed Page union |

Record exact old SHA, requests/responses and data/revision assertions. Simulate cutover
while old create/layout/clone/delete/Simple requests run. With feature off, application
mounts NO Page-writing route, so it cannot produce a second Page during the gap. DB
functions are tested by a test-only caller; presence is not production activation.

## 9. Deployment, rollback and feature-off behavior

One frozen RISKY implementation PR, independent review + Claude full gate. For the new SQL:
preflight.sql, postcheck.sql, rollback.sql and Markdown runbook. No deployment/activation
permission is implied by this plan, a GO, a merge or an off-mode deploy.

1. Owner assigns fresh slot/prefix and confirms previous build; owner reads current counts.
2. Disposable baseline v71-v85 plus exact optional v86/v87 combinations: apply -> rollback
   -> identical normalized catalog -> reapply, with data digests, non-superuser proof,
   seven-flow old build rehearsal and measured lock duration.
3. Both reviews/gate pass; owner issues production order naming exact SQL/checksum. Read-only
   preflight checks all file/body/trigger/data/lock conditions before merge/deploy; abort drift.
4. Deploy with server-owned DASHBOARD_PAGES_ENABLED default false, Page writing routes not
   mounted and capability off. Existing Simple MODE/pilot unchanged. Postcheck counts/digests,
   Home/FKs, trigger/body manifest, legacy save/replay and health. Owner chooses activation
   separately, after new Page-aware server is serving and evidence is accepted.
5. Recheck read-only before activation. Never enable a second Page while the previous binary
   can still serve. No automatic widening of the Simple audience.

Preflight records all existing dashboard/widget/series IDs, order/layout, revisions, content
and timestamps in canonical per-dashboard digests (exclude only new page_id in comparisons).
Postcheck proves those rows survive unchanged, exactly one initial Home each at migration
completion, every widget attached to it, and all expected triggers enabled. Counts are observed,
not hardcoded. Digest capture may be exported as owner evidence; no new persistent snapshot
of measurements is required.

Rollback is guarded, not a generic down migration. Check exact P1 filename/checksum and
approved baseline/optional-file manifest, plus current function/trigger hashes. Refuse any
later-prefix/dependent migration outside the manifest; second Page; moved original widget;
noninitial Page defaults/period/identity incompatible with legacy; Page-protocol/copy/CRUD
receipt requiring the new schema; or failed catalog/data/guard proof. Existing v71 legacy
receipts stay untouched. Never delete or mutate receipts to force a rollback.

In an owner-approved quiet window take the same parent locks, restore exact original
function/trigger/constraint definitions from the manifest, remove only P1-added schema and
its own migration record, and prove data/catalog equality. Preserve all current Home-only
legacy writes, including new widgets created since migration. Never delete measurements,
unrelated migration records or v19 history. Rehearse rollback refusals as well as success.
The normalized catalog comparison includes columns/constraints/indexes/triggers/function
bodies/signatures/privileges; excludes unstable internal OIDs/statistics, not application data.

The operational kill switch is DASHBOARD_PAGES_ENABLED=false on the compatibility build:
Page operations unavailable, Home remains available, data is not deleted. After second Pages
or new protocol receipts exist, reverting to an OLD binary is unsafe (its raw read/clone
SQL can mix Pages). Keep new compatibility code running and forward-fix; no automatic
schema or application rollback. This is explicit in the runbook, not "clean rollback after
real use". Restoring old binary is permitted only after the guarded rollback conditions pass.

## 10. Required proof and planned files

- Real-route disposable tests in all five workspaces; dashboard view/manage and data scope
  independently, v84 multi-role/fail-closed/revocation, foreign/missing Page-parent response
  bytes/headers, unchanged Simple pilot/anonymous behavior. Kill each gate bypass, Home
  restriction bypass and off-mode Page-writing mount mutation.
- Two writers: layout/layout, content/layout, series/content, clone/delete, A->B vs B->A
  copy, defaults/preview/save, role/workspace revoke/save, duplicate request. Record locks
  before first write; no deadlock, lost update or duplicate receipt. Guard-only source
  inspection is not concurrency proof.
- Backfill added/changed trigger, old-body hash, enabled-at-end and revision-bump mutations;
  correct Page FK, same/different Page overlap, 21st Page, Home/nonempty delete, invisible
  and duplicate names. Assert exact widget/series bytes and old revisions.
- Actual previous-server seven flows; old frontend CAS sequence; new Page/widget/default
  CAS; Page/shell/period late replies and binding; copy/clone layout/config/source policies;
  original v71 replay and new idempotent recovery; retention tick invokes bounded purge.
- Rollback refusals, pristine apply/rollback/catalog+data equality/reapply and optional
  migration combinations; no reliance on unsupported Supabase superuser privileges.
- Browser create/navigate/edit/copy/delete-empty/reopen at 390/1280, 360 inputs/touch targets,
  keyboard operation, delayed Page replies, no raw coach/admin IDs/SQL/JSON panels.

Planned commands (not run for this docs-only PR), Node 22 / runner-owned disposable DB:

```text
node scripts/test-runner.mjs --project backend --file dashboard-pages-disposable.test.mjs
node scripts/test-runner.mjs --project backend --file dashboard-pages-legacy-server.test.mjs
node scripts/test-runner.mjs --project backend --file dashboard-pages-migration.test.mjs
node scripts/test-runner.mjs --project backend --kind disposable
node scripts/test-runner.mjs --preset backend-fast
node scripts/test-runner.mjs --preset frontend-fast
node scripts/test-runner.mjs --preset e2e
npm --prefix frontend run build
```

New test names are planned, verified with --list after creation and classified as real
disposable tests. Include current dashboard/ratio/shell suites. Compare failures against
exact fresh main and report heads, commands/counts, mutations and every omission.

Expected files: fresh dashboardPages modules; existing dashboard access/catalog/widgets/
query and Simple schema/context/binding/save adapters; NEW SQL, retention, Page UI/state/
cache/actions and tests; ADR-003 and four runbook files. No existing migration edit,
calculatedValues.js, GPS/position stream file, P2/P3 implementation or multi-variable Simple.

## 11. Confirmation before code

Confirm this complete contract, especially the explicit Home/default legacy projection
and single-slot deploy/activation boundary. Then assign one free number/prefix and supply
exact v86/v87 filenames. Actual deployed old build, current production counts and live
function/trigger hashes remain UNKNOWN pending owner-provided/read-only preflight and
disposable proof; they are prerequisites, not already established facts.

No application tests, database access, migration execution, production change or deploy
for this docs PR. Only repository source inspection, document checks and git diff --check.
