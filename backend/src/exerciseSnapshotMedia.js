import { exerciseReadScopeSql } from "./exerciseAccess.js";
import { exerciseMediaJoinSql } from "./exercisePersonalization.js";

export const effectiveExerciseMediaSql = `select e.id, e.name, e.aim, e.execution_notes, e.instruction,
  coalesce(e.image_url,fallback_media.image_url) as image_url,
  coalesce(e.video_url,fallback_media.video_url) as video_url
  from library.exercises e ${exerciseMediaJoinSql}
  where e.id=$2 and ${exerciseReadScopeSql}`;

export async function completeCopiedExerciseImages(runQuery, items, targetSessionOf) {
  const requested = items.filter((item) => item.image_url === null && item.exercise_id
    && item.item_type === "exercise"
    && (item.image_source || 'legacy') === 'legacy'
    && (item.video_source || 'legacy') === 'legacy').map((item) => ({
    id: item.id, exercise_id: item.exercise_id, video_url: item.video_url,
    target_session_id: targetSessionOf(item),
  }));
  if (!requested.length) return items;
  const isolation = await runQuery("select current_setting('transaction_isolation') as isolation");
  if (isolation.rows[0].isolation !== "read committed") return items;
  const lock = await runQuery("select pg_try_advisory_xact_lock_shared(hashtextextended('exercise_collections', 0)) as allowed");
  if (!lock.rows[0].allowed) return items;
  const actor = "target_plan.created_by_user_id";
  const result = await runQuery(`select requested.id,
      coalesce(e.image_url,fallback_media.image_url) as image_url
    from jsonb_to_recordset($1::jsonb) as requested(id uuid,exercise_id uuid,video_url text,target_session_id uuid)
    join plans.plan_sessions target_session on target_session.id=requested.target_session_id
    join plans.plan_days target_day on target_day.id=target_session.plan_day_id
    join plans.plans target_plan on target_plan.id=target_day.plan_id
    join library.exercises e on e.id=requested.exercise_id
    ${exerciseMediaJoinSql.replaceAll("$1", actor)}
    where ${exerciseReadScopeSql.replaceAll("$1", actor)}
      and nullif(btrim(coalesce(e.image_url,fallback_media.image_url)),'') is not null
      and requested.video_url is not distinct from coalesce(e.video_url,fallback_media.video_url)`,
  [JSON.stringify(requested)]);
  const images = new Map(result.rows.map((row) => [row.id, row.image_url]));
  return items.map((item) => images.has(item.id) ? { ...item, image_url: images.get(item.id) } : item);
}
