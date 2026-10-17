import { queryWithoutJit } from "./db.js";
import { exerciseCollectionAccessSql } from "./exerciseAccess.js";

export async function loadLockedExercisePreviews(userId, search, collection, limit, offset = 0) {
  if (collection === "other") return { exercises: [], hasMore: false };
  const result = await queryWithoutJit(`select e.id,e.name,case when c.block_preview='locked' then c.name end as "blockName" from library.exercises e
    join library.exercise_collection_items ci on ci.exercise_id=e.id
    join library.exercise_collections c on c.id=ci.collection_id
    where e.owner_scope='system' and e.is_active=true and c.exercise_preview='locked' and c.deleted_at is null
      and not ${exerciseCollectionAccessSql} and e.name ilike $2 and ($3::uuid is null or c.id=$3)
      and not exists (select 1 from library.filter_hidden hidden where hidden.kind='exercise' and hidden.item_id=e.id and hidden.user_id=$1)
    order by e.name,e.id limit $4 offset $5`, [userId,`%${search}%`,collection || null,limit + 1,offset]);
  return { exercises: result.rows.slice(0,limit), hasMore: result.rows.length > limit };
}
