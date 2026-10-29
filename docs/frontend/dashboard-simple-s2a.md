# Dashboard Simple Editor — S2a contract/model delivery

Integration base: `b0a839a33309324fd4ba863e77322fe27e959b9b`.
Specification: [S1.1 PR #265](https://github.com/predragbozic/OptiMove/pull/265), pinned
`26162ae8f266eb24c88c601c8d4e8b9f1ca59be7`. The owner authorized this separate branch
without merging or copying #265's documentation commits. That contract, rather than
an assumed copy on main, is the specification.

## Isolation and interfaces

Nothing imports these modules from `server.js`, existing routes, the existing query
engine or frontend. Existing V1/V2 and Advanced writers are unchanged. No migration,
preview/save/status endpoint, token, ledger, table evaluator, actual chart composer,
Pages persistence or UI is provided.

- `schema.js`: immutable strict descriptors and `validateContract(name,value)` /
  `validateEditorDraft(draft,{operation,complete})`. No coercion or unknown keys.
  Descriptors are used by this validator; they are not advertised as standalone
  JSON Schema documents with all cross-field checks expressible in JSON.
  Cross-field rules (date spans, bounds, operator/operand unions, priorities,
  draftRef equality) are enforced by the same module. `complete:false` permits
  missing view choices only; it never yields an executable compiled widget.
- `capabilities.js`: `createSimpleCapabilityReader({query,canManageDashboardRow,
  dataWorkspaceMatches})`. The future server adapter must pass the **existing
  server-owned DashboardAccess predicates**, a resolved server workspace, and a
  bound read-only query runner. No authorization booleans from a body, no implicit
  allow callback, no `resolveActiveWorkspace` preference fallback. Target access
  precedes catalog reads. Missing, unauthorized and workspace-mismatched targets
  all give `notFound`/404. Metric and source SQL uses target binding visibility
  before pagination, never the caller's broader catalog visibility. Built-ins come
  from their separate DB catalog with verbatim units, scope/default aggregation and
  active state; allowed aggregations follow the existing numeric vs text/boolean
  compatibility rule. Zero metric scope-capability rows mean the existing DB's
  unrestricted *explicit* scope choice, not a guessed default.
- `compiler.js`: `compileSimpleDraft(draft,snapshot,context,existing)` is a pure
  deterministic compiler, **not an authorization endpoint**. `snapshot` must come
  from the authorized capability reader; `context` and `existing` must be loaded
  and authorized by server adapters, never supplied as client claims. Context carries
  the authorized athlete set and activity/component membership, filter layers,
  concrete period and server `evaluatedAt`. The compiler repeats binding checks,
  preserves supported existing policies, and emits one widget/one DB series.
  A built-in's fixed scope/default aggregation may be proposed from DB metadata;
  an ambiguous metric scope/analytical aggregation returns `requiresChoice`.
  Stage-1 daily aggregation is never used as an invented Stage-2 default.

Compiler statuses: `valid`, `invalid`, `requiresChoice`, `advancedRequired`.
`valid` means configuration compilation only, not a successful preview or safe save.
Every successful result has `requiresPreview:true`; table bindings explicitly carry
`proof:catalogOnly` and `requiresResultSemanticProof:true`. Historical semantic and
reference compatibility requires the future actual-query metadata proof. This phase
never evaluates thresholds or returns measured/derived annotations.

`chartPlan` specifies the approved presentation contract only: athlete series for
day/week, athlete categories for athlete grouping, `noObservation` gaps, limit 20
**athletes, not data rows**. More athletes return `requiresChoice`; Table retains
all authorized athletes within contract bounds. No raw rows or ECharts options are
built or changed. Preserved V1 blobs retain extra fields; unrepresentable existing
configurations require Advanced instead of destructive normalization. Unknown sidecar
versions remain opaque and cannot be semantically rewritten through Simple.

## DB rule coverage inventory — unit coverage is not DB parity

The following is the S2a refusal inventory against current v15/v16/v17/v18 rules.
No production SQL file or schema is changed. The DB constraints and triggers remain
the authoritative final write protection.

| Existing rule family | Isolated S2a coverage | Real PostgreSQL parity in this delivery |
|---|---|---|
| Metric/source target visibility and active state | SQL target predicates; negative compiler/reader cases | Not executed |
| Built-in fixed scope, source `not_applicable`, null unit | Catalog fixtures, schema/compiler checks | Not executed |
| Scope capabilities (including zero rows) | Compiler boundary tests, picker SQL | Not executed |
| Value type vs analytical aggregation | Numeric vs text/boolean negative cases | Not executed |
| Source connection/policy pairing, role/coverage enums | Preserved-series negative cases | Not executed |
| Comparison support, axis enums | Preserved-series/type negatives | Not executed |
| Single metric/built-in reference and resolved status | Strict unions; exactly one compiled series; unresolved/multi-series => Advanced | Not executed |
| Series cap/shared-axis unit consistency | Structurally one Simple series; multi-series => Advanced; table unit matching | Not executed; cross-series DB cases need existing Advanced regression |
| Archive/template/workspace parent guards | Capability reader negatives before catalog access | Not executed |
| Filter athlete/activity/component membership | Authorized server context, negative membership/parent cases | Not executed |
| Presentation and rule shape/unit compatibility | Strict contracts and constant/reference capability negatives | No DB sidecar backstop exists yet; belongs to S2c |
| Retained widget size on type change | Destination catalog min/max width/height checks; incompatible size => invalid without resizing | Not executed; narrow unit cases added |
| Layout/order overlap, ownership immutability, write locks, revisions | No writer/layout mutation exists in S2a | Existing DB regression required before integration; not claimed by unit tests |

Full real parity must cover non-racing valid/invalid create **and** update, known
constraint rejection => stable code/path mapping, and race revalidation in the later
write adapter. S2a's mock query tests prove parameter construction/order and service
control flow, not SQL execution, DB authorization or concurrency. Future S2b/S2c
must not treat them as substitute parity evidence.

## Executed validation and limits

Results are recorded in the Draft PR and final delivery report. New unit/contract
tests run without `DATABASE_URL`. Frontend regression covers the unchanged Display
Model, view, ECharts and Advanced/editor suites.

The backend unit regression exposed `builder-tree-batch.test.mjs` test
“large copies chunk inserts without losing parent mapping or exercise doses”:
`batch must stay below PostgreSQL parameter limits`. The identical failure was
reproduced on a fresh detached worktree at the approved base; no Builder fix or test
manifest waiver is included.

Real DB parity and the existing disposable Dashboard API suite could not run:
`DATABASE_URL` is unset; no local PostgreSQL binaries/server or Docker are available.
The repository runner refused the disposable suite before opening a database.
Installing PostgreSQL through the available package manager failed on container
setuid/setgroups permissions; no permission escalation or production service was used.
No DB test is silently marked successful or skipped as proof. Shared persistent-db
tests were not run because no such write was authorized.

**Integration status: BLOCKED on actual disposable DB/API parity evidence and the
requested technical/security review.** The isolated code can be reviewed in Draft;
this does not authorize connecting production routes, S2b/S2c, migration, merge or
deployment. No departure from pinned S1.1 is intentionally introduced. The future
adapter's mandatory trusted input boundary and database proof are explicit limitations,
not new product behavior or relaxed authorization.

### Commands and measured results

- `node scripts/test-runner.mjs --project backend --kind unit --file dashboard-simple-contract.test.mjs --file dashboard-simple-compiler.test.mjs --file dashboard-simple-capabilities.test.mjs`: **114 pass, 0 fail** (79 contract, 25 compiler, 10 capabilities).
- `node scripts/test-runner.mjs --preset backend-fast`: **476 pass, 1 fail** on the final implementation; failure is the Builder baseline signature above. No baseline waiver was added.
- Baseline `node scripts/test-runner.mjs --project backend --kind unit --file builder-tree-batch.test.mjs` at base `b0a839a`: **10 pass, 1 fail**, same test/fingerprint. Temporary baseline worktree removed.
- `node scripts/test-runner.mjs --project frontend --file training-load-analysis-display-model.test.mjs --file training-load-analysis-display-view.test.mjs --file training-load-analysis-echarts.test.mjs --file training-load-dashboards-editor.actions.test.mjs --file training-load-dashboards.actions.test.mjs --file training-load-dashboards-h4.actions.test.mjs --file training-load-dashboards-ux.actions.test.mjs`: **164 pass, 0 fail**. An initial attempt lacked jsdom; after installing existing locked frontend dependencies all seven suites passed.
- `node scripts/test-runner.mjs --project backend --kind disposable --file training-load-dashboard.test.mjs`: **REFUSED before DB connection**, `DATABASE_URL is not set`. Zero DB tests executed; no migrations applied.
- `git diff --check`: clean. No existing production file/route, dependency declaration, migration or original S1.1 document is modified.

Internal static code/security review completed. The one MEDIUM finding (missing server evaluatedAt escaping the relative compiler as an exception) was corrected to stable invalid/serverTimeRequired with a focused regression; narrow re-review follows on that delta. No actionable security finding was raised. This does not replace the owner-requested external technical/security review or missing DB parity evidence.

### Arendt correction delta against `4b46ca8`

Three confirmed findings received narrow corrections against the pinned S1.1 contract:

- Retained width/height are checked against the destination widget type's loaded
  `min_width`, `max_width`, `min_height`, `max_height`; incompatible dimensions return
  `invalid` / `widgetSizeBounds` at `$.view.type` without changing layout. Missing or
  invalid bounds for retained dimensions return `invalidCatalogMetadata`. The v18
  seed defines KPI 2–4 × 2–3, Table 3–12 × 3–12 and charts 3–12 × 3–8; the v16
  `dashboard_widgets_validate_layout` trigger enforces destination bounds on type
  updates. Fixtures now carry these real bounds. Boundary, incompatible-size,
  loaded-catalog and input-preservation cases were added.
- Authorized component-only filters accept absent or explicitly cleared effective
  activity. Parent equality is required only when an effective activity is selected,
  matching `buildRangeContext`; conflicting selected or inherited activity still
  fails without reparenting. Added absent/clear, filter-layer and authorization cases.
- Time-zone validation explicitly rejects signed offset identifiers even on Node 24,
  whose Intl implementation accepts them. Named zones, UTC and named `Etc/GMT+1`
  remain supported. Added fixed/relative, context, draft and envelope regressions.

The coordinator executed the corrected S2a suites on Windows / Node v24.12.0:
**119 pass, 0 fail** (80 contract, 29 compiler, 10 capabilities). The backend unit
regression produced **481 pass, 1 baseline fail** with the same Builder assertion;
the approved-base reproduction produced 10 pass and that same 1 fail. The unchanged
seven frontend regression suites passed **164/164** on the pinned original HEAD.
These results supplement, rather than replace, the original delivery measurements
above. The disposable Dashboard suite again refused before connection because
`DATABASE_URL` is unset. This host has PostgreSQL binaries, but no isolated test
connection was configured; no environment settings were changed. No DB parity,
DB access or S2b/S2c work was performed. The independent reviewer closed all three
findings after 93 additional focused in-memory cases: 21 layout, 48 component,
24 timezone. No residual issue was found within the correction delta. This narrow
recheck does not establish actual SQL, DB/API or concurrency parity.
