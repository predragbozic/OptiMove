# Dashboard shell Club / Team / Athletes filter plan

Status: approved plan, 2026-11-20; implementation includes the three independent-review LOW additions below.
Review regime: **two-star (access / cross-workspace)**. Both Claude and the independent
reviewer must approve before implementation. Inspected base:
`66cae9fc9265e314eb9704e8c317bd3726e8db54`. #648 and its branch remain untouched.
This PR changes this document only. **No migration is expected.** Existing membership,
workspace and dashboard schema suffice. No implementation, production operation, merge
or deploy is authorized by this plan.

## 1. Verified existing behavior

- `backend/src/routes/trainingLoadDashboard.js`, QUERY_DASHBOARD_KEYS and POST
  `/api/training-load/dashboards/:dashboardId/query`: runtime athlete/activity/component
  filters; absent top-level athleteIds inherits, null/[] clears, a list overrides.
- `backend/src/routes/trainingLoad.js`, athleteExtraFilterSql and weekly/calendar:
  clubs OR teams OR individual athletes, AND mandatory active-workspace athlete scope.
  No individual existence/visibility rejection for a foreign or stale shell ID.
- `backend/src/trainingLoadDashboardAccess.js`: request-memoized active workspace,
  dashboard visibility and dataWorkspaceMatches (ADR-002).
- `backend/src/trainingLoadDashboardQuery.js`: mergeFilters, canonical context construction,
  widget overrides, built-in and metric branches, request-local caches.
- `frontend/training-load-analysis-data.js`: analysisRuntimeFilterPayload(), queryContextKey(),
  generation/context checks; `training-load-data.js`: shared state.trainingLoad.filter.
- `backend/src/dashboardSimple/schema.js`, contextSchema/runtimeFilterSchema/envelopeSchema;
  previewService.js, previewContext.js and previewBinding.js: preview contracts/binding.
- `docs/ai/CURRENT_STATE.md`, Open risks "Dashboards ignores the shell
  Club/Team/Athletes filter"; ADR-002 and ADR-006.

The shell control is disabled on Dashboards today. An empty internal athleteIds array
currently means unrestricted: it cannot represent a resolved, constrained-empty cohort.

## 2. Request contract: a separate shellFilter

POST /query adds one optional top-level field; existing fields keep their exact meanings:

```json
{
  "dateFrom": "2026-11-01",
  "dateTo": "2026-11-07",
  "athleteIds": null,
  "shellFilter": { "clubIds": ["<club UUID>"], "teamIds": [], "athleteIds": [] },
  "activityId": null,
  "componentId": null
}
```

Top-level athleteIds retains today's exact inherit/clear/override behavior. It never
changes meaning based on the presence or values of another field. shellFilter is a
separate additional constraint; it never enters the legacy mergeFilters precedence.

- shellFilter absent or null means no shell restriction (including old clients).
- A present object has exactly clubIds/teamIds/athleteIds, arrays of UUIDs, with a combined maximum of
  200 raw entries across all three lists (count before deduplication). Require all three arrays; allow empty arrays. Reject unknown keys inside
  the object just as unknown top-level keys are rejected. Invalid object/list/UUID syntax,
  null lists, missing lists or oversize lists return 400 invalidRequest, without ID
  existence lookups. Normalize UUID case and deduplicate after validation.
- A present object means a hard narrowing constraint: union within each kind and OR
  across kinds, then AND with workspace scope and every widget's effective saved/runtime
  filters. A widget override cannot escape it. Activity/component remain separate AND
  constraints, never terms in the union. Do not change or persist default/widget filters.
- Preserve constrained-empty explicitly. A present all-empty object has an empty union
  and yields no athletes. Clearing the UI's shared selection therefore serializes
  shellFilter:null, not an all-empty constrained object. This matches weekly/calendar's
  no-filter UI state while giving an explicit empty object an unambiguous API meaning.
  Nonempty selections whose resolved union is empty also return no rows, never all.

The client sends selected IDs only. Server expansion uses parameterized membership
predicates with athleteExtraFilterSql's union semantics, not a client-expanded roster.
Resolve once per request and reuse across widgets; no per-ID or per-widget N+1 queries.
Represent the result as a scoped predicate or `{ constrained, athleteIds }`, so
constrained+[] cannot collapse into the legacy unrestricted empty athlete list.

## 3. Access, weekly parity and info-hiding

Resolve the caller's active workspace once with the existing request-memoized dashboard
resolver. No role_hint, body-supplied workspace, or unrelated role held by the account.
A platform-admin account active in a club workspace has that workspace's scope.

Keep three independent gates: (1) dashboard visibility/owner permission; (2) the
dashboard's bound data_workspace matching the active workspace (ADR-002); (3) the final
shell cohort constrained to that workspace's authorized athletes. Gate 3 is set scoping,
**not** individual shell-ID authorization/existence lookups. Existing canonical fact,
source and metric access checks remain independently enforced.

For staff organizational scopes, the shell cohort is (selected-club members OR
selected-team members OR direct athlete IDs) AND the existing active-workspace athlete
scope; private_coach and athlete workspaces give organizational selections no members,
private coaches retain active own ties, and athlete workspaces remain pinned to self.
A disallowed kind contributes nobody; it does not invalidate another allowed term in
the union. No new organizational visibility is granted by having an athlete in a club.
This replaces the earlier per-kind access matrix and strict-rejection proposal.

A well-formed foreign, missing or stale ID contributes nobody. No separate existence or
visibility query and no filter-specific 404/403. An otherwise authorized query returns
the ordinary 200 query envelope: an empty result if the union resolves to nobody, or the
same remaining permitted cohort if mixed with valid terms. It never echoes which term
was unknown/foreign/stale, any entity name, or per-ID rejection counts. Foreign and
nonexistent selection probes must have identical response bytes/status/application
headers under otherwise identical fixtures; ignore only transport Date/request IDs.
No timing-side-channel guarantee is claimed.

Existing dashboard authentication/access errors stay as they are: missing session uses
the router's authentication response; missing/inaccessible dashboard follows ADR-006;
data-workspace mismatch retains its existing notFound response. Do not turn a harmless
stale shared selection into "dashboard not found", and do not align unrelated legacy
404 message differences in this slice.

No concrete data leak was found that the former strict per-ID rejection prevents while
this scoped-set approach allows. It is the final workspace intersection, not evidence
that a submitted ID exists, that protects data. Rejected syntax remains 400; unavailable
IDs never widen the result. The UI uses the ordinary "No data for this selection." state,
without auto-dropping terms and rerunning a broader query.

## 4. Membership in time (decided)

Keep weekly's **current active membership**, not membership at each activity's date:
public.athlete_memberships status='active' plus membership_type club/team; private coaches
use active public.user_athletes ties. The predicates contain no event-date interval join.
Membership changes may therefore change a later query of a historical period. Plan
ownership snapshots and historical metric ownership are not membership evidence; their
existing authorization remains unchanged.

`public.athlete_membership_periods` already exists (v25). **Event-time membership** is a
named follow-up using that history, not part of this slice and not a reason for a new
migration here. Comparisons use the same current selection on both periods.

## 5. Simple preview parity: included in this slice

Verified on the inspected base: POST
`/api/training-load/dashboards/:dashboardId/simple/preview` does **not** accept
shellFilter today (runtime.js SIMPLE_RUNTIME_PATH + previewRouter.js).
schema.js uses additionalProperties:false; runtimeFilterSchema accepts only athleteIds,
activityId, componentId, and contextSchema has no shellFilter. previewService queries with
compiled.effectiveFilter, while previewBinding fingerprints the existing context/filter.
Sending the proposed field today would fail validation; dashboard-only wiring is not enough.

Add context.shellFilter to the existing Simple legacyDashboard preview context as the
same optional nullable object defined in section 2, with identical strict nested schema,
normalization, union/workspace intersection and constrained-empty semantics. It is a
sibling of context.runtimeFilter, not another meaning for runtimeFilter.athleteIds.
Do not implement or activate the dormant page context/D2 contract in this slice.

The frontend captures the same shared selection for query and preview. The server applies
it after compiled draft/default/runtime/widget athlete filters, before query arithmetic,
and before chart-athlete-count decisions. Retain the existing 65536-byte Simple request
limit in addition to per-list limits; adding shellFilter does not widen parser/admission limits. Preview and saved-widget queries for the same
metric/config/period/viewer/selection must use the same cohort, including built-ins,
ratio coverage, empty groups and self scope. Use one shared scope implementation.

Include normalized shellFilter and the resolved authorized cohort/context in preview
fingerprints/token binding. Save must revalidate against its existing active-workspace
and preview binding, so changing the selection or effective membership cannot reuse an
older preview as though it represented the new scope. Reuse the current plain-language
preview-again flow on mismatch. Changing shellFilter invalidates outstanding frontend
preview state. Preserve receipt replay semantics; do not add persistence, store a shell
selection as widget configuration, or modify the atomic database save function. Test
preview/save/replay boundaries explicitly before claiming parity.

## 6. Frontend and cache behavior

state.trainingLoad.filter feeds a normalized shellFilter via analysisRuntimeFilterPayload().
Keep existing runtime top-level athleteIds/activityId/componentId intact. Reuse the same
selection serializer for Simple's context.shellFilter; do not copy shell athletes into
legacy runtime athleteIds and never expand club/team members on the client.

Re-enable the Dashboards control and remove its disabled-only note. Reuse the shared
picker/apply/clear interactions; applying triggers dashboard query invalidation/refetch,
not merely weekly/calendar loading. No request per widget. Clear maps to null as above.
Do not alter shell state or cohort semantics when navigating between Overview, Activities,
Athletes and Dashboards.

queryContextKey() includes canonical shellFilter (or null), existing user/workspace,
dashboard/revision, widget revisions, period and legacy runtime constraints. Sort copied
normalized arrays without mutating state; click order does not change meaning. Payload
and cache signature come from the same snapshot. A selection/workspace change clears old
rendered results and advances generation before requesting the new result. Keep both
generation and context checks; a late A response cannot repaint B. A cached B result is
reusable only for B's complete authorized context. Server request-local canonical/ratio
cache keys include scoped selection and its empty distinction. No persistent expansion
cache or new real-time membership subscription; use normal membership invalidation.

## 7. Ratios and built-ins

Integrate the accepted outcome of #648 later, without changing its frozen branch. Filter
before canonical context/seeds and pooling, not after aggregates return. Apply identically
to measured variables, calculated sums/differences and built-ins (including session count
and last session). Ratios include exact paired inputs only from selected authorized
occasions, with independent included/left-out coverage using the same scope, including
omitted buckets. Preserve real conflicts, formula-change errors, estimates/source rules
and athlete exclusion of calculated metrics. Keep groupBy and all other ratio cache
keys. Constrained-empty has no values, never an all-athlete cohort; zero remains a value.
No aggregation, axis or unit redesign.

## 8. Tests and exact planned commands

Use real mounted routes and disposable databases on Node 22. Fixtures cover platform,
club, team, private_coach and athlete workspaces, multiple roles on one account, dual
memberships, membership transfers, private ties and self. No production fixtures.

- Each workspace type: own/valid selections, foreign/missing/stale club, team and athlete
  IDs, individually and mixed with valid terms. Foreign/missing paired probes must have
  byte-identical envelopes/status/application headers and never widen the cohort. On
  platform, a visible existing ID may legitimately match; test missing IDs and proper
  results rather than inventing a foreign platform boundary.
- Exercise dashboard visibility and data-workspace match independently. Mutation per
  independent gate, final workspace intersection (including platform-admin active
  elsewhere), private/self group exclusion and athlete-self pinning. Remove each gate:
  its relevant test must fail. No per-ID rejection/check mutation exists anymore.
- Mutate union OR to AND, remove shell hard intersection with widget/default filters,
  or collapse constrained-empty to unrestricted: each must fail. Dedup union terms,
  authorized empty groups, null/absent/all-empty object, unknown nested keys, syntax,
  required arrays and max lengths; legacy athleteIds inherit/null/[]/override unchanged.
- Membership changes affect old periods by today's active rule; no event-time join.
  Private/self group-only selection has no rows; adding permitted direct athletes
  returns only those, with self pin intact. Activity/component constraints remain ANDed.
- Two widgets cannot override shell; built-ins and ratios share cohort/coverage,
  comparisons and cache isolation. No calculated metrics become visible to athletes.
- Preview and saved query parity; shell change invalidates preview/token; stale membership
  binding prompts re-preview; replay remains idempotent and saves no shell configuration.
- Frontend: exact separate payload, no expanded roster, no overloaded athleteIds; null
  clear; cache-key changes for each kind; canonical order; A/B/A and workspace switching;
  delayed A after B; Simple payload/binding context. Normal no-data state for zero cohort.
- Real browser: apply club+team+athlete, clear, switch filters during a delayed response,
  navigate between shared-filter views, and verify permitted athletes/built-ins/metric
  results with no stale repaint. Check existing picker at 390 and 1280 px.
- **If a SQL helper is extracted, weekly/calendar output unchanged is an explicit
  regression test:** the same fixtures and selections produce identical cohorts and
  response content before/after extraction (including foreign/stale terms and no-filter).
  No change to those endpoints' athlete-special-case behavior.

Use the runner's exact --file selection, not an unverified --filter shortcut. Proposed
new files dashboard-shell-filter-disposable.test.mjs and dashboard-shell-preview.test.mjs
will be registered with actual DB requirements (never labelled mock/unit to avoid DB):

```text
node scripts/test-runner.mjs --project backend --file dashboard-shell-filter-disposable.test.mjs
node scripts/test-runner.mjs --project backend --file dashboard-shell-preview.test.mjs
node scripts/test-runner.mjs --project backend --file training-load-dashboard.test.mjs
node scripts/test-runner.mjs --project backend --file training-load-calendar.test.mjs
node scripts/test-runner.mjs --project frontend --file training-load-dashboards.actions.test.mjs
node scripts/test-runner.mjs --project frontend --file training-load-simple-actions.test.mjs
node scripts/test-runner.mjs --preset backend-fast
node scripts/test-runner.mjs --preset frontend-fast
node scripts/test-runner.mjs --preset e2e
npm --prefix frontend run build
```

--project/--file and backend-fast/frontend-fast/e2e are verified in scripts/test-runner.mjs
(selectFiles and PRESETS). New test filenames are planned, not present or claimed run.
Use --list to verify exact selection after creating them; list and run any additional
identified weekly/calendar fixture file by its exact name if extraction touches its path.
Report exact frozen head, Node/Postgres/browser versions, commands/counts, baseline
comparisons for failures, mutations and omissions in the implementation PR. No application
tests ran for this docs-only revision; check document and one-file diff only.

## 9. Expected implementation files and exclusions

Expected backend: routes/trainingLoadDashboard.js; a shared dashboard shell-cohort helper;
trainingLoadDashboardQuery.js (canonical context boundary/caches); dashboardSimple/schema.js,
previewContext.js, previewService.js, previewBinding.js and saveService.js binding plumbing
as needed. Keep the shell outside compiler's persisted widget semantics; compiler context
may need the resolved cohort for chart limits. If extracted, shared pure SQL helper plus
routes/trainingLoad.js with unchanged weekly/calendar behavior. New disposable tests and
relevant Simple contract/binding tests; test-manifest entry reflects actual DB use.

Expected frontend: training-load-analysis-data.js, training-load-actions.js,
training-load-view.js, training-load-simple-actions.js and Simple controller/data payload
plumbing as needed; payload/cache/action tests; e2e/tests/dashboard-simple.test.mjs or a
focused shell-filter file. Confirm exact files in implementation packet, avoid a second
query engine and no new persistent membership cache.

Out of scope: D2/pages/v75, mapping writer/calculatedValues.js, GPS/import code,
migrations, authorization redesign, per-page rights, event-time membership implementation,
unrelated weekly/calendar output changes, athlete builder UX and production configuration.
If a schema/shared-access-rule change is discovered, return to both reviewers before code.

## 10. Decisions and remaining questions

**Taken by reviewer, not questions for the owner again:** separate shellFilter;
legacy athleteIds unchanged; shell hard intersection with saved/default/widget filters;
weekly scoped-union parity rather than per-ID rejection; private/self organizational
terms contribute nobody; self pin; current active membership; Simple preview parity
(included above). Empty cohort shows normal no-data UI, not dashboard-not-found.

No new owner decision is required for those points, and no concrete leak justifying strict
per-ID rejection was identified. Remaining work is review confirmation of this written
preview/token contract and explicit constrained-empty serialization. Recommendation:
accept absent/null as clear and a present empty union as zero cohort; retain current
preview-again behavior for a changed binding. These are reviewer contract confirmations,
not permission to begin implementation. Code waits for both reviews to pass.

## 11. Implementation review additions (approved owner direction)

- LOW-1: the resolved shell cohort is ONLY additional narrowing of the dashboard's
  existing data_workspace fact set. It is never a SOURCE of athletes/facts and never
  replaces the existing activity/day/source authorization. Kill the mutation that uses
  a weekly cohort as the source instead of intersecting the dashboard query, including a
  platform admin active in club X selecting an athlete only in club Y: no Y rows.
- LOW-2: kill omission of shellFilter from preview binding (a shell change invalidates
  the preview/token), and kill writing shell into effectiveFilter/default_filter on save
  (saved widget/series configuration byte-identical with/without shell selection).
- LOW-3: replace section 2's per-kind 500 limit with ONE combined raw-entry limit of
  **200 IDs total**, across clubIds/teamIds/athleteIds, on query AND preview/save context.
  Above 200 returns 400 invalidRequest on both; count before deduplication. Keep the
  separate 65536-byte Simple envelope/parser limit; the filter does not raise it.
- LOW-5 from #648: a stored ratio excluded by coverage/source while an input remains
  eligible counts as left-out, never a value. Kill ratioValueAllowed:true.

Implementation base: e087d209725c1efdc0e8078f1754f55396785c89 (#648 merged).
