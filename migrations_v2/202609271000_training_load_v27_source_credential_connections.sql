-- Training Load v27 — source credential connections, team bindings and their
-- audit (F3c1: source-neutral schema, encryption foundation, audit).
--
-- Contract: docs/ai/gpexe-f3c-auth-discovery.md (sections 3, 4, 5, 6 F3c1,
-- 7a, 8c) and docs/runbooks/source-connections-v27.md. Discovery decisions:
-- add BESIDE the existing GPEXE tables (D6), club-owned connections with
-- separate team bindings (D4), host keys from a controlled catalog (D1; the
-- source may run on several servers, one per organisation, and a
-- connection names its server by key, never by URL), an opaque encrypted
-- credential with a mandatory kind, the five-state model of section 5,
-- append-only audit.
--
-- What it adds (nothing else):
--   0. training_load.source_host_catalog — the approved host keys per
--      source, seeded with gpexe/e03 only. A new confirmed server is one
--      catalog ROW (a data-only migration) plus its exact HTTPS base URL in
--      backend/src/sourceHosts.js — never a structure change and never a
--      URL in a row. The backend resolves a key to a URL from its own
--      catalog and refuses an unknown key before any network call; the
--      database refuses a connection whose key is not approved.
--   1. training_load.source_credential_connections — who may read a source,
--      with what credential. The credential is ciphertext + nonce + auth tag
--      + key version, all four together or all NULL. There is no plaintext
--      column and no key anywhere in the database. `state` is stored and
--      bound to its facts by CHECKs; ownership, source and host become
--      immutable once a binding exists (like v11's
--      protect_connection_ownership_once_used).
--   2. training_load.source_team_bindings — which source team an OptiMove
--      team reads through which connection. One ACTIVE binding per team and
--      source; one active OptiMove team per source team across every
--      connection of every club (v22's global rule); the binding's team
--      belongs to the connection's owner (club or team); rows are never
--      deleted, a binding only ends (its own history). An optional pointer
--      keeps the provenance to the legacy training_load.gpexe_team_settings
--      row it will one day replace; that table is not touched.
--   3. training_load.source_connection_audit — append-only: who, when, which
--      action, outcome, reason, error code and sanitized metadata (a JSON
--      object whose keys may never name a secret). No UPDATE, DELETE or
--      TRUNCATE.
--   4. training_load.source_connection_bound_team_ids(connection) — the
--      ascending list of bound team ids a later credential change must lock
--      in that order, try-lock style (v24 hold_gpexe_team_lock), backed by
--      an index on (connection_id, team_id). Creating or ending a binding
--      takes that team's lock inside the trigger (the database's backstop);
--      the per-connection sweep over all bound teams is F3c2's route work.
--
-- What it deliberately does NOT do: it creates no connection and no binding
-- for any team (team 980 included), changes no existing row, adds no route,
-- and reads nothing from any source. The encryption key lives only in the
-- server environment and is read by backend/src/sourceCredentialCrypto.js
-- when a credential is encrypted or decrypted, never at start-up.
--
-- Rollback: docs/runbooks/source-connections-v27-rollback.sql (rehearsed in
-- backend/tests/source-connections-f3c1.test.mjs on a disposable database).

-- ---------------------------------------------------------------------------
-- 0. The host catalog: approved server keys per source. No URL is stored;
--    the backend maps a key to its exact HTTPS host and is the final
--    boundary (unknown or retired key -> host_not_allowed, before any
--    request). A platform admin only chooses an approved key.
-- ---------------------------------------------------------------------------
create table training_load.source_host_catalog (
  source_system   text not null
                    constraint source_host_catalog_source_system_format
                    check (source_system ~ '^[a-z][a-z0-9_]{1,30}$'),
  host_key        text not null
                    constraint source_host_catalog_host_key_format
                    check (host_key ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
  label           text not null
                    constraint source_host_catalog_label_check
                    check (length(btrim(label)) between 1 and 80),
  state           text not null default 'approved'
                    constraint source_host_catalog_state_check
                    check (state in ('approved', 'retired')),
  approved_at     timestamptz not null default now(),
  note            text
                    constraint source_host_catalog_note_check
                    check (note is null or length(btrim(note)) between 1 and 500),
  primary key (source_system, host_key)
);

comment on table training_load.source_host_catalog is
  'F3c1: the approved server keys a source credential connection may name. Keys only, never a URL: backend/src/sourceHosts.js maps each key to its exact HTTPS host and refuses anything else. A new confirmed server is a row added by a data-only migration plus its code entry.';

-- Only e03 is approved: it is the server the owner''s organisation is known
-- to use. server3 is deliberately NOT here until a dedicated API account and
-- Team ID 980 are confirmed to work there; nothing assumes that an account,
-- a token or a team id is valid on more than one server.
insert into training_load.source_host_catalog (source_system, host_key, label, note)
values ('gpexe', 'e03', 'GPEXE e03', 'The server of the owner''s organisation (UI at e03-ui.gpexe.com). Approved for F3c1.');

-- A catalog row is never deleted or renamed (connections point at it);
-- only its label, state and note may change.
create function training_load.source_host_catalog_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'source_host_catalog keeps every key: DELETE refused (retire it instead)';
  end if;
  if new.source_system is distinct from old.source_system or new.host_key is distinct from old.host_key then
    raise exception 'source_host_catalog: a host key is immutable (add a new row instead)';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_host_catalog_immutable
  before update or delete on training_load.source_host_catalog
  for each row execute function training_load.source_host_catalog_immutable();

-- ---------------------------------------------------------------------------
-- 1. Connections
-- ---------------------------------------------------------------------------
create table training_load.source_credential_connections (
  id                        uuid primary key default gen_random_uuid(),
  source_system             text not null
                              constraint source_credential_connections_source_system_format
                              check (source_system ~ '^[a-z][a-z0-9_]{1,30}$'),
  owner_scope               text not null
                              constraint source_credential_connections_owner_scope_check
                              check (owner_scope in ('club', 'team')),
  owner_club_id             uuid references public.clubs(id) on delete restrict,
  owner_team_id             uuid references public.teams(id) on delete restrict,
  -- A key from training_load.source_host_catalog (D1). Never a URL. The
  -- foreign key below refuses a key that is not in the catalog; the
  -- trigger after the table refuses one that is retired.
  host_key                  text not null
                              constraint source_credential_connections_host_key_format
                              check (host_key ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
  -- A display label the administrator types. Never the account's username.
  account_label             text not null
                              constraint source_credential_connections_account_label_check
                              check (length(btrim(account_label)) between 1 and 120),
  -- What the ciphertext holds; mandatory so that a later scheme needs no
  -- schema change. Owner decision 2026-09-27: 'api_token' (an official API
  -- token entered by the administrator; OptiMove never sees a password) is
  -- preferred, 'exchanged_token' (from a one-time username/password
  -- exchange, allowed only when the source has no official token; the
  -- password is never stored or logged) is the fallback. The database keeps
  -- the format open and chooses neither (backend/src/sourceHosts.js lists
  -- the kinds). Never the credential itself.
  credential_kind           text not null
                              constraint source_credential_connections_credential_kind_format
                              check (credential_kind ~ '^[a-z][a-z0-9_]{1,30}$'),
  credential_ciphertext     bytea,
  credential_nonce          bytea,
  credential_auth_tag       bytea,
  credential_key_version    integer,
  state                     text not null default 'not_connected'
                              constraint source_credential_connections_state_check
                              check (state in ('not_connected', 'linked_untested', 'verified', 'needs_reconnect', 'source_unavailable')),
  last_verified_at          timestamptz,
  last_error_code           text
                              constraint source_credential_connections_last_error_code_format
                              check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{1,60}$'),
  last_error_at             timestamptz,
  created_by_user_id        uuid not null references public.users(id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_by_user_id        uuid references public.users(id) on delete restrict,
  updated_at                timestamptz not null default now(),
  constraint source_credential_connections_host_in_catalog
    foreign key (source_system, host_key) references training_load.source_host_catalog (source_system, host_key) on delete restrict,
  constraint source_credential_connections_owner_check check (
    (owner_scope = 'club' and owner_club_id is not null and owner_team_id is null) or
    (owner_scope = 'team' and owner_team_id is not null and owner_club_id is null)
  ),
  -- The four credential parts exist together or not at all (v20's
  -- "reference complete" shape). AES-256-GCM: 12-byte nonce, 16-byte tag.
  constraint source_credential_connections_credential_complete check (
    (credential_ciphertext is null and credential_nonce is null and credential_auth_tag is null and credential_key_version is null) or
    (credential_ciphertext is not null and credential_nonce is not null and credential_auth_tag is not null and credential_key_version is not null
     and octet_length(credential_nonce) = 12 and octet_length(credential_auth_tag) = 16 and octet_length(credential_ciphertext) >= 1
     and credential_key_version >= 1)
  ),
  -- The state is bound to its facts (discovery section 3).
  constraint source_credential_connections_state_needs_reconnect_facts
    check (state <> 'needs_reconnect' or last_error_code is not null),
  constraint source_credential_connections_state_unavailable_facts
    check (state <> 'source_unavailable' or last_error_at is not null),
  constraint source_credential_connections_state_verified_facts
    check (state <> 'verified' or last_verified_at is not null),
  -- A verified connection holds a credential; a retired one holds none
  -- (section 4 rule 5: Disconnect wipes the ciphertext and leaves
  -- not_connected).
  constraint source_credential_connections_state_verified_has_credential
    check (state <> 'verified' or credential_ciphertext is not null),
  constraint source_credential_connections_state_not_connected_no_credential
    check (state <> 'not_connected' or credential_ciphertext is null)
);

comment on table training_load.source_credential_connections is
  'F3c1: a source account OptiMove may read a source with (club- or team-owned). The credential is AEAD ciphertext under a key that lives only in the server environment; there is no plaintext column. Add-beside: gpexe_team_settings is untouched.';
comment on column training_load.source_credential_connections.host_key is
  'An approved key of training_load.source_host_catalog, resolved to its exact HTTPS host only by backend/src/sourceHosts.js. Never a URL. A connection never falls back to another host.';

-- A new connection (or a host change while still unbound and without a
-- credential) may only name an APPROVED key. A key retired later leaves
-- existing connections in place; the backend then answers host_not_allowed.
create function training_load.source_credential_connection_check_host() returns trigger as $$
declare
  host_state text;
begin
  if tg_op = 'UPDATE' and new.host_key is not distinct from old.host_key and new.source_system is not distinct from old.source_system then
    return new;
  end if;
  select state into host_state from training_load.source_host_catalog
   where source_system = new.source_system and host_key = new.host_key for share;
  if host_state is null then
    raise exception 'source_credential_connections: host key % is not in the catalog for %', new.host_key, new.source_system
      using errcode = 'foreign_key_violation';
  end if;
  if host_state <> 'approved' then
    raise exception 'source_credential_connections: host key % of % is retired', new.host_key, new.source_system
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_credential_connections_check_host
  before insert or update on training_load.source_credential_connections
  for each row execute function training_load.source_credential_connection_check_host();
comment on column training_load.source_credential_connections.account_label is
  'A label typed by the administrator for the screen. Never the source username, password, token or any part of them.';
comment on column training_load.source_credential_connections.credential_ciphertext is
  'AES-256-GCM ciphertext of the credential, bound by additional authenticated data to this row (id, owner, source_system, host_key, credential_kind). Decryptable only by the server with the key version named in credential_key_version.';

create index source_credential_connections_owner_club_idx
  on training_load.source_credential_connections (owner_club_id) where owner_club_id is not null;
create index source_credential_connections_owner_team_idx
  on training_load.source_credential_connections (owner_team_id) where owner_team_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Team bindings
-- ---------------------------------------------------------------------------
create table training_load.source_team_bindings (
  id                                uuid primary key default gen_random_uuid(),
  team_id                           uuid not null references public.teams(id) on delete restrict,
  connection_id                     uuid not null references training_load.source_credential_connections(id) on delete restrict,
  -- Denormalised from the connection (kept equal by trigger) so that "one
  -- active binding per team and source" is one partial unique index.
  source_system                     text not null
                                      constraint source_team_bindings_source_system_format
                                      check (source_system ~ '^[a-z][a-z0-9_]{1,30}$'),
  source_team_id                    text not null
                                      constraint source_team_bindings_source_team_id_format
                                      check (source_team_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  state                             text not null default 'active'
                                      constraint source_team_bindings_state_check
                                      check (state in ('active', 'ended')),
  bound_by_user_id                  uuid not null references public.users(id) on delete restrict,
  bound_at                          timestamptz not null default now(),
  bind_reason                       text
                                      constraint source_team_bindings_bind_reason_check
                                      check (bind_reason is null or length(btrim(bind_reason)) between 1 and 500),
  ended_at                          timestamptz,
  ended_by_user_id                  uuid references public.users(id) on delete restrict,
  end_reason                        text
                                      constraint source_team_bindings_end_reason_check
                                      check (end_reason is null or length(btrim(end_reason)) between 1 and 500),
  -- Provenance only: the legacy GPEXE settings row this binding continues,
  -- when it continues one. The legacy row itself is never changed here.
  legacy_gpexe_settings_team_id     uuid references training_load.gpexe_team_settings(owner_team_id) on delete restrict,
  -- GPEXE team ids are the canonical numeric form of the guard PR (#118).
  constraint source_team_bindings_gpexe_team_id_canonical
    check (source_system <> 'gpexe' or source_team_id ~ '^(0|[1-9][0-9]{0,11})$'),
  constraint source_team_bindings_ended_facts check (
    (state = 'active' and ended_at is null and ended_by_user_id is null and end_reason is null) or
    (state = 'ended' and ended_at is not null and ended_by_user_id is not null and end_reason is not null)
  ),
  constraint source_team_bindings_legacy_pointer_is_gpexe
    check (legacy_gpexe_settings_team_id is null or source_system = 'gpexe')
);

comment on table training_load.source_team_bindings is
  'F3c1: which source team an OptiMove team reads through which connection. Rows never disappear: a binding ends (state ended) and stays as history. gpexe_team_settings is not changed by any binding.';

-- One OptiMove team never has two active bindings for the same source.
create unique index source_team_bindings_one_active_per_team_source
  on training_load.source_team_bindings (team_id, source_system) where state = 'active';
-- One source team feeds one OptiMove team at a time — across every
-- connection of every club (v22's global unique (gpexe_team_id) carried
-- over, so the same source team is never imported under two teams).
create unique index source_team_bindings_one_active_per_source_team
  on training_load.source_team_bindings (source_system, source_team_id) where state = 'active';
-- The lock query of F3c2: every bound team of a connection, ascending.
create index source_team_bindings_connection_team_idx
  on training_load.source_team_bindings (connection_id, team_id) where state = 'active';
create index source_team_bindings_team_idx
  on training_load.source_team_bindings (team_id);

-- The bound team ids of a connection in the order a credential change locks
-- them (v24 hold_gpexe_team_lock, try-lock style, ascending). F3c2 calls it;
-- F3c1 only provides it.
create function training_load.source_connection_bound_team_ids(connection uuid) returns setof uuid
  language sql stable as $$
    select team_id from training_load.source_team_bindings
     where connection_id = connection and state = 'active'
     order by team_id
  $$;

-- A binding belongs to its connection: same source, and its team inside the
-- connection's owner (the owner club's team, or the owner team itself). The
-- connection's source is copied onto the row so the unique index can use it.
-- Before anything else the team's import lock is taken, try-lock style
-- (v24 training_load.hold_gpexe_team_lock, the key every GPEXE check, link,
-- settings change and approval uses): a binding never lands next to a
-- running check or credential change of that team, whoever writes the row,
-- and a lock that is busy answers "try again" instead of waiting. This is
-- the database's own backstop; F3c2's routes take the same lock first, for
-- every bound team of a connection in ascending order
-- (source_connection_bound_team_ids).
create function training_load.source_team_binding_check_owner() returns trigger as $$
declare
  conn record;
  team_club uuid;
begin
  perform training_load.hold_gpexe_team_lock(new.team_id, 'binding');
  select source_system, owner_scope, owner_club_id, owner_team_id
    into conn from training_load.source_credential_connections where id = new.connection_id for share;
  if not found then
    raise exception 'source_team_bindings: connection % does not exist', new.connection_id using errcode = 'foreign_key_violation';
  end if;
  if new.source_system is distinct from conn.source_system then
    raise exception 'source_team_bindings: the binding must carry its connection''s source (% <> %)', new.source_system, conn.source_system
      using errcode = 'check_violation';
  end if;
  select club_id into team_club from public.teams where id = new.team_id for share;
  if conn.owner_scope = 'club' and team_club is distinct from conn.owner_club_id then
    raise exception 'source_team_bindings: team % is not in the club that owns connection %', new.team_id, new.connection_id
      using errcode = 'check_violation';
  end if;
  if conn.owner_scope = 'team' and new.team_id is distinct from conn.owner_team_id then
    raise exception 'source_team_bindings: team % is not the team that owns connection %', new.team_id, new.connection_id
      using errcode = 'check_violation';
  end if;
  if new.legacy_gpexe_settings_team_id is not null and new.legacy_gpexe_settings_team_id is distinct from new.team_id then
    raise exception 'source_team_bindings: the legacy GPEXE settings pointer must be the binding''s own team' using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_team_bindings_check_owner
  before insert on training_load.source_team_bindings
  for each row execute function training_load.source_team_binding_check_owner();

-- A binding is history: it can only END. Nothing else about it changes, and
-- an ended binding never changes again. Deleting is refused.
create function training_load.source_team_binding_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'source_team_bindings keeps history: DELETE refused (end the binding instead)';
  end if;
  if old.state = 'ended' then
    raise exception 'source_team_bindings: binding % has ended and is immutable', old.id;
  end if;
  -- Ending a binding is a change of the team's source set-up: same lock as
  -- creating it.
  perform training_load.hold_gpexe_team_lock(old.team_id, 'ending a binding');
  if new.id is distinct from old.id or new.team_id is distinct from old.team_id or new.connection_id is distinct from old.connection_id
     or new.source_system is distinct from old.source_system or new.source_team_id is distinct from old.source_team_id
     or new.bound_by_user_id is distinct from old.bound_by_user_id or new.bound_at is distinct from old.bound_at
     or new.bind_reason is distinct from old.bind_reason
     or new.legacy_gpexe_settings_team_id is distinct from old.legacy_gpexe_settings_team_id then
    raise exception 'source_team_bindings: binding % is immutable except for ending it', old.id;
  end if;
  if new.state <> 'ended' then
    raise exception 'source_team_bindings: the only change to binding % is ending it', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_team_bindings_immutable
  before update or delete on training_load.source_team_bindings
  for each row execute function training_load.source_team_binding_immutable();

create function training_load.source_history_no_truncate() returns trigger as $$
begin
  raise exception '%.% keeps history; TRUNCATE refused', tg_table_schema, tg_table_name;
end;
$$ language plpgsql;

create trigger source_team_bindings_no_truncate
  before truncate on training_load.source_team_bindings
  for each statement execute function training_load.source_history_no_truncate();

-- ---------------------------------------------------------------------------
-- 2b. A team cannot leave the club whose connection it is bound through.
--     Moving a team to another club (public.teams.club_id) takes the same
--     team lock as a binding insert, try-lock style, so the two never
--     interleave, and is refused while the team has an ACTIVE binding to a
--     club-owned connection of its current club. End the binding first.
-- ---------------------------------------------------------------------------
create function training_load.source_team_binding_guard_team_move() returns trigger as $$
declare
  conn_id uuid;
begin
  if new.club_id is not distinct from old.club_id then
    return new;
  end if;
  perform training_load.hold_gpexe_team_lock(old.id, 'moving the team to another club');
  select b.connection_id into conn_id
    from training_load.source_team_bindings b
    join training_load.source_credential_connections c on c.id = b.connection_id
   where b.team_id = old.id and b.state = 'active'
     and c.owner_scope = 'club' and c.owner_club_id is distinct from new.club_id
   limit 1;
  if conn_id is not null then
    raise exception 'teams: team % is bound through connection % of its current club; end that binding before moving the team', old.id, conn_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger teams_source_binding_guard_move
  before update of club_id on public.teams
  for each row execute function training_load.source_team_binding_guard_team_move();

-- ---------------------------------------------------------------------------
-- 3. Connections: immutable identity once bound
-- ---------------------------------------------------------------------------
-- Ownership, source and host are immutable once any binding (active or
-- ended) exists: a connection that vouched for a team's data is never
-- re-pointed to another owner or host (v11's rule for provenance
-- connections). credential_kind is immutable while a credential is stored.
-- Deleting a connection that ever had a binding is refused by the binding's
-- foreign key (on delete restrict).
create function training_load.source_credential_connection_protect_identity() returns trigger as $$
begin
  if new.id is distinct from old.id then
    raise exception 'source_credential_connections: id is immutable';
  end if;
  -- Owner, source, host and credential_kind are the data every ciphertext
  -- is bound to (the AAD): none of them may change while the stored
  -- ciphertext stays as it is, or the row would look healthy and fail only
  -- at the next decryption. Wiping the credential in the same statement, or
  -- re-encrypting it, is allowed. This is a single-statement guard: the
  -- database cannot verify the AEAD itself, so a wipe-then-restore of the
  -- old bytes in two statements still fails at decryption. Writers and
  -- rotation scripts re-encrypt; they never restore bytes.
  if (new.credential_kind is distinct from old.credential_kind
      or new.source_system is distinct from old.source_system
      or new.owner_scope is distinct from old.owner_scope
      or new.owner_club_id is distinct from old.owner_club_id
      or new.owner_team_id is distinct from old.owner_team_id
      or new.host_key is distinct from old.host_key)
     and new.credential_ciphertext is not null
     and new.credential_ciphertext is not distinct from old.credential_ciphertext then
    raise exception 'source_credential_connections (id=%): the credential context changed while its ciphertext stayed; wipe or re-encrypt the credential in the same statement', old.id;
  end if;
  if new.source_system is not distinct from old.source_system
     and new.owner_scope is not distinct from old.owner_scope
     and new.owner_club_id is not distinct from old.owner_club_id
     and new.owner_team_id is not distinct from old.owner_team_id
     and new.host_key is not distinct from old.host_key then
    return new;
  end if;
  if exists (select 1 from training_load.source_team_bindings where connection_id = old.id) then
    raise exception 'source_credential_connections (id=%) has been bound: owner, source and host are immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_credential_connections_protect_identity
  before update on training_load.source_credential_connections
  for each row execute function training_load.source_credential_connection_protect_identity();

-- ---------------------------------------------------------------------------
-- 4. Audit (append-only)
-- ---------------------------------------------------------------------------
-- True when a JSON object has a top-level key that could name a secret,
-- compared case-insensitively, so the guarantee does not depend on every
-- writer lower-casing its keys. Immutable, so a CHECK may call it.
-- A key name in its normal form: camelCase, hyphens, dots and spaces become
-- underscores, everything lower-case (signingKey, private-key and
-- Auth.Token become signing_key, private_key, auth_token). The secret
-- detection below works on this form, so the spelling never matters.
create function training_load.normalize_key_name(k text) returns text
  language sql immutable strict as $$
    select lower(regexp_replace(regexp_replace(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'), '[-.\s]+', '_', 'g'), '_+', '_', 'g'))
  $$;

-- True when a normalized key name is one that could carry a secret: an
-- exact secret word, a word that ends in key/keys/token/secret/... or one
-- that contains passw/credential/authoriz/cookie/jwt/bearer/session. Words
-- are compared at underscore boundaries, so "monkey" or "keyboard" pass
-- while "signing_key", "private_key", "auth" and "device_key" do not. The
-- two literal facts an audit row legitimately names are exempt: host_key
-- (a catalog key, not a secret) and credential_kind.
create function training_load.key_name_is_secret(k text) returns boolean
  language sql immutable strict as $$
    with n as (select training_load.normalize_key_name(k) as name)
    select name not in ('host_key', 'credential_kind')
       and (
         name = any (array['token', 'access_token', 'refresh_token', 'id_token', 'password', 'passwd', 'pass', 'pwd', 'secret', 'auth',
                            'authorization', 'cookie', 'set_cookie', 'jwt', 'bearer', 'session', 'credential', 'credentials',
                            'ciphertext', 'nonce', 'auth_tag', 'key', 'keys', 'api_key', 'apikey', 'private', 'username', 'user', 'login', 'email',
                            'accesstoken', 'authtoken', 'refreshtoken', 'apitoken', 'idtoken', 'sessionid', 'sessionkey', 'passcode', 'passphrase', 'xauth', 'privatekey', 'secretkey', 'signingkey'])
         or name ~ '(^|_)(key|keys|token|tokens|secret|secrets|auth|password|passwd|pwd|nonce|jwt|bearer|session|cookie|cookies|credential|credentials|apikey|api_key|private_key|private)(_|$)'
         or name ~ '(passw|passcode|passphrase|credential|authoriz|cookie|jwt|bearer|session|ciphertext|api_key|apikey|token)'
       )
      from n
  $$;

create function training_load.jsonb_names_a_secret(doc jsonb) returns boolean
  language sql immutable strict as $$
    select exists (
      select 1 from jsonb_each(case when jsonb_typeof(doc) = 'object' then doc else '{}'::jsonb end) as e(k, v)
       where training_load.key_name_is_secret(k)
          -- a flat object only: nothing may hide a secret one level down
          or jsonb_typeof(v) in ('object', 'array')
    )
  $$;

create table training_load.source_connection_audit (
  id                    uuid primary key default gen_random_uuid(),
  connection_id         uuid not null references training_load.source_credential_connections(id) on delete restrict,
  team_id               uuid references public.teams(id) on delete restrict,
  action                text not null
                          constraint source_connection_audit_action_check
                          check (action in ('create', 'connect', 'reconnect', 'test', 'disconnect', 'auto_invalidate', 'bind', 'unbind', 'rotate_key')),
  outcome               text not null
                          constraint source_connection_audit_outcome_check
                          check (outcome in ('ok', 'refused', 'failed', 'unknown')),
  error_code            text
                          constraint source_connection_audit_error_code_format
                          check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{1,60}$'),
  reason                text
                          constraint source_connection_audit_reason_check
                          check (reason is null or length(btrim(reason)) between 1 and 500),
  -- Null only for the system's own action (auto_invalidate).
  performed_by_user_id  uuid references public.users(id) on delete restrict,
  -- Owner guideline 2026-09-27 (D2, D3): only a platform admin manages and
  -- tests a connection; club_admin is kept for the contract's later option.
  -- A coach basis is deliberately absent: adding one is a migration, taken
  -- only if D3 is reopened.
  basis                 text
                          constraint source_connection_audit_basis_check
                          check (basis is null or basis in ('platform_admin', 'club_admin', 'system')),
  performed_at          timestamptz not null default now(),
  -- Sanitized facts only: a FLAT JSON object (no nested object or array).
  -- Keys that could name a secret are refused whatever their value and
  -- whatever their case.
  metadata              jsonb not null default '{}'::jsonb,
  constraint source_connection_audit_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint source_connection_audit_metadata_no_secret_keys
    check (not training_load.jsonb_names_a_secret(metadata)),
  constraint source_connection_audit_actor check (
    (action = 'auto_invalidate' and performed_by_user_id is null and basis = 'system') or
    (action <> 'auto_invalidate' and performed_by_user_id is not null and basis in ('platform_admin', 'club_admin'))
  ),
  constraint source_connection_audit_failed_has_code
    check (outcome not in ('refused', 'failed') or error_code is not null),
  constraint source_connection_audit_bind_names_team
    check (action not in ('bind', 'unbind') or team_id is not null)
);

comment on table training_load.source_connection_audit is
  'F3c1: append-only record of every action on a source credential connection (who, when, what, outcome, reason, error code, sanitized metadata). Never a credential, token, cookie, header value or username.';

create index source_connection_audit_connection_idx
  on training_load.source_connection_audit (connection_id, performed_at desc);
create index source_connection_audit_team_idx
  on training_load.source_connection_audit (team_id, performed_at desc) where team_id is not null;

create function training_load.source_connection_audit_append_only() returns trigger as $$
begin
  raise exception 'source_connection_audit is append-only (% refused)', tg_op;
end;
$$ language plpgsql;

create trigger source_connection_audit_no_update_delete
  before update or delete on training_load.source_connection_audit
  for each row execute function training_load.source_connection_audit_append_only();

create trigger source_connection_audit_no_truncate
  before truncate on training_load.source_connection_audit
  for each statement execute function training_load.source_history_no_truncate();
