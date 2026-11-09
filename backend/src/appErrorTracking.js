// Option A, A1: a sanitized record of the errors the app hit (migration v58, public.app_error_events).
//
// Nothing a person typed or a source returned is ever stored. A report is reduced to closed shapes here, and the
// table's CHECKs refuse anything else again: screen / action / error_code words, a route pattern with ids replaced,
// a stack signature of function@file names, a 12-hex hash of the user id, a release commit. Free text (an error
// message, a request body, a query string, a name, an e-mail, a token, a content string) has no column.
import crypto from "node:crypto";
import { pool } from "./db.js";
import { isPoolCheckoutTimeout } from "./db.js";
import { isPlatformAdministrator } from "./authz.js";

export const RETENTION_DAYS = 30;
export const REPEAT_WINDOW = "1 hour";
export const MAX_REPORT_BYTES = 4096;
export const MAX_ROWS_PER_USER_WINDOW = 100;
const PER_USER_PER_MINUTE = 20;
const PURGE_BATCH = 5000;
const PURGE_INTERVAL_HOURS = 6;

const WORD = /^[a-z0-9_.-]{1,60}$/;
const SCREEN = /^[a-z0-9_-]{1,60}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const CLIENT_KEYS = new Set(["screen", "action", "code", "status", "stackSig", "release"]);

export function userHash(userId) {
  if (!userId) return null;
  return crypto.createHash("sha256").update(`app-error-user:${String(userId)}`).digest("hex").slice(0, 12);
}

// A route pattern: ids (uuids, numbers, long tokens) become :id, anything outside the segment shape becomes :x,
// no query string, at most 120 characters. A pattern that is already a template (":teamId") passes unchanged.
export function normalizeRoute(value) {
  if (typeof value !== "string") return null;
  const path = value.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) return null;
  const segments = path.split("/").slice(1).map((seg) => {
    if (seg === "") return "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
    if (/^\d+$/.test(seg)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id";
    if (seg.length > 40) return ":id";
    if (!/^[A-Za-z0-9_.:-]+$/.test(seg)) return ":x";
    return seg;
  });
  const out = `/${segments.join("/")}`.slice(0, 120);
  return /^\/[A-Za-z0-9_/:.-]*$/.test(out) ? out : null;
}

// function@file names only, at most four frames, no line numbers, no message.
export function stackSignatureFromError(error) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const frames = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = line.match(/^\s*at\s+(?:async\s+)?(?:([^\s(]+)\s+)?\(?(?:file:\/\/)?([^():]+?)(?::\d+)?(?::\d+)?\)?\s*$/);
    if (!m) continue;
    const file = m[2];
    if (file.includes("node_modules") || file.startsWith("node:")) continue;
    const fn = (m[1] || "anonymous").replace(/[^A-Za-z0-9_.]/g, "").slice(0, 40) || "anonymous";
    const base = file.split(/[\\/]/).pop().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);
    if (!base) continue;
    frames.push(`${fn}@${base}`);
    if (frames.length >= 4) break;
  }
  return cleanStackSignature(frames.join(" > "));
}

export function cleanStackSignature(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^A-Za-z0-9_.@:/ >-]/g, "").trim().slice(0, 200);
  return cleaned || null;
}

export function fingerprintOf({ source, where, action, code, status, stackSignature }) {
  const parts = [source, where || "", action || "", code, status == null ? "" : String(status), stackSignature || ""];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

export function roleOf(authz) {
  if (!authz) return "none";
  if (isPlatformAdministrator(authz)) return "platform_admin";
  if (authz.platformRoles?.length || authz.clubRoles?.length || authz.teamRoles?.length || authz.isIndependentCoach) return "coach";
  if (authz.isAthlete) return "athlete";
  return "user";
}

function releaseOf(clientValue) {
  if (typeof clientValue === "string" && COMMIT.test(clientValue)) return clientValue;
  const server = String(process.env.RENDER_GIT_COMMIT || "").toLowerCase();
  return COMMIT.test(server) ? server.slice(0, 40) : null;
}

// A browser report: exactly the allowed keys, each in its closed shape, or null (the route answers 400).
export function sanitizeClientReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const key of Object.keys(body)) if (!CLIENT_KEYS.has(key)) return null;
  const { screen, action, code, status, stackSig, release } = body;
  if (typeof screen !== "string" || !SCREEN.test(screen)) return null;
  if (action != null && (typeof action !== "string" || !WORD.test(action))) return null;
  if (typeof code !== "string" || !WORD.test(code)) return null;
  if (status != null && !(Number.isInteger(status) && status >= 100 && status <= 599)) return null;
  if (stackSig != null && typeof stackSig !== "string") return null;
  if (release != null && typeof release !== "string") return null;
  const stackSignature = cleanStackSignature(stackSig);
  return { source: "client", screen, routeTemplate: null, action: action ?? null, code, status: status ?? null, stackSignature, release: releaseOf(release) };
}

// ---- per-user rate limit (in memory, bounded) ----
const buckets = new Map();
export function allowReport(userId, nowMs = Date.now()) {
  const key = userHash(userId) || "none";
  const minute = Math.floor(nowMs / 60000);
  const b = buckets.get(key);
  if (!b || b.minute !== minute) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { minute, n: 1 });
    return true;
  }
  b.n += 1;
  return b.n <= PER_USER_PER_MINUTE;
}
export function resetRateLimitForTests() { buckets.clear(); }

// One write: the same user repeating the same fingerprint inside the window raises repeat_count on the existing row;
// otherwise a new row, unless the user already has MAX_ROWS_PER_USER_WINDOW rows in the window.
export async function writeEvent(event, { executor = pool } = {}) {
  const fingerprint = fingerprintOf({ source: event.source, where: event.screen || event.routeTemplate, action: event.action, code: event.code, status: event.status, stackSignature: event.stackSignature });
  const hash = event.userHash ?? null;
  const client = await executor.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '2s'");
    await client.query("set local statement_timeout = '5s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`app-error:${hash || "none"}:${fingerprint}`]);
    const bumped = await client.query(
      `update public.app_error_events
          set repeat_count = repeat_count + 1, last_seen_at = now()
        where id = (select id from public.app_error_events
                     where fingerprint = $1 and user_hash is not distinct from $2 and last_seen_at > now() - interval '${REPEAT_WINDOW}'
                     order by last_seen_at desc limit 1)
        returning id`,
      [fingerprint, hash],
    );
    let outcome = "counted";
    if (!bumped.rowCount) {
      const recent = hash
        ? (await client.query(`select count(*)::int as n from public.app_error_events where user_hash = $1 and first_seen_at > now() - interval '${REPEAT_WINDOW}'`, [hash])).rows[0].n
        : 0;
      if (recent >= MAX_ROWS_PER_USER_WINDOW) {
        outcome = "dropped";
      } else {
        await client.query(
          `insert into public.app_error_events (fingerprint, source, screen, route_template, action, error_code, http_status, role, release_commit, user_hash, stack_signature)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [fingerprint, event.source, event.screen ?? null, event.routeTemplate ?? null, event.action ?? null, event.code, event.status ?? null, event.role, event.release ?? null, hash, event.stackSignature ?? null],
        );
        outcome = "stored";
      }
    }
    await client.query("commit");
    return outcome;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* the connection is released below */ }
    throw error;
  } finally {
    client.release();
  }
}

// A browser report from a signed-in user.
export async function recordClientError(req, report) {
  return writeEvent({ ...report, role: roleOf(req.authz), userHash: userHash(req.user?.id) });
}

// A server error from the global handler: fire and forget, never throws, never touches the response. Only 5xx; only
// the route pattern, a code from a closed shape, the status and a function@file signature - never the message.
export function recordServerError(req, error, status) {
  try {
    if (!(status >= 500) || isPoolCheckoutTimeout(error)) return;
    const route = req.route?.path != null ? `${req.baseUrl || ""}${req.route.path}` : req.originalUrl || req.url || "";
    const routeTemplate = normalizeRoute(typeof route === "string" ? route : "") || "/unknown";
    const rawCode = typeof error?.code === "string" ? error.code.toLowerCase() : "";
    const code = WORD.test(rawCode) ? rawCode : "internal_error";
    writeEvent({ source: "server", screen: null, routeTemplate, action: null, code, status, stackSignature: stackSignatureFromError(error), role: roleOf(req.authz), userHash: userHash(req.user?.id), release: releaseOf(null) })
      .catch((e) => console.error(`[app-errors] not recorded: ${String(e?.code || "error").replace(/[^A-Za-z0-9_.-]/g, "")}`));
  } catch (e) {
    console.error(`[app-errors] not recorded: ${String(e?.code || "error").replace(/[^A-Za-z0-9_.-]/g, "")}`);
  }
}

// What the platform admin reads: groups by fingerprint over the last `days` days (1 to 30).
export async function listErrorGroups({ days = 7, limit = 100 } = {}, { executor = pool } = {}) {
  const d = Math.min(Math.max(Number.isInteger(days) ? days : 7, 1), RETENTION_DAYS);
  const l = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 200);
  const rows = (await executor.query(
    `select fingerprint,
            (array_agg(source order by last_seen_at desc))[1] as source,
            (array_agg(screen order by last_seen_at desc))[1] as screen,
            (array_agg(route_template order by last_seen_at desc))[1] as route_template,
            (array_agg(action order by last_seen_at desc))[1] as action,
            (array_agg(error_code order by last_seen_at desc))[1] as error_code,
            (array_agg(http_status order by last_seen_at desc))[1] as http_status,
            (array_agg(release_commit order by last_seen_at desc))[1] as release_commit,
            (array_agg(stack_signature order by last_seen_at desc))[1] as stack_signature,
            sum(repeat_count)::int as occurrences,
            count(distinct user_hash)::int as users,
            min(first_seen_at) as first_seen_at,
            max(last_seen_at) as last_seen_at,
            array_agg(distinct role) as roles
       from public.app_error_events
      where last_seen_at > now() - make_interval(days => $1)
      group by fingerprint
      order by max(last_seen_at) desc
      limit $2`,
    [d, l],
  )).rows;
  return rows.map((r) => ({
    fingerprint: r.fingerprint, source: r.source, screen: r.screen, routeTemplate: r.route_template, action: r.action, code: r.error_code,
    status: r.http_status, release: r.release_commit, stackSignature: r.stack_signature, occurrences: r.occurrences, users: r.users,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, roles: r.roles,
  }));
}

// Retention: rows whose last sighting is older than RETENTION_DAYS, in short batches.
export async function purgeAppErrorEvents({ executor = pool, days = RETENTION_DAYS } = {}) {
  let total = 0;
  for (let i = 0; i < 200; i += 1) {
    const r = await executor.query(
      `delete from public.app_error_events where id in (select id from public.app_error_events where last_seen_at < now() - make_interval(days => $1) order by id limit ${PURGE_BATCH})`,
      [days],
    );
    total += r.rowCount;
    if (r.rowCount < PURGE_BATCH) break;
  }
  return total;
}

export function startAppErrorRetentionSchedule({ intervalHours = PURGE_INTERVAL_HOURS, startupDelayMs = 60_000 } = {}) {
  const tick = () => purgeAppErrorEvents().catch((e) => console.error(`[app-errors] purge failed: ${String(e?.code || "error").replace(/[^A-Za-z0-9_.-]/g, "")}`));
  const first = setTimeout(tick, startupDelayMs);
  first.unref();
  const every = setInterval(tick, intervalHours * 3_600_000);
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
