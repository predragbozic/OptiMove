import { Router } from "express";
import { query } from "../db.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const queryLimit = limit + 1;
    const params = [];
    let where = "where e.is_active = true";

    if (search) {
      params.push(`%${search}%`);
      where += ` and (e.name ilike $${params.length} or e.exercise_code ilike $${params.length})`;
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
        c.name as complexity
      from library.exercises e
      left join library.places p on p.id = e.place_id
      left join library.complexity_levels c on c.id = e.complexity_level_id
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

export default router;
