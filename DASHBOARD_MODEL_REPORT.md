# Training Load 3B1 — Analysis Dashboard: model, ownership, data semantics, API contract, and disposable-DB PoC results

**Status: design phase only — Round 6 (final corrective pass before real migrations).** Nothing in this round touches `migrations_v2`, the backend app, or the frontend app. `schema.sql` is a standalone, additive proposal validated only against a disposable, throwaway database created and dropped by `test-harness.mjs`. Waiting for a NEW confirmation of this corrected model before any real migration or application code is written.

Every claim below is labeled **[confirmed]** (read directly from `origin/main`'s real code/schema), **[decision]** (a choice made for this proposal, with rejected alternatives), or **[PoC-proven]** (demonstrated by `test-harness.mjs` against real, unmodified `migrations_v2` files + this proposal's `schema.sql`, on a disposable database, **three consecutive runs, 161/161 passing each time**, database confirmed dropped after each, zero leftovers). Round 1 had 24 proof points, Round 2 added 26 (50 total), Round 3 added 36 (86 total), Round 4 added 30 (116 total), Round 5 added 21 (137 total), Round 6 adds the final **24** required by this pass — see "PoC results" below for the full breakdown, **§0-R6's own finding→correction→test→function traceability table**, and **§0-R6.6 for an honest, unflinching readiness assessment** (the task's own explicit instruction: green tests alone do not mean "ready").

**Read this first — jump straight to what changed:** §0-R6 immediately below is the complete Round-6 changelog — a real runtime `activityId`/`componentId` filter enforced through the authorized pipeline, a realistic (system-scope) cross-club day fixture, binding-time metric state/type compatibility, a sanctioned active-selection write path, and a real audit (not a simulation) of the Metrics Core capability-removal lock discipline against the actual production service function. §0-R5, §0-R4, §0-R3, §0 (Round 2), and the rest of the report are kept as historical context beneath it, amended in place wherever a later round changed something (each amendment marked with its own round).

---

## §0-R6. Round 6 (final corrective pass) — what changed, and why

This round's task was, once again, explicit that this is the LAST corrective pass before real migrations. All 5 items were findings against the ALREADY-EXISTING Round 5 model, not new feature requests — each is a genuine correctness/completeness gap, closed strictly within `schema.sql`/`test-harness.mjs`/the two doc files, no real migrations/backend/frontend, no OPTIMOVE/monitoring2/production access.

### §0-R6.1 A real runtime `activityId`/`componentId` filter, enforced through the authorized pipeline

**The finding.** §12.4 (Round 5) claimed to prove that an explicit `activityId`/`componentId` filter never auto-claims an unrelated day-level fact — but it never actually exercised a runtime activity/component filter at all. It called `queryMetricSeries()` directly with `dataScopeLevel` swapped to `"session"`/`"component"` against the day-scope metric, which trivially returns zero rows for an unrelated structural reason (a day-scope metric has no session/component-grain facts to begin with, regardless of any activity filter). `runSeriesPipeline()` — the real pipeline entry point every widget actually calls — never even accepted an `activityId`/`componentId` on its own `ctx` at all; there was no real filter to test in the first place.

**The fix.** `runSeriesPipeline()`'s `ctx` now accepts an optional `activityId`/`componentId` (the Calendar's own "from Calendar" deep-link context — `DASHBOARD_UX_SPEC.md`'s existing Global Filter control), enforced with the exact semantics required:
- `activityId` is ALWAYS intersected with the already workspace-authorized activity set `fetchActivitiesInRange()` produces for that date range — an id from a different workspace narrows the result to EMPTY, never silently falls back to the unnarrowed full set (§13.3, negative proof).
- `componentId` resolves its own owning activity (`training.activity_components.activity_id`, a single real lookup — new `resolveComponentOwningActivityId()`) and is subject to the SAME authorization intersection (§13.4, negative proof) — and, when an explicit `activityId` was ALSO supplied, the component's owning activity must equal it exactly, or the query returns zero rows rather than silently reinterpreting the request as "switch to the component's own activity instead" (§13.5).
- Session-scope Metrics-Core series and built-in series (RPE/sRPE/duration/session_count/last_session_date) narrow to exactly the one authorized activity (§13.1/§13.1b) — built-ins share the SAME `activityIds` resolution as any other series, never a separate, looser path.
- Component-scope series additionally narrow to the ONE real canonical component (a new `componentId` parameter threaded into `queryMetricSeries()`, filtering the already-canonicalized `grainKey` from Round 5's own component-identity fix — never the raw source segment) — while session-level facts for the SAME parent activity (RPE included) stay fully visible even while zoomed into one component (§13.2), matching the task's own explicit "session-level RPE/metrika može ostati vidljiva kao rezultat roditeljske aktivnosti" requirement.
- A standalone (non-built-in) day-scope series under EITHER filter returns zero rows structurally — the day-level fetch is never even attempted when `ctx.activityId`/`ctx.componentId` is set, a real empty result, not a scope-level substitution trick. §12.4 itself is rewritten to prove this the RIGHT way: a real `dataScopeLevel='day'` series, run through the real `runSeriesPipeline()`, with a real `ctx.activityId`/`ctx.componentId` set, PLUS a sanity check that the identical query with NEITHER filter genuinely does return real rows (proving the zero is caused by the filter, not an unrelated fixture mistake).

**[PoC-proven]** §12.4 (rewritten), §13.1, §13.1b, §13.2, §13.3, §13.4, §13.5.

### §0-R6.2 A realistic (system-scope) cross-club day fixture

**The finding.** `dayScopeMetric` (introduced in Round 5, §0-R5.1) was `owner_scope='club'`/`owner_club_id=`Club A. The `dayEventClubB` fixture then wrote a real value against this SAME Club-A-owned definition from Club B's own event — a state the real application can never legitimately produce: `resolveValueEntries()` (`backend/src/trainingLoadMetricsMeasurements.js`) gates every value write behind `catalogVisibilitySql()` (`backend/src/trainingLoadMetricsAccess.js`), which only ever admits `owner_scope='system'`, the caller's OWN `'user'`-scope metrics, or a `'club'`/`'team'` scope the caller actually administers — Club B can never see, let alone write against, a Club-A-owned definition. The whole cross-club conflict/self-view proof this fixture backs (§12.1/§12.2/§12.2b) was therefore built on a state the real app could never create.

**The fix.** `dayScopeMetric` is now `owner_scope='system'` — genuinely visible to every club, exactly like `distanceSystem`'s own existing fixture — while the metric EVENTS and SOURCE CONNECTIONS underneath it stay correctly separate, real Club-A-owned and Club-B-owned rows (only the shared catalog definition itself moved). Every existing test built on this fixture (§12.1, §12.2, §12.2b, §12.3, §11.3, §13.6's own new test below) needed no behavioral change — the workspace filter that matters at query time is on `metric_events.owner_scope/owner_*`, never on the metric DEFINITION's own ownership, so the fix is purely a fixture-realism correction, not a semantics change. One genuinely NEW test was added: pinning a source connection now demonstrably resolves the real self-view conflict (§12.2b) down to exactly that connection's own value, proving the resolution mechanism works identically for this now-realistic shared metric as it already does for every other source conflict in this file.

**[PoC-proven]** §13.6 (new); §12.1/§12.2/§12.2b/§12.3/§11.3 all continue passing unchanged against the corrected fixture.

### §0-R6.3 Binding-time metric state and value-type/aggregation compatibility

**The finding, part A.** `resolve_series_binding()` (Round 5, §0-R5.3) re-validated OWNER/workspace visibility live via the existing metric-visibility trigger, but nothing anywhere ever checked `metric_definitions.state='active'` — a coach could bind a fresh or repaired series straight onto an ARCHIVED (retired) metric, and the query adapter would happily query it forever after.

**The finding, part B.** A series could be bound to a `text`/`boolean` metric (or built-in, e.g. `last_session_date`) while carrying `analytical_aggregation='sum'` — a combination the query adapter's own `reduceTyped()` has always explicitly rejected (`test-harness.mjs`, unchanged this round) — meaning the FIRST time anyone actually ran that widget's query, it would throw deep inside the adapter, instead of being refused up front at config time, where a coach could actually fix it.

**The fix.** Two new triggers on `dashboard_widget_series`, both following the exact Round 5 lock-discipline (each takes its own `FOR SHARE` lock on the referenced catalog row as its first statement, independent of any other trigger's firing order):
- `dashboard_widget_series_validate_metric_active_state()` — fires ONLY on `insert or update of metric_definition_id` (never on any other column, and never on `metric_definitions.state` itself) — rejects a NEW or CHANGED binding to a non-`'active'` metric. Deliberately scoped this way: an existing, already-validly-bound series is NEVER broken by its metric being archived LATER (archiving is a state change on `metric_definitions`, not a write to `dashboard_widget_series` — it never fires this trigger), so the series keeps working and keeps its history, exactly as required (§13.7 proves the rejection; §13.12b proves an EXISTING bind is untouched by a LATER archive).
- `dashboard_widget_series_validate_aggregation_type_compat()` — fires on a (re)binding OR on a bare `analytical_aggregation` change with no binding change at all (the second case matters because `update_series()` can change `analytical_aggregation` without touching the binding — §13.11 proves an already-bound text series can never be moved to `'sum'` later through the sanctioned path either). Mirrors `reduceTyped()`'s own real contract exactly: `numeric` supports the full `sum`/`avg`/`max`/`last`/`none` set; `text`/`boolean` support ONLY `last`/`none` this round (no boolean `any`/`all`/`count_true`, explicitly out of scope per the task).
- Both are exercised for FREE by `resolve_series_binding()` — its own real `UPDATE` of `metric_definition_id` re-fires the SAME trigger stack every other metric-binding write already goes through; no bespoke re-implementation was added to that function itself.
- If the user knowingly picks a replacement metric that was never in the original candidate snapshot, it is permitted ONLY if it is currently visible, active, AND type-compatible — the snapshot was already documented (Round 5, §0-R5.3) as a UI convenience, never an authorization source; this round extends that same "never trust the stale JSON" principle to state and type as well.

**[PoC-proven]** §13.7 (archived metric rejected), §13.8 (text+sum rejected), §13.9 (boolean+avg rejected), §13.10 (text+last accepted), §13.11 (`update_series()` re-check on aggregation-only change), §13.12a/§13.12b (a REAL two-connection archive-vs-resolve race, both orderings, `pg_stat_activity`-proven).

### §0-R6.4 A sanctioned active-selection write path

**The finding.** `dashboard_active_selection_validate_visibility()` (Round 2, hardened Round 5, §0-R5.5) already enforced every real invariant on the `dashboard_active_selection` table — but no SANCTIONED FUNCTION ever existed to reach it through. The only working write path was a raw `INSERT ... ON CONFLICT` directly against the table (visible in Round 5's own §12.15/§12.16 tests) — the ONE place in this schema where the application layer had no choice but to bypass this file's own "one write path per mutation" convention that every other mutation (series, widgets, layout, archive) already follows.

**The fix.** Two new sanctioned functions: `set_active_dashboard(p_user_id, p_workspace_type, p_scope_id, p_dashboard_id)` — locks the target dashboard FIRST (the SAME order `archive_dashboard()` already uses), then performs a real UPSERT keyed on the table's own `unique nulls not distinct (user_id, workspace_type, scope_id)` constraint: a first selection INSERTs, a switch to a different dashboard in the SAME workspace UPDATEs that SAME row in place (§13.14, never a duplicate row) — either path fires the SAME `validate_visibility` trigger, so a switch is validated exactly as strictly as a first selection (§13.15). `clear_active_dashboard(p_user_id, p_workspace_type, p_scope_id)` — the sanctioned counterpart for explicitly removing a selection, a genuine no-op (not an error) when nothing was selected (§13.21). A real PL/pgSQL "ambiguous column" bug was caught live by the harness itself while building `set_active_dashboard()` — its `RETURNS TABLE` out-parameters originally reused the table's own real column names (`dashboard_id`/`workspace_type`/`scope_id`/`updated_at`), and Postgres could not resolve `workspace_type` inside the `ON CONFLICT (user_id, workspace_type, scope_id)` clause between the out-parameter and the table column; fixed by prefixing every out-parameter (`out_selection_id`, `out_dashboard_id`, ...) — the exact same bug CLASS Round 2's own history already documents ("several PL/pgSQL 'ambiguous column' bugs against RETURNS TABLE out-parameters"), caught again, the same way, by actually running the tests rather than merely reading the SQL.

**[PoC-proven]** §13.13 (first selection), §13.14 (switch, same row), §13.15 (mismatched workspace rejected), §13.16/§13.17 (`set_active_dashboard()` vs `archive_dashboard()`, both orderings, `pg_stat_activity`-proven), §13.18 (switching old→new while the OLD dashboard archives concurrently — no lock contention, correctness-only), §13.19/§13.20 (switching old→new while the NEW dashboard archives concurrently, both orderings, `pg_stat_activity`-proven — the genuine-contention case, since both operations target the SAME dashboard row), §13.21 (`clear_active_dashboard()`).

**Documentation requirement, restated plainly:** a future route implementation MUST call `set_active_dashboard()`/`clear_active_dashboard()` exclusively — never a raw `INSERT`/`UPDATE`/`DELETE` against `dashboard_active_selection` — now that a sanctioned path exists for both directions.

### §0-R6.5 The Metrics Core capability-removal lock discipline — audited, not assumed

**The finding.** Every prior round's report (most explicitly Round 5, §0-R5.6/§0-R5.9) stated the capability-removal-vs-`add_series` race was only "half-closed" — this PoC proves the dashboard-side lock discipline, but a real, future Metrics Core capability-removal code path would need to independently adopt the same "lock the parent row as your own first statement" pattern for the guarantee to hold end-to-end. This round's task required actually AUDITING `origin/main`'s real code rather than continuing to assume the gap.

**The audit result.** The discipline is ALREADY PRESENT, confirmed by reading the real, unmodified source: `backend/src/trainingLoadMetricsCatalog.js`'s `setDefinitionScopeCapabilities()` (line ~279: `select * from training_load.metric_definitions where id = $1 for update` is its own literal FIRST statement inside its transaction, before any read) and `archiveDefinition()` (line ~380: the identical pattern) both already take `FOR UPDATE` on `metric_definitions` as their first act, with the function's own header comment explicitly naming the reason: `"FOR UPDATE conflicts with FOR SHARE... giving this setter and every write path one real, shared serialization point per definition."` This is NOT new code added this round — it was already shipped, and this round's job was to verify it, not to write it.

**Consequently:** this is reclassified from an open design gap to a required END-TO-END INTEGRATION TEST obligation for the implementation phase — the discipline on BOTH sides already exists (dashboard-side: this schema's own triggers; Metrics-Core-side: the real service function above), so what remains is proving the two ACTUALLY serialize against each other when run concurrently, not designing a fix for either side.

**The proof.** §13.22 dynamically imports the REAL, unmodified `backend/src/trainingLoadMetricsCatalog.js` module (pointing its own `backend/src/db.js` pool at this run's own disposable database before the very first import — the same "real code, disposable database" precedent already established for `backend/src/migrate.js`) and calls the REAL `setDefinitionScopeCapabilities()` directly, using its own already-existing `onLocked` test hook (the same "test-only sync point" convention this app's other deterministic-concurrency-tested functions already use) to hold its real `FOR UPDATE` lock open while a concurrent dashboard-side series insert is proven, via a real second connection and `pg_stat_activity.wait_event_type='Lock'` polling, to genuinely queue behind it — then the insert correctly fails once it sees the REAL, final (capability-removed) state. Not a raw-SQL stand-in pretending to be the production path — the actual production function, actually executed, against the actual schema, on a disposable database.

**A real cleanup bug this proof caught along the way:** the REAL module's own pool (`backend/src/db.js`, a SEPARATE `pg.Pool` from this harness's own) was never closed — dropping the disposable database at teardown left it holding dead connections that threw an unhandled `"terminating connection due to administrator command"` asynchronously, AFTER the test had already finished, failing the overall suite despite every individual test passing. Fixed by capturing that pool's own reference and closing it in `teardown()`, before the disposable database is dropped — caught by this harness's own 3×-consecutive-run verification requirement doing exactly the job it exists to do.

**[PoC-proven]** §13.22.

### §0-R6.6 Finding → correction → test → function traceability, and the honest readiness assessment

| # | Finding | Correction | Test(s) | Function(s) actually executed |
|---|---|---|---|---|
| 1 | §12.4 never exercised a real activityId/componentId filter — runSeriesPipeline() had no such ctx field at all | Real `ctx.activityId`/`ctx.componentId`, authorized-intersection semantics, componentId narrows only component-grain facts | §12.4 (rewritten), §13.1, §13.1b, §13.2, §13.3, §13.4, §13.5 | `runSeriesPipeline()` + `queryMetricSeries()` + new `resolveComponentOwningActivityId()` |
| 2 | Cross-club day fixture wrote a value against a Club-A-owned definition Club B could never see through the real app | `dayScopeMetric` moved to `owner_scope='system'`, events/connections stay club-separated | §13.6 (new); §12.1/§12.2/§12.2b/§12.3/§11.3 (unchanged, still pass) | `queryMetricSeries()` (day-scope path) |
| 3 | No check on metric `state`/value_type at binding time — could bind to an archived or type-incompatible metric | Two new triggers: `..._validate_metric_active_state()`, `..._validate_aggregation_type_compat()` | §13.7, §13.8, §13.9, §13.10, §13.11, §13.12a, §13.12b | `training_load.resolve_series_binding()` / `add_series()` / `update_series()` (SQL, via the two new triggers) |
| 4 | No sanctioned function for active-dashboard selection — only a raw INSERT/UPDATE | New `set_active_dashboard()` + `clear_active_dashboard()` | §13.13–§13.21 | `training_load.set_active_dashboard()` / `clear_active_dashboard()` (SQL) |
| 5 | Capability-removal lock discipline claimed "half-closed" without ever being audited against real code | Audited `origin/main`: already present (both sides) — reclassified to an integration-test obligation, proven end-to-end | §13.22 | `backend/src/trainingLoadMetricsCatalog.js`'s REAL `setDefinitionScopeCapabilities()` (JS, dynamically imported and actually executed) |

**All 161 tests pass, three consecutive runs, disposable database confirmed dropped every time (including the REAL backend module's own separate connection pool, see §0-R6.5's own cleanup-bug note), zero leftovers (`select datname from pg_database where datname like 'optimove_poc_dashboard_%'` → zero rows after all three), no hardcoded credentials in either `schema.sql` or `test-harness.mjs`.**

**Explicitly NOT ready, stated plainly rather than papered over — carried forward from Round 5, still true, plus what this round adds/changes:**
- Route-level authorization still does not exist (unchanged from every prior round).
- The 13 sanctioned write functions (11 from Round 5 + `set_active_dashboard()`/`clear_active_dashboard()` this round) are the ONLY proven-safe entry points — the real backend's route layer must call exclusively these; this is a hard requirement, not a suggestion. In particular, active-dashboard selection must now go through `set_active_dashboard()`/`clear_active_dashboard()`, never a raw `INSERT`/`UPDATE`/`DELETE` against `dashboard_active_selection`.
- **Changed this round:** the capability-removal race is NO LONGER an open design gap on either side (§0-R6.5) — both the dashboard-side lock (this schema's triggers) and the Metrics-Core-side lock (`setDefinitionScopeCapabilities()`/`archiveDefinition()`, confirmed already shipped) exist; §13.22 is a real, passing, end-to-end proof they serialize correctly together. The remaining obligation for the implementation phase is to keep exercising this SAME integration test (or an equivalent) against the real route layer once it exists — not to design a fix, since none is needed.
- This adapter's per-activity/per-day N+1 query pattern remains explicitly not a production query plan (restated from Round 3/4/5, still true) — unchanged this round; no route/API/frontend work was in scope.
- Boolean built-in aggregation (`any`/`all`/`count_true`), real team grouping (vs `cohort`), and unit conversion remain explicitly out of scope this round too, exactly as instructed.
- The value-type/aggregation compatibility check (§0-R6.3) is deliberately narrow — it enforces exactly `reduceTyped()`'s own existing, already-implemented contract (numeric: full set; text/boolean: last/none only) and does not attempt to anticipate a richer future contract (e.g. boolean rollups) that does not exist yet.

This section's purpose, restated from every prior round: everything above the "Explicitly NOT ready" line is safe to build real migrations and routes on top of; everything below it is a known, named gap to close during implementation, not a surprise to discover later.

---

## §0-R5. Round 5 (final corrective pass) — what changed, and why

This round's task was again explicit that this is the LAST corrective pass before real migrations. All 8 items were findings against the ALREADY-EXISTING Round 4 model, not new feature requests — each is a genuine correctness/completeness gap, closed strictly within `schema.sql`/`test-harness.mjs`/the two doc files, no real migrations/backend/frontend, no OPTIMOVE/monitoring2/production access.

### §0-R5.1 Day-level Metrics Core facts no longer have a fake Training Activity anchor

**The finding.** §11.3's `dayEventActivity` fixture linked a `scope_level='day'` metric event to a real `training.activities` row via `activity_metric_event_links` — but day-level facts (sleep, recovery, resting HR) are never recorded against a training session in the real system; they are read directly off `metric_events → participants → occasions → values`, exactly like the real, already-deployed `GET /results` route (`queryResults()` in `backend/src/trainingLoadMetricsMeasurements.js`) does. The old fixture invented a link that cannot exist for a real day fact and would have let the PoC silently validate the wrong pipeline shape.

**The fix.** Two real, independent fact-sourcing paths now exist in `queryMetricSeries()`:
- **Activity-backed facts** (RPE/sRPE/duration, session-level, component-level) — unchanged, still driven by `training.canonical_activity_results(activityId)`.
- **Standalone day-level facts** (new) — `fetchDayLevelMetricFacts()` reads `metric_events(scope_level='day') → metric_event_participants → metric_measurement_occasions → metric_values` directly, workspace-filtered on `ev.owner_scope/owner_club_id/owner_team_id/owner_user_id` exactly like the real `metricEventScopeSqlForWorkspace()` — including the real special case that an `athlete` self-view skips the owner-scope predicate entirely and filters on `p.athlete_id` only. Day facts never touch `activity_metric_event_links`, `training.activities`, or activity-participant rows anywhere in this path.

A single shared `resolveFactsToRows()` was extracted from the old monolithic query function so the role/coverage/source-policy filtering and the measurement-target conflict logic is the SAME code for both paths — the two fact sources can never silently diverge in how a conflict is detected.

**Runtime filter behavior, now explicit:** a date/range filter includes day facts; an explicit `activityId`/`componentId` filter never auto-claims a day fact for that session/component (day facts have no activity to match against — §12.4 proves an activity-filtered query returns zero day rows even when a day fact exists on the exact same date).

**[PoC-proven]** §12.1 (zero Activity rows, workspace isolation Club A vs Club B), §12.2/§12.2b (athlete self-view breadth vs a genuine same-day multi-club conflict), §12.3 (real ISO-week aggregation), §12.4 (activity/component filter exclusion), §11.3 rewritten to assert zero `training.activities` rows for a day fact.

### §0-R5.2 Component identity is now the canonical Training Activity component, not a raw source segment

**The finding.** `queryMetricSeries()` used `metric_event_segments.id` — a raw, source-specific segment row — as the component-scope bucket/target identity. Two different sources (e.g. two different GPEXE-style imports) can each produce their own segment for the SAME real training-activity component; keying on the segment meant the same real component could silently appear as two unrelated buckets, or worse, never be recognized as a genuine conflict when it should be.

**The fix.** `fetchCanonicalFacts()` already calls `training.canonical_activity_results()`, which returns `component_metric_segment_link` facts (`{componentId, metricEventSegmentId, linkStatus}`, confirmed links only) — this data was already being fetched and simply wasn't being used for identity. A `segmentToComponentId` map is now built from those facts (no extra DB round trip), and every component-grain fact's `grainKey`/target identity is the real `activity_component_id`, never the segment id. A component fact with no confirmed canonical link is filtered out rather than silently bucketed under its own segment id.

**[PoC-proven]** §12.5 (two source segments confirmed-linked to ONE real component collapse to one target), §12.6 (differing values on that one target correctly conflict), §12.7 (pinning one source connection resolves it to that connection's own value), §12.8 (segments on two genuinely different components stay two separate buckets).

### §0-R5.3 A real sanctioned function now exists to resolve an unresolved/ambiguous series

**The finding.** None of the 10 sanctioned write functions could ever change `resolution_status`/`metric_definition_id`/`template_resolution_candidates` — the only way to "fix" a stuck placeholder series was a raw `UPDATE`, bypassing every sanctioned-write guarantee (lock order, revision bump, live re-authorization). This was a genuine completeness gap: the model could create an unresolved/ambiguous series but never actually resolve one.

**The fix.** `training_load.resolve_series_binding(p_series_id, p_widget_id, p_expected_widget_revision, p_metric_definition_id)` — locks dashboard then widget (the same order every other sanctioned function uses), checks the caller's expected widget revision (stale-revision rejection, same contract as every other write), confirms the series exists, belongs to that widget, and isn't already `resolved`, then performs a REAL `UPDATE` of `metric_definition_id` — deliberately a real column write, not a bespoke re-implementation, so the EXISTING `dashboard_widget_series_validate_scope_capability`/`..._validate_source_connection_visibility`/`..._validate_axis_unit` triggers re-fire and do the live authorization check. **The chosen metric is never trusted from the stale candidate JSON** — it is re-validated for CURRENT visibility at the moment of selection, exactly because a candidate that was visible when the template was cloned may no longer be visible now (workspace/role/archival changes in between). `resolution_status` is set to `'resolved'` and `template_resolution_candidates` is atomically cleared in the same statement.

A CHECK constraint was tightened to require the correct shape in BOTH directions (`resolution_status='ambiguous'` ⟺ `template_resolution_candidates is not null`, previously only checked one way), and a new trigger `validate_template_resolution_candidates_shape()` enforces: a real JSON array (never a scalar), every element a syntactically valid UUID, no duplicates, and at least 2 DISTINCT candidates whenever `resolution_status='ambiguous'`.

**Why JSONB, not a normalized child table (as required to justify):** `template_resolution_candidates` is a point-in-time snapshot taken once at clone time — it is never independently queried, filtered, joined, or paginated; it is always read as a whole and replaced as a whole (exactly once, by `resolve_series_binding()`); and critically, it is NEVER used as a live authorization source — `resolve_series_binding()` always re-derives current visibility through the real trigger, never by trusting what the snapshot says. A normalized child table would add join/write overhead for a value that is only ever read-as-a-blob and re-validated live regardless of its own contents.

**[PoC-proven]** §12.9 (clean resolve), §12.10 (live re-validation rejects a stale-but-now-invisible candidate while accepting the dashboard's own real currently-visible metric — the specific case the "never trust stale JSON" rule exists for), §12.11 (stale widget revision rejected), §12.12 (shape validation rejects a too-short/duplicate/non-UUID candidate array).

### §0-R5.4 `update_series()` can now actually clear a pinned source connection

**The finding.** `source_connection_id = coalesce(p_source_connection_id, s.source_connection_id)` can never move a series FROM `source_policy='source_connection'` TO any other policy — the old connection id survives every update that doesn't explicitly overwrite it, and the CHECK constraint (`source_connection_id is not null` requires `source_policy='source_connection'`, and vice versa) then rejects the very policy change the coach asked for. The only way around it was raw SQL, outside the sanctioned-write contract.

**The fix.** The SET clause now clears the column whenever the caller supplies a new, non-`source_connection` policy: `source_connection_id = case when p_source_policy is not null and p_source_policy <> 'source_connection' then null else coalesce(p_source_connection_id, s.source_connection_id) end`. Both directions are real, sanctioned-function-only transitions now.

**[PoC-proven]** §12.13 (`source_connection` → `all_with_conflicts`, pin genuinely cleared), §12.14 (`all_with_conflicts` → `source_connection`, pin genuinely set) — both exclusively through `update_series()`, no raw SQL.

### §0-R5.5 Active-selection vs archive race closed with a real row lock

**The finding.** `dashboard_active_selection_validate_visibility()` read the dashboard's status without locking it — a concurrent `archive_dashboard()` could interleave such that a new active-selection row ends up referencing a dashboard that is (or is about to be) archived, since the archive path's own trigger-based delete-selection step could run either before or after the read, with no ordering guarantee between them.

**The fix.** The validation trigger now takes `perform 1 from training_load.dashboards where id = new.dashboard_id for update` as its FIRST statement, before reading status/workspace — the same lock `archive_dashboard()` itself takes on the dashboard, so whichever transaction gets there first genuinely serializes the other behind it; there is no interleaving where both can proceed on stale state.

**[PoC-proven]** §12.15 (selection-first: archive genuinely queues behind the in-flight selection, confirmed via `pg_stat_activity.wait_event_type='Lock'` polling on the archiver's own real backend pid — no `sleep`; after the selection commits, the archive proceeds and removes it) and §12.16 (archive-first: the selection queues, then correctly sees the archived state and is rejected) — both proving the final state never contains an active selection pointing at an archived dashboard, regardless of ordering.

### §0-R5.6 Catalog-row locks no longer depend on trigger firing-order luck

**The finding.** PL/pgSQL BEFORE-ROW triggers on the same table+event fire in alphabetical order BY TRIGGER NAME. `dashboard_widget_series_validate_scope_capability()` read capability rows before the alphabetically-later metric-visibility trigger took its own `FOR SHARE` lock on the definition — meaning the capability read's safety depended entirely on incidental trigger naming, not on anything it itself guaranteed. The same pattern existed in `dashboard_widget_series_validate_axis_unit()` against the built-in-scope trigger.

**The fix.** Both triggers now take their own lock as the first thing they do, before reading anything: `dashboard_widget_series_validate_scope_capability()` takes `for share` on the metric definition before reading capability rows; `dashboard_widget_series_validate_axis_unit()` takes `for share` on the metric definition (or the built-in series row, whichever branch applies) immediately before reading its unit. Neither trigger's correctness depends on any other trigger's name or firing position anymore.

**Honest scope limit, stated plainly:** this PoC only owns the dashboard-side half of the "capability removal" race — a real, future Metrics Core capability-removal code path must adopt the same "lock the parent row as your own first statement" discipline for the end-to-end guarantee to hold; this round proves the dashboard side is now correct and provable, not that the whole system is.

**[PoC-proven]** §12.17 (axis-unit's own lock genuinely blocks a concurrent semantic change to a built-in, both orderings resolve to one consistent final outcome), §12.18 (scope-capability's own lock genuinely serializes against a simulated, equally-disciplined concurrent capability removal).

### §0-R5.7 Clone provenance — snapshot semantics adopted explicitly, and made race-proof

**The decision.** `cloned_from_dashboard_id` means "this dashboard WAS a template at the moment it was cloned" — a historical fact, never a live constraint that could later be invalidated by the source dashboard's own template flag changing. This was already the model's *de facto* behavior (the validation only ever ran once, at INSERT time) but was never explicitly decided or race-proofed.

**The fix.** `dashboards_validate_clone_provenance()` now takes `perform 1 from training_load.dashboards where id = new.cloned_from_dashboard_id for share` before checking `is_template`, so a concurrent template-flip and a concurrent clone genuinely serialize against each other rather than racing on an unlocked read. Because the validation is INSERT-only by construction, a later template flip on the source dashboard can never retroactively invalidate a clone's already-recorded provenance — that is the snapshot guarantee, now backed by a real lock instead of an implicit assumption.

**[PoC-proven]** §12.19 (template-flip-first: the flip commits before the clone's own lock is acquired → the clone is correctly rejected) and §12.20 (clone-first: the clone's own lock+read commits before a later flip → the clone is completely unaffected by that later flip) — both proving the historical-fact guarantee holds under real concurrency, not just in the happy path.

### §0-R5.8 Documents reconciled — one semantics for the unresolved/ambiguous clone-review state

**The finding.** `DASHBOARD_UX_SPEC.md` still said a series with zero matching candidates during clone review was "simply omitted from the created dashboard unless the coach explicitly picks a replacement right there" — directly contradicting the model (§0-R5.3 above, and the underlying contract since Round 3) where an unresolved/ambiguous row is always preserved, never dropped, specifically so it stays fixable later.

**The fix.** `DASHBOARD_UX_SPEC.md`'s "Template cloning and the unresolved/ambiguous-metric state" section is rewritten to adopt ONE semantics: the row is always preserved; the new dashboard can be created with it as-is; the widget shows a neutral "Choose a metric" (ambiguous) or "Metric not available" (zero-candidate) placeholder; the coach resolves it later via `resolve_series_binding()` (§0-R5.3) or deletes it outright via the normal per-widget Remove action. A stale comment claiming archiving doesn't retroactively clear an active selection was checked for — none survives; the comment block on `dashboard_active_selection_validate_visibility()` was already rewritten in §0-R5.5 above to describe the current (correct) trigger-based behavior.

### §0-R5.9 Req → test → function traceability, and the honest readiness assessment

Every one of the 8 findings this round specified, the exact test(s) that prove it, and the real function actually exercised:

| # | Finding | Correction | Test(s) | Function(s) actually executed |
|---|---|---|---|---|
| 1 | Day metrics had a fake Training Activity anchor | Standalone day-level fact path, decoupled from `training.activities` | §11.3 (rewritten), §12.1, §12.2, §12.2b, §12.3, §12.4 | `fetchDayLevelMetricFacts()` + `resolveFactsToRows()` |
| 2 | Component identity used raw source segment id | Canonical `activity_component_id` via `component_metric_segment_link` | §12.5, §12.6, §12.7, §12.8 | `fetchCanonicalFacts()` (`segmentToComponentId` map) + `queryMetricSeries()` |
| 3 | No sanctioned way to resolve unresolved/ambiguous series | New `resolve_series_binding()` with live re-authorization + candidate shape validation | §12.9, §12.10, §12.11, §12.12 | `training_load.resolve_series_binding()` + `validate_template_resolution_candidates_shape()` (SQL) |
| 4 | `update_series()` could never clear a source pin | Explicit clear-on-policy-change in the SET clause | §12.13, §12.14 | `training_load.update_series()` (SQL) |
| 5 | Active-selection vs archive race (unlocked read) | `FOR UPDATE` on the dashboard as the trigger's first statement | §12.15, §12.16 | `dashboard_active_selection_validate_visibility()` trigger (SQL) |
| 6 | Catalog reads relied on another trigger's alphabetical firing order | Each trigger takes its own `FOR SHARE` lock first | §12.17, §12.18 | `dashboard_widget_series_validate_axis_unit()` + `..._validate_scope_capability()` triggers (SQL) |
| 7 | UX_SPEC contradicted the model's preserved-placeholder contract | UX_SPEC rewritten to one adopted semantics | manual doc review (no test — doc-only change) | n/a |
| 8 | Clone provenance race undecided/unlocked | Snapshot semantics explicitly adopted + `FOR SHARE` lock | §12.19, §12.20 | `dashboards_validate_clone_provenance()` trigger (SQL) |

**All 137 tests pass, three consecutive runs, disposable database confirmed dropped every time, zero leftovers (`select datname from pg_database where datname like 'optimove_poc_dashboard_%'` → zero rows after all three), no hardcoded credentials in either `schema.sql` or `test-harness.mjs`.**

**Explicitly NOT ready, stated plainly rather than papered over — carried forward from Round 4, still true, plus what this round adds:**
- Route-level authorization still does not exist (unchanged from every prior round).
- The 11 sanctioned write functions (10 from Round 4 + `resolve_series_binding()` this round) are the ONLY proven-safe entry points — the real backend's route layer must call exclusively these; this is a hard requirement, not a suggestion.
- The "capability removal" race is only half-closed (§0-R5.6): this PoC proves the dashboard-side lock discipline is correct; a real, future Metrics Core capability-removal code path must independently adopt the same "lock the parent row as your own first statement" pattern for the end-to-end guarantee to actually hold in production. This is a genuine, named, currently-open risk, not a resolved one.
- This adapter's per-activity/per-day N+1 query pattern remains explicitly not a production query plan (restated from Round 3/4, still true) — a real backend service must replace it with a set-based query, now across BOTH the activity-backed and the new standalone day-level fact paths.
- Boolean built-in aggregation (`any`/`all`/`count_true`), real team grouping (vs `cohort`), and unit conversion remain explicitly out of scope this round too, exactly as instructed.
- A true production route/API implementation of any of this round's SQL-only functions (`resolve_series_binding()` especially) does not exist yet — only the sanctioned function itself is proven; the route that calls it, with its own authorization check, is future work.

This section's purpose, restated from Round 3/4: everything above the "Explicitly NOT ready" line is safe to build real migrations and routes on top of; everything below it is a known, named gap to close during implementation, not a surprise to discover later.

---

## §0-R4. Round 4 (final blocker-correction pass) — what changed, and why

This round's task was explicit that this is the LAST corrective pass before real migrations, and repeated the same non-negotiable instruction as Round 3: a green test suite does not by itself mean the model is ready. §0-R4.9 is written to honor that literally.

### §0-R4.1 The final grain/grouping contract

**The gap.** Round 3's `reduceRows()` bucketed almost everything by calendar DATE alone — `group_by='session'` and `group_by='component'` were not real (they degraded to a date bucket), two sessions on the same real day silently vanished into one daily sum, and a day-level Metrics Core event (`metric_events.scope_level='day'`) was recognized as `'session'` scope whenever it happened to have no segment, purely by omission.

**The fix — every raw fact now carries its own real identity**, fetched via real extra joins (never re-deriving `canonical_activity_results()`'s own effective-value logic, only enriching what it doesn't expose): canonical activity id, canonical participant/athlete id, activity local date, activity start instant, component/segment id when one exists, the occasion id, the metric_definition_VERSION id, the metric EVENT's own `scope_level`, the source connection, `unit_at_capture`/`value_type` (per version), and `aggregation_role`/`coverage`.

**Grain is derived correctly** (`queryMetricSeries`, `schema.sql`'s own event `scope_level` column): `event.scope_level='day' → 'day'`; else `segment present → 'component'`; else `'session'` — a day-level event is recognized by its OWN real property, never by the absence of a segment. **[PoC-proven]** §11.3.

**Final `group_by` semantics** (`dashboard_widgets.group_by` CHECK, `schema.sql`):

| Value | Real meaning | Proof |
|---|---|---|
| `session` | One bucket PER REAL canonical session/activity identity | §11.1 |
| `component` | One bucket PER REAL component/segment identity within a session | §11.2 |
| `day` | One bucket per real local calendar date | §10.1, §10.4 |
| `week` **[new]** | One bucket per real Monday-Sunday ISO week, derived from each fact's own local date — was previously CLAIMED supported but never implemented; now real | §11.4 |
| `athlete` | One bucket per athlete across the whole queried range | §10.2, §10.3 |
| `cohort` **[renamed from `team`]** | One bucket merging EVERY currently-selected athlete — it never represented a real `team_id` (a widget has no `team_id` column); calling it `'team'` implied a guarantee this column structurally cannot provide. A genuine "one bucket per real roster team" grouping is a distinct, NOT-yet-built feature, deliberately not offered under this name | §10.6, §10.7 |

**The two-phase pipeline that makes Stage 1 and Stage 2 genuinely independent** (the exact bug an early Round-4 draft itself had, caught before this report was written — see "PoC results" below): PHASE 1 always reduces same-REAL-DATE facts first (Stage 1, `daily_aggregation_method`, only ever for `day`/`week`/`athlete`/`cohort` requests — NEVER for `session`/`component`, which show raw per-target identity directly, per the task's own explicit "ne sme se primeniti pre session ili component prikaza"); PHASE 2 then re-buckets that (now one-real-date-per-entry) output into whatever `group_by` actually asked for and Stage 2's `analytical_aggregation` runs ACROSS those real dates. Collapsing straight to the final bucket (an early draft's own bug) would silently apply Stage 1 across multiple distinct days before Stage 2 ever ran. **[PoC-proven]** §10.3/§10.4 (the sharpest proof: `avg` at the `athlete` level correctly averages the two real per-day values, 115, never the single already-summed number).

### §0-R4.2 The typed, two-stage aggregation contract

Every fact resolves to a real `value_type` (`numeric`/`boolean`/`text`, read from ITS OWN `metric_definition_version_id` — never the metric's CURRENT version, which would silently reinterpret history). `reduceTyped()` (`test-harness.mjs`) enforces:

| `value_type` | Allowed `analytical_aggregation` / `daily_aggregation_method` |
|---|---|
| `numeric` | `sum` / `avg` / `max` / `last` / `none` |
| `text` | `last` / `none` only |
| `boolean` | `last` / `none` only (no `any`/`all`/`count_true` this round — a real, out-of-scope-for-now limit, stated plainly rather than half-implemented) |

An invalid combination (e.g. `sum` on a `text` series) is REJECTED — never silently coerced through `Number()` (Round 3's own real bug: `last_session_date` under certain paths became `NaN`). Through the real pipeline this surfaces as a per-bucket `{value: null, error: "..."}`, never a crash of the whole batch. **[PoC-proven]** §11.14 (real date string, never NaN), §11.16 (rejected combination, both as a direct `reduceTyped` throw and as a real pipeline-level error field).

`'last'` is **deterministic**: sorted by each fact's own real instant, tie-broken by a stable id (never Postgres row order). **[PoC-proven]** §11.15 (same identical instant, same winner, across repeated calls with the input array deliberately reversed).

If a single bucket would need to combine facts from two historical `metric_definition_versions` with DIFFERENT `daily_aggregation_method` or DIFFERENT `value_type`, the adapter never guesses — it returns `semanticConflict: true` / `typeConflict: true` with `value: null`. **[PoC-proven]** §11.12 (method conflict), §11.13 (type conflict).

### §0-R4.3 The real conflict / no-double-count state machine

**The gap.** Round 3's conflict rule was `values.length > 1 → conflict` — wrong: two ordinary readings from two different sessions/days is not a conflict just because more than one row exists in a result set.

**The fix — a real MEASUREMENT TARGET.** `queryMetricSeries` groups every surviving candidate fact (after role/coverage/source-policy filters) into targets keyed by `canonical participant + this metric (implicit) + grain + grain identity + unit`:

- **1 candidate on a target** → a normal, usable value.
- **2+ candidates on the SAME target** → a real conflict: returned in `targetConflicts` (never in `values`, never summed/averaged/silently picked). This ONE rule uniformly covers every case the task named separately — `standalone` + `source_rollup` on the same target (§11.9), raw + `derived` on the same target (§11.10), `complete` + `partial` coverage on the same target, and a genuine duplicate multi-source reading (§9.7/§11.6) — because they are all, structurally, just ">1 surviving candidate for one target".
- **Two values on two DIFFERENT targets** (different day/session/component) are never flagged a conflict, no matter how many exist in total. **[PoC-proven]** §11.5.
- **Pinning a `source_policy`** (a specific connection, or `manual`/`api_import`/`csv_import`/`derived`) narrows candidates BEFORE targets are built — when that narrows a target down to exactly 1 survivor, the conflict is genuinely resolved. **[PoC-proven]** §10.33/§11.8 (and its own honest negative case: a connection that STILL leaves 3 candidates on the same target stays a real conflict — pinning the connection alone does not automatically resolve everything).
- **Bucket-level propagation**: a final bucket (day/week/session/component/athlete/cohort) that depends on any unresolved target is `value: null, conflict: true` with the real candidates attached — never silently dropped (which would let the bucket's OTHER resolved values sum as if nothing were missing) and never a partial/false sum. **[PoC-proven]** §11.7.
- **Unit conflicts** stay structurally separate at every stage (grouped by unit from the very first step) — never blended into one cross-unit number, through the full pipeline including Stage 1/Stage 2. **[PoC-proven]** §7.2/§9.10/§10.10/§11.11.

### §0-R4.4 Built-in series — real workspace scoping, real typed facts

Round 3's `session_count`/`last_session_date` silently re-ran their own `platform`-wide `fetchActivitiesInRange` call, bypassing whatever workspace the CALLER had actually resolved. **Fixed**: `queryBuiltInSeries()` now REQUIRES a caller-supplied `activityIds` (the same already-workspace-scoped set every Metrics-Core series uses) and throws if omitted — there is no other code path. **[PoC-proven]** §11.17 (the SAME athlete, Ana, gets a genuinely different `session_count` in Club A vs Club B), §11.18 (RPE, not just `session_count`, respects workspace scoping end-to-end), §10.13-§10.19 (all 5 workspace types), §11.19 (an `athlete`-workspace query cannot be widened by a caller-supplied `athleteIds` override, through the FULL pipeline — fixed at the SAME time as the built-in refetch bug: `runSeriesPipeline` itself was found, in this round's own review, to still pass the caller's raw `athleteIds` down to the fact-level query functions even after correctly scoping the ACTIVITY set — see "PoC results" below).

`session_count` emits one real fact per canonical activity (`value:1`, tagged with its own real date) — the PIPELINE decides how to count them per bucket, never a pre-aggregated number the adapter cannot re-bucket. `last_session_date` stays a real `text` value end-to-end, never coerced through `Number()`.

### §0-R4.5 Sanctioned writes and the real lock-order contract

**The gap, found by tracing Postgres's own tuple-locking mechanics again, in two NEW places this round:**
1. `update_widget_layout()`'s own TOCTOU: it read+checked the widget's revision BEFORE locking the dashboard, then locked, then updated with no re-check — a genuine race window where another writer's change, landing between the read and the lock, would go undetected.
2. Series writes (`lock_widget_for_series_write`) only ever locked the WIDGET row, never the DASHBOARD — meaning a series write had no shared lock at all against a whole-dashboard operation (`replace_dashboard_layout`, a widget delete), a real gap in the "dashboard → widget → series, always" claim.
3. A raw `DELETE FROM dashboard_widgets` locks the WIDGET first (the delete's own implicit lock), then the dashboard SECOND (via the AFTER trigger) — the reverse of every other sanctioned function's order.

**The fix — `update_widget_layout()` rebuilt to a real 7-step, race-free order:** (1) an unlocked lookup ONLY to find `dashboard_id` — safe because `dashboard_id` is itself immutable; (2) lock the DASHBOARD first, genuinely first; (3) lock AND RE-READ the widget row — the only revision value ever trusted; (4) confirm the widget still belongs to the locked dashboard (defense-in-depth); (5) check the caller's expected revision against THIS fresh value; (6) the UPDATE itself, with an extra revision guard in the `WHERE` clause on top of the row lock already held; (7) return the real, fresh widget AND dashboard revision tokens. **[PoC-proven]** §11.20 — a genuine two-connection race where a widget change lands WHILE the call is queued behind the dashboard lock is still caught; the caller's now-stale expected revision is rejected.

**The full sanctioned-write surface — every one locks dashboard, then widget, before touching its own table**, closing every gap above at once: `create_widget`, `update_widget_content`, `delete_widget`, `add_series`, `update_series`, `delete_series`, `reorder_series`, `update_widget_layout`, `replace_dashboard_layout`, `archive_dashboard` (10 functions total; the two from Round 3 kept, 8 new this round). **Honesty about the boundary, stated as a hard implementation requirement, not a nice-to-have**: this project uses no `SECURITY DEFINER`/DB-role trick to make raw SQL physically impossible — nothing here claims that. What IS proven: these 10 functions are the ONLY entry points with a PROVEN dashboard-then-widget-then-series lock order; the real backend's route layer MUST call exclusively these for every write, never a raw `INSERT`/`UPDATE`/`DELETE`. **[PoC-proven]**: `delete_widget()` vs `replace_dashboard_layout()` never deadlock (§11.21); `update_series()`/`delete_series()` vs a widget type-change never deadlock (§11.22); `update_widget_layout()` vs `replace_dashboard_layout()` never deadlock (§10.28, Round 3, still holds against the rebuilt function).

**Catalog concurrency, also closed with real `FOR SHARE` locks** (`schema.sql`): the first widget referencing a `widget_type`/`dashboard_builtin_series`, and the first series referencing a `metric_definition`/`metric_source_connection`, now takes a `FOR SHARE` lock on that catalog row — a concurrent semantic UPDATE (which needs Postgres's own implicit exclusive lock) genuinely blocks until the first use commits, so the "already in use" check that follows always sees the real, final state, never a torn mid-flight read. **[PoC-proven]** §11.28 (a real two-connection race: the first widget insert and a concurrent `max_series` change on the SAME type — B genuinely blocks, then correctly sees "in use" and is rejected, the real value left completely untouched).

### §0-R4.6 Write-once and archive-atomicity, made real

`owner_scope`/`data_workspace_type`/`data_workspace_scope_id` are now UNCONDITIONALLY immutable from the moment a `dashboards` row exists — Round 2/3 only enforced this "once IN USE" (a widget/selection/clone existed), and the report already CLAIMED write-once while the code let a completely empty, brand-new dashboard's workspace be silently rebound. **[PoC-proven]** §11.23 (rejected even with zero widgets, zero selections, zero clones).

Archiving a dashboard now ATOMICALLY invalidates any existing `dashboard_active_selection` row pointing at it — enforced as a TRIGGER on `dashboards` itself (`dashboards_archive_clears_active_selection`), so the guarantee holds no matter HOW a dashboard becomes archived (the sanctioned `archive_dashboard()` function, or a raw `UPDATE`), never leaving a valid-looking "active dashboard" that actually points at an archived one. **[PoC-proven]** §11.24.

### §0-R4.7 Template binding and the clone-provenance state machine

`template_metric_key_hints` is now a schema-validated JSON array of OBJECTS — `{key, valueType?, unit?, scopeLevel?}` — a bare string element is rejected outright (this schema has never been deployed, so there is no legacy shape to preserve). `resolveTemplateHint()` matches EVERY hint field actually present, never key alone. **[PoC-proven]** §11.25 (bare string rejected), §10.35 (unit mismatch excludes), §10.36/§11.26 (scope-capability mismatch excludes a configured-but-different-scope definition, while a genuinely UNCONFIGURED one is never falsely excluded — the same "never guess from absence" rule the DB's own scope-capability trigger uses).

A series' real state machine is now `resolution_status ∈ {'resolved', 'unresolved', 'ambiguous'}` (`dashboard_widget_series`, `schema.sql`) — `'ambiguous'` additionally carries the real `template_resolution_candidates`. **Cloning now PRESERVES `'unresolved'`/`'ambiguous'` state onto the new, REAL (non-template) dashboard** — Round 2/3's report claimed unresolved series are simply dropped on clone; the task rejects that outright, since it throws away exactly the state a coach needs to see and fix ("Choose a metric"). This is safe because a non-`'resolved'` series can NEVER be queried (the adapter refuses it outright) — a UI-visibility need, never a data-visibility risk. **[PoC-proven]** §11.27 (a real ambiguous binding survives a simulated clone onto a real dashboard, keeps its real candidates, is never auto-picked, and remains fixable).

`cloned_from_dashboard_id`'s own provenance rules: self-clone rejected by a plain CHECK; the immediate parent must be a real `is_template=true` row; a genuine CYCLE (a chain looping back to the row being inserted) is rejected by a bounded walk; write-once from the moment of creation. **Round 2/3's "one hop, never a chain" language is corrected** — a legitimate multi-hop lineage (template → a club's own fork of it → a coach's further personal fork of THAT) is real and accepted; only an actual cycle is rejected. **[PoC-proven]** §10.23 (self-clone/non-template/write-once), §10.24 (a real 2-hop chain accepted, cycle rejected).

### §0-R4.8 Additional query corrections

- `activityId`/`athleteId` filters passed directly into `queryMetricSeries`/`queryBuiltInSeries` are NEVER an authorization boundary on their own — only `fetchActivitiesInRange` (called exclusively by `runSeriesPipeline`, the real entry point) resolves a workspace-authorized activity set; the two fact-level functions only ever NARROW whatever they are handed, by design, and this is stated here explicitly rather than left to be discovered. This is exactly the class of bug §0-R4.4/§11.19 found and fixed in `runSeriesPipeline`'s own wiring.
- `comparison_period='previous_year'` has a real, deterministic leap-day policy: Feb 29 shifted into a non-leap year rolls FORWARD to Mar 1 (via `setUTCFullYear`'s own real JS `Date` semantics) — never a silently wrong Feb 28. **[PoC-proven]** §11.29. The comparison result now returns the CONCRETE `comparisonRange` it actually computed against (`runSeriesPipeline`'s own return shape) — never leaving the caller to reverse-engineer it.
- The canonical activity alias chain is proven non-double-counted through the FULL pipeline this round, not just a raw `canonical_activity_results()` row count. **[PoC-proven]** §9.8 (raw count), §11.30 (through `runSeriesPipeline`, a real numeric value).
- **This remains an explicit PoC-level adapter with per-activity N+1 queries — stated here plainly**: the real backend implementation MUST use a real, set-based, time-bounded query plan. Nothing in `test-harness.mjs` is a production query plan.

### §0-R4.9 Req → test → function traceability, and the honest readiness assessment

Every one of the 30 requirements this round specified, the exact test that proves it, and the real function it actually exercises — never a renamed test claiming to prove something it doesn't:

| # | Requirement | Test | Function(s) actually executed |
|---|---|---|---|
| 1 | Two same-day sessions stay two session buckets | §11.1 | `runSeriesPipeline` → `reduceRows` (session branch) |
| 2 | Two same-session components stay two component buckets | §11.2 | `runSeriesPipeline` → `reduceRows` (component branch) |
| 3 | Day-level event recognized as `'day'`, not defaulted to `'session'` | §11.3 | `queryMetricSeries` (grain derivation) |
| 4 | `week` buckets Monday-Sunday | §11.4 | `reduceRows` → `isoWeekKey` |
| 5 | Two different-day values are not a conflict | §11.5 | `runSeriesPipeline` → `reduceRows` |
| 6 | Two sources on the same target ARE a conflict | §9.7, §11.6 | `queryMetricSeries` (target resolution) |
| 7 | A conflicted target produces no false sum | §11.7 | `reduceRows` (conflict propagation) |
| 8 | Pinning one connection resolves the conflict | §10.33, §11.8 | `queryMetricSeries` + `reduceRows` |
| 9 | standalone + source_rollup, same target, never summed | §11.9 | `queryMetricSeries` (target resolution) |
| 10 | raw + derived, same target, never summed | §11.10 | `queryMetricSeries` (target resolution) |
| 11 | Unit conflict stays separate, no false aggregate | §7.2, §9.10, §10.10, §11.11 | `queryMetricSeries` + `reduceRows` |
| 12 | Historical versions use their OWN daily_aggregation_method | §10.1, §10.4, §11.12 | `queryMetricSeries` (`fetchVersionInfo`) + `reduceRows` |
| 13 | Different historical value_types → type conflict | §11.13 | `reduceRows` (Stage 1 type check) |
| 14 | `last_session_date` returns a real date, never NaN | §11.14 | `queryBuiltInSeries` + `reduceTyped` |
| 15 | `last` deterministic at an identical instant | §11.15 | `reduceTyped` / `compareForLast` (direct unit test) |
| 16 | Invalid aggregation/value-type combo rejected | §11.16 | `reduceTyped` (direct) + `runSeriesPipeline` (surfaced error) |
| 17 | `session_count` isolated per real club workspace | §11.17 | `fetchActivitiesInRange` + `queryBuiltInSeries` |
| 18 | RPE/sRPE/duration respect all 5 workspace types | §10.13-§10.19, §11.18 | `runSeriesPipeline` (full stack) |
| 19 | `athlete` workspace not widened by caller override | §10.16, §11.19 | `runSeriesPipeline` (`effectiveAthleteIds`) |
| 20 | `update_widget_layout()` TOCTOU race rejected | §11.20 | `training_load.update_widget_layout()` (SQL) |
| 21 | `delete_widget()` vs layout: no deadlock | §11.21 | `training_load.delete_widget()` + `replace_dashboard_layout()` (SQL) |
| 22 | Series mutation vs widget type-change: no deadlock | §11.22 | `update_series()`/`delete_series()` + `update_widget_content()` (SQL) |
| 23 | Empty dashboard cannot change workspace | §11.23 | `protect_dashboard_ownership_once_used()` trigger (SQL) |
| 24 | Archive invalidates active selection | §11.24 | `dashboards_archive_clears_active_selection()` trigger (SQL) |
| 25 | Bare-string hint rejected | §11.25 | `validate_template_metric_key_hints_shape()` trigger (SQL) |
| 26 | Scope hint + no capability stays unresolved | §10.36, §11.26 | `resolveTemplateHint` |
| 27 | Ambiguous binding survives clone, stays fixable | §11.27 | `add_series()` (SQL) + `resolveTemplateHint` |
| 28 | Catalog first-use race gives a consistent outcome | §11.28 | `dashboard_widgets_validate_layout()` (`FOR SHARE`) + `protect_dashboard_widget_types_once_used()` |
| 29 | `previous_year` leap-day policy defined | §11.29 | `shiftDateRange` (direct unit test) |
| 30 | Canonical alias not double-counted | §9.8, §11.30 | `runSeriesPipeline` (full stack) |

**All 116 tests pass, three consecutive runs, disposable database confirmed dropped every time (including a deliberately-forced mid-`seed()` failure this round, to directly verify the failure-path cleanup guard), zero leftovers, no hardcoded credentials.**

**A real safety-guard gap found and fixed in THIS round's own review, before it could ship**: the forbidden-database guard only ever checked the GENERATED disposable database's own name/URL (which can structurally never equal a forbidden name — it always carries a random suffix) — it never checked the CALLER's own `DATABASE_URL`. Pointing this harness's `DATABASE_URL` directly at a database literally named `OPTIMOVE` was silently ALLOWED to proceed (it never wrote to that database's own tables — every real operation targets a freshly created, separately-named disposable database on the same server — but the guard's own stated purpose is to refuse this by name, outright, before any connection is attempted). Fixed: the guard now also checks `DATABASE_URL`'s own database name/URL, checked immediately at module load, before any connection is opened. Verified live: pointing `DATABASE_URL` at `OPTIMOVE` now fails immediately with `SAFETY: refusing to run against a forbidden database name/url`.

**Explicitly NOT ready, stated plainly rather than papered over — carried forward from Round 3, still true, plus what this round adds:**
- Route-level authorization still does not exist (unchanged from every prior round).
- The 10 sanctioned write functions (§0-R4.5) are the ONLY proven-safe entry points — the real backend's route layer must call exclusively these; this is a hard requirement, not a suggestion.
- `queryMetricSeries`/`queryBuiltInSeries` do not themselves enforce workspace authorization when handed `activityIds` directly (§0-R4.8) — only `runSeriesPipeline`'s own use of `fetchActivitiesInRange` does. A real backend service must never expose a code path that calls the fact-level functions with caller-supplied `activityIds` bypassing that resolution.
- This adapter's per-activity N+1 query pattern is explicitly not a production query plan (§0-R4.8, restated from Round 3, still true and still important).
- Boolean built-in aggregation (`any`/`all`/`count_true`) is explicitly NOT implemented — `boolean`/`text` series are hard-limited to `last`/`none` this round; if a future requirement needs richer boolean rollups, that is new work, not a hidden gap in what's claimed here.
- A true "one bucket per real roster team" grouping does not exist — `group_by='cohort'` merges the CURRENT SELECTION of athletes, never a real team_id join. Naming it honestly (`cohort`, not `team`) is this round's own fix for a claim the model could not actually back.
- A real `unit_policy`/conversion engine still does not exist (unchanged since Round 2).

This section's purpose, restated from Round 3: everything above the "Explicitly NOT ready" line is safe to build real migrations and routes on top of; everything below it is a known, named gap to close during implementation, not a surprise to discover later.

---

## §0-R3. Round 3 (final corrective pass) — what changed, and why

This round's own corrective task was explicit about its central risk: **"nemoj proglasiti model spremnim samo zato što su testovi zeleni."** §0-R3.9 below is written to honor that literally — it is not a summary of what passed, it is an audit of what is and is NOT genuinely executed.

### §0-R3.1 Two-stage aggregation — the central fix

**The gap.** Round 2's `dashboard_widget_series.aggregation_method` was forced, by a trigger, to equal the underlying metric's own `metric_definition_versions.daily_aggregation_method`. This was wrong: it conflated two genuinely different concepts into one column and one equality rule.

**The fix — two independent stages, now real, separately-named columns:**

| Stage | Column | Meaning | Mutable per-series? |
|---|---|---|---|
| **1 — daily reduction** | `metric_definitions.daily_aggregation_method` (unchanged, real Metrics Core column) | The metric's own fixed, natural same-day reduction (e.g. Total Distance is always naturally summed within one day) | No — a fact about the metric itself |
| **2 — analytical aggregation** | `dashboard_widget_series.analytical_aggregation` **[R3, renamed from `aggregation_method`]** | How THIS widget reduces the (already day-reduced when needed) values across whatever `group_by` bucket it uses | **Yes — freely chosen per series** |

The Round 2 equality trigger (`dashboard_widget_series_validate_aggregation`) is **deleted**, not merely relaxed — replaced with an explanatory comment in `schema.sql`. The literal example the task required is now real and PoC-proven: the SAME "Total Distance" metric (`daily_aggregation_method='sum'`) backs one widget showing a weekly sum, another a per-training average, another a per-training max, and another every individual activity unaggregated — **[PoC-proven]** §10.1–§10.5, asserting the actual final NUMBERS (150/80, 230, 115, 150 again under `max`, `[150,80]` under `none`), never just row counts. §10.4 is the sharpest proof: Stage 2 set to `'max'` still shows a day-bucket of 150 (the Stage-1 SUM), never `max(100,50)=100` — proving the two stages are genuinely sequenced, not merged.

The **real 9-step pipeline** the task required is implemented AND executed, end to end, by `runSeriesPipeline()` in `test-harness.mjs`, built on top of — never reimplementing — `queryBuiltInSeries()`/`queryMetricSeries()` (which themselves stay built on the real, unmodified `training.canonical_activity_results()`):

| Step | What actually runs | Where |
|---|---|---|
| 1. Canonical/effective facts | `training.canonical_activity_results()` (unmodified) | `fetchCanonicalFacts` |
| 2. Workspace + series filters | 5-type workspace scoping (§0-R3.2) + role/coverage/source-policy filters (§0-R3.5) | `fetchActivitiesInRange`, `queryMetricSeries` |
| 3. Prevent double-count | `data_scope_level` equality (component XOR session — unchanged mechanism from Round 2, now proven through the FULL pipeline, not just the raw adapter) | `queryMetricSeries`, **[PoC-proven]** §10.9 |
| 4. Group by unit | Real, structurally SEPARATE `groups[]` per distinct unit — never one array with just a flag | `queryMetricSeries`, **[PoC-proven]** §10.10 |
| 5. Daily reduction | `metric_definitions.daily_aggregation_method`, collapsing same-calendar-day raw facts | `reduceRows`, **[PoC-proven]** §10.1 |
| 6. Dashboard grouping | `group_by` ∈ {day,session,component,athlete,team} — `'team'` genuinely merges ACROSS athletes, not just relabels a per-athlete bucket | `reduceRows`, **[PoC-proven]** §10.6, §10.7, §10.12 |
| 7. Analytical aggregation | `analytical_aggregation`, Stage 2 | `reduceRows`, **[PoC-proven]** §10.2–§10.5 |
| 8. Comparison period | Real shifted-date-range re-run of the WHOLE pipeline (`shiftDateRange` + a second `runForRange` call) — never a guessed offset | `runSeriesPipeline`, **[PoC-proven]** §10.8 |
| 9. Conflict metadata | `unitConflict`/`conflict` carried through every stage to the final bucketed result | `reduceRows` |

### §0-R3.2 Full 5-type workspace filtering

**The gap.** Round 2's query adapter only ever implemented `club`/`team` filtering; `platform`/`private_coach`/`athlete` silently fell through to `scopeSql = 'true'` (an accidental unrestricted default) wherever they were reached at all.

**The fix.** `fetchActivitiesInRange()` now requires an EXPLICIT, recognized `dataWorkspaceType` — an unrecognized or missing value is a thrown error, not a silent fallback (**[PoC-proven]** §10.19). All 5 types are genuinely implemented, each against the correct real column shape:

| Workspace type | Real filter | Basis |
|---|---|---|
| `platform` | none (deliberately, explicitly unrestricted) | An explicit opt-in, matching `resolveActiveWorkspace`'s own real "platform admin sees everything" semantic — never reached by omission (**[PoC-proven]** §10.13) |
| `club` | `training.activities.owner_scope='club' AND owner_club_id=...` | unchanged from Round 2 |
| `team` | `owner_scope='team' AND owner_team_id=...` | now actually exercised against a real team-owned activity fixture (Round 2's fixture had none) (**[PoC-proven]** §10.14) |
| `private_coach` | `owner_scope='user' AND owner_user_id=<the coach>` | owner-based, NEW (**[PoC-proven]** §10.15, §10.17) |
| `athlete` | participant-based (`activity_participants`), NOT owner-based, and ignores any caller-supplied `athleteIds` — always forced to the current viewing athlete | structurally different from every other type, matching `dashboards.data_workspace_scope_id` being NULL for `athlete` (resolved from the CURRENT viewer, never baked into the row) (**[PoC-proven]** §10.16 |

**The dual-role/"other relation" risk, closed with a real fixture, not just documentation:** `privateCoach` has a genuine `public.user_athletes` relationship to Marko, a real Club A/Team A roster athlete — §10.17 proves that querying `private_coach` workspace with `athleteIds:[marko]` returns **zero** activities, because workspace visibility is owner-based, never relationship-based. The metric/source-connection visibility triggers' own "dashboard owner's private catalog" carve-out (§0.1 below, unchanged) is workspace-TYPE-agnostic by construction (it never reads `data_workspace_type` at all) — §10.18 proves this does NOT mean `platform` leaks club-scope data: a private coach's `platform`-bound dashboard sees their own private metric but is rejected outright for Club A's club-scoped one.

### §0-R3.3 Mutable-parent holes closed

| Field | Rule | Why | Proof |
|---|---|---|---|
| `dashboard_widgets.dashboard_id` | Immutable after INSERT | A raw UPDATE moving a widget to another dashboard would bypass every dashboard-scoped invariant (visibility, overlap, cap, axis, revision) this file builds | §10.20 |
| `dashboard_widget_series.widget_id` | Immutable after INSERT | Same reasoning, one level down | §10.21 |
| `dashboards.created_by_user_id` | Unconditionally immutable (not just "once in use") | An identity/audit field, not content | §10.22 |
| `dashboards.cloned_from_dashboard_id` | Write-once (decided only at INSERT, never changeable after), self-clone rejected by CHECK, must reference a real `is_template=true` row, provenance cycle rejected by a bounded walk | `cloned_from_dashboard_id` claims to represent template lineage — every one of these was a real, exploitable gap in Round 2's shape | §10.23, §10.24 |
| `dashboard_widget_types` (min/max width/height, max_series, has_shared_axis, supports_comparison_period) | Immutable once ANY widget references the type | Round 2 reasoned shrinking was "harmless" because nothing retroactively re-validated existing rows — the task explicitly rejects that framing; `is_active`/`label`/`default_width`/`default_height` stay freely mutable | §4.6 (max_series), §10.25 (has_shared_axis, supports_comparison_period) |

### §0-R3.4 Revision/cache contract reconciled — and a real deadlock risk found and fixed

**The gap, found by tracing through Postgres's own locking mechanics, not by testing alone:** Round 2 deliberately excluded widget position/size (layout) changes from bumping `dashboards.revision`, reasoning that only the WIDGET's own revision needed to move. Round 3 requires layout changes to ALSO bump `dashboards.revision` (it is the cache token for the whole rendered grid, not just widget-set membership). Naively extending the existing per-row trigger to call `bump_dashboard_revision()` on every layout UPDATE introduces a genuine, provable deadlock risk: **Postgres locks an UPDATE's own target row (via `GetTupleForTrigger`) BEFORE any BEFORE-ROW trigger body runs** — so a raw `UPDATE dashboard_widgets SET x=... WHERE id=X` locks the WIDGET row first, then (via the trigger) tries to lock the DASHBOARD row second — the exact reverse of `replace_dashboard_layout()`'s own dashboard-then-widget order. Two such operations running concurrently on the same dashboard form a genuine AB-BA cycle.

**The fix, two parts:**
1. `dashboard_widgets_bump_revision` is restructured to distinguish LAYOUT fields (x/y/width/height/mobile_order — bump BOTH this widget's revision AND, via `bump_dashboard_revision`, the dashboard's) from CONTENT fields (widget_type/title/group_by/state/display_config/local_filter_override — bump only the widget's own revision, unchanged from Round 2).
2. A NEW, genuinely deadlock-safe single-widget entry point, `training_load.update_widget_layout()`, explicitly locks the DASHBOARD row first (its own `SELECT ... FOR UPDATE`, before touching `dashboard_widgets` at all) and only then updates the widget — real dashboard-then-widget ordering, matching `replace_dashboard_layout()`. **[PoC-proven]** §10.27 (returns a fresh widget_revision AND dashboard_revision from one call) and, the critical proof, §10.28: `update_widget_layout()` and `replace_dashboard_layout()` running concurrently on the SAME dashboard genuinely queue behind each other's dashboard-row lock and **never deadlock** — a real two-connection lock-wait proof, not a timing guess.

**Honesty about the boundary this leaves:** the existing per-row trigger (`dashboard_widgets_lock_dashboard_before_layout_write`) is kept, and its comment now says plainly that it achieves true dashboard-first ordering only for an INSERT, not an UPDATE — a raw ad-hoc `UPDATE dashboard_widgets SET x=...` remains functionally correct (both revisions still end up bumped) but is **not proven deadlock-safe** against `replace_dashboard_layout()`/`update_widget_layout()`. The real application's route layer must use only the two sanctioned functions for any layout write — this is stated as a hard implementation requirement in §0-R3.9, not left implicit.

`replace_dashboard_layout()`'s own `RETURNS TABLE` now includes `dashboard_revision` alongside each widget's own `revision` — the caller gets both fresh tokens from the one call, matching the task's "mora vratiti stvarni novi revision token" requirement.

### §0-R3.5 Template metric binding fixed

`template_metric_key_hints` accepts a richer shape — `{ key, valueType?, unit?, scopeLevel? }`, not just a bare key string (a bare string is still accepted for backward compatibility and simply skips the extra checks). `resolveTemplateHint()` now filters candidates by EVERY hint field actually present, never key alone: a unit mismatch excludes an otherwise key-matching, visibility-matching candidate (**[PoC-proven]** §10.35); a `scopeLevel` mismatch excludes a metric configured ONLY for a different scope capability, while an UNCONFIGURED metric (no capability rows at all) is never falsely excluded — the same "never guess from absence" rule `dashboard_widget_series_validate_scope_capability` itself already uses (**[PoC-proven]** §10.36). Visibility filtering (system / same-data-workspace club-or-team / the resolving user's own private catalog) is unchanged from Round 2 and is what already guarantees another user's private metric UUID can never leak through a template — the richer field-matching only ever NARROWS the candidate set further, never widens it.

### §0-R3.6 Source-connection visibility fixed

`dashboard_widget_series_validate_source_connection_visibility` had no branch at all for `owner_scope='user'` connections — any private coach's own import connection was unconditionally rejected, even on their own dashboard. Fixed with the identical carve-out `dashboard_widget_series_validate_metric_visibility` already uses for a coach's own private metric catalog: a `'user'`-scope connection is visible on a `'user'`-owned dashboard **only** when it belongs to that SAME dashboard's own owner — never merely compared against the data-workspace scope id, and never another private coach's connection.

### §0-R3.7 Other integrities

- `dashboard_active_selection` now rejects selecting an `archived` dashboard outright (**[PoC-proven]** §10.26).
- `source_policy` gained `'not_applicable'`, legal ONLY for a built-in series (RPE/sRPE/duration) and REQUIRED for one — `'manual'` is no longer accepted for a built-in (it wrongly implied "a human chose to enter this instead of importing it", a distinction built-ins have none of). `queryMetricSeries()` (the Metrics-Core path) actively REJECTS `'not_applicable'` outright (**[PoC-proven]** §4.5, §10.34).
- `source_policy` is now genuinely, distinctly EXECUTED for every declared value — `manual`/`api_import`/`csv_import` (real `entry_method` equality), `source_connection` (a real extra join to `metric_events.source_connection_id`, on top of — never reimplementing — `canonical_activity_results()`), `derived` (`metric_values.is_derived`) — each proven to return a real, DIFFERENT, correct numeric result set from a shared fixture with genuinely distinct rows per policy (**[PoC-proven]** §10.29–§10.33).
- `metric_structure_links`' own nullable/domain-only/category-only semantics are completely untouched by this round — no edit anywhere in `schema.sql` touches that table or its trigger.
- Widget-type-change re-validation (series cap, axis-unit, comparison_period) is unchanged from Round 2 and still correct; metric/source-connection VISIBILITY is invariant to `widget_type` by construction (it depends only on the dashboard's data workspace, never the widget's own type), so no additional re-validation trigger was needed there — stated explicitly rather than left to be inferred.

### §0-R3.8 The 36 new required tests

Organized exactly as the task specified — Query results (§10.1–§10.12), Workspace isolation (§10.13–§10.19), Integrity and revision (§10.20–§10.28), Binding/source (§10.29–§10.36) — see "PoC results" below for the full run record. Every existing Round 1/2 test (§1–§9, 50 of them) still passes unchanged in meaning; the handful whose FIELD NAMES or EXPECTED BEHAVIOR changed (`aggregation_method`→`analytical_aggregation`, built-in `source_policy` `'manual'`→`'not_applicable'`, the `max_series`-shrink-is-harmless case in §4.6) were updated in place to match the new, corrected contract — never left silently asserting the old, now-wrong behavior.

### §0-R3.9 Honest readiness assessment — required verbatim by the task, not a formality

**All 86 tests pass, three consecutive runs, disposable database confirmed dropped every time, zero leftovers, no hardcoded credentials, the safety guard intact.** That is necessary, but per the task's own explicit instruction, **it is not sufficient to declare this model ready** — here is what genuinely is, and is not, true underneath the green checkmarks:

**Genuinely implemented and executed (not just accepted config):**
- Two-stage aggregation, all 5 workspace types, `group_by` (including the real cross-athlete `'team'` merge), `analytical_aggregation`, `source_policy` (all 7 named values, each with distinct real behavior or an explicit rejection for `'not_applicable'`), `source_connection_id` pinning, `comparison_period` (real shifted-range re-computation), the richer template-hint shape, every immutability rule listed in §0-R3.3, and the deadlock-safe layout-write pair.

**Explicitly NOT ready, stated plainly rather than papered over:**
- **Route-level authorization remains entirely unbuilt**, exactly as Round 1/2 already disclosed (§ "what this PoC does not prove," unchanged) — the DB-level data-workspace correctness this round hardens is necessary but not sufficient; a real route layer must call `resolveActiveWorkspace`/an equivalent scope check on every request, never trust a cached grant.
- **`update_widget_layout()`/`replace_dashboard_layout()` are the ONLY proven-safe layout-write entry points.** This is a real constraint the application MUST honor: the real backend's route layer must call exclusively these two functions for any position/size/mobile_order change — a raw `UPDATE dashboard_widgets` remains functionally correct but is not proven deadlock-safe under concurrency with them. This is a genuine, non-optional implementation requirement, not a nice-to-have.
- **`comparison_period`'s real backend wiring (the route that calls `runSeriesPipeline`'s comparison branch and returns both numbers to the frontend) does not exist yet** — the PoC proves the COMPUTATION is real and correct; the API surface that exposes it is still Section 8's design-only contract, unchanged from Round 2.
- **The 'athlete' workspace's "current viewing athlete" resolution** (`athleteWorkspaceAthleteId` in this PoC) is a parameter the harness's own tests supply directly — the real equivalent (resolving the logged-in user's own athlete profile) is application code, not exercised here.
- **No option was found this round that is declared in the schema/API contract but NOT genuinely executed by the adapter** — every column added or renamed this round (`analytical_aggregation`, `source_policy`'s new/renamed values, `group_by='team'`, `comparison_period`) has a real, tested, numerically-verified code path. Where an early draft of this round's own adapter had a genuinely unexecuted gap (`group_by='team'` was, briefly, only a relabeled copy of `'athlete'` bucketing, caught before this report was written — see `reduceRows`'s own comment in `test-harness.mjs`), it was fixed to be REAL, not removed from the contract, because implementing it correctly was straightforward and already proven safe.
- **A real `unit_policy`/conversion engine still does not exist** — unchanged from Round 2, still deliberately not even hinted at in the schema.

This section's purpose is to make the NEXT reviewer's job easy: everything above the "Explicitly NOT ready" line is safe to build real migrations and routes on top of; everything below it is a known, named gap to close during implementation, not a surprise to discover later.

---

## §0. Round 2 — what changed, and why

### §0.1 Owner-vs-data-workspace separation (task item 1)

**The gap.** Round 1 used `dashboards.owner_scope` for two genuinely different jobs at once: who may see/edit/clone the dashboard, AND which workspace's data it may read. This broke the common case: a coach's own PRIVATE dashboard, viewed while acting in Club A, needs to read Club A's metrics/activities — but Round 1's visibility trigger only ever let a `user`-scope dashboard see `system` metrics or that SAME user's own private metrics, never a club's. Relaxing that trigger naively would have opened a cross-workspace leak (any private dashboard could then read ANY club's data).

**The fix — two independent concepts, both real columns on `dashboards`:**

| Concept | Columns | Governs |
|---|---|---|
| **Ownership** (unchanged shape) | `owner_scope` ∈ {system,club,team,user} + one owner id | Who may see/edit/clone/archive this dashboard row |
| **Data workspace** (NEW) | `data_workspace_type` ∈ {platform,private_coach,club,team,athlete} + `data_workspace_scope_id` | Which workspace's metric_definitions/source_connections/activities/athletes this dashboard's widgets may ever reference |

Rules (all **[PoC-proven]**, §1.1–§1.8 in the harness):
- A **`user`-owned** (private) dashboard picks exactly ONE data workspace, **write-once** (immutable the moment any widget/active-selection/clone exists under it — the same "protect once used" trigger that already governed `owner_scope`). The same coach may have several different private dashboards, each bound to a different data workspace (§1.5).
- A **`club`/`team`-owned** dashboard's data workspace is *forced* to be that exact same club/team — no independent choice, enforced by a plain same-row CHECK (§1.7).
- A **`system`-owned** dashboard is *always* a template (`owner_scope='system' ⇒ is_template=true`, enforced by CHECK) and its data workspace is *always* `NULL` (workspace-agnostic) until cloned (§1.8) — cloning is where a concrete data-workspace snapshot is first assigned.
- Widget-series **metric visibility** now checks the dashboard's **data workspace**, not `owner_scope` directly — so a private Club-A-bound dashboard now correctly sees Club A's own club metrics (a real capability round 1 didn't have) *in addition to* the coach's own private catalog and system metrics, but still never Club B's (§1.1, §1.2, §4.4 for source connections too).
- **Active dashboard selection** (`dashboard_active_selection`) now requires the selected dashboard's data workspace to **exactly equal** the selection's own `workspace_type`/`scope_id` — not "visible by owner_scope" as Round 1 had it. A private dashboard bound to Club A's data can never be selected as active while viewing Club B (§1.2) — this is the direct, literal fix for the task's own example.
- **Losing a workspace role never deletes or hides the dashboard row** — the schema has no mechanism that could do that, by design (§1.6). Blocking *use* (selection/query/edit) while a role is revoked is **entirely an application-layer requirement** — see "what this PoC does not prove" below. The task's explicit instruction not to treat `user_workspace_preferences` as a security boundary is honored by construction: this schema never reads that table for any authorization decision at all, in either round.

### §0.2 Series query semantics — now real, normalized columns (task item 2)

`dashboard_widget_series` gained 5 new normalized columns, each independently validated:

| Column | Values | Validated against |
|---|---|---|
| `data_scope_level` | day / session / component | For a metric-based series: soft-checked against `metric_definition_scope_capabilities` when any exist (§2.4-adjacent). For a built-in series: **fixed** by the catalog (`dashboard_builtin_series.fixed_data_scope_level`) — never a per-widget choice (§2.4). |
| ~~`aggregation_method`~~ **[R3: renamed & reworked, see §0-R3.1]** | sum / avg / max / last / none | **This row is superseded.** Round 2's equality-with-the-metric's-own-method rule is REMOVED in Round 3 — the column is renamed `analytical_aggregation` and is now a freely-chosen Stage 2 reduction, deliberately independent of the metric's own fixed `daily_aggregation_method` (Stage 1). See §0-R3.1 for the full two-stage model and its proof. |
| `aggregation_role_policy` | standalone_only / standalone_and_source_rollup / all_including_derived | Named policies mapping directly onto `metric_values.aggregation_role`'s real value set — never a free-text/undefined convention (§2.2, exercised for real by the query adapter in §9.4/§9.9). |
| `coverage_policy` | complete_only / complete_and_partial / any | Same shape, mapping onto `metric_values.coverage` (§2.2, §9.9). |
| `comparison_period` | previous_period / previous_year / NULL | Only settable on a widget type that declares `supports_comparison_period` (KPI, in this phase) — genuinely changes the query (two period ranges), so an incompatible setting is refused outright, not silently ignored (§2.3). |

`display_config` (JSONB, cosmetic-only) now requires a `schemaVersion` integer key by CHECK — an unversioned blob is refused at INSERT time (§2.5). The exact per-`widget_type` shape under that key is documented here, not DB-enforced field-by-field: a **future application-layer validator**, one per widget type, must reject an unrecognized `schemaVersion` by falling back to defaults and surfacing a "review this widget's display settings" notice — never crash, never silently misrender. An unrecognized *key* inside a *known* `schemaVersion` is ignored (forward-compatible/additive). `source_policy` (unchanged from Round 1) already fully covers "how to treat conflicting values" — a separate `conflict_handling` column was considered and rejected as redundant with it.

### §0.3 Revision and cache identity — fixed (task item 3)

| Event | Round 1 | Round 2 |
|---|---|---|
| Widget added/removed | ❌ no dashboard revision bump | ✅ `dashboards.revision` bumps (AFTER INSERT/DELETE trigger on `dashboard_widgets`) |
| Series added/updated/deleted/reordered | ❌ nothing bumped | ✅ the PARENT WIDGET's `dashboard_widgets.revision` bumps (AFTER trigger on `dashboard_widget_series`) |
| `widget_type` changed | ❌ missing from the widget's own revision-bump field list | ✅ included |
| `replace_dashboard_layout()` batch save | (didn't exist) | ✅ bumps `dashboards.revision` once per call (its own concurrency token — see §0.4) *in addition to* each touched widget's own revision bumping individually via the ordinary per-row trigger |

**Final cache-key contract:** a dashboard's rendered STRUCTURE (which widgets exist, in what layout) is keyed by `dashboards.revision`; each individual widget's own CONTENT (series, display config, non-layout fields) is keyed by that widget's own `dashboard_widgets.revision`. A consumer caching "the whole dashboard" uses `(dashboardId, dashboards.revision)`; a consumer caching one widget's query result uses `(widgetId, dashboard_widgets.revision, resolved filter)`. Two edits to two *different* widgets never produce a false optimistic conflict (their revisions are independent — **[PoC-proven]** §3.4, with a real two-connection lock-wait proof, not a timing guess); two edits to the *same* widget with the same stale revision give exactly one success and one controlled conflict (**[PoC-proven]** §3.5).

### §0.4 Lock order — now explicit and consistent (task item 5)

**The order, everywhere in this subsystem: DASHBOARD → WIDGET → SERIES.**

- Any write that validates a **widget-set-wide** invariant (layout overlap) locks the **dashboard** row first (`dashboard_widgets_lock_dashboard_before_layout_write`, a `SELECT ... FOR UPDATE` on `dashboards`) — a brand-new dashboard's very first widget has no sibling widget row to lock, so locking only widgets would let two concurrent "first widget" inserts both pass; locking the dashboard closes that (**[PoC-proven]** §6.1).
- Any write that validates a **series-set-wide** invariant (max-series cap, axis-unit compatibility) locks the **widget** row first (`training_load.lock_widget_for_series_write`) before reading sibling series rows (**[PoC-proven]** §5.1 cap, §5.2 axis-unit — both with real two-connection lock-wait proofs).
- A `widget_type` change (which itself already holds the widget row's own lock, being an UPDATE of that row) and a concurrent series insert against the SAME widget (which explicitly locks the same widget row) always serialize through that ONE shared lock — proven deadlock-free, deterministic, sequential (**[PoC-proven]** §5.3).
- `replace_dashboard_layout()` locks the dashboard first, exactly like every other layout writer — a concurrent plain widget UPDATE against the same dashboard is provably blocked behind it, not racing it (**[PoC-proven]** §6.6).

Because the order is always the same direction (never widget-then-dashboard, never series-then-widget), no cycle — and therefore no deadlock — is structurally possible across any combination of these operations.

### §0.5 Atomic layout replace (task item 6)

**The gap.** Round 1's overlap check was an immediate `BEFORE` trigger — so a legitimate swap (A moves to B's old spot, B moves to A's old spot) failed on the FIRST individual `UPDATE`, which alone is a real overlap, even though the final state is valid.

**The fix.** The overlap check is now a genuine Postgres **`DEFERRABLE INITIALLY DEFERRED` constraint trigger** (`dashboard_widgets_check_no_overlap`) — it re-scans the WHOLE dashboard's widget set and only runs once, at the end of the transaction (or explicitly earlier, see below) — so a multi-`UPDATE` swap or rearrange within one transaction is checked only on its FINAL state, never an intermediate one. Serialization against *concurrent* writers is still guaranteed by the immediate dashboard-row lock (§0.4) — the deferred check only defers *when the overlap rule is evaluated*, never *whether concurrent writers wait for each other*.

`training_load.replace_dashboard_layout(dashboard_id, expected_revision, layout jsonb)` is the one sanctioned atomic entry point: locks the dashboard, checks `expected_revision` (raising a clear `stale revision` exception, SQLSTATE `40001`, on mismatch — **[PoC-proven]** §6.5), applies every widget's new position/size/mobile_order in one loop, then explicitly runs `SET CONSTRAINTS ... IMMEDIATE` to force the deferred overlap/uniqueness checks to run **inside this function's own transaction scope** rather than silently deferring to whatever the caller's outer transaction happens to do next — so a caller always gets an immediate, synchronous success-or-failure from this one call, all-or-nothing (**[PoC-proven]**: plain swap §6.2, 3+-widget rearrange §6.3, rejected final overlap with full rollback §6.4, lock order §6.6). A caller MAY still write `dashboard_widgets` directly for a single-widget change — the same deferred constraint protects that path too, checked at that statement's own ordinary transaction commit.

**Mobile Move-up/Move-down** (report UX spec, updated below) now goes through this SAME function — a batch of reorder steps is one `replace_dashboard_layout()` call (mobile_order-only entries), never a sequence of independent PATCH requests that could be left half-applied.

### §0.6 Reverse invariants closed (task item 4)

- **Template flip guard**: `is_template` cannot flip `true → false` while any of the dashboard's widgets still carries an unresolved (hints-only) series — closed from the PARENT side, matching the existing INSERT-side guard on the series itself (**[PoC-proven]** §4.1).
- **`widget_type` change re-validation**: switching Table→KPI re-checks the max-series cap against the widget's EXISTING series (§4.2); switching into a chart type re-checks axis-unit compatibility against existing series (§4.3); switching away from KPI is blocked if an existing series still has `comparison_period` set (§2.3).
- **Source-connection visibility**: a `source_connection_id` must be visible to the dashboard's data workspace, mirroring metric visibility exactly — Club B's connection is rejected on a Club-A-bound dashboard (§4.4).
- **Built-in source-policy restriction**: RPE/sRPE/duration (and the two new built-ins) can only ever use `source_policy='not_applicable'` **[Round 4 correction — was wrongly still stated as `'manual'` here; the real, current contract is `'not_applicable'`, see §0-R3.7]**, with no `source_connection_id` — `source_connection`/`api_import`/`csv_import`/`manual` are structurally meaningless for a fact that only ever comes from `session_feedback` (§4.5).
- **Catalog immutability, both directions, both proven**: (a) child-first — once a series references a built-in, its unit/value_type/aggregation/scope semantics become immutable (§4.6); (b) parent-change-first — deactivating a widget type blocks NEW widgets of that type but an EXISTING widget of that type can still be resized/edited (never broken by the deactivation), and shrinking a type's `max_series` never retroactively strips an existing widget's already-larger series set, only blocks adding more (§4.6, both directions asserted in one test).

### §0.7 Historical units and versions (task item 7)

**Policy, stated plainly and only claiming what is actually built:** the config-time axis-unit check (§0.2 table) uses the metric's **CURRENT** version's unit — it is a real, useful guard against an obviously wrong NEW configuration, but it is explicitly **advisory only**, documented here as insufficient on its own, because a metric's unit can legitimately change between versions (`metric_definition_versions.unit`) while historical `metric_values.unit_at_capture` rows keep whatever unit was true when they were captured. **No silent unit conversion exists anywhere in this proposal** — there is no reviewed, correct conversion engine to build one on, and the task explicitly forbids claiming one. Instead, the PoC query adapter itself carries the real behavior: when a query period's result set for one series spans more than one distinct `unit_at_capture`, the adapter returns `unitConflict: true` with the values grouped by their own real unit — never a single, silently-blended or mislabeled number (**[PoC-proven]** §7.2, §9.10, using a real fixture: distance v1 in meters on 2026-09-09, the SAME definition's v2 in kilometers on 2026-09-10, one query period covering both). A future `unit_policy`/`presentation_unit` column is a plausible extension point for a REAL conversion engine later — deliberately **not added to `schema.sql` this round**, so nothing in the schema itself implies a conversion capability that does not exist. `metric_definition_version_id` on `metric_values` is never reinterpreted by a later/archived version — the adapter always reads `unit_at_capture` off the value row itself, never re-derives it from the metric's current version.

### §0.8 Default template contract fixed (task item 8)

Two built-in series were added so the "Athlete overview" template (report §7) is genuinely materializable, exactly as the report already claimed: `session_count` (day-scope rollup: distinct canonical activities per athlete per day) and `last_session_date` (day-scope rollup: latest `occurred_local_date`) — both computed by the query adapter directly from `training.activity_participants`/`training.activities`, never from `metric_values` or `session_feedback` (**[PoC-proven]** §8.1).

**Safe template-hint resolution**, implemented as `resolveTemplateHint()` in the harness (a real, working PoC function, not just a description): tries each hint key in order; for each key, finds every metric_definition matching that key that is actually **visible** to the target data workspace (same visibility rule as §0.1, applied without ever touching the DB's own enforcement trigger — this is a pre-check the real clone service would run before ever attempting the INSERT); zero candidates → try the next hint key; exactly one candidate → resolved; **more than one equally-valid candidate → `needs_resolution`, never an arbitrary pick** (**[PoC-proven]** §8.2, using a deliberately ambiguous fixture: the same key `poc-ambiguous-load` exists as both a system-scope AND a Club-A-scope definition — cloning into Club A correctly returns both candidates and does not choose; cloning into Club B, which cannot see the Club-A one, correctly resolves to the single visible candidate — §8.3).

### §0.9 A real PoC query adapter (task item 9) — the query semantics table

Round 1's PoC mostly proved *storage* (config exists, FKs are valid). Round 2 adds a genuinely working query layer, `queryBuiltInSeries()`/`queryMetricSeries()`/`fetchActivitiesInRange()`/`runBatchQuery()` in `test-harness.mjs`, built **on top of** — never re-implementing — the real, unmodified `training.canonical_activity_results()` function, so alias resolution, the effective-occasion predicate, and RPE/metric fact shapes are never re-derived, only filtered/grouped by each series' own policy columns from §0.2. This is explicitly a **PoC-level adapter** — the real backend implementation will formalize this as actual service code later; nothing here is application code being added this round.

| Series own config | What the adapter does with it | Proven by |
|---|---|---|
| `built_in_series_key` (rpe/srpe/duration_minutes) | Reads `session_feedback` via the canonical activity's own resolved RPE fact — never `metric_values` | §9.1 |
| `built_in_series_key` (session_count/last_session_date) | Rolls up `training.activity_participants`/`activities` directly — never `metric_values`/`session_feedback` | §8.1 |
| `data_scope_level='session'` vs `'component'` | Filters canonical `metric_value` facts by `detail.segmentId` presence — a session-scope query NEVER returns a component's own standalone value, and vice versa | §9.2, §9.3 |
| `aggregation_role_policy` | Filters by `detail.aggregationRole` — a session-level `source_rollup` and that SAME session's own component-level `standalone` reading are never summed together, at any policy setting, because scope filtering happens BEFORE role filtering | §9.4, §9.9 |
| `coverage_policy` | Filters by `detail.coverage` — genuinely changes which rows appear, not merely accepted config | §9.9 |
| effective-value predicate | Only occasions with `superseded_by_occasion_id IS NULL AND import_conflict_status IS NULL` (the exact predicate `canonical_activity_results()` itself already applies — never re-derived independently) | §9.5, §9.6 |
| 2+ effective values, same athlete/metric/scope | Returned as a `conflict: true` payload with every value, never an auto-picked winner | §9.7 |
| canonical alias chain (a real `training.merge_activity_participants()` call) | The merged alias's own fact resolves through `canonical_activity_results()` exactly once | §9.8 |
| mixed historical `unit_at_capture` in one period | `unitConflict: true`, values grouped by unit, never blended | §7.2, §9.10 |
| data-workspace scoping | `fetchActivitiesInRange()` filters which ACTIVITIES exist in the result at all, not just which config a picker offers | §9.11 |
| one bad widget spec in a batch (`runBatchQuery`) | `{status:'error', error}` for that one widget only — the other widgets' results are unaffected | §9.12 |

---

## 1. Audit — what already exists (confirmed)

Read directly, this round, from `origin/main` (which already includes the merged Training Load Calendar/Activity/Results work — PR #75):

- **Training Load Calendar** (`backend/src/routes/trainingLoad.js`'s `GET /calendar`, `frontend/training-load-calendar-*.js`): a unified read model over planned sessions, external assignments, and canonical `training.activities`, already giving a coach `activityId`/`componentId`/date/period selection with dedup guaranteed server-side.
- **Training Activity canonical/alias model** (`migrations_v2/202609071000-202609071300`, `training` schema): `training.activities` (owner_scope/owner_user_id/owner_club_id/owner_team_id, lifecycle_state, origin, superseded_by_activity_id), `training.activity_participants` (merge_status/superseded_by_participant_id), `training.resolve_canonical_activity_id`/`activity_alias_ids`/`resolve_canonical_participant_id`/`participant_alias_ids`, and the read contract `training.canonical_activity_results()` — returns `fact_kind` rows (`rpe`, `metric_value`, `component_performance`, `metric_event_link`, `component_metric_segment_link`) per canonical activity, resolved through every alias.
- **`training.activity_components`**: `parent_component_id`, `component_type_key`, `exercise_id`, `name_snapshot`, `sort_order`, `planned_duration_seconds`/`actual_duration_seconds`. `training.activity_participant_components` (per-athlete performance per component) exists as a table but **has no real write path anywhere in the current backend** — confirmed by grep; nothing inserts into it today.
- **RPE/sRPE** (`training_load.session_feedback`, final shape after v1→v5→v14): `athlete_id`, `session_date`, `source` ('planned'|'scheduled_external'), `logical_session_id`/`external_assignment_id` (XOR), `rpe smallint`, `duration_minutes smallint`, `srpe integer generated always as (rpe * duration_minutes) stored`, fully immutable via `protect_session_feedback_snapshot()`. **It has no relationship to `training_load.metric_values` at all** — it is reached from a canonical activity only via `training.activity_participant_session_links` (`logical_session_id`/`external_assignment_id` → `activity_participant_id`).
- **Metrics Core** (`migrations_v2/202609041400-202609041700`, extended by `202609071200`): `metric_definitions`/`metric_definition_versions` (stable identity vs. append-only semantic version, exact same split reused below for dashboards), `metric_domains`/`metric_categories`/`metric_structure_links` (classification, with `link_scope_within_target` scope-breadth enforcement — reused and *tightened* below), `metric_source_connections`/`metric_import_batches`/`metric_source_identities` (provenance), `metric_events`/`metric_event_participants`/`metric_event_segments` (group-shaped, `scope_level` 'session'|'day'), `metric_measurement_occasions` (supersede chain, `import_conflict_status`) + `metric_values` (`aggregation_role` 'standalone'|'source_rollup'|'derived_rollup', `coverage` 'complete'|'partial'|'unknown'|'not_applicable', `metric_definition_scope_capabilities` gating session/component/day writes).
- **Owner-scope/workspace pattern** (confirmed identical across every `training_load.*`/`training.*` table): `owner_scope` ∈ {`system`,`club`,`team`,`user`} + exactly one of `owner_user_id`/`owner_club_id`/`owner_team_id`, enforced by a repeated 4-way CHECK. Application-layer resolution: `backend/src/trainingActivityAccess.js`/`trainingLoadAccess.js`, `resolveActiveWorkspace()` in `workspace.js` — a *workspace* (`platform`|`private_coach`|`club`|`team`|`athlete`, 5 values, `public.user_workspace_preferences`) is a **different, wider** concept than *owner_scope* (4 values) — a distinction this proposal's `dashboard_active_selection` table depends on getting right (§4, §D10).
- **`view-cache.js`**: namespace + contextKey cache, TTL-based freshness, `dedupeRequest`, request-generation counters, capture-before-mutate invalidation — the exact primitive the Calendar's own week/month/activity-detail caches already use. The dashboard's own data-fetch contract (§8) is designed to slot into this unchanged, not replace it.
- **Current Results view** (`frontend/training-load-calendar-view.js`'s `renderResultsTableHtml`): rows = athletes, RPE/sRPE/Duration as fixed pseudo-columns + a metric picker for `metric_definitions` columns, conflict cells that never silently pick a value. This is *already* a (frontend-only, non-persisted) proof that RPE/sRPE and Metrics Core series can coexist in one table without copying — see §A.
- **`public.user_workspace_preferences`**: exactly the shape `training_load.dashboard_active_selection` (§D10) is modeled on — a plain, non-authoritative UI preference row, never itself consulted for authorization (its own migration's comment says this explicitly).

---

## §A. How the dashboard selects RPE/sRPE together with Metrics Core metrics

Three options were compared, per the task's own instruction not to default to "just copy it in":

**Option 1 — convert RPE/sRPE into real `metric_definitions` rows, backfill `metric_values`.** Rejected. This would require inserting synthetic `metric_measurement_occasions`/`metric_values` rows for every historical RPE submission — a live, invasive backfill across genuinely append-only tables, duplicating a fact that already has its own authoritative, immutable, DB-generated-`srpe` table. It directly risks the "never double-count" requirement (Section 5) the whole task explicitly forbids, and maps RPE's much simpler write semantics (insert-once, one row per athlete/session, DB-computed derived value) onto Metrics Core's much heavier conflict/versioning/provenance model for no real benefit.

**Option 2 — a stable virtual/built-in series a query adapter reads directly from `session_feedback`.** **[decision, chosen]**. This is what the Calendar's Results table *already does today*, in production, unmodified by this proposal (§ audit above). `schema.sql` formalizes it: `training_load.dashboard_builtin_series` (`rpe`, `srpe`, `duration_minutes` today) is a small extensible catalog table (same shape as `training.activity_types`/`component_types` — a new built-in series is a future INSERT + a new case in the query adapter, never a schema change to `dashboard_widget_series`). `dashboard_widget_series.built_in_series_key` (FK into that catalog) sits alongside `metric_definition_id` as a normalized, mutually-exclusive reference (§C). **[PoC-proven]** PoC 17: RPE + sRPE (built-in) and a real Metrics Core distance metric sit on the same widget; a direct count against `metric_values` confirms zero rows were ever created for RPE.

**Option 3 — some other model.** Considered and rejected as unnecessary: a generic "adapter registry" table mapping series keys to query functions is just Option 2 with an extra layer of indirection that adds no real capability at this scale (3 built-in series today, a handful more foreseeable).

**Why Option 2 preserves history, semantics, and the no-double-count rule:** `session_feedback` stays the single, unmodified, immutable source of truth for RPE; nothing about this proposal writes to it, reads-and-copies it, or reinterprets its historical rows. A widget reading the `rpe`/`srpe`/`duration_minutes` built-in series always goes straight to `session_feedback` (via the same `activity_participant_session_links` join the canonical read contract already uses) — never through `metric_values`, so there is no way for the same fact to be counted through two different paths.

---

## §B. Shared template vs. personal dashboard, and clone/fork

**§B1 — same object or different tables?** **[decision]** Same table (`training_load.dashboards`), differentiated by `owner_scope` — exactly mirroring `metric_definitions`' own system/club/team/user split, which the codebase already trusts for an analogous "shared vs. private" distinction. A separate `is_template boolean` column (independent of `owner_scope`) marks whether a dashboard is meant to be cloned from — a club can have both a shared *template* and a shared *non-template* dashboard, and a private (`user`-scope) dashboard can also be a personal template a coach forks from later. **Rejected alternative:** two separate tables (`dashboard_templates` + `dashboards`) — this would duplicate every ownership/layout/widget/series table beneath it for no real behavioral difference; a template *is* a dashboard, just one others may fork.

**§B2 — clone/fork flow.** **[decision, corrected in Round 4]** Cloning inserts a brand-new `dashboards` row (`is_template` per the cloner's own choice — usually `false`, but a club admin forking the system template into their own editable club template sets it `true` again) with `cloned_from_dashboard_id` pointing at the original. **Round 2/3 described this as "one hop, never a chain" — that was never actually enforced, and Round 4 makes the real rule explicit: a MULTI-HOP chain (template → club template → a coach's further personal fork of THAT club template) is legitimate lineage, not an error** — `dashboards_validate_clone_provenance` (schema.sql) only rejects a genuine CYCLE (a chain that loops back to the row currently being inserted) and requires the immediate parent to be a real `is_template=true` row; it does not, and never did, cap the chain at one hop. **[PoC-proven]** §10.24 (a legitimate 2-hop chain — template → cloneA → cloneOfClone — is accepted, only a real cycle is rejected). Every widget/series is copied; a template widget's series that was only `template_metric_key_hints` (unresolved/ambiguous — see §D12, reworked in §0-R4.9) is now **preserved onto the new dashboard with its real `resolution_status`, never silently dropped** — Round 2/3's "or dropped if nothing resolves" language is superseded by this round's explicit requirement that an unresolved/ambiguous series stay visible and fixable. **[PoC-proven]** §11.27.

Who may do what (**not yet DB-enforced — application-layer, exactly like every other `owner_scope` write in this codebase, e.g. `canManageActivityInScope`**):
| Action | Who |
|---|---|
| See a dashboard | Anyone whose current workspace matches its owner_scope, or its owner_scope='system', or it's their own `user`-scope dashboard |
| Edit a `system`/`club`/`team` dashboard | A platform admin / that exact club's admin / that exact team's coach (same role check every other `owner_scope='club'` write already uses) |
| Edit a `user` dashboard | Its own owner only |
| Clone any dashboard they can see | Anyone (produces a `user`-scope copy in their own name — or a `club`/`team` fork if they administer that scope) |
| Select an active dashboard for themselves | Any user, for their own `dashboard_active_selection` row only |

---

## §C. Widget metric/series — normalized, never a bare UUID in JSON

`training_load.dashboard_widget_series`: `widget_id` FK, `series_order`, exactly one of `metric_definition_id` (real FK into `metric_definitions`) / `built_in_series_key` (FK into `dashboard_builtin_series`) / — for a template-only, unresolved series — `template_metric_key_hints` (an ordered JSONB array of candidate keys, §D12), plus `axis`, `color`, `display_label`, `source_policy` (+ `source_connection_id`).

Two triggers give this table real DB-level integrity beyond a plain FK:

- **Visibility scope-breadth** (`dashboard_widget_series_validate_metric_visibility`) — **a stricter variant of the existing `metric_structure_links`/`link_scope_within_target` pattern (v10)**. That existing function trusts a `'user'`-scope link to reference *any* target ("the authoritative leak protection is the READ-time application query" — its own comment). This proposal does **not** extend that same trust to a `'user'`-scope *dashboard*, because the task explicitly requires the DB layer itself to prove a private dashboard cannot reference another user's private metric (PoC item 8) — so a private dashboard's series may only reference a `'system'` metric or its own owner's own `'user'`-scope metric; a `'club'`/`'team'` dashboard may only reference `'system'` or that exact club/team's own metrics. **[PoC-proven]** PoC 6 (club-B metric rejected on a club-A dashboard), PoC 8 (another private coach's metric rejected, even though it's a real, valid FK target).
- **Per-type series cap** (`dashboard_widget_series_enforce_cap`) — reads `max_series` from `dashboard_widget_types` (KPI=1, Table/Line/Bar capped per type), falling back to a dashboard-wide hard ceiling (20) if a future type forgets to configure one. **[PoC-proven]** PoC 14.

Broader club/team-*membership*-based visibility (e.g. "any metric visible to any club I coach at, even a different one than this dashboard's own scope") is intentionally left to the application layer, matching `isAthleteInWorkspaceScope` elsewhere in this codebase — not duplicated as a static trigger.

---

## Section 2 objects — Dashboard / Widget / Series / Layout summary

See `schema.sql` for the full, commented definitions. Table set (all in the existing `training_load` schema); columns marked **[R2]** are new in Round 2:

1. `dashboard_widget_types` — extensible catalog: `key`, `label`, `min/max_width`, `min/max_height`, `default_width/height`, `max_series`, `has_shared_axis` **[R2]**, `supports_comparison_period` **[R2]**.
2. `dashboard_builtin_series` — extensible catalog: `key`, `label`, `unit`, `value_type` (§A), `default_analytical_aggregation` **[R3, renamed from R2's `default_aggregation_method` — now only a picker pre-fill hint, never enforced, see §0-R3.1]**, `fixed_data_scope_level` **[R2]**.
3. `dashboards` — identity, `owner_scope`/owner columns, `data_workspace_type`/`data_workspace_scope_id` **[R2, §0.1]**, `is_template`, `status` ('active'|'archived'), `cloned_from_dashboard_id`, `default_filter jsonb`, `revision`, `created_by_user_id`, timestamps.
4. `dashboard_widgets` — `dashboard_id`, `widget_type`, `title`, `widget_order`, `x`/`y`/`width`/`height` (12-col grid), `mobile_order`, `group_by` **[R4: gained `'week'`, `'team'`→`'cohort'` renamed, see §0-R4.1]**, `state` ('active'|'collapsed'), `display_config jsonb` (now requires a `schemaVersion` key **[R2]**), `local_filter_override jsonb`, `revision`.
5. `dashboard_widget_series` — see §C; `data_scope_level`/`aggregation_role_policy`/`coverage_policy`/`comparison_period` **[R2, §0.2]**; `analytical_aggregation` **[R3, renamed+reworked, §0-R3.1]**; `source_policy` gained `'not_applicable'` **[R3, §0-R3.7]**; `widget_id` is now immutable after insert **[R3, §0-R3.3]**; `resolution_status` + `template_resolution_candidates` **[R4, NEW, §0-R4.7]**; `template_metric_key_hints` is now shape-validated (real objects, never a bare string) **[R4, §0-R4.7]**.
6. `dashboard_active_selection` — see §0.1 (Round 2 reworked its visibility rule to require an exact data-workspace match, not owner-scope visibility); now also rejects an `archived` dashboard **[R3, §0-R3.7]**; and is atomically cleared when its own dashboard is archived, regardless of how **[R4, NEW, §0-R4.6]**.

Plus the full sanctioned-write function surface (10 total, all locking dashboard→widget→series — see §0-R4.5): `replace_dashboard_layout()` **[R2, §0.5; return shape extended with `dashboard_revision` in R3]**, `update_widget_layout()` **[R3, §0-R3.4; TOCTOU race rebuilt in R4]**, `create_widget()`, `update_widget_content()`, `delete_widget()`, `add_series()`, `update_series()`, `delete_series()`, `reorder_series()`, `archive_dashboard()` **[all 8 NEW in R4, §0-R4.5/§0-R4.6]**.

---

## §D. The 12 open questions — answered

### §D1. How does the dashboard select RPE/sRPE alongside Metrics Core metrics?
Answered fully in §A: built-in series, Option 2, no copy, proven by PoC 17.

### §D2. Are shared template and personal dashboard the same object or different tables?
Answered in §B1: same table (`dashboards`), `owner_scope` + `is_template` distinguish them; `cloned_from_dashboard_id` tracks provenance. **[PoC-proven]** PoC 1, PoC 4.

### §D3. Where does layout live?
**[decision]** Directly on `dashboard_widgets` (`x`/`y`/`width`/`height`/`mobile_order`) — **not** a separate layout/breakpoint table. Every widget always needs exactly one desktop position/size and at most one mobile order; there is no case today where a widget needs zero or multiple layouts per breakpoint, so a join table would be pure ceremony (the task itself warns against introducing breakpoint tables that aren't actually needed). **Tablet** is a responsive reduction of the same 12-column desktop grid, decided at render time by the frontend — not a third stored breakpoint. If a genuinely independent, curated tablet layout is ever required (not just a scaled reduction), *that* is the point to introduce a real `dashboard_widget_layouts(widget_id, breakpoint, x, y, width, height)` table — deliberately not built now. Bounds: `x∈[0,11]`, `x+width≤12`, per-type min/max via `dashboard_widget_types` (checked by trigger, since a plain CHECK cannot join). Overlap: **rejected deterministically** (never auto-resolved) by a trigger that locks the *dashboard* row first (not individual widget rows — closes the "two concurrent first-widgets" race) and refuses any rectangle intersection. **[PoC-proven]** PoC 9, PoC 10, PoC 12.

### §D4. How much configuration stays in JSONB, vs. what must be normalized?
**[decision]** Normalized: anything bearing FK integrity, cross-viewer visibility, or query-affecting structure — series identity (`metric_definition_id`/`built_in_series_key`), layout, `group_by`, `source_policy`(+connection), ownership, revision. JSONB: **cosmetic/display-only** config that legitimately varies per widget type and is never joined against (`display_config` — KPI comparison-period toggle, table page size/sort, chart line style) and **filter *values*** that are advisory, not identity-bearing (`dashboards.default_filter`, `dashboard_widgets.local_filter_override` — a stale `athleteId` in a saved filter is a harmless no-op on next apply, never a correctness bug). The dividing line: if a wrong/stale value in the field could silently leak data across a visibility boundary or silently miscompute a result, it's normalized; if the worst case is "the UI has to re-pick a value," it's JSONB.

### §D5. How is concurrent lost-update prevented?
**[decision]** Optimistic concurrency, **at two independent granularities**: `dashboards.revision` (bumped only on *structural*/direct-field changes — name, description, status, `is_template`, `default_filter`) and **each widget's own, independent** `dashboard_widgets.revision` (bumped on any of *that* widget's own field changes). A client sends back the revision it last read; `UPDATE ... WHERE id=? AND revision=?` affecting 0 rows is the controlled-conflict signal. Choosing per-widget (not one dashboard-wide) revision is deliberate: a single coarse lock would make two editors resizing two *unrelated* widgets falsely conflict with each other, which the task's own PoC item 12 explicitly requires NOT to happen. The dashboard-level *overlap* check still serializes concurrent LAYOUT writes on the same dashboard through one row lock (§D3) — but that's a correctness necessity for overlap detection, not the optimistic-concurrency mechanism itself, and it does not cause a false revision conflict between two different widgets (proven side-by-side in the same test). **[PoC-proven]** PoC 11 (stale-revision conflict, same widget), PoC 12 (two different widgets, both succeed, real DB barrier via `pg_stat_activity.wait_event_type`, no `sleep`).

### §D6. How does an archived metric behave in an existing widget?
**[decision]** It stays fully readable — a widget's `metric_definition_id` FK and the metric's own historical `metric_values` are completely unaffected by `state='archived'`; the visibility/scope-breadth trigger does not gate on `state` at all. What changes is **only** the metric *picker* (an application-layer catalog query) no longer offering it for a *new* pick — the same distinction `metric_definitions.state` already draws for every other consumer of the catalog. **[PoC-proven]** PoC 7.

### §D7. How does one Calendar activity context drive every widget?
**[decision]** A single **global runtime filter** (period, `activityId`, `componentId`, athlete/team selection, active workspace) lives in frontend state, seeded directly from the Calendar's own click-through (never re-derived by name/time — always the canonical `activityId` the Calendar already resolved). It is *not* written to the database on every change — only an explicit "Save as default" writes it into `dashboards.default_filter`. Each widget inherits the global filter unless its own `local_filter_override` (nullable JSONB, only the keys it wants to override) says otherwise.

### §D8. How does a widget inherit or override the global filter?
Covered in §D7: `local_filter_override IS NULL` ⇒ full inheritance; a non-null override merges key-by-key over the global filter, never wholesale-replaces it (a widget overriding just `componentId` still inherits the global `activityId`/period).

### §D9. How do we show two sources of the same metric?
**[decision, and already the live pattern]** Never silently pick one. `dashboard_widget_series.source_policy` is one of `all_with_conflicts` (show both, flagged), `source_connection` (pin to one, `source_connection_id` required by CHECK), `manual`, `api_import`, `csv_import`, `derived` — **no implicit "primary source" rule**, matching the task's explicit instruction and the Calendar Results table's own already-shipped conflict-cell behavior. The underlying query adapter must use the *exact same* "effective value" predicate `training.canonical_activity_results()` already uses (`superseded_by_occasion_id IS NULL AND import_conflict_status IS NULL AND ...`) — **[PoC-proven]** PoC 19, which deliberately re-derives that predicate rather than inventing a new one, and shows a superseded value is structurally excluded, not just conventionally hidden. **[PoC-proven]** PoC 16 (policy self-consistency CHECK).

### §D10. How do future AC/CH and ML results enter without a redesign?
Two additive, already-designed-for extension points: (a) a new row in `dashboard_widget_types` (a new type is an INSERT, not a migration — min/max size and `max_series` configured per type) plus a new `widget_type` case in the frontend renderer; (b) if a future computed result needs its own series identity distinct from a raw `metric_definition`, `metric_values.aggregation_role='derived_rollup'` (already real, already deployed by v3's Metrics Core extension) is the existing, correct home for it — a derived AC/CH ratio is still a `metric_definition` + `metric_values` row with `is_derived=true`/`computed_by_ref` set, referenced by a widget series exactly like any other metric, no new table required. Radar/scatter/heatmap widgets are new *rows* in `dashboard_widget_types`, reusing the exact same `dashboard_widget_series` normalization — only their own query-adapter and renderer are new code.

### §D11. How does the system behave with hundreds or thousands of metric definitions?
The metric picker (already shipped in the Calendar phase) already handles this via domain/category grouping + search, never rendering the full set at once (Section 1's own audit confirmed this exists today). A dashboard's own per-widget `max_series` cap (§C) is the second half of the answer: however large the *catalog* gets, one widget's own query footprint stays bounded (≤1 for KPI, ≤8-12 for Table/Chart) regardless. `dashboard_widget_types.max_series` is configuration, not a hardcoded limit — raising it later needs no migration.

### §D12. How does a default dashboard degrade safely when a club lacks the expected metric?
**[decision, reworked in Round 4 — see §0-R4.9 for the full binding/clone state machine]** A widget-series row may be **`resolution_status`** `'resolved'` (a real `metric_definition_id`/`built_in_series_key`), `'unresolved'` (zero visible candidates matched any hint), or `'ambiguous'` (2+ equally-valid candidates matched — the real candidate ids are kept in `template_resolution_candidates` for the UI to offer). `template_metric_key_hints` is now a validated JSON array of OBJECTS (`{key, valueType?, unit?, scopeLevel?, ...}` — a bare string is rejected outright) carrying enough to bind precisely, not just by key. **Round 2/3's rule — "only a TEMPLATE dashboard may hold an unresolved series, a real dashboard's series must be resolved or simply not exist (dropped on clone)" — is corrected here**: a REAL (non-template) dashboard now legitimately carries an `'unresolved'`/`'ambiguous'` series, preserved verbatim by the clone operation specifically so it stays visible and fixable ("Choose a metric") rather than silently vanishing. This is safe because a non-`'resolved'` series can never be QUERIED at all (the adapter refuses it outright) — it carries a UI-visibility need, never a data-visibility risk. This is the exact mechanism Section 7's "template mora bezbedno degradirati" requires, made concrete and DB-enforced rather than a documentation-only promise. **[PoC-proven]** §8.2/§8.3 (resolution itself), §10.35/§10.36/§11.26 (richer hint matching), §11.25 (bare-string hint rejected), §11.27 (ambiguous binding survives clone, stays fixable, never auto-picked).

---

## Section 6 — widget types in this first phase

| Type | Required config | Size bounds (`dashboard_widget_types`) | Max series | Query result shape |
|---|---|---|---|---|
| **KPI** | 1 series, 1 aggregation, optional prior-period comparison (in `display_config`), unit+icon from the series itself | 2×2 – 4×3 | 1 | one scalar (+ optional prior-period scalar) |
| **Table** | `group_by` rows (athletes/activities/dates/components), N series as columns | 3×3 – 12×12 | 12 | sticky-identity rows × series columns, conflict cells never collapsed |
| **Line chart** | time on X, one unit per axis (enforced), ≥1 series/athletes | 3×3 – 12×8 | 8 | per-series time-ordered points; a gap is a gap, never a synthesized 0 |
| **Bar chart** | comparison dimension (`group_by`), explicit aggregation | 3×3 – 12×8 | 8 | one bar (or bar-group) per `group_by` bucket |

AC/CH, radar, scatter, heatmap, ML-result widgets are explicitly future `dashboard_widget_types` rows (§D10) — not part of this phase's `schema.sql` seed data, per the task's own boundary.

---

## Section 7 — default system templates

Seeded (in a real future migration, not in this design-phase `schema.sql`) as `owner_scope='system', is_template=true` rows, created by a platform admin, with **hint-only** widget series (§D12) so they degrade safely everywhere:

1. **Team overview** — Table (rows=athletes, columns: `rpe`/`srpe` built-in + `["distance_total_m","distance_m"]` hint), Line chart (`srpe` built-in, one line per athlete, last 7/28 days), Bar chart (session count per athlete, `group_by='athlete'`).
2. **Athlete overview** — KPI × 3 (today's `rpe`, this week's `srpe` sum, last session date — all built-in, always resolvable, no external metric dependency at all), Line chart (`srpe` trend), Table (session-by-session RPE/sRPE/Duration history).
3. **Session analysis** — Table (rows=components, `group_by='component'`, columns = whatever session-scope metrics resolve), KPI (session `rpe`), pre-filtered by the Calendar's own `activityId` context (§D7) the moment it is opened from an activity.

None of these hardcode a GPEXE-specific name; every non-built-in series is a *hint list*, resolved (or safely omitted) per workspace at clone/instantiation time.

The **existing Results table** is not deleted — it remains available as a compatible fallback view (and is, in effect, already "Session analysis" widget #1's own current UI, just not yet dashboard-shaped) until a later phase formally reframes it as this dashboard's own preset/starting widget set.

---

## Section 8 — API/query contract (design only, no routes written this round)

Three shapes were compared for `fetch dashboard data`:

1. **One giant dashboard-data endpoint** (`GET /dashboards/:id/data`) — rejected as the *sole* mechanism: a single slow or failing widget blocks/500s the entire dashboard; no partial loading; a fixed response shape struggles to express "this one widget's query failed, the rest are fine."
2. **One batch endpoint, N widget query specs per request** — **[decision, recommended]**. `POST /api/training-load/dashboards/:id/query` with a body `{ filter: <global filter>, widgets: [{ widgetId, spec }, ...] }`, response `{ results: [{ widgetId, status: 'ok'|'error', data | error }] }`. One round trip; the server runs each widget's query independently (parallel where safe) so **one bad widget never 500s the rest** (PoC-adjacent principle, mirrors the per-row error isolation already used elsewhere in this app); a natural place to enforce a total-widget-count/complexity budget server-side; a clean, single cache key (`workspace + dashboard.revision + filter-hash`) for the *whole* batch, with each widget's *own* result additionally cacheable by `(widget.revision, resolved filter)` for reuse across a fast filter toggle. Fits `view-cache.js`'s existing namespace+contextKey+generation-counter shape directly (§ audit) — no new caching primitive needed.
3. **Per-widget endpoints + request coalescing** — rejected as the primary shape: N round trips even with coalescing, harder to get one atomic "as of this exact filter+revision" snapshot across all widgets, more per-request auth/rate-limit overhead at 10-30 widgets per dashboard.

Other routes (list/create/get/update/archive dashboard; clone; add/update/remove/reorder/resize widget; select active dashboard) are conventional CRUD following this app's existing `owner_scope`-gated route shape (e.g. `trainingActivity.js`'s own pattern) — not designed further this round since no route code is being written yet.

**Partial loading / stale-response protection**: identical to the Calendar's own already-proven pattern (per-nav-slot generation counters + `view-cache.js`'s revision guard) — a fast dashboard/filter switch must never let an in-flight batch response for the *old* context land on top of a newer one. No new primitive; direct reuse.

---

## PoC results (Round 6 — final)

`test-harness.mjs`, run three consecutive times against a fresh disposable database each time (`optimove_poc_dashboard_run_<random>`, created via `CREATE DATABASE` and dropped via `DROP DATABASE` by the script itself — never `OPTIMOVE`, never `monitoring2`, never staging/Supabase/production; the hardcoded name/URL guard, including the Round 4 fix that also checks the caller's own `DATABASE_URL`, is unchanged this round):

| Run | Result | DB confirmed dropped |
|---|---|---|
| 1 | 161/161 pass | yes |
| 2 | 161/161 pass | yes |
| 3 | 161/161 pass | yes |

137 tests are the original Round 1–5 suite (§1.x–§12.x), unchanged this round except §12.4 (rewritten — see §0-R6.1) and the underlying `dayScopeMetric` fixture (moved to `owner_scope='system'` — see §0-R6.2, no test assertions themselves needed to change). The 24 new Round 6 tests are §13.1–§13.22 (including §13.1b, §13.12a, §13.12b), one per the task's own numbered finding list — see §0-R6.6's finding→correction→test→function table above for the full traceability.

Every concurrency claim (§3.4, §5.1, §5.2, §5.3, §6.1, §6.6, §10.28, §11.20/§11.21/§11.22/§11.28, §12.15/§12.16/§12.17/§12.18/§12.19/§12.20, and Round 6's own §13.12a/§13.12b/§13.16/§13.17/§13.19/§13.20/§13.22) uses **two real `pg` connections and a deterministic barrier** — a second connection's write is confirmed genuinely blocked by polling `pg_stat_activity.wait_event_type = 'Lock'` for its own real backend pid, never a `sleep`/timing guess. §13.22 is this round's most structurally different proof: the "second connection" side is the REAL, dynamically-imported `backend/src/trainingLoadMetricsCatalog.js` service function itself, using ITS OWN already-existing `onLocked` test hook as the synchronization point, rather than a second raw SQL client — the genuine end-to-end integration proof the task required.

Final leftover check after all three runs: `select datname from pg_database where datname like 'optimove_poc_dashboard_%'` → **zero rows**. No real database (OPTIMOVE, monitoring2, staging, Supabase, production) was ever touched — every connection this harness opens is either the disposable database itself, the `postgres` maintenance database (used only to create/drop it), or — new this round — the REAL backend module's own pool, also pointed at the SAME disposable database and closed in `teardown()` before it is dropped (see §0-R6.5's own cleanup-bug note). No hardcoded credentials anywhere in `schema.sql` or `test-harness.mjs` — `DATABASE_URL` is read from the environment only (re-checked this round via a direct grep for embedded credential strings — none found).

**Real bugs THIS round's PoC caught before they could ever reach a real migration:**
- `set_active_dashboard()`'s first draft named its `RETURNS TABLE` out-parameters `dashboard_id`/`workspace_type`/`scope_id`/`updated_at` — identical to the real table's own column names — and Postgres genuinely could not resolve `workspace_type` inside `ON CONFLICT (user_id, workspace_type, scope_id)` between the out-parameter and the table column (`42702: column reference "workspace_type" is ambiguous`), caught immediately on the very first test run against this function, before any test could even exercise its real behavior. Fixed by prefixing every out-parameter (`out_selection_id`, `out_dashboard_id`, ...) — the exact same "ambiguous column" bug CLASS Round 2's own history already documents against `RETURNS TABLE` out-parameters, recurring here because the specific column names happened to collide again.
- §13.22's own first draft left the REAL, dynamically-imported backend module's own `pool` (`backend/src/db.js`, a separate `pg.Pool` from this harness's own) open — dropping the disposable database at teardown then threw an unhandled `"terminating connection due to administrator command"` asynchronously, AFTER the individual test itself had already reported as passing, which still failed the OVERALL suite (`✖ test-harness.mjs`, 161/162, despite every individual test showing `✔`). Caught by this harness's own habit of reading the summary counts, not just individual test lines. Fixed by capturing that pool's own reference and closing it in `teardown()`, before the disposable database is dropped.

**Real bugs prior rounds' PoC caught before they could ever reach a real migration** (kept for a complete history, Round 5's own list below unchanged):
- §12.2's own first draft expected Club A's and Club B's SAME real day (2026-09-13) to appear as two clean, separate values in an athlete's combined self-view — the actual, correct behavior is that this collides into the same measurement target and is correctly a real conflict, per the already-established target-resolution model (§0-R4.3). This was a wrong test expectation, not an implementation bug — caught before it could ship a test that would have silently required weakening the conflict rule to pass. Fixed by splitting into §12.2 (workspace breadth, genuinely non-colliding dates) and §12.2b (explicitly proving the same-day multi-club case IS a real conflict).
- §12.7's fixture referenced a non-existent `ids.participant`, silently resolving to `undefined`/null and tripping a real `training.activity_participant_metric_participant_links` trigger check (metric participant athlete not matching the activity participant) — caught immediately by the trigger itself refusing the insert, not by a silently-wrong result. Fixed by looking up the real `activity_participants` row instead of assuming a shortcut identifier existed.
- §12.8 initially reused a shared metric/component fixture that, by the time this sequentially-run test executed, had accumulated extra component-scope facts from earlier tests in the same suite (the same shared-fixture-pollution class of bug `makeQuickMetric()` already exists to avoid elsewhere in this file) — caught by an assertion on the exact bucket COUNT, not just presence. Fixed by rewriting §12.8 to use `makeQuickMetric()` for full isolation.

**Real bugs prior rounds' PoC caught before they could ever reach a real migration** (kept for a complete history, Round 4's own list below unchanged):
- `reduceRows`' own first draft collapsed straight to the FINAL requested bucket (e.g. `athlete`) using `daily_aggregation_method` directly — meaning Stage 1 would silently combine facts from MULTIPLE distinct real days into one number before Stage 2 ever ran, making Stage 2's own aggregation choice meaningless. Caught by §10.3 (`avg` at the athlete level returned the already-summed 230, not the real day-value average 115) before this report was written. Fixed by splitting into two real phases: Phase 1 always reduces per real calendar date first; Phase 2 re-buckets that output into whatever `group_by` actually asked for.
- `runSeriesPipeline` correctly scoped the ACTIVITY set for an `athlete` workspace via `fetchActivitiesInRange`, but then still passed the caller's own, unoverridden `athleteIds` down to the fact-level query functions — meaning a caller-supplied `athleteIds` pointing at a DIFFERENT athlete would filter OUT the real viewing athlete's own data. Caught by §11.19. Fixed by computing the effective athlete filter once, identically to `fetchActivitiesInRange`'s own internal rule, and reusing it everywhere in the pipeline.
- The forbidden-database safety guard (see above) only ever checked the GENERATED disposable database's own name, never the caller's own `DATABASE_URL` — found by directly testing the guard's actual behavior against `DATABASE_URL` pointed at `OPTIMOVE`, not merely reading the code. Fixed as described above.
- Several new-fixture design issues surfaced by the corrected, stricter target-conflict model itself (a GOOD kind of bug to find): §9.7/§9.9's old fixtures and §10.33's source-connection fixture had accidentally placed multiple facts on the exact SAME measurement target, which the new, correct conflict rule now (rightly) flags — where Round 3's cruder rule did not. Each was fixed by either asserting the real conflict shape (§9.7) or moving a fact onto a genuinely separate target (§9.9, §10.33), never by weakening the new conflict rule to make the old assertion pass.

**Real bugs prior rounds' PoC caught before they could ever reach a real migration** (kept for a complete history):
- Round 3: `reduceRows`' own `'team'` `group_by` branch was, in an early draft, only a relabeled copy of `'athlete'` bucketing; `fetchActivityDates()` silently shifted dates by a day via a JS `Date` round-trip; §10.9/§10.29 shared-fixture pollution across sequentially-run tests.
- Round 2: a stale `dashboards.revision` concurrency token in the atomic-layout check; several PL/pgSQL "ambiguous column" bugs against `RETURNS TABLE` out-parameters; a trigger declared before its target table existed; an RPE fixture missing a real, valid session link; shared-fixture pollution across §9.x tests.

**Real bugs THIS round's PoC caught before they could ever reach a real migration:**
- `reduceRows`' own `'team'` `group_by` branch was, in an early draft, only a relabeled copy of `'athlete'` bucketing (same per-athlete buckets, different key name) — it did not actually merge values ACROSS athletes. Caught by writing §10.6/§10.7 against a real two-athlete fixture before trusting the implementation; fixed to genuinely aggregate across every athlete in the queried set into one bucket per unit.
- `fetchActivityDates()`'s conversion of a Postgres `date` column to a `YYYY-MM-DD` string went through a JS `Date` object's `.toISOString()`, which silently shifted every date back by one day under this machine's local timezone. Caught by §10.1 asserting the exact real bucket keys, not just bucket VALUES — fixed by casting to `text` directly in SQL and never round-tripping through a JS `Date` at all (the same latent bug existed in the already-shipped `last_session_date` built-in from Round 2 and was fixed at the same time).
- §10.9's own first draft used `coveragePolicy: 'any'` and got a polluted result (9500 instead of 5000) because it shared `distanceClubA` with an EARLIER test (§9.9) in the same sequential suite that adds its own partial-coverage rollup to that same metric — the exact shared-fixture-pollution class of bug `makeQuickMetric()` already exists to avoid elsewhere in this file. Fixed by scoping §10.9 to `coveragePolicy: 'complete_only'`.
- The original §10.29 fixture reused the SAME activity for a second source-connection's fact as the entry-method fixture, so `source_policy='manual'` incidentally matched TWO real rows through two different connections instead of one — entry-method policies are (correctly) connection-agnostic, so this was a fixture design issue, not an adapter bug. Fixed by moving the second connection's fact onto its own separate activity, so §10.29–§10.31 (entry-method policies) naturally exclude it via `activityIds` while §10.33 (the connection-aware policy) opts back in explicitly.

---

## What this PoC does NOT prove — real application-authorization work still required

Being explicit about the boundary, as asked — unchanged in spirit from Round 1, restated precisely for the corrected model. **See §0-R6.6 above for the current, final, required, unflinching readiness assessment** — this section is the durable/general boundary statement; §0-R6.6 is the specific, current audit.

- **Route-level authorization** (who is *currently* a platform admin / club admin / team coach / has an active role in a given club or team) is entirely outside this schema, exactly like every other `owner_scope`-based feature in this codebase (`resolveActiveWorkspace`, `req.authz`). §1.6 documents this narrowly: revoking a coach's club role does not change what the *storage layer* would accept, because the storage layer was never the thing checking it, in either round — a real implementation's routes must call the same `resolveActiveWorkspace`/scope-check pattern `trainingActivityAccess.js` already uses, on **every** selection/query/edit request, never a cached grant. This is the single largest remaining gap between "PoC-proven" and "safe to ship" — the schema-level guarantees (§0.1) close the DATA-leak risk; only a real route layer closes the AUTHORIZATION-recency risk.
- **Per-request metric/source-connection visibility beyond exact-scope-match** (e.g., "any metric visible to any club this coach also happens to administer") is real, but is a membership *query*, not a static trigger — left to the application layer, matching `isAthleteInWorkspaceScope` precedent, for both metrics (§0.1) and source connections (§0.6).
- **The template-clone metric-key resolution step** — `resolveTemplateHint()` is a genuine, tested PoC function, but the REAL clone service (which INSERTs the resolved series row, snapshots a `needs_resolution` UI state for the coach to pick manually, etc.) is application logic not written this round. `resolve_series_binding()` (§0-R5.3, now also state/type-checked — §0-R6.3) is the sanctioned function that same future service must call to let the coach fix it later — the route around it is still future work.
- **Frontend code** (drag/resize interaction, mobile single-column stacking with the atomic Move-up/down flow, the metric-picker UI, the batch-query client, unit-conflict/needs-resolution UI states, the "Choose a metric"/"Metric not available" placeholder widgets described in §0-R5.8, and — new this round — any UI for choosing/switching the active dashboard, which must call `set_active_dashboard()`/`clear_active_dashboard()`, §0-R6.4) — none of this exists yet; `DASHBOARD_UX_SPEC.md` is a contract for that future work, not a test of it.
- **Real system-template seed migration** — Section 7's three templates (and the two new built-in series' real query-adapter service code) are described/PoC'd here, not written as an actual seed-data migration or real backend service this round (explicitly out of scope).
- **A real `unit_policy`/conversion engine** — deliberately not built, and deliberately not even added as an unused schema column (§0.7), so nothing here implies a capability that does not exist.
- ~~The capability-removal race's non-dashboard half~~ — **RESOLVED this round (§0-R6.5).** Prior rounds (most recently Round 5, §0-R5.6) listed this as an open gap; auditing `origin/main` this round found the Metrics-Core-side discipline was ALREADY shipped (`setDefinitionScopeCapabilities()`/`archiveDefinition()`, both `FOR UPDATE`-first) — §13.22 now proves both sides serialize correctly together, end-to-end, against the real service function. The remaining obligation is to keep this SAME integration test exercised once a real route layer exists, not to design or write a fix.

---

## Deliverables

- `schema.sql` — the corrected, additive schema (Round 6, final), applied on top of real `migrations_v2` in the PoC. This round adds a real `componentId` narrowing parameter to the query adapter's own `queryMetricSeries()` (test-harness.mjs side), two new dashboard_widget_series triggers (`..._validate_metric_active_state`, `..._validate_aggregation_type_compat`) enforcing binding-time metric state/type compatibility, and two new sanctioned functions (`set_active_dashboard()`, `clear_active_dashboard()`, 13 sanctioned functions total) giving active-dashboard selection its own proper write path.
- `test-harness.mjs` — the disposable-DB PoC, 161 tests (137 original + 24 new this round), run 3×, 161/161 each time, including the real runtime `activityId`/`componentId` filter now enforced in `runSeriesPipeline()`, the corrected system-scope `dayScopeMetric` fixture, and — new this round — a genuine dynamic import of the REAL `backend/src/trainingLoadMetricsCatalog.js` service module for the end-to-end capability-removal-lock integration proof (§13.22).
- `DASHBOARD_UX_SPEC.md` — a one-line Round 6 changelog note added for consistency with every prior round's documentation practice; no UX-visible behavior changed this round (all 5 findings were schema/adapter/backend-side).
- this report — see §0-R6 for the full Round 6 changelog, the finding→correction→test→function traceability table, and the honest readiness assessment.

Waiting for confirmation of this model before writing any real `migrations_v2` file or application code.
