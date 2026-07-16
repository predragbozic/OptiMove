import { query } from "./db.js";
import { emitRealtimeEventForUsers } from "./realtime.js";

export async function ensureConversationForContactRequest(contactRequestId, actorUserId = null) {
  const contact = await query(
    `select ccr.id, ccr.coach_profile_id, ccr.sender_user_id, ccr.sender_name, ccr.sender_email,
            ccr.message, ccr.conversation_id, cp.user_id as coach_user_id
     from public.coach_contact_requests ccr
     join public.coach_profiles cp on cp.id = ccr.coach_profile_id
     where ccr.id = $1`,
    [contactRequestId],
  );
  const row = contact.rows[0];
  if (!row || !row.sender_user_id || !row.coach_user_id) return null;
  if (row.conversation_id) return row.conversation_id;

  const conversation = await query(
    `insert into public.message_conversations (
       conversation_type, created_by_user_id, source_type, source_id, last_message_at
     )
     values ('coach_contact', $1, 'coach_contact_request', $2, now())
     returning id`,
    [actorUserId || row.coach_user_id, row.id],
  );
  const conversationId = conversation.rows[0].id;
  await query(
    `insert into public.message_participants (conversation_id, user_id, participant_role, last_read_at)
     values ($1, $2, 'owner', now()), ($1, $3, 'member', null)
     on conflict (conversation_id, user_id) do nothing`,
    [conversationId, row.coach_user_id, row.sender_user_id],
  );
  await query(
    `insert into public.messages (conversation_id, sender_user_id, body)
     values ($1, $2, $3)`,
    [conversationId, row.sender_user_id, row.message],
  );
  await query(
    `update public.coach_contact_requests
     set conversation_id = $2,
         updated_at = now()
     where id = $1`,
    [row.id, conversationId],
  );
  emitRealtimeEventForUsers([row.coach_user_id, row.sender_user_id], "messages_changed", {
    conversationId,
    source: "coach_contact_request",
  });
  return conversationId;
}

export async function userCanAccessConversation(userId, conversationId) {
  const result = await query(
    `select mp.conversation_id, mp.blocked_at,
            exists (
              select 1
              from public.message_participants other_mp
              where other_mp.conversation_id = mp.conversation_id
                and other_mp.user_id <> mp.user_id
                and other_mp.blocked_at is not null
            ) as blocked_by_other
     from public.message_participants mp
     where mp.conversation_id = $1
       and mp.user_id = $2`,
    [conversationId, userId],
  );
  return result.rows[0] || null;
}

export async function sendConversationMessage({ conversationId, senderUserId, body }) {
  const access = await userCanAccessConversation(senderUserId, conversationId);
  if (!access) {
    const error = new Error("Conversation not found.");
    error.status = 404;
    throw error;
  }
  if (access.blocked_at || access.blocked_by_other) {
    const error = new Error("This conversation is blocked.");
    error.status = 403;
    throw error;
  }
  const cleanBody = String(body || "").trim();
  if (!cleanBody) {
    const error = new Error("Message is required.");
    error.status = 400;
    throw error;
  }
  const message = await query(
    `insert into public.messages (conversation_id, sender_user_id, body)
     values ($1, $2, $3)
     returning id, conversation_id, sender_user_id, body, created_at`,
    [conversationId, senderUserId, cleanBody],
  );
  await query(
    `update public.message_conversations
     set last_message_at = now(),
         updated_at = now()
     where id = $1`,
    [conversationId],
  );
  await query(
    `update public.message_participants
     set last_read_at = now()
     where conversation_id = $1
       and user_id = $2`,
    [conversationId, senderUserId],
  );
  const participants = await query(
    `select user_id
     from public.message_participants
     where conversation_id = $1`,
    [conversationId],
  );
  emitRealtimeEventForUsers(participants.rows.map((row) => row.user_id), "messages_changed", {
    conversationId,
    messageId: message.rows[0].id,
  });
  return message.rows[0];
}
