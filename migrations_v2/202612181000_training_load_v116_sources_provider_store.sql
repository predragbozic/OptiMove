-- Private Sources provider coordination storage. Admission remains closed.
set local lock_timeout = '5s';

do $check$
begin
  if not exists (
    select from public.schema_migrations
    where migration_name = 'migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql'
      and checksum = '7b8f035cbc134aec30adaffe031607a826af4346bb9617fa0e292ed078a201b4'
  ) or exists (
    select from public.schema_migrations
    where migration_name ~ '^migrations_v2/[0-9]{12}_'
      and migration_name > 'migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql'
  ) then
    raise exception 'Sources provider store requires the exact v115 predecessor';
  end if;
  if to_regclass('training_load.sources_connect_local_bridge_use') is null
     or (select md5(prosrc) from pg_proc
         where oid = to_regprocedure('public.permission_word_honoured(text)'))
        is distinct from '6a30d1efc10f2e065c5a53ab570c82c9' then
    raise exception 'Sources provider store requires the approved v115 bridge';
  end if;
end
$check$;

create table training_load.source_provider_admission (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  epoch bigint not null default 0,
  constraint source_provider_admission_closed check (not enabled and epoch = 0)
);
insert into training_load.source_provider_admission default values;

create table training_load.source_provider_attempts (
  id uuid primary key,
  nonce_digest bytea not null unique check (octet_length(nonce_digest) = 32),
  actor_id uuid not null references public.users(id),
  club_id uuid not null references public.clubs(id),
  connection_id uuid not null references training_load.source_credential_connections(id),
  workspace_type text not null check (workspace_type in ('platform','club')),
  workspace_club_id uuid references public.clubs(id),
  admission_epoch bigint not null check (admission_epoch > 0),
  operation text not null check (operation in ('connect','reconnect','test','bind')),
  state text not null default 'reserved' check (state in ('reserved','dispatching','succeeded','failed','unknown','not_sent')),
  target_team_id uuid references public.teams(id),
  target_source_team text check (target_source_team ~ '^(0|[1-9][0-9]{0,11})$'),
  host_key text not null check (length(host_key) between 1 and 80),
  connection_generation bigint not null check (connection_generation >= 0),
  host_generation bigint not null check (host_generation >= 0),
  binding_generation bigint not null check (binding_generation >= 0),
  reserved_at timestamptz not null,
  expires_at timestamptz not null,
  dispatched_at timestamptz,
  settled_at timestamptz,
  counted boolean not null default true,
  check ((workspace_type = 'platform' and workspace_club_id is null)
    or (workspace_type = 'club' and workspace_club_id is not null and workspace_club_id = club_id)),
  check ((operation = 'bind' and target_team_id is not null and target_source_team is not null)
    or (operation <> 'bind' and target_team_id is null and target_source_team is null)),
  check (expires_at > reserved_at),
  check (dispatched_at is null or dispatched_at between reserved_at and expires_at),
  check (settled_at is null or settled_at >= coalesce(dispatched_at, reserved_at)),
  check ((state = 'reserved' and dispatched_at is null and settled_at is null and counted)
    or (state = 'dispatching' and dispatched_at is not null and settled_at is null and counted)
    or (state in ('failed','unknown') and dispatched_at is not null and settled_at is not null and counted)
    or (state = 'succeeded' and dispatched_at is not null and settled_at is not null and counted = (operation <> 'bind'))
    or (state = 'not_sent' and settled_at is not null and not counted))
);

create unique index source_provider_attempt_actor_live
  on training_load.source_provider_attempts (actor_id) where state in ('reserved','dispatching');
create unique index source_provider_attempt_connection_live
  on training_load.source_provider_attempts (connection_id) where state in ('reserved','dispatching');
create index source_provider_attempt_actor_window
  on training_load.source_provider_attempts (actor_id, coalesce(dispatched_at, reserved_at)) where counted;
create index source_provider_attempt_connection_window
  on training_load.source_provider_attempts (connection_id, coalesce(dispatched_at, reserved_at)) where counted;
create index source_provider_attempt_expiry
  on training_load.source_provider_attempts (expires_at, id) where state in ('reserved','dispatching','unknown');

create table training_load.source_provider_attempt_teams (
  attempt_id uuid not null references training_load.source_provider_attempts(id),
  team_id uuid not null references public.teams(id),
  team_generation bigint not null check (team_generation >= 0),
  pointer_generation bigint not null check (pointer_generation >= 0),
  primary key (attempt_id, team_id)
);
create index source_provider_attempt_team_fence
  on training_load.source_provider_attempt_teams (team_id, attempt_id);

-- The later adoption release must replace this guard explicitly. An app flag
-- or direct write cannot open a partial rollout or manufacture evidence.
create function training_load.source_provider_store_closed() returns trigger
language plpgsql set search_path = pg_catalog, training_load as $closed$
begin
  raise exception 'Sources provider storage is closed' using errcode = '55000';
end
$closed$;

create trigger source_provider_admission_keep_closed
before insert or update or delete or truncate on training_load.source_provider_admission
for each statement execute function training_load.source_provider_store_closed();
create trigger source_provider_attempts_keep_closed
before insert or update or delete or truncate on training_load.source_provider_attempts
for each statement execute function training_load.source_provider_store_closed();
create trigger source_provider_attempt_teams_keep_closed
before insert or update or delete or truncate on training_load.source_provider_attempt_teams
for each statement execute function training_load.source_provider_store_closed();

alter table training_load.source_provider_admission enable row level security;
alter table training_load.source_provider_attempts enable row level security;
alter table training_load.source_provider_attempt_teams enable row level security;
revoke all on training_load.source_provider_admission, training_load.source_provider_attempts, training_load.source_provider_attempt_teams from public;
revoke all on function training_load.source_provider_store_closed() from public;

do $acl$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on training_load.source_provider_admission, training_load.source_provider_attempts, training_load.source_provider_attempt_teams from %I', api_role);
      execute format('revoke all on function training_load.source_provider_store_closed() from %I', api_role);
    end if;
  end loop;
end
$acl$;
