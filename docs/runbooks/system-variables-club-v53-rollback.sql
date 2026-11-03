-- Rollback of migration v53 (a club copies or hides a system variable and
-- moves a team to its copy; phase 7i, J15):
-- migrations_v2/202611031200_training_load_v53_system_variables_club.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-metric-variables-club-7i.test.mjs: apply ->
-- rollback -> the v52 catalog exactly -> re-apply, every refusal below, and
-- atomicity). Before it is run anywhere real: a fresh restore-verified backup
-- exists; the deployed commit no longer contains the v53 migration file
-- (otherwise the migrator applies v53 again at the next start) nor phase 7i's
-- code; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v53 adds three tables (metric_definition_copies,
-- source_metric_mapping_version_copies, metric_definition_club_hides) with
-- eight functions, widens training_load.metric_variable_requests (the
-- operation variable_copy, the column operation_id, version_iff, the
-- one-create index, the insert trigger's WHEN) and replaces two bodies (v36's
-- metric_variable_requests_insert_guard and v48's
-- source_metric_activations_insert_guard). This script drops the three tables
-- and their functions, restores v45's operation CHECK, v38's version_iff,
-- v36's index predicate, v38's trigger WHEN and both bodies byte for byte,
-- drops operation_id, and removes the v53 record; it changes no other row.
-- It refuses, changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v53 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * any copy, link or hide row exists, or any variable_copy request (once
--     one exists the way forward is a new migration, never this script);
--   * a v53 object is missing (a table, a function, a trigger), a trigger on
--     the request table, T5 or a new table is disabled, or a body in force of
--     the two replaced functions is not v53's (by md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f system-variables-club-v53-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds one of the tables (a read included), or
-- one of the tables the three new tables' foreign keys reference (public.clubs,
-- public.users, metric_definitions, metric_definition_versions, T4: dropping
-- the new tables locks them too), makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v53 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v53 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202611031200_training_load_v53_system_variables_club.sql') then
    raise exception 'v53 rollback refused: v53 is not recorded on this database';
  end if;
end $$;

-- v53's locks, in v53's order, then the new tables: no copy, hide, start or
-- request is written until the COMMIT.
lock table training_load.metric_variable_requests in access exclusive mode;
lock table training_load.source_metric_mapping_activations in share row exclusive mode;
lock table training_load.metric_definition_copies in access exclusive mode;
lock table training_load.source_metric_mapping_version_copies in access exclusive mode;
lock table training_load.metric_definition_club_hides in access exclusive mode;

do $$
declare
  v53 constant text := 'migrations_v2/202611031200_training_load_v53_system_variables_club.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v53) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.metric_definition_copies) then
    reasons := array_append(reasons, 'a copy exists');
  end if;
  if exists (select 1 from training_load.source_metric_mapping_version_copies) then
    reasons := array_append(reasons, 'a copied mapping version link exists');
  end if;
  if exists (select 1 from training_load.metric_definition_club_hides) then
    reasons := array_append(reasons, 'a hide exists');
  end if;
  if exists (select 1 from training_load.metric_variable_requests where operation = 'variable_copy') then
    reasons := array_append(reasons, 'a variable_copy request exists');
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load'
         and p.proname in ('club_variable_rows_append_only', 'metric_definition_copies_insert_guard', 'metric_definition_copies_request_link', 'source_metric_mapping_version_copies_insert_guard', 'source_metric_mapping_version_copies_audit_link', 'metric_definition_club_hides_insert_guard', 'metric_definition_club_hides_update_guard', 'metric_definition_club_hides_xact_link')) <> 8 then
    reasons := array_append(reasons, 'a v53 function is missing');
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid in ('training_load.metric_definition_copies'::regclass,
                           'training_load.source_metric_mapping_version_copies'::regclass,
                           'training_load.metric_definition_club_hides'::regclass)
         and not t.tgisinternal) <> 13 then
    reasons := array_append(reasons, 'a trigger of a v53 table is missing');
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid in ('training_load.metric_variable_requests'::regclass,
                                  'training_load.source_metric_mapping_activations'::regclass,
                                  'training_load.metric_definition_copies'::regclass,
                                  'training_load.source_metric_mapping_version_copies'::regclass,
                                  'training_load.metric_definition_club_hides'::regclass)
                and not t.tgisinternal and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a trigger on the request table, T5 or a v53 table is disabled');
  end if;
  if exists (select 1 from (values
               ('metric_variable_requests_insert_guard', 'dfec05ae802bfbb810c5c46337616970'),
               ('source_metric_activations_insert_guard', 'e4f9a4e632d00c090d2c646def16374d')) as want(name, digest)
              where (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = want.name) is distinct from want.digest) then
    reasons := array_append(reasons, 'a body in force is not v53''s');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v53 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- The three tables (their triggers go with them), then their functions.
drop table training_load.metric_definition_club_hides;
drop table training_load.source_metric_mapping_version_copies;
drop table training_load.metric_definition_copies;
drop function training_load.club_variable_rows_append_only();
drop function training_load.metric_definition_copies_insert_guard();
drop function training_load.metric_definition_copies_request_link();
drop function training_load.source_metric_mapping_version_copies_insert_guard();
drop function training_load.source_metric_mapping_version_copies_audit_link();
drop function training_load.metric_definition_club_hides_insert_guard();
drop function training_load.metric_definition_club_hides_update_guard();
drop function training_load.metric_definition_club_hides_xact_link();

-- The request record: v38's trigger WHEN, v36's index predicate, v45's
-- operation CHECK and v38's version_iff, without operation_id.
create or replace trigger metric_variable_requests_insert_guard
  before insert on training_load.metric_variable_requests
  for each row
  when (new.operation in ('variable_create', 'variable_version_create'))
  execute function training_load.metric_variable_requests_insert_guard();

drop index training_load.metric_variable_requests_one_create_per_definition;
create unique index metric_variable_requests_one_create_per_definition
  on training_load.metric_variable_requests (metric_definition_id) where operation = 'variable_create';

alter table training_load.metric_variable_requests
  drop constraint metric_variable_requests_operation_id_iff,
  drop constraint metric_variable_requests_operation_check,
  add constraint metric_variable_requests_operation_check check (operation in (
    'variable_create', 'variable_version_create', 'variable_rename', 'variable_archive', 'variable_restore', 'variable_icon')),
  drop constraint metric_variable_requests_version_iff,
  add constraint metric_variable_requests_version_iff check (
    (metric_definition_version_id is not null) = (operation in ('variable_create', 'variable_version_create'))),
  drop column operation_id;

-- v36's request insert guard, byte for byte.
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
  if not found
     or ver.written_in is distinct from here
     or ver.created_by_user_id is distinct from actor
     or def.written_in is distinct from here
     or def.state is distinct from 'active'
     or def.current_version_id is distinct from new.metric_definition_version_id
     or (new.operation = 'variable_create' and (ver.version_number <> 1 or def.created_by_user_id is distinct from actor))
     or (new.operation = 'variable_version_create' and ver.version_number <= 1) then
    raise exception 'metric_variable_requests: the request must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- v48's T5 insert guard, byte for byte.
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
  return new;
end;
$$ language plpgsql;

-- Both bodies restored byte for byte, or nothing is committed.
do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'metric_variable_requests_insert_guard') is distinct from 'ae5bf5e22620546a83cf955b8b1d9a9d'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'training_load' and p.proname = 'source_metric_activations_insert_guard') is distinct from 'e47f75d4a7a6c63659a19491db97d678' then
    raise exception 'v53 rollback refused: a restored body is not v36''s or v48''s';
  end if;
end $$;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202611031200_training_load_v53_system_variables_club.sql';

commit;
