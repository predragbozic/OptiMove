# J14 — phase 7h: a club's admin activates, replaces and disables its club's mapping versions (accepted ★★ contract)

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
| Status | **Accepted** by the owner on 2026-11-02: „J14 O1–O6 i J15 O1–O9 po preporuci, odobravam oba ugovora” (owner turn `95c006f2` in the *Rukovodilac*'s chat, 20:16:10 UTC; relayed with its event id by the *Rukovodilac*'s order `011e7d13`, 20:16:22 UTC; the executor checked it in the transcript). Proposed by the executor earlier that day, on the *Rukovodilac*'s order queued at 13:35:02 UTC („počni sa 7h i 7i”; „Ne piši kod ni migraciju dok ne prihvatim ugovor.”); merged as PR #333 (`f0578a72`) from head `3a4f7933` after both ★★ GOs. The decisions are C126–C131 (section 11). The implementation is 7h-B (R7). |
| Verified against commit | `565fe097` (merge of PR #331). Every file and line reference below is to that commit unless it names another. |
| Mark | ★★: external-review triggers 1 (a migration), 2 (auth, role, `owner_scope`, info hiding) and 4 (transactions, lock order, idempotency). Reviewed by the *Rukovodilac* and the *Nezavisni revizor*. |
| The owner's decision | **C108 / OD6** (2026-10-30): „Povezivanje veza i raskidanje veza izmedju varijabli radi pre svega klupski admin, moze i sistemski ali pre svega klupski jer je to njegov posao.” (turn `122a4df5`); „Rekli smo da sam mogu da klupski admin da radi mapiranja, i da preuzima sistemske varijable” (turn `a73981ac`); „znaci promeni u skladu sta sam hteo, ne vidim problem, da li ti vidis” (turn `88ad60ca`). Section 2 is the *Rukovodilac*'s reading of it (discovery C108), made concrete. |
| Owner decisions | **O1–O6** (section 11), decided as recommended on 2026-11-02: **C126–C131** in the discovery document's section C (R8). |
| Decides | The *Rukovodilac*: R1–R13 (section 12) and the acceptance under its order. The owner: O1–O6; for a ★★ phase the owner also approves the contract before any code (`metrics-core-plan.md`, section 3, A1). |
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
  including support in club X's workspace on the basis `platform_admin` — which, as today, needs a platform admin who
  also holds club X's admin role (section 2.1). Everyone else gets the identical 404.
- **Where the refusals sit today** (section 1.2): the route and service gate `mayTransitionMappings`; v34's T4 update
  guard (two `source_metric_require_platform_admin` calls); v34's two T4 basis CHECKs; T8's `source_metric_audit_row_ok`
  (v48 body) for three branches; and the club-less basis of a version-driven activation end (v48's T5 update guard and
  T8 actor guard, plus a constant in the service). v35's actor guards, v43's G1 and G2 and v48's T8 insert guard
  already handle `club_admin` and are **not** changed.
- **v52** widens the two CHECKs and replaces four function bodies in place, each behind an md5 precondition: v34's T4
  update guard, v48's `source_metric_audit_row_ok`, v48's T5 update guard and v48's T8 actor guard. It also rewrites
  T4's table comment. It adds no table, column, trigger or index. Its rollback refuses once a row only 7h can write
  exists.
- **The service** changes one predicate (`mayTransitionMappings`), lets the version-driven ends carry the caller's
  basis, and locks a club admin's `users` row before its role row in `rightsStillHold`, which removes a deadlock with
  a club-admin revocation that exists today (section 5). The replay, the request record and the COMMIT discipline are
  7b's and 7d's, unchanged.
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
would look like information hiding. A plain A2 of a `draft` or `needs_review` version (no open activation) stops at
v34 `:1204` with the same text, also the identical 404. A2 or a replacement of a version with open activations would
stop at the T5 end first (v48 `:222` derives the basis, `:224-225` raise a text not in `ACTOR_REFUSALS`) and answer a
sanitized 500.

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
- **A team archive does not end its bindings**: the only code that ends a binding is the Unbind
  (`backend/src/sourceConnectionService.js:513`, the only `update` of `source_team_bindings`; a bind inserts, `:997`).
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

**Platform support in a club, as it is today and stays:** a club workspace exists only for a user's own `club_admin`
role (`backend/src/workspace.js:46-58`), so a platform admin acts on one club version only if it also holds club X's
admin role. It may grant itself that role (`canManageClub`, `authz.js:131-133`; `grantClubAdminRole`,
`routes/organization.js:2506-2537`). The grant is stamped on the role row (`granted_by_user_id`), and a later re-grant
overwrites it: it is not an append-only log. The mapping acts it then performs are in T8 with the basis
`platform_admin`. Without the role, its levers on a club's versions are blunt: the pinned
step (every version on a revision), an Unbind of the team's binding, and D9. There is no platform veto on a single
club version without that grant.

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
- a coach, a private coach, an athlete, a user with no role;
- club X's admin on a system mapping, on a version of another mapping, or on an unknown id;
- a user who holds both roles, in the platform workspace, on club X's mapping (that workspace's owner is the system);
- a replay from another workspace.

An inactive user gets the router's 401, as today.

**Not a 404 (R6).** The Rukovodilac's order says "only on a binding of that club's team". The database rule is "a
binding of a connection the club owns" (section 1.4). The two differ in two cases:

- **A1's starts.** On a binding outside the scope or of an archived club they are the identical 404
  (`assertListedBindingsInScope`, `sourceMetricActivationSteps.js:80-96`), and on an archived team or a missing binding
  too (`lockListedBindings`, `:113-118`), as for S1 today.
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

**The order of the answers for a club admin** (J8's order, as the code runs it: `routes/sourceMetrics.js:241-255`,
`sourceMetricMappingService.js:1368-1397`, `:1525-1534`, then `runWrite` `:779-791` and the operation's body):

1. no session → 401;
2. no context, or a context the gate refuses → the identical 404, before the body;
3. 415, then 400 `invalid_body` for a non-object;
4. a malformed id → the identical 404;
5. 400 per body rule;
6. the request record, looked up by the caller's own user and key after the per-user lock:
   - another action or hash under the same key → `409 request_key_reused`;
   - the same → the replay: the right is checked again, then the current state is read through the owner filter
     (`writableVersion`, `:707-715`) — the identical 404 when it is outside the workspace;
7. the owner-filtered read (`transitionTarget`, `:1274-1288`) → the identical 404 for a system mapping, another
   club's mapping, a version of another mapping or an unknown id;
8. the locks;
9. the right checked again;
10. the state refusals (`version_not_submitted`, `active_version_changed`, `version_status_changed`, …), only after
    the right is confirmed.

The 400s of step 5 and the 409 of step 6 come before the owner-filtered read. Neither reveals anything of another
tenant: a 400 does not depend on the id, and the request record is the caller's own (`performed_by_user_id`), so
`request_key_reused` depends only on the caller's own earlier requests. The same order holds today for a platform
admin in the platform workspace who names a club mapping (7b test 9). Tests use a fresh request key per attempt, or
assert the 409 for a reused key on purpose.

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
- If it commits after that check and before the writes, the first guard to see the new role refuses: v52's T5 guard
  ("source metric activation: the acting user may not write this activation", for a replacement or a disable with
  open activations) or v35's T4 actor guard ("the basis is not the acting user's own"). Neither text is in
  `ACTOR_REFUSALS`, so the answer is a sanitized 500 with nothing written, as discovery `:4053-4054` already accepts
  for 7d. (M3-0 maps its own basis text to `try_again`, `canonicalVariableAdminService.js:765-774`; here the race
  meets two guards, and the T5 text is shared with genuine refusals, so a partial mapping would be inconsistent.)

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
   - `users` and `user_club_roles` `FOR SHARE` (7h-B changes the order to users first, section 7; today it is the role
     row first);
   - the club `FOR SHARE`;
10. the writes and A1's listed starts, in J10 section 4.3's order (`sourceMetricMappingService.js:1458-1500`):
    - the T5 ends;
    - the T4 status changes (N disabled, then N+1 activated);
    - A1's listed starts: the bindings `FOR SHARE`, then their teams `FOR SHARE`, then the bindings' clubs `FOR SHARE`
      (`bindingClubHolds`), then the checks and the T5 inserts;
    - the unkeyed T8 rows;
    - the keyed T8 row last.

Any refusal in step 10 throws and rolls everything back. The right and the workspace's club are held from step 9.
The starts' locks re-check, under lock, the plain-read decision of `activationInScope`: an archived team or club, or
an ended binding, is still the identical 404 there (`sourceMetricActivationSteps.js:106-130`, `bindingClubHolds`).
They add no new decision for a club admin, and they serialize with an Unbind, a team archive or a club archive.

The triggers derive the basis again on the rows step 9 already holds. v52 **adds** a T3 `FOR SHARE` read to v34's
disable branch, before its role check (section 6.1); v34 has none there today. v35's T4 actor guard already reads T3
`FOR SHARE` after the T4 row lock on every transition (v35 `:152-161`), so for a raw writer the only change is that
T3 now comes before the rights rows inside the trigger chain, as the activation branch already does. A1 and A2 hold
T3 `FOR NO KEY UPDATE` from step 5 and the pinned step holds T3 `FOR SHARE` (`sourceRevisionLifecycleService.js:196-209`),
so on every service path the re-lock is a no-op.

The rights rows come after every registry row, as the importer's step 6b does (J17 R5). No 7h write takes the team
import lock, a binding `FOR UPDATE` or the Metrics Core connection.

## 5. Concurrency

This table adds the club admin's rows to J10 section 5. **It amends J10's row "A1, A2 and the pinned step lock no club
row for their ends … an archive never blocks them"**, which is false for a club admin.

| Against | Outcome |
|---|---|
| Club X's admin's A1 against another admin of club X (or a platform admin) on the same mapping | They serialize at T3, the first row each takes `FOR NO KEY UPDATE` (after shared locks on the conversions and T2a / T2b). The second reads the new state after its right is confirmed: `version_not_submitted` when both target the same version (`sourceMetricMappingService.js:1429`), `active_version_changed` when they target different versions (`:1430`), `version_status_changed` for an A2. |
| A2 or a replacement against S2 ending the same activation | J10's row, unchanged: they serialize at T3 (or at T4 for the pinned step) before the T5 row. |
| Club X's admin's A1 or A2 against the pinned step (L4 / L5) on the pinned revision | They serialize at T2b (`FOR UPDATE` against `FOR SHARE`), then at T3 and T4 in the same order. If the pinned step goes first, the A1 / A2 reads a disabled version or a retired revision. If the A1 / A2 goes first, the pinned step disables what it finds. |
| **A club archive** against club X's admin's A1 / A2 | The club row is held `FOR SHARE` in step 9, and again in the triggers' `source_metric_actor_basis`. The archive waits for the write, or lands first, and the write then answers the identical 404. The archive takes no T3, T4, T5 or binding lock, so no cycle forms. |
| **A club-role revocation** against club X's admin's A1 / A2 | The revocation (`revokeClubAdminRole`, `routes/organization.js:2549-2589`; `loadQualifyingClubAdminUserIds`, `:2430-2437`) locks `for update of u, r`: the `users` row first, then `user_club_roles`. **Today** `rightsStillHold` locks `for share of r, u` (`sourceMetricAccess.js:134-137`): the role row first. PostgreSQL locks a row's relations in the order of the `OF` list, whatever the join plan, so the two orders can deadlock. The internal review reproduced it on a disposable PostgreSQL: 3 of 3 runs ended in `40P01`, with the revocation as the victim (its route answers 500). The same inversion exists today for every club-admin write that checks its right again (mappings, activations, canonical variables, classification; section 7). **7h-B** changes `rightsStillHold`'s club-admin query to `for share of u, r` (section 7): the same order as the revocation, so one waits for the other and no cycle forms. With that fix the reviewer's reproduction ran without a deadlock in 3 of 3 runs. The triggers' later `r, u, c` re-locks (`source_metric_require_club_admin`, `source_metric_actor_basis`) find both rows already held, so they add no wait. If the revocation lands first, the write answers the identical 404 with nothing written. |
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
   - if it is a club mapping, refuse when `source_metric_binding_club(new.source_team_binding_id) is distinct from
     owner_club_id` (`23514` "source_metric_mapping_activations: a club version's activation is on another club's
     binding", R3) — `is distinct from`, so a binding with no club (the function's NULL) is refused too, never passed —
     and then `basis := source_metric_actor_basis(actor, owner_club_id)`.

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

**One catalog comment changes:** T4's table comment (v34 `:899-900`) says "only a platform admin activates or
disables". v52 replaces that clause, as v48 replaced T5's: "… draft -> needs_review -> active -> disabled; activated
or disabled by a platform admin and, for a club mapping's version, also by its club's active admin (v52, C108, J14).
parameter_fingerprint is computed by the database." T5's table comment (v48 `:101-102`) already names both and stays. The T5 guard's explanation is a code
comment inside its body (v48 `:208-213`), rewritten with the body. No column or function comment exists for these
objects, and v52 adds none.

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

Three of the four values equal the constants v48's rollback already restores against
(`docs/runbooks/mapping-activations-v48-rollback.sql:109-114`); the fourth, v34's T4 update guard, was computed the
same way. It also refuses unless both CHECK definitions are v34's (`pg_get_constraintdef`).

J18's later migration md5-checks the bodies in force (`c112-drag-mapping-contract.md:550`). After v52 its baselines
are v52's bodies; J14's 7h-B records them in its "As built".

### 6.3 Locks and the window

- v52 takes, in this order:
  1. T4 `access exclusive` (the CHECK swap; it scans T4, which holds production rows since M6);
  2. T5 `share row exclusive`;
  3. T8 `share row exclusive` (the replaced trigger functions, to serialize with their writers, as v48 and v50 did).
- The old instance keeps serving while the new one migrates (`npm start` runs the migrator before the server). A
  queued `access exclusive` request makes every later reader of T4 wait behind it — the Mappings screen, A1, A2, S1,
  S2 and the importer — up to the runner's `lock_timeout` (30 s, `backend/src/migrate.js:543-547`), after which the
  migration fails with nothing applied. **v52 takes the T4 lock with `nowait`** (R10): a busy T4 fails the migration at
  once, nothing is applied, the old instance keeps serving, and the deploy is repeated at a quiet moment. T5 and T8
  take the runner's bound as v48 and v50 did.
- The importer reads T4 `FOR SHARE` at an approval and in a check's preview. So **the deploy window needs the import
  switch off, no running check and no open approval**, and the deploy follows the preflight's quiet-moment block at
  once. With the switch off since M6 and no check until the end of this track (the owner's order of 2026-11-02), this
  holds by default.
- `NOT VALID` plus `VALIDATE` gains nothing on a table this small.
- The order T4 → T5 → T8 forms no cycle with any writer: A1, A2, S1 and S2 take T4 before any T5 write, the importer
  T4 before T5, and the pinned step T3, T4, T5.

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
4. the two CHECK definitions are v34's, and T4's table comment is v34's text (`obj_description(…, 'pg_class')`);
5. no disabled trigger on T4, T5 and T8, and no v52 object collision;
6. the migrator role owns T4, T5 and T8 and the four functions v52 replaces;
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
3. the two widened CHECK definitions, and T4's table comment is v52's text;
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
    `mapping_version_disabled`);
  - a T8 `activation_end` row with basis `club_admin` whose activation's `end_reason` is one of those two (implied by
    the T5 row unless triggers were disabled; counted anyway).

It does **not** refuse on the `club_admin` rows that 7d and M2 already write: `mapping_create`,
`mapping_version_create`, `draft → needs_review`, `activation_start`, and `activation_end` with `admin_ended`.
Otherwise it restores v34's two CHECKs, v34's T4 table comment verbatim and the four bodies byte for byte, and
deletes v52's record.

**Rehearsed** in 7h-B's suite: apply → rollback → the v51 catalog exactly (comments included) → re-apply → the v52
catalog exactly. A migration whose last statement fails leaves nothing behind.

**The files of 7h-B's runbook:** the three SQL files above, `docs/runbooks/club-mapping-transitions-v52.md` (the
steps, as v48's and v50's), and a `.gitattributes` line `docs/runbooks/club-mapping-transitions-v52*.sql text eol=lf`.
The owner's checkout uses `core.autocrlf=true` (`.gitattributes:3`), and the rollback and the post-check compare
function bodies by md5, so a CRLF checkout would break them. The test asks `git check-attr eol` for the three SQL
files, not only the bytes of a Linux worktree. v52's file name sorts after `202611011900_calendar_v51_settings.sql`:
the runner and the refusals compare migration names.

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
- **`rightsStillHold`'s club-admin query** (`sourceMetricAccess.js:134-137`) locks `for share of u, r` instead of
  `r, u`: the `users` row first, as the club-admin revocation does (`routes/organization.js:2430-2437`, `for update of
  u, r`) (R13; section 5). The rows, the conditions and the answers stay the same; the triggers' `r, u, c` re-locks
  find both rows held. It changes the lock order of **every caller of that branch with a club-admin context**:
  - the mapping service: M2's writes, A1 and A2;
  - the activation service: S1 and S2;
  - the canonical-variable service (`canonicalVariableAdminService.js:626`, `:702`, `:803`: M3-0 and R2 writes);
  - the classification service (`canonicalClassificationService.js:370`, `:394`, `:563`, `:616`).

  **Not changed in 7h-B, and recorded as a separate task (the "lock order" pull request; the *Rukovodilac*'s
  decision of 2026-11-02):** the same role-first inversion stays in these queries.
  - **Club-admin branches, against `revokeClubAdminRole` (`for update of u, r`, `routes/organization.js:2430-2437`):**
    - `sourceConnectionService.js` `rightsStillHold`, `:216` (`user_club_roles r … for share of r, u`);
    - `gpexeAthleteIdentityService.js` `rightHolds` with `lock = true`, `:155` and `:158` (`user_club_roles r …
      for share of r, u`);
    - `coachRightsStillHold`'s club-admin probe, `sourceMetricAccess.js:165` (`for share of r, u, c`).
  - **Platform-admin branches, against `loadQualifyingPlatformAdminIds` (`for update of u, g`,
    `routes/organization.js:522-531`, the platform-admin revocation and the login disable):**
    - `sourceMetricAccess.js` `rightsStillHold`'s promotion probe and platform branch, `:123` and `:131`, and
      `coachRightsStillHold`'s platform probe, `:157` (`for share of g, u`);
    - `sourceConnectionService.js` `rightsStillHold`, `:211` (`for share of g, u`);
    - `gpexeAthleteIdentityService.js` `rightHolds`, `:155` and `:157` (the global role is aliased `r`: `for share
      of r, u`);
    - `routes/exerciseCollections.js:191-193` (the global role aliased `r`: `for share of r,u`).
  - **The team-coach branch:** `coachRightsStillHold`, `:177` (`user_team_roles r … for share of r, u`); the lock
    order of a team-coach revocation is not checked here, and the lock-order pull request checks it first.

  7h does not make those paths more common: none of them is a mapping transition. The lock-order pull request turns
  every one of them into users first (`u, r`, `u, g`, `u, r, c`), with route-against-route tests for each revocation
  it meets. It comes right after 7h-B and before more clubs are brought on.
- **`submitVersion`** answers its state refusals (`409 version_not_draft` with `current.status`, `:1210`, and
  `409 revision_not_usable`, `:1211`) only after `rightsStillHold` (`:1212`), as A1 and A2 do (R5). This is a
  pre-existing ordering gap: a caller who lost the right meanwhile could see the current status or a revision refusal
  instead of the identical 404.
- **The comments** at `sourceMetricAccess.js:33-37`, `sourceMetricMappingService.js:1226-1244`,
  `routes/sourceMetrics.js:236-240`, `sourceMetricActivationSteps.js:240-242` (`endAuditRows`) and
  `frontend/metric-mappings-data.js:3-4` state the new rule.
- **No change to:**
  - `resolveMappingAdminWith`, `activationInScope`, `bindingClubHolds`, and the rest of `rightsStillHold`;
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
  - For any non-null context this equals `inOwnerWorkspace(mapping, ctx)`: a context exists only for the platform
    workspace (always a platform admin) or a club workspace (`frontend/metric-mappings-data.js:23-32`), and in a club
    workspace a club mapping is always the workspace's own club's, because the server reads only those owner keys
    (`readableOwnerKeys`, `sourceMetricAccess.js:109`; `transitionTarget`, `sourceMetricMappingService.js:1284`). It is
    written out anyway, so a later context kind cannot widen it.
  - The client's `isPlatformAdmin` comes from the workspace list; the server derives the basis from the roles. One
    shared fixture table (workspace, roles, mapping owner — including a user who holds both roles, and a platform
    admin in a club workspace on a system mapping) is asserted against the server's `mayTransitionMappings` plus the
    owner filter in the backend suite, and against the client predicate in the frontend suite (R12: no new API field).
  - With it, club X's admin gets, on club X's own mappings: *Activate* (with the optional *Switch on for teams now*
    chooser, preset to the club), *Replace version N* (*Keep these teams*), *Disable* on draft, waiting and active
    versions, the primary act *Activate*, and "You can activate it now." after a submit.
  - On a system mapping in the club's workspace nothing changes: *Switch on for teams*, *Switch off* and *Check*
    only, with "A platform administrator activates system mappings in the platform workspace."
- **Sentences:**
  - **the club intro** (`metric-mappings-view.js:97`): "System mappings come from a platform administrator; you switch
    them on for your teams. You activate your club's own mappings yourself.";
  - **step 4** (`:276-278`) has no mapping yet, and a draft is always made in its owner's workspace, so the sentence
    becomes the same for every caller who reaches step 4: "…submit it for review, then you can activate it.";
  - **the dead note** "Ask a platform administrator who also administers <club>…" (`:363-364`) is removed;
  - **the meaning blocker** (`activateBlocker`, `actions.js:275`) gets the next step for a club workspace: "A
    platform administrator confirms it in the platform workspace." (the pattern of `view.js:171`);
  - **a missing conversion** gets "Ask a platform administrator to add it." **in a club workspace only**, added in the
    view as `view.js:171` does for its sentence (`ctx.owner !== "system"`), not in `data.js:284` — a platform admin is
    the one who adds it;
  - **the Imports screen's step for `mapping_not_usable`** (`SETUP_MAPPINGS_STEP`, `frontend/gpexe-import-view.js:1516`):
    only its last sentence ("If both look right, ask a platform administrator …") changes, to "If both look right,
    your club's admin fixes the club's own mappings, and a platform administrator fixes system mappings and field
    confirmations (give them the Technical details)." The binding check and "find new sessions" stay.
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
- a coach, an athlete, a private coach (`workspace.js:42-44`), a user with no role;
- a platform admin in a team workspace; a revoked platform admin;
- a user who holds both roles, in the platform workspace, naming its own club's version (the identical 404: the
  platform workspace's owner is the system).

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
- **caA on any other target** → the identical 404, as section 3 orders it. "Identical" is asserted by deep equality
  of the status, the body and the headers (`Cache-Control: no-store`, no `Retry-After`) across a missing id, a system
  version, another club's version and a foreign binding (`testing-evidence.md`).
- **Every other actor on club A's versions** → the identical 404 (401 for no session and an inactive user), nothing
  written, the key left free.
- **A platform admin in club A's workspace** → 200 with basis `platform_admin` (unchanged).
- **caA on the platform-only routes** → the identical 404 (unchanged).

### 10.3 Direct SQL (each asserting the SQLSTATE, the fixed message and which guard fires first)

v34's guard fires before v35's by name, so each case must reach the layer it tests. A CHECK must never mask a
mutated trigger.

1. Club A's admin activates, disables and replaces a club A version, with its T8 rows → passes.
2. A wrong basis, each at the layer that fires first:
   - club A's admin writes T4 with basis `platform_admin` → `42501` from v34's guard,
     `source_metric_require_platform_admin`'s text ("the acting user is not an active platform admin");
   - a user who holds both roles writes T4 with basis `club_admin` → passes v34's split (`require_club_admin` does
     not exclude a platform admin), then `42501` from v35's T4 actor guard, "the basis is not the acting user's own";
   - club A's admin writes T4 with `club_admin` (passes) and its T8 row with `platform_admin` → `42501` from v48's T8
     actor guard, "the basis is not the acting user's own".
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
7. The R3 backstop, with planted rows (triggers off for the plant only): a club version's activation on another
   club's binding, and one on a binding whose connection is not club-owned (the function's NULL) → `23514` in the T5
   guard and in the T8 actor guard.
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
- **The service locks the rights rows before any trigger does** (the *Nezavisni revizor*'s note): the database
  functions `source_metric_actor_basis` and `source_metric_require_club_admin` lock `r, u, c`, the role row first, so
  they are safe against a revocation only because the service has already taken `users` and `user_club_roles` in
  `rightsStillHold` (`u, r`). A test asserts it for A1, A2 and A1's replacement: at the write hold seam (after
  `rightsStillHold`, before the first T4 / T5 write and so before any trigger), a peer's `select … for update nowait`
  on the admin's `users` row and on its `user_club_roles` row each fails with `55P03`. A mutation that moves the right
  check after the writes must fail this test.
- The rights hold seam (`setRightsHoldForTests`, before the right is checked again), for A1 plain, A1 replacement with
  starts, and A2 with open activations:
  - role revoked, club archived or user deactivated during the write → the identical 404; nothing in T4, T5 or T8;
    the key free;
  - a promotion → `409 try_again`; the retry writes `platform_admin`.
- The write hold seam (`setMappingWriteHoldForTests`, after the right was checked, `sourceMetricMappingService.js:1460`,
  `:1554`):
  - a promotion committed there → a sanitized 500, nothing in T4, T5 or T8, the key free; the retry writes
    `platform_admin` (R4);
  - a club-role revocation from a peer client there → it waits on the rows the write holds and lands after the
    COMMIT. The write's T4, T5 and T8 rows are committed; its HTTP answer is 200 or the identical 404 (the answer
    checks the right again after the COMMIT, section 3), never anything else; a replay with the same key after the
    revocation answers the identical 404.
- **The real revocation route against the real write** (db review F2), as the reviewer reproduced it, made
  deterministic:
  - club A has at least two active admins (a lone admin's revocation answers `409 LAST_CLUB_ADMIN` and revokes
    nothing, `routes/organization.js:2568-2574`);
  - a third client holds the revoked admin's `users` row `FOR UPDATE` in an open transaction;
  - the revocation route (`revokeClubAdminRole`) is observed queued on it (`pg_locks` / `pg_stat_activity`);
  - then A1 plain (or A2 with open activations) is released by the rights hold seam into `rightsStillHold`;
  - the third client commits.

  That is the order "revocation queued first". **The other order:** A1 is held by the write hold seam after
  `rightsStillHold` (it holds `users` and `user_club_roles`); the revocation is sent and observed waiting in `pg_locks`;
  the hold is released.

  In both orders: no `40P01`. When the revocation wins, the write answers the identical 404 with nothing written.
  When the write wins, its rows are committed and its answer is 200 or the identical 404, as above, and the
  revocation then succeeds. With the old `r, u` order the first order must deadlock (the mutation in 10.6).
- `submitVersion` by a caller whose right was revoked during the request → the identical 404, never
  `version_not_draft` or `revision_not_usable` (R5).
- The COMMIT trio on a club admin's replacement with starts and on A2 with open activations:
  - `verified_after_commit_error`;
  - `outcome_unknown`, then a replay;
  - a definite refusal at the COMMIT, with nothing written and the key free:
    - A1's replacement: the existing `split_operation` fault (v43 G1; `setMappingTransitionAuditFaultForTests`,
      `sourceMetricMappingService.js:1254`, read only in the replacement branch, `:1503`);
    - A2 with open activations: **a new fault kind of the same seam, `skip_end`**, which passes the ended rows minus
      the first to `endAuditRows` in A1 and A2, so v48's deferred end link refuses at the COMMIT. No A2 seam exists
      today; the activation service's own `skip_end` (`sourceMetricActivationService.js:57`) reaches S2 only.
- A replay after the role was revoked → 404. A cross-workspace replay by the A+B admin → 404.
- The importer (J17): caA's A2 and caA's replacement with starts against an approval, both orders:
  - import first → the transition waits;
  - transition first → the approval answers `preview_changed` with nothing stored.
- caA activates its club's version, switches it on, and an import writes through it (section 1.5).
- **The leak scan:** no reason, actor id, club id, trigger or SQL text in any answer or log line.

### 10.5 The migration rehearsal

1. **The preflight blocks** on the rehearsal database, with planted rows that flip each hard assertion.
2. **Apply** through the runner while a reader holds T5 (and, separately, T8): assert that it waits within the
   runner's `lock_timeout` and applies, with no deadlock. A reader on T4 is item 10.
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
9. `git check-attr eol` gives `lf` for the three runbook SQL files and the migration (section 6.5).
10. A busy T4 (a reader holding it) fails v52 at once through `nowait`, with nothing applied (section 6.3).

### 10.6 Mutations (each killed by a named test)

**The service:**

- `mayTransitionMappings` back to platform-only;
- `mayTransitionMappings` widened to `club_admin` on a system scope, or to any basis;
- the route gate moved after the body check;
- the owner filter dropped from `transitionTarget` (`m.owner_key`, `:1284`), and separately from `writableVersion`
  (`:711`, the replay path) — the single application-level barrier between a club admin and a system or other club's
  mapping;
- `activationInScope` ignoring `bindingClubId` in a club workspace — killed by 10.2's "caA with a listed club B
  binding → the identical 404, nothing written";
- the `skip_end` fault kind ignored in A2 (the definite-refusal test of 10.4 must then fail);
- `rightsStillHold`: the club-role query always true; the club row check dropped; the promotion probe removed; the
  club-admin query back to `for share of r, u` — killed **only** by R13's route-against-route revocation test of 10.4
  (the *Nezavisni revizor*'s note on `3a4f7933`): a test that checks the rights before the triggers holds both rows
  and cannot see their order, so 7h-B's packet names that test as the one that kills this mutation;
- `endOpenActivations` / `endAuditRows` back to the constant;
- the pinned step passing a caller's basis other than `platform_admin`;
- `submitVersion`'s state refusals moved back before the right.

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
  - the R3 backstop dropped, or written with `<>` (a NULL club passes);
- T4's table comment not restored by the rollback.

**The rollback:**

- the 7h-only row refusal dropped;
- its exemption of 7d / M2 rows dropped.

**The frontend:** `mayTransition` back to platform-only.

### 10.7 Existing suites

**Changed:**

- **7b test 8** (`source-metric-mapping-transitions-7b.test.mjs:655-668`). Today its title says "a club admin gets
  the identical 404 before the body is looked at", and its rows (`:664-667`) use `W.caA` on club A's own version.
  After 7h-B those rows fail (415 ≠ 404), so:
  - the four rows move to an actor with no admin context — a coach, an athlete, a private coach or an admin in a
    team workspace — still the identical 404 before the body, and the title says so;
  - new rows pin caA (415, then 400) and caB (415 / 400, then the identical 404 for a well-formed request on club A's
    version; section 3).
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
  - `--file` for the other callers of `rightsStillHold` (section 7), also not in the preset:
    `metric-variables-m3-0.test.mjs`, `canonical-variables-r2.test.mjs`, `canonical-classification-12b.test.mjs`,
    `classification-icons-1c.test.mjs` and `metric-variable-icon-1b.test.mjs` (every disposable suite that imports the
    access, mapping, activation, variable or classification services and is outside the gpexe preset);
  - `test:frontend:fast`;
  - the frontend build.
- `test:backend:shared` only on the *Rukovodilac*'s word (R9).

## 11. Questions for the owner (O1–O6)

Each has a recommendation, the consequence and the alternative. **All six were decided as recommended by the owner on
2026-11-02** („J14 O1–O6 i J15 O1–O9 po preporuci, odobravam oba ugovora”, turn `95c006f2`): O1 → **C126**, O2 (a) →
**C127**, O3 → **C128**, O4 → **C129**, O5 → **C130**, O6 (a) in 7h-B and (b) as 7h-F → **C131**.

- **O1. The scope is the *Rukovodilac*'s reading of C108.**
  - **Recommended: accept section 2 as written.** Club X's active admin, in club X's workspace, activates, replaces
    and disables club X's own mapping versions, with A1's listed starts on club X's bindings and the ends those
    write. System mappings, unit and meaning, conversions, D9 and the revision lifecycle stay the platform admin's,
    and the platform admin keeps everything it has today. Support on one club version needs, as today, a platform
    admin who also holds club X's admin role (it may grant itself that role; the grant is stamped on the role row, not
    in an append-only log); without it, the platform's
    levers are the pinned step, an Unbind and D9 (section 2.1). There is no platform veto on a single club version
    without that grant.
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
    audience, which already lists, renames, archives and restores the club's variables, and already sees their names
    in the import preview through R17), sees the club variable's name and unit in that team's activity results. The
    read change is its own small pull request (7h-V), merged and deployed before 7h-B's deploy, under these rules:
    - **the predicate** is C99's, `resolveVariableEditor` (`canonicalVariableAdminService.js:735-763`: the team, the
      club, the coach role and the user all active, from the active team workspace), as R17 already uses it
      (`routes/gpexeImport.js:39-50`); `catalogVisibilitySql` (`trainingLoadMetricsAccess.js:116-134`) is **not**
      touched — it is built from every role the user holds, not the workspace, and it also gates measurement writes;
    - **what is returned** is only the name and unit of definitions that appear in results the caller already reads,
      never the club's catalog, and only for a definition with `owner_scope = 'club'` whose `owner_club_id` equals
      the team's club (an athlete's older results, from another club's membership, can carry another club's
      variable; `public.athlete_membership_periods`);
    - **where:** every screen that names a result's variable — the Activities drawer, the calendar and the dashboards
      (`training-load-calendar-view.js`, `training-load-analysis-data.js`), listed exactly in 7h-V's contract section;
    - **athletes:** unchanged by 7h-V; whether an athlete's own results name a club variable is decided separately if
      it ever arises;
    - **tests:** a coach of another club's team, and the same coach in a second team's workspace, get no name; nor
      does a result row of an athlete in the coach's team that carries another club's variable.
    - **As built (7h-V):** section 16 — the screens exactly, the roster narrowed (V1), the dashboards unreachable, and
      the path by which another club's variable reaches a team's results (a dual-role writer, not an older membership).
  - *Alternative (b):* defer O16, and 7h-B carries a code guard: S1 and A1's listed starts refuse a club mapping until
    O16 is decided. This narrows C106.
  - *Alternative (c):* keep O16 procedural — not recommended once 7h is live.
- **O3. Separation of duties inside a club.**
  - **Recommended: no rule.** The same admin may create, submit, activate, replace and disable, as C104 Q6 decided
    for platform admins.
  - Every act is attributed (T8). A club with one admin would otherwise be stuck. J18's one-transaction save depends
    on it.
  - **The compensating control:** an active mapping writes nothing by itself. Importing stays separately approved by
    an active platform admin or a coach with the team's grant (v23), and an approval recomputes the preview under the
    locks (section 1.5).
  - *Alternative:* the activating admin must differ from the submitting one: one-admin clubs could never go live.
- **O4. Which of the club's admins.**
  - **Recommended: any.** Any active admin of the club may replace or disable any version of the club's mappings,
    including one another admin of the club or a platform admin (in support) activated. C108 gives the club its own
    versions without an author restriction. The platform admin keeps the pinned step, and A1 / A2 in the club's
    workspace when it also holds the club's admin role (section 2.1).
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
  **Decided as recommended (C131):** 7h-F may come right after 7h-B. The *Rukovodilac*'s order of 2026-11-02 (event `783e3591`,
  correcting its earlier `011e7d13`) adds only that 7h-F and the lock-order pull request come in either order after
  7h-B, and that 7i-B waits for the lock-order pull request.
  - *Alternative:* (a) only, leaving the simplification to J18 and J16's recorded "Save and submit".

## 12. Decisions for the *Rukovodilac* (R1–R13)

Each has a recommendation. **Decided by the *Rukovodilac* on 2026-11-02 (its GO on `44e47340`): R1–R13 as
recommended.** R13 was widened by J15's R13 (the *Rukovodilac*'s decision of 2026-11-02, its GO on J15's `aa0b2589`,
event `360823e4`; recorded in J15 section 13): the lock-order pull request also moves A1 to D's order — its listed
bindings and teams before its rights, every lock before its first end — with a route-against-route test of A1 against
an Unbind and a club-admin revocation; and **the order of the pull requests is mandatory: 7h-B → the lock-order pull
request → 7i-B** (7h-V before 7h-B's deploy; 7h-F right after 7h-B, as O6 decides (C131), before or after the
lock-order pull request — the *Rukovodilac*'s order of 2026-11-02, event `783e3591`).

- **R1. The migration number.** v52; the next free number if another migration lands first. J18's numbers move by one
  (section 9).
- **R2. The two new `else` texts of the T4 guard.**
  - **Recommended:** fixed texts, **not** in `ACTOR_REFUSALS`. They are reachable only by a raw writer, so a
    sanitized 500, as 7d's T5 text.
  - *Alternative:* add them (a 404, like submit's text).
- **R3. The backstop in the version-driven derivation.** The binding's club must not be distinct from the mapping's
  club (`is distinct from`, so a binding with no club is refused too), `23514`, checked in the T5 and T8 guards.
  **Recommended: yes**, tested by planted rows.
- **R4. A promotion after the right was checked again.** **Recommended:** it stays a sanitized 500 with nothing
  written, as accepted for 7d (section 3). It is not mapped to `try_again`: the race meets the T5 guard or the T4
  actor guard, and the T5 text is shared with genuine refusals.
  - *Alternative:* map the one T4 / T8 basis text to `409 try_again`, as M3-0 does for its own text — partial, since a
    replacement or a disable with open activations meets the T5 text first.
- **R5. `submitVersion`'s answer order** (`version_not_draft` and `revision_not_usable` after the right).
  **Recommended:** fixed in 7h-B, with a test.
- **R6. A2 and a replacement end activations on an archived team's binding, or on a moved team's ended binding** (not
  a 404). **Recommended: accept** (section 2.3). The scope is the connection's club; starts there stay refused.
- **R7. The pull requests.**
  - **Recommended:**
    - **7h-B:** migration, backend and the minimal frontend, in one ★★ pull request;
    - **7h-V:** O2 (a), before 7h-B's deploy;
    - **7h-F:** O6 (b), after 7h-B.
      **Decided as recommended (C131):** right after 7h-B; before or after the lock-order pull request (event `783e3591`).
  - The frontend never ships before the backend.
- **R8. Decision numbers.** C113–C125 stay reserved for J18. **Recommended:** J14's decisions take the next free numbers
  (C126 and on) in the order they are decided.
- **R9. `test:backend:shared`.** 7h-B changes a shared rights re-check (`rightsStillHold`, R13), which the canonical
  variables and the classification — Metrics Core, non-GPEXE Training Load — also call; `agent-efficiency.md` §6 asks
  for `test:backend:shared` for such a change. **But no shared-kind suite reaches the changed code:** none of the 46
  files that `node scripts/test-runner.mjs --project backend --list` marks `shared` imports `sourceMetricAccess.js`,
  `sourceMetricMappingService.js`, `sourceMetricActivationService.js`, `canonicalVariableAdminService.js` or
  `canonicalClassificationService.js` (grep of their imports at `565fe097`); every suite that does is disposable and
  runs by `--file` (section 10.8). **Recommended:** run the disposable suites; `test:backend:shared` only on the
  *Rukovodilac*'s word, since it writes to the local development database. 7h-B's packet repeats that grep.
- **R10. The deploy window** (section 6.3). The import switch is off, and there is no running check or open approval;
  the deploy follows the preflight's quiet-moment block at once. **Recommended:** v52 takes T4 with `nowait`, so a
  busy table fails the migration at once (nothing applied, the old instance serving) instead of stalling every T4
  reader for up to 30 s.
  - *Alternative:* the runner's 30 s `lock_timeout`, as v48 and v50.
- **R11. The amendments of section 13.** **Recommended:** made in this contract's acceptance pull request, by marking
  the superseded text, never by erasing it.
- **R12. The screen's predicate.** **Recommended:** a client predicate mirrored by a shared fixture table in both
  suites, rather than a server `actions` hint (no API change).
- **R13. `rightsStillHold`'s lock order** (section 5, db review F2). **Recommended:** 7h-B changes only the
  club-admin query to `for share of u, r`, with the route-against-route test of section 10.4. That also changes the
  existing club-admin path of every caller (section 7: mappings, activations, canonical variables, classification),
  where the same deadlock exists today. The other branches with the same inversion (section 7: the club-admin branches
  of `sourceConnectionService.js` and `gpexeAthleteIdentityService.js` and of `coachRightsStillHold`, every
  platform-admin branch, the team-coach branch) are the separate "lock order" pull request, right after 7h-B and
  before more clubs are brought on.
  - *Alternative (a):* 7h-B also turns `g, u` into `u, g` and `r, u, c` into `u, r, c` in `rightsStillHold` and
    `coachRightsStillHold`, with a platform-admin route-against-route test — a wider change for paths 7h does not touch.
  - *Alternative (b):* leave the club-admin query as it is and record the deadlock as a known `try_again` / 500 race —
    not recommended, since 7h makes club-admin writes routine.
  - **Decided by the *Rukovodilac* (2026-11-02):** as recommended; the lock-order pull request as above.

## 13. What this contract supersedes or amends (accepted 2026-11-02; each row marked in its document)

The acceptance pull request marks every row below in its own document, next to the text it changes, and erases nothing
(R11). A mark names J14 and its decision (C126 for the scope) and says that it holds once 7h-B is merged and v52 is
deployed; until then the old text describes the system as it runs.

| Where | What | How |
|---|---|---|
| Discovery C30 | "only a platform admin" for a club mapping's status changes | superseded for club mappings (C108, J14) |
| Discovery C33 (`:378-380`) | "the platform admin chooses explicitly which one a binding uses" | amended: the club admin too, for its club's versions (already de facto by C106) |
| Discovery C106, last sentence | "A1, A2 and the revision lifecycle stay the platform admin's" | amended: A1 and A2 on a club mapping are also its club admin's; the lifecycle stays the platform admin's |
| Discovery D6 (`:1563`, `:1583`, `:1602-1607`) | `activated_basis` / `disabled_basis` (`platform_admin`); "every other transition is a platform admin's" | amended: both bases on a club mapping |
| Discovery D10 (`:1806-1809`) | the club-admin column: `mapping_status` "draft → needs_review only", `mapping_version_replaced` blank, `activation_start` / `activation_end` blank | amended: every `mapping_status` transition and `mapping_version_replaced` on a club mapping; activations per C106 |
| Discovery `:2026-2030` (who reads an audit row) | "Does not activate, disable or end an activation in the first scope: the `*_basis` CHECKs allow `platform_admin` only …" | amended: a club mapping's version is also activated and disabled, and its activations ended, by its club's admin |
| Discovery `:3834-3836` (J8 as built) | the A1 / A2 gate "(basis `platform_admin`, owner `system` or `club`)" | amended: basis `platform_admin`, or `club_admin` with a club owner |
| Discovery `:4055-4056` (J10 as built) | "the version-driven ends write the basis `platform_admin` as a constant, because A1, A2 and the pinned step admit only a platform admin" | superseded by section 2.4's third row and section 7 |
| J8 (`phase7b`: `:30`, `:171-172`, `:350-352`, R3) | "Only an active platform admin may do either" | amended for club mappings |
| J8 Q7's consequence (`phase7b:574-576`) | "The club's admin can only create and submit one" | superseded: it can also activate one |
| J10 section 2.3 (`phase7d:214-240`) | the basis table; "Unchanged: A1, A2 and the revision lifecycle stay the platform admin's" | amended: section 2.4's third row |
| J10 section 5 (`phase7d:512`) | "A1, A2 and the pinned step lock no club row for their ends … an archive never blocks them" | amended: section 5's club archive row |
| J16 (`phase8`: `:50-51`, `:84`, `:88-90`, `:224-227`, R12 `:464-466`) | the club admin's waiting-version note; "a platform admin only" | superseded by section 8 |
| J17 O16 (`phase9:1033-1036`, `:341`) | "no club mapping is switched on for a team binding" until decided | answered by O2 |
| J18 (`c112`) | 7h = v51 (`:46`, `:550`), and **every** `v52` that names J18's own migration — `:46`, `:182-183`, `:479`, `:548`, `:550`, `:608`, `:636`, `:690` (the runbook `source-metric-confirmations-v52-rollback.sql`), `:692`, `:701`, `:834`, `:947`, `:979`, `:1166`, `:1172` | renumbered: 7h = v52, J18's migration and its runbook names ≥ v53 |
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
- **Round 1** of the internal reviews, on `523aac77` (each MEDIUM checked again by an adversarial verifier from the
  code). `code-reviewer` ended without an answer and runs again on the next head.
  - **`db-reviewer`: READY WITH NON-BLOCKING NOTES**, no BLOCKER or HIGH. Its findings, all applied:
    - MEDIUM F1, the catalog comment: the T4 table comment, restored by the rollback;
    - MEDIUM F2, the club-role revocation deadlock: fixed-order, not plan-dependent; the verifier reproduced it on a
      disposable PostgreSQL (3 of 3 runs, the revocation the victim) and saw the fix pass (3 of 3); it became section
      5's row, section 7's `rightsStillHold` change, R13 and the route-against-route test of 10.4;
    - LOW F3, the first-firing guard in 10.3 item 2;
    - LOW F4, `.gitattributes` and the runbook `.md`;
    - LOW F5, "adds", not "moves", the T3 lock;
    - LOW F6, the deploy window and `nowait` (R10);
    - notes: the migrator role owns the four functions; the rollback also counts T8 `activation_end` rows.
  - **`security-reviewer`: READY WITH NON-BLOCKING NOTES**, no BLOCKER or HIGH. Its findings, all applied:
    - S1 (MEDIUM; the verifier rated it LOW), platform support in a club needs the club role: sections 0, 2.1, O1 and
      O4;
    - S2 (MEDIUM, confirmed), the order of the answers: section 3, the request record before the owner-filtered read;
    - S3 (MEDIUM; the verifier rated it LOW), 7h-V's access rule: O2 (a);
    - LOW S4 to S11: the test plan (the write hold, the revocation peer, R5's test, deep-equal 404s, a user with both
      roles, a private coach), the mutations, the `is distinct from` backstop, both submit refusals, J10 section 4.3's
      write order in section 4, the M3-0 precedent in R4, the predicate's fixture table, and `actions.js:275`.
- **Round 2**, on `502f1356`: narrow re-reviews of the round-1 delta.
  - **`db-reviewer`: READY WITH NON-BLOCKING NOTES.** F1–F6 applied correctly; the `u, r` order creates no new cycle
    (it checked every writer of `users` and `user_club_roles`). Its findings, all applied:
    - MEDIUM D1, the wrong precedent ("the promotion probe … `g, u`") and the sibling branches that keep the
      inversion: section 7 and R13, with the remaining branches as a separate task;
    - LOW D2, every caller of the changed branch and their suites (sections 7, 10.8);
    - LOW D3, 10.5 item 2 against `nowait`;
    - LOW D4, the raw-writer sentence in section 4;
    - LOW D5, the T4 comment's clause replaced, checked by the preflight and the post-check;
    - LOW D6, the deterministic revocation test.
  - **`security-reviewer`: READY WITH NON-BLOCKING NOTES.** S1–S11 applied correctly; no new authorization,
    information-hiding or audit error. Its findings, all applied:
    - MEDIUM N1, the same as D1;
    - LOW N2, 7b test 8's actor;
    - LOW N3, a committed write may answer the identical 404 after the COMMIT;
    - LOW N4, the same as D3;
    - LOW N5, 7h-V's owner-club clause;
    - LOW N6, "audited" and the starts' locks in section 4.
  - **`code-reviewer`** ended twice without an answer on this size of review (its agent definition allows 24 turns);
    it ran in three scoped parts on the next head.
- **Round 3**, on `dcfc1575`: `code-reviewer`, the full review in three scoped parts (sections 0–3 and 11–14;
  sections 4–9; section 10). Each **READY WITH NON-BLOCKING NOTES**, no BLOCKER or HIGH. Its findings, all applied:
  - MEDIUM: section 13 missed three places of the discovery document that 7h makes false (`:2026-2030`,
    `:3834-3836`, `:4055-4056`);
  - MEDIUM: R9 contradicted R13 (the shared rights re-check); R9 now gives the evidence that no shared-kind suite
    reaches the changed code;
  - MEDIUM: A2 has no fault seam for a definite COMMIT refusal; 10.4 now specifies `skip_end` on the mapping
    service's seam, with its mutation;
  - LOW: every `v52` of J18 in section 13; the citation of the scope refusal in section 2.3; `exerciseCollections.js`
    among the remaining inversions; the missing-conversion sentence in a club workspace only; only the last sentence
    of the Imports step changes; 7b test 8's rows and title; `classification-icons-1c` in 10.8; the second order of
    the revocation race;
  - NIT: the plain A2 case in section 1.2; "the only code that ends a binding"; the race answer codes in section 5;
    two more comments to rewrite; the step-4 sentence; two citations; the C33 quote.
- **The ★★ reviews of `44e47340`:** the *Rukovodilac*'s GO (no BLOCKER, HIGH or MEDIUM; two LOW for 7h-B: the
  route-against-route test with its mutation in the 7h-B packet, and the runbook's steps for a `nowait` failure in
  Serbian; R1–R13 decided as recommended) and the *Nezavisni revizor*'s GO (it reproduced the deadlock, 9 of 9 with
  `r, u` under three join plans, 0 of 9 with `u, r`, and confirmed the four md5 values on v51; one LOW). The LOW: section
  7 described the remaining inversions of `sourceConnectionService.js` and `gpexeAthleteIdentityService.js` as on the
  global role only, while both also have a club-admin branch. On the *Rukovodilac*'s decision this head corrects section
  7 and R13, puts those branches into the separate lock-order pull request, and adds the revisor's test to 10.4.
- **Accepted on 2026-11-02.** The owner: „J14 O1–O6 i J15 O1–O9 po preporuci, odobravam oba ugovora” (turn
  `95c006f2`, 20:16:10 UTC, relayed by the *Rukovodilac*'s order `011e7d13`). PR #333 merged as `f0578a72` exactly
  from `3a4f7933`. The acceptance pull request records C126–C131, marks section 13's rows in their documents (R11),
  and fixes **what 7h-B's packet must carry** (the *Rukovodilac*'s two LOW notes on `44e47340` and the *Nezavisni
  revizor*'s note on `3a4f7933`):
  - **L1:** the route-against-route revocation test of 10.4, with the mutation of 10.6 that returns the club-admin
    query to `for share of r, u` and that only this test kills (the rights-before-triggers test holds both rows and
    proves nothing about their order);
  - **L2:** the Serbian runbook's steps for a lock failure of v52 — `nowait` on T4 ("could not obtain lock on
    relation") or the runner's 30 s `lock_timeout` on T5 / T8 ("canceling statement due to lock timeout"): both leave
    nothing applied and the old instance serving; wait for a quiet moment, run the preflight's quiet-moment block again,
    deploy again; nothing is deleted;
  - **a known limit until the lock-order pull request**, named in the packet and the runbook: a club's admin's A1 with
    listed starts, an Unbind of one of those bindings and a revocation of the club's admins at the same moment can end
    in `40P01` (A1 and the Unbind answer `try_again`, the revocation a 500; nothing is written), because A1 locks its
    rights before its listed bindings (J15 section 5 and R13); the lock-order pull request removes it;
  - R9's grep repeated at 7h-B's head, and the real `--file` results of every suite of 10.8 with their counts.
  - **The order of the pull requests** (C127, C131, J15's R13 and the *Rukovodilac*'s order of 2026-11-02, event `783e3591`):
    7h-V before 7h-B's deploy; 7h-B; then 7h-F (right after 7h-B, as O6 decides) and the lock-order pull request
    (every remaining role-first rights lock turned users first, and A1 in D's order with a route-against-route test of
    A1 against an Unbind and a club-admin revocation), in either order; 7i-B only after the lock-order pull request.
    The *Rukovodilac* accepts that, while 7h-F is out and the lock-order pull request is not, the known limit above
    can meet a club's admin who saves and activates with listed starts (`try_again` or a 500, nothing written).

## 16. 7h-V as built (C127)

The pull request 7h-V (branch `feature/7h-v-club-variable-names`, base `95c05199`, the merge of PR #335; no migration)
builds O2 (a) / C127. Its design and scope were decided before the code by the *Rukovodilac* on 2026-11-02 (event
`66518c44`, 21:14:30 UTC: „7h-V: dizajn je prihvaćen”, V1–V7 all as recommended). This section is "7h-V's contract
section" that O2 names: the screens, exactly, and what the read returns. **Merged and deployed:** merged as PR #337 (`d3dcb641`, parents `95c05199` and `f56cbdfc`, the tree the reviewed head's) exactly from `f56cbdfc` under the standing merge order after both ★★ GOs (the *Rukovodilac*'s event `28c48113`, the *Nezavisni revizor*'s event `1cf49e34`), and deployed by the *Rukovodilac* through the Render API on 2026-11-02 (live at 21:59:35 UTC; `/api/health` served `d3dcb641` with `ok: true` four times in a row, 21:59:50–22:00:28 UTC; without a login `/api/auth/me` answered 200 with no user and the activity read, its roster and the mappings list 401).

- **The read.** `GET /api/training-activity/:activityId` gains `variableNamesById`, always present (`{}` by default),
  beside `athleteNamesById` (`backend/src/trainingActivityResults.js`). An entry is `{ label, shortLabel, unit }` (V3:
  the name, the short name and the unit of the definition's current version, as the catalog gives it); never a key,
  icon, description or the club's catalog. It is filled only when every one holds:
  - the caller is not an athlete on their own result, and the active workspace is a team workspace of the
    activity's own team (the activity `owner_scope = 'team'`, its team in an active club row);
  - the definition appears in a `metric_value` fact this read already scoped and authorized (the ids come from the
    facts, never from the request);
  - the definition is `owner_scope = 'club'` with `owner_club_id` = the activity team's club;
  - C99's predicate admits the caller for that team and club (`resolveVariableEditor`, asked by the route with the
    workspace this request already resolved, through its new optional `known` argument; asked only when such a
    definition is present). That is: the team, its club, the caller's `team_coach` role and the user are all active.
  Archived club variables are named (V4: results are history). Everyone else (an athlete, a club, platform or
  private-coach workspace, a coach of another team or club) gets `{}`, whether or not the activity holds a club
  variable; the activity's own identical `404` is unchanged.
- **Errors (V5).** The C99 check's errors propagate. A pool checkout timeout is the global `503 database_busy`; the
  check's own read bound (`try_again`) is mapped by the route to the same `503 database_busy` with `Retry-After`; any
  other error is a `500`. The frontend's activity cache keeps only a successful answer, so a nameless "Metric" is never
  cached.
- **The screens, exactly** (`frontend/training-load-calendar-view.js`; the activity's names stand behind the catalog,
  the catalog wins for an id it has, and nothing is written into `metricPicker.definitions`):
  1. the Activities results table's column header (`metricColumnsFromRows` / `pickedMetricColumns`): the short name
     or name, and the unit;
  2. the athlete drawer (`athleteMetricGroups`): the short name or name, with the captured unit as before;
  3. the column picker (`renderMetricPickerHtml`, V6): the open activity's named club variables are offered too, so
     one can be chosen when the activity has more than four variables (the smart default then shows none); another
     activity does not offer them.
- **The roster (V1).** The Roster tab of the same drawer (`GET /api/training-activity/:activityId/roster`,
  `activityRoster.js` `loadRosterSnapshot`) names only the variables of the team's own club: a club-owned definition of
  another club reads with no key, label or short label, for every basis (the team's coach, the club's admin in its
  workspace, the platform admin). Each such value keeps a column of its own through a placeholder key `#unnamed-N`,
  numbered in that answer by the sorted definition ids (no definition key has a `#`), and the screen shows "Value".
  The team's own club's variables are named as before to every roster basis: the roster is not gated by C99, only the
  activity read's `variableNamesById` is. System variables and the team's own variables are unchanged; the other
  owners' user and team variables are the separate info-hiding task (V2, CURRENT_STATE Separate tasks). No roster
  state reads a name.
- **Not changed.** `catalogVisibilitySql`, `listDefinitions`, the measurement write gate, the athletes' reads, the
  calendar grid and `/weekly` (they carry no definition id), and the dashboards: a team-workspace dashboard can never
  hold a club variable (the v16 trigger `dashboard_widget_series_validate_metric_visibility`, the application pre-check
  `assertMetricReferenceOk` and the template resolution), so there is nothing to name; C138's later pull request, which
  lets a team's dashboards use its own club's variables, carries the same rule. `GET /metrics/occasions/:id` and
  `/metrics/results` (no screen calls them) are V2's.
- **How another club's variable reaches a team's results** (correcting O2's wording, which named an athlete's older
  membership): an activity's facts come only from metric events of the identical owner (the v2 trigger
  `activity_metric_event_links_check_owner`; a merge or reparent never changes the owner), and the measurement write
  admits every definition the writer's role-wide catalog shows. So a user who also administers club B (or a platform
  admin) and coaches team A1 can record B's variable in A1's results. Moving a team to another club: the route refuses
  it (`team_club_fixed`); the database refuses it for any team with a membership row (the foreign key
  `athlete_memberships_team_club_fkey`, archived memberships included); a team with none can still be moved by raw SQL
  (section 1.4), and its results then follow its new club. The `owner_club_id` condition is what keeps B's name out of
  A1's results; the suite writes B's variable exactly that way, through the real routes, and pins the refused move.
- **Known limits.** A user who holds club B's admin role sees B's names through the catalog in every workspace,
  because `catalogVisibilitySql` is built from every role the user holds; unchanged by C127's decision. The column
  picker's layout is the existing one (CURRENT_STATE: "the 'Choose metrics' picker is unusable at about 515 px width");
  the added rows use the same template. The service's team-workspace gate and the route's workspace-team check guard
  the same fact; each alone is a second layer (a mutation of one of them alone is not killed, the two together are).
- **Tests.** `backend/tests/club-variable-names-7h-v.test.mjs` (disposable, through the real server; 14 tests: the
  coach of A1 gets exactly club A's variables of the facts; another team's and another club's coach get the identical
  `404`; the same coach in a second team's workspace gets `404` on A1 and, on B1's session, B's name and not A's; an
  archived club names nothing; club and platform workspaces and the athlete get `{}`; dual roles in A1's workspace get
  A's names only; the catalog is untouched (list, single read, write); the roster for four viewers; the dashboard's
  identical `404`; a label with markup comes back verbatim; a read bound is `503`, a broken read `500`, and a caller the
  check does not concern never asks it; an administrator with no coach role falls back to its club workspace and a
  revoked coach loses the team workspace; the refused move between clubs; the placeholder columns numbered the same for
  every viewer) and seven new tests in `frontend/tests/training-load-calendar.actions.test.mjs`
  (header, drawer, the catalog wins, the picker, escaping, a workspace switch, a `503` not cached). Twelve mutations,
  each killed by a named test, are listed in the pull request.
