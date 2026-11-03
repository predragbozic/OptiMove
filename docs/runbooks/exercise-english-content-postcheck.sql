-- Exercise English content production post-check - READ ONLY. For the owner
-- (or the manager, on the owner's order) to run in the Supabase SQL Editor
-- after the deploy of the pull request that adds
-- migrations_v2/202611031200_exercise_english_content.sql, one numbered block
-- at a time. Every block is a plain SELECT; nothing is written. The expected
-- values are in the comments; any other value means: stop, change nothing,
-- report the block, the column and the value.

-- 1. The migration recorded once, with the repository's checksum (the sha256
--    named in the pull request), as the last migration; nothing after it.
--    Expected: this_rows = 1, this_checksum = the pull request's sha256,
--    later_rows = 0, last_migration =
--    migrations_v2/202611031200_exercise_english_content.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611031200_exercise_english_content.sql') as this_rows,
  (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202611031200_exercise_english_content.sql') as this_checksum,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611031200_exercise_english_content.sql') as later_rows,
  (select migration_name from public.schema_migrations where migration_name like 'migrations_v2/%' order by migration_name desc limit 1) as last_migration;

-- 2. The three columns, as the migration defines them.
--    Expected, one row each:
--      exercises.instruction_en  text  YES  (no default)
--      exercises.name_en         text  YES  (no default)
--      users.content_language    text  NO   'sr'::text
select table_name || '.' || column_name as column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where (table_schema = 'library' and table_name = 'exercises' and column_name in ('name_en', 'instruction_en'))
    or (table_schema = 'public' and table_name = 'users' and column_name = 'content_language')
 order by 1;

-- 3. The three CHECKs exist and are validated.
--    Expected: constraints = 3, not_validated = 0.
select
  (select count(*) from pg_constraint
    where conname in ('exercises_name_en_trimmed', 'exercises_instruction_en_trimmed', 'users_content_language_known')
      and contype = 'c') as constraints,
  (select count(*) from pg_constraint
    where conname in ('exercises_name_en_trimmed', 'exercises_instruction_en_trimmed', 'users_content_language_known')
      and not convalidated) as not_validated;

-- 4. No data was written: no exercise has English content yet (the import is
--    a separate order), every user reads in Serbian, and the sizes equal the
--    preflight's block 4 (or more, if exercises or users were created since).
--    Expected: exercises_with_english = 0 and users_in_english = 0 (unless,
--    after the deploy, someone already typed an English name in the editor
--    or chose English in Account), exercises and users = the preflight's
--    numbers.
select
  (select count(*) from library.exercises where name_en is not null or instruction_en is not null) as exercises_with_english,
  (select count(*) from public.users where content_language <> 'sr') as users_in_english,
  (select count(*) from library.exercises) as exercises,
  (select count(*) from public.users) as users;
