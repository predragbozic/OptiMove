# Dashboard shell Club / Team / Athletes filter plan

Status: proposal only, 2026-11-20. Review regime: **two-star (access / cross-workspace)**.
Both the independent reviewer and Claude must approve this contract before code.
Base inspected: `66cae9fc9265e314eb9704e8c317bd3726e8db54`. PR #648 remains frozen
and untouched; integrate its accepted ratio code only after its review outcome is known.
This PR contains this document only. **No migration is expected:** membership and dashboard
scope already exist; this adds request validation, scoped selection and query/cache wiring.
No production reads, writes, activation, merge or deploy are part of this task.

## 1. Existing behavior and invariants

Sources inspected:

- `docs/ai/CURRENT_STATE.md`, Open risks, "Dashboards ignores the shell Club/Team/Athletes filter".
- `backend/src/routes/trainingLoad.js`: `coachWorkspaceScopeSqlForWorkspace`,
  `athleteExtraFilterSql`, GET `/weekly` and `/calendar`.
- `backend/src/routes/trainingLoadDashboard.js`: `QUERY_DASHBOARD_KEYS`, POST
  `/api/training-load/dashboards/:dashboardId/query`.
- `backend/src/trainingLoadDashboardAccess.js`: request-memoized active workspace,
  `dataWorkspaceMatches`, dashboard view/manage checks.
- `backend/src/trainingLoadDashboardQuery.js`: `mergeFilters`, `queryDashboard`,
  canonical contexts, request-local caches and built-in/metric branches.
- `frontend/training-load-analysis-data.js`: `analysisRuntimeFilterPayload`,
  `queryContextKey`, query generation/context checks; `training-load-data.js` shell filter.
- ADR-002 (ownership and data scope are separate) and ADR-006 (info-hiding).

Today the query accepts runtime athlete/activity/component filters. Absent runtime fields
inherit defaults; explicit null/[] clears the existing athlete restriction. Widget filters
have their own precedence. An empty internal athlete list currently means unrestricted,
not "match nobody". The shell control is disabled on Dashboards, so simply enabling it or
sending a client-expanded roster would be incorrect.

## 2. Proposed request contract

Add top-level `clubIds` and `teamIds` alongside `athleteIds` to the existing POST /query.
Each is null or an array of UUIDs, maximum 500 entries per kind (same athlete limit);
validate shape before use, normalize UUID case, deduplicate. Invalid syntax/oversize gives
400 `invalidRequest`, without an existence lookup. Dates, widgetIds, activityId and
componentId keep their existing validation. Authentication remains unchanged.

The new frontend always sends **all three arrays**, including empty arrays. Example:

```json
{"dateFrom":"2026-11-01","dateTo":"2026-11-07",
 "clubIds":["<club UUID>"],"teamIds":[],"athleteIds":["<athlete UUID>"],
 "activityId":null,"componentId":null}
```

For a shell request, selected clubs' active member athletes OR selected teams' active
member athletes OR explicitly selected athletes form one union. Deduplicate athletes;
never intersect the three kinds. An athlete selected directly and through two groups
contributes once. All-empty/null arrays mean no extra shell restriction. A selected,
authorized group with zero eligible members means **zero athletes**, never unrestricted.

Expansion is entirely server-side, using parameterized EXISTS/union predicates with the
same `athleteExtraFilterSql` semantics, inside the mandatory active-workspace scope.
The client sends selection IDs, never an expanded roster as authority. Prefer a small
shared pure SQL-fragment helper over importing a router or duplicating the weekly rule;
if extracted, preserve weekly/calendar output and test them unchanged. No N+1 membership
queries or per-widget roster fetches; resolve once per request, then reuse.

### Saved filters and compatibility (decision requested)

Recommendation: the shell is an additional **hard narrowing constraint** on every widget,
not a mutation of stored dashboard/widget/default filters. Existing effective saved
athlete/activity/component selection stays intact, then the shell union is ANDed with it
and with workspace scope. Widget overrides cannot escape the shell. Activity/component
are separate runtime constraints, not terms in the club/team/athlete union.

Avoid giving athleteIds two meanings in one request: presence of clubIds or teamIds marks
the new shell contract; in that mode all three lists belong only to the shell union and
must not also feed the legacy athlete override (which would turn club OR athlete into
club AND athlete). Old callers with neither new property retain existing athleteIds
inherit/clear/override behavior. New frontend always sends both new properties, even [].
This compatibility discriminator is explicit, not based on non-empty values. Do not
silently overwrite a nonempty legacy runtime athlete selection with shell athletes:
review whether any caller still needs both, and agree a distinct additional runtime
field before implementation if it does. Do not repurpose persisted filter JSON.

Represent resolved selection as `{ constrained, athleteIds }` or a scoped SQL predicate,
so constrained+[] cannot normalize to "all" in queryDashboard/context/cache code.
Missing selections mean no added constraint; an authorized empty selection result stays
constrained for built-ins, metrics, ratios and comparisons alike.

## 3. Access and info-hiding

Resolve the active workspace once via the dashboard request-memoized resolver; reuse it
for dashboard access, selection validation and expansion. Do not use role_hint, all roles
held by the account, or a workspace supplied in the body. A platform administrator active
in a club/team/private workspace has that workspace's boundaries, not platform scope.

Keep three independent gates: dashboard visibility/owner permission; dashboard's bound
data workspace matching the active workspace (ADR-002); every submitted selection ID
being visible/selectable in that active workspace. A filter cannot grant either of the
first two. Existing canonical fact authorization remains in force after selection.

Proposed selectable-entity matrix (review/owner confirmation required for private/self):

| Active workspace | Clubs | Teams | Individual athletes |
| --- | --- | --- | --- |
| platform | existing clubs visible under current platform predicates | existing visible teams | existing visible athletes |
| club | own club | teams belonging to own club under existing visibility predicates | active members of own club |
| team | own team's parent club only | own team | active members of own team |
| private_coach | none | none | own active public.user_athletes ties |
| athlete | none | none | authenticated athlete only |

Accepting a team's parent club never exposes sibling teams' athletes: expansion is still
ANDed with own-team scope. Private/self workspaces must not acquire organizational
visibility just because one of their athletes belongs to a club. Use existing shared
visibility predicates/relations, not dashboard manage rights as a substitute for entity
read rights; align picker eligibility with this matrix. Disabled/archived entities follow
the existing entity visibility rule, not a new bypass. An authorized group may be empty.

Reject the **entire query**, before any widget calculation, if even one well-formed ID
is missing or outside scope (including one hidden ID among valid IDs). For these failures
use exactly `404 {"error":"notFound"}`; no message, kind, index, ID, name, missing count,
partial result or per-widget distinction. Foreign and nonexistent IDs get identical
status, body bytes and application headers (ignore only transport-generated Date/request
IDs in comparisons). No 403 or existence-dependent custom header. Never return which ID
failed, and never partially execute valid selections. Do not promise timing side-channel
elimination, but avoid an unrestricted existence probe before a permission lookup.

This adds a strict ID-validation rule for dashboards; weekly's union predicate alone
currently does not prove each submitted group's visibility, and weekly's athlete branch
ignores the shell params. Keep weekly unchanged. Dashboard athlete requests validate any
submitted IDs and remain pinned to self; do not expand athlete access or calculated
variable access. Missing session keeps the router's existing authentication response.
Do not normalize unrelated pre-existing dashboard 404 message differences in this slice.

## 4. Membership in time

Keep **current active membership**, as weekly uses: public.athlete_memberships with
status='active' and matching membership_type club/team; private coaches use active
public.user_athletes ties. These predicates have no per-activity date interval join.
This is current query-time membership, not membership on each event's date. Changing
membership can therefore change which historical activity rows pass a later query.
Do not use plan ownership snapshots to infer membership or reinterpret historical metric
ownership. Existing fact/workspace/source authorization still decides which facts may
be read for those athletes. Historical membership reporting is a separate product/schema
question, not an implicit change here.

## 5. Frontend and caches

Feed state.trainingLoad.filter into analysisRuntimeFilterPayload() explicitly. Serialize
normalized clubIds/teamIds/athleteIds from the shell and the existing runtime
activityId/componentId; never derive group athletes from a locally loaded roster.
Inspect all callers, including Simple preview actions, so none accidentally combines the
legacy athlete list with the new union or claims preview equals a differently scoped
saved result. If Simple's separate preview endpoint cannot accept the same scope, propose
that endpoint change for review before code; do not silently show an unfiltered preview.
The runtime shell selection is not saved into widget config. Any preview-token scope binding
must follow the approved preview/save contract; it must not turn a temporary view filter
into saved athlete configuration.

Re-enable the existing control on Dashboards and remove its disabled-only note. Reuse
existing selection/apply/clear interactions and invoke dashboard query invalidation/refetch
instead of only weekly/calendar loading. Do not fetch once per widget. Keep legitimate
no-data and authorization-error states distinct: no empty-result fallback to all athletes.

queryContextKey() must include a deterministic signature of all three normalized ID sets,
plus existing user/workspace, dashboard/revision, widget revisions, period and runtime
activity/component. Sort copied arrays, never mutate state; equivalent selections in a
different click order have the same key. The query payload and key use the same snapshot.
On apply/clear or workspace change, clear old rendered results and invalidate/increment
the generation before starting the next request. Retain both generation and context-key
checks so a late A response cannot repaint B. No stale-while-revalidate display from a
different selection. A hit for B may only reuse B's authorized-context result.

Server request-local canonical-context and ratio caches include the resolved shell scope
and its constrained/empty distinction, in addition to existing filters. No persistent
membership-expansion cache is introduced. Requery after normal membership invalidation;
no new real-time membership subscription is promised.

## 6. Ratios and built-ins

Coordinate with the accepted outcome of #648 without changing its frozen branch. Apply
selection before canonical facts/seeds and coverage, identically for measured variables,
calculated sums/differences, and all built-ins (including session count/last session).
No client-side filtering after pooling. A ratio pools exact paired inputs only for selected
authorized athletes/occasions; independent included/left-out coverage must use the same
scope, including omitted buckets. Preserve real conflicts, formula-change errors,
source/estimate policies and athlete exclusion of calculated variables. For comparisons,
use the same current-membership selection on both periods (not historical membership).
Retain groupBy and all other #648 cache-key dimensions. Empty selection yields no values,
not a cohort-wide aggregate; zero remains a real value. No aggregation/axis/unit change.

## 7. Planned tests and acceptance evidence

Use the repository runner on Node 22, real routes and fresh disposable databases. Create
fixtures for all five workspace types, multiple roles on one account, own/foreign clubs
and teams, directly selected athletes, dual memberships, private ties and a self profile.
No production fixtures or persistent database writes.

- For **each workspace type and each ID kind**, test allowed (where the matrix permits),
  foreign and nonexistent UUIDs. For matrix cells allowing none, both existing organizational
  IDs and missing IDs must give the same 404. Include platform missing IDs, platform-admin
  account active elsewhere, inactive memberships and valid+hidden mixed lists.
- Compare foreign vs missing response bytes/status/application headers for each kind;
  prove dashboard ownership permission and data-workspace match independently. Missing
  session follows existing 401. Assert rejected selections never invoke query arithmetic.
- Mutation per club, team and athlete visibility check; per active-workspace scope and
  dataWorkspaceMatches/owner gate. Removing any must fail its relevant fixture; no
  surviving bypass mutation accepted. Also mutate union OR to AND, remove final workspace
  intersection, and normalize constrained-empty to unrestricted; all must be killed.
- Union across and within kinds, deduplication, own empty team, all-empty shell, malformed
  lists, limits, absent/null/[] legacy inheritance, stored widget filters vs shell,
  activity/component constraints, and old clients with no new fields.
- Membership transfer/deactivation: query an old period before/after a current membership
  change, prove weekly's rule is retained. Include team-parent-club and private-coach ties.
- Two widgets with differing overrides cannot escape shell; source/unit conflicts remain
  visible. Built-ins and ratio pooled arithmetic/coverage/comparison/cache isolation use
  the same scoped athletes; athlete workspace never gains calculated metrics.
- Frontend unit/action tests inspect exact raw selection payload, all-empty clearing,
  canonicalized cache signatures for each of club/team/athlete changes, A-to-B-to-A cache
  hits, workspace changes and late A response after B. Assert no client-expanded roster.
- One real browser scenario: platform pilot selects club+team+athlete on Dashboards,
  applies and clears, sees an excluded athlete disappear/reappear across built-in and
  metric widgets, and switches filters during a delayed response without a stale repaint.
  Check the existing picker at 390 and 1280 px; no clipped/dead filter controls.

Planned commands (results supplied only by the later implementation PR):
`node scripts/test-runner.mjs --project backend --filter dashboard`, targeted new disposable
route file via --project backend --file, relevant weekly/calendar regression files if a
helper is extracted, --preset backend-fast, --preset frontend-fast, --preset e2e (or agreed
focused dashboard browser file plus declared full-suite omissions), and frontend build.
Compare any failure with a clean exact-main baseline; report exact heads/commands/counts,
mutations and omissions. Neither implementation nor these application tests ran for this
docs-only PR; its checks are document review, one-file diff and git diff --check.

## 8. Expected implementation files and exclusions

Expected: backend/src/routes/trainingLoadDashboard.js; a small dashboard shell-selection
access/resolution module; backend/src/trainingLoadDashboardQuery.js and its canonical
context argument boundary; optionally an extracted pure filter SQL helper and
backend/src/routes/trainingLoad.js to consume it with unchanged behavior.
Frontend: frontend/training-load-analysis-data.js, training-load-actions.js,
training-load-view.js, possibly training-load-simple-actions.js for shared payload callers;
new/updated backend dashboard route tests, frontend/tests/training-load-dashboards.actions.test.mjs
and related analysis cache tests, e2e/tests/dashboard-simple.test.mjs or a focused new file.
Canonical context construction currently lives inside trainingLoadDashboardQuery.js;
keep its scope boundary explicit rather than inventing a second query engine. No schema edit.

Out of scope: D2/pages/v75, ratio math redesign, mapping writer/calculatedValues.js,
GPS/import files, migrations, per-page permissions, historical membership schema,
athlete builder UX, unrelated weekly/calendar behavior, authz redesign, persistent cache
infrastructure, production configuration and deployment. Any newly discovered need to
change a shared access rule or add a migration returns to both reviewers before code.

## 9. Owner/reviewer decisions before implementation

1. **Saved selection precedence and legacy contract:** approve shell as a hard intersection
   with saved widget/default filters and the presence-based compatibility mode in section 2.
   Recommendation: yes; clearing shell restores saved defaults and never silently clears
   a widget's intentional athlete selection. If a legacy runtime athlete filter must also
   coexist, approve its separate field rather than overloading athleteIds.
2. **Private coach/self organizational selectors:** allow clubs/teams by intersection,
   or reject them? Recommendation: reject as in the matrix; individual authorized athletes
   only. Keep athlete self restriction and no calculated variables. Team parent club is
   allowed only as a selector narrowed to that team.
3. **Membership history expectation:** recommendation: keep current active membership,
   exactly weekly, and explain "Filters use current club and team membership" in existing
   help if needed. Event-time membership requires a separate contract.
4. **Simple preview parity:** recommendation: the same shell scope must apply to preview
   and saved query. Review existing preview contract before code and explicitly approve
   any added preview request keys; never widen preview silently or persist a temporary
   shell restriction into saved config.
5. **Unavailable selection UX:** recommendation: for a rejected selection, clear stale
   chart data and show "This selection is unavailable. Choose athletes again." with a
   "Choose athletes" action. Keep raw IDs/codes and existence detail out of coach/admin
   text and folded panels. Do not auto-drop an inaccessible ID and execute a broader query.

No code starts until both reviewers confirm these decisions and the access matrix.
