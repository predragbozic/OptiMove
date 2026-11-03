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
  - In the app: the editor's "Name (English)" and "Instruction (English)", Account → Exercise language (coach and
    athlete), and the display rule of `frontend/exercise-text.js`.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`);
`npm start` runs the migrations before the server. **Lock footprint:** the ADD COLUMNs take ACCESS EXCLUSIVE on
`library.exercises` and `public.users` for the time the CHECKs need to scan the two tables (both columns are NULL or
`'sr'`; no table is rewritten), under the runner's `lock_timeout`. Every signed-in request reads its session's user,
so requests wait for that moment (preflight block 5 is the quiet-moment check). While the migration is applied and the
old server still serves during the deploy, the old server reads neither column and works unchanged.

**The order, each step on the owner's order:**

1. Preflight, read-only: `docs/runbooks/exercise-english-content-preflight.sql`, one block at a time.
2. Merge and deploy; the migration runs at the start of the new server.
3. Post-check, read-only: `docs/runbooks/exercise-english-content-postcheck.sql`.
4. The import of the English names and instructions is a separate order (its own script, a dry run first).

**Rollback** (only on an explicit owner order, after the previous release serves again):
`docs/runbooks/exercise-english-content-rollback.sql`. It refuses while the migrator runs, when the migration is not
recorded, when a later migration is recorded, and while any exercise has English text or any user reads in English
(that data would be lost: clear it first, on its own order). Rehearsed on a disposable database by
`backend/tests/exercise-english-content.test.mjs`.

**Local development database.** `npm run dev` does not migrate. Until the local OPTIMOVE database has this migration
(applied only on confirmation), the exercise routes fail there (they read the new columns); `GET /api/auth/me` keeps
working and answers `sr`.
