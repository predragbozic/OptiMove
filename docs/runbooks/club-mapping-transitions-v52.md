# Runbook: migration v52 and a club's admin activating its club's mappings (phase 7h)

Contract: `docs/ai/phase7h-club-admin-mappings-contract.md` (J14; accepted by the owner on 2026-11-02 with O1–O6 as
recommended, C126–C131; R1–R13 decided by the *Rukovodilac*).

- **v52** (`migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql`): before v52 a club's admin
  created, versioned and submitted its club's mappings and started and ended activations (C106), but only a platform
  admin could activate, replace or disable a version. v52 opens those steps, and the activation ends they write, to
  club X's active admin on club X's own mapping versions.
  - **A check before anything changes:** the four bodies v52 replaces are the ones in force (by md5: v34's
    `source_metric_mapping_versions_update_guard`, v48's `source_metric_audit_row_ok`,
    `source_metric_audit_actor_guard` and `source_metric_activations_update_guard`), and T4's two basis CHECKs are
    v34's; otherwise the migration refuses (`23514`) and changes nothing.
  - **T4** (`source_metric_mapping_versions`): `activated_basis` and `disabled_basis` admit `club_admin`. The update
    guard splits the activation and the disable by basis, as the submit already did: `platform_admin` needs an active
    platform admin, `club_admin` a club mapping and its club's active admin of an active club, anything else `42501`.
  - **T8** (`source_metric_audit`): the row shape admits `club_admin` on `mapping_status` to `active` or `disabled` and
    on `mapping_version_replaced`.
  - **The version-driven activation end** (a version's replacement or disable): T5's update guard and T8's actor guard
    derive the basis as the version's own transition did - an active platform admin whatever the club's state, else,
    for a club mapping's version, the club's active admin of an active club - and refuse a club version's activation on
    a binding of another club or of no club (`23514`, R3).
  - T4's table comment names the new rule. No table, column, trigger, index or data changes.
  - **Locks:** T4 `ACCESS EXCLUSIVE` with `NOWAIT`, then T5 and T8 `SHARE ROW EXCLUSIVE` within the runner's
    `lock_timeout` (30 s).
- **The code** (one release with v52):
  - `mayTransitionMappings` (`backend/src/sourceMetricAccess.js`) admits `club_admin` on a club scope; the routes
    `POST /api/training-load/sources/metrics/mappings/:mappingId/versions/:versionId/activate` and `…/disable` are
    unchanged otherwise (no new route, no body change). A club's admin naming a system mapping or another club's gets
    the identical 404 from the service's owner filter.
  - The version-driven ends of A1 and A2 write the caller's basis (`endOpenActivations`, `endAuditRows`); the revision
    lifecycle's pinned step keeps `platform_admin`.
  - `rightsStillHold`'s club-admin query locks the `users` row before the role row (`for share of u, r`), the order of
    the club-admin revocation (R13).
  - `submitVersion` answers its state refusals only after the right (R5).
  - The Mappings screen offers *Activate*, *Replace version N* and *Disable* to a club's admin on the club's own
    mappings, with the sentences of J14 section 8.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets v51 without v52.

**Deploy compatibility.** The new schema with the old code is safe: the old code writes only `platform_admin`, which
v52 still admits. The same holds after a code rollback. A schema rollback is refused once a 7h-only row exists.

## Before the merge (the standing order for migration PRs)

`docs/ai/metrics-core-plan.md`, section 2, "Standing order for migration PRs", applies. The executor never calls a
Supabase connector tool and never touches the production database.

1. The *Rukovodilac* runs `docs/runbooks/club-mapping-transitions-v52-preflight.sql` read-only, one block at a time,
   on the same UTC day as the merge. Every value must be the expected one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows v51 recorded with its checksum as the last migration, and no v52;
   - block 3 shows the four bodies v52 replaces in force (v34's T4 guard, v48's three);
   - block 4 shows T4's two basis CHECKs and T4's table comment as v34 wrote them;
   - block 5 shows every trigger of T4, T5 and T8 enabled (6, 5 and 7 of them), the two CHECKs and the four functions;
   - block 6 shows the migrator's role owns T4, T5, T8 and the four functions;
   - block 7 shows no actor default;
   - block 8 shows a quiet moment: no lock on T4, no writer on T5 or T8, no running check or identity load, no session
     idle in a transaction; the import switch (`GPEXE_IMPORT_APPLY_ENABLED`, a Render variable) is off;
   - block 9 is a sanity line: no row of the kinds only 7h can write.
2. Both ★★ GOs on the exact head, then the owner's order that names v52 (the *Rukovodilac* asks for it once both GOs
   are on the same head).

## Deploy order

1. The merge from exactly the reviewed head.
2. The owner's deploy of exactly that commit, **right after** the *Rukovodilac*'s preflight block 8 came back clean.
3. The *Rukovodilac*'s smoke (without a login the two transition routes answer `401`) and its read-only post-check.

No PR is merged into `main` from the merge until the deploy and the post-check have passed.

### Ako deploy padne na zaključavanju (L2)

v52 uzima tabelu verzija mapiranja (T4) sa `NOWAIT`: ako je u tom trenutku bilo ko čita ili piše (ekran Mappings, A1,
A2, uvoz), migracija odmah pada sa porukom *could not obtain lock on relation* (SQLSTATE `55P03`). Tabele aktivacija
(T5) i audita (T8) čekaju najviše 30 sekundi; ako ih neko drži duže, migracija pada sa *canceling statement due to lock
timeout*. U oba slučaja:

1. **Ništa nije primenjeno**: migracija je jedna transakcija, v52 nije upisana u `schema_migrations`, stara verzija
   servera i dalje radi.
2. Ništa se ne briše i ništa se ne vraća ručno. Rollback skripta se **ne** pokreće (v52 nije primenjena, pa bi je
   ionako odbila).
3. Sačekaj miran trenutak (nema uvoza, nema otvorenih sesija u Mappings ekranu).
4. *Rukovodilac* ponovo pokreće blok 8 preflight-a; sve vrednosti moraju biti 0.
5. Odmah posle toga ponovi deploy istog commit-a.

Ako i drugi pokušaj padne na isti način, stani i javi *Rukovodiocu* (koji red čekanja drži tabelu, iz bloka 8).

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before any club admin activates, replaces or disables a version, run
   `docs/runbooks/club-mapping-transitions-v52-postcheck.sql` one block at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 compares the four bodies by md5;
   - block 3 shows the two widened CHECKs and v52's T4 comment;
   - block 4 lists the 18 triggers of T4, T5 and T8 by name, enabled, each on its function;
   - block 5 shows no 7h-only row yet;
   - block 6 shows nothing left behind (no lock on the three tables, no migrator lock, no session idle in a
     transaction).

## A rollback

`docs/runbooks/club-mapping-transitions-v52-rollback.sql` (rehearsed on disposable databases by
`backend/tests/source-metric-mapping-club-admin-7h.test.mjs`). One transaction with `lock_timeout` 5 s and the
migrator's advisory lock. It refuses, changing nothing, under a later migration, while a v52 object is missing or a
trigger is disabled, while a body in force is not v52's, while the migrator holds its lock, and **once a row only 7h
can write exists**:

- a T4 version activated or disabled on the `club_admin` basis;
- a T8 `mapping_status` row to `active` or `disabled`, or a `mapping_version_replaced` row, on the `club_admin` basis;
- a T5 activation ended on the `club_admin` basis by a version's replacement or disable;
- a T8 `activation_end` row on the `club_admin` basis whose activation ended so.

It does **not** refuse on the `club_admin` rows phase 7d and M2 already write (`mapping_create`,
`mapping_version_create`, `draft → needs_review`, `activation_start`, `activation_end` with `admin_ended`). Once a
7h-only row exists the way forward is a new migration. Otherwise it restores v34's two CHECKs, v34's T4 comment
verbatim and the four bodies byte for byte, and deletes v52's record. Before it is run anywhere real: a fresh
restore-verified backup; the deployed commit no longer carries v52 or phase 7h's code; the owner's approval for that
database.

## A known limit until the lock-order pull request

A club's admin's A1 with listed starts, an Unbind of one of those bindings and a revocation of the club's admins at
the same moment can end in `40P01`: A1 and the Unbind answer `try_again`, the revocation a 500, and nothing is written.
A1 locks its rights before its listed bindings (J15 section 5, R13). The lock-order pull request, which follows 7h-B,
removes it; until then the *Rukovodilac* accepts it (J14 section 15, the acceptance's L2 note). It is built as LO-1
(J14 section 18): from the deploy of LO-1 on, A1 takes its listed bindings and teams before its rights, and this
limit no longer holds.

## What a club's admin can do now

- **Who:** club X's active admin, in club X's workspace, on club X's own mapping versions. A platform admin keeps
  every right it had; a system mapping, a source field's unit and meaning, the revision lifecycle, the conversions and
  D9 stay the platform admin's.
- **What:** activate a version waiting for review (optionally switching it on for the club's teams in the same step),
  replace the active version (keeping its teams), and disable a draft, waiting or active version (its teams are
  switched off with the version's reason).
- **The rows say who:** `activated_basis` / `disabled_basis` `club_admin` on T4, `ended_basis` `club_admin` on the
  ended T5 rows, basis `club_admin` on their T8 rows.
