import { Router } from "express";
import { query } from "../db.js";

const router = Router();

const exerciseScope = "e.is_active = true and (e.owner_scope = 'system' or e.owner_user_id = $1)";
const libraryScope = `(
  owner_scope = 'system'
  or owner_user_id = $1
  or (owner_scope = 'club' and owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
  or (owner_scope = 'team' and owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true))
)`;

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
    select distinct name
    from library.tags
    where is_active = true and ${libraryScopeWithHidden("tags", "tag")}
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
        (fav.user_id is not null) as is_favorite,
        coalesce(
          (
            select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name)
            from library.exercise_tags et
            join library.tags t on t.id = et.tag_id
            where et.exercise_id = e.id
              and t.is_active = true
              and (t.owner_scope = 'system' or t.owner_user_id = $1)
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

router.get("/:exerciseId/tags", async (req, res, next) => {
  try {
    if (!(await exerciseExistsForUser(req.user.id, req.params.exerciseId))) {
      return res.status(404).json({ error: "Exercise not found." });
    }
    const [allTags, exerciseTags] = await Promise.all([
      query(
        `select id, name
         from library.tags
         where is_active = true and ${libraryScope}
         order by name`,
        [req.user.id],
      ),
      query(
        `select t.id, t.name
         from library.exercise_tags et
         join library.tags t on t.id = et.tag_id
         where et.exercise_id = $2
           and t.is_active = true
           and ${libraryScope}
         order by t.name`,
        [req.user.id, req.params.exerciseId],
      ),
    ]);
    res.json({ tags: exerciseTags.rows, options: allTags.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/:exerciseId/tags", async (req, res, next) => {
  try {
    if (!(await exerciseExistsForUser(req.user.id, req.params.exerciseId))) {
      return res.status(404).json({ error: "Exercise not found." });
    }
    const name = String(req.body?.name || "").trim();
    const tagId = String(req.body?.tagId || "").trim();
    let finalTagId = tagId;

    if (!finalTagId) {
      if (!name) return res.status(400).json({ error: "Tag name is required." });
      const slug = slugify(name);
      const created = await query(
        `insert into library.tags (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
         values ($1, concat($2, '-', substring(gen_random_uuid()::text from 1 for 8)), 'user', $3, $3, true)
         on conflict (name) do nothing
         returning id`,
        [name, slug, req.user.id],
      );
      if (created.rows[0]?.id) {
        finalTagId = created.rows[0].id;
      } else {
        const existing = await query(
          `select id
           from library.tags
           where lower(name) = lower($2) and is_active = true and ${libraryScope}`,
          [req.user.id, name],
        );
        if (!existing.rows[0]) return res.status(409).json({ error: "Tag name already exists outside your library." });
        finalTagId = existing.rows[0].id;
      }
    }

    const tag = await query(
      `select id, name
       from library.tags
       where id = $2 and is_active = true and ${libraryScope}`,
      [req.user.id, finalTagId],
    );
    if (!tag.rows[0]) return res.status(404).json({ error: "Tag not found." });

    await query(
      `insert into library.exercise_tags (exercise_id, tag_id)
       values ($1, $2)
       on conflict (exercise_id, tag_id) do nothing`,
      [req.params.exerciseId, finalTagId],
    );
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
    await query(
      `delete from library.exercise_tags
       where exercise_id = $1 and tag_id = $2`,
      [req.params.exerciseId, req.params.tagId],
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

export default router;
