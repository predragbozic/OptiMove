import { Router } from "express";
import { query } from "../db.js";
import { ensureDirectCoachConversation, sendConversationMessage, userCanAccessConversation } from "../messages.js";

const router = Router();

// hotfix/mobile-messages-test-regression: participant photo sourcing.
// Audited every candidate column before picking these two: athletes.
// image_url (the self-service field athletes manage via Settings' Personal
// data form) and coach_profiles.photo_url (the equivalent self-service
// profile photo coaches manage). users.image_url/image_mime_type also exist
// in the schema but have zero application code anywhere reading or writing
// them - dead columns from an earlier design, not a real, currently-used
// avatar source, so they are deliberately not used here. No role_hint
// involved anywhere in this priority - both columns are looked up directly
// off the real athletes/coach_profiles tables.
// coach_profiles.user_id and athletes.user_id are both uniquely indexed
// (coach_profiles_user_id_key, athletes_user_id_unique), so a plain LEFT
// JOIN on either can never multiply a participant's row.
// Priority for a multi-role account (both an active athlete row AND a
// coach_profiles row): ATHLETE photo wins. A user with a real athlete
// profile must see their own athlete photo in Messages, even if they also
// hold a coach profile with a different photo. Both queries below use the
// identical `coalesce(ath.image_url, cp.photo_url, '')` expression, so
// changing the priority again only ever means editing this one expression
// in both places.
// Both LEFT JOINs are added to the SAME per-conversation participants
// lateral subquery that already existed (building the participants array),
// not a new subquery - the query still runs exactly once per conversation
// row, same as before this change, so no N+1 is introduced.

// feature/athlete-home-mvp: the ONLY way to open a conversation with a
// specific person without going through the coach_contact_requests
// approval detour - deliberately narrow (athlete -> a coach they actually
// train under, checked again server-side in ensureDirectCoachConversation,
// never trusted from the client) rather than a general "message any user"
// endpoint. Returns the conversation id; the frontend then reuses the
// exact same GET /api/messages/:conversationId / openMessageConversation
// flow every other conversation already uses - no separate reply/thread
// code path exists for this one.
router.post("/direct", async (req, res, next) => {
  try {
    const coachUserId = String(req.body?.coachUserId || "").trim();
    if (!coachUserId) return res.status(400).json({ error: "INVALID_COACH" });
    const conversationId = await ensureDirectCoachConversation({ athleteUserId: req.user.id, coachUserId });
    res.json({ conversationId });
  } catch (error) {
    next(error);
  }
});

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
           'role', u.role_hint,
           'imageUrl', coalesce(ath.image_url, cp.photo_url, '')
         ) order by u.email) as participants
         from public.message_participants mp
         join public.users u on u.id = mp.user_id
         left join public.coach_profiles cp on cp.user_id = u.id
         left join public.athletes ath on ath.user_id = u.id
         where mp.conversation_id = c.id
       ) participants on true
       where me.user_id = $1
         and me.hidden_at is null
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
             'role', u.role_hint,
             'imageUrl', coalesce(ath.image_url, cp.photo_url, '')
           ) order by u.email) as participants
           from public.message_participants all_mp
           join public.users u on u.id = all_mp.user_id
           left join public.coach_profiles cp on cp.user_id = u.id
           left join public.athletes ath on ath.user_id = u.id
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

router.post("/:conversationId/hide", async (req, res, next) => {
  try {
    const result = await query(
      `update public.message_participants
       set hidden_at = now(),
           last_read_at = now()
       where conversation_id = $1
         and user_id = $2
       returning conversation_id`,
      [req.params.conversationId, req.user.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Conversation not found." });
    res.json({ hidden: true });
  } catch (error) {
    next(error);
  }
});

export default router;
