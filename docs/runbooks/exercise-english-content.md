# Runbook: English names and instructions of exercises

Owner, 2026-11-03: exercise content is shown "po jeziku korisnika" (by the user's language). The owner's
translation (`vezbe.xlsx`, matched by exercise code) is imported by a separate script and order; this
migration only makes room for it.

- **The migration** (`migrations_v2/202611031200_exercise_english_content.sql`):
  - `library.exercises.name_en` and `instruction_en`, both `text` and NULL by default. Each is NULL or a trimmed,
    non-empty text (CHECKs `exercises_name_en_trimmed`, `exercises_instruction_en_trimmed`; the application trims and
    stores a blank value as NULL).
  - `public.users.content_language`, `text not null default 'sr'`, `sr` or `en` (CHECK
    `users_content_language_known`).
  - No backfill and no data rewrite: every exercise keeps NULL, every user gets `sr`. The Serbian columns are
    untouched.
- **The code** (one release with the migration):
  - The exercise list (`name_en`, `instruction_en` on each row; the search `q` also matches `name_en`, and an exact
    or leading English match ranks like a Serbian one).
  - The exercise detail and save (`nameEn`, `instructionEn`; a save that does not send a key keeps the stored
    value, a blank one clears it, anything but text or null is a 400).
  - `GET /api/auth/me` answers `contentLanguage`, and `PUT /api/auth/me/content-language` sets the caller's own,
    `{ "contentLanguage": "sr" | "en" }`.
  - An athlete's, on the athlete's login: `PUT /api/organization/athletes/:athleteId` takes `contentLanguage` with the
    profile, for exactly those who may edit that athlete today (`canManageAthlete`); an athlete without a login is a
    400. Settings → Athletes lists each athlete's `content_language`.
  - In the app: the editor's "Name (English)" and "Instruction (English)", Account → Exercise language (coach and
    athlete), and the display rule of `frontend/exercise-text.js`.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`);
`npm start` runs the migrations before the server. **Lock footprint:** the ADD COLUMNs take ACCESS EXCLUSIVE on
`library.exercises` and `public.users` for the time the CHECKs need to scan the two tables (both columns are NULL or
`'sr'`; no table is rewritten), under the runner's `lock_timeout`. Every signed-in request reads its session's user,
so requests wait for that moment (preflight block 6 is the quiet-moment check). While the migration is applied and the
old server still serves during the deploy, the old server reads neither column and works unchanged. A request that
holds a `users` row and then reads `library.exercises` can deadlock with the migration in that moment: PostgreSQL
aborts one side, and a failed migration leaves the old server serving (deploy again at a quieter moment).

**The order, each step on the owner's order:**

1. Preflight, read-only: `docs/runbooks/exercise-english-content-preflight.sql`, one block at a time.
2. Merge and deploy; the migration runs at the start of the new server.
3. Post-check, read-only: `docs/runbooks/exercise-english-content-postcheck.sql`.
4. The import of the English names and instructions is a separate order (its own script, a dry run first; below).

**Rollback** (only on an explicit owner order, after the previous release serves again):
`docs/runbooks/exercise-english-content-rollback.sql`. It refuses while the migrator runs, when the migration is not
recorded, when a later migration is recorded, and while any exercise has English text or any user reads in English
(that data would be lost: clear it first, on its own order). Rehearsed on a disposable database by
`backend/tests/exercise-english-content.test.mjs`.

**Local development database.** `npm run dev` does not migrate. Until the local OPTIMOVE database has this migration
(applied only on confirmation), the exercise routes answer 500 there (`GET /api/exercises` and the others select the
new columns; development only: the deployed server migrates at its start); `GET /api/auth/me` keeps working and answers
`sr`, and Settings → Athletes lists athletes with `sr`; saving a language there (Account, or an
athlete's profile with a changed language) is a 500 until the migration is applied.

## The import of the owner's translation (`backend/scripts/import-exercise-english.mjs`)

Owner, 2026-11-03: the English names and instructions of `vezbe.xlsx` (1189 rows), exported as JSON
(`[{ code, name_sr, instr_sr, name_en, notes_en }]`; `notes_en` is the English of `instr_sr`), matched by exercise
code. The xlsx itself is never changed.

- It matches only system exercises by `exercise_code`, and writes only `name_en` and `instruction_en`: never the
  Serbian name, the instruction or any other column (not even `updated_at`).
- An English value is written only where the exercise has none; `--overwrite` also replaces one that differs. A blank
  English value is never written and never clears anything. Each value is trimmed of spaces, tabs, CR and LF first
  (the database's CHECK refuses them at either end).
- A matched code whose Serbian name differs from the library's (beyond whitespace) is listed in `nameDiffers` with
  the library's name and the sheet's side by side, and **not written** (`written: false`) unless the code is named in
  `--include-code 758,759` (owner, 2026-11-03). A code in `--include-code` whose name does not differ (a typo) is
  refused before anything is written.
- **Copies** (owner, 2026-11-03): an exercise with no code whose `source_exercise_id` or `copy_parent_id` points at
  a matched exercise, and whose name AND instruction still equal the source's (whitespace aside), gets the same English
  under the same rules (`copies.unchanged`, `copies.nameEn`, `copies.instructionEn`). A copy that differs is listed
  in `copies.changed` (code and copy id) and not written; a copy whose source is not written (a name that differs, not
  included) is counted in `copies.withSourceNotWritten`. A copy of a copy is not followed. An exercise with a code of
  its own is never treated as a copy.
- Guard: `DATABASE_URL` from the environment only (no `.env` is read), never printed; `--database-name` must name the
  database the URL points at and the one the connection is really on; a database without the migration is refused.
  The report's `target` names host, port and database (never a user or a password). TLS as the deployed server
  connects (`backend/src/db.js`): for a `supabase.com` host the pooler's certificate is accepted as the server does;
  every other host uses Node's defaults.
- Bounds: `statement_timeout` 60 s, `lock_timeout` 5 s, `idle_in_transaction_session_timeout` 30 s on the server; the
  client waits at most 75 s for any answer. The matched rows and the copies it reads are locked `FOR NO KEY UPDATE`
  during an apply.
- Rehearsed on disposable databases by `backend/tests/import-exercise-english.test.mjs`.

**The order, each step on the owner's order (the production run is the owner's, or the manager's with the owner's
confirmation; `database-safety.md`):**

1. The migration is applied (its own post-check passed).
2. Before anything else, read-only:
   - compare the number of non-blank English instructions on the xlsx rows that have a code with the file's (the
     dry run's matched rows minus `instructionEn.blank`): a smaller number in the file means the export lost some;
     export again first. (On 2026-11-03 the sheet had 1083 non-blank English notes, 32 of them on 160 rows without a
     code; all 1051 on coded rows were in the exported file.)
   - the baseline over the system exercises and the copies (expected `0` on the first run) and the triggers an
     UPDATE could fire (expected: none of them names `name_en` or `instruction_en`):
     `select count(*) filter (where name_en is not null) as names, count(*) filter (where instruction_en is not null) as instructions, max(updated_at) as last_updated from library.exercises where owner_scope = 'system' or (exercise_code is null and (source_exercise_id is not null or copy_parent_id is not null));`
     `select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'library.exercises'::regclass and not tgisinternal;`
3. Dry run, read-only (`begin read only`, rolled back):
   `DATABASE_URL=<url> node backend/scripts/import-exercise-english.mjs --file vezbe-en.json --database-name <name>`.
   Check the report's `target` (host and port) is the database meant. Read `matched`, `notFound`, `nameDiffers`,
   `noEnglish`, `copies`, and per field `write` / `alreadyFilled` / `same` / `blank` (for the matched
   exercises and, under `copies`, for the copies). The owner reads each `nameDiffers` pair and names the codes to
   write anyway; they go in `--include-code` of the dry run again and of the apply. Take out of the file any other
   row the owner does not want written.
4. Apply at a quiet moment, with `--apply` added: one transaction; the report says `written`. An exercise editor that
   was opened before the import and saved after it sends its (empty) English fields and clears what the import wrote
   for that exercise, the same lost update as any other field; so run it when nobody edits exercises, and compare in
   step 5.
5. Check: run the dry run again. The primary check is that every field's `write` is now 0, for the
   matched exercises and the copies (what was written is now `same`). Then the baseline query of step 2 again: after
   minus before must equal the first dry run's `write` for each field, the matched exercises' and the copies' added
   (`alreadyFilled`, `same` and exercises outside the file were counted before already), and `last_updated` is
   unchanged unless someone saved an exercise meanwhile (the import touches no other column). A smaller difference names an exercise saved
   meanwhile (step 4): run the apply again.
6. If the COMMIT's answer is lost, the script says the outcome is not known: run the dry run again; it shows what is
   stored. A second apply writes nothing that is already there.
7. Undo, only on its own owner's order, and only while nobody has typed English in the editor since the import (the
   baseline of step 2 was 0):
   `update library.exercises set name_en = null, instruction_en = null where (owner_scope = 'system' or (exercise_code is null and (source_exercise_id is not null or copy_parent_id is not null))) and (name_en is not null or instruction_en is not null);`
   in one transaction, checking before COMMIT that the count it reports equals the apply's `written`.
