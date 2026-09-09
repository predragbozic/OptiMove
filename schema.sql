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

-- Round 2, §4 "catalog rows must not retroactively change meaning": `key`
-- is the PK and is referenced by dashboard_widgets.widget_type with the
-- default NO ACTION — Postgres itself already refuses to change a
-- referenced key, so no extra trigger is needed for key immutability.
-- Shrinking min/max/max_series or flipping is_active=false does NOT
-- retroactively touch any EXISTING widget row (the validation triggers
-- below only ever fire on that WIDGET row's own future writes) — proven
-- by PoC rather than asserted; see "Round 2 §4" tests. is_active is
-- checked only on a genuinely NEW widget or a widget_type CHANGE (not on
-- an ordinary resize of an already-existing widget of that type) — see
-- dashboard_widgets_validate_layout below.

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
  -- Round 2, §2: a built-in series has ONE intrinsically correct
  -- aggregation method and ONE intrinsically correct scope level — never a
  -- free per-widget choice (see dashboard_widget_series_validate_aggregation
  -- and _validate_scope_level below).
  default_aggregation_method varchar(20) not null check (default_aggregation_method in ('sum', 'avg', 'max', 'last', 'none')),
  fixed_data_scope_level varchar(20) not null check (fixed_data_scope_level in ('day', 'session', 'component')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into training_load.dashboard_builtin_series (key, label, unit, value_type, default_aggregation_method, fixed_data_scope_level) values
  ('rpe', 'RPE', null, 'numeric', 'avg', 'session'),
  ('srpe', 'sRPE', 'AU', 'numeric', 'sum', 'session'),
  ('duration_minutes', 'Duration', 'min', 'numeric', 'sum', 'session'),
  -- Round 2, §8: added so the "Athlete overview" system template (report
  -- §7) is actually materializable, as required — both are query-adapter
  -- rollups over training.activity_participants / canonical activity
  -- results, never over metric_values or session_feedback.
  ('session_count', 'Sessions', null, 'numeric', 'sum', 'day'),
  ('last_session_date', 'Last session', null, 'text', 'last', 'day');

-- Round 2, §4: unit/value_type/aggregation/scope-level semantics become
-- immutable the moment ANY series references this built-in — silently
-- changing what "srpe" MEANS would reinterpret every widget already
-- plotting it.
create function training_load.protect_builtin_series_semantics_once_used() returns trigger as $$
declare
  in_use boolean;
begin
  if new.unit is not distinct from old.unit
     and new.value_type is not distinct from old.value_type
     and new.default_aggregation_method is not distinct from old.default_aggregation_method
     and new.fixed_data_scope_level is not distinct from old.fixed_data_scope_level then
    return new;
  end if;
  select exists (select 1 from training_load.dashboard_widget_series where built_in_series_key = old.key) into in_use;
  if in_use then
    raise exception 'dashboard_builtin_series (key=%): already referenced by a widget — unit/value_type/aggregation/scope semantics are immutable', old.key;
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
  check (owner_scope <> 'team' or (data_workspace_type = 'team' and data_workspace_scope_id = owner_team_id))
);

create index dashboards_owner_idx on training_load.dashboards (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index dashboards_owner_status_idx on training_load.dashboards (owner_scope, status);
create index dashboards_template_idx on training_load.dashboards (owner_scope, is_template) where is_template = true;
create index dashboards_data_workspace_idx on training_load.dashboards (data_workspace_type, data_workspace_scope_id);

-- Round 2, §1: owner_scope AND the new data-workspace binding are now
-- BOTH governed by this one "protect once used" trigger — a dashboard's
-- data workspace is exactly as security-sensitive as its owner_scope
-- (silently rebinding a private dashboard from Club A's data to Club B's
-- data after the fact is precisely the cross-workspace leak this whole
-- round exists to close), so it gets the identical write-once-after-use
-- protection, never a separate, weaker rule.
create function training_load.protect_dashboard_ownership_once_used() returns trigger as $$
declare
  in_use boolean;
begin
  if new.owner_scope is not distinct from old.owner_scope
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.owner_club_id is not distinct from old.owner_club_id
     and new.owner_team_id is not distinct from old.owner_team_id
     and new.data_workspace_type is not distinct from old.data_workspace_type
     and new.data_workspace_scope_id is not distinct from old.data_workspace_scope_id then
    return new;
  end if;
  select
       exists (select 1 from training_load.dashboard_widgets where dashboard_id = old.id)
    or exists (select 1 from training_load.dashboard_active_selection where dashboard_id = old.id)
    or exists (select 1 from training_load.dashboards where cloned_from_dashboard_id = old.id)
    into in_use;
  if in_use then
    raise exception 'training_load.dashboards (id=%): already in use — owner_scope and data_workspace are immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_protect_ownership
  before update on training_load.dashboards
  for each row execute function training_load.protect_dashboard_ownership_once_used();

-- Round 2, §4: is_template may not flip true->false while any of this
-- dashboard's widgets still carries an UNRESOLVED (hints-only) series —
-- that combination (is_template=false + unresolved series) is exactly
-- what dashboard_widget_series_validate_resolution below already forbids
-- at INSERT time; this closes the same gap from the PARENT side (flip the
-- flag instead of touching the series row).
create function training_load.dashboards_guard_template_flip() returns trigger as $$
declare
  v_unresolved boolean;
begin
  if new.is_template is not distinct from old.is_template or new.is_template = true then
    return new;
  end if;
  select exists (
    select 1 from training_load.dashboard_widget_series s
    join training_load.dashboard_widgets w on w.id = s.widget_id
    where w.dashboard_id = old.id and s.metric_definition_id is null and s.built_in_series_key is null
  ) into v_unresolved;
  if v_unresolved then
    raise exception 'training_load.dashboards (id=%): cannot flip is_template to false while unresolved (hints-only) series still exist', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_guard_template_flip
  before update of is_template on training_load.dashboards
  for each row execute function training_load.dashboards_guard_template_flip();

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
  group_by varchar(20) not null default 'day' check (group_by in ('day', 'session', 'component', 'athlete', 'team')),
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

-- Per-type min/max size + is_active. Round 2: is_active is now checked
-- ONLY on insert or an incoming widget_type change — never on a plain
-- resize of an existing widget whose type may since have been
-- deactivated (report §4 "deaktivacija ne sme pokvariti ... dozvoljene
-- izmene postojećeg dashboarda").
create function training_load.dashboard_widgets_validate_layout() returns trigger as $$
declare
  v_min_w smallint; v_max_w smallint; v_min_h smallint; v_max_h smallint; v_active boolean;
  v_check_active boolean;
begin
  select min_width, max_width, min_height, max_height, is_active
    into v_min_w, v_max_w, v_min_h, v_max_h, v_active
    from training_load.dashboard_widget_types where key = new.widget_type;
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

create function training_load.dashboard_widgets_bump_revision() returns trigger as $$
begin
  if new.widget_type is distinct from old.widget_type -- Round 2 §3 fix: was missing
     or new.title is distinct from old.title
     or new.widget_order is distinct from old.widget_order
     or new.x is distinct from old.x or new.y is distinct from old.y
     or new.width is distinct from old.width or new.height is distinct from old.height
     or new.mobile_order is distinct from old.mobile_order
     or new.group_by is distinct from old.group_by
     or new.state is distinct from old.state
     or new.display_config is distinct from old.display_config
     or new.local_filter_override is distinct from old.local_filter_override then
    new.revision := old.revision + 1;
    new.updated_at := now();
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
  template_metric_key_hints jsonb,
  axis varchar(10) not null default 'primary' check (axis in ('primary', 'secondary')),
  color text,
  display_label text,
  source_policy varchar(20) not null default 'all_with_conflicts'
    check (source_policy in ('all_with_conflicts', 'source_connection', 'manual', 'api_import', 'csv_import', 'derived')),
  source_connection_id uuid references training_load.metric_source_connections(id) on delete restrict,
  -- Round 2, §2 — the previously-missing query-affecting semantics, now
  -- real normalized columns instead of an undefined frontend convention:
  data_scope_level varchar(20) not null default 'session' check (data_scope_level in ('day', 'session', 'component')),
  aggregation_method varchar(20) not null default 'sum' check (aggregation_method in ('sum', 'avg', 'max', 'last', 'none')),
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
  -- Round 2, §4: a built-in series (RPE/sRPE/duration/...) has no
  -- Metrics-Core provenance at all — 'source_connection'/'api_import'/
  -- 'csv_import' are meaningless for it (report §4 "built-in RPE ne sme
  -- prihvatiti neprimenljiv source policy"); 'manual' is the only sensible
  -- policy (session_feedback is always a direct athlete/coach entry).
  check (built_in_series_key is null or (source_policy = 'manual' and source_connection_id is null))
);

create index dashboard_widget_series_widget_idx on training_load.dashboard_widget_series (widget_id, series_order);
create index dashboard_widget_series_definition_idx on training_load.dashboard_widget_series (metric_definition_id) where metric_definition_id is not null;

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

create function training_load.dashboard_widget_series_validate_resolution() returns trigger as $$
declare
  v_is_template boolean;
begin
  perform training_load.lock_widget_for_series_write(new.widget_id);
  if new.metric_definition_id is not null or new.built_in_series_key is not null then
    return new;
  end if;
  select d.is_template into v_is_template
    from training_load.dashboard_widgets w join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = new.widget_id;
  if not v_is_template then
    raise exception 'dashboard_widget_series: an unresolved (hints-only) series is only allowed on a TEMPLATE dashboard (widget %)', new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_resolution
  before insert or update of metric_definition_id, built_in_series_key, template_metric_key_hints, widget_id
  on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_resolution();

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
  if new.metric_definition_id is not null then
    select mdv.unit into v_new_unit
      from training_load.metric_definitions md
      join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id
      where md.id = new.metric_definition_id;
  elsif new.built_in_series_key is not null then
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

-- Round 2, §2: aggregation_method must be compatible with the underlying
-- series' own declared method — a widget can never pick 'sum' for a
-- metric the catalog itself says is not meaningfully summable
-- (daily_aggregation_method='none'), and never a stronger claim than the
-- series' own default ('last'-only data queried as 'sum' would silently
-- fabricate a total that was never a real fact). The only choices allowed
-- beyond the series' own declared method are 'none' (raw/ungrouped) and
-- the declared method itself — never a DIFFERENT real aggregation than
-- the one the metric's own semantics support.
create function training_load.dashboard_widget_series_validate_aggregation() returns trigger as $$
declare
  v_declared varchar;
begin
  if new.metric_definition_id is not null then
    select mdv.daily_aggregation_method into v_declared
      from training_load.metric_definitions md
      join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id
      where md.id = new.metric_definition_id;
  elsif new.built_in_series_key is not null then
    select default_aggregation_method into v_declared from training_load.dashboard_builtin_series where key = new.built_in_series_key;
  else
    return new; -- unresolved template hint
  end if;
  if new.aggregation_method <> 'none' and new.aggregation_method <> v_declared then
    raise exception 'dashboard_widget_series: aggregation_method % is not compatible with this series'' own declared method % (widget %)', new.aggregation_method, v_declared, new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_aggregation
  before insert or update of metric_definition_id, built_in_series_key, aggregation_method on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_aggregation();

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
create function training_load.dashboard_widget_series_validate_builtin_scope() returns trigger as $$
declare
  v_fixed varchar;
begin
  if new.built_in_series_key is null then
    return new;
  end if;
  select fixed_data_scope_level into v_fixed from training_load.dashboard_builtin_series where key = new.built_in_series_key;
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
create function training_load.dashboard_widget_series_validate_scope_capability() returns trigger as $$
declare
  v_has_any boolean;
  v_allowed boolean;
begin
  if new.metric_definition_id is null then
    return new;
  end if;
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
  select owner_scope, owner_user_id, owner_club_id, owner_team_id
    into v_def_scope, v_def_user, v_def_club, v_def_team
    from training_load.metric_definitions where id = new.metric_definition_id;

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
  v_data_type varchar; v_data_scope uuid;
  v_conn_scope varchar; v_conn_club uuid; v_conn_team uuid;
begin
  if new.source_connection_id is null then
    return new;
  end if;
  select d.data_workspace_type, d.data_workspace_scope_id into v_data_type, v_data_scope
    from training_load.dashboard_widgets w join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = new.widget_id;
  select owner_scope, owner_club_id, owner_team_id into v_conn_scope, v_conn_club, v_conn_team
    from training_load.metric_source_connections where id = new.source_connection_id;
  if v_conn_scope = 'system' then
    return new;
  end if;
  if v_conn_scope = 'club' and v_data_type = 'club' and v_conn_club = v_data_scope then
    return new;
  end if;
  if v_conn_scope = 'team' and v_data_type = 'team' and v_conn_team = v_data_scope then
    return new;
  end if;
  raise exception 'dashboard_widget_series: source_connection % (owner_scope=%) is not visible to this dashboard''s data workspace %/%', new.source_connection_id, v_conn_scope, v_data_type, v_data_scope;
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
--    A caller MAY still write dashboard_widgets directly for a
--    single-widget change (add one widget, resize just one) — the
--    deferred overlap trigger protects that path too, it just resolves
--    at that statement's own (non-deferred-elsewhere) transaction commit
--    since nothing there calls SET CONSTRAINTS IMMEDIATE itself.
-- ------------------------------------------------------------
create function training_load.replace_dashboard_layout(
  p_dashboard_id uuid,
  p_expected_revision integer,
  p_layout jsonb -- [{"widgetId": "...", "x":0,"y":0,"width":4,"height":2,"mobileOrder":1}, ...]
) returns table (widget_id uuid, x smallint, y smallint, width smallint, height smallint, mobile_order integer, revision integer) as $$
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
  -- (checked above) — but a pure per-widget position/size change does NOT
  -- otherwise bump it (only each WIDGET's own revision does, deliberately,
  -- so two edits to two DIFFERENT widgets never falsely conflict with each
  -- other — report §D5). A whole-layout REPLACE is different: it is
  -- itself the dashboard-wide operation this revision guards, so it must
  -- bump dashboards.revision on every successful call — otherwise two
  -- sequential replace_dashboard_layout calls would keep seeing the exact
  -- same "current" revision and neither would ever detect the other as
  -- stale. Each individual widget's own revision still bumps too, via the
  -- ordinary per-row UPDATE trigger already firing above — this call adds
  -- the missing DASHBOARD-level signal on top, it does not replace it.
  perform training_load.bump_dashboard_revision(p_dashboard_id);

  return query
    select w.id, w.x, w.y, w.width, w.height, w.mobile_order, w.revision
    from training_load.dashboard_widgets w
    where w.dashboard_id = p_dashboard_id and w.id in (select (e ->> 'widgetId')::uuid from jsonb_array_elements(p_layout) e);
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

create function training_load.dashboard_active_selection_validate_visibility() returns trigger as $$
declare
  v_data_type varchar; v_data_scope uuid;
begin
  select data_workspace_type, data_workspace_scope_id into v_data_type, v_data_scope
    from training_load.dashboards where id = new.dashboard_id;
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
