-- Training Load v67 - the track choice of an athlete GPEXE recorded on more than one track (MT-A).
--
-- Plan: docs/ai/mt-multiple-tracks-plan.md sections 5 and 8, with the Rukovodilac's decisions of 2026-11-12 (the approval's
-- lock order, the table gpexe_track_choices, track / none / cleared only, the scale choice in MT-D's own migration, the
-- approver's audience). Runbook: docs/runbooks/gpexe-track-choices-v67.md.
--
-- What this migration changes (no existing row changes; nothing is written to a table):
--   1. training_load.gpexe_track_choices: one row per decision about one athlete of one GPEXE session of a team, append-only.
--      choice 'track' (use one of the athlete's tracks), 'none' (nothing from GPEXE), or 'cleared' (the way back: the athlete
--      is multiple_tracks again). The current choice is the row no later row supersedes; supersedes_choice_id is unique, so
--      the rows of one athlete form a single chain, and one root per athlete (a partial unique index). It holds ids, the
--      track-set fingerprint, who, on which right, and when: no GPEXE name and no value.
--   2. The acting user (optimove.track_choice_actor = '<user uuid>:<xact id>', set by the service) and a guard: the author is
--      the acting user; the right and its basis are the ones training_load.lock_gpexe_import_approver gives under lock (the
--      approval's own function: team mode of v56 included, the team's switch on); a first choice supersedes nothing, a later
--      one supersedes the athlete's current one; 'cleared' clears a choice that is not already cleared; a chosen track is one
--      of the fingerprint's tracks.
--   3. Append-only: UPDATE, DELETE and TRUNCATE are refused, the session undo included (a choice is not import data).
--
-- Not here: reading the choice (MT-B), 'sum' (MT-E) and the scale choice (MT-D, its own migration).
-- Order: after v65. This migration refuses to run without v56's switch table, with another body of the approver function in
-- force, or when the table already exists.
-- Rollback: docs/runbooks/gpexe-track-choices-v67-rollback.sql (refuses once a choice row exists, or a later migration is
-- recorded).

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('training_load.gpexe_team_import_switch') is null or to_regclass('training_load.gpexe_import_candidates') is null then
    raise exception 'v67 refused: v56 (the team import switch) or v22 (the candidates) is not applied' using errcode = '23514';
  end if;
  if to_regclass('training_load.gpexe_track_choices') is not null then
    raise exception 'v67 refused: training_load.gpexe_track_choices already exists' using errcode = '23514';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver') <> 1 then
    raise exception 'v67 refused: training_load.lock_gpexe_import_approver must exist exactly once' using errcode = '23514';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver') is distinct from '09b80cfea087b2c0e7aba47284010412' then
    raise exception 'v67 refused: the body in force of training_load.lock_gpexe_import_approver is not v56''s' using errcode = '23514';
  end if;
  if to_regprocedure('training_load.forbid_update_delete()') is null then
    raise exception 'v67 refused: training_load.forbid_update_delete() is missing' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The acting user of a track choice
-- ---------------------------------------------------------------------------
create function training_load.track_choice_context_actor() returns uuid as $$
declare
  raw text := current_setting('optimove.track_choice_actor', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    raise exception 'track choice: no acting user is set for this transaction' using errcode = '42501';
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------
-- The fingerprint: every track of the athlete with its athlete-session row ids, '<track>:<row>,<row>;<track>:<row>', tracks and
-- rows in ascending numeric order, canonical GPEXE ids, at least two tracks. The server computes it from the candidate's bundle.
create table training_load.gpexe_track_choices (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  gpexe_team_session_id text not null check (gpexe_team_session_id ~ '^[0-9]{1,12}$'),
  gpexe_athlete_id text not null check (gpexe_athlete_id ~ '^(0|[1-9][0-9]{0,11})$'),
  track_set_fingerprint text not null check (
    char_length(track_set_fingerprint) <= 4000
    and track_set_fingerprint ~ '^(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,11})(,(0|[1-9][0-9]{0,11}))*(;(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,11})(,(0|[1-9][0-9]{0,11}))*)+$'
  ),
  choice varchar(10) not null check (choice in ('track', 'none', 'cleared')),
  chosen_track_id text check (chosen_track_id is null or chosen_track_id ~ '^(0|[1-9][0-9]{0,11})$'),
  chosen_by_user_id uuid not null references public.users(id) on delete restrict,
  chosen_basis text not null check (chosen_basis in ('platform_admin', 'team_grant', 'club_admin', 'team_coach')),
  chosen_grant_id uuid references training_load.gpexe_import_approvers(id) on delete restrict,
  chosen_at timestamptz not null default clock_timestamp(),
  supersedes_choice_id uuid unique references training_load.gpexe_track_choices(id) on delete restrict,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint gpexe_track_choices_track_named check ((choice = 'track') = (chosen_track_id is not null)),
  constraint gpexe_track_choices_grant_basis check ((chosen_basis = 'team_grant') = (chosen_grant_id is not null)),
  constraint gpexe_track_choices_request unique (chosen_by_user_id, request_key)
);
create unique index gpexe_track_choices_one_root
  on training_load.gpexe_track_choices (owner_team_id, gpexe_team_session_id, gpexe_athlete_id)
  where supersedes_choice_id is null;
create index gpexe_track_choices_athlete_idx
  on training_load.gpexe_track_choices (owner_team_id, gpexe_team_session_id, gpexe_athlete_id);

-- ---------------------------------------------------------------------------
-- 3. The guard
-- ---------------------------------------------------------------------------
create function training_load.validate_gpexe_track_choice() returns trigger as $$
declare
  v_actor uuid := training_load.track_choice_context_actor();
  v_right record;
  v_prior record;
begin
  if new.chosen_by_user_id is distinct from v_actor then
    raise exception 'track choice: the author must be the acting user' using errcode = '42501';
  end if;
  -- The approval's own right, under its locks (42501 when none; 55000 when the team's switch is off or in pilot mode).
  select r.basis, r.grant_id into v_right from training_load.lock_gpexe_import_approver(v_actor, new.owner_team_id) r limit 1;
  if v_right.basis is distinct from new.chosen_basis or v_right.grant_id is distinct from new.chosen_grant_id then
    raise exception 'track choice: the basis must be the acting user''s right' using errcode = '42501';
  end if;
  if new.choice = 'track' and position(';' || new.chosen_track_id || ':' in ';' || new.track_set_fingerprint) = 0 then
    raise exception 'track choice: the chosen track is one of the athlete''s tracks' using errcode = '23514';
  end if;
  if new.supersedes_choice_id is null then
    if new.choice = 'cleared' then
      raise exception 'track choice: there is no choice to clear' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.gpexe_track_choices c
                where c.owner_team_id = new.owner_team_id and c.gpexe_team_session_id = new.gpexe_team_session_id
                  and c.gpexe_athlete_id = new.gpexe_athlete_id) then
      raise exception 'track choice: a later choice supersedes the athlete''s current one' using errcode = '23514';
    end if;
    return new;
  end if;
  select c.owner_team_id, c.gpexe_team_session_id, c.gpexe_athlete_id, c.choice into v_prior
    from training_load.gpexe_track_choices c where c.id = new.supersedes_choice_id for update;
  if not found or v_prior.owner_team_id is distinct from new.owner_team_id
     or v_prior.gpexe_team_session_id is distinct from new.gpexe_team_session_id
     or v_prior.gpexe_athlete_id is distinct from new.gpexe_athlete_id then
    raise exception 'track choice: a choice supersedes a choice of the same athlete of the same session' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.gpexe_track_choices c where c.supersedes_choice_id = new.supersedes_choice_id) then
    raise exception 'track choice: the superseded choice is not the current one' using errcode = '23514';
  end if;
  if new.choice = 'cleared' and v_prior.choice = 'cleared' then
    raise exception 'track choice: there is no choice to clear' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger gpexe_track_choices_validate
  before insert on training_load.gpexe_track_choices
  for each row execute function training_load.validate_gpexe_track_choice();

-- Append-only, the session undo included.
create trigger gpexe_track_choices_no_update_delete
  before update or delete on training_load.gpexe_track_choices
  for each row execute function training_load.forbid_update_delete();
create trigger gpexe_track_choices_no_truncate
  before truncate on training_load.gpexe_track_choices
  for each statement execute function training_load.forbid_update_delete();
