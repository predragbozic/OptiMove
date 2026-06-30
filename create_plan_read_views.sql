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
  count(pi.id) - count(pi.exercise_id) as item_without_exercise_id_count
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
  pi.source_row_ref
from plans.plans p
join public.athletes a on a.id = p.athlete_id
join plans.plan_days pd on pd.plan_id = p.id
join plans.plan_sessions ps on ps.plan_day_id = pd.id
join plans.plan_items pi on pi.plan_session_id = ps.id
left join library.exercises e on e.id = pi.exercise_id
where p.plan_type = 'weekly'
  and coalesce(p.is_active, true)
  and not coalesce(p.is_edit_draft, false)
order by
  a.source_external_id,
  p.week_start,
  pd.date,
  pd.day_order,
  ps.session_order,
  pi.item_order;

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
  pi.source_row_ref
from plans.plans p
left join public.athletes a on a.id = p.athlete_id
join plans.plan_days pd on pd.plan_id = p.id
join plans.plan_sessions ps on ps.plan_day_id = pd.id
join plans.plan_items pi on pi.plan_session_id = ps.id
left join library.exercises e on e.id = pi.exercise_id
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
