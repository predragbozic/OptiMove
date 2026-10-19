import { completeCopiedExerciseImages } from "./exerciseSnapshotMedia.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SNAPSHOT_REPAIR_LIMIT = 200;

export function validateRepairIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > SNAPSHOT_REPAIR_LIMIT
    || ids.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`Supply 1-${SNAPSHOT_REPAIR_LIMIT} distinct item UUIDs.`);
  }
}

export async function previewSnapshotImages(client, ids) {
  validateRepairIds(ids);
  const result = await client.query(`select item.*, md5(to_jsonb(item)::text) as before_hash
    from plans.plan_items item where item.id=any($1::uuid[]) order by item.id`, [ids]);
  if (result.rows.length !== ids.length) throw new Error("An approved item is missing.");
  const completed = await completeCopiedExerciseImages(client.query.bind(client), result.rows,
    (item) => item.plan_session_id);
  return completed.filter((item, index) => result.rows[index].image_url === null && item.image_url !== null)
    .map((item) => ({ id: item.id, beforeHash: item.before_hash, imageUrl: item.image_url }));
}

export async function applySnapshotImages(client, entries, { rollback = false } = {}) {
  validateRepairIds(entries.map((entry) => entry.id));
  if (entries.some((entry) => !/^[0-9a-f]{32}$/.test(entry.beforeHash || "")
    || typeof entry.imageUrl !== "string" || !entry.imageUrl.trim()
    || (rollback && !/^[0-9a-f]{32}$/.test(entry.afterHash || "")))) {
    throw new Error("Invalid repair manifest.");
  }
  const ids = entries.map((entry) => entry.id);
  const locked = await client.query(`select item.*, md5(to_jsonb(item)::text) as current_hash
    from plans.plan_items item where item.id=any($1::uuid[]) order by item.id for update`, [ids]);
  const rows = new Map(locked.rows.map((row) => [row.id, row]));
  const preview = rollback ? [] : await previewSnapshotImages(client, ids);
  const eligible = new Map(preview.map((entry) => [entry.id, entry]));
  const changed = [];
  for (const entry of entries) {
    const row = rows.get(entry.id);
    if (!row) throw new Error(`Item disappeared: ${entry.id}`);
    if (rollback && row.image_url === null && row.current_hash === entry.beforeHash) continue;
    if (!rollback && row.image_url === entry.imageUrl) {
      const original = await client.query(`select md5((to_jsonb(item) || jsonb_build_object('image_url',null))::text) as hash
        from plans.plan_items item where id=$1`, [entry.id]);
      if (original.rows[0].hash === entry.beforeHash) continue;
    }
    if (rollback ? row.current_hash !== entry.afterHash || row.image_url !== entry.imageUrl
      : row.current_hash !== entry.beforeHash || eligible.get(entry.id)?.imageUrl !== entry.imageUrl) {
      throw new Error(`Item or access changed; regenerate/review the dry-run: ${entry.id}`);
    }
    const updated = await client.query(`update plans.plan_items item set image_url=$2
      where id=$1 and image_url is not distinct from $3
      returning md5(to_jsonb(item)::text) as after_hash`,
    [entry.id, rollback ? null : entry.imageUrl, rollback ? entry.imageUrl : null]);
    if (updated.rowCount !== 1) throw new Error(`Concurrent image edit: ${entry.id}`);
    changed.push({ ...entry, afterHash: updated.rows[0].after_hash });
  }
  return changed;
}
