# Runbook: migration v48 and the T5 activation writes (phase 7d)

Contract: `docs/ai/phase7d-mapping-activations-contract.md` (J10; accepted on 2026-10-30 by the *Rukovodilac*'s and the
*Nezavisni revizor*'s GO; C106's breadth confirmed by the owner's „Odobravam PR #291."; R1–R9 decided by the
*Rukovodilac*).

- **v48** (`migrations_v2/202610301900_training_load_v48_mapping_activations.sql`): the database actor guard of every
  write of `training_load.source_metric_mapping_activations` (T5; C76), with the `club_admin` basis C106 adds.
  - **`training_load.source_metric_binding_club(binding)`**: the owner club of the binding's connection when it is
    club-owned, NULL otherwise - never the team's club. The guards below and the services use it.
  - **T5's two basis CHECKs** admit `club_admin`.
  - **The T5 insert guard** (v34's body, changed): the activator is the acting user of the transaction (the v35 setting
    `optimove.source_metric_actor`); a binding whose connection is not club-owned takes no activation; the activated
    basis is the one the database derives for the binding's club (an active platform admin, or that club's active
    admin, while the club is active).
  - **The T5 update guard** (v34's body, changed): an end names the acting user, at the time of its own transaction,
    with the basis derived for the binding's club (`admin_ended`) or without the club gate (an end written by a
    version's replacement or disable: an active platform admin, whatever the club's state).
  - **At COMMIT** (two deferred constraint triggers): every start has its `activation_start` audit row, every end its
    `activation_end` row; a version-driven end sits in the transaction that disabled its version, and a
    `mapping_version_replaced` end in the operation of its mapping's replacement.
  - **The audit table (T8)**: `source_metric_audit_row_ok` admits `club_admin` on the two activation actions; v34's
    insert guard names a club-admin activation row's club through its binding; v35's actor guard derives an activation
    row's basis as its write did; v47's revision guard gains the activation branch (the row follows its own start or
    end, with its reason, once - a unique index makes "once" physical).
  - No table, column or data change.
- **The code** (one release with v48): `backend/src/sourceMetricActivationService.js`,
  `backend/src/sourceMetricActivationSteps.js`, the access helpers in `backend/src/sourceMetricAccess.js`, the D6 steps
  in `backend/src/sourceMetricMappingService.js` (A1, A2) and `backend/src/sourceRevisionLifecycleService.js` (the
  pinned step), and the routes in `backend/src/routes/sourceMetrics.js`:
  - `POST /api/training-load/sources/metrics/activations` starts one active version on 1–50 listed bindings (201);
  - `POST …/activations/:activationId/end` ends one activation (200);
  - `GET …/activations?bindingId=…|versionId=…[&state=open|ended|all]` lists them in pages of 100;
  - an active platform admin (the platform workspace or a club workspace) and the active admin of the club that owns
    the binding's connection, in that club's workspace; everyone else gets the identical 404;
  - A1 (activate, replace) and A2 (disable) end the open activations of the version they disable instead of refusing
    `activation_open`, and A1 may start the activated version on listed bindings; the revision lifecycle's pinned step
    ends them too.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets v47.

**The code needs v48; v48 does not need the code.** The new routes write the audit rows v48 checks, and v47 refuses
every activation audit row, so a start or an end fails (`500`) on a database without v48 - which the deploy order rules
out. Without the new code, v48 changes nothing a writer does: no code wrote a T5 row before phase 7d.

**v48 is written on v47's text**: it replaces v47's body of the audit guard, and the preflight checks that body's md5.
v48 is merged only after phase 7c (v47).

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

The same day as the merge and deploy:

1. Run `docs/runbooks/mapping-activations-v48-preflight.sql` one block at a time. Every value must be the expected one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows v47 as the last migration, with its checksum;
   - block 3 shows the six bodies v48 replaces as the ones in force;
   - **block 4 is a hard assertion: `safe_to_merge = true` (no T5 row and no activation audit row).** Anything else:
     stop, do not merge, report;
   - block 5 shows no binding whose connection is not club-owned (`bindings_without_club = 0`): v48 refuses a start
     on such a binding, so one would refuse in production with no visible reason;
   - block 6 shows no v48 object and v34's two basis CHECKs;
   - block 7 shows the migrator's role may create the objects and owns both tables, and every trigger of both tables
     enabled;
   - block 8 shows no actor default;
   - block 9 must show a quiet moment on both tables.
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request, the exact file
`migrations_v2/202610301900_training_load_v48_mapping_activations.sql` and its sha256 (given in the pull request), with
this preflight the same day.

## Deploy order

1. The owner's preflight the same day.
2. The owner's order naming the pull request, the v48 file and its sha256.
3. The merge from exactly the reviewed head.
4. The deploy, started by the owner.
5. The *Rukovodilac*'s smoke (without a login, the three new routes answer `401`).
6. The owner's post-check.

While v48 runs, every read of the activations (an A1 or A2, the revision lifecycle, a T6 guard) waits for its short
run. While the old server still serves during the deploy, it has no activation route (`404`), and its A1 and A2 refuse
`activation_open` on an open activation - none exists before the new server.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before any activation is started or ended, run `docs/runbooks/mapping-activations-v48-postcheck.sql` one block at a
   time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 compares the nine function bodies by md5;
   - block 3 shows the two basis CHECKs with `club_admin`, validated;
   - block 4 shows the two deferred links enabled, deferrable and initially deferred, and T5's two guards enabled;
   - block 5 shows the index valid;
   - block 6 shows no activation yet.

## A rollback

`docs/runbooks/mapping-activations-v48-rollback.sql` (rehearsed on disposable databases by
`backend/tests/mapping-activations-7d.test.mjs`). It refuses, changing nothing, once any activation or any activation
audit row exists: from then on the way forward is a new migration. Before it is run anywhere real: a fresh
restore-verified backup; the deployed commit no longer carries v48 or the phase 7d routes; the owner's approval for that
database.

## Starting and ending: what happens

- **A start** names its bindings explicitly; the server never adds a binding that is not named, and never a future
  one. One open activation per binding, source field and parameters, and one source per binding and canonical variable
  at each level.
- **An end** (`admin_ended`) stops that binding importing through that version; its reason is written to the audit row
  only.
- **A replacement (A1) or a disable (A2) of a version** ends every open activation of the version it disables - on
  every club's binding for a system version, an archived club's included - and reports how many (`activationsEnded`).
  A replacement does not restart them: the caller lists the bindings to start the new version on.
- **Retiring or replacing a source revision** ends the open activations of the versions pinned to it, with the fixed
  reason "Source revision retired.".
- **A club's own version on an archived club** stays as phase 7b decided: A1 and A2 are the identical 404, the pinned
  step answers `409 club_archived`, and its activations stay open until the club is restored.
- **A club admin granted the platform admin role while a start or an end runs** gets `409 try_again` when the grant
  lands before the request's rights check (the promotion probe). When it lands after that check, the database derives
  `platform_admin` against the request's `club_admin` and refuses with `42501`. The answer is then a sanitized `500`,
  nothing is written, and a retry succeeds. This is v35's rule (C79) and is accepted.
- **An Unbind** never touches an activation (C58). An activation left open on an ended binding applies to nothing, the
  list shows it with `bindingState: "ended"`, and an end stops it.
