import { Router } from "express";
import { query } from "../db.js";

const router = Router();

const exerciseScope = "e.is_active = true and (e.owner_scope = 'system' or e.owner_user_id = $1)";

const optionQueries = {
  purposes: `
    select distinct d.name
    from library.exercises e
    join library.exercise_domains ed on ed.exercise_id = e.id
    join library.domains d on d.id = ed.domain_id
    where ${exerciseScope} and d.is_active = true
    order by d.name`,
  qualities: `
    select distinct c.name
    from library.exercises e
    join library.exercise_categories ec on ec.exercise_id = e.id
    join library.categories c on c.id = ec.category_id
    where ${exerciseScope} and c.is_active = true
    order by c.name`,
  groups: `
    select distinct s.name
    from library.exercises e
    join library.exercise_sections es on es.exercise_id = e.id
    join library.sections s on s.id = es.section_id
    where ${exerciseScope} and s.is_active = true
    order by s.name`,
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
    select distinct sp.name
    from library.exercises e
    join library.starting_positions sp on sp.id = e.starting_position_id
    where ${exerciseScope} and sp.is_active = true
    order by sp.name`,
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
    select distinct a.name
    from library.exercises e
    join library.attractors a on a.id = e.attractor_id
    where ${exerciseScope} and a.is_active = true
    order by a.name`,
  tags: `
    select distinct t.name
    from library.exercises e
    join library.exercise_tags et on et.exercise_id = e.id
    join library.tags t on t.id = et.tag_id
    where ${exerciseScope} and t.is_active = true
    order by t.name`,
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
    const params = [req.user.id];
    let where = `where ${exerciseScope}`;

    if (search) {
      params.push(`%${search}%`);
      where += ` and (e.name ilike $${params.length} or e.exercise_code ilike $${params.length})`;
    }

    const addExistsFilter = (value, sql) => {
      if (!value) return;
      params.push(value);
      where += ` and exists (${sql.replace("?", `$${params.length}`)})`;
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
      where et.exercise_id = e.id and t.name = ?`);

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
    const result = await query(
      `
      select
        e.id,
        e.exercise_code,
        e.name,
        e.aim,
        e.execution_notes,
        e.instruction,
        e.video_url,
        e.image_url,
        p.name as place,
        c.name as complexity,
        sp.name as starting_position,
        a.name as attractor,
        (fav.user_id is not null) as is_favorite
      from library.exercises e
      left join library.places p on p.id = e.place_id
      left join library.complexity_levels c on c.id = e.complexity_level_id
      left join library.starting_positions sp on sp.id = e.starting_position_id
      left join library.attractors a on a.id = e.attractor_id
      left join library.exercise_favorites fav on fav.exercise_id = e.id and fav.user_id = $1
      ${where}
      order by nullif(regexp_replace(e.exercise_code, '\\D', '', 'g'), '')::int nulls last, e.name
      limit $${params.length}
      `,
      params,
    );
    res.json({
      exercises: result.rows.slice(0, limit),
      hasMore: result.rows.length > limit,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:exerciseId/favorite", async (req, res, next) => {
  try {
    await query(
      `insert into library.exercise_favorites (user_id, exercise_id)
       select $1, e.id
       from library.exercises e
       where e.id = $2 and e.is_active = true and (e.owner_scope = 'system' or e.owner_user_id = $1)
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

export default router;
