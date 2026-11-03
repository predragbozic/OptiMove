-- Exercise English content production preflight - READ ONLY. For the owner
-- (or the manager, on the owner's order) to run in the Supabase SQL Editor,
-- as the application's DATABASE_URL role (the one the migrator uses), on the
-- day of the merge and deploy of the pull request that adds
-- migrations_v2/202611031200_exercise_english_content.sql.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The server version, for the record (the migration needs nothing newer
--    than PostgreSQL 11).
--    Expected: server_version_num >= 110000 (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num;

-- 2. The migration state: this migration absent, nothing recorded at or after
--    its name.
--    Expected: this_rows = 0, at_or_after_this = 0, last_migration =
--    migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql
--    (or a later migration of another part whose name sorts before this one's).
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611031200_exercise_english_content.sql') as this_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name >= 'migrations_v2/202611031200_exercise_english_content.sql') as at_or_after_this,
  (select migration_name from public.schema_migrations where migration_name like 'migrations_v2/%' order by migration_name desc limit 1) as last_migration;

-- 3. None of the new columns or constraints exists yet (a column of the same
--    name made by hand would make the migration fail).
--    Expected: every count 0.
select
  (select count(*) from information_schema.columns
    where table_schema = 'library' and table_name = 'exercises' and column_name in ('name_en', 'instruction_en')) as exercise_columns,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'content_language') as user_columns,
  (select count(*) from pg_constraint
    where conname in ('exercises_name_en_trimmed', 'exercises_instruction_en_trimmed', 'users_content_language_known')) as constraints;

-- 4. The sizes, to compare in the post-check (the migration adds no row and
--    removes none). Record both numbers.
select
  (select count(*) from library.exercises) as exercises,
  (select count(*) from public.users) as users;

-- 5. The role running this (the migrator's) owns both tables: ADD COLUMN
--    and ADD CONSTRAINT need the owner.
--    Expected: two rows, owner = running_as on each (may_alter = true is
--    enough: a member of the owner role may alter the table too).
select c.oid::regclass::text as table_name, pg_get_userbyid(c.relowner) as owner, current_user as running_as,
       pg_has_role(current_user, c.relowner, 'USAGE') as may_alter
  from pg_class c
 where c.oid in ('library.exercises'::regclass, 'public.users'::regclass)
 order by 1;

-- 6. A quiet moment: no other migration running, no transaction holding a
--    strong lock on the two tables the migration alters (ADD COLUMN takes
--    ACCESS EXCLUSIVE on library.exercises and public.users for a moment), no
--    idle transaction. An ordinary row write's RowExclusiveLock does not count.
--    Expected: every count 0.
select
  (select count(*) from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where ((n.nspname = 'library' and c.relname = 'exercises') or (n.nspname = 'public' and c.relname = 'users'))
      and l.pid <> pg_backend_pid()
      and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as strong_locks,
  (select count(*) from pg_stat_activity where query ilike '%schema_migrations%' and pid <> pg_backend_pid() and state <> 'idle') as other_migrators,
  (select count(*) from pg_locks where locktype = 'advisory' and objid = 822026) as migrator_lock_held;
