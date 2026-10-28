-- Rollback of migration v41 (domains and categories of canonical variables,
-- phase 12b):
-- migrations_v2/202610281000_training_load_v41_metric_classification.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/canonical-classification-12b.test.mjs: apply ->
-- rollback -> the v40 catalog again -> re-apply, and every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the
-- deployed commit no longer contains the v41 migration file (otherwise the
-- migrator applies v41 again at the next start) nor the classification routes
-- that write these tables; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v41 adds two tables (training_load.metric_classification_changes and
-- metric_classification_requests), two columns and two checks on each of
-- metric_domains and metric_categories, three indexes on the v10 tables,
-- nine functions and sixteen triggers. It changes no data. This script
-- reverses exactly that and removes the v41 record. It refuses, changing
-- nothing, when
--   * v41 is not recorded on the database;
--   * any migrations_v2 migration newer than v41 is recorded;
--   * any change or request row exists, or any system or club domain,
--     category or link exists - they are the record and the result of the
--     canonical-classification writes; once one exists the way forward is a
--     new migration, never this script;
--   * any team or user domain or category carries a key or a description
--     (dropping the two columns would lose it);
--   * the v41 objects are not exactly the ones v41 created (one is missing,
--     or a trigger is disabled).
--
-- One transaction: everything or nothing. Waits are bounded: a stalled
-- transaction that holds one of the tables makes this script fail after 5 s.
-- Run it at a quiet moment, as one script that stops at the first error
-- (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open transaction is
-- aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') then
    raise exception 'v41 rollback refused: v41 is not recorded on this database';
  end if;
  if to_regclass('training_load.metric_classification_changes') is null
     or to_regclass('training_load.metric_classification_requests') is null then
    raise exception 'v41 rollback refused: the v41 tables are not present';
  end if;
end $$;

lock table training_load.metric_domains, training_load.metric_categories, training_load.metric_structure_links,
           training_load.metric_classification_changes, training_load.metric_classification_requests
  in access exclusive mode;

do $$
declare
  v41 constant text := 'migrations_v2/202610281000_training_load_v41_metric_classification.sql';
  reasons text[] := '{}';
  newer text;
  missing text;
  disabled text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > v41;
  if newer is not null then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.metric_classification_changes)
     or exists (select 1 from training_load.metric_classification_requests) then
    reasons := array_append(reasons, 'change or request records exist');
  end if;
  if exists (select 1 from training_load.metric_domains where owner_scope in ('system', 'club'))
     or exists (select 1 from training_load.metric_categories where owner_scope in ('system', 'club'))
     or exists (select 1 from training_load.metric_structure_links where owner_scope in ('system', 'club')) then
    reasons := array_append(reasons, 'canonical classification rows exist');
  end if;
  if exists (select 1 from training_load.metric_domains
              where owner_scope in ('team', 'user') and (key is not null or description is not null))
     or exists (select 1 from training_load.metric_categories
                 where owner_scope in ('team', 'user') and (key is not null or description is not null)) then
    reasons := array_append(reasons, 'a team or user domain or category carries a key or a description');
  end if;
  select string_agg(f.name, ', ' order by f.name) into missing
    from unnest(array['metric_classification_node_guard', 'metric_classification_record_node_change',
                      'metric_classification_link_guard', 'metric_classification_record_link',
                      'metric_classification_changes_insert_guard', 'metric_classification_requests_guard',
                      'metric_classification_changes_request_link', 'metric_classification_append_only',
                      'metric_classification_links_no_truncate']) as f(name)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = f.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v41 functions are not all present');
  end if;
  select string_agg(t.rel || '.' || t.name, ', ' order by t.rel, t.name) into missing
    from (values ('metric_domains', 'metric_domains_v41_guard'),
                 ('metric_domains', 'metric_domains_v41_record_create'),
                 ('metric_domains', 'metric_domains_v41_record_change'),
                 ('metric_categories', 'metric_categories_v41_guard'),
                 ('metric_categories', 'metric_categories_v41_record_create'),
                 ('metric_categories', 'metric_categories_v41_record_change'),
                 ('metric_structure_links', 'metric_structure_links_v41_guard'),
                 ('metric_structure_links', 'metric_structure_links_v41_record_link'),
                 ('metric_structure_links', 'metric_structure_links_v41_no_truncate'),
                 ('metric_classification_changes', 'metric_classification_changes_insert_guard'),
                 ('metric_classification_changes', 'metric_classification_changes_request_link'),
                 ('metric_classification_changes', 'metric_classification_changes_no_update_delete'),
                 ('metric_classification_changes', 'metric_classification_changes_no_truncate'),
                 ('metric_classification_requests', 'metric_classification_requests_guard'),
                 ('metric_classification_requests', 'metric_classification_requests_no_update_delete'),
                 ('metric_classification_requests', 'metric_classification_requests_no_truncate')) as t(rel, name)
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'training_load' and c.relname = t.rel and g.tgname = t.name and not g.tgisinternal);
  if missing is not null then
    reasons := array_append(reasons, 'the v41 triggers are not all present');
  end if;
  select string_agg(i.name, ', ' order by i.name) into missing
    from unnest(array['metric_domains_canonical_key_unique', 'metric_categories_canonical_key_unique',
                      'metric_structure_links_one_domain_per_category']) as i(name)
   where to_regclass('training_load.' || i.name) is null;
  if missing is not null then
    reasons := array_append(reasons, 'the v41 indexes are not all present');
  end if;
  select string_agg(c.relname || '.' || g.tgname, ', ' order by c.relname, g.tgname) into disabled
    from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'training_load' and not g.tgisinternal and g.tgenabled <> 'O'
     and (c.relname in ('metric_classification_changes', 'metric_classification_requests')
          or g.tgname like '%\_v41\_%');
  if disabled is not null then
    reasons := array_append(reasons, 'a v41 trigger is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v41 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- The v10 tables' triggers and indexes, then the two v41 tables (their own
-- constraints, indexes and triggers go with them), then the columns.
drop trigger metric_domains_v41_guard on training_load.metric_domains;
drop trigger metric_domains_v41_record_create on training_load.metric_domains;
drop trigger metric_domains_v41_record_change on training_load.metric_domains;
drop trigger metric_categories_v41_guard on training_load.metric_categories;
drop trigger metric_categories_v41_record_create on training_load.metric_categories;
drop trigger metric_categories_v41_record_change on training_load.metric_categories;
drop trigger metric_structure_links_v41_guard on training_load.metric_structure_links;
drop trigger metric_structure_links_v41_record_link on training_load.metric_structure_links;
drop trigger metric_structure_links_v41_no_truncate on training_load.metric_structure_links;
drop index training_load.metric_domains_canonical_key_unique;
drop index training_load.metric_categories_canonical_key_unique;
drop index training_load.metric_structure_links_one_domain_per_category;
drop table training_load.metric_classification_requests;
drop table training_load.metric_classification_changes;
alter table training_load.metric_domains
  drop constraint metric_domains_canonical_key,
  drop constraint metric_domains_key_rule,
  drop column description,
  drop column key;
alter table training_load.metric_categories
  drop constraint metric_categories_canonical_key,
  drop constraint metric_categories_key_rule,
  drop column description,
  drop column key;

drop function training_load.metric_classification_requests_guard();
drop function training_load.metric_classification_changes_request_link();
drop function training_load.metric_classification_append_only();
drop function training_load.metric_classification_changes_insert_guard();
drop function training_load.metric_classification_record_link();
drop function training_load.metric_classification_link_guard();
drop function training_load.metric_classification_record_node_change();
drop function training_load.metric_classification_node_guard();
drop function training_load.metric_classification_links_no_truncate();

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql';

commit;
