-- Training Load v30 — the approved pair (OptiMove team <-> GPEXE Team ID) of
-- a source binding is guaranteed by the database: an active binding binds
-- exactly its team's approved pair, that pair is final while the binding is
-- active, and one OptiMove team holds one GPEXE team in canonical form.
--
-- F3c2e (verified team binding). Owner decision 2026-10-04 (security review
-- HIGH F-1, option (a)): the existing training_load.gpexe_team_settings row
-- of an OptiMove team is the platform-admin allowlist — the approved pair
-- `OptiMove team <-> GPEXE Team ID`. A source_team_bindings row (v27) may only
-- bind that exact pair, and a club admin may only see and choose GPEXE teams
-- that match such a pair of their club. The application checks the pair under
-- the team's import lock (bind) and refuses a change of the approved Team ID
-- while a binding is active (setTeamSettings). This migration is the
-- database's own backstop for the second half, so that a raw UPDATE can never
-- leave an active binding pointing at a Team ID the settings row no longer
-- approves.
--
-- What it adds (nothing else):
--   0. (owner's external review of PR #135, 2026-10-04) Two further backstops
--      so the database itself guarantees the approved pair:
--      a. a BEFORE INSERT trigger on source_team_bindings: an ACTIVE gpexe
--         binding must point at its own team's gpexe_team_settings row
--         (legacy_gpexe_settings_team_id = team_id), that row must exist, and
--         the canonical source_team_id must equal the canonical approved
--         GPEXE Team ID — otherwise check_violation, constraint
--         source_team_bindings_approved_pair (…_missing when the team has
--         no settings row at all). It fires AFTER v27's
--         source_team_bindings_check_owner (by name order), i.e. after the
--         team's import try-lock, and reads the settings row FOR SHARE: the
--         same order the bind route uses (team try-lock, then the settings
--         row), so no new wait and no cycle with a settings change (which
--         takes the team lock first) or with the trigger below.
--         The guarantee is scoped to source_system = 'gpexe', whose allowlist
--         is gpexe_team_settings; a future source needs its own approved-pair
--         rule before it gets a bind route.
--      b. a unique index on gpexe_team_id_canonical(gpexe_team_id): the v22
--         key is on the raw text, so "981" and "0981" could name one GPEXE
--         team for two OptiMove teams. The migration REFUSES, changing
--         nothing, when such canonical duplicates already exist (resolve them
--         by hand through Settings, with a reason, then apply).
--   1. training_load.gpexe_team_id_canonical(text): the canonical form of a
--      GPEXE team id as stored by v22 (`^[0-9]{1,12}$`, which allowed leading
--      zeros) — leading zeros removed, "0" kept — the form the guard PR (#118)
--      and v27's binding CHECK use. Comparison only; no stored value changes.
--   2. A BEFORE UPDATE trigger on gpexe_team_settings that refuses, while the
--      row's team has an ACTIVE gpexe binding in source_team_bindings, any
--      UPDATE that changes the canonical GPEXE Team ID or the OptiMove team of
--      the row. The same value again (and a reason / author / time change
--      that v24 allows) passes untouched, so the idempotent PUT /settings
--      keeps working. SQLSTATE check_violation (23514), constraint name
--      gpexe_team_settings_bound_team_final, so the application can answer
--      a stable code without the message.
--
-- What it deliberately does NOT add:
--   * DELETE and TRUNCATE of gpexe_team_settings and a change of its
--     owner_team_id are already refused for EVERY row by v24
--     (gpexe_team_settings_refuse_delete, gpexe_team_settings_no_truncate,
--     refuse_gpexe_team_repoint); the table has no archive flag, so an
--     "archived setting" does not exist. Nothing is duplicated.
--   * No column, no data rewrite, no backfill: at v29 no binding row exists
--     on any database this project knows (no merged code writes one), so the
--     trigger validates nothing existing.
--
-- Lock order: the trigger fires inside an UPDATE that already holds the
-- settings row (FOR UPDATE through the statement). The bind reads that row
-- FOR SHARE while holding the team's import try-lock, so an UPDATE and a bind
-- of one team are ordered by the row: the UPDATE waits for a bind in flight
-- (and then sees its binding), or the bind waits for the UPDATE at most its
-- lock_timeout and answers try_again. The trigger takes no lock of its own
-- (v24's repoint trigger, which fires after it by name order, takes the
-- team's try-lock when the id really changes).
--
-- Rollback: docs/runbooks/source-connections-v30-rollback.sql (refuses when
-- the protection is already needed by data, or when a later migration is
-- recorded).

create function training_load.gpexe_team_id_canonical(raw text) returns text
  language sql immutable strict as $$
    select case when raw ~ '^[0-9]{1,12}$' then regexp_replace(raw, '^0+([0-9])', '\1') else raw end
  $$;
comment on function training_load.gpexe_team_id_canonical(text) is
  'v30 (F3c2e): the canonical GPEXE team id (no leading zeros, "0" kept) for comparing a gpexe_team_settings value with a source_team_bindings value. Comparison only; values are never rewritten.';

create function training_load.refuse_gpexe_team_change_while_bound() returns trigger as $$
begin
  if training_load.gpexe_team_id_canonical(new.gpexe_team_id) is not distinct from training_load.gpexe_team_id_canonical(old.gpexe_team_id)
     and new.owner_team_id is not distinct from old.owner_team_id then
    return new;
  end if;
  if exists (
    select 1 from training_load.source_team_bindings b
     where b.team_id = old.owner_team_id and b.source_system = 'gpexe' and b.state = 'active'
  ) then
    raise exception 'gpexe_team_settings: team % is bound to GPEXE team % through a source connection; the approved GPEXE team cannot change while that binding is active (end the binding first)',
      old.owner_team_id, old.gpexe_team_id
      using errcode = 'check_violation', constraint = 'gpexe_team_settings_bound_team_final';
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.refuse_gpexe_team_change_while_bound() is
  'v30 (F3c2e): the approved GPEXE team (and the OptiMove team) of a gpexe_team_settings row is final while the team has an active gpexe source_team_binding. Same value: allowed.';

create trigger gpexe_team_settings_bound_team_final
  before update on training_load.gpexe_team_settings
  for each row execute function training_load.refuse_gpexe_team_change_while_bound();

-- ---------------------------------------------------------------------------
-- 0a. The approved pair, on INSERT (the database's own guarantee)
-- ---------------------------------------------------------------------------
create function training_load.refuse_unapproved_gpexe_binding() returns trigger as $$
declare
  approved text;
begin
  if new.source_system <> 'gpexe' or new.state <> 'active' then
    return new;
  end if;
  if new.legacy_gpexe_settings_team_id is null or new.legacy_gpexe_settings_team_id is distinct from new.team_id then
    raise exception 'source_team_bindings: an active GPEXE binding of team % must point at that team''s own approved GPEXE setting (legacy_gpexe_settings_team_id)', new.team_id
      using errcode = 'check_violation', constraint = 'source_team_bindings_approved_pair';
  end if;
  select gpexe_team_id into approved from training_load.gpexe_team_settings where owner_team_id = new.team_id for share;
  if not found then
    raise exception 'source_team_bindings: team % has no approved GPEXE team in gpexe_team_settings; nothing can be bound', new.team_id
      using errcode = 'check_violation', constraint = 'source_team_bindings_approved_pair_missing';
  end if;
  if training_load.gpexe_team_id_canonical(approved) is distinct from training_load.gpexe_team_id_canonical(new.source_team_id) then
    raise exception 'source_team_bindings: team % is approved for GPEXE team %, not for %', new.team_id, approved, new.source_team_id
      using errcode = 'check_violation', constraint = 'source_team_bindings_approved_pair';
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.refuse_unapproved_gpexe_binding() is
  'v30 (F3c2e): an active gpexe source_team_binding binds exactly the approved pair of its team (gpexe_team_settings): pointer to its own setting, setting present, canonical ids equal.';

-- Fires after source_team_bindings_check_owner ("check_o" < "check_p"): the
-- team's import try-lock is already held when the settings row is read.
create trigger source_team_bindings_check_pair
  before insert on training_load.source_team_bindings
  for each row execute function training_load.refuse_unapproved_gpexe_binding();

-- ---------------------------------------------------------------------------
-- 0b. One OptiMove team per canonical GPEXE team id
-- ---------------------------------------------------------------------------
do $$
declare
  dups integer;
  unpaired integer;
begin
  select count(*) into dups from (
    select training_load.gpexe_team_id_canonical(gpexe_team_id) as canonical
      from training_load.gpexe_team_settings
     group by 1 having count(*) > 1
  ) d;
  if dups > 0 then
    raise exception 'v30 refused: % GPEXE team id(s) in training_load.gpexe_team_settings differ only by leading zeros; resolve them by hand (Settings, with a reason) before applying v30 — no row is changed here', dups;
  end if;
  -- An ACTIVE gpexe binding that is not its team's approved pair would be
  -- protected by nothing after v30 (the INSERT trigger sees new rows only):
  -- refuse to apply over it rather than keep a contradiction. None can exist
  -- on any database this project knows (no merged code writes a binding).
  select count(*) into unpaired
    from training_load.source_team_bindings b
    left join training_load.gpexe_team_settings s on s.owner_team_id = b.team_id
   where b.source_system = 'gpexe' and b.state = 'active'
     and (b.legacy_gpexe_settings_team_id is distinct from b.team_id
          or s.owner_team_id is null
          or training_load.gpexe_team_id_canonical(s.gpexe_team_id) is distinct from training_load.gpexe_team_id_canonical(b.source_team_id));
  if unpaired > 0 then
    raise exception 'v30 refused: % active GPEXE binding(s) are not their team''s approved pair; end or correct them by hand before applying v30 — no row is changed here', unpaired;
  end if;
end $$;

create unique index gpexe_team_settings_canonical_team_id_key
  on training_load.gpexe_team_settings (training_load.gpexe_team_id_canonical(gpexe_team_id));
comment on index training_load.gpexe_team_settings_canonical_team_id_key is
  'v30 (F3c2e): one OptiMove team per GPEXE team in canonical form ("981" and "0981" are one team); the v22 key on the raw text stays.';
