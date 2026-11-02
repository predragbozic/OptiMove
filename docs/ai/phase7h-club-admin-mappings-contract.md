# J14 — phase 7h: a club's admin activates, replaces and disables its club's mapping versions (proposed ★★ contract)

This is the contract of phase 7h of `docs/ai/metrics-core-plan.md` (phase 7: "7h ★★: a club's admin approves, disables
and replaces its club's mapping versions (OD6, C108)"). It extends `docs/ai/gpexe-metric-variable-mapping-discovery.md`
(the *discovery document*): D (lock order), D6, D7, D10, C30, C33, C35, C60, C76, C104, C106 and C108. It changes
what the phase 7b contract (`docs/ai/phase7b-mapping-transitions-contract.md`, J8), the phase 7d contract
(`docs/ai/phase7d-mapping-activations-contract.md`, J10) and the Mappings screen contract
(`docs/ai/phase8-mappings-screen-contract.md`, J16) left to the platform admin, and it answers J17's O16 question
(`docs/ai/phase9-importer-mappings-contract.md`, section 12.2) and keeps the path of J18
(`docs/ai/c112-drag-mapping-contract.md`, C112) open.

The implementation is its own pull request, **7h-B**, with migration **v52**. No code and no migration are written
before this contract is accepted.

| | |
|---|---|
| Status | **Proposed** by the executor on 2026-11-02, on the *Rukovodilac*'s order of that day (queued at 13:35:02 UTC), which relays the owner's order „počni sa 7h i 7i” and adds: „Ne piši kod ni migraciju dok ne prihvatim ugovor.” Documentation only. |
| Verified against commit | `565fe097` (merge of PR #331). Every file and line reference below is to that commit unless it names another. |
| Mark | ★★: external-review triggers 1 (a migration), 2 (auth, role, `owner_scope`, info hiding) and 4 (transactions, lock order, idempotency). Reviewed by the *Rukovodilac* and the *Nezavisni revizor*. |
| The owner's decision | **C108 / OD6** (2026-10-30): „Povezivanje veza i raskidanje veza izmedju varijabli radi pre svega klupski admin, moze i sistemski ali pre svega klupski jer je to njegov posao.” (turn `122a4df5`); „Rekli smo da sam mogu da klupski admin da radi mapiranja, i da preuzima sistemske varijable” (turn `a73981ac`); „znaci promeni u skladu sta sam hteo, ne vidim problem, da li ti vidis” (turn `88ad60ca`). Section 2 is the *Rukovodilac*'s reading of it (discovery C108), made concrete. |
| Owner decisions | **O1–O6** (section 11), each with a recommendation. They become decisions with the next free C numbers once decided (R8). |
| Decides | The *Rukovodilac*: R1–R12 (section 12) and the acceptance under its order. The owner: O1–O6; for a ★★ phase the owner also approves the contract before any code (`metrics-core-plan.md`, section 3, A1). |
| Migration | **v52** (the next free number: v51 is `migrations_v2/202611011900_calendar_v51_settings.sql`), proposed as `migrations_v2/<YYYYMMDDHHMM>_training_load_v52_club_mapping_transitions.sql`. No open pull request carries a migration at the time of writing (PR #332 has none). If another migration lands first, 7h takes the next number (R1). |

---

## 0. In short

- **What changes for a club's admin.** Club X's active admin, in club X's workspace, may **activate** (A1:
  `needs_review → active`), **replace** (A1 with `expectedActiveVersionId` and a reason) and **disable** (A2: from
  `draft`, `needs_review` or `active`) a version of **club X's own mappings**. A1's listed starts and the activation
  ends that a replacement or a disable writes go with it. Today a club admin can only create, version and submit
  its club's mappings, and start and end activations (C106); the step to `active` needs a platform admin.
- **What does not change.** System mappings, a source field's unit and meaning (M2b), the revision lifecycle and its
  pinned step (L1–L5), unit conversions and D9 stay the platform admin's. The platform admin keeps everything it has,
  including support in club X's workspace on the basis `platform_admin`. Everyone else gets the identical 404.
- **Where the refusals sit today** (section 1.2): the route and service gate `mayTransitionMappings`; v34's T4 update
  guard (two `source_metric_require_platform_admin` calls); v34's two T4 basis CHECKs; T8's `source_metric_audit_row_ok`
  (v48 body) for three branches; and the club-less basis of a version-driven activation end (v48's T5 update guard and
  T8 actor guard, plus a constant in the service). v35's actor guards, v43's G1 and G2 and v48's T8 insert guard
  already handle `club_admin` and are **not** changed.
- **v52** widens the two CHECKs and replaces four function bodies in place, each behind an md5 precondition: v34's T4
  update guard, v48's `source_metric_audit_row_ok`, v48's T5 update guard and v48's T8 actor guard. It adds no table,
  column, trigger or index. Its rollback refuses once a row only 7h can write exists.
- **The service** changes one predicate (`mayTransitionMappings`) and lets the version-driven ends carry the caller's
  basis. Lock order, idempotency, replay and the COMMIT discipline are 7b's and 7d's, unchanged.
- **The screen** shows Activate, Replace and Disable on the club's own mappings to its admin: one person, one
  workspace, no hand-off (section 8).
- **The importer** is unchanged: it never reads who activated a version (section 1.5). The owner's O16 question
  (what a team coach sees of a club variable after an import) is put again here, because 7h removes the only thing
  that keeps it true today (O2).

## 1. What exists (verified at `565fe097`)

### 1.1 What a club admin can do today

Club X's active admin, in club X's workspace (`resolveMappingAdminWith`, `backend/src/sourceMetricAccess.js:88-106`,
basis `club_admin`, owner `{ scope: "club", clubId: X }`):

- **create** a club mapping (`POST /mappings`), **a version** (`POST /mappings/:id/versions`) and **submit** it
  (`draft → needs_review`, `POST …/submit`) — M2, proven by `source-metric-mapping-m2.test.mjs` test 11; the T4 guard's
  submit branch already splits by basis (v34 `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql:1161-1167`);
- **start, end and list** T5 activations of system versions and of club X's versions on club X's bindings (S1, S2,
  S3; C106, v48), and run the 7e preview — `mayManageActivations` (`sourceMetricAccess.js:46-49`) and
  `activationInScope` (`:57-61`).

It **cannot** activate, replace or disable a version. On its own club mapping the screen says "Ask a platform
administrator who also administers <club> to activate it in this workspace." (`frontend/metric-mappings-view.js:363-364`).
A club without such a person cannot make its own mapping live at all (J16 R12).

### 1.2 The five layers that refuse A1 and A2 to a club admin

| Layer | Where | What it does today |
|---|---|---|
| 1. Route and service gate | `mayTransitionMappings` (`sourceMetricAccess.js:38-40`), asked by `routes/sourceMetrics.js:244` and `:252` before the body, and again by `activateVersion` (`sourceMetricMappingService.js:1368`) and `disableVersion` (`:1525`) | `basis === "platform_admin"` only: a club admin gets the identical 404 before the body. |
| 2. T4 update guard | `training_load.source_metric_mapping_versions_update_guard` (v34 `:1109-1210`; never replaced) | `needs_review → active`: `source_metric_require_platform_admin(new.activated_by_user_id)` (`:1192`). `→ disabled`: the same for `disabled_by_user_id` (`:1204`). The activation branch locks T3 `FOR SHARE` without reading its owner (`:1178`). |
| 3. T4 basis CHECKs | `source_metric_mapping_versions_activated_basis_check` and `source_metric_mapping_versions_disabled_basis_check` (v34 `:811-818`) | `activated_basis` / `disabled_basis` is null or `'platform_admin'`. (`submitted_basis` already admits both, `:806-808`.) |
| 4. T8 row shape | `source_metric_audit_row_ok` behind the CHECK `source_metric_audit_action_shape` (v34 `:1720-1731`); body in force v48 `migrations_v2/202610301900_training_load_v48_mapping_activations.sql:297-337` | `mapping_status` `needs_review → active` and `→ disabled` (`:322-323`) and `mapping_version_replaced` (`:324-325`) admit `platform_admin` only; `draft → needs_review`, `mapping_create`, `mapping_version_create`, `activation_start` and `activation_end` admit both. |
| 5. Version-driven ends | v48's T5 update guard (`:185-233`, the `else` branch at `:221-222`) and T8 actor guard (`:364-458`, `:386-387`); the service writes the constant `'platform_admin'` (`backend/src/sourceMetricActivationSteps.js:230-238` and `:243-252`) | An end with `end_reason` `mapping_version_replaced` or `mapping_version_disabled` derives the basis as `source_metric_actor_basis(actor, NULL)`: `platform_admin` for an active platform admin whatever the club's state (7d section 2.3), NULL (`42501`) for anyone else. |

**What happens if only layer 1 were opened** (from the code; the reason the tests in section 10 assert success, not
"no error"): BEFORE ROW triggers fire in name order, so v34's guard runs before v35's (v35 test 1). A club admin's
plain A1 would stop at v34 `:1192` with "the acting user is not an active platform admin", which is in
`ACTOR_REFUSALS` (`sourceMetricMappingService.js:341-345`) and so answers the **identical 404**: the missing migration
would look like information hiding. A2 or a replacement of a version with open activations would stop at the T5 end
first (v48 `:222`, a text not in `ACTOR_REFUSALS`) and answer a sanitized 500.

### 1.3 What already handles `club_admin` (no change in 7h)

- **v35's actor guards** derive the basis with the mapping's owner club: T3 (`source_metric_mappings_actor_guard`,
  v35 `migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql:124-136`) and T4
  (`source_metric_mapping_versions_actor_guard`, `:145-200`), which requires `activated_by` / `disabled_by` = the
  acting user and `activated_basis` / `disabled_basis` = the derived basis (`:183-196`).
  `source_metric_actor_basis` (`:82-113`) returns `platform_admin` first for an active platform admin (and NULL for
  one on an archived club's mapping), then `club_admin` for the club's active admin of an active club, else NULL.
- **v48's T8 insert guard** (`:339-362`) confines a `club_admin` row of a mapping action to a club mapping (`:350-353`).
- **v48's T8 actor guard** derives a mapping action's basis with the mapping's club (`:405-416`) and checks the
  version's facts against the row (`:444-450`).
- **v43's G1 and G2** (`migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql:51-122`)
  never read the basis: G1 needs the replacement's disable row by the same user in the same operation, G2 the
  transition's facts.
- **v50's revision guard** returns early for the four mapping actions and compares an activation row's basis with
  the T5 row's own (`migrations_v2/202610311200_training_load_v50_source_instance_end.sql:211-372`).
- **A1's listed starts** already write `activated_basis = ctx.basis` (`sourceMetricActivationSteps.js:163-203`), under
  v48's insert guard, which derives it for the binding's club.
- **The service** already writes `ctx.basis` on every T4 fact and T8 row of A1 and A2 (`sourceMetricMappingService.js`
  `:1466-1506`, `:1556-1563`); `transitionTarget` (`:1274-1288`) reads the version only where the mapping's
  `owner_key = ownerKeyOf(ctx)`, so in club X's workspace a system mapping, another club's mapping or a version of
  another mapping is the identical 404 before any lock.

### 1.4 The scope of a club mapping's activations

- A T5 row's club is `training_load.source_metric_binding_club(binding)`: the owner club of the binding's
  **connection**, never the team's club (v48 `:84-90`).
- A club mapping is activated only on a binding of a connection that club owns (C35; v48's insert guard `:165-169`).
- A connection's owner is immutable once any binding, active or ended, exists (v27 trigger function
  `source_credential_connection_protect_identity`,
  `migrations_v2/202609271000_training_load_v27_source_credential_connections.sql:437-476`).
- So **every activation of a club X version sits on a binding of club X's connection**, and S3 in club X's workspace
  lists them all while club X is active. The replace / disable list of teams that would be switched off
  (J10 R8, J16) is complete for a club admin.
- **A team archive does not end its bindings**: the only writer of `source_team_bindings` is the Unbind
  (`backend/src/sourceConnectionService.js:513`).
- **A team's club is fixed** after creation by the organization route (D43, PR #332, open at the time of writing:
  `409 team_club_fixed`). A raw `update` of `public.teams.club_id` is still possible for an unbound team. v27 refuses a
  move while the team is bound through its club's connection (`:410-430`).

### 1.5 The importer (J17, 9-B)

- **It does not read who activated, replaced or disabled a version.** `ACTIVATIONS_SQL`
  (`backend/src/gpexeImportMapping.js:75-96`) reads every open T5 row of the binding, with T4, T3, T2a, T2b and the
  definition, and selects no `*_by_user_id` or `*_basis` column. It reads the mapping's `owner_scope` and
  `owner_club_id` only into the decision key (`:118-119`, `:147-150`).
- **Usability** is decided in `mappedMetricSpecs` (`gpexeImportMapper.js:167-219`): the version must be `active`, and
  the field must be active and verified.
- A 9-B test already imports through a club mapping activated by a platform admin in the club's workspace
  (`backend/tests/gpexe-import-mapped-audience-9b.test.mjs`, test 4).
- **Its approval** locks T2b → T3 → T4 → definitions → T5 `FOR SHARE` (`lockActivations`, `gpexeImportMapping.js:161-180`),
  reads the set again and refuses a change as `409 preview_changed` with nothing stored
  (`gpexeImportService.js:2392-2397`). It then takes the approver's rights rows (6b). A2 and A1 take the same registry
  rows in the same order (FOR NO KEY UPDATE / FOR UPDATE) and their rights rows after them. So a club admin's
  transition forms no new cycle with an approval, a check-time preview, a club-admin revocation or a club archive
  (J17 R5's argument, unchanged; the club-archive leg rests on PostgreSQL's row-lock rules, not on a test).
- **Stored candidates:** the preview hash includes the sorted set of activations (`gpexeImportPreview.js:283-285`;
  `gpexeImportMapping.js:314`). An approval after a disable or a replacement recomputes it and answers
  `409 preview_changed`, storing the new preview (`gpexeImportService.js:2419-2423`, `:2488-2491`). A check
  recomputes every session's preview, and a value re-imported under another version goes to `needs_review` (D17,
  `gpexeImportWriter.js:539-556`).
- **One consequence matters more once club admins change their own mappings.** A *Ready* row stays *Ready* in the list
  until the next *Find new sessions* or a refused approval. A check after the change can report a session as
  *unchanged* (its bundle hash) while its status moves to *blocked* (`no_mapped_values`). This is the same today for a
  platform admin, and an approval is always safe.
- **Who approves an import** is unchanged (an active platform admin or a coach with the team's grant; v23,
  `gpexeImportAccess.js:39-55`). Not in 7h.

### 1.6 The Mappings screen today (J16, 8-B)

- No answer of the mapping reads carries a permission hint (`publicMappingBase`, `sourceMetricMappingService.js:626-629`).
- The screen decides from the workspace and `mapping.ownerScope`, in two helpers (`frontend/metric-mappings-actions.js:259-263`):
  - `inOwnerWorkspace` gates *New version* and *Submit for review*;
  - `mayTransition = ctx.isPlatformAdmin && inOwnerWorkspace` gates *Activate*, *Replace*, *Disable*, the primary act
    and the notice "You can activate it now." after a submit (`:436-439`).
- *Switch on for teams*, *Switch off* and *Check with a saved session* are not gated: C106 already gives them to a
  club admin.
- The sentences that assume the platform: the club intro (`metric-mappings-view.js:97`), step 4's "a platform
  administrator activates it" (`:276-278`, keyed on `isPlatformAdmin`) and the waiting-version note (`:363-364`).
- J16 section 15 counted **13 interactions** from the list to the first team switched on (platform admin, system
  mapping). For a club admin today the same path takes the first 7, then a hand-off to a person who is both a
  platform admin and the club's admin, in the club's workspace.

## 2. Who may do what (OD6, the *Rukovodilac*'s reading)

### 2.1 The table

"Club X's admin" is an active `club_admin` of active club X, in club X's workspace, who is not an active platform admin
(a user who is both always acts on the basis `platform_admin`: `resolveMappingAdminWith`, `sourceMetricAccess.js:95-99`,
and v35's derivation). "Platform admin" is an active platform admin in the platform workspace (system mappings) or in
club X's workspace (club X's mappings, support), as today.

| Operation | Club X's admin, on club X's mapping | Club X's admin, on a system mapping or another club's | Platform admin (owner's workspace) |
|---|---|---|---|
| Create a mapping, a version; submit | yes (today) | 404 (today) | yes (today) |
| **A1 activate** `needs_review → active` | **yes (7h)** | 404 | yes |
| **A1 replace** (`expectedActiveVersionId`, reason) | **yes (7h)**: N's open activations end with `mapping_version_replaced` | 404 | yes |
| **A1 with listed starts** | **yes (7h)**, on club X's bindings only (`activationInScope`); a listed binding of another club, of an archived club or team, or out of scope: the identical 404 | 404 | yes |
| **A2 disable** from `draft` / `needs_review` / `active` | **yes (7h)**: an active version's open activations end with `mapping_version_disabled` | 404 | yes |
| Replay of each, the answer after COMMIT | the same right, checked again in the current workspace | 404 | as today |
| S1 / S2 / S3, the 7e preview | yes (C106, today), system and club X versions on club X's bindings | — | yes |
| M2b unit and meaning, L1–L5 and the pinned step, conversions, D9 | 404 (unchanged) | 404 | platform workspace only (unchanged) |

- **Any** active admin of club X may act on **any** version of club X's mappings, including one another admin of the
  club or a platform admin (in support) activated (O4).
- No separation of duties: the same admin may create, submit, activate, replace and disable (O3; C104 Q6 for platform
  admins).
- **A1 still needs the platform's evidence:** the source revision `active` and `verified`, and the value and bound
  conversions active (`sourceMetricMappingService.js:1431-1435`; v34 `:1173-1177`, `:1187-1190`). A club admin
  therefore activates only fields a platform admin confirmed (C97, M2b) — once per field, not per mapping. This is
  intended, and the screen names it (section 8).

### 2.2 What stays the platform admin's

Each gate and body below is unchanged by 7h, and 7h's tests assert it again (section 10.6):

- **System mappings:** a system mapping's owner workspace is the platform workspace, which only a platform admin has
  (C60). In the database, `source_metric_actor_basis(actor, NULL)` is NULL for a non-platform user (v35 `:96-100`), and
  the T8 insert guard refuses a `club_admin` row naming a system mapping (v48 `:350-353`).
- **A source field's unit and meaning** (M2b): `mayVerify` (`sourceFieldVerificationService.js:88`); T2b guards
  (v34 `:582-588`, v42).
- **The revision lifecycle (L1–L5) and its pinned step:** `mayChangeRevisions = mayVerify`
  (`sourceRevisionLifecycleService.js:91`). The pinned step keeps disabling a club's active version from the platform
  workspace on the basis `platform_admin` (`:245-267`), and it still answers `409 club_archived` for an archived club's
  version (`:218-237`).
- **Unit conversions:** `mayMaintainConversions` (`unitConversionService.js:59`; v47).
- **D9:** `mayEndInstances` (`sourceInstanceEndService.js:59`; v50).

### 2.3 The identical 404, and what is not a 404

**The identical 404** (`{ "error": "notFound" }`, `Cache-Control: no-store`), with nothing written and the request
key left free, goes to:

- another club's admin;
- an admin of clubs A and B acting in B's workspace on A's mapping;
- club X's admin in a team workspace of club X;
- a revoked club role, a revoked platform admin role, and an archived club, for both bases;
- a coach, an athlete, a user with no role;
- club X's admin on a system mapping, on a version of another mapping, or on an unknown id;
- a replay from another workspace.

An inactive user gets the router's 401, as today.

**Not a 404 (R6).** The Rukovodilac's order says "only on a binding of that club's team". The database rule is "a
binding of a connection the club owns" (section 1.4). The two differ in two cases:

- **A1's starts.** On an archived team, or on a binding outside the scope, they are the identical 404, as for S1
  today (`lockListedBindings`, `sourceMetricActivationSteps.js:106-130`).
- **A2 and a replacement.** They still **end** open activations of the club's own version on an archived team's
  binding, and on an ended binding of a team that a raw write moved to another club. S2 and the platform's A2 do the
  same today (7d test 5). Stopping is always the safe direction, and nothing new is started there.

### 2.4 The basis on the row (amends J10 section 2.3)

| Write | Derived as | Result |
|---|---|---|
| A start (S1, A1's listed starts) and an S2 end (`admin_ended`) | `source_metric_actor_basis(actor, the binding's club)` — unchanged | as J10 |
| An end written by A1, A2 or the pinned step, by a platform admin | `source_metric_actor_basis(actor, NULL)` — unchanged | `platform_admin` whatever the club's state (a system version can always be stopped) |
| **An end written by A1 or A2 of a club version, by that club's admin (7h)** | `source_metric_actor_basis(actor, NULL)` first; when that is NULL and the T5 row's mapping is a club mapping, `source_metric_actor_basis(actor, the mapping's owner club)` | `club_admin` for that club's active admin of the active club; NULL (`42501`) for anyone else, and for a club admin on a system version |

The platform admin's path is byte-for-byte unchanged in effect: a platform admin still derives `platform_admin`
without the club gate. A club admin can never reach the NULL-club path's result. The mapping's owner club equals the
binding's club for every activation of a club version (section 1.4); v52 asserts it as a backstop (R3).

## 3. Routes and answers (no new route, no body change)

The routes are 7b's: `POST /api/training-load/sources/metrics/mappings/:mappingId/versions/:versionId/activate` (A1)
and `…/disable` (A2), with the bodies, hashes and answers of J8 and J10 unchanged. No field names an owner, an actor
or a basis (C60). The request hash carries no basis or workspace (`sourceMetricMappingService.js:1394-1397`, `:1534`).

**The order of the answers for a club admin** (J8's order; `routes/sourceMetrics.js:241-255`):

1. no session → 401;
2. no context, or a context the gate refuses → the identical 404, before the body;
3. 415, then 400 `invalid_body` for a non-object;
4. a malformed id → the identical 404;
5. 400 per body rule;
6. the owner-filtered read (`transitionTarget`) → the identical 404 for a system mapping, another club's mapping, a
   version of another mapping or an unknown id;
7. the request record (replay or `request_key_reused`);
8. the locks;
9. the right checked again;
10. the state refusals (`version_not_submitted`, `active_version_changed`, `version_status_changed`, …), only after
    the right is confirmed.

Step 6 after step 5 is today's order for a platform admin in the platform workspace who names a club mapping
(7b test 9). A 400 does not depend on the id, so it reveals nothing.

**Replay.** The key is per user (`source_metric_audit_one_request_per_key`). A replay checks the right again in the
current workspace (`runWrite`, `:786`) and answers the current state.

- A key written by club X's admin and replayed from another workspace → the identical 404.
- A key written as a platform admin in club X's workspace and replayed by the same user as club X's admin, after the
  platform role was revoked → the same version (same owner). This is accepted and stated.
- `request_key_reused` compares the action and the hash, not the basis.

**After the COMMIT** (F2, `runWrite` `:800-825`, unchanged): the COMMIT is awaited 15 s. A definite refusal (an
ordinary ERROR) is classified: the deferred 23514 links answer a sanitized 500 with nothing written. Any other error
is checked on a new connection within 5 s, then answers `200 verified_after_commit_error` or `503 outcome_unknown`
with `details.requestKey`. `answerAfterCommit` (`:843-858`) checks the right again: if it was lost meanwhile, the
answer is the identical 404.

**A promotion during the request** (a club admin granted the platform admin role) — the 7d rule, restated (R4):

- If the grant commits before the right is checked again (`rightsStillHold`'s probe, `sourceMetricAccess.js:117-127`),
  the answer is `409 try_again`.
- If it commits after that check and before the T4 or T5 write, v35's or v48's actor guard refuses
  "the basis is not the acting user's own" (not in `ACTOR_REFUSALS`). The answer is a sanitized 500 with nothing
  written, as discovery `:4053-4054` already accepts for 7d.

## 4. The write, in the documented lock order (unchanged)

A club admin's A1 and A2 take exactly the platform admin's order. Only the rights rows they lock at the end differ:

1. per-user advisory lock (`hashtextextended('source-metric-mapping:' || user, 34)`, 5 s);
2. the request record (replay before any registry lock);
3. A1: the value and bound conversions (`source_metric_lock_conversions`);
4. T2a and T2b `FOR SHARE`;
5. T3 `FOR NO KEY UPDATE`;
6. T4 `FOR UPDATE`, ascending;
7. A1: the definition and its scope capabilities `FOR SHARE`;
8. the open T5 rows `FOR NO KEY UPDATE`, ascending (a replacement or a disable);
9. `rightsStillHold`, in order:
   - the promotion probe (global role and user `FOR SHARE`);
   - `user_club_roles` and `users` `FOR SHARE`;
   - the club `FOR SHARE`;
10. A1's listed starts:
    - bindings `FOR SHARE`, then their teams `FOR SHARE`;
    - the bindings' clubs `FOR SHARE` (`bindingClubHolds`);
11. the writes, in this order:
    - the T5 ends;
    - the T4 status changes;
    - the T5 starts;
    - the unkeyed T8 rows;
    - the keyed T8 row last.

The triggers derive the basis again on the rows step 9 already holds. v52 moves v34's T3 `FOR SHARE` in the disable
branch to before its role check (section 6.1). That restores D's header order (T3 before the acting user's rows)
inside the trigger chain. The service already holds T3 more strongly from step 5, so nothing new waits.

The rights rows come after every registry row, as the importer's step 6b does (J17 R5). No 7h write takes the team
import lock, a binding `FOR UPDATE` or the Metrics Core connection.

## 5. Concurrency

This table adds the club admin's rows to J10 section 5. **It amends J10's row "A1, A2 and the pinned step lock no club
row for their ends … an archive never blocks them"**, which is false for a club admin.

| Against | Outcome |
|---|---|
| Club X's admin's A1 against another admin of club X (or a platform admin) on the same mapping | Both take T3 `FOR NO KEY UPDATE` first: they serialize. The second reads the new state and answers `active_version_changed` / `version_status_changed` after its right is confirmed. |
| A2 or a replacement against S2 ending the same activation | J10's row, unchanged: they serialize at T3 (or at T4 for the pinned step) before the T5 row. |
| Club X's admin's A1 or A2 against the pinned step (L4 / L5) on the pinned revision | They serialize at T2b (`FOR UPDATE` against `FOR SHARE`), then at T3 and T4 in the same order. If the pinned step goes first, the A1 / A2 reads a disabled version or a retired revision. If the A1 / A2 goes first, the pinned step disables what it finds. |
| **A club archive** against club X's admin's A1 / A2 | The club row is held `FOR SHARE` in step 9, and again in the triggers' `source_metric_actor_basis`. The archive waits for the write, or lands first, and the write then answers the identical 404. The archive takes no T3, T4, T5 or binding lock, so no cycle forms. |
| **A club-role revocation** against club X's admin's A1 / A2 | The revocation (`routes/organization.js:2549-2583`) takes `users` and `user_club_roles` `FOR UPDATE`; the write holds them `FOR SHARE` from step 9. One waits for the other. If the revocation lands first, the write answers the identical 404 with nothing written. A deadlock between the two rows of the same user is possible but not proven (the row order depends on the join plan); `40P01` answers `409 try_again` with nothing written. |
| A promotion | Section 3. |
| An Unbind, or a team archive, against A1's listed starts | J10's rows, unchanged: the starts hold the bindings and teams `FOR SHARE`. |
| An Unbind, or a team archive, against A2 or a replacement | No binding or team row is locked: the ends go through (section 2.3). |
| An import approval or a check-time preview (J17) | Section 1.5: the same registry order and the rights rows after it; no new cycle. Import first: the transition waits at T3, T4 or T5. Transition first: the approval's step-5 re-read answers `preview_changed`, with nothing stored. |

**Bounds** (unchanged): a 2 s row-lock timeout, a 10 s statement timeout and a 5 s per-user lock. `55P03`, `40P01` and
`57014` answer `409 try_again`.

## 6. The migration (v52, proposed)

### 6.1 What it changes

**Two CHECKs on T4** (`training_load.source_metric_mapping_versions`), in one `alter table`:

```sql
alter table training_load.source_metric_mapping_versions
  drop constraint source_metric_mapping_versions_activated_basis_check,
  add constraint source_metric_mapping_versions_activated_basis_check
    check (activated_basis is null or activated_basis in ('platform_admin', 'club_admin')),
  drop constraint source_metric_mapping_versions_disabled_basis_check,
  add constraint source_metric_mapping_versions_disabled_basis_check
    check (disabled_basis is null or disabled_basis in ('platform_admin', 'club_admin'));
```

**Four bodies replaced in place** (`create or replace`, no new trigger, the trigger names and their firing order
unchanged):

1. **`training_load.source_metric_mapping_versions_update_guard()`** (v34). Only two branches change; every other line
   stays byte for byte.
   - **The activation branch** (`needs_review → active`): v34 `:1178`'s `perform 1 … for share` becomes
     `select owner_scope, owner_club_id into map … for share`, at the same place with the same lock. v34 `:1192`'s
     `source_metric_require_platform_admin` becomes the submit branch's split (v34 `:1161-1167`):
     - basis `platform_admin` → `source_metric_require_platform_admin(new.activated_by_user_id)`;
     - basis `club_admin` on a club mapping → `source_metric_require_club_admin(new.activated_by_user_id, map.owner_club_id)`;
     - anything else → `42501` "source metric mapping: the acting user may not activate this mapping version".
   - **The disable branch:** after its two existing checks (only its own facts; no open activation), it reads
     `select owner_scope, owner_club_id into map … for share`, then the same split for `disabled_by_user_id` /
     `disabled_basis`, else `42501` "source metric mapping: the acting user may not disable this mapping version".
2. **`training_load.source_metric_audit_row_ok(…)`** (v48 body). Only three branches change; every other branch stays
   byte for byte. The `source_metric_*`, `unit_conversion_*` and `source_instance_end` branches stay `platform_admin`
   only.
   - `mapping_status` `needs_review → active` admits `p_basis in ('platform_admin', 'club_admin')`;
   - `mapping_status` `→ disabled` (reason still required) admits both;
   - `mapping_version_replaced` (reason still required) admits both.

   The function is `immutable` and used by a CHECK, so replacing it does not revalidate existing rows. That is
   harmless for a widening, and the reason the rollback must refuse (section 6.5).
3. **`training_load.source_metric_activations_update_guard()`** (v48 body). Only the `else` branch of the end
   (v48 `:221-222`) changes, to section 2.4's derivation:
   - `basis := source_metric_actor_basis(actor, null)`;
   - when that is NULL, read the T3 row's `owner_scope` and `owner_club_id` by `new.mapping_id` with a plain read (T3
     is immutable, v34 `:643-645`);
   - if it is a club mapping, assert `source_metric_binding_club(new.source_team_binding_id) = owner_club_id` (`23514`
     "source_metric_mapping_activations: a club version's activation is on another club's binding", R3) and then
     `basis := source_metric_actor_basis(actor, owner_club_id)`.

   The rest (the actor equals `ended_by_user_id`, the derived basis equals `ended_basis`, `ended_at = now()`) is
   unchanged.
4. **`training_load.source_metric_audit_actor_guard()`** (v48 body). Only the `activation_end` branch with a
   version-driven `end_reason` (v48 `:386-387`) changes:
   - its activation read also selects `mapping_id` (an `activation_end` row has no mapping, targets `00011001`);
   - it derives the basis exactly as body 3, with the same backstop.

   The other branches stay byte for byte.

**v52 adds nothing else** — no table, column, trigger, index or data. **It does not change:**

- `source_metric_audit_basis_check`, which already admits both;
- the T5 CHECKs (v48);
- `source_metric_actor_basis` and `source_metric_context_actor`;
- v35's T3 and T4 actor guards;
- v48's T8 insert guard and its deferred links;
- v43's G1 and G2;
- v50's revision guard: v50's md5 precondition on it stays true.

It also updates the comments that state the old rule: the column comments of `activated_basis` and `disabled_basis`,
and v48's comment of the T5 guard.

**Fixed texts and their answers.** Through 7h-B's routes a club admin cannot reach the two new `else` texts, because
`transitionTarget` filters by owner and the gate admits only a club scope. They are reachable only by a raw writer.
They stay out of `ACTOR_REFUSALS`, so a sanitized 500 (R2). The reused `require_*` texts are already in
`ACTOR_REFUSALS`. The new `23514` backstop is not in `TRIGGER_REFUSALS`, so a sanitized 500 too: it signals a broken
invariant, not a user error.

### 6.2 Preconditions (as v50)

Before replacing a body, v52 refuses (`raise exception`, nothing applied) unless the body in force has its expected
md5 (`md5(p.prosrc)`). The values below were computed from the migration files with the method that reproduces
v50's own constant for v48's revision guard (`921db06f6f2833eb57c062fb61e82e25`). 7h-B confirms them on a disposable
database built through v51:

| Function | Body in force | md5 |
|---|---|---|
| `source_metric_mapping_versions_update_guard` | v34 | `4b64be0b9bed0368cb9bae9fc6d53b17` |
| `source_metric_audit_row_ok` | v48 | `764f4ad70de273a443be84bc9bebd87a` |
| `source_metric_audit_actor_guard` | v48 | `3622725a1b0d454767704b2021db731c` |
| `source_metric_activations_update_guard` | v48 | `f4ce8781c0f1797663064cd4e5c63929` |

It also refuses unless both CHECK definitions are v34's (`pg_get_constraintdef`).

J18's later migration md5-checks the bodies in force (`c112-drag-mapping-contract.md:550`). After v52 its baselines
are v52's bodies; J14's 7h-B records them in its "As built".

### 6.3 Locks and the window

- v52 takes, in this order:
  1. T4 `access exclusive` (the CHECK swap; it scans T4, which holds production rows since M6);
  2. T5 `share row exclusive`;
  3. T8 `share row exclusive` (the replaced trigger functions, to serialize with their writers, as v48 and v50 did).
- The runner's `lock_timeout` bounds the wait; a wait beyond it fails the migration with nothing applied.
- The importer reads T4 `FOR SHARE` at an approval and in a check's preview. So **the deploy window needs the import
  switch off, no running check and no open approval** (the preflight's quiet-moment block). With the switch off since
  M6 and no check until the end of this track (the owner's order of 2026-11-02), this holds by default.
- `NOT VALID` plus `VALIDATE` gains nothing on a table this small.

### 6.4 Deploy compatibility

`npm start` runs the migration before the server starts, so the new schema always meets either the old code or the
new:

- **new schema, old code:** safe. The old code writes only `platform_admin`, which v52 still admits.
- **old code after a code rollback:** safe, for the same reason.
- **schema rollback:** refused once a 7h-only row exists (section 6.5).

### 6.5 Preflight, post-check and rollback (runbook SQL, as v48 and v50)

**`docs/runbooks/club-mapping-transitions-v52-preflight.sql`**: read-only blocks, each sent in its own read-only
transaction (the connector rule of 9-R):

1. the PostgreSQL version;
2. v51 is the last recorded migration, with its checksum equal to the file's, and v52 is absent;
3. the four bodies in force by md5 (section 6.2);
4. the two CHECK definitions are v34's;
5. no disabled trigger on T4, T5 and T8, and no v52 object collision;
6. the migrator role owns T4, T5 and T8;
7. no default for `optimove.source_metric_actor` at the database or role level;
8. a quiet moment:
   - no running check;
   - no running identity load;
   - no lock held on T4, T5 or T8;
   - no session idle in a transaction;
9. a sanity line: no row of the 7h-only kinds (below).

The counts in block 9 can only be non-zero if triggers were disabled, so they are a sanity line, not the gate.

**`…-postcheck.sql`**:

1. v52 recorded once, as the last migration, with its checksum;
2. the four new bodies by md5;
3. the two widened CHECK definitions;
4. the triggers on T4, T5 and T8 enabled, listed by name;
5. the counts of the 7h-only kinds (0 at the deploy);
6. no lock or session left.

**`…-rollback.sql`**: one transaction, `lock_timeout` 5 s, `pg_try_advisory_xact_lock(822026)` (the migrator's lock),
then the record check and the same locks as v52. It refuses, with every reason collected and nothing changed, when:

- a later migration is recorded;
- an object is missing, or a trigger is disabled;
- a body in force is not v52's (md5);
- **a 7h-only row exists**, which is any of:
  - a T4 row with `activated_basis` or `disabled_basis` `club_admin`;
  - a T8 `mapping_status` row to `active` or `disabled` with basis `club_admin`;
  - a T8 `mapping_version_replaced` row with basis `club_admin`;
  - a T5 row with `ended_basis` `club_admin` and `end_reason` in (`mapping_version_replaced`,
    `mapping_version_disabled`).

It does **not** refuse on the `club_admin` rows that 7d and M2 already write: `mapping_create`,
`mapping_version_create`, `draft → needs_review`, `activation_start`, and `activation_end` with `admin_ended`.
Otherwise it restores v34's two CHECKs and the four bodies byte for byte, and deletes v52's record.

**Rehearsed** in 7h-B's suite: apply → rollback → the v51 catalog exactly → re-apply → the v52 catalog exactly. A
migration whose last statement fails leaves nothing behind. All four files have LF line endings.

## 7. The service (7h-B)

- **`mayTransitionMappings`** (`sourceMetricAccess.js:38-40`) admits `basis === "club_admin" && owner.scope === "club"`
  besides today's rule, the same shape as `mayManageActivations`.
  - It is written out in full, never as "any basis".
  - The routes (`:244`, `:252`) and the service (`:1368`, `:1525`) read the same exported function.
  - Narrowing to the club's own mappings needs no new code: `transitionTarget` does it (section 1.3).
- **`endOpenActivations` and `endAuditRows`** (`sourceMetricActivationSteps.js:230-252`) write `ctx.basis` instead of
  the constant `'platform_admin'`.
  - The pinned step's context is always a platform admin's in the platform workspace (its own gate), so it still
    writes `platform_admin`; its T4 disable and its T8 row keep their constant.
  - The comment at `:222-229` is rewritten.
- **`submitVersion`** answers its state refusal (`409 version_not_draft`, `:1210`) only after `rightsStillHold`
  (`:1212`), as A1 and A2 do (R5). This is a pre-existing ordering gap: a caller who lost the right meanwhile could
  see the current status instead of the identical 404.
- **The comments** at `sourceMetricAccess.js:33-37`, `sourceMetricMappingService.js:1226-1244` and
  `routes/sourceMetrics.js:236-240` state the new rule.
- **No change to:**
  - `resolveMappingAdminWith`, `rightsStillHold`, `activationInScope` and `bindingClubHolds`;
  - `runWrite`, the request record, the hashes and `answerAfterCommit`;
  - `TRIGGER_REFUSALS` and `ACTOR_REFUSALS` (R2);
  - the lifecycle, conversion, verification and source-instance services;
  - the importer.

## 8. The Mappings screen

**In 7h-B**, frontend only where the server changed. It ships in the same pull request, never before the backend:
shipped alone it would show buttons that always end in the identical 404 and the sentence "Whether it was saved is
not known".

- **One predicate** (`frontend/metric-mappings-actions.js:263`):
  `mayTransition = (mapping, ctx) => Boolean(ctx && inOwnerWorkspace(mapping, ctx) && (ctx.isPlatformAdmin || (ctx.owner === "club" && mapping.ownerScope === "club")))`.
  - This equals the server's rule. In the platform workspace the caller is always a platform admin. In a club
    workspace, a club mapping is always the workspace's own club's.
  - A test pins the two predicates together (R12: no new API field).
  - With it, club X's admin gets, on club X's own mappings: *Activate* (with the optional *Switch on for teams now*
    chooser, preset to the club), *Replace version N* (*Keep these teams*), *Disable* on draft, waiting and active
    versions, the primary act *Activate*, and "You can activate it now." after a submit.
  - On a system mapping in the club's workspace nothing changes: *Switch on for teams*, *Switch off* and *Check*
    only, with "A platform administrator activates system mappings in the platform workspace."
- **Sentences:**
  - **the club intro** (`metric-mappings-view.js:97`): "System mappings come from a platform administrator; you switch
    them on for your teams. You activate your club's own mappings yourself.";
  - **step 4** (`:276-278`) keys on the same predicate, so the club admin reads "…submit it for review, then you can
    activate it.";
  - **the dead note** "Ask a platform administrator who also administers <club>…" (`:363-364`) is removed;
  - **the meaning blocker** (`actions.js:274`) gets the next step for a club workspace: "A platform administrator
    confirms it in the platform workspace." (the pattern of `view.js:171`);
  - **a missing conversion** (`data.js:284`) gets "Ask a platform administrator to add it.";
  - **the Imports screen's step for `mapping_not_usable`** (`frontend/gpexe-import-view.js:1516`): "Your club's admin
    fixes the club's own mappings; a platform administrator fixes system mappings and field confirmations."
- **The result for a club admin:** one person, one workspace, no hand-off. The path is J16's 13 interactions, which
  was impossible alone before.
- **"Much simpler"** (the owner's J16 criterion „mora biti mnogo jednostavnije za korisnika”, repeated in the
  *Rukovodilac*'s order) is O6. The recommendation: one *Save and activate* on step 4, about 8 interactions, as its
  own frontend pull request right after 7h-B; J18 (the board) stays the club's long-term path.
- **Tests:**
  - frontend test 10 (`frontend/tests/metric-mappings.actions.test.mjs:393-419`) inverts its club-mapping branch, and
    test 34 (`:1064-1092`) inverts its club branch; the system-mapping branches stay;
  - new handler tests: a club admin's activate with teams, replace with kept teams, and disable, through the real
    handlers, with the fake server admitting `club_admin` on a club mapping;
  - a mutation that makes `mayTransition` platform-only again must fail.
- **A browser check** of the club admin's path at 1280, 390, 375 and 360 px is required before any UI claim
  (`testing-evidence.md`).
- **Reviewers:** `code-reviewer` and `ux-design-reviewer` (a changed flow for club admins); `mobile-qa` only if the
  layout changes.
- **J16** section 2 row 3, section 5's "Waiting for review, anyone else" and R12 are superseded by this section
  (section 13).

## 9. C112 (J18) stays open

J18's drag-and-drop save will use exactly the club admin's rights that 7h opens. J14 keeps it possible:

- **The database rules are route-agnostic.** A `club_admin` `needs_review → active` passes when it is not the keyed
  request record: J18's keyed row is `mapping_confirmation` (`c112-drag-mapping-contract.md:496`).
- **No reason on an activation** (row_ok's `needs_review → active` has none, kept).
- **No separation-of-duties rule** (O3).
- **No new T4 trigger:** J18's gate is a new T4 trigger "named to sort after v34's and v35's guards" (`c112:626-645`),
  and v52 leaves that namespace free.
- **J18's md5 baselines move to v52's bodies** (section 6.2).
- **One direct-SQL test in 7h-B** de-risks J18 R8 (`c112:171-172`, `:1186`, unverified there). In one transaction,
  club X's admin creates T3, inserts T4, submits it and activates it, with every T8 row. The transaction commits
  under v35's deferred links and v43's G1 and G2. If it fails, J14's rules do not change; J18 R8 handles it.
- **J18's numbering is stale:** it assumes 7h = v51 and its own 18-1 = v52 (`c112:46`, `:182-183`, `:550`). With 7h at
  v52, 18-1 becomes v53 or later.
- **Under J18 Q13** (`c112:1166-1171`), J18 may later refuse a club admin's A1 for a parameter-less version in favour
  of the board's confirmation. That narrowing is J18's, on top of 7h's basis change, never instead of it.

## 10. Tests (7h-B)

### 10.1 The suite and its world

**The suite** is a new file, `backend/tests/source-metric-mapping-club-admin-7h.test.mjs`. Its `source-` prefix puts it
in `--preset gpexe`, which runs only `gpexe-` and `source-` files (`scripts/test-runner.mjs:45-57`). It runs on
disposable `optimove_tests_gpexe_*` databases:

- a rehearsal database built through v51;
- a main database built through every migration (v52 appended to `GPEXE_TEST_MIGRATIONS`).

**The world** is 7d's `world()`, plus:

- club A's admin in a team workspace of club A;
- club A's admin with a revoked role;
- an athlete;
- a revoked platform admin;
- `clubVersion()` variants that **club A's admin activates itself**.

A fixture meant as a club admin never carries a global `platform_admin` row: the database would derive
`platform_admin` first.

### 10.2 The actors × routes matrix

**Actors:**

- no session; an inactive user;
- a platform admin in the platform workspace; one in club A's workspace; one in club B's workspace;
- **club A's admin (caA)**; a second admin of club A (caA2); club B's admin;
- an admin of A and B in B's workspace;
- caA in a team workspace; caA with a revoked role;
- club C's admin with club C archived;
- a coach, an athlete, a user with no role;
- a platform admin in a team workspace; a revoked platform admin.

**Targets:**

- a club A version in `draft`, `needs_review` and `active`;
- a club B version; a system version;
- a version of another mapping; unknown ids;
- a club C version (club archived).

**Routes:**

- A1 plain; A1 replacement; A1 with listed starts on club A's bindings; A1 with a listed club B binding;
- A2 from each status;
- A2 with open activations, including one on an archived team's binding;
- the replays from another workspace;
- the regression routes: submit, S1, S2, S3;
- the platform-only routes: unit and meaning, L1–L5, conversions, source instances.

**Expected:**

- **caA (and caA2) on club A's versions** → 200, with:
  - `activated_basis` / `disabled_basis` = `club_admin`;
  - T8 `mapping_status` / `mapping_version_replaced` with basis `club_admin`;
  - version-driven ends with `ended_basis` `club_admin`, the right `end_reason` and, as the reason, the version's
    `disable_reason`;
  - listed starts with `activated_basis` `club_admin`.
- caA2 may replace or disable what caA or a platform admin activated (O4).
- **caA with a listed club B binding** → the identical 404, nothing written.
- **caA on any other target** → the identical 404, as section 3 orders it.
- **Every other actor on club A's versions** → the identical 404 (401 for no session and an inactive user), nothing
  written, the key left free.
- **A platform admin in club A's workspace** → 200 with basis `platform_admin` (unchanged).
- **caA on the platform-only routes** → the identical 404 (unchanged).

### 10.3 Direct SQL (each asserting the SQLSTATE, the fixed message and which guard fires first)

v34's guard fires before v35's by name, so each case must reach the layer it tests. A CHECK must never mask a
mutated trigger.

1. Club A's admin activates, disables and replaces a club A version, with its T8 rows → passes.
2. The same with basis `platform_admin` → `42501`, "the basis is not the acting user's own".
3. Club A's admin on a system version:
   - with basis `club_admin` → `42501` from v52's new `else` text in the T4 guard;
   - a T8 row → refused by the insert guard (`23514`, "a club-admin row names a club mapping"), which fires first by
     name.
4. Club B's admin on club A's version → `42501`, `require_club_admin`'s text.
5. An archived club, a revoked role, an inactive user, a coach, an athlete → `42501`.
6. A version-driven T5 end by club A's admin:
   - of club A's version, inside its own disable → passes;
   - of a system version → `42501` (7d `:1076`, kept);
   - of club B's version → `42501`.
7. The R3 backstop: a planted club version activation on another club's binding (triggers off for the plant only) →
   `23514`.
8. v43's G1 and G2 with `club_admin` rows behave as in 7b test 16.
9. **The J18 chain** (section 9): T3 + T4 + submit + activate in one transaction, committed.
10. A club-role revocation against a club admin's T4 activation in raw SQL, both orders (v35 test 9's pattern).

### 10.4 Races (each with no `40P01` in the log lines, the second request by another user, waits on rows not on an advisory lock)

- caA's A1 against caA2's A1 on the same mapping.
- caA's replacement against a platform admin's A2.
- caA's A2 against caA2's S2 on the same activation.
- caA's A1 / A2 against the pinned step on the pinned revision.
- caA's A1 with starts against an Unbind, a team archive and a club archive (a peer client, 7d `:1252-1305`).
- caA's A2 against club A's archive, both orders.
- The rights hold seam (`setRightsHoldForTests`), for A1 plain, A1 replacement with starts, and A2 with open
  activations:
  - role revoked, club archived or user deactivated during the write → the identical 404; nothing in T4, T5 or T8;
    the key free;
  - a promotion → `409 try_again`; the retry writes `platform_admin`.
- The COMMIT trio on a club admin's replacement with starts and on A2 with open activations:
  - `verified_after_commit_error`;
  - `outcome_unknown`, then a replay;
  - a definite refusal through `split_operation` (v43 G1) and through a v48 end-link fault.
- A replay after the role was revoked → 404. A cross-workspace replay by the A+B admin → 404.
- The importer (J17): caA's A2 and caA's replacement with starts against an approval, both orders:
  - import first → the transition waits;
  - transition first → the approval answers `preview_changed` with nothing stored.
- caA activates its club's version, switches it on, and an import writes through it (section 1.5).
- **The leak scan:** no reason, actor id, club id, trigger or SQL text in any answer or log line.

### 10.5 The migration rehearsal

1. **The preflight blocks** on the rehearsal database, with planted rows that flip each hard assertion.
2. **Apply** through the runner while a reader holds T4: assert that it waits, with no deadlock.
3. **The exact catalog delta:**
   - two CHECK definitions;
   - four bodies, by digest;
   - comments;
   - nothing else.
4. **The post-check blocks**, and the file's sha256.
5. **Each rollback refusal**, each changing nothing:
   - a later migration;
   - each 7h-only row kind;
   - **no** refusal on the 7d and M2 `club_admin` rows;
   - an object missing; a trigger disabled; a body not v52's;
   - the migrator's lock held.
6. **Rollback** to the v51 catalog byte for byte.
7. **Re-apply.**
8. A failing last statement leaves nothing.
9. LF line endings.

### 10.6 Mutations (each killed by a named test)

**The service:**

- `mayTransitionMappings` back to platform-only;
- `mayTransitionMappings` widened to `club_admin` on a system scope, or to any basis;
- the route gate moved after the body check;
- the promotion probe removed from `rightsStillHold`;
- `endOpenActivations` / `endAuditRows` back to the constant;
- the pinned step passing the caller's basis.

**v52:**

- The T4 guard, each separately for activation and for disable:
  - `require_club_admin` dropped;
  - reverted to `require_platform_admin`;
  - the owner check dropped (`club_admin` on a system mapping).
- Each CHECK widened to any text.
- `row_ok`, each of its three branches separately:
  - left platform-only;
  - admitting any text.
- The T5 and T8 version-driven derivation:
  - the club derived for a system version (it must stay NULL);
  - the NULL club kept for a club version;
  - the club taken from the binding instead of the mapping;
  - the R3 backstop dropped.

**The rollback:**

- the 7h-only row refusal dropped;
- its exemption of 7d / M2 rows dropped.

**The frontend:** `mayTransition` back to platform-only.

### 10.7 Existing suites

**Changed:**

- **7b test 8** (`source-metric-mapping-transitions-7b.test.mjs:663-668`) uses club B's admin or a coach as its
  "404 before the body" actor.
- **7b test 9's row** "club admin of the club" (`:710`) leaves the 404 list and becomes a success case in the new
  suite.
- **The comment and constant** in `sourceMetricActivationSteps.js`.
- **Frontend tests 10 and 34.**

**Kept as they are:**

- `source-metric-mapping-m1.test.mjs:893-894`: that suite stops at v34, so v52 is never applied there;
- 7d `:1076` (a system version);
- 7d `:938-946` (an archived club: A1 / A2 404, pinned step `club_archived`);
- 7b test 9's other rows; 7b test 14 (the pinned step);
- 7c test 6 and its SQL `42501`;
- 7g test 8; M2b test 3; v39 test 7; v35 test 4.

### 10.8 Commands (the T1 runner)

- During development: `--file` for the new suite, the 7b, 7d, M2, v35 and 7g suites, and the frontend Mappings suite.
- Before the review:
  - `test:gpexe`;
  - `--file` for `mapping-activations-7d.test.mjs` and `unit-conversions-7c.test.mjs`, which are **not** in the
    gpexe preset;
  - `test:frontend:fast`;
  - the frontend build.
- `test:backend:shared` only on the *Rukovodilac*'s word (R9).

## 11. Questions for the owner (O1–O6)

Each has a recommendation, the consequence and the alternative.

- **O1. The scope is the *Rukovodilac*'s reading of C108.**
  - **Recommended: accept section 2 as written.** Club X's active admin, in club X's workspace, activates, replaces
    and disables club X's own mapping versions, with A1's listed starts on club X's bindings and the ends those
    write. System mappings, unit and meaning, conversions, D9 and the revision lifecycle stay the platform admin's,
    and the platform admin keeps everything, including support in the club's workspace.
  - „moze i sistemski” is read as "a platform admin may also do it", not as "a club admin may touch system mappings".
  - *Alternative:* a club admin also changes system mappings — against C60 and the plan's 7h line, and every club
    would change every club's imports.
- **O2. O16: a club variable after an import.**
  - **Background:** J17 O16 is decided only for the pilot ("system variables only"; J17 section 12.3). After an
    import, the activity results carry only a value's definition id. The catalog hides a club-owned definition from
    a team coach (`trainingLoadMetricsAccess.js:116-134`). Today O16 holds only because a club version needs a
    platform admin to become active. After 7h a club admin alone can activate and switch on a club mapping (S1
    already allows the switch-on). No code enforces O16 (no hit in `backend/src` or the frontend).
  - **Recommended (a):** yes — an active coach of an active team of that club, in that team's workspace (C99's
    audience, which already renames, archives and restores the club's variables), sees the club variable's name and
    unit in that team's activity results. The read change is its own small pull request (7h-V), merged and deployed
    before 7h-B's deploy.
  - *Alternative (b):* defer O16, and 7h-B carries a code guard: S1 and A1's listed starts refuse a club mapping until
    O16 is decided. This narrows C106.
  - *Alternative (c):* keep O16 procedural — not recommended once 7h is live.
- **O3. Separation of duties inside a club.**
  - **Recommended: no rule.** The same admin may create, submit, activate, replace and disable, as C104 Q6 decided
    for platform admins.
  - Every act is attributed (T8). A club with one admin would otherwise be stuck. J18's one-transaction save depends
    on it.
  - *Alternative:* the activating admin must differ from the submitting one: one-admin clubs could never go live.
- **O4. Which of the club's admins.**
  - **Recommended: any.** Any active admin of the club may replace or disable any version of the club's mappings,
    including one another admin of the club or a platform admin (in support) activated. C108 gives the club its own
    versions without an author restriction, and the platform admin keeps the pinned step and A1 / A2 in the club's
    workspace.
  - *Alternative:* only the activating admin — a club would be stuck when that admin leaves.
- **O5. Q1(c) and the pinned step's cap.** Both were waived for the pilot only (J17 O5, `CURRENT_STATE.md`).
  - **The questions:**
    - Q1(c): refuse to archive a club that holds a `needs_review` or `active` mapping version;
    - the cap: on the versions one pinned step disables.
  - **Why it matters now:** 7h makes active club versions common. An archived club's active version makes the pinned
    step answer `club_archived`, so a field could not be stopped without a database write.
  - **Recommended:** both before more clubs are brought on, each its own small pull request. Neither blocks 7h's
    code, merge or deploy while one club exists.
  - *Alternative:* before 7h's deploy. That costs time now, for a case that needs a second club.
- **O6. How simple the screen becomes for a club admin** (the owner's J16 criterion „mora biti mnogo jednostavnije
  za korisnika”).
  - **(a) In 7h-B:** the club admin gets *Activate*, *Replace* and *Disable* on its own club mappings. That makes J16's
    13 interactions, one person, one workspace — impossible alone today.
  - **(b) A *Save and activate* button on step 4** for whoever may activate, with *Switch on for teams now* inline.
    - It chains the existing writes (create → version → submit → activate, with the starts), each with its own
      request key, under J16's one-write-at-a-time pattern.
    - Each failure point gets its own sentence: a draft or a waiting version is left.
    - About 8 interactions plus the note and the reason.
  - **(c)** J18's board, later, for the club's whole team at once.
  - **Recommended: (a) in 7h-B, and (b) as its own frontend pull request, 7h-F, right after 7h-B.** J18 Q13 may later
    move parameter-less club versions to the board.
  - *Alternative:* (a) only, leaving the simplification to J18 and J16's recorded "Save and submit".

## 12. Decisions for the *Rukovodilac* (R1–R12)

Each has a recommendation.

- **R1. The migration number.** v52; the next free number if another migration lands first. J18's numbers move by one
  (section 9).
- **R2. The two new `else` texts of the T4 guard.**
  - **Recommended:** fixed texts, **not** in `ACTOR_REFUSALS`. They are reachable only by a raw writer, so a
    sanitized 500, as 7d's T5 text.
  - *Alternative:* add them (a 404, like submit's text).
- **R3. The backstop in the version-driven derivation.** The binding's club equals the mapping's club, `23514`,
  checked in the T5 and T8 guards. **Recommended: yes**, tested by a planted row.
- **R4. A promotion after the right was checked again.** **Recommended:** it stays a sanitized 500 with nothing
  written, as accepted for 7d (section 3). It is not mapped to `try_again`.
- **R5. `submitVersion`'s answer order** (the state after the right). **Recommended:** fixed in 7h-B, with a test.
- **R6. A2 and a replacement end activations on an archived team's binding, or on a moved team's ended binding** (not
  a 404). **Recommended: accept** (section 2.3). The scope is the connection's club; starts there stay refused.
- **R7. The pull requests.**
  - **Recommended:**
    - **7h-B:** migration, backend and the minimal frontend, in one ★★ pull request;
    - **7h-V:** O2 (a), before 7h-B's deploy;
    - **7h-F:** O6 (b), after 7h-B.
  - The frontend never ships before the backend.
- **R8. Decision numbers.** C113–C125 stay reserved for J18. **Recommended:** J14's decisions take the next free numbers
  (C126 and on) in the order they are decided.
- **R9. `test:backend:shared`.** **Recommended: not needed.** 7h touches no auth, organization, builder or Tests module,
  and the mapping suites run on disposable databases. It runs on the *Rukovodilac*'s word. It writes to the local
  development database.
- **R10. The deploy window** (section 6.3). The import switch is off, and there is no running check or open approval.
  The preflight's quiet-moment block is the gate.
- **R11. The amendments of section 13.** **Recommended:** made in this contract's acceptance pull request, by marking
  the superseded text, never by erasing it.
- **R12. The screen's predicate.** **Recommended:** a client predicate mirrored by a test, rather than a server
  `actions` hint (no API change).

## 13. What this contract supersedes or amends (once accepted)

| Where | What | How |
|---|---|---|
| Discovery C30 | "only a platform admin" for a club mapping's status changes | superseded for club mappings (C108, J14) |
| Discovery C33 | "the platform admin chooses explicitly which one that binding uses" | amended: the club admin too, for its club's versions (already de facto by C106) |
| Discovery C106, last sentence | "A1, A2 and the revision lifecycle stay the platform admin's" | amended: A1 and A2 on a club mapping are also its club admin's; the lifecycle stays the platform admin's |
| Discovery D6 (`:1563`, `:1583`, `:1602-1607`) | `activated_basis` / `disabled_basis` (`platform_admin`); "every other transition is a platform admin's" | amended: both bases on a club mapping |
| Discovery D10 (`:1806-1809`) | the club-admin column: `mapping_status` "draft → needs_review only", `mapping_version_replaced` blank, `activation_start` / `activation_end` blank | amended: every `mapping_status` transition and `mapping_version_replaced` on a club mapping; activations per C106 |
| J8 (`phase7b`: `:30`, `:171-172`, `:350-352`, R3) | "Only an active platform admin may do either" | amended for club mappings |
| J8 Q7's consequence (`phase7b:574-576`) | "The club's admin can only create and submit one" | superseded: it can also activate one |
| J10 section 2.3 (`phase7d:214-240`) | the basis table; "Unchanged: A1, A2 and the revision lifecycle stay the platform admin's" | amended: section 2.4's third row |
| J10 section 5 (`phase7d:512`) | "A1, A2 and the pinned step lock no club row for their ends … an archive never blocks them" | amended: section 5's club archive row |
| J16 (`phase8`: `:50-51`, `:84`, `:88-90`, `:224-227`, R12 `:464-466`) | the club admin's waiting-version note; "a platform admin only" | superseded by section 8 |
| J17 O16 (`phase9:1033-1036`, `:341`) | "no club mapping is switched on for a team binding" until decided | answered by O2 |
| J18 (`c112`: `:46`, `:182-183`, `:550`) | 7h = v51, 18-1 = v52 | renumbered: 7h = v52, 18-1 ≥ v53 |
| The plan's 7h line (`metrics-core-plan.md:1066-1070`) | "the T8 rules … with the v43 guards" | made exact: v43 and v35 need no change; the T4 guard, the two CHECKs, row_ok and the version-driven ends do |

## 14. Not in this contract

- **7i** (OD7, C109): using, copying and hiding a system variable — J15, after J14 is accepted.
- **C111:** editing a variable in place — its own contract.
- **Any import:** no check, approval or switch change until the end of this track (the owner, 2026-11-02). Approving
  imports by a club admin (v23) is also out.
- **The MEDIUM finding** "a coach of a team whose club is archived still reaches the GPEXE team routes"
  (`CURRENT_STATE.md:3744`) — a separate task.
- **System-mapping transitions;** M2b, conversions, D9, L1–L5 and the pinned step; the instance codes' audience.
- **7d-C** (D3's prepared replacement in L4): it stays the platform admin's when it comes. A club's versions on a new
  revision are then the club admin's to activate (A1), not the lifecycle's.
- **The rest:**
  - J18's board;
  - showing the pinned step's reason to the club (C63 unchanged);
  - team-owned connections (refused by v48);
  - Q1(c) and the cap (O5).

## 15. Review record

- **Discovery** (read-only, 2026-11-02, at `565fe097`): six areas — the database guards, the services and routes, the
  screen, the importer, the documents, and the tests and runbooks — and one completeness critic. The executor
  checked every claim this contract rests on in the code. Five of the discovery's claims were corrected:
  - the m1 suite's asserts do not flip (it stops at v34);
  - 7d `:1076` is a system-version case and stays;
  - a binding's club is immutable (v27), and a team archive does not end bindings;
  - a promotion after the right was checked again is a sanitized 500, not `try_again`;
  - the rollback's hard assertion counts only 7h-only rows.
- Internal reviews of this document (`code-reviewer`, `db-reviewer`, `security-reviewer`): below, after they run.
