# J15 — phase 7i: a club uses, copies or hides a system variable (proposed ★★ contract)

This is the contract of phase 7i of `docs/ai/metrics-core-plan.md` (phase 7: "7i ★★: a club uses a system variable as it
is or copies it into its own set, or hides it (OD7, C109)"). It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): C2, C4, C5, C10, C51, C60, C88, C99,
C104, C106, C108 and C109, and the decision 9 pin guard. It builds on the proposed J14
(`docs/ai/phase7h-club-admin-mappings-contract.md`, phase 7h), it answers J18's Q14 → C125
(`docs/ai/c112-drag-mapping-contract.md`, section 5.5), and it amends what J16 (`docs/ai/phase8-mappings-screen-contract.md`)
and the canonical-variable screens say about system variables in a club.

**Written while J14 is still Proposed.** Everything here that depends on J14 holds **under the condition that J14 is
accepted with O1–O6 as recommended** (J14 section 11). Where an answer to J14 would change J15, the section says so.
Nothing in J15 is merged before J14 is accepted.

| | |
|---|---|
| Status | **Proposed** by the executor on 2026-11-02, on the *Rukovodilac*'s orders of that day: KORAK 2 of its order queued at 13:35:02 UTC ("J15 za 7i … kao poseban PR"), and its permission queued at 16:57:27 UTC to write it before J14 is accepted ("novi worktree iz main-a; PR otvaraš tek kao Proposed; svuda gde J15 zavisi od J14 piši „pod uslovom da J14 bude prihvaćen sa O1–O6 kako su preporučeni"; ništa se ne merguje pre prihvatanja J14"). Documentation only. |
| Verified against commit | `565fe097` (merge of PR #331). Every file and line reference below is to that commit unless it names J14's head `3a4f7933` (PR #333). |
| Mark | ★★: external-review triggers 1 (a migration), 2 (`owner_scope`, information hiding), 3 (a **copy**: canonical identity and materialization) and 4 (transactions, lock order, idempotency). Reviewed by the *Rukovodilac* and the *Nezavisni revizor*. |
| The owner's decision | **C109 / OD7** (2026-10-30): „Sistemske kanonske varijable su pre svega zamisljene kao nesto sto klub moze vrlo brzo da koristi da mozda ih ubaci u svoje da ne mora da ih kreira ako mu odgovaraju, ako ne odgovaraju on moze i da ih sakrije, ne trebaju mu na primer... To je sustina, svi ce oni napraviti neki svoj skup core varijabli” (turn `bf4c6ce7`); the two forms (a) *use as is* and (b) *copy to own* are the *Rukovodilac*'s decision recorded in C109. Sections 2–4 make them concrete. |
| Owner decisions | **O1–O9** (section 12), each with a recommendation. They become decisions with the next free C numbers after J14's once decided (R12). |
| Decides | The *Rukovodilac*: R1–R12 (section 13). The owner: O1–O9 and, for a ★★ phase, the contract before any code (`metrics-core-plan.md`, section 3, A1). |
| Migration | **One**, the next free number after J14's v52 and J18's migration (whichever lands first), proposed as `migrations_v2/<YYYYMMDDHHMM>_training_load_vNN_system_variables_club.sql` (section 7, R1). |

---

## 0. In short

- **Three acts, for the club's active admin in its own workspace** (and for a platform admin who also holds that
  club's admin role, as in J14 section 2.1):
  - **Use as is** (form a) — already possible: a club admin switches an active system mapping on for its own teams
    (S1, C106). 7i adds only a way to get there from the variable and a per-club status on each system variable.
  - **Copy to own** (form b) — new: one server act makes a club variable that is the system variable's current
    version, with the system variable's active mappings as the club's **draft** versions, and a record of what it was
    copied from. The club then submits and activates them as its own (J14's 7h path).
  - **Hide / Show again** — new: a per-club preference that takes a system variable out of that club's lists and
    pickers and refuses switching it on for the club's teams. It never touches recorded values, results, provenance or
    existing charts.
- **What stays as it is:** system variables are changed only in the platform workspace; a club never maps to a system
  variable with its own mapping (C88, C60); a club's copy is the club's own and does not follow later system versions
  (C109); a value is never moved between variables (ADR-007).
- **Moving a team from the system variable to the club's copy** is one server step (end the system activation and
  start the copy's, same requirement, no window). It needs J14's 7h-B, since only then can a club admin activate its
  copy's versions.
- **The migration** adds three small tables (the copy record, the mapping-version copy link, the per-club hide), widens
  the variable request record by one operation, and replaces two guard bodies under md5 preconditions (the v36 request
  guard and the v48 T5 insert guard). It is the place where J18's Q14 → C125 option one lives: the typed link from a
  club version to the system version it copies.
- **Charts of club variables are not possible today** (section 1.7, from the code, not tested). A copy makes a measure
  that could be charted as a system variable unchartable. That is its own owner question (O7), not solved here.

## 1. What exists (verified at `565fe097`)

### 1.1 What a club can do with a system variable today

- **Read it, as a reference only.** In a club workspace, `GET /variables?scope=system` lists system variables
  (`ownerFilter`, `backend/src/canonicalVariableAdminService.js:353-357`; C88). Every system row reads
  `editable: false`, no actions (`actionsOf`, `:290-291`) and `mappingTarget.notReadyCode = target_scope_mismatch`. The
  screen calls the tab "System (reference)" and says "this club's own mappings cannot target them"
  (`frontend/metric-variables-view.js:39-47`, `:62-67`).
- **Switch it on for its teams (form a, in effect).** Since C106, a club admin starts and ends T5 activations of
  **system** mapping versions on its own club's bindings (`mayManageActivations`, `backend/src/sourceMetricAccess.js:46-49`;
  `activationInScope`, `:57-61`). The pilot runs exactly this: three system variables switched on for one team,
  Required (`docs/ai/CURRENT_STATE.md`, the M6 record).
- **Place it into its own categories.** A club link may put a system variable into the club's own domain or category
  (v41 O4; `backend/src/canonicalClassificationService.js:564-569`).
- **Not copy it, not hide it.** No copy route, no provenance column and no per-club hide exist anywhere (a grep for
  `copied_from`, `copy_of`, `club_hidden` over `migrations_v2` and `backend/src` finds nothing). A club could make a
  look-alike by hand through `POST /variables` today; nothing would link it to the system variable.

### 1.2 How a club variable is made today (the template of a copy)

`createVariable` (`canonicalVariableAdminService.js:581-650`, `POST /variables`): admin only; owner from the workspace;
body `requestKey, label, shortLabel, description, key, iconKey, unit, levels, dailyAggregationMethod, minValue,
maxValue, condition`; numeric only; levels `session` / `drill` (Metrics Core `component`); conditions none, a zone or an
event threshold; the key unique **per owner** (`metric_definitions_owner_scope_owner_user_id_owner_club_id__key`,
`:71`; v10 `:124-127`), so a club may hold the same key as a system variable. One transaction writes the definition,
version 1, the scope capabilities and the v36 request record `variable_create`
(`migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql:68-93`). The key never changes afterwards
(v38's key freeze).

### 1.3 Mappings a copy must reproduce

- **T3** is one row per (source field, canonical definition), whatever the owner (`source_metric_mappings_pair_key`,
  v34 `:628`); a club mapping must target a definition of its own club (v34 `:655-656`). So a copy's mappings are new
  club T3 rows onto the copy, never onto the system variable.
- **T4** pins the source revision, the canonical version (composite FK, v34 `:833-835`), the units, the factors, the
  parameters and the levels; it is inserted only as `draft` (v34 `:1044-1045`) and its fingerprint is computed by the
  database (`:1104`). `createVersion` (`backend/src/sourceMetricMappingService.js:1019-1179`) derives everything from
  the mapping's current canonical version and the current active conversion. A copied version is therefore
  **re-derived**, not cloned, and equals the system version only if the copy's version 1 equals the canonical version
  the system T4 pins and the same unit conversion is still active.
- **One active target per owner** (`source_metric_mapping_versions_one_active_target_per_owner`, v34 `:890-893`) is
  per `owner_key`: the system version and the club copy's version can both be active.
- **One open activation per (binding, field, fingerprint)** (`source_metric_activations_one_open_per_field`, v34
  `:1337-1339`), whatever the owner. So the copy's version cannot be switched on for a team while the system version
  is on for the same field: S1 answers `activation_exists` (`backend/src/sourceMetricActivationSteps.js:142-149`).

### 1.4 Hiding today: per user, ungoverned, unused

`training_load.metric_definition_hidden` (v10 `:183-188`, per user, cascading) is written by the older
`POST|DELETE /api/training-load/metrics/definitions/:id/hide` (`backend/src/routes/trainingLoadMetrics.js:363-385`),
open to any account, and read only by `listDefinitions` (`backend/src/trainingLoadMetricsCatalog.js:169-180`). No
screen calls it. Nothing is per club.

### 1.5 Where a system variable appears for a club

- the Variables screen, System tab (`metric-variables-*.js`);
- the Mappings screen's list of system mappings and its switch-on chooser (J16);
- the dashboard and calendar metric pickers, which page through the older `GET /api/training-load/metrics/definitions`
  (`frontend/training-load-analysis-data.js:1536-1560`, `frontend/training-load-calendar-data.js:330-382`), filtered by
  `catalogVisibilitySql` (`backend/src/trainingLoadMetricsAccess.js:116-134`: system rows for everyone; it is built
  from every role the user holds, not from the workspace, and it also gates manual measurement writes);
- dashboard template clones, which resolve a series by key among system definitions plus the data workspace's own
  (`backend/src/trainingLoadDashboardWidgets.js:105-117`; two candidates make it `ambiguous`, `:155-161`);
- result names: the Activities drawer and dashboard series labels take a value's name from the same picker list
  (`frontend/training-load-calendar-view.js:638-660`; `frontend/training-load-analysis-view.js:405-411`), so a row
  removed from that list loses its name in results.

### 1.6 The importer and history

The importer reads every open T5 row of a binding with no owner filter (`backend/src/gpexeImportMapping.js:75-96`)
and never reads who activated it (J14 section 1.5). A value's definition is fixed by the T4 version it was imported
under; values and T6 provenance are permanent (v13 `metric_values_immutable`; v34 T6 append-only). So after a switch
the old values stay under the system variable and new ones come under the copy. A re-import of a session already
imported under the system variable, whose GPEXE content changed after the switch, is not a supplement (the system
value is missing from the new set) and goes to `needs_review` (D17, `backend/src/gpexeImportWriter.js:478-571`);
an unchanged session ends as `unchanged`. This is read from the code, not tested.

### 1.7 Charts of a club variable: not possible today (from the code, not tested)

- Imported GPEXE events and their activities belong to the team (`gpexeImportWriter.js:153-174`).
- A team dashboard cannot bind a club definition: the v16 trigger admits a club definition only on a club data
  workspace (`migrations_v2/202609101000_training_load_v16_dashboard_widgets_series_selection.sql:736-752`), and so does
  `isMetricVisibleToDashboard` (`backend/src/trainingLoadDashboardAccess.js:271-283`).
- A club dashboard reads only club-owned activities and events (`backend/src/trainingLoadDashboardQuery.js:59-64`,
  `:177-182`).

So no dashboard can chart a club variable's imported values. This holds for every club variable once 7h is live; a
copy makes it sharper, because a measure that charts as a system variable stops getting new points on its existing
charts after the team moves to the copy. Decision: O7.

## 2. The three acts

### 2.1 Use as is (form a)

- **Already built** (C106): S1 of an active system mapping version on a binding of the club's connection. 7i adds no
  write for it.
- **7i adds:** on the system variable's detail, a per-club status (*Used by your teams* / *Not used* / *Hidden*) and a
  button *Use for your teams* that opens that system mapping's *Switch on for teams* (J16 section 6), preset to the
  club. A system variable with no active system mapping says "OptiMove has not connected a data source to it yet." and
  offers no button. Several active system mappings (later, several sources) are listed by source.

### 2.2 Copy to own (form b)

One server act, `POST /api/training-load/sources/metrics/variables/:variableId/copy` (section 4), which in **one
transaction** writes:

1. **The club variable**: a new club `metric_definitions` row with version 1 equal to the system variable's **current**
   version in every semantic fact — unit, value type (numeric), min, max, condition, daily aggregation — and the same
   scope capabilities. The label, short label, description and icon are copied and may be edited in the same act (C111
   lets them change in place anyway). The key is the system key by default and may be changed (O4).
2. **Its mappings**: for each system mapping of that variable whose **active** system version exists, one club T3 (the
   same source field onto the copy) and one club T4 **draft**, re-derived by `createVersion`'s rules from the system
   version's source revision, levels, conversion note and source parameters. Draft, needs-review and disabled system
   versions are never copied (O3).
3. **The record of the copy**: a copy row (variable level) and one link row per copied version (mapping-version
   level, section 7.2), which is J18's Q14 → C125 option one.
4. **The request record**: the variable request row with the new operation `variable_copy` (section 7.4), and the T8
   rows `mapping_create` and `mapping_version_create` of each copied mapping in the same operation.

**All or nothing.** Every copied version is checked before the first insert; one that cannot be reproduced (its
revision retired, its conversion changed, a level the copy lacks) refuses the whole copy with its field named
(`409 copy_mapping_not_reproducible`). No savepoints are used (the v35 / v48 guards refuse a write inside one).

**Bounded:** at most 10 copied mappings in one act (`409 copy_too_large`). The pilot's three system variables have one
active system mapping each, as reported in the M6 record; the database was not read.

**What a copy is not:** a copy of a club variable, of another club's variable, of a team or user variable, or of an
archived system variable; a copy into a team; a copy into the platform workspace. Each has its own answer (section 4).

**One copy per club and system variable** (O5): a second copy answers `409 already_copied` with the copy's id; an
archived copy is restored (R2's restore), not copied again.

**After the copy** the club submits and activates the drafts as its own versions — **under the condition that J14 is
accepted with O1–O6 as recommended**, through J14's A1 by the club admin (7h-B). Until then a platform admin who also
holds the club's admin role activates them, as today.

### 2.3 Hide / Show again

- **What hiding is** (O1): a per-club preference. In the club's workspace and in every team workspace of that club
  (O2), a hidden system variable is left out of: the System tab's default list, the dashboard and calendar metric
  pickers, the switch-on choosers and J18's board. It is returned **flagged**, so result names, dashboard series labels
  and the Activities drawer still name it.
- **What hiding refuses:** switching the variable's system mapping on for any of the club's teams (S1, A1's listed
  starts, J18's board), with `409 variable_hidden`.
- **What hiding never touches:** recorded values, T6 provenance, occasions, existing dashboard series (they keep
  reading), the club's existing classification links, manual measurements, the import of other variables, athletes'
  views, and anything outside that club.
- **Refused while in use** (O1): hiding answers `409 variable_in_use` while any open activation of a system mapping of
  that variable exists on a binding of the club's connections; the admin switches it off first (S2, its own right since
  C106). Show again restarts nothing.
- **Only a system variable** can be hidden: the club archives its own variables instead (`409 hide_not_system`).

### 2.4 Moving a team from the system variable to its copy (O6)

`POST /api/training-load/sources/metrics/activations/:activationId/switch-to-copy` (section 4): in one transaction it
ends the team's open activation of the system version (`admin_ended`) and starts the copy's **active** club version on
the same binding with the same requirement and levels. The copy's version must be the one linked (section 7.2) to the
system version of the ended activation; a later club version of the copy (after the club replaced it) is not linked,
and that team moves in two acts (S2, then S1). No window opens in which a check would find the field without an
activation.

It needs the copy's version to be active, so it **depends on J14's 7h-B** (a club admin's A1), under the condition that
J14 is accepted with O1–O6 as recommended. Without it, the switch is two acts (S2, then S1) with the window.

## 3. Who may do what

"Club X's admin" and "platform admin" are J14 section 2.1's definitions: club X's active admin in club X's workspace,
and a platform admin in club X's workspace (which, as today, needs club X's admin role).

| Act | Club X's admin | Platform admin in club X's workspace | Platform workspace | Coach (team workspace of club X) | Everyone else |
|---|---|---|---|---|---|
| Read system variables with club X's status (used / not used / hidden) | yes | yes | no per-club status | yes, read only, a *Hidden by the club* badge | as today |
| Copy a system variable into club X | **yes** | yes | 404 | 404 | 404 |
| Hide / Show again for club X | **yes** | yes | 404 | 404 | 404 |
| Switch a team to the copy | **yes** (after 7h-B) | yes | 404 | 404 | 404 |
| Use as is (S1 of a system version) | yes (C106) | yes | yes | no | 404 |

- **The identical 404** (`{ "error": "notFound" }`, `Cache-Control: no-store`), before the body, with nothing written
  and the key left free, for: another club's admin; an admin of clubs A and B acting in B's workspace on A's copy or
  hide; club X's admin in a team workspace; a coach; a private coach; an athlete; a user with no role; a revoked role;
  an archived club; an unknown id; an id of another club's variable. An inactive user gets the router's 401.
- **Never revealed:** another club's hides, copies or usage. Hide and copy rows are read only for `ctx.owner.clubId`.
- **A coach** keeps C99's rights on club variables (rename, archive, restore), so it may rename or archive a copy once
  it exists. It gets no act on system variables.

## 4. Routes and answers

All under `/api/training-load/sources/metrics`, through the admin context of `resolveMappingAdminWith` (owner club =
the workspace's club), with J8's order of answers: 401; the identical 404 before the body; 415 / 400; a malformed id the
identical 404; 400 per body rule; the request record (`409 request_key_reused`, or the replay); the owner-filtered read;
the locks; the right checked again; the state refusals.

### 4.1 `POST /variables/:variableId/copy`

Body: `{ requestKey, expectedSourceVersionId, key?, label?, shortLabel?, description?, iconKey? }`. Answer `201` with
the copy (a variable answer) and `copiedMappings: [{ mappingId, versionId, sourceMetricId, systemVersionId }]`.

| Refusal | When |
|---|---|
| the identical 404 | the id is not readable in the workspace, or the workspace is not a club's |
| `409 copy_source_not_system` | the id is the club's own variable |
| `409 source_not_active` | the system variable is archived |
| `409 source_version_changed` (`current.versionId`) | its current version is no longer `expectedSourceVersionId` |
| `409 already_copied` (`current.variableId`) | club X already holds a copy of it, in any state |
| `409 key_taken` | the key is a club X key in any state |
| `409 copy_source_unsupported` (`current.reason`) | the system version cannot be a club version: not numeric, a `day` level, an unsupported condition, a unit that is not a unit token |
| `409 copy_mapping_not_reproducible` (`current.sourceMetricId`, `current.code`) | a copied version cannot be re-derived (revision retired, `conversion_unavailable`, `level_not_allowed`, …) |
| `409 copy_too_large` | more than 10 mappings to copy |
| `409 try_again` | a lock wait (55P03, 40P01, 57014) |

The request hash names the source definition and version and every field of the body, so a replay after a new system
version is `request_key_reused`, never a different copy.

### 4.2 `POST /variables/:variableId/hide` and `…/show`

Body `{ requestKey }`. Answer `200 { variableId, hidden, hiddenAt }`; the same state again is `200` with
`idempotent: true` and nothing written.

| Refusal | When |
|---|---|
| the identical 404 | not readable, or not a club's workspace |
| `409 hide_not_system` | the club's own variable |
| `409 variable_in_use` (`current.activationCount`) | hide only: an open activation of its system mapping on the club's bindings |
| `409 try_again` | a lock wait |

The hide row itself is the request record (the T5 pattern: who, when, basis, key and hash on the row, section 7.3).

### 4.3 `POST /activations/:activationId/switch-to-copy`

Body `{ requestKey, expectedState: "open", toVersionId, reason }` (the reason as S2's). Answer the ended and the new
activation. Refusals: the identical 404 (scope as S2's); `409 activation_not_open`; `409 not_a_copy_of_this_version`
(no copy link from `toVersionId` to the activation's version); `409 version_not_active`; S1's start codes. **Built in
7i-B only after 7h-B is merged** (section 2.4).

### 4.4 Reads

- `GET /variables?scope=system` and `GET /variables/:id` in a club or team workspace of club X: each system row gains
  `club: { hidden, usedByTeams, copyId }` for club X, and for an admin `actions` from `use`, `copy`, `hide`, `show`
  (never for a coach). `?hidden=exclude|include|only` (default `exclude`) is bound into the `variables` cursor like the
  other filters; a cursor without it reads as `exclude`.
- `GET /mappings` and `GET /activations` in club X: a system mapping row gains `targetHiddenInClub`.
- The older `GET /api/training-load/metrics/definitions`: a system row gains `hiddenInClub` for the **active
  workspace's** club (a club workspace's id, or a team workspace's club; none for platform, private coach and athlete
  workspaces). `catalogVisibilitySql` is **not** changed. The two pickers drop flagged rows; every other caller keeps
  them, so names stay.
- Dashboard template clones into club X's data workspace leave out a system definition club X has hidden
  (`trainingLoadDashboardWidgets.js:105-117`), so a copy that keeps the system key resolves instead of `ambiguous`
  (O4).

## 5. The writes, in the documented lock order

- **Copy:** per-user advisory lock → the request record → (plain read of the source and its active system versions,
  to know what to lock) → the conversions → T2a and T2b `FOR SHARE` → the system T3 rows `FOR SHARE`, ascending → the
  system T4 rows `FOR SHARE`, ascending → the system definition and its current version `FOR SHARE` → its scope
  capabilities `FOR SHARE` → the rights (`users`, `user_club_roles`, club `FOR SHARE`, in J14's 7h-B order) → the
  facts compared again under the locks (`source_version_changed`, `copy_mapping_not_reproducible`) → the inserts
  (definition, version, capabilities, club T3s, club T4s, links, copy row, T8 rows, the request row last). This is D's
  order (v34 `:38-49`); a concurrent A1 / A2 of a copied system version or a new system variable version serializes
  with it at T4 or at the definition, and no cycle forms.
- **Hide / show:** per-user advisory lock → the hide row's key → an advisory lock on `club-variable-hide:<club>:<variable>`
  → the system definition `FOR KEY SHARE` → the open activations of its system mappings on the club's bindings (a
  plain read under the advisory lock) → the rights → the insert or the end of the hide row. The v48 T5 insert guard,
  replaced in section 7.5, takes the same advisory lock before it reads the hide row, so a hide and an S1 of the same
  club and variable serialize; neither waits on anything the other holds exclusively, so no cycle forms.
- **Switch to copy:** S2's order for the system activation, then S1's for the new one (T2a / T2b, T3, T4 ascending over
  both versions, the old T5 `FOR NO KEY UPDATE`, the rights, the binding, team and club `FOR SHARE`), the end, the
  start, the T8 rows (`activation_end` unkeyed, `activation_start` keyed last).

Bounds as 7b / 7d: 2 s row locks, 10 s per statement, 5 s per-user lock; `55P03`, `40P01` and `57014` answer `try_again`.
A copy's total length is bounded by the 10-mapping cap. The F2 COMMIT discipline is `runWrite`'s, unchanged.

## 6. Concurrency

| Against | Outcome |
|---|---|
| Copy vs A1 / A2 of the system version being copied | They serialize at the system T4 row. Copy first: A1 / A2 then proceeds; the copy holds a draft of a version that may later be disabled — harmless, the copy is the club's. A1 / A2 first: the copy reads the new state under its lock and copies the new active version or refuses with `copy_mapping_not_reproducible`. |
| Copy vs a new system variable version, archive or rename (R2) | They serialize at the system definition (`FOR SHARE` against `FOR UPDATE`). The copy re-reads under the lock and answers `source_version_changed` or `source_not_active`. |
| Two copies of the same system variable by two admins of club X | The copy rows' unique (club, system variable) refuses the second at insert (`already_copied`); a lost answer replays by key. |
| Hide vs S1 of the same variable on the club's binding | The shared advisory lock: hide first → S1's guard reads the open hide row and refuses (`variable_hidden`); S1 first → hide reads the new open activation and refuses (`variable_in_use`). |
| Hide vs a club-role revocation | Like any club-admin write (J14 section 5 and R13): the rights rows `FOR SHARE` after the advisory lock; the revocation lands first → the identical 404. |
| Switch to copy vs an import approval or a check-time preview | As A1 with listed starts in J14 section 5: same registry order, the rights after it; the approval answers `preview_changed` when the switch lands first. |
| Switch to copy vs S2 of the same activation | They serialize at the T5 row; the second answers `activation_not_open`. |

## 7. The migration (proposed; the next free number after v52 and J18's)

### 7.1 `training_load.metric_definition_copies`

The variable-level record. Columns: `club_definition_id` (primary key, FK `metric_definitions`), `club_id` (FK
`public.clubs`), `system_definition_id`, `system_version_id` (composite FK to `metric_definition_versions (id,
metric_definition_id)`), `copied_by_user_id`, `basis` (`platform_admin` | `club_admin`), `operation_id`, `copied_at`.
Unique `(club_id, system_definition_id)` (O5). Append-only (no UPDATE, DELETE or TRUNCATE).

Its BEFORE INSERT guard: the actor is the v35 setting and equals `copied_by_user_id`; the basis is
`source_metric_actor_basis(actor, club_id)`; the club definition is `owner_scope = 'club'` of `club_id`, written in
this transaction by the actor, with version 1 current; the system definition is `owner_scope = 'system'` and active,
and `system_version_id` is its current version (both `FOR SHARE`); the club version 1 equals the system version in
unit, value type, min, max, condition and daily aggregation, and the scope capabilities are equal; the system
definition is itself no copy. A deferred check at COMMIT requires the club definition's `variable_copy` request row.

### 7.2 `training_load.source_metric_mapping_version_copies` (J18's Q14 → C125 option one)

The mapping-version link. Columns: `club_version_id` (primary key, FK T4), `system_version_id` (FK T4),
`operation_id`, `created_at`. Append-only.

Its BEFORE INSERT guard: the club version is `owner_key` = a club, `draft`, written in this transaction by the actor;
the system version is `owner_key = 'system'`, **active**, and was activated (`activated_at` not null); the club
version's mapping targets the club definition that `metric_definition_copies` records as the copy of the system
version's definition; and the two versions are **identical** in `source_metric_version_id`, `parameter_kind`,
`source_parameters`, `parameter_fingerprint`, `source_unit`, `target_unit`, `scale`, `scale_divisor`, `offset`,
`parameter_scale`, `parameter_scale_divisor`, `parameter_offset`, `applies_to_session`, `applies_to_drill` and, by
value, `canonical_parameters`. A deferred check at COMMIT requires the club version's `mapping_version_create` T8 row.

**J18's gate** then accepts this link as the second proof, beside a checked T9i row: a club admin's activation of a
parameter-less club version passes when the version has a link row whose system version is **still active** at the
activation. Whichever of J18's migration and this one lands second replaces the other's gate body under an md5
precondition (R7).

### 7.3 `training_load.metric_definition_club_hides`

One table for state and history, shaped like T5. Columns: `id`, `club_id` (FK `public.clubs`, `on delete restrict`),
`metric_definition_id` (FK, `on delete restrict`), `hidden_by_user_id`, `hidden_basis`, `hide_request_key`,
`hide_request_hash`, `hidden_at`, and the show facts `shown_by_user_id`, `shown_basis`, `show_request_key`,
`show_request_hash`, `shown_at` (all null or all set). Unique per key and user for both acts; a unique partial index on
`(club_id, metric_definition_id) where shown_at is null` (one open hide); never deleted.

Its guards: BEFORE INSERT — the actor (v35 setting) is `hidden_by_user_id`; the basis is
`source_metric_actor_basis(actor, club_id)` and equals `hidden_basis`; the definition is `owner_scope = 'system'`;
`hidden_at = now()`; under the advisory lock `club-variable-hide:<club>:<variable>`, no open T5 activation of a system
mapping version targeting the definition on a binding whose `source_metric_binding_club` is `club_id`. BEFORE UPDATE —
only the show facts, once, with the same actor and basis rules. No other writer.

### 7.4 The variable request record

`metric_variable_requests` gains the operation `variable_copy` (its operation CHECK widened; its version rule admits a
version for `variable_copy`; the one-create-per-definition index covers `variable_copy` too) and a nullable
`operation_id` (set only for `variable_copy`, equal to the T8 rows' and the copy rows' `operation_id`, so a replay and
the post-COMMIT check find every row the copy wrote). The v36 insert guard
(`training_load.metric_variable_requests_insert_guard`, body in force v36, md5 `11095b44b633e9eb1262f5189c4ec9c5`) is
replaced so that `variable_copy` is checked as `variable_create` is, plus: the copy row of the definition exists in this
transaction with the same `operation_id`. Its trigger's `WHEN` gains `variable_copy`.

### 7.5 The T5 insert guard

`training_load.source_metric_activations_insert_guard` (body in force v48, md5 `e47f75d4a7a6c63659a19491db97d678`,
equal to the v48 rollback's constant) is replaced to add, for a **system** mapping version: take the advisory lock
`club-variable-hide:<binding club>:<target>` and refuse (`23514`, "source_metric_mapping_activations: the variable is
hidden in the binding's club") while an open hide row exists. Every other line stays byte for byte. J14's v52 does not
replace this body (it replaces the T5 update guard), so there is no conflict with 7h.

### 7.6 Preconditions, locks, rollback

- **md5 preconditions** on the two replaced bodies; refuse if J18's migration or another changed them.
- **Locks:** `metric_variable_requests` and T5 `share row exclusive` for the replaced triggers; the three new tables are
  new. No `access exclusive` on a table with production rows.
- **Preflight / post-check / rollback** as v48 and v50, with a Serbian runbook for the owner. The rollback refuses once
  any copy, link or hide row, or any `variable_copy` request, exists, or a later migration is recorded; otherwise it
  drops the three tables, restores both bodies and the CHECKs byte for byte. Its SQL files get a `.gitattributes`
  `eol=lf` line.
- **A read-only preflight count** of system variables a copy would refuse (non-numeric, a `day` level, an unsupported
  condition, a non-token unit), so the owner knows before 7i-B what `copy_source_unsupported` will meet.
- **Deploy compatibility:** the old code never writes the new operation or tables; old reads ignore them.

## 8. The service and the screen (7i-B)

### 8.1 The service

- `copyVariable` in `canonicalVariableAdminService.js`, through `runWrite` with the variable request table, reusing
  `createVariable`'s validation for the editable fields and `createVersion`'s derivation for each copied version.
- `hideVariable` / `showVariable` with the hide row as the request record.
- `switchToCopy` in the activation service (after 7h-B).
- The readers of section 4.4; `listDefinitions` takes the active workspace's club; the template resolver takes the
  hide set of the data workspace's club.
- `actionsOf` keeps `[]` for a coach and for the platform workspace.

### 8.2 The screen ("mora biti mnogo jednostavnije za korisnika")

- **The tab** "System (reference)" becomes **From OptiMove** in a club workspace. Its intro: "OptiMove's ready-made
  variables. Use them for your teams, copy one to make it your club's own, or hide the ones you don't need."
- **Each row:** one chip — *Used by your teams*, *Not used*, or *Hidden*; *Copied* when the club holds a copy (a link
  to it). A *Show: Shown / Hidden / All* select like the archive filter.
- **The detail:** at most three buttons, the primary one by state:
  - *Use for your teams* (primary when not used) — opens the system mapping at *Switch on for teams*, preset to the
    club;
  - *Copy to my club* — one review card: the name (prefilled, editable), the key (prefilled, editable), "Its N data
    source connections come as drafts you activate.", "It will not follow later changes OptiMove makes.", the chart
    note of O7, one button *Copy*. After it the copy's detail opens with the next step named;
  - *Hide for my club* / *Show again* — one short confirmation naming what disappears (the lists and pickers) and what
    stays (results, charts already made); while teams use it, the button is off with "Switch it off for your teams
    first."
- **On the copy's detail:** "Copied from OptiMove's <name>." and, while a team still uses the original, *Move your
  teams to this copy* (the switch, after 7h-B).
- **A coach** sees the chips and a *Hidden by the club* badge, no buttons.
- **The pickers** drop hidden rows; results keep the names.
- Phones: buttons stack, 44 px targets, 16 px fields. Reviewers: `code-reviewer`, `ux-design-reviewer`, `mobile-qa`.
  A browser check at 1280, 390, 375 and 360 px, and J16's interaction count for "copy, then use" measured against the
  real routes.

## 9. Relation to J14, J18 and C111

- **J14 (7h):** a copy's drafts are activated by the club admin through J14's A1 (7h-B); the switch needs it too. A
  copy is a club variable, so what a coach sees of its name after an import is J14's O2 (7h-V). **Under the condition
  that J14 is accepted with O1–O6 as recommended.** If J14's O2 were answered (b) (S1 and A1's starts refuse club
  mappings until O16 is decided), a copy could be made but never switched on, and the switch route waits.
- **J18 (C112):** this contract carries Q14 → C125 option one (section 7.2). J18's §3.6 / §7 eligibility gains "not
  hidden in the team's club"; a system mapping the club has copied stays pre-placed until the club hides the original
  (no automatic hide). Whichever migration lands second replaces the other's gate body (R7).
- **C111 (editing a variable in place):** a copy has mappings from its first moment, so under C111 its unit,
  aggregation, min / max, condition, levels and key are fixed from the copy on; a club wanting other zone bounds makes
  a new variable (OD1), not a changed copy. J15 assumes no in-place semantic edit; C111's contract must keep the copy
  link true (an in-place edit of a copied version would break "identical").

## 10. Tests (7i-B)

**The suite** is a new file, `backend/tests/source-metric-variables-club-7i.test.mjs` (its `source-` prefix puts it in
`--preset gpexe`), on disposable `optimove_tests_gpexe_*` databases (a rehearsal database through the previous
migration, a main one through all).

- **Matrix:** the actors of J14 section 10.2 (club A's admin, a second admin of A, club B's admin, an admin of A and B
  in B's workspace, A's admin in a team workspace, revoked, archived club, coach, private coach, athlete, no role, the
  platform admin in the platform and in A's workspace, a revoked platform admin) × copy, hide, show, switch, the reads.
  Success only for A's admins and the platform admin in A's workspace; the identical 404, deep-equal (status, body,
  headers) across a missing id, another club's variable and a foreign activation, for everyone else.
- **Copy:** the variable, version 1 equal in every semantic fact, the capabilities, one club T3 and draft T4 per active
  system version, the link rows, the copy row, the T8 rows and the request row, all in one transaction; nothing for a
  draft, needs-review or disabled system version; each refusal of section 4.1 with nothing written and the key free;
  replay and `request_key_reused`; the copy's drafts submitted and activated by the club admin (after 7h-B); a copy
  that keeps the system key and a template clone into the club resolving once the original is hidden.
- **Hide:** hide and show by each allowed actor; idempotent repeats; `variable_in_use` with an open activation; S1 and
  A1's listed starts refused for a hidden variable (`variable_hidden`); the readers flag and the pickers drop; result
  names, existing series and manual values unchanged; a coach in a team workspace of the club sees the badge; another
  club sees nothing.
- **Switch:** one transaction, no window (a check between is impossible), the requirement kept, the T8 pair; refusals.
- **Direct SQL** (each with its first-firing guard, code and message): every guard of section 7 refuses a missing
  actor, another actor, a wrong basis, a system definition as a copy's club side, a non-identical link, a link to a
  never-activated system version, a hide of a club variable, a hide with an open activation, a write inside a
  savepoint, a copy row or a link row without its request or T8 row at COMMIT.
- **Races** (no `40P01`, the second request by another user): copy vs A1 / A2 of the copied system version; copy vs a
  new system version and vs an archive; two copies by two admins; hide vs S1, both orders; switch vs an import
  approval and vs S2; a club-role revocation during a copy (J14 R13's route-against-route pattern).
- **History (inferred today):** after a switch, a session imported under the system variable whose content GPEXE
  changed is `needs_review` once, its system value stays current; an unchanged session stays `unchanged`.
- **Migration rehearsal** as J14 section 10.5: preflight, apply under a held reader, the exact catalog delta, the
  post-check, every rollback refusal, rollback to the previous catalog byte for byte, re-apply, LF endings.
- **Mutations**, each killed by a named test: every guard condition above; the shared advisory lock removed from the
  T5 guard or from the hide; the copy's "active system versions only" filter widened; the reader flag ignored by a
  picker; the template resolver ignoring the hide; the identical-404 gate widened.
- **Frontend:** the From OptiMove tab, the chips, the three acts with their cards, the coach badge, the pickers
  dropping hidden rows while results keep names; a mutation that shows the acts to a coach must fail.

Regression by `--file`: the M3-0, R2, 12b, icon, M2, 7b, 7d and 9-B suites, and `test:frontend:fast`.

## 11. Rollout

- **7i-B** (migration, backend, frontend) after J14 is accepted and **after 7h-B is merged**, as one ★★ pull request;
  the switch route ships in it only if 7h-B is merged, otherwise in a follow-up.
- **The pilot club stays on form (a)** (O8): its three Required system mappings are not copied or moved; copy and hide
  are first used by a new club, with its own test data.
- The frontend never ships before the backend (J14 R7).

## 12. Questions for the owner (O1–O9)

Each has a recommendation, the consequence and the alternative.

- **O1. What hiding means.** **Recommended:** a per-club preference that takes a system variable out of the club's
  lists and pickers and refuses switching it on; refused while the club's teams still use it (switch it off first);
  never touches recorded values, results, provenance or existing charts. *Alternative:* hiding also switches it off
  for the club's teams by itself — a heavier change (a new end reason and new audit rows).
- **O2. Where hiding applies.** **Recommended:** in the club's workspace and in every team workspace of that club; the
  club comes from the active workspace, never from all of a user's roles; no effect on athletes or the platform
  workspace. *Alternative:* the club's workspace only (coaches keep seeing it).
- **O3. What a copy copies.** **Recommended:** the system variable's current version, exactly in its unit, bounds,
  condition, daily aggregation and levels (only the name, short name, description, icon and key may differ), and only
  the mappings with an active system version, as the club's drafts; not the system's categories. *Alternative:* also
  copy draft and waiting system versions — those carry no platform approval yet.
- **O4. The copy's key.** **Recommended:** the system key by default, editable; and dashboard templates in the club
  then use the club's copy once the club hides the original. *Alternative:* always a new key from the name — templates
  then keep using the system variable.
- **O5. How many copies.** **Recommended:** one per club and system variable; an archived copy is restored, not copied
  again. *Alternative:* a new copy after archiving, with a new key.
- **O6. Moving teams to the copy.** **Recommended:** one step that switches a team from the system variable to the copy
  with the same Required / Optional setting and no gap, available once J14's 7h-B lets a club admin activate its copy.
  *Alternative:* two steps (switch off, switch on), with a window in which a search finds the field unmapped.
- **O7. Charts of club variables** (from the code, not tested). Today no dashboard can chart a club variable's imported
  values; a copy therefore stops new points on the system variable's charts. **Recommended:** a separate pull request
  before more clubs are brought on that lets a team dashboard use its own club's variables (a migration and a security
  review), and until then the copy card says "Charts of club variables come later." *Alternatives:* accept it as a
  lasting limitation; or hold back copying until charts exist.
- **O8. The pilot club.** **Recommended:** it stays on OptiMove's variables (form a); copying and hiding are first used
  by a new club. *Alternative:* move the pilot to copies — it would split its history at the switch date.
- **O9. History after a switch** (from the code, not tested). Sessions imported before the switch stay under the
  system variable; a re-import of one GPEXE later changed goes to review once and keeps the system value.
  **Recommended:** accept, and say so on the copy's detail. *Alternative:* a re-import tool that moves old sessions to
  the copy — against ADR-007 (a value is never reinterpreted).

## 13. Decisions for the *Rukovodilac* (R1–R12)

- **R1. The migration number:** the next free after v52 and J18's; the runbook file names wait for it.
- **R2. The request record:** a new operation `variable_copy` with `operation_id` (recommended) rather than a plain
  `variable_create`, which would lose that it is a copy.
- **R3. The copy's size cap:** 10 mappings, `409 copy_too_large`.
- **R4. The refusal codes** of section 4.
- **R5. The lock order** of section 5 (D's order, the rights after the registry, J14's `u, r`).
- **R6. The T5 insert guard replacement** (section 7.5), md5-preconditioned; J14's v52 does not touch it.
- **R7. C125 option one** lives in this migration; J18's gate accepts the link; whichever lands second replaces the
  other's body under an md5 precondition.
- **R8. The pull requests:** 7i-B after J14's acceptance and 7h-B; the switch only with 7h-B merged; the charts
  (O7) as their own pull request.
- **R9. The readers** that honour a hide (section 4.4), and that `catalogVisibilitySql` is not changed.
- **R10. Cursor compatibility** of `variables` with the new `hidden` filter.
- **R11. `test:backend:shared`:** the same evidence as J14 R9 (no shared-kind suite imports the touched services);
  recommended not needed, on the *Rukovodilac*'s word otherwise.
- **R12. Decision numbers:** the next free after J14's.

## 14. What this contract supersedes or amends (once accepted)

| Where | What | How |
|---|---|---|
| Discovery C88 | system variables in a club are a "read-only reference" | amended: the club also uses, copies and hides them; they stay unchangeable by the club and never a club mapping's target |
| Discovery C109 | "hiding per club is likely a new table" | made concrete: section 2.3 and 7.3 |
| J16 (`phase8`) club sentences | "System mappings come from a platform administrator; you switch them on for your teams." | amended: hidden ones are marked and cannot be switched on |
| J18 §3.6 and §7 eligibility (`c112:279`, `:794-799`) | every eligible active system version is pre-placed | amended: not when hidden in the team's club |
| J18 Q14 → C125 (`c112:640-643`, `:1172-1175`) | option one recommended, "decided with 7i" | carried: section 7.2 |
| The Variables screen (`metric-variables-view.js:39-47`, `:62-67`) | "System (reference)", "this club's own mappings cannot target them" | superseded by section 8.2 |

## 15. Not in this contract

- **C111** (editing a variable in place) and any edit of a copy's semantics.
- **Charts of club variables** (O7): their own pull request.
- **Hiding system domains and categories**; copying them.
- **Comparing clubs** (C109: not a goal now).
- **The per-user hide** of v10 (left as it is; retiring it is a separate cleanup).
- **Moving old sessions** to a copy (O9).
- **Any import** until the end of this track (the owner, 2026-11-02).
- **A platform view** of which clubs copied or hid a system variable.

## 16. Review record

- **Discovery** (read-only, 2026-11-02): five areas — the variables, the mappings, hiding, the documents and screen, the
  importer, dashboards and tests — and a completeness critic, on J14's worktree (`565fe097` plus the J14 documents).
  The executor checked the facts this contract rests on in the code at `565fe097`, and the two md5 values against the
  migration files (the method reproduces v48's rollback constant for the T5 insert guard).
- Internal reviews of this document: below, after they run.
