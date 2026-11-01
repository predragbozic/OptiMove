# J16 — phase 8: the Mappings screen, minimal (proposed ★ contract)

This is the contract of the minimal phase 8 of `docs/ai/metrics-core-plan.md` ("### Phase 8 ★: M3 Mappings tab, after 7b
and 7d"). It is the M3 row of section J of `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery
document*) for the "Mappings / activations" bullet of its section H, built over routes that already exist: M2 (J1), 7b
(J8), 7c's reads (J9), 7d (J10), 7e (J11) and 7f's `extractorAvailable` (J12). J14 and J15 stay reserved for 7h and 7i.

| | |
|---|---|
| Status | Proposed by the executor on 2026-11-01, on the *Rukovodilac*'s order of that day („Zatim sledeće po planu: minimalna faza 8 (ekran mapiranja) — ugovor ako ga nema, pa implementacija.”, its turn `ec301e87`, 10:48:15 UTC). No phase 8 contract existed. Revised after the internal reviews (section 14). **Accepted** by the *Rukovodilac* on 2026-11-01 (its turn `e0830de3`, 11:46:59 UTC: „ODLUKE R1–R19: sve PRIHVAĆENE kako si preporučio”), merged as PR #308. **Built** in the 8-B pull request (section 15). |
| Verified against commit | `08c6cbf` (merge of PR #307). Every file and line reference is to that commit. |
| Mark | ★ (the plan's mark for phase 8): frontend only. **No API change, no migration**, no backend file. |
| Owner decisions | None new is needed (section 12 lists what is the *Rukovodilac*'s). The owner's sentence „Stim sto ovo mora biti mnogo jednostavnijeg za korisnika” (owner turn `d9a0b800`, 2026-10-28) is an acceptance criterion of `ux-design-reviewer`. |
| Decides | The *Rukovodilac*: R1–R19 (section 12). |

---

## 0. In short

An administrator opens **Data configuration → Mappings** and, in one guided flow of three steps, connects a source
field to an OptiMove variable: **1. the field**, **2. the variable**, **3. the unit and the details**. The screen offers
only fields OptiMove can read and whose unit is confirmed, and only variables the field can really fill (the same unit,
or a conversion that exists); it puts the variables with the field's own unit first; and everywhere else it says in one
sentence what is missing and who can fix it. The flow saves a draft, which is submitted for review. A platform
administrator activates the version (and may switch it on for teams in the same step), replaces the active version, or
disables a version. A version is switched on and off for teams by their names; every confirmation of that names the
source, the mapping version, the team and its link to the GPEXE team. A version can be checked against a saved GPEXE
session: counts and ranges only, never an athlete; a session that cannot be imported as it stands is marked **Not
confirmed for import** there.

The simplicity is in the guidance; every server check stays (the plan, section 6, point 3).

## 1. What exists (verified at `08c6cbf`)

Every route below is under `/api/training-load/sources/metrics` behind `requireAuth`, sets `Cache-Control: no-store`,
answers every invisible or refused case with the identical `404 {"error":"notFound"}`, and passes on only `error`,
`message`, `current`, `limit`, `requestKey` and `clubIds` in a service refusal (`backend/src/routes/sourceMetrics.js:35-78`);
a POST without a JSON body is `415 jsonRequired`, a body that is not an object `400 invalid_body` (`:80-90`), and a pool
checkout timeout `409 try_again` with `Retry-After` (`:49-53`).

| Need | Route | Audience (code) | Notes |
|---|---|---|---|
| fields | `GET /fields[?sourceSystem=&apiFamily=]` | both admin bases (`adminContext`) | `{fields:[{id, sourceSystem, apiFamily, key, label, state, extractorAvailable, revisions:[…]}]}`; a revision carries `revisionNumber`, `state`, `parameterKind`, `supportsSession`, `supportsDrill`, `sourceUnit`, `expectedSourceUnit`, `sourceBoundUnit`, `boundOperator`, `evidenceStatus`, `unitVerifiedAt`, `meaningVerifiedAt`; more than 100 fields, or more than 20 revisions of one field, is `409 result_too_large` (`backend/src/sourceMetricMappingService.js:482-531`); `extractorAvailable` says only that the registry has an entry for the field's key, not that the chosen revision's shape and parameters fit it (`:526`; `backend/src/sourceMetricExtractors.js:280-289`) |
| variables as targets | `GET /targets` | both bases | the workspace's own owner scope only (system in the platform workspace, the club's own in a club workspace); `{targets:[{id, ownerScope, key, label, currentVersion:{id, versionNumber, unit, canonicalParameters}, scopes, versionReady, notReadyCode}]}`; more than 200 is `409 result_too_large` (`:551-599`) |
| conversions | `GET /conversions[?cursor=]` | both bases | active rows, pages of 100: `{conversions:[{id, fromUnit, toUnit, scale, scaleDivisor, offset, evidenceRef, seeded}], nextCursor}` (`backend/src/unitConversionService.js:64-101`); seeded: s→min, m/s→km/h, m→km, km/h→m/s (v34) |
| mappings | `GET /mappings[?cursor=]`, `GET /mappings/:id[?cursor=]` | both bases; system in the platform workspace, system and the club's in a club workspace (`readableOwnerKeys`, `backend/src/sourceMetricAccess.js:88-109`) | the list summary carries `sourceMetric:{id, key, apiFamily, label}`, `target`, `latestVersion`, `activeVersionId`, `versionCounts` (no `sourceSystem`: the source's name comes from the `/fields` read); the detail carries the versions (all statuses, 50 per page) but not those three (`sourceMetricMappingService.js:625-746`) |
| create | `POST /mappings` `{requestKey, sourceMetricId, metricDefinitionId}` | both bases, own owner scope | `409 mapping_exists` names `current.mappingId`; `target_scope_mismatch`, `source_metric_retired`, `target_not_active` (`:899-957`) |
| draft | `POST /mappings/:id/versions` `{requestKey, sourceRevisionId, appliesToSession, appliesToDrill, conversionNote?, sourceParameters?}` | the mapping's owner workspace | the server derives the factors, the operator and the canonical parameters; `conversionNote` is required only when the units differ; a zone's or threshold's `sourceParameters` are the field's bounds **in the field's bound unit**, and the server requires the variable's operator to equal the field's and the variable's bounds to equal them exactly through the bound unit's conversion (`:1090-1113`); the 409s include `unit_not_proven`, `parameters_not_proven`, `level_not_allowed`, `conversion_unavailable`, `bound_conversion_unavailable`, `parameters_not_equivalent`, `source_metric_unsupported` (`:959-1179`) |
| submit | `POST …/versions/:versionId/submit` `{requestKey}` | both bases, own owner scope | draft → needs_review; `409 version_not_draft` (`:1180-1224`) |
| activate / replace (A1) | `POST …/versions/:versionId/activate` `{requestKey, expectedActiveVersionId, reason?, activations?, activationReason?}` | a platform admin only, in the mapping owner's workspace (`mayTransitionMappings`, `sourceMetricAccess.js:33-40`) | a `reason` only with a replacement; `activations` 0–50 `{bindingId, requirement}` (also on a first activation); answer `{version, replaced, activationsEnded, activations}`; `409 revision_not_verified` unless the revision is active and verified (unit and meaning), `source_metric_target_taken` when another mapping of the owner has an active version of the same field and parameters (`:1245-1518`); one listed binding of an archived team or club makes the whole call the identical 404 (`backend/src/sourceMetricActivationSteps.js:93`, `:118`) |
| disable (A2) | `POST …/versions/:versionId/disable` `{requestKey, expectedStatus, reason}` | as A1 | ends every open activation of the version first, on every club's binding, archived clubs included (`lockOpenActivations`, `sourceMetricActivationSteps.js:211-220`); answer `{version, activationsEnded}` (`:1520-1567`) |
| activations (S1, S2, S3) | `POST /activations`, `POST /activations/:id/end`, `GET /activations?bindingId|versionId&state&cursor` | a platform admin in either workspace, or the club's admin in its club (`mayManageActivations`, `sourceMetricAccess.js:46-61`) | the scope table of J10 §2.1: the platform workspace starts only system mappings, on any club's binding; club X's workspace starts system or X's mappings, on X's bindings only; S3 pages of 100 and leaves out the rows of archived clubs (`backend/src/sourceMetricActivationService.js:270-288`); rows carry `teamId`, `bindingId`, `bindingState`, `requirement`, `basis` and an `endReason` code, never a team name, a reason or a user; S1 refuses the whole batch with the first failing binding named in `current.bindingId` (`binding_not_active`, `binding_source_mismatch`, `activation_exists` — an open activation of the same field with the same parameter fingerprint on that binding, from any mapping — or `variable_taken_on_binding` — an open activation of the same variable at an overlapping level; `sourceMetricActivationSteps.js:141-156`) |
| preview | `GET /mappings/:mappingId/versions/:versionId/preview?candidateId=` | as S1 (`mayManageActivations`) | `{preview:{candidateId, versionId, sourceUnit, targetUnit, minimumAthletes:3, levels:{session, drill}}}`; no status gate on the version or the candidate; the candidate's scope by the team's current club; the identical 404 before `snapshot_expired` (`backend/src/sourceMetricPreviewService.js:50-149`) |

Reads outside this router that the screen needs, unchanged:
- **The club's GPEXE teams (bindings):** `GET /api/training-load/sources/gpexe/connections?clubId=` (a platform admin in
  the platform workspace or a club workspace, or the club's admin in its workspace; `clubId` required) answers
  `{connections:[{id, hostLabel, accountLabel, state, boundTeams:[{bindingId, teamId, teamName, sourceTeamId, state:'active',
  boundAt, teamActive}], …}]}` with only active bindings, archived teams included with `teamActive: false`
  (`backend/src/sourceConnectionService.js:222-289`). The clubs and teams of the workspace come from `/api/organization`
  (`clubs`, `teams`, `isPlatformAdmin`; `backend/src/routes/organization.js:342-380`; active teams only), as Settings →
  Source connections already reads them (`frontend/source-connections-data.js:70-101`). That answer also carries athletes,
  users and join applications: the section keeps only the clubs' and teams' ids and names (`id`, `name`, `club_id`,
  `club_name`) in its state.
- **A team's saved GPEXE sessions:** `GET /api/training-load/gpexe/teams/:teamId/candidates` and
  `GET …/candidates/:candidateId` (`backend/src/routes/gpexeImport.js:143-157`; the audience is wider than the
  preview's), each with `label`, `sessionStartedAt`, `status`, `snapshot:{available, reason, expiresAt}` and
  `approvalBlockers`; `frontend/gpexe-import-data.js:843-847` (`notConfirmedForImport`) reads the blockers fail-closed.
- **Whether the user is a platform admin:** `currentUser.availableWorkspaces` holds a `platform` workspace only for an
  active platform admin (the pattern of `teamBasis`, `frontend/metric-variables-data.js:101-108`). A club workspace exists
  only for the user's own active `club_admin` role (`backend/src/workspace.js:46-58`). The mapping and version reads carry
  no `actions` hint (unlike `GET /variables`), so these facts decide which acts are offered; the server decides again on
  every request.

**Production today:** no source field is confirmed (CURRENT_STATE, phase 7), so a draft version answers
`unit_not_proven` and A1 `revision_not_verified`. The screen must read sensibly in that state (section 4.1).

## 2. Who sees what

| Caller and workspace | Sees | May |
|---|---|---|
| a platform admin, platform workspace | system mappings; any active club's GPEXE teams (club chosen first) | create, draft, submit; activate, replace, disable a system mapping's versions; switch a system version on or off for any club's team; check a system version against any club's saved session |
| a platform admin who also administers club X, club X's workspace | system and X's mappings; X's GPEXE teams | create, draft, submit X's mappings; activate, replace, disable X's versions; switch a system or X version on or off for X's teams; check either against X's sessions |
| club X's admin, club X's workspace | system and X's mappings (all versions of both, as the API answers them, R13); X's GPEXE teams | create, draft, submit X's mappings; switch an active system or X version on or off for X's teams; check either against X's sessions; **not** activate, replace or disable a version (phase 7h) |
| anyone else, a team workspace, an archived club | nothing: no card, no section | — |

So a club's own mapping can be activated today only by a platform admin who also administers that club (A1 runs in the
mapping owner's workspace, and a club workspace exists only for a club admin); until phase 7h every other club waits for
such a person (R12). The first import (M6) uses system variables and system mappings, which the platform workspace
activates.

The card and the section are offered from the active workspace exactly as Source fields is (`sourceFieldsContext()`:
the platform workspace, or a club workspace with a `scopeId`); a team workspace never gets them (C99). Every act is
offered only to the caller the table names; a hidden act is never the protection: the server answers the identical 404.

## 3. Where it lives

- A new Training Load section **`mappings`** in the Data configuration space, built like Source fields: its own state
  slice `state.trainingLoad.mappings` (created lazily, a `generation` counter), its own `frontend/metric-mappings-{data,view,actions}.js`,
  and the same hooks Source fields has in `frontend/training-load-actions.js` (section load, leave guard, before-unload,
  discard, workspace switch reset) and `frontend/app.js` (click, input, change, submit with a `data-metric-mappings-` prefix).
- A **Mappings** card on the start screen (`frontend/data-config-home-view.js`), for the same callers as the section, after
  Source fields. Its count comes from the section's own first `GET /mappings` page (an `ensure` read, as Source fields'
  card does): "N mappings", or "More than N mappings" when a further page exists; its rows are the first mappings'
  variable names. No read of its own. A `404` makes the card and the section read "Mappings are not available in this
  workspace." (as Source fields' `NOT_AVAILABLE`).
- The way back is "← Data configuration"; a new screen puts focus on its title, as the other screens do.
- One sentence, on the list and in the detail, tells the two acts apart: "Activating approves a version as the mapping's
  current one. Switching it on for a team lets that team's imports use it.".

## 4. The list and the guided flow

### 4.1 The list
- One sentence of introduction: "A mapping tells OptiMove which source field fills which of your variables." In a club
  workspace a second sentence, as Variables does: "System mappings come from a platform administrator; you switch them on
  for your teams.".
- Rows: the variable's label, "from" the field's label and source (the source's name from the `/fields` read), a
  **System** or club badge (the club colour of the visual proposal), and the state in words from `activeVersionId`,
  `latestVersion` and `versionCounts`: "Active: version 2", "Active: version 2 · version 3 waiting for review",
  "Draft", "Waiting for review", "Disabled", or "No version yet"; under Technical details the ids, the field key and the
  data family.
- One primary action: **New mapping**. "Load more" for a further page.
- Empty state: "No mappings yet. Start with New mapping." When no field is ready (section 4.2), the empty state says so
  and names the next step: for a platform admin in the platform workspace "Confirm a field's unit first" with a link to
  Source fields; for everyone else "A platform administrator confirms a field's unit in the platform workspace first.".

### 4.2 Step 1 — the field
- A step indicator ("Step 1 of 3"); **Back** keeps the choices made; changing the field clears the variable and the
  details.
- `GET /fields`, grouped by source as Source fields groups them. A `409 result_too_large` (more than 100 fields, or more
  than 20 revisions of one field) reads
  "There are too many source fields to list here. Ask a platform administrator." (the same for more than 200 variables
  in step 2).
- A field is **choosable** when it is active, `extractorAvailable` is true, and its chosen revision (R3: the active
  revision, else the newest draft revision) has a `sourceUnit` and, for a zone or an event threshold, a `sourceBoundUnit`
  and a `boundOperator` (the conditions of `unit_not_proven` / `parameters_not_proven`).
- A field that is not choosable stays in the list with one reason in plain words: "OptiMove cannot read this field yet."
  (no extractor), "Its unit is not confirmed yet." (with the link or the sentence of 4.1), or "This field is retired.".
- `extractorAvailable` does not prove that the chosen revision's value shape and parameters fit OptiMove's reader; the
  server says so at **Save draft** (`source_metric_unsupported`, `parameters_unsupported`, section 8). The screen does not
  copy the registry's rules.
- A choosable field whose revision is not yet active and verified (meaning not confirmed) carries: "You can save a draft
  now; it can be activated only once the field's meaning is confirmed.".
- The field's unit, its levels (session, drill) and, for a zone or a threshold, its operator are shown with it.

### 4.3 Step 2 — the variable
- `GET /targets` (the workspace's own variables; a club workspace never offers a system variable, the server would
  answer `target_scope_mismatch`).
- A variable is **choosable** only when all of these hold, and otherwise stays in the list, not choosable, with one
  reason:
  - `versionReady` is true (else the words the Variables screen already uses for `notReadyCode`);
  - it allows a level the field supports (session ↔ `session`, drill ↔ `component`): "It has no level this field
    supports.";
  - its unit is the field's unit, or exactly one active conversion from the field's unit to it exists: "There is no
    conversion from <unit> to <unit> yet.";
  - for a zone or a threshold: its condition is of the same kind, its operator is the field's operator, and its bound
    unit is the field's bound unit or reachable by an active conversion: "Its condition does not match this field's.";
    and its bound has an exact value in the field's bound unit (section 4.4): "Its bound has no exact value in this
    field's unit.".
  - For a platform admin the screen adds once: "Unit conversions cannot be added on this screen yet." (R1).
- **The suggestion:** the choosable variables with the field's own unit come first with the badge **Same unit**, then
  those reached by a conversion with **Converted from <unit>**. Nothing is preselected (R4).
- If a mapping of this field to this variable exists (in the loaded list, or answered as `mapping_exists`): "A mapping of
  this field to this variable exists; this becomes its version N+1." and the flow goes on with that mapping.
- If another mapping of the same owner already has an active version of this field: "This field already fills
  <variable>. Only one of them can be active at a time." (the cause of `source_metric_target_taken`).
- A sentence with a link: "Missing a variable? Create it in Variables.".

### 4.4 Step 3 — the unit and the details
- **The unit:** "Same unit: no conversion." when equal; otherwise the active conversion in words ("1 s = 1/60 min"), with
  its reverse pair when one exists and a sentence when the two disagree (7c R4).
- **A conversion note** (required when the units differ; one line of 1–500 characters) with an example ("For example:
  GPEXE gives seconds; the variable is in minutes.") and the sentence "Do not enter athlete names, ids, dates of birth or
  measured values.". Its label says that every administrator who can read this mapping sees the note (for a system
  mapping: every club administrator, R13).
- **Levels:** Session and Drill as checkboxes, only those both the field and the variable allow, at least one; when
  only one is possible it is shown as a fact, not a checkbox.
- **A zone or a threshold:** the operator and the bound unit shown read-only from the field; the inputs ask for **the
  bound GPEXE uses for this field, in <the field's bound unit>** (the lower bound, and the upper bound for "between"; or
  the threshold value and the duration in seconds). Beside each input the screen shows the value the variable's bound
  gives in the field's unit, computed exactly from the conversion ("The variable's 25.2 km/h is 7 m/s."), or says that
  it has no exact value in that unit (then no typed value can match, and the variable is not choosable for this field).
  Decimals are typed text, checked against the server's pattern `^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$` before
  sending; the server decides equivalence (`parameters_not_equivalent`). Whether the screen also offers **Use this value**
  is R17.
- **Review:** one summary card names the field, the variable, the unit or the conversion, the levels and the bounds; one
  primary action **Save draft**.

### 4.5 Saving
- **Save draft** sends `POST /mappings` (unless the mapping exists), then `POST /mappings/:id/versions`: two writes, each
  with its own request key, never two at once; the version is sent only after the mapping write settled.
- A version refused after the mapping was created leaves the mapping without a version (C27 allows a mapping before the
  unit is proven): the detail opens with "The mapping is saved, but its draft was not: <the refusal's sentence>. Use New
  version to try again." (R11).
- After a saved draft the detail opens with **Submit for review** as its primary action and **Check with a saved session**
  as a secondary one.

## 5. The mapping's detail

- Header: the variable's label, the field's label and source, the owner badge; one primary action for the whole
  mapping, the first that applies of: Activate (or Replace) a version waiting for review, Submit a draft, Switch on for
  teams an active version that no team uses; every other act is a secondary button.
- **New version** (both bases, the mapping owner's workspace): opens step 3 with the field and the variable fixed and the
  details filled from the latest version.
- Versions, newest first (pages of 50): the number; the status in words (**Draft**, **Waiting for review**, **Active**,
  **Disabled**); the unit and the conversion in words; the levels; the bounds (OD4, R8); the conversion note as escaped
  text; the dates (created, submitted, activated, disabled). A version disabled by the server's pinned step shows only
  "Disabled since <date>", never why (C63, J8 Q7). Ids, the fingerprint and the factors as exact decimals under
  Technical details.
- Acts per version, each offered only to the caller of section 2 (the primary one in bold):
  - **Draft:** **Submit for review** (a short confirmation naming the variable, the field and the version); Check with a
    saved session; Disable (a platform admin, with a reason).
  - **Waiting for review**, a platform admin in the mapping owner's workspace:
    - **Activate**, offered only when the reads show the field's revision active and verified and the variable's
      current version still the one the draft was made against; otherwise the sentence of what is missing ("The field's
      meaning must be confirmed first." / "The variable has a newer version: make a new version.").
    - With Activate, an optional **Switch on for teams now** (A1's `activations` on a first activation, R15): the team
      choice of section 6, in the same review card.
    - When another version is active, the act is **Replace version N** (section 5.1).
    - Disable, with a reason.
  - **Waiting for review**, anyone else: on the club's own mapping the club's admin reads "Ask a platform administrator
    who also administers <club> to activate it in this workspace." (R12); on a system mapping a club's admin reads "A
    platform administrator activates system mappings in the platform workspace.", and a platform admin in a club
    workspace reads "Activate it in the platform workspace.".
  - **Active:** with no team switched on, **Switch on for teams** with "Active, but no team uses it yet."; otherwise the
    teams of section 6; Disable (a platform admin, section 5.1).
  - **Disabled:** read-only.
- `expectedActiveVersionId` and `expectedStatus` come from the version the screen shows; a `409 active_version_changed` or
  `version_status_changed` closes the form and reads the mapping again.

### 5.1 The teams a replacement or a disable switches off (J10 R8)
A1's replacement and A2 end every open activation of the version without a precondition, so this list is the only
guard and must be complete:
- It is read **when the review card opens**, not earlier: every page of `GET /activations?versionId=<id>&state=open`,
  at most 10 pages (1,000 rows); beyond that the card says "More than 1,000 teams use this version; all of them are
  switched off.".
- Each row is named by the team's name from `/api/organization` (`teams`, by `teamId`; it lists active teams only) and
  its link from the connections read of every club present in the list; in the platform workspace the rows are grouped
  by club. A row that cannot be named reads "a team that is no longer listed" (never an id); a row whose `bindingState`
  is `ended` reads "<team> — no longer linked to GPEXE".
- When the primary button is pressed, the count of open rows is read again; if it changed, the card shows the new list
  and asks again.
- The card always says: "Teams of archived clubs that use this version are switched off too; they are not listed.".
- After the answer, the screen shows `activationsEnded` and, when it is higher than the number listed, "N teams were
  switched off; the list showed fewer.".
- **Replace version N** asks for one reason (sent as `reason`, and as `activationReason` when teams are kept, R16) and
  offers **Keep these teams on the new version**, on by default (R7), at most 50, for the listed rows whose binding is
  active, whose team is in the `/api/organization` teams and whose link was read; every other row (an ended link, a team
  not listed, a link not read, more than 50) is named with "is switched off and not kept". **Each kept team keeps its own
  current requirement**, shown per row and changeable; there is no single choice for all on a replacement (R19). With
  kept teams the review card is the one of section 6 (source, version, each team, its link and requirement), with one
  primary button "Replace and keep N teams". The replacement is one transaction: a refusal of a kept team
  (`activation_exists`, `variable_taken_on_binding`, `binding_not_active`) changes nothing, names the team, and offers
  "Replace without keeping <team>".

## 6. Teams (activations)

Shown on the active version, for the callers of section 2.
- **The list:** every page of `GET /activations?versionId=<id>&state=open` (**Show switched off** → `state=all`), each row
  named as in 5.1: the team's name, "linked to GPEXE team <sourceTeamId>", **Required** or **Optional**, since <date>;
  a switched-off row says when and why in words from `endReason` ("Switched off by an administrator", "The version was
  replaced", "The version was disabled"). Never who; `basis` is not shown.
- **Switch on for teams** (`POST /activations`), in an in-page review card (never a native dialog):
  1. In the platform workspace the club is chosen first (from `/api/organization`); in a club workspace it is the club.
  2. The club's GPEXE teams are listed by connection (its account label and `hostLabel`), each team with a checkbox. A
     team is not choosable while its check below is loading ("Checking…"); if that read fails it is choosable with
     "Could not be checked; the server decides.". A team is not choosable, with its reason, when it is archived ("This
     team is archived."), when this version is already on for it ("Already on."), when it already gets this field with
     the same bounds from another version ("Already gets this field."), or when it already has this variable at a level
     this version also covers ("Already has this variable at this level."). These come from
     `GET /activations?bindingId=<id>&state=open` for the listed teams; a row of another version is compared by reading
     that version (`GET /mappings/:mappingId`, its version pages: the field, `parameterFingerprint` and levels), and a
     row that cannot be resolved leaves the team choosable with "Could not be checked; the server decides.". That read
     lists only the mappings this workspace can read, so the server's refusal of step 6 remains the last word. **Every team of this connection** checks the connection's
     choosable teams explicitly; above 50 it checks the first 50 and says so (one send takes at most 50); the sentence
     beside it says it never includes a team linked later.
  3. **Required** or **Optional**: one choice for all checked teams, with no default (R14), its meaning beside it:
     "When imports use this mapping — Required: if an athlete the import admits has no value, the whole session is not
     imported. Optional: athletes without a value get no value for this variable; this alone does not stop the session
     from being imported." A single team's requirement can be changed in the card.
  4. A reason (required, with an example and the free-text sentence).
  5. The review card (the acceptance of phase 8) names **the source** (the connection's `hostLabel`, e.g. "GPEXE
     server3"), **the mapping version** ("<variable> from <field>, version N"), and for each **team** its **link**
     ("<team> — linked to GPEXE team <sourceTeamId>") and its requirement; one primary button "Switch on for N teams".
  6. A refusal of the batch names its team (from `current.bindingId`, never the id), unticks it and offers "Switch on for
     the other N".
  7. After success: "Switched on. Imports do not use mappings yet; nothing changes in imports until they do." (R18).
- **Switch off** a team (`POST /activations/:id/end`, `expectedState:'open'`): a reason, and a short confirmation naming
  the team, its link and the version; offered also for a team no longer linked or archived (a remedy).

## 7. Checking a version against a saved session (the preview)

Offered on a draft, a version waiting for review and the active version (not on a disabled one), for the callers of
section 2.
1. Choose a team (the same club and team list as section 6, one team).
2. Choose one of its saved sessions (`GET /api/training-load/gpexe/teams/:teamId/candidates`): its label (source text,
   escaped, shown to this audience in Imports already) and date. A session whose saved data is gone
   (`snapshot.available` false) is shown, not choosable: "Find this session again in Imports.". **A session is marked
   when `notConfirmedForImport(c)` (`frontend/gpexe-import-data.js:843-847`, fail-closed: no blockers array counts) is
   true or its `status` is neither `pending` nor `blocked`**: the server adds the word `not_confirmed_for_import` only to
   a pending or blocked session and to one withdrawn by a check, while a session replaced by newer data carries
   `superseded_by_newer_data` instead (`backend/src/gpexeImportService.js:1301-1314`). The mark is the badge **Not
   confirmed for import** — the Imports screen's — or **Already imported** for an imported session, with the sentence
   "This session cannot be imported as it stands. Its values are shown here only to check the mapping." (R5: the 7e-B
   obligation, met on the safe side).
3. When the answer arrives the screen reads the team's session list again (`GET …/candidates?includeSuperseded=true`,
   never the single-session route, which carries athlete names), finds the session by its id, and **repeats the badge
   and the sentence above the numbers** whenever the rule of step 2 applies then; a session no longer in the list
   counts as not confirmed for import. The numbers are shown only once that re-read settles; if it fails, the list's mark stays and
   "Could not be checked again." is added.
4. The answer, per level: "N athletes have a value", and the range in the field's unit and in the variable's unit; with
   fewer than 3 athletes: "Fewer than 3 athletes have a value, so no range is shown."; 0 is an answer, not an error. The
   refusals in words: `snapshot_expired` → "The saved session is no longer available. Find it again in Imports.";
   `candidate_too_large`, `candidate_source_mismatch`, `source_metric_unsupported`, `parameters_unsupported`,
   `candidate_not_importable` → one sentence each, the code under Technical details; a `404` → "This session is not
   available for this mapping in this workspace." (an archived team or club, a lost right, or a mapping no longer
   readable).
5. Nothing is saved; no athlete, value list or bound of the team is shown.

## 8. Writes

Every write follows the pattern of Source fields and Variables (`frontend/source-fields-actions.js`,
`frontend/metric-variables-actions.js`):
- a fresh `crypto.randomUUID()` request key per attempt; a 90 s client bound; one write at a time per screen (busy or
  not confirmed locks the form);
- a lost answer (no answer, `503 outcome_unknown`, a 5xx other than `internal_error`) shows **Result not confirmed** with
  **Check result**, which sends the same body with the same key, never by itself, and only in the workspace where it was
  sent; a check settles only on the codes the server answers after reading its request record or for the body itself (a
  per-route list in the code);
- `request_key_reused` → a new key; `try_again` → "The server was busy. Nothing was saved. Try again.";
- a `404` on a write never says that nothing was saved (it can come after a confirmed COMMIT); the sentence names what to
  open to see: "It is not available in this workspace now. Whether it was saved is not known: open the mapping again to
  see." (create, draft, submit, activate, replace, disable) or "… open the version's teams again to see." (switch on,
  switch off); the form closes and the item is read again;
- a `readError` answer is shown as saved, with "could not be read back", and the item is read again;
- a short single act (submit, switch off one team) asks a `window.confirm` naming what it does; an act that names
  several teams or a replacement uses the in-page review card of sections 5.1 and 6; a declined one sends nothing.
- Every stated refusal has its sentence; the code stands only under Technical details; a refusal that shows the item
  changed closes the form and reads it again:

| Act | Code | Sentence |
|---|---|---|
| create | `mapping_exists` | (none: the flow goes on with that mapping, 4.3) |
| create | `target_scope_mismatch`, `target_not_active` | "This variable cannot be used here now." (read again) |
| create | `source_metric_retired` | "This field is retired." (read again) |
| draft | `unit_not_proven`, `parameters_not_proven` | "The field's unit (or its bound) is not confirmed yet." |
| draft | `source_metric_unsupported`, `parameters_unsupported` | "OptiMove cannot read this field with these settings." |
| draft | `level_not_allowed` | "The field or the variable does not allow this level." |
| draft | `conversion_unavailable`, `bound_conversion_unavailable`, `conversion_not_normal` | "There is no usable conversion between these units now." |
| draft | `parameters_not_equivalent`, `condition_description_unsupported` | "The bound does not match the variable's bound." |
| draft | `canonical_not_numeric`, `canonical_unit_missing`, `canonical_unit_not_a_token`, `target_not_active` | "This variable cannot be the target of a mapping now." (read again) |
| draft | `revision_not_usable` | "The field changed; choose it again." (read again) |
| submit | `version_not_draft`, `revision_not_usable` | "This version changed meanwhile." (read again) |
| activate, replace | `version_not_submitted`, `active_version_changed` | "This mapping changed meanwhile." (read again) |
| activate, replace | `revision_not_verified` | "The field's unit and meaning must be confirmed first." |
| activate, replace | `canonical_version_changed` | "The variable has a newer version: make a new version." |
| activate, replace | `target_not_active`, `conversion_unavailable`, `bound_conversion_unavailable`, `level_not_allowed`, `source_metric_unsupported`, `parameters_unsupported` | "This version cannot be activated now: <the draft's sentence for the code>." |
| activate, replace | `source_metric_target_taken` | "This field already fills <variable>. Only one of them can be active at a time." |
| activate, replace, switch on | `binding_not_active`, `binding_source_mismatch`, `activation_exists`, `variable_taken_on_binding` | the team named, as in 5.1 and 6 |
| disable | `version_status_changed` | "This version changed meanwhile." (read again) |
| switch on | `version_not_active`, `field_retired` | "This version is no longer active." (read again) |
| switch off | `activation_not_open` | "This team was already switched off." (read again) |
| any | `invalid_body`, `invalid_query` | "The screen sent something the server does not accept. Nothing was saved." |
| any | another 4xx | "It was not saved: the server refused it." (read again; the code under Technical details) |


## 9. Language, safety, mobile

- One sentence of introduction per screen; one primary action per screen, by state; empty states name the next step;
  no abbreviations (no T2b, A1, S1, C97, J10 in the text); keys, codes and ids only under Technical details.
- Every server or user text is escaped (`escapeHtml` / `escapeAttr`); units and evidence references in `<code>` as
  escaped text, never a link; ids only in `data-` attributes and under Technical details. A name written by another
  administrator or a source (a team's, a connection's, a session's, a variable's or a field's) is, in a `window.confirm`
  and in a review card alike, stripped of control and format characters (bidi included), its whitespace collapsed, cut
  to 80 characters and quoted, before it is escaped.
- No athlete name, id, date of birth or value is produced by this screen; a session's label is the source's own text,
  shown to this audience in Imports already. The screen never calls the single-session route (it returns athlete
  names). Every free-text field (conversion note, every reason) carries an example
  and "Do not enter athlete names, ids, dates of birth or measured values.".
- 44 px targets, 16 px inputs, checked at 360, 375 and 390 px; at 760 px and below forms and actions go full width; no
  horizontal overflow; a team row keeps its checkbox, name and requirement readable at 360 px.
- An older answer never overwrites a newer one (the `generation` counter and the open item's id); a workspace switch
  resets the section.

## 10. Tests and evidence

- A JSDOM suite over the real handlers and markup with `frontend/tests/support/fetch-mock.mjs`, whose fakes keep the
  server's contracts (the same query filters and pages, the request-key replay, the scope rules of J10 §2.1). It covers:
  - who sees the card and the section in each workspace, and the neutral `404` state;
  - every row of the refusal table of section 8, and the fallback for an unknown 4xx;
  - the field and variable choosability with every reason (the no-exact-bound reason included), the suggestion order,
    `mapping_exists`, the `source_metric_target_taken` notice, the bound value shown in the field's unit,
    `result_too_large` on `/fields` and `/targets`;
  - the two-write save with a lost answer on each write (no answer, `503 outcome_unknown`, an uncoded 502: the check sends
    a body equal to the first), and the refused-draft sentence;
  - the mapping's one primary action by state, and the waiting-version sentences (the club's own, a system one, a
    platform admin in a club workspace);
  - submit; New version; activate with and without **Switch on for teams now**; replace with **Keep these teams**
    (kept with each team's own requirement, not kept, more than 50, a kept team refused and "Replace without keeping");
    disable;
  - the J10 R8 list: several pages, an unnamed row, an ended link, rows of two clubs with the same team name, the
    archived-club sentence, the count changed at the primary button, `activationsEnded` above the listed count;
  - switch on: not-choosable teams (archived, already on, already gets this field, already has this variable, a check
    loading or failed), **Every team of this connection** below and above 50, the one requirement choice, the review
    card's text (source, version, team, link, requirement), a batch refusal for each of `binding_not_active`,
    `binding_source_mismatch`, `activation_exists` and `variable_taken_on_binding` that names the team and offers the
    others; the after-success sentence; switch off;
  - the preview: the badge with `approvalBlockers` absent, holding the word, a session superseded by newer data
    (`superseded_by_newer_data`, no `not_confirmed_for_import`), an imported one, after the re-read, a session missing
    from the re-read list, and a failed re-read; numbers only after the re-read; no call to the single-session route and no
    athlete name in state or markup; the fewer-than-3 sentence; every refusal's sentence;
  - a hostile team, connection, session and variable name (control and bidi characters, markup) in a card and in a
    confirm; after the organization read, the section's state holds no `athletes`, `users` or `joinApplications`;
  - switch on: a team whose open row is of the same field with another fingerprint stays choosable; a row of the same
    variable at the drill level only does not block a session-only version;
  - the leave guards and the workspace switch.
- An integration run against the real routes on a disposable database (as PR #218 did), with a revision confirmed in the
  fixture: create → draft → submit → activate with a team → preview → switch off → switch on → replace keeping the team
  → disable.
- Browser QA at 1280, 360, 375 and 390 px.
- `npm --prefix frontend run build`.

## 11. Reviewers and gates

- `code-reviewer`, `mobile-qa` and `ux-design-reviewer` (the owner's sentence as an acceptance criterion), and a narrow
  `security-reviewer` pass on the rendering of server and source text, the free-text fields and the J10 R8 list (R10).
- The *Rukovodilac*'s GO is the external review (★). No migration: the standing merge order; the merge is the deploy;
  the smoke afterwards (`/api/health` three times; the routes the screen calls answer 401 without a login).
- No GPEXE request, no production write and no import switch change by the executor.

## 12. Decisions for the *Rukovodilac*

- **R1. What "minimal" holds.** In: sections 3–8. Out (later phase 8 work, or their own phases): maintaining unit
  conversions (7c Q3 placed its screen in phase 8's third step; here step 3 only reads them, and a variable without a
  conversion is not choosable), the history of retired conversions (7c R6), the revision lifecycle (L1–L5), the history
  and audit view, ending a held source instance (7g), 7h and 7i. Recommendation: as written; the seeded conversions cover
  the first import's fields.
- **R2. Placement:** a section of its own, like Source fields, with a start-screen card. Recommendation: yes.
- **R3. The revision of step 1:** the field's active revision, else its newest draft revision. Recommendation: yes.
- **R4. The suggestion** orders and badges, never preselects. Recommendation: yes.
- **R5. Not confirmed for import** marks every session the import would not take as it stands: the generic
  `not_confirmed_for_import` word through the fail-closed helper, or a status other than pending and blocked; wider than
  `not_observed`; no API change. Recommendation: yes.
- **R6. Naming the link** as "linked to GPEXE team <sourceTeamId>" outside Technical details (the binding's id stays under
  it). Recommendation: yes; the GPEXE team number is already shown in Settings.
- **R7. Keep these teams** on a replacement, on by default, for the rows that can be kept. Recommendation: yes.
- **R8. OD4:** a version's own bounds are shown to everyone who may read the mapping; no team threshold is read or shown.
  Recommendation: yes.
- **R9. One pull request or two** (8-B1: list, flow, detail, submit, New version, activate, replace, disable; 8-B2: teams
  and the preview). Recommendation: one, since the first import needs both.
- **R10. A narrow `security-reviewer` pass.** Recommendation: yes.
- **R11. A mapping without a version** after a refused draft stays (C27), with the sentence of 4.5. Recommendation: yes.
- **R12. A club's own mapping** can be activated only by a platform admin who also administers the club, until phase 7h.
  Options: (a) accept until 7h — the first import uses system mappings; (b) bring 7h forward (a migration, after phase
  9 in today's order). Recommendation: (a).
- **R13. A club's admin reads every version of a system mapping**, drafts and conversion notes included, as the API
  answers today. Options: (a) accept, with the conversion note's label saying so; (b) show a club's admin only the
  active version of a system mapping (a client filter, not a protection: the API would still answer the rest).
  Recommendation: (a).
- **R14. One requirement for all checked teams**, chosen explicitly (no default, C23), changeable per team.
  Recommendation: yes.
- **R15. Activate and switch on in one act** (A1's `activations` on a first activation). Recommendation: yes, optional.
- **R16. One reason on a replacement** sent as both `reason` and `activationReason`. Recommendation: yes.
- **R17. Use this value** beside a bound: fills the input with the value computed from the variable. The typed bound
  states what GPEXE uses for the field; the import refuses a team whose GPEXE setting differs (discovery section F), so
  the check stays, but the admin's own statement would become a click. Recommendation: no button; show the value
  beside the input.
- **R18. The after-success sentence** of a switch on ("Imports do not use mappings yet; nothing changes in imports until
  they do."). Recommendation: yes, removed once phase 9 is merged.
- **R19. A kept team keeps its own requirement** on a replacement: the team's earlier explicit choice is carried over,
  shown and changeable; C23's "no default" is read as "never a requirement nobody chose". Recommendation: yes.

## 13. Not in this contract

Any backend or API change; a migration; the import switch; the importer (phase 9); a GPEXE request; a stored preview;
showing a disable reason to a club (a separate owner decision); several candidates at once; maintaining unit
conversions.

## 14. Review record

- **Internal round on the first draft (2026-11-01):**
  - `ux-design-reviewer`: READY WITH NON-BLOCKING NOTES, nine MEDIUM and two LOW, all applied: variables that cannot
    work are not choosable, with their reason (4.3); refusals that would come later are named while choosing (4.2, 4.3,
    6); in-page review cards for the acts that name teams (5.1, 6, 8); the requirement's meaning beside its choice and in
    the conditional tense (6); the primary action by state, the list's states, the two acts told apart (3, 4.1, 5); the
    club's path with a next step (5); **New version** (5); the bound in the field's unit (4.4); unnamed and ended rows
    (5.1); the wording (Not confirmed for import, Disabled, the host label, "More than N"); the step indicator, Back, one
    reason on a replacement, the preview not on a disabled version, the refused-draft sentence (4.2, 4.5, 5.1, 7).
  - `security-reviewer`: NOT READY, one HIGH and six MEDIUM/LOW, all applied: the J10 R8 list read completely and late,
    named across clubs, the archived-club sentence and `activationsEnded` (5.1, HIGH); archived teams not choosable and
    never kept (5.1, 6); the fail-closed badge repeated on the answer after a re-read (7); the Required sentence (6);
    the club-mapping path and R12; sanitised names and review cards (8, 9); R13; the LOWs (`basis` not shown, the
    preview's 404 causes, the per-write 404 sentence and the workspace of a check, S1's named refusal, the session label).
  - `code-reviewer`: its first run ended before a report.
- **Round 2 on revision 2:** `ux-design-reviewer` (narrow) READY WITH NON-BLOCKING NOTES, every round-1 finding closed;
  one new MEDIUM (a kept team's requirement on a replacement: each keeps its own, R19) and four LOWs (same-named teams of
  two clubs, the system-version sentence, three wordings, the order of primary acts, the no-exact-bound reason, more than
  50 teams and a loading check, the tests), all applied. `security-reviewer` (narrow) READY WITH NON-BLOCKING NOTES, the
  HIGH and every MEDIUM closed; one new MEDIUM (the session's re-read must use the list route, never the single-session
  route, which carries athlete names) and four LOWs (the re-read's failure, the system-version sentence, the kept rows'
  names and links and the atomic refusal, the sanitiser in review cards and for variable labels, `result_too_large`'s
  place, S1 codes in the tests, the first 50, a re-read at the primary button, the Required sentence's wording, the J16
  pointer's wording), all applied. `code-reviewer`'s second run also ended before a report.
- **`code-reviewer` on revision 3** (run on its own): READY WITH NON-BLOCKING NOTES, every claim it checked true at
  `08c6cbf`; two MEDIUM, both applied: the preview's mark did not cover a session replaced by newer data (it carries
  `superseded_by_newer_data`, not `not_confirmed_for_import`), now marked by status as well (7, R5); `extractorAvailable`
  does not prove the chosen revision readable, so `source_metric_unsupported` and `parameters_unsupported` at Save draft
  get a sentence (4.2, 8). Four LOWs applied: the exact meanings of `activation_exists` and `variable_taken_on_binding`
  and how the screen resolves them (1, 6); a sentence for every refusal of every act and a fallback (8); the router's
  415, 400 and pool timeout and the 20-revision cap (1, 4.2); only clubs' and teams' names kept from the organization
  read (1).

## 15. As built (8-B)

The 8-B pull request, on the *Rukovodilac*'s GO of PR #308 (turn `e0830de3`, 11:46:59 UTC: „ODLUKE R1–R19: sve
PRIHVAĆENE kako si preporučio … Posle merge-a kreni sa 8-B (jedan PR); deploy bez migracije radim ja.”). R1–R19 as
recommended in section 12. Verified against commit `f8ebb28` (merge of PR #308; the base of the 8-B pull request).
Frontend only: no backend file, no API change, no migration.

- **Files.** `frontend/metric-mappings-data.js` (the routes' reads and writes, the choosability rules, the exact
  decimals, the sentences), `frontend/metric-mappings-actions.js` (the handlers, the reads, the write pattern, the guards),
  `frontend/metric-mappings-view.js` (the markup), their wiring in `training-load-view.js`, `training-load-actions.js`,
  `app.js`, `data-config-home-view.js` and `metric-variables-actions.js` (the start screen's card count), a block of
  `styles.css`, and the suite `frontend/tests/metric-mappings.actions.test.mjs`; the start screen's suites
  (`data-config-home.actions.test.mjs`, `metric-classification.actions.test.mjs`) count the fifth card.
- **Tightened while building, within the contract:**
  - **A variable's condition must be the field's kind** (4.3): a field without a bound is never offered a variable with a
    zone or event condition, and a zone field never a variable without one — the same "can fill" rule, applied to the
    `none` kind too.
  - **Names are cleaned wherever they are shown**, not only in review cards and confirms (9): team, club and saved-session
    names in rows, pickers, labels and the club's badge pass through the same cleaner (control and format characters,
    bidi included, removed; at most 80 characters) before they are escaped, so a bidi control in a team name can never
    reorder the "linked to GPEXE team N" beside it. Found in the integration run (a team named with U+202E).
  - **The clubs read is said when it fails** (6, 7): the club picker of a switch on, of an activation with teams and of the
    preview shows "The clubs and teams could not be loaded." with **Try again**, and "Loading the clubs..." while it runs,
    instead of an empty picker. Found in the integration run.
  - **After a change, the mapping's acts wait for its re-read** (5, 8): while the mapping is read again after a write, every
    act of its versions, **New version** and **Switch off** are disabled and a click starts nothing, so no act starts from
    the state before the change. Found in the integration run.
- **Internal review round on head `41e35bc`** (`code-reviewer` NOT READY, one HIGH; `ux-design-reviewer`,
  `security-reviewer` (R10) and `mobile-qa` READY WITH NON-BLOCKING NOTES). Applied in the next head:
  - **HIGH — a refused write could not be sent again** (8): after a refusal with a stated reason (`try_again`, a state
    code) the form kept the write and every send ignored it. A settled refusal now never holds the screen: its sentence
    stays until the next act, and the same form sends again with a new key (nothing was saved). Only a write in flight
    or not confirmed holds it.
  - **The settle list of a Check result is per route** (8): only the refusals a route answers after reading its request
    record, or for the body itself, settle a check; any other code leaves the result not confirmed.
  - **A refusal the screen has no sentence for reads the mapping again** (8, last row) and keeps its sentence and code.
  - **The R8 list is compared by identity at the button** (5.1): the same count with one team swapped for another is
    caught, never only the number of rows.
  - **A late answer for another team never replaces the chosen team's saved sessions** (7, 9).
  - **"N teams were switched off; the list showed fewer."** as section 5.1 words it.
  - **`source_metric_target_taken` names the variable** the field already fills when the mappings list shows it, and
    only a mapping of the same owner counts (the server's rule is per owner), in the flow's notice too (4.3, 8).
  - **UX:** an old outcome's sentence is cleared when a new act opens or a write starts; the levels both the field and
    the variable allow start ticked (4.4 asks for at least one; the review card names them); a lone club is chosen in
    the platform workspace; the replace panel puts **Keep these teams** first, says "These N teams use version M.
    Replacing it switches them off version M and on for version N in the same step:" with "on version N as
    [requirement]" per team, and names what changes from the active version (unit, levels, bound, note); the activate
    panel has its own sentence; the platform administrator is told "You can activate it now." after Submit and on the
    step-4 card; the preview reads "a–b s in GPEXE = c–d min in “variable”"; in step 1 the fields that can be chosen come
    first, with the Source fields link for the platform. The **clicks to the first switch on of a system mapping fall
    from 16 to 13** (measured again in the integration run). Not applied (a contract change, for the *Rukovodilac*):
    "Save and submit for review" in one act, which would save two more.
  - **Security (R10):** variable and field labels and the conversion note are cleaned wherever shown; the clubs read
    in flight is awaited by a second caller (the names of the R8 list); the version number in a button is escaped.
  - **Mobile:** field errors and hints in `.search-field` keep their own style; an unavailable choice's reason is not
    faded; the step numbers are in the markup (a New version reads 3. and 4.); the version's acts have a gap; the
    reason field is styled like the screen's other fields; the checkbox, rhythm and badge notes.
- **Tests (JSDOM).** 35 tests over the real handlers and markup with a fake server that keeps the routes' contracts. Which
  items of section 10 they cover, and which the integration run covers, is listed in the pull request's description.
  Mutations, each removed and the suite failing: the clubs-read sentence, the name cleaning in a team row, both halves of
  the re-read guard, the owner filter and the naming of `source_metric_target_taken`, the settled-write release, the
  acts enabled after a settled refusal, the R8 identity, the stale team answer, the per-route settle list, the
  unknown-refusal re-read, the notice cleared on a new act, the lone club, the ticked levels, the label cleaning and the
  preview's repaint.
- **Integration run** (the executor's scratch harness, not in the repository): this branch's backend in process on one
  disposable `optimove_tests_gpexe_*` database migrated through v50, the real frontend in Chromium, the seeded TIME and
  TotDist revisions confirmed on that database only, never a GPEXE request. Create → draft → submit → activate with a
  team → preview → switch off → switch on (with a lost answer and **Check result**) → **New version** → replace keeping
  both teams → disable, by a platform admin in the platform workspace, each step checked in the database; a club admin
  (the system mapping's teams, a switch on for the club's own team, a club mapping's draft and submit) and a platform admin
  in the club's workspace (activating the club mapping with a team); a coach (no card, `GET /mappings` 404). The database
  holds `migrations_v2` only, so the legacy `/api/organization` route cannot run on it: the run serves it from the same
  database's clubs and teams with the route's keys and workspace narrowing (plus decoy athletes and users the screen
  drops); `/api/notifications`, `/api/messages` and `/api/admin/athletes` answer 500 there for the same reason and are
  outside the screen. Browser QA at 1280, 390, 375 and 360 px on every state of the flow and the detail (no horizontal
  overflow, 44 px targets, 16 px fields). The database was dropped afterwards. After the review fixes: 110 of 110 checks.
- **The owner's acceptance criterion** („Stim sto ovo mora biti mnogo jednostavnijeg za korisnika”): from the Mappings list
  to the first team switched on for a system mapping, the integration run counted 16 interactions on the first head and
  **13 after the review fixes** — New mapping, the field, the variable, Review, Save draft, Submit for review and its
  confirm, Activate, **Switch on for teams now**, the team, Required, Review, **Activate and switch on** — plus typing the
  conversion note and the reason. `ux-design-reviewer` judged it acceptable for a one-off setup per field by an
  administrator.
