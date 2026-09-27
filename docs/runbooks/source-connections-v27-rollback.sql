-- Rollback of migration v27 (F3c1: source credential connections, team
-- bindings and their audit):
-- migrations_v2/202609271000_training_load_v27_source_credential_connections.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/source-connections-f3c1.test.mjs, test 1: apply,
-- rollback, apply again, broken tail). Before it is run anywhere real:
--   * the application is back on a commit WITHOUT F3c1 (nothing of F3c1 is
--     reachable from a route in this phase, so that is only a consistency
--     rule);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It drops only what v27 created, and ONLY while every v27 table is still
-- empty (the seeded host catalog aside): once a connection, a binding or an
-- audit row exists the audit is append-only and history must not vanish,
-- so this script refuses and the only way forward is a new migration. It
-- NEVER copies, exports or decrypts a credential: the tables are dropped
-- with their (absent) ciphertext; no "backup before drop" table is made
-- here (a backup is the database backup above). Nothing of v26 or earlier
-- is touched: gpexe_team_settings and every other table keep every row.
--
-- One transaction: everything or nothing.
begin;

do $$
declare
  n_conn bigint; n_bind bigint; n_audit bigint;
begin
  select count(*) into n_conn from training_load.source_credential_connections;
  select count(*) into n_bind from training_load.source_team_bindings;
  select count(*) into n_audit from training_load.source_connection_audit;
  if n_conn > 0 or n_bind > 0 or n_audit > 0 then
    raise exception 'v27 rollback refused: source_credential_connections=% source_team_bindings=% source_connection_audit=% rows exist; after first use only a forward migration is allowed', n_conn, n_bind, n_audit;
  end if;
end $$;

drop trigger if exists teams_source_binding_guard_move on public.teams;
drop trigger if exists source_credential_connections_check_host on training_load.source_credential_connections;
drop trigger if exists source_host_catalog_immutable on training_load.source_host_catalog;
drop trigger if exists source_connection_audit_no_truncate on training_load.source_connection_audit;
drop trigger if exists source_connection_audit_no_update_delete on training_load.source_connection_audit;
drop trigger if exists source_credential_connections_protect_identity on training_load.source_credential_connections;
drop trigger if exists source_team_bindings_no_truncate on training_load.source_team_bindings;
drop trigger if exists source_team_bindings_immutable on training_load.source_team_bindings;
drop trigger if exists source_team_bindings_check_owner on training_load.source_team_bindings;

drop table if exists training_load.source_connection_audit;
drop table if exists training_load.source_team_bindings;
drop table if exists training_load.source_credential_connections;
drop table if exists training_load.source_host_catalog;

drop function if exists training_load.source_connection_audit_append_only();
drop function if exists training_load.jsonb_names_a_secret(jsonb);
drop function if exists training_load.key_name_is_secret(text);
drop function if exists training_load.normalize_key_name(text);
drop function if exists training_load.source_team_binding_guard_team_move();
drop function if exists training_load.source_credential_connection_check_host();
drop function if exists training_load.source_host_catalog_immutable();
drop function if exists training_load.source_credential_connection_protect_identity();
drop function if exists training_load.source_history_no_truncate();
drop function if exists training_load.source_team_binding_immutable();
drop function if exists training_load.source_team_binding_check_owner();
drop function if exists training_load.source_connection_bound_team_ids(uuid);

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202609271000_training_load_v27_source_credential_connections.sql';

commit;
