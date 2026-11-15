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
const CLIENT_KEYS = new Set(["screen", "action", "code", "status", "stackSig", "release", "reason", "device"]);
// What failed, as one word of a closed list: the kind of the rejection's reason or of the error object (its `name`,
// never its message). A native rejection (an aborted request, a refused play() or full screen) has no script frames,
// so without this word such an error says nothing about itself. Only the codes below take one; it is stored as the
// code's second part ("unhandled_rejection.aborterror"), so no column is added.
export const CLIENT_REASONS = Object.freeze(["aborterror", "notallowederror", "notsupportederror", "invalidstateerror", "securityerror", "networkerror",
  "timeouterror", "quotaexceedederror", "typeerror", "referenceerror", "rangeerror", "syntaxerror", "other_error", "non_error", "none", "script_error", "no_error_object"]);
export const CODES_WITH_REASON = Object.freeze(["unhandled_rejection", "js_error", "handler_error"]);

// Version 1 of the user hash (v58): unkeyed. No new row gets it from v70 on; it stays so the rows written before the
// keyed hash can still be matched until they age out (30 days).
export function userHash(userId) {
  if (!userId) return null;
  return crypto.createHash("sha256").update(`app-error-user:${String(userId)}`).digest("hex").slice(0, 12);
}

// ---- the keyed user hash (v70; docs/ai/app-health-device-person-plan.md, 10.1) ----
// The key ring: "2:<base64 of at least 32 bytes>;3:<...>". The highest version is the one new rows get; an older one
// stays in the ring for 30 days after a rotation so its rows still resolve. Version 1 is the unkeyed hash and can
// never be a key's version. The keys are read when a hash is made, never logged and never sent to the database.
export const USER_HASH_KEYS_ENV = "APP_ERROR_USER_HASH_KEYS";
export const FIRST_KEYED_VERSION = 2;
const MIN_KEY_BYTES = 32;
let ringCache = { spec: null, ring: null };
export function parseUserHashKeys(spec) {
  if (typeof spec !== "string" || !spec.trim()) return null;
  const keys = new Map();
  for (const part of spec.split(";").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,3}):([A-Za-z0-9+/]+={0,2})$/);
    if (!m) return null;
    const version = Number(m[1]);
    const key = Buffer.from(m[2], "base64");
    if (version < FIRST_KEYED_VERSION || version > 999 || key.length < MIN_KEY_BYTES || keys.has(version)) return null;
    keys.set(version, key);
  }
  if (!keys.size) return null;
  return { keys, current: Math.max(...keys.keys()) };
}
function userHashRing() {
  const spec = process.env[USER_HASH_KEYS_ENV] ?? "";
  if (ringCache.spec !== spec) ringCache = { spec, ring: parseUserHashKeys(spec) };
  return ringCache.ring;
}
// Whether people can be counted and shown: "keyed" with a usable ring, else "not_configured".
export function userHashKeyState() { return userHashRing() ? "keyed" : "not_configured"; }
let warnedNoKey = false;
export function resetUserHashWarningForTests() { warnedNoKey = false; ringCache = { spec: null, ring: null }; }
// The keyed hash of a user for one version of the ring, or null (no user, or no such key).
export function keyedUserHash(userId, version) {
  const key = userId ? userHashRing()?.keys.get(version) : null;
  if (!key) return null;
  return crypto.createHmac("sha256", key).update(`app-error-user:${String(userId)}`).digest("hex").slice(0, 12);
}
// Said once per process, at the server's start and again at the first row should the ring go missing later: the
// variable's name only, never a part of its value.
export function warnIfUserHashKeyMissing() {
  if (userHashRing() || warnedNoKey) return;
  warnedNoKey = true;
  console.warn(`[app-errors] people cannot be counted or shown: ${USER_HASH_KEYS_ENV} is not set or not readable`);
}
// What a new row stores: the current key's hash and its version. Without a usable ring the row is stored WITHOUT a
// hash - never with the unkeyed one: a silent return to the weaker scheme is what the key is there to prevent.
export function userHashForNewRow(userId) {
  const ring = userHashRing();
  if (!ring) {
    warnIfUserHashKeyMissing();
    return { hash: null, version: FIRST_KEYED_VERSION };
  }
  return { hash: keyedUserHash(userId, ring.current), version: ring.current };
}
// Every version of the ring, newest first (the resolution of AH-3 tries each).
export function userHashVersions() { return [...(userHashRing()?.keys.keys() ?? [])].sort((a, b) => b - a); }

// ---- the device facts of a browser report (v70): closed lists only, reduced in the browser ----
export const DEVICE_LISTS = Object.freeze({
  class: Object.freeze(["phone", "tablet", "desktop", "unknown"]),
  os: Object.freeze(["ios", "android", "windows", "macos", "linux", "chromeos", "other"]),
  browser: Object.freeze(["safari", "chrome", "firefox", "edge", "samsung", "webview", "other"]),
  viewport: Object.freeze(["lt_360", "360_479", "480_767", "768_1023", "1024_1439", "ge_1440"]),
});
const DEVICE_KEYS = new Set(["class", "os", "browser", "major", "viewport", "touch"]);
// The device of a report: exactly the allowed keys, each a word of its list (a number 1-999, a boolean), or null
// for a report that is refused. A report without the key has no device (an older page).
export function sanitizeDevice(device) {
  if (device === undefined || device === null) return {};
  if (typeof device !== "object" || Array.isArray(device)) return null;
  for (const key of Object.keys(device)) if (!DEVICE_KEYS.has(key)) return null;
  const out = {};
  for (const key of ["class", "os", "browser", "viewport"]) {
    if (device[key] == null) continue;
    if (typeof device[key] !== "string" || !DEVICE_LISTS[key].includes(device[key])) return null;
    out[key] = device[key];
  }
  if (device.major != null) {
    if (!Number.isInteger(device.major) || device.major < 1 || device.major > 999 || !out.browser) return null;
    out.major = device.major;
  }
  if (device.touch != null) {
    if (typeof device.touch !== "boolean") return null;
    out.touch = device.touch;
  }
  return out;
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
  const device = sanitizeDevice(body.device);
  if (device === null) return null;
  if (reason != null && (typeof reason !== "string" || !CLIENT_REASONS.includes(reason) || !CODES_WITH_REASON.includes(code))) return null;
  if (typeof screen !== "string" || !SCREEN.test(screen)) return null;
  if (action != null && (typeof action !== "string" || !WORD.test(action))) return null;
  if (typeof code !== "string" || !WORD.test(code)) return null;
  if (status != null && !(Number.isInteger(status) && status >= 100 && status <= 599)) return null;
  if (stackSig != null && typeof stackSig !== "string") return null;
  if (release != null && typeof release !== "string") return null;
  const stackSignature = stackSig == null ? null : cleanStackSignature(stackSig);
  if (stackSig != null && stackSignature === null) return null;
  return { source: "client", screen, routeTemplate: null, action: action ?? null, code: reason == null ? code : `${code}.${reason}`, status: status ?? null, stackSignature, release: releaseOf(release), device };
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
  // A hash is stored only with the version that says how it was made: a keyed hash labelled unkeyed could never be resolved.
  if (hash !== null && event.userHashVersion == null) throw new Error("writeEvent: a user hash needs its version");
  const hashVersion = event.userHashVersion ?? 1;
  // The device of a browser report; a server error has none (the table refuses one).
  const d = event.source === "client" ? event.device || {} : {};
  const device = [d.class ?? null, d.os ?? null, d.browser ?? null, d.major ?? null, d.viewport ?? null, d.touch ?? null];
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
                       and user_hash_version = $3
                       and device_class is not distinct from $4 and os_family is not distinct from $5 and browser_family is not distinct from $6
                       and browser_major is not distinct from $7::smallint and viewport_bucket is not distinct from $8 and touch is not distinct from $9::boolean
                     order by last_seen_at desc limit 1)
        returning id`,
      [fingerprint, hash, hashVersion, ...device],
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
          `insert into public.app_error_events (fingerprint, source, screen, route_template, action, error_code, http_status, role, release_commit, user_hash, stack_signature,
                                                user_hash_version, device_class, os_family, browser_family, browser_major, viewport_bucket, touch)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [fingerprint, event.source, event.screen ?? null, event.routeTemplate ?? null, event.action ?? null, event.code, event.status ?? null, event.role, event.release ?? null, hash, event.stackSignature ?? null,
            hashVersion, ...device],
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
// Without the hashing key every signed-in row is a row "without a user" and shares one cap (MAX_ROWS_WITHOUT_USER_WINDOW
// an hour in all). So that one person cannot use it up for everyone, each user's reports are then counted in memory,
// by the id itself (never stored): beyond NO_KEY_REPORTS_PER_USER_WINDOW an hour a report is dropped silently.
export const NO_KEY_REPORTS_PER_USER_WINDOW = 40;
const noKeyReports = new Map();
export function resetNoKeyReportsForTests() { noKeyReports.clear(); }
function allowNoKeyReport(userId, nowMs = Date.now()) {
  const hour = Math.floor(nowMs / 3_600_000);
  if (noKeyReports.size > 5000) for (const [k2, v] of noKeyReports) if (v.hour !== hour) noKeyReports.delete(k2);
  const entry = noKeyReports.get(userId);
  if (!entry || entry.hour !== hour) { noKeyReports.set(userId, { hour, n: 1 }); return true; }
  entry.n += 1;
  return entry.n <= NO_KEY_REPORTS_PER_USER_WINDOW;
}
export async function recordClientError(req, report) {
  const who = userHashForNewRow(req.user?.id);
  if (who.hash === null && req.user?.id && !allowNoKeyReport(String(req.user.id))) return "dropped";
  return writeEvent({ ...report, role: roleOf(req.authz), userHash: who.hash, userHashVersion: who.version });
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
    const who = userHashForNewRow(req.user?.id);
    const event = { source: "server", screen: null, routeTemplate, action: null, code, status, stackSignature: stackSignatureFromError(error), role: roleOf(req.authz), userHash: who.hash, userHashVersion: who.version, release: releaseOf(null) };
    // A 5xx storm must not become a second storm on the pool: an in-memory repeat filter and a bound on writes in flight.
    const fp = fingerprintOf({ source: "server", where: routeTemplate, action: null, code, status, stackSignature: event.stackSignature });
    // Per user by the id itself (in memory only, never stored): without the hashing key every hash is null, and two
    // people hitting the same error must still both count.
    const key = `${req.user?.id || "none"}:${fp}`;
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
export const MAX_DEVICE_LINES = 3;
export async function listErrorGroups({ days = 7, limit = 100 } = {}, { executor = pool } = {}) {
  const d = Math.min(Math.max(Number.isInteger(days) ? days : 7, 1), RETENTION_DAYS);
  const l = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 200);
  // One snapshot and one "now" for the counts and the devices: the two reads always agree with each other.
  const client = await executor.connect();
  let rows; let devices;
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    await client.query("set local statement_timeout = '10s'");
    rows = (await client.query(
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
            array_agg(distinct role) as roles,
            coalesce(sum(repeat_count) filter (where source = 'client' and device_class is null and os_family is null and browser_family is null), 0)::int as no_device
       from public.app_error_events
      where last_seen_at > now() - make_interval(days => $1)
      group by fingerprint
      order by max(last_seen_at) desc
      limit $2`,
    [d, l],
  )).rows;
  // The devices of the listed kinds of error, in the same period: per kind the MAX_DEVICE_LINES most frequent
  // (class, system, browser, version), how many other combinations there are, and how often no device was recorded
  // (a row from before v70 or from an older page). Browser reports only: a server error has no device.
    devices = rows.length ? (await client.query(
    `select fingerprint, device_class, os_family, browser_family, browser_major, n, combos, total, rn
       from (select fingerprint, device_class, os_family, browser_family, browser_major, sum(repeat_count)::int as n,
                    (count(*) over (partition by fingerprint))::int as combos,
                    (sum(sum(repeat_count)) over (partition by fingerprint))::int as total,
                    (row_number() over (partition by fingerprint order by sum(repeat_count) desc, max(last_seen_at) desc,
                                         device_class, os_family, browser_family, browser_major))::int as rn
               from public.app_error_events
              where last_seen_at > now() - make_interval(days => $1) and source = 'client' and fingerprint = any($2::text[])
                and (device_class is not null or os_family is not null or browser_family is not null)
              group by fingerprint, device_class, os_family, browser_family, browser_major) d
      where rn <= ${MAX_DEVICE_LINES}
      order by fingerprint, rn`,
    [d, rows.map((r) => r.fingerprint)],
    )).rows : [];
    await client.query("commit");
  } catch (error) {
    try { await client.query("rollback"); } catch { /* the connection is released below */ }
    throw error;
  } finally {
    client.release();
  }
  const byKind = new Map();
  for (const row of devices) {
    const entry = byKind.get(row.fingerprint) || { list: [], combos: row.combos, total: row.total };
    entry.list.push({ class: row.device_class, os: row.os_family, browser: row.browser_family, major: row.browser_major, occurrences: row.n });
    byKind.set(row.fingerprint, entry);
  }
  return rows.map((r) => {
    const dev = byKind.get(r.fingerprint);
    return {
      fingerprint: r.fingerprint, source: r.source, screen: r.screen, routeTemplate: r.route_template, action: r.action, code: r.error_code,
      status: r.http_status, release: r.release_commit, stackSignature: r.stack_signature, occurrences: r.occurrences, users: r.users,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, roles: r.roles,
      devices: dev ? dev.list : [], otherDevices: dev ? Math.max(dev.combos - dev.list.length, 0) : 0,
      otherDeviceOccurrences: dev ? Math.max(dev.total - dev.list.reduce((n, x) => n + x.occurrences, 0), 0) : 0, deviceNotRecorded: r.no_device,
    };
  });
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

// "Who looked" (public.app_error_person_lookups, v70) is kept one year; the table's own guard refuses a younger row.
export const LOOKUP_RETENTION_DAYS = 365;
export async function purgePersonLookups({ executor = pool } = {}) {
  const client = await executor.connect();
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '10s'");
    await client.query("set local lock_timeout = '2s'");
    const deleted = (await client.query(
      `delete from public.app_error_person_lookups where id in (select id from public.app_error_person_lookups where looked_at < now() - make_interval(days => $1) order by id limit ${PURGE_BATCH})`,
      [LOOKUP_RETENTION_DAYS],
    )).rowCount;
    await client.query("commit");
    return deleted;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* the connection is released below */ }
    throw error;
  } finally {
    client.release();
  }
}

export function startAppErrorRetentionSchedule({ intervalHours = PURGE_INTERVAL_HOURS, startupDelayMs = 60_000 } = {}) {
  const failed = (e) => console.error(`[app-errors] purge failed: ${String(e?.code || "error").replace(/[^A-Za-z0-9_.-]/g, "")}`);
  const tick = () => purgeAppErrorEvents().catch(failed).then(() => purgePersonLookups()).catch(failed);
  warnIfUserHashKeyMissing();
  const first = setTimeout(tick, startupDelayMs);
  first.unref();
  const every = setInterval(tick, intervalHours * 3_600_000);
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
