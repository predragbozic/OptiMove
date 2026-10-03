-- Training Load v29 — the two state/fact invariants v27 left to the
-- application, and the index the per-user authentication throttle reads.
--
-- F3c2d (GPEXE Connect / Reconnect / Test routes). Contract:
-- docs/ai/source-connections-f3c2-contract.md section 2.3 (conditions 4
-- and 5) and 2.4 ("Fact gap in v27 to close with the routes"). Owner order
-- 2026-10-03: a state/fact invariant the schema cannot enforce is not left
-- as a JavaScript check; the smallest forward migration closes it.
--
-- What it adds (nothing else):
--   1. A fact CHECK for linked_untested: v27 bound verified, needs_reconnect
--      and source_unavailable to their facts and left linked_untested
--      unbound. A connection whose credential was stored but whose first
--      Test did not reach the source must carry the error code and the time
--      of that failed Test, so the screen can say why it is not verified.
--   2. A credential CHECK for every state but not_connected: v27 said
--      "verified has a credential" and "not_connected has none"; the three
--      states between (linked_untested, needs_reconnect, source_unavailable)
--      are reached only from a connection that holds a credential (section
--      2.4), so a row in one of them without ciphertext is a contradiction
--      the database now refuses.
--   3. A partial index on the audit for the per-user window of the
--      authentication throttle (5 attempts that reached the source in 15
--      minutes, per connection AND per performing user). v27 indexed the
--      per-connection window only.
--
-- It changes no row: at v28 no connection, binding or audit row exists on
-- any database this project knows (F3c1/F3c2a/F3c2b/F3c2c write none), so
-- the new CHECKs validate an empty table. Should a row exist that violates
-- them, ALTER TABLE ... ADD CONSTRAINT fails and the migration does not
-- apply — nothing is rewritten silently.
--
-- Rollback: docs/runbooks/source-connections-v29-rollback.sql (drops only
-- the two constraints and the index; refuses once a later migration is
-- recorded).

alter table training_load.source_credential_connections
  add constraint source_credential_connections_state_linked_untested_facts
  check (state <> 'linked_untested' or (last_error_code is not null and last_error_at is not null));

alter table training_load.source_credential_connections
  add constraint source_credential_connections_state_has_credential
  check (state = 'not_connected' or credential_ciphertext is not null);

comment on constraint source_credential_connections_state_linked_untested_facts
  on training_load.source_credential_connections is
  'v29 (F3c2d): a connection whose credential is stored but whose first Test did not reach the source carries the code and the time of that failed Test.';

comment on constraint source_credential_connections_state_has_credential
  on training_load.source_credential_connections is
  'v29 (F3c2d): every state but not_connected is reached only from a stored credential; a row in such a state without ciphertext is a contradiction.';

-- The per-user window of the authentication throttle: attempts of one user
-- across every connection in the last 15 minutes. Only the three attempt
-- actions are indexed; the audit's own (connection_id, performed_at) index
-- serves the per-connection window.
create index source_connection_audit_user_attempts_idx
  on training_load.source_connection_audit (performed_by_user_id, performed_at desc)
  where action in ('connect', 'reconnect', 'test') and performed_by_user_id is not null;

comment on index training_load.source_connection_audit_user_attempts_idx is
  'v29 (F3c2d): the per-user window of the Connect / Reconnect / Test throttle (docs/ai/source-connections-f3c2-contract.md, condition 4).';
