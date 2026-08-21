create or replace view plans.v_plan_summary as
select
  p.id as plan_id,
  p.plan_type,
  p.is_template,
  p.name as plan_name,
  p.status,
  p.source_type,
  p.source_external_id,
  p.week_start,
  case
    when p.week_start is not null then p.week_start + interval '6 days'
    else null
  end::date as week_end,
  p.start_date,
  case
    when p.start_date is not null and p.duration_days is not null
      then p.start_date + (p.duration_days - 1) * interval '1 day'
    else null
  end::date as valid_until,
  p.duration_days,
  p.program_order,
  a.id as athlete_uuid,
  a.athlete_id,
  a.source_external_id as athlete_source_external_id,
  a.full_name as athlete_name,
  a.image_url as athlete_image_url,
  count(distinct pd.id) as block_or_day_count,
  count(distinct ps.id) as session_count,
  count(pi.id) as item_count,
  count(pi.exercise_id) as matched_exercise_count,
  count(pi.id) - count(pi.exercise_id) as item_without_exercise_id_count,
  p.library_scope,
  p.library_category,
  p.cover_image_url,
  p.is_free,
  p.price_cents,
  p.available_until,
  p.owner_type,
  p.visibility,
  p.access_model,
  p.access_duration_days,
  p.subscription_period,
  p.can_copy,
  p.can_edit_copy,
  p.can_assign_to_athlete,
  p.athlete_can_view_directly,
  p.requires_approval
from plans.plans p
left join public.athletes a on a.id = p.athlete_id
left join plans.plan_days pd on pd.plan_id = p.id
left join plans.plan_sessions ps on ps.plan_day_id = pd.id
left join plans.plan_items pi on pi.plan_session_id = ps.id
where coalesce(p.is_active, true)
  and not coalesce(p.is_edit_draft, false)
group by
  p.id,
  a.id;

-- Walks each plan_item's plan_node_id up the plan_nodes tree (section -> category ->
-- domain) so readers can group/identify domain/category/section by their real node id
-- instead of by the denormalized text name. Two different nodes that happen to share a
-- name (e.g. two sections both called "Warming up") must never visually merge.
create or replace view plans.v_plan_item_node_ancestry as
with recursive node_chain as (
  select id, parent_id, node_type, id as leaf_id
  from plans.plan_nodes
  union all
  select pn.id, pn.parent_id, pn.node_type, nc.leaf_id
  from plans.plan_nodes pn
  join node_chain nc on pn.id = nc.parent_id
)
select
  leaf_id as plan_node_id,
  max(case when node_type = 'domain' then id::text end)::uuid as domain_node_id,
  max(case when node_type = 'category' then id::text end)::uuid as category_node_id,
  max(case when node_type = 'section' then id::text end)::uuid as section_node_id
from node_chain
group by leaf_id;

-- Same ancestor walk as v_plan_item_node_ancestry above, but also carries
-- each ancestor level's OWN name/color/icon_url/short_note/note/node_order
-- (straight from plans.plan_nodes) and the node's own plan_session_id. Used
-- exclusively to represent an EMPTY domain/category/section (a leaf node -
-- no plan_items and no child plan_nodes anywhere under it) in
-- v_weekly_plan_items below: such a node has no plan_item row to snapshot
-- domain/category/section text from, so its display name/color/etc must
-- come directly from plan_nodes instead. Populated items keep using their
-- own plan_items snapshot columns unchanged - this view is never consulted
-- for those.
create or replace view plans.v_plan_node_ancestry_detail as
with recursive node_chain as (
  select id, parent_id, node_type, name, color, icon_url, short_note, note, node_order, plan_session_id, id as leaf_id
  from plans.plan_nodes
  union all
  select pn.id, pn.parent_id, pn.node_type, pn.name, pn.color, pn.icon_url, pn.short_note, pn.note, pn.node_order, pn.plan_session_id, nc.leaf_id
  from plans.plan_nodes pn
  join node_chain nc on pn.id = nc.parent_id
)
select
  leaf_id as plan_node_id,
  (array_agg(plan_session_id))[1] as plan_session_id,
  max(case when node_type = 'domain' then id::text end)::uuid as domain_node_id,
  max(case when node_type = 'domain' then name end)::character varying(255) as domain_name,
  -- plans.plan_nodes.color is declared varchar(32), but plans.plan_items.
  -- domain_color/category_color/section_color are varchar(40) - a
  -- pre-existing width mismatch between the two tables. Cast to (40), not
  -- (32), so this view's UNION branch below resolves to the SAME output
  -- type the item-driven branch already produces (from pi.domain_color
  -- etc) - CREATE OR REPLACE VIEW rejects a definition that would narrow an
  -- existing view column's type, and the values themselves already fit
  -- within 32 characters either way, so widening the cast to 40 is safe.
  max(case when node_type = 'domain' then color end)::character varying(40) as domain_color,
  max(case when node_type = 'domain' then icon_url end) as domain_icon_url,
  max(case when node_type = 'domain' then short_note end) as domain_short_note,
  max(case when node_type = 'domain' then note end) as domain_note,
  max(case when node_type = 'domain' then node_order end) as domain_order,
  max(case when node_type = 'category' then id::text end)::uuid as category_node_id,
  max(case when node_type = 'category' then name end)::character varying(255) as category_name,
  max(case when node_type = 'category' then color end)::character varying(40) as category_color,
  max(case when node_type = 'category' then icon_url end) as category_icon_url,
  max(case when node_type = 'category' then short_note end) as category_short_note,
  max(case when node_type = 'category' then note end) as category_note,
  max(case when node_type = 'category' then node_order end) as category_order,
  max(case when node_type = 'section' then id::text end)::uuid as section_node_id,
  max(case when node_type = 'section' then name end)::character varying(255) as section_name,
  max(case when node_type = 'section' then color end)::character varying(40) as section_color,
  max(case when node_type = 'section' then icon_url end) as section_icon_url,
  max(case when node_type = 'section' then short_note end) as section_short_note,
  max(case when node_type = 'section' then note end) as section_note,
  max(case when node_type = 'section' then node_order end) as section_order
from node_chain
group by leaf_id;

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

create or replace view plans.v_program_plan_items as
select
  p.id as plan_id,
  p.name as plan_name,
  p.plan_type,
  p.is_template,
  p.program_order,
  p.start_date,
  p.duration_days,
  case
    when p.start_date is not null and p.duration_days is not null
      then p.start_date + (p.duration_days - 1) * interval '1 day'
    else null
  end::date as valid_until,
  p.source_type,
  p.source_external_id,
  a.id as athlete_uuid,
  a.athlete_id,
  a.source_external_id as athlete_source_external_id,
  a.full_name as athlete_name,
  a.image_url as athlete_image_url,
  pd.id as plan_block_id,
  pd.block_index,
  pd.block_name,
  pd.block_type,
  pd.block_order,
  pd.day_note,
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
  na.section_node_id
from plans.plans p
left join public.athletes a on a.id = p.athlete_id
join plans.plan_days pd on pd.plan_id = p.id
join plans.plan_sessions ps on ps.plan_day_id = pd.id
join plans.plan_items pi on pi.plan_session_id = ps.id
left join library.exercises e on e.id = pi.exercise_id
left join plans.v_plan_item_node_ancestry na on na.plan_node_id = pi.plan_node_id
where p.plan_type = 'program'
  and coalesce(p.is_active, true)
  and not coalesce(p.is_edit_draft, false)
order by
  p.is_template,
  coalesce(a.source_external_id, p.source_external_id),
  p.program_order,
  p.name,
  pd.block_index,
  ps.session_order,
  pi.item_order;
