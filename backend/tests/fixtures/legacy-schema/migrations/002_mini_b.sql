-- A later migration the synthetic dump does NOT contain.
create table public.newer_table (
  id uuid primary key,
  note text
);
insert into public.newer_table (id, note) values ('00000000-0000-0000-0000-000000000001', 'seed');
