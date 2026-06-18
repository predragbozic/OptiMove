import crypto from "node:crypto";
import { query } from "./db.js";

const COOKIE_NAME = "optimove_session";
const SESSION_DAYS = 14;
const HASH_ITERATIONS = 210000;
const HASH_KEYLEN = 32;
const HASH_DIGEST = "sha256";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.pbkdf2Sync(String(password), salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString("base64url");
  return `pbkdf2:${HASH_DIGEST}:${HASH_ITERATIONS}:${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split(":");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") return false;
  const [, digest, iterationsText, salt, expected] = parts;
  const iterations = Number(iterationsText);
  if (!iterations || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, HASH_KEYLEN, digest).toString("base64url");
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function sessionCookie(token, secure = false) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `insert into public.auth_sessions (user_id, token_hash, expires_at) values ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );
  return token;
}

export async function destroySession(token) {
  if (!token) return;
  await query("delete from public.auth_sessions where token_hash = $1", [hashSessionToken(token)]);
}

export async function getSessionUser(token) {
  if (!token) return null;
  const result = await query(
    `
    select u.id, u.email, u.full_name, u.display_name, u.role_hint
    from public.auth_sessions s
    join public.users u on u.id = s.user_id
    where s.token_hash = $1
      and s.expires_at > now()
      and u.is_active = true
    `,
    [hashSessionToken(token)],
  );
  return result.rows[0] || null;
}

export async function authMiddleware(req, _res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    req.sessionToken = cookies[COOKIE_NAME] || "";
    req.user = await getSessionUser(req.sessionToken);
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: "Unauthorized" });
}

export function requireCoach(req, res, next) {
  if (req.user && req.user.role_hint !== "athlete") return next();
  res.status(403).json({ error: "Forbidden" });
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
}
