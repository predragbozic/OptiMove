import { Router } from "express";
import { query } from "../db.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  sessionCookie,
  verifyPassword,
} from "../auth.js";

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
    role: user.role_hint || "user",
  };
}

export default router;
