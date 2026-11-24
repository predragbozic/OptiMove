# v95: R2's dominance inside a club whose licence closes a module

Migration `migrations_v2/202611271000_roles_v95_closed_module_dominance.sql`. The *Rukovodilac* of OptiMove's decision
(A) of 2026-11-24, on a finding of the R4-3 executor; roles R4 contract (`docs/ai/roles-r4-contract.md`) 3.5, 7.2,
7.3 and 16 / 17. The files beside this one are:
- `roles-closed-module-dominance-v95-preflight.sql`;
- `roles-closed-module-dominance-v95-postcheck.sql`;
- `roles-closed-module-dominance-v95-rollback.sql`.

The rehearsal tool is `backend/scripts/roles-closed-module-dominance-v95-rehearsal.mjs` (Node 20 or later), with `.sh`
and `.ps1` wrappers (the `.ps1` asks for the password hidden when `PGPASSWORD` is not set).

## The gap it closes

v92's four dominance checks of the club versions and the custom roles - the two item guards on INSERT
(`permission_club_role_version_items_guard`, `permission_custom_role_items_guard`) and the two COMMIT checks
(`permission_club_role_versions_complete`, `permission_custom_roles_complete`) - require
`user_has_permission(actor, word, 'club', club)` for every item. That answer applies the club's ceiling (contract 3.2
step 6). Once a club's licence closes a module whose words its roles carry (the seeded view words sit in Team coach and
Club admin: `calendar.view`, `tests.view`, `load.view.*`, ...), the club's admin "holds" none of them, so it can make or
change **no** club version or custom role at all. Rule 7 already reads "minus the closed modules"; dominance did not.
A platform admin was never affected.

## What it does

- **`public.permission_actor_holds_in_club(actor, word, club)`** (new): true when the word is held now (the twin,
  ceiling included), OR the word's module is closed for the club and the actor - an active user - holds it through its
  own club holdings with the ceiling left out (`public.permission_user_holdings`, which applies no ceiling: the old row or
  assignment of the club, its live custom, the club's version, the role's items).
- **The four guards** ask it instead of `user_has_permission`; nothing else in them changes (who may write, the lock
  checks, storable / platform-only / system-role-only / scope-type rules, H1, rule 7). Each body is md5-gated against
  v92's.
- So a closed word passes only for an admin who would hold it the moment the module opens again: reopening brings back
  exactly what was recorded (O1), and a club's admin still gives only what it holds (R2). A closed word the admin would
  NOT hold (for example a platform admin gave the club a Club admin version without the Tests words while Tests is
  closed) is still refused.
- No table, trigger, index or row. The new function is not executable by `PUBLIC`, `anon`, `authenticated` or
  `service_role` (v92's convention); a replaced body keeps its privileges.

## Not changed (recorded)

- R2's assignment dominance (`public.user_holds_role_items`, and the service's checks of `roles.manage` / `staff.assign`
  writes) still compares through the twin with the ceiling: a club's admin cannot assign a club role whose items carry a
  word of a closed module. Not in the *Rukovodilac*'s decision (A); recorded for a decision.
- The API keeps refusing to ADD a word of a closed module (`409 closed_by_club_ceiling`, R4-3); v95 only stops the
  words a role already carries from blocking every change.

## Deploy

1. **Before the merge, at a quiet moment:** the read-only preflight, each block as
   `begin transaction read only; <block>; rollback;`. Every ok column true (v92 recorded, v95 not; the four bodies v92's;
   the helper absent; no idle transaction or lock wait). Block 3 is for the reader. Block 5 is the prefix check on the
   merge tree (git).
2. **The deploy** runs the runner at start-up; v95 replaces four function bodies and adds one function (`lock_timeout`
   5 s). It changes no row and takes no table lock beyond the catalog's.
3. **Right after the deploy:** the read-only post-check, every ok column true.

## Rollback

`roles-closed-module-dominance-v95-rollback.sql`, one transaction, only on its own approval, after a deploy of a commit
without the v95 file. It refuses, changing nothing, when v95 is not recorded, a later migration is recorded, or a body in
force is not v95's. It restores v92's four bodies verbatim (checked by md5 at the end) and drops the helper. It changes no
row: club versions and custom roles written under v95 stay; v92's checks apply again on their next write, so a club's
admin is blocked again while its licence closes a module its roles carry.

## Evidence

- `backend/tests/roles-v95-closed-module-dominance.test.mjs` (disposable database, the real runner): the migration's
  round trip - the same club admin's write refused under v92's bodies after the rollback and passing again after the
  re-apply - and the rollback's refusals (a later migration, a changed body); the fix with Tests closed (a club version
  and a custom carrying `tests.view`; reopened, the words act again); the stricter half (a closed word the admin would
  not hold, refused in a version and in a custom); open modules and a platform admin unchanged; the helper for another
  club's admin and an inactive user.
- The rehearsal, on PostgreSQL 16 in the executor's container; PostgreSQL 17 is the owner's run.
