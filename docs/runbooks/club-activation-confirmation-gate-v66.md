# Runbook: migration v66, the gate on a club admin's activation (J18, M-B), and the board's writes

Contract: `docs/ai/c112-drag-mapping-contract.md` (J18), sections 4.3–4.5, 5.5, 5.8, 15.3 and 15.9. This is **M-B**,
the migration of slice 18-3. It is deployed **together with the board's frontend (18-4), in one deploy**: 18-3's merge
waits for 18-4's GO, so a club admin never meets the gate's refusal without the board and its link.

- **v66** (`migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql`) adds one function and
  one `BEFORE UPDATE` trigger on the mapping versions (T4). It replaces no body, alters no table and changes no row.
  - **What it does.** A club admin moves a version of a field **without parameters** `needs_review → active` only
    - inside a drag-and-drop save: a checked confirmation row of the **same transaction**, by the activating user,
      for the version's club, naming exactly this version; or
    - as a copy of OptiMove's mapping (J15, v53) whose system version is still active.
    Anything else is refused (`23514`, one fixed text), which the service answers as `409 confirmation_required`,
    "Switch this version on from Map by drag and drop."
  - **What it leaves alone.** A platform admin's activation; a system version; a version of a field with parameters
    (zones and thresholds).
  - **A check before anything changes:** T4's update guard and actor guard are the bodies the gate was written on
    (by md5), T4's triggers are the six expected ones, all enabled, and v65's tables and v53's copy links exist;
    otherwise the migration refuses (`23514`) and changes nothing.
  - **Locks:** T4 `SHARE ROW EXCLUSIVE`, waiting for a writer of T4 up to the runner's `lock_timeout` (30 s).

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server.

**What a refused lock looks like.** If a writer holds T4 for the whole `lock_timeout`, the migration fails with
SQLSTATE `55P03`, nothing is applied, the deploy fails and the old instance keeps serving. Nothing needs repair: the
deploy is repeated at a quiet moment, right after the preflight's last block comes back clean.

**Deploy compatibility.** The new schema with the old code: a club admin's *Activate* in Mappings for a field without
parameters answers a sanitized `500` instead of a sentence, since the old code does not know the gate's text. That
is why v66 ships only with the code of 18-3 and the screens of 18-4. The new code with the old schema is safe: the
save never depended on the gate. A schema rollback removes only the gate.

## Before the merge (the standing order for migration PRs)

`docs/ai/metrics-core-plan.md`, section 2, applies. The executor never calls a Supabase connector tool and never
touches the production database.

1. Right before the merge, on the merge tree: the 12-digit prefixes are unique (`.claude/rules/migrations.md`), and
   the md5 of T4's two guards on `main` is still the pair of the preflight's block 2. **Four migrations of other
   tracks sort after v66 by file name and are tolerated by exact name**, with their checksums where presence is
   asserted: v67 (MT-A, sha256 `9f9b7d25…47cd`; required, on production), v68 (`8beaef9b…a815`) and v69
   (`98a11f69…6391`) (MT-D; deployed before v66), and v70 (App health, `85804583…7d60`; before or after v66). None
   touches T4 or reads the gate; the runner applies by file name and takes v66 after them. Any other migration
   after v66 is a refusal, and block 1 is then re-issued with that migration's name and checksum first.
2. The *Rukovodilac* runs `docs/runbooks/club-activation-confirmation-gate-v66-preflight.sql` read-only, one block at
   a time, on the same UTC day as the deploy. Every `…_ok` column must be `true` and every count the expected one:
   - block 1: v65 and v67 each recorded once with its checksum; v68 and v69 recorded (the fixed deploy order), v70
     recorded or not; each of those three with its checksum where recorded; no v66; no other migration after v66;
   - block 2: T4's two guards and its trigger set as the gate expects;
   - block 3: nothing of v66 exists yet; what it reads is there; the migrator's role owns T4;
   - block 4: **the versions the gate will stop.** `waiting_without_link` must be 0. If it is not, the owner decides
     before the deploy who disables or activates those versions; nothing is disabled automatically;
   - block 5: **the server does not write a save's values to its log.** It is run **as the application's
     `DATABASE_URL` role**: the settings are those of the session that asks. A refusal: if any column is `false`,
     there is no deploy until the owner changes the setting, or the save is shown not to pass values as logged
     parameters. Its last column is `false` when any role or database carries an override of these settings,
     except `log_statement=none`, which only reduces logging. **The `auto_explain` column** is true when
     `auto_explain` is off, or logs neither parameters nor a verbose plan, or its threshold is above 5000 ms: the
     save's value-carrying statements (the confirmation's items) run under their own 5000 ms statement bound
     (`VALUE_STATEMENT_TIMEOUT_MS`), a statement that long is cancelled, and `auto_explain` explains only a
     statement that finished. Production today: threshold 10000 ms, parameters in full, so the bound is what keeps
     the values out of the log; if the threshold is ever lowered to 5000 ms or less, this column turns false;
   - block 6: the same settings as they are and the role that asked, for the record. It also says what block 5 does
     not cover: the pooler's own statement log, and a value inside an error's own text;
   - block 7: a quiet moment on T4.
3. Both ★★ GOs on the exact head of 18-3, 18-4's GO, then the owner's order that names v66 and the file's sha256 (the
   post-check's block 1 carries it).

## Deploy order

1. The merges of 18-3 and 18-4, one after the other, each from exactly its reviewed head.
2. The owner's deploy of exactly that commit, right after the preflight's block 7 came back clean.
3. The *Rukovodilac*'s smoke (`/api/health` serves the commit; without a login `POST …/sources/metrics/confirmations`
   answers 401) and its read-only post-check, `docs/runbooks/club-activation-confirmation-gate-v66-postcheck.sql`.

## Standing rule after the deploy: the server's log settings

v66 is on production since 2026-11-15 (merge `6a5ee45e`; as relayed by the *Rukovodilac*: deployed with `8d5d3a76`,
its read-only post-check, blocks 1 to 4, as expected). From then on a save writes two athletes' values as bind parameters, and what
keeps them out of the server's log is the pair "the statement bound of the value-carrying statements
(`VALUE_STATEMENT_TIMEOUT_MS`, 5000 ms, `backend/src/sourceMetricBoardSaveService.js`) is below `auto_explain`'s
threshold (10000 ms on production), and no other setting logs parameters".

**Any change of `auto_explain.*`, of `log_parameter_max_length` or `log_parameter_max_length_on_error`, or of the
other settings block 5 reads (`log_statement`, `log_min_duration_*`, `log_transaction_sample_rate`, `pgaudit.*`,
`debug_print_*`) on production, by anyone and for any reason, is followed by block 5 of
`club-activation-confirmation-gate-v66-preflight.sql`, run as the application's role, before the change is left in
place.** Every column must be true; the `auto_explain` threshold is compared with `VALUE_STATEMENT_TIMEOUT_MS`, and a
change of that constant in the code is compared with the threshold the same way (the suite pins the preflight's
number to the constant). A false column means the setting goes back, or saves are stopped, until the owner decides.

## Rollback

`docs/runbooks/club-activation-confirmation-gate-v66-rollback.sql`, rehearsed on a disposable database (apply →
rollback → the identical catalog → apply again). It drops the gate's trigger and function and removes the v66 record.
It refuses while the migrator runs, when v66 is not recorded, under a later migration, and when the gate's function
or trigger is missing, disabled or not v66's. It tolerates, by exact name and in any subset, the four later
migrations v67, v68, v69 and v70, which touch other tables, do not read the gate and are not rolled back with it;
any other later migration refuses it. Never run
without the owner's order for that database. v65 is rolled back only after v66.

## The stored values: how a platform admin removes them

A board save stores two athletes' raw and stored values for each row the admin checked. They leave the live table 90
days after the save. No screen exists for the two operations below in J18; they are called with the platform admin's
session, in the **platform workspace**. Everyone else, the confirmer and the club's admins included, gets the
identical `404`.

- **The schedule.** The server removes values past their date every 6 hours and shortly after it starts
  (`backend/src/sourceMetricConfirmationRemoval.js`), batch after batch until none is left. Every board and History
  read removes one batch first. No route returns a value past its date, removed or not. The schedule writes no audit
  row: the rows themselves carry `expired` and the time.
- **Erase one confirmation's values on request** (an erasure request, or a confirmation made by mistake):

  ```
  POST /api/training-load/sources/metrics/confirmations/<confirmation id>/erase-values
  { "requestKey": "<a new UUID>", "reasonCode": "erasure_request" }      (or "wrong_confirmation")
  ```

  - `200 { confirmation }`: the confirmation as History shows it, its rows `erased`, no value.
  - `400 invalid_body`: another reason code, or typed text. A reason is never free text.
  - `409 values_already_removed`: the values were already removed (expired or erased).
  - `409 request_key_reused`: the key was used for another request. The same key and body again answers the same
    result with `replayed: true`.
  - `503 outcome_unknown`: repeat with the same key.
  - What stays: the digest, the facts of the mapping, who confirmed and when, and one audit row naming the admin and
    the reason code. With the salt gone the digest can no longer be tested against guessed values.
- **Remove what is past its date now** (the backstop of the schedule, for example before a restored copy is used):

  ```
  POST /api/training-load/sources/metrics/confirmations/expired-values/remove
  { "requestKey": "<a new UUID>" }
  ```

  - `200 { removed: N, more: true|false }`: at most 200 confirmations per call. Repeat with a **new** key while
    `more` is `true`.
  - One audit row per confirmation removed, naming the admin. A call that removes nothing writes nothing.
  - `409 request_key_reused`, `409 try_again`, `503 outcome_unknown` as above.
- **Backups.** A backup keeps the values for its own retention. After a restore, the on-demand removal is run before
  the copy is used.
