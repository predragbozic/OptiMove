import { Router } from "express";
import { pool, query } from "../db.js";
import { isPlatformAdministrator } from "../authz.js";
import { emitRealtimeEventForAll } from "../realtime.js";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!isPlatformAdministrator(req.authz)) return res.status(404).json({ error: "notFound" });
  next();
});

function respondError(res, error) {
  if (["55P03", "40P01", "57014"].includes(error.code)) return res.status(409).json({ error: "tryAgain" });
  if (error.code === "23505") return res.status(409).json({ error: "exerciseAlreadyInBlock" });
  return res.status(500).json({ error: "internalError" });
}

async function loadCollections(runQuery = query, collectionId = null) {
  return (await runQuery(
    `select c.id, c.name, c.revision,
       coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.name)
         from library.exercise_collection_items ci join library.exercises e on e.id = ci.exercise_id
         where ci.collection_id = c.id), '[]'::jsonb) as exercises,
       coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', coalesce(u.display_name,u.full_name,u.email), 'email', u.email) order by u.email)
         from library.exercise_collection_users cu join public.users u on u.id = cu.user_id
         where cu.collection_id = c.id), '[]'::jsonb) as users
     from library.exercise_collections c where ($1::uuid is null or c.id = $1) order by c.name, c.id limit 501`,
    [collectionId],
  )).rows;
}

router.get("/", async (req, res) => {
  try {
    const collections = await loadCollections();
    if (collections.length > 500) return res.status(409).json({ error: "tooManyBlocks" });
    res.json({ collections });
  } catch (error) { respondError(res, error); }
});

router.get("/options", async (req, res) => {
  try {
    const exerciseSearch = String(req.query.exerciseSearch || "").trim().slice(0, 120);
    const userSearch = String(req.query.userSearch || "").trim().slice(0, 120);
    const [exercises, users] = await Promise.all([
      query(`select e.id, e.name, ci.collection_id as "collectionId" from library.exercises e
        left join library.exercise_collection_items ci on ci.exercise_id = e.id
        where e.is_active = true and e.owner_scope = 'system' and e.name ilike $1
        order by e.name, e.id limit 101`, [`%${exerciseSearch}%`]),
      query(`select id, coalesce(display_name,full_name,email) as name, email from public.users
        where is_active = true and (coalesce(display_name,full_name,'') ilike $1 or email ilike $1)
        order by email, id limit 101`, [`%${userSearch}%`]),
    ]);
    res.json({ exercises: exercises.rows.slice(0, 100), users: users.rows.slice(0, 100),
      moreExercises: exercises.rows.length > 100, moreUsers: users.rows.length > 100 });
  } catch (error) { respondError(res, error); }
});

function parseBody(body) {
  if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) return null;
  for (const key of ["exerciseIds", "userIds"]) {
    if (!Array.isArray(body[key]) || body[key].length > 1000 || body[key].some((id) => typeof id !== "string" || !uuidPattern.test(id))) return null;
  }
  return { name: body.name.trim(), exerciseIds: [...new Set(body.exerciseIds)].sort(), userIds: [...new Set(body.userIds)].sort() };
}

async function saveCollection(req, res) {
  const data = parseBody(req.body);
  const collectionId = req.params.collectionId || null;
  if (!data || (collectionId && (!uuidPattern.test(collectionId) || !Number.isInteger(req.body.expectedRevision)))) {
    return res.status(400).json({ error: "invalidBody" });
  }
  let client;
  try {
    client = await pool.connect();
    const runQuery = (sql, params) => client.query(sql, params);
    await runQuery("begin");
    await runQuery("set local lock_timeout = '2s'");
    await runQuery("set local statement_timeout = '10s'");
    await runQuery("select pg_advisory_xact_lock(hashtextextended('exercise_collections', 0))");
    const actor = await runQuery(`select r.id from public.user_global_roles r join public.users u on u.id = r.user_id
      where r.user_id = $1 and r.role = 'platform_admin' and r.is_active = true and u.is_active = true for share of r,u`, [req.user.id]);
    if (!actor.rowCount) {
      await runQuery("rollback");
      return res.status(404).json({ error: "notFound" });
    }
    let before = null;
    if (collectionId) {
      const current = await runQuery("select revision from library.exercise_collections where id = $1 for update", [collectionId]);
      if (!current.rowCount) {
        await runQuery("rollback");
        return res.status(404).json({ error: "notFound" });
      }
      if (current.rows[0].revision !== req.body.expectedRevision) {
        await runQuery("rollback");
        return res.status(409).json({ error: "staleRevision" });
      }
      [before] = await loadCollections(runQuery, collectionId);
    }
    const selected = await runQuery(`select id from library.exercises where id = any($1::uuid[])
      and owner_scope = 'system' and is_active = true order by id for update`, [data.exerciseIds]);
    const users = await runQuery("select id from public.users where id = any($1::uuid[]) and is_active = true order by id for share", [data.userIds]);
    if (selected.rowCount !== data.exerciseIds.length || users.rowCount !== data.userIds.length) {
      await runQuery("rollback");
      return res.status(400).json({ error: "invalidSelection" });
    }
    const conflict = await runQuery(`select 1 from library.exercise_collection_items
      where exercise_id = any($1::uuid[]) and ($2::uuid is null or collection_id <> $2) limit 1`, [data.exerciseIds, collectionId]);
    if (conflict.rowCount) {
      await runQuery("rollback");
      return res.status(409).json({ error: "exerciseAlreadyInBlock" });
    }
    let savedId = collectionId;
    if (savedId) {
      await runQuery("update library.exercise_collections set name = $2, revision = revision + 1, updated_at = now() where id = $1", [savedId, data.name]);
      await runQuery("delete from library.exercise_collection_items where collection_id = $1", [savedId]);
      await runQuery("delete from library.exercise_collection_users where collection_id = $1", [savedId]);
    } else {
      savedId = (await runQuery("insert into library.exercise_collections (name,created_by_user_id) values ($1,$2) returning id", [data.name, req.user.id])).rows[0].id;
    }
    await runQuery("insert into library.exercise_collection_items (collection_id,exercise_id) select $1, unnest($2::uuid[])", [savedId, data.exerciseIds]);
    await runQuery("insert into library.exercise_collection_users (collection_id,user_id) select $1, unnest($2::uuid[])", [savedId, data.userIds]);
    const [collection] = await loadCollections(runQuery, savedId);
    await runQuery(`insert into library.exercise_collection_audit (collection_id,actor_user_id,before_state,after_state)
      values ($1,$2,$3::jsonb,$4::jsonb)`, [savedId, req.user.id, before ? JSON.stringify(before) : null, JSON.stringify(collection)]);
    await runQuery("commit");
    emitRealtimeEventForAll("exercise_library_changed");
    res.status(collectionId ? 200 : 201).json({ collection });
  } catch (error) {
    if (client) { try { await client.query("rollback"); } catch {} }
    respondError(res, error);
  } finally { client?.release(); }
}

router.post("/", saveCollection);
router.patch("/:collectionId", saveCollection);
export default router;
