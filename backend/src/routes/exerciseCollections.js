import { Router } from "express";
import { pool, query, queryWithoutJit } from "../db.js";
import { exerciseAdministratorSql, exerciseReadScopeSql, hasExerciseAdministration } from "../exerciseAccess.js";
import { loadLockedExercisePreviews } from "../exerciseBlocks.js";
import { emitRealtimeEventForAll } from "../realtime.js";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The pictures a card without a cover of its own steps through: at most ten
// exercises with a picture, in the alphabetical name/ID order of the
// first-picture cover. A picture is an image, or a video link the page takes
// a cover from - the link forms media.js reads a YouTube or Google Drive id
// from; it is decided before the limit, so other video links never crowd
// out a real picture. `from` is the caller's own FROM ... WHERE with its
// access predicates on `e`, so a slide is never an exercise the coach could
// not open from there.
const COVER_SLIDE_LIMIT = 10;
const coverPictureSql = `(nullif(btrim(e.image_url),'') is not null
  or btrim(e.video_url) ~* '^https?://((www\\.|m\\.|music\\.)?youtube\\.com|(www\\.)?youtube-nocookie\\.com)/([^?#]*\\?([^#]*&)?v=[a-z0-9_-]{11}([&#]|$)|(shorts|embed|live)/[a-z0-9_-]{11}([/?#]|$))'
  or btrim(e.video_url) ~* '^https?://youtu\\.be/[a-z0-9_-]{11}([/?#]|$)'
  or e.video_url ~* 'drive\\.google\\.com/(file/d/[^/?]|.*[?&]id=[^&])|lh3\\.googleusercontent\\.com/d/[^/?]')`;
const coverSlideSql = `jsonb_build_object('imageUrl',coalesce(e.image_url,''),'videoUrl',coalesce(e.video_url,''))`;
const coverSlidesSql = (from) => `(select coalesce(jsonb_agg(slide.picture order by slide.name,slide.id),'[]'::jsonb)
  from (select e.id,e.name,${coverSlideSql} as picture ${from} and ${coverPictureSql}
    order by e.name,e.id limit ${COVER_SLIDE_LIMIT}) slide)`;

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
        case when nullif(c.cover_image_url,'') is null and ${granted} then ${coverSlidesSql(`from library.exercise_collection_items ci
          join library.exercises e on e.id=ci.exercise_id where ci.collection_id=c.id and e.owner_scope='system' and ${visible}`)}
          else '[]'::jsonb end as "coverSlides",
        (select count(*)::integer from library.exercise_collection_items ci join library.exercises e on e.id=ci.exercise_id
          where ci.collection_id=c.id and e.owner_scope='system' and e.is_active=true
          and (${granted} and ${visible} or not ${granted})) as "exerciseCount"
      from library.exercise_collections c
      where c.deleted_at is null and (${granted} or c.block_preview='locked')
        and (c.name ilike $2 or c.description ilike $2)
      order by c.name,c.id limit 501`, params);
    if (blocks.rows.length > 500) return res.status(409).json({ error: "tooManyBlocks" });
    // Other's pictures come from the same pass as its count.
    const other = await queryWithoutJit(`select count(*)::integer as count,
        (array_agg(nullif(e.image_url,'') order by e.name,e.id))[1] as image,
        coalesce(to_jsonb((array_agg(${coverSlideSql} order by e.name,e.id) filter (where ${coverPictureSql}))[1:${COVER_SLIDE_LIMIT}]),'[]'::jsonb) as slides
      from library.exercises e where ${visible} and (e.owner_scope='system' or e.owner_user_id=$1) and not exists (select 1 from library.exercise_collection_items ci
        where ci.exercise_id=coalesce(e.source_exercise_id,e.id))`, [req.user.id]);
    res.json({ blocks: blocks.rows, other: { id: "other", name: "Other", description: "Available exercises outside application blocks.",
      exerciseCount: other.rows[0].count, coverImageUrl: other.rows[0].image || "", coverSlides: other.rows[0].slides }, canManageCollections: admin });
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

// A live block's full state (the editor's answer and the audit's before /
// after), for the blocks the `where` clause names.
const collectionStateSql = (where) => `select c.id, c.name, c.revision,c.description,c.cover_image_url as "coverImageUrl",c.access_all as "accessAll",
       c.block_preview as "blockPreview",c.exercise_preview as "exercisePreview",
       coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'imageUrl', e.image_url) order by e.name,e.id)
         from library.exercise_collection_items ci join library.exercises e on e.id = ci.exercise_id
         where ci.collection_id = c.id), '[]'::jsonb) as exercises,
       coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', coalesce(u.display_name,u.full_name,u.email), 'email', u.email) order by u.email)
         from library.exercise_collection_users cu join public.users u on u.id = cu.user_id
         where cu.collection_id = c.id), '[]'::jsonb) as users
     from library.exercise_collections c where c.deleted_at is null and ${where}
     order by c.name, c.id limit 501`;

async function loadCollections(runQuery = query, collectionId = null) {
  return (await runQuery(collectionStateSql("($1::uuid is null or c.id = $1)"), [collectionId])).rows;
}

// Several blocks' states in one statement, by id.
async function loadCollectionsById(runQuery, ids) {
  return new Map((await runQuery(collectionStateSql("c.id = any($1::uuid[])"), [ids])).rows.map((row) => [row.id, row]));
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

// A checked-out client has no 'error' listener of its own (pg-pool removes
// its idle listener at checkout), and pg emits 'error' when the server ends
// the session while no query runs - exactly what the idle bound below or a
// pooler reset does. Without a listener that event would crash the process
// (the guardClient pattern of sourceConnectionService.js). The listener is
// removed again right before the client goes back to the pool; a release
// with an error destroys the client.
async function checkoutBlockClient() {
  const client = await pool.connect();
  const onClientError = () => {};
  client.on("error", onClientError);
  return { client, release: (error) => {
    client.removeListener("error", onClientError);
    client.release(error);
  } };
}

// Every block write: one READ COMMITTED transaction (the block deletion
// guard requires it), bounded lock waits and idle time - it holds the
// exclusive block lock that every exercise reuse takes shared -, and the
// caller still an active platform admin in the platform workspace. A
// refusal is rolled back.
async function beginBlockWrite(runQuery, userId) {
  await runQuery("begin isolation level read committed");
  await runQuery("set local lock_timeout = '2s'");
  await runQuery("set local statement_timeout = '10s'");
  await runQuery("set local idle_in_transaction_session_timeout = '15s'");
  await runQuery("select pg_advisory_xact_lock(hashtextextended('exercise_collections', 0))");
  const actor = await runQuery(`select r.id from public.user_global_roles r join public.users u on u.id = r.user_id
    where r.user_id = $1 and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
      and ${exerciseAdministratorSql} for share of r,u`, [userId]);
  if (actor.rowCount) return null;
  await runQuery("rollback");
  return { status: 404, error: "notFound" };
}

// The block, locked, unless it is missing or deleted (the same 404) or the
// caller edited an older revision. A refusal is rolled back.
async function lockLiveBlock(runQuery, collectionId, expectedRevision) {
  const current = await runQuery("select revision from library.exercise_collections where id = $1 and deleted_at is null for update", [collectionId]);
  if (current.rowCount && current.rows[0].revision === expectedRevision) return null;
  await runQuery("rollback");
  return current.rowCount ? { status: 409, error: "staleRevision" } : { status: 404, error: "notFound" };
}

async function saveCollection(req, res) {
  const data = parseBody(req.body);
  const collectionId = req.params.collectionId || null;
  if (!data || (collectionId && (!uuidPattern.test(collectionId) || !Number.isInteger(req.body.expectedRevision)))) {
    return res.status(400).json({ error: "invalidBody" });
  }
  let client;
  let release;
  try {
    ({ client, release } = await checkoutBlockClient());
    const runQuery = (sql, params) => client.query(sql, params);
    const refusal = await beginBlockWrite(runQuery, req.user.id);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    let before = null;
    if (collectionId) {
      const stale = await lockLiveBlock(runQuery, collectionId, req.body.expectedRevision);
      if (stale) return res.status(stale.status).json({ error: stale.error });
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
  } finally { if (client) release(); }
}

// Whether a delete whose COMMIT answer was an error is in the database,
// read on another connection: the block marked deleted by this user.
async function deletionCommitted(collectionId, userId) {
  try {
    const found = await query(`select 1 from library.exercise_collections
      where id = $1 and deleted_at is not null and deleted_by_user_id = $2`, [collectionId, userId]);
    return found.rowCount === 1;
  } catch { return null; }
}

// Deleting a block: its exercises are back in Other (available to every
// coach), its user grants are removed, and the row stays, marked deleted,
// for the audit trail. A deleted block is gone from every list for good.
// Once the COMMIT is sent the answer never says "not deleted": an error then
// is checked on another connection - deleted (200, verifiedAfterCommitError)
// or unknown (503 outcomeUnknown); a retry of a deleted block is a 404.
async function deleteCollection(req, res) {
  const collectionId = req.params.collectionId;
  if (!uuidPattern.test(collectionId) || !Number.isInteger(req.body?.expectedRevision)) {
    return res.status(400).json({ error: "invalidBody" });
  }
  let client;
  let release;
  let commitSent = false;
  let verifiedAfterCommitError = false;
  let deleted;
  try {
    ({ client, release } = await checkoutBlockClient());
    const runQuery = (sql, params) => client.query(sql, params);
    const refusal = await beginBlockWrite(runQuery, req.user.id);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    const stale = await lockLiveBlock(runQuery, collectionId, req.body.expectedRevision);
    if (stale) return res.status(stale.status).json({ error: stale.error });
    const [before] = await loadCollections(runQuery, collectionId);
    await runQuery("delete from library.exercise_collection_items where collection_id = $1", [collectionId]);
    await runQuery("delete from library.exercise_collection_users where collection_id = $1", [collectionId]);
    await runQuery(`update library.exercise_collections set deleted_at=now(),deleted_by_user_id=$2,
      revision=revision+1,updated_at=now() where id=$1`, [collectionId, req.user.id]);
    deleted = { id: before.id, name: before.name, deleted: true,
      exerciseCount: before.exercises.length, userCount: before.users.length };
    await runQuery(`insert into library.exercise_collection_audit (collection_id,actor_user_id,before_state,after_state)
      values ($1,$2,$3::jsonb,$4::jsonb)`, [collectionId, req.user.id, JSON.stringify(before), JSON.stringify(deleted)]);
    commitSent = true;
    await runQuery("commit");
  } catch (error) {
    if (!commitSent) {
      if (client) { try { await client.query("rollback"); } catch {} }
      return respondError(res, error);
    }
    // The connection's state after a failed COMMIT is unknown: never reuse it.
    release(error);
    client = null;
    if (!(await deletionCommitted(collectionId, req.user.id))) return res.status(503).json({ error: "outcomeUnknown" });
    verifiedAfterCommitError = true;
  } finally { if (client) release(); }
  try { emitRealtimeEventForAll("exercise_library_changed"); } catch {}
  res.json(verifiedAfterCommitError ? { deleted, verifiedAfterCommitError } : { deleted });
}

// One exercise's application block, for the administrator's block choice in
// the exercise's classification panel: its current block (a personal copy's
// is its original's, read-only here) and every live block to choose from.
router.get("/exercise-block/:exerciseId", async (req, res) => {
  if (!uuidPattern.test(req.params.exerciseId)) return res.status(400).json({ error: "invalidBody" });
  try {
    const exercise = (await query(`select e.id,e.name,e.owner_scope='system' and e.is_active=true as movable,
        c.id as "currentId",c.name as "currentName"
      from library.exercises e
      left join library.exercise_collection_items ci on ci.exercise_id=coalesce(e.source_exercise_id,e.id)
      left join library.exercise_collections c on c.id=ci.collection_id and c.deleted_at is null
      where e.id=$1`, [req.params.exerciseId])).rows[0];
    if (!exercise) return res.status(404).json({ error: "notFound" });
    const blocks = (await query(`select id,name,access_all as "accessAll" from library.exercise_collections
      where deleted_at is null order by name,id limit 501`)).rows;
    if (blocks.length > 500) return res.status(409).json({ error: "tooManyBlocks" });
    res.json({ exerciseId: exercise.id, exerciseName: exercise.name, movable: exercise.movable,
      current: exercise.currentId ? { id: exercise.currentId, name: exercise.currentName } : null, blocks });
  } catch (error) { respondError(res, error); }
});

// The most exercises one move takes, and one lookup reads.
const BLOCK_MOVE_LIMIT = 100;

// Where each of the given exercises is, for the administrator's move of
// several at once: its current block (a personal copy's is its original's),
// whether it can be moved (an active application exercise), and every live
// block to choose from. An id that names no exercise is left out.
router.get("/exercise-blocks", async (req, res) => {
  const ids = [...new Set(String(req.query.ids || "").split(",").filter(Boolean).map((id) => id.toLowerCase()))];
  if (!ids.length || ids.length > BLOCK_MOVE_LIMIT || ids.some((id) => !uuidPattern.test(id))) return res.status(400).json({ error: "invalidBody" });
  try {
    const exercises = (await query(`select e.id,e.name,e.owner_scope='system' and e.is_active=true as movable,
        c.id as "currentId",c.name as "currentName"
      from library.exercises e
      left join library.exercise_collection_items ci on ci.exercise_id=coalesce(e.source_exercise_id,e.id)
      left join library.exercise_collections c on c.id=ci.collection_id and c.deleted_at is null
      where e.id = any($1::uuid[]) order by e.name,e.id`, [ids])).rows;
    const blocks = (await query(`select id,name,access_all as "accessAll" from library.exercise_collections
      where deleted_at is null order by name,id limit 501`)).rows;
    if (blocks.length > 500) return res.status(409).json({ error: "tooManyBlocks" });
    res.json({ exercises: exercises.map((exercise) => ({ id: exercise.id, name: exercise.name, movable: exercise.movable,
      current: exercise.currentId ? { id: exercise.currentId, name: exercise.currentName } : null })), blocks });
  } catch (error) { respondError(res, error); }
});

// Moves application exercises into one block, or out of every block (back to
// Other, available to every coach), each from the block the screen showed it
// in (`expectedCollectionId`, null for Other). All of them or none, in one
// transaction with the lock order of a block save: the block lock, the
// administrator, the blocks (by id), then the exercises (by id). An exercise
// already in the target is left as it is, so a repeat of a move already made
// writes nothing. Every block that loses or gains an exercise gets a new
// revision (an editor open on it sees it changed) and one audit row. The
// statements are the same in number however many blocks the move touches:
// the transaction holds the block lock every exercise reuse waits for (2 s).
// Once the COMMIT is sent the answer never says "not moved": an error then
// is checked on another connection. Returns { status, body }, or { error }
// for the caller's error mapping.
async function moveExercisesToBlock(userId, target, moves) {
  const ids = moves.map((move) => move.exerciseId);
  let client;
  let release;
  let commitSent = false;
  let answer;
  let movingIds = [];
  try {
    ({ client, release } = await checkoutBlockClient());
    const runQuery = (sql, params) => client.query(sql, params);
    const refusal = await beginBlockWrite(runQuery, userId);
    if (refusal) return { status: refusal.status, body: { error: refusal.error } };
    const refuse = async (status, body) => { await runQuery("rollback"); return { status, body }; };
    const placement = async () => new Map((await runQuery(`select exercise_id,collection_id from library.exercise_collection_items
      where exercise_id = any($1::uuid[])`, [ids])).rows.map((row) => [row.exercise_id, row.collection_id]));
    const blockOf = (placed, id) => placed.get(id) ?? null;
    const current = await placement();
    const affected = [...new Set([...current.values(), target].filter(Boolean))].sort();
    const live = await runQuery(`select id from library.exercise_collections where id = any($1::uuid[]) and deleted_at is null
      order by id for update`, [affected]);
    if (target && !live.rows.some((row) => row.id === target)) return await refuse(409, { error: "blockNotAvailable" });
    const exercises = await runQuery(`select id from library.exercises where id = any($1::uuid[])
      and owner_scope = 'system' and is_active = true order by id for update`, [ids]);
    if (exercises.rowCount !== ids.length) return await refuse(400, { error: "invalidSelection" });
    // Read before their blocks were locked: still the same under every lock?
    const locked = await placement();
    if (ids.some((id) => blockOf(locked, id) !== blockOf(current, id))) return await refuse(409, { error: "tryAgain" });
    const moving = moves.filter((move) => blockOf(current, move.exerciseId) !== target);
    if (!moving.length) return await refuse(200, { collectionId: target, moved: [], unchanged: ids, changed: false });
    const stale = moving.filter((move) => blockOf(current, move.exerciseId) !== move.expectedCollectionId).map((move) => move.exerciseId);
    if (stale.length) return await refuse(409, { error: "staleRevision", stale });
    movingIds = moving.map((move) => move.exerciseId);
    const changedBlocks = [...new Set([...movingIds.map((id) => blockOf(current, id)), target].filter(Boolean))].sort();
    const before = await loadCollectionsById(runQuery, changedBlocks);
    await runQuery("delete from library.exercise_collection_items where exercise_id = any($1::uuid[])", [movingIds]);
    if (target) await runQuery("insert into library.exercise_collection_items (collection_id,exercise_id) select $1, unnest($2::uuid[])", [target, movingIds]);
    await runQuery("update library.exercise_collections set revision=revision+1,updated_at=now() where id = any($1::uuid[])", [changedBlocks]);
    const after = await loadCollectionsById(runQuery, changedBlocks);
    await runQuery(`insert into library.exercise_collection_audit (collection_id,actor_user_id,before_state,after_state)
      select entry.id, $1, entry.before, entry.after from jsonb_to_recordset($2::jsonb) as entry(id uuid, before jsonb, after jsonb)`,
    [userId, JSON.stringify(changedBlocks.map((id) => ({ id, before: before.get(id), after: after.get(id) })))]);
    answer = { collectionId: target, moved: movingIds, unchanged: ids.filter((id) => !movingIds.includes(id)), changed: true };
    commitSent = true;
    await runQuery("commit");
  } catch (error) {
    if (!commitSent) {
      if (client) { try { await client.query("rollback"); } catch {} }
      return { error };
    }
    // The connection's state after a failed COMMIT is unknown: never reuse it.
    release(error);
    client = null;
    let landed;
    try {
      landed = (await query("select collection_id from library.exercise_collection_items where exercise_id = any($1::uuid[])", [movingIds])).rows;
    } catch { return { status: 503, body: { error: "outcomeUnknown" } }; }
    const arrived = target
      ? landed.length === movingIds.length && landed.every((row) => row.collection_id === target)
      : landed.length === 0;
    if (!arrived) return { status: 503, body: { error: "outcomeUnknown" } };
    answer.verifiedAfterCommitError = true;
  } finally { if (client) release(); }
  try { emitRealtimeEventForAll("exercise_library_changed"); } catch {}
  return { status: 200, body: answer };
}

// A block id or null for Other: a missing key (undefined) is refused, never
// read as "Other", the direction that opens an exercise to every coach.
const blockIdOrNull = (id) => id === null || (typeof id === "string" && uuidPattern.test(id));

// One exercise (the classification panel): { collectionId, expectedCollectionId }.
// Ids compare in the database's lower case.
async function moveExerciseBlock(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!uuidPattern.test(req.params.exerciseId) || !blockIdOrNull(body.collectionId) || !blockIdOrNull(body.expectedCollectionId)) {
    return res.status(400).json({ error: "invalidBody" });
  }
  const exerciseId = req.params.exerciseId.toLowerCase();
  const result = await moveExercisesToBlock(req.user.id, body.collectionId?.toLowerCase() ?? null,
    [{ exerciseId, expectedCollectionId: body.expectedCollectionId?.toLowerCase() ?? null }]);
  if (result.error) return respondError(res, result.error);
  if (result.status !== 200) return res.status(result.status).json({ error: result.body.error });
  const { collectionId, changed, verifiedAfterCommitError } = result.body;
  res.json(verifiedAfterCommitError ? { exerciseId, collectionId, changed, verifiedAfterCommitError } : { exerciseId, collectionId, changed });
}

// Several exercises at once (the library's selection):
// { collectionId | null, moves: [{ exerciseId, expectedCollectionId | null }] },
// at most BLOCK_MOVE_LIMIT, each exercise once.
async function moveExerciseBlocks(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const moves = Array.isArray(body.moves) ? body.moves : null;
  if (!blockIdOrNull(body.collectionId) || !moves?.length || moves.length > BLOCK_MOVE_LIMIT
    || moves.some((move) => !move || typeof move !== "object" || typeof move.exerciseId !== "string"
      || !uuidPattern.test(move.exerciseId) || !blockIdOrNull(move.expectedCollectionId))) {
    return res.status(400).json({ error: "invalidBody" });
  }
  const normalized = moves.map((move) => ({ exerciseId: move.exerciseId.toLowerCase(), expectedCollectionId: move.expectedCollectionId?.toLowerCase() ?? null }));
  if (new Set(normalized.map((move) => move.exerciseId)).size !== normalized.length) return res.status(400).json({ error: "invalidBody" });
  const result = await moveExercisesToBlock(req.user.id, body.collectionId?.toLowerCase() ?? null, normalized);
  if (result.error) return respondError(res, result.error);
  res.status(result.status).json(result.body);
}

router.post("/", saveCollection);
router.patch("/:collectionId", saveCollection);
router.delete("/:collectionId", deleteCollection);
router.put("/exercise-block/:exerciseId", moveExerciseBlock);
router.put("/exercise-blocks", moveExerciseBlocks);
export default router;
