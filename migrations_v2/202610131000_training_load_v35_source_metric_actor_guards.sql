-- v35: database actor guards for the source metric mapping writes (T3, T4, T8).
--
-- Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, decisions
-- C73-C79 and section J2 (owner's decisions of 2026-10-13). v34 checked the
-- acting user only through the row's own columns (submitted_by / activated_by /
-- disabled_by) and not at all on a mapping (T3), a mapping version (T4) or an
-- audit row (T8) insert. From v35 the database refuses those writes unless:
--
--   * the transaction carries the acting user in the transaction-local
--     setting optimove.source_metric_actor = '<user uuid>:<id of this
--     transaction>' (set_config(..., true), written by the M2 service right
--     before its first protected write; never from a request body). Missing,
--     empty, not a lowercase canonical uuid, or naming another transaction
--     (a session-level SET left from an earlier one): 42501. A setting is
--     gone at COMMIT and ROLLBACK;
--   * the row names that user (created_by_user_id, performed_by_user_id and
--     the transition's submitted_by / activated_by / disabled_by): 42501;
--   * the user may write the mapping's owner scope - an active platform admin
--     for a system mapping; for a club mapping an active platform admin or
--     the active admin of that club, the club active in both cases: 42501;
--   * the basis is the one the database derives (an active platform admin:
--     platform_admin; otherwise the club's active admin: club_admin): 42501;
--   * an audit row follows its own operation in the same transaction: the
--     mapping or version it names was written by this transaction (its xmin
--     is this transaction's id), with the same user, status and basis, and
--     the operation has no audit row yet: 23514;
--   * at COMMIT (deferred constraint triggers) every mapping insert has its
--     mapping_create row, every version insert its mapping_version_create row
--     and every status transition its mapping_status (or
--     mapping_version_replaced) row: 23514, and the whole transaction is
--     rolled back. A trivial update of a version (no status or actor change)
--     is not checked.
-- Every other audit action (source metric, revision, unit conversion,
-- activation, source instance) needs an active platform admin as the acting
-- user; the chain of each comes with the PR that writes it (C76).
--
-- Known limits (stated in the contract, C74 and C78):
--   * This keeps an accidental or unintended write that bypasses the M2
--     service out - a raw SQL session, a script, another module, a stale
--     setting. The guards prove that the row, the acting user and the user's
--     right agree; they do not prove that the code which set the acting user
--     was entitled to. It is NOT a defence against whoever controls the
--     database credentials the application and the migrations share, nor
--     against any code that runs SQL through the application's pool (another
--     module, an injection): that role owns these tables and can set the
--     setting itself, disable a trigger or switch session_replication_role.
--     Separate migration and runtime roles are a later infrastructure task.
--   * A mapping or version written inside a savepoint (a subtransaction) has
--     the subtransaction's id as its xmin, so its audit row is refused (fail
--     closed). The M2 service uses no savepoint.
--
-- Lock order (compatible with v34 and M2): the v34 guard of each table runs
-- first (trigger names sort before *_v35_*); the v35 guards then take the
-- mapping row FOR SHARE (already held by M2: FOR NO KEY UPDATE for a version,
-- FOR SHARE for a submission, its own new row for a create) and last the
-- acting user's role, user and club rows FOR SHARE - the same rows, in the
-- same order, as M2's own right re-check (role and user, then club).
--
-- Fixed messages: no id, name, value or SQL. No data change, no seed; two
-- partial indexes serve the audit lookups. Requires PostgreSQL 13 or later
-- (pg_current_xact_id(); an older server fails this migration at once).

-- ---------------------------------------------------------------------------
-- 1. The acting user of this transaction.
-- ---------------------------------------------------------------------------
create function training_load.source_metric_context_actor() returns uuid as $$
declare
  raw text := current_setting('optimove.source_metric_actor', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    raise exception 'source metric mapping: no acting user is set for this transaction' using errcode = '42501';
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql;

-- The basis of the acting user for a mapping owner (NULL: none). The role and
-- user rows, then the club row, FOR SHARE: a concurrent revocation or archive
-- lands first or waits for this transaction.
create function training_load.source_metric_actor_basis(p_actor uuid, p_owner_club uuid) returns text as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_actor and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
     for share of r, u;
  if found then
    if p_owner_club is not null then
      perform 1 from public.clubs where id = p_owner_club and coalesce(is_active, true) for share;
      if not found then
        return null;
      end if;
    end if;
    return 'platform_admin';
  end if;
  if p_owner_club is null then
    return null;
  end if;
  perform 1
    from public.user_club_roles r
    join public.users u on u.id = r.user_id
    join public.clubs c on c.id = r.club_id
   where r.user_id = p_actor and r.club_id = p_owner_club and r.role = 'club_admin' and r.is_active = true
     and u.is_active = true and coalesce(c.is_active, true)
     for share of r, u, c;
  if found then
    return 'club_admin';
  end if;
  return null;
end;
$$ language plpgsql;

-- The id of this transaction as a row's xmin carries it.
create function training_load.source_metric_current_xmin() returns bigint
  language sql volatile as $$
    select pg_current_xact_id()::text::bigint % 4294967296
  $$;

-- ---------------------------------------------------------------------------
-- 2. T3: a mapping insert by its acting user, in an owner scope that user may write.
-- ---------------------------------------------------------------------------
create function training_load.source_metric_mappings_actor_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
begin
  if new.created_by_user_id is distinct from actor then
    raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
  end if;
  if training_load.source_metric_actor_basis(actor, case when new.owner_scope = 'club' then new.owner_club_id end) is null then
    raise exception 'source metric mapping: the acting user may not write this mapping' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mappings_v35_actor_guard
  before insert on training_load.source_metric_mappings
  for each row execute function training_load.source_metric_mappings_actor_guard();

-- ---------------------------------------------------------------------------
-- 3. T4: a version insert and every status transition by its acting user.
-- ---------------------------------------------------------------------------
create function training_load.source_metric_mapping_versions_actor_guard() returns trigger as $$
declare
  actor uuid;
  map record;
  basis text;
begin
  -- Not a protected change: v34 refuses every other column change itself.
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.submitted_by_user_id is not distinct from old.submitted_by_user_id
     and new.activated_by_user_id is not distinct from old.activated_by_user_id
     and new.disabled_by_user_id is not distinct from old.disabled_by_user_id then
    return new;
  end if;
  actor := training_load.source_metric_context_actor();
  select owner_scope, owner_club_id into map
    from training_load.source_metric_mappings where id = new.mapping_id for share;
  basis := training_load.source_metric_actor_basis(actor, case when map.owner_scope = 'club' then map.owner_club_id end);
  if basis is null then
    raise exception 'source metric mapping: the acting user may not write this mapping' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.created_by_user_id is distinct from actor then
      raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status is not distinct from old.status then
    -- An actor column changed without a transition (v34 refuses it too).
    raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
  end if;
  if new.status = 'needs_review' then
    if new.submitted_by_user_id is distinct from actor then
      raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
    end if;
    if new.submitted_basis is distinct from basis then
      raise exception 'source metric mapping: the basis is not the acting user''s own' using errcode = '42501';
    end if;
  elsif new.status = 'active' then
    if new.activated_by_user_id is distinct from actor then
      raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
    end if;
    if new.activated_basis is distinct from basis then
      raise exception 'source metric mapping: the basis is not the acting user''s own' using errcode = '42501';
    end if;
  elsif new.status = 'disabled' then
    if new.disabled_by_user_id is distinct from actor then
      raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
    end if;
    if new.disabled_basis is distinct from basis then
      raise exception 'source metric mapping: the basis is not the acting user''s own' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mapping_versions_v35_actor_guard
  before insert or update on training_load.source_metric_mapping_versions
  for each row execute function training_load.source_metric_mapping_versions_actor_guard();

-- The audit lookups of the guards below and of the deferred link (section 5).
create index source_metric_audit_v35_mapping_create_idx
  on training_load.source_metric_audit (mapping_id) where action = 'mapping_create';
create index source_metric_audit_v35_version_idx
  on training_load.source_metric_audit (mapping_version_id, to_status) where mapping_version_id is not null;

-- ---------------------------------------------------------------------------
-- 4. T8: an audit row by its acting user, with the derived basis, following
-- its own operation in the same transaction, once.
-- ---------------------------------------------------------------------------
create function training_load.source_metric_audit_actor_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  map record;
  ver record;
  basis text;
begin
  if new.performed_by_user_id is distinct from actor then
    raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
  end if;
  if new.action not in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced') then
    -- Every other action: an active platform admin; its chain comes with the
    -- PR that writes it.
    if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' or new.basis is distinct from 'platform_admin' then
      raise exception 'source metric mapping: the acting user may not write this audit row' using errcode = '42501';
    end if;
    return new;
  end if;
  select owner_scope, owner_club_id, created_by_user_id, xmin::text::bigint as written_in into map
    from training_load.source_metric_mappings where id = new.mapping_id for share;
  if not found then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  basis := training_load.source_metric_actor_basis(actor, case when map.owner_scope = 'club' then map.owner_club_id end);
  if basis is null then
    raise exception 'source metric mapping: the acting user may not write this mapping' using errcode = '42501';
  end if;
  if new.basis is distinct from basis then
    raise exception 'source metric mapping: the basis is not the acting user''s own' using errcode = '42501';
  end if;
  if new.action = 'mapping_create' then
    if map.written_in is distinct from here or map.created_by_user_id is distinct from actor then
      raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit where action = 'mapping_create' and mapping_id = new.mapping_id) then
      raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;
  select status, created_by_user_id, submitted_by_user_id, submitted_basis, activated_by_user_id, activated_basis,
         disabled_by_user_id, disabled_basis, xmin::text::bigint as written_in into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id and mapping_id = new.mapping_id;
  if not found or ver.written_in is distinct from here then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  if new.action = 'mapping_version_create' then
    if ver.status is distinct from 'draft' or ver.created_by_user_id is distinct from actor then
      raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'mapping_version_create' and mapping_version_id = new.mapping_version_id) then
      raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;
  -- mapping_status / mapping_version_replaced: the version's current status is
  -- the transition's target, written by this user with this basis.
  if ver.status is distinct from new.to_status
     or (new.to_status = 'needs_review' and (ver.submitted_by_user_id, ver.submitted_basis) is distinct from (actor, new.basis))
     or (new.to_status = 'active' and (ver.activated_by_user_id, ver.activated_basis) is distinct from (actor, new.basis))
     or (new.to_status = 'disabled' and (ver.disabled_by_user_id, ver.disabled_basis) is distinct from (actor, new.basis))
     or new.to_status not in ('needs_review', 'active', 'disabled') then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.source_metric_audit
              where action in ('mapping_status', 'mapping_version_replaced')
                and mapping_version_id = new.mapping_version_id and to_status = new.to_status) then
    raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_audit_v35_actor_guard
  before insert on training_load.source_metric_audit
  for each row execute function training_load.source_metric_audit_actor_guard();

-- ---------------------------------------------------------------------------
-- 5. At COMMIT: every protected write has its audit row (deferred).
-- ---------------------------------------------------------------------------
create function training_load.source_metric_mappings_audit_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit where action = 'mapping_create' and mapping_id = new.id) then
    raise exception 'source_metric_mappings: a mapping is written with its mapping_create audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_mappings_v35_audit_link
  after insert on training_load.source_metric_mappings
  deferrable initially deferred
  for each row execute function training_load.source_metric_mappings_audit_link();

create function training_load.source_metric_mapping_versions_audit_link() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from training_load.source_metric_audit
                    where action = 'mapping_version_create' and mapping_version_id = new.id) then
      raise exception 'source_metric_mapping_versions: a version is written with its mapping_version_create audit row' using errcode = '23514';
    end if;
  elsif not exists (select 1 from training_load.source_metric_audit
                     where action in ('mapping_status', 'mapping_version_replaced') and mapping_version_id = new.id
                       and from_status = old.status and to_status = new.status) then
    raise exception 'source_metric_mapping_versions: a status transition is written with its mapping_status audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_mapping_versions_v35_audit_link_insert
  after insert on training_load.source_metric_mapping_versions
  deferrable initially deferred
  for each row execute function training_load.source_metric_mapping_versions_audit_link();

create constraint trigger source_metric_mapping_versions_v35_audit_link_update
  after update on training_load.source_metric_mapping_versions
  deferrable initially deferred
  for each row
  when (old.status is distinct from new.status
        or old.submitted_by_user_id is distinct from new.submitted_by_user_id
        or old.activated_by_user_id is distinct from new.activated_by_user_id
        or old.disabled_by_user_id is distinct from new.disabled_by_user_id)
  execute function training_load.source_metric_mapping_versions_audit_link();
