// Option A, A1: a sanitized record of the errors the app hit (migration v58, public.app_error_events).
//
// Nothing a person typed or a source returned is ever stored. A report is reduced to closed shapes here, and the
// table's CHECKs refuse anything else again: screen / action / error_code words, a route pattern with ids replaced,
// a stack signature of function@file names, a 12-hex hash of the user id, a release commit. Free text (an error
// message, a request body, a query string, a name, an e-mail, a token, a content string) has no column.
import crypto from "node:crypto";
import { isPoolCheckoutTimeout, pool } from "./db.js";
import { isPlatformAdministrator } from "./authz.js";

export const RETENTION_DAYS = 30;
export const REPEAT_WINDOW = "1 hour";
export const MAX_REPORT_BYTES = 4096;
export const MAX_ROWS_PER_USER_WINDOW = 100;
export const MAX_ROWS_WITHOUT_USER_WINDOW = 200;
const MAX_IN_FLIGHT = 10;
const DEDUPE_MS = 60_000;
const PER_USER_PER_MINUTE = 20;
const PURGE_BATCH = 5000;
const PURGE_INTERVAL_HOURS = 6;

const WORD = /^[a-z0-9_.-]{1,60}$/;
const SCREEN = /^[a-z0-9_-]{1,60}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const CLIENT_KEYS = new Set(["screen", "action", "code", "status", "stackSig", "release", "reason"]);
// What failed, as one word of a closed list: the kind of the rejection's reason or of the error object (its `name`,
// never its message). A native rejection (an aborted request, a refused play() or full screen) has no script frames,
// so without this word such an error says nothing about itself. Only the codes below take one; it is stored as the
// code's second part ("unhandled_rejection.aborterror"), so no column is added.
export const CLIENT_REASONS = Object.freeze(["aborterror", "notallowederror", "notsupportederror", "invalidstateerror", "securityerror", "networkerror",
  "timeouterror", "quotaexceedederror", "typeerror", "referenceerror", "rangeerror", "syntaxerror", "other_error", "non_error", "none", "script_error", "no_error_object"]);
export const CODES_WITH_REASON = Object.freeze(["unhandled_rejection", "js_error", "handler_error"]);

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
  // The header ("Name: message") spans as many lines as the message does: skip all of them, so a message that contains a line
  // looking like a frame is never read as one.
  const headerLines = String(error?.message ?? "").split("\n").length;
  for (const line of stack.split("\n").slice(headerLines)) {
    const m = line.match(/^\s*at\s+(?:async\s+)?(?:([^\s(]+)\s+)?\(?(?:file:\/\/)?([^():]+?)(?::\d+)?(?::\d+)?\)?\s*$/);
    if (!m) continue;
    const file = m[2];
    if (file.includes("node_modules") || file.startsWith("node:")) continue;
    const fn = (m[1] || "anonymous").replace(/[^A-Za-z0-9_.]/g, "").slice(0, 40) || "anonymous";
    const base = file.split(/[\\/]/).pop().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);
    if (!base) continue;
    const frame = `${fn}@${base}`;
    if ([...frames, frame].join(" > ").length > 200) break; // whole frames only: keep what fits, never drop the signature
    frames.push(frame);
    if (frames.length >= 4) break;
  }
  return cleanStackSignature(frames.join(" > "));
}

// The grammar fn@file( > fn@file){0,3}: function and file names only. A sentence, an e-mail address or an error message
// does not match and is refused (it can still be encoded as fn@file by a hostile client; the column is a bounded shape).
const STACK_FRAME = "[A-Za-z0-9_$.]{1,40}@[A-Za-z0-9_.-]{1,40}";
const STACK_SIGNATURE = new RegExp(`^${STACK_FRAME}( > ${STACK_FRAME}){0,3}$`);
export function cleanStackSignature(value) {
  if (typeof value !== "string" || value.length > 200) return null;
  return STACK_SIGNATURE.test(value) ? value : null;
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
  const { screen, action, code, status, stackSig, release, reason } = body;
  if (reason != null && (typeof reason !== "string" || !CLIENT_REASONS.includes(reason) || !CODES_WITH_REASON.includes(code))) return null;
  if (typeof screen !== "string" || !SCREEN.test(screen)) return null;
  if (action != null && (typeof action !== "string" || !WORD.test(action))) return null;
  if (typeof code !== "string" || !WORD.test(code)) return null;
  if (status != null && !(Number.isInteger(status) && status >= 100 && status <= 599)) return null;
  if (stackSig != null && typeof stackSig !== "string") return null;
  if (release != null && typeof release !== "string") return null;
  const stackSignature = stackSig == null ? null : cleanStackSignature(stackSig);
  if (stackSig != null && stackSignature === null) return null;
  return { source: "client", screen, routeTemplate: null, action: action ?? null, code: reason == null ? code : `${code}.${reason}`, status: status ?? null, stackSignature, release: releaseOf(release) };
}

// ---- per-user rate limit (in memory, bounded) ----
const buckets = new Map();
export function allowReport(userId, nowMs = Date.now()) {
  const key = userHash(userId) || "none";
  const minute = Math.floor(nowMs / 60000);
  const b = buckets.get(key);
  if (!b || b.minute !== minute) {
    if (buckets.size > 5000) for (const [key2, v] of buckets) if (v.minute !== minute) buckets.delete(key2);
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
          set repeat_count = repeat_count + 1, last_seen_at = greatest(last_seen_at, clock_timestamp())
        where id = (select id from public.app_error_events
                     where fingerprint = $1 and user_hash is not distinct from $2 and last_seen_at > now() - interval '${REPEAT_WINDOW}'
                     order by last_seen_at desc limit 1)
        returning id`,
      [fingerprint, hash],
    );
    let outcome = "counted";
    if (!bumped.rowCount) {
      const recent = (await client.query(
        hash
          ? `select count(*)::int as n from public.app_error_events where user_hash = $1 and first_seen_at > now() - interval '${REPEAT_WINDOW}'`
          : `select count(*)::int as n from public.app_error_events where user_hash is null and first_seen_at > now() - interval '${REPEAT_WINDOW}' and $1::text is null`, [hash])).rows[0].n;
      if (recent >= (hash ? MAX_ROWS_PER_USER_WINDOW : MAX_ROWS_WITHOUT_USER_WINDOW)) {
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

const recentServer = new Map();
let inFlight = 0;
export function resetServerDedupeForTests() { recentServer.clear(); inFlight = 0; }

// A server error from the global handler: fire and forget, never throws, never touches the response. Only 5xx; only
// the route pattern, a code from a closed shape, the status and a function@file signature - never the message.
export function recordServerError(req, error, status, { executor = pool } = {}) {
  try {
    if (!(status >= 500) || isPoolCheckoutTimeout(error)) return;
    // The pattern is the route's own (code-defined). The mount prefix is lost by the time an error handler runs (baseUrl is
    // empty), so it is taken from the URL's leading segments, those before the segments the route's pattern covers, with the
    // usual id replacement. A request that matched no route (or whose pattern is not a plain string) is "/unmatched", never its URL.
    let routeTemplate = "/unmatched";
    if (typeof req.route?.path === "string") {
      const urlSegs = String(req.originalUrl || req.url || "").split("?")[0].split("/").filter(Boolean);
      const routeSegs = req.route.path.split("/").filter(Boolean);
      const prefix = urlSegs.slice(0, Math.max(0, urlSegs.length - routeSegs.length));
      routeTemplate = normalizeRoute(`/${[...prefix, ...routeSegs].join("/")}`) || "/unmatched";
    }
    const rawCode = typeof error?.code === "string" ? error.code.toLowerCase() : "";
    const code = WORD.test(rawCode) ? rawCode : "internal_error";
    const event = { source: "server", screen: null, routeTemplate, action: null, code, status, stackSignature: stackSignatureFromError(error), role: roleOf(req.authz), userHash: userHash(req.user?.id), release: releaseOf(null) };
    // A 5xx storm must not become a second storm on the pool: an in-memory repeat filter and a bound on writes in flight.
    const fp = fingerprintOf({ source: "server", where: routeTemplate, action: null, code, status, stackSignature: event.stackSignature });
    const key = `${event.userHash || "none"}:${fp}`;
    const now = Date.now();
    if (recentServer.size > 2000) for (const [k2, t] of recentServer) if (now - t > DEDUPE_MS) recentServer.delete(k2);
    if (now - (recentServer.get(key) ?? 0) < DEDUPE_MS || inFlight >= MAX_IN_FLIGHT) return;
    recentServer.set(key, now);
    inFlight += 1;
    writeEvent(event, { executor })
      .finally(() => { inFlight -= 1; })
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
    // One short transaction per batch with its own bounds: a purge never holds a lock or a connection for long.
    const client = await executor.connect();
    let deleted = 0;
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '10s'");
      await client.query("set local lock_timeout = '2s'");
      deleted = (await client.query(
        `delete from public.app_error_events where id in (select id from public.app_error_events where last_seen_at < now() - make_interval(days => $1) order by id limit ${PURGE_BATCH})`,
        [days],
      )).rowCount;
      await client.query("commit");
    } catch (error) {
      try { await client.query("rollback"); } catch { /* the connection is released below */ }
      throw error;
    } finally {
      client.release();
    }
    total += deleted;
    if (deleted < PURGE_BATCH) break;
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
