-- Publish a complete team-owned table revision as one immutable document.
create table training_load.dashboard_reference_table_revisions (
  team_id uuid not null references public.teams(id),
  table_id uuid not null,
  revision integer not null check (revision > 0),
  binding jsonb not null check (jsonb_typeof(binding) = 'object'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) between 1 and 10000),
  created_at timestamptz not null default now(),
  primary key (team_id, table_id, revision)
);

revoke all on training_load.dashboard_reference_table_revisions from public;

create function training_load.dashboard_reference_table_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Reference table revisions are immutable' using errcode = '23514';
end;
$$;

create trigger dashboard_reference_table_immutable
before update or delete on training_load.dashboard_reference_table_revisions
for each row execute function training_load.dashboard_reference_table_immutable();
