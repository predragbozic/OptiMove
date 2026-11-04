# U2a — the club admin approves the pair "OptiMove team ↔ GPEXE team" (discovery and plan, ★★, no migration)

Part of J19 (`docs/ai/gps-import-flow-contract.md`, section 3, U2 / D2). **Status: Proposed, documentation only; no code before the *Rukovodilac*'s GO.** Verified against `origin/main` `76af5f52` (PR #364, U1) — the files cited here did not change in PR #364 except as noted. No GPEXE request, no production read.

## 1. The owner's decision (D2, 2026-11-04)

> „Admin kluba bi trebao da odobrava par „OptiMove tim ↔ GPEXE tim" za timove koje vidi njegov klub."

Today only a platform admin sets the pair (`PUT /api/training-load/gpexe/teams/:teamId/settings`, `routes/gpexeImport.js:134`, `if (!access.platformAdmin) return forbidden(res)`). After F3c2e a bind needs that exact pair (`team_setting_missing` / `team_setting_mismatch`, `sourceConnectionService.js:804-805`, v30 triggers), and a club admin sees only the **intersection** of the connection's visible teams with already approved pairs (`sourceConnectionService.js:940-948`), which is empty before any pair exists. So the club admin cannot start the flow alone.

## 2. What exists and is reused

| Piece | Where | Reused as |
|---|---|---|
| The write of the pair: team import lock → settings row → history row → v24 change guard → v30 bound-final guard, idempotent, reason on a change | `setTeamSettings()`, `gpexeImportService.js:217-` | Unchanged; the club admin calls the same function. |
| Who may reach a team's GPEXE routes (team coach, club admin of the team's club, platform admin, in a workspace that contains the team; anything else 404) | `resolveGpexeTeamAccess()`, `gpexeImportAccess.js` | Unchanged; it already returns `workspace` and `platformAdmin`. |
| The list of GPEXE teams the club's account sees, as returned by Connect / Test | `sourceConnectionService.js:906-949` (`sourceTeams`, annotated with `approvedTeamId`) | Extended: the club admin gets the same annotated list as the platform admin (section 3.2). |
| Visibility check of the chosen team | The bind's own `GET team/<id>/` through the adapter bound to that id (F3c2e) | Unchanged; it is the enforcement that the club's own credential can read the team. |
| Club-admin role predicate | `holdsClubAdminRole(req.authz, clubId)` (`authz.js`), used by `resolveConnectionAdmin()` | Reused; no new predicate. |

## 3. The change

### 3.1 The route

`PUT …/teams/:teamId/settings` accepts, besides an active platform admin, **the active admin of the team's club acting in that club's workspace** (`access.workspace.type === "club"` and `access.workspace.scopeId === access.clubId` and `holdsClubAdminRole`). Everyone else keeps today's answer (a team coach, a team workspace, a platform admin outside the right workspace: unchanged). The body is unchanged (`gpexeTeamId`, `reason`).

Additional conditions for the **club-admin basis only** (a platform admin keeps today's behaviour):
1. the club owns a `verified` GPEXE connection (state and host approved) — else `409 source_connection_required`, nothing written;
2. a team that is archived or of another club is the same 404 as today (the access resolver);
3. the record of the approval is the existing settings history row (`configured_by_user_id`, reason); the body never names an actor or a basis (see 3.3 for the basis).

### 3.2 The list the club admin chooses from

Connect / Test for a club admin returns the same annotated list a platform admin gets (all teams the club's own credential sees, with `approvedTeamId` where a pair exists), not only the intersection. This reverses the F3c2e rule "a club admin sees only the intersection" (security review HIGH F-1, 2026-10-04) **on the owner's explicit decision of 2026-11-04**; it is the one disclosure change of U2a and needs the security review's attention (section 5).

### 3.3 The record of who approved

`gpexe_team_settings_history.configured_by_user_id` already names the person. The basis is derivable from the role at the time only by a join that can change later, so it is not stored. U2a records the approval in the history row as it is, and adds nothing to the database. If the *Rukovodilac* wants the basis stored, that is a column and therefore a migration (decision R-3).

### 3.4 Lock order and transactions

Unchanged: `setTeamSettings()` takes the team import lock and bounded `lock_timeout`; the route's access check precedes it. The club admin basis adds one read before the call (the club's connection state, plain `SELECT`, no lock) and re-checks the role at the end as the other club-admin routes do (`rightsStillHold` pattern). No new lock; no change to COMMIT handling.

## 4. Risks this exposes (for the owner's decision)

- **R-1, shared account.** Today one GPEXE account sees eight teams, only one of them this club's. If several clubs use that one account, any club's admin could approve and bind any of the eight. D2 as worded ("teams the club's account sees") makes the **GPEXE-side scoping of the account** the boundary. Mitigation outside code: one GPEXE account per club, or the platform admin keeps approving until that is true. Decision needed before U2a is released to a second club.
- **R-2, first come.** One GPEXE team feeds one OptiMove team across the whole database (`gpexe_team_taken`, v22 unique key). A club admin who approves a GPEXE team another club needs blocks that club until a platform admin steps in. With one account per club this cannot happen; with a shared account it can. The refusal is already stable (`409 gpexe_team_taken`) and names no other club.
- **R-3, basis not stored.** See 3.3.
- **R-4, verification at approval.** The pair route makes no GPEXE request (a source call there would need an audit action, a migration and the throttle). A club admin can therefore approve any numeric id; it becomes effective only at the bind, which reads the team through the club's own credential and refuses an invisible one (`source_team_not_visible`). Until then the pair is inert.

## 5. Tests and reviews

- Role matrix on the settings route: platform admin (platform workspace; club workspace); club admin of the team's club in its club workspace (allowed); the same person in a team or platform workspace (as today); club admin of **another** club; club admin of two clubs in the wrong club's workspace; coach; athlete; revoked role; archived team; archived club; team moved to another club mid-request. Every refusal identical to today's.
- `source_connection_required` for a club without a verified connection; unchanged behaviour for a platform admin.
- The list: a club admin sees the whole annotated list (the same body as a platform admin's), and still **nothing** when the connection is not `verified`.
- Idempotency, `gpexe_team_bound`, `gpexe_team_taken`, the history row, the reason on a change — through the club-admin basis, byte for byte as for the platform admin.
- Cross-club info-hiding: the response to a club admin never names another club, team or connection.
- Mutations: the club comparison dropped, the workspace condition dropped, the `verified` condition dropped, the intersection filter restored.
- Reviewers: `code-reviewer`, `security-reviewer` (authorization, workspace, disclosure), `ux-design-reviewer` for the Settings screen change. ★★ by trigger 2; no migration, so no `db-reviewer`; both ★★ GOs, then the standing merge order.

## 6. Frontend

The Data sources screen's "approve pair" control is offered to the club admin in the club workspace for the teams of their club, fed by the Test list (a GPEXE team picked from "the teams this account sees", never typed). The Source connections screen's "Approve and bind" already sends the pair to *Bind* where one exists; for a club admin without a pair it now offers *Approve pair* first (one confirmation naming the club, the OptiMove team and the GPEXE team), then *Bind*. Texts reviewed by `ux-design-reviewer`.

## 7. Questions for the *Rukovodilac*

- **R-1/R-2:** the owner's D2 relies on each club's GPEXE account seeing only that club's teams. Is that true today (one shared account, eight teams)? If not, U2a is released only when each club has its own account — or the owner accepts that any club admin may pick any team of the shared account for now.
- **R-3:** is storing the approval's basis (column, migration) wanted, or is the history's user id enough?
- **Order:** U2a before U2 (the per-team switch), as J19 section 4 says.

## 8. Decisions of the *Rukovodilac* (2026-11-04) and as built

- **R-1 / R-2:** U2a is released to a second club only after that club has connected its OWN GPEXE account. For the pilot club (one account, its eight teams) the risk does not exist. No detection of a "shared account" is built. If it is ever doubted, a platform admin removes the pair through the existing F3b path.
- **R-3:** no new column: the history row's `configured_by_user_id` and the workspace are enough.
- **As built (branch `feature/u2a-club-admin-pair`):**
  - `PUT …/teams/:teamId/settings` accepts the active platform admin, or the active admin of the team's club in that club's own workspace. `setTeamSettings()` gets `clubAdminClubId`; inside its transaction, after the team import lock, `assertClubAdminMayApprovePair()` re-checks the user and role row (`FOR SHARE of u, r`, the revocations' order), the club, the team (active, of that club) and the club's `verified` connection (`409 source_connection_required`; anything else missing is the same 404). A club admin sets a **first** pair only: a different GPEXE team for a team that already has one is `409 pair_change_requires_platform_admin` (the same value stays idempotent); changing and removing stay with a platform admin.
  - Connect / Test return the whole annotated list to a club admin as to a platform admin (annotations carry only the owning club's own pairs).
  - The Source connections screen offers *Approve pair* (a team of the club without a pair, one confirmation, the GPEXE team only in the body); the row then offers *Bind*.
  - Not changed: the bind (it still verifies the team through the club's credential), the F3c2e/v30 guards, the settings history table, any migration.
