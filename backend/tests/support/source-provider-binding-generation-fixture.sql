-- Disposable-only captures for the other three Sources claim inputs.
do $lab$
begin
  if current_database() !~ '^optimove_tests_[a-z0-9_]+$'
     or (select not enabled and epoch = 0 from training_load.source_provider_admission where singleton) is distinct from true then
    raise exception 'Sources binding generation fixture requires a closed disposable database';
  end if;
end
$lab$;

alter table public.teams
  add column provider_generation bigint not null default 0 check (provider_generation >= 0);
-- A missing pointer is represented by zero. Old and new existing rows start
-- at one, so a first approval cannot equal an earlier absence.
alter table training_load.gpexe_team_settings
  add column provider_generation bigint not null default 1 check (provider_generation >= 1);

create function training_load.capture_source_team_generation() returns trigger
language plpgsql set search_path = pg_catalog as $capture$
begin
  if tg_op = 'INSERT' then
    new.provider_generation := 0;
  else
    new.provider_generation := old.provider_generation
      + case when row(new.club_id, coalesce(new.is_active, true))
         is distinct from row(old.club_id, coalesce(old.is_active, true)) then 1 else 0 end;
  end if;
  return new;
end
$capture$;

create function training_load.capture_source_pointer_generation() returns trigger
language plpgsql set search_path = pg_catalog as $capture$
begin
  if tg_op = 'INSERT' then
    new.provider_generation := 1;
  else
    new.provider_generation := old.provider_generation
      + case when training_load.gpexe_team_id_canonical(new.gpexe_team_id) is distinct from
                  training_load.gpexe_team_id_canonical(old.gpexe_team_id) then 1 else 0 end;
  end if;
  return new;
end
$capture$;

-- The original alphabetically earlier BEFORE guards still control the write.
create trigger zz_source_team_capture_generation
before insert or update on public.teams
for each row execute function training_load.capture_source_team_generation();
create trigger zz_source_pointer_capture_generation
before insert or update on training_load.gpexe_team_settings
for each row execute function training_load.capture_source_pointer_generation();

-- The legacy guards prohibit delete/truncate and allow an active row only
-- to become ended. Counting each retained insertion and each ended row
-- therefore advances on every effect with no UPDATE of the parent connection.
-- Retain complete history and read this and the active set in one snapshot.
create index fixture_source_binding_generation_history
  on training_load.source_team_bindings (connection_id, state);
create function training_load.source_binding_generation(p_connection uuid) returns bigint
language sql stable set search_path = pg_catalog as $version$
  select count(*) + count(*) filter (where state = 'ended')
  from training_load.source_team_bindings
  where connection_id = p_connection
$version$;

revoke all on function training_load.capture_source_team_generation(),
  training_load.capture_source_pointer_generation(), training_load.source_binding_generation(uuid) from public;
do $acl$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function training_load.capture_source_team_generation(), training_load.capture_source_pointer_generation(), training_load.source_binding_generation(uuid) from %I',api_role);
    end if;
  end loop;
end
$acl$;
