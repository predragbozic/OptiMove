import { Router } from "express";
import { pool, query, queryWithoutJit } from "../db.js";
import { exerciseAdministratorSql, exerciseReadScopeSql, hasExerciseAdministration } from "../exerciseAccess.js";
import { loadLockedExercisePreviews } from "../exerciseBlocks.js";
import { emitRealtimeEventForAll } from "../realtime.js";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/catalog", async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    const admin = await hasExerciseAdministration(req.user.id, req.authz, query);
    const search = String(req.query.search || "").trim().slice(0, 120);
    const params = [req.user.id, `%${search}%`];
    const visible = `${exerciseReadScopeSql} and not exists (select 1 from library.filter_hidden hidden
      where hidden.kind='exercise' and hidden.item_id=e.id and hidden.user_id=$1)`;
    const granted = `(${exerciseAdministratorSql} or c.access_all=true or exists (
      select 1 from library.exercise_collection_users granted where granted.collection_id=c.id and granted.user_id=$1))`;
    const blocks = await queryWithoutJit(`select c.id,c.name,c.description,not ${granted} as locked,
        coalesce(nullif(c.cover_image_url,''),case when ${granted} then (select nullif(e.image_url,'') from library.exercise_collection_items ci
          join library.exercises e on e.id=ci.exercise_id where ci.collection_id=c.id and ${visible}
          order by e.name,e.id limit 1) end,'') as "coverImageUrl",
        (select count(*)::integer from library.exercise_collection_items ci join library.exercises e on e.id=ci.exercise_id
          where ci.collection_id=c.id and e.owner_scope='system' and e.is_active=true
          and (${granted} and ${visible} or not ${granted})) as "exerciseCount"
      from library.exercise_collections c
      where (${granted} or c.block_preview='locked')
        and (c.name ilike $2 or c.description ilike $2)
      order by c.name,c.id limit 501`, params);
    if (blocks.rows.length > 500) return res.status(409).json({ error: "tooManyBlocks" });
    const other = await queryWithoutJit(`select count(*)::integer as count,
        (array_agg(nullif(e.image_url,'') order by e.name,e.id))[1] as image
      from library.exercises e where ${visible} and (e.owner_scope='system' or e.owner_user_id=$1) and not exists (select 1 from library.exercise_collection_items ci
        where ci.exercise_id=coalesce(e.source_exercise_id,e.id))`, [req.user.id]);
    res.json({ blocks: blocks.rows, other: { id: "other", name: "Other", description: "Available exercises outside application blocks.",
      exerciseCount: other.rows[0].count, coverImageUrl: other.rows[0].image || "" }, canManageCollections: admin });
  } catch (error) { next(error); }
});

router.get("/locked-exercises", async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    const collection = String(req.query.collection || "");
    if (collection && collection !== "other" && !uuidPattern.test(collection)) return res.status(400).json({ error: "invalidBlock" });
    if (collection === "other") return res.json({ exercises: [], hasMore: false });
    const search = String(req.query.search || "").trim().slice(0, 120);
    const requestedLimit = Number(req.query.limit || 30);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1,Math.min(500,Math.floor(requestedLimit))) : 30;
    res.json(await loadLockedExercisePreviews(req.user.id, search, collection, limit));
  } catch (error) { next(error); }
});

router.use(async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!(await hasExerciseAdministration(req.user.id, req.authz, query))) return res.status(404).json({ error: "notFound" });
    next();
  } catch (error) { next(error); }
});

function respondError(res, error) {
  if (["55P03", "40P01", "57014"].includes(error.code)) return res.status(409).json({ error: "tryAgain" });
  if (error.code === "23505") return res.status(409).json({ error: "exerciseAlreadyInBlock" });
  return res.status(500).json({ error: "internalError" });
}

async function loadCollections(runQuery = query, collectionId = null) {
  return (await runQuery(
    `select c.id, c.name, c.revision,c.description,c.cover_image_url as "coverImageUrl",c.access_all as "accessAll",
       c.block_preview as "blockPreview",c.exercise_preview as "exercisePreview",
       coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'imageUrl', e.image_url) order by e.name,e.id)
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
      query(`select e.id, e.name, e.image_url as "imageUrl", ci.collection_id as "collectionId" from library.exercises e
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
  const description = body.description === undefined ? undefined : typeof body.description === "string" ? body.description.trim() : null;
  const coverImageUrl = body.coverImageUrl === undefined ? undefined : typeof body.coverImageUrl === "string" ? body.coverImageUrl.trim() : null;
  if (description === null || description?.length > 2000 || coverImageUrl === null || coverImageUrl?.length > 2048) return null;
  if (coverImageUrl) {
    // The same rule as the database's CHECK (^https?://), so a typing slip
    // such as "http:example.com" is a 400, never an unknown save outcome.
    if (!/^https?:\/\//i.test(coverImageUrl)) return null;
    // Every coach's browser loads the cover: never a user name or password in it.
    try {
      const url = new URL(coverImageUrl);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    } catch { return null; }
  }
  if (body.accessAll !== undefined && typeof body.accessAll !== "boolean") return null;
  for (const field of ["blockPreview","exercisePreview"]) if (body[field] !== undefined && !["hidden","locked"].includes(body[field])) return null;
  return { name: body.name.trim(), description, coverImageUrl, accessAll: body.accessAll, blockPreview: body.blockPreview, exercisePreview: body.exercisePreview,
    exerciseIds: [...new Set(body.exerciseIds)].sort(), userIds: [...new Set(body.userIds)].sort() };
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
      where r.user_id = $1 and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
        and ${exerciseAdministratorSql} for share of r,u`, [req.user.id]);
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
      await runQuery(`update library.exercise_collections set name=$2,description=coalesce($3,description),
        cover_image_url=coalesce($4,cover_image_url),access_all=coalesce($5,access_all),
        block_preview=coalesce($6,block_preview),exercise_preview=coalesce($7,exercise_preview),
        revision=revision+1,updated_at=now() where id=$1`, [savedId,data.name,data.description,data.coverImageUrl,data.accessAll,data.blockPreview,data.exercisePreview]);
      await runQuery("delete from library.exercise_collection_items where collection_id = $1", [savedId]);
      await runQuery("delete from library.exercise_collection_users where collection_id = $1", [savedId]);
    } else {
      savedId = (await runQuery(`insert into library.exercise_collections (name,created_by_user_id,description,cover_image_url,access_all,block_preview,exercise_preview)
        values ($1,$2,$3,$4,$5,$6,$7) returning id`, [data.name,req.user.id,data.description || "",data.coverImageUrl || "",data.accessAll ?? false,data.blockPreview || "hidden",data.exercisePreview || "hidden"])).rows[0].id;
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
