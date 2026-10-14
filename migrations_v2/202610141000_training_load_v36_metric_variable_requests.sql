-- v36: the durable request record of the canonical-variable admin API (M3-0).
--
-- Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, decisions
-- C80-C88 and section J3 (owner's decisions of 2026-10-14). The new admin
-- routes under /api/training-load/sources/metrics/variables create an OptiMove
-- canonical variable (a Metrics Core definition with its version 1 and its
-- levels) and new immutable semantic versions of it. Each such write is one
-- transaction that ends with exactly one row of this table: who asked, with
-- which request key and request hash, for which operation, in which owner scope
-- and on which basis, and which definition and version the write produced. The
-- row is the request record: the same user, key and hash replay the write; the
-- same key with another hash or operation is refused by the service; a COMMIT
-- whose answer was lost is verified by looking the row up on another
-- connection.
--
-- The database guards the row (BEFORE INSERT):
--   * the transaction carries the acting user in the v35 transaction-local
--     setting optimove.source_metric_actor (training_load.source_metric_context_actor():
--     missing, empty, malformed or of another transaction: 42501), and the row
--     names that user (42501);
--   * the basis is the one the database derives for that user and the row's
--     owner scope (training_load.source_metric_actor_basis(): an active platform
--     admin - for a club owner only while the club is active - is
--     platform_admin, otherwise the active admin of the active club is
--     club_admin; none: 42501; another basis: 42501);
--   * the request follows its own operation in the same transaction: the
--     definition is of the row's owner and was written (created, or its current
--     version repointed) by this transaction, the version belongs to it, was
--     created by this transaction and this user and is its current version; a
--     variable_create names version 1, a variable_version_create a later one
--     (23514).
-- Uniques: one row per user and request key, one per version, one
-- variable_create per definition. The table is append-only (UPDATE, DELETE and
-- TRUNCATE refused).
--
-- What this does not do (decided, C82): the existing Metrics Core catalog API
-- (/api/training-load/metrics) and the GPEXE team-owned writer keep writing
-- metric_definitions, their versions and levels without a request row and
-- without an acting user - nothing here guards those three tables. A deferred
-- check "every definition written in a transaction has its request row" cannot
-- tell an M3-0 write from those writers without breaking them, so it is not
-- built; the M3-0 service writes the request row in the same transaction,
-- before the COMMIT, and its tests prove it. The guarantees of the stricter
-- contract are those of the new admin API only.
--
-- Known limits (as v35, C74): this proves that the row, the acting user and the
-- user's right agree, not that the code which set the acting user was entitled
-- to; it is no defence against whoever controls the shared owner credentials or
-- runs SQL through the application's pool. A row written inside a savepoint is
-- refused (its rows carry the subtransaction's id): fail closed.
--
-- Depends on the v35 functions source_metric_context_actor(),
-- source_metric_actor_basis() and source_metric_current_xmin() (the v35 rollback
-- refuses while v36 is recorded). Lock order: the guard reads the definition and
-- the version plainly (the service holds the definition: its own new row, or
-- FOR UPDATE for a new version) and last takes the acting user's role, user and
-- club rows FOR SHARE through source_metric_actor_basis() - already held by the
-- service's own right check, in the same order. No data change, no seed. Fixed
-- messages: no id, name, value or SQL.

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------
create table training_load.metric_variable_requests (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null,
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  operation text not null
    constraint metric_variable_requests_operation_check check (operation in ('variable_create', 'variable_version_create')),
  request_hash text not null
    constraint metric_variable_requests_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  owner_scope text not null
    constraint metric_variable_requests_owner_scope_check check (owner_scope in ('system', 'club')),
  owner_club_id uuid references public.clubs(id) on delete restrict,
  basis text not null
    constraint metric_variable_requests_basis_check check (basis in ('platform_admin', 'club_admin')),
  metric_definition_id uuid not null references training_load.metric_definitions(id) on delete restrict,
  metric_definition_version_id uuid not null,
  created_at timestamptz not null default now(),
  constraint metric_variable_requests_owner_shape check ((owner_scope = 'system') = (owner_club_id is null)),
  constraint metric_variable_requests_basis_shape check (owner_scope = 'club' or basis = 'platform_admin'),
  constraint metric_variable_requests_version_fk foreign key (metric_definition_version_id, metric_definition_id)
    references training_load.metric_definition_versions (id, metric_definition_id) on delete restrict,
  constraint metric_variable_requests_one_per_key unique (requested_by_user_id, request_key),
  constraint metric_variable_requests_one_per_version unique (metric_definition_version_id)
);

create unique index metric_variable_requests_one_create_per_definition
  on training_load.metric_variable_requests (metric_definition_id) where operation = 'variable_create';

-- ---------------------------------------------------------------------------
-- 2. The insert guard.
-- ---------------------------------------------------------------------------
create function training_load.metric_variable_requests_insert_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  def record;
  ver record;
  derived text;
begin
  if new.requested_by_user_id is distinct from actor then
    raise exception 'metric variable request: the row names another user than the acting user' using errcode = '42501';
  end if;
  select owner_scope, owner_club_id, state, current_version_id, xmin::text::bigint as written_in into def
    from training_load.metric_definitions where id = new.metric_definition_id;
  if not found or def.owner_scope is distinct from new.owner_scope or def.owner_club_id is distinct from new.owner_club_id then
    raise exception 'metric_variable_requests: the request must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  derived := training_load.source_metric_actor_basis(actor, new.owner_club_id);
  if derived is null then
    raise exception 'metric variable request: the acting user may not write this owner scope' using errcode = '42501';
  end if;
  if new.basis is distinct from derived then
    raise exception 'metric variable request: the basis is not the acting user''s own' using errcode = '42501';
  end if;
  select version_number, created_by_user_id, xmin::text::bigint as written_in into ver
    from training_load.metric_definition_versions
   where id = new.metric_definition_version_id and metric_definition_id = new.metric_definition_id;
  if not found
     or ver.written_in is distinct from here
     or ver.created_by_user_id is distinct from actor
     or def.written_in is distinct from here
     or def.state is distinct from 'active'
     or def.current_version_id is distinct from new.metric_definition_version_id
     or (new.operation = 'variable_create' and ver.version_number <> 1)
     or (new.operation = 'variable_version_create' and ver.version_number <= 1) then
    raise exception 'metric_variable_requests: the request must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_variable_requests_insert_guard
  before insert on training_load.metric_variable_requests
  for each row execute function training_load.metric_variable_requests_insert_guard();

-- ---------------------------------------------------------------------------
-- 3. Append-only.
-- ---------------------------------------------------------------------------
create function training_load.metric_variable_requests_append_only() returns trigger as $$
begin
  raise exception 'metric_variable_requests: request records are append-only' using errcode = '23514';
end;
$$ language plpgsql;

create trigger metric_variable_requests_no_update_delete
  before update or delete on training_load.metric_variable_requests
  for each row execute function training_load.metric_variable_requests_append_only();

create trigger metric_variable_requests_no_truncate
  before truncate on training_load.metric_variable_requests
  for each statement execute function training_load.metric_variable_requests_append_only();
