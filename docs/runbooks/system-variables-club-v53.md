# Runbook: migration v53 and a club using, copying or hiding a system variable (phase 7i-B1)

Contract: `docs/ai/phase7i-system-variables-club-contract.md` (J15; accepted by the owner on 2026-11-02 with O1–O9 as
recommended, C132–C140; R1–R13 decided by the *Rukovodilac*). This pull request is 7i-B1: the migration, the backend
and the routes. **Until 7i-B2 (the screen) copy, hide, show and the move to the copy exist only as an API.** The pilot
(O8) stays on form (a): the club uses OptiMove's variable as it is.

- **v53** (`migrations_v2/202611041000_training_load_v53_system_variables_club.sql`):
  - **A check before anything changes:** the two bodies v53 replaces are the ones in force (by md5: v36's
    `metric_variable_requests_insert_guard` `ae5bf5e22620546a83cf955b8b1d9a9d`, v48's
    `source_metric_activations_insert_guard` `e47f75d4a7a6c63659a19491db97d678`), and the request table's operation
    CHECK, `version_iff`, one-create index and insert trigger are the ones v36, v38 and v45 left; otherwise the
    migration refuses (`23514`) and changes nothing.
  - **`training_load.metric_definition_copies`** (J15 7.1): one row per club and copied system variable, naming the
    system version it copied; append-only; the insert guard checks the acting user, the basis, the club variable of
    this transaction at version 1, the active system variable at its current version, equal semantics and equal
    levels; a deferred link requires the copy's `variable_copy` request at COMMIT.
  - **`training_load.source_metric_mapping_version_copies`** (J15 7.2): the link from a club draft to the active system
    mapping version it reproduces, identical in every listed column; append-only; a deferred link requires the draft's
    `mapping_version_create` audit row at COMMIT.
  - **`training_load.metric_definition_club_hides`** (J15 7.3): a club's hide of a system variable, state and history
    in one table; the hide row is the request record of the hide and its show facts the request record of the show;
    never deleted.
  - **The variable request record** (J15 7.4): the operation `variable_copy`, a nullable `operation_id` only a copy
    carries, `version_iff` and the one-create index widened to it, and v36's insert guard checking a copy as a create
    plus its copy row in the same operation.
  - **v48's T5 insert guard** (J15 7.5): for a system mapping version, the hide lock of the binding's club and the
    version's variable, then a refusal while that club hides it (`23514`). Every other line stays byte for byte.
  - **Locks:** the request table `ACCESS EXCLUSIVE` and T5 `SHARE ROW EXCLUSIVE`, both `NOWAIT`; the new tables'
    foreign keys take `SHARE ROW EXCLUSIVE` on `public.clubs`, `public.users`, `metric_definitions`,
    `metric_definition_versions` and T4 within the runner's `lock_timeout` (30 s).
- **The code** (one release with v53), under `/api/training-load/sources/metrics`:
  - `POST /variables/:variableId/copy`, `POST /variables/:variableId/hide`, `POST /variables/:variableId/show` and
    `POST /activations/:activationId/switch-to-copy`, for club X's active admin and a platform admin in club X's
    workspace; everyone else, the platform workspace included, gets the identical 404 before the body is read.
  - S1 and A1's listed starts take the hide locks of their (club, variable) pairs ascending, after their last row lock,
    and refuse a hidden variable (`409 variable_hidden`).
  - The reads: `GET /variables` and `GET /variables/:id` carry club X's facts and acts on system rows (`?hidden=` on
    the system scope), `/mappings` and `/activations` carry `targetHiddenInClub`, the older
    `GET /api/training-load/metrics/definitions` carries `hiddenInClub` and `ownerScope`, and a dashboard template
    clone in club X's data workspace prefers the club's copy of a variable club X hides.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets v52 without v53.

**Deploy compatibility.** The new schema with the old code is safe: the old code never writes the new operation or
tables, and old reads ignore them. After a code rollback with hide rows in place, the old S1 on a hidden variable meets
the new guard's `23514`, which the old code does not map: a sanitized 500 instead of `409 variable_hidden`, nothing
written (L2 below).

## Before the merge (the standing order for migration PRs)

`docs/ai/metrics-core-plan.md`, section 2, "Standing order for migration PRs", applies. The executor never calls a
Supabase connector tool and never touches the production database.

1. The *Rukovodilac* runs `docs/runbooks/system-variables-club-v53-preflight.sql` read-only, one block at a time, on
   the same UTC day as the merge. Every value must be the expected one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows v52 recorded with its checksum as the last migration, and no v53;
   - block 3 shows the two bodies v53 replaces in force (v36's request guard, v48's T5 guard);
   - block 4 shows the request table's operation CHECK (v45), `version_iff` (v38), one-create index (v36) and insert
     trigger (v38);
   - block 5 shows nothing v53 creates yet and every trigger of the request table and T5 enabled;
   - block 6 shows the migrator's role owns the request table, T5 and the two functions, and may create in the schema;
   - block 7 shows no actor default;
   - block 8 shows a quiet moment: no lock on the request table, no writer on T5 or on the foreign-key targets, no
     running check or identity load, no session idle in a transaction; the import switch
     (`GPEXE_IMPORT_APPLY_ENABLED`, a Render variable) is off;
   - block 9 is read only for the owner: how many active system variables a copy would refuse, by reason.
2. Both ★★ GOs on the exact head, then the owner's order that names v53 (the *Rukovodilac* asks for it once both GOs
   are on the same head).

## Deploy order

1. The merge from exactly the reviewed head.
2. The owner's deploy of exactly that commit, **right after** the *Rukovodilac*'s preflight block 8 came back clean.
3. The *Rukovodilac*'s smoke (without a login the four new routes answer `401`) and its read-only post-check.

No PR is merged into `main` from the merge until the deploy and the post-check have passed.

### Ako deploy padne na zaključavanju

v53 uzima tabelu zahteva za varijable sa `ACCESS EXCLUSIVE` i tabelu aktivacija (T5) sa `SHARE ROW EXCLUSIVE`, obe
sa `NOWAIT`: ako je u tom trenutku bilo ko čita tabelu zahteva (ekran Variables, preimenovanje, arhiviranje) ili piše
u T5 (uključivanje ili isključivanje varijable za tim, A1, A2, Unbind), migracija odmah pada sa porukom *could not
obtain lock on relation* (SQLSTATE `55P03`). Strani ključevi novih tabela čekaju najviše 30 sekundi na tabele klubova,
korisnika, varijabli, njihovih verzija i verzija mapiranja; ako ih neko drži duže, migracija pada sa *canceling
statement due to lock timeout*. U oba slučaja:

1. **Ništa nije primenjeno**: migracija je jedna transakcija, v53 nije upisana u `schema_migrations`, stara verzija
   servera i dalje radi.
2. Ništa se ne briše i ništa se ne vraća ručno. Rollback skripta se **ne** pokreće (v53 nije primenjena, pa bi je
   ionako odbila).
3. Sačekaj miran trenutak (nema uvoza, nema otvorenih sesija u ekranima Variables i Mappings).
4. *Rukovodilac* ponovo pokreće blok 8 preflight-a; sve vrednosti moraju biti 0.
5. Odmah posle toga ponovi deploy istog commit-a.

Ako i drugi pokušaj padne na isti način, stani i javi *Rukovodiocu* (koji red čekanja drži tabelu, iz bloka 8).

### Posle vraćanja koda dok postoje sakrivene varijable (L2)

Ako se posle deploy-a v53 vrati stari kod (rollback koda, ne šeme), a u bazi već postoji bar jedna sakrivena
sistemska varijabla (red u `metric_definition_club_hides` bez `shown_at`), onda stari S1 (uključivanje sistemske
varijable za tim kluba koji je tu varijablu sakrio) nailazi na novu proveru baze (`23514`, *the variable is hidden in
the binding's club*). Stari kod tu grešku ne prepoznaje, pa trener ili administrator dobija **sanitizovanu grešku 500**
umesto poruke `409 variable_hidden`. To je **očekivano**:

1. **Ništa nije upisano**: ceo zahtev je jedna transakcija i ona je odbijena.
2. **Ništa se ne briše**: redovi sakrivanja ostaju; brisanje bi uklonilo istoriju i ne bi bilo dozvoljeno ni
   pravilima baze.
3. Isti zahtev će raditi čim se ponovo pusti novi kod, ili čim administrator kluba ponovo prikaže varijablu (Show).
4. Za druge klubove i za varijable koje nisu sakrivene stari kod radi kao i pre.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before any club copies or hides a system variable, run `docs/runbooks/system-variables-club-v53-postcheck.sql` one
   block at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 compares the two replaced bodies and the eight new ones by md5;
   - block 3 shows the request table's widened CHECKs, `operation_id_iff`, index and trigger;
   - block 4 shows the three tables, their 13 triggers (3 deferred), all enabled, and their 8 indexes;
   - block 5 shows no copy, link, hide or `variable_copy` request yet;
   - block 6 shows no actor default and none in the session;
   - block 7 shows nothing left behind (no session idle in a transaction, no lock waiting on the tables).

## A rollback

`docs/runbooks/system-variables-club-v53-rollback.sql` (rehearsed on disposable databases by
`backend/tests/source-metric-variables-club-7i.test.mjs`: apply → rollback → the v52 catalog exactly → v53 again, every
refusal, and a failed last statement changing nothing). One transaction with `lock_timeout` 5 s and the migrator's
advisory lock. It refuses, changing nothing, under a later migration, while v53 is not recorded, while a v53 function
or a trigger of a v53 table is missing or a trigger on the request table, T5 or a v53 table is disabled, while a body
in force of the two replaced functions is not v53's, while the migrator holds its lock, and **once any copy, link or
hide row, or any `variable_copy` request, exists**: then the way forward is a new migration. Otherwise it drops the
three tables and their eight functions, restores v45's operation CHECK, v38's `version_iff`, v36's index predicate,
v38's trigger `WHEN` and both bodies byte for byte, drops `operation_id`, and deletes v53's record. Before it is run
anywhere real: a fresh restore-verified backup; the deployed commit no longer carries v53 or phase 7i's code; the
owner's approval for that database.

## Raw writers

A raw writer of the new tables, of T5 or of the request table uses READ COMMITTED (the application pins it): the hide
guard and the T5 guard read the hide state after an advisory lock, and only under READ COMMITTED does that read see a
hide or a start committed before the lock was granted.

## What a club's admin can do now (API only until 7i-B2)

- **Copy** a system variable into the club (`POST /variables/:id/copy`): a club variable equal to OptiMove's at its
  current version, with one club draft per active system mapping version; the drafts are submitted and activated like
  any club mapping (7h).
- **Hide** a system variable for the club, and **Show** it again (`POST /variables/:id/hide`, `…/show`): pickers and
  the Variables list leave it out, results and dashboards keep their names; a variable switched on for the club's
  teams cannot be hidden (`409 variable_in_use`).
- **Move a team** from OptiMove's variable to the club's copy in one step (`POST /activations/:id/switch-to-copy`):
  the team's activation of the system version ends and the linked club version starts on the same binding, with no
  moment in between.

## Which copies are refused

Preflight block 9 counts, before the merge, the active system variables a copy would refuse with
`409 copy_source_unsupported`; its `current.reason` names the case. The copy gives the first reason that applies, in
the table's order; block 9 counts each column on its own, so one variable can appear in several columns (a variable
with no unit and no level counts under `unit_not_token` and `no_levels`, and its copy answers `unit`).

| `current.reason` | The system variable | Block 9 column |
|---|---|---|
| `not_numeric` | does not hold a number | `not_numeric` |
| `unit` | has no unit or a unit that is not a unit token, or a condition whose unit is not a unit token | `unit_not_token`; a condition's unit only under `with_condition_to_review` |
| `condition` | has a condition in a shape the create rules do not accept | `with_condition_to_review` (to check one by one) |
| `day_level` | can be recorded per day | `day_level` |
| `no_levels` | has no level at all | `no_levels` |

The copy also refuses, case by case at the moment of the request, without a preflight count:
- `400 key_required` or `400 label_required`: OptiMove's key or name is not one the create rules accept; the admin sends
  a `key` or a `label`;
- `409 key_taken`: the club already has a variable with that key; the admin sends another `key`;
- `409 copy_mapping_not_reproducible` (names the source field): an active OptiMove mapping version cannot be copied as
  it is (its field retired, its revision no longer usable, its extraction or unit conversion no longer valid);
- `409 copy_too_large`: more than ten active OptiMove mapping versions;
- `409 source_not_active`, `409 source_version_changed` (names the current version), `409 already_copied` (names the
  club's copy): the state at that moment;
- `409 try_again`: OptiMove's active mapping versions changed during the copy, or the admin was given the platform admin
  role just before the copy's request record was written; nothing was written, the same request can be sent again. A
  role change earlier in the copy (before its own rows) answers a sanitized `500 internal_error` instead, nothing
  written, and the same request then succeeds.
