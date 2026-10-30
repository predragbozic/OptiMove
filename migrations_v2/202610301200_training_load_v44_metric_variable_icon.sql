-- v44: changing the icon of a canonical variable (I1, PR-1b).
--
-- Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, section
-- J3b.11 (the Rukovodilac's order and decisions of 2026-10-30, after the
-- owner's words quoted there). A variable's icon is
-- metric_definitions.icon_url (v10); M3-0's create stores `icon:<key>`.
-- Before v44 an UPDATE of icon_url alone fired no v38 trigger: an unaudited
-- write (C76). v44 makes an icon change a fourth kind of v38's audited
-- change, written by the same trigger and followed by its own request row, as
-- a rename is:
--
--   * metric_variable_changes gains old_icon_url and new_icon_url (the rows
--     before v44 keep null) and the kind 'icon': the state stays 'active', the
--     label, short label and description stay, the icon changes, and its new
--     value is null or `icon:` and a key's shape. A rename, an archive and a
--     restore keep the icon, so one UPDATE cannot rename and change the icon
--     at once (23514).
--   * metric_definitions_v38_record_change fires on icon_url too, and
--     metric_definitions_record_change() writes the two icon values and takes
--     the kind 'icon' when only the icon changed. Its name stays v38's (the
--     trigger order on metric_definitions is by name).
--   * metric_variable_requests gains the operation 'variable_icon' (with a
--     change row, the team_coach basis allowed for a club variable, no reason)
--     and metric_variable_requests_change_guard() pairs it with the kind
--     'icon' and compares the definition's icon with the change's new value.
--     A coach may change the icon of a variable an active mapping version
--     pins: an icon is display only and does not change what the variable
--     means (the Rukovodilac's Q2); decision 9 (v34) is untouched.
--
-- No table, no index, no row is added or changed; the two functions are
-- replaced, the two triggers redefined in place and five checks widened (their
-- v38 names kept). Rollback: docs/runbooks/metric-variable-icon-v44-rollback.sql
-- (it refuses once any icon change or request exists). Fixed messages: no id,
-- name, value or SQL.
--
-- Locks: the three tables first, in the order a change takes them (the
-- definition, then its change row, then its request row), so v44 never waits
-- for a writer that waits for it; the runner's lock_timeout bounds each wait.
-- metric_definitions is held in SHARE ROW EXCLUSIVE (its trigger is replaced
-- with CREATE OR REPLACE TRIGGER), so reads of the variables go on; the two
-- record tables in ACCESS EXCLUSIVE (their columns and checks).
-- A future migration that changes the icon of a system or club definition
-- disables metric_definitions_v38_record_change inside itself, as for a label
-- (v38's note).

-- ---------------------------------------------------------------------------
-- 0. The locks, in a change's own order.
-- ---------------------------------------------------------------------------
lock table training_load.metric_definitions in share row exclusive mode;
lock table training_load.metric_variable_changes, training_load.metric_variable_requests in access exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. The change record: the icon's old and new value, the kind 'icon'.
-- ---------------------------------------------------------------------------
alter table training_load.metric_variable_changes
  add column old_icon_url text,
  add column new_icon_url text,
  drop constraint metric_variable_changes_kind_check,
  add constraint metric_variable_changes_kind_check check (kind in ('rename', 'archive', 'restore', 'icon')),
  drop constraint metric_variable_changes_kind_shape,
  add constraint metric_variable_changes_kind_shape check (
    (kind = 'rename' and old_state = 'active' and new_state = 'active' and old_icon_url is not distinct from new_icon_url)
    or (kind = 'archive' and old_state = 'active' and new_state = 'archived' and old_icon_url is not distinct from new_icon_url)
    or (kind = 'restore' and old_state = 'archived' and new_state = 'active' and old_icon_url is not distinct from new_icon_url)
    or (kind = 'icon' and old_state = 'active' and new_state = 'active'
        and old_label = new_label and old_short_label is not distinct from new_short_label
        and old_description is not distinct from new_description
        and old_icon_url is distinct from new_icon_url
        and (new_icon_url is null or new_icon_url ~ '^icon:[a-z0-9]+(-[a-z0-9]+)*$'))
  );

-- ---------------------------------------------------------------------------
-- 2. The writer: the icon's two values, and the kind 'icon' when only the icon
--    changed (a state change is an archive or a restore, as in v38).
-- ---------------------------------------------------------------------------
create or replace function training_load.metric_definitions_record_change() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
begin
  insert into training_load.metric_variable_changes
    (metric_definition_id, owner_scope, owner_club_id, kind, old_label, new_label, old_short_label, new_short_label,
     old_description, new_description, old_state, new_state, old_icon_url, new_icon_url, changed_by_user_id, xact_id)
  values
    (new.id, new.owner_scope, new.owner_club_id,
     case when old.state is distinct from new.state then case when new.state = 'archived' then 'archive' else 'restore' end
          when old.label is not distinct from new.label and old.short_label is not distinct from new.short_label
               and old.description is not distinct from new.description then 'icon'
          else 'rename' end,
     old.label, new.label, old.short_label, new.short_label, old.description, new.description, old.state, new.state,
     old.icon_url, new.icon_url, actor, pg_current_xact_id());
  return null;
end;
$$ language plpgsql;

create or replace trigger metric_definitions_v38_record_change
  after update of label, short_label, description, state, icon_url on training_load.metric_definitions
  for each row
  -- As v38: plain comparisons, so a dump and restore reads it back the same.
  when ((old.owner_scope::text in ('system', 'club') or new.owner_scope::text in ('system', 'club'))
        and (old.label is distinct from new.label or old.short_label is distinct from new.short_label
             or old.description is distinct from new.description or old.state is distinct from new.state
             or old.icon_url is distinct from new.icon_url))
  execute function training_load.metric_definitions_record_change();

-- ---------------------------------------------------------------------------
-- 3. The request record: the operation 'variable_icon' (v38's names kept).
-- ---------------------------------------------------------------------------
alter table training_load.metric_variable_requests
  drop constraint metric_variable_requests_operation_check,
  add constraint metric_variable_requests_operation_check check (operation in (
    'variable_create', 'variable_version_create', 'variable_rename', 'variable_archive', 'variable_restore', 'variable_icon')),
  drop constraint metric_variable_requests_change_iff,
  add constraint metric_variable_requests_change_iff check (
    (metric_variable_change_id is not null)
      = (operation in ('variable_rename', 'variable_archive', 'variable_restore', 'variable_icon'))),
  drop constraint metric_variable_requests_team_coach_shape,
  add constraint metric_variable_requests_team_coach_shape check (
    basis <> 'team_coach'
    or (owner_scope = 'club' and operation in ('variable_rename', 'variable_archive', 'variable_restore', 'variable_icon')));

-- ---------------------------------------------------------------------------
-- 4. The R2 request guard: 'variable_icon' pairs with the kind 'icon', every
--    other kind keeps the icon, and the definition's icon is the change's new
--    one. A coach's icon change is not refused for a pinned variable.
-- ---------------------------------------------------------------------------
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
  select owner_scope, owner_club_id, label, short_label, description, state, icon_url, current_version_id,
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
         old_description, new_description, old_state, new_state, old_icon_url, new_icon_url, changed_by_user_id, xact_id,
         xmin::text::bigint as written_in into chg
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
     or (def.label, def.short_label, def.description, def.state, def.icon_url)
        is distinct from (chg.new_label, chg.new_short_label, chg.new_description, chg.new_state, chg.new_icon_url) then
    raise exception 'metric_variable_requests: the request must follow its own change in the same transaction' using errcode = '23514';
  end if;
  if (new.operation = 'variable_rename' and chg.kind is distinct from 'rename')
     or (new.operation = 'variable_archive' and chg.kind is distinct from 'archive')
     or (new.operation = 'variable_restore' and chg.kind is distinct from 'restore')
     or (new.operation = 'variable_icon' and chg.kind is distinct from 'icon')
     or (chg.kind <> 'icon' and chg.old_icon_url is distinct from chg.new_icon_url)
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
  when (new.operation in ('variable_rename', 'variable_archive', 'variable_restore', 'variable_icon'))
  execute function training_load.metric_variable_requests_change_guard();

comment on function training_load.metric_definitions_record_change() is
  'v44 (J3b.11): records a rename, an archive, a restore or an icon change of a system or club variable, with the icon''s old and new value.';
comment on function training_load.metric_variable_requests_change_guard() is
  'v44 (J3b.11): the R2 request guard of v38, with the operation variable_icon paired with the kind icon and the icon compared.';
