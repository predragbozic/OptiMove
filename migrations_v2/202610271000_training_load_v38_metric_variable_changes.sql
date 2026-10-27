-- v38: rename, archive and restore of a canonical variable (R2, phase 2b).
--
-- Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, decision C99
-- and section J3b (owner's decisions of 2026-10-26 and 2026-10-27). The
-- canonical-variable admin API (M3-0) gains three writes on an existing
-- system or club variable - a rename of its label, short label and
-- description, an archive and a restore - for the platform admin and the
-- club's admin as before, and for an active coach of an active team of the
-- variable's club, in that team's workspace (club variables only). Each write
-- is one transaction that ends with exactly one request row, as M3-0's.
--
--   * The request record (v36's table, widened): three more operations
--     (variable_rename, variable_archive, variable_restore), no version for
--     them, the basis team_coach with the team it names (basis_team_id), the
--     change row the request follows (metric_variable_change_id) and an
--     optional reason. v36's insert guard function is not changed; its
--     trigger now fires for v36's two operations only, and a separate R2
--     guard checks the three new ones.
--   * The basis (training_load.metric_variable_change_basis()): the strongest
--     right the acting user holds for the variable's owner - an active
--     platform admin, then the active admin of the active club, then an
--     active coach of an active team of that club. v35's
--     source_metric_actor_basis() is not changed.
--   * The change record (training_load.metric_variable_changes), written by
--     the database: an AFTER UPDATE trigger on metric_definitions records
--     every change of the label, short label, description or state of a
--     system or club row - old and new values from OLD and NEW, the acting
--     user (the v35 setting optimove.source_metric_actor, or 42501), the
--     transaction - and the identity `seq`, assigned while the UPDATE holds
--     the definition's row lock: for one definition a later change always
--     has a larger seq ("the most recent change" is the largest seq, never a
--     time). A row is admitted only from inside a trigger of this
--     transaction, for a definition this transaction wrote.
--   * The R2 request guard: the request names the acting user and the basis
--     the database derives from the definition's owner; exactly one change
--     row of this transaction for that definition exists, and the request
--     names it; the definition's current values are the change row's new
--     ones; the kind matches the operation; a rename's new texts pass
--     source_metric_text_ok(); for the team_coach basis no rename of a
--     variable an active mapping version pins (Q4) and a restore only when
--     the definition's most recent change before it is an archive whose
--     request had the team_coach basis (Q8).
--   * At COMMIT (deferred): every change row has the request row that names
--     it, or the whole transaction rolls back (23514). So a rename, archive
--     or restore of a canonical variable through any path of the
--     application's pool, without its own request row, is undone.
--   * The key of a system or club row never changes (BEFORE UPDATE OF key,
--     named after v34's two guards so their messages keep winning).
--   * Both tables are append-only.
--
-- Known limits (as v35 and v36, C74): the guards prove that the row, the
-- acting user and the user's right agree, not that the code which set the
-- acting user was entitled to; they are no defence against whoever holds the
-- shared owner credentials or runs SQL through the application's pool and
-- disables a trigger. The change table's own guard admits a row from any
-- trigger of the same transaction (pg_trigger_depth() > 1), not only from
-- the definition's; a forged row still needs a definition updated by this
-- transaction and its own request row. A write inside a savepoint is refused
-- (its rows carry the subtransaction's id): fail closed. A future migration
-- that changes the label or state of a system or club definition must set
-- the acting user or disable the trigger inside itself, and say so.
--
-- Lock order: the service takes the definition FOR UPDATE, then the rights
-- FOR SHARE (the stronger bases probed first - they lock rows only when
-- found, and then the request answers try_again -, then the team, the club
-- and the coach role with the user: v26's lock_activity_decider order); the
-- request guard derives the basis again through the same rows, already held.
-- Depends on the v34 function source_metric_text_ok() and the v35 functions
-- source_metric_context_actor() and source_metric_current_xmin() (their
-- rollbacks refuse while v38 is recorded). Fixed messages: no id, name, value
-- or SQL.

-- ---------------------------------------------------------------------------
-- 1. The basis of a canonical-variable change.
-- ---------------------------------------------------------------------------
-- NULL: none. Platform admin first; then the club's admin; then, with a
-- team, the team's coach (team -> club -> role and user, v26's order). A
-- joined FOR SHARE locks only the rows it returns.
create function training_load.metric_variable_change_basis(p_actor uuid, p_owner_club uuid, p_team uuid) returns text as $$
begin
  perform 1
    from public.user_global_roles g
    join public.users u on u.id = g.user_id
   where g.user_id = p_actor and g.role = 'platform_admin' and g.is_active = true and u.is_active = true
     for share of g, u;
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
  if p_team is null then
    return null;
  end if;
  perform 1 from public.teams where id = p_team and club_id = p_owner_club and coalesce(is_active, true) for share;
  if not found then
    return null;
  end if;
  perform 1 from public.clubs where id = p_owner_club and coalesce(is_active, true) for share;
  if not found then
    return null;
  end if;
  perform 1
    from public.user_team_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_actor and r.team_id = p_team and r.role = 'team_coach' and r.is_active = true and u.is_active = true
     for share of r, u;
  if found then
    return 'team_coach';
  end if;
  return null;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 2. The change record.
-- ---------------------------------------------------------------------------
create table training_load.metric_variable_changes (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  metric_definition_id uuid not null references training_load.metric_definitions(id) on delete restrict,
  owner_scope text not null
    constraint metric_variable_changes_owner_scope_check check (owner_scope in ('system', 'club')),
  owner_club_id uuid references public.clubs(id) on delete restrict,
  kind text not null
    constraint metric_variable_changes_kind_check check (kind in ('rename', 'archive', 'restore')),
  -- Metrics Core text is unbounded (v10): no length or text check here, so a
  -- legacy variable can always be renamed; the R2 request guard checks the
  -- new texts of a rename.
  old_label text not null,
  new_label text not null,
  old_short_label text,
  new_short_label text,
  old_description text,
  new_description text,
  old_state text not null
    constraint metric_variable_changes_old_state_check check (old_state in ('active', 'archived')),
  new_state text not null
    constraint metric_variable_changes_new_state_check check (new_state in ('active', 'archived')),
  changed_by_user_id uuid not null references public.users(id) on delete restrict,
  xact_id xid8 not null,
  changed_at timestamptz not null default clock_timestamp(),
  constraint metric_variable_changes_owner_shape check ((owner_scope = 'system') = (owner_club_id is null)),
  constraint metric_variable_changes_kind_shape check (
    (kind = 'rename' and old_state = 'active' and new_state = 'active')
    or (kind = 'archive' and old_state = 'active' and new_state = 'archived')
    or (kind = 'restore' and old_state = 'archived' and new_state = 'active')
  ),
  constraint metric_variable_changes_one_seq unique (seq)
);

create index metric_variable_changes_definition_idx on training_load.metric_variable_changes (metric_definition_id, seq);
create index metric_variable_changes_user_idx on training_load.metric_variable_changes (changed_by_user_id);

-- A change row only from inside a trigger of this transaction, by the acting
-- user, for a definition this transaction wrote, of the definition's owner.
create function training_load.metric_variable_changes_insert_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  def record;
begin
  if pg_trigger_depth() < 2 or new.xact_id is distinct from pg_current_xact_id() then
    raise exception 'metric_variable_changes: a change row is written only by the definition''s own change' using errcode = '23514';
  end if;
  if new.changed_by_user_id is distinct from actor then
    raise exception 'metric_variable_changes: the row names another user than the acting user' using errcode = '42501';
  end if;
  select owner_scope, owner_club_id, xmin::text::bigint as written_in into def
    from training_load.metric_definitions where id = new.metric_definition_id;
  if not found
     or def.written_in is distinct from training_load.source_metric_current_xmin()
     or def.owner_scope is distinct from new.owner_scope
     or def.owner_club_id is distinct from new.owner_club_id then
    raise exception 'metric_variable_changes: a change row is written only by the definition''s own change' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_variable_changes_insert_guard
  before insert on training_load.metric_variable_changes
  for each row execute function training_load.metric_variable_changes_insert_guard();

-- The writer: every change of the four columns of a system or club row.
-- Values from OLD and NEW only; a rename keeps the state, an archive and a
-- restore are told apart by the state alone (a statement that changes both
-- is recorded by its state and then refused by the R2 request guard).
create function training_load.metric_definitions_record_change() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
begin
  insert into training_load.metric_variable_changes
    (metric_definition_id, owner_scope, owner_club_id, kind, old_label, new_label, old_short_label, new_short_label,
     old_description, new_description, old_state, new_state, changed_by_user_id, xact_id)
  values
    (new.id, new.owner_scope, new.owner_club_id,
     case when old.state = new.state then 'rename' when new.state = 'archived' then 'archive' else 'restore' end,
     old.label, new.label, old.short_label, new.short_label, old.description, new.description, old.state, new.state,
     actor, pg_current_xact_id());
  return null;
end;
$$ language plpgsql;

create trigger metric_definitions_v38_record_change
  after update of label, short_label, description, state on training_load.metric_definitions
  for each row
  -- Written so a dump and restore reads it back the same (gpexe-backup-verify
  -- compares the definitions): four plain comparisons, not a row comparison
  -- (stored as nested ORs, which a restore flattens), and the varchar
  -- owner_scope compared as text (an IN list against varchar is stored with
  -- casts a restore rewrites).
  when ((old.owner_scope::text in ('system', 'club') or new.owner_scope::text in ('system', 'club'))
        and (old.label is distinct from new.label or old.short_label is distinct from new.short_label
             or old.description is distinct from new.description or old.state is distinct from new.state))
  execute function training_load.metric_definitions_record_change();

-- ---------------------------------------------------------------------------
-- 3. The key of a canonical variable never changes.
-- ---------------------------------------------------------------------------
create function training_load.metric_definitions_key_freeze() returns trigger as $$
begin
  if new.key is distinct from old.key and (old.owner_scope in ('system', 'club') or new.owner_scope in ('system', 'club')) then
    raise exception 'metric_definitions: the key of a canonical variable never changes' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- Named after v34's metric_definitions_source_metric_guard and
-- metric_definitions_source_metric_owner_guard (triggers fire in name order).
create trigger metric_definitions_v38_key_freeze
  before update of key on training_load.metric_definitions
  for each row execute function training_load.metric_definitions_key_freeze();

-- ---------------------------------------------------------------------------
-- 4. The request record, widened (v36's constraint names kept).
-- ---------------------------------------------------------------------------
alter table training_load.metric_variable_requests
  drop constraint metric_variable_requests_operation_check,
  add constraint metric_variable_requests_operation_check check (operation in (
    'variable_create', 'variable_version_create', 'variable_rename', 'variable_archive', 'variable_restore')),
  drop constraint metric_variable_requests_basis_check,
  add constraint metric_variable_requests_basis_check check (basis in ('platform_admin', 'club_admin', 'team_coach')),
  alter column metric_definition_version_id drop not null,
  add column basis_team_id uuid references public.teams(id) on delete restrict,
  add column metric_variable_change_id uuid
    constraint metric_variable_requests_one_per_change unique
    references training_load.metric_variable_changes(id) on delete restrict,
  add column reason text,
  add constraint metric_variable_requests_version_iff check (
    (metric_definition_version_id is not null) = (operation in ('variable_create', 'variable_version_create'))),
  add constraint metric_variable_requests_change_iff check (
    (metric_variable_change_id is not null) = (operation in ('variable_rename', 'variable_archive', 'variable_restore'))),
  add constraint metric_variable_requests_team_iff check ((basis = 'team_coach') = (basis_team_id is not null)),
  add constraint metric_variable_requests_team_coach_shape check (
    basis <> 'team_coach' or (owner_scope = 'club' and operation in ('variable_rename', 'variable_archive', 'variable_restore'))),
  add constraint metric_variable_requests_reason_check check (
    reason is null or (operation in ('variable_rename', 'variable_archive', 'variable_restore')
                       and training_load.source_metric_text_ok(reason, 500)));

create index metric_variable_requests_basis_team_idx
  on training_load.metric_variable_requests (basis_team_id) where basis_team_id is not null;

-- v36's guard, unchanged, for v36's two operations only.
drop trigger metric_variable_requests_insert_guard on training_load.metric_variable_requests;
create trigger metric_variable_requests_insert_guard
  before insert on training_load.metric_variable_requests
  for each row
  when (new.operation in ('variable_create', 'variable_version_create'))
  execute function training_load.metric_variable_requests_insert_guard();

-- ---------------------------------------------------------------------------
-- 5. The R2 request guard.
-- ---------------------------------------------------------------------------
create function training_load.metric_variable_requests_change_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  def record;
  chg record;
  prior record;
  derived text;
  this_xact xid8 := pg_current_xact_id();
begin
  if new.requested_by_user_id is distinct from actor then
    raise exception 'metric variable request: the row names another user than the acting user' using errcode = '42501';
  end if;
  select owner_scope, owner_club_id, label, short_label, description, state, current_version_id,
         xmin::text::bigint as written_in into def
    from training_load.metric_definitions where id = new.metric_definition_id;
  if not found
     or def.owner_scope not in ('system', 'club')
     or def.owner_scope is distinct from new.owner_scope
     or def.owner_club_id is distinct from new.owner_club_id then
    raise exception 'metric_variable_requests: the request must follow its own change in the same transaction' using errcode = '23514';
  end if;
  derived := training_load.metric_variable_change_basis(actor, def.owner_club_id, new.basis_team_id);
  if derived is null then
    raise exception 'metric variable request: the acting user may not write this owner scope' using errcode = '42501';
  end if;
  if new.basis is distinct from derived then
    raise exception 'metric variable request: the basis is not the acting user''s own' using errcode = '42501';
  end if;
  select id, seq, metric_definition_id, owner_scope, owner_club_id, kind, old_label, new_label, old_short_label, new_short_label,
         old_description, new_description, old_state, new_state, changed_by_user_id, xact_id, xmin::text::bigint as written_in into chg
    from training_load.metric_variable_changes where id = new.metric_variable_change_id;
  if not found
     or chg.metric_definition_id is distinct from new.metric_definition_id
     or chg.owner_scope is distinct from def.owner_scope
     or chg.owner_club_id is distinct from def.owner_club_id
     or chg.xact_id is distinct from this_xact
     or chg.written_in is distinct from here
     or chg.changed_by_user_id is distinct from actor
     or def.written_in is distinct from here
     or (select count(*) from training_load.metric_variable_changes
          where metric_definition_id = new.metric_definition_id and xact_id = this_xact) <> 1
     or (def.label, def.short_label, def.description, def.state)
        is distinct from (chg.new_label, chg.new_short_label, chg.new_description, chg.new_state) then
    raise exception 'metric_variable_requests: the request must follow its own change in the same transaction' using errcode = '23514';
  end if;
  if (new.operation = 'variable_rename' and chg.kind is distinct from 'rename')
     or (new.operation = 'variable_archive' and chg.kind is distinct from 'archive')
     or (new.operation = 'variable_restore' and chg.kind is distinct from 'restore')
     or (chg.kind <> 'rename'
         and (chg.old_label, chg.old_short_label, chg.old_description)
             is distinct from (chg.new_label, chg.new_short_label, chg.new_description)) then
    raise exception 'metric_variable_requests: the change does not match the operation' using errcode = '23514';
  end if;
  -- A rename's new texts are bounded text; a value it leaves as it was is
  -- exempt (a legacy variable keeps its longer label while its description
  -- changes).
  if chg.kind = 'rename'
     and not ((chg.new_label is not distinct from chg.old_label or training_load.source_metric_text_ok(chg.new_label, 80))
              and (chg.new_short_label is null or chg.new_short_label is not distinct from chg.old_short_label
                   or training_load.source_metric_text_ok(chg.new_short_label, 20))
              and (chg.new_description is null or chg.new_description is not distinct from chg.old_description
                   or training_load.source_metric_text_ok(chg.new_description, 500))) then
    raise exception 'metric_variable_requests: a new label, short label or description is not bounded text' using errcode = '23514';
  end if;
  if derived = 'team_coach' then
    -- Q4: a coach does not rename a variable an active mapping version pins.
    if chg.kind = 'rename' and exists (
         select 1 from training_load.source_metric_mapping_versions
          where metric_definition_id = new.metric_definition_id and metric_definition_version_id = def.current_version_id
            and status = 'active') then
      raise exception 'metric_variable_requests: a team coach does not rename a pinned variable' using errcode = '23514';
    end if;
    -- Q8: a coach restores only an archive a coach made - the definition's
    -- most recent change before this one is an archive whose request had the
    -- team_coach basis. An archive with no change row (legacy, or written with
    -- the trigger off) is no coach's: refused.
    if chg.kind = 'restore' then
      select c.kind, r.basis into prior
        from training_load.metric_variable_changes c
        left join training_load.metric_variable_requests r on r.metric_variable_change_id = c.id
       where c.metric_definition_id = new.metric_definition_id and c.seq < chg.seq
       order by c.seq desc
       limit 1;
      if not found or prior.kind is distinct from 'archive' or prior.basis is distinct from 'team_coach' then
        raise exception 'metric_variable_requests: a team coach restores only a coach''s archive' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_variable_requests_change_guard
  before insert on training_load.metric_variable_requests
  for each row
  when (new.operation in ('variable_rename', 'variable_archive', 'variable_restore'))
  execute function training_load.metric_variable_requests_change_guard();

-- ---------------------------------------------------------------------------
-- 6. At COMMIT: every change row has the request row that names it.
-- ---------------------------------------------------------------------------
create function training_load.metric_variable_changes_request_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.metric_variable_requests where metric_variable_change_id = new.id) then
    raise exception 'metric_variable_changes: a change is written with its own request row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger metric_variable_changes_request_link
  after insert on training_load.metric_variable_changes
  deferrable initially deferred
  for each row execute function training_load.metric_variable_changes_request_link();

-- ---------------------------------------------------------------------------
-- 7. Append-only.
-- ---------------------------------------------------------------------------
create function training_load.metric_variable_changes_append_only() returns trigger as $$
begin
  raise exception 'metric_variable_changes: change records are append-only' using errcode = '23514';
end;
$$ language plpgsql;

create trigger metric_variable_changes_no_update_delete
  before update or delete on training_load.metric_variable_changes
  for each row execute function training_load.metric_variable_changes_append_only();

create trigger metric_variable_changes_no_truncate
  before truncate on training_load.metric_variable_changes
  for each statement execute function training_load.metric_variable_changes_append_only();
