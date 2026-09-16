# Current state

Last reviewed: 2026-09-16. Last `origin/main` commit checked: `d01187b` (merge of PR #87,
`feature/training-load-dashboards-v1` → `main`).

## Last completed, merged phases

- **Training Load IA/UX redesign, Phases A–F** — PRs #82–#87, one branch each, all
  merged to `main`: A IA shell (Schedule · Data & Analysis), B shared Monday-anchored
  week across Data & Analysis, C Activities identity + first Carbon-referenced visual
  pass, D Athletes consolidation (canonical-activities deep-link, rated/expected moved
  to Schedule), E Overview (two separate blocks: RPE feedback from `/weekly`,
  activity/data coverage from `/calendar`), F Dashboards (intra-space "Analyze this
  activity" hand-off carrying only the runtime filter, token consolidation on
  `.training-load-root`, shell Filter shown unavailable on Dashboards — see Open
  risks). Phase G (cleanup) is on `chore/training-load-ia-cleanup-v1`. No backend/API/
  DB contract changed in any of these; Carbon is a design reference only, never a
  runtime dependency.
- **Training Load dashboard backend (3B2)** — schema (`migrations_v2` v15-v18: catalog,
  dashboards, widgets/series, sanctioned functions, catalog seed) + routes
  (`backend/src/routes/trainingLoadDashboard.js`) + Access/Query/Catalog/Widgets service
  split. See ADR-001 through ADR-004, ADR-006.
- **Training Load Analysis frontend (3B3)** — merged via PR #77
  (`feature/training-load-dashboard-3b3-frontend` → `main`, merge commit `111134d`):
  Analysis tab, dashboard select/create/clone/archive, batch query, KPI/Table widgets,
  widget/series configuration, desktop 12-column layout editing with real pointer
  drag/resize, atomic Save/Cancel/reload persistence, Calendar → Analysis activity picker
  hand-off, mobile (360/375/390px) — drag/resize disabled on mobile in favor of Move
  up/down, 16px input font floor, 44px touch targets on the controls that needed it.
- This `CLAUDE.md`/`.claude/agents/` reviewer workflow (`code-reviewer`, `db-reviewer`,
  `mobile-qa`, `security-reviewer`) — merged as part of the same PR #77 history.

**Implemented ≠ deployed.** The above is confirmed merged to `main`; whether it has been
deployed to any hosted environment has not been verified as part of this update — don't
assert a deploy state without checking the actual hosting target first.

## Known baseline/environment test issues

- `frontend/tests/tests-schedule-management.actions.test.mjs` — 5 tests covering the
  Tests-module calendar click/drag day-selection (`startTestsCalendarDrag`/
  `extendTestsCalendarDrag`/`endTestsCalendarDrag` in `frontend/tests-actions.js`) fail.
  Confirmed via a clean detached `origin/main` worktree (before the 3B3 work) that this
  predates that branch entirely — not a regression, not yet fixed. These 5 are the only
  known failing tests in the frontend suite as of the last check; re-run
  `node --test tests/*.test.mjs` from `frontend/` for the current actual count rather
  than trusting a number here — pass/fail counts are transient and don't belong in this
  file (`.claude/rules/memory-maintenance.md`).

## Open risks

- The Calendar → Analysis "Choose activity" round trip, the widget series/metric picker,
  "Use template"/clone, and dashboard "Create" are unit-tested but were not fully
  exercised in a live browser during the 3B3 review (no seed athlete/activity data in the
  dev workspace; `window.prompt` isn't supported by the automated browser harness used).
- `migrations/` (legacy, no `_v2` suffix) still exists alongside `migrations_v2/` —
  treat it as historical/reference only; new migrations go in `migrations_v2/`.
- **Dashboards ignores the shell Club/Team/Athletes filter** (Training Load IA
  Phase F, decision (b), 2026-09-16). `POST /api/training-load/dashboards/:id/query`
  only receives the runtime activity/component filter
  (`analysisRuntimeFilterPayload`, `frontend/training-load-analysis-data.js`);
  `runtimeFilter.athleteIds` is never populated and the backend accepts
  `athleteIds` only, not club/team. The shell Filter is therefore rendered
  disabled on Dashboards with a visible note, without an active count, while
  the coach's selection stays in `state.trainingLoad.filter` for
  Overview/Activities/Athletes. Proposed separate task (not part of Phase F, no
  backend change made there): let `/query` accept `clubIds`/`teamIds` and expand
  them to member athletes server-side (same `athleteExtraFilterSql` union
  semantics `/weekly` and `/calendar` already use), then feed
  `state.trainingLoad.filter` into `analysisRuntimeFilterPayload()` and
  `queryContextKey()` and re-enable the control.
- **Manual RPE reminder for external ("OUTSIDE PLAN") sessions has no coach UI**
  (Phase G, 2026-09-16). Its only entry point was the old Today tab's grouped
  OUTSIDE-PLAN row → per-athlete reminder panel, which became unreachable in Phase A
  when "today" started rendering the canonical-activity Activities view; Phase G
  removed that dead UI (`renderTrainingLoadTodayHtml`, the group/reminder actions and
  state, `sendExternalScheduleReminder`). The backend route
  `POST /api/training-load/external-schedules/:id/remind` and its tests are untouched.
  Proposed separate task: re-home the per-athlete status + reminder UI into Schedule's
  own external-schedule detail (`renderExternalScheduleDetailHtml`), reusing the Tests
  module's `reminderSelection` fingerprint pattern.

## Most likely next step

No committed next phase has been confirmed as of this update — check with the user or
look for an open PR/branch before assuming what comes after 3B3. A reasonable guess based
on the merged work (not a confirmed plan): chart-type widgets (line/bar) beyond the
already-shipped KPI/Table, or wiring the metric picker's chosen `metric_definition_id`s
into a broader metrics catalog UI outside Training Load Analysis.

## How to refresh this file

After a merged milestone or a change in active phase: update the "last reviewed"
line/commit at the top, move the newly-completed phase into "Last completed, merged
phases," and re-derive "Open risks"/"Most likely next step" from the actual current
state — don't carry stale entries forward unexamined. See
`.claude/rules/memory-maintenance.md`.
