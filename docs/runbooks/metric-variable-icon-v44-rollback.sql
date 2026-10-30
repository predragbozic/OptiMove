-- Rollback of migration v44 (changing the icon of a canonical variable; I1,
-- PR-1b):
-- migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/metric-variable-icon-1b.test.mjs: apply -> rollback
-- -> the v43 catalog, comments included, exactly -> re-apply, and every
-- refusal below). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v44 migration file
-- (otherwise the migrator applies v44 again at the next start) nor the icon
-- route that writes it; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v44 adds two columns of training_load.metric_variable_changes, widens five
-- checks under their v38 names, replaces two v38 functions (with comments)
-- and redefines two v38 triggers; it changes no row. This script restores v38's
-- exact definitions (the functions byte for byte, without a comment), drops the
-- two columns and removes the v44 record. It refuses, changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v44 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * any change row of the kind 'icon' or any request of the operation
--     'variable_icon' exists - they are the only record of an icon change; once
--     one exists the way forward is a new migration, never this script;
--   * a v44 column is missing, or a v44 trigger is disabled.
-- The icon values of the rename, archive and restore rows written while v44
-- was applied are dropped with the columns: they only repeat the icon those
-- rows kept.
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f metric-variable-icon-v44-rollback.sql
-- (the script carries its own BEGIN and COMMIT). It takes v44's locks in v44's
-- order (metric_definitions in SHARE ROW EXCLUSIVE, so reads go on; the two
-- record tables in ACCESS EXCLUSIVE); waits are bounded: a transaction that
-- holds one of the three tables makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v44 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql') then
    raise exception 'v44 rollback refused: v44 is not recorded on this database';
  end if;
end $$;

-- The three tables' locks before the checks, in a change's own order and in
-- the modes the redefinitions need, so no lock is upgraded later: no
-- definition is written, and no change or request row read or written, until
-- the COMMIT.
lock table training_load.metric_definitions in share row exclusive mode;
lock table training_load.metric_variable_changes, training_load.metric_variable_requests in access exclusive mode;

do $$
declare
  v44 constant text := 'migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v44) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'training_load' and table_name = 'metric_variable_changes'
         and column_name in ('old_icon_url', 'new_icon_url')) <> 2 then
    reasons := array_append(reasons, 'a v44 column is missing');
  elsif exists (select 1 from training_load.metric_variable_changes where kind = 'icon')
     or exists (select 1 from training_load.metric_variable_requests where operation = 'variable_icon') then
    reasons := array_append(reasons, 'an icon change is recorded');
  end if;
  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'training_load'
                and t.tgname in ('metric_definitions_v38_record_change', 'metric_variable_requests_change_guard')
                and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a v44 trigger is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v44 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- The request record: v38's three checks and its guard.
alter table training_load.metric_variable_requests
  drop constraint metric_variable_requests_operation_check,
  add constraint metric_variable_requests_operation_check check (operation in (
    'variable_create', 'variable_version_create', 'variable_rename', 'variable_archive', 'variable_restore')),
  drop constraint metric_variable_requests_change_iff,
  add constraint metric_variable_requests_change_iff check (
    (metric_variable_change_id is not null) = (operation in ('variable_rename', 'variable_archive', 'variable_restore'))),
  drop constraint metric_variable_requests_team_coach_shape,
  add constraint metric_variable_requests_team_coach_shape check (
    basis <> 'team_coach' or (owner_scope = 'club' and operation in ('variable_rename', 'variable_archive', 'variable_restore')));

create or replace function training_load.metric_variable_requests_change_guard() returns trigger as $$
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

create or replace trigger metric_variable_requests_change_guard
  before insert on training_load.metric_variable_requests
  for each row
  when (new.operation in ('variable_rename', 'variable_archive', 'variable_restore'))
  execute function training_load.metric_variable_requests_change_guard();
comment on function training_load.metric_variable_requests_change_guard() is null;

-- The writer and its trigger, as v38 wrote them.
create or replace function training_load.metric_definitions_record_change() returns trigger as $$
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

create or replace trigger metric_definitions_v38_record_change
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
comment on function training_load.metric_definitions_record_change() is null;

-- The change record: v38's two checks; the two icon columns go.
alter table training_load.metric_variable_changes
  drop constraint metric_variable_changes_kind_check,
  add constraint metric_variable_changes_kind_check check (kind in ('rename', 'archive', 'restore')),
  drop constraint metric_variable_changes_kind_shape,
  add constraint metric_variable_changes_kind_shape check (
    (kind = 'rename' and old_state = 'active' and new_state = 'active')
    or (kind = 'archive' and old_state = 'active' and new_state = 'archived')
    or (kind = 'restore' and old_state = 'archived' and new_state = 'active')
  ),
  drop column old_icon_url,
  drop column new_icon_url;

delete from public.schema_migrations where migration_name = 'migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql';

commit;
