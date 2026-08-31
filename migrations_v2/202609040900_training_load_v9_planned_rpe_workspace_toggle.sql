-- ============================================================
-- OPTIMOVE — Training load (RPE/sRPE) v9: a workspace-level MASTER
-- toggle for automatic planned-session RPE collection.
--
-- Context: every previous training_load migration (v1-v8) is already
-- deployed - this file is purely additive, touches no earlier
-- statement, and does not alter plans.* at all.
--
-- Until now, "does this Weekly-plan session collect RPE" was decided
-- entirely per-session (plans.plan_sessions.rpe_enabled, defaulting to
-- true - see v3). That means a brand-new coach/club/team gets asked for
-- RPE on EVERY planned session from day one, with no way to opt in
-- deliberately. This migration adds one more gate ABOVE the per-session
-- one: a workspace-scoped switch that must ALSO be on before a planned
-- session is ever RPE-actionable. The effective rule (enforced in
-- routes/trainingLoad.js, not here) is:
--
--   workspace automatic planned RPE enabled AND session.rpe_enabled
--
-- Ownership shape deliberately mirrors training_load.external_schedules'
-- own owner_scope/owner_user_id/owner_club_id/owner_team_id columns
-- (migrations_v2/202609011000) - "who configures this" is decided the
-- same way "who owns this external schedule" already is, via the
-- account's CURRENTLY ACTIVE workspace (see trainingLoadAccess.js).
--
-- Resolving which workspace(s) govern a given ATHLETE's own planned
-- session is a different question from schedule ownership, though: a
-- Weekly Plan session has no owner_club_id/owner_team_id of its own (see
-- create_builder_schema.sql - plans.plans only carries created_by_user_id/
-- athlete_id). This migration's own planned_rpe_effective_for_athlete()
-- function below resolves it via the athlete's own CURRENT active
-- relationships instead (club/team membership, private-coach relation) -
-- "any qualifying scope currently on" wins (an athlete privately coached
-- AND club-affiliated at once is asked for RPE if EITHER context wants
-- it), never a strict single-owner precedence. This is a real
-- architectural decision, not an accident - see this branch's own final
-- report for the reasoning and the risk if a stricter single-owner model
-- was actually intended.
-- ============================================================

create table training_load.planned_rpe_workspace_settings (
  id uuid primary key default gen_random_uuid(),

  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,

  -- Absent row = OFF (see planned_rpe_effective_for_athlete below, which
  -- treats "no matching row" identically to "matching row, enabled =
  -- false") - a workspace that has never touched this switch gets the
  -- safe default: no athlete is asked for RPE until a coach deliberately
  -- opts in. There is no separate "never configured" tri-state to track.
  enabled boolean not null default false,

  -- Set to now() only on a genuine false -> true transition (see the
  -- PATCH route) - re-toggling an already-true value back to true is a
  -- no-op that must NEVER push this forward, or a coach idly re-saving
  -- the form would keep resetting their own athletes' backlog cutoff.
  -- Read by planned_rpe_effective_for_athlete as the retroactivity
  -- cutoff: a planned session's own calendar date must be on or after
  -- this value's date before it can ever become actionable again after
  -- a re-enable - turning the switch back on after a long OFF stretch
  -- must never suddenly flood the athlete with every missed day.
  enabled_at timestamptz,

  updated_at timestamptz not null default now(),
  updated_by_user_id uuid references public.users(id) on delete restrict,

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  ),
  check (enabled = false or enabled_at is not null),

  -- The idempotency/upsert key - one settings row per real workspace
  -- scope, ever. NULLS NOT DISTINCT because owner_user_id/owner_club_id/
  -- owner_team_id are NULL for two of the three non-system scopes at any
  -- given row - a plain UNIQUE would never actually catch a duplicate
  -- (same reasoning as external_schedule_targets' own unique index).
  unique nulls not distinct (owner_scope, owner_user_id, owner_club_id, owner_team_id),

  foreign key (owner_team_id, owner_club_id) references public.teams (id, club_id)
);

-- Resolves the single effective boolean for one athlete's own planned
-- session, on one specific calendar date - "any currently-qualifying
-- scope enabled, and this date is on/after THAT scope's own enabled_at
-- cutoff" (see this file's own header for why "any wins" rather than a
-- strict single-owner precedence). Called from every planned-RPE read/
-- write path (GET /athlete/today, GET /weekly, POST /sessions/:id/rpe)
-- so they can never disagree, by construction - the same discipline
-- external scheduling's own ensureCurrentExternalOccurrence already
-- established for occurrence generation.
create function training_load.planned_rpe_effective_for_athlete(p_athlete_id uuid, p_date date)
returns boolean language sql stable as $$
  select exists (
    select 1
    from training_load.planned_rpe_workspace_settings s
    where s.enabled = true
      and p_date >= (s.enabled_at at time zone 'UTC')::date
      and (
        s.owner_scope = 'system'
        or (s.owner_scope = 'club' and exists (
              select 1 from public.athlete_memberships m
              where m.athlete_id = p_athlete_id and m.membership_type = 'club'
                and m.status = 'active' and m.club_id = s.owner_club_id
            ))
        or (s.owner_scope = 'team' and exists (
              select 1 from public.athlete_memberships m
              where m.athlete_id = p_athlete_id and m.membership_type = 'team'
                and m.status = 'active' and m.team_id = s.owner_team_id
            ))
        or (s.owner_scope = 'user' and exists (
              select 1 from public.user_athletes ua
              where ua.athlete_id = p_athlete_id and ua.user_id = s.owner_user_id and ua.is_active = true
            ))
      )
  )
$$;
