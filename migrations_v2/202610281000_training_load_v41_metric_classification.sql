-- v41: domains and categories of canonical variables (phase 12b).
--
-- Contract: docs/ai/phase12-domains-categories-contract.md (J6), accepted on
-- 2026-10-28 as decision C101 of docs/ai/gpexe-metric-variable-mapping-discovery.md.
-- The v10 tables training_load.metric_domains, metric_categories and
-- metric_structure_links gain a governed canonical part: a domain or category
-- owned by the system or a club, and a link with such an owner, is written
-- only through the canonical-classification admin API, by the acting user of
-- the transaction (the v35 setting optimove.source_metric_actor), with a
-- change row the database writes and a request row that names it. Team and
-- user rows stay as v10 left them (the older API's coach classification).
--
--   * Fail closed (C101, J6 1.4): v41 refuses while any system or club row
--     exists in the three tables. The owner's read-only count of 2026-10-28
--     found none; a row written after it stops the migration with a fixed
--     message (counts only), and nothing of v41 is applied.
--   * Columns: metric_domains and metric_categories gain `key` (M3-0's key
--     rule; required for a canonical row, unique per owner, never changed)
--     and `description`. Both are new and empty, so their CHECKs hold
--     against every existing row.
--   * The text rule (J6 3.3, the v38 pattern): the guard applies
--     source_metric_text_ok() to a canonical row's name (80) and description
--     (500) on INSERT, and on UPDATE only to a value that changes.
--   * The guards (C76): every INSERT, UPDATE or DELETE of a canonical row
--     needs the acting user, who must hold the right the database derives
--     (source_metric_actor_basis(): an active platform admin; for a club row
--     also the active club's active admin). A canonical domain or category is
--     created active with its key, then only renamed, archived and restored,
--     never deleted; a canonical link has exactly two of a variable, a
--     category and a domain (O2), stays inside its owner (O4), never points
--     at an archived node or variable, is never updated, and its removal
--     writes its change row before the row goes (J6 3.3).
--   * The change record (training_load.metric_classification_changes): one
--     row per create, rename, archive, restore, link and remove, written by
--     the database from the row itself (old and new values; a removed link's
--     full content), by the acting user, in this transaction.
--   * The request record (training_load.metric_classification_requests):
--     one row per admin write, naming its change; its guard checks the actor,
--     the basis the database derives, the change of this transaction and the
--     operation. At COMMIT (deferred) every change row has its request row,
--     or the transaction rolls back (23514).
--   * O3: a canonical category sits under at most one domain, whoever owns
--     the domain (a partial unique index).
--   * Both new tables are append-only.
--
-- Known limits (as v35, v36 and v38): the guards prove that the row, the
-- acting user and the user's right agree, not that the code which set the
-- acting user was entitled to; they are no defence against whoever holds the
-- shared owner credentials or runs SQL through the application's pool and
-- disables a trigger. A write inside a savepoint is refused (its rows carry
-- the subtransaction's id): fail closed. A future migration that writes a
-- canonical row must switch these guards off inside itself and say so.
--
-- Lock order (the service): the per-user advisory lock and the request record;
-- then the node row FOR UPDATE (rename, archive, restore), or the link's
-- targets FOR SHARE in the order domain, category, variable (a new link), or
-- the link row FOR UPDATE (a removal); then the rights FOR SHARE (user, club;
-- v35's order). The guards lock the same targets again, already held.
-- Depends on the v34 function source_metric_text_ok() (as v40 left it) and the
-- v35 functions source_metric_context_actor(), source_metric_actor_basis() and
-- source_metric_current_xmin(). Fixed messages: no id, name, value or SQL.

-- ---------------------------------------------------------------------------
-- 0. Fail closed: no canonical row exists yet.
-- ---------------------------------------------------------------------------
do $$
declare
  d bigint;
  c bigint;
  l bigint;
begin
  select count(*) into d from training_load.metric_domains where owner_scope in ('system', 'club');
  select count(*) into c from training_load.metric_categories where owner_scope in ('system', 'club');
  select count(*) into l from training_load.metric_structure_links where owner_scope in ('system', 'club');
  if d + c + l > 0 then
    raise exception 'v41 refused: canonical classification rows exist (domains %, categories %, links %)', d, c, l
      using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Key and description.
-- ---------------------------------------------------------------------------
alter table training_load.metric_domains
  add column key text,
  add column description text,
  add constraint metric_domains_key_rule check (key is null or key ~ '^[a-z][a-z0-9_]{0,62}$'),
  add constraint metric_domains_canonical_key check (owner_scope::text not in ('system', 'club') or key is not null);

alter table training_load.metric_categories
  add column key text,
  add column description text,
  add constraint metric_categories_key_rule check (key is null or key ~ '^[a-z][a-z0-9_]{0,62}$'),
  add constraint metric_categories_canonical_key check (owner_scope::text not in ('system', 'club') or key is not null);

-- One key per canonical owner (a system row has no club: NULLS NOT DISTINCT).
create unique index metric_domains_canonical_key_unique
  on training_load.metric_domains (owner_scope, owner_club_id, key) nulls not distinct
  where owner_scope::text in ('system', 'club');
create unique index metric_categories_canonical_key_unique
  on training_load.metric_categories (owner_scope, owner_club_id, key) nulls not distinct
  where owner_scope::text in ('system', 'club');

-- O3: a canonical category under at most one domain, whoever owns the domain.
create unique index metric_structure_links_one_domain_per_category
  on training_load.metric_structure_links (category_id)
  where metric_definition_id is null and domain_id is not null and category_id is not null
    and owner_scope::text in ('system', 'club');

-- ---------------------------------------------------------------------------
-- 2. The change record.
-- ---------------------------------------------------------------------------
create table training_load.metric_classification_changes (
  id uuid primary key default gen_random_uuid(),
  -- The order of the changes, drawn while the writing statement holds its row.
  seq bigint generated always as identity (cache 1),
  object_kind text not null
    constraint metric_classification_changes_object_check check (object_kind in ('domain', 'category', 'link')),
  kind text not null
    constraint metric_classification_changes_kind_check check (kind in ('create', 'rename', 'archive', 'restore', 'link', 'remove')),
  -- A node's own id (domain or category), or a link's content.
  domain_id uuid references training_load.metric_domains(id) on delete restrict,
  category_id uuid references training_load.metric_categories(id) on delete restrict,
  metric_definition_id uuid references training_load.metric_definitions(id) on delete restrict,
  -- A link's id; no foreign key, since a removed link's row is gone.
  link_id uuid,
  owner_scope text not null
    constraint metric_classification_changes_owner_scope_check check (owner_scope in ('system', 'club')),
  owner_club_id uuid references public.clubs(id) on delete restrict,
  old_name text,
  new_name text,
  old_description text,
  new_description text,
  old_active boolean,
  new_active boolean,
  changed_by_user_id uuid not null references public.users(id) on delete restrict,
  xact_id xid8 not null,
  changed_at timestamptz not null default clock_timestamp(),
  constraint metric_classification_changes_owner_shape check ((owner_scope = 'system') = (owner_club_id is null)),
  constraint metric_classification_changes_one_seq unique (seq),
  constraint metric_classification_changes_shape check (
    (object_kind = 'domain' and domain_id is not null and category_id is null and metric_definition_id is null and link_id is null
       and kind in ('create', 'rename', 'archive', 'restore'))
    or (object_kind = 'category' and category_id is not null and domain_id is null and metric_definition_id is null and link_id is null
       and kind in ('create', 'rename', 'archive', 'restore'))
    or (object_kind = 'link' and link_id is not null and kind in ('link', 'remove')
       and num_nonnulls(domain_id, category_id, metric_definition_id) = 2
       and old_name is null and new_name is null and old_description is null and new_description is null
       and old_active is null and new_active is null)
  ),
  constraint metric_classification_changes_kind_shape check (
    object_kind = 'link'
    or (kind = 'create' and old_name is null and new_name is not null and old_active is null and new_active = true)
    or (kind = 'rename' and old_name is not null and new_name is not null and old_active = true and new_active = true)
    or (kind = 'archive' and old_active = true and new_active = false
        and old_name is not distinct from new_name and old_description is not distinct from new_description)
    or (kind = 'restore' and old_active = false and new_active = true
        and old_name is not distinct from new_name and old_description is not distinct from new_description)
  )
);

create index metric_classification_changes_domain_idx on training_load.metric_classification_changes (domain_id, seq) where domain_id is not null;
create index metric_classification_changes_category_idx on training_load.metric_classification_changes (category_id, seq) where category_id is not null;
create index metric_classification_changes_definition_idx on training_load.metric_classification_changes (metric_definition_id) where metric_definition_id is not null;
create index metric_classification_changes_link_idx on training_load.metric_classification_changes (link_id, seq) where link_id is not null;
create index metric_classification_changes_user_idx on training_load.metric_classification_changes (changed_by_user_id);
create index metric_classification_changes_club_idx on training_load.metric_classification_changes (owner_club_id) where owner_club_id is not null;

-- ---------------------------------------------------------------------------
-- 3. The request record.
-- ---------------------------------------------------------------------------
create table training_load.metric_classification_requests (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null,
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  operation text not null
    constraint metric_classification_requests_operation_check check (operation in (
      'domain_create', 'domain_rename', 'domain_archive', 'domain_restore',
      'category_create', 'category_rename', 'category_archive', 'category_restore',
      'link_create', 'link_remove')),
  request_hash text not null
    constraint metric_classification_requests_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  owner_scope text not null
    constraint metric_classification_requests_owner_scope_check check (owner_scope in ('system', 'club')),
  owner_club_id uuid references public.clubs(id) on delete restrict,
  basis text not null
    constraint metric_classification_requests_basis_check check (basis in ('platform_admin', 'club_admin')),
  metric_classification_change_id uuid not null
    constraint metric_classification_requests_one_per_change unique
    references training_load.metric_classification_changes(id) on delete restrict,
  reason text,
  created_at timestamptz not null default now(),
  constraint metric_classification_requests_owner_shape check ((owner_scope = 'system') = (owner_club_id is null)),
  constraint metric_classification_requests_basis_shape check (owner_scope = 'club' or basis = 'platform_admin'),
  constraint metric_classification_requests_reason_check check (
    reason is null or (operation in ('domain_archive', 'domain_restore', 'category_archive', 'category_restore', 'link_remove')
                       and training_load.source_metric_text_ok(reason, 500))),
  constraint metric_classification_requests_archive_reason check (operation not in ('domain_archive', 'category_archive') or reason is not null),
  constraint metric_classification_requests_one_per_key unique (requested_by_user_id, request_key)
);

create index metric_classification_requests_club_idx on training_load.metric_classification_requests (owner_club_id) where owner_club_id is not null;

-- ---------------------------------------------------------------------------
-- 4. The guard of a canonical domain or category.
-- ---------------------------------------------------------------------------
create function training_load.metric_classification_node_guard() returns trigger as $$
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

create trigger metric_domains_v41_guard
  before insert or update or delete on training_load.metric_domains
  for each row execute function training_load.metric_classification_node_guard();
create trigger metric_categories_v41_guard
  before insert or update or delete on training_load.metric_categories
  for each row execute function training_load.metric_classification_node_guard();

-- The writer of a node's change row: values from OLD and NEW only.
create function training_load.metric_classification_record_node_change() returns trigger as $$
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

-- WHEN clauses written so a dump and restore reads them back the same (as
-- v38): plain comparisons, the varchar owner_scope compared as text.
create trigger metric_domains_v41_record_create
  after insert on training_load.metric_domains
  for each row when (new.owner_scope::text in ('system', 'club'))
  execute function training_load.metric_classification_record_node_change();
create trigger metric_domains_v41_record_change
  after update of name, description, is_active on training_load.metric_domains
  for each row
  when (new.owner_scope::text in ('system', 'club')
        and (old.name is distinct from new.name or old.description is distinct from new.description
             or old.is_active is distinct from new.is_active))
  execute function training_load.metric_classification_record_node_change();
create trigger metric_categories_v41_record_create
  after insert on training_load.metric_categories
  for each row when (new.owner_scope::text in ('system', 'club'))
  execute function training_load.metric_classification_record_node_change();
create trigger metric_categories_v41_record_change
  after update of name, description, is_active on training_load.metric_categories
  for each row
  when (new.owner_scope::text in ('system', 'club')
        and (old.name is distinct from new.name or old.description is distinct from new.description
             or old.is_active is distinct from new.is_active))
  execute function training_load.metric_classification_record_node_change();

-- ---------------------------------------------------------------------------
-- 5. The guard of a canonical link (after v10's breadth trigger, by name).
-- ---------------------------------------------------------------------------
create function training_load.metric_classification_link_guard() returns trigger as $$
declare
  actor uuid;
  basis text;
  dom record;
  cat record;
  def record;
begin
  if tg_op = 'UPDATE' then
    if old.owner_scope in ('system', 'club') or new.owner_scope in ('system', 'club') then
      raise exception 'metric classification: a canonical link is created or removed, never changed' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.owner_scope not in ('system', 'club') then
      return old;
    end if;
    actor := training_load.source_metric_context_actor();
    basis := training_load.source_metric_actor_basis(actor, old.owner_club_id);
    if basis is null then
      raise exception 'metric classification: the acting user may not write this owner scope' using errcode = '42501';
    end if;
    -- The removed link's change row, from the row itself, before it goes.
    insert into training_load.metric_classification_changes
      (object_kind, kind, domain_id, category_id, metric_definition_id, link_id, owner_scope, owner_club_id,
       changed_by_user_id, xact_id)
    values
      ('link', 'remove', old.domain_id, old.category_id, old.metric_definition_id, old.id, old.owner_scope,
       old.owner_club_id, actor, pg_current_xact_id());
    return old;
  end if;
  -- INSERT
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
  if num_nonnulls(new.domain_id, new.category_id, new.metric_definition_id) <> 2 or new.temporal_smoothing_enabled then
    raise exception 'metric classification: a canonical link names exactly two of a variable, a category and a domain' using errcode = '23514';
  end if;
  -- The targets, FOR SHARE in the service's order: domain, category, variable.
  if new.domain_id is not null then
    select owner_scope, owner_club_id, is_active into dom
      from training_load.metric_domains where id = new.domain_id for share;
  end if;
  if new.category_id is not null then
    select owner_scope, owner_club_id, is_active into cat
      from training_load.metric_categories where id = new.category_id for share;
  end if;
  if new.metric_definition_id is not null then
    select owner_scope, owner_club_id, state into def
      from training_load.metric_definitions where id = new.metric_definition_id for share;
  end if;
  -- O4: the container (the category of a variable link, the domain of a
  -- variable -> domain link, the category of a category -> domain link) is
  -- the link's own owner's; the other end is the same owner's or the system's.
  if new.metric_definition_id is not null and new.category_id is not null then
    if cat.owner_scope is distinct from new.owner_scope or cat.owner_club_id is distinct from new.owner_club_id
       or not (def.owner_scope = 'system' or (def.owner_scope = new.owner_scope and def.owner_club_id is not distinct from new.owner_club_id)) then
      raise exception 'metric classification: a link reaches outside its owner' using errcode = '23514';
    end if;
  elsif new.metric_definition_id is not null then
    if dom.owner_scope is distinct from new.owner_scope or dom.owner_club_id is distinct from new.owner_club_id
       or not (def.owner_scope = 'system' or (def.owner_scope = new.owner_scope and def.owner_club_id is not distinct from new.owner_club_id)) then
      raise exception 'metric classification: a link reaches outside its owner' using errcode = '23514';
    end if;
  else
    if cat.owner_scope is distinct from new.owner_scope or cat.owner_club_id is distinct from new.owner_club_id
       or not (dom.owner_scope = 'system' or (dom.owner_scope = new.owner_scope and dom.owner_club_id is not distinct from new.owner_club_id)) then
      raise exception 'metric classification: a link reaches outside its owner' using errcode = '23514';
    end if;
  end if;
  -- One IF per target: a record a branch never read is not assigned.
  if new.domain_id is not null then
    if dom.is_active is distinct from true then
      raise exception 'metric classification: a link never points at an archived domain or category' using errcode = '23514';
    end if;
  end if;
  if new.category_id is not null then
    if cat.is_active is distinct from true then
      raise exception 'metric classification: a link never points at an archived domain or category' using errcode = '23514';
    end if;
  end if;
  if new.metric_definition_id is not null then
    if def.state is distinct from 'active' then
      raise exception 'metric classification: a link never points at an archived variable' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_structure_links_v41_guard
  before insert or update or delete on training_load.metric_structure_links
  for each row execute function training_load.metric_classification_link_guard();

create function training_load.metric_classification_record_link() returns trigger as $$
begin
  insert into training_load.metric_classification_changes
    (object_kind, kind, domain_id, category_id, metric_definition_id, link_id, owner_scope, owner_club_id,
     changed_by_user_id, xact_id)
  values
    ('link', 'link', new.domain_id, new.category_id, new.metric_definition_id, new.id, new.owner_scope,
     new.owner_club_id, training_load.source_metric_context_actor(), pg_current_xact_id());
  return null;
end;
$$ language plpgsql;

create trigger metric_structure_links_v41_record_link
  after insert on training_load.metric_structure_links
  for each row when (new.owner_scope::text in ('system', 'club'))
  execute function training_load.metric_classification_record_link();

-- ---------------------------------------------------------------------------
-- 6. A change row only from inside a trigger of this transaction, by the
--    acting user, for a row this transaction wrote (a removal: the link row
--    still there, its content the change's).
-- ---------------------------------------------------------------------------
create function training_load.metric_classification_changes_insert_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  node record;
  link record;
begin
  if pg_trigger_depth() < 2 or new.xact_id is distinct from pg_current_xact_id() then
    raise exception 'metric_classification_changes: a change row is written only by its own change' using errcode = '23514';
  end if;
  if new.changed_by_user_id is distinct from actor then
    raise exception 'metric_classification_changes: the row names another user than the acting user' using errcode = '42501';
  end if;
  if new.object_kind = 'domain' then
    select owner_scope, owner_club_id, xmin::text::bigint as written_in into node
      from training_load.metric_domains where id = new.domain_id;
  elsif new.object_kind = 'category' then
    select owner_scope, owner_club_id, xmin::text::bigint as written_in into node
      from training_load.metric_categories where id = new.category_id;
  else
    select domain_id, category_id, metric_definition_id, owner_scope, owner_club_id, xmin::text::bigint as written_in into link
      from training_load.metric_structure_links where id = new.link_id;
    if not found
       or (new.kind = 'link' and link.written_in is distinct from here)
       or link.domain_id is distinct from new.domain_id
       or link.category_id is distinct from new.category_id
       or link.metric_definition_id is distinct from new.metric_definition_id
       or link.owner_scope is distinct from new.owner_scope
       or link.owner_club_id is distinct from new.owner_club_id then
      raise exception 'metric_classification_changes: a change row is written only by its own change' using errcode = '23514';
    end if;
    return new;
  end if;
  if not found
     or node.written_in is distinct from here
     or node.owner_scope is distinct from new.owner_scope
     or node.owner_club_id is distinct from new.owner_club_id then
    raise exception 'metric_classification_changes: a change row is written only by its own change' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_classification_changes_insert_guard
  before insert on training_load.metric_classification_changes
  for each row execute function training_load.metric_classification_changes_insert_guard();

-- ---------------------------------------------------------------------------
-- 7. The request guard.
-- ---------------------------------------------------------------------------
create function training_load.metric_classification_requests_guard() returns trigger as $$
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

create trigger metric_classification_requests_guard
  before insert on training_load.metric_classification_requests
  for each row execute function training_load.metric_classification_requests_guard();

-- ---------------------------------------------------------------------------
-- 8. At COMMIT: every change row has the request row that names it.
-- ---------------------------------------------------------------------------
create function training_load.metric_classification_changes_request_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.metric_classification_requests where metric_classification_change_id = new.id) then
    raise exception 'metric_classification_changes: a change is written with its own request row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger metric_classification_changes_request_link
  after insert on training_load.metric_classification_changes
  deferrable initially deferred
  for each row execute function training_load.metric_classification_changes_request_link();

-- ---------------------------------------------------------------------------
-- 9. Append-only.
-- ---------------------------------------------------------------------------
create function training_load.metric_classification_append_only() returns trigger as $$
begin
  raise exception 'metric classification: change and request records are append-only' using errcode = '23514';
end;
$$ language plpgsql;

create trigger metric_classification_changes_no_update_delete
  before update or delete on training_load.metric_classification_changes
  for each row execute function training_load.metric_classification_append_only();
create trigger metric_classification_changes_no_truncate
  before truncate on training_load.metric_classification_changes
  for each statement execute function training_load.metric_classification_append_only();
create trigger metric_classification_requests_no_update_delete
  before update or delete on training_load.metric_classification_requests
  for each row execute function training_load.metric_classification_append_only();
create trigger metric_classification_requests_no_truncate
  before truncate on training_load.metric_classification_requests
  for each statement execute function training_load.metric_classification_append_only();
