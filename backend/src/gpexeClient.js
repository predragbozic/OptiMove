// Read-only GPEXE API client for the in-app import (phase F1). It fetches the
// same responses the pilot's read-only fetch script collected, and returns
// them in the bundle shape buildGpexeImportPlan() reads
// (backend/scripts/gpexe-import-pilot.mjs loadGpexeBundle).
//
// Security (owner decisions 2026-09-18):
//   * the token comes only from the server environment (GPEXE_API_TOKEN); it
//     is never stored, logged, returned to a browser, or put in an error;
//   * the host is fixed; callers pass API paths only, never a URL, and
//     redirects are refused, so the token cannot be sent anywhere else;
//   * GET only;
//   * personal fields the importer does not need are removed before anything
//     is kept.
//
// GPEXE sometimes never answers a request: every attempt has a timeout, and a
// request is tried up to three times.

export const GPEXE_API_BASE = "https://e03.gpexe.com/api/";

// Removed from every response before it is stored anywhere.
const DROP_KEYS = new Set([
  "birthdate", "weight", "athlete_weight", "picture", "email", "lat", "lng",
  "athlete_name", "notes", "submitted_by", "weather", "roles",
]);

export class GpexeClientError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "GpexeClientError";
    this.code = code;
    this.status = status;
  }
}

export function redactGpexe(value) {
  if (Array.isArray(value)) return value.map(redactGpexe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !DROP_KEYS.has(k)).map(([k, v]) => [k, redactGpexe(v)]));
  }
  return value;
}

function listItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  return [];
}

function assertId(value, what) {
  if (!/^[0-9]{1,12}$/.test(String(value ?? ""))) throw new GpexeClientError("invalid_id", `${what} must be a numeric GPEXE id.`);
  return String(value);
}

function assertDay(value, what) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) throw new GpexeClientError("invalid_date", `${what} must be YYYY-MM-DD.`);
  return value;
}

// Page size for the session list. A window that returns a full page may be
// missing sessions, so the caller is told to use a shorter window.
export const SESSION_LIST_LIMIT = 100;
// athlete_session rows of one session: one whole-session row plus one per
// drill for every athlete. Pages are followed; a full page with no way to
// the next one is refused rather than silently cut.
export const ATHLETE_SESSION_PAGE = 100;
export const ATHLETE_SESSION_MAX_PAGES = 20;
// A session with more drills than this is refused: drills_count comes from
// GPEXE and drives one request per drill.
export const MAX_DRILLS = 30;

export function createGpexeClient({
  token = process.env.GPEXE_API_TOKEN,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  attempts = 3,
  retryDelayMs = 1_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!token || typeof token !== "string") {
    throw new GpexeClientError("token_missing", "GPEXE_API_TOKEN is not set on the server.");
  }

  async function get(apiPath) {
    if (typeof apiPath !== "string" || /^[a-z]+:/i.test(apiPath) || apiPath.startsWith("/") || apiPath.includes("..")) {
      throw new GpexeClientError("invalid_path", "only relative GPEXE API paths are allowed.");
    }
    const url = new URL(apiPath, GPEXE_API_BASE);
    if (!url.href.startsWith(GPEXE_API_BASE)) throw new GpexeClientError("invalid_path", "only GPEXE API paths are allowed.");

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: { Authorization: `Token ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Network error or timeout: the message never includes the token (it
        // is only in a header), but only the error's name is kept anyway.
        lastError = new GpexeClientError("unreachable", `GPEXE did not answer ${url.pathname} (${error?.name || "error"}).`);
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        throw new GpexeClientError("redirect_refused", `GPEXE answered ${url.pathname} with a redirect, which is refused.`, { status: res.status });
      }
      if (res.status === 401 || res.status === 403) {
        throw new GpexeClientError("unauthorized", "GPEXE refused the server's token (check GPEXE_API_TOKEN).", { status: res.status });
      }
      if (res.status === 404) {
        throw new GpexeClientError("not_found", `GPEXE has no ${url.pathname}.`, { status: 404 });
      }
      if (res.status >= 500 || res.status === 429) {
        lastError = new GpexeClientError("server_error", `GPEXE answered ${url.pathname} with ${res.status}.`, { status: res.status });
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
        continue;
      }
      if (res.status >= 400) {
        throw new GpexeClientError("request_refused", `GPEXE answered ${url.pathname} with ${res.status}.`, { status: res.status });
      }
      const text = await res.text();
      try {
        return redactGpexe(JSON.parse(text));
      } catch {
        throw new GpexeClientError("not_json", `GPEXE answered ${url.pathname} with something that is not JSON.`);
      }
    }
    throw lastError;
  }

  // Parent sessions whose start falls in [fromDay, toDay] (dates as GPEXE
  // stores them: naive UTC). Drills are listed by GPEXE as their own
  // sessions and named in their parent's `drills`; they are not candidates of
  // their own.
  async function listTeamSessions({ gpexeTeamId, fromDay, toDay }) {
    const team = assertId(gpexeTeamId, "gpexeTeamId");
    const from = assertDay(fromDay, "fromDay");
    const to = assertDay(toDay, "toDay");
    // One day earlier than asked: a drill that starts inside the window can
    // belong to a parent that started the evening before, and is only
    // recognisable as a drill through that parent's `drills`.
    const lookFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const body = await get(`team_session/?team=${team}&start_timestamp_gte=${lookFrom}%2000:00:00&start_timestamp_lte=${to}%2023:59:59&limit=${SESSION_LIST_LIMIT}`);
    const items = listItems(body);
    if (items.length >= SESSION_LIST_LIMIT) {
      throw new GpexeClientError("window_too_large", `GPEXE returned ${items.length} sessions for this window; choose a shorter one.`);
    }
    const foreign = items.filter((s) => String(s.team) !== team);
    if (foreign.length) throw new GpexeClientError("team_filter_ignored", `GPEXE returned sessions of another team for team ${team}.`);
    const drillIds = new Set(items.flatMap((s) => (Array.isArray(s.drills) ? s.drills.map(String) : [])));
    return items
      .filter((s) => !drillIds.has(String(s.id)))
      .filter((s) => String(s.start_timestamp ?? "").slice(0, 10) >= from)
      .map((s) => ({
        id: String(s.id),
        categoryName: s.category_name ?? null,
        startTimestamp: s.start_timestamp ?? null,
        updatedOn: s.updated_on ?? null,
        drillsCount: Number(s.drills_count ?? 0),
        isStatsValid: s.is_stats_valid === true,
      }));
  }

  // Every row of a paged list: follows `next` (only within the API base) or,
  // for a plain array, refuses a full page — never returns a silently cut list.
  async function getAllPages(apiPath, limit, step) {
    const out = [];
    let path = apiPath;
    for (let page = 0; page < ATHLETE_SESSION_MAX_PAGES; page += 1) {
      const body = await step(path);
      if (Array.isArray(body)) {
        if (body.length >= limit) throw new GpexeClientError("list_incomplete", `GPEXE returned a full page of ${body.length} rows for ${apiPath.split("?")[0]} with no next page.`);
        return out.concat(body);
      }
      out.push(...listItems(body));
      if (!body?.next) {
        if (Number.isFinite(Number(body?.count)) && out.length < Number(body.count)) {
          throw new GpexeClientError("list_incomplete", `GPEXE reported ${body.count} rows for ${apiPath.split("?")[0]} but returned ${out.length}.`);
        }
        return out;
      }
      if (typeof body.next !== "string" || !body.next.startsWith(GPEXE_API_BASE)) {
        throw new GpexeClientError("list_incomplete", "GPEXE pointed to a next page outside its API.");
      }
      path = body.next.slice(GPEXE_API_BASE.length);
    }
    throw new GpexeClientError("list_incomplete", `more than ${ATHLETE_SESSION_MAX_PAGES} pages for ${apiPath.split("?")[0]}.`);
  }

  async function athleteSessionsFor(sessionId, step) {
    const listed = (await getAllPages(`athlete_session/?teamsession=${sessionId}&limit=${ATHLETE_SESSION_PAGE}`, ATHLETE_SESSION_PAGE, step))
      .filter((a) => String(a.teamsession) === String(sessionId));
    // The list rows are enough for the ids; the full row is what the pilot
    // read (and what the mapper's fixtures describe).
    const rows = [];
    for (const a of listed) rows.push(await step(`athlete_session/${assertId(a.id, "athlete_session")}/`));
    return rows;
  }

  // Everything the mapper needs for one parent session, in the shape of
  // loadGpexeBundle(). onProgress runs after every request, so a long fetch
  // keeps reporting that it is alive.
  async function fetchSessionBundle({ gpexeTeamId, sessionId, onProgress = null }) {
    const team = assertId(gpexeTeamId, "gpexeTeamId");
    const id = assertId(sessionId, "sessionId");
    const step = async (apiPath) => {
      const body = await get(apiPath);
      if (onProgress) await onProgress();
      return body;
    };
    const teamSession = await step(`team_session/${id}/`);
    if (String(teamSession?.team) !== team) {
      throw new GpexeClientError("team_mismatch", `session ${id} does not belong to GPEXE team ${team}.`);
    }
    const drillsCount = Number(teamSession.drills_count ?? 0);
    if (!Number.isInteger(drillsCount) || drillsCount < 0 || drillsCount > MAX_DRILLS) {
      throw new GpexeClientError("drills_count_out_of_range", `session ${id} reports drills_count ${teamSession.drills_count}; at most ${MAX_DRILLS} is accepted.`);
    }
    const day = String(teamSession.start_timestamp ?? "").slice(0, 10);
    const athleteSessions = await athleteSessionsFor(id, step);
    const more = {};
    const tracks = {};
    for (const row of athleteSessions) {
      more[String(row.id)] = await step(`athlete_session/${assertId(row.id, "athlete_session")}/more/`);
      if (row.track && !tracks[String(row.track)]) tracks[String(row.track)] = await step(`track/${assertId(row.track, "track")}/`);
    }
    const full = await step(`team_session/${id}/details/`);
    const drills = {};
    for (let index = 0; index < drillsCount; index += 1) {
      drills[String(index)] = await step(`team_session/${id}/details/?drill=${index}`);
    }
    let teamThresholds = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      try {
        teamThresholds = await step(`team/${team}/thresholds/?valid_on=${day}`);
      } catch (error) {
        if (error.code !== "not_found") throw error;
      }
    }
    return { teamSession, teamThresholds, details: { full, drills }, athleteSessions, more, tracks };
  }

  return { get, listTeamSessions, fetchSessionBundle };
}
