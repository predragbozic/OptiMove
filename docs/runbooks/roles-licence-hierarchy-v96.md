# v96: the licence hierarchy (Training Load and its children)

Migration `migrations_v2/202611281000_roles_v96_licence_hierarchy.sql`. The owner's decision P-4 of 2026-11-25, as
relayed by the *Rukovodilac* of OptiMove; design and the manager's GO in `docs/ai/roles-v-steps-plan.md` section 13.1
(V-5a). The files beside this one are:
- `roles-licence-hierarchy-v96-preflight.sql`;
- `roles-licence-hierarchy-v96-postcheck.sql`;
- `roles-licence-hierarchy-v96-rollback.sql`.

The rehearsal tool is `backend/scripts/roles-licence-hierarchy-v96-rehearsal.mjs` (Node 20 or later), with `.sh` and
`.ps1` wrappers (the `.ps1` asks for the password hidden when `PGPASSWORD` is not set).

## The rule

- **Training Load is a parent module.** Its children are **Dashboards**, **Imports** and **Data configuration**. The
  `load.*` words (RPE, activities, schedules, roster) are Training Load's own module already.
- **Closing the parent** in a club's licence closes every child for that club as well.
- **Each child can still be closed on its own.** A child closed on its own stays closed when the parent is put back.
- **One level only:** a child has no children and a parent has no parent.
- **The stored rows are the decisions.** `club_permission_ceiling` keeps exactly what a platform admin closed. The
  effective ceiling (a module's own row, or its parent's) is derived on every read; no row is written or rewritten.
- A platform admin is never limited (unchanged).

## What it does

- **`public.permission_module_parent(module)`** (new, immutable): the fixed hierarchy (the three children →
  `training_load`, everything else null). A function, not a column, because v84 fixes `public.permission_modules`.
  Its JavaScript twin is `MODULE_PARENTS` in `backend/src/permissionModules.js`; a test pins them equal.
- **`public.permission_club_module_closed(club, module)`** (new): the effective ceiling of one module in one club.
- **Three bodies replaced** (md5-gated), each changing only its ceiling test to the effective one:
  - `user_has_permission` step 6 (v92): a child word in a club whose Training Load is closed answers no;
  - `permission_club_rule7_ok` (v92): "minus the closed modules" leaves out the effectively closed ones;
  - `permission_actor_holds_in_club` (v95): the dominance of a closed word reads the effective ceiling.
- `permission_club_closed_modules` is **unchanged**: it returns the stored rows, which the licence writer and screen
  read.
- The two new functions are not executable by `PUBLIC`, `anon`, `authenticated` or `service_role` (v92's convention).
- **The server.** `authz.js` turns each holding's stored rows into the effective set (`effectiveClosedModules`), so
  `can()` and `/me` follow with no change of their own. The role and custom-role checks of
  `permissionLayersService.js` read the effective set (they mirror the database's rule 7 and dominance); the licence
  writer keeps the stored rows. The licence read (`GET /api/organization/roles/clubs/:clubId/ceiling`) gives every
  module its `parent`, `closedByParent` and `effectivelyClosed`.
- **The screen** (Settings > Clubs > a club's licence): a child of a part that is not included shows "Not included",
  its switch is disabled, and the note says "Closed because Training Load is closed." When it is also taken out on its
  own, the note adds that it stays out when Training Load is put back.

## Effect on existing data

Only a club whose stored ceiling holds `training_load` sees a change: its role holders lose the children it did not
close on its own. The preflight's block 3 counts those (club, child) pairs (`children_newly_closed`).

- **The owner's test club in production** (Training Load, Dashboards, Data configuration and Imports all stored as
  closed): its effective set is the same four modules, so nothing changes for it. When Training Load is put back
  later, the three children stay closed (they were also closed on their own); the screen says so, and they are put back
  one by one.
- **Which children act today.** Data configuration is checked through `can()` since V-1, so closing Training Load now
  closes it for the club's admin and role holders. Dashboards and Imports follow the licence once their own words are
  checked (their row keeps "This part does not follow the licence yet"). Training Load's own words are checked in V-5b.

## Deploy

1. **Before the merge, at a quiet moment:** the read-only preflight, each block as
   `begin transaction read only; <block>; rollback;`. Every ok column true (v95 recorded, v96 not; the three bodies
   v92's and v95's; the new functions absent; the four modules in the catalog; no idle transaction or lock wait).
   Block 3 is for the reader. Block 5 is the prefix check on the merge tree (git).
2. **The deploy** runs the runner at start-up; v96 replaces three function bodies and adds two functions
   (`lock_timeout` 5 s). It changes no row and takes no table lock beyond the catalog's.
3. **Right after the deploy:** the read-only post-check, every ok column true; block 4's `closed_rows` equals the
   preflight's block 3 `closed_rows`.

## Rollback

`roles-licence-hierarchy-v96-rollback.sql`, one transaction, only on its own approval, after a deploy of a commit
without the v96 file. It refuses, changing nothing, when v96 is not recorded, a later migration is recorded, or a body
in force is not v96's. It restores v92's two bodies and v95's helper verbatim (checked by md5 at the end) and drops the
two new functions. It changes no row: a club that closed Training Load but not a child gets that child back for its
role holders in the database.

**A club that needs the hierarchy.** A club version written under v96 while only Training Load was closed may drop a
child word (rule 7 left that child out). The rollback checks rule 7 for every club with the restored bodies, and
refuses, changing nothing, when one would break it; that club's version is fixed first. (A club version or custom role
admitted by v96's looser dominance stays as it is: dominance is checked only when a role is written.)

The same refusal can happen under v96, and is intended: putting Training Load back while the club's Club admin version
lacks a child word another role holds is refused as `409 club_admin_would_lack`, nothing changed (test 5b).

**Roll the code back together with the SQL.** The server code of this step derives the hierarchy itself
(`effectiveClosedModules`), so after a rollback of v96 alone (this code still deployed) `can()` keeps refusing a
child of a closed parent while the database's twin, rule 7 and dominance hold it again: the route gate is stricter
(fail closed), but the database guards and the server disagree. Deploy a commit without this step's code (and without
the v96 file) first, then run the rollback.

## Evidence

- `backend/tests/roles-v96-licence-hierarchy.test.mjs` (disposable database, the real runner and the real server):
  - the JavaScript twin equals the database for every module and all 16 combinations of the four stored rows;
  - the migration's round trip (sha256, md5, privileges, rollback, re-apply) and its refusals (a later migration, a
    changed body; the migration itself over a changed body);
  - `can()` and the twin agree at club and team scope for the club admin and a team coach, with Training Load
    closed, a child closed alone, and all open; a platform admin is never limited;
  - the owner's production shape before and after the parent is put back;
  - rule 7 and dominance with the parent closed (looser), the stricter half, and the same Club admin version refused
    before v96;
  - the API: the licence read, the writer storing only what it is asked, `/me`, and Data configuration's identical
    404 for the club's admin while Training Load is closed.
- `backend/tests/roles-v96-rehearsal-guards.test.mjs`: the rehearsal's guards, eol=lf, and the rollback restoring the
  three bodies verbatim.
- The rehearsal, on PostgreSQL 16 in the executor's container (every step PASS). PostgreSQL 17 is the owner's run.
