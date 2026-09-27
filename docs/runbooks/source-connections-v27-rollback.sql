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
-- It drops only what v27 created. It NEVER copies, exports or decrypts a
-- credential: the tables are dropped with their ciphertext; no "backup
-- before drop" table is made here (a backup is the database backup above).
-- Nothing of v26 or earlier is touched: gpexe_team_settings and every other
-- table keep every row. A roll-forward fix is preferred whenever possible.
--
-- One transaction: everything or nothing.
begin;

drop trigger if exists source_connection_audit_no_truncate on training_load.source_connection_audit;
drop trigger if exists source_connection_audit_no_update_delete on training_load.source_connection_audit;
drop trigger if exists source_credential_connections_protect_identity on training_load.source_credential_connections;
drop trigger if exists source_team_bindings_no_truncate on training_load.source_team_bindings;
drop trigger if exists source_team_bindings_immutable on training_load.source_team_bindings;
drop trigger if exists source_team_bindings_check_owner on training_load.source_team_bindings;

drop table if exists training_load.source_connection_audit;
drop table if exists training_load.source_team_bindings;
drop table if exists training_load.source_credential_connections;

drop function if exists training_load.source_connection_audit_append_only();
drop function if exists training_load.jsonb_names_a_secret(jsonb);
drop function if exists training_load.source_credential_connection_protect_identity();
drop function if exists training_load.source_history_no_truncate();
drop function if exists training_load.source_team_binding_immutable();
drop function if exists training_load.source_team_binding_check_owner();
drop function if exists training_load.source_connection_bound_team_ids(uuid);

delete from public.schema_migrations
 where migration_name like '%202609271000_training_load_v27_source_credential_connections.sql';

commit;
