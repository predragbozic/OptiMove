-- ============================================================
-- OPTIMOVE — Training load metrics v11: provenance primitives (source
-- connections, import batches, source identities).
--
-- Context: continues 202609041400_training_load_v10_metrics_catalog.sql.
-- This migration adds the objects that let a future measurement carry
-- WHERE it came from, independent of any specific provider. No connector,
-- credential storage, or import UI is built in this phase — these tables
-- are the generic anchor a future GPEXE/CSV/other connector would attach
-- to, deliberately provider-agnostic (source_system is a free-text label,
-- never a fixed enum of known providers).
--
-- metric_source_identities is the STABLE dedup slot for one external fact
-- (one row per distinct (connection, external id), created once, never
-- duplicated) — this is what a correction/re-sync locks, decoupling
-- "uniqueness of the external identity" from "which occasion currently
-- represents it" (metric_measurement_occasions.current-pointer wiring is
-- completed in v13, once that table exists).
--
-- The "protect ownership once used" and "lock before insert" triggers
-- below intentionally reference training_load.metric_events /
-- metric_measurement_occasions / metric_import_batches, which are created
-- in later files (v12/v13) — PL/pgSQL function BODIES are not validated
-- against table existence at CREATE time, only when the trigger actually
-- fires, so this ordering is safe and keeps each table's own protection
-- logic grouped with the table it protects, matching the reviewed PoC's
-- own layout.
-- ============================================================

create table training_load.metric_source_connections (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  state varchar(20) not null default 'active' check (state in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

-- §4 (reviewed PoC correction): a connection's own ownership becomes
-- immutable once it has been used by ANY event or source identity —
-- closes the gap where a connection could be re-scoped to a different
-- club/team after already vouching for data checked against its OLD
-- scope. Fires on UPDATE only (nothing to protect on INSERT).
create function training_load.protect_connection_ownership_once_used() returns trigger as $$
declare
  in_use boolean;
begin
  if new.owner_scope is not distinct from old.owner_scope
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.owner_club_id is not distinct from old.owner_club_id
     and new.owner_team_id is not distinct from old.owner_team_id then
    return new;
  end if;
  select exists (select 1 from training_load.metric_events where source_connection_id = old.id)
      or exists (select 1 from training_load.metric_source_identities where source_connection_id = old.id)
    into in_use;
  if in_use then
    raise exception 'metric_source_connections (id=%) is already in use: owner_scope is immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_source_connections_protect_ownership
  before update on training_load.metric_source_connections
  for each row execute function training_load.protect_connection_ownership_once_used();

create table training_load.metric_import_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by_user_id uuid not null references public.users(id) on delete restrict,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  filename text,
  uploaded_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

-- §4: same "protect once used" pattern, for a batch once any occasion
-- references it (via metric_measurement_occasions.import_batch_id, v13).
create function training_load.protect_batch_ownership_once_used() returns trigger as $$
declare
  in_use boolean;
begin
  if new.owner_scope is not distinct from old.owner_scope
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.owner_club_id is not distinct from old.owner_club_id
     and new.owner_team_id is not distinct from old.owner_team_id then
    return new;
  end if;
  select exists (select 1 from training_load.metric_measurement_occasions where import_batch_id = old.id) into in_use;
  if in_use then
    raise exception 'metric_import_batches (id=%) is already in use: owner_scope is immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_import_batches_protect_ownership
  before update on training_load.metric_import_batches
  for each row execute function training_load.protect_batch_ownership_once_used();

-- The stable dedup slot for one external fact — created ONCE per distinct
-- (connection, external id), never duplicated. current_occasion_id's real
-- (composite) FK is added in v13, once metric_measurement_occasions
-- exists — see that file for the full correction/idempotency design this
-- pointer supports.
create table training_load.metric_source_identities (
  id uuid primary key default gen_random_uuid(),
  source_connection_id uuid not null references training_load.metric_source_connections(id) on delete restrict,
  source_external_id text not null,
  current_occasion_id uuid,
  created_at timestamptz not null default now(),
  unique (source_connection_id, source_external_id)
);

-- §4: closes the TOCTOU race between the FIRST event/identity referencing
-- a connection and a CONCURRENT UPDATE of that connection's own protected
-- fields — a plain SELECT EXISTS in protect_connection_ownership_once_used
-- does not, by itself, see or wait for an uncommitted concurrent insert
-- (READ COMMITTED), and Postgres's own implicit FK locking (FOR KEY SHARE
-- on insert) does not conflict with an ordinary UPDATE's FOR NO KEY
-- UPDATE, so it does not close this gap either. Locking here forces the
-- two to serialize on the same row.
create function training_load.lock_connection_before_identity_insert() returns trigger as $$
begin
  perform 1 from training_load.metric_source_connections where id = new.source_connection_id for update;
  return new;
end;
$$ language plpgsql;

create trigger metric_source_identities_lock_connection
  before insert on training_load.metric_source_identities
  for each row execute function training_load.lock_connection_before_identity_insert();

-- §4: an identity's OWN source_connection_id/source_external_id become
-- immutable once any occasion references it — re-pointing an already-used
-- identity to a different club's connection would silently reassign its
-- entire measurement history. current_occasion_id is deliberately EXCLUDED
-- from this check — the revision pointer must stay freely mutable; only
-- the identity's own meaning is frozen.
create function training_load.protect_identity_source_once_measured() returns trigger as $$
declare
  has_measurements boolean;
begin
  if new.source_connection_id is not distinct from old.source_connection_id
     and new.source_external_id is not distinct from old.source_external_id then
    return new;
  end if;
  select exists (select 1 from training_load.metric_measurement_occasions where source_identity_id = old.id) into has_measurements;
  if has_measurements then
    raise exception 'metric_source_identities (id=%) has dependent measurements: source_connection_id/source_external_id is immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_source_identities_protect_source
  before update on training_load.metric_source_identities
  for each row execute function training_load.protect_identity_source_once_measured();
