# Current state

Last reviewed: 2026-09-18. Last `origin/main` commit checked: `6c5b3a6` (merge of PR #104,
`feature/gpexe-undo-authorization-log` → `main`).

## Active phase

**Training Load Dashboards UX redesign (H-slices)** — frontend only unless a separate
product decision says otherwise. H1 (PR #89), H2 (PR #93), H3 (PR #95) and H4 (PR #97)
are merged. No further slice is scheduled; the small follow-up found during H4 is recorded
under Separate tasks.

Alongside it, the **GPEXE import groundwork** is merged:
- the pilot importer (PR #99);
- database uniqueness and threshold bindings (v20, PR #101);
- a rehearsed undo of one imported session (PR #102);
- session and drill display in Activities (PR #103);
- undo authorization with a database deletion log (v21) and a backup proven by a trial
  restore (PR #104).

All of it is code only. **No GPEXE data has been imported into the local OPTIMOVE or the
deployed database**, so nothing imported is visible in the app. The next functional task
the owner named (2026-09-18) is the in-app import (see Most likely next step).

## Last completed, merged phases

- **GPEXE undo authorization, deletion log and verified backup** — PR #104 (`6c5b3a6`),
  migration v21 (`migrations_v2/202609181000_training_load_v21_import_deletion_log.sql`).
  - **Who may run the undo** (`backend/scripts/gpexe-undo-imported-session.mjs`): only an
    **active platform admin** (active `user_global_roles` role and `users.is_active`),
    always with a reason.
    - The script checks this before taking any lock, and the v21 insert trigger checks it
      again (SQLSTATE 42501).
    - `--reason` and `--performed-by-user-id` are required on every run, dry run included.
    - The script still refuses any database that is not a disposable
      `optimove_tests_gpexe_*` one.
  - **`training_load.import_deletion_log`**:
    - one row per removed event, written in the **same transaction** as the removal;
    - records the session, team, day, admin, reason, threshold set, and rows removed per
      table and in total;
    - append-only against UPDATE, DELETE and TRUNCATE;
    - a row can only name an active platform admin and an event that no longer exists;
    - lock order: `user_global_roles` (FOR SHARE) → `metric_events` → `activities`.
  - **Verified backup** (`backend/scripts/gpexe-backup-verify.mjs`,
    `docs/runbooks/gpexe-backup-verify.md`):
    - `pg_dump` runs on an exported snapshot;
    - the dump is restored into a new `optimove_tests_gpexe_restore_*` database, which is
      always dropped afterwards;
    - the copy is compared table by table (row count plus a digest of every row) and per
      catalog object, including whether each trigger is enabled;
    - an unverified dump is deleted, and a verified one gets `<dump>.verify.json` with its
      sha256;
    - local sources only; `pg_dump`/`pg_restore` inherit no `PG*` variable and get
      explicit connection arguments.
  - **Known limit, stated in the runbook**: the CLI cannot authenticate its operator. It
    checks that the given user id is an active platform admin, not that the person running
    it is that admin. The runbook lists what must be in place before any persistent-database
    unlock.
- **GPEXE session and drills in Activities** — PR #103 (`37dadb1`), frontend only.
  - The Activities drawer shows the whole session and each drill separately, with readable
    metric names, and marks real conflicts.
  - Dashboards series are named from the metric catalog.
  - The Dashboards "Bucket" column still shows raw ids (see Separate tasks).
- **GPEXE undo procedure** — PR #102 (`df3cc6b`): `backend/scripts/gpexe-undo-imported-session.mjs`
  and `docs/runbooks/gpexe-undo-imported-session.md`.
  - Undoes one imported session in a fixed order.
  - The v13/v20 immutability triggers are disabled only inside that one transaction, and
    the commit is refused unless they are enabled again.
  - A JSON log is written before the commit (`pending`, then `committed`).
  - It refuses rather than guesses when it finds:
    - a manual correction;
    - an activity shared with, or linked to, another event;
    - a merged or reparented activity;
    - two events for one GPEXE session.
  - Disposable databases only.
- **GPEXE uniqueness and threshold provenance** — PR #101 (`c066b3b`), migration v20
  (`migrations_v2/202609171800_training_load_v20_gpexe_source_bindings.sql`).
  - One active GPEXE connection per team.
  - A trigger refuses a second event for the same GPEXE connection and `team_session:<id>`,
    and freezes the source identity of a bound event.
  - `training_load.metric_event_source_bindings` records, per event, the GPEXE threshold
    set the values were imported under:
    - the hash covers the set id and the payload;
    - the hash version has its own column;
    - rows cannot be changed.
  - The writer stops with `binding_missing`, `source_reference_set_changed` or
    `reference_hash_version_outdated` instead of mixing threshold sets.
- **GPEXE pilot import (code only)** — PR #99 (`41e9555`), backend only:
  `backend/src/gpexeImportMapper.js` (pure plan builder) + `backend/src/gpexeImportWriter.js`
  (one transaction under a team advisory lock) + `backend/scripts/gpexe-import-pilot.mjs`
  (CLI) + `backend/scripts/gpexe-pilot-disposable-run.mjs` + `backend/tests/gpexe-import.test.mjs`.
  One GPEXE team session becomes a `training_load.metric_events` row with participants,
  drill segments, occasions and values, plus the activity the existing
  `training.materialize_activity_group_from_metric_event` materializes with one
  `activity_components` row of type `drill` per segment.
  - **Only GPEXE's own values are stored**: TIME (min), TotDist (m), SPEEDmax (km/h),
    acceleration/deceleration events, burst/brake events (definition unconfirmed),
    "Sprint distanca ≥25,2 km/h" (m) from the GPEXE 7 m/s speed zone, and each GPEXE power
    zone separately (25–60, 60–75, ≥75 W/kg). Owner decision 2026-09-17: `m/min`,
    `Acc+Dec`, `Burst&brakes`, `HMLD ≥25 W/kg` and `EXPDist ≥60 W/kg` are **not**
    imported — they wait for a derived-metrics feature with a formula and a formula
    version, so an OptiMove-computed sum is never stored as a value GPEXE delivered.
  - **Identity and idempotency**: separate source identities
    `athlete_session:<id>:full` and `athlete_session:<id>:drill:<n>`; the occasion content
    hash covers unit, level, `aggregation_role`, `coverage` and the GPEXE source context;
    values fetched later (drill burst/brake) become current through a `supplemented`
    supersede path that only adds metrics while every existing value stays identical, while
    changed, dropped or older data stays `needs_review` and a manual correction is never
    replaced.
  - **Verified on a disposable database only** (`optimove_tests_gpexe_*`, created and
    dropped in the same run, with real responses for team 980 / session 186942): first
    import 19 results, then 15 drill results supplemented with burst/brake, a repeat import
    writing nothing, and two concurrent imports ending in the same state as one.
    `backend/tests/gpexe-import.test.mjs` covers mapper, writer, concurrency, deadlock, the
    dashboard source filter and the CLI guard.
  - **Nothing was written to the local OPTIMOVE or the Supabase database**, and the CLI
    refuses to: `--apply` requires a local `optimove_tests_gpexe_*` database carrying the
    marker table written by `backend/tests/_gpexe-disposable-db.mjs`, and `--dry-run` (the
    default) opens no connection at all. **No imported GPEXE data is therefore visible
    anywhere in the app today.**
  - Also fixed: `fetchOccasionContexts` in `backend/src/trainingLoadDashboardQuery.js` did
    not read `entry_method`, so the dashboard source policy (manual / api_import /
    csv_import) could never match imported values.
  - The read-only fetch script that collects the GPEXE responses stays **outside the
    repository** (owner decision 2026-09-17); the token never leaves the owner's own shell.

- **Dashboards UX H4** — PR #97 (`70eabaf`), frontend only.
  - **Readable labels in Advanced settings**, named after what the query engine does with
    each stored value (`resolveFactsToRows` / `shiftDateRange` in
    `backend/src/trainingLoadDashboardQuery.js`, value meanings in the v3 Metrics-Core and
    v16 dashboard migrations); stored values and request bodies are unchanged. Source =
    how a catalog metric's value was recorded (All sources, Manual entry only, API import
    only, CSV import only, Calculated values only, One connected source); Values included
    (`aggregation_role_policy`) = direct values / source totals / calculated totals; Total
    coverage (`coverage_policy`) = complete / partial / unknown-coverage totals, direct
    values pass every choice. A help text explains the terms and conflicts. For built-in
    metrics the three filters are disabled with a note, because
    `queryBuiltInSeriesFromContext` never applies them. Owner decision 2026-09-17 at the
    H3 merge: meanings verified before naming.
  - **Remaining leave-guard exits**: notification rows that open another screen and a
    workspace switch now ask before any request (`confirmLeaveTrainingLoad(_, { discard:
    false })`). Declined changes nothing; the draft is discarded only after the request
    succeeded (a notification's mark-read, then `discardTrainingLoadLeaveDrafts`; a
    workspace switch resets Training Load itself), so a failed request loses nothing.
    Covers both an unsaved layout and an unsaved Advanced settings change. The
    **messages panel** exit was **not reproduced** live (open, conversation, send, close,
    outside click, Escape, phone Back all kept both drafts) and was left unchanged.

- **Dashboards UX H3** — PR #95 (`d2189fa`), frontend only: the advanced widget editor
  ("Advanced settings") edits a local draft; nothing is sent before "Save changes", and
  Cancel, Escape, section switch and the H2 leave guard ask "Discard your unsaved widget
  changes?". Save sends only the difference through the existing widget/series endpoints,
  in an order the v16/v17 triggers accept (add-first below the type's series cap,
  delete-first with exact restore at the cap and on line/bar charts; the widget type
  change before or after the series changes depending on direction). After a failure the
  dashboard reloads when something may have been written (a completed step, a lost
  response, or a 409/404), and the draft is rebased 3-way (base / draft / server): a series
  whose response was lost is adopted, not posted again, and a retry after a stale
  revision keeps other users' changes. Checks before any request: series cap, a
  built-in's fixed data level, text-metric aggregation, catalog data levels, one unit per
  chart axis, comparison only on KPI. Also fixed in the H1 guided panel: "Session count" /
  "Last session date" now use data level `day`, and a metric change on a line/bar chart
  deletes first. External review (trigger #4) done by the owner on `7aea7cc`.

- **Dashboard permanent delete + deletion log** — PR #91 (`0de6afb`). Migration v19
  (`migrations_v2/202609170900_training_load_v19_dashboard_delete.sql`):
  `training_load.delete_dashboard(id, expected_revision, deleted_by_user_id,
  authorized_via)` and the append-only `training_load.dashboard_deletion_log`.
  `DELETE /api/training-load/dashboards/:id` uses the same manage rule as Rename/Archive
  (`canManageDashboardRow`); system templates are never deletable (409
  `systemTemplateProtected`); a dashboard that was cloned from cannot be deleted (409
  `dashboardHasClones`, archive instead). Owner decision (c): a platform admin keeps the
  right to delete any non-system dashboard, and every delete made through
  `delete_dashboard()` writes one log row (who, basis `owner`/`club_admin`/`team_coach`/
  `platform_admin`, what, when) in the same transaction. Only deletes through that
  function are logged; a raw SQL delete on `dashboards` is out of contract (ADR-003).
  Archive stays available.
  - **v19 on the local OPTIMOVE database**: applied 2026-09-17 with the standard runner
    (`npm --prefix backend run migrate`) after a verified `pg_dump` backup, then checked
    with a disposable probe dashboard whose rows were removed afterwards.
  - **v19 on the deployed database**: application is **inferred** from the successful
    server start of the deploy of `0de6afb` (`npm start` runs `node src/migrate.js`
    before the server, and `/api/health` reported commit `0de6afb` on 2026-09-17). The
    deployed database itself was **not** queried directly.
- **Dashboards UX H2** — PR #93 (`0a5936c`), frontend only: widget "⋯" menu (Settings,
  Advanced settings, Edit layout, Delete widget) on every widget of an editable dashboard;
  layout mode with one layout bar (Cancel / Save layout or Done; sticky on desktop, pinned
  to the bottom on phones) and layout-only per-widget tools (no-op moves disabled; phones
  get Move up/down only). An unsaved layout is never dropped silently inside Training
  Load, through the main sidebar/rail, or through browser Back: `releaseAnalysisLayoutDraft`
  / `confirmLeaveTrainingLoad` ask "Discard your unsaved layout changes?" first (a declined
  Back restores the consumed history entry). The remaining exits (notifications, workspace
  switch) were closed in H4 (PR #97).
- **Dashboards UX H1** — PR #89 (`3ef6033`), frontend only: dashboard picker (search,
  groups, badges), "New dashboard"/"Rename" dialog replacing `window.prompt`, dashboard
  "⋯" and period-preset menus, guided "Add metric" panel (changes staged client-side,
  nothing sent before Save; Save chains the existing widget/series endpoints; partial-
  failure handling for new widget, add-first, KPI delete-first and lost responses).
  `/query` evaluates only saved widgets, so there is no live preview of an unsaved widget
  (static configuration preview instead).
- **Dashboard list visibility fix** — PR #90 (`00a6d9b`): the list no longer reveals other
  users' private dashboards (`dashboardVisibilitySql` data-workspace clause guarded with
  `owner_scope <> 'user'`); see the residual drift under Open risks.
- **Training Load IA/UX redesign, Phases A–G** — PRs #82–#88, all merged: A IA shell
  (Schedule · Data & Analysis), B shared Monday-anchored week across Data & Analysis, C
  Activities identity + first Carbon-referenced visual pass, D Athletes consolidation, E
  Overview, F Dashboards hand-off + shell Filter shown unavailable on Dashboards, G cleanup
  (PR #88, removed the unreachable manual RPE reminder UI — see Separate tasks). Carbon is
  a design reference only, never a runtime dependency.
- **Training Load dashboard backend (3B2)** — schema (`migrations_v2` v15–v18: catalog,
  dashboards, widgets/series, sanctioned functions, catalog seed) + routes
  (`backend/src/routes/trainingLoadDashboard.js`) + Access/Query/Catalog/Widgets service
  split. See ADR-001 through ADR-004, ADR-006.
- **Training Load Analysis frontend (3B3)** — PR #77 (`111134d`): Analysis tab, batch
  query, KPI/Table widgets, widget/series configuration, desktop 12-column layout editing
  with real pointer drag/resize, atomic Save/Cancel/reload persistence, Calendar →
  Analysis activity picker hand-off, mobile (360/375/390px) with Move up/down instead of
  drag/resize.
- This `CLAUDE.md`/`.claude/agents/` reviewer workflow (`code-reviewer`, `db-reviewer`,
  `mobile-qa`, `security-reviewer`) — merged as part of the PR #77 history.

**Implemented ≠ deployed.** The deploy and database facts checked for this file:
- `/api/health` reported commit `0de6afb` on 2026-09-17.
- `/api/health` reported commit `6c5b3a6` on 2026-09-18.
- v20 and v21 on the deployed database are **inferred** from the successful start of
  that deploy (`npm start` runs `node src/migrate.js &&` the server). The deployed
  database itself was **not** queried.
- **v20 and v21 on the local OPTIMOVE database**: applied 2026-09-18 with the standard
  runner (owner-approved). The steps were:
  - a fresh backup taken immediately before, verified by a trial restore with
    `backend/scripts/gpexe-backup-verify.mjs` and kept outside the repo;
  - the migration run itself;
  - a direct check afterwards:
    - both new tables exist and are empty, and the three deletion-log triggers are
      enabled;
    - every table that existed before has the same row count and content digest, apart
      from the two new `schema_migrations` rows;
    - the catalog only gained objects; nothing existing changed or disappeared.
  - No GPEXE data was imported.

Re-check the hosting target and the database before asserting a deploy state later.

## Known baseline/environment test issues

Reproduce against a clean detached `origin/main` worktree before calling a failure
pre-existing; pass/fail counts don't belong in this file
(`.claude/rules/memory-maintenance.md`).

- `frontend/tests/tests-schedule-management.actions.test.mjs` — the Tests-module calendar
  click/drag day-selection tests (`startTestsCalendarDrag`/`extendTestsCalendarDrag`/
  `endTestsCalendarDrag` in `frontend/tests-actions.js`) fail; confirmed on clean
  `origin/main` before the 3B3 work. Not re-reproduced in this update.
- `backend/tests/tests-athlete-device-timezone.test.mjs` — test "13. the worker's
  occurrence-generation phase catches an ahead athlete's occurrence in its very next
  cycle…" fails; reproduced identically on a clean detached `origin/main` worktree
  (`3ef6033`) on 2026-09-17.
- `frontend/tests/training-load.actions.test.mjs` — the process never exits after the
  suite runs. It was reproduced on clean `main` on 2026-09-18, but the baseline commit
  was not recorded. Not fixed.
- `backend/tests/training-load-metrics-builder-edit-draft.test.mjs` — refuses to start
  unless `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL` is set (deliberate guard, no database
  operation attempted), so a plain full backend run reports it as failed; same on
  `3ef6033`.

## Separate tasks (recorded, waiting for the owner to schedule them)

- **In-app GPEXE import** (owner, 2026-09-18: the next functional task).
  - Planned shape:
    - "Check now" fetches from GPEXE;
    - a list of import candidates;
    - a review of what would change;
    - an explicit approve button.
  - Periodic checks and notifications can later feed the same candidate queue.
  - **One athlete** whose session data needs review stays **flagged for review**. The
    identity and details are only in the report kept outside the repo. That athlete's
    data must **not block** importing the other athletes.
  - Before any real import, take a **new verified backup** of the state at that moment.
    The 2026-09-18 backup (`...-r2.dump`, kept outside the repo) does not replace it.
  - Not approved yet: any write of GPEXE data to the local OPTIMOVE or the deployed
    database.
- **GPEXE session table readability** (owner, 2026-09-18, for later). The goal is that the
  Activities "Recorded metrics" table reads like GPEXE's own session table:
  - short column labels; `metric_definitions.short_label` and `icon_url` already exist
    (v10) but the table does not use them;
  - the unit shown once in the header, not in every cell;
  - duration as mm:ss;
  - no empty RPE columns;
  - a drill switch in the table.
  - Also: the "Choose metrics" picker is unusable at about 515 px width.
  - Importing GPEXE speed zones and max acceleration would change the import scope, so it
    needs its own decision.
- **Dashboards "Bucket" column shows raw ids** (found in PR #103). Fixing it needs readable
  labels from the backend and a security review.
- **Read the GPEXE import deletion log in the app.** Same shape as the dashboard deletion
  log task below: today `training_load.import_deletion_log` is readable only in the
  database.

- **Small Dashboards UX follow-up** (owner, 2026-09-17, found during H4): the guided
  "Add metric" panel (H1, `renderMetricPanelHtml`) closes without asking even when it
  holds staged changes, and its search field is 42px tall on phones (below the 44px
  touch-target rule).

- **Fix the known failing tests above** so a full suite run can be green again and a new
  regression can't hide among known failures: the backend worker timing test, a way to run
  or skip the edit-draft suite without `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL`, and the
  Tests-module drag-selection tests.
- **Re-home the manual RPE reminder for external ("OUTSIDE PLAN") sessions.** Its only
  entry point was the old Today tab's grouped OUTSIDE-PLAN row → per-athlete reminder
  panel, unreachable since Phase A and removed in Phase G (decision (a), 2026-09-16:
  `renderTrainingLoadTodayHtml`, the group/reminder actions and state,
  `sendExternalScheduleReminder`). The backend route
  `POST /api/training-load/external-schedules/:id/remind` and its tests are untouched.
  Proposal: per-athlete status + reminder UI in Schedule's external-schedule detail
  (`renderExternalScheduleDetailHtml`), reusing the Tests module's `reminderSelection`
  fingerprint pattern.
- **Read the dashboard deletion log in the app** (owner, 2026-09-17: kept out of PR #91 as
  a separate task; e.g. an admin-only view). Today
  `training_load.dashboard_deletion_log` is readable only in the database; no endpoint or
  UI reads it.
- **Dashboards and the shell Club/Team/Athletes filter** — see Open risks.

## Open risks

- **Dashboards ignores the shell Club/Team/Athletes filter** (Phase F, decision (b),
  2026-09-16). `POST /api/training-load/dashboards/:id/query` only receives the runtime
  activity/component filter (`analysisRuntimeFilterPayload`,
  `frontend/training-load-analysis-data.js`); `runtimeFilter.athleteIds` is never
  populated and the backend accepts `athleteIds` only, not club/team. The shell Filter is
  therefore rendered disabled on Dashboards with a visible note, while the coach's
  selection stays in `state.trainingLoad.filter` for Overview/Activities/Athletes.
  Proposed separate task: let `/query` accept `clubIds`/`teamIds` and expand them to
  member athletes server-side (same `athleteExtraFilterSql` union semantics `/weekly` and
  `/calendar` use), then feed `state.trainingLoad.filter` into
  `analysisRuntimeFilterPayload()` and `queryContextKey()` and re-enable the control.
- **Dashboard LIST visibility vs. `canViewDashboardRow` (residual drift, no leak today)**
  (PR #90, 2026-09-16). The list SQL's club owner clause admits ANY `req.authz.clubRoles`
  entry while `canManageClub` requires `role = 'club_admin'`; the team clause has the same
  shape (`teamRoles` ∪ `managedTeamIds`). Unreachable today — every current writer of
  `public.user_club_roles` inserts `club_admin` only and only club admins can activate a
  club workspace. security-reviewer (MEDIUM, out of scope): for such a non-admin member
  active in a DIFFERENT workspace the list would show the club/team-owned board while the
  single GET 404s — a list/GET split, not a private-data leak. If a non-admin club/team
  role is ever introduced, decide the contract first (list = only what GET allows is the
  ADR-006-consistent choice), filter those clauses with the shared role predicates in
  `backend/src/authz.js` (`holdsClubAdminRole`, `holdsTeamCoachRole`,
  `managesTeamThroughClub`, extracted in PR #91) and add a list+GET test for the new role.
- **Not exercised in a live browser yet** (unit-tested only): "Use template"/clone and
  the Calendar → Analysis "Choose activity" round trip. Dashboard create and the guided
  "Add metric" panel (`renderMetricPanelHtml`) were live-checked in PR #89's browser QA,
  the advanced editor with its series metric picker (`renderMetricPickerHtml`) in PR
  #95's, and the notification / workspace-switch leave guard in PR #97's.
- **Leaving the app with unsaved Dashboards changes** (found during H4, not scheduled):
  signing out, reloading the page or closing the tab still leaves without asking about an
  unsaved layout or Advanced settings change (no `beforeunload` guard).
- **The GPEXE undo CLI cannot authenticate its operator** (PR #104). It is limited to
  disposable databases. The runbook lists what a persistent-database unlock would need
  first: a real authenticated identity, a narrow break-glass credential, and a second
  person's approval.
- `migrations/` (legacy, no `_v2` suffix) still exists alongside `migrations_v2/` — treat
  it as historical/reference only; new migrations go in `migrations_v2/`.

## Most likely next step

The **in-app GPEXE import** (see Separate tasks). It is the last open step of the owner's
2026-09-18 order; the local migrations and this state update are done.

The other Separate tasks wait until the owner schedules them.

## How to refresh this file

After a merged milestone or a change in active phase: update the "last reviewed"
line/commit at the top, move the newly-completed phase into "Last completed, merged
phases," and re-derive "Open risks"/"Separate tasks"/"Most likely next step" from the
actual current state — don't carry stale entries forward unexamined. See
`.claude/rules/memory-maintenance.md`.
