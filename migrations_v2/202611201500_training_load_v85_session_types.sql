-- Training Load v85 - OptiMove decides the session type (ST-1 of docs/ai/session-type-plan.md, merged as PR #699;
-- the owner's answers Q1-Q5 of 2026-11-20 relayed by the OptiMove manager).
--
-- What this migration does:
--   * training.activity_types stays the one registry of session types (no parallel table). It gains an owner
--     ('system' or 'club' with its club), who created it, who archived it and when, a sort order and updated_at.
--     The key is the identity and never changes; a rename changes only the label; an archive sets is_active = false
--     (is_active <=> archived_at is null). A club type's key is generated ('c_<8 hex>_<slug>').
--   * The seed (the owner's six, Q1, Q4, Q5): training_session is relabelled "Full training" (every session of that type,
--     hand-planned ones included, Q4); match is relabelled "Game"; friendly_match "Friendly game", exercise_session
--     "Exercise", compensation_session "Compensation", rtp_session "RTP" are added; testing_session and recovery_session
--     are archived (no user: a seed archive) and stay on the activities that hold them (Q5).
--   * training.activity_type_changes: the append-only log of every add, rename, archive and restore (who, the basis,
--     the old and new label, the request key and its hash - the request record of the routes).
--   * Guards (the v35 pattern): every write of training.activity_types and of the log needs the transaction's acting
--     user (optimove.session_type_actor = '<user uuid>:<xact id>') with the right for the type's owner: an active
--     platform admin for a system type, the active club admin of an active club for a club type. The rights are
--     locked users first (PR #346). A change of a type without its log row in the same transaction is refused at
--     COMMIT (deferred). A type is never deleted or truncated; key, owner and creator never change.
--   * The type's owner on training.activities (the Independent's MEDIUM-2 on the plan): an activity holds a system
--     type or a type of the club that owns it (owner_club_id, or the owner team's club); a user's activity takes system
--     types only. A newly set key must be active; a row that keeps its key is never refused for a later archive. The
--     guard locks the type row FOR SHARE (an archive locks it FOR UPDATE and waits for a write in flight).
--   * training_load.source_session_types: the team's last choice per source category (the suggestion of plan section
--     4 (b)), seeded with GPEXE "FULL TRAINING" -> training_session for every team with an active gpexe binding. A
--     write needs the acting user with a team manager's right (platform admin, the team's club admin, the team's
--     coach) and a type offered to the team.
--
-- Nothing is written to any other table; no existing activity changes its type.
-- Lock orders: a type write - the acting user, its role row (FOR SHARE), the club (FOR SHARE), the type row; an
-- activity write - the activity row, then the type row (FOR SHARE); a source-map write - the acting user, the role
-- row, the team and club, then the type row (FOR SHARE).
-- The guards prove that the row, the actor and the right agree; they do not stop whoever holds the database
-- credentials (stated as v35 states it).
-- Rollback: docs/runbooks/session-types-v85-rollback.sql. Runbook: docs/runbooks/session-types-v85.md.

-- ---------------------------------------------------------------------------
-- 0. Preconditions: the catalog is still the v1 shape, and the new keys are free
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'training' and table_name = 'activity_types'
              and column_name in ('owner_scope', 'owner_club_id', 'archived_at', 'archived_by_user_id', 'created_by_user_id', 'sort_order', 'updated_at')) then
    raise exception 'v85 refused: training.activity_types already has a v85 column' using errcode = '23514';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'training' and table_name = 'activity_types') <> 4 then
    raise exception 'v85 refused: training.activity_types is not the v1 shape (key, label, is_active, created_at)' using errcode = '23514';
  end if;
  if exists (select 1 from training.activity_types where key in ('friendly_match', 'exercise_session', 'compensation_session', 'rtp_session')) then
    raise exception 'v85 refused: a key v85 seeds already exists' using errcode = '23514';
  end if;
  if (select count(*) from training.activity_types where key in ('training_session', 'match', 'testing_session', 'recovery_session')) <> 4 then
    raise exception 'v85 refused: one of the four v1 types is missing' using errcode = '23514';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. training.activity_types: owner, archive, creator, order
-- ---------------------------------------------------------------------------
alter table training.activity_types
  add column owner_scope text not null default 'system',
  add column owner_club_id uuid references public.clubs(id) on delete restrict,
  add column created_by_user_id uuid references public.users(id) on delete restrict,
  add column archived_at timestamptz,
  add column archived_by_user_id uuid references public.users(id) on delete restrict,
  add column sort_order integer not null default 100,
  add column updated_at timestamptz not null default now();

-- The seed (before any guard exists; the migration runs without an acting user).
update training.activity_types set label = 'Full training', sort_order = 10 where key = 'training_session';
update training.activity_types set label = 'Game', sort_order = 20 where key = 'match';
insert into training.activity_types (key, label, sort_order) values
  ('friendly_match',       'Friendly game', 30),
  ('exercise_session',     'Exercise',      40),
  ('compensation_session', 'Compensation',  50),
  ('rtp_session',          'RTP',           60);
update training.activity_types set is_active = false, archived_at = now(), sort_order = 90
 where key in ('testing_session', 'recovery_session');

alter table training.activity_types
  add constraint activity_types_owner_scope_check check (owner_scope in ('system', 'club')),
  add constraint activity_types_owner_shape check (
    (owner_scope = 'system' and owner_club_id is null) or (owner_scope = 'club' and owner_club_id is not null)),
  add constraint activity_types_key_shape check (
    (owner_scope = 'system' and key ~ '^[a-z][a-z0-9_]{1,40}$') or
    (owner_scope = 'club' and key ~ '^c_[0-9a-f]{8}_[a-z0-9_]{1,40}$')),
  add constraint activity_types_label_check check (training_load.source_metric_text_ok(label, 60)),
  add constraint activity_types_archive_shape check (is_active = (archived_at is null)),
  add constraint activity_types_archived_by_shape check (archived_by_user_id is null or archived_at is not null),
  add constraint activity_types_sort_order_check check (sort_order between 0 and 10000);

-- One live label per owner (an archived type frees its label).
create unique index activity_types_owner_label_live_key
  on training.activity_types (owner_scope, owner_club_id, lower(label)) nulls not distinct where is_active;
create index activity_types_owner_club_idx on training.activity_types (owner_club_id) where owner_club_id is not null;

-- ---------------------------------------------------------------------------
-- 2. The change log (and the request record of the routes)
-- ---------------------------------------------------------------------------
create table training.activity_type_changes (
  id                   uuid primary key default gen_random_uuid(),
  type_key             text not null references training.activity_types(key) on delete restrict,
  action               text not null
                       constraint activity_type_changes_action_check check (action in ('create', 'rename', 'archive', 'restore')),
  old_label            text,
  new_label            text not null
                       constraint activity_type_changes_new_label_check check (training_load.source_metric_text_ok(new_label, 60)),
  performed_by_user_id uuid not null references public.users(id) on delete restrict,
  basis                text not null
                       constraint activity_type_changes_basis_check check (basis in ('platform_admin', 'club_admin')),
  request_key          uuid not null,
  request_hash         text not null constraint activity_type_changes_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  created_xact         text not null default pg_current_xact_id()::text,
  created_at           timestamptz not null default now(),
  constraint activity_type_changes_label_shape check (
    (action = 'create' and old_label is null) or (action <> 'create' and old_label is not null))
);
create unique index activity_type_changes_request_key on training.activity_type_changes (performed_by_user_id, request_key);
create index activity_type_changes_type_idx on training.activity_type_changes (type_key, created_at);

-- ---------------------------------------------------------------------------
-- 3. The acting user and the rights
-- ---------------------------------------------------------------------------
create function training.session_type_actor() returns uuid as $$
declare
  raw text := current_setting('optimove.session_type_actor', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    raise exception 'session type: no acting user is set for this transaction' using errcode = '42501';
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql;

-- The basis on which p_user may write a type of this owner, or null. Users first, then the role row, then the club
-- (PR #346); every row FOR SHARE.
create function training.session_type_basis(p_user uuid, p_owner_scope text, p_club uuid) returns text as $$
begin
  perform 1 from public.users u where u.id = p_user and u.is_active = true for share;
  if not found then
    return null;
  end if;
  if p_owner_scope = 'system' then
    perform 1 from public.user_global_roles r
     where r.user_id = p_user and r.role = 'platform_admin' and r.is_active = true for share of r;
    return case when found then 'platform_admin' end;
  end if;
  if p_owner_scope = 'club' and p_club is not null then
    perform 1 from public.user_club_roles r
     where r.user_id = p_user and r.club_id = p_club and r.role = 'club_admin' and r.is_active = true for share of r;
    if not found then
      return null;
    end if;
    perform 1 from public.clubs c where c.id = p_club and c.is_active = true for share;
    return case when found then 'club_admin' end;
  end if;
  return null;
end;
$$ language plpgsql;

-- Whether a type is offered to an owner club (null: a user's or the system's activity - system types only), and,
-- with p_require_active, still active. The type row is locked FOR SHARE.
create function training.session_type_offered(p_key text, p_club uuid, p_require_active boolean) returns boolean as $$
declare
  v_type record;
begin
  select owner_scope, owner_club_id, is_active into v_type from training.activity_types where key = p_key for share;
  if not found then
    return false;
  end if;
  if v_type.owner_scope = 'club' and (p_club is null or v_type.owner_club_id is distinct from p_club) then
    return false;
  end if;
  return not p_require_active or v_type.is_active;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 4. Guards on training.activity_types
-- ---------------------------------------------------------------------------
create function training.activity_types_before_write() returns trigger as $$
declare
  v_actor uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'training.activity_types: a session type is never deleted; archive it' using errcode = '23514';
  end if;
  v_actor := training.session_type_actor();
  if tg_op = 'UPDATE' then
    if new.key is distinct from old.key or new.owner_scope is distinct from old.owner_scope
       or new.owner_club_id is distinct from old.owner_club_id or new.created_by_user_id is distinct from old.created_by_user_id
       or new.created_at is distinct from old.created_at then
      raise exception 'training.activity_types: key, owner and creator are write-once' using errcode = '23514';
    end if;
    if new.is_active is distinct from old.is_active then
      if new.is_active then
        if new.archived_at is not null or new.archived_by_user_id is not null then
          raise exception 'training.activity_types: a restore clears the archive' using errcode = '23514';
        end if;
      elsif new.archived_by_user_id is distinct from v_actor then
        raise exception 'training.activity_types: an archive names the acting user' using errcode = '23514';
      end if;
    elsif new.archived_at is distinct from old.archived_at or new.archived_by_user_id is distinct from old.archived_by_user_id then
      raise exception 'training.activity_types: the archive changes only with is_active' using errcode = '23514';
    end if;
    new.updated_at := now();
  else
    if new.created_by_user_id is distinct from v_actor then
      raise exception 'training.activity_types: a new type names the acting user as its creator' using errcode = '23514';
    end if;
    if not new.is_active then
      raise exception 'training.activity_types: a new type is active' using errcode = '23514';
    end if;
  end if;
  if training.session_type_basis(v_actor, new.owner_scope, new.owner_club_id) is null then
    raise exception 'training.activity_types: the acting user may not write this session type' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_types_before_write
  before insert or update or delete on training.activity_types
  for each row execute function training.activity_types_before_write();

create function training.activity_types_no_truncate() returns trigger as $$
begin
  raise exception 'training.activity_types: a session type is never deleted; archive it' using errcode = '23514';
end;
$$ language plpgsql;
create trigger activity_types_no_truncate before truncate on training.activity_types
  for each statement execute function training.activity_types_no_truncate();

-- A change of a type needs its log row in the same transaction (deferred, the v35 lesson).
create function training.activity_types_change_logged() returns trigger as $$
begin
  if not exists (select 1 from training.activity_type_changes c
                  where c.type_key = new.key and c.created_xact = pg_current_xact_id()::text) then
    raise exception 'training.activity_types: a change of a session type needs its log row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;
create constraint trigger activity_types_change_logged
  after insert or update on training.activity_types deferrable initially deferred
  for each row execute function training.activity_types_change_logged();

-- ---------------------------------------------------------------------------
-- 5. Guards on the log
-- ---------------------------------------------------------------------------
create function training.activity_type_changes_before_insert() returns trigger as $$
declare
  v_actor uuid := training.session_type_actor();
  v_type record;
begin
  if new.performed_by_user_id is distinct from v_actor then
    raise exception 'training.activity_type_changes: the row names the acting user' using errcode = '42501';
  end if;
  if new.created_xact is distinct from pg_current_xact_id()::text then
    raise exception 'training.activity_type_changes: created_xact is the writing transaction' using errcode = '23514';
  end if;
  select owner_scope, owner_club_id, label, is_active into v_type from training.activity_types where key = new.type_key;
  if not found then
    raise exception 'training.activity_type_changes: no such session type' using errcode = '23514';
  end if;
  if new.basis is distinct from training.session_type_basis(v_actor, v_type.owner_scope, v_type.owner_club_id) then
    raise exception 'training.activity_type_changes: the basis is not the acting user''s right' using errcode = '42501';
  end if;
  if new.new_label is distinct from v_type.label
     or (new.action = 'rename' and new.old_label is not distinct from new.new_label)
     or (new.action = 'archive' and v_type.is_active)
     or (new.action in ('create', 'restore', 'rename') and not v_type.is_active) then
    raise exception 'training.activity_type_changes: the row does not match the session type' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_type_changes_before_insert
  before insert on training.activity_type_changes
  for each row execute function training.activity_type_changes_before_insert();

create function training.activity_type_changes_append_only() returns trigger as $$
begin
  raise exception 'training.activity_type_changes is append-only' using errcode = '23514';
end;
$$ language plpgsql;
create trigger activity_type_changes_no_update before update or delete on training.activity_type_changes
  for each row execute function training.activity_type_changes_append_only();
create trigger activity_type_changes_no_truncate before truncate on training.activity_type_changes
  for each statement execute function training.activity_type_changes_append_only();

-- ---------------------------------------------------------------------------
-- 6. The type's owner on training.activities (every write path)
-- ---------------------------------------------------------------------------
create function training.activities_session_type_guard() returns trigger as $$
declare
  v_club uuid;
begin
  if new.activity_type_key is null then
    return new;
  end if;
  if new.owner_scope = 'club' then
    v_club := new.owner_club_id;
  elsif new.owner_scope = 'team' then
    select club_id into v_club from public.teams where id = new.owner_team_id;
  end if;
  if not training.session_type_offered(new.activity_type_key, v_club,
                                        tg_op = 'INSERT' or new.activity_type_key is distinct from old.activity_type_key) then
    raise exception 'training.activities: the session type is not offered to this activity''s owner' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activities_session_type_guard
  before insert or update of activity_type_key, owner_scope, owner_club_id, owner_team_id on training.activities
  for each row execute function training.activities_session_type_guard();

-- ---------------------------------------------------------------------------
-- 7. The team's suggestion per source category
-- ---------------------------------------------------------------------------
create table training_load.source_session_types (
  owner_team_id     uuid not null references public.teams(id) on delete restrict,
  source_system     text not null constraint source_session_types_source_check check (source_system in ('gpexe')),
  category_name     text not null constraint source_session_types_category_check check (training_load.source_metric_text_ok(category_name, 80)),
  activity_type_key text not null references training.activity_types(key) on delete restrict,
  set_by_user_id    uuid references public.users(id) on delete restrict,
  seeded            boolean not null default false,
  set_at            timestamptz not null default now(),
  primary key (owner_team_id, source_system, category_name),
  constraint source_session_types_seed_shape check ((set_by_user_id is null) = seeded)
);

-- The seed: today's fixed pair, for every team with an active gpexe binding.
insert into training_load.source_session_types (owner_team_id, source_system, category_name, activity_type_key, seeded)
select distinct b.team_id, 'gpexe', 'FULL TRAINING', 'training_session', true
  from training_load.source_team_bindings b
 where b.source_system = 'gpexe' and b.state = 'active';

create function training_load.source_session_types_before_write() returns trigger as $$
declare
  v_actor uuid;
  v_club uuid;
  v_right boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'training_load.source_session_types: a suggestion is replaced, never deleted' using errcode = '23514';
  end if;
  v_actor := training.session_type_actor();
  if tg_op = 'UPDATE' and (new.owner_team_id is distinct from old.owner_team_id or new.source_system is distinct from old.source_system
                           or new.category_name is distinct from old.category_name) then
    raise exception 'training_load.source_session_types: team, source and category are write-once' using errcode = '23514';
  end if;
  if new.seeded or new.set_by_user_id is distinct from v_actor then
    raise exception 'training_load.source_session_types: a suggestion names the acting user' using errcode = '42501';
  end if;
  new.set_at := now();
  -- A team manager: users first, then the role rows, then the team and its club.
  perform 1 from public.users u where u.id = v_actor and u.is_active = true for share;
  if found then
    perform 1 from public.user_global_roles r where r.user_id = v_actor and r.role = 'platform_admin' and r.is_active = true for share of r;
    v_right := found;
    if not v_right then
      perform 1 from public.user_team_roles r where r.user_id = v_actor and r.team_id = new.owner_team_id
         and r.role = 'team_coach' and r.is_active = true for share of r;
      v_right := found;
    end if;
    select t.club_id into v_club from public.teams t where t.id = new.owner_team_id and t.is_active = true for share;
    if not found then
      v_right := false;
    elsif not v_right then
      perform 1 from public.user_club_roles r where r.user_id = v_actor and r.club_id = v_club
         and r.role = 'club_admin' and r.is_active = true for share of r;
      v_right := found;
    end if;
  end if;
  if not v_right then
    raise exception 'training_load.source_session_types: the acting user may not set this team''s suggestion' using errcode = '42501';
  end if;
  if not training.session_type_offered(new.activity_type_key, v_club, true) then
    raise exception 'training_load.source_session_types: the session type is not offered to this team' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger source_session_types_before_write
  before insert or update or delete on training_load.source_session_types
  for each row execute function training_load.source_session_types_before_write();
create trigger source_session_types_no_truncate before truncate on training_load.source_session_types
  for each statement execute function training.activity_types_no_truncate();
