-- v53: a club copies or hides a system variable, and moves a team from the
-- system variable to its copy (phase 7i, C132-C140).
--
-- Contract: docs/ai/phase7i-system-variables-club-contract.md (J15), section 7,
-- accepted by the owner on 2026-11-02 (C132-C140). It adds:
--
--   * A check, before anything changes, that the two bodies v53 replaces are
--     the ones in force (their md5: v36's request insert guard and v48's T5
--     insert guard), and that the request table's operation CHECK, its
--     version_iff CHECK, its one-create index and its insert trigger are the
--     ones v36, v38 and v45 left.
--   * training_load.metric_definition_copies (J15 7.1): one row per club and
--     copied system variable, naming the system version it copied; append-only.
--   * training_load.source_metric_mapping_version_copies (J15 7.2, J18's Q14 ->
--     C125 option one): the typed link from a club draft to the active system
--     mapping version it reproduces, identical in every listed column;
--     append-only.
--   * training_load.metric_definition_club_hides (J15 7.3): a club's hide of a
--     system variable, state and history in one table, shaped like T5; the
--     hide row is the request record of the hide, and its show facts the
--     request record of the show; never deleted.
--   * The variable request record (J15 7.4): the operation 'variable_copy',
--     a nullable operation_id that only a copy carries, version_iff and the
--     one-create index widened to it, and v36's insert guard checking a copy
--     as a create plus its copy row in the same operation.
--   * v48's T5 insert guard (J15 7.5): for a system mapping version, the hide
--     lock of the binding's club and the version's variable, then a refusal
--     while that club hides it. Every other line stays byte for byte.
--
-- The hide lock (J15 section 5), defined once and used by the services and
-- the guards alike:
--   pg_advisory_xact_lock(hashtextextended('club-variable-hide:' || club::text
--     || ':' || definition::text, 0))
-- built in SQL from uuid values, seed 0 (runWrite's per-user lock uses seed 34
-- and another prefix). Several are taken ascending by (club, definition). A
-- path takes it after its last row lock and before its state checks and its
-- first write; no row lock follows it. The guards' key lock
--   'club-variable-hide-key:' || actor || ':' || key
-- comes after the hide lock.
--
-- Errors: an acting user who is not allowed raises 42501; every other explicit
-- refusal raises 23514; every message is fixed text without an id, a name or
-- a value (C44). A write inside a savepoint is refused: every guard compares
-- the xmin of the rows it relies on with the transaction's own (v35).
--
-- Raw writers of these tables use READ COMMITTED (the application pins it): a
-- guard's read after an advisory lock sees what committed before the lock was
-- granted only under that isolation.
--
-- Locks: the request table ACCESS EXCLUSIVE and T5 SHARE ROW EXCLUSIVE, both
-- NOWAIT (a busy table fails the migration at once, nothing applied, the old
-- instance serving). The new tables' foreign keys take SHARE ROW EXCLUSIVE on
-- public.clubs, public.users, metric_definitions, metric_definition_versions
-- and T4 within the runner's lock_timeout (30 s), the accepted risk of v34,
-- v36 and v48; the preflight's quiet-moment block is the gate.
--
-- Rollback: docs/runbooks/system-variables-club-v53-rollback.sql (it refuses
-- once any copy, link or hide row or any variable_copy request exists, and
-- under a later migration; it restores both bodies, the CHECKs, the index and
-- the trigger byte for byte).
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to; it is no defence against whoever controls the shared owner
-- credentials or runs SQL through the application's pool. The rights
-- functions the guards call (v35) still lock the role row before the user
-- row; under the services they only re-lock rows already held users first
-- (LO-1); LO-2 turns them.

-- ---------------------------------------------------------------------------
-- 0. The locks, in a write's own order, without waiting.
-- ---------------------------------------------------------------------------
lock table training_load.metric_variable_requests in access exclusive mode nowait;
lock table training_load.source_metric_mapping_activations in share row exclusive mode nowait;

-- ---------------------------------------------------------------------------
-- 1. v53 is written on the bodies and definitions in force: refuse any other.
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['metric_variable_requests_insert_guard', 'ae5bf5e22620546a83cf955b8b1d9a9d', 'v36'],
    ['source_metric_activations_insert_guard', 'e47f75d4a7a6c63659a19491db97d678', 'v48']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v53 refused: the body in force of training_load.% is not %''s', expected[i][1], expected[i][3] using errcode = '23514';
    end if;
  end loop;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'training_load.metric_variable_requests'::regclass
         and conname = 'metric_variable_requests_operation_check')
     is distinct from 'CHECK ((operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text, ''variable_rename''::text, ''variable_archive''::text, ''variable_restore''::text, ''variable_icon''::text])))'
     or (select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'training_load.metric_variable_requests'::regclass
            and conname = 'metric_variable_requests_version_iff')
     is distinct from 'CHECK (((metric_definition_version_id IS NOT NULL) = (operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text]))))' then
    raise exception 'v53 refused: the CHECKs of training_load.metric_variable_requests are not v45''s and v38''s' using errcode = '23514';
  end if;
  if (select indexdef from pg_indexes
       where schemaname = 'training_load' and indexname = 'metric_variable_requests_one_create_per_definition')
     is distinct from 'CREATE UNIQUE INDEX metric_variable_requests_one_create_per_definition ON training_load.metric_variable_requests USING btree (metric_definition_id) WHERE (operation = ''variable_create''::text)'
     or (select pg_get_triggerdef(t.oid) from pg_trigger t
          where t.tgrelid = 'training_load.metric_variable_requests'::regclass
            and t.tgname = 'metric_variable_requests_insert_guard')
     is distinct from 'CREATE TRIGGER metric_variable_requests_insert_guard BEFORE INSERT ON training_load.metric_variable_requests FOR EACH ROW WHEN ((new.operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text]))) EXECUTE FUNCTION training_load.metric_variable_requests_insert_guard()' then
    raise exception 'v53 refused: the one-create index or the insert trigger of training_load.metric_variable_requests is not v36''s and v38''s' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Append-only, for the three new tables (UPDATE of a hide: section 5).
-- ---------------------------------------------------------------------------
create function training_load.club_variable_rows_append_only() returns trigger as $$
begin
  raise exception '%: rows are never changed or removed', tg_table_name using errcode = '23514';
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 3. The copy record (J15 7.1).
-- ---------------------------------------------------------------------------
create table training_load.metric_definition_copies (
  club_definition_id   uuid primary key
                         constraint metric_definition_copies_club_definition_fk
                         references training_load.metric_definitions(id) on delete restrict,
  club_id              uuid not null
                         constraint metric_definition_copies_club_fk
                         references public.clubs(id) on delete restrict,
  system_definition_id uuid not null
                         constraint metric_definition_copies_system_definition_fk
                         references training_load.metric_definitions(id) on delete restrict,
  system_version_id    uuid not null,
  copied_by_user_id    uuid not null
                         constraint metric_definition_copies_copied_by_fk
                         references public.users(id) on delete restrict,
  basis                text not null
                         constraint metric_definition_copies_basis_check
                         check (basis in ('platform_admin', 'club_admin')),
  operation_id         uuid not null,
  copied_at            timestamptz not null default now(),
  constraint metric_definition_copies_system_version_fk
    foreign key (system_version_id, system_definition_id)
    references training_load.metric_definition_versions (id, metric_definition_id) on delete restrict,
  constraint metric_definition_copies_one_per_club unique (club_id, system_definition_id),
  constraint metric_definition_copies_not_itself check (club_definition_id <> system_definition_id)
);

comment on table training_load.metric_definition_copies is
  'v53 (J15 7.1, C134, C136): a club variable made by copying a system variable at one of its versions; one per club and system variable; written once by the copy, never changed or removed.';

create function training_load.metric_definition_copies_insert_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  basis text;
  cdef record;
  cver record;
  sdef record;
  sver record;
begin
  if new.copied_by_user_id is distinct from actor then
    raise exception 'metric variable copy: the row names another user than the acting user' using errcode = '42501';
  end if;
  basis := training_load.source_metric_actor_basis(actor, new.club_id);
  if basis is null or new.basis is distinct from basis then
    raise exception 'metric variable copy: the acting user may not copy into this club' using errcode = '42501';
  end if;
  -- The club side: the club's own new variable, written in this transaction
  -- by the acting user, at its version 1.
  select owner_scope, owner_club_id, state, current_version_id, created_by_user_id, xmin::text::bigint as written_in into cdef
    from training_load.metric_definitions where id = new.club_definition_id;
  if not found
     or cdef.owner_scope is distinct from 'club'
     or cdef.owner_club_id is distinct from new.club_id
     or cdef.state is distinct from 'active'
     or cdef.written_in is distinct from here
     or cdef.created_by_user_id is distinct from actor then
    raise exception 'metric_definition_copies: the copy must be the club variable written in this transaction' using errcode = '23514';
  end if;
  select version_number, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method,
         created_by_user_id, xmin::text::bigint as written_in into cver
    from training_load.metric_definition_versions
   where id = cdef.current_version_id and metric_definition_id = new.club_definition_id;
  if not found or cver.version_number <> 1 or cver.written_in is distinct from here or cver.created_by_user_id is distinct from actor then
    raise exception 'metric_definition_copies: the copy must be the club variable written in this transaction' using errcode = '23514';
  end if;
  -- The system side (the service holds both rows FOR SHARE already, D's order).
  select owner_scope, state, current_version_id into sdef
    from training_load.metric_definitions where id = new.system_definition_id for share;
  if not found
     or sdef.owner_scope is distinct from 'system'
     or sdef.state is distinct from 'active'
     or sdef.current_version_id is distinct from new.system_version_id then
    raise exception 'metric_definition_copies: the source must be an active system variable at its current version' using errcode = '23514';
  end if;
  select unit, value_type, min_value, max_value, condition_description, daily_aggregation_method into sver
    from training_load.metric_definition_versions
   where id = new.system_version_id and metric_definition_id = new.system_definition_id for share;
  if exists (select 1 from training_load.metric_definition_copies c where c.club_definition_id = new.system_definition_id) then
    raise exception 'metric_definition_copies: the source must be an active system variable at its current version' using errcode = '23514';
  end if;
  if cver.unit is distinct from sver.unit
     or cver.value_type is distinct from sver.value_type
     or cver.min_value is distinct from sver.min_value
     or cver.max_value is distinct from sver.max_value
     or cver.condition_description is distinct from sver.condition_description
     or cver.daily_aggregation_method is distinct from sver.daily_aggregation_method then
    raise exception 'metric_definition_copies: version 1 of the copy must equal the system version in every semantic fact' using errcode = '23514';
  end if;
  if exists ((select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = new.club_definition_id)
             except
             (select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = new.system_definition_id))
     or exists ((select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = new.system_definition_id)
                except
                (select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = new.club_definition_id)) then
    raise exception 'metric_definition_copies: the copy''s scope capabilities must equal the system variable''s' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_definition_copies_insert_guard
  before insert on training_load.metric_definition_copies
  for each row execute function training_load.metric_definition_copies_insert_guard();

create trigger metric_definition_copies_no_update_delete
  before update or delete on training_load.metric_definition_copies
  for each row execute function training_load.club_variable_rows_append_only();

create trigger metric_definition_copies_no_truncate
  before truncate on training_load.metric_definition_copies
  for each statement execute function training_load.club_variable_rows_append_only();

-- At COMMIT: the copy's own variable_copy request row, and no savepoint.
create function training_load.metric_definition_copies_request_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.metric_variable_requests r
                  where r.operation = 'variable_copy'
                    and r.metric_definition_id = new.club_definition_id
                    and r.operation_id = new.operation_id) then
    raise exception 'metric_definition_copies: a copy needs its variable_copy request in the same operation' using errcode = '23514';
  end if;
  if (select c.xmin::text::bigint from training_load.metric_definition_copies c where c.club_definition_id = new.club_definition_id)
     is distinct from training_load.source_metric_current_xmin() then
    raise exception 'metric_definition_copies: a copy is written outside a savepoint' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger metric_definition_copies_request_link
  after insert on training_load.metric_definition_copies
  deferrable initially deferred
  for each row execute function training_load.metric_definition_copies_request_link();

-- ---------------------------------------------------------------------------
-- 4. The mapping-version link (J15 7.2; J18's Q14 -> C125 option one).
-- ---------------------------------------------------------------------------
create table training_load.source_metric_mapping_version_copies (
  club_version_id   uuid primary key
                      constraint source_metric_mapping_version_copies_club_version_fk
                      references training_load.source_metric_mapping_versions(id) on delete restrict,
  system_version_id uuid not null
                      constraint source_metric_mapping_version_copies_system_version_fk
                      references training_load.source_metric_mapping_versions(id) on delete restrict,
  operation_id      uuid not null,
  created_at        timestamptz not null default now(),
  constraint source_metric_mapping_version_copies_not_itself check (club_version_id <> system_version_id)
);

create index source_metric_mapping_version_copies_system_idx
  on training_load.source_metric_mapping_version_copies (system_version_id);

comment on table training_load.source_metric_mapping_version_copies is
  'v53 (J15 7.2, C125 option one): a club draft that reproduces an active system mapping version of the variable its club copied, identical in every listed column; written once by the copy, never changed or removed.';

create function training_load.source_metric_mapping_version_copies_insert_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  cv record;
  sv record;
  cm record;
  sm record;
  cp record;
  first_version uuid;
begin
  select v.*, v.xmin::text::bigint as written_in into cv
    from training_load.source_metric_mapping_versions v where v.id = new.club_version_id;
  if not found
     or cv.owner_key = 'system'
     or cv.status is distinct from 'draft'
     or cv.written_in is distinct from here
     or cv.created_by_user_id is distinct from actor then
    raise exception 'source_metric_mapping_version_copies: the club version must be the club''s draft written in this transaction' using errcode = '23514';
  end if;
  select v.* into sv from training_load.source_metric_mapping_versions v where v.id = new.system_version_id;
  if not found
     or sv.owner_key is distinct from 'system'
     or sv.status is distinct from 'active'
     or sv.activated_at is null then
    raise exception 'source_metric_mapping_version_copies: the system version must be an active system version' using errcode = '23514';
  end if;
  select metric_definition_id, owner_club_id into cm from training_load.source_metric_mappings where id = cv.mapping_id;
  select metric_definition_id into sm from training_load.source_metric_mappings where id = sv.mapping_id;
  select c.* into cp from training_load.metric_definition_copies c
   where c.club_definition_id = cm.metric_definition_id
     and c.club_id = cm.owner_club_id
     and c.system_definition_id = sm.metric_definition_id;
  if not found then
    raise exception 'source_metric_mapping_version_copies: the club version must target the copy of the system version''s variable' using errcode = '23514';
  end if;
  if new.operation_id is distinct from cp.operation_id then
    raise exception 'source_metric_mapping_version_copies: the link belongs to its copy''s operation' using errcode = '23514';
  end if;
  select id into first_version from training_load.metric_definition_versions
   where metric_definition_id = cp.club_definition_id and version_number = 1;
  if sv.metric_definition_version_id is distinct from cp.system_version_id
     or cv.metric_definition_version_id is distinct from first_version then
    raise exception 'source_metric_mapping_version_copies: the versions must pin the variable versions of the copy' using errcode = '23514';
  end if;
  -- Identical, null-safe; conversion_note and rounding_decimals are left out
  -- on purpose (free text and presentation).
  if cv.source_metric_version_id is distinct from sv.source_metric_version_id
     or cv.parameter_kind is distinct from sv.parameter_kind
     or cv.source_parameters is distinct from sv.source_parameters
     or cv.parameter_fingerprint is distinct from sv.parameter_fingerprint
     or cv.source_unit is distinct from sv.source_unit
     or cv.target_unit is distinct from sv.target_unit
     or cv.scale is distinct from sv.scale
     or cv.scale_divisor is distinct from sv.scale_divisor
     or cv."offset" is distinct from sv."offset"
     or cv.parameter_scale is distinct from sv.parameter_scale
     or cv.parameter_scale_divisor is distinct from sv.parameter_scale_divisor
     or cv.parameter_offset is distinct from sv.parameter_offset
     or cv.applies_to_session is distinct from sv.applies_to_session
     or cv.applies_to_drill is distinct from sv.applies_to_drill
     or cv.canonical_parameters is distinct from sv.canonical_parameters then
    raise exception 'source_metric_mapping_version_copies: the club version must be identical to the system version' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mapping_version_copies_insert_guard
  before insert on training_load.source_metric_mapping_version_copies
  for each row execute function training_load.source_metric_mapping_version_copies_insert_guard();

create trigger source_metric_mapping_version_copies_no_update_delete
  before update or delete on training_load.source_metric_mapping_version_copies
  for each row execute function training_load.club_variable_rows_append_only();

create trigger source_metric_mapping_version_copies_no_truncate
  before truncate on training_load.source_metric_mapping_version_copies
  for each statement execute function training_load.club_variable_rows_append_only();

-- At COMMIT: the club version's mapping_version_create row of the same
-- operation, and no savepoint.
create function training_load.source_metric_mapping_version_copies_audit_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit a
                  where a.action = 'mapping_version_create'
                    and a.mapping_version_id = new.club_version_id
                    and a.operation_id = new.operation_id) then
    raise exception 'source_metric_mapping_version_copies: a link needs its version''s audit row in the same operation' using errcode = '23514';
  end if;
  if (select l.xmin::text::bigint from training_load.source_metric_mapping_version_copies l where l.club_version_id = new.club_version_id)
     is distinct from training_load.source_metric_current_xmin() then
    raise exception 'source_metric_mapping_version_copies: a link is written outside a savepoint' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_mapping_version_copies_audit_link
  after insert on training_load.source_metric_mapping_version_copies
  deferrable initially deferred
  for each row execute function training_load.source_metric_mapping_version_copies_audit_link();

-- ---------------------------------------------------------------------------
-- 5. The club's hide of a system variable (J15 7.3).
-- ---------------------------------------------------------------------------
create table training_load.metric_definition_club_hides (
  id                   uuid primary key default gen_random_uuid(),
  club_id              uuid not null
                         constraint metric_definition_club_hides_club_fk
                         references public.clubs(id) on delete restrict,
  metric_definition_id uuid not null
                         constraint metric_definition_club_hides_definition_fk
                         references training_load.metric_definitions(id) on delete restrict,
  hidden_by_user_id    uuid not null
                         constraint metric_definition_club_hides_hidden_by_fk
                         references public.users(id) on delete restrict,
  hidden_basis         text not null
                         constraint metric_definition_club_hides_hidden_basis_check
                         check (hidden_basis in ('platform_admin', 'club_admin')),
  hide_request_key     uuid not null,
  hide_request_hash    text not null
                         constraint metric_definition_club_hides_hide_hash_check
                         check (hide_request_hash ~ '^[0-9a-f]{64}$'),
  hidden_at            timestamptz not null default now(),
  shown_by_user_id     uuid
                         constraint metric_definition_club_hides_shown_by_fk
                         references public.users(id) on delete restrict,
  shown_basis          text
                         constraint metric_definition_club_hides_shown_basis_check
                         check (shown_basis is null or shown_basis in ('platform_admin', 'club_admin')),
  show_request_key     uuid,
  show_request_hash    text
                         constraint metric_definition_club_hides_show_hash_check
                         check (show_request_hash is null or show_request_hash ~ '^[0-9a-f]{64}$'),
  shown_at             timestamptz,
  constraint metric_definition_club_hides_show_facts check (
    (shown_at is null) = (shown_by_user_id is null)
    and (shown_at is null) = (shown_basis is null)
    and (shown_at is null) = (show_request_key is null)
    and (shown_at is null) = (show_request_hash is null)),
  constraint metric_definition_club_hides_shown_after check (shown_at is null or shown_at >= hidden_at)
);

create unique index metric_definition_club_hides_one_hide_per_key
  on training_load.metric_definition_club_hides (hidden_by_user_id, hide_request_key);

create unique index metric_definition_club_hides_one_show_per_key
  on training_load.metric_definition_club_hides (shown_by_user_id, show_request_key) where shown_at is not null;

create unique index metric_definition_club_hides_one_open
  on training_load.metric_definition_club_hides (club_id, metric_definition_id) where shown_at is null;

comment on table training_load.metric_definition_club_hides is
  'v53 (J15 7.3, C132, C133): a club''s hide of a system variable, open until shown again; the row is the request record of the hide and its show facts the request record of the show; never deleted.';

create function training_load.metric_definition_club_hides_insert_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  basis text;
  def record;
begin
  if new.hidden_by_user_id is distinct from actor then
    raise exception 'metric variable hide: the row names another user than the acting user' using errcode = '42501';
  end if;
  -- The rights rows first (row locks); no row lock after the hide lock.
  basis := training_load.source_metric_actor_basis(actor, new.club_id);
  if basis is null or new.hidden_basis is distinct from basis then
    raise exception 'metric variable hide: the acting user may not hide for this club' using errcode = '42501';
  end if;
  if new.shown_at is not null or new.shown_by_user_id is not null or new.shown_basis is not null
     or new.show_request_key is not null or new.show_request_hash is not null then
    raise exception 'metric_definition_club_hides: a hide is created open' using errcode = '23514';
  end if;
  if new.hidden_at is distinct from now() then
    raise exception 'metric_definition_club_hides: a hide is dated by its own transaction' using errcode = '23514';
  end if;
  -- A plain read: the service holds the definition FOR KEY SHARE from before.
  select owner_scope into def from training_load.metric_definitions where id = new.metric_definition_id;
  if def.owner_scope is distinct from 'system' then
    raise exception 'metric_definition_club_hides: only a system variable is hidden' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('club-variable-hide:' || new.club_id::text || ':' || new.metric_definition_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('club-variable-hide-key:' || actor::text || ':' || new.hide_request_key::text, 0));
  if exists (select 1 from training_load.metric_definition_club_hides h
              where h.shown_by_user_id = actor and h.show_request_key = new.hide_request_key) then
    raise exception 'metric_definition_club_hides: a request key serves one act only' using errcode = '23514';
  end if;
  if exists (select 1
               from training_load.source_metric_mapping_activations a
               join training_load.source_metric_mappings m on m.id = a.mapping_id
              where a.metric_definition_id = new.metric_definition_id
                and a.ended_at is null
                and m.owner_scope = 'system'
                and training_load.source_metric_binding_club(a.source_team_binding_id) = new.club_id) then
    raise exception 'metric_definition_club_hides: the variable is switched on for the club''s teams' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create function training_load.metric_definition_club_hides_update_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  basis text;
begin
  if old.shown_at is not null then
    raise exception 'metric_definition_club_hides: a hide is shown again once' using errcode = '23514';
  end if;
  if new.id is distinct from old.id
     or new.club_id is distinct from old.club_id
     or new.metric_definition_id is distinct from old.metric_definition_id
     or new.hidden_by_user_id is distinct from old.hidden_by_user_id
     or new.hidden_basis is distinct from old.hidden_basis
     or new.hide_request_key is distinct from old.hide_request_key
     or new.hide_request_hash is distinct from old.hide_request_hash
     or new.hidden_at is distinct from old.hidden_at then
    raise exception 'metric_definition_club_hides: only the show facts change' using errcode = '23514';
  end if;
  if new.shown_at is null then
    raise exception 'metric_definition_club_hides: only the show facts change' using errcode = '23514';
  end if;
  if new.shown_by_user_id is distinct from actor then
    raise exception 'metric variable hide: the row names another user than the acting user' using errcode = '42501';
  end if;
  basis := training_load.source_metric_actor_basis(actor, new.club_id);
  if basis is null or new.shown_basis is distinct from basis then
    raise exception 'metric variable hide: the acting user may not hide for this club' using errcode = '42501';
  end if;
  if new.shown_at is distinct from now() then
    raise exception 'metric_definition_club_hides: a show is dated by its own transaction' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('club-variable-hide:' || new.club_id::text || ':' || new.metric_definition_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('club-variable-hide-key:' || actor::text || ':' || new.show_request_key::text, 0));
  if exists (select 1 from training_load.metric_definition_club_hides h
              where h.hidden_by_user_id = actor and h.hide_request_key = new.show_request_key) then
    raise exception 'metric_definition_club_hides: a request key serves one act only' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_definition_club_hides_insert_guard
  before insert on training_load.metric_definition_club_hides
  for each row execute function training_load.metric_definition_club_hides_insert_guard();

create trigger metric_definition_club_hides_update_guard
  before update on training_load.metric_definition_club_hides
  for each row execute function training_load.metric_definition_club_hides_update_guard();

create trigger metric_definition_club_hides_no_delete
  before delete on training_load.metric_definition_club_hides
  for each row execute function training_load.club_variable_rows_append_only();

create trigger metric_definition_club_hides_no_truncate
  before truncate on training_load.metric_definition_club_hides
  for each statement execute function training_load.club_variable_rows_append_only();

-- At COMMIT: a hide or a show is never written inside a savepoint.
create function training_load.metric_definition_club_hides_xact_link() returns trigger as $$
begin
  if (select h.xmin::text::bigint from training_load.metric_definition_club_hides h where h.id = new.id)
     is distinct from training_load.source_metric_current_xmin() then
    raise exception 'metric_definition_club_hides: a hide or a show is written outside a savepoint' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger metric_definition_club_hides_xact_link
  after insert or update on training_load.metric_definition_club_hides
  deferrable initially deferred
  for each row execute function training_load.metric_definition_club_hides_xact_link();

-- ---------------------------------------------------------------------------
-- 6. The variable request record (J15 7.4).
-- ---------------------------------------------------------------------------
alter table training_load.metric_variable_requests
  add column operation_id uuid,
  drop constraint metric_variable_requests_operation_check,
  add constraint metric_variable_requests_operation_check check (operation in (
    'variable_create', 'variable_version_create', 'variable_rename', 'variable_archive', 'variable_restore', 'variable_icon',
    'variable_copy')),
  drop constraint metric_variable_requests_version_iff,
  add constraint metric_variable_requests_version_iff check (
    (metric_definition_version_id is not null) = (operation in ('variable_create', 'variable_version_create', 'variable_copy'))),
  add constraint metric_variable_requests_operation_id_iff check ((operation_id is not null) = (operation = 'variable_copy'));

drop index training_load.metric_variable_requests_one_create_per_definition;
create unique index metric_variable_requests_one_create_per_definition
  on training_load.metric_variable_requests (metric_definition_id) where operation in ('variable_create', 'variable_copy');

create or replace function training_load.metric_variable_requests_insert_guard() returns trigger as $$
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
  select owner_scope, owner_club_id, state, current_version_id, created_by_user_id, xmin::text::bigint as written_in into def
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
  -- v53 (J15 7.4): a copy is checked as a create, and its copy row of the
  -- same operation must be written in this transaction.
  if not found
     or ver.written_in is distinct from here
     or ver.created_by_user_id is distinct from actor
     or def.written_in is distinct from here
     or def.state is distinct from 'active'
     or def.current_version_id is distinct from new.metric_definition_version_id
     or (new.operation in ('variable_create', 'variable_copy') and (ver.version_number <> 1 or def.created_by_user_id is distinct from actor))
     or (new.operation = 'variable_version_create' and ver.version_number <= 1)
     or (new.operation = 'variable_copy' and not exists (
           select 1 from training_load.metric_definition_copies c
            where c.club_definition_id = new.metric_definition_id
              and c.operation_id = new.operation_id
              and c.xmin::text::bigint = here)) then
    raise exception 'metric_variable_requests: the request must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create or replace trigger metric_variable_requests_insert_guard
  before insert on training_load.metric_variable_requests
  for each row
  when (new.operation in ('variable_create', 'variable_version_create', 'variable_copy'))
  execute function training_load.metric_variable_requests_insert_guard();

-- ---------------------------------------------------------------------------
-- 7. T5's insert guard: a club's hide refuses a system mapping's start on the
--    club's bindings (J15 7.5). Every other line is v48's.
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_activations_insert_guard() returns trigger as $$
declare
  ver record;
  def record;
  map record;
  bnd record;
  conn record;
  actor uuid := training_load.source_metric_context_actor();
  club uuid;
  basis text;
begin
  -- v48: the row names the acting user of this transaction (v35's setting).
  if new.activated_by_user_id is distinct from actor then
    raise exception 'source metric activation: the acting user may not write this activation' using errcode = '42501';
  end if;
  if new.ended_at is not null or new.ended_by_user_id is not null or new.ended_basis is not null or new.end_reason is not null then
    raise exception 'source_metric_mapping_activations: an activation is created open' using errcode = '23514';
  end if;
  select status, applies_to_session, applies_to_drill into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id for share;
  if ver.status is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: only an active mapping version is activated' using errcode = '23514';
  end if;
  if new.applies_to_session is distinct from ver.applies_to_session or new.applies_to_drill is distinct from ver.applies_to_drill then
    raise exception 'source_metric_mapping_activations: the levels must be the mapping version''s' using errcode = '23514';
  end if;
  -- C42: an active source field (implied by the active version's chain; a backstop).
  select source_system, api_family, state into def
    from training_load.source_metric_definitions where id = new.source_metric_definition_id;
  if def.state is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: the source metric is retired' using errcode = '23514';
  end if;
  -- The owner comes from T3, never from the caller.
  select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id;
  -- v27 rows, plain reads (an Unbind is never inverted).
  select connection_id, team_id, source_system, state into bnd
    from training_load.source_team_bindings where id = new.source_team_binding_id;
  if bnd.state is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: the team binding is not active' using errcode = '23514';
  end if;
  if bnd.source_system is distinct from def.source_system then
    raise exception 'source_metric_mapping_activations: the binding''s source is not the source metric''s' using errcode = '23514';
  end if;
  select c.owner_scope, c.owner_club_id, c.owner_team_id, h.api_family into conn
    from training_load.source_credential_connections c
    join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
   where c.id = bnd.connection_id;
  if conn.api_family is distinct from def.api_family then
    raise exception 'source_metric_mapping_activations: the API family of the binding''s host is not the source metric''s' using errcode = '23514';
  end if;
  -- v48 (C106): the binding's club is its connection's owner club
  -- (source_metric_binding_club); a connection that is not club-owned takes no
  -- activation until its rule is decided (so the team-owned branch below is
  -- never reached).
  club := training_load.source_metric_binding_club(new.source_team_binding_id);
  if club is null then
    raise exception 'source_metric_mapping_activations: the binding''s connection is not owned by a club' using errcode = '23514';
  end if;
  if map.owner_scope = 'club' then
    -- C35: a club mapping only on a connection owned by that club; never on a team-owned one.
    if conn.owner_scope is distinct from 'club' or conn.owner_club_id is distinct from map.owner_club_id then
      raise exception 'source_metric_mapping_activations: a club mapping is activated only on a binding of a connection owned by that club' using errcode = '23514';
    end if;
  elsif conn.owner_scope = 'team' and conn.owner_team_id is distinct from bnd.team_id then
    raise exception 'source_metric_mapping_activations: a team-owned connection hosts a system mapping only for its own team' using errcode = '23514';
  end if;
  -- v48 (C106): the basis the database derives for the binding's club -
  -- platform_admin for an active platform admin, club_admin for that club's
  -- active admin, both only while the club is active (replaces v34's
  -- source_metric_require_platform_admin).
  basis := training_load.source_metric_actor_basis(actor, club);
  if basis is null or new.activated_basis is distinct from basis then
    raise exception 'source metric activation: the acting user may not write this activation' using errcode = '42501';
  end if;
  -- v53 (J15 7.5, C132): a system mapping is not switched on for a club that
  -- hides its variable, whoever starts it. The hide lock comes after every
  -- row lock above (D's order), and the hide row is read after it.
  if map.owner_scope = 'system' then
    perform pg_advisory_xact_lock(hashtextextended('club-variable-hide:' || club::text || ':' || new.metric_definition_id::text, 0));
    if exists (select 1 from training_load.metric_definition_club_hides h
                where h.club_id = club and h.metric_definition_id = new.metric_definition_id and h.shown_at is null) then
      raise exception 'source_metric_mapping_activations: the variable is hidden in the binding''s club' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
