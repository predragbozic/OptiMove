import { query } from "./db.js";

export async function createNotification({
  recipientUserId,
  actorUserId = null,
  type,
  title,
  body = "",
  entityType = null,
  entityId = null,
  href = null,
  metadata = {},
}) {
  if (!recipientUserId || !type || !title) return null;
  try {
    const result = await query(
      `insert into public.app_notifications (
         recipient_user_id, actor_user_id, type, title, body, entity_type, entity_id, href, metadata
       )
       values ($1, $2, $3, $4, nullif(trim($5::text), ''), $6, $7, nullif(trim($8::text), ''), $9::jsonb)
       returning id, recipient_user_id, type, title, body, read_at, created_at`,
      [
        recipientUserId,
        actorUserId,
        type,
        title,
        body,
        entityType,
        entityId,
        href,
        JSON.stringify(metadata || {}),
      ],
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Notification insert failed", error);
    return null;
  }
}
