# P3: reference tables and Radar contract

Status: proposal for owner and independent review; documentation only.
Verified base: `963e1c0fc0a4a2ba27c45539a5f8fc28ae5856db` (2026-11-24).
No implementation, migration, activation, merge or deployment is authorized by this document.
P2 #742 is under review and is not changed here.

## 1. Outcome and boundaries

A coach chooses a named reference table, such as **Game targets by position** or
**Return to play**, then chooses the named values to draw beside actual results.
Each position/variable cell can contain several named values: Minimum, Maximum,
Target and additional owner-defined values. A band explicitly selects its two values.
Radar compares an athlete or a deliberately selected group with those references.
Missing references are never replaced by zero, a team average or a made-up target.

Reference tables belong under **Training Load > Data configuration > Reference tables**.
The position list remains the existing registry; this screen does not create another one.
First delivery is manual entry. File import later fills the same draft and uses the
same validation and publication operation. Simple multi-variable tables, new athlete
viewer rights and historical/event-time position assignment are separate work.

## 2. Verified dependencies and permission boundary

Sources: [R4 roles](roles-r4-contract.md), [positions](athlete-positions-plan.md),
[ADR-002](../decisions/ADR-002-owner-scope-vs-data-workspace.md),
[ADR-003](../decisions/ADR-003-dashboard-sanctioned-writes.md),
[ADR-006](../decisions/ADR-006-info-hiding-authorization.md),
`backend/src/permissions.js`, `backend/src/positionService.js`, and
`migrations_v2/202611221200_athletes_v87_positions.sql` at the verified base.
The position plan's old “not merged” heading is historical; v87 exists on this base.

Use the existing `can(authz, word, resourceScope)` and active-workspace resolution,
not role names, role_hint, client role tests or a copy of the R4 algorithm. R4's club
ceiling, club role version, user custom items and shared platform-admin exemption
remain authoritative. Workspace compatibility, ownership and permission are separate gates.

Proposed mapping, requiring confirmation with the roles stream before code:

| Operation | Existing permission word and additional gate |
|---|---|
| List/read a club's tables and published versions | `variables.view` on the resource club; permitted active data context |
| Create/edit/publish/archive a club's table | `variables.view` plus `variables.manage` on the resource club |
| Read a reference bound to a dashboard | Existing dashboard view/ownership gate plus `dashboards.view`, `variables.view`, and visibility of each metric |
| Change a widget's reference binding | Existing dashboard manage/ownership gate plus `dashboards.manage` and reference read rights; no table-edit right required |

These words exist in the catalog, but `variables.view`, `variables.manage`,
`dashboards.view` and `dashboards.manage` are **not** in `ENFORCED_PERMISSIONS`
on this base; `variables.manage` is not yet storable either. Catalog presence is
not a working delegation contract. P3 must wait for the corresponding R4 module
steps or explicitly coordinate their complete gate migration with that stream.
Do not enable a partial word on P3 routes alone, seed it ad hoc, or fall back to
“club admin” checks. Private-coach and athlete workspaces gain no new access here.
Recommendation: club-owned tables first; system reference templates are a later
explicit scope decision, not inferred from the system position registry.

The dashboard owner is not automatically the reference-data owner. A platform-owned
dashboard reading club facts uses that club's table and position assignments only
when authorized. Reference lookup never supplies additional athletes or facts.
The existing data_workspace fact set and shell hard intersection stay intact.
A cross-club result must be segmented by authorized club context; no assignment
or target is borrowed from another club because the athlete id is the same.

## 3. Proposed storage and versions

Names below are proposed schema identifiers, not existing objects or allocated migrations.
Use `training_load` tables with stable UUID identities and restrictive foreign keys:

- `dashboard_reference_tables`: club ownership, name, archive state, revision,
  published version pointer, creation/update actor and timestamps. Names are trimmed,
  1–80 characters, case-insensitively unique among the club's live tables and follow
  the admin APIs' existing invisible-character rule.
- `dashboard_reference_versions`: table, monotonic version number, draft/published
  state, revision, publisher and timestamp. Published contents are immutable.
- Version columns: ordered metric-definition identities, display label snapshot,
  canonical unit and applicable aggregation/data-level semantics. No binding by name.
- Version rows: ordered target identities. First delivery permits only a position
  target referencing `public.sport_positions`. A typed target discriminator and
  exclusive target foreign keys reserve team/athlete row kinds without enabling
  them; a future import does not add a new target kind or a parallel storage model.
- Version value definitions: stable named value identities, label, order and optional
  semantic hint (minimum/maximum/target/custom). No three fixed numeric columns.
- Cell values: unique (version, row, column, named value), finite numeric amount and
  canonical unit. A missing row is absence, never zero. Explicit zero is a value.
- An append-only audit/request ledger records draft changes/publication, actor,
  request id, content hash and receipt. Bounded retention and its scheduler caller,
  guards and refusal semantics are delivered together, following existing ledgers.

Every child belongs to exactly one table/version; composite foreign keys prevent
cross-version cells or a binding mixing columns from different tables. Publication
validates all rows, definitions, visibility, units and selected bands atomically.
No observation or metric definition is rewritten by editing a reference.
Initial resource limits and maximum cells/request bytes must be explicit, shared by
manual and future import paths, tested at the boundary and documented before code review.

Editing creates/updates a draft from a published version. Publication creates a new
immutable version and advances the table pointer under an expected revision.
Archive removes a table from new pickers; authorized existing pinned bindings can
still read its published version. No hard delete of referenced versions.
Revoked access still takes effect immediately; pinning never preserves permission.

## 4. Positions, variables and unavailable results

v87's `public.sport_positions` is the sole position registry. Resolve effective names
through club overrides in `public.club_position_overrides`; never copy system rows
into a P3 position registry. Athlete assignment comes from the latest `seq` in
`public.athlete_positions` for **athlete and club**; null means unassigned.
Recommendation: current assignment at query time for this delivery, disclosed in
the screen. It is not the position at the session date. Return the resolved identity
and evaluation time internally so a refresh is explainable.

Existing hidden/archived position assignments retain their identities. They are not
new picker choices; show an authorized existing binding with its retained label and
an archive/hidden indication. Renaming a position never moves values to another row.
A cleared or inaccessible assignment does not fall back to a previous assignment.
Metric columns use canonical definition ids; renames update display only. An
archived/inaccessible variable is not offered for new columns and never silently
replaced by a similarly named variable.

| Condition | Coach-facing sentence and next step |
|---|---|
| No assignment | “Reference not available: no position is selected.” / “Choose a position in the athlete profile.” |
| No cell/named value | “Reference not available for this position and metric.” / “Choose another reference value.” |
| Missing/hidden variable or revoked reference access | “This reference is not available.” / “Choose another reference table.” |
| Incompatible unit or aggregation | “This reference does not match the metric's unit or calculation.” / “Choose a matching reference.” |
| Mixed positions in a group | “This group has more than one position.” / “Choose one position.” |

Unavailable reference metadata is per axis/series; the actual result and other
valid references remain visible. Use a visible “Not available” state and reason,
not a fabricated polygon point, zero, infinity or misleading complete band.
Normal metric conflicts retain their existing status. No athlete ids, source ids,
raw JSON, tokens or fingerprints in rendered text, attributes or collapsed content.

## 5. Binding a chart and evaluating Radar

A widget's presentation binds a published table version and an explicit reference
club context. Each axis/series maps a metric definition to that version's column,
selects named value ids, and selects position resolution (`athleteCurrentPosition`
or an explicitly chosen position for a single-position group). This is one binding
model for line/bar references, bands and Radar, not separate target stores.

Recommendation: pin a published version. “Update reference version” is an explicit
widget edit with preview and optimistic concurrency; publishing alone does not
rewrite existing charts. Query/cache identity includes table version, binding,
position resolution and existing runtime context. Current access/assignment changes
invalidate relevant results even when the published version remains pinned.
Copy/clone remaps widget/series identities but retains authorized pinned bindings;
if destination access is absent, report an unavailable binding, never copy private
reference contents or select a different table automatically.

Actuals come from the existing dashboard query, including source policy, conflicts,
ratios and the shell narrowing. A reference is an absolute value in the column's
unit and stated aggregation/data level, not a fact contributing to that query.
A ratio uses the existing paired-input weighted aggregation and scale; references
do not average stored ratios or alter coverage. Athlete-workspace restrictions on
calculated variables and estimates are unchanged.

Proposed Radar display: one axis per variable and one actual series per selected
athlete/group. An explicit, selected positive reference value is the normalization
anchor: `100 * actual / anchor`; the same conversion draws other selected reference
values and band boundaries. Label 100 as the chosen reference, not automatically
“good”. Never infer “lower is better” from a metric's name. Tooltips show the raw
actual and reference amounts/units and the pinned table/version. Do not clamp
values over 100. A nonpositive/missing anchor or a negative value unsupported by
the Radar geometry makes that axis unavailable with a plain explanation; the
ordinary table can still display the actual. This normalization choice needs owner
confirmation (question 3), including metrics requiring another scale.

A band requires two explicitly selected compatible named values with lower <= upper;
it is not inferred from labels. Missing one endpoint means no band, with a reason.
For group Radar, recommend one position cohort at a time; do not average targets
from different positions. Use the existing authorized roster comparator and safe
names; legend items can be hidden/restored, preserve widget legend settings and
remain distinct for athletes with identical names. Tooltips/tables use DD.MM.YYYY,
short date axes DD.MM.; use the existing number formatter and units.

## 6. Proposed API and atomic writes

Paths are proposals to review, not currently mounted routes:

- `GET /api/training-load/reference-tables`: authorized table summaries/capabilities.
- `GET /api/training-load/reference-tables/:id`: metadata, draft revision and published versions.
- `GET /api/training-load/reference-tables/:id/versions/:versionId`: authorized snapshot.
- `POST /api/training-load/reference-tables`: create table plus empty draft.
- `PATCH /api/training-load/reference-tables/:id/draft`: bounded atomic cell/structure
  changes with requestId and expectedRevision; null explicitly clears a value.
- `POST /api/training-load/reference-tables/:id/publish`: validate and publish draft.
- `POST /api/training-load/reference-tables/:id/archive`: archive with expectedRevision.

Existing dashboard query and Simple preview gain the same reference-result envelope
(actual, selected reference values, unit, availability/reason and pinned version).
Existing sanctioned Advanced/Simple/page save paths validate and persist bindings;
preview fingerprints include the full binding and version. Runtime shell selection
remains runtime-only and is never written into saved default/effective filters.
No new route may bypass the Simple pilot or page activation gates.

Foreign/missing/inaccessible table, version, cell and nested resource ids yield
ADR-006's identical missing-route 404 (status, body and headers); authenticated
validation cannot probe visibility. Authentication retains the router's existing
unauthenticated behavior. Malformed/oversize input is 400; stale revision or reused
request id with another payload is 409; responses give a safe sentence/action.
Do not return unauthorized input variable labels in a formula or column header.

Writes use sanctioned Postgres functions, not application raw cell inserts. A
request advisory lock precedes row locks. Reference edits lock table -> draft
version -> children in deterministic order. Dashboard writes keep dashboard ->
page -> widget -> series. Published snapshots are immutable, so binding validation
must not acquire reference draft locks after a widget lock; authorize/resolve a
published snapshot without introducing an inverse locking chain. Publication never
locks dashboard rows. Record SQL order and test concurrent publication, editing,
save, copy and revocation rather than relying on this description alone.

## 7. React screens and interaction

New screens are React islands using the foundation's mount/unmount helper and
component tests once its main commit and rules are supplied. The plain-JS rule on
this base predates the owner's React decision and is not a reason to add new
plain-JS P3 screens. No React dependencies or UI are introduced in this docs PR.

1. Reference table list: named tables, published version, availability and one Add
   table action when the server capability permits it.
2. Table editor: positions as rows, variables as columns, expandable named values
   per cell; draft/published state, explicit Save draft and Publish. A compact cell
   editor works at 360/390 px; horizontal scrolling stays inside the matrix.
3. Widget reference picker: table -> published version -> named values/band ->
   preview. Safe position names and real metric picker; no typed ids.
4. Radar configuration and display: metric axes, explicit anchor, athlete/position
   cohort selection, legend toggles and an accessible companion table.

Capabilities come from the server. One problem gets one plain sentence and one
next action; state uses a sign/label as well as color/count. Technical details are
platform-admin-only and are not inserted into a coach's DOM. Collapse choices are
remembered as existing dashboard controls are. Browser PDF respects visual widget
order, hides controls and includes only expanded data tables, using P2 output
handling after #742 is merged. Screen-reader labels never expose raw identifiers.

## 8. Migration and rollout plan

Future implementation is RISKY: schema, authorization and dashboard writes. No
migration number or prefix is allocated here; ask the owner on the day code starts.
Do not reuse old reference draft migrations or assume a next free number. P3
builds from then-current main after P2 and the required R4 gates, not an old draft.

Inventory the exact functions/validators to change before authoring SQL, including
P2 presentation validation and all v71/page save/copy/clone paths. Schema and new
sanctioned writers may be an additive step; presentation/reader integration may
need a subsequent step. Each migration is independently deployable, one per owner
order, with feature defaults closed and old clients still accepted unchanged.
No binding data backfill or rewriting existing widget/series rows is expected.

For each migration: exact-name/checksum registry manifest (independent optional
tracks tolerated only by agreed exact names), md5 gates for every replaced body,
preflight counts/digests and trigger inventory, lock_timeout, postcheck, and a
rollback that refuses after real reference writes/bindings or incompatible later
migrations. Restore bodies with md5 verification. Rehearse apply -> rollback ->
identical catalog -> reapply on a disposable database, plus old-server reads/saves
through the deploy gap. Ship .sh/.ps1 rehearsal wrappers, Node >=20, RESULT: PASS;
owner rehearses on the production PostgreSQL major before merge. No production
connection or migration execution belongs to this planning PR.

## 9. Test and review packet for implementation

- Disposable real-route tests: shared R4 roles/ceilings/custom items, active
  workspace vs resource club, cross-club platform dashboards, revoked permission,
  foreign/missing byte-identical 404s, every route enumerated and gate mutations killed.
- Registry tests: effective system/club names, latest per-club assignment, clear,
  hidden/archive, athlete in two clubs, missing position/variable and no fallback.
- Schema/write tests: extensible named values, duplicate cells, units, bands,
  immutable versions, stale edit, idempotent replay and parallel publication/save.
- Math tests: zero vs absence, multiple lines/band, incompatible reference, positive
  anchors, ratio weighted actuals, mixed-position refusal, partial-axis availability.
- Preview/saved parity and fingerprint mutations; clone/copy authorization; shell
  and existing data_workspace narrowing never widened by references.
- React/browser tests at 360, 390 and 1280 px: keyboard cell editing, names/legend,
  unavailable states, preserved collapse, no raw ids/JSON in any role-visible DOM,
  PDF order/table visibility, no controls in PDF.
- Migration catalog round trip, refusal cases, concurrency SQL order, old binary
  rehearsal; current dashboard family, whole disposable set, baseline comparison.

Use the repository runner with exact files after implementation creates them:
`node scripts/test-runner.mjs --project backend --file <actual-file>`;
`node scripts/test-runner.mjs --project backend --kind disposable`;
`node scripts/test-runner.mjs --preset frontend-fast`;
`node scripts/test-runner.mjs --preset backend-fast`;
`node scripts/test-runner.mjs --preset e2e`, plus the repository build command.
Freeze one head; report exact commands/counts, baseline failures, unrun checks and
per-check mutations applied after SQL installation (not checksum-only failures).
Both independent review and the owner's full gate precede merge/activation.

## 10. Expected files and remaining decisions

Future new reference service/router, sanctioned SQL/runbooks and disposable tests;
existing dashboard access, presentation/save/query integration and contracts;
React reference-table/editor/Radar components, island adapters, styles and tests;
ADR-003 writer inventory and existing print integration. Resolve exact filenames
against current main when code starts. No mapping migrations, calculatedValues.js,
GPS import files or position registry rewrite. Changes to a shared query file are
coordinated with its owning stream before implementation.

Owner questions (recommendations, not decisions already taken):

1. **Ownership/permission mapping:** start with club-owned tables using
   `variables.view`/`variables.manage`, dashboard bindings using existing dashboard
   words, and defer system templates? Recommend yes; confirm with the R4 stream.
2. **Version choice:** pin published versions with explicit widget updates?
   Recommend yes, for reproducible comparisons.
3. **Radar scale:** use a coach-selected positive anchor =100, with unavailable
   axes where that scale is invalid? Recommend yes initially; do not invent a
   universal score or reverse lower-is-better metrics silently.
4. **Position timing/group:** use current per-club position and one position per
   group comparison? Recommend yes; historical assignment and mixed-position
   target weighting require their own explicit contract.

Unknown until implementation planning: React foundation commit/helper API, then-current
R4 module gate completion, migration slot/checksums/live md5 manifest and final
resource limits. None is inferred from production or blocks reviewing this document.
