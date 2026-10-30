-- Rollback of migration v46 (icons of canonical domains and categories; V4,
-- PR-1c):
-- migrations_v2/202610301300_training_load_v46_classification_icons.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/classification-icons-1c.test.mjs: apply -> rollback
-- -> the catalog before v46, comments included, exactly -> re-apply, and every
-- refusal below). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v46 migration file
-- (otherwise the migrator applies v46 again at the next start) nor the icon
-- routes that write it; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v46 adds an icon column to each node table and two to the change record,
-- widens four checks under their v41 names, replaces three v41 functions (with
-- comments) and redefines two v41 triggers; it changes no row. This script
-- restores v41's exact definitions (the functions byte for byte, without a
-- comment), drops the four columns and removes the v46 record. It refuses,
-- changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v46 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * any domain or category has an icon, or any change row carries an icon
--     value, or any request is a domain_icon or a category_icon - they are the
--     only record of an icon and of who set it; once one exists the way
--     forward is a new migration, never this script;
--   * a v46 column is missing, or a v46 trigger is disabled.
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f classification-icons-v46-rollback.sql
-- (the script carries its own BEGIN and COMMIT). It takes v46's locks in v46's
-- order (ACCESS EXCLUSIVE on the two records, then the two node tables); waits
-- are bounded: a transaction that holds one of the four tables makes this
-- script fail after 5 s.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v46 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') then
    raise exception 'v46 rollback refused: v46 is not recorded on this database';
  end if;
end $$;

lock table training_load.metric_classification_requests, training_load.metric_classification_changes,
  training_load.metric_domains, training_load.metric_categories
  in access exclusive mode;

do $$
declare
  v46 constant text := 'migrations_v2/202610301300_training_load_v46_classification_icons.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v46) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'training_load'
         and ((table_name in ('metric_domains', 'metric_categories') and column_name = 'icon_url')
              or (table_name = 'metric_classification_changes' and column_name in ('old_icon_url', 'new_icon_url')))) <> 4 then
    reasons := array_append(reasons, 'a v46 column is missing');
  elsif exists (select 1 from training_load.metric_domains where icon_url is not null)
     or exists (select 1 from training_load.metric_categories where icon_url is not null)
     or exists (select 1 from training_load.metric_classification_changes
                 where kind = 'icon' or old_icon_url is not null or new_icon_url is not null)
     or exists (select 1 from training_load.metric_classification_requests where operation in ('domain_icon', 'category_icon')) then
    reasons := array_append(reasons, 'an icon is set or recorded');
  end if;
  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'training_load'
                and t.tgname in ('metric_domains_v41_record_change', 'metric_categories_v41_record_change',
                                 'metric_domains_v41_guard', 'metric_categories_v41_guard', 'metric_classification_requests_guard')
                and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a v46 trigger is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v46 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- The request record: v41's operations and its guard.
alter table training_load.metric_classification_requests
  drop constraint metric_classification_requests_operation_check,
  add constraint metric_classification_requests_operation_check check (operation in (
      'domain_create', 'domain_rename', 'domain_archive', 'domain_restore',
      'category_create', 'category_rename', 'category_archive', 'category_restore',
      'link_create', 'link_remove'));

create or replace function training_load.metric_classification_requests_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  this_xact xid8 := pg_current_xact_id();
  chg record;
  node record;
  derived text;
  expected_object text;
  expected_kind text;
begin
  if new.requested_by_user_id is distinct from actor then
    raise exception 'metric classification request: the row names another user than the acting user' using errcode = '42501';
  end if;
  derived := training_load.source_metric_actor_basis(actor, new.owner_club_id);
  if derived is null then
    raise exception 'metric classification request: the acting user may not write this owner scope' using errcode = '42501';
  end if;
  if new.basis is distinct from derived then
    raise exception 'metric classification request: the basis is not the acting user''s own' using errcode = '42501';
  end if;
  expected_object := split_part(new.operation, '_', 1);
  expected_kind := case new.operation
    when 'link_create' then 'link' when 'link_remove' then 'remove' else split_part(new.operation, '_', 2) end;
  select id, object_kind, kind, domain_id, category_id, metric_definition_id, link_id, owner_scope, owner_club_id,
         new_name, new_description, new_active, changed_by_user_id, xact_id, xmin::text::bigint as written_in into chg
    from training_load.metric_classification_changes where id = new.metric_classification_change_id;
  if not found
     or chg.xact_id is distinct from this_xact
     or chg.written_in is distinct from here
     or chg.changed_by_user_id is distinct from actor
     or chg.owner_scope is distinct from new.owner_scope
     or chg.owner_club_id is distinct from new.owner_club_id
     or chg.object_kind is distinct from expected_object
     or chg.kind is distinct from expected_kind then
    raise exception 'metric_classification_requests: the request must follow its own change in the same transaction' using errcode = '23514';
  end if;
  if chg.object_kind = 'link' then
    if (select count(*) from training_load.metric_classification_changes where link_id = chg.link_id and xact_id = this_xact) <> 1
       or (chg.kind = 'link' and not exists (select 1 from training_load.metric_structure_links
                                              where id = chg.link_id and xmin::text::bigint = here))
       or (chg.kind = 'remove' and exists (select 1 from training_load.metric_structure_links where id = chg.link_id)) then
      raise exception 'metric_classification_requests: the request must follow its own change in the same transaction' using errcode = '23514';
    end if;
    return new;
  end if;
  if chg.object_kind = 'domain' then
    select name, description, is_active, xmin::text::bigint as written_in into node
      from training_load.metric_domains where id = chg.domain_id;
    if (select count(*) from training_load.metric_classification_changes where domain_id = chg.domain_id and object_kind = 'domain'
         and xact_id = this_xact) <> 1 then
      raise exception 'metric_classification_requests: the request must follow its own change in the same transaction' using errcode = '23514';
    end if;
  else
    select name, description, is_active, xmin::text::bigint as written_in into node
      from training_load.metric_categories where id = chg.category_id;
    if (select count(*) from training_load.metric_classification_changes where category_id = chg.category_id and object_kind = 'category'
         and xact_id = this_xact) <> 1 then
      raise exception 'metric_classification_requests: the request must follow its own change in the same transaction' using errcode = '23514';
    end if;
  end if;
  if not found
     or node.written_in is distinct from here
     or node.name is distinct from chg.new_name
     or node.description is distinct from chg.new_description
     or node.is_active is distinct from chg.new_active then
    raise exception 'metric_classification_requests: the request must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.metric_classification_requests_guard() is null;

-- The writer, its two update triggers and the node guard, as v41 wrote them.
create or replace function training_load.metric_classification_record_node_change() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  is_domain boolean := tg_table_name = 'metric_domains';
begin
  if tg_op = 'INSERT' then
    insert into training_load.metric_classification_changes
      (object_kind, kind, domain_id, category_id, owner_scope, owner_club_id, new_name, new_description, new_active,
       changed_by_user_id, xact_id)
    values
      (case when is_domain then 'domain' else 'category' end, 'create',
       case when is_domain then new.id end, case when is_domain then null else new.id end,
       new.owner_scope, new.owner_club_id, new.name, new.description, new.is_active, actor, pg_current_xact_id());
  else
    insert into training_load.metric_classification_changes
      (object_kind, kind, domain_id, category_id, owner_scope, owner_club_id, old_name, new_name, old_description,
       new_description, old_active, new_active, changed_by_user_id, xact_id)
    values
      (case when is_domain then 'domain' else 'category' end,
       case when old.is_active = new.is_active then 'rename' when new.is_active then 'restore' else 'archive' end,
       case when is_domain then new.id end, case when is_domain then null else new.id end,
       new.owner_scope, new.owner_club_id, old.name, new.name, old.description, new.description, old.is_active,
       new.is_active, actor, pg_current_xact_id());
  end if;
  return null;
end;
$$ language plpgsql;

create or replace trigger metric_domains_v41_record_change
  after update of name, description, is_active on training_load.metric_domains
  for each row
  when (new.owner_scope::text in ('system', 'club')
        and (old.name is distinct from new.name or old.description is distinct from new.description
             or old.is_active is distinct from new.is_active))
  execute function training_load.metric_classification_record_node_change();
create or replace trigger metric_categories_v41_record_change
  after update of name, description, is_active on training_load.metric_categories
  for each row
  when (new.owner_scope::text in ('system', 'club')
        and (old.name is distinct from new.name or old.description is distinct from new.description
             or old.is_active is distinct from new.is_active))
  execute function training_load.metric_classification_record_node_change();
comment on function training_load.metric_classification_record_node_change() is null;

create or replace function training_load.metric_classification_node_guard() returns trigger as $$
declare
  actor uuid;
  basis text;
begin
  if tg_op = 'DELETE' then
    if old.owner_scope in ('system', 'club') then
      raise exception 'metric classification: a canonical domain or category is archived, never deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.owner_scope not in ('system', 'club') then
      return new;
    end if;
    actor := training_load.source_metric_context_actor();
    if new.created_by_user_id is distinct from actor then
      raise exception 'metric classification: the row names another user than the acting user' using errcode = '42501';
    end if;
    basis := training_load.source_metric_actor_basis(actor, new.owner_club_id);
    if basis is null then
      raise exception 'metric classification: the acting user may not write this owner scope' using errcode = '42501';
    end if;
    if new.is_active is distinct from true or new.key is null then
      raise exception 'metric classification: a canonical domain or category is created active, with its key' using errcode = '23514';
    end if;
    if not training_load.source_metric_text_ok(new.name, 80)
       or (new.description is not null and not training_load.source_metric_text_ok(new.description, 500)) then
      raise exception 'metric classification: a name or description is not bounded text' using errcode = '23514';
    end if;
    return new;
  end if;
  -- UPDATE
  if old.owner_scope not in ('system', 'club') and new.owner_scope not in ('system', 'club') then
    return new;
  end if;
  actor := training_load.source_metric_context_actor();
  basis := training_load.source_metric_actor_basis(actor, old.owner_club_id);
  if basis is null then
    raise exception 'metric classification: the acting user may not write this owner scope' using errcode = '42501';
  end if;
  if new.id is distinct from old.id
     or new.owner_scope is distinct from old.owner_scope
     or new.owner_user_id is distinct from old.owner_user_id
     or new.owner_club_id is distinct from old.owner_club_id
     or new.owner_team_id is distinct from old.owner_team_id
     or new.key is distinct from old.key
     or new.created_by_user_id is distinct from old.created_by_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'metric classification: only the name, the description and the state of a canonical domain or category change' using errcode = '23514';
  end if;
  if new.is_active is distinct from old.is_active then
    if new.name is distinct from old.name or new.description is distinct from old.description then
      raise exception 'metric classification: a rename, an archive and a restore are separate changes' using errcode = '23514';
    end if;
  elsif new.name is not distinct from old.name and new.description is not distinct from old.description then
    raise exception 'metric classification: the change changes nothing' using errcode = '23514';
  else
    if old.is_active is distinct from true then
      raise exception 'metric classification: an archived domain or category is restored before it is renamed' using errcode = '23514';
    end if;
    -- A value the rename leaves as it was is exempt (the v38 pattern).
    if (new.name is distinct from old.name and not training_load.source_metric_text_ok(new.name, 80))
       or (new.description is distinct from old.description and new.description is not null
           and not training_load.source_metric_text_ok(new.description, 500)) then
      raise exception 'metric classification: a name or description is not bounded text' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.metric_classification_node_guard() is null;

-- The change record: v41's checks; its two icon columns go.
alter table training_load.metric_classification_changes
  drop constraint metric_classification_changes_kind_check,
  add constraint metric_classification_changes_kind_check check (kind in ('create', 'rename', 'archive', 'restore', 'link', 'remove')),
  drop constraint metric_classification_changes_shape,
  add constraint metric_classification_changes_shape check (
    (object_kind = 'domain' and domain_id is not null and category_id is null and metric_definition_id is null and link_id is null
       and kind in ('create', 'rename', 'archive', 'restore'))
    or (object_kind = 'category' and category_id is not null and domain_id is null and metric_definition_id is null and link_id is null
       and kind in ('create', 'rename', 'archive', 'restore'))
    or (object_kind = 'link' and link_id is not null and kind in ('link', 'remove')
       and num_nonnulls(domain_id, category_id, metric_definition_id) = 2
       and old_name is null and new_name is null and old_description is null and new_description is null
       and old_active is null and new_active is null)
  ),
  drop constraint metric_classification_changes_kind_shape,
  add constraint metric_classification_changes_kind_shape check (
    object_kind = 'link'
    or (kind = 'create' and old_name is null and new_name is not null and old_active is null and new_active = true)
    or (kind = 'rename' and old_name is not null and new_name is not null and old_active = true and new_active = true)
    or (kind = 'archive' and old_active = true and new_active = false
        and old_name is not distinct from new_name and old_description is not distinct from new_description)
    or (kind = 'restore' and old_active = false and new_active = true
        and old_name is not distinct from new_name and old_description is not distinct from new_description)
  ),
  drop column old_icon_url,
  drop column new_icon_url;

-- The two node tables' icon columns (and with them their checks).
alter table training_load.metric_domains drop column icon_url;
alter table training_load.metric_categories drop column icon_url;

delete from public.schema_migrations where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql';

commit;
