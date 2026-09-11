-- ============================================================
-- OPTIMOVE — Training Load 3B2: Analysis Dashboard v15 — widget/built-in
-- series catalogs, and the dashboards table with its ownership/data-
-- workspace contract.
--
-- This is migration 1 of 4 for the Analysis Dashboard feature (3B2). The
-- model, every invariant below, and the query semantics it supports were
-- worked out and proven across six corrective rounds of an isolated,
-- disposable-database schema proof (see the design history on
-- feature/training-load-analysis-dashboard-model — schema.sql,
-- test-harness.mjs, DASHBOARD_MODEL_REPORT.md, DASHBOARD_UX_SPEC.md — the
-- final, confirmed Round 6 state of those files is this migration's
-- contract source, translated here into real, additive migrations_v2
-- files and real backend code). Nothing in this migration touches any
-- existing table, column, trigger, or function.
--
-- Central design decision carried over unchanged: OWNERSHIP (who may
-- see/edit/clone a dashboard row) and DATA WORKSPACE (which workspace's
-- metric_definitions/source_connections/activities/athletes a dashboard's
-- widgets may ever read) are two SEPARATE concepts, not one owner_scope
-- doing both jobs.
--   * owner_scope/owner_user_id/owner_club_id/owner_team_id — the SAME
--     4-value (system/club/team/user) shape already used throughout
--     training_load (metric_definitions, external_schedules, ...) —
--     visibility/edit/clone rights only.
--   * data_workspace_type/data_workspace_scope_id — the 5-value WORKSPACE
--     shape (platform/private_coach/club/team/athlete), the SAME shape as
--     public.user_workspace_preferences / resolveActiveWorkspace's own
--     workspace concept, deliberately NOT the 4-value owner_scope shape,
--     because this is genuinely a workspace-context binding, not an
--     ownership-scope binding. A 'user'-owned (private) dashboard picks
--     ANY ONE data workspace at creation time and is permanently bound to
--     it, write-once from the moment the row exists — the same coach may
--     have several different private dashboards, each bound to a
--     different data workspace. A 'club'/'team'-owned dashboard's data
--     workspace is always that exact same club/team — no independent
--     choice. A 'system'-owned dashboard is ALWAYS a template
--     (owner_scope='system' implies is_template=true) and always
--     workspace-agnostic (data_workspace_type IS NULL) until cloned — a
--     clone is where a concrete data-workspace context snapshot is first
--     assigned.
-- ============================================================

-- ------------------------------------------------------------
-- Widget type catalog — a new widget type is an INSERT (seeded in v18,
-- migration 4), never a further migration. min/max size and max_series
-- live HERE, not hardcoded into a CHECK on dashboard_widgets, so future
-- catalog growth never requires a schema change to the widgets table.
-- ------------------------------------------------------------
create table training_load.dashboard_widget_types (
  key text primary key,
  label text not null,
  min_width smallint not null check (min_width between 1 and 12),
  max_width smallint not null check (max_width between 1 and 12),
  min_height smallint not null check (min_height >= 1),
  max_height smallint not null check (max_height >= 1),
  default_width smallint not null,
  default_height smallint not null,
  max_series smallint check (max_series is null or max_series >= 1),
  -- Does this type render a shared visual axis at all? Only line/bar
  -- charts do — a KPI/Table's series are independent numbers/columns with
  -- no real axis-unit ambiguity. Read by the axis-unit validation trigger
  -- (v16) instead of a hardcoded key list, so a future chart type (radar,
  -- scatter) just sets this true, no trigger edit needed.
  has_shared_axis boolean not null default false,
  -- Only a KPI shows a single-scalar prior-period comparison in this
  -- phase — read by the comparison_period validation trigger (v16), same
  -- "config, not hardcoded key list" reasoning.
  supports_comparison_period boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (min_width <= max_width),
  check (min_height <= max_height),
  check (default_width between min_width and max_width),
  check (default_height between min_height and max_height)
);

-- Size/series-cap/axis/comparison-period contract becomes immutable the
-- moment ANY widget references this type — a catalog change that would
-- retroactively invalidate an EXISTING widget's already-saved layout/
-- series (e.g. shrinking max_width below a widget's current width, or
-- lowering max_series below a widget's current series count) is rejected
-- outright, not silently left unchecked. is_active and label stay freely
-- mutable — deactivating a type must not break existing widgets, it only
-- blocks NEW widgets of that type (see dashboard_widgets_validate_layout
-- in v16).
create function training_load.protect_dashboard_widget_types_once_used() returns trigger as $$
declare
  in_use boolean;
begin
  if new.min_width is not distinct from old.min_width
     and new.max_width is not distinct from old.max_width
     and new.min_height is not distinct from old.min_height
     and new.max_height is not distinct from old.max_height
     and new.max_series is not distinct from old.max_series
     and new.has_shared_axis is not distinct from old.has_shared_axis
     and new.supports_comparison_period is not distinct from old.supports_comparison_period then
    return new;
  end if;
  select exists (select 1 from training_load.dashboard_widgets where widget_type = old.key) into in_use;
  if in_use then
    raise exception 'dashboard_widget_types (key=%): already referenced by a widget — size/series-cap/axis/comparison-period contract is immutable once in use; is_active, label, and the default_width/default_height picker hints stay mutable', old.key;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_types_protect_once_used
  before update on training_load.dashboard_widget_types
  for each row execute function training_load.protect_dashboard_widget_types_once_used();

-- ------------------------------------------------------------
-- Built-in series catalog — stable, non-Metrics-Core series a widget can
-- plot: RPE/sRPE/duration/session_count/last_session_date, read by the
-- query engine directly from training_load.session_feedback / training.*
-- activity data, NEVER copied into metric_values. Seeded in v18.
-- ------------------------------------------------------------
create table training_load.dashboard_builtin_series (
  key text primary key,
  label text not null,
  unit text,
  value_type varchar(20) not null check (value_type in ('numeric', 'boolean', 'text')),
  -- Only a suggested UI default for the widget's own, freely-choosable
  -- analytical_aggregation (dashboard_widget_series, v16) — never an
  -- enforced equality; each series row freezes its OWN choice at creation
  -- time, so tweaking this suggested default later is harmless (excluded
  -- from the semantics-immutability trigger below).
  default_analytical_aggregation varchar(20) not null check (default_analytical_aggregation in ('sum', 'avg', 'max', 'last', 'none')),
  fixed_data_scope_level varchar(20) not null check (fixed_data_scope_level in ('day', 'session', 'component')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- unit/value_type/scope-level semantics become immutable the moment ANY
-- series references this built-in — silently changing what "srpe" MEANS
-- would reinterpret every widget already plotting it.
create function training_load.protect_builtin_series_semantics_once_used() returns trigger as $$
declare
  in_use boolean;
begin
  if new.unit is not distinct from old.unit
     and new.value_type is not distinct from old.value_type
     and new.fixed_data_scope_level is not distinct from old.fixed_data_scope_level then
    return new;
  end if;
  select exists (select 1 from training_load.dashboard_widget_series where built_in_series_key = old.key) into in_use;
  if in_use then
    raise exception 'dashboard_builtin_series (key=%): already referenced by a widget — unit/value_type/scope semantics are immutable', old.key;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_builtin_series_protect_semantics
  before update on training_load.dashboard_builtin_series
  for each row execute function training_load.protect_builtin_series_semantics_once_used();

-- ------------------------------------------------------------
-- Dashboards.
-- ------------------------------------------------------------
create table training_load.dashboards (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  data_workspace_type varchar(20) check (data_workspace_type in ('platform', 'private_coach', 'club', 'team', 'athlete')),
  data_workspace_scope_id uuid,
  is_template boolean not null default false,
  status varchar(20) not null default 'active' check (status in ('active', 'archived')),
  cloned_from_dashboard_id uuid references training_load.dashboards(id) on delete restrict,
  default_filter jsonb,
  -- Bumps on a direct field edit (name/description/is_template/status/
  -- default_filter) AND whenever the widget SET changes (a widget is
  -- added or removed, v16) — it intentionally does NOT bump on an
  -- individual widget's own content/position/series changes, that is
  -- what each widget's OWN revision (v16) is for.
  revision integer not null default 1,
  created_by_user_id uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  ),
  -- A system-owned dashboard is always a template — there is no "live"
  -- system dashboard in this model, only templates awaiting clone.
  check (owner_scope <> 'system' or is_template = true),
  -- Shape of the data-workspace binding — NULL only for a system
  -- template; otherwise a real, shape-valid workspace.
  check (
    (owner_scope = 'system' and data_workspace_type is null and data_workspace_scope_id is null) or
    (owner_scope <> 'system' and data_workspace_type is not null and (
      (data_workspace_type in ('club', 'team') and data_workspace_scope_id is not null) or
      (data_workspace_type in ('platform', 'private_coach', 'athlete') and data_workspace_scope_id is null)
    ))
  ),
  -- A club/team-OWNED dashboard's data workspace is always that exact
  -- same club/team — no independent choice for these two scopes (only a
  -- 'user'-owned dashboard genuinely picks one).
  check (owner_scope <> 'club' or (data_workspace_type = 'club' and data_workspace_scope_id = owner_club_id)),
  check (owner_scope <> 'team' or (data_workspace_type = 'team' and data_workspace_scope_id = owner_team_id)),
  -- A dashboard can never claim to be cloned from itself. Cycle detection
  -- (A clones B clones A) and "the referenced dashboard must actually be
  -- a template" cannot be expressed as a plain CHECK (both need to read
  -- OTHER rows) — see dashboards_validate_clone_provenance below.
  check (cloned_from_dashboard_id is null or cloned_from_dashboard_id <> id)
);

create index dashboards_owner_idx on training_load.dashboards (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index dashboards_owner_status_idx on training_load.dashboards (owner_scope, status);
create index dashboards_template_idx on training_load.dashboards (owner_scope, is_template) where is_template = true;
create index dashboards_data_workspace_idx on training_load.dashboards (data_workspace_type, data_workspace_scope_id);

-- owner_scope AND the data-workspace binding are governed by this one
-- write-once trigger — a dashboard's data workspace is exactly as
-- security-sensitive as its owner_scope (silently rebinding a private
-- dashboard from Club A's data to Club B's data after the fact is
-- precisely the cross-workspace leak this model exists to close).
-- Genuinely, unconditionally immutable from the moment the row exists,
-- whether or not anything yet references it. Changing a dashboard's
-- workspace always means creating (or cloning) a NEW dashboard, never
-- updating this one — even for a dashboard with zero widgets.
create function training_load.protect_dashboard_ownership_once_used() returns trigger as $$
begin
  if new.owner_scope is distinct from old.owner_scope
     or new.owner_user_id is distinct from old.owner_user_id
     or new.owner_club_id is distinct from old.owner_club_id
     or new.owner_team_id is distinct from old.owner_team_id
     or new.data_workspace_type is distinct from old.data_workspace_type
     or new.data_workspace_scope_id is distinct from old.data_workspace_scope_id then
    raise exception 'training_load.dashboards (id=%): owner_scope and data_workspace are immutable from creation — create or clone a new dashboard instead', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_protect_ownership
  before update on training_load.dashboards
  for each row execute function training_load.protect_dashboard_ownership_once_used();

-- created_by_user_id and cloned_from_dashboard_id are identity/audit
-- fields, not ordinary content — unconditionally write-once from the
-- moment the row exists. cloned_from_dashboard_id going NULL -> a value
-- on a later UPDATE is exactly as forbidden as value -> a different
-- value: clone provenance is decided once, at INSERT time, or never (see
-- dashboards_validate_clone_provenance below for the INSERT-time checks).
create function training_load.dashboards_protect_identity_once_created() returns trigger as $$
begin
  if new.created_by_user_id is distinct from old.created_by_user_id then
    raise exception 'training_load.dashboards (id=%): created_by_user_id is immutable', old.id;
  end if;
  if new.cloned_from_dashboard_id is distinct from old.cloned_from_dashboard_id then
    raise exception 'training_load.dashboards (id=%): cloned_from_dashboard_id is immutable after creation', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_protect_identity_once_created
  before update on training_load.dashboards
  for each row execute function training_load.dashboards_protect_identity_once_created();

-- The two clone-provenance rules that can't be a plain CHECK — the
-- referenced dashboard must actually be a template, and the chain can
-- never cycle back to this row. BEFORE INSERT only — cloned_from_
-- dashboard_id can never change after insert anyway (see the write-once
-- trigger above), so there is nothing to re-validate on UPDATE.
--
-- SNAPSHOT SEMANTICS: cloned_from_dashboard_id means "this dashboard WAS
-- a template at the moment it was cloned" — a historical provenance
-- fact, never a live constraint the source must keep satisfying forever.
-- Once this INSERT commits, nothing about the SOURCE dashboard's own
-- later is_template flips can retroactively invalidate this clone's
-- already-recorded lineage (this trigger only ever fires on the CLONE's
-- own insert, never re-runs against a source that changes afterward) —
-- that half of snapshot semantics falls out for free from the design
-- already being INSERT-only. The half that needs a real fix: the read of
-- the SOURCE's own is_template is race-prone unless locked — `FOR SHARE`
-- on the source dashboard row BEFORE reading is_template genuinely
-- serializes against a concurrent template-flip. Whichever happens first
-- wins outright: a flip that commits BEFORE this lock is acquired is
-- correctly seen and rejects the clone; a clone whose lock (and
-- is_template read) commits BEFORE a later flip is unaffected by that
-- later flip, by construction.
create function training_load.dashboards_validate_clone_provenance() returns trigger as $$
declare
  v_current uuid;
  v_is_template boolean;
  v_depth integer := 0;
begin
  if new.cloned_from_dashboard_id is null then
    return new;
  end if;
  perform 1 from training_load.dashboards where id = new.cloned_from_dashboard_id for share;
  select is_template into v_is_template from training_load.dashboards where id = new.cloned_from_dashboard_id;
  if not found then
    raise exception 'training_load.dashboards: cloned_from_dashboard_id % does not exist', new.cloned_from_dashboard_id;
  end if;
  if not v_is_template then
    raise exception 'training_load.dashboards: cloned_from_dashboard_id % is not a template (is_template=false) — cloned_from_dashboard_id must reference a valid template', new.cloned_from_dashboard_id;
  end if;
  -- Bounded walk up the clone-provenance chain. A real template in this
  -- model is always hand-authored with cloned_from_dashboard_id NULL, so
  -- in practice this loop terminates in one hop — but it walks for real,
  -- defensively, rather than trusting that convention alone, and is
  -- bounded at 50 hops so a corrupt chain can never hang the insert.
  v_current := new.cloned_from_dashboard_id;
  while v_current is not null and v_depth < 50 loop
    if v_current = new.id then
      raise exception 'training_load.dashboards (id=%): clone provenance cycle detected via %', new.id, new.cloned_from_dashboard_id;
    end if;
    select cloned_from_dashboard_id into v_current from training_load.dashboards where id = v_current;
    v_depth := v_depth + 1;
  end loop;
  if v_depth >= 50 then
    raise exception 'training_load.dashboards: clone provenance chain too deep (possible cycle) starting at %', new.cloned_from_dashboard_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_validate_clone_provenance
  before insert on training_load.dashboards
  for each row execute function training_load.dashboards_validate_clone_provenance();

-- is_template is free to flip in either direction regardless of any
-- series' resolution_status — a real (non-template) dashboard holding an
-- unresolved/ambiguous series is an intentional, safe, fixable state (the
-- query engine refuses to ever query a non-'resolved' series), never a
-- state that blocks a template-flag change.

create function training_load.dashboards_bump_revision() returns trigger as $$
begin
  if new.name is distinct from old.name
     or new.description is distinct from old.description
     or new.is_template is distinct from old.is_template
     or new.status is distinct from old.status
     or new.default_filter is distinct from old.default_filter then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_bump_revision
  before update on training_load.dashboards
  for each row execute function training_load.dashboards_bump_revision();

-- The missing half of the dashboard-revision contract — the WIDGET SET
-- changing (one added or removed) is a structural change to the
-- dashboard just as much as renaming it, and must bump dashboards.
-- revision too, or a client caching "the whole dashboard" by its own
-- revision would never notice a widget was added/removed. Called from
-- v16's own dashboard_widgets triggers (dashboard_widgets does not exist
-- yet in this migration).
create function training_load.bump_dashboard_revision(p_dashboard_id uuid) returns void as $$
begin
  update training_load.dashboards set revision = revision + 1, updated_at = now() where id = p_dashboard_id;
end;
$$ language plpgsql;
