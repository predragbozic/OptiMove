# Training Load 3B1 — Analysis Dashboard: model, ownership, data semantics, API contract, and disposable-DB PoC results

**Status: design phase only — Round 3 (final corrective pass before real migrations).** Nothing in this round touches `migrations_v2`, the backend app, or the frontend app. `schema.sql` is a standalone, additive proposal validated only against a disposable, throwaway database created and dropped by `test-harness.mjs`. Waiting for a NEW confirmation of this corrected model before any real migration or application code is written.

Every claim below is labeled **[confirmed]** (read directly from `origin/main`'s real code/schema), **[decision]** (a choice made for this proposal, with rejected alternatives), or **[PoC-proven]** (demonstrated by `test-harness.mjs` against real, unmodified `migrations_v2` files + this proposal's `schema.sql`, on a disposable database, **three consecutive runs, 86/86 passing each time**, database confirmed dropped after each, zero leftovers). Round 1 had 24 proof points, Round 2 added 26 more (50 total), Round 3 adds the final **36** required by this pass — see "PoC results" below for the full breakdown and **§0-R3.9 for an honest, unflinching readiness assessment** (the task's own explicit instruction: green tests alone do not mean "ready").

**Read this first — jump straight to what changed:** §0-R3 immediately below is the complete Round-3 changelog. §0 (Round 2) beneath it is kept as historical context, amended in place where Round 3 further changed it (each such amendment is marked **[Round 3]**). Everything after §0 is the Round 1 report, amended in place across both later rounds.

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
- **Built-in source-policy restriction**: RPE/sRPE/duration (and the two new built-ins) can only ever use `source_policy='manual'` with no `source_connection_id` — `source_connection`/`api_import`/`csv_import` are structurally meaningless for a fact that only ever comes from `session_feedback` (§4.5).
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

**§B2 — clone/fork flow.** **[decision]** Cloning inserts a brand-new `dashboards` row (`is_template` per the cloner's own choice — usually `false`, but a club admin forking the system template into their own editable club template sets it `true` again) with `cloned_from_dashboard_id` pointing at the original (one hop, never a chain — a dashboard clone is a one-time fork, not an identity merge like `training.activities`' alias chain). Every widget/series is copied; template widgets whose series were only `template_metric_key_hints` (unresolved — see §D12) get resolved against the *cloning workspace's own* visible catalog at clone time, or dropped if nothing resolves. **[PoC-proven]** PoC 4: cloning a system template leaves the original's series still hint-only and unresolved, and produces a new dashboard with a genuinely resolved FK.

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
4. `dashboard_widgets` — `dashboard_id`, `widget_type`, `title`, `widget_order`, `x`/`y`/`width`/`height` (12-col grid), `mobile_order`, `group_by`, `state` ('active'|'collapsed'), `display_config jsonb` (now requires a `schemaVersion` key **[R2]**), `local_filter_override jsonb`, `revision`.
5. `dashboard_widget_series` — see §C; `data_scope_level`/`aggregation_role_policy`/`coverage_policy`/`comparison_period` **[R2, §0.2]**; `analytical_aggregation` **[R3, renamed+reworked, §0-R3.1]**; `source_policy` gained `'not_applicable'` **[R3, §0-R3.7]**; `widget_id` is now immutable after insert **[R3, §0-R3.3]**.
6. `dashboard_active_selection` — see §0.1 (Round 2 reworked its visibility rule to require an exact data-workspace match, not owner-scope visibility); now also rejects an `archived` dashboard **[R3, §0-R3.7]**.

Plus functions: `training_load.replace_dashboard_layout()` **[R2, §0.5; return shape extended with `dashboard_revision` in R3]** and `training_load.update_widget_layout()` **[R3, NEW, §0-R3.4]** — the two sanctioned, deadlock-safe layout-write entry points.

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
**[decision]** A *template*'s widget-series rows may be **unresolved** — `metric_definition_id`/`built_in_series_key` both NULL, only `template_metric_key_hints` (an ordered JSONB array of candidate keys) set. A trigger (`dashboard_widget_series_validate_resolution`) permits this *only* when the owning dashboard is itself `is_template=true` — a real, live, cloned dashboard's series must always be fully resolved (or simply not exist — the clone operation drops any series that resolved to nothing, it never leaves a dangling hint-only row on a real dashboard). This is the exact mechanism Section 7's "template mora bezbedno degradirati" requires, made concrete and DB-enforced rather than a documentation-only promise. **[PoC-proven]** PoC 4.

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

## PoC results (Round 3 — final)

`test-harness.mjs`, run three consecutive times against a fresh disposable database each time (`optimove_poc_dashboard_run_<random>`, created via `CREATE DATABASE` and dropped via `DROP DATABASE` by the script itself — never `OPTIMOVE`, never `monitoring2`, never staging/Supabase/production; a hardcoded name/URL guard refuses any of those):

| Run | Result | DB confirmed dropped |
|---|---|---|
| 1 | 86/86 pass | yes |
| 2 | 86/86 pass | yes |
| 3 | 86/86 pass | yes |

50 tests are the original Round 1/2 suite (§1.x ownership/data-workspace, §2.x series semantics, §3.x revision, §4.x reverse invariants, §5.x locking, §6.x atomic layout, §7.x units/versions, §8.x templates, §9.x the query adapter) — updated in place wherever Round 3 changed a field name or expected behavior (§0-R3.8). The 36 new Round 3 tests are §10.1–§10.36, organized exactly as required: Query results (§10.1–§10.12), Workspace isolation (§10.13–§10.19), Integrity and revision (§10.20–§10.28), Binding/source (§10.29–§10.36).

Every concurrency claim (§3.4, §5.1, §5.2, §5.3, §6.1, §6.6, and Round 3's own §10.28) uses **two real `pg` connections and a deterministic barrier** — a second connection's write is confirmed genuinely blocked by polling `pg_stat_activity.wait_event_type = 'Lock'` for its own real backend pid, never a `sleep`/timing guess. §10.28 is the round's most important new proof: `update_widget_layout()` and `replace_dashboard_layout()` running concurrently on the same dashboard genuinely queue behind each other's dashboard-row lock and never deadlock.

Final leftover check after all three runs: `select datname from pg_database where datname like 'optimove_poc_dashboard_%'` → **zero rows**. No real database (OPTIMOVE, monitoring2, staging, Supabase, production) was ever touched — every connection this harness opens is either the disposable database itself or the `postgres` maintenance database, used only to create/drop it. No hardcoded credentials anywhere in `schema.sql` or `test-harness.mjs` — `DATABASE_URL` is read from the environment only.

**Real bugs THIS round's PoC caught before they could ever reach a real migration:**
- `reduceRows`' own `'team'` `group_by` branch was, in an early draft, only a relabeled copy of `'athlete'` bucketing (same per-athlete buckets, different key name) — it did not actually merge values ACROSS athletes. Caught by writing §10.6/§10.7 against a real two-athlete fixture before trusting the implementation; fixed to genuinely aggregate across every athlete in the queried set into one bucket per unit.
- `fetchActivityDates()`'s conversion of a Postgres `date` column to a `YYYY-MM-DD` string went through a JS `Date` object's `.toISOString()`, which silently shifted every date back by one day under this machine's local timezone. Caught by §10.1 asserting the exact real bucket keys, not just bucket VALUES — fixed by casting to `text` directly in SQL and never round-tripping through a JS `Date` at all (the same latent bug existed in the already-shipped `last_session_date` built-in from Round 2 and was fixed at the same time).
- §10.9's own first draft used `coveragePolicy: 'any'` and got a polluted result (9500 instead of 5000) because it shared `distanceClubA` with an EARLIER test (§9.9) in the same sequential suite that adds its own partial-coverage rollup to that same metric — the exact shared-fixture-pollution class of bug `makeQuickMetric()` already exists to avoid elsewhere in this file. Fixed by scoping §10.9 to `coveragePolicy: 'complete_only'`.
- The original §10.29 fixture reused the SAME activity for a second source-connection's fact as the entry-method fixture, so `source_policy='manual'` incidentally matched TWO real rows through two different connections instead of one — entry-method policies are (correctly) connection-agnostic, so this was a fixture design issue, not an adapter bug. Fixed by moving the second connection's fact onto its own separate activity, so §10.29–§10.31 (entry-method policies) naturally exclude it via `activityIds` while §10.33 (the connection-aware policy) opts back in explicitly.

**Real bugs this round's PoC caught before they could ever reach a real migration** (the entire point of doing this phase first) — beyond the three already listed in Round 1:
- The atomic-layout revision check used `dashboards.revision` as its concurrency token, but a pure layout write never bumped that column (only per-widget revisions did, by design) — so two sequential `replace_dashboard_layout()` calls would both see the "same" revision and neither would ever be correctly rejected as stale. Fixed by having `replace_dashboard_layout()` bump `dashboards.revision` once per call, on top of (not instead of) each touched widget's own revision.
- Several PL/pgSQL functions (`replace_dashboard_layout`, `dashboards_bump_revision`'s sibling, the trigger for `dashboard_widgets_bump_parent_dashboard_revision`) had bare column references (`revision`, `x`, `y`, `width`, `height`, `mobile_order`) that were ambiguous against that SAME function's own `RETURNS TABLE` out-parameter names of the identical names — Postgres accepted the function definition but failed at call time. Fixed by qualifying every such reference with its table alias.
- Two trigger-creation statements referenced `training_load.dashboard_widgets` before that table was created (a widget-set-change trigger declared, by mistake, in the "Dashboards" section instead of the "Widgets" section) — `CREATE TRIGGER` (unlike a function body's internal references) needs its target table to exist immediately. Fixed by moving the trigger declarations after the table.
- The original fixture's RPE row had no real `training.activity_participant_session_links` row linking it to the activity — Round 1's PoC never actually called `canonical_activity_results()` and asserted on the RPE fact, so this gap was invisible until Round 2's real query adapter tried to read it. Fixed by adding a genuine, fully-valid Weekly plan (`plans.plans`/`plan_days`/`plan_sessions`) and a CONFIRMED session link, satisfying the real `check_session_link_integrity` trigger — not a shortcut.
- Several §9.x query-adapter tests shared one `hrClubA` metric_definition across sequential tests in the same run, so an EARLIER test's own fixture rows silently inflated a LATER test's "how many effective values" count. Fixed by giving each of those tests its own fresh, throwaway metric_definition (`makeQuickMetric()`) — a test-isolation fix, not a schema fix, but worth recording since it is exactly the kind of ordering bug a shared-fixture PoC harness is prone to.

---

## What this PoC does NOT prove — real application-authorization work still required

Being explicit about the boundary, as asked — unchanged in spirit from Round 1, restated precisely for the corrected model. **See §0-R3.9 above for Round 3's own, required, unflinching readiness assessment** — this section is the durable/general boundary statement; §0-R3.9 is the specific, current audit.

- **Route-level authorization** (who is *currently* a platform admin / club admin / team coach / has an active role in a given club or team) is entirely outside this schema, exactly like every other `owner_scope`-based feature in this codebase (`resolveActiveWorkspace`, `req.authz`). §1.6 documents this narrowly: revoking a coach's club role does not change what the *storage layer* would accept, because the storage layer was never the thing checking it, in either round — a real implementation's routes must call the same `resolveActiveWorkspace`/scope-check pattern `trainingActivityAccess.js` already uses, on **every** selection/query/edit request, never a cached grant. This is the single largest remaining gap between "PoC-proven" and "safe to ship" — the schema-level guarantees (§0.1) close the DATA-leak risk; only a real route layer closes the AUTHORIZATION-recency risk.
- **Per-request metric/source-connection visibility beyond exact-scope-match** (e.g., "any metric visible to any club this coach also happens to administer") is real, but is a membership *query*, not a static trigger — left to the application layer, matching `isAthleteInWorkspaceScope` precedent, for both metrics (§0.1) and source connections (§0.6).
- **The template-clone metric-key resolution step** — `resolveTemplateHint()` is a genuine, tested PoC function, but the REAL clone service (which INSERTs the resolved series row, snapshots a `needs_resolution` UI state for the coach to pick manually, etc.) is application logic not written this round.
- **Frontend code** (drag/resize interaction, mobile single-column stacking with the atomic Move-up/down flow, the metric-picker UI, the batch-query client, unit-conflict/needs-resolution UI states) — none of this exists yet; `DASHBOARD_UX_SPEC.md` (updated this round) is a contract for that future work, not a test of it.
- **Real system-template seed migration** — Section 7's three templates (and the two new built-in series' real query-adapter service code) are described/PoC'd here, not written as an actual seed-data migration or real backend service this round (explicitly out of scope).
- **A real `unit_policy`/conversion engine** — deliberately not built, and deliberately not even added as an unused schema column (§0.7), so nothing here implies a capability that does not exist.

---

## Deliverables

- `schema.sql` — the corrected, additive schema (Round 3, final), applied on top of real `migrations_v2` in the PoC.
- `test-harness.mjs` — the disposable-DB PoC, 86 tests (50 original + 36 new this round), run 3×, 86/86 each time, including a real 9-step query pipeline.
- `DASHBOARD_UX_SPEC.md` — desktop/tablet/mobile UX contract, updated this round for analytical-aggregation picker semantics, the corrected built-in source-policy language, and workspace-type-specific UX notes.
- this report.

Waiting for confirmation of this model before writing any real `migrations_v2` file or application code.
