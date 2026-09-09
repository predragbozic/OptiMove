-- ============================================================
-- OPTIMOVE — Training Load 3B1: Analysis Dashboard model (DESIGN / PoC
-- ONLY — not a real migrations_v2 file, not applied to any real database).
--
-- Purely additive over the REAL, already-deployed schema (migrations_v2
-- through 202609080900_training_load_v14, plus 202609071*_training_activity
-- v1-v4). This file assumes that real schema already exists in whatever
-- disposable database it is applied to (see test-harness.mjs, which applies
-- the real migrations_v2 files first, then this file on top). No existing
-- table, column, trigger, or function from those real migrations is
-- altered, renamed, or dropped anywhere below.
--
-- Everything here lives in the training_load schema (already exists) —
-- this is a Training Load feature, not a new domain. Naming/ownership
-- conventions below deliberately copy the EXACT pattern already proven in
-- migrations_v2/202609041400_training_load_v10_metrics_catalog.sql
-- (metric_definitions/metric_domains/metric_categories/metric_structure_
-- links): a stable identity table with owner_scope/owner_user_id/
-- owner_club_id/owner_team_id + the same 4-way CHECK, a small extensible
-- catalog table instead of a hardcoded enum wherever the set of values is
-- expected to grow, and the same "protect ownership once used" trigger
-- shape reused for dashboards.
--
-- See DASHBOARD_MODEL_REPORT.md for the full rationale behind every
-- decision below — this file's comments are deliberately terser, pointing
-- back at that report's numbered sections rather than re-arguing each
-- choice inline.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Widget type catalog — a new widget type is an INSERT (AC/CH, radar,
--    scatter, heatmap, ML result — Section 6/report), never a migration.
--    min/max size and max_series live HERE (per type), not hardcoded into
--    a CHECK on dashboard_widgets itself, so adding a type never touches
--    that table's own constraints. Report §D3/§D7.
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
  -- The hard cap on how many series one widget of this type may carry —
  -- report §D7 / PoC item 14 ("KPI ne prihvata više serija nego što
  -- dozvoljava"). NULL = no type-specific cap (still bounded by the
  -- dashboard-wide DASHBOARD_MAX_WIDGET_SERIES_HARD_CAP check below).
  max_series smallint check (max_series is null or max_series >= 1),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (min_width <= max_width),
  check (min_height <= max_height),
  check (default_width between min_width and max_width),
  check (default_height between min_height and max_height)
);

insert into training_load.dashboard_widget_types
  (key, label, min_width, max_width, min_height, max_height, default_width, default_height, max_series) values
  ('kpi',        'KPI',        2, 4,  2, 3,  3, 2, 1),
  ('table',      'Table',      3, 12, 3, 12, 6, 4, 12),
  ('line_chart', 'Line chart', 3, 12, 3, 8,  6, 4, 8),
  ('bar_chart',  'Bar chart',  3, 12, 3, 8,  6, 4, 8);

-- ------------------------------------------------------------
-- 2. Built-in series catalog — the STABLE, non-Metrics-Core series a
--    widget can plot: rpe / srpe / duration_minutes today, read by a query
--    adapter directly from training_load.session_feedback (never copied
--    into metric_values — report §A "RPE/sRPE options", Decision B).
--    A NEW built-in series (report §D12 mentions none planned, but the
--    mechanism itself is extensible) is an INSERT here + a new case in the
--    query adapter — never a schema change to dashboard_widget_series.
-- ------------------------------------------------------------
create table training_load.dashboard_builtin_series (
  key text primary key,
  label text not null,
  unit text,
  value_type varchar(20) not null check (value_type in ('numeric', 'boolean', 'text')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into training_load.dashboard_builtin_series (key, label, unit, value_type) values
  ('rpe', 'RPE', null, 'numeric'),
  ('srpe', 'sRPE', 'AU', 'numeric'),
  ('duration_minutes', 'Duration', 'min', 'numeric');

-- ------------------------------------------------------------
-- 3. Dashboards. Same owner_scope shape as metric_definitions (report §B1:
--    shared template and personal dashboard are the SAME table/object,
--    distinguished by owner_scope, exactly like metric_definitions already
--    does for system/club/team/user metrics — never a separate table).
-- ------------------------------------------------------------
create table training_load.dashboards (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  -- A template is something OTHER viewers in its owner_scope may clone
  -- (report §B2). Independent of owner_scope itself: a club may have both
  -- a shared club TEMPLATE and a shared club dashboard nobody is meant to
  -- fork from. A 'user'-scope dashboard may also be is_template=true (a
  -- coach forking their own private layout as a personal starting point).
  is_template boolean not null default false,
  status varchar(20) not null default 'active' check (status in ('active', 'archived')),
  -- Provenance only — never re-clonable transitively in a way that hides
  -- the ORIGINAL system/club/team template; always points at the template
  -- this dashboard was cloned FROM, one hop, not a chain resolver (unlike
  -- training.activities' alias chain, a dashboard clone is a one-time,
  -- one-directional fork, not an identity merge — there is nothing to
  -- "resolve canonical" here). ON DELETE RESTRICT (not SET NULL) is
  -- deliberate — report §B1/§D2, PoC item 20: a template with a live
  -- clone must be ARCHIVED, never hard-deleted; silently nulling the
  -- clone's provenance out from under it on delete would let that
  -- protection be bypassed by simply deleting the template.
  cloned_from_dashboard_id uuid references training_load.dashboards(id) on delete restrict,
  -- Saved default runtime filter (period/activityId/componentId/athleteIds/
  -- teamId) — JSONB deliberately: applying it is a client-side "seed the
  -- runtime filter" convenience, never joined/validated at the DB level: a
  -- stale athleteId here (an athlete since removed) is a harmless no-op on
  -- next apply, not a correctness bug (report §D4/§D9 JSONB-vs-normalized
  -- split — Section 5's "runtime filter never rewrites the saved config"
  -- rule lives at the application layer: writing this column is only ever
  -- triggered by an explicit "Save as default" action, never by a plain
  -- filter change).
  default_filter jsonb,
  -- Optimistic concurrency (report §D5 / PoC item 11). Bumped by
  -- dashboards_bump_revision below on any real content change — the
  -- caller sends back the revision it last read; a stale value means 0
  -- rows updated, a controlled conflict, never a silent overwrite.
  revision integer not null default 1,
  created_by_user_id uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create index dashboards_owner_idx on training_load.dashboards (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index dashboards_owner_status_idx on training_load.dashboards (owner_scope, status);
create index dashboards_template_idx on training_load.dashboards (owner_scope, is_template) where is_template = true;

-- Same "protect ownership once used" shape as metric_source_connections /
-- metric_import_batches (v11) — a dashboard's owner_scope becomes
-- immutable the moment ANY widget, active-selection, or clone exists under
-- it; re-scoping it afterward would silently reassign already-visible
-- content to a different audience.
create function training_load.protect_dashboard_ownership_once_used() returns trigger as $$
declare
  in_use boolean;
begin
  if new.owner_scope is not distinct from old.owner_scope
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.owner_club_id is not distinct from old.owner_club_id
     and new.owner_team_id is not distinct from old.owner_team_id then
    return new;
  end if;
  select
       exists (select 1 from training_load.dashboard_widgets where dashboard_id = old.id)
    or exists (select 1 from training_load.dashboard_active_selection where dashboard_id = old.id)
    or exists (select 1 from training_load.dashboards where cloned_from_dashboard_id = old.id)
    into in_use;
  if in_use then
    raise exception 'training_load.dashboards (id=%): already in use — owner_scope is immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboards_protect_ownership
  before update on training_load.dashboards
  for each row execute function training_load.protect_dashboard_ownership_once_used();

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

-- ------------------------------------------------------------
-- 4. Widgets. Layout (x/y/width/height, mobile_order) lives directly on
--    the widget row — report §D3: every widget always needs exactly one
--    desktop position/size and at most one mobile order; there is no case
--    today where a widget needs zero or multiple layouts per breakpoint,
--    so a separate layout/breakpoint table would be pure ceremony. Tablet
--    is a responsive reduction of the SAME 12-column desktop grid, decided
--    at render time — not a third stored breakpoint (see report §D3 for
--    why a real second breakpoint table is deferred, not built now).
-- ------------------------------------------------------------
create table training_load.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references training_load.dashboards(id) on delete cascade,
  widget_type text not null references training_load.dashboard_widget_types(key),
  title text not null check (char_length(title) between 1 and 200),
  widget_order integer not null,
  -- 12-column desktop grid (report §D3). x/width bounds enforced below;
  -- per-type min/max enforced by dashboard_widgets_validate_layout (needs
  -- a join to dashboard_widget_types, which a plain CHECK cannot do).
  x smallint not null check (x >= 0 and x <= 11),
  y smallint not null check (y >= 0),
  width smallint not null check (width >= 1 and width <= 12),
  height smallint not null check (height >= 1),
  check (x + width <= 12),
  -- Mobile single-column stacking order (report §7 mobile spec) —
  -- independent of widget_order (which is the desktop "logical"/tab order
  -- used as a tiebreaker and for screen-reader traversal); a coach may
  -- want a KPI to show first on mobile even if it sits bottom-right on
  -- desktop.
  mobile_order integer not null,
  group_by varchar(20) not null default 'day' check (group_by in ('day', 'session', 'component', 'athlete', 'team')),
  -- Runtime display state — 'collapsed' hides the widget's body (config
  -- and layout slot preserved) without deleting it; not a soft-delete
  -- (removing a widget from a dashboard is a plain DELETE — a widget has
  -- no independent history worth preserving once removed, unlike a whole
  -- dashboard — see report §B1/§D2 for why dashboards themselves archive
  -- instead of delete but widgets do not need to).
  state varchar(20) not null default 'active' check (state in ('active', 'collapsed')),
  -- Cosmetic/display-only config that legitimately differs per widget TYPE
  -- (KPI comparison-period toggle + icon; Table page size + default sort;
  -- chart line/bar style) — report §D4: never FK-bearing, never queried
  -- against, so JSONB here is the correct call, not a shortcut.
  display_config jsonb not null default '{}'::jsonb,
  -- NULL = inherit the dashboard's global runtime filter unchanged
  -- (report §4/§D8). Non-null = this widget's own explicit override for
  -- whichever of period/activityId/componentId/athleteIds/teamId it
  -- chooses to set; any key it omits still inherits from the global
  -- filter. Same JSONB-is-fine reasoning as dashboards.default_filter.
  local_filter_override jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Deferrable: a batch reorder (swap widget_order 3<->5) or a batch
  -- mobile-restack legitimately passes through a transient duplicate
  -- mid-transaction — only the FINAL, post-transaction shape must be
  -- unique. Same deferred-uniqueness idiom already used elsewhere in this
  -- codebase for exactly this reason (e.g. plan_days_plan_date_unique-style
  -- reorder flows).
  constraint dashboard_widgets_order_unique unique (dashboard_id, widget_order) deferrable initially deferred,
  constraint dashboard_widgets_mobile_order_unique unique (dashboard_id, mobile_order) deferrable initially deferred
);

create index dashboard_widgets_dashboard_idx on training_load.dashboard_widgets (dashboard_id, widget_order);
create index dashboard_widgets_mobile_idx on training_load.dashboard_widgets (dashboard_id, mobile_order);

-- Per-type min/max size (report §D3 / PoC item 13 "widget type i config
-- validation"). A plain CHECK cannot join dashboard_widget_types, so this
-- is a trigger — fires on insert and on any size-affecting update.
create function training_load.dashboard_widgets_validate_layout() returns trigger as $$
declare
  v_min_w smallint; v_max_w smallint; v_min_h smallint; v_max_h smallint; v_active boolean;
begin
  select min_width, max_width, min_height, max_height, is_active
    into v_min_w, v_max_w, v_min_h, v_max_h, v_active
    from training_load.dashboard_widget_types where key = new.widget_type;
  if not found then
    raise exception 'dashboard_widgets: unknown widget_type %', new.widget_type;
  end if;
  if not v_active then
    raise exception 'dashboard_widgets: widget_type % is not active — cannot add a new widget of this type', new.widget_type;
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

-- Deterministic overlap rejection (report §D3 / PoC item 10) — no two
-- widgets on the SAME dashboard may occupy overlapping (x,y,width,height)
-- rectangles. Deliberately REJECT, not auto-resolve: auto-arranging a
-- collision is an order-dependent, stateful operation better done as an
-- application-layer service that computes a candidate free position and
-- retries — the DB's job is to make an actual overlap structurally
-- impossible, not to silently guess a fix. Locks the dashboard's widget
-- rows FOR UPDATE first so two concurrent inserts proposing overlapping
-- rectangles serialize instead of both reading a stale "no overlap" view
-- (same race-closing shape as lock_and_validate_event_connection, v12).
create function training_load.dashboard_widgets_reject_overlap() returns trigger as $$
declare
  v_conflict uuid;
begin
  -- Lock the DASHBOARD row itself, not its widget rows — a brand-new
  -- dashboard's very FIRST widget has no sibling row to lock, so locking
  -- widgets alone would let two concurrent "first widget" inserts on the
  -- SAME new dashboard both pass this check before either commits. Every
  -- widget write against one dashboard now serializes through this one
  -- lock, matching this codebase's own established "lock the parent
  -- before validating a set-wide invariant among its children" shape
  -- (e.g. lock_and_validate_event_connection, v12).
  perform 1 from training_load.dashboards where id = new.dashboard_id for update;
  select id into v_conflict
    from training_load.dashboard_widgets
    where dashboard_id = new.dashboard_id
      and id <> new.id
      and x < new.x + new.width and new.x < x + width
      and y < new.y + new.height and new.y < y + height
    limit 1;
  if v_conflict is not null then
    raise exception 'dashboard_widgets: layout (x=%,y=%,w=%,h=%) overlaps existing widget % on dashboard %', new.x, new.y, new.width, new.height, v_conflict, new.dashboard_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_reject_overlap
  before insert or update of x, y, width, height on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_reject_overlap();

create function training_load.dashboard_widgets_bump_revision() returns trigger as $$
begin
  if new.title is distinct from old.title
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

-- ------------------------------------------------------------
-- 5. Widget series — the normalized metric/series reference (report §C:
--    never a bare UUID buried in JSON). Exactly one of
--    metric_definition_id / built_in_series_key is set for a RESOLVED
--    series (a real, live dashboard); a TEMPLATE dashboard's widget may
--    instead carry only template_metric_key_hints, resolved into a real
--    FK (or dropped) at clone time — see
--    dashboard_widget_series_validate_resolution below (report §D12 /
--    Section 7 "template must safely degrade").
-- ------------------------------------------------------------
create table training_load.dashboard_widget_series (
  id uuid primary key default gen_random_uuid(),
  widget_id uuid not null references training_load.dashboard_widgets(id) on delete cascade,
  series_order integer not null,
  metric_definition_id uuid references training_load.metric_definitions(id) on delete restrict,
  built_in_series_key text references training_load.dashboard_builtin_series(key) on delete restrict,
  -- Ordered candidate keys (e.g. ["distance_total_m","distance_m"]) tried
  -- in order when a TEMPLATE is cloned into a real workspace — a soft,
  -- advisory hint, deliberately NOT an FK (the keys may not resolve to
  -- anything in a given workspace's own catalog at all — that is exactly
  -- the "safe degradation" case). Ignored/irrelevant once
  -- metric_definition_id or built_in_series_key is actually set.
  template_metric_key_hints jsonb,
  axis varchar(10) not null default 'primary' check (axis in ('primary', 'secondary')),
  color text,
  display_label text,
  -- Report §5 "source policy options" — per-series, not per-widget, so a
  -- Table with several metric columns can show a different policy per
  -- column.
  source_policy varchar(20) not null default 'all_with_conflicts'
    check (source_policy in ('all_with_conflicts', 'source_connection', 'manual', 'api_import', 'csv_import', 'derived')),
  source_connection_id uuid references training_load.metric_source_connections(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint dashboard_widget_series_order_unique unique (widget_id, series_order) deferrable initially deferred,
  check (source_connection_id is null or source_policy = 'source_connection'),
  check (source_policy <> 'source_connection' or source_connection_id is not null),
  -- A resolved series (metric_definition_id or built_in_series_key set)
  -- never carries BOTH; a series with neither must carry hints (the
  -- template-only, unresolved case — further gated by the trigger below,
  -- which additionally requires the OWNING dashboard to actually be a
  -- template).
  check (
    (metric_definition_id is not null and built_in_series_key is null) or
    (metric_definition_id is null and built_in_series_key is not null) or
    (metric_definition_id is null and built_in_series_key is null and template_metric_key_hints is not null)
  )
);

create index dashboard_widget_series_widget_idx on training_load.dashboard_widget_series (widget_id, series_order);
create index dashboard_widget_series_definition_idx on training_load.dashboard_widget_series (metric_definition_id) where metric_definition_id is not null;

-- An UNRESOLVED series (hints-only, no metric_definition_id/
-- built_in_series_key) is only legal on a widget whose OWNING dashboard is
-- itself is_template=true — a live, cloned dashboard's series must always
-- be fully resolved (or simply not exist — the clone operation drops a
-- series it could not resolve, it never leaves a dangling hint-only row on
-- a real dashboard). Report §D12.
create function training_load.dashboard_widget_series_validate_resolution() returns trigger as $$
declare
  v_is_template boolean;
begin
  if new.metric_definition_id is not null or new.built_in_series_key is not null then
    return new; -- resolved — always legal, on any dashboard
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

-- Series-count-per-widget cap (report §D7 / PoC item 14). Counts ALL
-- series rows for the widget (resolved or template-hint) against that
-- widget's TYPE's own max_series — a widget_type with max_series IS NULL
-- (no type-specific cap declared) falls back to the dashboard-wide hard
-- ceiling, so no widget type can ever accept an unbounded number of
-- series even if someone forgets to configure one.
create function training_load.dashboard_widget_series_enforce_cap() returns trigger as $$
declare
  v_widget_type text;
  v_max_series smallint;
  v_count integer;
begin
  select w.widget_type, t.max_series into v_widget_type, v_max_series
    from training_load.dashboard_widgets w join training_load.dashboard_widget_types t on t.key = w.widget_type
    where w.id = new.widget_id;
  if v_max_series is null then
    v_max_series := 20; -- dashboard-wide hard ceiling, report §D7
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

-- Axis-unit compatibility (report §5 "ne spajati različite jedinice" /
-- PoC item 15). Every series sharing the SAME (widget_id, axis) must
-- resolve to the SAME unit. A metric_definition's unit comes from its
-- CURRENT version (metric_definitions.current_version_id ->
-- metric_definition_versions.unit); a built-in series' unit comes from
-- dashboard_builtin_series.unit. An unresolved (template-hint-only) series
-- has no unit yet and is exempt — checked again at clone/resolve time,
-- once it actually has one.
--
-- Scoped to CHART widget types only (line_chart/bar_chart) — a KPI or
-- Table has no shared visual axis at all (each is its own independent
-- number/column); RPE (unitless 0-10) and sRPE (AU) legitimately sit side
-- by side as two Table columns or two KPI tiles on the very same widget
-- (report §A / PoC item 17) without ever being "on the same axis" in any
-- meaningful sense — only a line/bar chart's actual rendered Y-axis has
-- the real ambiguity this check protects against.
create function training_load.dashboard_widget_series_validate_axis_unit() returns trigger as $$
declare
  v_widget_type text;
  v_new_unit text;
  v_existing_unit text;
  v_conflict_id uuid;
begin
  select widget_type into v_widget_type from training_load.dashboard_widgets where id = new.widget_id;
  if v_widget_type not in ('line_chart', 'bar_chart') then
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
    return new; -- unresolved template hint — nothing to check yet
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

-- Metric-definition VISIBILITY scope-breadth (report §C / PoC items 6+8:
-- "metric FK pripada vidljivoj definiciji" / "tuđa private definicija ne
-- može se ubaciti UUID-jem"). A STRICTER variant of the existing
-- metric_structure_links pattern (training_load.link_scope_within_target,
-- v10) — that function trusts a 'user'-scope link to reference ANY target
-- (its own comment: "the authoritative leak protection is the READ-time
-- application query"). This trigger does NOT extend that same trust to a
-- 'user'-scope DASHBOARD, because THIS task explicitly requires the DB
-- layer itself to prove a private dashboard cannot reference another
-- user's private metric — so the 'user' case here is real, not
-- delegated: a private dashboard's widget may only reference a 'system'
-- metric, or its OWN owner's 'user'-scope metric. A club/team/system
-- dashboard's widget may reference 'system', or a metric owned by that
-- EXACT club/team. Real club/team MEMBERSHIP-based visibility beyond
-- exact-scope-match (e.g. "any metric visible to any club I belong to")
-- is intentionally left to the application layer, same as everywhere else
-- in this codebase (isAthleteInWorkspaceScope) — see report's own "what
-- still needs application authorization" section.
create function training_load.dashboard_widget_series_validate_metric_visibility() returns trigger as $$
declare
  v_dash_scope varchar; v_dash_user uuid; v_dash_club uuid; v_dash_team uuid;
  v_def_scope varchar; v_def_user uuid; v_def_club uuid; v_def_team uuid;
begin
  if new.metric_definition_id is null then
    return new;
  end if;
  select d.owner_scope, d.owner_user_id, d.owner_club_id, d.owner_team_id
    into v_dash_scope, v_dash_user, v_dash_club, v_dash_team
    from training_load.dashboard_widgets w join training_load.dashboards d on d.id = w.dashboard_id
    where w.id = new.widget_id;
  select owner_scope, owner_user_id, owner_club_id, owner_team_id
    into v_def_scope, v_def_user, v_def_club, v_def_team
    from training_load.metric_definitions where id = new.metric_definition_id;

  if v_def_scope = 'system' then
    return new; -- always visible
  end if;
  if v_dash_scope = 'user' then
    if v_def_scope = 'user' and v_def_user = v_dash_user then
      return new;
    end if;
    raise exception 'dashboard_widget_series: a private dashboard (owner %) may not reference metric_definition % (owner_scope=%, not system and not owned by the same user)', v_dash_user, new.metric_definition_id, v_def_scope;
  end if;
  if v_dash_scope = 'club' and v_def_scope = 'club' and v_def_club = v_dash_club then
    return new;
  end if;
  if v_dash_scope = 'team' and v_def_scope = 'team' and v_def_team = v_dash_team then
    return new;
  end if;
  if v_dash_scope = 'system' then
    -- a system dashboard may only reference system metrics (already
    -- returned above) — a system template must never bind to one club's
    -- private catalog.
    raise exception 'dashboard_widget_series: a system dashboard may not reference non-system metric_definition % (owner_scope=%)', new.metric_definition_id, v_def_scope;
  end if;
  raise exception 'dashboard_widget_series: metric_definition % (owner_scope=%/%/%/%) is not visible to dashboard owner_scope=%/%/%/%',
    new.metric_definition_id, v_def_scope, v_def_club, v_def_team, v_def_user, v_dash_scope, v_dash_club, v_dash_team, v_dash_user;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_metric_visibility
  before insert or update of metric_definition_id, widget_id on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_metric_visibility();

-- ------------------------------------------------------------
-- 6. Active dashboard selection — same non-authoritative preference shape
--    as public.user_workspace_preferences (report §D10): a per-(user,
--    workspace-instance) pointer, never itself consulted for
--    authorization, always re-validated by the visibility trigger below.
--    Deliberately its OWN small table (not a column on dashboards or on
--    user_workspace_preferences) — a user needs a DIFFERENT remembered
--    active dashboard PER workspace they switch into, unlike the single
--    active WORKSPACE itself.
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

-- The selected dashboard must actually be visible FROM that workspace
-- instance — same "own metric, or system, or exact club/team match" shape
-- as the series-visibility trigger above, generalized to a workspace
-- context rather than a fixed dashboard-vs-dashboard comparison. A
-- private ('user'-scope) dashboard is selectable as the active view
-- regardless of which workspace the coach is currently acting in (a
-- personal layout choice is not workspace-bound) — report §D10.
create function training_load.dashboard_active_selection_validate_visibility() returns trigger as $$
declare
  v_scope varchar; v_user uuid; v_club uuid; v_team uuid;
begin
  select owner_scope, owner_user_id, owner_club_id, owner_team_id
    into v_scope, v_user, v_club, v_team
    from training_load.dashboards where id = new.dashboard_id;
  if v_scope = 'system' then return new; end if;
  if v_scope = 'user' and v_user = new.user_id then return new; end if;
  if v_scope = 'club' and new.workspace_type = 'club' and v_club = new.scope_id then return new; end if;
  if v_scope = 'team' and new.workspace_type = 'team' and v_team = new.scope_id then return new; end if;
  raise exception 'dashboard_active_selection: dashboard % (owner_scope=%) is not visible from workspace %/% for user %', new.dashboard_id, v_scope, new.workspace_type, new.scope_id, new.user_id;
end;
$$ language plpgsql;

create trigger dashboard_active_selection_validate_visibility
  before insert or update of dashboard_id, workspace_type, scope_id, user_id on training_load.dashboard_active_selection
  for each row execute function training_load.dashboard_active_selection_validate_visibility();

-- Unlike a trigger BODY (only resolved when it fires), CREATE TRIGGER
-- itself needs the function to already exist (it looks up the function's
-- OID/return type immediately) — so this one, unusually among this file's
-- functions, must be declared BEFORE the trigger that uses it.
create function training_load.dashboard_active_selection_touch() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger dashboard_active_selection_touch_updated_at
  before update on training_load.dashboard_active_selection
  for each row execute function training_load.dashboard_active_selection_touch();
