-- Additive Builder RPE provenance. No legacy-owner or draft backfill.
set local lock_timeout = '5s';

select pg_advisory_xact_lock(hashtextextended('builder-rpe-provenance-v106', 0));

create table training_load.builder_rpe_provenance_use (
  singleton boolean primary key default true check (singleton),
  first_used_at timestamptz not null default clock_timestamp()
);

create table training_load.builder_rpe_plan_baselines (
  plan_id uuid primary key references plans.plans(id) on delete cascade,
  origin text not null check (origin in ('created', 'edit', 'copy')),
  source_plan_id uuid,
  source_updated_at timestamptz,
  owner_scope text,
  owner_user_id uuid,
  owner_club_id uuid,
  owner_team_id uuid,
  opening_tracking boolean not null,
  opening_rpe boolean not null,
  check (opening_tracking or not opening_rpe),
  check ((origin = 'created') = (source_plan_id is null)),
  check ((source_plan_id is null) = (source_updated_at is null)),
  check (
    (coalesce(owner_scope, 'unresolved') in ('system', 'unresolved') and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 0)
    or (coalesce(owner_scope, '') = 'user' and owner_user_id is not null and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 1)
    or (coalesce(owner_scope, '') = 'club' and owner_club_id is not null and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 1)
    or (coalesce(owner_scope, '') = 'team' and owner_team_id is not null and num_nonnulls(owner_user_id, owner_club_id, owner_team_id) = 1)
  )
);

create table training_load.builder_rpe_session_baselines (
  plan_id uuid not null references training_load.builder_rpe_plan_baselines(plan_id) on delete cascade,
  session_id uuid not null,
  logical_session_id uuid,
  source_plan_id uuid,
  source_session_id uuid,
  opening_tracking boolean not null,
  opening_rpe boolean not null,
  primary key (plan_id, session_id),
  unique (plan_id, source_plan_id, source_session_id),
  check ((source_plan_id is null) = (source_session_id is null)),
  check (opening_tracking or not opening_rpe)
);

create table training_load.builder_rpe_plan_effects (
  plan_id uuid primary key references training_load.builder_rpe_plan_baselines(plan_id) on delete cascade,
  changed_tracking boolean not null,
  changed_rpe boolean not null,
  effective_tracking boolean not null,
  effective_rpe boolean not null,
  check (changed_tracking or changed_rpe),
  check (effective_tracking or not effective_rpe)
);

create table training_load.builder_rpe_session_effects (
  plan_id uuid not null,
  session_id uuid not null,
  changed_tracking boolean not null,
  changed_rpe boolean not null,
  effective_tracking boolean not null,
  effective_rpe boolean not null,
  primary key (plan_id, session_id),
  foreign key (plan_id, session_id) references training_load.builder_rpe_session_baselines(plan_id, session_id) on delete cascade,
  check (changed_tracking or changed_rpe),
  check (effective_tracking or not effective_rpe)
);

revoke all on training_load.builder_rpe_provenance_use, training_load.builder_rpe_plan_baselines,
  training_load.builder_rpe_session_baselines, training_load.builder_rpe_plan_effects,
  training_load.builder_rpe_session_effects from public;
