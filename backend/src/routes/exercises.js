import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import { exerciseReadScopeSql as exerciseScope } from "../exerciseAccess.js";
import { isPlatformAdministrator } from "../authz.js";

const router = Router();
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const libraryScope = `(
  owner_scope = 'system'
  or owner_user_id = $1
  or (owner_scope = 'club' and owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
  or (owner_scope = 'team' and owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true))
)`;

const visibleTagsSql = `
  select t.id, t.name, (t.owner_scope <> 'user' or t.owner_user_id is distinct from $1::uuid) as readonly
  from library.exercise_tags et join library.tags t on t.id = et.tag_id
  where et.exercise_id = e.id and t.is_active = true
    and (t.owner_scope = 'system' or t.owner_user_id = $1)
  union all
  select personal.id, personal.name, false as readonly
  from library.exercise_personal_tags personal
  where personal.exercise_id = e.id and personal.user_id = $1`;

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `tag-${Date.now()}`;
}

function text(value) { return String(value ?? "").trim(); }
function nullableText(value) { return text(value) || null; }

async function getOrCreateLookup(table, name, userId, extra = {}, runQuery = query, systemOwned = false) {
  const clean = text(name);
  if (!clean) return null;
  const existing = await runQuery(
    `select id, owner_scope, is_active, (${libraryScope}) as can_read,
       (owner_scope = 'user' and owner_user_id = $1) as can_reactivate
     from library.${table} where lower(name) = lower($2) limit 1 for update`,
    [userId, clean],
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].can_read || (systemOwned && existing.rows[0].owner_scope !== "system") || (!existing.rows[0].is_active && !existing.rows[0].can_reactivate)) {
      const error = new Error("Lookup value is unavailable.");
      error.status = 409;
      throw error;
    }
    if (!existing.rows[0].is_active) {
      await runQuery(`update library.${table} set is_active = true, updated_at = now() where id = $1`, [existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }
  const extraKeys = Object.keys(extra);
  const extraCols = extraKeys.map((key) => `, ${key}`).join("");
  const extraParams = extraKeys.map((key, index) => `, $${index + 4}`).join("");
  const inserted = await runQuery(
    `insert into library.${table} (name, slug, owner_scope, owner_user_id, created_by_user_id${extraCols})
     values ($2, $3, '${systemOwned ? "system" : "user"}', ${systemOwned ? "null" : "$1"}, $1${extraParams})
     returning id`,
    [userId, clean, slugify(clean), ...extraKeys.map((key) => extra[key])],
  );
  return inserted.rows[0].id;
}

async function syncJunction(table, fkColumn, lookupTable, exerciseId, ids, userId, { withOrder = true, runQuery = query } = {}) {
  // Only clear links to values *this user can see* (system-wide or their own); a link to
  // another user's private value (e.g. a tag only they created) stays untouched even though
  // it never showed up in their own edit form, so we don't silently delete someone else's data.
  await runQuery(
    `delete from library.${table} j
     using library.${lookupTable} l
     where j.exercise_id = $1 and j.${fkColumn} = l.id
       and (l.owner_scope = 'system' or l.owner_user_id = $2)`,
    [exerciseId, userId],
  );
  for (let index = 0; index < ids.length; index += 1) {
    if (withOrder) {
      await runQuery(
        `insert into library.${table} (exercise_id, ${fkColumn}, is_primary, sort_order)
         values ($1, $2, $3, $4)
         on conflict do nothing`,
        [exerciseId, ids[index], index === 0, index],
      );
    } else {
      await runQuery(
        `insert into library.${table} (exercise_id, ${fkColumn}) values ($1, $2) on conflict do nothing`,
        [exerciseId, ids[index]],
      );
    }
  }
}

function splitNames(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return [];
}

async function exerciseExistsForUser(userId, exerciseId) {
  const result = await query(
    `select id
     from library.exercises e
     where e.id = $2 and ${exerciseScope}`,
    [userId, exerciseId],
  );
  return Boolean(result.rows[0]);
}

function libraryScopeWithHidden(table, kind) {
  return `${libraryScope} and not exists (select 1 from library.filter_hidden h where h.kind = '${kind}' and h.item_id = library.${table}.id and h.user_id = $1)`;
}

const optionQueries = {
  purposes: `
    select distinct name
    from library.domains
    where is_active = true and ${libraryScopeWithHidden("domains", "domain")}
    order by name`,
  qualities: `
    select distinct name
    from library.categories
    where is_active = true and ${libraryScopeWithHidden("categories", "category")}
    order by name`,
  groups: `
    select distinct name
    from library.sections
    where is_active = true and ${libraryScopeWithHidden("sections", "section")}
    order by name`,
  bodyParts: `
    select distinct bp.name
    from library.exercises e
    join library.exercise_body_parts ebp on ebp.exercise_id = e.id
    join library.body_parts bp on bp.id = ebp.body_part_id
    where ${exerciseScope} and bp.is_active = true
    order by bp.name`,
  movementPatterns: `
    select distinct mp.name
    from library.exercises e
    join library.exercise_movement_patterns emp on emp.exercise_id = e.id
    join library.movement_patterns mp on mp.id = emp.movement_pattern_id
    where ${exerciseScope} and mp.is_active = true
    order by mp.name`,
  startingPositions: `
    select distinct name
    from library.starting_positions
    where is_active = true and ${libraryScope}
    order by name`,
  places: `
    select distinct p.name
    from library.exercises e
    join library.places p on p.id = e.place_id
    where ${exerciseScope}
    order by p.name`,
  complexities: `
    select distinct c.name
    from library.exercises e
    join library.complexity_levels c on c.id = e.complexity_level_id
    where ${exerciseScope}
    order by c.name`,
  attractors: `
    select distinct name
    from library.attractors
    where is_active = true and ${libraryScopeWithHidden("attractors", "attractor")}
    order by name`,
  tags: `
    select distinct name from (
      select name from library.tags
      where is_active = true and ${libraryScopeWithHidden("tags", "tag")}
      union all
      select personal.name from library.exercise_personal_tags personal
      join library.exercises e on e.id = personal.exercise_id
      where personal.user_id = $1 and ${exerciseScope}
    ) visible_tags
    order by name`,
};

router.get("/options", async (req, res, next) => {
  try {
    const params = [req.user.id];
    const entries = await Promise.all(
      Object.entries(optionQueries).map(async ([key, sql]) => {
        const result = await query(sql, params);
        return [key, result.rows.map((row) => row.name).filter(Boolean)];
      }),
    );
    res.json(Object.fromEntries(entries));
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    const filters = {
      purpose: String(req.query.purpose || "").trim(),
      quality: String(req.query.quality || "").trim(),
      group: String(req.query.group || "").trim(),
      bodyPart: String(req.query.bodyPart || "").trim(),
      movementPattern: String(req.query.movementPattern || "").trim(),
      startingPosition: String(req.query.startingPosition || "").trim(),
      place: String(req.query.place || "").trim(),
      complexity: String(req.query.complexity || "").trim(),
      attractor: String(req.query.attractor || "").trim(),
      tag: String(req.query.tag || "").trim(),
      favorite: String(req.query.favorite || "") === "true",
    };
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const queryLimit = limit + 1;
    const requestedOffset = Number(req.query.offset || 0);
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    const params = [req.user.id];
    let where = `where ${exerciseScope}`;
    let searchOrder = "";

    if (search) {
      params.push(`%${search}%`);
      where += ` and (e.name ilike $${params.length} or e.exercise_code ilike $${params.length}
        or exists (select 1 from (${visibleTagsSql}) search_tags where search_tags.name ilike $${params.length}))`;
      params.push(search);
      const searchParam = `$${params.length}`;
      searchOrder = `case
        when lower(e.name) = lower(${searchParam}) or lower(e.exercise_code) = lower(${searchParam}) then 0
        when left(lower(e.name), length(${searchParam})) = lower(${searchParam}) then 1
        else 2
      end, `;
    }

    const addExistsFilter = (value, sql) => {
      if (!value) return;
      params.push(value);
      where += ` and exists (${sql.replaceAll("?", `$${params.length}`)})`;
    };

    addExistsFilter(filters.purpose, `
      select 1 from library.exercise_domains ed
      join library.domains d on d.id = ed.domain_id
      where ed.exercise_id = e.id and d.name = ?`);
    addExistsFilter(filters.quality, `
      select 1 from library.exercise_categories ec
      join library.categories c2 on c2.id = ec.category_id
      where ec.exercise_id = e.id and c2.name = ?`);
    addExistsFilter(filters.group, `
      select 1 from library.exercise_sections es
      join library.sections s on s.id = es.section_id
      where es.exercise_id = e.id and s.name = ?`);
    addExistsFilter(filters.bodyPart, `
      select 1 from library.exercise_body_parts ebp
      join library.body_parts bp on bp.id = ebp.body_part_id
      where ebp.exercise_id = e.id and bp.name = ?`);
    addExistsFilter(filters.movementPattern, `
      select 1 from library.exercise_movement_patterns emp
      join library.movement_patterns mp on mp.id = emp.movement_pattern_id
      where emp.exercise_id = e.id and mp.name = ?`);
    addExistsFilter(filters.tag, `
      select 1 from library.exercise_tags et
      join library.tags t on t.id = et.tag_id
      where et.exercise_id = e.id and t.name = ?
        and (t.owner_scope = 'system' or t.owner_user_id = $1)
      union all
      select 1 from library.exercise_personal_tags personal
      where personal.exercise_id = e.id and personal.user_id = $1 and personal.name = ?`);

    if (filters.startingPosition) {
      params.push(filters.startingPosition);
      where += ` and sp.name = $${params.length}`;
    }

    if (filters.place) {
      params.push(filters.place);
      where += ` and p.name = $${params.length}`;
    }

    if (filters.complexity) {
      params.push(filters.complexity);
      where += ` and c.name = $${params.length}`;
    }

    if (filters.attractor) {
      params.push(filters.attractor);
      where += ` and a.name = $${params.length}`;
    }

    if (filters.favorite) {
      where += " and fav.user_id is not null";
    }

    params.push(queryLimit);
    params.push(offset);
    const result = await query(
      `
      select
        e.id,
        e.exercise_code,
        e.name,
        e.aim,
        e.execution_notes,
        e.instruction,
        e.owner_scope,
        e.source_exercise_id,
        e.video_url,
        e.image_url,
        p.name as place,
        c.name as complexity,
        sp.name as starting_position,
        a.name as attractor,
        (fav.user_id is not null) as is_favorite,
        coalesce(
          (
            select json_agg(json_build_object('id', t.id, 'name', t.name, 'readonly', t.readonly) order by t.name)
            from (${visibleTagsSql}) t
          ),
          '[]'::json
        ) as tags
      from library.exercises e
      left join library.places p on p.id = e.place_id
      left join library.complexity_levels c on c.id = e.complexity_level_id
      left join library.starting_positions sp on sp.id = e.starting_position_id
      left join library.attractors a on a.id = e.attractor_id
      left join library.exercise_favorites fav on fav.exercise_id = e.id and fav.user_id = $1
      ${where}
      order by ${searchOrder}nullif(regexp_replace(e.exercise_code, '\\D', '', 'g'), '')::int nulls last, e.name, e.id
      limit $${params.length - 1} offset $${params.length}
      `,
      params,
    );
    res.json({
      exercises: result.rows.slice(0, limit),
      hasMore: result.rows.length > limit,
      canManageCollections: isPlatformAdministrator(req.authz),
    });
  } catch (error) {
    next(error);
  }
});

async function loadExerciseDetail(userId, exerciseId, runQuery = query) {
  const result = await runQuery(
    `
    select
      e.id, e.owner_scope, e.source_exercise_id, e.exercise_code, e.name, e.aim, e.execution_notes, e.instruction, e.video_url, e.image_url,
      p.name as place, c.name as complexity, sp.name as starting_position, a.name as attractor,
      coalesce((select json_agg(d.name order by d.name) from library.exercise_domains ed join library.domains d on d.id = ed.domain_id where ed.exercise_id = e.id and (d.owner_scope = 'system' or d.owner_user_id = $1)), '[]'::json) as purposes,
      coalesce((select json_agg(cat.name order by cat.name) from library.exercise_categories ec join library.categories cat on cat.id = ec.category_id where ec.exercise_id = e.id and (cat.owner_scope = 'system' or cat.owner_user_id = $1)), '[]'::json) as qualities,
      coalesce((select json_agg(s.name order by s.name) from library.exercise_sections es join library.sections s on s.id = es.section_id where es.exercise_id = e.id and (s.owner_scope = 'system' or s.owner_user_id = $1)), '[]'::json) as groups,
      coalesce((select json_agg(bp.name order by bp.name) from library.exercise_body_parts ebp join library.body_parts bp on bp.id = ebp.body_part_id where ebp.exercise_id = e.id and (bp.owner_scope = 'system' or bp.owner_user_id = $1)), '[]'::json) as body_parts,
      coalesce((select json_agg(mp.name order by mp.name) from library.exercise_movement_patterns emp join library.movement_patterns mp on mp.id = emp.movement_pattern_id where emp.exercise_id = e.id and (mp.owner_scope = 'system' or mp.owner_user_id = $1)), '[]'::json) as movement_patterns,
      coalesce((select json_agg(t.name order by t.name) from (${visibleTagsSql}) t), '[]'::json) as tags
    from library.exercises e
    left join library.places p on p.id = e.place_id
    left join library.complexity_levels c on c.id = e.complexity_level_id
    left join library.starting_positions sp on sp.id = e.starting_position_id
    left join library.attractors a on a.id = e.attractor_id
    where e.id = $2 and ${exerciseScope}
    `,
    [userId, exerciseId],
  );
  return result.rows[0] || null;
}

router.post("/visible-marked", async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      return res.status(400).json({ error: "Invalid marked exercises." });
    }
    const result = await query(`select e.id from library.exercises e where e.id = any($2::uuid[]) and ${exerciseScope}`, [req.user.id, ids]);
    res.json({ ids: result.rows.map((row) => row.id) });
  } catch (error) { next(error); }
});

router.get("/:exerciseId", async (req, res, next) => {
  try {
    const row = await loadExerciseDetail(req.user.id, req.params.exerciseId);
    if (!row) return res.status(404).json({ error: "Exercise not found." });
    res.json({
      id: row.id,
      ownerScope: row.owner_scope,
      sourceExerciseId: row.source_exercise_id || null,
      exerciseCode: row.exercise_code || "",
      name: row.name,
      aim: row.aim || "",
      executionNotes: row.execution_notes || "",
      instruction: row.instruction || "",
      videoUrl: row.video_url || "",
      imageUrl: row.image_url || "",
      place: row.place || "",
      complexity: row.complexity || "",
      startingPosition: row.starting_position || "",
      attractor: row.attractor || "",
      purposes: row.purposes || [],
      qualities: row.qualities || [],
      groups: row.groups || [],
      bodyParts: row.body_parts || [],
      movementPatterns: row.movement_patterns || [],
      tags: row.tags || [],
    });
  } catch (error) { next(error); }
});

async function upsertExercise(req, res, exerciseId, copying = false) {
  const userId = req.user.id;
  const body = req.body || {};
  const name = text(body.name);
  if (!name) { res.status(400).json({ error: "Exercise name is required." }); return; }

  const client = await pool.connect();
  const runQuery = (sql, params) => client.query(sql, params);
  let copySourceId = null;
  let editingSystem = false;
  let exerciseCode = nullableText(body.exerciseCode);
  const videoUrl = nullableText(body.videoUrl);
  const imageUrl = nullableText(body.imageUrl);
  try {
    await runQuery("begin isolation level read committed");
    await runQuery("set local lock_timeout = '2s'");
    await runQuery("set local statement_timeout = '10s'");
    await runQuery("select pg_advisory_xact_lock_shared(hashtextextended('exercise_collections', 0))");
    if (exerciseId) {
      const existing = await runQuery(
        `select e.id, e.owner_scope, e.video_url, e.image_url from library.exercises e where e.id = $2 and ${exerciseScope} for update of e`,
        [userId, exerciseId],
      );
      if (!existing.rows[0]) {
        await runQuery("rollback");
        return res.status(404).json({ error: "Exercise not found." });
      }
      if (copying && existing.rows[0].owner_scope !== "system") {
        await runQuery("rollback");
        return res.status(403).json({ error: "Only application exercises can be copied." });
      }
      if (!copying && existing.rows[0].owner_scope === "system" && !isPlatformAdministrator(req.authz)) {
        await runQuery("rollback");
        return res.status(403).json({ error: "Only platform administrators can edit application exercises." });
      }
      editingSystem = !copying && existing.rows[0].owner_scope === "system";
      if (copying) {
        copySourceId = exerciseId;
        const personal = await runQuery(
          "select id, exercise_code from library.exercises where owner_scope = 'user' and owner_user_id = $1 and source_exercise_id = $2 for update",
          [userId, copySourceId],
        );
        if (personal.rows[0]) {
          await runQuery("rollback");
          return res.status(409).json({ error: "You already have a private copy. Edit that copy instead.", exerciseId: personal.rows[0].id });
        }
        const sourceMedia = [existing.rows[0].video_url, existing.rows[0].image_url].map(nullableText).filter(Boolean);
        if ([videoUrl, imageUrl].some((value) => value && sourceMedia.includes(value))) {
          await runQuery("rollback");
          return res.status(400).json({ error: "A private copy must use your own media, not the application's media URLs." });
        }
        exerciseId = null;
        exerciseCode = null;
      }
    }
    const placeId = await getOrCreateLookup("places", body.place, userId, {}, runQuery, editingSystem);
    const complexityId = await getOrCreateLookup("complexity_levels", body.complexity, userId, {}, runQuery, editingSystem);
    const startingPositionId = await getOrCreateLookup("starting_positions", body.startingPosition, userId, {}, runQuery, editingSystem);
    const attractorId = await getOrCreateLookup("attractors", body.attractor, userId, { kind: "local" }, runQuery, editingSystem);

    let finalId = exerciseId;
    if (exerciseId) {
      await runQuery(
        `update library.exercises set
           exercise_code = $2, name = $3, aim = $4, execution_notes = $5, instruction = $6,
           video_url = $7, image_url = $8, place_id = $9, complexity_level_id = $10,
           starting_position_id = $11, attractor_id = $12, updated_at = now()
         where id = $1`,
        [exerciseId, exerciseCode, name, nullableText(body.aim), nullableText(body.executionNotes),
          nullableText(body.instruction), videoUrl, imageUrl, placeId, complexityId,
          startingPositionId, attractorId],
      );
    } else {
      const inserted = await runQuery(
        `insert into library.exercises
           (owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name, aim, execution_notes,
            instruction, video_url, image_url, place_id, complexity_level_id, starting_position_id, attractor_id, source_exercise_id)
         values ('user', $1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         returning id`,
        [userId, exerciseCode, `private-${randomUUID()}`, name, nullableText(body.aim), nullableText(body.executionNotes),
          nullableText(body.instruction), videoUrl, imageUrl, placeId, complexityId,
          startingPositionId, attractorId, copySourceId],
      );
      finalId = inserted.rows[0].id;
    }

    const domainIds = await Promise.all(splitNames(body.purposes).map((value) => getOrCreateLookup("domains", value, userId, {}, runQuery, editingSystem)));
    const categoryIds = await Promise.all(splitNames(body.qualities).map((value) => getOrCreateLookup("categories", value, userId, {}, runQuery, editingSystem)));
    const sectionIds = await Promise.all(splitNames(body.groups).map((value) => getOrCreateLookup("sections", value, userId, {}, runQuery, editingSystem)));
    const bodyPartIds = await Promise.all(splitNames(body.bodyParts).map((value) => getOrCreateLookup("body_parts", value, userId, {}, runQuery, editingSystem)));
    const movementPatternIds = await Promise.all(splitNames(body.movementPatterns).map((value) => getOrCreateLookup("movement_patterns", value, userId, {}, runQuery, editingSystem)));

    await syncJunction("exercise_domains", "domain_id", "domains", finalId, domainIds.filter(Boolean), userId, { runQuery });
    await syncJunction("exercise_categories", "category_id", "categories", finalId, categoryIds.filter(Boolean), userId, { runQuery });
    await syncJunction("exercise_sections", "section_id", "sections", finalId, sectionIds.filter(Boolean), userId, { runQuery });
    await syncJunction("exercise_body_parts", "body_part_id", "body_parts", finalId, bodyPartIds.filter(Boolean), userId, { runQuery });
    await syncJunction("exercise_movement_patterns", "movement_pattern_id", "movement_patterns", finalId, movementPatternIds.filter(Boolean), userId, { runQuery });
    if (Array.isArray(body.tags)) {
      const names = splitNames(body.tags);
      if (names.some((value) => value.length > 200)) {
        await runQuery("rollback");
        return res.status(400).json({ error: "Tag names must contain 1 to 200 characters." });
      }
      await runQuery(`delete from library.exercise_personal_tags
        where user_id=$1 and exercise_id=$2 and not (lower(name)=any($3::text[]))`,
      [userId, finalId, names.map((value) => value.toLowerCase())]);
      for (const name of names) {
        await runQuery(`insert into library.exercise_personal_tags (user_id,exercise_id,name)
          select $1,$2,$3 where not exists (
            select 1 from library.exercise_tags et join library.tags t on t.id=et.tag_id
            where et.exercise_id=$2 and lower(t.name)=lower($3) and t.is_active=true
              and (t.owner_scope='system' or t.owner_user_id=$1))
          on conflict (user_id,exercise_id,lower(name)) do nothing`, [userId, finalId, name]);
      }
    }

    const detail = await loadExerciseDetail(userId, finalId, runQuery);
    if (!detail) {
      await runQuery("rollback");
      return res.status(404).json({ error: "Exercise not found." });
    }
    await runQuery("commit");
    res.status(exerciseId ? 200 : 201).json({
      id: detail.id,
      ownerScope: detail.owner_scope,
      sourceExerciseId: detail.source_exercise_id || null,
      copiedFromSystem: Boolean(copySourceId),
      exerciseCode: detail.exercise_code || "",
      name: detail.name,
      aim: detail.aim || "",
      executionNotes: detail.execution_notes || "",
      instruction: detail.instruction || "",
      videoUrl: detail.video_url || "",
      imageUrl: detail.image_url || "",
      place: detail.place || "",
      complexity: detail.complexity || "",
      startingPosition: detail.starting_position || "",
      attractor: detail.attractor || "",
      purposes: detail.purposes || [],
      qualities: detail.qualities || [],
      groups: detail.groups || [],
      bodyParts: detail.body_parts || [],
      movementPatterns: detail.movement_patterns || [],
      tags: detail.tags || [],
    });
  } catch (error) {
    try { await runQuery("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

router.post("/", async (req, res, next) => {
  try {
    await upsertExercise(req, res, null);
  } catch (error) { next(error); }
});

router.patch("/:exerciseId", async (req, res, next) => {
  try {
    await upsertExercise(req, res, req.params.exerciseId);
  } catch (error) { next(error); }
});

router.post("/:exerciseId/copy", async (req, res, next) => {
  try {
    await upsertExercise(req, res, req.params.exerciseId, true);
  } catch (error) { next(error); }
});

router.post("/:exerciseId/favorite", async (req, res, next) => {
  try {
    if (!(await exerciseExistsForUser(req.user.id, req.params.exerciseId))) return res.status(404).json({ error: "Exercise not found." });
    await query(
      `insert into library.exercise_favorites (user_id, exercise_id)
       select $1, e.id
       from library.exercises e
       where e.id = $2 and ${exerciseScope}
       on conflict (user_id, exercise_id) do nothing`,
      [req.user.id, req.params.exerciseId],
    );
    res.json({ ok: true, isFavorite: true });
  } catch (error) {
    next(error);
  }
});

router.delete("/:exerciseId/favorite", async (req, res, next) => {
  try {
    if (!(await exerciseExistsForUser(req.user.id, req.params.exerciseId))) return res.status(404).json({ error: "Exercise not found." });
    await query(
      `delete from library.exercise_favorites
       where user_id = $1 and exercise_id = $2`,
      [req.user.id, req.params.exerciseId],
    );
    res.json({ ok: true, isFavorite: false });
  } catch (error) {
    next(error);
  }
});

router.get("/:exerciseId/tags", async (req, res, next) => {
  try {
    if (!(await exerciseExistsForUser(req.user.id, req.params.exerciseId))) {
      return res.status(404).json({ error: "Exercise not found." });
    }
    const [allTags, exerciseTags, personalTags, personalOptions] = await Promise.all([
      query(
        `select id, name
         from library.tags
         where is_active = true and ${libraryScope}
         order by name`,
        [req.user.id],
      ),
      query(
        `select t.id, t.name, (t.owner_scope <> 'user' or t.owner_user_id is distinct from $1::uuid) as readonly
         from library.exercise_tags et
         join library.tags t on t.id = et.tag_id
         where et.exercise_id = $2
           and t.is_active = true
           and (t.owner_scope = 'system' or t.owner_user_id = $1)
         order by t.name`,
        [req.user.id, req.params.exerciseId],
      ),
      query("select id, name from library.exercise_personal_tags where user_id=$1 and exercise_id=$2 order by name", [req.user.id, req.params.exerciseId]),
      query(`select distinct on (personal.name) personal.id, personal.name
        from library.exercise_personal_tags personal join library.exercises e on e.id=personal.exercise_id
        where personal.user_id=$1 and ${exerciseScope} order by personal.name, personal.id`, [req.user.id]),
    ]);
    res.json({ tags: [...exerciseTags.rows, ...personalTags.rows], options: [...allTags.rows, ...personalOptions.rows] });
  } catch (error) {
    next(error);
  }
});

router.post("/:exerciseId/tags", async (req, res, next) => {
  try {
    if (!(await exerciseExistsForUser(req.user.id, req.params.exerciseId))) {
      return res.status(404).json({ error: "Exercise not found." });
    }
    let name = String(req.body?.name || "").trim();
    const tagId = String(req.body?.tagId || "").trim();
    if (tagId) {
      const selected = await query(`select name from library.tags where id=$2 and is_active=true
        and (owner_scope='system' or owner_user_id=$1)
        union all select personal.name from library.exercise_personal_tags personal
        join library.exercises e on e.id=personal.exercise_id
        where personal.id=$2 and personal.user_id=$1 and ${exerciseScope}`, [req.user.id, tagId]);
      if (!selected.rows[0]) return res.status(404).json({ error: "Tag not found." });
      name = selected.rows[0].name;
    }
    if (!name || name.length > 200) return res.status(400).json({ error: "Tag name must contain 1 to 200 characters." });
    const tag = await query(`insert into library.exercise_personal_tags (user_id,exercise_id,name)
      select $1,e.id,$3 from library.exercises e where e.id=$2 and ${exerciseScope}
      on conflict (user_id,exercise_id,lower(name)) do update set name=library.exercise_personal_tags.name
      returning id,name`, [req.user.id, req.params.exerciseId, name]);
    if (!tag.rows[0]) return res.status(404).json({ error: "Exercise not found." });
    res.status(201).json({ tag: tag.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/:exerciseId/tags/:tagId", async (req, res, next) => {
  try {
    if (!(await exerciseExistsForUser(req.user.id, req.params.exerciseId))) {
      return res.status(404).json({ error: "Exercise not found." });
    }
    const removed = await query(`delete from library.exercise_personal_tags
      where user_id=$1 and exercise_id=$2 and id=$3 returning id`, [req.user.id, req.params.exerciseId, req.params.tagId]);
    if (!removed.rowCount) {
      const legacy = await query(`delete from library.exercise_tags et using library.tags t
        where et.exercise_id=$2 and et.tag_id=$3 and t.id=et.tag_id
          and t.owner_scope='user' and t.owner_user_id=$1 returning et.tag_id`, [req.user.id, req.params.exerciseId, req.params.tagId]);
      if (!legacy.rowCount) return res.status(404).json({ error: "Tag not found." });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

export default router;
