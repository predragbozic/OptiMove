-- ============================================================
-- OPTIMOVE — Training load metrics v10: parameter catalog (domains,
-- categories, definitions, immutable semantic versions, classification
-- links).
--
-- Context: Training Load currently covers only RPE/sRPE
-- (training_load.session_feedback, untouched by this migration). This is
-- the first migration of a multi-file phase that extends Training Load to
-- an arbitrary, user-extensible set of metrics (GPS/external-load/manual/
-- future API imports) WITHOUT ever requiring a new column, table, or
-- hardcoded frontend case per metric — a metric is a row in
-- metric_definitions, never a schema change.
--
-- This migration deliberately does NOT touch monitoring2 (a separate,
-- read-only legacy database) and does NOT import any of its content — any
-- future port of monitoring2's own metric catalog is a separate, human-
-- reviewed data migration, not part of this schema change.
--
-- Model summary (full rationale worked out and reviewed across a separate
-- isolated schema proof before this migration was written):
--
-- * metric_definitions / metric_definition_versions: a STABLE identity
--   (key, label, icon, ownership — cosmetic, mutable in place) is kept
--   separate from its SEMANTIC content (unit, value type, validation
--   bounds, structured threshold/condition, daily aggregation method —
--   append-only, immutable once created). Changing a unit, threshold, or
--   aggregation method always creates a NEW version row and repoints
--   metric_definitions.current_version_id; it never rewrites an existing
--   version. A composite FK (definition_versions(id, metric_definition_id)
--   + metric_definitions' own composite FK on current_version_id)
--   declaratively guarantees the "current" version really belongs to the
--   same definition — not just that SOME version row exists.
-- * metric_domains / metric_categories / metric_structure_links: a
--   classification LINK is its own object (own identity, own ownership),
--   never columns on the definition — the exact same domain/category/
--   metric-definition nullable-combination semantics already reviewed
--   (a link may represent a domain-only or category-only classification
--   node, and the SAME metric may have more than one link — e.g. shown
--   under two different domains with independently configured temporal
--   smoothing on each link). temporal_smoothing_enabled lives on the LINK,
--   never on the definition (daily aggregation is a property of the
--   metric itself; temporal smoothing is a property of how it's being
--   viewed in a given classification context).
-- * metric_definition_hidden: per-user "hide this system/shared item from
--   my own catalog view" — never a real delete of shared content.
--
-- Ownership: every ownership-bearing table here uses the SAME
-- owner_scope/owner_user_id/owner_club_id/owner_team_id shape and CHECK
-- already used throughout training_load (see e.g.
-- training_load.planned_rpe_workspace_settings in v9) — 'system' (platform
-- admin only), 'club', 'team', or 'user' (a coach's own private content),
-- with exactly one owner id populated matching the scope. The application
-- layer (not this migration) enforces WHO may create which scope — see
-- backend/src/trainingLoadMetricsAccess.js.
-- ============================================================

create table training_load.metric_domains (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  is_active boolean not null default true,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create index metric_domains_owner_idx on training_load.metric_domains (owner_scope, owner_club_id, owner_team_id, owner_user_id);

create table training_load.metric_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  is_active boolean not null default true,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create index metric_categories_owner_idx on training_load.metric_categories (owner_scope, owner_club_id, owner_team_id, owner_user_id);

-- Stable identity + cosmetic fields only. current_version_id's real FK is
-- added below, once metric_definition_versions (and the composite unique
-- it needs) exists.
create table training_load.metric_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  label text not null,
  short_label text,
  description text,
  icon_url text,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  state varchar(20) not null default 'active' check (state in ('active', 'archived')),
  current_version_id uuid,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  ),
  -- Uniqueness of `key` is scoped to the owner, not global: two different
  -- private coaches (or two different clubs) may each independently define
  -- their own metric under the same short code without colliding.
  unique nulls not distinct (owner_scope, owner_user_id, owner_club_id, owner_team_id, key)
);

create index metric_definitions_owner_idx on training_load.metric_definitions (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index metric_definitions_owner_state_idx on training_load.metric_definitions (owner_scope, state);

-- Append-only. A row here is NEVER updated after insert — a semantic
-- change (unit/value type/bounds/condition/aggregation) always inserts a
-- NEW row and repoints metric_definitions.current_version_id; the OLD row
-- (and every metric_values row that captured a value under it) is
-- untouched forever, so a historical value is always interpreted against
-- the exact semantics that were live when it was measured.
create table training_load.metric_definition_versions (
  id uuid primary key default gen_random_uuid(),
  metric_definition_id uuid not null references training_load.metric_definitions(id) on delete restrict,
  version_number int not null check (version_number > 0),
  unit text,
  value_type varchar(20) not null check (value_type in ('numeric', 'boolean', 'text')),
  min_value numeric,
  max_value numeric,
  -- Structured, extensible threshold/condition description — e.g.
  -- {"operator":">","value":60,"unit":"W/kg"} or a range
  -- {"operator":"between","min":20,"max":25,"unit":"km/h"} — deliberately
  -- NOT a flat threshold/unit/operator column triple, so a metric whose
  -- defining condition is a range (or carries a relative reference, e.g.
  -- "relative_to":"body_mass") is representable without further migration.
  -- Descriptive in this phase (surfaced to the coach as documentation),
  -- not mechanically enforced against submitted values.
  condition_description jsonb,
  daily_aggregation_method varchar(20) not null default 'sum' check (daily_aggregation_method in ('sum', 'avg', 'max', 'last', 'none')),
  superseded_reason text,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (metric_definition_id, version_number),
  -- Enables the composite FK below on metric_definitions.current_version_id
  -- — declaratively guarantees "current" really belongs to THIS definition.
  unique (id, metric_definition_id)
);

create index metric_definition_versions_definition_idx on training_load.metric_definition_versions (metric_definition_id);

alter table training_load.metric_definitions
  add constraint metric_definitions_current_version_fk
  foreign key (current_version_id, id)
  references training_load.metric_definition_versions (id, metric_definition_id);

create function training_load.forbid_update_delete() returns trigger as $$
begin
  raise exception 'immutable row: % on %.% (id=%) is not permitted', tg_op, tg_table_schema, tg_table_name, coalesce(old.id::text, 'n/a');
end;
$$ language plpgsql;

create trigger metric_definition_versions_immutable
  before update or delete on training_load.metric_definition_versions
  for each row execute function training_load.forbid_update_delete();

create table training_load.metric_definition_hidden (
  user_id uuid not null references public.users(id) on delete cascade,
  definition_id uuid not null references training_load.metric_definitions(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, definition_id)
);

-- Classification link — own identity, own ownership, deliberately kept
-- separate from metric_definitions (see header). A link may reference any
-- non-empty combination of domain/category/definition; the SAME
-- definition may appear in more than one link (see the migration header's
-- worked example — same metric under two domains with independently
-- configured smoothing).
create table training_load.metric_structure_links (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references training_load.metric_domains(id) on delete cascade,
  category_id uuid references training_load.metric_categories(id) on delete cascade,
  metric_definition_id uuid references training_load.metric_definitions(id) on delete cascade,
  temporal_smoothing_enabled boolean not null default false,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  ),
  check (domain_id is not null or category_id is not null or metric_definition_id is not null),
  -- NULL-safe: "same domain, no category" (category_id NULL in two
  -- attempts) is a real duplicate, not silently allowed to repeat via NULL.
  unique nulls not distinct (owner_scope, owner_user_id, owner_club_id, owner_team_id, domain_id, category_id, metric_definition_id)
);

create index metric_structure_links_domain_category_idx on training_load.metric_structure_links (domain_id, category_id);
create index metric_structure_links_owner_idx on training_load.metric_structure_links (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index metric_structure_links_definition_idx on training_load.metric_structure_links (metric_definition_id);

-- Write-time guard: a link's own visibility footprint must never exceed
-- the footprint of any non-null target it references. A 'system' or
-- 'club'/'team' link may only reference targets that are 'system' or that
-- exact same club/team; a 'user' link (narrowest possible scope) may
-- reference anything its creator can see. This is defense-in-depth — the
-- authoritative leak protection is the READ-time visibility query in the
-- application layer, which independently re-checks every target's own
-- visibility for the current viewer (see trainingLoadMetricsAccess.js).
create function training_load.link_scope_within_target(
  link_scope varchar, link_club uuid, link_team uuid, link_user uuid,
  target_scope varchar, target_club uuid, target_team uuid, target_user uuid
) returns boolean as $$
begin
  if link_scope = 'user' then return true; end if;
  if target_scope = 'system' then return true; end if;
  if link_scope = 'system' then return false; end if;
  if link_scope = 'club' then return target_scope = 'club' and target_club = link_club; end if;
  if link_scope = 'team' then return target_scope = 'team' and target_team = link_team; end if;
  return false;
end;
$$ language plpgsql immutable;

create function training_load.validate_structure_link_scope_breadth() returns trigger as $$
declare
  target_scope varchar;
  target_club uuid;
  target_team uuid;
  target_user uuid;
begin
  if new.domain_id is not null then
    select owner_scope, owner_club_id, owner_team_id, owner_user_id into target_scope, target_club, target_team, target_user
      from training_load.metric_domains where id = new.domain_id;
    if not training_load.link_scope_within_target(new.owner_scope, new.owner_club_id, new.owner_team_id, new.owner_user_id, target_scope, target_club, target_team, target_user) then
      raise exception 'structure link owner_scope=% exceeds visibility of target domain %', new.owner_scope, new.domain_id;
    end if;
  end if;
  if new.category_id is not null then
    select owner_scope, owner_club_id, owner_team_id, owner_user_id into target_scope, target_club, target_team, target_user
      from training_load.metric_categories where id = new.category_id;
    if not training_load.link_scope_within_target(new.owner_scope, new.owner_club_id, new.owner_team_id, new.owner_user_id, target_scope, target_club, target_team, target_user) then
      raise exception 'structure link owner_scope=% exceeds visibility of target category %', new.owner_scope, new.category_id;
    end if;
  end if;
  if new.metric_definition_id is not null then
    select owner_scope, owner_club_id, owner_team_id, owner_user_id into target_scope, target_club, target_team, target_user
      from training_load.metric_definitions where id = new.metric_definition_id;
    if not training_load.link_scope_within_target(new.owner_scope, new.owner_club_id, new.owner_team_id, new.owner_user_id, target_scope, target_club, target_team, target_user) then
      raise exception 'structure link owner_scope=% exceeds visibility of target definition %', new.owner_scope, new.metric_definition_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_structure_links_scope_breadth
  before insert or update on training_load.metric_structure_links
  for each row execute function training_load.validate_structure_link_scope_breadth();
