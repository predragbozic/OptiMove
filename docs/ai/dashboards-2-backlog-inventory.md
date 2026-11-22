# Dashboards 2.0 backlog inventory

Inventory only, 2026-11-22. **No implementation is authorized by this document.**
Main snapshot: `2b021c42c2145461eba71202c124d06036a850f0` (includes #648, #696 and #712; latest committed migration label v85).
All 22 requested pull-request head refs were fetched and their actual trees/deltas inspected.
No existing PR was pushed, closed or merged during this inventory. No production access,
SQL execution, migration run or deploy. Follow-up #712 was sent before starting this inventory
and has since been merged by the reviewer.

## Reading this inventory

- State describes shipped capability against the pinned main, not whether an old commit
  was cherry-picked verbatim. "Already on main" names the later carrier PR and verified files.
- KEEP means preserve the wanted feature/source for a fresh implementation branch, **not**
  merge or rebase the old draft. CLOSE is a recommendation after inventory/owner approval,
  not an action taken here. Closing a wrapper must not lose its still-missing features.
- Size is relative engineering scope, not a delivery estimate: S = isolated contract/math
  or view; M = one UI flow; L = several coordinated modules; XL = schema/transactions plus
  end-to-end integration. Runtime readiness and elapsed-time estimates remain UNKNOWN.
- Tier describes the feature delta. Pure screens/docs/math can be ORDINARY; a package that
  changes SQL validation, workspace access, page model or save transactions is RISKY.
- Conflict column is a reproducible dry merge of the **whole old head** into this main:
  none = zero conflict files; small = 1-3; large = more than 3. Later drafts inherit stale
  earlier work, so these counts are not the number of feature files needing rewriting.
  Representative actual conflict files are named in each row. No merge was performed.
- Each delta is compared with its fetched parent/base (or graph merge-base for main-based
  drafts). A read-only feature-patch check was also performed. #265, #368 and #398's own
  patches apply textually; that does not prove behavior or compatibility. All others need
  adaptation, and some fail because required Page modules do not exist on main.

## 1. Already on main through newer PRs

These five old implementation drafts add no missing base capability that warrants another
merge. The original SQL file in #285 must not be replayed. Newer gates, ratio support,
roles and the shell-filter contract must be preserved.

| Old PR / inspected head | What a coach gets | State against main and verified carrier | Migration / fit | Access or save impact of old delta | Conflicts with main (examples) | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| [#270](https://github.com/predragbozic/OptiMove/pull/270) @ `326d6edd` | A simple three-step widget setup with valid choices. | **already on main: #524 introduced dashboardSimple/schema.js, compiler.js and capabilities.js; #648 adds ratio choices to that live contract.** | No SQL. | Contract/capability checks; server determines readable choices. | large (5 files) — `backend/src/dashboardSimple/{compiler,schema,capabilities}.js` | **CLOSE**; later PRs carry the capability. |
| [#279](https://github.com/predragbozic/OptiMove/pull/279) @ `2317aa47` | Preview real numbers before saving. | **already on main: #524 introduced previewService/Context/Router/Tokens/Transaction; #558 adds the current platform-pilot boundary.** | No SQL. | Authorization/workspace reads and read-only preview transaction. | large (14 files) — `backend/src/dashboardSimple/{previewContext,previewService,schema}.js; backend/src/trainingLoadDashboardQuery.js` | **CLOSE**; later PRs carry the capability. |
| [#285](https://github.com/predragbozic/OptiMove/pull/285) @ `fa981c7b` | Save a widget once and recover an unconfirmed save. | **already on main: #524 / v71 introduced saveService/saveRequest/saveTransaction, revision and durable receipts. The old migration is superseded, not a missing migration.** | Original `202611011300_dashboard_simple_atomic_save.sql`. Does not fit: its CREATE objects overlap committed v71; use the main v71 implementation, not a renamed copy. | Atomic save, revisions, receipts and presentation writers: RISKY if changed. | large (19 files) — `backend/src/dashboardSimple/{saveRequest,previewBinding,previewService}.js; backend/src/routes/trainingLoadDashboard.js` | **CLOSE**; later PRs carry the capability. |
| [#342](https://github.com/predragbozic/OptiMove/pull/342) @ `fdc56222` | Run previews with bounded database capacity. | **already on main: #524 introduced runtime/config and PostgreSQL admission, mounted by server.js; #558 hardens audience/runtime access.** | No own SQL. Runtime now pins the v71 filename/checksum, not the old S2c file. | Runtime routes, admission and transaction budgets. | large (22 files) — `backend/src/dashboardSimple/{runtime,runtimeConfig}.js; backend/src/server.js` | **CLOSE**; later PRs carry the capability. |
| [#353](https://github.com/predragbozic/OptiMove/pull/353) @ `e1297bef` | Create/edit in Simple, then check whether a save succeeded. | **already on main: #524 introduced Simple frontend controller/actions/view; #558 and later #593/#604/#606/#607 repair recovery, safe names and display behavior.** | No own SQL. | Editor UI plus preview/runtime adapters and save recovery. | large (32 files) — `frontend/app.js; frontend/index.html; frontend/training-load-simple-{controller,view}.js; backend/src/dashboardSimple/previewService.js` | **CLOSE**; later PRs carry the capability. |

Verified introduction point: merge `3a71d5faf611b8fbb32360aac83b6143b46392d2`
(#524) adds all of those backend Simple modules and the frontend controller. Pilot merge
`c6c92cae944890197f698abdef41b70819a60413` (#558) adds the present audience protection.
The v71 file is `migrations_v2/202611151000_training_load_v71_dashboard_simple_atomic_save.sql`;
runtime.js names and checksums that file. Main still reports pages:false and backendReference:false;
that is not evidence that the Page or reference backlog shipped.

Additional later work to preserve, not credit to the old drafts: #648
(`e087d209725c1efdc0e8078f1754f55396785c89`) supplies ratios/calculation coverage;
#696 (`e2d5de6c0ba7970cb35f8c6162147fd40dc09267`) supplies the shared shell filter;
#712 (`2b021c42c2145461eba71202c124d06036a850f0`) supplies the backend-only HTTP fixture and successful-empty assertions.

## 2. Old chart gallery drafts: one RISKY group

**None of these seven features is implemented end to end on this main.** Current renderer
training-load-analysis-echarts-options.js builds bar/line plots (including athlete lines),
not the gallery variants below. Gallery/composer/pairing/stack modules below are absent.
The supplied ECharts library containing a chart implementation is not a product feature.

Important: the old migrations do **not** register seven independent new catalog widget
kinds. They extend the persisted presentation contract and replace
training_load.dashboard_presentation_valid / dashboard_presentation_assert_compatible,
plus marker/guard functions. Main v71 currently accepts athletes-v1, not these variants.
Thus this entire gallery group is **RISKY as authored**, even where the visible change
looks small. The six SQL files must be redesigned/consolidated against current function
bodies with fresh owner-issued numbers/prefixes; none of the old slots is proposed for reuse.

All SQL filenames in the following tables are under migrations_v2/.

| Old PR / head | What a coach gets | State / size / tier | Every own SQL migration and fit | Server-side processing added | Depends on | Conflicts (examples) / recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| [#391](https://github.com/predragbozic/OptiMove/pull/391) @ `c16dcefd` | Pick a chart from a gallery, including area and horizontal bars. | **not on main**; L; **RISKY** group | `202611051200_training_load_v60_chart_gallery_variants.sql` — does not fit: label is occupied on main and the old prefix/body sequence is stale. | Extends Simple schema/compiler/preview and SQL presentation validators for chartVariant; capability marker dashboard_chart_variants_v1. | Current Simple base; interaction/composer work from #355. | large (40 files) — `backend/src/dashboardSimple/{compiler,previewService,schema}.js; frontend/training-load-simple-view.js`. **KEEP** feature/source, rebuild on main. |
| [#392](https://github.com/predragbozic/OptiMove/pull/392) @ `956dfdfd` | Show bars and a line together with separately labelled axes. | **not on main**; L; **RISKY** group | `202611051300_training_load_v61_combined_chart.sql` — does not fit: label is occupied on main and the old prefix/body sequence is stale. | Adds metrics-v1/combined presentation validation and automatic-axis checks, plus Page service adapters; it is not only a new drawing. | Gallery base; Page service in the old implementation (#370/#376). | large (40 files) — `frontend/training-load-analysis-{view,echarts-options,data}.js; backend/src/dashboardSimple/compiler.js`. **KEEP** feature/source, rebuild on main. |
| [#393](https://github.com/predragbozic/OptiMove/pull/393) @ `c309933e` | See an athlete-by-date heatmap without inventing missing values. | **not on main**; L; **RISKY** group | `202611051400_training_load_v62_heatmap.sql` — does not fit: label is occupied on main and the old prefix/body sequence is stale. | Adds matrix-v1 heatmap schema/compiler/capability and preview checks; replaces SQL presentation validation. | Gallery/interaction base; current authorized query rows. | large (40 files) — `backend/src/dashboardSimple/{capabilities,compiler,schema}.js; frontend/training-load-analysis-echarts.js`. **KEEP** feature/source, rebuild on main. |
| [#394](https://github.com/predragbozic/OptiMove/pull/394) @ `8c847936` | Compare two measurements using matched observations. | **not on main**; M; **RISKY** group | None in its own delta — no migration of its own; adjacent Scatter migration is in #395. | Adds dashboardPages/metricPairs.js and queryContract/service wiring: pairs already-authorized results, refuses ambiguity/duplicates and bounds output; no SQL in this delta. | Page query service (#370/#376); two compatible authorized series; input pairing contract. | large (40 files) — `Inherited Simple/query/UI conflicts; its own patch also requires missing backend/src/dashboardPages/{queryContract,service}.js`. **KEEP** feature/source, rebuild on main. |
| [#395](https://github.com/predragbozic/OptiMove/pull/395) @ `e4ed718c` | Choose X and Y and display the matched measurements as a scatter plot. | **not on main**; L; **RISKY** group | `202611051500_training_load_v63_scatter.sql` — does not fit: label is occupied on main and the old prefix/body sequence is stale. | Adds pairs-v1/scatter validation and capability, Simple/preview/Page-service adapters and server-confirmed metric-pair response consumption. | Pairing #394 plus gallery and Page query contract. | large (40 files) — `backend/src/dashboardSimple/{compiler,previewService,schema}.js; frontend/training-load-analysis-{view,echarts}.js`. **KEEP** feature/source, rebuild on main. |
| [#396](https://github.com/predragbozic/OptiMove/pull/396) @ `36b84576` | See explicitly chosen additive parts as a stacked bar. | **not on main**; L; **RISKY** group | `202611061000_training_load_v64_stacked.sql` — does not fit: label is occupied on main and the old prefix/body sequence is stale. | Adds dashboardPages/metricStack.js plus service wiring and components-v1/stackDefinition validation; rejects invalid component declarations rather than stacking arbitrary metrics. | Gallery/Page query service; agreed additive component semantics, compatible units. | large (40 files) — `backend/src/dashboardSimple/{compiler,previewService,schema}.js; frontend/training-load-analysis-{data,view}.js`. **KEEP** feature/source, rebuild on main. |
| [#397](https://github.com/predragbozic/OptiMove/pull/397) @ `1230a6aa` | See the spread of returned athlete values as a box plot. | **not on main**; L; **RISKY** group | `202611061100_training_load_v65_boxplot.sql` — does not fit: label is occupied on main and the old prefix/body sequence is stale. | Adds distribution-v1 validation, deferred series guards and flush checks in SQL; Page/Simple validation and boxplot composer. It is a distribution of returned aggregates, not raw unseen measurements. | Gallery/Page service; agreed distribution and unit rules. | large (40 files) — `frontend/training-load-analysis-echarts-options.js; backend/src/dashboardSimple/{compiler,previewService,schema}.js`. **KEEP** feature/source, rebuild on main. |

The old migrations' prefixes run from 202611051200 through 202611061100. Their labels
v60-v65 now name unrelated import/estimate/confirmation migrations on main (registry below).
Changing only the filenames is not sufficient: replacement function bodies and current
revision/receipt guards need a new reviewed migration. SQL compatibility has not been
executed and is UNKNOWN beyond these statically verified dependencies/conflicts.

## 3. Remaining items: user value, size, tier and dependencies

| Old PR / head | What a coach gets | State against current main | Size / tier and access-save scope | Own migration / fit | Depends on | Conflicts (examples) / recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| [#265](https://github.com/predragbozic/OptiMove/pull/265) @ `26162ae8` | An agreed design/example for simpler dashboard editing. | **superseded as a live implementation contract by current Simple schema, #524/#558 and the later ratio/shell contracts. Its S1 HTML/Markdown files are absent on main; this does NOT mean all future S1 features were delivered.** | S / ORDINARY; documentation only. | None. | Keep its owner-approved intent as design evidence for the missing packages. | none — `none; its own docs patch applies textually.`. **CLOSE; archive/link the design, do not silently reinstate its older defaults.** |
| [#355](https://github.com/predragbozic/OptiMove/pull/355) @ `60a77aa7` | Use chart details and zoom, then explicitly apply a selected period. | **partly on main: main has presentation schema fields, native legend/tooltips and named athlete lines (#524/#604/#606). The chart-interaction/actions modules, point selection and confirmed zoom-to-period flow are absent.** | L / RISKY gallery group: chart UI plus query-response identity contract; no new permission grant shown by this delta. | None in its own delta. | Current query identity, #696 shell context, interaction/composer support. | large (34 files) — `frontend/training-load-analysis-{echarts,echarts-options,view}.js; backend/src/routes/trainingLoadDashboard.js`. **KEEP; carry missing interactions into the gallery topic.** |
| [#363](https://github.com/predragbozic/OptiMove/pull/363) @ `2ffd642f` | Edit within the dashboard workspace with clearer widget controls. | **partly on main: three-step editing, safe widget actions and mobile recovery already exist (#524/#558/#593 onward). Its inline role=region panel and dedicated chart-composer workspace are not the current role=dialog Simple UI.** | M / ORDINARY; its own delta is frontend/docs only. | None. | Current Simple/actions contracts; gallery interaction work for composer controls. | large (34 files) — `frontend/training-load-analysis-view.js; frontend/training-load-simple-{view,css}.js`. **KEEP the still-wanted layout/UX, not the old labels or overwritten recovery code.** |
| [#368](https://github.com/predragbozic/OptiMove/pull/368) @ `d78de79d` | Define how pages inside one dashboard should work. | **not on main: dashboardPages/contract.js and its tests are absent. A dormant page context in Simple schema with pages:false is not the page model.** | S / RISKY Page contract; no deployed route in this delta. | None; persistence comes in #370. | Reconfirm current Page contract, not the old 32-page assumption. | large (34 files) — `Inherited Simple/server/UI conflicts; own contract patch applies textually.`. **KEEP as input to a refreshed Page plan.** |
| [#370](https://github.com/predragbozic/OptiMove/pull/370) @ `65470716` | Create and manage multiple pages without losing existing widgets. | **not on main: Page table/migration, access/router/service and legacy guards are absent.** | XL / RISKY; page access/workspace, data backfill, revisions and DB writers. | `202611041500_training_load_v57_dashboard_pages.sql` — does not fit as authored; see version/body notes below. | #368 contract; current v71 saves, v84 roles and legacy-client compatibility. | large (35 files) — `backend/src/dashboardSimple/{previewContext,saveService}.js; backend/src/{server,trainingLoadDashboardCatalog}.js`. **KEEP feature; rewrite migration and backfill proof against main.** |
| [#371](https://github.com/predragbozic/OptiMove/pull/371) @ `fce078d2` | Use Simple preview/save on the page currently selected. | **not on main: pageContext.js, page-aware save port and separate page receipts are absent. Current Simple explicitly requires legacyDashboard.** | L / RISKY; page-aware tokens, save transaction, revisions and receipts. | `202611041700_training_load_v58_page_simple_save.sql` — does not fit as authored; see version/body notes below. | Page foundation #370; current preview binding, shell filter and idempotency. | large (38 files) — `backend/src/dashboardSimple/{previewBinding,previewTokens,saveRouter,saveService}.js; backend/src/server.js`. **KEEP; integrate current v71/#696 instead of copying an obsolete writer.** |
| [#374](https://github.com/predragbozic/OptiMove/pull/374) @ `f45a4351` | Use Advanced editing on a page and clone a whole dashboard. | **partly on main: whole-dashboard clone exists via the older catalog/Advanced path; page-aware Advanced writers, receipts and clone behavior are absent.** | XL / RISKY; new page mutation authorization and transactional writers/clone. | `202611041900_training_load_v59_page_advanced.sql` — does not fit as authored; see version/body notes below. | Page foundation and Simple port; preserve v19 deletion logging and current clone exception. | large (39 files) — `backend/src/{trainingLoadDashboardAccess,trainingLoadDashboardCatalog,server}.js; backend/src/routes/trainingLoadDashboard.js`. **KEEP missing Page behavior; do not duplicate the existing clone feature.** |
| [#376](https://github.com/predragbozic/OptiMove/pull/376) @ `3e768cf5` | Navigate pages, add a page and edit its contents. | **not on main: training-load-pages-actions/data/view/css and Page navigation are absent.** | L / ORDINARY screens/adapters as a delta, dependent on RISKY Page backend; old delta also adjusts Page service/capability adapters. | None in its own delta. | Page read/manage APIs and save ports (#370/#371/#374). | large (40 files) — `frontend/index.html; frontend/training-load-actions.js; frontend/training-load-analysis-data.js; frontend/training-load-simple-view.js`. **KEEP; deliver with the Page topic, maintaining English copy.** |
| [#398](https://github.com/predragbozic/OptiMove/pull/398) @ `ef34dfc5` | Define comparisons with targets, including Radar attainment rules. | **not on main: isolated dashboardReferences/contract.js and calculations.js are absent. It is groundwork, not a functioning Radar screen.** | S / ORDINARY pure contracts/math by itself; deploying persisted references is RISKY. | None in this delta; reference storage appears in #487. | Owner-confirmed reference semantics/data and current units; not the Metrics Core stored-ratio formula. | large (40 files) — `Inherited Simple/query/UI conflicts; its own isolated contract/math patch applies textually.`. **KEEP semantic source and tests for the reference package.** |
| [#487](https://github.com/predragbozic/OptiMove/pull/487) @ `7ebcc6e4` | A combined candidate with pages, extra charts, target comparisons, Radar, copy-to-page and print-to-PDF. | **partly on main: its Simple/preview/atomic-save subset is superseded by #524/#558 and display fixes. Pages, gallery variants, reference/Radar modules, page copy and page print are absent. Later ratios/shell are compatibility requirements, not features delivered by #487.** | XL / RISKY wrapper: access, page model, many saves/transactions and presentation/reference SQL; frontend print alone is ORDINARY. | 17 files, fully listed in M487 below. None fits as authored; v71 Simple is already superseded, labels/prefixes and body dependencies are stale. | All three proposed topics; current roles, ratios, shell and receipt rules. | large (40 files) — `backend/src/{server,trainingLoadDashboardAccess,trainingLoadDashboardQuery}.js; dashboardSimple modules; frontend/app.js; frontend/index.html; frontend/training-load-analysis-view.js`. **CLOSE the stale integration vehicle after its missing work is explicitly retained in P1-P3; do not mark the whole feature set merged.** |

## Migration registry and stale assumptions

No migration was run. "On main" below means **committed code**, not a production
schema_migrations record. Fresh version numbers AND prefixes come from the reviewer/owner
on the day of writing; **this inventory reserves and proposes no old or new slot**.
Latest timestamped SQL in this main is 202611201500_training_load_v85_session_types.sql.

All original filenames above are unique paths, but uniqueness is not compatibility.
Their prefixes predate already-committed later work and many CREATE/REPLACE targets
already exist under v71. Even the numeric gaps v58/v75 are not evidence of availability:
reservations and deployment ordering are UNKNOWN here. The previously discussed D2a/v75
reservation must not be assumed current.

Main's conflicting label meanings (all under migrations_v2/):

- v57: `202611051000_training_load_v57_session_undo.sql`
- v59: `202611091100_training_load_v59_import_approval_subset.sql`
- v60: `202611101000_training_load_v60_undo_roster_work.sql`
- v61: `202611101200_training_load_v61_import_states_approval.sql`
- v62: `202611111200_training_load_v62_team_session_timezone.sql`
- v63: `202611121000_training_load_v63_metric_value_estimates.sql`
- v64: `202611121200_training_load_v64_metric_estimate_requests.sql`
- v65: `202611121800_training_load_v65_source_metric_confirmations.sql`
- v66: `202611131000_training_load_v66_club_activation_confirmation_gate.sql`
- v67: `202611131200_training_load_v67_gpexe_track_choices.sql`
- v68: `202611131300_training_load_v68_track_choice_scale.sql`
- v69: `202611131310_training_load_v69_scale_recording_estimates.sql`
- v70: `202611131400_app_error_events_v70_device_and_keyed_hash.sql`
- v71: `202611151000_training_load_v71_dashboard_simple_atomic_save.sql`
- v72: `202611151200_training_load_v72_source_field_observations.sql`

### M487: every SQL file carried by #487

- `migrations_v2/202611111000_dashboard_simple_atomic_save.sql`
- `migrations_v2/202611111001_training_load_v57_dashboard_pages.sql`
- `migrations_v2/202611111002_training_load_v58_page_simple_save.sql`
- `migrations_v2/202611111003_training_load_v59_page_advanced.sql`
- `migrations_v2/202611111004_training_load_v60_chart_gallery_variants.sql`
- `migrations_v2/202611111005_training_load_v61_combined_chart.sql`
- `migrations_v2/202611111006_training_load_v62_heatmap.sql`
- `migrations_v2/202611111007_training_load_v63_scatter.sql`
- `migrations_v2/202611111008_training_load_v64_stacked.sql`
- `migrations_v2/202611111009_training_load_v65_boxplot.sql`
- `migrations_v2/202611111010_training_load_v66_manual_threshold.sql`
- `migrations_v2/202611111011_training_load_v67_catalog_threshold.sql`
- `migrations_v2/202611111012_training_load_v68_chart_reference.sql`
- `migrations_v2/202611111013_training_load_v69_lower_threshold.sql`
- `migrations_v2/202611111014_training_load_v70_chart_reference_dates.sql`
- `migrations_v2/202611111015_training_load_v71_reference_tables.sql`
- `migrations_v2/202611111016_training_load_v72_widget_copy.sql`

Static hazards that were verified in the old code, not inferred from PR descriptions:

- #370 and #487's old Page backfill creates the initial page named "Početna". Current
  product copy is English. The old #368 contract has MAX_DASHBOARD_PAGES=32; earlier
  owner/reviewer Page decisions (20, permanent Home, no nonempty deletion cascade) must
  be carried into the refreshed plan, not replaced by old defaults.
- #371/#374 derive separate Page writer bodies/receipts from an older Simple/Page chain.
  Current main has the audited v71 writer, retention and later pilot/roles changes.
  Backfill-trigger hashes, unchanged widget revisions, old-server deploy-gap rehearsal,
  rollback refusals and ordering cannot be borrowed as passed evidence from these drafts.
- #391's SQL adds chartVariant to the presentation allow-list; current v71 does not
  allow it. #392 adds metrics-v1, #393 matrix-v1, #395 pairs-v1, #396 components-v1,
  #397 distribution-v1 and deferred boxplot checks. These are stored-contract changes,
  not just loading more ECharts code. Six old migrations replace the same validators.
- The old Simple view enums in these branches omit analytical aggregation ratio. A raw
  replacement would discard #648 support. Calculated metadata from v77-v79, estimates
  rules and v84 authorization must survive every port.
- #355's chart action context binds workspace/dashboard/period/runtimeFilter but not the
  new shared shell selection. New chart actions must use the current #696 context and
  reject stale actions after a shell change.
- #394 explicitly pairs already-authorized returned observations and does not choose
  duplicates/interpolate. #396 requires declared additive components. Neither permits
  arbitrary summing of ratios or cross-unit data. Reuse of mathematical code is subject
  to current ratio/coverage semantics, not presumed safe because it is pure JavaScript.
- #487 contains frontend/training-load-page-print.js calling browser print(), and
  copy_dashboard_page_widget in its final SQL file. Print is browser print-to-PDF,
  not a proven server PDF service. Neither entry point is present on this main.

## What to close and what to keep

**Proposed CLOSE after this inventory is confirmed:** #265 (historic design document,
retain its intent/links), #270, #279, #285, #342, #353 (carried by #524 and later fixes),
and #487 (stale integration wrapper, with unique remaining work explicitly mapped below).
**No closures are performed in step 1.** Do not describe #487's missing features as merged.

**KEEP as feature/source inputs:** #355, #363, #368, #370, #371, #374, #376, #391, #392,
#393, #394, #395, #396, #397, #398. No old branch is proposed for in-place rebase/merge.
Close each remaining old draft in step 2 only with a one-line pointer to the approved
new topic PR carrying its work. The code remains accessible by the inspected commit IDs.

## Proposed order: three larger, focused topic PRs

This is a proposal awaiting Claude's inventory confirmation and the owner's selection,
not permission to begin code. Ordinary changes are grouped by topic; **the complete old
packages below cannot honestly be labelled ORDINARY as supplied**. Each contains a
separate RISKY contract. A genuinely display-only alternative can be ORDINARY only after
review confirms it needs no SQL, access or save-contract changes; that is not assumed here.

1. **P1 — Pages, one coherent Page model: RISKY, XL; plan first.** Sources #368/#370/
   #371/#374/#376 plus page copy from #487. One refreshed contract for schema/backfill,
   dashboard -> page -> widget -> series locking, inherited dashboard rights, legacy
   clients, Simple/Advanced save/replay and clone/delete/logging; include the navigation
   UI as the same Page feature, not a series of tiny standalone editor PRs. Preserve
   present v71/ratios/shell/roles behavior. New owner-issued migration slot(s), per-file
   runbooks and independently deployable steps are prerequisites. Larger PR size does
   not authorize combining unrelated risky domains or applying multiple migrations
   without the owner's explicit order. If reviewer still requires a schema-only deploy
   gap, describe and rehearse it in this one topic plan before choosing code boundaries.
2. **P2 — Chart gallery, interactions and output: RISKY, L/XL as authored; one gallery
   PR, not one per chart.** Sources #355/#363/#391-#397. Area, horizontal bar, combined,
   heatmap, scatter with confirmed pairing, declared stacked components and boxplot;
   consolidate presentation-validation changes against current v71 instead of replaying
   six old migrations. Preserve ratio units/math and scoped coverage. The old backend
   adapters depend on P1's Page query service; either keep that dependency or explicitly
   redesign against the current dashboard query in its contract. Group related UI/copy,
   keyboard/mobile controls and browser print-to-PDF from #487 here. PDF follows the
   chosen widget order; optional tables follow the visible expanded/collapsed state,
   with tables moved intact to a subsequent page when needed. Those earlier owner
   requirements are acceptance criteria, not claims that the archived print code meets them.
3. **P3 — References and Radar: RISKY if persisted/integrated, L/XL; plan first.** Source
   #398 plus #487's reference resolver/settings/snapshot/threshold files. Pure arithmetic
   contracts alone are ORDINARY but would not deliver usable Radar/targets. Agree the
   stored reference/period/units/source contract and use fresh owner-issued slots. A
   reference without confirmed applicable evidence must show a plain unavailability
   reason, not an invented number. Do not write view-relative attainment into Metrics
   Core as though it were the stored calculated-ratio value. Depends on selected Page/
   presentation/query contracts and confirmed reference inputs; no production data was
   accessed to establish their availability.

This groups 15 retained feature drafts and the missing #487 work into three topics, not
three promises of trivial merges. No hours/percent-complete estimate is supported by the
static inventory. In particular, multi-variable **Simple** tables are not already supplied
by the old editor schemas: they still have one metricRef; current Advanced multi-series
and old combined charts are not proof of that requested Simple workflow.

## Owner decisions (at most five)

1. **Order:** accept P1 Pages -> P2 full gallery/output -> P3 references/Radar, or prioritize
   the chart topic first? Recommendation: P1 first because the archived gallery backend
   depends on its Page service; avoid building a second temporary query/editor system.
2. **Gallery scope:** all seven gallery forms in one stored-contract delivery, or a
   narrower visual-only first delivery? Recommendation: the complete chosen gallery as
   one RISKY topic, with one reviewed validation design; no reused old migration IDs.
3. **References:** which confirmed target/reference sources should be usable initially?
   Recommendation: explicit manual targets and only confirmed applicable catalog/history
   evidence; everything else gets an unavailability reason. No synthetic benchmarks.
4. **Output/copy timing:** include copy-to-page in P1 and browser PDF in P2, or defer them?
   Recommendation: include them with those topics, preserving order, visibility of tables
   and role-safe output; do not add separate tiny PRs for each control.
5. **Simple multi-variable tables:** must they be in this first backlog completion?
   Recommendation: keep that new contract explicitly separate from claims about these
   22 drafts. If it outranks Radar, replace P3's priority with a focused Simple-table
   contract/delivery rather than silently adding a fourth risky topic or calling it done.

Already decided constraints are not being asked again: English UI, dashboard-inherited
page rights, owner/reviewer Page safeguards, athlete read-only/self-only direction,
current membership for the shared shell and no estimates/calculated exposure to athletes
outside the approved server policies. Reconfirm their current contract before code where
older draft defaults disagree.

## Verification and UNKNOWN

**Verified in checked-out/fetched code:** every requested head matches its fetched PR ref;
all own feature-delta filenames; stated new modules and SQL bodies; current absence or
presence of feature entry points; #524/#558 and later carrier commits; current v71 filename/
checksum pin; committed v57-v85 label meanings; all 22 read-only merge results and feature
patch applicability checks. Existing PR descriptions were used only to identify heads,
not as proof of implementation. The 22 head snapshots follow for reproducibility:

```text
#265 26162ae8f266eb24c88c601c8d4e8b9f1ca59be7 (delta base 82fbb3ca14754442dc3a7f78a92a7e6a090393a2)
#270 326d6edd09ba34959b2c69abfb2a168e22cee6df (delta base b0a839a33309324fd4ba863e77322fe27e959b9b)
#279 2317aa47019afaa5357cabfbea00ec017c1d0265 (delta base 326d6edd09ba34959b2c69abfb2a168e22cee6df)
#285 fa981c7b8b2eb73d7d515ad320b194e3d09432cf (delta base 2317aa47019afaa5357cabfbea00ec017c1d0265)
#342 fdc562222c2ffe4dc5b7c17e29234bde9bbe8901 (delta base fa981c7b8b2eb73d7d515ad320b194e3d09432cf)
#353 e1297bef9d0541e5311b81843d9a55112f892770 (delta base fdc562222c2ffe4dc5b7c17e29234bde9bbe8901)
#355 60a77aa7ef5af7cc9064e38b7979399467f7ed5e (delta base e1297bef9d0541e5311b81843d9a55112f892770)
#363 2ffd642f0abb16bbc2320c4d4db11b6b30b3579f (delta base 60a77aa7ef5af7cc9064e38b7979399467f7ed5e)
#368 d78de79dc1d5e6092bebef48660161b42852d479 (delta base 2ffd642f0abb16bbc2320c4d4db11b6b30b3579f)
#370 654707163192dd3d34089377d571706e65e060e3 (delta base d78de79dc1d5e6092bebef48660161b42852d479)
#371 fce078d20ef7d411c606cbe39231bbd755a762b3 (delta base 654707163192dd3d34089377d571706e65e060e3)
#374 f45a4351984d5df0a2c71e5108e57352a41611a1 (delta base fce078d20ef7d411c606cbe39231bbd755a762b3)
#376 3e768cf56229ebe96e0ebaedf023fa70327ef825 (delta base f45a4351984d5df0a2c71e5108e57352a41611a1)
#391 c16dcefd0d8703f8e28e66ef2baad969f8527e6e (delta base 3e768cf56229ebe96e0ebaedf023fa70327ef825)
#392 956dfdfd23d204afb17ae3138e89afe6a623a6f9 (delta base c16dcefd0d8703f8e28e66ef2baad969f8527e6e)
#393 c309933e302f7d42209ce5a4accf19f18b3490dd (delta base 956dfdfd23d204afb17ae3138e89afe6a623a6f9)
#394 8c847936751bb01575a8ac363f9f222bdc12a0fc (delta base c309933e302f7d42209ce5a4accf19f18b3490dd)
#395 e4ed718c571f7d7870377721ac4ee20ca3b912e2 (delta base 8c847936751bb01575a8ac363f9f222bdc12a0fc)
#396 36b84576431aa5a7f002ece030f19f80cfa011cd (delta base e4ed718c571f7d7870377721ac4ee20ca3b912e2)
#397 1230a6aa8e7d7012c79a56553629b08f8f6d2f6e (delta base 36b84576431aa5a7f002ece030f19f80cfa011cd)
#398 ef34dfc5dc87efc090df02dc9806365d1dd20596 (delta base 1230a6aa8e7d7012c79a56553629b08f8f6d2f6e)
#487 7ebcc6e4a38b5cbab94c418eb0b83347ea8460a9 (delta base 284a532f45ad7c45b75b36ec38913a594199fc59)
```

**UNKNOWN / not claimed:** old draft test pass rates, runtime/visual correctness, fresh-main
migration application and rollback safety, unchanged production data/revisions, deployed
schema history/configuration, live reference-data quality, current reserved migration
slots, and the engineering time required to port each topic. Old drafts' successful local
runs are not transferred to this snapshot. The current owner's precise feature priorities
remain a decision, not something inferred from a prototype.

Only documentation validation ran for this PR: git diff --check; exact 22-row/head
coverage; fetched-tree/source/SQL checks; read-only git merge-tree and git apply --check.
No application tests, browser sessions or migration execution were run for the inventory.
No production access and no existing PR was changed. Step 2 waits for both inventory
confirmation and the owner's choices; new work branches freshly from then-current main.
