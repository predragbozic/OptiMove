export async function sqlLegacyPlanComponents(client, normalized) {
  const result = await client.query(`
with items as (
  select value, ord
  from jsonb_array_elements(coalesce($1::jsonb->'items', '[]'::jsonb)) with ordinality as t(value, ord)
),
canonical_items as (
  select jsonb_build_object(
    'date', value->'date',
    'day_note', value->'day_note',
    'session_order', value->'session_order',
    'am_pm', value->'am_pm',
    'bta', value->'bta',
    'node_type', value->'node_type',
    'node_name', value->'node_name',
    'node_order', value->'node_order',
    'item_type', value->'item_type',
    'title', value->'title',
    'description', value->'description',
    'short_note', value->'short_note',
    'note', value->'note',
    'image_url', value->'image_url',
    'video_url', value->'video_url',
    'sets', value->'sets',
    'reps', value->'reps',
    'load', value->'load',
    'item_order', value->'item_order',
    'exercise_order', value->'exercise_order',
    'source_row_ref', value->'source_row_ref',
    'domain_name', value->'domain_name',
    'category_name', value->'category_name',
    'section_name', value->'section_name',
    'domain_color', value->'domain_color',
    'category_color', value->'category_color',
    'section_color', value->'section_color',
    'domain_icon_url', value->'domain_icon_url',
    'category_icon_url', value->'category_icon_url',
    'section_icon_url', value->'section_icon_url',
    'domain_short_note', value->'domain_short_note',
    'category_short_note', value->'category_short_note',
    'section_short_note', value->'section_short_note',
    'domain_note', value->'domain_note',
    'category_note', value->'category_note',
    'section_note', value->'section_note',
    'domain_order', value->'domain_order',
    'category_order', value->'category_order',
    'section_order', value->'section_order',
    'exercise_key_type', value->'exercise_key_type',
    'exercise_key', value->'exercise_key'
  ) as item, ord
  from items
),
canonical_payload as (
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'days', coalesce($1::jsonb#>'{counts,days}', '0'::jsonb),
      'sessions', coalesce($1::jsonb#>'{counts,sessions}', '0'::jsonb),
      'sections', coalesce($1::jsonb#>'{counts,sections}', '0'::jsonb),
      'exerciseItems', coalesce($1::jsonb#>'{counts,exerciseItems}', '0'::jsonb),
      'noteItems', coalesce($1::jsonb#>'{counts,noteItems}', '0'::jsonb),
      'totalItems', coalesce($1::jsonb#>'{counts,totalItems}', '0'::jsonb)
    ),
    'items', coalesce((select jsonb_agg(item order by ord) from canonical_items), '[]'::jsonb)
  ) as payload
),
component_payloads as (
  select
    coalesce((select jsonb_agg(jsonb_build_array(value->>'date', value->>'session_order', value->>'node_order', value->>'item_order', value->>'source_row_ref') order by ord) from items), '[]'::jsonb) as order_source_rows,
    coalesce((select jsonb_agg(jsonb_build_array(value->>'exercise_key_type', value->>'exercise_key') order by ord) from items), '[]'::jsonb) as exercise_keys,
    coalesce((select jsonb_agg(jsonb_build_array(value->>'sets', value->>'reps', value->>'load') order by ord) from items), '[]'::jsonb) as dose,
    coalesce((select jsonb_agg(jsonb_build_array(value->>'title', value->>'description', value->>'short_note', value->>'note') order by ord) from items), '[]'::jsonb) as text_notes,
    coalesce((select jsonb_agg(jsonb_build_array(value->>'domain_name', value->>'category_name', value->>'section_name', value->>'domain_order', value->>'category_order', value->>'section_order') order by ord) from items), '[]'::jsonb) as sections,
    coalesce((select jsonb_agg(jsonb_build_array(value->>'image_url', value->>'video_url') order by ord) from items), '[]'::jsonb) as media
)
select jsonb_build_object(
  'full', encode(digest(canonical_payload.payload::text, 'sha256'), 'hex'),
  'order_source_rows', encode(digest(order_source_rows::text, 'sha256'), 'hex'),
  'exercise_keys', encode(digest(exercise_keys::text, 'sha256'), 'hex'),
  'dose', encode(digest(dose::text, 'sha256'), 'hex'),
  'text_notes', encode(digest(text_notes::text, 'sha256'), 'hex'),
  'sections', encode(digest(sections::text, 'sha256'), 'hex'),
  'media', encode(digest(media::text, 'sha256'), 'hex')
) as components
from component_payloads, canonical_payload;
`, [JSON.stringify(normalized)]);
  return result.rows[0].components;
}

export async function sqlLegacyPlanChecksum(client, normalized) {
  return (await sqlLegacyPlanComponents(client, normalized)).full;
}
