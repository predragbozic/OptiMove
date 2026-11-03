-- Rollback of migrations_v2/202611031200_exercise_english_content.sql: drops
-- library.exercises.name_en and instruction_en, public.users.content_language
-- and their CHECKs, and deletes the migration record, so the migrator applies
-- the migration again on the next start. The code of the release that reads
-- these columns must not serve after this rollback (the exercise routes and
-- GET /api/auth/me read them): run it only after the previous release serves
-- again.
--
-- Runs only on an explicit owner order, never automatically, and refuses
-- (nothing dropped) when:
--   - the migrator is running (its advisory lock is held);
--   - the migration is not recorded;
--   - a later migration is recorded (forward-only after that);
--   - any exercise has an English name or instruction, or any user reads in
--     English (the data would be lost: clear it first, on its own order).
-- The two tables are locked ACCESS EXCLUSIVE before the row checks, so a row
-- written between the check and the drop is impossible. Locking public.users
-- holds every signed-in request (each one reads its session's user) for the
-- few milliseconds the drop takes, and waits at most lock_timeout for a
-- running transaction. Run it as one script that stops at the first error
-- (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open transaction is
-- aborted and nothing is changed. Rehearsed on a disposable database by
-- backend/tests/exercise-english-content.test.mjs (apply -> rollback -> the
-- catalog as before -> re-apply; every refusal).

begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration meanwhile.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'exercise English content rollback refused: the migrator holds its lock (a migration is running)';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202611031200_exercise_english_content.sql') then
    raise exception 'exercise English content rollback refused: the migration is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations
             where migration_name like 'migrations_v2/%'
               and migration_name > 'migrations_v2/202611031200_exercise_english_content.sql') then
    raise exception 'exercise English content rollback refused: a later migration is recorded';
  end if;
end $$;

lock table library.exercises, public.users in access exclusive mode;

do $$
begin
  if exists (select 1 from library.exercises where name_en is not null or instruction_en is not null) then
    raise exception 'exercise English content rollback refused: exercises with English content exist; clear them first on their own order';
  end if;
  if exists (select 1 from public.users where content_language <> 'sr') then
    raise exception 'exercise English content rollback refused: users who read exercises in English exist; set them back first on their own order';
  end if;
end $$;

alter table library.exercises
  drop constraint exercises_name_en_trimmed,
  drop constraint exercises_instruction_en_trimmed,
  drop column name_en,
  drop column instruction_en;

alter table public.users
  drop constraint users_content_language_known,
  drop column content_language;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202611031200_exercise_english_content.sql';

commit;
