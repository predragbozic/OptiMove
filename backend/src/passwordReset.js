// Forgot/reset password (security/password-recovery) - shared helpers for
// public.password_reset_tokens (migrations/20260810_password_reset.sql), a
// dedicated table separate from public.email_verification_tokens (see that
// migration's own header comment for why). Mirrors the shape of
// backend/src/emailVerification.js on purpose (hash/issue/mark-sent/
// throttle/per-entity advisory lock), but is its own module with its own
// state - the two flows must never share a rate-limit map or lock
// namespace.
import crypto from "node:crypto";

export function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

// 30 minutes - within the 30-60 minute range a password-reset link is
// conventionally valid for: long enough that a real inbox check isn't a
// race against the clock, short enough that a stale, unused link stops
// being useful quickly. A single named constant so the value is defined
// exactly once.
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

// Same 60-second shape as emailVerification.js's RESEND_MIN_INTERVAL_MS -
// keyed off sent_at (see loadLastPasswordResetTokenSentAt below), never
// created_at, so a token whose send attempt failed never blocks an
// immediate retry.
export const PASSWORD_RESET_RESEND_MIN_INTERVAL_MS = 60 * 1000;

// Shared advisory-lock namespace for every mutation that can affect a given
// user's password-reset state (issuing a new token via forgot, consuming one
// via reset) - keyed by user_id alone. A distinct constant from every other
// lock namespace in this codebase (inviteContext.js's
// ATHLETE_INVITE_ACTION_LOCK_NAMESPACE=719402583, joinLinkContext.js's
// JOIN_LINK_ACTION_LOCK_NAMESPACE=719402617 and
// APPLICANT_ATHLETE_CREATION_LOCK_NAMESPACE=719402629,
// organization.js's PLATFORM_ADMIN_HEADCOUNT_LOCK_KEY=726354981 and
// CLUB_ADMIN_HEADCOUNT_LOCK_NAMESPACE=891234567) - never reused, never
// changed. pg_advisory_xact_lock auto-releases at transaction end (commit or
// rollback); never paired with pg_advisory_unlock.
const PASSWORD_RESET_ACTION_LOCK_NAMESPACE = 719402651;

export async function lockPasswordResetActions(executor, userId) {
  await executor(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [PASSWORD_RESET_ACTION_LOCK_NAMESPACE, String(userId)]);
}

// Revokes any existing active token for this user - called both right
// before issuing a fresh one (forgot) and, defensively, right after a
// successful reset consumes the token that was actually used (in case some
// future bug ever let a second one exist despite the partial unique index
// below normally making that impossible).
export async function revokeActivePasswordResetTokens(executor, userId) {
  await executor(
    `update public.password_reset_tokens
     set revoked_at = now(), updated_at = now()
     where user_id = $1 and consumed_at is null and revoked_at is null`,
    [userId],
  );
}

// Revokes any existing active token for this user and issues exactly one
// fresh one - the single call site POST /api/auth/password/forgot goes
// through, so a reset token is never minted any other way. Must be called
// with `executor` bound to a transaction that already holds
// lockPasswordResetActions for this exact userId. Returns the new row's id
// (tokenId) so the caller can mark it `sent` separately, via
// markPasswordResetTokenSent, AFTER the transaction commits and the actual
// provider call succeeds (never inside this transaction - a network call
// must never hold a DB lock, and issuance must survive even when sending
// fails).
export async function issuePasswordResetToken(executor, userId) {
  await revokeActivePasswordResetTokens(executor, userId);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);
  const inserted = await executor(
    `insert into public.password_reset_tokens (user_id, token_hash, expires_at)
     values ($1, $2, $3)
     returning id`,
    [userId, tokenHash, expiresAt],
  );
  return { rawToken, expiresAt, tokenId: inserted.rows[0].id };
}

// Called once, right after sendPasswordResetEmail's provider call actually
// succeeds - never inside the transaction that inserted the token (see
// issuePasswordResetToken). A token that was created but never successfully
// sent (provider failure) is NOT "sent", so it must never count toward the
// resend throttle below.
export async function markPasswordResetTokenSent(executor, tokenId) {
  await executor(`update public.password_reset_tokens set sent_at = now(), updated_at = now() where id = $1`, [tokenId]);
}

// Deliberately keyed off sent_at, NOT created_at - a token that was created
// but whose send attempt failed was never actually delivered, so it must
// never block an immediate retry.
export async function loadLastPasswordResetTokenSentAt(executor, userId) {
  const result = await executor(
    `select max(sent_at) as last_sent_at from public.password_reset_tokens where user_id = $1 and sent_at is not null`,
    [userId],
  );
  return result.rows[0]?.last_sent_at || null;
}

export function resetResendTooSoon(lastSentAt) {
  if (!lastSentAt) return false;
  return Date.now() - new Date(lastSentAt).getTime() < PASSWORD_RESET_RESEND_MIN_INTERVAL_MS;
}

// Best-effort, in-memory per-IP limiter for POST /api/auth/password/forgot
// only - its own map, never shared with emailVerification.js's
// resendAttemptsByIp, so the two endpoints' usage can never throttle each
// other. Not the primary defense (see the module comment on
// resentTooSoon-style DB throttling above, which is the real, persistent
// guard): this is a coarse backstop against a single client hammering the
// endpoint, and resets naturally as entries age past the window. Acceptable
// for a single-instance deployment, matching the exact same documented
// tradeoff emailVerification.js's own limiter makes.
const FORGOT_IP_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_IP_MAX_ATTEMPTS = 10;
const forgotAttemptsByIp = new Map();

export function allowForgotAttemptForIp(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const existing = forgotAttemptsByIp.get(key);
  if (!existing || now - existing.windowStart > FORGOT_IP_WINDOW_MS) {
    forgotAttemptsByIp.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (existing.count >= FORGOT_IP_MAX_ATTEMPTS) return false;
  existing.count += 1;
  return true;
}

// Test-only: lets a test reset the module-level IP limiter map between runs
// without needing to wait out FORGOT_IP_WINDOW_MS or restart the process.
export function __resetForgotIpLimiterForTests() {
  forgotAttemptsByIp.clear();
}
