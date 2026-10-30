# Runbook: migration v45 and changing a variable's icon (PR-1b, I1)

Contract and as built: section J3b.11 of `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *Rukovodilac*'s order
and decisions of 2026-10-30, after the owner's words quoted there).

- **v45** (`migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql`) makes an icon change the fourth kind
  of v38's audited change of a canonical variable:
  - `metric_variable_changes` gets `old_icon_url` and `new_icon_url` and the kind `icon`. An `icon` row keeps the state
    `active` and the three texts and changes the icon, to `null` or `icon:` and a key's shape. A rename, an archive and
    a restore keep the icon.
  - The trigger `metric_definitions_v38_record_change` fires on `icon_url` too, and its function writes the two icon
    values.
  - `metric_variable_requests` gets the operation `variable_icon`, and its guard pairs it with the kind `icon`.
  - So an update of `icon_url` on a system or club variable needs the acting user and its request row in the same
    transaction, exactly like a rename. Without them the database refuses it (`42501`, or `23514` at COMMIT).
  - No table, no index, no row is added or changed.
- **The code** (one release with v45): `POST /api/training-load/sources/metrics/variables/:variableId/icon`
  (`backend/src/canonicalVariableAdminService.js`, `backend/src/routes/sourceMetrics.js`), and **Change icon** in the
  variable's detail (Training Load → Data configuration → Variables).

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets a database without v45.

**v45 and the code go together.** Without v45, v38 writes no change row for an icon-only update, so the service stops
before the request row (`500`, nothing written): nothing unaudited can be written, but every icon change fails. While v45 is
applied and the old server still serves during the deploy, the old server has no icon route (`404`); its renames,
archives and restores write their change rows as before, with the icon unchanged.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

The same day as the merge and deploy:

1. Run `docs/runbooks/metric-variable-icon-v45-preflight.sql` one block at a time. Every value must be the expected
   one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows v43 and v38 with their checksums, the roster's v44 (PR #275) as the last migration with its
     checksum, and no v45;
   - block 3 shows that the two functions, the two triggers and the five checks v45 changes are v38's, every trigger of
     the three tables enabled;
   - block 4 shows no v45 object;
   - block 5 shows the migrator's role owns the three tables;
   - block 6: no row outside v38's kinds; record `change_rows` and `request_rows` (the post-check's baseline) and the
     icon counts (information only);
   - block 7 shows no actor default;
   - block 8 must show a quiet moment on the three tables.
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request, the exact file
`migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql` and its sha256 (given in the pull request), with
this preflight the same day.

## Deploy order

1. The owner's preflight the same day.
2. The owner's order naming the pull request, the v45 file and its sha256.
3. The merge from exactly the reviewed head.
4. The deploy, started by the owner by hand.
5. The *Rukovodilac*'s smoke (without a login, the new route answers `401`).
6. The owner's post-check.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before anyone changes an icon, run `docs/runbooks/metric-variable-icon-v45-postcheck.sql` one block at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 shows the two icon columns, nullable text;
   - block 3 compares both function bodies by md5, shows their v45 comments and both triggers enabled, the writer's on
     `icon_url` and the guard's on `variable_icon`;
   - block 4 shows the five checks with the icon;
   - block 5: `change_rows` and `request_rows` equal to or above preflight block 6, `unpaired_icon_rows = 0`,
     `icon_changes = icon_requests` (both `0` before anyone used the route);
   - block 6 shows no actor default.

## If v45 refuses at deploy

**Lock timeout or deadlock.** v45 takes `ACCESS EXCLUSIVE` on `metric_variable_requests`, then `SHARE ROW EXCLUSIVE` on
`metric_definitions` (its plain reads go on, writes wait), then `ACCESS EXCLUSIVE` on `metric_variable_changes` - the
order a write takes them, the request record first. The Variables screen's reads, which join the change record, wait
until v45 commits (seconds). A long write on one of the tables makes v45 fail on the runner's lock timeout (`55P03`); a
read that took the change record before the request record can meet v45 in the other order for a moment, and
PostgreSQL then ends one of them (`40P01`). Either way nothing of v45 is written (one transaction), the new server
does not start, and the old server keeps serving.
1. Check that no session holds a lock on the three tables (block 8 of the preflight).
2. Run the deploy again in a quiet moment.
3. If it fails the same way again, report to the owner. No manual change in the database.

**A check refuses an existing row.** It cannot happen: the two new columns start empty, which every v38 kind accepts,
and block 6 of the preflight shows no other kind. If it happens anyway, nothing is written; report to the owner.

## When a block of the post-check differs

- **Block 1 or 3:** the recorded file or a function is not the repository's, or a trigger is missing or disabled. Stop
  and report; change nothing. Do not enable or create a trigger by hand. (`CREATE OR REPLACE TRIGGER` leaves both v45
  triggers enabled even if one was disabled before; preflight block 3's `disabled_triggers = 0` is what guards that.)
- **Block 2 or 4:** a column or a check is not v45's. Stop and report; change nothing.
- **Block 5:** a count below the preflight's, or an icon change without its request (or the reverse). Stop and report
  which. A value above the preflight's is an ordinary rename, archive, restore or creation between the two checks.

## Rollback

On the owner's approval only, for the database the owner names (`.claude/rules/database-safety.md`):
- after a fresh restore-verified backup;
- with the deployed commit no longer carrying the v45 file (otherwise the migrator applies it again at the next start)
  nor the icon route.

Run `docs/runbooks/metric-variable-icon-v45-rollback.sql` in a quiet moment as one transaction that stops at the first
error (`psql -v ON_ERROR_STOP=1 -f`; the script carries its own `BEGIN` and `COMMIT`). It refuses, changing nothing:
- while the migrator is running: it takes the migrator's advisory lock for its own transaction, without waiting;
- without v45, or under a later migration;
- once any icon change or `variable_icon` request exists: they are the only record of who changed an icon, so from
  then on the way forward is a new migration, never this script;
- while a v45 column is missing or a v45 trigger is disabled.

It takes the three tables' locks before its checks, restores v38's two functions (byte for byte, without a comment),
triggers and five checks, drops the two icon columns and removes the v45 record. After it, the catalog before v45 comes back
exactly, and v45 can be applied again.

## Using the route

- `POST …/variables/:variableId/icon` `{ requestKey, expectedIconKey, iconKey }`: `iconKey` is a key of the icon library
  or `null` (no icon); `expectedIconKey` is the key the caller saw (`null` for none, and for a stored value that is not
  a library key).
- Who: the callers of a rename - an active platform admin, the active admin of the variable's club in that club's
  workspace, and for a club variable a coach of one of the club's teams in that team's workspace. A coach may also
  change the icon of a variable an active mapping version pins (an icon is display only).
- Refusals: `409 variable_not_active`, `409 variable_changed` (another icon is stored; the answer carries the current
  variable), `409 icon_unchanged`, `400 invalid_body` for a key outside the library; the identical `404` for everyone
  else.
- A lost answer is repeated with the same `requestKey`: the same request replays the current state and never writes
  twice. A key used with another body is `409 request_key_reused`.
