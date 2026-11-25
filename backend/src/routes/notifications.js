import { Router } from "express";
import { query } from "../db.js";
import { athleteTrainingLoadAllowed } from "../athleteTrainingLoadLicence.js";

const athleteRpePromptTypes = [
  "training_load_external_invitation",
  "training_load_external_reminder",
  "training_load_manual_reminder",
];

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 80);
    const athleteId = req.authz?.athleteId;
    const hiddenTypes = athleteId && !(await athleteTrainingLoadAllowed(athleteId)) ? athleteRpePromptTypes : [];
    const [rows, unread] = await Promise.all([
      query(
        `select id, type, title, body, entity_type, entity_id, href, metadata, read_at, created_at
         from public.app_notifications
         where recipient_user_id = $1
           and type <> 'message_received'
           and type <> all($3::text[])
         order by created_at desc
         limit $2`,
        [req.user.id, limit, hiddenTypes],
      ),
      query(
        `select count(*)::int as count
         from public.app_notifications
         where recipient_user_id = $1
           and type <> 'message_received'
           and type <> all($2::text[])
           and read_at is null`,
        [req.user.id, hiddenTypes],
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
         and type <> 'message_received'
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
