-- ============================================================
-- OPTIMOVE — Training Load 3B1: Analysis Dashboard model (DESIGN / PoC
-- ONLY — not a real migrations_v2 file, not applied to any real database).
-- Round 2 (corrective): owner/data-workspace split, real series query
-- semantics, revision/lock/atomic-layout fixes, reverse invariants, and a
-- real PoC query adapter (see test-harness.mjs). See
-- DASHBOARD_MODEL_REPORT.md for full rationale — this file's comments
-- point back at that report's section numbers rather than re-arguing each
-- choice inline.
--
-- Purely additive over the REAL, already-deployed schema (migrations_v2
-- through 202609080900_training_load_v14, plus 202609071*_training_activity
-- v1-v4). No existing table, column, trigger, or function from those real
-- migrations is altered, renamed, or dropped anywhere below.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Widget type catalog — a new widget type is an INSERT, never a
--    migration. min/max size, max_series live HERE, not hardcoded into a
--    CHECK on dashboard_widgets. Report §D3.
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
  -- Round 2, §4: does this type render a shared visual axis at all? Only
  -- line/bar charts do — a KPI/Table's series are independent numbers/
  -- columns with no real axis-unit ambiguity (report §D "axis-unit scoped
  -- to chart types"). Read by dashboard_widget_series_validate_axis_unit
  -- below instead of a hardcoded key list, so a FUTURE chart type (radar,
  -- scatter) just sets this true, no trigger edit needed.
  has_shared_axis boolean not null default false,
  -- Round 2, §4: only a KPI shows a single-scalar prior-period comparison
  -- in this phase — read by the comparison_period validation trigger
  -- below, same "config, not hardcoded key list" reasoning.
  supports_comparison_period boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (min_width <= max_width),
  check (min_height <= max_height),
  check (default_width between min_width and max_width),
  check (default_height between min_height and max_height)
);

insert into training_load.dashboard_widget_types
  (key, label, min_width, max_width, min_height, max_height, default_width, default_height, max_series, has_shared_axis, supports_comparison_period) values
  ('kpi',        'KPI',        2, 4,  2, 3,  3, 2, 1,  false, true),
  ('table',      'Table',      3, 12, 3, 12, 6, 4, 12, false, false),
  ('line_chart', 'Line chart', 3, 12, 3, 8,  6, 4, 8,  true,  false),
  ('bar_chart',  'Bar chart',  3, 12, 3, 8,  6, 4, 8,  true,  false);

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

-- Round 2, §4 "catalog rows must not retroactively change meaning": `key`
-- is the PK and is referenced by dashboard_widgets.widget_type with the
-- default NO ACTION — Postgres itself already refuses to change a
-- referenced key, so no extra trigger is needed for key immutability.
-- is_active is checked only on a genuinely NEW widget or a widget_type
-- CHANGE (not on an ordinary resize of an already-existing widget of that
-- type) — see dashboard_widgets_validate_layout below.
--
-- Round 3, §7 CORRECTION: Round 2 previously let min/max width/height,
-- max_series, has_shared_axis, and supports_comparison_period keep
-- changing freely even after widgets referenced a type, reasoning that
-- the per-widget validation triggers only fire on that widget's OWN
-- future writes so a shrink is "harmless". The task explicitly rejects
-- that framing: a catalog change that would retroactively invalidate an
-- EXISTING widget's already-saved layout/series (e.g. shrinking max_width
-- below a widget's current width, or lowering max_series below a
-- widget's current series count) must be REJECTED outright, not silently
-- left to "still technically pass because nothing re-checks it". Simpler
-- and safer than versioning the catalog: once ANY widget references a
-- type, its size/series/axis/comparison contract is frozen — see
-- protect_dashboard_widget_types_once_used below. is_active and label
-- stay freely mutable (deactivating a type must not break existing
-- widgets — that half of Round 2's reasoning is unchanged and correct).

-- ------------------------------------------------------------
-- 2. Built-in series catalog — stable, non-Metrics-Core series a widget
--    can plot (report §A, Decision B: read by the PoC query adapter
--    directly from training_load.session_feedback / training.* activity
--    data, never copied into metric_values).
-- ------------------------------------------------------------
create table training_load.dashboard_builtin_series (
  key text primary key,
  label text not null,
  unit text,
  value_type varchar(20) not null check (value_type in ('numeric', 'boolean', 'text')),
  -- Round 3, §1: this is now ONLY a suggested UI default for the widget's
  -- own, freely-choosable `analytical_aggregation` (dashboard_widget_
  -- series, below) — never an enforced equality. RENAMED from Round 2's
  -- `default_aggregation_method` to make that explicit: this column no
  -- longer claims to be "the one correct method", only "the one we
  -- pre-select in the picker". fixed_data_scope_level is still a real,
  -- enforced fact (RPE/sRPE/duration are always session-level; session_
  -- count/last_session_date are always day-level) — that part is
  -- unchanged from Round 2 (see _validate_scope_level below).
  default_analytical_aggregation varchar(20) not null check (default_analytical_aggregation in ('sum', 'avg', 'max', 'last', 'none')),
  fixed_data_scope_level varchar(20) not null check (fixed_data_scope_level in ('day', 'session', 'component')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into training_load.dashboard_builtin_series (key, label, unit, value_type, default_analytical_aggregation, fixed_data_scope_level) values
  ('rpe', 'RPE', null, 'numeric', 'avg', 'session'),
  ('srpe', 'sRPE', 'AU', 'numeric', 'sum', 'session'),
  ('duration_minutes', 'Duration', 'min', 'numeric', 'sum', 'session'),
  -- Round 2, §8: added so the "Athlete overview" system template (report
  -- §7) is actually materializable, as required — both are query-adapter
  -- rollups over training.activity_participants / canonical activity
  -- results, never over metric_values or session_feedback.
  ('session_count', 'Sessions', null, 'numeric', 'sum', 'day'),
  ('last_session_date', 'Last session', null, 'text', 'last', 'day');

-- Round 2, §4: unit/value_type/scope-level semantics become immutable the
-- moment ANY series references this built-in — silently changing what
-- "srpe" MEANS would reinterpret every widget already plotting it.
-- default_analytical_aggregation is deliberately EXCLUDED from this
-- protection (Round 3, §1) — it is only ever a picker pre-fill hint now,
-- never load-bearing for any already-created series (each series row
-- freezes its OWN analytical_aggregation choice at creation time), so
-- tweaking the SUGGESTED default later is harmless.
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
-- 3. Dashboards.
--
-- Round 2, §1 — THE central correction this round: OWNERSHIP (who may
-- see/edit/clone this dashboard row) and DATA WORKSPACE (which
-- workspace's metric_definitions/source_connections/activities/athletes
-- this dashboard's widgets may ever read) are now two SEPARATE concepts,
-- not one owner_scope doing both jobs.
--   * owner_scope/owner_user_id/owner_club_id/owner_team_id — UNCHANGED
--     shape from round 1 — visibility/edit/clone rights only.
--   * data_workspace_type/data_workspace_scope_id — NEW. The 5-value
--     WORKSPACE shape (platform/private_coach/club/team/athlete) —
--     deliberately the SAME shape as public.user_workspace_preferences /
--     resolveActiveWorkspace's own workspace concept, NOT the 4-value
--     owner_scope shape — because this is genuinely a workspace-context
--     binding, not an ownership-scope binding. A 'user'-owned (private)
--     dashboard picks ANY ONE data workspace at creation time and is
--     permanently bound to it (write-once, see
--     protect_dashboard_ownership_once_used below) — the same coach may
--     have several different private dashboards, each bound to a
--     different data workspace (Club A, Club B, their own private-coach
--     practice, ...). A 'club'/'team'-owned dashboard's data workspace is
--     always that exact same club/team (enforced below) — no independent
--     choice. A 'system'-owned dashboard is ALWAYS a template
--     (owner_scope='system' implies is_template=true below) and is always
--     workspace-agnostic (data_workspace_type IS NULL) until cloned — a
--     clone is where a concrete data-workspace context snapshot is first
--     assigned (report §B2 / PoC "Round 2 §1").
-- ------------------------------------------------------------
create table training_load.dashboards (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  -- Round 2, §1 — the new, separate data-workspace binding.
  data_workspace_type varchar(20) check (data_workspace_type in ('platform', 'private_coach', 'club', 'team', 'athlete')),
  data_workspace_scope_id uuid,
  is_template boolean not null default false,
  status varchar(20) not null default 'active' check (status in ('active', 'archived')),
  cloned_from_dashboard_id uuid references training_load.dashboards(id) on delete restrict,
  default_filter jsonb,
  -- Round 2, §3: this revision now ALSO bumps when the widget SET changes
  -- (a widget is added or removed) — see
  -- dashboard_widgets_bump_parent_dashboard_revision below — not just on a
  -- direct field edit. It intentionally does NOT bump on an individual
  -- widget's own content/position/series changes — that is what each
  -- widget's OWN revision (below) is for; see report §D5/"final
  -- revision/cache contract".
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
  -- Round 2, §1: a system-owned dashboard is always a template — there is
  -- no "live" system dashboard in this model, only templates awaiting
  -- clone.
  check (owner_scope <> 'system' or is_template = true),
  -- Round 2, §1: shape of the data-workspace binding — NULL only for a
  -- system template; otherwise a real, shape-valid workspace.
  check (
    (owner_scope = 'system' and data_workspace_type is null and data_workspace_scope_id is null) or
    (owner_scope <> 'system' and data_workspace_type is not null and (
      (data_workspace_type in ('club', 'team') and data_workspace_scope_id is not null) or
      (data_workspace_type in ('platform', 'private_coach', 'athlete') and data_workspace_scope_id is null)
    ))
  ),
  -- Round 2, §1: a club/team-OWNED dashboard's data workspace is always
  -- that exact same club/team — no independent choice for these two
  -- scopes (only a 'user'-owned dashboard genuinely picks one).
  check (owner_scope <> 'club' or (data_workspace_type = 'club' and data_workspace_scope_id = owner_club_id)),
  check (owner_scope <> 'team' or (data_workspace_type = 'team' and data_workspace_scope_id = owner_team_id)),
  -- Round 3, §3: a dashboard can never claim to be cloned from itself.
  -- Cycle detection (A clones B clones A) and "the referenced dashboard
  -- must actually be a template" cannot be expressed as a plain CHECK
  -- (both need to read OTHER rows) — see dashboards_validate_clone_provenance
  -- below for those. created_by_user_id and cloned_from_dashboard_id are
  -- both made unconditionally write-once by dashboards_protect_identity_
  -- once_created below (post-creation, not just "once in use" the way
  -- owner_scope/data_workspace are).
  check (cloned_from_dashboard_id is null or cloned_from_dashboard_id <> id)
);

create index dashboards_owner_idx on training_load.dashboards (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index dashboards_owner_status_idx on training_load.dashboards (owner_scope, status);
create index dashboards_template_idx on training_load.dashboards (owner_scope, is_template) where is_template = true;
create index dashboards_data_workspace_idx on training_load.dashboards (data_workspace_type, data_workspace_scope_id);

-- Round 2, §1 / Round 4, §7 CORRECTION: owner_scope AND the data-workspace
-- binding are governed by this one write-once trigger — a dashboard's
-- data workspace is exactly as security-sensitive as its owner_scope
-- (silently rebinding a private dashboard from Club A's data to Club B's
-- data after the fact is precisely the cross-workspace leak this whole
-- model exists to close). Round 2/3 only enforced this "once IN USE"
-- (a widget/selection/clone exists) — the task explicitly rejects that
-- framing: the report already CLAIMED write-once, but the code let a
-- completely empty, brand-new dashboard's workspace be silently rebound.
-- Fixed to be genuinely, unconditionally immutable from the moment the
-- row exists, whether or not anything yet references it — identical in
-- spirit to how dashboards_protect_identity_once_created already treats
-- created_by_user_id/cloned_from_dashboard_id. Changing a dashboard's
-- workspace now always means creating (or cloning) a NEW dashboard, never
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

-- Round 3, §3: created_by_user_id and cloned_from_dashboard_id are
-- identity/audit fields, not ordinary content — unlike owner_scope/
-- data_workspace above (which only lock once actually IN USE),
-- these are unconditionally write-once from the moment the row exists,
-- whether or not anything yet references it. cloned_from_dashboard_id
-- going NULL -> a value on a later UPDATE is exactly as forbidden as
-- value -> a different value: the task's own wording is "changing the
-- original dashboard post-creation" is forbidden outright — clone
-- provenance is decided once, at INSERT time, or never (see
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

-- Round 3, §3: the two clone-provenance rules that can't be a plain CHECK
-- (self-clone IS a plain CHECK, above) — the referenced dashboard must
-- actually be a template (cloned_from_dashboard_id's whole meaning is
-- "template lineage" per the contract), and the chain can never cycle
-- back to this row. BEFORE INSERT only — cloned_from_dashboard_id can
-- never change after insert anyway (see the write-once trigger above), so
-- there is nothing to re-validate on UPDATE.
--
-- Round 5, §8 — SNAPSHOT SEMANTICS, made explicit and race-proof.
-- `cloned_from_dashboard_id` means "this dashboard WAS a template at the
-- moment it was cloned" — a historical provenance fact, never a live
-- constraint the source must keep satisfying forever. Once this INSERT
-- commits, nothing about the SOURCE dashboard's own later is_template
-- flips can retroactively invalidate this clone's already-recorded
-- lineage (this trigger only ever fires on the CLONE's own insert, never
-- re-runs against a source that changes afterward) — that half of
-- snapshot semantics falls out for free from the design already being
-- INSERT-only. The half that needed a real fix: the read of the SOURCE's
-- own is_template was UNLOCKED, so a concurrent template-flip on the
-- source and this clone-insert could interleave — this clone reading
-- is_template=true a moment before the flip commits, and recording
-- lineage from a dashboard that (from the flip's own perspective) was
-- simultaneously being demoted. Fixed: `FOR SHARE` on the source
-- dashboard row BEFORE reading is_template — genuinely serializes
-- against a concurrent flip. Whichever happens first wins outright: a
-- flip that commits BEFORE this lock is acquired is correctly seen and
-- rejects the clone; a clone whose lock (and is_template read) commits
-- BEFORE a later flip is unaffected by that later flip, by construction.
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

-- Round 2, §4 trigger REMOVED in Round 4, §9. It used to block is_template
-- flipping true->false while any widget still carried an unresolved
-- (hints-only) series, on the premise that a real (non-template)
-- dashboard could never legitimately hold one. That premise is no longer
-- true: Round 4 makes cloning PRESERVE unresolved/ambiguous series onto
-- the new, real dashboard on purpose (see dashboard_widget_series_
-- validate_resolution's own updated comment and report §0-R4.9) — a real
-- dashboard holding an unresolved series is now an intentional, safe,
-- fixable state (the query adapter refuses to ever query a non-'resolved'
-- series), not a bug to prevent. Nothing replaces this trigger; is_template
-- is free to flip in either direction regardless of any series'
-- resolution_status.

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

-- Round 2, §3: the missing half of the dashboard-revision contract — the
-- WIDGET SET changing (one added or removed) is a structural change to
-- the dashboard just as much as renaming it, and must bump
-- dashboards.revision too, or a client caching "the whole dashboard" by
-- its own revision would never notice a widget was added/removed.
create function training_load.bump_dashboard_revision(p_dashboard_id uuid) returns void as $$
begin
  update training_load.dashboards set revision = revision + 1, updated_at = now() where id = p_dashboard_id;
end;
$$ language plpgsql;

create function training_load.dashboard_widgets_bump_parent_dashboard_revision() returns trigger as $$
begin
  perform training_load.bump_dashboard_revision(coalesce(new.dashboard_id, old.dashboard_id));
  return coalesce(new, old);
end;
$$ language plpgsql;

-- Note: the two triggers using this function are declared further below,
-- immediately after training_load.dashboard_widgets itself is created —
-- unlike a function BODY's internal references (resolved only when the
-- function actually fires), CREATE TRIGGER needs its target table to
-- already exist at creation time.

-- ------------------------------------------------------------
-- 4. Widgets. Layout lives directly on the widget row (report §D3,
--    unchanged from round 1). Round 2 changes: widget_type IS now part of
--    the revision-bump field list (was missing); the overlap check is now
--    a DEFERRED constraint trigger so a legitimate atomic swap/rearrange
--    passes (Round 2 §6); is_active on the widget's TYPE is checked only
--    for a genuinely new widget or an incoming widget_type change, never
--    for an ordinary resize of an already-existing widget (Round 2 §4).
-- ------------------------------------------------------------
create table training_load.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references training_load.dashboards(id) on delete cascade,
  widget_type text not null references training_load.dashboard_widget_types(key),
  title text not null check (char_length(title) between 1 and 200),
  widget_order integer not null,
  x smallint not null check (x >= 0 and x <= 11),
  y smallint not null check (y >= 0),
  width smallint not null check (width >= 1 and width <= 12),
  height smallint not null check (height >= 1),
  check (x + width <= 12),
  mobile_order integer not null,
  -- Round 4, §1 CORRECTION: 'week' was claimed as supported but never
  -- implemented (the adapter silently fell through to 'day' bucketing);
  -- now real (Monday-Sunday, derived from each fact's own local date —
  -- see the adapter's own week-bucket helper). 'team' was renamed to
  -- 'cohort': it never represented a real team_id — it only ever meant
  -- "merge together whichever athletes this query's own athleteIds filter
  -- currently selects," which is a query-time SELECTION, not a team
  -- identity. Calling it 'team' implied a guarantee (a real
  -- public.teams row) this column structurally cannot provide (a widget
  -- has no team_id column of its own) — 'cohort' names what it actually
  -- is. A genuine "one bucket per real team" grouping is a different,
  -- NOT-YET-implemented feature (it would need to join athletes to their
  -- OWN team membership, not just merge the caller's selection) and is
  -- deliberately not offered here — see report §0-R4.1.
  group_by varchar(20) not null default 'day' check (group_by in ('day', 'week', 'session', 'component', 'athlete', 'cohort')),
  state varchar(20) not null default 'active' check (state in ('active', 'collapsed')),
  display_config jsonb not null default '{"schemaVersion": 1}'::jsonb,
  local_filter_override jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_widgets_order_unique unique (dashboard_id, widget_order) deferrable initially deferred,
  constraint dashboard_widgets_mobile_order_unique unique (dashboard_id, mobile_order) deferrable initially deferred,
  -- Round 2, §2: display_config must at least carry a schema version — the
  -- exact shape per widget_type is an application-layer validator (report
  -- "query semantics table" / JSON schema note), not enforced field-by-
  -- field here, but a missing/malformed version key is refused outright so
  -- an unversioned blob can never silently exist.
  check (display_config ? 'schemaVersion' and jsonb_typeof(display_config -> 'schemaVersion') = 'number')
);

create index dashboard_widgets_dashboard_idx on training_load.dashboard_widgets (dashboard_id, widget_order);
create index dashboard_widgets_mobile_idx on training_load.dashboard_widgets (dashboard_id, mobile_order);

create trigger dashboard_widgets_bump_parent_on_insert
  after insert on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_bump_parent_dashboard_revision();
create trigger dashboard_widgets_bump_parent_on_delete
  after delete on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_bump_parent_dashboard_revision();

-- Round 3, §3: dashboard_id is immutable after insert — a raw UPDATE
-- moving a widget to a different dashboard would bypass every dashboard-
-- scoped invariant this file builds (metric/source visibility checked
-- against the OLD dashboard's data workspace, the overlap/cap/axis checks
-- run against the NEW dashboard's sibling widgets without ever having
-- validated against IT, both dashboards' revisions left stale). Moving a
-- widget to another dashboard must be a real delete-then-recreate, never
-- an UPDATE of this column.
create function training_load.protect_dashboard_widgets_dashboard_id() returns trigger as $$
begin
  if new.dashboard_id is distinct from old.dashboard_id then
    raise exception 'dashboard_widgets (id=%): dashboard_id is immutable — delete and recreate the widget under the new dashboard instead', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_protect_dashboard_id
  before update of dashboard_id on training_load.dashboard_widgets
  for each row execute function training_load.protect_dashboard_widgets_dashboard_id();

-- Per-type min/max size + is_active. Round 2: is_active is now checked
-- ONLY on insert or an incoming widget_type change — never on a plain
-- resize of an existing widget whose type may since have been
-- deactivated (report §4 "deaktivacija ne sme pokvariti ... dozvoljene
-- izmene postojećeg dashboarda").
-- Round 4, §10: a FOR SHARE lock on the referenced widget_types row closes
-- the "first widget of a type vs. a concurrent semantic change to that
-- type" race. protect_dashboard_widget_types_once_used's own EXISTS
-- check for "is this type in use" only sees COMMITTED rows — without this
-- lock, a concurrent first-INSERT and a concurrent catalog UPDATE could
-- each read a state that becomes stale the instant the other commits (the
-- INSERT sees "not in use yet" and proceeds while the UPDATE, running at
-- the same instant, also sees "not in use yet" and changes the bounds the
-- INSERT is about to violate). An UPDATE already holds Postgres's own
-- implicit exclusive lock on the row it targets for the trigger's whole
-- duration — so a FOR SHARE lock taken here genuinely blocks until that
-- concurrent UPDATE commits (or rolls back), at which point this trigger's
-- own bounds-check below reads the REAL, final, post-update semantics —
-- never a stale mid-flight read. See PoC's catalog-concurrency tests.
create function training_load.dashboard_widgets_validate_layout() returns trigger as $$
declare
  v_min_w smallint; v_max_w smallint; v_min_h smallint; v_max_h smallint; v_active boolean;
  v_check_active boolean;
begin
  select min_width, max_width, min_height, max_height, is_active
    into v_min_w, v_max_w, v_min_h, v_max_h, v_active
    from training_load.dashboard_widget_types where key = new.widget_type for share;
  if not found then
    raise exception 'dashboard_widgets: unknown widget_type %', new.widget_type;
  end if;
  v_check_active := (tg_op = 'INSERT') or (tg_op = 'UPDATE' and new.widget_type is distinct from old.widget_type);
  if v_check_active and not v_active then
    raise exception 'dashboard_widgets: widget_type % is not active — cannot add/switch to this type', new.widget_type;
  end if;
  if new.width < v_min_w or new.width > v_max_w then
    raise exception 'dashboard_widgets: width % out of bounds [%, %] for widget_type %', new.width, v_min_w, v_max_w, new.widget_type;
  end if;
  if new.height < v_min_h or new.height > v_max_h then
    raise exception 'dashboard_widgets: height % out of bounds [%, %] for widget_type %', new.height, v_min_h, v_max_h, new.widget_type;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_validate_layout
  before insert or update of widget_type, width, height on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_validate_layout();

-- Round 2, §4: when widget_type actually CHANGES (e.g. Table -> KPI),
-- re-validate every invariant that depends on the type — series cap and
-- (for a chart type) axis-unit compatibility — against the widget's
-- EXISTING series. Fires AFTER the type change is already committed to
-- the row (so dashboard_widget_types is joined via the NEW type), inside
-- the same statement's transaction.
create function training_load.dashboard_widgets_revalidate_series_on_type_change() returns trigger as $$
declare
  v_max_series smallint;
  v_count integer;
  v_has_axis boolean;
  v_supports_comparison boolean;
  v_conflict record;
begin
  select max_series, has_shared_axis, supports_comparison_period into v_max_series, v_has_axis, v_supports_comparison
    from training_load.dashboard_widget_types where key = new.widget_type;
  if v_max_series is null then v_max_series := 20; end if;
  select count(*) into v_count from training_load.dashboard_widget_series where widget_id = new.id;
  if v_count > v_max_series then
    raise exception 'dashboard_widgets: cannot change widget % to type % — it already has % series, that type allows at most %', new.id, new.widget_type, v_count, v_max_series;
  end if;
  if not v_supports_comparison then
    if exists (select 1 from training_load.dashboard_widget_series where widget_id = new.id and comparison_period is not null) then
      raise exception 'dashboard_widgets: cannot change widget % to type % — an existing series still has a comparison_period set, only KPI supports it', new.id, new.widget_type;
    end if;
  end if;
  if v_has_axis then
    -- Re-run the SAME per-axis unit-compatibility check the series
    -- trigger itself uses, over the widget's now-fixed final series set.
    for v_conflict in
      select axis, count(distinct coalesce(
        (select mdv.unit from training_load.metric_definitions md join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id where md.id = s.metric_definition_id),
        (select b.unit from training_load.dashboard_builtin_series b where b.key = s.built_in_series_key)
      )) as distinct_units
      from training_load.dashboard_widget_series s
      where s.widget_id = new.id and (s.metric_definition_id is not null or s.built_in_series_key is not null)
      group by axis having count(distinct coalesce(
        (select mdv.unit from training_load.metric_definitions md join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id where md.id = s.metric_definition_id),
        (select b.unit from training_load.dashboard_builtin_series b where b.key = s.built_in_series_key)
      )) > 1
    loop
      raise exception 'dashboard_widgets: cannot change widget % to type % — axis % already mixes incompatible units among its existing series', new.id, new.widget_type, v_conflict.axis;
    end loop;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_revalidate_series_on_type_change
  after update of widget_type on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_revalidate_series_on_type_change();

-- Round 2, §5/§6: lock order for this whole subsystem is DASHBOARD ->
-- WIDGET -> SERIES, applied consistently everywhere below. This trigger
-- is step 1 for any layout write: lock the DASHBOARD row (a brand-new
-- dashboard's very first widget has no sibling widget row to lock, so
-- locking widgets alone would let two concurrent "first widget" inserts
-- both pass) — it does NOT itself check for overlap anymore (Round 2 §6:
-- that is now the DEFERRED constraint trigger below, so a legitimate
-- atomic swap within one transaction is never rejected mid-flight).
--
-- Round 3, §4 HONESTY CORRECTION: for an INSERT, this trigger genuinely
-- achieves dashboard-before-widget ordering (no widget row exists yet to
-- compete for). For an UPDATE, it does NOT — Postgres already acquires
-- the target widget row's own lock (via GetTupleForTrigger, to fetch the
-- row for this trigger's OLD/NEW binding) BEFORE any before-row trigger
-- body runs, so by the time this trigger's own `for update` on dashboards
-- executes, the widget row is already locked — the reverse order. This
-- trigger is kept for the INSERT case (where it IS correct) and as a
-- defense-in-depth correctness backstop for the UPDATE case (the lock
-- still gets taken, just not provably first) — but it must never be
-- treated as the proof of dashboard-first ordering for an UPDATE-based
-- layout write. training_load.update_widget_layout() and
-- replace_dashboard_layout() are the only two entry points that actually
-- prove that ordering (each takes its own explicit dashboard lock BEFORE
-- issuing any dashboard_widgets statement) — see their own comments.
create function training_load.dashboard_widgets_lock_dashboard_before_layout_write() returns trigger as $$
begin
  perform 1 from training_load.dashboards where id = new.dashboard_id for update;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_lock_dashboard_before_layout_write
  before insert or update of x, y, width, height on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_lock_dashboard_before_layout_write();

-- Round 2, §6: the real overlap check, now a DEFERRABLE INITIALLY
-- DEFERRED constraint trigger — checked once at the end of the
-- transaction (or explicitly earlier via `SET CONSTRAINTS ... IMMEDIATE`,
-- see replace_dashboard_layout() below), not per individual row write.
-- This is what makes "A moves to B's old spot, B moves to A's old spot,
-- in the same transaction" succeed — the transiently-overlapping
-- intermediate state between the two individual UPDATEs is never checked,
-- only the FINAL state is. The BEFORE trigger above already serializes
-- every layout writer through the dashboard-row lock, so by the time this
-- deferred check runs, no concurrent writer for the SAME dashboard can
-- still be in flight — what it sees IS the real final state, not a
-- moving target.
create function training_load.dashboard_widgets_check_no_overlap() returns trigger as $$
declare
  v_conflict record;
begin
  select a.id as a_id, b.id as b_id into v_conflict
    from training_load.dashboard_widgets a
    join training_load.dashboard_widgets b on b.dashboard_id = a.dashboard_id and b.id <> a.id
      and a.x < b.x + b.width and b.x < a.x + a.width
      and a.y < b.y + b.height and b.y < a.y + a.height
    where a.dashboard_id = new.dashboard_id
    limit 1;
  if v_conflict.a_id is not null then
    raise exception 'dashboard_widgets: final layout still has an overlap between widgets % and % on dashboard %', v_conflict.a_id, v_conflict.b_id, new.dashboard_id;
  end if;
  return new;
end;
$$ language plpgsql;

create constraint trigger dashboard_widgets_check_no_overlap
  after insert or update of x, y, width, height on training_load.dashboard_widgets
  deferrable initially deferred
  for each row execute function training_load.dashboard_widgets_check_no_overlap();

-- Round 3, §4 RESTRUCTURED: layout fields (x/y/width/height/mobile_order)
-- now bump BOTH this widget's own revision AND the parent dashboard's
-- revision — reversing Round 2's deliberate choice to exclude
-- position/size from the dashboard-level signal. The task's own
-- reasoning: dashboard.revision is the cache token for the WHOLE
-- rendered layout (every widget's position/size), not just widget SET
-- membership, so a position/size change genuinely invalidates that
-- cache too. Content fields (widget_type/title/group_by/state/
-- display_config/local_filter_override) still bump ONLY this widget's
-- own revision, unchanged from Round 2 — the dashboard's cached LAYOUT
-- did not change, only this widget's own content.
create function training_load.dashboard_widgets_bump_revision() returns trigger as $$
declare
  v_layout_changed boolean;
  v_content_changed boolean;
begin
  v_layout_changed := (
    new.x is distinct from old.x or new.y is distinct from old.y
    or new.width is distinct from old.width or new.height is distinct from old.height
    or new.mobile_order is distinct from old.mobile_order
  );
  v_content_changed := (
    new.widget_type is distinct from old.widget_type
    or new.title is distinct from old.title
    or new.widget_order is distinct from old.widget_order
    or new.group_by is distinct from old.group_by
    or new.state is distinct from old.state
    or new.display_config is distinct from old.display_config
    or new.local_filter_override is distinct from old.local_filter_override
  );
  if v_layout_changed or v_content_changed then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  -- Deadlock-safety note (report "lock order" section): calling
  -- bump_dashboard_revision from THIS before-row trigger does NOT, by
  -- itself, achieve dashboard-before-widget lock ordering for a raw
  -- ad-hoc UPDATE — Postgres already acquires THIS row's own lock (via
  -- GetTupleForTrigger, internally, to fetch the row for the trigger's
  -- OLD/NEW binding) BEFORE any before-row trigger body runs, so by the
  -- time this trigger tries to lock the dashboard, the WIDGET row is
  -- already locked — the reverse of dashboard-then-widget. This is still
  -- functionally correct (dashboard.revision DOES end up bumped) but is
  -- NOT proven deadlock-safe against a concurrent replace_dashboard_layout
  -- / update_widget_layout call, which lock dashboard-then-widget. Kept
  -- anyway as defense-in-depth correctness for any writer that bypasses
  -- the two sanctioned functions below — see their own comments, and the
  -- report's lock-order section, for the full AB-BA trace and the
  -- deliberate decision to keep this trigger despite it.
  if v_layout_changed then
    perform training_load.bump_dashboard_revision(new.dashboard_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_bump_revision
  before update on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_bump_revision();

-- Round 2, §3: helper reused by the series-change triggers below — a
-- series add/update/delete/reorder is a query/render-relevant change to
-- its PARENT WIDGET, so the widget's own revision (not just some series-
-- level counter) must bump, exactly like a direct widget field edit does.
create function training_load.bump_widget_revision(p_widget_id uuid) returns void as $$
begin
  update training_load.dashboard_widgets set revision = revision + 1, updated_at = now() where id = p_widget_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 5. Widget series — the normalized metric/series reference (report §C).
--    Round 2 adds the missing query-affecting semantics (§2) as real
--    normalized columns, fixes the widget-revision bump (§3), adds
--    widget-row locking to the cap/axis checks (§5), reworks visibility
--    to check the dashboard's DATA WORKSPACE rather than owner_scope
--    directly (§1), and adds source-connection visibility + built-in
--    source-policy restrictions (§4).
-- ------------------------------------------------------------
create table training_load.dashboard_widget_series (
  id uuid primary key default gen_random_uuid(),
  widget_id uuid not null references training_load.dashboard_widgets(id) on delete cascade,
  series_order integer not null,
  metric_definition_id uuid references training_load.metric_definitions(id) on delete restrict,
  built_in_series_key text references training_load.dashboard_builtin_series(key) on delete restrict,
  -- Round 4, §9: template_metric_key_hints must now be a validated JSON
  -- ARRAY OF OBJECTS (see dashboard_widget_series_validate_template_hints_
  -- shape below) — a bare string element is refused outright, since this
  -- schema has never been deployed and there is no legacy shape to stay
  -- compatible with. Each object carries at least {"key": "..."}, plus
  -- optional "valueType"/"unit"/"scopeLevel"/"domain"/"category" narrowing
  -- hints — see the shape-validation trigger for the exact contract,
  -- including how an explicit `"unit": null` (means "must have NO unit")
  -- is distinguished from unit simply being absent (means "unit not a
  -- criterion").
  template_metric_key_hints jsonb,
  -- Round 4, §9: an unresolved/ambiguous template series is no longer
  -- silently DROPPED on clone (Round 2/3's report claimed this, but that
  -- throws away exactly the state a coach needs to see and fix). It is
  -- preserved with a real status: 'resolved' (metric_definition_id or
  -- built_in_series_key is set, normal series), 'unresolved' (zero
  -- visible candidates matched any hint), 'ambiguous' (2+ equally-valid
  -- candidates matched — never auto-picked). See the CHECK below tying
  -- this to which of metric_definition_id/built_in_series_key may be set,
  -- and dashboard_widget_series_validate_resolution's own is_template
  -- gate (unchanged: only a TEMPLATE dashboard may carry a non-'resolved'
  -- series at all — a real, live, cloned dashboard's own series must
  -- either be resolved or not exist... except see the clone contract in
  -- the report: cloning now PRESERVES unresolved/ambiguous state onto the
  -- new, real dashboard specifically so it stays fixable — is_template
  -- gating is therefore relaxed for this one case, see report §0-R4.9 for
  -- the full state machine and why this is safe: an unresolved series can
  -- never be QUERIED (the adapter refuses it outright), so it carries no
  -- data-visibility risk, only a "needs attention" UI state).
  resolution_status varchar(20) not null default 'resolved' check (resolution_status in ('resolved', 'unresolved', 'ambiguous')),
  -- Round 4, §9 / Round 5, §3: for an 'ambiguous' series, the real
  -- candidate metric_definition_ids found at the last resolution attempt
  -- — so the UI can render "pick one of these" without re-querying
  -- visibility itself. NULL for 'resolved'/'unresolved' (nothing to pick
  -- from either way). Shape-validated below (a real array of >=2 DISTINCT
  -- valid UUIDs whenever resolution_status='ambiguous', never a bare
  -- string/scalar/empty/duplicate list) by validate_template_resolution_
  -- candidates_shape.
  --
  -- Why JSONB here rather than a normalized child table (asked for
  -- explicitly this round): these candidates are a POINT-IN-TIME SNAPSHOT
  -- of one resolution attempt, never independently queried, filtered,
  -- joined, or paginated — the UI always reads the WHOLE list at once (to
  -- render "pick one of these") and the sanctioned resolve_series_binding()
  -- function below always REPLACES the whole list atomically (never
  -- appends/removes one candidate at a time). A child table would need
  -- its own FK+cascade+ordering machinery for exactly zero of the access
  -- patterns a normalized table earns its keep for. Critically, this
  -- snapshot is NEVER trusted as the live authorization source — see
  -- resolve_series_binding()'s own comment: the metric this column
  -- eventually binds to is re-validated live, against the metric's
  -- CURRENT visibility, by the SAME dashboard_widget_series_validate_
  -- metric_visibility trigger every other metric_definition_id write
  -- already goes through — this column is UI convenience data, never an
  -- authorization record.
  template_resolution_candidates jsonb,
  axis varchar(10) not null default 'primary' check (axis in ('primary', 'secondary')),
  color text,
  display_label text,
  -- Round 3, §1: 'not_applicable' added — a built-in series (RPE/sRPE/
  -- duration/...) has no Metrics-Core provenance concept at all; it is
  -- never fairly described as 'manual' (which implies "a human chose to
  -- enter this instead of importing it", a REAL distinction Metrics Core
  -- values make that simply does not exist for session_feedback). See the
  -- CHECK constraints below: 'not_applicable' is legal ONLY for a
  -- built-in series, and a built-in series may ONLY use 'not_applicable'.
  source_policy varchar(20) not null default 'all_with_conflicts'
    check (source_policy in ('all_with_conflicts', 'source_connection', 'manual', 'api_import', 'csv_import', 'derived', 'not_applicable')),
  source_connection_id uuid references training_load.metric_source_connections(id) on delete restrict,
  -- Round 2, §2 — the previously-missing query-affecting semantics, now
  -- real normalized columns instead of an undefined frontend convention:
  data_scope_level varchar(20) not null default 'session' check (data_scope_level in ('day', 'session', 'component')),
  -- Round 3, §1 — RENAMED from Round 2's `aggregation_method`, and its
  -- meaning is now genuinely different: this is STAGE 2 ("dashboard
  -- analytical aggregation" — how the widget reduces values ACROSS
  -- activities/days/weeks/athletes, e.g. "sum per week" / "avg per
  -- training" / "max per training" / "none, show every activity") —
  -- freely choosable, deliberately NOT constrained to equal
  -- metric_definitions.daily_aggregation_method (that is STAGE 1, a fixed
  -- fact about the metric itself, always applied by the query adapter
  -- when it needs to collapse same-day raw facts into one daily value on
  -- the way to whatever this column asks for — report "two-stage
  -- aggregation" / query adapter §0.9-successor). The
  -- dashboard_widget_series_validate_aggregation equality trigger from
  -- Round 2 is REMOVED in Round 3 — this is the literal fix for "nemoj
  -- više zahtevati da dashboard aggregation_method bude jednak daily_
  -- aggregation_method definicije".
  analytical_aggregation varchar(20) not null default 'sum' check (analytical_aggregation in ('sum', 'avg', 'max', 'last', 'none')),
  -- Named policies rather than a raw role/coverage array — see report
  -- "query semantics table" for the exact meaning of each; matches
  -- metric_values.aggregation_role/coverage's own real value sets rather
  -- than inventing a parallel vocabulary.
  aggregation_role_policy varchar(30) not null default 'standalone_and_source_rollup'
    check (aggregation_role_policy in ('standalone_only', 'standalone_and_source_rollup', 'all_including_derived')),
  coverage_policy varchar(20) not null default 'complete_and_partial'
    check (coverage_policy in ('complete_only', 'complete_and_partial', 'any')),
  -- NULL = no comparison. Only meaningful (and only insertable/settable)
  -- on a widget_type with supports_comparison_period=true (KPI today) —
  -- report §2 "comparison period is not cosmetic, it changes the query".
  comparison_period varchar(20) check (comparison_period in ('previous_period', 'previous_year')),
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint dashboard_widget_series_order_unique unique (widget_id, series_order) deferrable initially deferred,
  check (source_connection_id is null or source_policy = 'source_connection'),
  check (source_policy <> 'source_connection' or source_connection_id is not null),
  check (
    (metric_definition_id is not null and built_in_series_key is null) or
    (metric_definition_id is null and built_in_series_key is not null) or
    (metric_definition_id is null and built_in_series_key is null and template_metric_key_hints is not null)
  ),
  -- Round 4, §9: resolution_status must agree with which reference
  -- columns are actually set — 'resolved' requires a real reference (one
  -- of the two FKs); 'unresolved'/'ambiguous' require NEITHER FK to be
  -- set (nothing to query yet) and MUST still carry the original hints so
  -- a later retry has something to re-resolve against.
  check (
    (resolution_status = 'resolved' and (metric_definition_id is not null or built_in_series_key is not null)) or
    (resolution_status in ('unresolved', 'ambiguous') and metric_definition_id is null and built_in_series_key is null and template_metric_key_hints is not null)
  ),
  -- Round 4, §9 / Round 5, §3: candidates are only ever meaningful for
  -- 'ambiguous' — a 'resolved' series has no candidates left to choose
  -- from, and an 'unresolved' one has none that matched at all. Round 5
  -- tightens this to a real two-way requirement (both directions
  -- enforced, matching every other such pair in this file): 'ambiguous'
  -- REQUIRES a real candidates value (a genuinely empty/absent list is
  -- not "ambiguous", it is "unresolved" and must be labelled as such);
  -- the actual ARRAY SHAPE (>=2 distinct valid UUIDs) is enforced by the
  -- validate_template_resolution_candidates_shape trigger below, since a
  -- plain CHECK cannot inspect JSONB array contents element-by-element
  -- as clearly as a trigger can.
  check (
    (resolution_status = 'ambiguous' and template_resolution_candidates is not null) or
    (resolution_status <> 'ambiguous' and template_resolution_candidates is null)
  ),
  -- Round 2, §4: a built-in series (RPE/sRPE/duration/...) has no
  -- Metrics-Core provenance at all — 'source_connection'/'api_import'/
  -- 'csv_import' are meaningless for it (report §4 "built-in RPE ne sme
  -- prihvatiti neprimenljiv source policy"); 'manual' is the only sensible
  -- policy (session_feedback is always a direct athlete/coach entry).
  -- Round 3, §1: a built-in series MUST use 'not_applicable' (never
  -- 'manual' — see the source_policy column comment above); conversely a
  -- real Metrics-Core-backed series (metric_definition_id set) MUST NOT
  -- use 'not_applicable' — that value has no meaning outside the built-in
  -- case. Both directions enforced so neither can drift into the wrong
  -- shape.
  check (built_in_series_key is null or (source_policy = 'not_applicable' and source_connection_id is null)),
  check (metric_definition_id is null or source_policy <> 'not_applicable')
);

create index dashboard_widget_series_widget_idx on training_load.dashboard_widget_series (widget_id, series_order);
create index dashboard_widget_series_definition_idx on training_load.dashboard_widget_series (metric_definition_id) where metric_definition_id is not null;

-- Round 3, §3: widget_id is immutable after insert — the same reasoning
-- as dashboard_widgets.dashboard_id above, one level down: a raw UPDATE
-- moving a series to a different widget would bypass the series cap,
-- axis-unit compatibility, and metric/source visibility checks for the
-- NEW widget (they only ever ran against the widget this row was
-- inserted under) and leave both widgets' revisions stale. Moving a
-- series to another widget must be delete-then-recreate.
create function training_load.protect_dashboard_widget_series_widget_id() returns trigger as $$
begin
  if new.widget_id is distinct from old.widget_id then
    raise exception 'dashboard_widget_series (id=%): widget_id is immutable — delete and recreate the series under the new widget instead', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_protect_widget_id
  before update of widget_id on training_load.dashboard_widget_series
  for each row execute function training_load.protect_dashboard_widget_series_widget_id();

-- Round 2, §5: lock order step 2 — every series-row trigger below that
-- validates a WIDGET-wide invariant (series cap, axis-unit) locks the
-- WIDGET row FIRST, before reading sibling series rows. Two concurrent
-- INSERTs against the SAME widget now serialize through this lock,
-- closing the "both read the same stale count/unit set" race — proven by
-- PoC with two real connections and a genuine lock-wait check.
create function training_load.lock_widget_for_series_write(p_widget_id uuid) returns void as $$
begin
  perform 1 from training_load.dashboard_widgets where id = p_widget_id for update;
end;
$$ language plpgsql;

-- Round 4, §9 CORRECTION: Round 2/3 restricted an unresolved (hints-only)
-- series to TEMPLATE dashboards only, and the report claimed cloning
-- simply DROPS whatever doesn't resolve. The task rejects that: a clone
-- must PRESERVE an unresolved/ambiguous series onto the new, real (non-
-- template) dashboard so a coach can fix it later ("Choose a metric").
-- The is_template restriction is therefore removed — resolution_status +
-- the query adapter's own hard refusal to ever query a non-'resolved'
-- series (see report §0-R4.9) is what makes this safe now, not which KIND
-- of dashboard the series happens to live on. This function's only
-- remaining job is locking the widget row (unchanged, still needed for
-- the lock-order contract) — resolution_status/candidate shape itself is
-- enforced by the CHECK constraints and the hints-shape trigger below.
create function training_load.dashboard_widget_series_validate_resolution() returns trigger as $$
begin
  perform training_load.lock_widget_for_series_write(new.widget_id);
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_resolution
  before insert or update of metric_definition_id, built_in_series_key, template_metric_key_hints, widget_id
  on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_resolution();

-- Round 4, §9: template_metric_key_hints must be a real JSON array of
-- OBJECTS — a bare string element is refused, and every element must at
-- least carry a non-empty string "key". Optional narrowing fields
-- ("valueType"/"unit"/"scopeLevel") are shape-checked when present;
-- "unit" being present-with-null-value ("must have no unit") is
-- deliberately distinguished from absent ("unit not a hint criterion at
-- all") via jsonb's own `?` key-existence operator — never conflated.
create function training_load.validate_template_metric_key_hints_shape() returns trigger as $$
declare
  v_elem jsonb;
begin
  if new.template_metric_key_hints is null then
    return new;
  end if;
  if jsonb_typeof(new.template_metric_key_hints) <> 'array' then
    raise exception 'dashboard_widget_series: template_metric_key_hints must be a JSON array of objects (widget %)', new.widget_id;
  end if;
  for v_elem in select * from jsonb_array_elements(new.template_metric_key_hints) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'dashboard_widget_series: template_metric_key_hints elements must be objects, not a bare string/scalar (got %, widget %) — every hint must carry at least {"key": "..."}', v_elem, new.widget_id;
    end if;
    if not (v_elem ? 'key') or jsonb_typeof(v_elem -> 'key') <> 'string' or length(v_elem ->> 'key') = 0 then
      raise exception 'dashboard_widget_series: each template_metric_key_hints element requires a non-empty string "key" (got %, widget %)', v_elem, new.widget_id;
    end if;
    if (v_elem ? 'valueType') and v_elem -> 'valueType' is not null and (v_elem ->> 'valueType') not in ('numeric', 'boolean', 'text') then
      raise exception 'dashboard_widget_series: template_metric_key_hints "valueType" must be numeric/boolean/text (got %, widget %)', v_elem -> 'valueType', new.widget_id;
    end if;
    if (v_elem ? 'scopeLevel') and v_elem -> 'scopeLevel' is not null and (v_elem ->> 'scopeLevel') not in ('day', 'session', 'component') then
      raise exception 'dashboard_widget_series: template_metric_key_hints "scopeLevel" must be day/session/component (got %, widget %)', v_elem -> 'scopeLevel', new.widget_id;
    end if;
    if (v_elem ? 'unit') and v_elem -> 'unit' is not null and jsonb_typeof(v_elem -> 'unit') <> 'string' then
      raise exception 'dashboard_widget_series: template_metric_key_hints "unit" must be a string or explicit null (got %, widget %)', v_elem -> 'unit', new.widget_id;
    end if;
  end loop;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_template_hints_shape
  before insert or update of template_metric_key_hints on training_load.dashboard_widget_series
  for each row execute function training_load.validate_template_metric_key_hints_shape();

-- Round 5, §3: template_resolution_candidates must be a real JSON array
-- of >=2 DISTINCT valid UUID strings whenever it is set (the CHECK above
-- already guarantees it is set if and only if resolution_status=
-- 'ambiguous', and null otherwise) — never a bare scalar, never a
-- single-element "ambiguous" list (that is just 'resolved' or a bug),
-- never a list with a malformed or duplicated entry.
create function training_load.validate_template_resolution_candidates_shape() returns trigger as $$
declare
  v_elem jsonb;
  v_count integer := 0;
  v_seen text[] := '{}';
  v_text text;
begin
  if new.template_resolution_candidates is null then
    return new;
  end if;
  if jsonb_typeof(new.template_resolution_candidates) <> 'array' then
    raise exception 'dashboard_widget_series: template_resolution_candidates must be a JSON array of UUID strings (widget %)', new.widget_id;
  end if;
  for v_elem in select * from jsonb_array_elements(new.template_resolution_candidates) loop
    if jsonb_typeof(v_elem) <> 'string' then
      raise exception 'dashboard_widget_series: template_resolution_candidates elements must be UUID strings (got %, widget %)', v_elem, new.widget_id;
    end if;
    v_text := v_elem #>> '{}';
    begin
      perform v_text::uuid;
    exception when invalid_text_representation then
      raise exception 'dashboard_widget_series: template_resolution_candidates element % is not a valid UUID (widget %)', v_text, new.widget_id;
    end;
    if v_text = any(v_seen) then
      raise exception 'dashboard_widget_series: template_resolution_candidates contains a duplicate id % (widget %)', v_text, new.widget_id;
    end if;
    v_seen := v_seen || v_text;
    v_count := v_count + 1;
  end loop;
  if v_count < 2 then
    raise exception 'dashboard_widget_series: template_resolution_candidates must have at least 2 DISTINCT candidates for resolution_status=ambiguous (got %, widget %)', v_count, new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_template_resolution_candidates_shape
  before insert or update of template_resolution_candidates on training_load.dashboard_widget_series
  for each row execute function training_load.validate_template_resolution_candidates_shape();

create function training_load.dashboard_widget_series_enforce_cap() returns trigger as $$
declare
  v_widget_type text;
  v_max_series smallint;
  v_count integer;
begin
  perform training_load.lock_widget_for_series_write(new.widget_id);
  select w.widget_type, t.max_series into v_widget_type, v_max_series
    from training_load.dashboard_widgets w join training_load.dashboard_widget_types t on t.key = w.widget_type
    where w.id = new.widget_id;
  if v_max_series is null then
    v_max_series := 20;
  end if;
  select count(*) into v_count from training_load.dashboard_widget_series where widget_id = new.widget_id;
  if v_count >= v_max_series then
    raise exception 'dashboard_widget_series: widget % (type %) already has % series, the max allowed is %', new.widget_id, v_widget_type, v_count, v_max_series;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_enforce_cap
  before insert on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_enforce_cap();

create function training_load.dashboard_widget_series_validate_axis_unit() returns trigger as $$
declare
  v_has_axis boolean;
  v_new_unit text;
  v_existing_unit text;
  v_conflict_id uuid;
begin
  perform training_load.lock_widget_for_series_write(new.widget_id);
  select t.has_shared_axis into v_has_axis
    from training_load.dashboard_widgets w join training_load.dashboard_widget_types t on t.key = w.widget_type
    where w.id = new.widget_id;
  if not v_has_axis then
    return new;
  end if;
  -- Round 5, §6 FIX: same reasoning as dashboard_widget_series_validate_
  -- scope_capability's own fix above — this trigger's read of the
  -- referenced metric_definition's/built-in's own unit was unlocked, and
  -- relied on "validate_metric_visibility"/"validate_builtin_scope"
  -- (which DO take their own locks) happening to have ALREADY fired —
  -- but "validate_axis_unit" sorts alphabetically BEFORE both of those,
  -- so at the moment THIS trigger reads the unit, neither lock has been
  -- taken yet. Fixed: lock the exact row this trigger itself is about to
  -- read, as its own first statement, independent of any other trigger's
  -- firing order.
  if new.metric_definition_id is not null then
    perform 1 from training_load.metric_definitions where id = new.metric_definition_id for share;
    select mdv.unit into v_new_unit
      from training_load.metric_definitions md
      join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id
      where md.id = new.metric_definition_id;
  elsif new.built_in_series_key is not null then
    perform 1 from training_load.dashboard_builtin_series where key = new.built_in_series_key for share;
    select unit into v_new_unit from training_load.dashboard_builtin_series where key = new.built_in_series_key;
  else
    return new;
  end if;

  select s.id, coalesce(
      (select mdv.unit from training_load.metric_definitions md join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id where md.id = s.metric_definition_id),
      (select b.unit from training_load.dashboard_builtin_series b where b.key = s.built_in_series_key)
    )
    into v_conflict_id, v_existing_unit
    from training_load.dashboard_widget_series s
    where s.widget_id = new.widget_id and s.axis = new.axis and s.id <> new.id
      and (s.metric_definition_id is not null or s.built_in_series_key is not null)
      and coalesce(
        (select mdv.unit from training_load.metric_definitions md join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id where md.id = s.metric_definition_id),
        (select b.unit from training_load.dashboard_builtin_series b where b.key = s.built_in_series_key)
      ) is distinct from v_new_unit
    limit 1;
  if v_conflict_id is not null then
    raise exception 'dashboard_widget_series: unit mismatch on widget % axis % — series % has unit %, this series has unit %', new.widget_id, new.axis, v_conflict_id, v_existing_unit, v_new_unit;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_axis_unit
  before insert or update of metric_definition_id, built_in_series_key, axis on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_axis_unit();

-- Round 3, §1: the Round 2 dashboard_widget_series_validate_aggregation
-- trigger (which forced analytical_aggregation to EQUAL the metric's own
-- daily_aggregation_method) is REMOVED here — that equality was exactly
-- the bug this round's task fixes. metric_definitions.daily_aggregation_
-- method (STAGE 1: the metric's own fixed, natural same-day reduction,
-- untouched Metrics Core contract) and dashboard_widget_series.
-- analytical_aggregation (STAGE 2: how THIS widget reduces the — already
-- day-reduced when needed — values across whatever `group_by` bucket it
-- uses) are independent by design now: the SAME "Total Distance" metric
-- (daily_aggregation_method='sum') can back one widget showing a weekly
-- sum, another showing a per-training average, another a per-training
-- max, and another showing every individual activity with no aggregation
-- at all — see the query adapter's own two-stage pipeline for where each
-- stage is actually applied.

-- Round 2, §2: comparison_period only valid on a widget_type that
-- declares supports_comparison_period — it changes the QUERY (two period
-- ranges fetched instead of one), so an incompatible setting must be
-- refused outright, not silently ignored by the renderer.
create function training_load.dashboard_widget_series_validate_comparison_period() returns trigger as $$
declare
  v_supports boolean;
begin
  if new.comparison_period is null then
    return new;
  end if;
  select t.supports_comparison_period into v_supports
    from training_load.dashboard_widgets w join training_load.dashboard_widget_types t on t.key = w.widget_type
    where w.id = new.widget_id;
  if not v_supports then
    raise exception 'dashboard_widget_series: comparison_period is not supported by this widget''s type (widget %)', new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_comparison_period
  before insert or update of comparison_period, widget_id on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_comparison_period();

-- Round 2, §2: a built-in series' scope level is fixed by the catalog
-- (RPE/sRPE/duration are always session-level facts; session_count/
-- last_session_date are always day-level rollups) — never a per-widget
-- choice for these.
-- Round 4, §10: same reasoning as the widget-type lock above — a FOR
-- SHARE lock on the referenced dashboard_builtin_series row closes the
-- "first series referencing this built-in vs. a concurrent semantic
-- change to it" race, blocking on a concurrent UPDATE's own implicit
-- exclusive lock until it resolves.
create function training_load.dashboard_widget_series_validate_builtin_scope() returns trigger as $$
declare
  v_fixed varchar;
begin
  if new.built_in_series_key is null then
    return new;
  end if;
  select fixed_data_scope_level into v_fixed from training_load.dashboard_builtin_series where key = new.built_in_series_key for share;
  if new.data_scope_level <> v_fixed then
    raise exception 'dashboard_widget_series: built-in series % is always scope_level=% (got %)', new.built_in_series_key, v_fixed, new.data_scope_level;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_builtin_scope
  before insert or update of built_in_series_key, data_scope_level on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_builtin_scope();

-- Round 2, §2 (soft check): if a metric_definition already has ANY
-- scope_capability rows configured (training_load.
-- metric_definition_scope_capabilities, v3), a series referencing it must
-- pick a data_scope_level that is actually among them — a component-scope
-- widget series for a metric that has only ever been configured/observed
-- at session scope is very likely a config mistake. A definition with
-- ZERO capability rows (nothing configured yet) is NOT blocked — there is
-- nothing yet to validate against, matching v3's own "backfill only from
-- real observed history, never guess" reasoning.
-- Round 5, §6 FIX: this trigger's own read of metric_definition_scope_
-- capabilities was completely UNLOCKED, and PL/pgSQL BEFORE-ROW triggers
-- on the same table+event fire in ALPHABETICAL ORDER BY TRIGGER NAME —
-- "validate_metric_visibility" (which DOES take a `FOR SHARE` lock on
-- metric_definitions) happens to sort before "validate_scope_capability"
-- today, but relying on that ordering accident is exactly the fragility
-- the task calls out: nothing another table (metric_definition_scope_
-- capabilities is a CHILD table, its OWN rows are never protected by a
-- lock on the parent metric_definitions row taken somewhere else) or a
-- future trigger rename would keep safe. Every trigger that reads
-- catalog/definition state relevant to metric_definition_id now takes
-- its OWN `FOR SHARE` lock on that metric_definitions row as its FIRST
-- statement — genuinely correct regardless of firing order, never
-- depending on a DIFFERENT trigger having already locked anything. This
-- also documents the discipline any FUTURE Metrics Core code adding/
-- removing a scope_capability row must itself follow (lock the PARENT
-- metric_definitions row first) for the "capability removal vs
-- add_series" race to be genuinely closed on both sides — this PoC only
-- owns the dashboard-side half of that contract.
create function training_load.dashboard_widget_series_validate_scope_capability() returns trigger as $$
declare
  v_has_any boolean;
  v_allowed boolean;
begin
  if new.metric_definition_id is null then
    return new;
  end if;
  perform 1 from training_load.metric_definitions where id = new.metric_definition_id for share;
  select exists (select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id = new.metric_definition_id) into v_has_any;
  if not v_has_any then
    return new;
  end if;
  select exists (
    select 1 from training_load.metric_definition_scope_capabilities
    where metric_definition_id = new.metric_definition_id and scope_level = new.data_scope_level
  ) into v_allowed;
  if not v_allowed then
    raise exception 'dashboard_widget_series: metric_definition % has never been configured for scope_level=% (widget %)', new.metric_definition_id, new.data_scope_level, new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_scope_capability
  before insert or update of metric_definition_id, data_scope_level on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_scope_capability();

-- Round 2, §1 — REWORKED metric-definition visibility: checks the
-- dashboard's DATA WORKSPACE (data_workspace_type/data_workspace_scope_id),
-- never owner_scope directly. A private ('user'-owned) dashboard bound to
-- Club A's data workspace may now reference: 'system' metrics, Club A's
-- own club metrics (NEW — round 1 could not see these at all), or the
-- SAME coach's own private metrics (unchanged) — but never Club B's, and
-- never another coach's private metrics, matching PoC items 6/8 exactly
-- as before, just against the richer, correctly-separated model.
create function training_load.dashboard_widget_series_validate_metric_visibility() returns trigger as $$
declare
  v_data_type varchar; v_data_scope uuid; v_dash_owner_scope varchar; v_dash_owner_user uuid;
  v_def_scope varchar; v_def_user uuid; v_def_club uuid; v_def_team uuid;
begin
  if new.metric_definition_id is null then
    return new;
  end if;
  select d.data_workspace_type, d.data_workspace_scope_id, d.owner_scope, d.owner_user_id
    into v_data_type, v_data_scope, v_dash_owner_scope, v_dash_owner_user
    from training_load.dashboard_widgets w join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = new.widget_id;
  -- Round 4, §10: FOR SHARE closes "series insert vs. a concurrent
  -- ownership/current_version change on this metric_definition" — a
  -- concurrent UPDATE (ownership or a legitimate current_version_id bump,
  -- both real Metrics Core operations) holds an implicit row lock that
  -- conflicts with this share lock, so our visibility check below is
  -- guaranteed to run against either the fully-pre-update or fully-post-
  -- update row, never a value caught mid-flight. Documented tradeoff: a
  -- long-running series-insert transaction can delay a legitimate,
  -- unrelated version bump on the SAME metric_definition until it
  -- commits — acceptable, since this critical section is normally a
  -- single fast INSERT, and correctness (never validating against a
  -- half-applied ownership change) is worth more here than that narrow
  -- concurrency cost. See report §0-R4.10.
  select owner_scope, owner_user_id, owner_club_id, owner_team_id
    into v_def_scope, v_def_user, v_def_club, v_def_team
    from training_load.metric_definitions where id = new.metric_definition_id for share;

  if v_def_scope = 'system' then
    return new;
  end if;
  -- The dashboard owner's OWN private catalog is always visible to their
  -- own dashboards, independent of which data workspace it is bound to
  -- (a coach's personal metrics travel with them across workspaces).
  if v_dash_owner_scope = 'user' and v_def_scope = 'user' and v_def_user = v_dash_owner_user then
    return new;
  end if;
  if v_def_scope = 'club' and v_data_type = 'club' and v_def_club = v_data_scope then
    return new;
  end if;
  if v_def_scope = 'team' and v_data_type = 'team' and v_def_team = v_data_scope then
    return new;
  end if;
  raise exception 'dashboard_widget_series: metric_definition % (owner_scope=%/%/%/%) is not visible to this dashboard''s data workspace %/%',
    new.metric_definition_id, v_def_scope, v_def_club, v_def_team, v_def_user, v_data_type, v_data_scope;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_metric_visibility
  before insert or update of metric_definition_id, widget_id on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_metric_visibility();

-- Round 2, §4: a source_connection_id must be visible to the SAME data
-- workspace, exactly mirroring the metric-visibility rule above — a
-- private Club-A-bound dashboard must not be able to pin a series to
-- Club B's import connection.
create function training_load.dashboard_widget_series_validate_source_connection_visibility() returns trigger as $$
declare
  v_data_type varchar; v_data_scope uuid; v_dash_owner_scope varchar; v_dash_owner_user uuid;
  v_conn_scope varchar; v_conn_club uuid; v_conn_team uuid; v_conn_user uuid;
begin
  if new.source_connection_id is null then
    return new;
  end if;
  select d.data_workspace_type, d.data_workspace_scope_id, d.owner_scope, d.owner_user_id
    into v_data_type, v_data_scope, v_dash_owner_scope, v_dash_owner_user
    from training_load.dashboard_widgets w join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = new.widget_id;
  -- Round 4, §10: same FOR SHARE reasoning as the metric-visibility
  -- trigger above, applied to the source connection's own ownership.
  select owner_scope, owner_club_id, owner_team_id, owner_user_id
    into v_conn_scope, v_conn_club, v_conn_team, v_conn_user
    from training_load.metric_source_connections where id = new.source_connection_id for share;
  if v_conn_scope = 'system' then
    return new;
  end if;
  -- A private coach's OWN import connection is always visible to their own
  -- dashboards, independent of which data workspace those dashboards are
  -- bound to — mirrors dashboard_widget_series_validate_metric_visibility's
  -- identical carve-out for a coach's own private metric catalog. Another
  -- private coach's connection stays invisible (v_conn_user must equal the
  -- DASHBOARD's own owner_user_id, never merely compared against v_data_scope).
  if v_dash_owner_scope = 'user' and v_conn_scope = 'user' and v_conn_user = v_dash_owner_user then
    return new;
  end if;
  if v_conn_scope = 'club' and v_data_type = 'club' and v_conn_club = v_data_scope then
    return new;
  end if;
  if v_conn_scope = 'team' and v_data_type = 'team' and v_conn_team = v_data_scope then
    return new;
  end if;
  raise exception 'dashboard_widget_series: source_connection % (owner_scope=%/%/%/%) is not visible to this dashboard''s data workspace %/%',
    new.source_connection_id, v_conn_scope, v_conn_club, v_conn_team, v_conn_user, v_data_type, v_data_scope;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_source_connection_visibility
  before insert or update of source_connection_id, widget_id on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_source_connection_visibility();

-- Round 2, §3: series add/update/delete/reorder is a query/render-
-- relevant change to the PARENT WIDGET — bump ITS revision, not just log
-- the series row's own existence. AFTER trigger (fires once the row is
-- already committed within the statement), reusing the same
-- bump_widget_revision helper the direct widget-edit path does not need
-- (that one still goes through dashboard_widgets_bump_revision, a BEFORE
-- trigger on that table itself) — two different tables, two different
-- trigger timings, ONE shared revision-increment primitive.
create function training_load.dashboard_widget_series_bump_widget_revision() returns trigger as $$
begin
  perform training_load.bump_widget_revision(coalesce(new.widget_id, old.widget_id));
  return coalesce(new, old);
end;
$$ language plpgsql;

create trigger dashboard_widget_series_bump_widget_on_insert
  after insert on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_bump_widget_revision();
create trigger dashboard_widget_series_bump_widget_on_update
  after update on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_bump_widget_revision();
create trigger dashboard_widget_series_bump_widget_on_delete
  after delete on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_bump_widget_revision();

-- ------------------------------------------------------------
-- 6. Atomic layout replace (report §D3/Round 2 §6) — the ONE sanctioned
--    way to apply a multi-widget position/size/mobile_order change
--    (desktop swap/rearrange, or a batch of mobile Move up/down steps) as
--    a single all-or-nothing operation: lock the dashboard, check the
--    caller's expected revision, apply every row, force the deferred
--    overlap check to run NOW (not silently deferred to whatever
--    unrelated commit happens to come next), and return the fresh state.
--
--    Round 3, §4 CORRECTION: Round 2's comment here said a caller "MAY
--    still write dashboard_widgets directly for a single-widget change".
--    That is no longer accurate as a RECOMMENDATION (it remains
--    functionally correct — see dashboard_widgets_bump_revision's own
--    comment) — a raw single-widget UPDATE locks the WIDGET row before
--    the DASHBOARD row (Postgres locks an UPDATE's target row before any
--    before-row trigger fires), the reverse of THIS function's own
--    dashboard-then-widget order, which is a real, provable deadlock risk
--    under concurrency. training_load.update_widget_layout() below is now
--    the SANCTIONED single-widget entry point — genuinely dashboard-
--    first, proven safe to run concurrently with this function (see its
--    own comment and the report's lock-order section for the full trace).
-- ------------------------------------------------------------
create function training_load.replace_dashboard_layout(
  p_dashboard_id uuid,
  p_expected_revision integer,
  p_layout jsonb -- [{"widgetId": "...", "x":0,"y":0,"width":4,"height":2,"mobileOrder":1}, ...]
) returns table (widget_id uuid, x smallint, y smallint, width smallint, height smallint, mobile_order integer, revision integer, dashboard_revision integer) as $$
declare
  v_current_revision integer;
  v_entry jsonb;
begin
  select d.revision into v_current_revision from training_load.dashboards d where d.id = p_dashboard_id for update;
  if not found then
    raise exception 'replace_dashboard_layout: dashboard % not found', p_dashboard_id;
  end if;
  if v_current_revision <> p_expected_revision then
    raise exception 'replace_dashboard_layout: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_current_revision using errcode = '40001';
  end if;

  for v_entry in select * from jsonb_array_elements(p_layout) loop
    -- Table alias `w` + qualified column references throughout — the
    -- bare column names (x, width, ...) collide with this FUNCTION's own
    -- RETURNS TABLE out-parameter names of the identical names, which
    -- PL/pgSQL would otherwise treat as ambiguous.
    update training_load.dashboard_widgets w
      set x = coalesce((v_entry ->> 'x')::smallint, w.x),
          y = coalesce((v_entry ->> 'y')::smallint, w.y),
          width = coalesce((v_entry ->> 'width')::smallint, w.width),
          height = coalesce((v_entry ->> 'height')::smallint, w.height),
          mobile_order = coalesce((v_entry ->> 'mobileOrder')::integer, w.mobile_order)
      where w.id = (v_entry ->> 'widgetId')::uuid and w.dashboard_id = p_dashboard_id;
    if not found then
      raise exception 'replace_dashboard_layout: widget % does not belong to dashboard %', v_entry ->> 'widgetId', p_dashboard_id;
    end if;
  end loop;

  -- Force the deferred overlap check (and the deferred widget_order/
  -- mobile_order uniqueness constraints) to run NOW, inside this
  -- function's own transaction scope, rather than silently deferring to
  -- whatever the CALLER's own outer transaction happens to do next.
  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique, training_load.dashboard_widgets_mobile_order_unique immediate;

  -- This function's own optimistic-concurrency token IS dashboards.revision
  -- (checked above). Round 3, §4: each per-widget UPDATE above ALREADY
  -- bumps dashboards.revision on its own now (dashboard_widgets_bump_
  -- revision's layout branch, since Round 2's exclusion of position/size
  -- from the dashboard-level signal was reversed this round) — this extra,
  -- explicit call is kept anyway as a deliberate, unconditional guarantee:
  -- it makes dashboards.revision bump at least once per successful call
  -- to THIS function even in the (currently impossible, but not worth
  -- depending on) case of an empty p_layout array, and it keeps
  -- replace_dashboard_layout's own correctness independent of exactly how
  -- dashboard_widgets_bump_revision happens to be implemented. A harmless
  -- double-bump on the normal (non-empty) path is explicitly fine — the
  -- task's own contract is "revision need not increment by exactly 1",
  -- only that the returned token is fresh and sole-authoritative.
  perform training_load.bump_dashboard_revision(p_dashboard_id);

  return query
    select w.id, w.x, w.y, w.width, w.height, w.mobile_order, w.revision, d.revision
    from training_load.dashboard_widgets w
    join training_load.dashboards d on d.id = w.dashboard_id
    where w.dashboard_id = p_dashboard_id and w.id in (select (e ->> 'widgetId')::uuid from jsonb_array_elements(p_layout) e);
end;
$$ language plpgsql;

-- Round 3, §4: the SANCTIONED, deadlock-safe single-widget layout-change
-- entry point — proven safe to run concurrently with replace_dashboard_
-- layout() because it locks the DASHBOARD row FIRST via its own explicit
-- `SELECT ... FOR UPDATE` (after only a plain, unlocked read to resolve
-- the widget's dashboard_id) and only THEN touches the widget row —
-- genuinely dashboard-before-widget. A raw `UPDATE dashboard_widgets SET
-- x=... WHERE id=...` cannot achieve this order: Postgres locks an
-- UPDATE's own target row before any before-row trigger runs, so
-- dashboard_widgets_lock_dashboard_before_layout_write's attempt to lock
-- the dashboard "first" is already too late for an UPDATE (it IS
-- genuinely first for an INSERT, where no widget row exists yet to lock —
-- see that trigger's own comment). The application's route layer must use
-- THIS function (or replace_dashboard_layout for a multi-widget batch)
-- for every layout write — see the PoC's dedicated concurrency test
-- proving this function and replace_dashboard_layout never deadlock
-- against each other, and the report's lock-order section for the full
-- AB-BA trace a raw UPDATE would risk instead.
create function training_load.update_widget_layout(
  p_widget_id uuid,
  p_expected_widget_revision integer,
  p_x smallint,
  p_y smallint,
  p_width smallint,
  p_height smallint,
  p_mobile_order integer
) returns table (
  widget_id uuid, dashboard_id uuid, x smallint, y smallint, width smallint, height smallint,
  mobile_order integer, widget_revision integer, dashboard_revision integer
) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_locked_dashboard_id uuid;
begin
  -- Round 4, §5 TOCTOU FIX. The previous shape read+checked the widget's
  -- revision BEFORE locking the dashboard, then locked the dashboard, then
  -- updated with no re-check — a genuine race: another writer could change
  -- this widget between the unlocked read and the dashboard lock, and this
  -- function would go on to accept an already-stale p_expected_widget_revision
  -- because it never looked again. Corrected order:
  --   1. an UNLOCKED read used ONLY to find dashboard_id (never trusted
  --      for anything else — it exists purely to know which dashboard row
  --      to lock first, since dashboard_id is immutable so this can never
  --      itself go stale in a way that matters).
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'update_widget_layout: widget % not found', p_widget_id;
  end if;

  --   2. lock the DASHBOARD row first — genuinely first, before this
  --      function has touched dashboard_widgets at all.
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;

  --   3. NOW lock and RE-READ the widget row — this is the fresh,
  --      trustworthy revision, taken only after the dashboard lock is
  --      held, so nothing can have raced it undetected in between.
  select w.dashboard_id, w.revision into v_locked_dashboard_id, v_current_widget_revision
    from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if not found then
    raise exception 'update_widget_layout: widget % disappeared concurrently (deleted between lookup and lock)', p_widget_id;
  end if;

  --   4. confirm the widget still belongs to the SAME dashboard we locked
  --      (defense-in-depth — dashboard_id is immutable by trigger, so this
  --      can only ever be a no-op today, but the function's own safety
  --      does not have to depend on that OTHER trigger never changing).
  if v_locked_dashboard_id is distinct from v_dashboard_id then
    raise exception 'update_widget_layout: widget % dashboard_id changed between lookup and lock (% -> %)', p_widget_id, v_dashboard_id, v_locked_dashboard_id;
  end if;

  --   5. ONLY NOW check the caller's expected revision, against the FRESH,
  --      locked value from step 3 — never the stale step-1 read.
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'update_widget_layout: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;

  --   6. the UPDATE itself, with an EXTRA revision guard in the WHERE
  --      clause on top of the row lock already held — belt-and-suspenders:
  --      the lock alone is sufficient, but the guard makes the statement's
  --      own correctness independent of the lock being held correctly.
  update training_load.dashboard_widgets w
    set x = p_x, y = p_y, width = p_width, height = p_height, mobile_order = p_mobile_order
    where w.id = p_widget_id and w.revision = p_expected_widget_revision;
  if not found then
    raise exception 'update_widget_layout: stale widget revision (expected %) — reload and retry', p_expected_widget_revision using errcode = '40001';
  end if;

  -- Same reasoning as replace_dashboard_layout: force the deferred
  -- overlap/order checks to run inside THIS function's own transaction
  -- scope rather than silently deferring to the caller's outer commit.
  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique, training_load.dashboard_widgets_mobile_order_unique immediate;

  --   7. return the REAL, fresh widget AND dashboard revision tokens.
  return query
    select w.id, w.dashboard_id, w.x, w.y, w.width, w.height, w.mobile_order, w.revision, d.revision
    from training_load.dashboard_widgets w
    join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = p_widget_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 6b. Round 4, §6 — the full set of SANCTIONED write functions. The
-- project uses no SECURITY DEFINER / DB-role trick to make raw SQL
-- against these tables physically impossible — nothing below claims
-- otherwise. What these functions ARE: the one documented, proven-safe
-- dashboard->widget->series lock order for every write this subsystem
-- needs, which the real backend's route layer MUST use exclusively (a
-- hard implementation requirement, stated plainly — see report
-- §0-R4.6). A raw INSERT/UPDATE/DELETE against these tables from a
-- superuser/migration/raw-SQL context stays outside this contract by
-- definition — that boundary is real and is not being hidden.
--
-- Why series writes need their OWN dashboard-first lock, not just the
-- widget lock they already had: lock_widget_for_series_write (Round 2)
-- only ever locked the WIDGET row, never the dashboard — meaning a series
-- write and a whole-dashboard batch operation (replace_dashboard_layout,
-- delete_widget, a future archive/clone step) had NO shared lock at all
-- to serialize behind, a real, if narrow, gap in the "dashboard -> widget
-- -> series, always" claim. Every function below locks the dashboard
-- FIRST (via the widget's own, immutable dashboard_id), then the widget,
-- then performs its own table's operation — genuinely the same order,
-- every time, for every one of: create/update-content/delete widget,
-- add/update/delete/reorder series, update-single-widget-layout (above),
-- replace-whole-layout (above), archive (above).
-- ------------------------------------------------------------

create function training_load.create_widget(
  p_dashboard_id uuid, p_expected_dashboard_revision integer,
  p_widget_type text, p_title text, p_widget_order integer,
  p_x smallint, p_y smallint, p_width smallint, p_height smallint, p_mobile_order integer,
  p_group_by varchar default 'day', p_display_config jsonb default '{"schemaVersion": 1}'::jsonb,
  p_local_filter_override jsonb default null
) returns table (widget_id uuid, dashboard_revision integer) as $$
declare
  v_current_revision integer;
  v_widget_id uuid;
begin
  -- INSERT is the one operation where the EXISTING dashboard_widgets_lock_
  -- dashboard_before_layout_write trigger already achieves genuine
  -- dashboard-first ordering on its own (no widget row exists yet to
  -- compete for) — this function's own explicit lock below is therefore
  -- somewhat redundant with that trigger, but is kept anyway so the
  -- revision check happens BEFORE the insert is attempted (a cleaner
  -- failure than letting the insert run and only then discovering the
  -- caller's expected_revision was stale), and so every sanctioned
  -- function in this section follows the identical, easy-to-audit shape.
  select d.revision into v_current_revision from training_load.dashboards d where d.id = p_dashboard_id for update;
  if not found then
    raise exception 'create_widget: dashboard % not found', p_dashboard_id;
  end if;
  if v_current_revision <> p_expected_dashboard_revision then
    raise exception 'create_widget: stale dashboard revision (expected %, dashboard is at %) — reload and retry', p_expected_dashboard_revision, v_current_revision using errcode = '40001';
  end if;
  insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order, group_by, display_config, local_filter_override)
    values (p_dashboard_id, p_widget_type, p_title, p_widget_order, p_x, p_y, p_width, p_height, p_mobile_order, coalesce(p_group_by, 'day'), coalesce(p_display_config, '{"schemaVersion": 1}'::jsonb), p_local_filter_override)
    returning id into v_widget_id;
  set constraints training_load.dashboard_widgets_check_no_overlap, training_load.dashboard_widgets_order_unique, training_load.dashboard_widgets_mobile_order_unique immediate;
  return query select v_widget_id, d.revision from training_load.dashboards d where d.id = p_dashboard_id;
end;
$$ language plpgsql;

create function training_load.update_widget_content(
  p_widget_id uuid, p_expected_widget_revision integer,
  p_widget_type text default null, p_title text default null, p_group_by varchar default null,
  p_state varchar default null, p_display_config jsonb default null,
  p_local_filter_override jsonb default null, p_clear_local_filter_override boolean default false
) returns table (widget_id uuid, widget_revision integer, dashboard_id uuid) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'update_widget_content: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if not found then
    raise exception 'update_widget_content: widget % disappeared concurrently', p_widget_id;
  end if;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'update_widget_content: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  update training_load.dashboard_widgets w set
    widget_type = coalesce(p_widget_type, w.widget_type),
    title = coalesce(p_title, w.title),
    group_by = coalesce(p_group_by, w.group_by),
    state = coalesce(p_state, w.state),
    display_config = coalesce(p_display_config, w.display_config),
    local_filter_override = case when p_clear_local_filter_override then null else coalesce(p_local_filter_override, w.local_filter_override) end
  where w.id = p_widget_id and w.revision = p_expected_widget_revision;
  if not found then
    raise exception 'update_widget_content: stale widget revision (expected %) — reload and retry', p_expected_widget_revision using errcode = '40001';
  end if;
  return query select w.id, w.revision, w.dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- Round 4, §6: the sanctioned single-widget delete — closes the AB-BA
-- risk a raw `DELETE FROM dashboard_widgets WHERE id=...` carries (the
-- DELETE's own implicit row lock is acquired on the WIDGET first, then
-- dashboard_widgets_bump_parent_on_delete's AFTER trigger locks the
-- dashboard second — the reverse of every other sanctioned function's
-- order, and a genuine deadlock risk against replace_dashboard_layout()/
-- update_widget_layout() running concurrently on the same dashboard).
create function training_load.delete_widget(p_widget_id uuid, p_expected_widget_revision integer)
returns table (dashboard_id uuid, dashboard_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'delete_widget: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if not found then
    raise exception 'delete_widget: widget % disappeared concurrently', p_widget_id;
  end if;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'delete_widget: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  delete from training_load.dashboard_widgets where id = p_widget_id;
  return query select v_dashboard_id, d.revision from training_load.dashboards d where d.id = v_dashboard_id;
end;
$$ language plpgsql;

-- Round 4, §6: sanctioned series writes — each locks dashboard, then
-- widget, before touching dashboard_widget_series, closing the gap where
-- Round 2's lock_widget_for_series_write locked ONLY the widget, never
-- the dashboard, leaving series writes with no shared lock against a
-- whole-dashboard operation at all.
create function training_load.add_series(
  p_widget_id uuid, p_expected_widget_revision integer, p_series_order integer,
  p_metric_definition_id uuid default null, p_built_in_series_key text default null,
  p_template_metric_key_hints jsonb default null, p_resolution_status varchar default 'resolved',
  p_template_resolution_candidates jsonb default null,
  p_axis varchar default 'primary', p_color text default null, p_display_label text default null,
  p_source_policy varchar default 'all_with_conflicts', p_source_connection_id uuid default null,
  p_data_scope_level varchar default 'session', p_analytical_aggregation varchar default 'sum',
  p_aggregation_role_policy varchar default 'standalone_and_source_rollup', p_coverage_policy varchar default 'complete_and_partial',
  p_comparison_period varchar default null, p_created_by_user_id uuid default null
) returns table (series_id uuid, widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_series_id uuid;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'add_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'add_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  insert into training_load.dashboard_widget_series (
    widget_id, series_order, metric_definition_id, built_in_series_key, template_metric_key_hints,
    resolution_status, template_resolution_candidates,
    axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation,
    aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id
  ) values (
    p_widget_id, p_series_order, p_metric_definition_id, p_built_in_series_key, p_template_metric_key_hints,
    p_resolution_status, p_template_resolution_candidates,
    coalesce(p_axis, 'primary'), p_color, p_display_label, coalesce(p_source_policy, 'all_with_conflicts'), p_source_connection_id,
    coalesce(p_data_scope_level, 'session'), coalesce(p_analytical_aggregation, 'sum'),
    coalesce(p_aggregation_role_policy, 'standalone_and_source_rollup'), coalesce(p_coverage_policy, 'complete_and_partial'),
    p_comparison_period, p_created_by_user_id
  ) returning id into v_series_id;
  return query select v_series_id, w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

create function training_load.update_series(
  p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer,
  p_axis varchar default null, p_color text default null, p_display_label text default null,
  p_source_policy varchar default null, p_source_connection_id uuid default null,
  p_data_scope_level varchar default null, p_analytical_aggregation varchar default null,
  p_aggregation_role_policy varchar default null, p_coverage_policy varchar default null,
  p_comparison_period varchar default null, p_clear_comparison_period boolean default false
) returns table (series_id uuid, widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'update_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'update_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  -- Round 5, §4 FIX: the old shape (`coalesce(p_source_connection_id,
  -- s.source_connection_id)`) could never CLEAR a pinned connection — a
  -- caller moving source_policy away from 'source_connection' (to
  -- 'all_with_conflicts'/'manual'/'api_import'/'csv_import'/'derived')
  -- without ALSO explicitly re-passing a null connection would keep the
  -- OLD connection id, immediately failing the table's own CHECK
  -- (source_connection_id is null or source_policy='source_connection').
  -- The only sanctioned function for this column therefore CANNOT
  -- express a legal transition away from 'source_connection' at all,
  -- forcing a raw UPDATE bypass. Fixed: whenever the CALLER explicitly
  -- changes source_policy to anything other than 'source_connection', the
  -- connection pin is cleared automatically — no separate p_clear flag
  -- needed, since a non-'source_connection' policy can never legally
  -- carry a connection id in the first place.
  update training_load.dashboard_widget_series s set
    axis = coalesce(p_axis, s.axis),
    color = coalesce(p_color, s.color),
    display_label = coalesce(p_display_label, s.display_label),
    source_policy = coalesce(p_source_policy, s.source_policy),
    source_connection_id = case
      when p_source_policy is not null and p_source_policy <> 'source_connection' then null
      else coalesce(p_source_connection_id, s.source_connection_id)
    end,
    data_scope_level = coalesce(p_data_scope_level, s.data_scope_level),
    analytical_aggregation = coalesce(p_analytical_aggregation, s.analytical_aggregation),
    aggregation_role_policy = coalesce(p_aggregation_role_policy, s.aggregation_role_policy),
    coverage_policy = coalesce(p_coverage_policy, s.coverage_policy),
    comparison_period = case when p_clear_comparison_period then null else coalesce(p_comparison_period, s.comparison_period) end
  where s.id = p_series_id and s.widget_id = p_widget_id;
  if not found then
    raise exception 'update_series: series % not found under widget %', p_series_id, p_widget_id;
  end if;
  return query select p_series_id, w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- Round 5, §3: the sanctioned resolve/bind function — the ONE write path
-- allowed to move a series out of 'unresolved'/'ambiguous' into
-- 'resolved'. Before this round, NONE of the sanctioned functions could
-- touch resolution_status/metric_definition_id/template_resolution_
-- candidates at all (update_series's own coalesce-based SET list never
-- assigns these three columns), meaning the model's own claim — "an
-- unresolved/ambiguous series stays fixable" — had no real, sanctioned
-- way to actually BE fixed; the only working path was a raw UPDATE
-- bypassing the entire sanctioned-write contract this file otherwise
-- insists on.
--
-- Same dashboard->widget->series lock order as every other sanctioned
-- series function. The critical property: this function does NOT trust
-- the row's own STORED template_resolution_candidates as an
-- authorization source (that JSONB snapshot can be stale — visibility
-- can change between clone time and pick time, see the test proving
-- exactly this) — it re-validates the CALLER's chosen p_metric_definition_id
-- LIVE, for real, by performing a genuine UPDATE of metric_definition_id,
-- which fires the SAME dashboard_widget_series_validate_metric_visibility
-- (and _validate_scope_capability, _validate_axis_unit) triggers every
-- other metric_definition_id write already goes through — no bespoke,
-- possibly-weaker re-implementation of that check here, the real trigger
-- IS the authorization.
create function training_load.resolve_series_binding(
  p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer, p_metric_definition_id uuid
) returns table (series_id uuid, widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_current_status varchar;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'resolve_series_binding: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'resolve_series_binding: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  select resolution_status into v_current_status from training_load.dashboard_widget_series where id = p_series_id and widget_id = p_widget_id;
  if not found then
    raise exception 'resolve_series_binding: series % not found under widget %', p_series_id, p_widget_id;
  end if;
  if v_current_status = 'resolved' then
    raise exception 'resolve_series_binding: series % is already resolved — nothing to bind', p_series_id;
  end if;
  if p_metric_definition_id is null then
    raise exception 'resolve_series_binding: p_metric_definition_id is required';
  end if;
  -- The UPDATE itself: setting metric_definition_id fires the real
  -- visibility/scope-capability/axis-unit triggers (unchanged, doing
  -- their OWN live re-check) — a metric that is no longer visible to
  -- this dashboard's data workspace is rejected right here, by the SAME
  -- mechanism that protects every other metric binding in this file,
  -- never by this function re-deriving that logic.
  update training_load.dashboard_widget_series s set
    metric_definition_id = p_metric_definition_id,
    resolution_status = 'resolved',
    template_resolution_candidates = null
  where s.id = p_series_id and s.widget_id = p_widget_id;
  return query select p_series_id, w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

create function training_load.delete_series(p_series_id uuid, p_widget_id uuid, p_expected_widget_revision integer)
returns table (widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_deleted uuid;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'delete_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'delete_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  delete from training_load.dashboard_widget_series where id = p_series_id and widget_id = p_widget_id returning id into v_deleted;
  if v_deleted is null then
    raise exception 'delete_series: series % not found under widget %', p_series_id, p_widget_id;
  end if;
  return query select w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- Round 4, §6/§12: batch series reorder — the series-level analog of
-- replace_dashboard_layout(), same dashboard-first lock order, one
-- atomic all-or-nothing call for a drag-reorder of a widget's own series.
create function training_load.reorder_series(p_widget_id uuid, p_expected_widget_revision integer, p_order jsonb)
returns table (widget_revision integer) as $$
declare
  v_dashboard_id uuid;
  v_current_widget_revision integer;
  v_entry jsonb;
  v_updated uuid;
begin
  select w.dashboard_id into v_dashboard_id from training_load.dashboard_widgets w where w.id = p_widget_id;
  if not found then
    raise exception 'reorder_series: widget % not found', p_widget_id;
  end if;
  perform 1 from training_load.dashboards d where d.id = v_dashboard_id for update;
  select w.revision into v_current_widget_revision from training_load.dashboard_widgets w where w.id = p_widget_id for update;
  if v_current_widget_revision <> p_expected_widget_revision then
    raise exception 'reorder_series: stale widget revision (expected %, widget is at %) — reload and retry', p_expected_widget_revision, v_current_widget_revision using errcode = '40001';
  end if;
  for v_entry in select * from jsonb_array_elements(p_order) loop
    update training_load.dashboard_widget_series s set series_order = (v_entry ->> 'seriesOrder')::integer
      where s.id = (v_entry ->> 'seriesId')::uuid and s.widget_id = p_widget_id
      returning s.id into v_updated;
    if v_updated is null then
      raise exception 'reorder_series: series % does not belong to widget %', v_entry ->> 'seriesId', p_widget_id;
    end if;
  end loop;
  set constraints training_load.dashboard_widget_series_order_unique immediate;
  return query select w.revision from training_load.dashboard_widgets w where w.id = p_widget_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- 7. Active dashboard selection.
--
-- Round 2, §1 — REWORKED: the selected dashboard's OWN data-workspace
-- binding must EXACTLY equal the active_selection row's own
-- workspace_type/scope_id — not "visible by owner_scope" as round 1 had
-- it. This is the direct fix for "isti privatni dashboard ne sme se
-- automatski koristiti u Club B workspace-u": a private dashboard bound
-- to Club A's data can only ever be selected as active while viewing
-- Club A, never Club B, never any other workspace — full stop. A
-- 'system'-owned (always-template, always data_workspace_type IS NULL)
-- dashboard can never satisfy this equality against any real workspace
-- row, so it can never be selected as active without being cloned first
-- — exactly the intended "must clone before real use" rule.
-- ------------------------------------------------------------
create table training_load.dashboard_active_selection (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  workspace_type varchar(20) not null check (workspace_type in ('platform', 'private_coach', 'club', 'team', 'athlete')),
  scope_id uuid,
  dashboard_id uuid not null references training_load.dashboards(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check (
    (workspace_type in ('club', 'team') and scope_id is not null) or
    (workspace_type in ('platform', 'private_coach', 'athlete') and scope_id is null)
  ),
  unique nulls not distinct (user_id, workspace_type, scope_id)
);

create index dashboard_active_selection_dashboard_idx on training_load.dashboard_active_selection (dashboard_id);

-- Round 3, §7 / Round 4, §8 / Round 5, §5: an ARCHIVED dashboard must
-- never become (or remain selectable as) a user's active dashboard for a
-- workspace. Since Round 4, archiving a dashboard that IS currently
-- someone's active selection is no longer merely "caught on next
-- re-selection" — dashboards_archive_clears_active_selection (below the
-- dashboard_active_selection table's own definition) atomically deletes
-- any existing selection row the INSTANT a dashboard's status becomes
-- 'archived', regardless of how (a raw UPDATE, or archive_dashboard()).
--
-- Round 5, §5 FIX: this trigger's own status/workspace read was UNLOCKED
-- — a real race: a concurrent SELECT (this trigger) and a concurrent
-- ARCHIVE could each read the dashboard's pre-change state, both
-- "succeed" from their own point of view, and interleave into a final
-- state where a brand-new selection row survives an archive that had
-- already committed (selection reads status='active' before archive
-- commits, inserts after archive's own AFTER-trigger delete already ran).
-- Fixed: this trigger now takes the SAME `FOR UPDATE` lock on the
-- dashboard row that archive_dashboard() takes, BEFORE reading
-- status/workspace — genuinely serializing against a concurrent archive,
-- in the same dashboard-first order every other sanctioned writer uses.
-- Whichever of the two (this INSERT, or an archive) reaches the lock
-- first fully completes (including, for an archive, its own AFTER
-- delete-selection trigger, which runs within the SAME transaction and
-- is visible to anyone who only proceeds once that transaction commits)
-- before the other is ever unblocked — see the report's lock-order
-- section for the full two-connection proof.
create function training_load.dashboard_active_selection_validate_visibility() returns trigger as $$
declare
  v_data_type varchar; v_data_scope uuid; v_status varchar;
begin
  perform 1 from training_load.dashboards where id = new.dashboard_id for update;
  select data_workspace_type, data_workspace_scope_id, status into v_data_type, v_data_scope, v_status
    from training_load.dashboards where id = new.dashboard_id;
  if v_status is distinct from 'active' then
    raise exception 'dashboard_active_selection: dashboard % is not active (status=%) and cannot be selected', new.dashboard_id, v_status;
  end if;
  if v_data_type is distinct from new.workspace_type or v_data_scope is distinct from new.scope_id then
    raise exception 'dashboard_active_selection: dashboard % (data workspace %/%) does not match the exact selection context %/% for user %', new.dashboard_id, v_data_type, v_data_scope, new.workspace_type, new.scope_id, new.user_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_active_selection_validate_visibility
  before insert or update of dashboard_id, workspace_type, scope_id, user_id on training_load.dashboard_active_selection
  for each row execute function training_load.dashboard_active_selection_validate_visibility();

create function training_load.dashboard_active_selection_touch() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger dashboard_active_selection_touch_updated_at
  before update on training_load.dashboard_active_selection
  for each row execute function training_load.dashboard_active_selection_touch();

-- Round 4, §8 FIX: the trigger above already prevents a NEW selection of
-- an archived dashboard, but a dashboard that gets archived WHILE it is
-- CURRENTLY someone's active selection left that selection row untouched
-- — a real "validand-looking active dashboard that is actually archived"
-- state, exactly what the task calls out. Declared as a TRIGGER on
-- dashboards itself (not only as app-level function logic) so the
-- guarantee holds no matter HOW a dashboard becomes archived — a raw
-- UPDATE, a future admin tool, or the sanctioned archive_dashboard()
-- function below all go through this same AFTER trigger, atomically, in
-- the SAME transaction as the status change. Kept in this section
-- (rather than next to dashboards_bump_revision) because it is
-- conceptually an active-selection invariant, even though it fires on
-- training_load.dashboards.
create function training_load.dashboards_archive_clears_active_selection() returns trigger as $$
begin
  if new.status = 'archived' and old.status is distinct from 'archived' then
    delete from training_load.dashboard_active_selection where dashboard_id = new.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_archive_clears_active_selection
  after update of status on training_load.dashboards
  for each row execute function training_load.dashboards_archive_clears_active_selection();

-- Round 4, §8: the sanctioned application entry point for archiving — not
-- strictly required for the CORRECTNESS guarantee above (the trigger
-- enforces it regardless of caller), but kept consistent with every other
-- sanctioned write function in §6: locks the dashboard, checks the
-- caller's expected revision, and returns the fresh state in one call.
create function training_load.archive_dashboard(p_dashboard_id uuid, p_expected_revision integer)
returns table (dashboard_id uuid, status varchar, revision integer) as $$
declare
  v_current_revision integer;
begin
  select d.revision into v_current_revision from training_load.dashboards d where d.id = p_dashboard_id for update;
  if not found then
    raise exception 'archive_dashboard: dashboard % not found', p_dashboard_id;
  end if;
  if v_current_revision <> p_expected_revision then
    raise exception 'archive_dashboard: stale revision (expected %, dashboard is at %) — reload and retry', p_expected_revision, v_current_revision using errcode = '40001';
  end if;
  update training_load.dashboards set status = 'archived' where id = p_dashboard_id;
  return query select d.id, d.status, d.revision from training_load.dashboards d where d.id = p_dashboard_id;
end;
$$ language plpgsql;
