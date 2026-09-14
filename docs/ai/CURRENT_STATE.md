# Current state

Last reviewed: 2026-09-14. Last `origin/main` commit checked: `111134d` (merge of PR #77,
`feature/training-load-dashboard-3b3-frontend` → `main`).

## Last completed, merged phases

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
  predates that branch entirely — not a regression, not yet fixed. Full frontend suite
  as of the last check: 972 pass / 5 fail (the above), 977 total.

## Open risks

- The Calendar → Analysis "Choose activity" round trip, the widget series/metric picker,
  "Use template"/clone, and dashboard "Create" are unit-tested but were not fully
  exercised in a live browser during the 3B3 review (no seed athlete/activity data in the
  dev workspace; `window.prompt` isn't supported by the automated browser harness used).
- `migrations/` (legacy, no `_v2` suffix) still exists alongside `migrations_v2/` —
  treat it as historical/reference only; new migrations go in `migrations_v2/`.

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
