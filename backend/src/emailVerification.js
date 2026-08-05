// Shared email-verification helpers for the athlete_join_application purpose
// (feature/email-verification-foundation). A brand-new-email join
// application (applicant_user_id null) can never be approved until its
// email has been verified through this flow - see POST
// /organization/athlete-join-applications/:id/approve. An authenticated
// apply-existing application (applicant_user_id set) never goes through
// this at all - session-proven ownership of the existing account already IS
// proof of email control, so no separate verification email is ever sent
// for that path (documented here and in the apply-existing route/tests).
import crypto from "node:crypto";

export function hashVerificationToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Revokes any still-active (not consumed, not revoked) verification token
// for this application - called whenever the application leaves its
// pending/awaiting-verification state for a reason OTHER than a successful
// confirm (reject, the closeUnusableJoinLinkApplications sweep, an explicit
// join-link revoke's cascade): the token would otherwise remain a live,
// clickable link to nowhere-useful indefinitely. Mirrors how a
// password_hash is cleared the moment it can no longer lead anywhere real.
export async function revokeActiveEmailVerificationTokens(executor, applicationId) {
  await executor(
    `update public.email_verification_tokens
     set revoked_at = now(), updated_at = now()
     where athlete_join_application_id = $1 and consumed_at is null and revoked_at is null`,
    [applicationId],
  );
}

// Bulk counterpart for an explicit join-link revoke, which closes every
// still-open application for that link in one statement (see DELETE
// /api/organization/athlete-join-links/:linkId) - revokes the active token
// for all of them in one statement too, rather than one query per
// application.
export async function revokeActiveEmailVerificationTokensForJoinLink(executor, joinLinkId) {
  await executor(
    `update public.email_verification_tokens t
     set revoked_at = now(), updated_at = now()
     from public.athlete_join_applications a
     where t.athlete_join_application_id = a.id
       and a.join_link_id = $1
       and t.consumed_at is null
       and t.revoked_at is null`,
    [joinLinkId],
  );
}

// Revokes any existing active token for this application and issues exactly
// one fresh one - the single call site both the initial POST .../apply (new
// email) and POST .../email-verifications/resend go through, so a
// verification token is never minted any other way. Must be called with
// `executor` bound to a transaction that already holds
// lockJoinLinkActions for this application's join link - both callers do.
// Returns the new row's id (tokenId) so the caller can mark it `sent` -
// separately, via markVerificationTokenSent, AFTER the transaction commits
// and the actual provider call succeeds (never inside this transaction -
// a network call must never hold a DB lock, and issuance must survive even
// when sending fails).
export async function issueEmailVerificationToken(executor, { applicationId, email }) {
  await revokeActiveEmailVerificationTokens(executor, applicationId);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashVerificationToken(rawToken);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  const inserted = await executor(
    `insert into public.email_verification_tokens (email, purpose, athlete_join_application_id, token_hash, expires_at)
     values (lower($1), 'athlete_join_application', $2, $3, $4)
     returning id`,
    [email, applicationId, tokenHash, expiresAt],
  );
  return { rawToken, expiresAt, tokenId: inserted.rows[0].id };
}

// Called once, right after sendEmailVerification's provider call actually
// succeeds - never inside the transaction that inserted the token (see
// issueEmailVerificationToken). A token that was created but never
// successfully sent (provider failure) is NOT "sent", so it must never
// count toward the resend throttle below - see loadLastVerificationTokenSentAt.
export async function markVerificationTokenSent(executor, tokenId) {
  await executor(`update public.email_verification_tokens set sent_at = now(), updated_at = now() where id = $1`, [tokenId]);
}

// Deliberately keyed off sent_at, NOT created_at - a token that was created
// but whose send attempt failed was never actually delivered, so it must
// never block an immediate retry (see resentTooSoon's caller in POST
// /api/auth/email-verifications/resend).
export async function loadLastVerificationTokenSentAt(executor, applicationId) {
  const result = await executor(
    `select max(sent_at) as last_sent_at from public.email_verification_tokens where athlete_join_application_id = $1 and sent_at is not null`,
    [applicationId],
  );
  return result.rows[0]?.last_sent_at || null;
}

const RESEND_MIN_INTERVAL_MS = 60 * 1000;

export function resentTooSoon(lastSentAt) {
  if (!lastSentAt) return false;
  return Date.now() - new Date(lastSentAt).getTime() < RESEND_MIN_INTERVAL_MS;
}

// Best-effort, in-memory per-IP limiter for the resend endpoint only - no
// rate-limit infrastructure exists anywhere else in this codebase (checked
// before building this), and this phase deliberately avoids introducing a
// large new system for it. Resets naturally as entries age past the window;
// acceptable for a single-instance deployment. Even if this were bypassed
// entirely, the per-application 60-second throttle and the fact that
// POST /email-verifications/resend always returns the exact same generic
// response regardless of outcome remain the real defenses against
// enumeration/abuse.
const RESEND_IP_WINDOW_MS = 15 * 60 * 1000;
const RESEND_IP_MAX_ATTEMPTS = 10;
const resendAttemptsByIp = new Map();

export function allowResendAttemptForIp(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const existing = resendAttemptsByIp.get(key);
  if (!existing || now - existing.windowStart > RESEND_IP_WINDOW_MS) {
    resendAttemptsByIp.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (existing.count >= RESEND_IP_MAX_ATTEMPTS) return false;
  existing.count += 1;
  return true;
}

// Reads the same x-forwarded-for header the rest of this codebase already
// reads manually for x-forwarded-proto (see backend/src/appOrigin.js) rather
// than relying on Express's `trust proxy` setting, which is not configured
// here.
export function requestIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
