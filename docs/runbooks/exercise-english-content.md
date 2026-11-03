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
(applied only on confirmation), the exercise routes fail there (they read the new columns); `GET /api/auth/me` keeps
working and answers `sr`, and Settings → Athletes lists athletes with `sr`; saving a language there (Account, or an
athlete's profile with a changed language) is a 500 until the migration is applied.

## The import of the owner's translation (`backend/scripts/import-exercise-english.mjs`)

Owner, 2026-11-03: the English names and instructions of `vezbe.xlsx` (1189 rows), exported as JSON
(`[{ code, name_sr, instr_sr, name_en, notes_en }]`; `notes_en` is the English of `instr_sr`), matched by exercise
code. The xlsx itself is never changed.

- It matches only system exercises by `exercise_code`, and writes only `name_en` and `instruction_en`: never the
  Serbian name, the instruction or any other column (not even `updated_at`).
- An English value is written only where the exercise has none; `--overwrite` also replaces one that differs. A blank
  English value is never written and never clears anything.
- A code whose Serbian name differs from the database's is still matched by its code, and listed in the report
  (`nameDiffers`: code, the sheet's name, the database's name), so the owner can take it out of the file first.
- Guard: `DATABASE_URL` from the environment only (no `.env` is read), never printed; `--database-name` must name the
  database the URL points at and the one the connection is really on; a database without the migration is refused.
- Rehearsed on disposable databases by `backend/tests/import-exercise-english.test.mjs`.

**The order, each step on the owner's order (the production run is the owner's, or the manager's with the owner's
confirmation; `database-safety.md`):**

1. The migration is applied (its own post-check passed).
2. Dry run, read-only (`begin read only`, rolled back):
   `DATABASE_URL=<url> node backend/scripts/import-exercise-english.mjs --file vezbe-en.json --database-name <name>`.
   Read the report: `matched`, `notFound`, `nameDiffers`, `noEnglish`, and per field `write` / `alreadyFilled` /
   `same` / `blank`. Take out of the file any row the owner does not want written (a renamed exercise, for example).
3. Apply at a quiet moment, with `--apply` added: one transaction; the report says `written`. An exercise editor that
   was opened before the import and saved after it sends its (empty) English fields and clears what the import wrote
   for that exercise, the same lost update as any other field; so run it when nobody edits exercises, and compare in
   step 4.
4. Check: run the dry run again. Every row it reported as `write` is now `same` (`write` is 0), and the number of
   exercises with English text equals the first dry run's matched rows that had English:
   `select count(*) filter (where name_en is not null) as names, count(*) filter (where instruction_en is not null) as instructions from library.exercises where owner_scope = 'system';`
5. If the COMMIT's answer is lost, the script says the outcome is not known: run the dry run again; it shows what is
   stored. A second apply writes nothing that is already there.
