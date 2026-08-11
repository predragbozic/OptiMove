import { pool, query } from "./db.js";
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

  const existing = await query(
    `select c.id
     from public.message_conversations c
     join public.message_participants coach_mp
       on coach_mp.conversation_id = c.id
      and coach_mp.user_id = $1
     join public.message_participants sender_mp
       on sender_mp.conversation_id = c.id
      and sender_mp.user_id = $2
     where c.conversation_type = 'coach_contact'
     order by c.last_message_at desc nulls last, c.updated_at desc
     limit 1`,
    [row.coach_user_id, row.sender_user_id],
  );
  if (existing.rows[0]?.id) {
    const conversationId = existing.rows[0].id;
    await query(
      `update public.message_participants
       set blocked_at = null,
           blocked_by_user_id = null,
           hidden_at = null
       where conversation_id = $1
         and user_id in ($2, $3)`,
      [conversationId, row.coach_user_id, row.sender_user_id],
    );
    await query(
      `insert into public.messages (conversation_id, sender_user_id, body)
       values ($1, $2, $3)`,
      [conversationId, row.sender_user_id, row.message],
    );
    await query(
      `update public.message_conversations
       set last_message_at = now(),
           updated_at = now()
       where id = $1`,
      [conversationId],
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
      reused: true,
    });
    return conversationId;
  }

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

// hotfix/direct-coach-conversation-race: shared lock namespace for the
// "does a direct/coach_contact conversation between this exact pair of
// users already exist" decision, same pg_advisory_xact_lock(namespace,
// hashtext(key)) pattern already used throughout this codebase (see
// inviteContext.js's ATHLETE_INVITE_ACTION_LOCK_NAMESPACE=719402583,
// joinLinkContext.js's JOIN_LINK_ACTION_LOCK_NAMESPACE=719402617 and
// APPLICANT_ATHLETE_CREATION_LOCK_NAMESPACE=719402629,
// passwordReset.js's PASSWORD_RESET_ACTION_LOCK_NAMESPACE=719402651,
// accountEmailChange.js's ACCOUNT_EMAIL_CHANGE_ACTION_LOCK_NAMESPACE=719402663,
// organization.js's PLATFORM_ADMIN_HEADCOUNT_LOCK_KEY=726354981 and
// CLUB_ADMIN_HEADCOUNT_LOCK_NAMESPACE=891234567) - never reused, never
// changed, carries no meaning beyond "this one lock namespace".
// pg_advisory_xact_lock auto-releases at transaction end (commit or
// rollback); never pair it with pg_advisory_unlock.
const DIRECT_COACH_CONVERSATION_LOCK_NAMESPACE = 719402677;

// Keyed on the unordered PAIR of users, sorted before joining, so it is the
// exact same lock regardless of which side (athlete or coach) happens to
// call ensureDirectCoachConversation first, or in what argument order.
async function lockDirectCoachConversationPair(client, athleteUserId, coachUserId) {
  const pairKey = [String(athleteUserId), String(coachUserId)].sort().join(":");
  await client.query(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [DIRECT_COACH_CONVERSATION_LOCK_NAMESPACE, pairKey]);
}

// feature/athlete-home-mvp, hotfix/direct-coach-conversation-race: lets an
// athlete open (or start) a conversation with a coach they genuinely train
// under, directly from the Coaches view's "Message" button - no separate
// Contact modal/approval step, since the trust relationship (an active
// public.user_athletes relationship_type='coach' row) already exists and
// was established elsewhere (an invite/assignment flow), unlike the
// cold-contact case coach_contact_requests exists for. Mirrors coaches.js's
// own is_my_coach column - same underlying rule, checked again here
// server-side rather than trusted from the client.
//
// The whole relationship-check + lookup + create + add-participants flow
// runs inside ONE transaction, on ONE checked-out client, guarded by
// lockDirectCoachConversationPair - never the pooled query() helper for any
// of these steps, since query() borrows a fresh connection per call and
// could never participate in this transaction. Two concurrent calls for
// the same pair serialize on the advisory lock: the loser only ever
// proceeds past BEGIN once the winner has committed (or rolled back), so it
// re-reads a state that already reflects the winner's write - it can never
// observe the pre-insert state and create a second conversation. This is a
// genuine DB-enforced guarantee, not a UX nicety: the frontend's own
// disable-while-pending guard (coach-profile-actions.js /
// app.js's "coach-message" handler) only prevents an accidental
// double-click from firing a second HTTP request in the common case - it
// is not trusted here for correctness, since nothing stops two independent
// hand-crafted concurrent requests from reaching this function at once.
//
// Idempotent by lookup: an existing conversation between these exact two
// users is reused rather than duplicated - but only one that is actually a
// two-person direct conversation between them: conversation_type must be
// 'direct' or 'coach_contact' (the earlier two-sided type this can also
// have started as, if the coach already accepted a coach_contact_requests
// row), AND the conversation must have EXACTLY these two participants, no
// third. A group conversation, or any conversation where one of these two
// users merely happens to also be a participant alongside others, is never
// reused - opening "their" direct conversation must never surface someone
// else's messages or add them to a conversation they weren't part of.
export async function ensureDirectCoachConversation({ athleteUserId, coachUserId }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockDirectCoachConversationPair(client, athleteUserId, coachUserId);

    // Re-checked AFTER the lock is acquired, inside the transaction - never
    // trust a relationship read from before the lock (or from outside this
    // transaction) as still current.
    const relationship = await client.query(
      `select 1
       from public.athletes viewer_athlete
       join public.user_athletes coach_rel
         on coach_rel.athlete_id = viewer_athlete.id
        and coach_rel.user_id = $2
        and coach_rel.relationship_type = 'coach'
        and coach_rel.is_active = true
       where coalesce(viewer_athlete.is_active, true)
         and (
           viewer_athlete.user_id = $1
           or exists (
             select 1
             from public.user_athletes athlete_link
             where athlete_link.athlete_id = viewer_athlete.id
               and athlete_link.user_id = $1
               and athlete_link.relationship_type = 'athlete'
               and athlete_link.is_active = true
           )
         )
       limit 1`,
      [athleteUserId, coachUserId],
    );
    if (!relationship.rows[0]) {
      const error = new Error("You can only message a coach you currently train under.");
      error.status = 403;
      throw error;
    }

    const existing = await client.query(
      `select c.id
       from public.message_conversations c
       where c.conversation_type in ('direct', 'coach_contact')
         and exists (
           select 1 from public.message_participants coach_mp
           where coach_mp.conversation_id = c.id and coach_mp.user_id = $1
         )
         and exists (
           select 1 from public.message_participants athlete_mp
           where athlete_mp.conversation_id = c.id and athlete_mp.user_id = $2
         )
         and (
           select count(*) from public.message_participants all_mp
           where all_mp.conversation_id = c.id
         ) = 2
       order by c.last_message_at desc nulls last, c.updated_at desc
       limit 1`,
      [coachUserId, athleteUserId],
    );

    let conversationId;
    if (existing.rows[0]?.id) {
      conversationId = existing.rows[0].id;
      // Reopening a conversation either side previously blocked/hid must not
      // silently resurrect a relationship the coach deliberately blocked -
      // only clear the ATHLETE's own hidden flag, never touch blocked_at for
      // either participant.
      await client.query(
        `update public.message_participants
         set hidden_at = null
         where conversation_id = $1
           and user_id = $2`,
        [conversationId, athleteUserId],
      );
    } else {
      const conversation = await client.query(
        `insert into public.message_conversations (conversation_type, created_by_user_id, last_message_at)
         values ('direct', $1, null)
         returning id`,
        [athleteUserId],
      );
      conversationId = conversation.rows[0].id;
      // Deliberately no "on conflict do nothing" here - with the pair lock
      // held for the whole transaction there is no legitimate way this can
      // race, so a constraint violation (e.g. a duplicate user_id, which
      // can only happen if athleteUserId === coachUserId) is a real bug
      // that must surface loudly and roll back the conversation row just
      // inserted above, not be silently swallowed.
      await client.query(
        `insert into public.message_participants (conversation_id, user_id, participant_role, last_read_at)
         values ($1, $2, 'owner', now()), ($1, $3, 'member', now())`,
        [conversationId, coachUserId, athleteUserId],
      );
    }

    await client.query("commit");
    return conversationId;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
  await query(
    `update public.message_participants
     set hidden_at = null
     where conversation_id = $1`,
    [conversationId],
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
