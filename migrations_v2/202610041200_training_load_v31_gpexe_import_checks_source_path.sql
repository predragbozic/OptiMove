-- Training Load v31 — a check records which credential path it read through
-- (F3c2g, owner decision Q1 of docs/ai/source-connections-f3c2g-discovery.md,
-- 2026-10-04): the audit of the transition from GPEXE_API_TOKEN to the source
-- connections is a durable fact of the check row, written in the same locked
-- INSERT that starts the check, final from creation like the GPEXE team of
-- v24 — never a log line alone.
--
-- What it adds to training_load.gpexe_import_checks (nothing else):
--   1. source_path            'legacy_env' (the environment token, a team that
--                              never had a source binding) or
--                              'source_connection' (the stored credential of the
--                              club's connection through the team's active
--                              binding). NOT NULL with DEFAULT 'legacy_env':
--                              every row from before v31 was written before the
--                              resolver existed, when the only path was the
--                              environment token, so the default IS the
--                              backfill, documented here and in the column
--                              comment; no UPDATE, no rewrite.
--   2. source_connection_id   the connection read through (FK, RESTRICT),
--      source_binding_id      the binding read through (FK, RESTRICT),
--      source_team_id         the bound source team id in canonical form,
--      source_host_key        the connection's host key at the time —
--                              all four NULL on the legacy path and all four
--                              present on the connection path (CHECK
--                              gpexe_import_checks_source_path_facts). Nothing
--                              of a credential, a token, a username or a URL.
--   3. a BEFORE INSERT trigger (gpexe_import_checks_source_facts): a row on the
--      connection path must name a binding that is ACTIVE, belongs to the
--      row's own team and to the named connection, is a gpexe binding,
--      carries that source team id, and whose connection speaks that host
--      key — the same facts the
--      application resolved under the team import lock a moment earlier, so a
--      raw INSERT cannot claim a path the data does not support. It holds the
--      team's import try-lock itself (v24 hold_gpexe_team_lock, reentrant for
--      the application and for v24's gpexe_import_checks_require_team, which
--      sorts before it by name) and reads two rows by primary key under it.
--   4. a BEFORE UPDATE trigger (gpexe_import_checks_freeze_source): the five
--      columns are final from creation — a check's path is what the row says.
--
-- No index on the two foreign-key columns: the referenced rows are never
-- deleted or re-keyed (v27 keeps binding rows for good; a connection with a
-- binding or a check cannot be deleted), so a referential scan is never needed
-- for anything bound, and no route reads checks by connection or binding. A
-- support query that needs one adds a partial index in its own migration.
--
-- Rollback: docs/runbooks/gpexe-import-checks-v31-rollback.sql (forward-safe:
-- it refuses under a later migration and while any row says
-- 'source_connection', because v30 cannot represent that evidence).

alter table training_load.gpexe_import_checks
  add column source_path text not null default 'legacy_env'
    constraint gpexe_import_checks_source_path_check
    check (source_path in ('legacy_env', 'source_connection')),
  add column source_connection_id uuid
    references training_load.source_credential_connections(id) on delete restrict,
  add column source_binding_id uuid
    references training_load.source_team_bindings(id) on delete restrict,
  add column source_team_id text
    constraint gpexe_import_checks_source_team_id_format
    check (source_team_id is null or source_team_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  add column source_host_key text
    constraint gpexe_import_checks_source_host_key_format
    check (source_host_key is null or source_host_key ~ '^[a-z0-9][a-z0-9_-]{0,30}$');

alter table training_load.gpexe_import_checks
  add constraint gpexe_import_checks_source_path_facts check (
    (source_path = 'legacy_env'
      and source_connection_id is null and source_binding_id is null
      and source_team_id is null and source_host_key is null)
    or
    (source_path = 'source_connection'
      and source_connection_id is not null and source_binding_id is not null
      and source_team_id is not null and source_host_key is not null)
  );

comment on column training_load.gpexe_import_checks.source_path is
  'F3c2g: which credential path the check read through — legacy_env (GPEXE_API_TOKEN; a team that never had a source binding) or source_connection (the club connection through the team''s active binding). Rows from before v31 default to legacy_env: the resolver did not exist, the environment token was the only path. Final from creation.';
comment on column training_load.gpexe_import_checks.source_connection_id is
  'F3c2g: the source connection the check read through (source_connection path only). Final from creation. Never a credential.';
comment on column training_load.gpexe_import_checks.source_binding_id is
  'F3c2g: the source binding the check read through (source_connection path only); active at the moment the row was written. Final from creation.';
comment on column training_load.gpexe_import_checks.source_team_id is
  'F3c2g: the bound source team id the check read, canonical form (source_connection path only). Final from creation.';
comment on column training_load.gpexe_import_checks.source_host_key is
  'F3c2g: the host key of the connection at the moment the row was written (source_connection path only). A key, never a URL. Final from creation.';

-- 3. The connection path names facts the data supports.
create function training_load.require_gpexe_check_source() returns trigger as $$
declare
  b record;
  c record;
begin
  if new.source_path = 'legacy_env' then
    return new;
  end if;
  -- The same team import try-lock every writer of these facts takes (v24
  -- hold_gpexe_team_lock; reentrant for the application, which already holds
  -- it): the two reads below cannot race a bind, an Unbind or a Reconnect,
  -- whatever order a future trigger sorts in.
  perform training_load.hold_gpexe_team_lock(new.owner_team_id, 'check source');
  select team_id, connection_id, source_team_id, state, source_system
    into b
    from training_load.source_team_bindings
   where id = new.source_binding_id;
  if b is null then
    raise exception 'gpexe_import_checks: check of team % names a source binding that does not exist', new.owner_team_id;
  end if;
  if b.source_system <> 'gpexe' then
    raise exception 'gpexe_import_checks: check of team % names a binding of another source than gpexe', new.owner_team_id;
  end if;
  if b.state <> 'active' then
    raise exception 'gpexe_import_checks: check of team % names a source binding that is not active', new.owner_team_id;
  end if;
  if b.team_id is distinct from new.owner_team_id then
    raise exception 'gpexe_import_checks: check of team % names a source binding of another team', new.owner_team_id;
  end if;
  if b.connection_id is distinct from new.source_connection_id then
    raise exception 'gpexe_import_checks: check of team % names a connection other than its binding''s', new.owner_team_id;
  end if;
  if b.source_team_id is distinct from new.source_team_id then
    raise exception 'gpexe_import_checks: check of team % names a source team other than its binding''s', new.owner_team_id;
  end if;
  select host_key, source_system
    into c
    from training_load.source_credential_connections
   where id = new.source_connection_id;
  if c is null then
    raise exception 'gpexe_import_checks: check of team % names a source connection that does not exist', new.owner_team_id;
  end if;
  if c.host_key is distinct from new.source_host_key then
    raise exception 'gpexe_import_checks: check of team % names a host key other than its connection''s', new.owner_team_id;
  end if;
  if c.source_system is distinct from b.source_system then
    raise exception 'gpexe_import_checks: check of team % names a connection of another source than its binding', new.owner_team_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_import_checks_source_facts
  before insert on training_load.gpexe_import_checks
  for each row execute function training_load.require_gpexe_check_source();

-- 4. The path is what the row says, for good.
create function training_load.freeze_gpexe_check_source() returns trigger as $$
begin
  if new.source_path is distinct from old.source_path
     or new.source_connection_id is distinct from old.source_connection_id
     or new.source_binding_id is distinct from old.source_binding_id
     or new.source_team_id is distinct from old.source_team_id
     or new.source_host_key is distinct from old.source_host_key then
    raise exception 'gpexe_import_checks: the credential path of check % is final', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_import_checks_freeze_source
  before update on training_load.gpexe_import_checks
  for each row execute function training_load.freeze_gpexe_check_source();
