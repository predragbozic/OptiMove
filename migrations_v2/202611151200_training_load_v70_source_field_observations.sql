-- Training Load v70 - the GPEXE field inventory (I1).
--
-- Plan: docs/ai/gpexe-field-inventory-plan.md sections 1, 5 and 6 (the owner's D-INV-1 and his answers Q1 and Q5,
-- 2026-11-15). Runbook: docs/runbooks/source-field-observations-v70.md.
--
-- What this migration changes (no existing row changes; nothing is written to a table):
--   1. training_load.source_field_observations: one row per (source connection, endpoint, field name) a succeeded check
--      saw in the answers it read - the NAME of a field only, its value-shape kind, the unit word the answer itself carried
--      (when it passes the unit-token rule), how many answers carried it, and the first and last check that saw it. Never a
--      value, an athlete id, a session id or a date of a session. rest_v1 only (Q5).
--   2. The writer: only the finalization of a running, connection-path check of that same connection, in its own
--      transaction (optimove.field_inventory_check = '<check uuid>:<xact id>', set by the service right before the write).
--      A raw write without it, or for another check or connection, is refused (42501).
--   3. Identity is final (connection, family, endpoint, name, first sighting); the counts and the last sighting only grow.
--      DELETE and TRUNCATE are refused: a name list with no personal data, kept for the club's choice (D-INV-1).
--
-- Not here: reading the rows (I2), the Source fields list (I3), "I want this" (I2), creating a source field (G1).
-- Order: after v69. Refuses to run without v31's check source facts, v40's unit-token rule, or when the table exists.
-- Rollback: docs/runbooks/source-field-observations-v70-rollback.sql (refuses once a row exists, or a later migration is
-- recorded).

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('training_load.gpexe_import_checks') is null or to_regclass('training_load.source_credential_connections') is null then
    raise exception 'v70 refused: v22 (the checks) or v27 (the source connections) is not applied' using errcode = '23514';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'training_load' and table_name = 'gpexe_import_checks' and column_name = 'source_connection_id') then
    raise exception 'v70 refused: v31 (a check''s source path facts) is not applied' using errcode = '23514';
  end if;
  if to_regprocedure('training_load.source_metric_unit_token_ok(text)') is null then
    raise exception 'v70 refused: v40''s training_load.source_metric_unit_token_ok(text) is missing' using errcode = '23514';
  end if;
  if to_regclass('training_load.source_field_observations') is not null then
    raise exception 'v70 refused: training_load.source_field_observations already exists' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table training_load.source_field_observations (
  id uuid primary key default gen_random_uuid(),
  source_connection_id uuid not null references training_load.source_credential_connections(id) on delete restrict,
  api_family text not null
    constraint source_field_observations_family_check check (api_family = 'rest_v1'),
  endpoint text not null
    constraint source_field_observations_endpoint_check
    check (endpoint in ('athlete_session', 'more.events', 'more.complementary_data', 'details.session', 'details.drill', 'team_thresholds')),
  field_name text not null
    constraint source_field_observations_name_check check (field_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'),
  value_kind text not null
    constraint source_field_observations_kind_check
    check (value_kind in ('number', 'text', 'boolean', 'null', 'unit_value_object', 'zone_list', 'object', 'list')),
  unit_word text
    constraint source_field_observations_unit_check check (unit_word is null or training_load.source_metric_unit_token_ok(unit_word)),
  answers_seen integer not null
    constraint source_field_observations_answers_check check (answers_seen >= 1),
  first_seen_check_id uuid not null references training_load.gpexe_import_checks(id) on delete restrict,
  last_seen_check_id uuid not null references training_load.gpexe_import_checks(id) on delete restrict,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint source_field_observations_seen_order check (last_seen_at >= first_seen_at),
  constraint source_field_observations_key unique (source_connection_id, endpoint, field_name)
);

comment on table training_load.source_field_observations is
  'I1: the names of the fields a source connection''s answers carried (never a value, an athlete or a session), written only by a succeeded check''s finalization (v70).';

-- ---------------------------------------------------------------------------
-- 2. The writer
-- ---------------------------------------------------------------------------
create function training_load.field_inventory_context_check() returns uuid as $$
declare
  raw text := current_setting('optimove.field_inventory_check', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    return null;
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql stable;

create function training_load.source_field_observations_guard() returns trigger as $$
declare
  v_check uuid := training_load.field_inventory_context_check();
  v_ok boolean;
begin
  if v_check is null or new.last_seen_check_id is distinct from v_check then
    raise exception 'source field observations are written only by a check''s finalization' using errcode = '42501';
  end if;
  select true into v_ok
    from training_load.gpexe_import_checks k
   where k.id = v_check and k.status = 'running' and k.source_path = 'source_connection'
     and k.source_connection_id = new.source_connection_id;
  if v_ok is not true then
    raise exception 'source field observations are written only for the running check of their connection' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.first_seen_check_id is distinct from v_check then
      raise exception 'a new source field observation is first seen by the check that writes it' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.source_connection_id is distinct from old.source_connection_id
     or new.api_family is distinct from old.api_family or new.endpoint is distinct from old.endpoint
     or new.field_name is distinct from old.field_name or new.first_seen_check_id is distinct from old.first_seen_check_id
     or new.first_seen_at is distinct from old.first_seen_at then
    raise exception 'a source field observation''s identity is final' using errcode = '23514';
  end if;
  if new.answers_seen < old.answers_seen or new.last_seen_at < old.last_seen_at then
    raise exception 'a source field observation''s counts and last sighting only grow' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_field_observations_guard
  before insert or update on training_load.source_field_observations
  for each row execute function training_load.source_field_observations_guard();

create function training_load.source_field_observations_keep() returns trigger as $$
begin
  raise exception 'source field observations are never deleted' using errcode = '23514';
end;
$$ language plpgsql;

create trigger source_field_observations_no_delete
  before delete on training_load.source_field_observations
  for each row execute function training_load.source_field_observations_keep();

create trigger source_field_observations_no_truncate
  before truncate on training_load.source_field_observations
  for each statement execute function training_load.source_field_observations_keep();
