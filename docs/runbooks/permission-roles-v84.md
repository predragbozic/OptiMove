# v84: roles and permissions (step R2)

Migration `migrations_v2/202611201000_roles_v84_permission_roles.sql`. Contract: `docs/ai/roles-r2-contract.md`
(accepted 2026-11-19). Files beside this one: `permission-roles-v84-preflight.sql`, `permission-roles-v84-postcheck.sql`,
`permission-roles-v84-rollback.sql`. The rehearsal tool: `backend/scripts/permission-roles-v84-rehearsal.mjs` with its
bash (`.sh`) and PowerShell (`.ps1`) wrappers.

## What it does

- Nine tables in `public`: the catalog (`permission_modules`, `permissions`, `permission_scope_types`), the roles
  (`permission_roles`, `permission_role_items`, `permission_role_module_display`), their change record
  (`permission_role_changes`), the non-basic assignments (`user_role_assignments`) and the Roles API's request record
  (`permission_requests`). Row-level security on each, no policy; nothing granted to `PUBLIC`, `anon` or `authenticated`.
- A literal seed: 12 modules, 52 permissions, 89 scope rows, the four basic roles with literal ids and 10 item rows
  (Club admin: R1's six words plus `roles.manage`; Team coach: three; Platform admin and Independent coach: none). It
  reads no existing row and assigns no role to anyone.
- The SQL twin of `can()` (`public.user_has_permission`), `public.user_holds_role_items`, `public.lock_permission_actor`,
  and the guards (the acting user, the ceiling and dominance, rule 7, the change and request records, append-only).
- Last, one CHECK on each old scoped role table: `user_club_roles.role = 'club_admin'`, `user_team_roles.role =
  'team_coach'`. A `DO` block refuses the whole migration first if a row of another word exists (none on production
  on 2026-11-19; preflight block 3 counts again).

With it the application (the same pull request) reads the basic roles' items from the database in `can()`, and the
Roles API (`/api/organization/roles`) exists. For every existing account every `can()` answer is R1's, apart from
`roles.manage`, which a club's admin now holds at its club: only the Roles API checks that word.

## Who merges, and when

- The *Rukovodilac* of OptiMove merges on its own decision after the *Nezavisni revizor*'s review and its gate (the
  owner, 2026-11-19, as relayed; contract section 7). It runs the preflight and the post-check, read-only.
- **A merge to `main` is the deploy** (Render Auto-Deploy): the migration runs at the start of the server that merge
  triggers. So the preflight is run right before the merge, at the quiet moment chosen for it, and R2 is merged whole.

## Before the merge

1. **PostgreSQL 17 rehearsal** (the *Rukovodilac*'s condition; production runs 17.6). On any computer with a
   PostgreSQL 17 server on loopback, `node` and this repository (`npm --prefix backend ci` once):
   - Linux / macOS: `backend/scripts/permission-roles-v84-rehearsal.sh --host 127.0.0.1 --port 5432 --user postgres --pg-bin /usr/lib/postgresql/17/bin`
   - Windows: `powershell -ExecutionPolicy Bypass -File backend\scripts\permission-roles-v84-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres -PgBin "C:\Program Files\PostgreSQL\17\bin"`

   It asks for the password once (hidden; or takes `PGPASSWORD`), creates and drops its own
   `optimove_tests_r2rehearsal_*` databases, refuses any other host, and prints PASS / FAIL per step: the build through
   the migration before v84, the preflight, the apply, the post-check, the runner's checksum skip, the rollback (the
   catalog back to the one before v84), the second apply, a real guarded write after each apply (steps 3b and 7b: the
   acting user's same-transaction check reads `xmin` and `pg_current_xact_id()`, the most version-sensitive part; the
   write without the acting user must be refused with 42501), and the `pg_dump` / `pg_restore` read-back of v84's
   constraints, generated columns, triggers, indexes and functions (M7). Exit code 0 only when every step passed.
   The user needs the right to create databases and a superuser for the legacy seed replay.
   **State: PostgreSQL 16.15: PASS (the executor's container, 2026-11-19). PostgreSQL 17: NOT RUN.** How to read a
   failure on 17 only:
   - step 3b / 7b (the guarded write) or step 8 (a CHECK, a trigger or a function that does not read back the same after
     `pg_dump` / `pg_restore`): a finding for the migration;
   - every other step green, and only a digest of post-check block 3 (`triggers_as_written`, `functions_as_written`,
     `constraints_as_written`) differs: 17 renders that catalog text differently. Re-take that digest from the 17
     rehearsal (block 3 fixes its own `search_path`), record both values, and do not treat it as a migration fault.
2. **The preflight**, read-only, each block in `begin transaction read only; ... rollback;`, right before the merge:
   every `ok` column true; keep block 3a's row for post-check block 6a; block 7 read at the moment of the merge; block 8
   (the unique 12-digit prefix on the merge tree) in git; block 1b (no recorded checksum differs from the merge tree's
   files): `node backend/scripts/permission-roles-v84-checksums.mjs > v84-checksums.sql` on the merge tree, then that one
   statement read-only (`no_recorded_checksum_differs` true). After the deploy, post-check block 1 compares v84's recorded
   checksum with the file's sha256 written in it (the runbook test keeps that literal equal to the file).

## Locks and the quiet moment

- The new tables lock nothing that exists, apart from the foreign keys to `users`, `clubs` and `teams` (`SHARE ROW
  EXCLUSIVE` for the moment of each statement).
- The two `ADD CONSTRAINT ... CHECK` take `ACCESS EXCLUSIVE` on `user_club_roles` and `user_team_roles` until the
  migration commits. Every signed-in request reads both, so they are the last statements of the file, after `set local
  lock_timeout = '5s'`.
- **If an `ADD CONSTRAINT` waits longer than 5 s:** the statement fails, the whole migration rolls back (the runner
  applies a file in one transaction), nothing of v84 remains, and `npm start` stops: the new deploy does not start and
  the previous instance keeps serving. Read preflight block 7 and start the deploy again at a quiet moment.
- A request of the old instance that meets the lock waits for the COMMIT; nothing it writes is refused by v84.

## After the deploy

The post-check, read-only, each block in `begin transaction read only; ... rollback;`: every `ok` column true; block 6a
equal to preflight block 3a (v84 rewrote no row of the old role tables). The digests of block 3 (triggers, functions,
constraints) and the seed fingerprint of block 4 were taken from the rehearsal on PostgreSQL 16.

## The way back

**The plan of return is redeploying the previous code; v84 stays in the database.** v84 is forward-only in practice.

- **Why that is safe** (checked on PR-A's head `e5fe035`, the previous code):
  - it reads none of the nine tables and calls none of v84's functions (`git grep` finds only a comment in
    `permissions.js`);
  - its only writers of the old scoped role tables (`organization.js`: the grant and revoke of `club_admin` and
    `team_coach`) insert exactly those two literals and update only `is_active` and the revocation columns, which is what
    the two new CHECKs allow (R1's source scan `permissions-r1` c1 pins it);
  - its runner walks the files on disk only, so a recorded v84 row without its file is never touched, and the server
    starts (test 1c (c): the previous code's migration folder over a database with v84; nothing changes).
- **What a club's admin loses meanwhile:** `roles.manage` (only the Roles API, which the previous code does not have,
  checks it). Every other `can()` answer is R1's.
- **The code of R2 with a database without v84 is the one case refused.** R2 reads the role tables on every signed-in
  request (`loadAuthorizationContext`) and fails closed: a platform admin still passes, every other request that reaches a
  `can()` call site answers `503 permissions_unavailable`. So v84 is never removed while R2's code is live; the code goes
  first.

How the deploy behaves (`backend/package.json`: `"start": "node src/migrate.js && node src/server.js"`):
- the new instance starts the server only after the runner applied every migration; a failed v84 (a refused `DO`
  block, a lock timeout) exits non-zero, the new server never starts, and the previous instance - the previous code,
  which reads nothing of v84 - keeps serving;
- while v84 runs, a request of the previous instance that reads `user_club_roles` / `user_team_roles` waits for the
  migration's COMMIT (the `ACCESS EXCLUSIVE` of the two `ADD CONSTRAINT`, at most `lock_timeout` 5 s each).

**The rollback SQL** (`permission-roles-v84-rollback.sql`, one transaction, `psql -v ON_ERROR_STOP=1 -f ...`) is only for
a database where nothing was applied after v84, after the previous code is deployed, and on the owner's word for that
database. "After" is decided by `schema_migrations.applied_at` (each file is applied in its own transaction, so its
`now()` orders them), never by prefix: v80 (`202611201100`) and the calendar's v83 (`202611201200`) sort after v84 but
reach production before it, and they do not refuse it; any migration applied at or after v84's own row does (test 1c).
It also refuses, changing nothing, once a role was created, changed, copied or archived, an assignment or a request
exists, a display row exists, another table refers to the nine, or the seed differs. Post-check block 1's
`applied_after_v84` shows the count.

## Known limits

- Rolling back v84 while R2's code is live makes every non-platform request that reaches a `can()` call site answer
  `503 permissions_unavailable` (fail closed, contract section 6). Roll the code back first. The same holds for a
  database restored from a backup taken before v84: apply v84 (start the server) before serving.

- The guards keep an unintended write that bypasses the service out; they are no defence against whoever holds the
  database credentials the application and the migrations share (v35's limit). With row-level security and no policy,
  a future runtime role that is not the owner reads nothing: `can()` then fails closed with `503
  permissions_unavailable` (a platform admin still passes).
- The old revocations of `club_admin` and `platform_admin` lock `for update of u, r` / `u, g` in one statement
  (interleaved users and role rows, id order inside the statement); unchanged by R2. The login switch-off's lock order
  is PR-A's (`backend/tests/login-disable-lock-order.test.mjs`).
- No route of the Roles API grants or revokes a basic role, so none lowers a count the headcount advisory locks
  protect; none takes them. A later route that can must.
- A grant that commits at the same moment as an archive of its club or team can leave an active assignment in an
  archived scope (club and team rows are not locked); it gives nothing there.
- The cap of 50 roles per club is best-effort under concurrency.
- The migration branch of the change guard (a `migration` change row needs its `schema_migrations` row in the same
  transaction) does not stop whoever can also write `schema_migrations`; it keeps an accidental write out, like v35's
  guards. A later migration that changes a basic role writes `migration_name` exactly as `migrations_v2/<file>`.
- `permission_requests_guard` does not compare a request record's `owner_club_id` with the assignment or role it names;
  the service writes it (from the checked club).
- The revokes cover `PUBLIC`, `anon`, `authenticated` and `service_role` where they exist (post-check block 2). Like
  every v84 table, `service_role` also meets row-level security without a policy.
- Narrowing a system role (a platform admin's P5) is not retroactive for clubs' own roles: a club role that holds a
  removed word keeps it, and its holders keep the right. The answer's `affected.clubRolesKeepingRemovedWords` counts
  those roles, their clubs and their holders; removing the word from a club's role is that club's own P5.
- `org.teams.manage` also empties a team: `DELETE /api/organization/teams/:teamId` (archive) ends every membership of the
  team (D45). R3's description of the word and R4 must say so (the security review's S5).
- A system role's change history, read by anyone but a platform admin, carries only `revision`, `kind`, `itemsAdded`,
  `itemsRemoved`, `at` and `byMigration` (no reason, basis or name; the security review's S1).
