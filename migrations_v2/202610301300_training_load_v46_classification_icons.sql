-- v46: icons of canonical domains and categories (V4, PR-1c).
--
-- Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, section J6.1
-- (C105: the owner decided V4 now; the Rukovodilac's order and decisions of
-- 2026-10-30). A domain or category had no icon (v10, v41). v46 gives each one,
-- set at create or changed later through its own audited change - the fourth
-- kind of a node's change in v41's record, as v45 does for a variable:
--
--   * metric_domains.icon_url and metric_categories.icon_url: null or `icon:`
--     and a key's shape (the library's membership is the service's check).
--   * metric_classification_changes gains old_icon_url and new_icon_url (the
--     rows before v46 keep null) and the kind 'icon' for a domain or a
--     category: the node is active before and after, its name and description
--     are kept, the icon changes. A create may carry its icon; a rename, an
--     archive and a restore keep it; a link's row has none.
--   * metric_classification_node_guard() lets an icon change alone of an
--     active node through, and refuses an icon changed together with the name,
--     the description or the state, or on an archived node (restore first).
--     v41's other rules and messages are unchanged.
--   * metric_classification_record_node_change() writes the two icon values and
--     takes the kind 'icon'; the two AFTER UPDATE triggers fire on icon_url too.
--   * metric_classification_requests gains the operations domain_icon and
--     category_icon (the guard's split takes 'icon' as their kind), and
--     metric_classification_requests_guard() compares the node's icon with the
--     change's new value, as the name, description and state.
--
-- So an icon of a system or club domain or category is written only by its
-- acting user (v35) with its change row and its request row, in one
-- transaction; a raw UPDATE of icon_url without them is refused (42501, or
-- 23514 at COMMIT). No row is changed. Rollback:
-- docs/runbooks/classification-icons-v46-rollback.sql (it refuses while any
-- icon is set or recorded). Fixed messages: no id, name, value or SQL.
--
-- Locks: the four tables first, in the order a write takes them - the request
-- and change records (a write and a replay read them first, joined, in
-- runWrite), then the node tables - so a write or a replay in flight never waits
-- for v46 while v46 waits for it; ACCESS EXCLUSIVE (new columns and checks);
-- the runner's lock_timeout bounds each wait. A read of the classification
-- takes the domains before the categories, as v46 does, except a variable's
-- classification (C6), which joins the categories first: met at a deploy, one
-- of the two ends with 40P01 and nothing written (the runbook). A future
-- migration that sets the icon of a system or club node disables the record
-- triggers inside itself, as for a name.

-- ---------------------------------------------------------------------------
-- 0. The locks, in a write's own order.
-- ---------------------------------------------------------------------------
lock table training_load.metric_classification_requests, training_load.metric_classification_changes,
  training_load.metric_domains, training_load.metric_categories
  in access exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. The icon of a domain and of a category.
-- ---------------------------------------------------------------------------
alter table training_load.metric_domains
  add column icon_url text,
  add constraint metric_domains_icon_rule check (icon_url is null or (icon_url ~ '^icon:[a-z0-9]+(-[a-z0-9]+)*$' and char_length(icon_url) <= 69));

alter table training_load.metric_categories
  add column icon_url text,
  add constraint metric_categories_icon_rule check (icon_url is null or (icon_url ~ '^icon:[a-z0-9]+(-[a-z0-9]+)*$' and char_length(icon_url) <= 69));

-- ---------------------------------------------------------------------------
-- 2. The change record: the icon's old and new value, the kind 'icon'.
-- ---------------------------------------------------------------------------
alter table training_load.metric_classification_changes
  add column old_icon_url text,
  add column new_icon_url text,
  drop constraint metric_classification_changes_kind_check,
  add constraint metric_classification_changes_kind_check check (kind in ('create', 'rename', 'archive', 'restore', 'link', 'remove', 'icon')),
  drop constraint metric_classification_changes_shape,
  add constraint metric_classification_changes_shape check (
    (object_kind = 'domain' and domain_id is not null and category_id is null and metric_definition_id is null and link_id is null
       and kind in ('create', 'rename', 'archive', 'restore', 'icon'))
    or (object_kind = 'category' and category_id is not null and domain_id is null and metric_definition_id is null and link_id is null
       and kind in ('create', 'rename', 'archive', 'restore', 'icon'))
    or (object_kind = 'link' and link_id is not null and kind in ('link', 'remove')
       and num_nonnulls(domain_id, category_id, metric_definition_id) = 2
       and old_name is null and new_name is null and old_description is null and new_description is null
       and old_active is null and new_active is null and old_icon_url is null and new_icon_url is null)
  ),
  drop constraint metric_classification_changes_kind_shape,
  add constraint metric_classification_changes_kind_shape check (
    object_kind = 'link'
    or (kind = 'create' and old_name is null and new_name is not null and old_active is null and new_active = true
        and old_icon_url is null and (new_icon_url is null or (new_icon_url ~ '^icon:[a-z0-9]+(-[a-z0-9]+)*$' and char_length(new_icon_url) <= 69)))
    or (kind = 'rename' and old_name is not null and new_name is not null and old_active = true and new_active = true
        and old_icon_url is not distinct from new_icon_url)
    or (kind = 'archive' and old_active = true and new_active = false
        and old_name is not distinct from new_name and old_description is not distinct from new_description
        and old_icon_url is not distinct from new_icon_url)
    or (kind = 'restore' and old_active = false and new_active = true
        and old_name is not distinct from new_name and old_description is not distinct from new_description
        and old_icon_url is not distinct from new_icon_url)
    or (kind = 'icon' and old_name is not null and old_active = true and new_active = true
        and old_name is not distinct from new_name and old_description is not distinct from new_description
        and old_icon_url is distinct from new_icon_url
        and (new_icon_url is null or (new_icon_url ~ '^icon:[a-z0-9]+(-[a-z0-9]+)*$' and char_length(new_icon_url) <= 69)))
  );

-- ---------------------------------------------------------------------------
-- 3. The node guard: an icon change alone, of an active node.
-- ---------------------------------------------------------------------------
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
    if new.icon_url is distinct from old.icon_url then
      raise exception 'metric classification: an icon change is a change of its own' using errcode = '23514';
    end if;
  elsif new.icon_url is distinct from old.icon_url then
    -- v46: an icon change alone, of an active node.
    if new.name is distinct from old.name or new.description is distinct from old.description then
      raise exception 'metric classification: an icon change is a change of its own' using errcode = '23514';
    end if;
    if old.is_active is distinct from true then
      raise exception 'metric classification: an archived domain or category is restored before its icon changes' using errcode = '23514';
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

-- ---------------------------------------------------------------------------
-- 4. The writer and its two update triggers (v41's names kept).
-- ---------------------------------------------------------------------------
create or replace function training_load.metric_classification_record_node_change() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  is_domain boolean := tg_table_name = 'metric_domains';
begin
  if tg_op = 'INSERT' then
    insert into training_load.metric_classification_changes
      (object_kind, kind, domain_id, category_id, owner_scope, owner_club_id, new_name, new_description, new_active,
       new_icon_url, changed_by_user_id, xact_id)
    values
      (case when is_domain then 'domain' else 'category' end, 'create',
       case when is_domain then new.id end, case when is_domain then null else new.id end,
       new.owner_scope, new.owner_club_id, new.name, new.description, new.is_active, new.icon_url, actor, pg_current_xact_id());
  else
    insert into training_load.metric_classification_changes
      (object_kind, kind, domain_id, category_id, owner_scope, owner_club_id, old_name, new_name, old_description,
       new_description, old_active, new_active, old_icon_url, new_icon_url, changed_by_user_id, xact_id)
    values
      (case when is_domain then 'domain' else 'category' end,
       case when old.is_active = new.is_active then case when old.icon_url is distinct from new.icon_url then 'icon' else 'rename' end
            when new.is_active then 'restore' else 'archive' end,
       case when is_domain then new.id end, case when is_domain then null else new.id end,
       new.owner_scope, new.owner_club_id, old.name, new.name, old.description, new.description, old.is_active,
       new.is_active, old.icon_url, new.icon_url, actor, pg_current_xact_id());
  end if;
  return null;
end;
$$ language plpgsql;

create or replace trigger metric_domains_v41_record_change
  after update of name, description, is_active, icon_url on training_load.metric_domains
  for each row
  when (new.owner_scope::text in ('system', 'club')
        and (old.name is distinct from new.name or old.description is distinct from new.description
             or old.is_active is distinct from new.is_active or old.icon_url is distinct from new.icon_url))
  execute function training_load.metric_classification_record_node_change();
create or replace trigger metric_categories_v41_record_change
  after update of name, description, is_active, icon_url on training_load.metric_categories
  for each row
  when (new.owner_scope::text in ('system', 'club')
        and (old.name is distinct from new.name or old.description is distinct from new.description
             or old.is_active is distinct from new.is_active or old.icon_url is distinct from new.icon_url))
  execute function training_load.metric_classification_record_node_change();

-- ---------------------------------------------------------------------------
-- 5. The request record: domain_icon and category_icon (v41's names kept).
-- ---------------------------------------------------------------------------
alter table training_load.metric_classification_requests
  drop constraint metric_classification_requests_operation_check,
  add constraint metric_classification_requests_operation_check check (operation in (
    'domain_create', 'domain_rename', 'domain_archive', 'domain_restore', 'domain_icon',
    'category_create', 'category_rename', 'category_archive', 'category_restore', 'category_icon',
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
         new_name, new_description, new_active, new_icon_url, changed_by_user_id, xact_id, xmin::text::bigint as written_in into chg
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
    select name, description, is_active, icon_url, xmin::text::bigint as written_in into node
      from training_load.metric_domains where id = chg.domain_id;
    if (select count(*) from training_load.metric_classification_changes where domain_id = chg.domain_id and object_kind = 'domain'
         and xact_id = this_xact) <> 1 then
      raise exception 'metric_classification_requests: the request must follow its own change in the same transaction' using errcode = '23514';
    end if;
  else
    select name, description, is_active, icon_url, xmin::text::bigint as written_in into node
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
     or node.is_active is distinct from chg.new_active
     or node.icon_url is distinct from chg.new_icon_url then
    raise exception 'metric_classification_requests: the request must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

comment on function training_load.metric_classification_node_guard() is
  'v46 (J6.1): the guard of a canonical domain or category of v41, with an icon change alone of an active node.';
comment on function training_load.metric_classification_record_node_change() is
  'v46 (J6.1): records a node''s create, rename, archive, restore or icon change, with the icon''s old and new value.';
comment on function training_load.metric_classification_requests_guard() is
  'v46 (J6.1): the request guard of v41, with domain_icon and category_icon and the icon compared.';
