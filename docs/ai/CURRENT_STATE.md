# Current state

Last reviewed: 2026-09-24. Last `origin/main` commit checked: `ca6d48f` (merge of PR #118,
`fix/gpexe-import-access-guards` → `main`).

## Active phase

The **Training Load Dashboards UX redesign (H-slices)** is complete: H1 (PR #89), H2
(PR #93), H3 (PR #95) and H4 (PR #97) are merged, no further slice is scheduled, and the
small follow-up found during H4 is recorded under Separate tasks.

Alongside it, the **GPEXE import groundwork** is merged:
- the pilot importer (PR #99);
- database uniqueness and threshold bindings (v20, PR #101);
- a rehearsed undo of one imported session (PR #102);
- session and drill display in Activities (PR #103);
- undo authorization with a database deletion log (v21) and a backup proven by a trial
  restore (PR #104).

On top of it, the **in-app GPEXE import** phases F1 (check, candidates, preview; PR #106)
and F2 (approve and import; PR #107) are merged, and so are the coach screens F3a
(PR #110), the documentation consolidation (PR #112) and the settings change guard with
migration v24 (PR #113).

**The minimal F3b is merged** (PR #114, `f32e262`): a platform-admin-only `Settings →
Data sources` sub-tab — choose a team, see and set its GPEXE connection (first connect
without a reason, a change only with one, the same value idempotent, every v24 refusal in
plain administrator language), grant or revoke a coach's right to approve an import with
a reason and a confirmation naming the coach and the team. Deliberately out of it:
Disconnect, retention UI, the import switch, any real import.

**The active phase is the source-neutral Imports track** (owner's mission, 2026-09-22;
blueprint v3.1 accepted as the direction on 2026-09-23). GPEXE is the first data source,
not the name of the feature; future sources (Garmin, Catapult, Polar, Kinexon, …) are
further Source cards on the same screen, never a new top-level screen. Phase 2 (the
Imports shell, PR #115), Phase 2b (candidate list reasons, PR #116), Phase 3a (the
read-only source-athletes endpoint, PR #117) and the guard PR before Phase 3b (one
canonical GPEXE athlete id, archived teams answer 404; PR #118) are merged and deployed
(see below). **The step in progress is Phase 3b, the whole-team linking screen** (branch
`feature/imports-team-mapping`, frontend only): a *Link athletes* screen opened from the
Imports page lists every GPEXE athlete of the team once (`GET …/source-athletes`) with the
last session's helper values (Time, Distance, Top speed, Drills — "—" where the source gave
none), grouped *Not linked / Linked to an athlete no longer in the team / Linked*; the
coach chooses a team athlete per GPEXE athlete (active members not yet linked; two
athletes with the same name cannot be chosen; nothing is preselected, choices are staged
in state so a repaint never loses them), *Confirm N links* shows every pair with the
consequences, *Link N athletes* sends them one by one through the existing link route and
shows one result per pair (linked / not linked with the reason / not confirmed when the
answer was lost); *Unlink* is right there with the same question as elsewhere. Any link
made or possibly made marks the reviews on screen as made with the old links ("Find new
sessions…"). No name comes from the source; ids and codes only under Technical details.
No backend change, no migration, no batch import. Phases 4–6 (batch import, completion
model and roster, session context, add-later-values) wait for the owner's go after each
merge.

**Production-readiness checks recorded by the owner (2026-09-24), not gates for
development:** before the first real use of athlete linking and before
`GPEXE_IMPORT_APPLY_ENABLED` is turned on, the deployed `gpexe_athlete_links` must be
checked read-only for a non-canonical id (`select count(*) from
training_load.gpexe_athlete_links where gpexe_athlete_id !~ '^(0|[1-9][0-9]{0,11})$'`,
expected 0 — it could not be run from the development workstation, which has no path to
the deployed database); and a "Check now" already running when its team is archived still
completes and writes candidates (the background job does not re-resolve access) — to be
fixed before regular production imports (see condition 5 under Separate tasks).

All of it is code only. **`GPEXE_IMPORT_APPLY_ENABLED` is off in every environment and no
GPEXE data has been imported into the local OPTIMOVE or the deployed database**, so
nothing imported is visible in the app.

## Last completed, merged phases

- **GPEXE guards before Phase 3b** — PR #118 (`ca6d48f`, reviewed head `19c7866`),
  backend only: one canonical GPEXE athlete id wherever it enters (`"0"` or digits without
  a leading zero, at most 12; `GPEXE_ATHLETE_ID_PATTERN` in `gpexeImportMapper.js`) — the
  link route answers `400 invalid_gpexe_athlete_id` before any lock or write, the mapper
  refuses a snapshot row with a non-canonical id (`invalid_athlete_id`, inconsistent
  source data), the source-athletes list takes only canonical ids from previews and raw
  rows (bound as a parameter); a link row written before the rule is listed as stored. An
  archived team resolves to the same 404 as a missing one on every GPEXE route, for its
  coach, its club admin and a platform admin (Settings → Data sources therefore shows an
  archived team as not available). No migration: the v22 check stays the wider
  `^[0-9]{1,12}$`. Reviewed by `code-reviewer` and `security-reviewer`; external review by
  the owner.
- **Imports Phase 3a: read-only source-athletes endpoint** — PR #117 (`8d2841b`, reviewed
  head `2731ed2`): `GET /api/training-load/gpexe/teams/:teamId/source-athletes` lists the
  team's GPEXE athletes once each — every athlete seen in a snapshot that is still
  available (not purged, not expired) plus every athlete with an active link — with
  `status` (`linked` / `unlinked` / `linked_inactive`), the link (the OptiMove name only
  from it; no GPEXE name, it is never stored), a deterministic `lastSeen` (newest session
  date; same date: current before replaced, then the later sighting, then the larger id;
  `evidence` `preview` or `raw_snapshot`; the session's own `sessionDrillsCount`) and the
  athlete's `values` (`duration`, `distance`, `maxSpeed`; missing = `null`). A refused
  session's raw snapshot is a fallback only: it adds an athlete no available preview
  names, never replacing a preview sighting (owner decision (b)); the array guard sits
  inside the `jsonb_array_elements` argument. One SQL statement whatever the number of
  candidates or athletes (contract test); same readers and 404 as the candidates; security
  and isolation tests. Reviewed by `code-reviewer` and `security-reviewer`; external
  review by the owner (three rounds).
- **Imports Phase 2b: candidate list reasons** — PR #116 (`12d57ff`, reviewed head
  `a94f01b`): every candidate summary additionally carries `blockedCode` (source-neutral),
  `blockedSourceCode` (the adapter's own code, for Technical details), `sessionType` and
  `reasons` (one `{ code, count }` per kind), derived in memory from the stored preview
  the list query already reads (`backend/src/gpexeImportReasons.js`); no new SQL, and a
  contract test proves the list runs the same number of statements for one candidate as
  for four. The Imports inbox sorts every row from the list alone; the per-blocked-session
  detail read is gone. Reviewed by `code-reviewer`.
- **Imports Phase 2: the Imports shell** — PR #115 (`10d035a`, reviewed head `20c4273`),
  frontend only: the coach's tab is *Imports*; one Source card per source (GPEXE) with
  the connection state, "Sessions found …", one *Find new sessions* button and the dates
  folded away (opened and pre-filled, clipped to 31 days, only when a session needs
  other dates); the sessions sorted into *Needs attention / Ready to import / Stays out /
  Imported* from the fields the list returns (a session with an unlinked recorded
  athlete, or in which nobody is linked yet, is never "ready" or "up to date"); the Ready
  header and the next step say "review only" while the switch is off or the viewer may
  not approve; Ready locked after a link change until the sessions are found again; a
  workspace with no team shows one sentence plus the existing workspace menu (button
  only when the menu has another team or club to offer). Ids, statuses and server
  sentences only under Technical details. Reviewed by `code-reviewer`,
  `ux-design-reviewer` and `mobile-qa`; browser QA on a disposable schema clone.
- **In-app GPEXE import F3a: coach screens** — PR #110 (`ed49031`, reviewed head
  `4d36781`), frontend only: a "GPEXE imports" sub-tab in Training Load → Data &
  Analysis (`frontend/gpexe-import-{data,view,actions}.js`) on the F1/F2 routes.
  - Sessions are grouped by what the coach has to do (needs a decision, can't be imported
    yet, stays out, up to date, imported). A blocked session's reason and step come from
    its own detail.
  - The review shows participation and GPS apart, coach metric names (GPEXE's names only
    in Technical details), each left-out value with level, metric and reason, and every
    change to an already-imported result behind an accept checkbox.
  - Outcomes: imported, not imported (only an explicit refusal), and unknown. An unknown
    outcome is never shown as "not imported", stays marked in the list, and after three
    checks the coach is sent to a platform admin.
  - **Linking a GPEXE athlete** (owner decision (b), 2026-09-19): the session's values
    only help to find the athlete in GPEXE; no athlete is preselected; a confirmation
    shows both sides and says the link applies to this session and every GPEXE session
    imported later; a name shared by two team athletes can't be confirmed. After a link
    change a session's review is not approvable until a check that started after the
    change has seen that session (the server's preview hash check stays the real guard).
  - Reviewed by `code-reviewer`, `mobile-qa` and the `ux-design-reviewer` agent. That
    agent was added to `main` by PR #111, which is merged; this stacked docs branch predates it.

- **A team's GPEXE connection is only changeable while nothing depends on it** — PR #113
  (`4a60fa7`, reviewed head `238de27`), migration v24
  (`migrations_v2/202609211000_training_load_v24_gpexe_settings_change_guard.sql`).
  - `PUT /settings` allows the first connection, an idempotent repeat of the same value,
    and a change only while the team has no check, candidate, athlete link, approval or
    imported GPEXE data. Otherwise: 409 `gpexe_team_change_blocked`. The guard and the
    write are one transaction under the team import lock.
  - `change_reason` (v24): a first connection may carry one, a change requires one
    (trimmed, non-empty, at most 500 characters), a repeat of the same value writes no
    history row and never overwrites the reason. The history stays append-only and
    admin-only; rows from before v24 keep a NULL reason.
  - The database refuses the rest whoever writes it, psql included: the settings row is
    never moved to another team, never deleted or truncated; a first connection over
    leftover GPEXE data is refused (409 `gpexe_orphan_data`); an athlete link needs the
    connection; a check row carries the team's current GPEXE team and that identity is
    final from the row's creation (a row from before v24 stays empty forever); a check
    row is never deleted.
  - `startCheck` takes the team lock in one short transaction, writes the check row with
    the locked GPEXE identity, commits, and only then calls GPEXE.
  - No Disconnect, nothing deleted or re-pointed, the import switch untouched.
  - External review by the owner: three rounds; `db-reviewer` and `code-reviewer` READY.
- **Documentation consolidation** — PR #112 (`a18b9cb`), docs only: it replaced the
  stacked documentation PRs #98, #100, #105 and #109, which were closed as superseded.
- **Reviewer rule for transactions with an external effect** — PR #108 (`636fdf3`),
  `.claude/agents/code-reviewer.md` and `db-reviewer.md` only. For a change to a
  transaction that writes important data (import, deletion, approval), the reviewers
  check five things before READY:
  - an error before, during and after a successful COMMIT;
  - success, an explicit error, and an answer that never comes;
  - that the answer tells apart "not written", "written" and "outcome unknown";
  - the connection, the locks and a retried request in each outcome;
  - one targeted test through the real route.

  Owner decision: it stays in the two agent files, not in a shared rules file.
- **In-app GPEXE import F2: approving imports** — PR #107 (`cb3399a`, reviewed head
  `d1d92db`), migration v23
  (`migrations_v2/202609201000_training_load_v23_gpexe_import_approval.sql`).
  - `POST /api/training-load/gpexe/teams/:teamId/candidates/:candidateId/approve
    {previewHash, acceptChanges}` imports the **whole candidate** exactly as its preview
    showed it. Refused with nothing written when:
    - the switch is off;
    - the caller has no right;
    - the candidate is not pending, or its snapshot expired;
    - the preview is not the one reviewed;
    - changes to already imported results were not accepted.
  - **One transaction:** approver rights (`lock_gpexe_import_approver`, role, grant and
    user rows `FOR SHARE`) → candidate `FOR UPDATE` → team import lock → the import and
    the preview recomputed from it → hash compare → approval row → candidate `imported`.
    A different hash rolls everything back, including what the import wrote, and answers
    409 `preview_changed` with `reviewAgain`.
  - **Preview v2 `changesToImported`** lists every already imported result the import
    writes to (`corrected`, `supplemented`, `needs_review`, `stale_resend_ignored`). The
    approval needs `acceptChanges` for them.
  - **v23:** `training_load.gpexe_import_approvals`, one per candidate. It is append-only
    and cannot be truncated. Its trigger re-checks:
    - the right and its basis;
    - the candidate's state, content hash and preview hash;
    - the number of changes.

    A candidate becomes `imported` only from `pending` with its approval, and is never
    inserted as `imported`.
  - **The COMMIT's outcome** (two external review rounds):
    - once the COMMIT is sent, the answer never says "nothing was imported";
    - the answer to the COMMIT is awaited at most 15 s. After an error or that time, the
      connection is closed, and the approval is looked for on another connection (at most
      5 s);
    - the answer is then `200` with `verified_after_commit_error`, or `503
      import_outcome_unknown` with `verify` links;
    - `GET .../approvals/:approvalId` exists, and an imported candidate names its
      approval;
    - a failed candidate read after the commit still answers `200` with
      `candidateReadError`.
  - External review by the owner: three rounds, READY on `d1d92db`.
- **In-app GPEXE import F1: check, candidates, preview** — PR #106 (`96d876d`, reviewed
  head `b070a54`), migration v22 (`migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql`).
  - **"Check now"** runs in the background and reads GPEXE through a fixed-host,
    GET-only client (`backend/src/gpexeClient.js`). Header paging is read to the end or
    refused.
  - **Candidates:** one per (team, session, content). New content supersedes older
    candidates that were never imported.
  - **The preview** is a rolled-back run of the real import under the team lock. It
    shows participation and GPS separately and gives a reason for every left-out value.
    An athlete imported earlier and now left out blocks the session, with the step that
    lifts it.
  - **Approver grants** (platform admin only), athlete links, raw-snapshot retention
    (30 days unapproved, 90 days after import), and a purge that does not depend on one
    process.
  - The real GPEXE API was checked read-only by the owner's probe
    (`backend/scripts/gpexe-api-probe.mjs`).
  - Runbook: `docs/runbooks/gpexe-in-app-import.md`, which also covers F2.
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
- `/api/health` reported commit `ca6d48f` (PR #118) with `ok: true` on 2026-09-24 (three
  consecutive checks); the GPEXE routes answered 401 without a login. No search or import
  was run in production.
- `/api/health` reported commit `8d2841b` (PR #117) with `ok: true` on 2026-09-24 (three
  consecutive checks); the new source-athletes route answered 401 without a login. No
  search or import was run in production.
- `/api/health` reported commit `12d57ff` (PR #116) with `ok: true` on 2026-09-23; the
  served bundle carried the new row sentences and none of the removed detail-read code,
  and a GPEXE route answered 401 without a login. No search or import was run in
  production.
- `/api/health` reported commit `10d035a` (PR #115) with `ok: true` on 2026-09-23; the
  served bundle contained the Imports screen (the "Find new sessions" button, the four
  bucket headings, the no-team sentence; the old "Check GPEXE" text gone) and a GPEXE
  route answered 401 without a login. No search or import was run in production.
- `/api/health` reported commit `f32e262` (PR #114) with `ok: true` on 2026-09-22; the
  served bundle contained the Data sources screen and the new
  `GET …/settings/history` route answered 401 without a login. The owner accepted that
  unauthenticated smoke as sufficient (admin/coach visibility is covered by tests and the
  disposable-database browser QA). No Check, Connect, grant, revoke or import was run in
  production.
- `/api/health` reported commit `a18b9cb` (PR #112) with `ok: true` on 2026-09-21, and
  `4a60fa7` (PR #113) with `ok: true` on 2026-09-21 after that merge.
- **v24 on the deployed database is inferred** from the successful start of the deploy of
  `4a60fa7` (`npm start` runs `node src/migrate.js &&` the server). The deployed database
  itself was **not** queried.
- **v22, v23 and v24 are not applied to the local OPTIMOVE database**, which is at v21.
  Applying them is a separate decision.
- `/api/health` reported commit `0de6afb` on 2026-09-17.
- `/api/health` reported commit `6c5b3a6` on 2026-09-18.
- `/api/health` reported commit `96d876d` (F1) and later `cb3399a` (F2) on 2026-09-18.
  The new GPEXE routes answered 401 when called without a login on the deployed app
  (checked on 2026-09-18), as expected from `requireAuth` on the whole router.
- `/api/health` reported commit `ed49031` (F3a) with `ok: true` on 2026-09-19. The
  served frontend contains the GPEXE imports screens, and a GPEXE route answered 401
  without a login. The tab itself was not opened on the deployed app (no signed-in
  session there).
- **v22 and v23 on the deployed database are inferred** from the successful start of
  those deploys (`npm start` runs `node src/migrate.js &&` the server). The deployed
  database itself was **not** queried.
- `GPEXE_IMPORT_APPLY_ENABLED` is off in both environments. No real import has been run.
- v20 and v21 on the deployed database are **inferred** from the successful start of
  the deploy of `6c5b3a6` (`npm start` runs `node src/migrate.js &&` the server). The
  deployed database itself was **not** queried.
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

- **In-app GPEXE import — conditions before the switch is turned on** (owner, 2026-09-18).
  F1, F2, F3a and F3b are merged (see above); F4 is the first real local import. `GPEXE_IMPORT_APPLY_ENABLED` stays off in an
  environment until conditions 1–3 hold there; condition 4 is required before regular
  production imports:
  1. **A fresh, restore-verified backup of that environment.** This is an operational
     gate: `docs/runbooks/gpexe-in-app-import.md` has a record table (backup path or
     identifier, `.verify.json`, when it was verified, who confirmed it). The local
     OPTIMOVE and Supabase are separate decisions. The app never claims a backup was
     checked. Before regular self-service imports, a mechanism that reliably checks
     backup freshness is to be proposed, instead of a switch left on.
  2. **A bound on the lock waits before the COMMIT** of an approval: the approver's role
     and grant rows, the candidate, and the team import lock. For example `lock_timeout`
     and `idle_in_transaction_session_timeout` with a stable refusal code, and the
     deployed request timeout confirmed. Today another approval of the same team, or a
     transaction abandoned on a real network stall, can make an approval wait with no
     limit.
  3. **The undo script takes the team import lock** (`lockTeamForImport`) before it is
     ever used on a persistent database. Today it runs only on disposable databases.
  4. **Mandatory before regular production imports** (owner, 2026-09-19): a safe,
     verified production procedure for results imported under a wrongly linked GPEXE
     athlete. Unlinking only ends the link and never changes imported results; the app
     tells the coach those results "can't be changed here — contact a platform
     administrator". Today the only path is the controlled admin undo
     (`docs/runbooks/gpexe-undo-imported-session.md`), rehearsed on disposable databases
     only. The procedure must be defined and verified.
  5. **Mandatory before regular production imports** (owner, 2026-09-24): a "Check now"
     that is already running when its team is archived still completes and writes its
     candidates — the background job does not re-resolve access (PR #118 closed the routes
     only). Not a blocker for the guard PR or Phase 3b; must be fixed before regular
     production imports are switched on.
  - Planned shape (as built in F1–F2):
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
  - Owner decisions for the plan, 2026-09-18. F1 was approved to start.
    - **Phases:**
      - F1: fetch, candidates and preview;
      - F2: approval and the actual import;
      - F3: screens;
      - F4: the first real local import, after a fresh verified backup.
    - **Credentials:** the GPEXE token lives only in the server environment
      (`GPEXE_API_TOKEN`).
    - **Who may approve:** an active platform admin, or a coach who holds an explicit
      approver grant for that team. Only a platform admin grants and revokes those
      grants. The server checks the right on every request and records who approved.
      Coaches without the grant can review candidates but not approve them.
    - **`GPEXE_IMPORT_APPLY_ENABLED`:** it blocks writing results and activities. "Check
      now" still writes candidates and the check record. When it may be turned on: see
      the three conditions above.
    - **Raw GPEXE JSON retention:**
      - kept for 90 days after import;
      - kept for 30 days for a candidate that was never approved;
      - the hash, source mapping, decision, approver and write report are kept.
      - Deletion must not depend only on the server process running every day.
      - A candidate whose raw snapshot has expired can no longer be approved; it has to
        be checked again.
    - **The review shows participation and the GPS measurement separately.** A missing
      value is not a zero. "GPS was not worn" is shown only when the data confirms it or
      a coach enters it.
- **Tighten the v22 database check on `gpexe_athlete_links.gpexe_athlete_id`** to the
  canonical pattern (`^(0|[1-9][0-9]{0,11})$`) — a migration, separate decision; the
  application rule is enforced by the guard PR. Whether the deployed database holds any
  leading-zero id could not be checked from this workstation (the local OPTIMOVE database
  is at v21 and has no GPEXE tables); the ids the app stores come from GPEXE numbers and
  from preview entries, so none is expected.
- **Small Imports follow-ups** (found in PR #115, not scheduled): a hand-typed date in
  the source card's *Choose dates* is lost on a repaint (pre-existing); the review modal's
  badges still use the old vocabulary ("Waiting for approval"), to be aligned with the
  buckets; `errorInfo`/`fmtDateTime` are duplicated between the coach
  (`gpexe-import-*.js`) and admin (`data-sources-*.js`) screens.
- **Athletes who trained without a GPS record** (owner, 2026-09-18). Scheduled after
  phases F1–F3 of the in-app import. Options, none of them decided yet:
  - participation only, with no values;
  - a manual entry by the coach;
  - an estimate from the team average, the position average, another athlete or a
    similar session.

  An estimate is never stored as a GPEXE measurement. It is stored as an estimate, with
  its source and method, close to the future derived-metrics feature.
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
- **An approval can wait without a limit before its COMMIT** (PR #107 reviews, not fixed).
  It waits on the role and grant rows, the candidate row, and the team import lock. It
  also waits when a transaction abandoned on a network stall keeps those locks until TCP
  keepalive notices. This is condition 2 in Separate tasks.
- **The GPEXE undo CLI cannot authenticate its operator** (PR #104). It is limited to
  disposable databases. The runbook lists what a persistent-database unlock would need
  first: a real authenticated identity, a narrow break-glass credential, and a second
  person's approval.
- `migrations/` (legacy, no `_v2` suffix) still exists alongside `migrations_v2/` — treat
  it as historical/reference only; new migrations go in `migrations_v2/`.

## Most likely next step

**Phase 3b of the Imports track (`feature/imports-team-mapping`, the whole-team linking
screen) is in progress**; see Active phase for its exact scope. The owner decides the next phase after each merge. Conditions
1-3 under Separate tasks still come before the first real local import, and condition 4
before regular production imports. The owner's decisions of 2026-09-23 on estimates,
completion and session context (blueprint v3.1, section 14) shape Phases 5a–6 and are
not implemented yet.

The other Separate tasks wait until the owner schedules them.

## How to refresh this file

After a merged milestone or a change in active phase: update the "last reviewed"
line/commit at the top, move the newly-completed phase into "Last completed, merged
phases," and re-derive "Open risks"/"Separate tasks"/"Most likely next step" from the
actual current state — don't carry stale entries forward unexamined. See
`.claude/rules/memory-maintenance.md`.
