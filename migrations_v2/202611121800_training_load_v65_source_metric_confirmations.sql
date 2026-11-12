-- v65: the stored two-athlete confirmation of a drag-and-drop mapping
-- (J18, C112; migration M-A of the contract).
--
-- Contract: docs/ai/c112-drag-mapping-contract.md (J18), sections 5.1-5.4,
-- 5.6, 5.8 and 15 (accepted by the owner as C113, 2026-11-04; the split into
-- M-A and M-B is the Rukovodilac's R1 of 2026-11-12). It adds:
--
--   * A check, before anything changes, that the four T8 bodies it replaces
--     are the ones in force (their md5: v52's source_metric_audit_row_ok and
--     source_metric_audit_actor_guard, v48's source_metric_audit_insert_guard,
--     v50's source_metric_audit_revision_guard) and that T8's action CHECK is
--     v34's text.
--   * training_load.source_metric_confirmations (T9): the act - who, when,
--     which club, team, binding and connection. Only the team_mapping shape
--     (a board save); the field_observation shape is 18-P's later migration.
--   * training_load.source_metric_confirmation_sessions (T9s): the stored
--     session the two athletes were read from - its candidate id (no foreign
--     key: a candidate that was never imported may be deleted), content hash,
--     session id, start, check and pair index. No athlete id.
--   * training_load.source_metric_confirmation_items (T9i): one row per
--     mapping version of the save, with copies of its facts and, for a row the
--     admin checked, the two athletes' raw and stored values, a random salt
--     and a digest. The values and the salt are the only removable columns.
--   * Their guards (the v35 / v48 pattern): the acting user, the derived
--     basis, the binding's club and connection, the check and candidate
--     facts, the T4 and T2b facts, append-only, the two removals, and the
--     deferred links at COMMIT.
--   * training_load.remove_expired_confirmation_values(p_limit): the removal
--     of values past their date, one bounded batch of whole confirmations,
--     under a purge marker bound to its transaction (C118).
--   * T8: the nullable confirmation_id, the actions mapping_confirmation,
--     confirmation_values_expired and confirmation_values_erased, their
--     shapes, one row per confirmation and action, and the four bodies.
--
-- NOT in this migration: the gate on a club admin's activation (M-B, with the
-- board's backend), T2b's observation columns and the observed acts (18-P),
-- any application code. Until M-B and the board's backend nothing writes
-- these tables.
--
-- Every existing line of the four bodies stays byte for byte; the new lines
-- sit between "-- M-A (J18) begin" and "-- M-A (J18) end".
--
-- No athlete id, GPEXE athlete id, name, date of birth or free text is stored.
-- Errors: an acting user who is not allowed raises 42501; every other explicit
-- refusal raises 23514; every message is fixed text without an id, a name or
-- a value. Every rule of T9i that can fail on a row holding values is refused
-- by its BEFORE trigger first, because PostgreSQL prints the whole failing row
-- for a failing CHECK; the table CHECKs behind them are backstops. A write
-- inside a savepoint is refused: every guard compares the xmin of the rows it
-- relies on with the transaction's own (v35).
--
-- The guards read the connection, the binding, the check and the candidate
-- with plain reads and never lock them, so an Unbind's order is never
-- inverted (v34's T5 trigger does the same for the v27 rows). The only row
-- locks they take are the acting user's rights rows, through v54's
-- source_metric_actor_basis (users first).
-- The foreign keys of T9 take FOR KEY SHARE
-- on the binding and the connection, as T5's foreign key to the binding
-- already does: a Reconnect's update of the connection (FOR NO KEY UPDATE)
-- neither blocks it nor waits for it, while an Unbind, which takes the binding
-- FOR UPDATE, and the foreign key's check wait for each other, exactly as a
-- T5 start and an Unbind already do (no new lock edge). Because the guard
-- reads the binding without a lock, the writer (18-3) holds the binding FOR
-- SHARE before its first write, as the contract's section 4.3 step 13 says.
--
-- Locks: T4 SHARE ROW EXCLUSIVE first (T9i's foreign key takes it anyway; the
-- writers' order is T4 -> T8). The new tables' foreign keys then take SHARE
-- ROW EXCLUSIVE on public.clubs, public.teams, public.users, the v27
-- connections and bindings, the import checks and T2b, each within the
-- runner's lock_timeout, the accepted risk of v34, v36, v48 and v53. Only
-- then, right before its own changes, T8 ACCESS EXCLUSIVE with NOWAIT: this
-- is the first migration that alters T8's table (a column, the action CHECK,
-- two CHECKs and an index), and a queued ACCESS EXCLUSIVE request would make
-- every mapping write and replay read wait behind it, so a busy T8 fails the
-- migration at once, nothing applied, the old instance serving. T8 is held
-- exclusively only for its own statements, never while the migration waits
-- for another table. T5 is neither changed nor locked. The preflight's
-- quiet-moment block is the gate.
--
-- Rollback: docs/runbooks/source-metric-confirmations-v65-rollback.sql (it
-- refuses once a confirmation or a row with a confirmation_id exists, when a
-- trigger of this migration is missing or disabled, and under a later
-- migration; it restores the four bodies and v34's CHECK byte for byte).
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to. The purge marker, like the actor setting, is no defence
-- against whoever controls the shared owner credentials or runs SQL through
-- the application's pool; it can only null values that are past their date.

-- ---------------------------------------------------------------------------
-- 0. The first lock, in the writers' order (T8's comes in section 8).
-- ---------------------------------------------------------------------------
lock table training_load.source_metric_mapping_versions in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. This migration is written on the bodies and the CHECK in force: refuse
--    any other.
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['source_metric_audit_row_ok', 'a43a63c2d248cbaf71302468429acb85', 'v52'],
    ['source_metric_audit_actor_guard', '94cf466bfa765a1a03f7d290a3ce154a', 'v52'],
    ['source_metric_audit_insert_guard', '157c1ba1be40aaaa6cf5884542919c11', 'v48'],
    ['source_metric_audit_revision_guard', '16c87e61856986987a4794412c9e6dc2', 'v50']];
  i integer;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v65 refused: the body in force of training_load.% is not %''s', expected[i][1], expected[i][3] using errcode = '23514';
    end if;
  end loop;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'training_load.source_metric_audit'::regclass and conname = 'source_metric_audit_action_check')
     is distinct from 'CHECK ((action = ANY (ARRAY[''source_metric_create''::text, ''source_metric_revision_create''::text, ''source_metric_unit_verified''::text, ''source_metric_meaning_verified''::text, ''source_metric_revision_activate''::text, ''source_metric_revision_retire''::text, ''source_metric_retire''::text, ''mapping_create''::text, ''mapping_version_create''::text, ''mapping_status''::text, ''mapping_version_replaced''::text, ''activation_start''::text, ''activation_end''::text, ''unit_conversion_create''::text, ''unit_conversion_retire''::text, ''source_instance_end''::text])))' then
    raise exception 'v65 refused: the action CHECK of training_load.source_metric_audit is not v34''s' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Small helpers.
-- ---------------------------------------------------------------------------
-- The acting user of this transaction, or NULL when no actor setting is
-- present. A present setting that is not valid (not canonical, or of another
-- transaction) raises 42501 through v35's reader: it is never "no actor".
create function training_load.source_metric_confirmation_actor_or_null() returns uuid as $$
declare
  raw text := current_setting('optimove.source_metric_actor', true);
begin
  if raw is null or raw = '' then
    return null;
  end if;
  return training_load.source_metric_context_actor();
end;
$$ language plpgsql;

-- The purge marker: the id of this transaction, set only by
-- remove_expired_confirmation_values and reset before it returns. A marker of
-- another transaction (a session-level or stale one) is not valid.
create function training_load.source_metric_confirmation_purge_marker_ok() returns boolean as $$
  select coalesce(current_setting('optimove.source_metric_confirmation_purge', true), '') = pg_current_xact_id()::text
$$ language sql volatile;

-- The display registry's closed lists (R5): what the GPEXE screen shows for a
-- column, and the unit the admin compared in. Only the three rules that have
-- evidence (docs/ai/gpexe-c97-unit-evidence.md); a new rule or unit is a new
-- migration with its own evidence and test.
create function training_load.source_metric_display_unit_ok(p_rule text, p_unit text) returns boolean
  language sql immutable as $$
    select coalesce(case p_rule
      when 'duration_mmss' then p_unit = 'mm:ss'
      when 'distance_m' then p_unit = 'm'
      when 'speed_kmh' then p_unit = 'km/h'
      else false end, false)
  $$;

-- A value that can be stored: a finite number.
create function training_load.source_metric_confirmation_number_ok(p numeric) returns boolean
  language sql immutable as $$
    select p is not null and p not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  $$;

-- ---------------------------------------------------------------------------
-- 3. T9: the act.
-- ---------------------------------------------------------------------------
create table training_load.source_metric_confirmations (
  id                        uuid primary key default gen_random_uuid(),
  operation_id              uuid not null
                              constraint source_metric_confirmations_operation_key unique,
  kind                      text not null
                              constraint source_metric_confirmations_kind_check check (kind = 'team_mapping'),
  owner_scope               text not null
                              constraint source_metric_confirmations_owner_scope_check check (owner_scope = 'club'),
  owner_club_id             uuid not null
                              constraint source_metric_confirmations_club_fk references public.clubs(id) on delete restrict,
  binding_id                uuid not null,
  team_id                   uuid not null
                              constraint source_metric_confirmations_team_fk references public.teams(id) on delete restrict,
  credential_connection_id  uuid not null
                              constraint source_metric_confirmations_connection_fk
                              references training_load.source_credential_connections(id) on delete restrict,
  confirmed_by_user_id      uuid not null
                              constraint source_metric_confirmations_user_fk references public.users(id) on delete restrict,
  confirmed_basis           text not null
                              constraint source_metric_confirmations_basis_check check (confirmed_basis in ('platform_admin', 'club_admin')),
  confirmed_at              timestamptz not null,
  attested                  boolean not null,
  display_registry_version  smallint not null
                              constraint source_metric_confirmations_registry_version_check check (display_registry_version > 0),
  values_expire_at          timestamptz not null,
  constraint source_metric_confirmations_binding_fk
    foreign key (binding_id, team_id) references training_load.source_team_bindings (id, team_id) on delete restrict,
  constraint source_metric_confirmations_expiry_check check (values_expire_at = confirmed_at + interval '2160 hours')
);

create index source_metric_confirmations_club_idx
  on training_load.source_metric_confirmations (owner_club_id, confirmed_at desc, id);
create index source_metric_confirmations_team_idx
  on training_load.source_metric_confirmations (team_id, confirmed_at desc, id);
create index source_metric_confirmations_binding_idx
  on training_load.source_metric_confirmations (binding_id, team_id);
create index source_metric_confirmations_connection_idx
  on training_load.source_metric_confirmations (credential_connection_id);
create index source_metric_confirmations_user_idx
  on training_load.source_metric_confirmations (confirmed_by_user_id);
create index source_metric_confirmations_expiry_idx
  on training_load.source_metric_confirmations (values_expire_at, id);

comment on table training_load.source_metric_confirmations is
  'v65 (J18, T9): one board save - who confirmed, when, for which club, team, binding and connection. Append-only; no athlete data, no free text. values_expire_at is confirmed_at plus 90 days (2160 hours, C118), set by the database.';

create function training_load.source_metric_confirmations_insert_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  bnd record;
  club uuid;
  basis text;
begin
  if new.confirmed_by_user_id is distinct from actor then
    raise exception 'source metric confirmation: the row names another user than the acting user' using errcode = '42501';
  end if;
  -- The time and the expiry are the database's, never the writer's.
  new.confirmed_at := clock_timestamp();
  new.values_expire_at := new.confirmed_at + interval '2160 hours';
  -- v27 rows, plain reads (an Unbind is never inverted).
  select connection_id, team_id, state into bnd
    from training_load.source_team_bindings where id = new.binding_id;
  if not found or bnd.state is distinct from 'active' then
    raise exception 'source_metric_confirmations: the team binding is not active' using errcode = '23514';
  end if;
  if bnd.team_id is distinct from new.team_id then
    raise exception 'source_metric_confirmations: the team is not the binding''s' using errcode = '23514';
  end if;
  if bnd.connection_id is distinct from new.credential_connection_id then
    raise exception 'source_metric_confirmations: the connection is not the binding''s' using errcode = '23514';
  end if;
  club := training_load.source_metric_binding_club(new.binding_id);
  if club is null or club is distinct from new.owner_club_id then
    raise exception 'source_metric_confirmations: the binding''s connection is not owned by the confirmation''s club' using errcode = '23514';
  end if;
  -- The basis the database derives for that club (v54: users first).
  basis := training_load.source_metric_actor_basis(actor, new.owner_club_id);
  if basis is null or new.confirmed_basis is distinct from basis then
    raise exception 'source metric confirmation: the acting user may not write this confirmation' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_confirmations_insert_guard
  before insert on training_load.source_metric_confirmations
  for each row execute function training_load.source_metric_confirmations_insert_guard();
create trigger source_metric_confirmations_append_only
  before update or delete on training_load.source_metric_confirmations
  for each row execute function training_load.source_metric_append_only();
create trigger source_metric_confirmations_no_truncate
  before truncate on training_load.source_metric_confirmations
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- 4. T9s: the stored session.
-- ---------------------------------------------------------------------------
create table training_load.source_metric_confirmation_sessions (
  confirmation_id        uuid not null
                           constraint source_metric_confirmation_sessions_confirmation_fk
                           references training_load.source_metric_confirmations(id) on delete restrict,
  session_ordinal        smallint not null
                           constraint source_metric_confirmation_sessions_ordinal_check check (session_ordinal = 1),
  candidate_id           uuid not null,
  candidate_bundle_hash  text not null
                           constraint source_metric_confirmation_sessions_hash_format check (candidate_bundle_hash ~ '^[0-9a-f]{64}$'),
  gpexe_team_session_id  text not null
                           constraint source_metric_confirmation_sessions_session_format check (gpexe_team_session_id ~ '^[0-9]{1,12}$'),
  session_started_at     timestamptz not null,
  check_id               uuid not null
                           constraint source_metric_confirmation_sessions_check_fk
                           references training_load.gpexe_import_checks(id) on delete restrict,
  team_id                uuid not null
                           constraint source_metric_confirmation_sessions_team_fk references public.teams(id) on delete restrict,
  pair_index             integer not null
                           constraint source_metric_confirmation_sessions_pair_check check (pair_index >= 0),
  constraint source_metric_confirmation_sessions_pkey primary key (confirmation_id, session_ordinal)
);

create index source_metric_confirmation_sessions_check_idx
  on training_load.source_metric_confirmation_sessions (check_id);
create index source_metric_confirmation_sessions_team_idx
  on training_load.source_metric_confirmation_sessions (team_id);
create index source_metric_confirmation_sessions_candidate_idx
  on training_load.source_metric_confirmation_sessions (candidate_id);

comment on table training_load.source_metric_confirmation_sessions is
  'v65 (J18, T9s): the stored session a confirmation read its two athletes from. candidate_id has no foreign key (a candidate that was never imported may be deleted); the start is copied so History never reads the candidate. A session, never a person: no athlete id.';

-- A confirmation row written in this transaction by the acting user (a row
-- written in a savepoint has another xmin and is refused). Returns the row.
create function training_load.source_metric_confirmation_of_this_transaction(p_confirmation uuid)
  returns training_load.source_metric_confirmations as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  conf training_load.source_metric_confirmations;
  written_in bigint;
begin
  select c.xmin::text::bigint into written_in from training_load.source_metric_confirmations c where c.id = p_confirmation;
  select c.* into conf from training_load.source_metric_confirmations c where c.id = p_confirmation;
  if conf.id is null or written_in is distinct from training_load.source_metric_current_xmin() then
    raise exception 'source_metric_confirmations: a row of a confirmation is written with its confirmation in the same transaction' using errcode = '23514';
  end if;
  if conf.confirmed_by_user_id is distinct from actor then
    raise exception 'source metric confirmation: the row belongs to another user''s confirmation' using errcode = '42501';
  end if;
  return conf;
end;
$$ language plpgsql;

create function training_load.source_metric_confirmation_sessions_insert_guard() returns trigger as $$
declare
  conf training_load.source_metric_confirmations := training_load.source_metric_confirmation_of_this_transaction(new.confirmation_id);
  chk record;
  cand record;
begin
  if new.team_id is distinct from conf.team_id then
    raise exception 'source_metric_confirmation_sessions: the session''s team is not the confirmation''s' using errcode = '23514';
  end if;
  -- The check and the candidate: plain reads, never a lock.
  select status, owner_team_id, source_binding_id into chk
    from training_load.gpexe_import_checks where id = new.check_id;
  if not found or chk.status is distinct from 'succeeded' or chk.owner_team_id is distinct from new.team_id then
    raise exception 'source_metric_confirmation_sessions: the check did not succeed for this team' using errcode = '23514';
  end if;
  if chk.source_binding_id is distinct from conf.binding_id then
    raise exception 'source_metric_confirmation_sessions: the check did not read through the confirmation''s binding' using errcode = '23514';
  end if;
  select owner_team_id, gpexe_team_session_id, session_started_at, bundle_hash, status, last_seen_check_id, import_undone_at into cand
    from training_load.gpexe_import_candidates where id = new.candidate_id;
  if not found or cand.owner_team_id is distinct from new.team_id then
    raise exception 'source_metric_confirmation_sessions: the candidate is not a stored session of this team' using errcode = '23514';
  end if;
  if cand.last_seen_check_id is distinct from new.check_id then
    raise exception 'source_metric_confirmation_sessions: the candidate was last seen by another check' using errcode = '23514';
  end if;
  if cand.bundle_hash is distinct from new.candidate_bundle_hash then
    raise exception 'source_metric_confirmation_sessions: the candidate''s content is not the one confirmed' using errcode = '23514';
  end if;
  if cand.status = 'superseded' then
    raise exception 'source_metric_confirmation_sessions: the candidate is superseded' using errcode = '23514';
  end if;
  if cand.import_undone_at is not null then
    raise exception 'source_metric_confirmation_sessions: the candidate is an undone import' using errcode = '23514';
  end if;
  if cand.gpexe_team_session_id is distinct from new.gpexe_team_session_id then
    raise exception 'source_metric_confirmation_sessions: the session id is not the candidate''s' using errcode = '23514';
  end if;
  if new.session_started_at is null or cand.session_started_at is distinct from new.session_started_at then
    raise exception 'source_metric_confirmation_sessions: the session''s start is not the candidate''s' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_confirmation_sessions_insert_guard
  before insert on training_load.source_metric_confirmation_sessions
  for each row execute function training_load.source_metric_confirmation_sessions_insert_guard();
create trigger source_metric_confirmation_sessions_append_only
  before update or delete on training_load.source_metric_confirmation_sessions
  for each row execute function training_load.source_metric_append_only();
create trigger source_metric_confirmation_sessions_no_truncate
  before truncate on training_load.source_metric_confirmation_sessions
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- 5. T9i: the rows and their values.
-- ---------------------------------------------------------------------------
create table training_load.source_metric_confirmation_items (
  id                         uuid primary key default gen_random_uuid(),
  confirmation_id            uuid not null,
  session_ordinal            smallint not null,
  item_no                    smallint not null
                               constraint source_metric_confirmation_items_item_no_check check (item_no > 0),
  item_kind                  text not null
                               constraint source_metric_confirmation_items_kind_check check (item_kind in ('club_mapping', 'system_mapping')),
  checked                    boolean not null,
  source_metric_version_id   uuid not null
                               constraint source_metric_confirmation_items_revision_fk
                               references training_load.source_metric_definition_versions(id) on delete restrict,
  mapping_version_id         uuid not null
                               constraint source_metric_confirmation_items_version_fk
                               references training_load.source_metric_mapping_versions(id) on delete restrict,
  parameter_fingerprint      text not null,
  source_unit                text not null,
  target_unit                text not null,
  scale                      numeric not null,
  scale_divisor              numeric not null,
  "offset"                   numeric not null,
  compared_level             text not null
                               constraint source_metric_confirmation_items_level_check check (compared_level = 'session'),
  gpexe_display_rule         text,
  gpexe_display_unit         text,
  raw_a                      numeric,
  stored_a                   numeric,
  raw_b                      numeric,
  stored_b                   numeric,
  values_salt                bytea,
  values_digest              text
                               constraint source_metric_confirmation_items_digest_format
                               check (values_digest is null or values_digest ~ '^[0-9a-f]{64}$'),
  values_removed_at          timestamptz,
  values_removed_kind        text
                               constraint source_metric_confirmation_items_removed_kind_check
                               check (values_removed_kind is null or values_removed_kind in ('expired', 'erased')),
  values_removed_by_user_id  uuid
                               constraint source_metric_confirmation_items_removed_by_fk references public.users(id) on delete restrict,
  constraint source_metric_confirmation_items_session_fk
    foreign key (confirmation_id, session_ordinal)
    references training_load.source_metric_confirmation_sessions (confirmation_id, session_ordinal) on delete restrict,
  constraint source_metric_confirmation_items_item_key unique (confirmation_id, item_no),
  constraint source_metric_confirmation_items_version_key unique (confirmation_id, mapping_version_id),
  -- Backstops: the BEFORE triggers refuse each of these first, with a fixed
  -- message (a failing CHECK prints the whole row, values included).
  constraint source_metric_confirmation_items_system_unchecked check (item_kind = 'club_mapping' or not checked),
  constraint source_metric_confirmation_items_display_iff check (
    (checked and gpexe_display_rule is not null and gpexe_display_unit is not null
       and gpexe_display_rule ~ '^[a-z_]{1,40}$'
       and training_load.source_metric_display_unit_ok(gpexe_display_rule, gpexe_display_unit))
    or (not checked and gpexe_display_rule is null and gpexe_display_unit is null)),
  constraint source_metric_confirmation_items_digest_iff check (checked = (values_digest is not null)),
  constraint source_metric_confirmation_items_values_together check (
    num_nonnulls(raw_a, stored_a, raw_b, stored_b, values_salt) in (0, 5)),
  constraint source_metric_confirmation_items_values_iff check (
    (raw_a is not null) = (checked and values_removed_at is null)),
  constraint source_metric_confirmation_items_salt_length check (values_salt is null or octet_length(values_salt) = 16),
  constraint source_metric_confirmation_items_values_distinct check (
    raw_a is null or (training_load.source_metric_confirmation_number_ok(raw_a)
                      and training_load.source_metric_confirmation_number_ok(raw_b)
                      and raw_a <> 0 and raw_b <> 0 and raw_a <> raw_b)),
  constraint source_metric_confirmation_items_values_converted check (
    raw_a is null or (training_load.source_metric_value_matches(raw_a, stored_a, scale, scale_divisor, "offset")
                      and training_load.source_metric_value_matches(raw_b, stored_b, scale, scale_divisor, "offset"))),
  constraint source_metric_confirmation_items_removed_together check (
    (values_removed_at is null) = (values_removed_kind is null)),
  constraint source_metric_confirmation_items_removed_checked check (values_removed_at is null or checked),
  constraint source_metric_confirmation_items_removed_by_check check (
    values_removed_by_user_id is null or values_removed_at is not null),
  constraint source_metric_confirmation_items_erased_by_check check (
    values_removed_kind is distinct from 'erased' or values_removed_by_user_id is not null)
);

-- M-B's gate looks a version's checked row up by the version.
create index source_metric_confirmation_items_version_idx
  on training_load.source_metric_confirmation_items (mapping_version_id, confirmation_id);
create index source_metric_confirmation_items_revision_idx
  on training_load.source_metric_confirmation_items (source_metric_version_id);
create index source_metric_confirmation_items_removed_by_idx
  on training_load.source_metric_confirmation_items (values_removed_by_user_id) where values_removed_by_user_id is not null;
-- The removal function's scan: the rows that still hold values.
create index source_metric_confirmation_items_holding_idx
  on training_load.source_metric_confirmation_items (confirmation_id) where checked and values_removed_at is null;

comment on table training_load.source_metric_confirmation_items is
  'v65 (J18, T9i): one row per mapping version of a confirmation, with copies of its facts and, for a row the admin checked, two athletes'' raw and stored values, a random salt and a digest. The values and the salt are removed 90 days after the confirmation, or erased earlier by a platform admin; the digest and the facts stay. No athlete id, name or free text.';

-- The digest of a checked row: SHA-256 over the salt and the canonical text of
-- the row's facts and values. Core functions only (sha256, no pgcrypto).
create function training_load.source_metric_confirmation_item_digest(i training_load.source_metric_confirmation_items) returns text
  language sql immutable as $$
    select encode(sha256(i.values_salt || convert_to(concat_ws('|',
      i.confirmation_id::text, i.item_no::text, i.item_kind, i.mapping_version_id::text, i.source_metric_version_id::text,
      i.parameter_fingerprint, i.source_unit, i.target_unit, i.scale::text, i.scale_divisor::text, i."offset"::text,
      i.gpexe_display_rule, i.gpexe_display_unit,
      i.raw_a::text, i.stored_a::text, i.raw_b::text, i.stored_b::text), 'UTF8')), 'hex')
  $$;

create function training_load.source_metric_confirmation_items_insert_guard() returns trigger as $$
declare
  conf training_load.source_metric_confirmations := training_load.source_metric_confirmation_of_this_transaction(new.confirmation_id);
  ver record;
  rev record;
begin
  -- Before anything else that could fail on a row holding values: the three
  -- columns no other rule below reads (a NOT NULL or CHECK failure would
  -- print the row).
  if new.id is null or new.session_ordinal is null or new.item_no is null or new.item_no <= 0 then
    raise exception 'source_metric_confirmation_items: a row names its id, its session and a positive number' using errcode = '23514';
  end if;
  if new.values_removed_at is not null or new.values_removed_kind is not null or new.values_removed_by_user_id is not null then
    raise exception 'source_metric_confirmation_items: a row is created with no removal' using errcode = '23514';
  end if;
  if new.compared_level is distinct from 'session' then
    raise exception 'source_metric_confirmation_items: the two athletes are compared at the session level' using errcode = '23514';
  end if;
  -- The T4 version and its T2b revision: plain reads (the writer holds their
  -- locks; a guard takes none).
  select owner_key, source_metric_version_id, parameter_fingerprint, source_unit, target_unit, scale, scale_divisor, "offset" into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id;
  if not found then
    raise exception 'source_metric_confirmation_items: the row names no mapping version' using errcode = '23514';
  end if;
  if new.item_kind = 'club_mapping' then
    if ver.owner_key is distinct from conf.owner_club_id::text then
      raise exception 'source_metric_confirmation_items: a club row names a mapping version of the confirmation''s club' using errcode = '23514';
    end if;
  elsif new.item_kind = 'system_mapping' then
    if ver.owner_key is distinct from 'system' then
      raise exception 'source_metric_confirmation_items: a system row names a system mapping version' using errcode = '23514';
    end if;
    if new.checked then
      raise exception 'source_metric_confirmation_items: a system mapping is not compared' using errcode = '23514';
    end if;
  else
    raise exception 'source_metric_confirmation_items: the row''s kind is not one of this table''s' using errcode = '23514';
  end if;
  if new.source_metric_version_id is distinct from ver.source_metric_version_id
     or new.parameter_fingerprint is distinct from ver.parameter_fingerprint
     or new.source_unit is distinct from ver.source_unit or new.target_unit is distinct from ver.target_unit
     or new.scale::text is distinct from ver.scale::text or new.scale_divisor::text is distinct from ver.scale_divisor::text
     or new."offset"::text is distinct from ver."offset"::text then
    raise exception 'source_metric_confirmation_items: the row''s facts are not the mapping version''s' using errcode = '23514';
  end if;
  select state, evidence_status, source_unit into rev
    from training_load.source_metric_definition_versions where id = new.source_metric_version_id;
  if rev.state is distinct from 'active' or rev.evidence_status is distinct from 'verified' then
    raise exception 'source_metric_confirmation_items: the source revision must be active and verified' using errcode = '23514';
  end if;
  if rev.source_unit is distinct from new.source_unit then
    raise exception 'source_metric_confirmation_items: the source unit is not the revision''s proven unit' using errcode = '23514';
  end if;
  -- The salt and the digest are the database's: whatever the writer sent is
  -- overwritten below.
  new.values_salt := null;
  new.values_digest := null;
  if new.checked is distinct from true then
    if new.checked is null then
      raise exception 'source_metric_confirmation_items: a row says whether it was compared' using errcode = '23514';
    end if;
    if new.raw_a is not null or new.stored_a is not null or new.raw_b is not null or new.stored_b is not null
       or new.gpexe_display_rule is not null or new.gpexe_display_unit is not null then
      raise exception 'source_metric_confirmation_items: a row that was not compared stores no values and no display unit' using errcode = '23514';
    end if;
    return new;
  end if;
  -- A checked row. Every refusal below is fixed text: the row holds values.
  if new.gpexe_display_rule is null or new.gpexe_display_unit is null
     or new.gpexe_display_rule !~ '^[a-z_]{1,40}$'
     or not training_load.source_metric_display_unit_ok(new.gpexe_display_rule, new.gpexe_display_unit) then
    raise exception 'source_metric_confirmation_items: a compared row names a display rule and a unit of that rule' using errcode = '23514';
  end if;
  if not training_load.source_metric_confirmation_number_ok(new.raw_a) or not training_load.source_metric_confirmation_number_ok(new.raw_b)
     or not training_load.source_metric_confirmation_number_ok(new.stored_a) or not training_load.source_metric_confirmation_number_ok(new.stored_b) then
    raise exception 'source_metric_confirmation_items: a compared row stores four finite values' using errcode = '23514';
  end if;
  if new.raw_a = 0 or new.raw_b = 0 or new.raw_a = new.raw_b then
    raise exception 'source_metric_confirmation_items: the two athletes'' values are non-zero and different' using errcode = '23514';
  end if;
  if not training_load.source_metric_value_matches(new.raw_a, new.stored_a, new.scale, new.scale_divisor, new."offset")
     or not training_load.source_metric_value_matches(new.raw_b, new.stored_b, new.scale, new.scale_divisor, new."offset") then
    raise exception 'source_metric_confirmation_items: a stored value is not the conversion of its raw value' using errcode = '23514';
  end if;
  -- 16 random bytes (gen_random_uuid is core; 122 of its bits are random).
  new.values_salt := uuid_send(gen_random_uuid());
  new.values_digest := training_load.source_metric_confirmation_item_digest(new);
  return new;
end;
$$ language plpgsql;

-- The only change a row ever takes: the removal of its values and its salt.
create function training_load.source_metric_confirmation_items_update_guard() returns trigger as $$
declare
  actor uuid;
  expires timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_confirmation_items: a row is never deleted' using errcode = '23514';
  end if;
  -- The right first: the acting user, or none. A present but invalid setting
  -- raises 42501; an acting user who is not an active platform admin changes
  -- nothing here, whatever the change.
  actor := training_load.source_metric_confirmation_actor_or_null();
  if actor is not null and training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
    raise exception 'source metric confirmation: the acting user may not remove these values' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.confirmation_id is distinct from old.confirmation_id
     or new.session_ordinal is distinct from old.session_ordinal or new.item_no is distinct from old.item_no
     or new.item_kind is distinct from old.item_kind or new.checked is distinct from old.checked
     or new.source_metric_version_id is distinct from old.source_metric_version_id
     or new.mapping_version_id is distinct from old.mapping_version_id
     or new.parameter_fingerprint is distinct from old.parameter_fingerprint
     or new.source_unit is distinct from old.source_unit or new.target_unit is distinct from old.target_unit
     or new.scale::text is distinct from old.scale::text or new.scale_divisor::text is distinct from old.scale_divisor::text
     or new."offset"::text is distinct from old."offset"::text or new.compared_level is distinct from old.compared_level
     or new.gpexe_display_rule is distinct from old.gpexe_display_rule or new.gpexe_display_unit is distinct from old.gpexe_display_unit
     or new.values_digest is distinct from old.values_digest then
    raise exception 'source_metric_confirmation_items: only the values of a row are removed' using errcode = '23514';
  end if;
  if old.checked is distinct from true or old.values_removed_at is not null then
    raise exception 'source_metric_confirmation_items: the row holds no values to remove' using errcode = '23514';
  end if;
  if new.raw_a is not null or new.stored_a is not null or new.raw_b is not null or new.stored_b is not null
     or new.values_salt is not null then
    raise exception 'source_metric_confirmation_items: a removal nulls the four values and the salt together' using errcode = '23514';
  end if;
  if new.values_removed_kind is null or new.values_removed_kind not in ('expired', 'erased') then
    raise exception 'source_metric_confirmation_items: a removal is expired or erased' using errcode = '23514';
  end if;
  if new.values_removed_kind = 'expired' then
    select values_expire_at into expires from training_load.source_metric_confirmations where id = old.confirmation_id;
    if expires is null or expires > now() then
      raise exception 'source_metric_confirmation_items: the values are not past their date' using errcode = '23514';
    end if;
    if not training_load.source_metric_confirmation_purge_marker_ok() then
      raise exception 'source_metric_confirmation_items: expired values are removed only by the removal function' using errcode = '23514';
    end if;
  elsif actor is null then
    -- An erasure always has an acting user (a platform admin, checked above).
    raise exception 'source metric confirmation: the acting user may not remove these values' using errcode = '42501';
  end if;
  -- The record of the removal is the database's, never the writer's.
  new.values_removed_at := clock_timestamp();
  new.values_removed_by_user_id := actor;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_confirmation_items_insert_guard
  before insert on training_load.source_metric_confirmation_items
  for each row execute function training_load.source_metric_confirmation_items_insert_guard();
create trigger source_metric_confirmation_items_update_guard
  before update or delete on training_load.source_metric_confirmation_items
  for each row execute function training_load.source_metric_confirmation_items_update_guard();
create trigger source_metric_confirmation_items_no_truncate
  before truncate on training_load.source_metric_confirmation_items
  for each statement execute function training_load.source_metric_no_truncate();

-- ---------------------------------------------------------------------------
-- 6. The removal of expired values (C118): one bounded batch of whole
--    confirmations. With no acting user it writes no T8 row (the removal
--    columns are the record); with one (route 7) the caller writes them.
-- ---------------------------------------------------------------------------
create function training_load.remove_expired_confirmation_values(p_limit integer) returns uuid[] as $$
declare
  ids uuid[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'remove_expired_confirmation_values: the limit is between 1 and 1000' using errcode = '23514';
  end if;
  perform set_config('optimove.source_metric_confirmation_purge', pg_current_xact_id()::text, true);
  select coalesce(array_agg(q.id), '{}') into ids
    from (select c.id
            from training_load.source_metric_confirmations c
           where c.values_expire_at <= now()
             and exists (select 1 from training_load.source_metric_confirmation_items i
                          where i.confirmation_id = c.id and i.checked and i.values_removed_at is null)
           order by c.values_expire_at, c.id
           limit p_limit
             for update of c skip locked) q;
  update training_load.source_metric_confirmation_items i
     set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_salt = null, values_removed_kind = 'expired'
   where i.confirmation_id = any (ids) and i.checked and i.values_removed_at is null;
  perform set_config('optimove.source_metric_confirmation_purge', '', true);
  return ids;
end;
$$ language plpgsql;

comment on function training_load.remove_expired_confirmation_values(integer) is
  'v65 (J18, C118): nulls the values and the salt of at most p_limit confirmations past their values_expire_at, skipping a confirmation another transaction holds; returns their ids, never a value.';

-- ---------------------------------------------------------------------------
-- 7. At COMMIT (deferred): a confirmation is whole, and an acting user''s
--    removal has its audit row.
-- ---------------------------------------------------------------------------
-- The rows of a confirmation against its activations and its attested flag.
create function training_load.source_metric_confirmation_rows_hold(p_confirmation uuid) returns void as $$
declare
  here bigint := training_load.source_metric_current_xmin();
  conf record;
begin
  select binding_id, confirmed_by_user_id, attested into conf from training_load.source_metric_confirmations where id = p_confirmation;
  if exists (select 1 from training_load.source_metric_confirmation_items i
              where i.confirmation_id = p_confirmation
                and (not exists (select 1 from training_load.source_metric_mapping_versions v
                                  where v.id = i.mapping_version_id and v.status = 'active')
                     or not exists (select 1 from training_load.source_metric_mapping_activations a
                                     where a.mapping_version_id = i.mapping_version_id
                                       and a.source_team_binding_id = conf.binding_id and a.ended_at is null
                                       and a.activated_by_user_id = conf.confirmed_by_user_id
                                       and a.xmin::text::bigint = here))) then
    raise exception 'source_metric_confirmations: every row''s mapping version is active and switched on for the binding in this transaction' using errcode = '23514';
  end if;
  if conf.attested is distinct from exists (select 1 from training_load.source_metric_confirmation_items i
                                             where i.confirmation_id = p_confirmation and i.checked) then
    raise exception 'source_metric_confirmations: a confirmation is attested exactly when a row was compared' using errcode = '23514';
  end if;
end;
$$ language plpgsql;

create function training_load.source_metric_confirmations_commit_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit a
                  where a.action = 'mapping_confirmation' and a.confirmation_id = new.id
                    and a.operation_id = new.operation_id and a.performed_by_user_id = new.confirmed_by_user_id
                    and a.request_key is not null) then
    raise exception 'source_metric_confirmations: a confirmation is written with its keyed mapping_confirmation audit row' using errcode = '23514';
  end if;
  if (select count(*) from training_load.source_metric_confirmation_sessions s where s.confirmation_id = new.id) <> 1 then
    raise exception 'source_metric_confirmations: a team''s confirmation has exactly one session' using errcode = '23514';
  end if;
  if not exists (select 1 from training_load.source_metric_confirmation_items i where i.confirmation_id = new.id) then
    raise exception 'source_metric_confirmations: a confirmation has at least one row' using errcode = '23514';
  end if;
  perform training_load.source_metric_confirmation_rows_hold(new.id);
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_confirmations_commit_link
  after insert on training_load.source_metric_confirmations
  deferrable initially deferred
  for each row execute function training_load.source_metric_confirmations_commit_link();

-- Each row is checked at COMMIT too, so a row added after the confirmation's
-- own link was forced early (SET CONSTRAINTS ... IMMEDIATE) is still held to
-- the same rules.
create function training_load.source_metric_confirmation_items_commit_link() returns trigger as $$
begin
  perform training_load.source_metric_confirmation_rows_hold(new.confirmation_id);
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_confirmation_items_commit_link
  after insert on training_load.source_metric_confirmation_items
  deferrable initially deferred
  for each row execute function training_load.source_metric_confirmation_items_commit_link();

create function training_load.source_metric_confirmation_items_removal_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit a
                  where a.action = (case new.values_removed_kind when 'expired' then 'confirmation_values_expired' else 'confirmation_values_erased' end)
                    and a.confirmation_id = new.confirmation_id
                    and a.performed_by_user_id = new.values_removed_by_user_id
                    and a.xmin::text::bigint = training_load.source_metric_current_xmin()) then
    raise exception 'source_metric_confirmation_items: an acting user''s removal of values is written with its audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_confirmation_items_removal_link
  after update on training_load.source_metric_confirmation_items
  deferrable initially deferred
  for each row
  when (old.values_removed_at is null and new.values_removed_at is not null and new.values_removed_by_user_id is not null)
  execute function training_load.source_metric_confirmation_items_removal_link();

-- ---------------------------------------------------------------------------
-- 8. T8: the typed link to a confirmation, the three actions, once each.
-- ---------------------------------------------------------------------------
lock table training_load.source_metric_audit in access exclusive mode nowait;

alter table training_load.source_metric_audit
  add column confirmation_id uuid
    constraint source_metric_audit_confirmation_fk
    references training_load.source_metric_confirmations(id) on delete restrict,
  drop constraint source_metric_audit_action_check,
  add constraint source_metric_audit_action_check check (action in (
    'source_metric_create', 'source_metric_revision_create', 'source_metric_unit_verified',
    'source_metric_meaning_verified', 'source_metric_revision_activate', 'source_metric_revision_retire',
    'source_metric_retire', 'mapping_create', 'mapping_version_create', 'mapping_status',
    'mapping_version_replaced', 'activation_start', 'activation_end', 'unit_conversion_create',
    'unit_conversion_retire', 'source_instance_end',
    'mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased')),
  add constraint source_metric_audit_confirmation_iff check (
    (confirmation_id is not null)
    = (action in ('mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased'))),
  add constraint source_metric_audit_erased_reason_check check (
    action <> 'confirmation_values_erased' or reason in ('erasure_request', 'wrong_confirmation'));

-- Once per confirmation and action (the revision guard refuses a second one
-- first, with its own message); also the index of the foreign key.
create unique index source_metric_audit_v65_confirmation_once
  on training_load.source_metric_audit (confirmation_id, action)
  where confirmation_id is not null;

comment on table training_load.source_metric_audit is
  'v34 (D10, T8): append-only record of every source metric, mapping, activation, unit conversion and source instance operation, and from v65 of every confirmation and of an acting user''s removal of its values. No metadata column; reason and evidence_ref are bounded, format-checked and never name an athlete or carry a value; confirmation_id is a typed link, never a value.';

-- ---------------------------------------------------------------------------
-- 9. T8's four bodies. Every line outside the M-A marks is the body's in force.
-- ---------------------------------------------------------------------------
-- 9a. The row shape (v52's body; three new actions).
create or replace function training_load.source_metric_audit_row_ok(
  p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text) returns boolean
  language sql immutable as $$
    select coalesce(case p_action
      when 'source_metric_create' then
        p_targets = '10000000' and p_from is null and p_to = 'active' and p_basis = 'platform_admin'
      when 'source_metric_retire' then
        p_targets = '10000000' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_metric_revision_create' then
        p_targets = '11000000' and p_from is null and p_to = 'draft' and p_basis = 'platform_admin'
      when 'source_metric_unit_verified' then
        p_targets = '11000000' and p_from is null and p_to is null and p_evidence is not null and p_basis = 'platform_admin'
      when 'source_metric_meaning_verified' then
        p_targets = '11000000' and p_from is null and p_to is null and p_evidence is not null and p_basis = 'platform_admin'
      when 'source_metric_revision_activate' then
        p_targets = '11000000' and p_from = 'draft' and p_to = 'active' and p_basis = 'platform_admin'
      when 'source_metric_revision_retire' then
        p_targets = '11000000' and p_from in ('draft', 'active') and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'mapping_create' then
        p_targets = '00100000' and p_from is null and p_to is null and p_basis in ('platform_admin', 'club_admin')
      when 'mapping_version_create' then
        p_targets = '00110000' and p_from is null and p_to = 'draft' and p_basis in ('platform_admin', 'club_admin')
      when 'mapping_status' then
        p_targets = '00110000' and (
             (p_from = 'draft' and p_to = 'needs_review' and p_basis in ('platform_admin', 'club_admin'))
          or (p_from = 'needs_review' and p_to = 'active' and p_basis in ('platform_admin', 'club_admin'))
          or (p_from in ('draft', 'needs_review', 'active') and p_to = 'disabled' and p_reason is not null and p_basis in ('platform_admin', 'club_admin')))
      when 'mapping_version_replaced' then
        p_targets = '00110000' and p_from = 'needs_review' and p_to = 'active' and p_reason is not null and p_basis in ('platform_admin', 'club_admin')
      when 'activation_start' then
        p_targets = '00011001' and p_from is null and p_to is null and p_reason is not null and p_basis in ('platform_admin', 'club_admin')
      when 'activation_end' then
        p_targets = '00011001' and p_from is null and p_to is null and p_basis in ('platform_admin', 'club_admin')
      when 'unit_conversion_create' then
        p_targets = '00000100' and p_from is null and p_to = 'active' and p_evidence is not null and p_basis = 'platform_admin'
      when 'unit_conversion_retire' then
        p_targets = '00000100' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_instance_end' then
        p_targets in ('00000010', '00000011') and p_from = 'active' and p_to = 'inactive' and p_reason is not null and p_basis = 'platform_admin'
      -- M-A (J18) begin
      when 'mapping_confirmation' then
        p_targets = '00000001' and p_from is null and p_to is null and p_reason is null and p_evidence is null and p_basis in ('platform_admin', 'club_admin')
      when 'confirmation_values_expired' then
        p_targets = '00000000' and p_from is null and p_to is null and p_reason is null and p_evidence is null and p_basis = 'platform_admin'
      when 'confirmation_values_erased' then
        p_targets = '00000000' and p_from is null and p_to is null and p_reason is not null and p_evidence is null and p_basis = 'platform_admin'
      -- M-A (J18) end
      else false end, false)
  $$;

-- 9b. The insert guard (v48's body; a club-admin confirmation row).
create or replace function training_load.source_metric_audit_insert_guard() returns trigger as $$
begin
  if new.basis = 'club_admin' then
    if new.action in ('activation_start', 'activation_end') then
      -- v48 (C106): a club-admin activation row names its club through its
      -- activation's binding (the connection's owner club), never through the
      -- team or a mapping.
      if training_load.source_metric_binding_club(
           (select source_team_binding_id from training_load.source_metric_mapping_activations where id = new.activation_id)) is null then
        raise exception 'source_metric_audit: a club-admin activation row names an activation on a club''s binding' using errcode = '23514';
      end if;
    -- M-A (J18) begin
    elsif new.action = 'mapping_confirmation' then
      -- A club-admin confirmation row names its club through its confirmation,
      -- never through a mapping.
      if not exists (select 1 from training_load.source_metric_confirmations
                      where id = new.confirmation_id and owner_scope = 'club' and owner_club_id is not null) then
        raise exception 'source_metric_audit: a club-admin confirmation row names a club''s confirmation' using errcode = '23514';
      end if;
    -- M-A (J18) end
    elsif not exists (
         select 1 from training_load.source_metric_mappings where id = new.mapping_id and owner_scope = 'club') then
      raise exception 'source_metric_audit: a club-admin row names a club mapping' using errcode = '23514';
    end if;
  end if;
  if new.activation_id is not null and not exists (
       select 1 from training_load.source_metric_mapping_activations
        where id = new.activation_id and mapping_version_id = new.mapping_version_id and team_id = new.team_id) then
    raise exception 'source_metric_audit: an activation row must name its own mapping version and team' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- 9c. The actor guard (v52's body; the basis of a confirmation row).
create or replace function training_load.source_metric_audit_actor_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  map record;
  ver record;
  basis text;
  activation record;
  club uuid;
begin
  if new.performed_by_user_id is distinct from actor then
    raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
  end if;
  if new.action in ('activation_start', 'activation_end') then
    -- v48 (C106): the basis derived as the activation's own write derived it -
    -- for the binding's club on a start and an admin_ended end; for an end
    -- written by a version's replacement or disable, as v52's T5 guard
    -- derives it (J14 section 2.4), with the same backstop.
    select source_team_binding_id, end_reason, mapping_id into activation
      from training_load.source_metric_mapping_activations where id = new.activation_id;
    if not found then
      raise exception 'source metric activation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    if new.action = 'activation_end' and activation.end_reason in ('mapping_version_replaced', 'mapping_version_disabled') then
      basis := training_load.source_metric_actor_basis(actor, null);
      if basis is null then
        select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = activation.mapping_id;
        if map.owner_scope = 'club' then
          if training_load.source_metric_binding_club(activation.source_team_binding_id) is distinct from map.owner_club_id then
            raise exception 'source_metric_mapping_activations: a club version''s activation is on another club''s binding' using errcode = '23514';
          end if;
          basis := training_load.source_metric_actor_basis(actor, map.owner_club_id);
        end if;
      end if;
    else
      club := training_load.source_metric_binding_club(activation.source_team_binding_id);
      basis := case when club is null then null else training_load.source_metric_actor_basis(actor, club) end;
    end if;
    if basis is null or new.basis is distinct from basis then
      raise exception 'source metric activation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    return new;
  end if;
  -- M-A (J18) begin
  if new.action = 'mapping_confirmation' then
    -- The basis derived for the confirmation's club, as the confirmation's own
    -- insert derived it. The two removal actions stay with "every other
    -- action" below: an active platform admin.
    select owner_club_id into club from training_load.source_metric_confirmations where id = new.confirmation_id;
    if not found then
      raise exception 'source metric confirmation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    basis := training_load.source_metric_actor_basis(actor, club);
    if basis is null or new.basis is distinct from basis then
      raise exception 'source metric confirmation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    return new;
  end if;
  -- M-A (J18) end
  if new.action not in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced') then
    -- Every other action: an active platform admin; its chain comes with the
    -- PR that writes it.
    if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' or new.basis is distinct from 'platform_admin' then
      raise exception 'source metric mapping: the acting user may not write this audit row' using errcode = '42501';
    end if;
    return new;
  end if;
  select owner_scope, owner_club_id, created_by_user_id, xmin::text::bigint as written_in into map
    from training_load.source_metric_mappings where id = new.mapping_id for share;
  if not found then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  basis := training_load.source_metric_actor_basis(actor, case when map.owner_scope = 'club' then map.owner_club_id end);
  if basis is null then
    raise exception 'source metric mapping: the acting user may not write this mapping' using errcode = '42501';
  end if;
  if new.basis is distinct from basis then
    raise exception 'source metric mapping: the basis is not the acting user''s own' using errcode = '42501';
  end if;
  if new.action = 'mapping_create' then
    if map.written_in is distinct from here or map.created_by_user_id is distinct from actor then
      raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit where action = 'mapping_create' and mapping_id = new.mapping_id) then
      raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;
  select status, created_by_user_id, submitted_by_user_id, submitted_basis, activated_by_user_id, activated_basis,
         disabled_by_user_id, disabled_basis, xmin::text::bigint as written_in into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id and mapping_id = new.mapping_id;
  if not found or ver.written_in is distinct from here then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  if new.action = 'mapping_version_create' then
    if ver.status is distinct from 'draft' or ver.created_by_user_id is distinct from actor then
      raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'mapping_version_create' and mapping_version_id = new.mapping_version_id) then
      raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;
  -- mapping_status / mapping_version_replaced: the version's current status is
  -- the transition's target, written by this user with this basis.
  if ver.status is distinct from new.to_status
     or (new.to_status = 'needs_review' and (ver.submitted_by_user_id, ver.submitted_basis) is distinct from (actor, new.basis))
     or (new.to_status = 'active' and (ver.activated_by_user_id, ver.activated_basis) is distinct from (actor, new.basis))
     or (new.to_status = 'disabled' and (ver.disabled_by_user_id, ver.disabled_basis) is distinct from (actor, new.basis))
     or new.to_status not in ('needs_review', 'active', 'disabled') then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.source_metric_audit
              where action in ('mapping_status', 'mapping_version_replaced')
                and mapping_version_id = new.mapping_version_id and to_status = new.to_status) then
    raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- 9d. The revision guard (v50's body; the three new chains).
create or replace function training_load.source_metric_audit_revision_guard() returns trigger as $$
declare
  actor uuid;
  here bigint;
  rev record;
begin
  if new.action in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced') then
    -- v35's chain (source_metric_audit_v35_actor_guard).
    return new;
  end if;

  if new.action in ('source_metric_revision_create', 'source_metric_revision_activate', 'source_metric_revision_retire') then
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric revision: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select state, created_by_user_id, activated_by_user_id, activated_at, retired_by_user_id, retired_reason, evidence_ref,
           xmin::text::bigint as written_in into rev
      from training_load.source_metric_definition_versions
     where id = new.source_metric_version_id and source_metric_definition_id = new.source_metric_definition_id;
    if not found or rev.written_in is distinct from here then
      raise exception 'source_metric_audit: the audit row must follow its own revision change in the same transaction' using errcode = '23514';
    end if;
    if (new.action = 'source_metric_revision_create'
        and (rev.created_by_user_id is distinct from actor or new.reason is not null
             or (new.evidence_ref is not null and new.evidence_ref is distinct from rev.evidence_ref)))
       or (new.action = 'source_metric_revision_activate'
           and (rev.state is distinct from 'active' or rev.activated_by_user_id is distinct from actor
                or new.reason is not null or new.evidence_ref is not null))
       or (new.action = 'source_metric_revision_retire'
           and (rev.state is distinct from 'retired' or rev.retired_by_user_id is distinct from actor
                or new.reason is distinct from rev.retired_reason or new.evidence_ref is not null
                or new.from_status is distinct from (case when rev.activated_at is null then 'draft' else 'active' end))) then
      raise exception 'source_metric_audit: the audit row must follow its own revision change in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and source_metric_version_id = new.source_metric_version_id) then
      raise exception 'source_metric_audit: the revision change already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action in ('unit_conversion_create', 'unit_conversion_retire') then
    -- v47: a conversion's audit row follows its own create or retirement, once.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'unit conversion: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select state, created_by_user_id, retired_by_user_id, retired_reason, evidence_ref, xmin::text::bigint as written_in into rev
      from training_load.unit_conversions
     where id = new.unit_conversion_id;
    if not found or rev.written_in is distinct from here then
      raise exception 'source_metric_audit: the audit row must follow its own conversion change in the same transaction' using errcode = '23514';
    end if;
    if (new.action = 'unit_conversion_create'
        and (rev.state is distinct from 'active' or rev.created_by_user_id is distinct from actor
             or new.evidence_ref is distinct from rev.evidence_ref or new.reason is not null))
       or (new.action = 'unit_conversion_retire'
           and (rev.state is distinct from 'retired' or rev.retired_by_user_id is distinct from actor
                or new.reason is distinct from rev.retired_reason or new.from_status is distinct from 'active'
                or new.evidence_ref is not null)) then
      raise exception 'source_metric_audit: the audit row must follow its own conversion change in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and unit_conversion_id = new.unit_conversion_id) then
      raise exception 'source_metric_audit: the conversion change already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action in ('activation_start', 'activation_end') then
    -- v48: an activation's audit row follows its own start or end in the same
    -- transaction, by its writer: a start carries the activation's reason; an
    -- end carries a reason, and an end written by a version's replacement or
    -- disable carries that version's disable_reason. No evidence. Once per
    -- activation and action (the unique index makes it physical).
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    select a.activated_by_user_id, a.activated_basis, a.reason, a.ended_at, a.ended_by_user_id, a.ended_basis, a.end_reason,
           a.xmin::text::bigint as written_in, v.disable_reason into rev
      from training_load.source_metric_mapping_activations a
      join training_load.source_metric_mapping_versions v on v.id = a.mapping_version_id
     where a.id = new.activation_id;
    if not found or rev.written_in is distinct from here then
      raise exception 'source_metric_audit: the audit row must follow its own activation change in the same transaction' using errcode = '23514';
    end if;
    if (new.action = 'activation_start'
        and (rev.activated_by_user_id is distinct from actor or new.basis is distinct from rev.activated_basis
             or new.reason is distinct from rev.reason or new.evidence_ref is not null))
       or (new.action = 'activation_end'
           and (rev.ended_at is null or rev.ended_by_user_id is distinct from actor or new.basis is distinct from rev.ended_basis
                or new.reason is null or new.evidence_ref is not null
                or (rev.end_reason in ('mapping_version_replaced', 'mapping_version_disabled')
                    and new.reason is distinct from rev.disable_reason))) then
      raise exception 'source_metric_audit: the audit row must follow its own activation change in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and activation_id = new.activation_id) then
      raise exception 'source_metric_audit: the activation change already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action = 'source_instance_end' then
    -- v50: an instance's end follows its own state change in the same
    -- transaction, by a platform admin, for the owner team, with a reason and
    -- no evidence, once per connection (the unique index makes it physical).
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source instance: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select state, owner_scope, owner_team_id, source_host_key, source_instance_key, xmin::text::bigint as written_in into rev
      from training_load.metric_source_connections
     where id = new.metric_source_connection_id;
    if not found or rev.written_in is distinct from here or rev.state is distinct from 'inactive'
       or rev.owner_scope is distinct from 'team' or rev.source_host_key is null or rev.source_instance_key is null
       or new.team_id is distinct from rev.owner_team_id or new.reason is null or new.evidence_ref is not null
       or new.from_status is distinct from 'active' or new.to_status is distinct from 'inactive' then
      raise exception 'source_metric_audit: the audit row must follow its own source instance end in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'source_instance_end' and metric_source_connection_id = new.metric_source_connection_id) then
      raise exception 'source_metric_audit: the source instance end already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  -- M-A (J18) begin
  if new.action = 'mapping_confirmation' then
    -- The keyed request record of a board save: it follows its own
    -- confirmation in the same transaction, by its writer, with the
    -- confirmation's basis, team and operation, once.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    select confirmed_by_user_id, confirmed_basis, team_id, operation_id, xmin::text::bigint as written_in into rev
      from training_load.source_metric_confirmations where id = new.confirmation_id;
    if not found or rev.written_in is distinct from here or rev.confirmed_by_user_id is distinct from actor
       or new.performed_by_user_id is distinct from actor or new.basis is distinct from rev.confirmed_basis
       or new.team_id is distinct from rev.team_id or new.operation_id is distinct from rev.operation_id
       or new.request_key is null or new.reason is not null or new.evidence_ref is not null
       or new.performed_at is distinct from now() then
      raise exception 'source_metric_audit: the audit row must follow its own confirmation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'mapping_confirmation' and confirmation_id = new.confirmation_id) then
      raise exception 'source_metric_audit: the confirmation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action in ('confirmation_values_expired', 'confirmation_values_erased') then
    -- A removal by an acting user: an active platform admin, after the removal
    -- of every value of that confirmation in the same transaction, by that
    -- user, of the row's kind, once per confirmation and action.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric confirmation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    if new.evidence_ref is not null or new.performed_at is distinct from now()
       or not exists (select 1 from training_load.source_metric_confirmation_items i
                       where i.confirmation_id = new.confirmation_id and i.values_removed_at is not null
                         and i.xmin::text::bigint = here and i.values_removed_by_user_id = actor
                         and i.values_removed_kind = (case new.action when 'confirmation_values_expired' then 'expired' else 'erased' end))
       or exists (select 1 from training_load.source_metric_confirmation_items i
                   where i.confirmation_id = new.confirmation_id and i.checked and i.values_removed_at is null) then
      raise exception 'source_metric_audit: the audit row must follow its own removal of values in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and confirmation_id = new.confirmation_id) then
      raise exception 'source_metric_audit: the removal of values already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  -- M-A (J18) end
  if new.action not in ('source_metric_unit_verified', 'source_metric_meaning_verified') then
    raise exception 'source_metric_audit: no writer of this action exists yet' using errcode = '23514';
  end if;
  -- v37, unchanged: a verification row follows its own act, once.
  actor := training_load.source_metric_context_actor();
  here := training_load.source_metric_current_xmin();
  select unit_verified_by_user_id, unit_verified_at, unit_evidence_ref,
         meaning_verified_by_user_id, meaning_verified_at, meaning_evidence_ref,
         xmin::text::bigint as written_in into rev
    from training_load.source_metric_definition_versions
   where id = new.source_metric_version_id and source_metric_definition_id = new.source_metric_definition_id;
  if not found or rev.written_in is distinct from here then
    raise exception 'source_metric_audit: the audit row must follow its own verification in the same transaction' using errcode = '23514';
  end if;
  if new.action = 'source_metric_unit_verified' then
    if rev.unit_verified_at is null or rev.unit_verified_by_user_id is distinct from actor
       or rev.unit_evidence_ref is distinct from new.evidence_ref then
      raise exception 'source_metric_audit: the audit row must follow its own verification in the same transaction' using errcode = '23514';
    end if;
  elsif rev.meaning_verified_at is null or rev.meaning_verified_by_user_id is distinct from actor
        or rev.meaning_evidence_ref is distinct from new.evidence_ref then
    raise exception 'source_metric_audit: the audit row must follow its own verification in the same transaction' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.source_metric_audit
              where action = new.action and source_metric_version_id = new.source_metric_version_id) then
    raise exception 'source_metric_audit: the verification already has its audit row' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
