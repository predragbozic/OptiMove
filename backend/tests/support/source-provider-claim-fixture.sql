-- Disposable fixture only. installClaimFixture checks the current database.
create function claim_fixture_safe_snapshot(value jsonb) returns boolean
language plpgsql immutable strict as $snapshot$
declare field record;
declare item jsonb;
begin
  if jsonb_typeof(value) <> 'object' or not value ? 'revision' then return false; end if;
  for field in select * from jsonb_each(value) loop
    case field.key
      when 'revision', 'hostGeneration', 'credentialGeneration', 'bindingGeneration', 'teamGeneration' then
        if jsonb_typeof(field.value) <> 'number' or field.value::text !~ '^[0-9]{1,15}$' then return false; end if;
      when 'team' then
        if jsonb_typeof(field.value) <> 'string' or (field.value #>> '{}') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then return false; end if;
      when 'sourceTeam' then
        if jsonb_typeof(field.value) <> 'string' or (field.value #>> '{}') !~ '^[1-9][0-9]{0,11}$' then return false; end if;
      when 'teams', 'teamGenerations' then
        if jsonb_typeof(field.value) <> 'array' or jsonb_array_length(field.value) > 100 then return false; end if;
        for item in select * from jsonb_array_elements(field.value) loop
          if field.key = 'teams' and (jsonb_typeof(item) <> 'string' or (item #>> '{}') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then return false; end if;
          if field.key = 'teamGenerations' and (jsonb_typeof(item) <> 'number' or item::text !~ '^[0-9]{1,15}$') then return false; end if;
        end loop;
      else return false;
    end case;
  end loop;
  return true;
end
$snapshot$;

create table source_claim_fixture (
  id uuid primary key,
  reservation uuid not null unique,
  actor uuid not null,
  connection uuid not null,
  club uuid not null,
  operation text not null check (operation in ('connect','reconnect','test','bind')),
  snapshot jsonb not null check (claim_fixture_safe_snapshot(snapshot)),
  state text not null check (state in ('reserved','dispatching','succeeded','failed','unknown','not_sent')),
  counted boolean not null,
  reserved_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > reserved_at),
  dispatched_at timestamptz,
  check (state not in ('dispatching','succeeded','failed','unknown') or dispatched_at is not null),
  check (state <> 'reserved' or dispatched_at is null),
  check (counted or state='not_sent' or (state='succeeded' and operation='bind'))
);
create unique index claim_fixture_one_actor on source_claim_fixture(actor) where state in ('reserved','dispatching');
create unique index claim_fixture_one_connection on source_claim_fixture(connection) where state in ('reserved','dispatching');

create function claim_fixture_preserve_identity() returns trigger
language plpgsql as $claim_identity$
begin
  if tg_op <> 'UPDATE' then raise exception 'claim evidence is retained' using errcode='23514'; end if;
  if (to_jsonb(new) - 'state' - 'counted' - 'dispatched_at') is distinct from (to_jsonb(old) - 'state' - 'counted' - 'dispatched_at')
     or not (
       (old.state='reserved' and new.state='dispatching' and new.dispatched_at is not null and new.counted)
       or (old.state='reserved' and new.state='not_sent' and new.dispatched_at is null and not new.counted)
       or (old.state='dispatching' and new.state in ('succeeded','failed','unknown','not_sent') and new.dispatched_at=old.dispatched_at)
     ) then
    raise exception 'claim identity and terminal evidence are immutable' using errcode='23514';
  end if;
  return new;
end
$claim_identity$;
create trigger claim_fixture_identity before update or delete on source_claim_fixture
  for each row execute function claim_fixture_preserve_identity();
create trigger claim_fixture_no_truncate before truncate on source_claim_fixture
  for each statement execute function claim_fixture_preserve_identity();

create table source_claim_fence_control_fixture (
  singleton boolean primary key check (singleton),
  enabled boolean not null,
  previous_drained boolean not null default false,
  first_effect_at timestamptz,
  check (not enabled or previous_drained)
);
insert into source_claim_fence_control_fixture(singleton,enabled) values (true, false);
create function claim_fixture_preserve_cutover() returns trigger
language plpgsql as $claim_cutover$
begin
  if tg_op <> 'UPDATE' or (old.first_effect_at is not null and new.first_effect_at is distinct from old.first_effect_at) then
    raise exception 'claim cutover evidence is retained' using errcode='23514';
  end if;
  return new;
end
$claim_cutover$;
create trigger claim_fixture_cutover before update or delete on source_claim_fence_control_fixture
  for each row execute function claim_fixture_preserve_cutover();
create trigger claim_fixture_cutover_no_truncate before truncate on source_claim_fence_control_fixture
  for each statement execute function claim_fixture_preserve_cutover();

create table source_claim_team_fence_fixture (
  attempt uuid not null references source_claim_fixture(id), team uuid not null, primary key (attempt,team)
);
create function claim_fixture_preserve_team_fence() returns trigger
language plpgsql as $claim_team$
begin
  if tg_op <> 'INSERT' or not exists (
    select 1 from source_claim_fixture p
    where p.id=new.attempt and p.state='reserved'
      and (p.snapshot->'teams' ? new.team::text or p.snapshot->>'team'=new.team::text)
  ) then raise exception 'team fence differs from captured scope' using errcode='23514'; end if;
  return new;
end
$claim_team$;
create trigger claim_fixture_team before insert or update or delete on source_claim_team_fence_fixture
  for each row execute function claim_fixture_preserve_team_fence();
create trigger claim_fixture_team_no_truncate before truncate on source_claim_team_fence_fixture
  for each statement execute function claim_fixture_preserve_team_fence();

create table source_claim_legacy_budget_fixture (
  id uuid primary key, actor uuid not null, connection uuid not null, reached_at timestamptz not null
);
