import { exerciseReadScopeSql } from "./exerciseAccess.js";

export const classificationFields = {
  place: { table: "places", column: "place_id", multiple: false, filter: "place", options: "places" },
  complexity: { table: "complexity_levels", column: "complexity_level_id", multiple: false, filter: "complexity", options: "complexities" },
  startingPosition: { table: "starting_positions", column: "starting_position_id", multiple: false, filter: "startingPosition", options: "startingPositions" },
  attractor: { table: "attractors", column: "attractor_id", multiple: false, filter: "attractor", options: "attractors" },
  purposes: { table: "domains", junction: "exercise_domains", column: "domain_id", multiple: true, filter: "purpose", options: "purposes" },
  qualities: { table: "categories", junction: "exercise_categories", column: "category_id", multiple: true, filter: "quality", options: "qualities" },
  groups: { table: "sections", junction: "exercise_sections", column: "section_id", multiple: true, filter: "group", options: "groups" },
  bodyParts: { table: "body_parts", junction: "exercise_body_parts", column: "body_part_id", multiple: true, filter: "bodyPart", options: "bodyParts" },
  movementPatterns: { table: "movement_patterns", junction: "exercise_movement_patterns", column: "movement_pattern_id", multiple: true, filter: "movementPattern", options: "movementPatterns" },
};

export const classificationJoinSql = `
  left join library.exercise_classifications personal_classification on personal_classification.exercise_id=e.id and personal_classification.user_id=$1
  cross join lateral (select ${Object.entries(classificationFields).map(([key, field]) => {
    const original = field.multiple
      ? `(select coalesce(jsonb_agg(lookup.name order by lookup.name),'[]'::jsonb) from library.${field.junction} link join library.${field.table} lookup on lookup.id=link.${field.column} where link.exercise_id=e.id)`
      : `(select to_jsonb(lookup.name) from library.${field.table} lookup where lookup.id=e.${field.column})`;
    return `coalesce(personal_classification.overrides->'${key}',${original},${field.multiple ? "'[]'::jsonb" : "'\"\"'::jsonb"}) as "${key}"`;
  }).join(",")} ) effective_classification`;

export function validateClassification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (!Object.hasOwn(classificationFields, key)) return false;
    const field = classificationFields[key];
    const names = field.multiple ? entry : [entry];
    return Array.isArray(names) && names.length <= 100 && names.every((name) => typeof name === "string" && name.length <= 200 && name === name.trim());
  });
}

export const exerciseMediaJoinSql = `left join lateral (
  with recursive media_sources as (
    select ancestor.*,array[e.id,ancestor.id] as path,1 as depth
    from library.exercises ancestor where ancestor.id=coalesce(e.source_exercise_id,e.copy_parent_id)
    union all
    select ancestor.*,media_sources.path||ancestor.id,media_sources.depth+1
    from library.exercises ancestor join media_sources on ancestor.id=coalesce(media_sources.source_exercise_id,media_sources.copy_parent_id)
    where not ancestor.id=any(media_sources.path)
  )
  select
    (select source.video_url from media_sources source where source.video_url is not null order by source.depth limit 1) as video_url,
    (select source.image_url from media_sources source where source.image_url is not null order by source.depth limit 1) as image_url
  where not exists (select 1 from media_sources e where not coalesce((${exerciseReadScopeSql}),false))
) fallback_media on true`;
