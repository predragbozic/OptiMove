-- Fixes Weekly showing exercises in the wrong order relative to Builder
-- (reported live: a section moved above another in Builder still showed
-- below it in Weekly - e.g. "Compressive pants" before "Ice bath" even
-- though Builder correctly showed Ice bath's section first).
--
-- Root cause: plans.v_weekly_plan_items's final ORDER BY sorted only by
-- item_order (a session-wide, insertion-sequence counter on plans.plan_items
-- - see nextOrder() in backend/src/routes/builder.js, which computes it
-- scoped by plan_session_id, NOT by plan_node_id). Moving a section only
-- updates plans.plan_nodes.node_order (the live tree Builder's own read
-- path, buildDraft(), already correctly orders by); it never touches the
-- domain_order/category_order/section_order snapshot columns already
-- sitting on plan_items rows added before the move, and item_order itself
-- was never scoped to reflect section position in the first place - so
-- Weekly's flat item_order sort could put an item from a later section
-- ahead of an item from an earlier one whenever they weren't added to the
-- session in hierarchy order.
--
-- Fix: a new small helper view, plans.v_plan_node_sort_path, computes each
-- node's LIVE root-to-leaf position as a numeric[] (node_order is scoped
-- per-parent, so comparing these arrays element-by-element reproduces
-- Builder's own tree order exactly, including a section sitting directly
-- under a session with no domain/category above it - any depth, not a fixed
-- 3-level domain/category/section assumption). v_weekly_plan_items now joins
-- this and orders by it ahead of item_order (which remains the correct
-- tie-breaker for items sharing one section - their hierarchy_sort_path is
-- identical). plan_item_id/plan_node_id are a final deterministic
-- tie-breaker so PostgreSQL never has an undefined choice for two exactly
-- equal (or NULL) order values.
--
-- This is the migrations_v2 counterpart of the create_plan_read_views.sql
-- change already applied there for future fresh-bootstrap purposes - the
-- Strategy B runner (backend/src/migrate.js) no longer replays legacy SQL
-- files like create_plan_read_views.sql against an already-cutover
-- database, so the view change has to ship through here to actually reach
-- OPTIMOVE. Both statements below are byte-for-byte identical to the
-- corresponding view definitions in create_plan_read_views.sql.
--
-- CREATE OR REPLACE VIEW is idempotent: re-running this migration (or
-- re-running the whole runner) redefines the same views to the same
-- definitions and changes nothing. This migration does not touch
-- migrations_v2/202608211200_weekly_plan_items_empty_structures.sql (already
-- applied) - it only adds a further CREATE OR REPLACE on top.

-- Every node's LIVE hierarchical position, as an array of node_order values
-- walked from the root down to that node (domain -> category -> section, or
-- any shorter chain - a section can be a root node directly under the
-- session). node_order is scoped per-parent (see nextOrder() in
-- backend/src/routes/builder.js), so comparing these arrays element-by-
-- element (PostgreSQL's native array comparison is lexicographic)
-- reproduces the exact same order Builder's own read path already gets by
-- walking the live tree - not the denormalized domain_order/category_order/
-- section_order snapshot columns on plan_items, which go stale the moment a
-- node is moved (reordering only updates plan_nodes.node_order - it never
-- touches the snapshot columns on items that already existed under moved
-- siblings).
create or replace view plans.v_plan_node_sort_path as
with recursive node_chain as (
  select id, array[coalesce(node_order, 0)]::numeric[] as sort_path
  from plans.plan_nodes
  where parent_id is null
  union all
  select pn.id, nc.sort_path || coalesce(pn.node_order, 0)
  from plans.plan_nodes pn
  join node_chain nc on pn.parent_id = nc.id
)
select id as plan_node_id, sort_path
from node_chain;

create or replace view plans.v_weekly_plan_items as
select
  p.id as plan_id,
  p.name as plan_name,
  p.week_start,
  (p.week_start + interval '6 days')::date as week_end,
  a.id as athlete_uuid,
  a.athlete_id,
  a.source_external_id as athlete_source_external_id,
  a.full_name as athlete_name,
  a.image_url as athlete_image_url,
  pd.id as plan_day_id,
  pd.date,
  pd.day_note,
  pd.day_order,
  ps.id as plan_session_id,
  ps.am_pm,
  ps.bta,
  ps.session_order,
  pi.id as plan_item_id,
  pi.item_type,
  pi.item_order,
  pi.domain_order,
  pi.category_order,
  pi.section_order,
  pi.exercise_order,
  pi.domain_name,
  pi.domain_color,
  pi.domain_icon_url,
  pi.domain_short_note,
  pi.domain_note,
  pi.category_name,
  pi.category_color,
  pi.category_icon_url,
  pi.category_short_note,
  pi.category_note,
  pi.section_name,
  pi.section_color,
  pi.section_icon_url,
  pi.section_short_note,
  pi.section_note,
  pi.title,
  pi.description,
  pi.image_url,
  pi.video_url,
  pi.sets,
  pi.reps,
  pi.load,
  e.id as exercise_id,
  e.exercise_code,
  e.name as library_exercise_name,
  pi.source_row_ref,
  ps.session_time,
  pi.plan_node_id,
  na.domain_node_id,
  na.category_node_id,
  na.section_node_id,
  nsp.sort_path as hierarchy_sort_path
from plans.plans p
join public.athletes a on a.id = p.athlete_id
join plans.plan_days pd on pd.plan_id = p.id
join plans.plan_sessions ps on ps.plan_day_id = pd.id
join plans.plan_items pi on pi.plan_session_id = ps.id
left join library.exercises e on e.id = pi.exercise_id
left join plans.v_plan_item_node_ancestry na on na.plan_node_id = pi.plan_node_id
left join plans.v_plan_node_sort_path nsp on nsp.plan_node_id = pi.plan_node_id
where p.plan_type = 'weekly'
  and coalesce(p.is_active, true)
  and not coalesce(p.is_edit_draft, false)

union all

-- Empty domains/categories/sections: a leaf plan_node (no child plan_nodes)
-- with zero plan_items anywhere on it. Represented as one row with
-- item_type set to the node's own node_type ('domain'/'category'/'section')
-- and every exercise-specific column null - frontend/exercise-view.js's
-- isExerciseItem() already treats an item_type of 'domain'/'category'/
-- 'section' as non-exercise, organizational content (see
-- renderOrganizationSummaryHtml), so this needs no frontend change: it is
-- not a fake/empty exercise, it is the row shape the frontend already
-- expects for a structure with no exercises under it. Never emitted for a
-- node that has any child node or any item, however deep, so a populated
-- section's ancestors are represented only via their real item rows, exactly
-- as before.
select
  p.id as plan_id,
  p.name as plan_name,
  p.week_start,
  (p.week_start + interval '6 days')::date as week_end,
  a.id as athlete_uuid,
  a.athlete_id,
  a.source_external_id as athlete_source_external_id,
  a.full_name as athlete_name,
  a.image_url as athlete_image_url,
  pd.id as plan_day_id,
  pd.date,
  pd.day_note,
  pd.day_order,
  ps.id as plan_session_id,
  ps.am_pm,
  ps.bta,
  ps.session_order,
  null::uuid as plan_item_id,
  pn.node_type::character varying(30) as item_type,
  null::numeric as item_order,
  nad.domain_order,
  nad.category_order,
  nad.section_order,
  null::numeric as exercise_order,
  nad.domain_name,
  nad.domain_color,
  nad.domain_icon_url,
  nad.domain_short_note,
  nad.domain_note,
  nad.category_name,
  nad.category_color,
  nad.category_icon_url,
  nad.category_short_note,
  nad.category_note,
  nad.section_name,
  nad.section_color,
  nad.section_icon_url,
  nad.section_short_note,
  nad.section_note,
  null::character varying(255) as title,
  null::text as description,
  null::text as image_url,
  null::text as video_url,
  null::character varying(80) as sets,
  null::character varying(80) as reps,
  null::character varying(80) as load,
  null::uuid as exercise_id,
  null::character varying(100) as exercise_code,
  null::character varying(255) as library_exercise_name,
  null::text as source_row_ref,
  ps.session_time,
  pn.id as plan_node_id,
  nad.domain_node_id,
  nad.category_node_id,
  nad.section_node_id,
  nsp.sort_path as hierarchy_sort_path
from plans.plan_nodes pn
join plans.v_plan_node_ancestry_detail nad on nad.plan_node_id = pn.id
join plans.plan_sessions ps on ps.id = pn.plan_session_id
join plans.plan_days pd on pd.id = ps.plan_day_id
join plans.plans p on p.id = pd.plan_id
join public.athletes a on a.id = p.athlete_id
left join plans.v_plan_node_sort_path nsp on nsp.plan_node_id = pn.id
where p.plan_type = 'weekly'
  and coalesce(p.is_active, true)
  and not coalesce(p.is_edit_draft, false)
  and not exists (select 1 from plans.plan_items pi2 where pi2.plan_node_id = pn.id)
  and not exists (select 1 from plans.plan_nodes child where child.parent_id = pn.id)

-- hierarchy_sort_path clusters every row (populated item or empty-node
-- placeholder) by its LIVE position in the domain/category/section tree,
-- matching Builder's own read order exactly (backend/src/routes/builder.js's
-- buildDraft() orders by the same live plan_nodes.node_order, not the
-- denormalized snapshot columns above). item_order remains the tie-breaker
-- for items sharing one section (their hierarchy_sort_path is identical -
-- it's per plan_node_id, not per item). plan_item_id/plan_node_id are a
-- final deterministic tie-breaker so two exactly-equal item_order values (or
-- two NULLs) can never produce PostgreSQL's undefined tie order.
order by
  athlete_source_external_id,
  week_start,
  date,
  day_order,
  session_order,
  hierarchy_sort_path,
  item_order,
  plan_item_id,
  plan_node_id;
