-- English content of an exercise, and the language a user reads exercises in
-- (owner, 2026-11-03: "po jeziku korisnika").
--
-- library.exercises gains an optional English name and instruction beside the
-- Serbian ones (name, instruction). Each is NULL or a trimmed, non-empty text:
-- the application trims and stores an empty value as NULL, and an
-- untrimmed value written by hand is refused here. The Serbian columns are
-- untouched and stay the fallback: a screen shows the English text only when
-- the user reads in English and the exercise has one.
--
-- public.users gains content_language, 'sr' (the default, today's behaviour)
-- or 'en'. Only the user changes it (PUT /api/auth/me/content-language); it
-- decides the language of exercise content, never of the interface.
--
-- No backfill and no data rewrite: every existing exercise keeps NULL, every
-- existing user gets 'sr'. Adding a column with a constant default and a
-- CHECK takes a short ACCESS EXCLUSIVE lock on each table (no table rewrite);
-- the CHECKs scan the tables once (the new columns are all NULL or 'sr').
-- Rollback: docs/runbooks/exercise-english-content-rollback.sql.

alter table library.exercises
  add column name_en text,
  add column instruction_en text,
  add constraint exercises_name_en_trimmed
    check (name_en is null or (name_en <> '' and btrim(name_en, E' \t\r\n') = name_en)),
  add constraint exercises_instruction_en_trimmed
    check (instruction_en is null or (instruction_en <> '' and btrim(instruction_en, E' \t\r\n') = instruction_en));

comment on column library.exercises.name_en is
  'English name of the exercise; NULL when there is none (the Serbian name is shown).';
comment on column library.exercises.instruction_en is
  'English instruction of the exercise; NULL when there is none (the Serbian instruction is shown).';

alter table public.users
  add column content_language text not null default 'sr',
  add constraint users_content_language_known
    check (content_language in ('sr', 'en'));

comment on column public.users.content_language is
  'Language the user reads exercise content in: sr (default) or en. Interface labels are not translated.';
