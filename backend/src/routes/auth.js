import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db.js";
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

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

    const result = await query(
      `
      select id, email, full_name, display_name, role_hint, password_hash
      from public.users
      where lower(email) = $1
        and is_active = true
      limit 1
      `,
      [email],
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
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

router.post("/invites/:token/accept", async (req, res, next) => {
  try {
    const password = String(req.body?.password || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const tokenHash = hashInviteToken(req.params.token);
    const inviteResult = await query(
      `
      select i.id, i.email, i.athlete_id,
             coalesce(a.display_name, a.full_name, a.athlete_id, i.email) as athlete_name
      from public.athlete_invites i
      join public.athletes a on a.id = i.athlete_id
      where i.token_hash = $1
        and i.accepted_at is null
        and i.expires_at > now()
      limit 1
      `,
      [tokenHash],
    );
    const invite = inviteResult.rows[0];
    if (!invite) return res.status(404).json({ error: "Invite is invalid or expired." });
    const nameParts = splitName(invite.athlete_name || invite.email);
    const userResult = await query(
      `
      insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
      values ($1, $2, $3, $4, $5, $5, 'athlete', true)
      on conflict (email) do update
        set password_hash = excluded.password_hash,
            role_hint = 'athlete',
            is_active = true,
            updated_at = now()
      returning id, email, full_name, display_name, role_hint
      `,
      [invite.email, nameParts.firstName, nameParts.lastName, hashPassword(password), invite.athlete_name],
    );
    const user = userResult.rows[0];
    await query(`update public.athletes set user_id = $2 where id = $1`, [invite.athlete_id, user.id]);
    await query(
      `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
       values ($1, $2, 'athlete', true)
       on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
      [user.id, invite.athlete_id],
    );
    await query(
      `update public.athlete_invites set accepted_by_user_id = $2, accepted_at = now() where id = $1`,
      [invite.id, user.id],
    );
    const token = await createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookie(token, req.secure || req.headers["x-forwarded-proto"] === "https"));
    res.json({ user: publicUser(user) });
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
    lastName: parts.slice(1).join(" ") || null,
  };
}

export default router;
