import { Router } from "express";
import crypto from "node:crypto";
import { pool, query } from "../db.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  sessionCookie,
  verifyPassword,
} from "../auth.js";
import { accessScope, publicRole } from "../access.js";
import { resolveActiveWorkspace, saveWorkspacePreference, validateWorkspaceSelection } from "../workspace.js";
import { closeOtherOpenInvitesForAthlete, loadUsableInvite, lockAthleteInviteActions } from "../inviteContext.js";
import { closeUnusableJoinLinkApplications, loadJoinLinkContextName, loadUsableJoinLink, lockJoinLinkActions } from "../joinLinkContext.js";
import { resolveAppOrigin } from "../appOrigin.js";
import { EmailConfigError, EmailSendError, sendEmailVerification, sendPasswordResetEmail } from "../email.js";
import {
  allowResendAttemptForIp,
  hashVerificationToken,
  issueEmailVerificationToken,
  loadLastVerificationTokenSentAt,
  markVerificationTokenSent,
  requestIp,
  resentTooSoon,
  revokeActiveEmailVerificationTokens,
} from "../emailVerification.js";
import {
  allowForgotAttemptForIp,
  enforceForgotResponseFloor,
  hashResetToken,
  issuePasswordResetToken,
  loadLastPasswordResetTokenSentAt,
  lockPasswordResetActions,
  markPasswordResetTokenSent,
  resetResendTooSoon,
  revokeActivePasswordResetTokens,
} from "../passwordReset.js";

const isProduction = process.env.NODE_ENV === "production";

const router = Router();

router.get("/me", async (req, res, next) => {
  try {
    if (!req.user) return res.json({ user: null });
    const authz = req.authz || {};
    const clubRoles = authz.clubRoles || [];
    const teamRoles = authz.teamRoles || [];
    const clubIds = clubRoles.map((r) => r.clubId);
    const teamIds = teamRoles.map((r) => r.teamId);
    const [clubsResult, teamsResult, { workspace: activeWorkspace, availableWorkspaces }] = await Promise.all([
      clubIds.length ? query(`select id, name from public.clubs where id = any($1::uuid[])`, [clubIds]) : { rows: [] },
      teamIds.length ? query(`select id, name from public.teams where id = any($1::uuid[])`, [teamIds]) : { rows: [] },
      resolveActiveWorkspace(req.user.id, authz),
    ]);
    const clubNameById = new Map(clubsResult.rows.map((c) => [String(c.id), c.name]));
    const teamNameById = new Map(teamsResult.rows.map((t) => [String(t.id), t.name]));

    res.json({
      user: {
        ...publicUser(req.user),
        // Capability flags and scoped roles for the multi-workspace UI -
        // role_hint above is legacy display only; any real permission
        // decision must come from these, not from role_hint, and the
        // active/available workspace below is presentation-only too (see
        // backend/src/workspace.js's header comment).
        capabilities: authz.capabilities || {},
        clubs: clubRoles.map((r) => ({ id: r.clubId, name: clubNameById.get(String(r.clubId)) || null, role: r.role })),
        teams: teamRoles.map((r) => ({ id: r.teamId, name: teamNameById.get(String(r.teamId)) || null, role: r.role })),
        activeWorkspace,
        availableWorkspaces,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Switches which workspace the account is currently acting in - never grants,
// revokes, or otherwise touches any role row; see backend/src/workspace.js.
// The new type/scopeId is validated against req.authz (real, active
// roles/FKs) before anything is written, so an invalid or currently-
// unavailable workspace is rejected with no mutation at all.
router.put("/workspace", async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const type = typeof req.body?.type === "string" ? req.body.type : "";
    const scopeId = req.body?.scopeId != null ? String(req.body.scopeId) : null;
    const validated = await validateWorkspaceSelection(req.authz || {}, type, scopeId);
    if (validated.error) {
      const status = validated.error === "UNSUPPORTED_WORKSPACE_TYPE" ? 400 : 403;
      return res.status(status).json({ error: validated.error });
    }
    await saveWorkspacePreference(req.user.id, validated.workspace.type, validated.workspace.scopeId);
    res.json({ activeWorkspace: validated.workspace, availableWorkspaces: validated.availableWorkspaces });
  } catch (error) {
    next(error);
  }
});

router.put("/me/credentials", async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const currentPassword = String(req.body?.currentPassword || "");
    const nextEmail = req.body?.email !== undefined ? String(req.body.email).trim().toLowerCase() : "";
    const nextPassword = req.body?.newPassword !== undefined ? String(req.body.newPassword) : "";
    if (!currentPassword) return res.status(400).json({ error: "Enter your current password to confirm this change." });
    if (!nextEmail && !nextPassword) return res.status(400).json({ error: "Enter a new email or a new password." });
    if (nextPassword && nextPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });

    const current = await query(
      `select id, email, password_hash from public.users where id = $1 limit 1`,
      [req.user.id],
    );
    const user = current.rows[0];
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    const email = nextEmail || user.email;
    const passwordHash = nextPassword ? hashPassword(nextPassword) : user.password_hash;
    const updated = await query(
      `update public.users set email = $2, password_hash = $3, updated_at = now() where id = $1
       returning id, email, full_name, display_name, role_hint`,
      [user.id, email, passwordHash],
    );
    res.json({ user: publicUser(updated.rows[0]) });
  } catch (error) {
    if (error?.code === "23505") return res.status(409).json({ error: "This email is already in use by another account." });
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

    // Look up without filtering is_active first: a wrong password must always
    // return the same generic error whether or not the account is disabled,
    // so a login attempt can never be used to probe which emails exist or
    // which accounts are active. Only after the password is proven correct
    // do we reveal the more specific "this account is disabled" message.
    const result = await query(
      `
      select id, email, full_name, display_name, role_hint, password_hash, is_active
      from public.users
      where lower(email) = $1
      limit 1
      `,
      [email],
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: "This account has been disabled. Contact your coach or platform admin." });
    }

    const token = await createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookie(token, req.secure || req.headers["x-forwarded-proto"] === "https"));
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

// --- Forgot / reset password (security/password-recovery) ---
// Public, unauthenticated. ALWAYS returns the exact same generic response
// regardless of whether the email belongs to an account, whether that
// account is active, whether it's currently throttled, or whether the
// email provider fails to send - this endpoint must never be usable to
// probe which emails have accounts, active or not, INCLUDING via response
// timing. See backend/src/passwordReset.js for the token/throttle/timing-
// floor helpers.
//
// Two things close the timing side-channel a naive implementation would
// have:
// 1. The real network call to the email provider (Brevo/Gmail/Resend) is
//    fired without being awaited (see fireForgotPasswordResetEmail below) -
//    it can never add its own latency to the HTTP response, slow or fast,
//    success or failure.
// 2. Every remaining, genuinely real difference in DB-only work (a
//    sendable account does a transaction + advisory lock + a FOR UPDATE
//    reload + a throttle read + a token insert + commit; every other exit
//    does at most one lookup query, or none at all) is absorbed by
//    enforceForgotResponseFloor - a small shared minimum-response-time
//    floor with bounded random jitter, applied to every single exit of
//    this handler. Not an attempt at cryptographically constant-time
//    behavior, just enough to remove the practically-measurable "instant"
//    vs "waited on real DB work" gap (see that function's own header
//    comment in backend/src/passwordReset.js for the exact reasoning and
//    constants).
const GENERIC_FORGOT_RESPONSE_MESSAGE = "If an active account exists for that email, we've sent password reset instructions.";

// Fired without being awaited by the request handler below - the HTTP
// response must never wait on a real network call to the email provider.
// This function must NEVER reject: every error is caught and reduced to a
// sanitized log line, so an un-awaited call here can never produce an
// unhandled promise rejection. sent_at is set only once
// sendPasswordResetEmail's provider call has genuinely succeeded; a
// failure leaves it null, which is exactly what the resend throttle (see
// resetResendTooSoon in passwordReset.js) is keyed off - a failed/never-
// confirmed send never blocks an immediate retry. Never logs the email
// address, raw token, reset URL, or the provider's raw response - only a
// sanitized error class/message, same as before this was made
// fire-and-forget.
//
// A caveat specific to Render: it runs this as a long-lived Node Web
// Service, not a serverless function frozen the instant the HTTP response
// is written - this promise keeps running on the same event loop after
// res.json() returns. It is only ever lost if the process is killed in the
// narrow window between the response being sent and this promise
// settling (e.g. a deploy or restart landing at that exact moment). That's
// an accepted, documented tradeoff, not a hidden wait - and the next
// forgot request for the same account can immediately issue a fresh token
// regardless, since a token that was created but never confirmed sent
// never got sent_at set, and the resend throttle only looks at sent_at.
async function fireForgotPasswordResetEmail({ to, resetUrl, recipientName, expiresAt, tokenId }) {
  try {
    await sendPasswordResetEmail({ to, resetUrl, recipientName, expiresAt });
    await markPasswordResetTokenSent(query, tokenId);
  } catch (emailError) {
    console.error("Failed to send password reset email:", emailError instanceof EmailConfigError || emailError instanceof EmailSendError ? emailError.message : "unexpected error");
  }
}

// Test-only hook: POST /password/forgot fires fireForgotPasswordResetEmail
// above without awaiting it, by design (see that function's own header
// comment) - a test that wants to deterministically wait for it to finish
// (to check sent_at, console output, or that it never throws) has no other
// way to observe an intentionally un-awaited background promise. Tracking
// is off by default (a no-op, zero overhead) so production never
// accumulates promises nobody drains.
let forgotSendTrackingEnabled = false;
let trackedForgotSendPromises = [];

export function __enableForgotSendTrackingForTests() {
  forgotSendTrackingEnabled = true;
  trackedForgotSendPromises = [];
}

export function __disableForgotSendTrackingForTests() {
  forgotSendTrackingEnabled = false;
  trackedForgotSendPromises = [];
}

export async function __flushForgotSendPromisesForTests() {
  const pending = trackedForgotSendPromises;
  trackedForgotSendPromises = [];
  await Promise.allSettled(pending);
}

function trackForgotSendPromiseForTests(promise) {
  if (forgotSendTrackingEnabled) trackedForgotSendPromises.push(promise);
}

router.post("/password/forgot", async (req, res, next) => {
  const startedAt = Date.now();
  const respondGeneric = async (extra = {}) => {
    await enforceForgotResponseFloor(startedAt);
    res.json({ ok: true, message: GENERIC_FORGOT_RESPONSE_MESSAGE, ...extra });
  };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return await respondGeneric();

    const ip = requestIp(req);
    if (!allowForgotAttemptForIp(ip)) return await respondGeneric();

    const candidate = await query(`select id, is_active from public.users where lower(email) = $1 limit 1`, [email]);
    const user = candidate.rows[0];
    // No account, or an account that's deactivated - never sends a reset
    // link for either case (a deactivated account can't log in even with a
    // new password), but the response must stay identical either way.
    if (!user || !user.is_active) return await respondGeneric();

    const client = await pool.connect();
    let resetToken;
    let tokenId;
    let expiresAt;
    let recipientName;
    let shouldSend = false;
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      await lockPasswordResetActions(exec, user.id);

      // Re-load fresh, under the lock - the account could have been
      // disabled between the unlocked read above and here. Deliberately
      // structured as nested ifs, not early returns, so every branch below
      // still reaches the single commit/finally at the bottom of this
      // block - the pool client must always be released BEFORE
      // respondGeneric's timing-floor wait (and before the fire-and-forget
      // email dispatch) run, never while it's still checked out.
      const fresh = await client.query(`select id, is_active, full_name, display_name from public.users where id = $1 limit 1 for update`, [user.id]);
      const freshUser = fresh.rows[0];
      if (freshUser && freshUser.is_active) {
        const lastSentAt = await loadLastPasswordResetTokenSentAt(exec, user.id);
        if (!resetResendTooSoon(lastSentAt)) {
          const issued = await issuePasswordResetToken(exec, user.id);
          resetToken = issued.rawToken;
          tokenId = issued.tokenId;
          expiresAt = issued.expiresAt;
          recipientName = freshUser.display_name || freshUser.full_name || "";
          shouldSend = true;
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (shouldSend) {
      const resetUrl = `${resolveAppOrigin(req)}/reset-password?token=${encodeURIComponent(resetToken)}`;
      // Not awaited - see fireForgotPasswordResetEmail's header comment.
      const sendPromise = fireForgotPasswordResetEmail({ to: email, resetUrl, recipientName, expiresAt, tokenId });
      trackForgotSendPromiseForTests(sendPromise);
      if (!isProduction) {
        // Automated tests and local development need the raw token to
        // drive the reset flow without a real inbox - never included in a
        // production response or in any log line.
        return await respondGeneric({ devResetToken: resetToken });
      }
    }
    return await respondGeneric();
  } catch (error) {
    next(error);
  }
});

// Read-only check, used by the frontend before showing the "set a new
// password" form - never consumes the token and never changes anything.
// Every invalid reason (not found, expired, consumed, revoked, or the
// account it belongs to no longer being active) collapses to the exact
// same generic { valid: false } - a token can never be used to probe why
// it stopped working, or to learn anything about the account it belongs
// to (no email, name, id, or role in this response, ever).
router.get("/password/reset/:token", async (req, res, next) => {
  try {
    const tokenHash = hashResetToken(req.params.token);
    const result = await query(
      `select t.expires_at, t.consumed_at, t.revoked_at, u.is_active
       from public.password_reset_tokens t
       join public.users u on u.id = t.user_id
       where t.token_hash = $1
       limit 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row || row.consumed_at || row.revoked_at || new Date(row.expires_at) <= new Date() || !row.is_active) {
      return res.json({ valid: false });
    }
    res.json({ valid: true });
  } catch (error) {
    next(error);
  }
});

// Actually changes the password. Transactional: resolve the token's owner
// without mutation (purely for the lock key), lock, re-load the token FOR
// UPDATE, re-check it and the account are still valid, hash the new
// password, write ONLY users.password_hash, consume the token, defensively
// revoke any other still-active token for this user, and delete every one
// of this user's existing sessions - all in the same transaction, so a
// failure at any step leaves password/token/session state exactly as it
// was before this request. Touches nothing else: not email, role_hint,
// user_global_roles, user_club_roles, user_team_roles, athletes.user_id,
// athlete_memberships, user_athletes, workspace preference, or is_active.
// Never creates a new session - the caller logs in again with the new
// password.
router.post("/password/reset/:token", async (req, res, next) => {
  const genericInvalid = () => res.status(404).json({ error: "This reset link is invalid or has expired." });
  const client = await pool.connect();
  try {
    const password = String(req.body?.password || "");
    // No transaction has been opened yet at this point - a plain early
    // return is enough; the finally block below still releases the client
    // in every path.
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const tokenHash = hashResetToken(req.params.token);

    // Resolve without mutation, purely to have the lock key - mirrors every
    // other token flow's "resolve without mutation, then lock, then
    // re-check" pattern. Never trusted past this point; the token/user rows
    // are both re-loaded FOR UPDATE below. Still no transaction open yet.
    const resolved = await query(`select user_id from public.password_reset_tokens where token_hash = $1 limit 1`, [tokenHash]);
    if (!resolved.rows[0]) {
      return genericInvalid();
    }

    await client.query("begin");
    const exec = (text, params) => client.query(text, params);
    await lockPasswordResetActions(exec, resolved.rows[0].user_id);

    const tokenResult = await client.query(
      `select id, user_id, expires_at, consumed_at, revoked_at
       from public.password_reset_tokens where token_hash = $1 limit 1 for update`,
      [tokenHash],
    );
    const tokenRow = tokenResult.rows[0];
    if (!tokenRow || tokenRow.consumed_at || tokenRow.revoked_at || new Date(tokenRow.expires_at) <= new Date()) {
      await client.query("rollback");
      return genericInvalid();
    }

    const userResult = await client.query(`select id, is_active from public.users where id = $1 limit 1 for update`, [tokenRow.user_id]);
    const user = userResult.rows[0];
    if (!user || !user.is_active) {
      await client.query("rollback");
      return genericInvalid();
    }

    const passwordHash = hashPassword(password);
    await client.query(`update public.users set password_hash = $2, updated_at = now() where id = $1`, [user.id, passwordHash]);
    await client.query(`update public.password_reset_tokens set consumed_at = now(), updated_at = now() where id = $1`, [tokenRow.id]);
    // Defensive, normally a no-op: the partial unique index on
    // password_reset_tokens already guarantees at most one active token per
    // user existed before this request, and the one that existed is the one
    // just consumed above (excluded by revokeActivePasswordResetTokens's own
    // consumed_at is null filter, now that it's set) - see that function's
    // header comment.
    await revokeActivePasswordResetTokens(exec, user.id);
    // Every existing session for this account is invalidated - the whole
    // point of a password reset is that anyone who had access via the old
    // password (or a stolen session) no longer does. The caller logs back
    // in with the new password afterward; no new session is created here.
    await client.query(`delete from public.auth_sessions where user_id = $1`, [user.id]);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.get("/invites/:token", async (req, res, next) => {
  try {
    const tokenHash = hashInviteToken(req.params.token);
    // loadUsableInvite folds "not found", "expired", "revoked", "already
    // accepted", and "the original context is no longer valid" into the
    // exact same null result - a link must never be usable to tell an
    // anonymous caller which of those it was.
    const invite = await loadUsableInvite(query, tokenHash);
    if (!invite) return res.status(404).json({ error: "Invite is invalid or expired." });
    res.json({ invite: { id: invite.id, email: invite.email, expires_at: invite.expires_at, athlete_name: invite.athlete_name, athlete_code: invite.athlete_code } });
  } catch (error) {
    next(error);
  }
});

// Invite accept is public and unauthenticated (anyone with the link can call
// it), so it must never be able to touch an account it doesn't already know
// the password for. If the invite's email matches ANY existing user - athlete,
// coach, or admin - this endpoint refuses to set a password or role on it at
// all; the real owner has to log in with their existing password and use
// POST /invites/:token/link instead, which proves ownership via session.
// Only a genuinely unused email may create a brand-new account here.
router.post("/invites/:token/accept", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const password = String(req.body?.password || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const tokenHash = hashInviteToken(req.params.token);

    // Resolve which athlete this token targets WITHOUT any mutation, purely
    // to have the per-athlete lock key before opening a transaction - if the
    // token doesn't even exist, there is nothing to lock, so this falls
    // through to the exact same generic response as every other invalid case.
    const resolved = await query(`select athlete_id from public.athlete_invites where token_hash = $1 limit 1`, [tokenHash]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "Invite is invalid or expired." });

    await client.query("begin");
    const exec = (text, params) => client.query(text, params);
    // Same lock generate/regenerate, link, and revoke all acquire for this
    // athlete_id before touching athletes.user_id or this athlete's invite
    // rows - see lockAthleteInviteActions. This is what actually prevents a
    // concurrent regenerate from revoking this exact token (or a concurrent
    // revoke) while this accept is mid-decision.
    await lockAthleteInviteActions(exec, resolved.rows[0].athlete_id);
    // loadUsableInvite (shared with GET/link) re-loads and re-locks the
    // invite row fresh, now that no concurrent operation for this athlete
    // can be mid-flight, and re-checks that the original context (private-
    // coach relationship / club or team membership / inviter's continued
    // authority) is STILL valid right now - not just that the token hasn't
    // expired - so a stale link can never resurrect an archived
    // relationship. Any failure reason collapses to the same generic 404
    // below.
    const invite = await loadUsableInvite(exec, tokenHash, { forUpdate: true });
    if (!invite) {
      await client.query("rollback");
      return res.status(404).json({ error: "Invite is invalid or expired." });
    }

    // A fresh, locked read - not the unlocked-at-read-time join value inside
    // loadUsableInvite's own SELECT - immediately before deciding whether to
    // create a new account. Trust athletes.user_id directly - it's the
    // athlete's own real FK link, not role_hint, so a multi-role account
    // (e.g. role_hint="coach" who is also, genuinely, this athlete) is
    // correctly recognized as already linked. This used to also require
    // role_hint="athlete", which broke exactly that multi-role case; the
    // historical bug that once let this column point at an unrelated staff
    // account (POST /athletes writing the wrong column) is fixed at its
    // source, so the raw FK is trustworthy.
    const athleteRow = await client.query(`select user_id from public.athletes where id = $1 for update`, [invite.athlete_id]);
    const linkedAthleteUserId = athleteRow.rows[0]?.user_id || null;
    if (linkedAthleteUserId) {
      // This athlete already has a login. The public accept form must never be
      // able to change that account's email or password, no matter what email
      // this particular invite was sent to - the account owner has to log in
      // with their existing password and use POST /invites/:token/link, which
      // proves ownership via session rather than "I typed the right email".
      await client.query("rollback");
      return res.status(409).json({
        error: "This athlete already has a login. Log in with the existing password, then accept this invite from your account.",
        requiresLogin: true,
      });
    }

    const emailOwner = await client.query(`select id from public.users where lower(email) = lower($1) limit 1`, [invite.email]);
    if (emailOwner.rows[0]) {
      await client.query("rollback");
      return res.status(409).json({
        error: "An account with this email already exists. Log in with your existing password, then accept this invite from your account.",
        requiresLogin: true,
      });
    }

    const nameParts = splitName(invite.athlete_name || invite.email);
    const passwordHash = hashPassword(password);
    const inserted = await client.query(
      `
      insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
      values ($1, $2, $3, $4, $5, $5, 'athlete', true)
      returning id, email, full_name, display_name, role_hint
      `,
      [invite.email, nameParts.firstName, nameParts.lastName, passwordHash, invite.athlete_name],
    );
    const user = inserted.rows[0];
    await client.query(`update public.athletes set user_id = $2 where id = $1`, [invite.athlete_id, user.id]);
    await client.query(
      `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
       values ($1, $2, 'athlete', true)
       on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
      [user.id, invite.athlete_id],
    );
    await client.query(
      `update public.athlete_invites set accepted_by_user_id = $2, accepted_at = now() where id = $1`,
      [invite.id, user.id],
    );
    // The athlete now has exactly one login - any OTHER still-open invite
    // for this same athlete (any context, any email) can never be
    // meaningfully accepted afterward, so close them out now rather than
    // leaving stale pending state behind. Still under the same per-athlete
    // lock this whole transaction has held since the top of this handler.
    await closeOtherOpenInvitesForAthlete(exec, invite.athlete_id, invite.id, user.id);
    await client.query("commit");

    const token = await createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookie(token, req.secure || req.headers["x-forwarded-proto"] === "https"));
    res.json({ user: publicUser(user) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// Authenticated counterpart to /accept: for a user who already has their own
// account (proven by being logged in with their real password), this links
// their existing account to the invited athlete profile without ever
// touching their password or role_hint. This is the only safe path for an
// invite whose email collides with an existing account.
router.post("/invites/:token/link", async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Log in first, then accept this invite from your account." });
  const client = await pool.connect();
  try {
    const tokenHash = hashInviteToken(req.params.token);

    // Resolve which athlete this token targets WITHOUT any mutation, purely
    // to have the per-athlete lock key before opening a transaction.
    const resolved = await query(`select athlete_id from public.athlete_invites where token_hash = $1 limit 1`, [tokenHash]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "Invite is invalid or expired." });

    await client.query("begin");
    const exec = (text, params) => client.query(text, params);
    // Same per-athlete lock accept/generate/regenerate/revoke all acquire -
    // see lockAthleteInviteActions - so this link is serialized against a
    // concurrent regenerate (which would revoke this exact token) or revoke.
    await lockAthleteInviteActions(exec, resolved.rows[0].athlete_id);
    const invite = await loadUsableInvite(exec, tokenHash, { forUpdate: true });
    if (!invite) {
      await client.query("rollback");
      return res.status(404).json({ error: "Invite is invalid or expired." });
    }
    if (String(invite.email).toLowerCase() !== String(req.user.email).toLowerCase()) {
      await client.query("rollback");
      return res.status(403).json({ error: "This invite was sent to a different email address." });
    }
    // A fresh, locked read - see the note in /accept above: trust
    // athletes.user_id directly (not role_hint), so a multi-role account is
    // correctly recognized as already linked.
    const athleteRow = await client.query(`select user_id from public.athletes where id = $1 for update`, [invite.athlete_id]);
    const linkedAthleteUserId = athleteRow.rows[0]?.user_id || null;
    if (linkedAthleteUserId && String(linkedAthleteUserId) !== String(req.user.id)) {
      await client.query("rollback");
      return res.status(409).json({ error: "This athlete profile is already linked to a different account." });
    }

    await client.query(`update public.athletes set user_id = $2 where id = $1`, [invite.athlete_id, req.user.id]);
    await client.query(
      `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
       values ($1, $2, 'athlete', true)
       on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
      [req.user.id, invite.athlete_id],
    );
    await client.query(
      `update public.athlete_invites set accepted_by_user_id = $2, accepted_at = now() where id = $1`,
      [invite.id, req.user.id],
    );
    // Same as /accept above: this athlete now has exactly one login, so any
    // OTHER still-open invite for it (any context, any email) is closed out
    // now rather than left as stale pending state - still under the same
    // per-athlete lock held since the top of this handler. A no-op if
    // req.user already held this athlete (idempotent re-link) and nothing
    // else was ever open.
    await closeOtherOpenInvitesForAthlete(exec, invite.athlete_id, invite.id, req.user.id);
    await client.query("commit");
    res.json({ ok: true, athleteId: invite.athlete_id });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// --- Group athlete join links (feature/group-athlete-join-links) ---
// A SEPARATE, public-facing system from the invite endpoints above - a join
// link is not addressed to any one person or existing athlete profile.
// GET/apply/apply-existing all fold not-found/inactive/revoked/
// expired/full/context-invalid into the exact same generic response (see
// loadUsableJoinLink), so a token can never be used to probe which of those
// it was.

router.get("/join-links/:token", async (req, res, next) => {
  try {
    const tokenHash = hashInviteToken(req.params.token);
    const link = await loadUsableJoinLink(query, tokenHash);
    if (!link) return res.status(404).json({ error: "This join link is invalid or no longer available." });
    const contextName = await loadJoinLinkContextName(query, link);
    res.json({
      link: {
        label: link.label,
        contextType: link.context_type,
        contextName,
        expiresAt: link.expires_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Public, unauthenticated submission for someone with no existing account.
// Never creates a user/athlete row here - only a pending application with a
// freshly hashed password, and now a pending email-verification requirement
// (see backend/src/emailVerification.js) - the application can never be
// approved (POST /organization/athlete-join-applications/:id/approve) until
// the applicant clicks the link this sends them.
router.post("/join-links/:token/apply", async (req, res, next) => {
  const client = await pool.connect();
  let insertedApplicationId;
  let verificationToken;
  let verificationTokenId;
  let verificationExpiresAt;
  let contextLabel;
  let rawStatusToken;
  try {
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!firstName) return res.status(400).json({ error: "First name is required." });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "A valid email is required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const tokenHash = hashInviteToken(req.params.token);

    // Resolve without mutation, purely to have the lock key.
    const resolved = await query(`select id from public.athlete_join_links where token_hash = $1 limit 1`, [tokenHash]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "This join link is invalid or no longer available." });

    await client.query("begin");
    const exec = (text, params) => client.query(text, params);
    // Same per-join-link lock regenerate/revoke/approve all acquire - closes
    // the race between this submission and a concurrent revoke/regenerate of
    // this exact link.
    await lockJoinLinkActions(exec, resolved.rows[0].id);
    const link = await loadUsableJoinLink(exec, tokenHash, { forUpdate: true });
    if (!link) {
      await client.query("rollback");
      return res.status(404).json({ error: "This join link is invalid or no longer available." });
    }

    // If this email already belongs to a real account, this public form must
    // never be able to set a password on it - the real owner has to log in
    // and use POST /join-links/:token/apply-existing instead.
    const emailOwner = await client.query(`select id from public.users where lower(email) = lower($1) limit 1`, [email]);
    if (emailOwner.rows[0]) {
      await client.query("rollback");
      return res.status(409).json({ error: "An account with this email already exists. Log in, then submit this request from your account.", requiresLogin: true });
    }

    const rawStatusToken2 = crypto.randomBytes(24).toString("base64url");
    const statusTokenHash = hashInviteToken(rawStatusToken2);
    const displayName = [firstName, lastName].filter(Boolean).join(" ") || email;
    let inserted;
    try {
      inserted = await client.query(
        `insert into public.athlete_join_applications
           (join_link_id, applicant_user_id, email, first_name, last_name, display_name, password_hash, status, status_token_hash)
         values ($1, null, $2, $3, $4, $5, $6, 'pending', $7)
         returning id`,
        [link.id, email, firstName, lastName, displayName, hashPassword(password), statusTokenHash],
      );
    } catch (insertError) {
      // The partial unique index on (join_link_id, lower(email)) for
      // pending/requires_login rows - a second submission for the same
      // email against the same link never creates a second row (and never
      // leaks whether one already exists to anyone who doesn't already know
      // this is their own email).
      if (insertError?.code === "23505") {
        await client.query("rollback");
        return res.status(409).json({ error: "A request for this email is already pending review." });
      }
      throw insertError;
    }
    insertedApplicationId = inserted.rows[0].id;
    rawStatusToken = rawStatusToken2;

    const issued = await issueEmailVerificationToken(exec, { applicationId: insertedApplicationId, email });
    verificationToken = issued.rawToken;
    verificationTokenId = issued.tokenId;
    verificationExpiresAt = issued.expiresAt;
    contextLabel = await loadJoinLinkContextName(exec, link);

    // Commit BEFORE attempting to send anything - the application (and its
    // hashed, still-unsent verification token) must survive an email
    // provider hiccup. If sending below throws, the row is already safely
    // persisted in a state POST .../email-verifications/resend can retry
    // from - never a duplicate application, never a lost one.
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }

  const verificationUrl = `${resolveAppOrigin(req)}/verify-email?token=${encodeURIComponent(verificationToken)}`;
  let emailSendFailed = false;
  try {
    await sendEmailVerification({
      to: req.body?.email ? String(req.body.email).trim().toLowerCase() : "",
      verificationUrl,
      recipientName: String(req.body?.firstName || "").trim(),
      contextLabel,
      expiresAt: verificationExpiresAt,
    });
    // Only marked sent once the provider call actually succeeded - the
    // resend throttle (POST .../email-verifications/resend) is keyed off
    // this, never off when the token was merely created, so a failed send
    // here never blocks an immediate retry.
    await markVerificationTokenSent(query, verificationTokenId);
  } catch (emailError) {
    emailSendFailed = true;
    // Never leaked to the client as the provider's own error text - the
    // request still succeeded from the applicant's point of view (their
    // application exists and can be resent); only a sanitized reason class
    // is logged, never the verification link/token and never a raw
    // provider error object.
    console.error(`Failed to send verification email for application ${insertedApplicationId}:`, emailError instanceof EmailConfigError || emailError instanceof EmailSendError ? emailError.message : "unexpected error");
  }

  const responseBody = { ok: true, statusToken: rawStatusToken, emailSendFailed };
  if (!isProduction) {
    // Automated tests and local development need the raw token to drive the
    // confirm flow without a real inbox - never included in a production
    // response or in any log line.
    responseBody.devVerificationToken = verificationToken;
  }
  res.status(201).json(responseBody);
});

// Authenticated counterpart to /apply: proves ownership of the account via
// session rather than a typed email, and never carries or stores a password.
//
// Deliberately never sends (or requires) an email-verification token: this
// endpoint only runs for a session already authenticated via
// POST /api/auth/login against that account's own existing password -
// logging in with a correct password for that email IS itself proof of
// control over the account (and, transitively, its email), which is exactly
// what an email-verification link would otherwise be establishing. Sending
// a redundant verification email here would add friction without adding
// any real assurance. See emailVerification.js's header comment for the
// same decision from the other side, and test "apply-existing does not
// require or create an email verification token" below.
router.post("/join-links/:token/apply-existing", async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Log in first, then submit this request from your account." });
  const client = await pool.connect();
  try {
    const tokenHash = hashInviteToken(req.params.token);
    const resolved = await query(`select id from public.athlete_join_links where token_hash = $1 limit 1`, [tokenHash]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "This join link is invalid or no longer available." });

    await client.query("begin");
    const exec = (text, params) => client.query(text, params);
    await lockJoinLinkActions(exec, resolved.rows[0].id);
    const link = await loadUsableJoinLink(exec, tokenHash, { forUpdate: true });
    if (!link) {
      await client.query("rollback");
      return res.status(404).json({ error: "This join link is invalid or no longer available." });
    }

    const rawStatusToken = crypto.randomBytes(24).toString("base64url");
    const statusTokenHash = hashInviteToken(rawStatusToken);
    try {
      // email comes from the account itself, never from the request body -
      // this can never be used to submit a request under someone else's
      // address. No password_hash is ever written for an existing account.
      await client.query(
        `insert into public.athlete_join_applications
           (join_link_id, applicant_user_id, email, password_hash, status, status_token_hash)
         values ($1, $2, $3, null, 'pending', $4)`,
        [link.id, req.user.id, req.user.email, statusTokenHash],
      );
    } catch (insertError) {
      if (insertError?.code === "23505") {
        await client.query("rollback");
        return res.status(409).json({ error: "You already have a pending request for this join link." });
      }
      throw insertError;
    }
    await client.query("commit");
    res.status(201).json({ ok: true, statusToken: rawStatusToken });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// Confirms email ownership for a brand-new-email join application. Never
// creates a user/athlete row and never approves anything by itself - it
// only unlocks the application for a reviewer to later approve (see POST
// /organization/athlete-join-applications/:id/approve's EMAIL_NOT_VERIFIED
// check). Every invalid variant (unknown token, expired, already consumed,
// revoked, or an application that is no longer pending for any other
// reason) returns the exact same generic message, so a token can never be
// used to probe why it stopped working.
router.post("/email-verifications/:token/confirm", async (req, res, next) => {
  const client = await pool.connect();
  const genericInvalid = () => res.status(404).json({ error: "This verification link is invalid or has expired." });
  try {
    const tokenHash = hashVerificationToken(req.params.token);

    // Read-only resolve, purely to get the join_link_id lock key - mirrors
    // every other join-link mutation's "resolve without mutation, then
    // lock, then re-check" pattern. Never trusted past this point; the
    // token/application/link rows are all re-loaded FOR UPDATE below.
    const resolved = await query(
      `select a.join_link_id
       from public.email_verification_tokens t
       join public.athlete_join_applications a on a.id = t.athlete_join_application_id
       where t.token_hash = $1 and t.purpose = 'athlete_join_application'
       limit 1`,
      [tokenHash],
    );
    if (!resolved.rows[0]) return genericInvalid();

    await client.query("begin");
    const exec = (text, params) => client.query(text, params);
    // Same per-join-link lock every other mutation (apply/apply-existing/
    // regenerate/revoke/approve/reject) already acquires FIRST, before
    // touching anything else. This is what actually prevents a deadlock
    // against revoke/reject: those close out an application (locking its
    // row) and then revoke its verification token (locking the token row) -
    // the exact reverse order this handler used to lock in. Two
    // transactions taking row locks in opposite orders is a classic
    // deadlock; serializing both through this same advisory lock first
    // means only one of them is ever inside its row-locking section for
    // this join link at a time, so the row-lock order beneath it no longer
    // matters.
    await lockJoinLinkActions(exec, resolved.rows[0].join_link_id);

    const linkResult = await client.query(
      `select id, context_type, context_id, created_by_user_id, is_active, revoked_at, expires_at
       from public.athlete_join_links where id = $1 limit 1 for update`,
      [resolved.rows[0].join_link_id],
    );
    const link = linkResult.rows[0];
    if (!link) {
      await client.query("rollback");
      return genericInvalid();
    }

    const tokenResult = await client.query(
      `select id, athlete_join_application_id, expires_at, consumed_at, revoked_at
       from public.email_verification_tokens
       where token_hash = $1 and purpose = 'athlete_join_application'
       limit 1
       for update`,
      [tokenHash],
    );
    const tokenRow = tokenResult.rows[0];
    if (!tokenRow || tokenRow.consumed_at || tokenRow.revoked_at || new Date(tokenRow.expires_at) <= new Date()) {
      await client.query("rollback");
      return genericInvalid();
    }

    const appResult = await client.query(
      `select id, join_link_id, applicant_user_id, email, status
       from public.athlete_join_applications where id = $1 limit 1 for update`,
      [tokenRow.athlete_join_application_id],
    );
    const application = appResult.rows[0];
    // applicant_user_id must be null (this purpose is only ever issued for
    // a new-email application - see issueEmailVerificationToken's only
    // caller), and status must still be 'pending' - anything else (already
    // rejected, cancelled, or somehow already approved) means this token no
    // longer leads anywhere useful.
    if (!application || String(application.join_link_id) !== String(link.id) || application.applicant_user_id || application.status !== "pending") {
      await client.query("rollback");
      return genericInvalid();
    }

    // Re-check the link/context is still real - it may have expired, been
    // revoked, or its context (archived club/team, private coach who lost
    // the role) may no longer be valid since this token was issued. Reuses
    // the exact same cleanup service every other flow uses (sweep/approve/
    // reject/resend) rather than re-implementing the check here: if the
    // link is dead, this closes the application (and this token, and any
    // sibling ones) as 'cancelled' with the password hash cleared, so a
    // revoked/expired link can never end up with an approvable application
    // just because its email got confirmed in the same instant. From here
    // on, every early exit COMMITS rather than rolls back - this cleanup is
    // a real mutation that must survive.
    const closed = await closeUnusableJoinLinkApplications(exec, link);
    if (closed > 0) {
      await client.query("commit");
      return genericInvalid();
    }

    // Re-check the email hasn't been claimed by a real account since this
    // application was submitted - mirrors the same race handled at approval
    // time (see POST .../approve). Confirming control of the inbox is not
    // itself proof this exact email is still free to create a new account
    // with.
    const emailOwner = await client.query(`select id from public.users where lower(email) = lower($1) limit 1`, [application.email]);
    if (emailOwner.rows[0]) {
      await client.query(
        `update public.athlete_join_applications set status = 'requires_login', password_hash = null, updated_at = now() where id = $1`,
        [application.id],
      );
      await client.query(`update public.email_verification_tokens set revoked_at = now(), updated_at = now() where id = $1`, [tokenRow.id]);
      await client.query("commit");
      return res.status(409).json({ error: "EMAIL_NOW_EXISTS_REQUIRES_LOGIN" });
    }

    await client.query(`update public.athlete_join_applications set email_verified_at = now(), updated_at = now() where id = $1`, [application.id]);
    await client.query(`update public.email_verification_tokens set consumed_at = now(), updated_at = now() where id = $1`, [tokenRow.id]);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// Resends a verification email for a pending, not-yet-verified, brand-new-
// email application. ALWAYS returns the exact same generic response
// regardless of what actually happened (no matching application, already
// verified/reviewed, rate-limited) - this endpoint must never be usable to
// probe whether a given email has a pending request at all.
router.post("/email-verifications/resend", async (req, res, next) => {
  const genericResponse = () => res.json({ ok: true, message: "If a pending request needs email verification, a new link has been sent." });
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return genericResponse();

    const ip = requestIp(req);
    if (!allowResendAttemptForIp(ip)) return genericResponse();

    const candidate = await query(
      `select id, join_link_id from public.athlete_join_applications
       where lower(email) = $1 and applicant_user_id is null and status = 'pending'
       order by submitted_at desc
       limit 1`,
      [email],
    );
    if (!candidate.rows[0]) return genericResponse();

    const client = await pool.connect();
    let verificationToken;
    let verificationTokenId;
    let verificationExpiresAt;
    let contextLabel;
    let recipientEmail;
    let recipientName;
    let shouldSend = false;
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      await lockJoinLinkActions(exec, candidate.rows[0].join_link_id);

      const appResult = await client.query(
        `select id, join_link_id, email, first_name, last_name, display_name, applicant_user_id, status
         from public.athlete_join_applications where id = $1 limit 1 for update`,
        [candidate.rows[0].id],
      );
      const application = appResult.rows[0];
      if (!application || application.applicant_user_id || application.status !== "pending") {
        await client.query("commit");
        return genericResponse();
      }

      const linkResult = await client.query(
        `select id, context_type, context_id, created_by_user_id, is_active, revoked_at, expires_at
         from public.athlete_join_links where id = $1 limit 1 for update`,
        [application.join_link_id],
      );
      const link = linkResult.rows[0];
      // Same opportunistic cleanup every other authenticated/management flow
      // performs - a dead link (expired/revoked/archived context) must never
      // let a resend through, and this also closes the application + clears
      // its password hash if that's what just happened.
      if (link) await closeUnusableJoinLinkApplications(exec, link);
      const recheck = await client.query(`select status from public.athlete_join_applications where id = $1`, [application.id]);
      if (!recheck.rows[0] || recheck.rows[0].status !== "pending") {
        await client.query("commit");
        return genericResponse();
      }

      const lastSentAt = await loadLastVerificationTokenSentAt(exec, application.id);
      if (resentTooSoon(lastSentAt)) {
        await client.query("commit");
        return genericResponse();
      }

      const issued = await issueEmailVerificationToken(exec, { applicationId: application.id, email: application.email });
      verificationToken = issued.rawToken;
      verificationTokenId = issued.tokenId;
      verificationExpiresAt = issued.expiresAt;
      contextLabel = link ? await loadJoinLinkContextName(exec, link) : "";
      recipientEmail = application.email;
      recipientName = application.first_name || application.display_name || "";
      shouldSend = true;
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (shouldSend) {
      const verificationUrl = `${resolveAppOrigin(req)}/verify-email?token=${encodeURIComponent(verificationToken)}`;
      try {
        await sendEmailVerification({ to: recipientEmail, verificationUrl, recipientName, contextLabel, expiresAt: verificationExpiresAt });
        // Only marked sent once the provider call actually succeeded - a
        // failed send here must never block an immediate retry (the
        // throttle above is keyed off sent_at, never created_at).
        await markVerificationTokenSent(query, verificationTokenId);
      } catch (emailError) {
        console.error("Failed to send verification resend email:", emailError instanceof EmailConfigError || emailError instanceof EmailSendError ? emailError.message : "unexpected error");
      }
      if (!isProduction) {
        return res.json({ ok: true, message: "If a pending request needs email verification, a new link has been sent.", devVerificationToken: verificationToken });
      }
    }
    return genericResponse();
  } catch (error) {
    next(error);
  }
});

router.get("/join-applications/:statusToken", async (req, res, next) => {
  try {
    const statusTokenHash = hashInviteToken(req.params.statusToken);
    const result = await query(
      `select a.status, a.submitted_at, a.reviewed_at, a.rejection_reason,
              l.label, l.context_type, l.context_id, l.created_by_user_id
       from public.athlete_join_applications a
       join public.athlete_join_links l on l.id = a.join_link_id
       where a.status_token_hash = $1
       limit 1`,
      [statusTokenHash],
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Request not found." });
    const contextName = await loadJoinLinkContextName(query, { context_type: row.context_type, context_id: row.context_id, created_by_user_id: row.created_by_user_id });
    res.json({
      application: {
        status: row.status,
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
        rejectionReason: row.status === "rejected" ? row.rejection_reason : null,
        contextLabel: row.label || contextName,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    await destroySession(req.sessionToken);
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.display_name || user.full_name || user.email,
    role: publicRole(user),
    role_hint: user.role_hint || "user",
    accessScope: accessScope(user),
  };
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function splitName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "Athlete",
    lastName: parts.slice(1).join(" "),
  };
}

export default router;
