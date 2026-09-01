-- ============================================================
-- OPTIMOVE — Training load (RPE/sRPE) v9: a workspace-level MASTER
-- toggle for automatic planned-session RPE collection.
--
-- Context: every previous training_load migration (v1-v8) is already
-- deployed - this file is purely additive, touches no earlier
-- statement, and does not alter plans.* at all. This file itself is
-- still unmerged on its own branch, so it is corrected IN PLACE below
-- rather than superseded by a new v10 - see this branch's own commit
-- history for the review that drove this correction.
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
-- HARDENING CORRECTION (was: "any qualifying scope wins"). The first cut
-- of this migration resolved a plan session's governing workspace from
-- the ATHLETE's own CURRENT memberships at read time - "any scope that
-- currently has a relationship to this athlete and is enabled, wins".
-- That is wrong: an athlete privately coached AND club-affiliated at
-- once got asked for RPE on their PRIVATE plan the instant the CLUB
-- turned its own switch on, even with Private Coaching left off - a
-- real workspace-isolation leak, and system=true was worse still
-- (turned RPE on for every plan of every athlete, unconditionally).
--
-- The fix: a Weekly Plan session's own governing workspace is now a
-- STABLE, STORED SNAPSHOT - training_load.plan_workspace_ownership,
-- ONE row per plans.plans.id (weekly plans only), holding the SAME
-- owner_scope/owner_*_id shape. It is written exactly ONCE, in
-- routes/builder.js, at the moment a real live/duplicate/assign weekly
-- plan is created (resolved from the CREATING coach's own then-active
-- workspace - the exact same scope.ownerContext trainingLoadAccess.js
-- already produces for external schedules), or copied verbatim from the
-- SOURCE plan when an edit-draft is created (POST /plans/:planId/edit) -
-- never re-derived from current membership. A later change/removal of
-- the athlete's OWN membership elsewhere can never retroactively move an
-- already-created plan to a different scope, and the athlete's other,
-- unrelated memberships never apply to a plan they don't own.
-- planned_rpe_effective_for_plan(plan_id, date) below replaces the old
-- athlete-scoped function - it is genuinely plan/session-scoped now, and
-- is the only function training_load's own routes ever call for this.
--
-- Legacy backfill (existing weekly plans, from BEFORE this table
-- existed): a real "who created this and under what workspace" record
-- was never kept before now, so it cannot be reconstructed exactly.
-- Rather than guess among multiple plausible club/team scopes, the rule
-- below is deliberately conservative and fully deterministic: a legacy
-- plan is auto-resolved to a real club scope ONLY when its athlete
-- currently has EXACTLY ONE active membership row of ANY kind, that row
-- is club-type (never team-type), and the athlete has ZERO active
-- private-coach relationships - the one case where there is genuinely no
-- ambiguity to guess through. Every other legacy plan (multiple
-- memberships, any team-type membership, any private-coach relation, or
-- no membership at all) is stamped owner_scope='unresolved' - it stores
-- a real row (not silently absent) so it is queryable/auditable, but
-- planned_rpe_effective_for_plan can never match it (no
-- planned_rpe_workspace_settings row is ever 'unresolved'), so it stays
-- inactive for automatic planned RPE until an explicit, real workspace
-- action re-resolves it (out of this hotfix's own scope).
-- ============================================================

create table training_load.planned_rpe_workspace_settings (
  id uuid primary key default gen_random_uuid(),

  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,

  -- Absent row = OFF (see planned_rpe_effective_for_plan below, which
  -- treats "no matching row" identically to "matching row, enabled =
  -- false") - a workspace that has never touched this switch gets the
  -- safe default: no athlete is asked for RPE until a coach deliberately
  -- opts in. There is no separate "never configured" tri-state to track.
  enabled boolean not null default false,

  -- Set to now() only on a genuine false -> true transition (see the
  -- PATCH route) - re-toggling an already-true value back to true is a
  -- no-op that must NEVER push this forward, or a coach idly re-saving
  -- the form would keep resetting their own athletes' backlog cutoff.
  -- Read by planned_rpe_effective_for_plan as the retroactivity cutoff,
  -- evaluated in the OWNING ATHLETE's own local date (device_timezone,
  -- falling back to UTC) - a plain UTC cutoff could re-activate an
  -- athlete's own previous local day for anyone west of UTC at the
  -- moment a coach re-enables the switch. A planned session's own
  -- calendar date must be on or after that local cutoff date before it
  -- can ever become actionable again after a re-enable - turning the
  -- switch back on after a long OFF stretch must never suddenly flood
  -- the athlete with every missed day.
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

-- ------------------------------------------------------------
-- Plan ownership snapshot - see this file's own header for the full
-- design rationale. One row per weekly plans.plans.id, written once at
-- plan-creation time (routes/builder.js) or copied from the source plan
-- for an edit-draft, never re-derived afterward.
-- ------------------------------------------------------------
create table training_load.plan_workspace_ownership (
  plan_id uuid primary key references plans.plans(id) on delete cascade,

  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user', 'unresolved')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,

  -- When this snapshot was actually taken - a real creation-time
  -- timestamp for a live/duplicate/assign, or the copy time for an
  -- edit-draft (its own row, copied verbatim from the source's owner_*
  -- columns, but with its OWN resolved_at - never confused with "when
  -- the ORIGINAL plan was created").
  resolved_at timestamptz not null default now(),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null) or
    (owner_scope = 'unresolved' and owner_user_id is null and owner_club_id is null and owner_team_id is null)
  ),

  foreign key (owner_team_id, owner_club_id) references public.teams (id, club_id)
);

-- Resolves the single effective boolean for one specific PLAN's own
-- session, on one specific calendar date - the plan's own STORED
-- ownership snapshot (never the athlete's current, possibly-unrelated
-- memberships) matched against that exact scope's own settings row,
-- with the enabled_at cutoff evaluated in the OWNING ATHLETE's own local
-- date. Called from every planned-RPE read/write path (GET /athlete/
-- today, GET /weekly, POST /sessions/:id/rpe) so they can never
-- disagree, by construction - the same discipline external scheduling's
-- own ensureCurrentExternalOccurrence already established for occurrence
-- generation. A plan with no ownership row at all (never should happen
-- for anything created after this migration, see routes/builder.js) or
-- owner_scope='unresolved' can never match any real settings row -
-- correctly, permanently inactive until the ownership is confirmed.
create function training_load.planned_rpe_effective_for_plan(p_plan_id uuid, p_date date)
returns boolean language sql stable as $$
  select exists (
    select 1
    from training_load.plan_workspace_ownership o
    join training_load.planned_rpe_workspace_settings s
      on s.owner_scope = o.owner_scope
     and s.owner_user_id is not distinct from o.owner_user_id
     and s.owner_club_id is not distinct from o.owner_club_id
     and s.owner_team_id is not distinct from o.owner_team_id
    join plans.plans p on p.id = o.plan_id
    join public.athletes a on a.id = p.athlete_id
    where o.plan_id = p_plan_id
      and s.enabled = true
      and p_date >= (s.enabled_at at time zone coalesce(a.device_timezone, 'UTC'))::date
  )
$$;

-- ------------------------------------------------------------
-- Legacy backfill - see this file's own header for the exact rule.
-- Runs once, here, for every weekly plan that predates this table.
-- ------------------------------------------------------------
with athlete_signal as (
  select
    a.id as athlete_id,
    (select count(*)::int from public.athlete_memberships m where m.athlete_id = a.id and m.status = 'active') as membership_count,
    (select count(*)::int from public.athlete_memberships m where m.athlete_id = a.id and m.status = 'active' and m.membership_type = 'team') as team_membership_count,
    (select count(*)::int from public.user_athletes ua where ua.athlete_id = a.id and ua.is_active = true) as private_coach_count,
    (select m.club_id from public.athlete_memberships m where m.athlete_id = a.id and m.status = 'active' limit 1) as sole_club_id
  from public.athletes a
),
unambiguous_athlete as (
  select athlete_id, sole_club_id
  from athlete_signal
  where membership_count = 1 and team_membership_count = 0 and private_coach_count = 0
)
insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id)
select p.id, 'club', ua.sole_club_id
from plans.plans p
join unambiguous_athlete ua on ua.athlete_id = p.athlete_id
where p.plan_type = 'weekly'
  and not exists (select 1 from training_load.plan_workspace_ownership existing where existing.plan_id = p.id)
on conflict (plan_id) do nothing;

insert into training_load.plan_workspace_ownership (plan_id, owner_scope)
select p.id, 'unresolved'
from plans.plans p
where p.plan_type = 'weekly'
  and not exists (select 1 from training_load.plan_workspace_ownership existing where existing.plan_id = p.id)
on conflict (plan_id) do nothing;
