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

const router = Router();

router.get("/me", async (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
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

router.get("/invites/:token", async (req, res, next) => {
  try {
    const tokenHash = hashInviteToken(req.params.token);
    const result = await query(
      `
      select i.id, i.email, i.expires_at,
             coalesce(a.display_name, a.full_name, a.athlete_id) as athlete_name,
             a.athlete_id as athlete_code
      from public.athlete_invites i
      join public.athletes a on a.id = i.athlete_id
      where i.token_hash = $1
        and i.accepted_at is null
        and i.expires_at > now()
      limit 1
      `,
      [tokenHash],
    );
    const invite = result.rows[0];
    if (!invite) return res.status(404).json({ error: "Invite is invalid or expired." });
    res.json({ invite });
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

    await client.query("begin");
    const inviteResult = await client.query(
      `
      select i.id, i.email, i.athlete_id, a.user_id as athlete_user_id, u.role_hint as athlete_user_role_hint,
             coalesce(a.display_name, a.full_name, a.athlete_id, i.email) as athlete_name
      from public.athlete_invites i
      join public.athletes a on a.id = i.athlete_id
      left join public.users u on u.id = a.user_id
      where i.token_hash = $1
        and i.accepted_at is null
        and i.expires_at > now()
      limit 1
      for update of i
      `,
      [tokenHash],
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      await client.query("rollback");
      return res.status(404).json({ error: "Invite is invalid or expired." });
    }

    const emailOwner = await client.query(`select id from public.users where lower(email) = lower($1) limit 1`, [invite.email]);
    if (emailOwner.rows[0]) {
      await client.query("rollback");
      return res.status(409).json({
        error: "An account with this email already exists. Log in with your existing password, then accept this invite from your account.",
        requiresLogin: true,
      });
    }

    // Only trust an existing link if it actually points to an athlete-role account.
    // A link to a coach/admin account is bad data (e.g. from a past bug) and must
    // never be renamed or have its password overwritten - treat it as unset instead.
    const linkedAthleteUserId = invite.athlete_user_role_hint === "athlete" ? invite.athlete_user_id : null;
    const nameParts = splitName(invite.athlete_name || invite.email);
    const passwordHash = hashPassword(password);

    let user;
    if (linkedAthleteUserId) {
      // Athlete already has a login under a different (now-unused) email:
      // rename/reset that same account instead of creating a second user row
      // and leaving the old one as an orphan.
      const updated = await client.query(
        `update public.users
         set email = $2,
             password_hash = $3,
             role_hint = 'athlete',
             is_active = true,
             updated_at = now()
         where id = $1
         returning id, email, full_name, display_name, role_hint`,
        [linkedAthleteUserId, invite.email, passwordHash],
      );
      user = updated.rows[0];
    } else {
      const inserted = await client.query(
        `
        insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
        values ($1, $2, $3, $4, $5, $5, 'athlete', true)
        returning id, email, full_name, display_name, role_hint
        `,
        [invite.email, nameParts.firstName, nameParts.lastName, passwordHash, invite.athlete_name],
      );
      user = inserted.rows[0];
    }
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

    await client.query("begin");
    const inviteResult = await client.query(
      `
      select i.id, i.email, i.athlete_id, a.user_id as athlete_user_id, u.role_hint as athlete_user_role_hint
      from public.athlete_invites i
      join public.athletes a on a.id = i.athlete_id
      left join public.users u on u.id = a.user_id
      where i.token_hash = $1
        and i.accepted_at is null
        and i.expires_at > now()
      limit 1
      for update of i
      `,
      [tokenHash],
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      await client.query("rollback");
      return res.status(404).json({ error: "Invite is invalid or expired." });
    }
    if (String(invite.email).toLowerCase() !== String(req.user.email).toLowerCase()) {
      await client.query("rollback");
      return res.status(403).json({ error: "This invite was sent to a different email address." });
    }
    const linkedAthleteUserId = invite.athlete_user_role_hint === "athlete" ? invite.athlete_user_id : null;
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
    await client.query("commit");
    res.json({ ok: true, athleteId: invite.athlete_id });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
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
