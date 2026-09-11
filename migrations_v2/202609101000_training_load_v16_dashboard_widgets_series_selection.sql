-- ============================================================
-- OPTIMOVE — Training Load 3B2: Analysis Dashboard v16 — widgets, series,
-- active dashboard selection, and every integrity/revision trigger for
-- all three. Migration 2 of 4 — depends on training_load.dashboards,
-- dashboard_widget_types, dashboard_builtin_series (v15), and the real,
-- already-deployed training_load.metric_definitions/metric_definition_
-- versions/metric_definition_scope_capabilities/metric_source_connections
-- (v10-v13). The sanctioned write functions that are the ONLY permitted
-- way to mutate these tables from application code are migration 3 (v17).
-- ============================================================

-- ------------------------------------------------------------
-- Widgets. Layout lives directly on the widget row.
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
  -- 'cohort' (not 'team') deliberately never represents a real team_id —
  -- it only ever means "merge together whichever athletes this query's
  -- own athleteIds filter currently selects," a query-time SELECTION, not
  -- a team identity. A genuine "one bucket per real team" grouping (which
  -- would need to join athletes to their own team membership, not just
  -- merge the caller's selection) is a different, not-yet-implemented
  -- feature, deliberately not offered here.
  group_by varchar(20) not null default 'day' check (group_by in ('day', 'week', 'session', 'component', 'athlete', 'cohort')),
  state varchar(20) not null default 'active' check (state in ('active', 'collapsed')),
  display_config jsonb not null default '{"schemaVersion": 1}'::jsonb,
  local_filter_override jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_widgets_order_unique unique (dashboard_id, widget_order) deferrable initially deferred,
  constraint dashboard_widgets_mobile_order_unique unique (dashboard_id, mobile_order) deferrable initially deferred,
  -- display_config must at least carry a schema version — the exact
  -- shape per widget_type is an application-layer validator, not
  -- enforced field-by-field here, but a missing/malformed version key is
  -- refused outright so an unversioned blob can never silently exist.
  check (display_config ? 'schemaVersion' and jsonb_typeof(display_config -> 'schemaVersion') = 'number')
);

create index dashboard_widgets_dashboard_idx on training_load.dashboard_widgets (dashboard_id, widget_order);
create index dashboard_widgets_mobile_idx on training_load.dashboard_widgets (dashboard_id, mobile_order);

-- The missing half of the dashboard-revision contract — the WIDGET SET
-- changing (one added or removed) is a structural change to the parent
-- dashboard just as much as renaming it.
create function training_load.dashboard_widgets_bump_parent_dashboard_revision() returns trigger as $$
begin
  perform training_load.bump_dashboard_revision(coalesce(new.dashboard_id, old.dashboard_id));
  return coalesce(new, old);
end;
$$ language plpgsql;

create trigger dashboard_widgets_bump_parent_on_insert
  after insert on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_bump_parent_dashboard_revision();
create trigger dashboard_widgets_bump_parent_on_delete
  after delete on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_bump_parent_dashboard_revision();

-- dashboard_id is immutable after insert — a raw UPDATE moving a widget
-- to a different dashboard would bypass every dashboard-scoped invariant
-- this file builds (metric/source visibility checked against the OLD
-- dashboard's data workspace, the overlap/cap/axis checks run against the
-- NEW dashboard's sibling widgets without ever having validated against
-- it, both dashboards' revisions left stale). Moving a widget to another
-- dashboard must be a real delete-then-recreate, never an UPDATE of this
-- column.
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

-- Per-type min/max size + is_active. is_active is checked ONLY on insert
-- or an incoming widget_type change — never on a plain resize of an
-- existing widget whose type may since have been deactivated. A `FOR
-- SHARE` lock on the referenced widget_types row closes the "first widget
-- of a type vs. a concurrent semantic change to that type" race: an
-- UPDATE against dashboard_widget_types already holds Postgres's own
-- implicit exclusive lock on the row it targets for the trigger's whole
-- duration, so a FOR SHARE lock taken here genuinely blocks until that
-- concurrent UPDATE commits (or rolls back), at which point this
-- trigger's own bounds-check reads the real, final, post-update
-- semantics — never a stale mid-flight read.
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

-- When widget_type actually CHANGES (e.g. Table -> KPI), re-validate
-- every invariant that depends on the type — series cap and (for a chart
-- type) axis-unit compatibility — against the widget's EXISTING series.
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

-- Lock order for this whole subsystem is DASHBOARD -> WIDGET -> SERIES,
-- applied consistently everywhere. This trigger is step 1 for any layout
-- write: lock the DASHBOARD row (a brand-new dashboard's very first
-- widget has no sibling widget row to lock, so locking widgets alone
-- would let two concurrent "first widget" inserts both pass). It does
-- NOT itself check for overlap — that is the DEFERRED constraint trigger
-- below, so a legitimate atomic swap within one transaction is never
-- rejected mid-flight.
--
-- For an INSERT, this trigger genuinely achieves dashboard-before-widget
-- ordering (no widget row exists yet to compete for). For an UPDATE, it
-- does NOT — Postgres already acquires the target widget row's own lock
-- (to fetch the row for this trigger's OLD/NEW binding) BEFORE any
-- before-row trigger body runs, so by the time this trigger's own `for
-- update` on dashboards executes, the widget row is already locked — the
-- reverse order. This trigger is kept for the INSERT case (where it IS
-- correct) and as a defense-in-depth backstop for the UPDATE case — but
-- training_load.update_widget_layout() and replace_dashboard_layout()
-- (v17) are the only two entry points that actually PROVE dashboard-first
-- ordering for a layout UPDATE (each takes its own explicit dashboard
-- lock BEFORE issuing any dashboard_widgets statement).
create function training_load.dashboard_widgets_lock_dashboard_before_layout_write() returns trigger as $$
begin
  perform 1 from training_load.dashboards where id = new.dashboard_id for update;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_lock_dashboard_before_layout_write
  before insert or update of x, y, width, height on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_lock_dashboard_before_layout_write();

-- The real overlap check, a DEFERRABLE INITIALLY DEFERRED constraint
-- trigger — checked once at the end of the transaction (or explicitly
-- earlier via `SET CONSTRAINTS ... IMMEDIATE`, see v17's replace_
-- dashboard_layout()), not per individual row write. This is what makes
-- "A moves to B's old spot, B moves to A's old spot, in the same
-- transaction" succeed — the transiently-overlapping intermediate state
-- between the two individual UPDATEs is never checked, only the FINAL
-- state is. The BEFORE trigger above already serializes every layout
-- writer through the dashboard-row lock, so by the time this deferred
-- check runs, no concurrent writer for the SAME dashboard can still be in
-- flight — what it sees IS the real final state, not a moving target.
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

-- Layout fields (x/y/width/height/mobile_order) bump BOTH this widget's
-- own revision AND the parent dashboard's revision — dashboard.revision
-- is the cache token for the WHOLE rendered layout, not just widget SET
-- membership, so a position/size change genuinely invalidates that cache
-- too. Content fields (widget_type/title/group_by/state/display_config/
-- local_filter_override) bump ONLY this widget's own revision — the
-- dashboard's cached LAYOUT did not change, only this widget's content.
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
  -- Deadlock-safety note: calling bump_dashboard_revision from THIS
  -- before-row trigger does NOT, by itself, achieve dashboard-before-
  -- widget lock ordering for a raw ad-hoc UPDATE — Postgres already
  -- acquires THIS row's own lock before any before-row trigger body
  -- runs, so by the time this trigger tries to lock the dashboard, the
  -- WIDGET row is already locked — the reverse of dashboard-then-widget.
  -- This is still functionally correct (dashboard.revision DOES end up
  -- bumped) but is NOT proven deadlock-safe against a concurrent
  -- replace_dashboard_layout()/update_widget_layout() call, which lock
  -- dashboard-then-widget. Kept anyway as defense-in-depth correctness
  -- for any writer that bypasses the two sanctioned functions (v17) — the
  -- application layer must never rely on this trigger alone for a
  -- concurrent layout write.
  if v_layout_changed then
    perform training_load.bump_dashboard_revision(new.dashboard_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widgets_bump_revision
  before update on training_load.dashboard_widgets
  for each row execute function training_load.dashboard_widgets_bump_revision();

-- Reused by the series-change triggers below — a series add/update/
-- delete/reorder is a query/render-relevant change to its PARENT WIDGET,
-- so the widget's own revision (not just some series-level counter) must
-- bump, exactly like a direct widget field edit does.
create function training_load.bump_widget_revision(p_widget_id uuid) returns void as $$
begin
  update training_load.dashboard_widgets set revision = revision + 1, updated_at = now() where id = p_widget_id;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- Widget series — the normalized metric/series reference.
-- ------------------------------------------------------------
create table training_load.dashboard_widget_series (
  id uuid primary key default gen_random_uuid(),
  widget_id uuid not null references training_load.dashboard_widgets(id) on delete cascade,
  series_order integer not null,
  metric_definition_id uuid references training_load.metric_definitions(id) on delete restrict,
  built_in_series_key text references training_load.dashboard_builtin_series(key) on delete restrict,
  -- template_metric_key_hints is a validated JSON ARRAY OF OBJECTS (see
  -- validate_template_metric_key_hints_shape below) — a bare string
  -- element is refused outright. Each object carries at least
  -- {"key": "..."}, plus optional "valueType"/"unit"/"scopeLevel"
  -- narrowing hints — an explicit `"unit": null` ("must have NO unit") is
  -- distinguished from unit simply being absent ("unit not a criterion").
  template_metric_key_hints jsonb,
  -- An unresolved/ambiguous template series is preserved, never silently
  -- dropped on clone — it carries a real status: 'resolved' (metric_
  -- definition_id or built_in_series_key is set, normal series),
  -- 'unresolved' (zero visible candidates matched any hint), 'ambiguous'
  -- (2+ equally-valid candidates matched — never auto-picked). See the
  -- CHECK below tying this to which of metric_definition_id/
  -- built_in_series_key may be set. Cloning PRESERVES unresolved/
  -- ambiguous state onto the new, real (non-template) dashboard
  -- specifically so it stays fixable ("Choose a metric") — a real
  -- dashboard holding an unresolved series is a safe, intentional state:
  -- the query engine refuses to ever query a non-'resolved' series, so it
  -- carries no data-visibility risk, only a "needs attention" UI state.
  resolution_status varchar(20) not null default 'resolved' check (resolution_status in ('resolved', 'unresolved', 'ambiguous')),
  -- For an 'ambiguous' series, the real candidate metric_definition_ids
  -- found at the last resolution attempt — so the UI can render "pick one
  -- of these" without re-querying visibility itself. NULL for
  -- 'resolved'/'unresolved'. Shape-validated below (a real array of >=2
  -- DISTINCT valid UUIDs whenever resolution_status='ambiguous', never a
  -- bare string/scalar/empty/duplicate list).
  --
  -- JSONB, not a normalized child table: these candidates are a
  -- point-in-time SNAPSHOT of one resolution attempt, never independently
  -- queried, filtered, joined, or paginated — the UI always reads the
  -- WHOLE list at once and the sanctioned resolve_series_binding()
  -- function (v17) always REPLACES the whole list atomically. Critically,
  -- this snapshot is NEVER trusted as the live authorization source — the
  -- metric this column eventually binds to is re-validated live, against
  -- the metric's CURRENT visibility, by the SAME dashboard_widget_series_
  -- validate_metric_visibility trigger every other metric_definition_id
  -- write already goes through — this column is UI convenience data,
  -- never an authorization record.
  template_resolution_candidates jsonb,
  axis varchar(10) not null default 'primary' check (axis in ('primary', 'secondary')),
  color text,
  display_label text,
  -- 'not_applicable' is legal ONLY for a built-in series (RPE/sRPE/
  -- duration/... has no Metrics-Core provenance concept at all — never
  -- fairly described as 'manual', which implies "a human chose to enter
  -- this instead of importing it", a real distinction Metrics Core values
  -- make that session_feedback does not); a real Metrics-Core-backed
  -- series (metric_definition_id set) must NOT use 'not_applicable'.
  source_policy varchar(20) not null default 'all_with_conflicts'
    check (source_policy in ('all_with_conflicts', 'source_connection', 'manual', 'api_import', 'csv_import', 'derived', 'not_applicable')),
  source_connection_id uuid references training_load.metric_source_connections(id) on delete restrict,
  data_scope_level varchar(20) not null default 'session' check (data_scope_level in ('day', 'session', 'component')),
  -- STAGE 2 ("dashboard analytical aggregation" — how the widget reduces
  -- values ACROSS activities/days/weeks/athletes) — freely choosable,
  -- deliberately NOT constrained to equal metric_definitions.daily_
  -- aggregation_method (that is STAGE 1, a fixed fact about the metric
  -- itself, always applied by the query engine when it needs to collapse
  -- same-day raw facts into one daily value on the way to whatever this
  -- column asks for). The SAME metric can back one widget showing a
  -- weekly sum, another a per-training average, another a per-training
  -- max, and another showing every individual activity with no
  -- aggregation at all.
  analytical_aggregation varchar(20) not null default 'sum' check (analytical_aggregation in ('sum', 'avg', 'max', 'last', 'none')),
  -- Named policies matching metric_values.aggregation_role/coverage's own
  -- real value sets rather than inventing a parallel vocabulary.
  aggregation_role_policy varchar(30) not null default 'standalone_and_source_rollup'
    check (aggregation_role_policy in ('standalone_only', 'standalone_and_source_rollup', 'all_including_derived')),
  coverage_policy varchar(20) not null default 'complete_and_partial'
    check (coverage_policy in ('complete_only', 'complete_and_partial', 'any')),
  -- NULL = no comparison. Only meaningful (and only insertable/settable)
  -- on a widget_type with supports_comparison_period=true (KPI today) —
  -- comparison period is not cosmetic, it changes the query.
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
  -- resolution_status must agree with which reference columns are
  -- actually set — 'resolved' requires a real reference (one of the two
  -- FKs); 'unresolved'/'ambiguous' require NEITHER FK to be set and MUST
  -- still carry the original hints so a later retry has something to
  -- re-resolve against.
  check (
    (resolution_status = 'resolved' and (metric_definition_id is not null or built_in_series_key is not null)) or
    (resolution_status in ('unresolved', 'ambiguous') and metric_definition_id is null and built_in_series_key is null and template_metric_key_hints is not null)
  ),
  -- Candidates are only ever meaningful for 'ambiguous', both directions
  -- enforced: 'ambiguous' REQUIRES a real candidates value (a genuinely
  -- empty/absent list is not "ambiguous", it is "unresolved"); the actual
  -- ARRAY SHAPE (>=2 distinct valid UUIDs) is enforced by the
  -- validate_template_resolution_candidates_shape trigger below.
  check (
    (resolution_status = 'ambiguous' and template_resolution_candidates is not null) or
    (resolution_status <> 'ambiguous' and template_resolution_candidates is null)
  ),
  check (built_in_series_key is null or (source_policy = 'not_applicable' and source_connection_id is null)),
  check (metric_definition_id is null or source_policy <> 'not_applicable')
);

create index dashboard_widget_series_widget_idx on training_load.dashboard_widget_series (widget_id, series_order);
create index dashboard_widget_series_definition_idx on training_load.dashboard_widget_series (metric_definition_id) where metric_definition_id is not null;

-- widget_id is immutable after insert — a raw UPDATE moving a series to a
-- different widget would bypass the series cap, axis-unit compatibility,
-- and metric/source visibility checks for the NEW widget and leave both
-- widgets' revisions stale. Moving a series to another widget must be
-- delete-then-recreate.
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

-- Lock order step 2 — every series-row trigger below that validates a
-- WIDGET-wide invariant (series cap, axis-unit) locks the WIDGET row
-- FIRST, before reading sibling series rows. Two concurrent INSERTs
-- against the SAME widget serialize through this lock, closing the "both
-- read the same stale count/unit set" race.
create function training_load.lock_widget_for_series_write(p_widget_id uuid) returns void as $$
begin
  perform 1 from training_load.dashboard_widgets where id = p_widget_id for update;
end;
$$ language plpgsql;

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
  -- This trigger's read of the referenced metric_definition's/built-in's
  -- own unit must not depend on ANOTHER trigger having already locked it
  -- — every trigger that reads catalog/definition state here takes its
  -- OWN `FOR SHARE` lock as its first statement, independent of any other
  -- trigger's alphabetical firing order.
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

-- comparison_period is only valid on a widget_type that declares
-- supports_comparison_period — it changes the QUERY (two period ranges
-- fetched instead of one), so an incompatible setting is refused outright.
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

-- A built-in series' scope level is fixed by the catalog (RPE/sRPE/
-- duration are always session-level facts; session_count/last_session_
-- date are always day-level rollups) — never a per-widget choice.
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

-- Soft check: if a metric_definition already has ANY scope_capability
-- rows configured (training_load.metric_definition_scope_capabilities), a
-- series referencing it must pick a data_scope_level that is actually
-- among them — a component-scope widget series for a metric that has
-- only ever been configured/observed at session scope is very likely a
-- config mistake. A definition with ZERO capability rows (nothing
-- configured yet) is NOT blocked. Takes its OWN `FOR SHARE` lock on the
-- parent metric_definitions row as its first statement — documents the
-- discipline any Metrics Core code adding/removing a scope_capability row
-- must itself follow (lock the PARENT metric_definitions row first) for
-- the "capability removal vs add_series" race to be closed end-to-end;
-- backend/src/trainingLoadMetricsCatalog.js's setDefinitionScopeCapabilities()
-- and archiveDefinition() already do this (both take FOR UPDATE on
-- metric_definitions as their own first statement).
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

-- Metric-definition visibility: checks the dashboard's DATA WORKSPACE
-- (data_workspace_type/data_workspace_scope_id), never owner_scope
-- directly. A private ('user'-owned) dashboard bound to Club A's data
-- workspace may reference: 'system' metrics, Club A's own club metrics,
-- or the SAME coach's own private metrics — but never Club B's, and never
-- another coach's private metrics.
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
  -- FOR SHARE closes "series insert vs. a concurrent ownership/current_
  -- version change on this metric_definition" — a concurrent UPDATE
  -- (ownership or a legitimate current_version_id bump) holds an implicit
  -- row lock that conflicts with this share lock, so our visibility check
  -- below is guaranteed to run against either the fully-pre-update or
  -- fully-post-update row, never a value caught mid-flight.
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

-- A source_connection_id must be visible to the SAME data workspace,
-- exactly mirroring the metric-visibility rule above — a private
-- Club-A-bound dashboard must not be able to pin a series to Club B's
-- import connection.
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
  select owner_scope, owner_club_id, owner_team_id, owner_user_id
    into v_conn_scope, v_conn_club, v_conn_team, v_conn_user
    from training_load.metric_source_connections where id = new.source_connection_id for share;
  if v_conn_scope = 'system' then
    return new;
  end if;
  -- A private coach's OWN import connection is always visible to their own
  -- dashboards, independent of which data workspace those dashboards are
  -- bound to. Another private coach's connection stays invisible
  -- (v_conn_user must equal the DASHBOARD's own owner_user_id, never
  -- merely compared against v_data_scope).
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

-- A series may only be NEWLY bound (INSERT, or resolve_series_binding()'s
-- own UPDATE of metric_definition_id) to an ACTIVE metric_definition.
-- Deliberately scoped to `insert or update OF metric_definition_id` ONLY,
-- never `state` and never any other column: an existing, already-validly-
-- bound series must NEVER be broken by its metric being archived LATER —
-- archiving is a state change on metric_definitions, not a write to
-- dashboard_widget_series, so it never fires this trigger at all, and the
-- series keeps working and keeps its history. This is a NEW-BINDING gate,
-- not a continuous invariant.
create function training_load.dashboard_widget_series_validate_metric_active_state() returns trigger as $$
declare
  v_state varchar;
begin
  if new.metric_definition_id is null then
    return new;
  end if;
  select state into v_state from training_load.metric_definitions where id = new.metric_definition_id for share;
  if v_state <> 'active' then
    raise exception 'dashboard_widget_series: metric_definition % is not active (state=%) — a series may only be newly bound to an ACTIVE metric (widget %)', new.metric_definition_id, v_state, new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_metric_active_state
  before insert or update of metric_definition_id on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_metric_active_state();

-- The exact analog of the metric active-state gate above, for
-- source_connection_id — merge-readiness corrective round. A series may
-- only be NEWLY bound (INSERT, or a genuine UPDATE of source_connection_id
-- e.g. via update_series()) to an ACTIVE metric_source_connections row.
-- Scoped to `insert or update OF source_connection_id` ONLY, same
-- new-binding-only reasoning as the metric gate: a connection later
-- deactivated must never retroactively break an already-bound series'
-- history. `FOR SHARE` closes the same "bind vs. concurrent deactivate"
-- race the metric gate closes for metric_definitions.
create function training_load.dashboard_widget_series_validate_source_connection_active_state() returns trigger as $$
declare
  v_state varchar;
begin
  if new.source_connection_id is null then
    return new;
  end if;
  select state into v_state from training_load.metric_source_connections where id = new.source_connection_id for share;
  if v_state <> 'active' then
    raise exception 'dashboard_widget_series: source_connection % is not active (state=%) — a series may only be newly bound to an ACTIVE source connection (widget %)', new.source_connection_id, v_state, new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_source_connection_active_state
  before insert or update of source_connection_id on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_source_connection_active_state();

-- A series' analytical_aggregation must stay compatible with the VALUE
-- TYPE of whatever it is actually bound to: value_type 'numeric' supports
-- the full sum/avg/max/last/none set; 'text'/'boolean' support ONLY
-- 'last'/'none' this phase (no boolean any/all/count_true, no text
-- concatenation — explicitly out of scope). Fires on EITHER a (re)binding
-- (metric_definition_id/built_in_series_key) OR a bare analytical_
-- aggregation change with no binding change at all — the second case
-- matters because update_series() (v17) can change analytical_
-- aggregation without touching the binding, and that transition must be
-- refused exactly as surely as binding a fresh text metric under 'sum' in
-- the first place.
create function training_load.dashboard_widget_series_validate_aggregation_type_compat() returns trigger as $$
declare
  v_value_type varchar;
begin
  if new.metric_definition_id is not null then
    perform 1 from training_load.metric_definitions where id = new.metric_definition_id for share;
    select mdv.value_type into v_value_type
      from training_load.metric_definitions md
      join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id
      where md.id = new.metric_definition_id;
  elsif new.built_in_series_key is not null then
    perform 1 from training_load.dashboard_builtin_series where key = new.built_in_series_key for share;
    select value_type into v_value_type from training_load.dashboard_builtin_series where key = new.built_in_series_key;
  else
    return new;
  end if;
  if v_value_type in ('text', 'boolean') and new.analytical_aggregation not in ('last', 'none') then
    raise exception 'dashboard_widget_series: value_type % only supports analytical_aggregation last/none this phase (got %, widget %)', v_value_type, new.analytical_aggregation, new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger dashboard_widget_series_validate_aggregation_type_compat
  before insert or update of metric_definition_id, built_in_series_key, analytical_aggregation
  on training_load.dashboard_widget_series
  for each row execute function training_load.dashboard_widget_series_validate_aggregation_type_compat();

-- A series add/update/delete/reorder is a query/render-relevant change to
-- the PARENT WIDGET — bump ITS revision, not just log the series row's
-- own existence.
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
-- Active dashboard selection — the selected dashboard's OWN data-
-- workspace binding must EXACTLY equal the active_selection row's own
-- workspace_type/scope_id. A private dashboard bound to Club A's data can
-- only ever be selected as active while viewing Club A, never Club B,
-- never any other workspace. A 'system'-owned (always-template) dashboard
-- can never satisfy this equality against any real workspace row, so it
-- can never be selected as active without being cloned first.
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

-- An ARCHIVED dashboard must never become (or remain selectable as) a
-- user's active dashboard for a workspace. This trigger takes the SAME
-- `FOR UPDATE` lock on the dashboard row that archive_dashboard() (v17)
-- takes, BEFORE reading status/workspace — genuinely serializing against
-- a concurrent archive, in the same dashboard-first order every other
-- sanctioned writer uses. Whichever of the two (this INSERT, or an
-- archive) reaches the lock first fully completes (including, for an
-- archive, its own AFTER delete-selection trigger below, which runs
-- within the SAME transaction) before the other is ever unblocked.
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

-- A dashboard that gets archived WHILE it is CURRENTLY someone's active
-- selection must not leave that selection row untouched — a real
-- "valid-looking active dashboard that is actually archived" state.
-- Declared as a TRIGGER on dashboards itself (not only as app-level
-- function logic) so the guarantee holds no matter HOW a dashboard
-- becomes archived — a raw UPDATE, a future admin tool, or the sanctioned
-- archive_dashboard() function (v17) all go through this same AFTER
-- trigger, atomically, in the SAME transaction as the status change.
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
