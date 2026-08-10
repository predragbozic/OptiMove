// Verified account login-email change (security/verified-email-change) -
// shared helpers for public.account_email_change_tokens
// (migrations/20260811_account_email_change.sql). Mirrors the shape of
// backend/src/passwordReset.js on purpose (hash/issue/mark-sent/throttle/
// per-user advisory lock), but is its own module with its own state - this
// flow must never share a rate-limit map or lock namespace with password
// reset or email verification.
import crypto from "node:crypto";

export function hashEmailChangeToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

// 30 minutes - same window password_reset_tokens uses, for the same
// reasoning (see passwordReset.js's own header comment): long enough that a
// real inbox check isn't a race against the clock, short enough that a
// stale, unused link stops being useful quickly.
export const ACCOUNT_EMAIL_CHANGE_TOKEN_TTL_MS = 30 * 60 * 1000;

// Same 60-second shape as passwordReset.js/emailVerification.js - keyed off
// sent_at (see loadLastAccountEmailChangeTokenSentAt below), never
// created_at, so a token whose send attempt failed never blocks an
// immediate retry.
export const ACCOUNT_EMAIL_CHANGE_RESEND_MIN_INTERVAL_MS = 60 * 1000;

// Shared advisory-lock namespace for every mutation that can affect a given
// user's pending email-change state (issuing a new token via request,
// resend, or admin-request; consuming one via confirm; revoking one via
// cancel) - keyed by user_id alone. A distinct constant from every other
// lock namespace in this codebase (see passwordReset.js's own header
// comment for the full documented list: inviteContext.js=719402583,
// joinLinkContext.js=719402617/719402629, passwordReset.js=719402651,
// organization.js's PLATFORM_ADMIN_HEADCOUNT_LOCK_KEY=726354981 and
// CLUB_ADMIN_HEADCOUNT_LOCK_NAMESPACE=891234567) - never reused, never
// changed. pg_advisory_xact_lock auto-releases at transaction end (commit
// or rollback); never paired with pg_advisory_unlock.
const ACCOUNT_EMAIL_CHANGE_ACTION_LOCK_NAMESPACE = 719402663;

export async function lockAccountEmailChangeActions(executor, userId) {
  await executor(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [ACCOUNT_EMAIL_CHANGE_ACTION_LOCK_NAMESPACE, String(userId)]);
}

// Revokes any existing active token for this user - called both right
// before issuing a fresh one (request/resend/admin-request) and,
// defensively, right after a successful confirm consumes the token that was
// actually used (in case some future bug ever let a second one exist
// despite the partial unique index below normally making that impossible).
export async function revokeActiveAccountEmailChangeTokens(executor, userId) {
  await executor(
    `update public.account_email_change_tokens
     set revoked_at = now(), updated_at = now()
     where user_id = $1 and consumed_at is null and revoked_at is null`,
    [userId],
  );
}

// Revokes any existing active token for this user and issues exactly one
// fresh one - every call site (self-service request, resend, and the
// platform-admin-initiated request) goes through this, so a token is never
// minted any other way. Must be called with `executor` bound to a
// transaction that already holds lockAccountEmailChangeActions for this
// exact userId. Returns the new row's id (tokenId) so the caller can mark
// it `sent` separately, via markAccountEmailChangeTokenSent, AFTER the
// transaction commits and the actual provider call succeeds (never inside
// this transaction - a network call must never hold a DB lock, and
// issuance must survive even when sending fails).
export async function issueAccountEmailChangeToken(executor, { userId, newEmail, requestedByUserId, requestSource }) {
  await revokeActiveAccountEmailChangeTokens(executor, userId);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashEmailChangeToken(rawToken);
  const expiresAt = new Date(Date.now() + ACCOUNT_EMAIL_CHANGE_TOKEN_TTL_MS);
  const inserted = await executor(
    `insert into public.account_email_change_tokens (user_id, new_email, token_hash, requested_by_user_id, request_source, expires_at)
     values ($1, lower($2), $3, $4, $5, $6)
     returning id`,
    [userId, newEmail, tokenHash, requestedByUserId || null, requestSource, expiresAt],
  );
  return { rawToken, expiresAt, tokenId: inserted.rows[0].id };
}

// Called once, right after sendAccountEmailChangeVerification's provider
// call actually succeeds - never inside the transaction that inserted the
// token. A token that was created but never successfully sent (provider
// failure) is NOT "sent", so it must never count toward the resend
// throttle below.
export async function markAccountEmailChangeTokenSent(executor, tokenId) {
  await executor(`update public.account_email_change_tokens set sent_at = now(), updated_at = now() where id = $1`, [tokenId]);
}

// Deliberately keyed off sent_at, NOT created_at - a token that was created
// but whose send attempt failed was never actually delivered, so it must
// never block an immediate retry.
export async function loadLastAccountEmailChangeTokenSentAt(executor, userId) {
  const result = await executor(
    `select max(sent_at) as last_sent_at from public.account_email_change_tokens where user_id = $1 and sent_at is not null`,
    [userId],
  );
  return result.rows[0]?.last_sent_at || null;
}

export function accountEmailChangeResendTooSoon(lastSentAt) {
  if (!lastSentAt) return false;
  return Date.now() - new Date(lastSentAt).getTime() < ACCOUNT_EMAIL_CHANGE_RESEND_MIN_INTERVAL_MS;
}

// The single still-active (not consumed, not revoked) request for this
// user, if any - drives the "pending change" status the frontend shows
// (new address, requested by self/admin, expiry) without exposing the
// token hash or id to the client.
export async function loadActiveAccountEmailChangeRequest(executor, userId) {
  const result = await executor(
    `select id, new_email, expires_at, sent_at, requested_by_user_id, request_source, created_at
     from public.account_email_change_tokens
     where user_id = $1 and consumed_at is null and revoked_at is null
     order by created_at desc
     limit 1`,
    [userId],
  );
  return result.rows[0] || null;
}
