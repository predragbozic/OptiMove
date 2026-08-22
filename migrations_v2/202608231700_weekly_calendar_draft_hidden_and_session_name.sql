-- Two fixes reported live, both in plans.v_weekly_plan_items (the Weekly
-- Calendar's read path, backend/src/routes/athletes.js's loadWeeklyData()):
--
-- 1. A weekly plan's draft/active status (plans.plans.status - already set
--    correctly the whole time: POST /plans/:planId/submit ("Save and
--    finish") sets it to 'active', builder-cancel ("Exit") leaves it as
--    'draft') was never actually enforced on read - this view showed a
--    weekly plan's content regardless of status, so a coach hitting Exit
--    mid-build looked IDENTICAL on the Calendar (to both the coach AND the
--    athlete - same endpoint serves both) to one they'd actually finished.
--    Now filtered to status = 'active', matching how Program/Template
--    drafts already stay invisible until finished.
--
--    Every existing weekly plan in this database is backfilled to 'active'
--    first (112 plans, ALL still 'draft' at the time of this migration -
--    "Save and finish" existed but never had any visible effect for weekly
--    plans, so nothing ever exercised the distinction) so this filter does
--    not make any already-visible plan disappear. Only plans created AFTER
--    this migration are subject to the new gate.
--
-- 2. plans.plan_sessions.name (added in
--    migrations_v2/202608231600_plan_sessions_add_name.sql) was never
--    selected by this view, so the Calendar could never show it no matter
--    what a coach set in the Builder - not a rendering bug, the value never
--    reached the frontend at all. Added as session_name.
--
-- Both statements are byte-for-byte identical (past this migration) to the
-- corresponding view definitions in create_plan_read_views.sql, same
-- convention as 202608231000_weekly_plan_items_hierarchy_order.sql.

update plans.plans
set status = 'active', updated_at = now()
where plan_type = 'weekly' and status = 'draft';

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
  nsp.sort_path as hierarchy_sort_path,
  ps.name as session_name
from plans.plans p
join public.athletes a on a.id = p.athlete_id
join plans.plan_days pd on pd.plan_id = p.id
join plans.plan_sessions ps on ps.plan_day_id = pd.id
join plans.plan_items pi on pi.plan_session_id = ps.id
left join library.exercises e on e.id = pi.exercise_id
left join plans.v_plan_item_node_ancestry na on na.plan_node_id = pi.plan_node_id
left join plans.v_plan_node_sort_path nsp on nsp.plan_node_id = pi.plan_node_id
where p.plan_type = 'weekly'
  and p.status = 'active'
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
  nsp.sort_path as hierarchy_sort_path,
  ps.name as session_name
from plans.plan_nodes pn
join plans.v_plan_node_ancestry_detail nad on nad.plan_node_id = pn.id
join plans.plan_sessions ps on ps.id = pn.plan_session_id
join plans.plan_days pd on pd.id = ps.plan_day_id
join plans.plans p on p.id = pd.plan_id
join public.athletes a on a.id = p.athlete_id
left join plans.v_plan_node_sort_path nsp on nsp.plan_node_id = pn.id
where p.plan_type = 'weekly'
  and p.status = 'active'
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
