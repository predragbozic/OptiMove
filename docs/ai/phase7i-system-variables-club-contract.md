# J15 — phase 7i: a club uses, copies or hides a system variable (accepted ★★ contract)

This is the contract of phase 7i of `docs/ai/metrics-core-plan.md` (phase 7: "7i ★★: a club uses a system variable as it
is or copies it into its own set, or hides it (OD7, C109)"). It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): C2, C4, C5, C10, C51, C60, C88, C99,
C104, C106, C108 and C109, and the decision 9 pin guard. It builds on the proposed J14
(`docs/ai/phase7h-club-admin-mappings-contract.md`, phase 7h), it answers J18's Q14 → C125
(`docs/ai/c112-drag-mapping-contract.md`, section 5.5), and it amends what J16 (`docs/ai/phase8-mappings-screen-contract.md`)
and the canonical-variable screens say about system variables in a club.

**Written while J14 was still Proposed.** Everything here that depends on J14 holds **under the condition that J14 is
accepted with O1–O6 as recommended** (J14 section 11). Where an answer to J14 would change J15, the section says so.
Nothing in J15 is merged before J14 is accepted. *(Kept as written. The condition is met: the owner accepted J14 with
O1–O6 as recommended on 2026-11-02, in the same words that accept this contract (C126–C131), and PR #334 was merged
after that, on the *Rukovodilac*'s merge GO `011e7d13`.)*

| | |
|---|---|
| Status | **Accepted** by the owner on 2026-11-02: „J14 O1–O6 i J15 O1–O9 po preporuci, odobravam oba ugovora” (owner turn `95c006f2` in the *Rukovodilac*'s chat, 20:16:10 UTC; relayed with its event id by the *Rukovodilac*'s order `011e7d13`, 20:16:22 UTC; the executor checked it in the transcript). Merged as PR #334 (`93f36615`) exactly from head `aa0b2589` after both narrow ★★ GOs. The decisions are C132–C140 (section 12). The implementation is 7i-B (section 11), after the lock-order pull request (R13). Proposed by the executor on 2026-11-02, on the *Rukovodilac*'s orders of that day: KORAK 2 of its order queued at 13:35:02 UTC ("J15 za 7i … kao poseban PR"), and its permission queued at 16:57:27 UTC to write it before J14 is accepted ("novi worktree iz main-a; PR otvaraš tek kao Proposed; svuda gde J15 zavisi od J14 piši „pod uslovom da J14 bude prihvaćen sa O1–O6 kako su preporučeni"; ništa se ne merguje pre prihvatanja J14"). Documentation only. |
| Verified against commit | `565fe097` (merge of PR #331). Every file and line reference below is to that commit unless it names J14's head `3a4f7933` (PR #333). |
| Mark | ★★: external-review triggers 1 (a migration), 2 (`owner_scope`, information hiding), 3 (a **copy**: canonical identity and materialization) and 4 (transactions, lock order, idempotency). Reviewed by the *Rukovodilac* and the *Nezavisni revizor*. |
| The owner's decision | **C109 / OD7** (2026-10-30): „Sistemske kanonske varijable su pre svega zamisljene kao nesto sto klub moze vrlo brzo da koristi da mozda ih ubaci u svoje da ne mora da ih kreira ako mu odgovaraju, ako ne odgovaraju on moze i da ih sakrije, ne trebaju mu na primer... To je sustina, svi ce oni napraviti neki svoj skup core varijabli” (turn `bf4c6ce7`); the two forms (a) *use as is* and (b) *copy to own* are the *Rukovodilac*'s decision recorded in C109. Sections 2–4 make them concrete. |
| Owner decisions | **O1–O9** (section 12), decided as recommended on 2026-11-02: **C132–C140** in the discovery document's section C (R12). |
| Decides | The *Rukovodilac*: R1–R13 (section 13). The owner: O1–O9 and, for a ★★ phase, the contract before any code (`metrics-core-plan.md`, section 3, A1). |
| Migration | **One**, the next free number after J14's v52 (J14 R1) and J18's migration (≥ v53 by J14 section 14; J18's own text still says "v52 after 7h's v51", which J14 renumbers), whichever lands first, proposed as `migrations_v2/<YYYYMMDDHHMM>_training_load_vNN_system_variables_club.sql` (section 7, R1). |

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
- **Charts of club variables are not possible today** (section 1.7, from the code, not tested). Copying changes
  nothing for existing charts; **moving a team** to its copy stops new points on that team's existing charts of the
  system variable, and the copy itself cannot be charted. That is its own owner question (O7), not solved here.

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
  offers no *Use* button (*Copy* and *Hide* stay). Several active system mappings (later, several sources) are listed
  by source.

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
accepted with O1–O6 as recommended**, through J14's A1 by the club admin (7h-B). 7i-B ships only after 7h-B is merged
(section 11), so a club admin can always do it.

### 2.3 Hide / Show again

- **What hiding is** (O1): a per-club preference. In the club's workspace and in every team workspace of that club
  (O2), a hidden system variable is left out of: the System tab's default list, the dashboard and calendar metric
  pickers, the switch-on choosers and J18's board. It is returned **flagged**, so result names, dashboard series labels
  and the Activities drawer still name it.
- **What hiding refuses:** switching the variable's system mapping on for any of the club's teams (S1, A1's listed
  starts, J18's board), with `409 variable_hidden`, **whoever starts it** — a platform admin in the platform workspace
  included (it amends C106 for that club's bindings: section 14). The club's choice binds its own teams.
- **What hiding is not:** an access boundary. `catalogVisibilitySql` and `isMetricVisibleToDashboard` are unchanged; a
  dashboard series may still be bound to a hidden system variable through the API, and a template clone still resolves
  it, in a team workspace always and in the club's workspace whenever no club variable passes the template's hint
  (section 4.4).
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
| Read system variables with club X's status (used / not used / no data source / hidden, and copied) | yes | yes | no per-club status | only *Hidden by the club* (no usage, no copy) | as today |
| Copy a system variable into club X | **yes** | yes | 404 | 404 | 404 |
| Hide / Show again for club X | **yes** | yes | 404 | 404 | 404 |
| Switch a team to the copy | **yes** (after 7h-B) | yes | 404 | 404 | 404 |
| Use as is (S1 of a system version) | yes (C106), refused while hidden | yes, refused while hidden | yes, refused on club X's bindings while club X hides it | 404 | 404 |

- **The identical 404** (`{ "error": "notFound" }`, `Cache-Control: no-store`), before the body, with nothing written
  and the key left free, for: another club's admin; an admin of clubs A and B acting in B's workspace on A's copy or
  hide; club X's admin in a team workspace; a coach; a private coach; an athlete; a user with no role; a revoked role;
  an archived club; an unknown id; an id of another club's variable. An inactive user gets the router's 401.
- **Never revealed:** another club's hides, copies or usage. The reads and the copy, hide and switch routes read hide
  and copy rows only for the workspace's own club. A start (S1, A1's listed starts, J18's board) reads the hide of the
  **binding's** club, and only after its scope check has passed (section 4.3's rule): an out-of-scope start gets the
  identical 404 whether or not that club hides the variable.
- **A coach** keeps C99's rights on club variables (rename, archive, restore), so it may rename or archive a copy once
  it exists. It gets no act on system variables.
- **The acts follow the view, never the basis.** In a team workspace the variable reads give a club admin or a
  platform admin `view: "coach"` (`resolveVariableEditor`, `canonicalVariableAdminService.js:735-763`); the reads then
  carry no `actions` and only `club.hidden`, and the write routes answer the identical 404 (their context is
  `resolveMappingAdminWith`, which admits no team workspace).

## 4. Routes and answers

All under `/api/training-load/sources/metrics`, through the admin context of `resolveMappingAdminWith` (owner club =
the workspace's club), with J8's order of answers: 401; the identical 404 before the body; 415 / 400; a malformed id the
identical 404; 400 per body rule; the request record (`409 request_key_reused`, or the replay); the owner-filtered read;
the locks; the right checked again; the state refusals.

**Every request hash** is computed from the contract, the operation, the workspace's club, the path id and the body
only — never from a state read in the database (the existing hashes, `canonicalVariableAdminService.js:610-617`,
`:667-673`). The same key and body replay the saved answer whatever has changed since; the same key with another body,
or in another club, is `409 request_key_reused`, which depends only on the caller's own earlier requests. A replay
checks the right again and re-reads through the owner filter (`runWrite`, `sourceMetricMappingService.js:782-791`).

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

A copy that committed and whose answer was lost replays its saved answer with the same key and body, even after a new
system version; an unsaved request whose `expectedSourceVersionId` is stale answers `source_version_changed`.
`copy_mapping_not_reproducible` and the answer name source fields and system versions a club admin can already read
(system mappings are readable in a club workspace, `readableOwnerKeys`, `sourceMetricAccess.js:109`).

### 4.2 `POST /variables/:variableId/hide` and `…/show`

Body `{ requestKey }`. Answer `200 { variableId, hidden, hiddenAt }`; the same state again is `200` with
`idempotent: true` and nothing written. A no-op is **not** a request record (as a refusal is not, F3c2f): its key may act
later, and the screen never resends it by itself. Hide and show are **desired-state** acts: if *Check result* repeats a
key whose first answer was a lost no-op, and another admin changed the state in between, the repeat sets the state
this admin asked for, and the answer says which state is now in force (the right is checked again, as for every
replay).

| Refusal | When |
|---|---|
| the identical 404 | not readable, or not a club's workspace |
| `409 hide_not_system` | the club's own variable |
| `409 variable_in_use` (`current.activationCount`) | hide only: an open activation of its system mapping on the club's bindings |
| `409 try_again` | a lock wait |

The hide row itself is the request record (the T5 pattern: who, when, basis, key and hash on the row, section 7.3). A
key is unique per user across both acts: the guard refuses a hide key already used as a show key and the reverse
(section 7.3 says how).

### 4.3 `POST /activations/:activationId/switch-to-copy`

Body `{ requestKey, expectedState: "open", toVersionId, reason }` (the reason as S2's). One call moves one team; the
screen sends one call per team (section 8.2). Answer the ended and the new activation.

**The order of the answers** (no existence oracle on another club's versions): the identical 404 when the workspace is
not a club's (the platform workspace included, although `activationInScope` admits it for system mappings), or when
the activation is out of S2's scope; then `toVersionId` read **only among club X's own mapping versions**
(`owner_key` = the workspace's club id as text, v34 `:619`, taken from the club workspace itself and never from
`ownerKeyOf(ctx)`, which answers `system` in the platform workspace, `sourceMetricAccess.js:107`) — the identical
404 for an unknown id, another club's version (linked or not) or a system version; then
`409 not_a_copy_of_this_version` (no copy link from `toVersionId` to the activation's
version); `409 activation_not_open`; `409 version_not_active`; S1's start codes. The deep-equal test of section 10
covers an unknown id, a foreign linked version and a foreign unlinked one.

**Starts and the hide.** For S1, A1's listed starts and J18's board, `409 variable_hidden` is a state refusal like
`activation_exists`: it comes after the start's scope check (the identical 404 for a binding out of scope), and it
reads the hide of the **binding's** club (`source_metric_binding_club`, as the T5 guard does), never
`ctx.owner.clubId`, which is null in the platform workspace.

### 4.4 Reads

- `GET /variables?scope=system` and `GET /variables/:id` in club X's workspace (`view: "admin"`): each system row gains
  `club: { hidden, usedByTeams, hasDataSource, copyId }` for club X, and `actions` from `use`, `copy`, `hide`, `show`.
  In a team workspace of club X (`view: "coach"`, whatever the basis): only `club: { hidden }` and no `actions`.
  `?hidden=exclude|include|only` (default `exclude`) is bound into the `variables` cursor like the other filters; a
  cursor without it reads as `exclude`.
- `GET /mappings` and `GET /activations` in club X: a system mapping row gains `targetHiddenInClub`.
- The older `GET /api/training-load/metrics/definitions` (its only callers are the two picker loaders,
  `training-load-analysis-data.js:1545` and `training-load-calendar-data.js:347`): a system row gains `hiddenInClub`
  for the **active workspace's** club, resolved once for the request from the active workspace (a club workspace's id,
  or a team workspace's club; none for platform, private coach and athlete workspaces), never from `req.authz`'s roles.
  It also gains `ownerScope`, so a picker can mark OptiMove's row next to a same-named copy. `catalogVisibilitySql` is
  **not** changed. **The loaders keep every row** (the same arrays name results in the Activities drawer and the
  dashboard series); only the pickers' own render and selection leave flagged rows out.
- **Dashboard template clones** (`trainingLoadDashboardWidgets.js:105-117`), case by case:
  - **club X's data workspace, a copy with the system key, the original not hidden:** both are candidates, the series
    is `ambiguous` (the existing status, never an auto-pick) until the club hides the original or picks one;
  - **club X's data workspace, the original hidden:** for each hint, **after** its `valueType`, `unit` and
    `scopeLevel` filters (`trainingLoadDashboardWidgets.js:141-162`: the filters `:145-153`, the empty-row `continue`
    `:155`), the resolver leaves out a system definition
    club X has hidden **only when** a club X definition is still among that hint's rows, so the copy resolves (O4).
    When no club X definition passes the hint (none of that key, or one the hint's filters drop), the hidden system
    variable stays and resolves as today, so a club template never ends `unresolved` because of a hide (hiding is not
    an access boundary);
  - **a team data workspace of club X:** club definitions are never candidates there, and the resolver **does not**
    apply the hide: a hidden system variable still resolves, so team templates keep working (hiding is not an access
    boundary);
  - every other data workspace: unchanged.

## 5. The writes, in the documented lock order

- **Copy:** per-user advisory lock → the request record → (plain read of the source and its active system versions,
  to know what to lock) → the conversions → T2a and T2b `FOR SHARE` → the system T3 rows `FOR SHARE`, ascending → the
  system T4 rows `FOR SHARE`, ascending → the system definition and its current version `FOR SHARE` → its scope
  capabilities `FOR SHARE` → the rights (`users`, `user_club_roles`, club `FOR SHARE`, in J14's 7h-B order) → the
  facts compared again under the locks (`source_version_changed`, `copy_mapping_not_reproducible`) → the inserts
  (definition, version, capabilities, **the copy row**, club T3s, club T4s, **then the links**, T8 rows, the request row
  last; the link guard needs the copy row). This is D's
  order (v34 `:38-49`); a concurrent A1 / A2 of a copied system version or a new system variable version serializes
  with it at T4 or at the definition, and no cycle forms.
- **The hide lock, defined once.** For a club id `c` and a definition id `d` (both `uuid`), the hide lock is
  `pg_advisory_xact_lock(hashtextextended('club-variable-hide:' || c::text || ':' || d::text, 0))`. It is always built
  in SQL from `uuid` values (`$1::uuid`, `$2::uuid`), so the service and the guards give the same 64-bit key whatever
  case or form a string had in JavaScript; the seed is 0 everywhere. It is a different key family from `runWrite`'s
  per-user lock (`hashtextextended(…, 34)`, `sourceMetricMappingService.js:779`). Sections 7.3 and 7.5 use this
  expression. Several hide locks in one transaction are always taken **ascending by `(c, d)`** (the `uuid` order),
  never by the hash, in every service.
- **Hide / show:** per-user advisory lock → the request-key lookup (a plain read, for a replay) → the system definition
  `FOR KEY SHARE` → the rights (`users`, `user_club_roles`, club `FOR SHARE`, in J14's 7h-B order `u, r`) → **then** the
  hide lock for (the workspace's club, the variable) → the open activations of its system mappings on the club's
  bindings (a plain read, a statement of its own after the lock, under READ COMMITTED) → the insert or the end of the
  hide row. The v48 T5 insert guard, replaced in section 7.5, takes the same hide lock before it reads the hide row, so
  a hide and an S1 of the same club and variable serialize. **Every path takes the hide lock after its rights rows** —
  the hide, the show and every start — which is D's position below. Taking it before the rights is a deadlock: a hide
  holding the lock and waiting for its own user row, a club-admin revocation holding that row (`FOR UPDATE OF u, r` over
  all the club's admins, by `u.id`) and waiting for the starting admin's row, and a start holding that row `FOR SHARE`
  and waiting for the hide lock. The *Nezavisni revizor* reproduced it (3 of 3 runs deadlocked, 0 of 3 with the rights
  first), and the executor reproduced it the same way on a throwaway PostgreSQL 16 (3 of 3, and 0 of 3).
- **Where the hide lock sits, on every path that takes one** (the hide, the show, S1, A1's listed starts, J18's
  board): **after the path's last row lock, and before its state checks and its first write.** The row locks are D's:
  the registry rows, the T5 rows the path will end (`FOR NO KEY UPDATE`), the bindings and teams, the rights and the
  clubs. A start takes the hide lock for every (binding club, variable) pair it will start, ascending by `(c, d)`, and
  then reads its T5 collisions (`activation_exists`, `variable_taken_on_binding`); the T5 guard's own lock at each
  insert is a repeat. A service never leaves the lock to the guard. So a path never waits for a hide lock while it
  holds an uncommitted write, and a hide-lock holder afterwards waits only for transactions that are already past
  their own last lock. For J18's board that means between step 14 (the rights) and step 15 (the state checks), before
  step 16.2's T5 ends; for A1, after its listed bindings and rights and before its first end. This adds a lock class
  to D's order (v34 `:38-49`): after the clubs, before every write. Two failures this rules out, both reproduced on the
  throwaway PostgreSQL 16 by the internal re-review and again by the executor:
  - several starts taking two keys in opposite order (`40P01`, answered `try_again`);
  - a start that read its collisions and then waited for the hide lock, while a club-version start committed an open
    row on the same binding and field and J18's board (or A1) ended that row and then waited for the same hide lock:
    the start's insert waited on the board's uncommitted end, and the board on the start's hide lock (2 of 2
    deadlocked with the board locking after its end; 0 of 2 with the board taking the hide lock before its first
    write, where the start's insert gets a plain `23505`, which `insertStarts` already maps to `activation_exists`).
- **No new row lock after the hide lock** (the *Nezavisni revizor*'s note on `aa0b2589`, accepted by the
  *Rukovodilac*). Once a path holds its hide locks, neither its service nor any guard takes a row lock it does not
  already hold: the guards' re-locks find rows the path took earlier in D's order (T4 `FOR SHARE`, the rights rows, the
  binding), and every new fact is a plain read. In particular the hide and show guards (section 7.3) read the
  definition's `owner_scope` with a plain read; the service holds that row `FOR KEY SHARE` from before. The rule is a
  defence in depth: a lock there that conflicts with `FOR SHARE` (`FOR NO KEY UPDATE`, `FOR UPDATE`) would deadlock,
  by construction, with an A1 that holds the definition `FOR SHARE` (D's step) and waits for the hide lock. A
  `FOR SHARE` there would not: PostgreSQL grants a share request compatible with every lock held on the row at once,
  even with a writer waiting (a new system version takes the definition `FOR UPDATE`,
  `canonicalVariableAdminService.js:688-689`) — the internal review of the acceptance pull request ran the hide, an A1
  and a new version 7 of 7 times without a wait (so the reviewers' example of a three-way cycle through `FOR SHARE`
  does not form; section 16).
- **A1 at `565fe097` does not follow D's order:** it checks the rights (`sourceMetricMappingService.js:1426`), ends
  the old version's activations (`:1465`) and only then locks its listed bindings (`:1485`). Its listed starts get
  hide locks in 7i-B only once A1 takes its listed bindings and teams before its rights and every lock before its
  first end (R13). (The same rights-before-binding order is the switch deadlock below; for A1 it exists today, with or
  without J15.) **Built as LO-1 (J14 section 18; PR #344, merged and deployed on 2026-11-03):** A1 takes its listed bindings and teams `FOR SHARE` before its
  rights, the clubs right after them, and every lock before its first end. LO-1's test 9 runs this section's three-way
  race (A1 with a listed start, an Unbind of that binding and a club-admin revocation) with no `40P01` (it catches the
  old order); tests 9b and 9c pin the order itself (A1 holds its listed binding at its right; the SQL order of a
  replacement up to its first end).
- **Switch to copy:** D's order, as S1 and J18's board take it: T2a / T2b → T3 → T4, ascending over both versions → the
  old T5 `FOR NO KEY UPDATE` → **the binding and its team `FOR SHARE`** → **then the rights** (`u, r`) → the club → the
  end, the start, the T8 rows (`activation_end` unkeyed, `activation_start` keyed last). It starts a club version, so it
  takes no hide lock. The rights before the binding would be a three-way deadlock: the switch holding its user row and
  waiting for the binding, an Unbind holding the binding `FOR UPDATE` (`sourceConnectionService.js:486-492`) and waiting
  for its own user's rows (`:509`, `for share of r, u` at `:216`), and a club-admin revocation holding those rows and
  waiting for the switching admin's row. Reproduced by the internal re-review (3 of 3 under both role orders of the
  Unbind; 0 of 3 with the binding first) and by the executor (2 of 2; 0 of 2).
- **The rights order these arguments rely on.** At `565fe097` the club-admin branch of `rightsStillHold` locks the
  role before the user (`for share of r, u`, `sourceMetricAccess.js:134-137`), against the revocation's
  `for update of u, r` (`organization.js:2437`): a two-way inversion that exists today. J14's 7h-B turns it to `u, r`;
  7i-B ships only on that order, with a test that pins it. The platform branch (`g, u` against the platform
  revocation's `u, g`, `organization.js:529`) is the separate lock-order pull request recorded with J14; J15 claims no
  freedom from that inversion.

Bounds as 7b / 7d: 2 s row locks, 10 s per statement, 5 s per-user lock; `55P03`, `40P01` and `57014` answer `try_again`.
A copy's total length is bounded by the 10-mapping cap. The F2 COMMIT discipline is `runWrite`'s, unchanged.

## 6. Concurrency

| Against | Outcome |
|---|---|
| Copy vs A1 / A2 of the system version being copied | They serialize at the system T4 row. Copy first: A1 / A2 then proceeds; the copy holds a draft of a version that may later be disabled — harmless, the copy is the club's. A1 / A2 first: the copy reads the new state under its lock and copies the new active version or refuses with `copy_mapping_not_reproducible`. |
| Copy vs a new system variable version, archive or rename (R2) | They serialize at the system definition (`FOR SHARE` against `FOR UPDATE`). The copy re-reads under the lock and answers `source_version_changed` or `source_not_active`. |
| Two copies of the same system variable by two admins of club X | The copy rows' unique (club, system variable) refuses the second at insert (`already_copied`); a lost answer replays by key. |
| Hide vs S1 of the same variable on the club's binding | The shared advisory lock: hide first → S1's guard reads the open hide row and refuses (`variable_hidden`); S1 first → hide reads the new open activation and refuses (`variable_in_use`). |
| Hide vs a club-role revocation | Like any club-admin write (J14 section 5 and R13): the rights rows `FOR SHARE` before the hide lock; the revocation lands first → the identical 404. |
| Hide (or show), an S1 of the same club and variable, and a revocation of that club's admins, all three at once | No cycle. The revocation's only advisory lock is the club-admin headcount lock (`organization.js:2417-2421`, taken before its `FOR UPDATE OF u, r` at `:2430-2437`; a two-key lock of another family), which no hide, show, start, copy or switch takes. So the three share only the rights rows, and both the hide and the start take those before the hide lock. The revocation waits for both, or they wait for it; the side that lost its right answers the identical 404. (With the hide lock before the rights this is a three-way deadlock, section 5.) |
| Copy vs a club-admin revocation, alone or with a hide, a show or a start at the same time | No cycle. The copy takes no hide lock and not the headcount lock. Its registry rows are `FOR SHARE` and come before its rights; after its rights it only inserts its own new rows (the club definition, its version and capabilities, the copy and link rows, club T3 / T4, T8 and the request row), which nobody else waits for. The revocation and the copy meet only at the copying admin's rights rows, both in `u, r` order: the two-party case of J14 R13, and the copy answers the identical 404 when the revocation commits first. Its shared registry locks are compatible with a start's, and the hide's read of open activations is a plain read, so no third party closes a cycle. |
| Switch to copy vs a club-admin revocation, alone or with an Unbind or a hide at the same time | No cycle, with the switch in D's order (section 5): it locks the binding and its team before its rights, as S1 does, so an Unbind holding the binding stops the switch before the switch holds any rights row. It starts a club version, so it takes no hide lock, and the hide's read of open activations is a plain read. With the rights before the binding this is a three-way deadlock with an Unbind and the revocation (section 5). |
| A start (S1 or A1's listed starts) and J18's board or A1 ending a T5 row on the same binding and field, while a hide of that variable holds the hide lock | No cycle: every path takes its hide locks before its state checks and its first write (section 5), so the board or A1 never holds an uncommitted end while it waits for a hide lock. A start whose insert meets a row another transaction only holds **locked** gets `23505` at once, mapped to `activation_exists`. That holds only for a row that is merely locked: an insert that meets a row another transaction has already **updated** and not committed (an uncommitted end) waits for that transaction instead. This order rules out the cycle: no path that holds an uncommitted write ever waits for a hide lock, because every path that takes one takes it before its first write (the *Rukovodilac*'s note on `aa0b2589`). A hide-lock holder may still wait, bounded by the 2 s row-lock bound (`try_again`), behind an end by a path that takes no hide lock (a switch to a copy, S2, A2); that path waits for nothing the holder has, so no cycle forms. |
| Switch to copy vs an import approval or a check-time preview | As S1 and J18's board against the importer (`c112` §4.4): the importer holds its T5 rows `FOR SHARE`, which the switch's `FOR NO KEY UPDATE` of the old row waits for; the switch holds only shared registry and binding locks, which the importer never waits for, so no cycle forms. The approval answers `preview_changed` when the switch lands first. |
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
value, `canonical_parameters`, each compared null-safe (`is not distinct from`); and the system version pins the copy
row's `system_version_id` while the club version pins the copy's version 1. `conversion_note` (free text) and
`rounding_decimals` (presentation) are left out on purpose. A deferred check at COMMIT requires the club version's
`mapping_version_create` T8 row.

**J18's gate** then accepts this link as the second proof, beside a checked T9i row: a club admin's activation of a
parameter-less club version passes when the version has a link row whose system version is **still active** at the
activation. The gate reads the linked system version's status with a **plain read**, never a lock: a lock taken there
would come after the club admin's rights and could close a cycle with an A2 of the system version and a revocation. A
disable that commits after that read does not undo the activation (the link proves the parameters are identical, which
a later disable does not change). Whichever of J18's migration and this one lands second replaces the other's gate
body under an md5 precondition (R7).

### 7.3 `training_load.metric_definition_club_hides`

One table for state and history, shaped like T5. Columns: `id`, `club_id` (FK `public.clubs`, `on delete restrict`),
`metric_definition_id` (FK, `on delete restrict`), `hidden_by_user_id`, `hidden_basis`, `hide_request_key`,
`hide_request_hash`, `hidden_at`, and the show facts `shown_by_user_id`, `shown_basis`, `show_request_key`,
`show_request_hash`, `shown_at` (all null or all set). Two unique indexes, `(hidden_by_user_id, hide_request_key)` and
`(shown_by_user_id, show_request_key) where shown_at is not null`, plus the cross-act check below; a unique partial
index on `(club_id, metric_definition_id) where shown_at is null` (one open hide); never deleted.

Its guards: BEFORE INSERT — the actor (v35 setting) is `hidden_by_user_id`; the basis is
`source_metric_actor_basis(actor, club_id)` and equals `hidden_basis`; the definition is `owner_scope = 'system'` (a
**plain read**, never a lock: the service already holds that row `FOR KEY SHARE`, section 5's rule below);
`hidden_at = now()`; under the hide lock of section 5 for `(club_id, metric_definition_id)`, no open T5 activation of a
system mapping version targeting the definition on a binding whose `source_metric_binding_club` is `club_id`. BEFORE
UPDATE — only the show facts, once, with the same actor and basis rules. **The guards' advisory locks, in this order:**
first the hide lock of section 5 for `(club_id, metric_definition_id)` (a repeat when the service already holds it),
then the key lock. **The key namespace:** under
`pg_advisory_xact_lock(hashtextextended('club-variable-hide-key:' || actor::text || ':' || key, 0))`, both guards refuse
(`23514`) a hide key that is already a show key of the same user in any row, and the reverse; the two unique indexes
cover a repeat within one act. So the namespace holds for a raw writer that does not hold `runWrite`'s per-user
lock. BEFORE DELETE and BEFORE TRUNCATE — refused. The copy and link tables (7.1, 7.2) refuse UPDATE, DELETE and
TRUNCATE the same way. No other writer.

**Raw writers** to this table (as to the other guard-protected tables, the standing rule of `docs/ai/CURRENT_STATE.md`)
use READ COMMITTED: the guards' reads after the advisory locks see what committed before the lock was granted only
under that isolation. The application pins it; the runbook names it.

### 7.4 The variable request record

`metric_variable_requests` (in force: v36's table, v38's `version_iff` (`:274-275`) and trigger `WHEN`
(`:291-296`), v45's operation list of six (`:119-130`)) gains the operation `variable_copy` (the operation CHECK
widened from v45's list; `version_iff` admits a version for `variable_copy`; the index
`metric_variable_requests_one_create_per_definition` gets the predicate `operation in ('variable_create',
'variable_copy')`) and a nullable `operation_id` with the CHECK `(operation_id is not null) = (operation =
'variable_copy')` (equal to the T8 rows' and the copy rows' `operation_id`, so a replay and the post-COMMIT check find
every row the copy wrote). `operation_id` gets no unique index of its own: one `variable_copy` row per definition
already follows from `one_create_per_definition`, and the replaced guard requires the copy row with the same
`operation_id` in the same transaction. The v36 insert guard (`training_load.metric_variable_requests_insert_guard`,
body in force since v36: v38 recreated only its trigger, and no later migration through v51 replaces it; md5
`ae5bf5e22620546a83cf955b8b1d9a9d`) is replaced so that `variable_copy` is checked as `variable_create` is, plus: the
copy row of the definition exists in this transaction with the same `operation_id`. Its trigger's `WHEN` gains
`variable_copy`. (`11095b44b633e9eb1262f5189c4ec9c5`, which an earlier head named here, is the md5 of
`metric_variable_requests_append_only`, which this migration does not touch.)

### 7.5 The T5 insert guard

`training_load.source_metric_activations_insert_guard` (body in force v48, md5 `e47f75d4a7a6c63659a19491db97d678`,
equal to the v48 rollback's constant) is replaced to add, for a **system** mapping version: take the hide lock of
section 5 for (the binding's club by `source_metric_binding_club`, the version's target definition) and refuse
(`23514`, "source_metric_mapping_activations: the variable is hidden in the binding's club") while an open hide row
exists. The hide row is read after the lock, which under READ COMMITTED (the application's isolation, and the one a raw
writer must use) sees a hide committed before the lock was granted. Every other line stays byte for byte. J14's v52
does not replace this body (it replaces the T5 update guard), so there is no conflict with 7h.

### 7.6 Preconditions, locks, rollback

- **md5 preconditions** on the two replaced bodies (an unknown md5 refuses the migration), and on **J18's gate body**
  when J18's migration landed first: then this migration also replaces that body (to accept the link of 7.2), with the
  md5 J18's migration gives it. When this migration lands first, J18's migration replaces its own gate body knowing the
  link table (R7). 7i-B confirms both values (and J18's, when it replaces that body) on a disposable database: after
  the migrations up to the previous one are applied, `md5(prosrc)` of each function equals its precondition, and the
  same values computed from the migration files agree (section 10).
- **Locks**, in a write's own order, **every explicit `lock table` with `nowait`**: `metric_variable_requests` in
  **ACCESS EXCLUSIVE** (its column, CHECKs, index and trigger `WHEN` change; v45 `:59` is the precedent; the Variables
  screen's reads wait until the migration commits, and a busy table fails it at once with nothing applied, as J14 R10);
  T5 in `share row exclusive` (its guard body only); J18's T4 gate, when replaced, in `share row exclusive`. So no
  explicit lock waits behind a reader while ACCESS EXCLUSIVE is held: a busy table fails the migration at once. The
  three new tables are new, but their foreign keys take `SHARE ROW EXCLUSIVE` on the tables they reference
  (`public.clubs`, `metric_definitions`, `metric_definition_versions`, T4, and `public.users` for any user column given
  a foreign key) when they are created. That is the accepted risk of v34, v36 and v48: the window is bounded by the
  runner's `lock_timeout` (30 s by default, `backend/src/migrate.js:543`) and by the quiet-moment block. The preflight's
  quiet-moment block is the gate, and the deploy follows it at once.
- **Preflight / post-check / rollback** as v48 and v50, with a Serbian runbook for the owner (including what to do when
  `nowait` fails: wait, repeat the deploy at a quiet moment, delete nothing; and the READ COMMITTED rule for raw
  writers of section 7.3). The rollback refuses once any copy, link or
  hide row, or any `variable_copy` request, exists, or a later migration is recorded, or the gate body in force
  references the link table and J18's previous body cannot be restored by md5. Otherwise it drops the three tables and
  restores byte for byte: both replaced bodies; J18's gate body if this migration replaced it; the operation CHECK
  (v45's six), `version_iff`, the index predicate, the trigger `WHEN` (v38's); and drops `operation_id`. Its SQL files
  get a `.gitattributes` `eol=lf` line.
- **A read-only preflight count** of system variables a copy would refuse (non-numeric, a `day` level, an unsupported
  condition, a non-token unit), so the owner knows before 7i-B what `copy_source_unsupported` will meet.
- **Deploy compatibility:** the old code never writes the new operation or tables; old reads ignore them. After a code
  rollback with hide rows in place, the old S1 on a hidden variable meets the new guard's `23514`, which the old code
  does not map: a sanitized 500 instead of `409 variable_hidden`, nothing written.

## 8. The service and the screen (7i-B)

### 8.1 The service

- `copyVariable` in `canonicalVariableAdminService.js`, through `runWrite` with the variable request table, reusing
  `createVariable`'s validation for the editable fields and `createVersion`'s derivation for each copied version.
- `hideVariable` / `showVariable` with the hide row as the request record.
- `switchToCopy` in the activation service.
- **S1 and A1's listed starts** check the hide of the binding's club after their scope check and before the insert
  (`409 variable_hidden`, section 4.3's rule), and the classifier maps the T5 guard's new `23514` text to the same
  code; the hide locks of section 5, ascending by `(club, definition)`.
- The readers of section 4.4: `listDefinitions` takes the club resolved once from the active workspace; the template
  resolver applies club X's hide set only in club X's data workspace.
- `actionsOf` gives the new acts only when `ctx.view === "admin"` **and** the workspace is a club's, never from the
  basis; `[]` in a team workspace and in the platform workspace (where `resolveVariableEditor` also answers
  `view: "admin"`, `canonicalVariableAdminService.js:739-741`). It leaves out `copy` for a system variable that
  `copy_source_unsupported` would refuse, and `use` for one with no active system mapping or no linked GPEXE team.

### 8.2 The screen ("mora biti mnogo jednostavnije za korisnika")

Every write on this screen follows the existing pattern of the Variables and Mappings screens (J16 section 8;
`refused()`, `frontend/metric-variables-actions.js:556-566`): one write at a time; *Saved*; a stated refusal with its
sentence; and for a lost answer, an uncoded 5xx or `outcome_unknown`, *Result not confirmed · Check result*, which
repeats the same request key and never claims that nothing was saved.

- **The tab** "System (reference)" becomes **From OptiMove** in a club workspace. Its intro: "OptiMove's ready-made
  variables. Use one as it is if it measures what you need. Copy it only if your club wants its own name and to decide
  itself when it changes. Hide the ones you don't need."
- **Each row:** one status chip — *Used by this club's teams*, *Not used*, *No data source yet* (no active system
  mapping), or *Hidden* — plus *Copied* when the club holds a copy (a link to it). A select *Available / Hidden by your
  club / All* beside the existing *Active / Archived / All* select, which stays.
- **The detail:** at most three buttons, one primary by state: *Use for your teams* when not used; *Copy to my club*
  when used and not copied; *Open your copy* (a link to the copy's detail, where the move is) when used and copied;
  none when there is no data source yet (*Copy* and *Hide* stay as plain buttons) or when hidden (*Show again* is the
  only act):
  - **Use for your teams** — opens the system mapping's panel titled "Use <name> for your teams", with the club chosen
    and no team ticked, and a way back "← <name>". With no linked GPEXE team the detail says first "Link a team to GPEXE
    first (Settings → Source connections)." and offers no *Use* button. With no data source: "OptiMove has not
    connected a data source to it yet." and no *Use* button. *Copy* and *Hide* stay in both cases.
  - **Copy to my club** — offered only when the read's `actions` hold `copy` (never for a variable the server would
    refuse as `copy_source_unsupported`). One review card: the name (prefilled, editable); "It comes with N links to
    GPEXE fields, as drafts. Review and activate them on the copy's page." (N = 0: "It has no GPEXE field link yet.");
    "It will not follow later changes OptiMove makes."; under **Advanced**, folded, the key, prefilled, with "Keep it
    unless you have a reason to change it. It cannot be changed later."; one button *Copy*. After it the copy's detail
    opens and says "Copied. Next: open each draft link, submit it and activate it. Then move the teams that use
    OptiMove's <name> with *Move your teams to this copy*; switch it on only for teams that do not use it yet."
  - **Hide for my club / Show again** — one short confirmation: "<name> disappears from this club's lists and pickers,
    and from those of its teams' coaches. Recorded values, results and charts already made stay." While teams use it,
    the button is off with "Switch it off for your teams first." and a link *See the teams using it*.
- **On the copy's detail:** "Copied from OptiMove's <name>. Sessions imported before your teams move stay under
  OptiMove's <name>." While a team still uses the original: **Move your teams to this copy**. Until the copy's link
  for the field a team uses is active, the button is off with "Activate the copy's GPEXE field links first." Once it
  is on, it opens one review card:
  - it names each team that uses the original and says its Required / Optional setting is kept;
  - a team that uses another OptiMove version than the one the copy was made from is listed apart, before anything is
    sent, as "Can't be moved: it uses a different OptiMove version than the one your copy was made from. Switch it off
    and then on with your copy; there is a short gap in between, in which a search does not read this field for the
    team." It is not sent;
  - "Sessions already imported stay under OptiMove's <name>.";
  - while O7 is open: "Your existing charts of <name> get no new points after the move.";
  - a reason field, as *Switch off*;
  - the button **Move N teams**, which sends one call per team, one at a time, with one result per team: *Moved*, *Not
    moved* (the refusal's sentence), or *Result not confirmed · Check result* (the same key).
  Once no team uses the original: "Hide OptiMove's <name> for your club" as a link to the hide confirmation.
- **Sentences for the new codes**, each with its next step: `already_copied` "Your club already has a copy." *Open it*;
  `variable_in_use` "Teams of this club still use it." *See the teams using it*; `variable_hidden` "This club hides
  <name>. Show it again first."; `source_version_changed` "OptiMove changed this variable a moment ago. Open it again
  and copy." ; `copy_mapping_not_reproducible` "One of its GPEXE field links can't be copied now (<field>). Ask a
  platform administrator."; `copy_source_unsupported` (only in a race, since *Copy* is not offered for such a variable)
  "This variable can't be copied into a club. Use it as it is instead."; `copy_too_large` "It has too many links to
  copy at once. Ask a platform administrator."; `not_a_copy_of_this_version` (only in a race, since such a team is
  listed apart on the move card) "This team uses a different OptiMove version than the one your copy was made from.
  Switch it off and then on with your copy; there is a short gap in between."; `version_not_active` **in the move
  flow** "The copy's link is not active yet. Activate it first." (J16's "This version is no longer active." stays for
  the other flows); `try_again` as today.
- **A coach** sees only *Hidden by the club* on a hidden row, and no buttons.
- **The pickers** leave hidden rows out in their own render and selection (the loaders keep every row, so results keep
  their names); while the club holds a same-named copy, OptiMove's row is marked "(OptiMove)".
- **Replaced sentences** (section 14): `metric-variables-view.js:87` ("…are under System (reference).") and `:93` (the
  club's empty list) become "This club has no variables of its own yet. Look in From OptiMove first: use one as it is, or
  copy it. Create one here only for a measure that list does not have."; `:193` ("Read only here: system variables are
  changed in the platform workspace.") becomes "OptiMove changes this variable; your club cannot edit it." (the buttons
  beside it show what can be done).
  `metric-variables-data.js:246` stays true and stays.
- Phones: buttons stack, 44 px targets, 16 px fields. Reviewers: `code-reviewer`, `ux-design-reviewer`, `mobile-qa`.
  A browser check at 1280, 390, 375 and 360 px, and J16's interaction count for "copy, then use" and for "move N
  teams" measured against the real routes.

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
  headers) across a missing id, another club's variable, a foreign activation and, for the switch, an unknown
  `toVersionId`, another club's linked version and another club's unlinked one, for everyone else. A's admin in a team
  workspace reads no `actions` and only `club.hidden`. Club B's admin starting S1 on club A's binding for a variable A
  hides gets an answer deep-equal to an unknown binding (never `variable_hidden`); the platform admin in the platform
  workspace gets the identical 404 from the switch route and no acts in the variable reads.
- **Copy:** the variable, version 1 equal in every semantic fact, the capabilities, one club T3 and draft T4 per active
  system version, the link rows, the copy row, the T8 rows and the request row, all in one transaction; nothing for a
  draft, needs-review or disabled system version; each refusal of section 4.1 with nothing written and the key free;
  replay and `request_key_reused` (a lost answer, then a new system version, then the same key and body: the saved
  answer); the copy's drafts submitted and activated by the club admin; template clones in the cases of section 4.4 (a
  same-key copy not hidden: `ambiguous`; hidden: the copy; hidden with no club variable of that key: the system
  variable, never `unresolved`; hidden with a same-key club variable that the hint's `unit`, `valueType` or
  `scopeLevel` filter drops: the system variable, never `unresolved`; a team data workspace: the system variable,
  hidden or not).
- **Hide:** hide and show by each allowed actor; idempotent repeats (a no-op key acting later, as section 4.2 says;
  a lost no-op, another admin's change, then *Check result* with the same key: the state this admin asked for, named
  in the answer);
  a key used for a hide refused for a show and the reverse; `variable_in_use` with an open activation; S1 and A1's
  listed starts refused for a hidden variable (`variable_hidden`), the platform workspace's S1 on club A's binding
  included; the readers flag, the loaders keep every row and the pickers drop in their render; result names, existing
  series and manual values unchanged; a coach in a team workspace of the club sees the badge; another club sees
  nothing; a user with roles in clubs A and B, in A's workspace, sees A's hides only; a `variables` cursor without
  `hidden` reads as `exclude`.
- **Switch:** one transaction, no window (a check between is impossible), the requirement kept, the T8 pair; each
  refusal in the order of section 4.3.
- **Direct SQL** (each with its first-firing guard, code and message): every guard of section 7 refuses a missing
  actor, another actor, a wrong basis, a system definition as a copy's club side, a non-identical link, a link to a
  never-activated system version, a link whose pins differ, a link before its copy row, a hide of a club variable, a
  hide with an open activation, a hide key reused as a show key of the same user (and the reverse) without the
  per-user lock, a write inside a savepoint, a copy row or a link row without its request or T8 row at
  COMMIT, an UPDATE, DELETE or TRUNCATE of each of the three tables (outside the show facts), and a `variable_copy`
  request without `operation_id` or another operation with one.
- **Races** (no `40P01`, the second request by another user), each **route against route and driven
  deterministically**: the `writeHold` seams of the services (as `sourceMetricActivationService.js:126` and
  `canonicalVariableAdminService.js:705` already have) and the waits seen in `pg_stat_activity` (`wait_event_type =
  'Lock'`) fix the interleaving; sleeps and "at once" are never the proof (the 7d suite's pattern,
  `mapping-activations-7d.test.mjs:365-399`). Each race that guards a lock order names its mutation, which the same
  script must turn into `40P01` on every run:
  - copy vs A1 / A2 of the copied system version; copy vs a new system version and vs an archive; two copies by two
    admins; hide vs S1, both orders; switch vs an import approval and vs S2;
  - **a hide, an S1 of the same club and variable by another admin, and a revocation of the club's admin roles**, the
    hider's user id below the starter's: hold the S1 at a seam after its last row lock and before its hide lock (7i-B
    adds it; today's `activation_start` seam sits after the checks, which now come after the hide lock); start the
    revocation and wait until it waits for a row lock (it then holds the hider's rows and waits for
    the starter's); start the hide and wait until it waits; release the S1. Expected: no `40P01`, the S1 succeeds, the
    revocation commits, the hide answers the identical 404. Mutation: the hide lock before the rights in the hide →
    `40P01`. **The same with a show** of an open hide in place of the hide, with its own mutation;
  - **a switch to the copy, an Unbind of the same binding and a revocation of the club's admin roles**, the Unbind's
    user id below the switcher's: hold the Unbind after its binding lock and before its rights (a test seam in
    `unbindTeam`, which 7i-B adds); start the switch and wait until it waits on the binding (in the contract order it
    holds no rights row then; under the mutation it holds its own); start the revocation and wait until it waits;
    release the Unbind. Expected: no `40P01` (the Unbind's or the switch's right is gone, the identical 404 or
    `rights_changed`). Mutation: the switch's binding after its rights → `40P01`;
  - **a start and J18's board (and the same with A1) ending a T5 row on the same binding and field**: hold the S1 at
    its `activation_start` seam (after its hide lock and its checks, before its insert); a club-version start commits
    an open row on that binding and field; the board locks that row and waits for the hide lock (under the mutation it
    ends the row first); release the S1. Expected: no `40P01`; the S1's insert meets the row the board only holds
    locked and answers `activation_exists`. Mutation: the board's (or A1's) hide lock after its first T5 end →
    `40P01`;
  - two S1s of the same variable on bindings of two clubs in opposite order (no `40P01`, thanks to the ascending
    advisory locks), **and the same with two A1s with listed starts** on several bindings in opposite order, route
    against route (the *Rukovodilac*'s first note on `61347a51`); a club-role revocation during a copy (J14 R13's
    route-against-route pattern);
  - **a hide, and an A1 of the hidden variable's system mapping that waits for the hide lock** (the *Nezavisni
    revizor*'s note on `aa0b2589`, as corrected): hold the hide after its hide lock; start the A1 and wait until it
    waits for the hide lock (it holds the definition `FOR SHARE`); release the hide. Expected: no `40P01`, and while the
    hide's guard runs, `pg_locks` / `pgrowlocks` show only `For Key Share` from the hide on the definition row.
    Mutations: a lock in the hide guard that conflicts with `FOR SHARE` (`FOR NO KEY UPDATE`) → `40P01`; a `FOR SHARE`
    there → killed by the lock-mode assertion, not by a deadlock (none forms, section 5).
- **J18's gate** (only when J18 is built): a club admin's activation of a copied parameter-less draft passes through
  the link, and is refused (`23514`, `409 confirmation_required`) once the linked system version is disabled.
- **History (inferred today):** after a switch, a session imported under the system variable whose content GPEXE
  changed is `needs_review` once, its system value stays current; an unchanged session stays `unchanged`.
- **Migration rehearsal** as J14 section 10.5: preflight (its count of system variables a copy would refuse asserted on
  planted rows), `nowait` failing at once under a held reader of `metric_variable_requests`, apply, the exact catalog
  delta, the post-check, every rollback refusal, rollback to the previous catalog byte for byte (the operation CHECK,
  `version_iff`, the index predicate, the trigger `WHEN`, no `operation_id`), re-apply, LF endings; and, once J18's
  migration exists, both orders (J18 first: its gate body replaced under its md5 and restored by the rollback).
- **Mutations**, each killed by a named test: every guard condition above; the shared advisory lock removed from the T5
  guard or from the hide, or taken in another order; the copy's "active system versions only" filter widened; the reader
  flag ignored by a picker; the filter moved into a loader (results lose names); the template resolver ignoring the hide
  in a club workspace or applying it in a team workspace, or dropping a hidden candidate with no club candidate of the
  same key, or applying the hide rule before the hint's filters; the hide lock taken before the rights rows in the hide
  or the show (the three-way race must then end in `40P01` and fail); the switch's target read without the owner filter,
  or through `ownerKeyOf(ctx)`; a start's hide check before its scope check, or on `ctx.owner.clubId`; the hide locks
  sorted by the hash in one path and by `(club, definition)` in another (the race of two S1s in opposite order must end
  without `40P01`); the acts keyed on the basis instead of the view, or shown in the platform workspace; the cross-act
  key check removed from either guard, or the guards taking the key lock before the hide lock; the switch's binding
  taken after its rights; the board's or A1's hide lock taken after its first write; the service's ascending order of
  the hide locks removed; a lock on the definition in the hide guard (each killed by its race above; a `FOR SHARE` there
  by that race's lock-mode assertion); the
  club-admin branch of `rightsStillHold` back to `r, u` (a test pins `u, r`); the J18 gate's read of the linked system
  version taking a lock; the identical-404 gate widened.
- **md5 preconditions:** a test computes the md5 of the v36 request guard (`ae5bf5e22620546a83cf955b8b1d9a9d`) and
  the v48 T5 insert guard (`e47f75d4a7a6c63659a19491db97d678`) bodies from the migration files on disk, read as LF (the
  method that reproduces v48's rollback constant), and **confirms both on a disposable database** migrated up to the
  previous migration, as `md5(prosrc)` of each function; both equal this migration's preconditions (J18's gate body
  too, once it is replaced). A mutation that changes one byte of either body in a disposable database makes the
  migration refuse.
- **Frontend:** the From OptiMove tab, the chips, the three acts with their cards, the move card with one result per
  team, a sentence and next step for every new code, *Result not confirmed · Check result* on a lost answer with the
  same key, the coach badge, the pickers dropping hidden rows while results keep names, "(OptiMove)" beside a
  same-named copy; the copy card's key hint makes no promise about dashboards; *Move your teams* off until the copy's
  link is active, a team on another OptiMove version listed apart and never sent, and `version_not_active` in the move
  flow with its own sentence; *Copy* absent for a variable without `copy` in its `actions`; a mutation that shows the
  acts to a coach must fail.

Regression by `--file`: the M3-0, R2, 12b, icon, M2, 7b, 7d and 9-B suites, and `test:frontend:fast`.

## 11. Rollout

- **7i-B** (migration, backend, frontend, the switch included) comes after J14 is accepted and **after 7h-B is
  merged**, as one ★★ pull request.
- **The pilot club stays on form (a)** (O8): its three Required system mappings are not copied or moved; copy and hide
  are first used by a new club, with its own test data.
- The frontend never ships before the backend (J14 R7).

## 12. Questions for the owner (O1–O9)

Each has a recommendation and the alternative, in plain words. **All nine were decided as recommended by the owner on
2026-11-02** („J14 O1–O6 i J15 O1–O9 po preporuci, odobravam oba ugovora”, turn `95c006f2`): O1 → **C132**, O2 →
**C133**, O3 → **C134**, O4 → **C135**, O5 → **C136**, O6 → **C137**, O7 → **C138**, O8 → **C139**, O9 → **C140**.

- **O1. What "hide" does.** **Recommended:** the club no longer sees the variable in its lists and pickers, and it cannot
  be switched on for the club's teams; hiding is refused while the club's teams still use it (they are switched off
  first); recorded values, results and charts already made are never touched; "Show again" restarts nothing.
  *Alternative:* hiding switches the variable off for the club's teams by itself — more work, and easier to do by
  mistake.
- **O2. Who stops seeing a hidden variable.** **Recommended:** the club's administrators and the coaches of all its
  teams; a coach of teams in two clubs sees it as decided by the club of the team they are working in. Athletes and other
  clubs see no change. A club's hide also stops OptiMove's own administrators from switching it on for that club's
  teams. *Alternative:* only the club's administrators (coaches keep seeing it).
- **O3. What a copy takes over.** **Recommended:** the variable exactly as OptiMove defines it now (unit, limits,
  zones, daily total, levels), and its working links to GPEXE fields, as drafts the club then switches on; the name,
  short name, description and icon may be changed at once; categories are not copied. *Alternative:* also take
  OptiMove's links that are not approved yet — they carry no platform check.
- **O4. The copy's internal name** (the key ready-made dashboards look for). **Recommended:** it keeps OptiMove's
  internal name, so ready-made dashboards set up in the club's own workspace pick the club's copy once the club hides
  OptiMove's (until then, one added there asks which of the two to use); team dashboards keep using OptiMove's variable
  (club variables cannot be charted there yet, O7). *Alternative:* a new internal name from the copy's name —
  ready-made dashboards then keep using OptiMove's everywhere.
- **O5. How many copies.** **Recommended:** one per club and OptiMove variable; an archived copy is brought back, not
  copied again. *Alternative:* a new copy after archiving, under a new internal name.
- **O6. Moving teams to the copy.** **Recommended:** one step per team that switches it from OptiMove's variable to the
  club's copy, keeping Required / Optional, with no moment in which a search finds the field without a mapping;
  available once club administrators can switch on their own mappings (phase 7h). *Alternative:* two steps (switch
  off, switch on), with that gap.
- **O7. Charts of club variables** (from the code, not tested). Today no dashboard can show a club variable's imported
  values. Copying changes nothing for existing charts; **moving a team to its copy** stops new points on that team's
  existing charts of OptiMove's variable, and the copy itself cannot be charted yet. **Recommended:** a separate pull
  request, before more clubs are brought on, that lets a team's dashboards use its own club's variables (a migration and a
  security review); until then the move card says "Your existing charts of <name> get no new points after the move."
  *Alternatives:* accept it as a lasting limit; or allow copying but hold back moving teams until charts exist.
- **O8. The pilot club.** **Recommended:** it stays on OptiMove's variables; copying and hiding are first used by a new
  club. *Alternative:* move the pilot to copies — its history would split at the move.
- **O9. History after a move** (from the code, not tested). Sessions imported before the move stay under OptiMove's
  variable; if GPEXE later changes one of them, its re-import goes to review once and keeps OptiMove's value.
  **Recommended:** accept it, and say so on the copy's page. *Alternative:* a tool that moves old sessions to the copy —
  against the rule that a recorded value is never reinterpreted (ADR-007).

## 13. Decisions for the *Rukovodilac* (R1–R13)

**Decided by the *Rukovodilac*:** R1–R12 as recommended (its GO on `61347a51`, event `8dc1fac6`, 17:44:03 UTC, kept on
the corrected head); R13 as recommended, with the order of the pull requests made **mandatory: 7h-B → the lock-order
pull request (A1 in D's order, with a route-against-route test of A1 against an Unbind and a club-admin revocation) →
7i-B**; 7i-B never comes before the lock-order pull request (its narrow GO on `aa0b2589`, event `360823e4`, 20:13:22
UTC). J14's R13 and `CURRENT_STATE.md`'s lock-order task carry the same order.

- **R1. The migration number:** the next free after J14's v52 and J18's; the runbook file names wait for it.
- **R2. The request record:** a new operation `variable_copy` with `operation_id` (recommended) rather than a plain
  `variable_create`, which would lose that it is a copy.
- **R3. The copy's size cap:** 10 mappings, `409 copy_too_large`.
- **R4. The refusal codes and their order** of section 4, the switch's included.
- **R5. The lock order** of section 5: D's order on every path, the switch's included (the binding and team before the
  rights); J14's `u, r`; the hide lock defined once, taken after the path's last row lock and before its state checks
  and its first write, on every path that takes one; several ascending by `(club, definition)`.
- **R6. The T5 insert guard replacement** (section 7.5), md5-preconditioned; J14's v52 does not touch it.
- **R7. C125 option one** lives in this migration. If J18's migration lands first, this one replaces J18's gate body
  under J18's md5 and its rollback restores it; if this one lands first, J18's migration builds its gate knowing the
  link table and its rollback handles it.
- **R8. The pull requests:** 7i-B after J14's acceptance and 7h-B, the switch in it; the charts (O7) as their own pull
  request.
- **R9. The readers** that honour a hide (section 4.4), and that `catalogVisibilitySql` and `isMetricVisibleToDashboard`
  are not changed.
- **R10. Cursor compatibility** of `variables` with the new `hidden` filter.
- **R11. `test:backend:shared`:** the same evidence as J14 R9 (no shared-kind suite imports the touched services);
  recommended not needed, on the *Rukovodilac*'s word otherwise.
- **R12. Decision numbers:** the next free after J14's.
- **R13. A1 in D's order before 7i-B.** A1 checks the rights before it locks its listed bindings and ends activations
  before that (section 5), so it already has the switch's three-way deadlock with an Unbind and a revocation, and it
  cannot take J15's hide locks before its first write. Recommended: move A1 to D's order (listed bindings and teams
  before the rights, every lock and its hide locks before its first end) in the lock-order pull request recorded with
  J14, after 7h-B and before 7i-B, with a route-against-route test; 7i-B adds A1's hide locks only on that order.

## 14. What this contract supersedes or amends (accepted 2026-11-02; each row marked in its document)

The acceptance pull request marks every row below in its own document, next to the text it changes, and erases nothing.
A mark names J15 and says that it holds once 7i-B is merged and its migration deployed; until then the old text
describes the system as it runs. The Variables screen's row is code, changed by 7i-B itself.

| Where | What | How |
|---|---|---|
| Discovery C88 | system variables in a club are a "read-only reference" | amended: the club also uses, copies and hides them; they stay unchangeable by the club and never a club mapping's target |
| Discovery C106 | a club admin and a platform admin start system activations on a club's bindings | amended: refused while that club hides the variable (`variable_hidden`, after the start's scope check, by the binding's club), whoever starts it |
| Discovery C109 | "hiding per club is likely a new table" | made concrete: sections 2.3 and 7.3 |
| Discovery D (lock order, v34 `:38-49`) | no advisory lock class for the registry | amended: the hide lock of section 5, after the path's last row lock (the rights and, in a start, the binding, team and club) and before its state checks and its first write; several ascending by `(club, definition)`; the switch keeps D's binding-before-rights order |
| J18 §4.3 steps 14–16 and §4.4 lock order (`c112:479-495`, `:499-503`) | the board's starts take no advisory lock | amended: after step 14 (the rights) and before step 15 (the state checks), so before step 16.2's T5 ends, the hide lock for every (team's club, target definition) pair the board starts, ascending by `(club, definition)` (section 5) |
| J16 (`phase8`) club sentences | "System mappings come from a platform administrator; you switch them on for your teams." | amended: hidden ones are marked and cannot be switched on |
| J18 §3.6 and §7 eligibility (`c112:279`, `:794-799`) | every eligible active system version is pre-placed | amended: not when hidden in the team's club |
| J18 Q14 → C125 (`c112:640-643`, `:1172-1175`) | option one recommended, "decided with 7i" | carried: sections 7.2 and 7.6 |
| The Variables screen (`metric-variables-view.js:39-47`, `:62-67`, `:87`, `:93`, `:193`) | "System (reference)", "this club's own mappings cannot target them", "Check System (reference) first …", "Read only here …" | superseded by section 8.2 |

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
  The executor checked the facts this contract rests on in the code at `565fe097`, and the md5 values against the
  migration files (the method reproduces v48's rollback constant for the T5 insert guard). The v36 value was named for
  the wrong function up to `61347a51` and is corrected after the *Nezavisni revizor*'s review (below).
- **Round 1** of the internal reviews, on `53c85969` (each finding of MEDIUM or above checked again by an adversarial
  verifier from the code). Verdicts: `code-reviewer` part A (sections 0–6) NOT READY and part B (sections 7–16) READY
  WITH NON-BLOCKING NOTES; `db-reviewer`, `security-reviewer` and `ux-design-reviewer` NOT READY. After the
  verifiers, one HIGH stood (ux: the move had no review card) and the rest were MEDIUM or lower. All applied on the next
  head:
  - **ux:** the move card with its teams, kept requirement, history and chart sentences, reason and per-team outcomes
    (HIGH); O7 names the move, not the copy, as what stops chart points; the replaced screen sentences; the outcome
    pattern and a sentence per code; "(OptiMove)" in the pickers beside a same-named copy; the status chip *No data
    source yet*; the copy card's wording, its key under Advanced, the next step; plain words in O1–O9;
  - **db:** the copy row before the links (the link guard needs it); `metric_variable_requests` in ACCESS EXCLUSIVE
    with `nowait` (v45's precedent); J18's gate body in the md5 preconditions and the rollback; the in-force bases of
    the request table and the `operation_id` CHECK; the null-safe "identical" predicate and its pins; the advisory locks
    in ascending order, named and placed in D; append-only guards on the three tables; one key namespace for hide and
    show; the code-rollback effect;
  - **security:** the switch's order of answers (the target version read only among the club's own, before the link
    check); the acts follow `view`, never the basis, and a coach gets only `club.hidden`; the hash rule with the club;
    the platform path for a hidden variable stated and C106 amended; the pickers filter only in their own render;
    the club resolved once from the active workspace; template resolution in a team data workspace;
  - **code:** the hash sentence of 4.1; template resolution case by case; the no-op hide key; the migration numbering;
    the 7i-B / 7h-B ordering made one.
- **Round 2**, narrow re-reviews of the delta `53c85969..27501e87`: `code-reviewer`, `db-reviewer`,
  `security-reviewer` and `ux-design-reviewer` all READY WITH NON-BLOCKING NOTES; every round-1 finding closed. Their
  notes (one code MEDIUM, one ux MEDIUM, the rest LOW and NIT) are applied on the next head:
  - **code:** O4 and the copy card's key hint no longer promise that team dashboards switch to the copy (MEDIUM); the
    hide lock's position in section 5 and in D's row of section 14 made one (after the binding, team, club and rights
    rows, immediately before the first T5 insert), ascending by `(club, definition)`, with a mutation that sorts by the
    hash in one path;
  - **db:** the cross-act key check in the section 7.3 guards, under its own advisory lock, with a direct-SQL case;
    the hide lock's expression defined once in section 5 (built in SQL from `uuid`s, seed 0, not `runWrite`'s
    seed 34) and referenced by 7.3 and 7.5, with the READ COMMITTED note at 7.5; `nowait` on every explicit lock and
    the foreign keys' `SHARE ROW EXCLUSIVE` named as the accepted risk; the `operation_id` uniqueness note; a test that
    computes both md5 values from the files; J18's step 5 and lock order as a row of section 14;
  - **security:** `variable_hidden` a state refusal after a start's scope check, by the binding's club, with the
    cross-club deep-equal case and the section 3 sentence corrected; the platform workspace's identical 404 on the
    switch and a mutation reading the target through `ownerKeyOf`; the READ COMMITTED rule for raw writers of the hide
    table, in the runbook too; a club template no longer ends `unresolved` because of a hide; hide and show stated as
    desired-state acts for *Check result*; the acts withheld in the platform workspace, with a mutation;
  - **ux:** the next step after a copy is "activate, then move your teams" and *Move your teams* waits for the copy's
    active link, with its own `version_not_active` sentence (MEDIUM); the read-only sentence of `:193` matches every
    state; "existing charts" and a key hint without a promise; a team on another OptiMove version is listed apart on
    the move card, the gap named; the primary button for "used and copied" and for no data source, *Use* alone
    withheld without a data source or a linked team, *Copy* not offered where the server would refuse it.
- **★★ reviews of `61347a51`.** The *Rukovodilac*: GO, with R1–R12 as recommended and two LOW notes for 7i-B (a
  route-against-route test of starts in opposite order with a mutation removing the ascending order; the Serbian
  runbook on the sanitized 500 after a code rollback). The *Nezavisni revizor*: NO-GO with three findings, each
  checked by the executor and applied on the next head:
  - **M1 (MEDIUM):** the hide took its advisory lock before its rights rows, while a start takes it after them; with a
    club-admin revocation (`FOR UPDATE OF u, r` over the club's admins by `u.id`) that is a three-way deadlock. The
    *Nezavisni revizor* reproduced it 3 of 3 (0 of 3 with the rights first); the executor reproduced it the same way
    on a throwaway PostgreSQL 16 cluster (3 of 3 and 0 of 3). Fixed in section 5 (the hide and the show take the
    hide lock after the rights), section 6 (the three-way row), R5, the D row of section 14, and section 10 (the
    three-way race and the mutation that moves the lock back);
  - **L1 (LOW):** section 7.4 named `11095b44…`, which is the md5 of `metric_variable_requests_append_only`; the insert
    guard's body, unchanged since v36 through v51, has `ae5bf5e22620546a83cf955b8b1d9a9d` (recomputed by the
    executor from the file);
  - **L2 (LOW):** section 4.4's hide rule for template clones now applies per hint, after the hint's `valueType`,
    `unit` and `scopeLevel` filters, with a test and a mutation.
- **After the *Nezavisni revizor*'s review** the *Rukovodilac* withdrew the GO on `61347a51` (it had accepted the
  contract's "only shared locks, no cycle" for the hide) and ordered one new commit with M1, L1 and L2 and four more
  points: why the copy and the switch are free of a cycle with the same revocation; a route-against-route three-way
  test with its mutation; 7i-B confirming both md5 values on a disposable database; the per-hint rule. All are in
  this head (sections 5, 6, 7.6, 10, 4.4).
- **A narrow internal re-review of the M1 / L1 / L2 delta** (`db-reviewer`, `code-reviewer` and an adversarial
  lock-cycle hunt on a throwaway PostgreSQL 16, each MEDIUM or higher checked by an independent verifier, who
  reproduced it):
  - **MEDIUM, the switch:** it took its rights before the binding, a three-way deadlock with an Unbind and a club-admin
    revocation (3 of 3 under both role orders of the Unbind, 0 of 3 with the binding first; the executor 2 of 2 and
    0 of 2). The switch now follows D's order (section 5), with a §6 row and a race. A1 has the same order today
    (R13);
  - **MEDIUM, starts against the board or A1:** a start that waited for the hide lock after reading its collisions,
    while the board (or A1) ended a T5 row and then waited for the same lock, deadlocked (3 of 3; the executor 2 of 2).
    The hide lock now sits after the path's last row lock and before its state checks and its first write (section 5;
    0 of 3, and the executor 0 of 2, with the board taking it before its first write; checking after the lock alone
    was not enough, 2 of 2 with a gap before the insert). The J18 row of section 14 moves accordingly;
  - **LOW / NIT:** the revocation's headcount advisory lock named correctly in section 6; the dependency on J14's
    `u, r` stated, with the platform branch's `g, u` left to the lock-order pull request; the show in the three-way
    race; the guards take the hide lock before the key lock, and the request key is a plain read; the races driven by
    hold seams and lock waits, not by timing (a LOW after its verifier); the J18 gate's read a plain read; the line
    range of §4.4.
- **Accepted on 2026-11-02.** The owner: „J14 O1–O6 i J15 O1–O9 po preporuci, odobravam oba ugovora” (turn
  `95c006f2`, 20:16:10 UTC, relayed by the *Rukovodilac*'s order `011e7d13`). PR #334 merged as `93f36615` exactly from
  `aa0b2589`. The acceptance pull request records C132–C140, marks section 14's rows in their documents, and applies
  the three notes the reviewers left for it: the *Rukovodilac*'s on `aa0b2589` (`23505` only for a row that is merely
  locked, section 6), the *Nezavisni revizor*'s on `aa0b2589` (no new row lock after the hide lock, sections 5, 7.3 and
  10; its example cycle corrected after the acceptance pull request's internal review, which ran it 7 of 7 times without
  a wait) and R13's mandatory order (section 13). **What 7i-B's packet must carry** (the *Rukovodilac*'s two notes on
  `61347a51`):
  - **L1:** the route-against-route test of two S1s and of two A1s with listed starts on several bindings in opposite
    order, with no `40P01`, and the mutation that removes the service's ascending order of the hide locks, killed by it;
  - **L2:** the Serbian runbook says that after a code rollback, while hide rows exist, the old S1 on a hidden variable
    answers a sanitized 500: this is expected, and nothing is deleted.
