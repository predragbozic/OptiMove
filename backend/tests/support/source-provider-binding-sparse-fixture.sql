begin;
do $lab$
begin
  if current_database() !~ '^optimove_tests_[a-z0-9_]+$'
     or (select not enabled and epoch = 0 from training_load.source_provider_admission where singleton) is distinct from true then
    raise exception 'Sources sparse binding fixture requires a closed disposable database';
  end if;
end
$lab$;
set local lock_timeout = '2s';
lock table training_load.source_team_bindings in share row exclusive mode;

create table training_load.source_binding_sparse_base (
  connection_id uuid primary key, generation bigint not null check (generation >= 0)
);
insert into training_load.source_binding_sparse_base
select connection_id, count(*) + count(*) filter (where state = 'ended')
from training_load.source_team_bindings group by connection_id;

create table training_load.source_binding_sparse_delta (
  connection_id uuid not null, team_id uuid not null,
  generation bigint not null check (generation > 0),
  primary key (connection_id, team_id)
);

create function training_load.capture_binding_sparse_delta() returns trigger
language plpgsql set search_path = pg_catalog as $body$
declare
  amount integer;
begin
  amount := case when tg_op = 'INSERT' and new.state = 'ended' then 2 else 1 end;
  insert into training_load.source_binding_sparse_delta as d values (new.connection_id, new.team_id, amount)
  on conflict (connection_id, team_id) do update set generation = d.generation + excluded.generation;
  return null;
end
$body$;
create trigger zz_source_binding_sparse_delta
after insert or update on training_load.source_team_bindings
for each row execute function training_load.capture_binding_sparse_delta();

create function training_load.source_binding_sparse_generation(p_connection uuid) returns bigint
language sql stable set search_path = pg_catalog as $body$
  select coalesce((select generation from training_load.source_binding_sparse_base where connection_id=p_connection),0)
       + coalesce((select sum(generation)::bigint from training_load.source_binding_sparse_delta where connection_id=p_connection),0)
$body$;
revoke all on table training_load.source_binding_sparse_base, training_load.source_binding_sparse_delta from public;
revoke all on function training_load.capture_binding_sparse_delta(), training_load.source_binding_sparse_generation(uuid) from public;
commit;
