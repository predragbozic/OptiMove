import { Router } from "express";
import { query } from "../db.js";
import { sendConversationMessage, userCanAccessConversation } from "../messages.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const rows = await query(
      `select c.id, c.conversation_type, c.title, c.last_message_at, c.updated_at,
              me.blocked_at is not null as blocked_by_me,
              exists (
                select 1
                from public.message_participants other_block
                where other_block.conversation_id = c.id
                  and other_block.user_id <> $1
                  and other_block.blocked_at is not null
              ) as blocked_by_other,
              coalesce(last_message.body, '') as last_message,
              last_message.created_at as last_message_created_at,
              coalesce(unread.unread_count, 0)::int as unread_count,
              coalesce(participants.participants, '[]'::jsonb) as participants
       from public.message_participants me
       join public.message_conversations c on c.id = me.conversation_id
       left join lateral (
         select m.body, m.created_at
         from public.messages m
         where m.conversation_id = c.id
           and m.deleted_at is null
         order by m.created_at desc
         limit 1
       ) last_message on true
       left join lateral (
         select count(*)::int as unread_count
         from public.messages m
         where m.conversation_id = c.id
           and m.sender_user_id is distinct from $1
           and m.deleted_at is null
           and (me.last_read_at is null or m.created_at > me.last_read_at)
       ) unread on true
       left join lateral (
         select jsonb_agg(jsonb_build_object(
           'userId', u.id,
           'name', coalesce(nullif(u.display_name, ''), nullif(u.full_name, ''), u.email),
           'email', u.email,
           'role', u.role_hint
         ) order by u.email) as participants
         from public.message_participants mp
         join public.users u on u.id = mp.user_id
         where mp.conversation_id = c.id
       ) participants on true
       where me.user_id = $1
       order by coalesce(c.last_message_at, c.updated_at, c.created_at) desc`,
      [req.user.id],
    );
    const unreadCount = rows.rows.reduce((sum, row) => sum + Number(row.unread_count || 0), 0);
    res.json({ conversations: rows.rows, unreadCount });
  } catch (error) {
    next(error);
  }
});

router.get("/:conversationId", async (req, res, next) => {
  try {
    const access = await userCanAccessConversation(req.user.id, req.params.conversationId);
    if (!access) return res.status(404).json({ error: "Conversation not found." });
    const [conversation, messages] = await Promise.all([
      query(
        `select c.id, c.conversation_type, c.title, c.last_message_at,
                mp.blocked_at is not null as blocked_by_me,
                exists (
                  select 1
                  from public.message_participants other_block
                  where other_block.conversation_id = c.id
                    and other_block.user_id <> $2
                    and other_block.blocked_at is not null
                ) as blocked_by_other,
                coalesce(participants.participants, '[]'::jsonb) as participants
         from public.message_conversations c
         join public.message_participants mp on mp.conversation_id = c.id and mp.user_id = $2
         left join lateral (
           select jsonb_agg(jsonb_build_object(
             'userId', u.id,
             'name', coalesce(nullif(u.display_name, ''), nullif(u.full_name, ''), u.email),
             'email', u.email,
             'role', u.role_hint
           ) order by u.email) as participants
           from public.message_participants all_mp
           join public.users u on u.id = all_mp.user_id
           where all_mp.conversation_id = c.id
         ) participants on true
         where c.id = $1`,
        [req.params.conversationId, req.user.id],
      ),
      query(
        `select m.id, m.conversation_id, m.sender_user_id, m.body, m.created_at,
                coalesce(nullif(u.display_name, ''), nullif(u.full_name, ''), u.email) as sender_name
         from public.messages m
         left join public.users u on u.id = m.sender_user_id
         where m.conversation_id = $1
           and m.deleted_at is null
         order by m.created_at asc`,
        [req.params.conversationId],
      ),
    ]);
    if (!conversation.rows[0]) return res.status(404).json({ error: "Conversation not found." });
    await query(
      `update public.message_participants
       set last_read_at = now()
       where conversation_id = $1
         and user_id = $2`,
      [req.params.conversationId, req.user.id],
    );
    res.json({ conversation: conversation.rows[0], messages: messages.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/:conversationId/messages", async (req, res, next) => {
  try {
    const message = await sendConversationMessage({
      conversationId: req.params.conversationId,
      senderUserId: req.user.id,
      body: req.body?.body,
    });
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.post("/:conversationId/block", async (req, res, next) => {
  try {
    const blocked = req.body?.blocked !== false && req.body?.blocked !== "false";
    const result = await query(
      `update public.message_participants
       set blocked_at = case when $3::boolean then now() else null end,
           blocked_by_user_id = case when $3::boolean then $2 else null end
       where conversation_id = $1
         and user_id = $2
       returning conversation_id, blocked_at`,
      [req.params.conversationId, req.user.id, blocked],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Conversation not found." });
    res.json({ blocked: Boolean(result.rows[0].blocked_at) });
  } catch (error) {
    next(error);
  }
});

export default router;
