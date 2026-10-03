-- Training Load v30 — the approved GPEXE team of a bound OptiMove team is final
-- while its source binding is active.
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
