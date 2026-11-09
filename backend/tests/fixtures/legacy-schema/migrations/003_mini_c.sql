-- Changes a legacy definition in place and holds a DO block: both are reported by the generator.
alter table public.teams alter column name set default 'x';
do $$ begin null; end $$;
