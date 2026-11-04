# U2 — the import switch per team, its conditions, and who may approve (discovery and plan, ★★, migration)

Part of J19 (`docs/ai/gps-import-flow-contract.md`, section 3, U2). U2a (the pair by the club admin) is its own part and is not repeated here. **Status: Proposed, documentation only; no code before the *Rukovodilac*'s GO.** Verified against `origin/main` `db7ebd55` (PR #366). No production read, no GPEXE request.

## 1. The decisions this builds on (2026-11-04)

- D3: during the pilot the **platform admin** turns the import on; after the pilot the club admin and the team coach import. The *Rukovodilac*'s reading (R1, accepted): the per-team switch is turned on by the club admin (the platform admin during the pilot) and the **coach approves sessions** of their team.
- D6 / R3: the evidence for regular imports is the Supabase daily backup **shown as a date** and a restore probe once a month; an administrator records both dates (the app cannot read Supabase); the maximum age is **2 days** for the backup and **35 days** for the probe.
- The import switch conditions of `CURRENT_STATE.md` (1–7). Today the switch is the environment variable `GPEXE_IMPORT_APPLY_ENABLED`, off everywhere; conditions 1–3, 6 and 7 gate turning it on anywhere, 4–5 gate regular production imports.

## 2. What exists (verified in code)

| Fact | Where |
|---|---|
| The switch is the environment variable only: `applyEnabled()`; refused as `409 import_switch_off` in `approveCandidate` and `approveCandidates`; a candidate carries the blocker `import_switch_off`. A check never reads it. | `gpexeImportService.js:45, :1376, :2334, :2770` |
| Who may approve: an active platform admin, or a coach with an explicit, platform-admin-given approver grant (`team_grant`). The right is re-checked in the approval's own transaction by `training_load.lock_gpexe_import_approver` (v23, body now rewritten users-first by v54) and by the approval's insert trigger, which compares the recorded `approval_basis` with the live right. | v23, v54 (`lock_gpexe_import_approver` md5 `be924aae…`), `gpexeImportAccess.js:39-55` |
| `gpexe_import_approvals.approval_basis` is CHECKed to `('platform_admin','team_grant')`, with `(basis = 'team_grant') = (approver_grant_id is not null)`. | v23 |
| The check run re-validates the binding, connection, credential, and pins the club (`team_not_available`, `team_club_changed`). | `sourceImportCredentialResolver.js:204, :212` |
| Condition 5 (a check running while its team is archived still completes) is recorded as open in `CURRENT_STATE.md`; the resolver's team / club re-resolution may already cover it. **To verify first, by a test**, before any claim. | `CURRENT_STATE.md`, section "conditions" |

## 3. The design

### 3.1 The per-team switch (migration)

Two new tables in `training_load` (names provisional), both append-only history of the facts, written only through sanctioned functions with the v35 / v48 actor guard pattern (the user and the basis are derived by the database, never taken from the body):

- `gpexe_team_import_switch`: one row per team: `owner_team_id` (PK, FK team), `enabled`, `mode` (`pilot` | `team`), `changed_by_user_id`, `changed_at`, `reason`. Its history table records every change.
- `gpexe_import_prerequisite_records`: append-only: `kind` (`backup` | `restore_probe`), `recorded_on` (the date of the backup or the probe), `recorded_by_user_id`, `note` (bounded, no secret), `recorded_at`.

Semantics:
- **An approval needs both switches:** the environment variable (the global master, a kill switch kept as is) **and** the team's row `enabled`. A candidate's blockers gain `team_import_switch_off`.
- **Turning on** is the function `training_load.set_team_import_switch(team, enabled, mode, reason)` under the team import lock, which refuses unless the conditions of 3.3 hold at that moment (read inside the function, not trusted from the client). **Turning off** has no condition.
- **Mode `pilot`:** only a platform admin approves (today's rule plus explicit grants). **Mode `team`:** the club admin of the team's club and the team's coaches approve too (3.2). Moving a team from `pilot` to `team` is a separate act (R-U2-1).

### 3.2 Who approves (migration, the sensitive part)

`lock_gpexe_import_approver` is replaced (md5 precondition against v54's body, md5 after) and the CHECK of `approval_basis` widened: new bases `club_admin` and `team_coach`, each valid only while the team's switch is `enabled` and `mode = 'team'`. Lock order stays users-first (the v54 rule): the user row, then role rows, then the club and team rows, then the switch row, all `FOR SHARE`. A coach's `team_coach` basis requires an **active team_coach role of that team** and an active user; the explicit `team_grant` stays as an additional path. The approval insert trigger compares the recorded basis with the live right as today. `canApproveGpexeImport()` (the screens' read) gets the same rule in code.

### 3.3 The conditions list and the gate

| # | Condition | Turning on in `pilot` | In `team` mode | Source of truth |
|---|---|---|---|---|
| 1 | A backup dated within 2 days **and** a restore probe within 35 days (D6) | required | required | the records of 3.1 |
| 2 | Bounded lock waits before an approval's COMMIT | met (9-0) | met | code, shown as a fact |
| 3 | The undo takes the team import lock | met for the script (disposable only) | replaced by U5 | code / U5 |
| 4 | A verified procedure for a wrongly linked athlete | not required | required: U5 deployed | a constant that U5 flips |
| 5 | A running check stops when its team is archived | not required | required | verified by a test first; built if open |
| 6 | A later check withdraws earlier unapproved candidates | met (v33) | met | code |
| 7 | A drill-parameter guard | met (v33) | met | code |

Only 1 and, for `team`, 4 and 5 are enforced by the database function (1 from the records, 4 from a recorded fact `wrong_link_procedure_available`, 5 from the same kind of fact once verified); the rest are shown as built. The status route returns the list with each item's state and, where an administrator recorded it, the date and who. Nothing in the list is claimed by the app unless it can prove it.

### 3.4 Condition 5 (an archived team's running check)

First a test on the resolver: archive a team while a binding-path check is between two source operations; expect `team_not_available` and no candidate. If it already passes, condition 5 is recorded as met and nothing is built. If not, the resolver's re-validation gains the team and club active check it lacks (a code change in the same PR).

### 3.5 Frontend

A *Team imports* panel in Settings (platform admin and the owning club's admin): the switch, its mode, the conditions list with dates, the reason on a change; a platform admin also records the two prerequisite dates. A coach sees the state of their team's switch (read only) and, when the switch is on and the mode is `team`, the Import controls (U1). Texts reviewed by `ux-design-reviewer`; phones by `mobile-qa`.

## 4. Migration, rollback, numbering

One migration (the next free number after v55 once O7 is merged; fixed at merge, with the prefix check). Rollback `docs/runbooks/…-rollback.sql`: refuses once any switch row, record or `club_admin` / `team_coach` approval exists, under a later migration, or if the function bodies are not this migration's; restores v54's `lock_gpexe_import_approver` and the original CHECK. Preflight and post-check read-only. Runbook records the two prerequisite dates procedure ("how to record the Supabase backup date").

## 5. Tests and reviews

- Role matrix for turning on / off and for approving in each mode: platform admin, club admin of the club, of another club, coach with and without a grant, athlete, revoked role, archived team / club, the user deactivated mid-call.
- The gate: refused with the exact condition named when the backup is 3 days old, the probe 36 days old, no record, in each mode; accepted at 2 and 35 days; the date in the future refused.
- Both switches: environment off or team off = `409`, nothing written; a switch turned off between the batch's candidates stops the batch (`BATCH_STOP_CODES` gains the code).
- The approval trigger: a `club_admin` / `team_coach` basis refused in `pilot` mode and when the switch is off; a basis that no longer matches the live right refused; a coach of another team refused.
- Lock order: two real sessions (a role revoke and an approval; a switch change and an approval), as in the v54 suite. Mutations on every new guard. Rollback rehearsal on a disposable database.
- Reviewers: `db-reviewer`, `security-reviewer`, `code-reviewer`, `ux-design-reviewer`, `mobile-qa`. **★★**: triggers 1, 2, 4; both GOs, the owner's order naming the migration, the preflight, the owner's deploy.

## 6. Questions for the *Rukovodilac*

- **R-U2-1:** who moves a team from `pilot` to `team` mode: a platform admin only (recommended: it is the end of the pilot for that team), or the club admin too?
- **R-U2-2:** who may turn the switch **off**: platform admin and club admin (recommended); should the coach be able to?
- **R-U2-3:** who may record the backup and restore-probe dates: platform admin only (recommended: the backup is the platform's, not a club's)?
- **R-U2-4:** `pilot` mode requires condition 1 as well (recommended: the first real import needs a fresh backup anyway, `CURRENT_STATE` condition 1), or only `team` mode?
- **R-U2-5:** the explicit coach grants (`team_grant`) stay as they are in both modes (recommended) or are retired once `team` mode exists?
