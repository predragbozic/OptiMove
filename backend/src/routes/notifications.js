import { Router } from "express";
import { query } from "../db.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 80);
    const [rows, unread] = await Promise.all([
      query(
        `select id, type, title, body, entity_type, entity_id, href, metadata, read_at, created_at
         from public.app_notifications
         where recipient_user_id = $1
         order by created_at desc
         limit $2`,
        [req.user.id, limit],
      ),
      query(
        `select count(*)::int as count
         from public.app_notifications
         where recipient_user_id = $1
           and read_at is null`,
        [req.user.id],
      ),
    ]);
    res.json({ notifications: rows.rows, unreadCount: unread.rows[0]?.count || 0 });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/read", async (req, res, next) => {
  try {
    const result = await query(
      `update public.app_notifications
       set read_at = coalesce(read_at, now())
       where id = $1
         and recipient_user_id = $2
       returning id, read_at`,
      [req.params.id, req.user.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Notification not found." });
    res.json({ notification: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/read-all", async (req, res, next) => {
  try {
    const result = await query(
      `update public.app_notifications
       set read_at = coalesce(read_at, now())
       where recipient_user_id = $1
         and read_at is null
       returning id`,
      [req.user.id],
    );
    res.json({ updated: result.rows.length });
  } catch (error) {
    next(error);
  }
});

export default router;
