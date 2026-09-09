# Training Load 3B1 — Analysis Dashboard: model, ownership, data semantics, API contract, and disposable-DB PoC results

**Status: design phase only.** Nothing in this round touches `migrations_v2`, the backend app, or the frontend app. `schema.sql` is a standalone, additive proposal validated only against a disposable, throwaway database created and dropped by `test-harness.mjs`. Waiting for confirmation of this model before any real migration or application code is written.

Every claim below is labeled **[confirmed]** (read directly from `origin/main`'s real code/schema this round), **[decision]** (a choice made for this proposal, with rejected alternatives), or **[PoC-proven]** (demonstrated by `test-harness.mjs` against real, unmodified `migrations_v2` files + this proposal's `schema.sql`, on a disposable database, three consecutive runs, 24/24 passing each time, database confirmed dropped after each).

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

See `schema.sql` for the full, commented definitions. Table set (all in the existing `training_load` schema):

1. `dashboard_widget_types` — extensible catalog: `key`, `label`, `min/max_width`, `min/max_height`, `default_width/height`, `max_series`.
2. `dashboard_builtin_series` — extensible catalog: `key`, `label`, `unit`, `value_type` (§A).
3. `dashboards` — identity, `owner_scope`/owner columns, `is_template`, `status` ('active'|'archived'), `cloned_from_dashboard_id`, `default_filter jsonb`, `revision`, `created_by_user_id`, timestamps.
4. `dashboard_widgets` — `dashboard_id`, `widget_type`, `title`, `widget_order`, `x`/`y`/`width`/`height` (12-col grid), `mobile_order`, `group_by`, `state` ('active'|'collapsed'), `display_config jsonb`, `local_filter_override jsonb`, `revision`.
5. `dashboard_widget_series` — see §C.
6. `dashboard_active_selection` — see §D10.

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

## PoC results

`test-harness.mjs`, run three consecutive times against a fresh disposable database each time (`optimove_poc_dashboard_run_<random>`, created via `CREATE DATABASE` and dropped via `DROP DATABASE` by the script itself — never `OPTIMOVE`, never `monitoring2`, never staging/Supabase/production; a hardcoded name/URL guard refuses any of those):

| Run | Result | DB confirmed dropped |
|---|---|---|
| 1 | 24/24 pass | yes |
| 2 | 24/24 pass | yes |
| 3 | 24/24 pass | yes |

All 24 numbered proof points from the task are implemented as individual `test()` blocks; concurrency claims (items 11, 12, 24) use **two real `pg` connections and a deterministic barrier** — a second connection's write is confirmed genuinely blocked by polling `pg_stat_activity.wait_event_type = 'Lock'` for its own real backend pid, never a `sleep`/timing guess.

**Real bugs this PoC caught before they could ever reach a real migration** (the entire point of doing this phase first):
- The axis-unit-compatibility trigger, as first written, wrongly applied to KPI/Table widgets (which have no real shared axis) — RPE + sRPE together on one Table row was rejected. Fixed by scoping that trigger to `line_chart`/`bar_chart` only.
- `dashboards.cloned_from_dashboard_id` was first written `ON DELETE SET NULL`, which would have silently let a template with a live clone be hard-deleted (exactly the case Section 3/PoC item 20 requires refused). Fixed to `ON DELETE RESTRICT`.
- The harness's own teardown didn't guard against a partially-failed `setup()` (an early run left one orphaned disposable database when an unrelated bug threw before teardown could run). Fixed with `if (pool)`/`if (migrationsDir)`/`if (db)` guards; the one leaked database from that earlier bug was found and manually dropped, confirmed gone, before the final three clean runs reported above.

Final leftover check after all runs: `select datname from pg_database where datname like 'optimove_poc_dashboard_%'` → **zero rows**.

---

## What this PoC does NOT prove — real application-authorization work still required

Being explicit about the boundary, as asked:

- **Route-level authorization** (who is *currently* a platform admin / club admin / team coach) is entirely outside this schema, exactly like every other `owner_scope`-based feature in this codebase (`resolveActiveWorkspace`, `req.authz`). PoC 23 documents this narrowly (revoking a role does not change what the *storage layer* would accept, because the storage layer was never the thing checking it) — a real implementation's routes must call the same `resolveActiveWorkspace`/scope-check pattern `trainingActivityAccess.js` already uses, unchanged.
- **Per-request metric visibility beyond exact-scope-match** (e.g., "any metric visible to any club this coach also happens to administer") is real, but is a membership *query*, not a static trigger — left to the application layer, matching `isAthleteInWorkspaceScope` precedent.
- **The template-clone metric-key resolution step** (turning `template_metric_key_hints` into a real `metric_definition_id` for a specific workspace) is application logic, not proven here beyond "the schema allows both the unresolved and resolved shapes and enforces which is legal where."
- **Frontend tests** (drag/resize interaction, mobile single-column stacking, the metric-picker UI, the batch-query client) — none of this exists yet; `DASHBOARD_UX_SPEC.md` is a contract for that future work, not a test of it.
- **Real system-template seed migration** — Section 7's three templates are described here as a *design*, not written as an actual seed-data migration this round (explicitly out of scope).

---

## Deliverables

- `schema.sql` — the proposed additive schema, applied on top of real `migrations_v2` in the PoC.
- `test-harness.mjs` — the disposable-DB PoC, all 24 items, run 3×, 24/24 each time.
- `DASHBOARD_UX_SPEC.md` — desktop/tablet/mobile UX contract.
- this report.

Waiting for confirmation of this model before writing any real `migrations_v2` file or application code.
