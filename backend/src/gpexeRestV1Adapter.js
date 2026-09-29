// Read-only adapter profile for GPEXE, API family rest_v1 (the family
// server3 speaks). F3c2a: no route, no database, no credential storage; the
// caller hands in a credential it already holds and the connection's
// approved catalog row.
//
// Boundaries, each one tested (backend/tests/gpexe-rest-v1-adapter.test.mjs):
//   * every URL is built by sourceApiUrl() with the approved catalog row —
//     this file holds no host, no base URL and no path prefix;
//   * GET only. The one function that talks to the network is a closure; it
//     takes a resource path and nothing else, and it is not exported or
//     returned. There is no generic request, POST, PUT or PATCH helper;
//   * every operation reads for the BOUND source team only. The team id is
//     fixed when the adapter is created; no operation accepts one, and an
//     option that names a team in any spelling is refused;
//   * a returned team, session or next-page link that names another team is
//     refused; nothing of that answer is returned;
//   * a capability that was not PROVEN by an owner-run read-only probe is
//     source_capability_unavailable. Its path and payload are not guessed;
//   * errors carry a stable code and OptiMove's own sentence, never the
//     source's text; the credential is only ever in the Authorization header.
//
// The existing e03 importer (backend/src/gpexeClient.js) is not changed and
// does not use this file.
// redactGpexe is the importer's drop list of personal fields; importing it
// has no side effect (that module reads the environment only when its own
// client is created). A change of that list changes what this adapter drops.
import { redactGpexe } from "./gpexeClient.js";
import { sourceApiUrl, sourceHost } from "./sourceHosts.js";

export const ADAPTER_SOURCE = "gpexe";
export const ADAPTER_API_FAMILY = "rest_v1";
export const SESSION_PAGE_LIMIT_MAX = 100;
export const MAX_PAGES = 20;
// One answer is at most this many BYTES (5 MiB). A larger one is refused:
// unread when it is announced, cancelled when it is counted.
export const MAX_ANSWER_BYTES = 5 * 1024 * 1024;

const TEAM_ID = /^(0|[1-9][0-9]{0,11})$/;
// A bound team id is given as its canonical string (or as that whole number);
// a list, an object or anything that only LOOKS like the id when printed is not.
const boundTeam = (value) => {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return text !== null && TEAM_ID.test(text) ? text : null;
};

export class SourceAdapterError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "SourceAdapterError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// What is known about each resource of rest_v1, and how it is known.
//   proven            an owner-run read-only probe read it on server3
//                     (2026-09-29): status 200, body shape and field names;
//   legacy_attested   the owner's existing integration uses this path or
//                     parameter; OptiMove has not seen its answer;
//   unknown           nothing is known.
// Only "proven" is implemented. The paths of the other rows are recorded for
// the probe that will verify them; no code builds a request from them.
export const REST_V1_CAPABILITIES = Object.freeze({
  team_list: Object.freeze({ status: "proven", importerUse: "verify the bound team is visible", e03: "not used", evidence: "probe 2026-09-29: GET team/ 200, array, X-Total-Count" }),
  team_read: Object.freeze({ status: "proven", importerUse: "verify the bound team is visible", e03: "not used", evidence: "probe 2026-09-29: GET team/<id>/ 200, object" }),
  session_list: Object.freeze({ status: "proven", importerUse: "none as it is: the importer always lists with a date window", e03: "not sent without a date window", evidence: "probe 2026-09-29: GET team_session/?team=&limit=1 200, array, X-Total-Count, Link" }),
  session_list_by_date: Object.freeze({ status: "legacy_attested", importerUse: "team sessions of a date window", e03: "team_session/?team=&start_timestamp_gte=&start_timestamp_lte=&limit=", evidence: "parameter names start_timestamp_gte / start_timestamp_lte read from the legacy integration's endpoint strings (names only, 2026-09-29); value format and filtering not seen" }),
  session_read: Object.freeze({ status: "legacy_attested", importerUse: "one session, its team and drills_count", e03: "team_session/<id>/", evidence: "path used by the legacy integration; answer not seen" }),
  session_details: Object.freeze({ status: "legacy_attested", importerUse: "whole-session values per athlete", e03: "team_session/<id>/details/", evidence: "path used by the legacy integration (also with header=true); answer not seen" }),
  session_drill_details: Object.freeze({ status: "unknown", importerUse: "values per drill", e03: "team_session/<id>/details/?drill=<n>", evidence: "none" }),
  athlete_session_list: Object.freeze({ status: "unknown", importerUse: "athlete rows of a session", e03: "athlete_session/?teamsession=<id>&limit=", evidence: "none" }),
  athlete_session_read: Object.freeze({ status: "unknown", importerUse: "one athlete row", e03: "athlete_session/<id>/", evidence: "none" }),
  athlete_session_more: Object.freeze({ status: "unknown", importerUse: "burst and brake events", e03: "athlete_session/<id>/more/", evidence: "none" }),
  track_read: Object.freeze({ status: "unknown", importerUse: "time zone, device restarts", e03: "track/<id>/", evidence: "none" }),
  team_thresholds: Object.freeze({ status: "unknown", importerUse: "threshold set valid on the session day", e03: "team/<team>/thresholds/?valid_on=", evidence: "none" }),
  units: Object.freeze({ status: "unknown", importerUse: "none (numbers are SI on e03)", e03: "no endpoint used", evidence: "none" }),
  session_tags: Object.freeze({ status: "legacy_attested", importerUse: "none today", e03: "not used", evidence: "path team_session_tag/?limit= used by the legacy integration; answer and team scope not seen" }),
});

function unavailable(capability) {
  return new SourceAdapterError(
    "source_capability_unavailable",
    "This source server has not been verified for that read yet.",
    { capability, capabilityStatus: REST_V1_CAPABILITIES[capability]?.status ?? "unknown" },
  );
}

// No operation takes a team. An option that names one, in any spelling, is
// a caller's mistake or an attempt to read another team: refused.
function refuseTeamOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new SourceAdapterError("invalid_options", "The options of a source read are a plain object.");
  }
  for (const key of Object.keys(options)) {
    if (/team/i.test(key)) throw new SourceAdapterError("team_param_not_allowed", "A source read is always for the bound team; a team cannot be passed.");
  }
  return options;
}

// The query of a team-scoped list: the bound team first, then the given
// pairs. A pair may not name the team, and no key may come twice.
export function teamScopedPath(resource, boundTeamId, pairs = []) {
  const boundId = boundTeam(boundTeamId);
  if (boundId === null) throw new SourceAdapterError("invalid_bound_team", "The bound source team id is not a canonical id.");
  if (typeof resource !== "string" || !/^[a-z_]+\/$/.test(resource)) throw new SourceAdapterError("path_not_allowed", "A list resource is one lower-case segment.");
  const seen = new Set(["team"]);
  const parts = [`team=${boundId}`];
  for (const pair of pairs) {
    const [key, value] = Array.isArray(pair) ? pair : [];
    if (typeof key !== "string" || !/^[a-z_]+$/.test(key)) throw new SourceAdapterError("path_not_allowed", "A query key is lower-case letters and underscores.");
    if (/team/i.test(key)) throw new SourceAdapterError("team_param_not_allowed", "A source read is always for the bound team; a team cannot be passed.");
    if (seen.has(key)) throw new SourceAdapterError("duplicate_param", "A query key may be given once.");
    seen.add(key);
    const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
    if (text === null || !/^[A-Za-z0-9_.:-]+$/.test(text)) throw new SourceAdapterError("path_not_allowed", "A query value is a plain string or a whole number.");
    parts.push(`${key}=${text}`);
  }
  return `${resource}?${parts.join("&")}`;
}

function nextFromLinkHeader(link) {
  if (typeof link !== "string") return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

// A team value of an answer names the bound team only when it is that id as
// a number or as a canonical string. Any other shape (an object, a URL, a
// list) is not interpreted: the answer is refused.
function namesBoundTeam(value, boundTeamId) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value) === boundTeamId;
  if (typeof value === "string" && TEAM_ID.test(value)) return value === boundTeamId;
  return null;
}

const tooLarge = () => new SourceAdapterError("source_answer_unexpected", "The source server answered with more than can be read.");

// The body of an answer, as text, or a refusal — never part of it.
// MAX_ANSWER_BYTES is a limit in BYTES on what is really received: the body
// is read from its stream chunk by chunk, the bytes are counted as they
// arrive, and the stream is cancelled the moment the count passes the limit.
// Content-Length is only an early guard: an answer that announces too much
// is refused unread, but an answer that announces little, or nothing, is
// still counted. The whole body is never asked for in one piece.
export async function readBounded(res, contentLength = null, limit = MAX_ANSWER_BYTES) {
  const announced = contentLength === null || contentLength === undefined || contentLength === "" ? NaN : Number(contentLength);
  const stream = res?.body;
  // Letting go of the stream is asked for, never waited for: the refusal
  // stands whether or not, and whenever, the source lets go.
  const cancel = (target) => {
    try {
      Promise.resolve(target?.cancel?.()).catch(() => {});
    } catch {
      // A cancel that throws changes nothing.
    }
  };
  if (Number.isFinite(announced) && announced > limit) {
    cancel(stream);
    throw tooLarge();
  }
  if (stream === null || stream === undefined) return "";
  if (typeof stream.getReader !== "function") {
    throw new SourceAdapterError("source_answer_unexpected", "The source server's answer cannot be read as a stream.");
  }
  const reader = stream.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        cancel(reader);
        throw new SourceAdapterError("source_answer_unexpected", "The source server's answer did not arrive as bytes.");
      }
      received += value.byteLength;
      if (received > limit) {
        cancel(reader);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceAdapterError) throw error;
    cancel(reader);
    throw new SourceAdapterError("source_unavailable", "The source server's answer stopped before its end.");
  }
  try {
    reader.releaseLock();
  } catch {
    // The stream is closed; nothing depends on the lock.
  }
  // Decoded once, over all the bytes: a character split between two chunks
  // stays one character.
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function createGpexeRestV1Adapter({
  hostKey,
  catalogRow,
  credential,
  boundSourceTeamId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  attempts = 3,
  retryDelayMs = 1_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  // The gate: the key's own approved catalog row, and the family this file is for.
  const probeUrl = sourceApiUrl(ADAPTER_SOURCE, hostKey, catalogRow, "team/");
  const host = sourceHost(ADAPTER_SOURCE, hostKey);
  if (host.apiFamily !== ADAPTER_API_FAMILY) {
    throw new SourceAdapterError("adapter_not_available", "This adapter is for another API family than the host speaks.");
  }
  const team = boundTeam(boundSourceTeamId);
  if (team === null) throw new SourceAdapterError("invalid_bound_team", "The bound source team id is not a canonical id.");
  if (typeof credential !== "string" || !credential || /[\r\n]/.test(credential)) {
    throw new SourceAdapterError("credential_missing", "No usable credential was given to the source adapter.");
  }
  if (typeof fetchImpl !== "function") throw new SourceAdapterError("invalid_options", "The source adapter needs a fetch implementation.");
  // Bounded on purpose: a credential travels with every attempt.
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new SourceAdapterError("invalid_options", "The number of attempts is a whole number from 1 to 5.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new SourceAdapterError("invalid_options", "The timeout is a whole number of milliseconds up to 120000.");
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) throw new SourceAdapterError("invalid_options", "The retry delay is a whole number of milliseconds up to 10000.");
  if (typeof sleep !== "function") throw new SourceAdapterError("invalid_options", "The source adapter needs a sleep function.");
  const root = probeUrl.slice(0, -"team/".length);
  const authorization = `${host.authScheme} ${credential}`;

  // The ONLY network function. GET, one resource path, nothing else.
  async function read(resourcePath) {
    const url = sourceApiUrl(ADAPTER_SOURCE, hostKey, catalogRow, resourcePath);
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: { Authorization: authorization, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        last = new SourceAdapterError("source_unavailable", "The source server did not answer.");
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
        continue;
      }
      const status = res.status;
      if (status >= 300 && status < 400) throw new SourceAdapterError("source_answer_unexpected", "The source server answered with a redirect, which is refused.", { status });
      // 401: the credential itself was refused. 403: the credential was read
      // but may not do this; the two are told apart for the administrator.
      if (status === 401) throw new SourceAdapterError("source_auth_rejected", "The source server refused the credential.", { status });
      if (status === 403) throw new SourceAdapterError("source_access_refused", "The source server does not allow this credential to read that.", { status });
      if (status === 404) throw new SourceAdapterError("source_not_found", "The source server has nothing at that place.", { status });
      // Asked to slow down: not repeated, so a rate limit is never made worse.
      if (status === 429) throw new SourceAdapterError("source_unavailable", "The source server asked to slow down.", { status });
      if (status >= 500) {
        last = new SourceAdapterError("source_unavailable", "The source server is not available.", { status });
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
        continue;
      }
      if (status !== 200) throw new SourceAdapterError("source_answer_unexpected", "The source server answered in a way that is not expected.", { status });
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      const text = await readBounded(res, header("content-length"));
      let body;
      try {
        body = redactGpexe(JSON.parse(text));
      } catch {
        throw new SourceAdapterError("source_answer_unexpected", "The source server answered with something that cannot be read as JSON.");
      }
      return { body, totalCount: header("x-total-count"), link: header("link") };
    }
    throw last ?? new SourceAdapterError("source_unavailable", "The source server did not answer.");
  }

  // A next-page link of the session list, as the server gave it: it must
  // stay on this host and family, on the same resource, and name the bound
  // team exactly once. It is then rebuilt as a relative path and goes
  // through sourceApiUrl() like every other read.
  function nextSessionPath(next) {
    if (typeof next !== "string" || !next.startsWith(root)) {
      throw new SourceAdapterError("source_answer_unexpected", "The source server pointed to a next page outside its own API.");
    }
    let url;
    try {
      url = new URL(next);
    } catch {
      throw new SourceAdapterError("source_answer_unexpected", "The source server pointed to a next page that cannot be read.");
    }
    if (url.href.slice(root.length).split("?")[0] !== "team_session/" || url.hash || url.username || url.password) {
      throw new SourceAdapterError("source_answer_unexpected", "The source server pointed to a next page of another resource.");
    }
    const keys = [...url.searchParams.keys()];
    const teams = url.searchParams.getAll("team");
    if (teams.length !== 1 || teams[0] !== team || keys.some((k) => k !== "team" && /team/i.test(k))) {
      throw new SourceAdapterError("source_team_mismatch", "The source server pointed to a next page of another team.");
    }
    if (new Set(keys).size !== keys.length) {
      throw new SourceAdapterError("source_answer_unexpected", "The source server pointed to a next page with a repeated parameter.");
    }
    const pairs = keys.filter((k) => k !== "team").map((k) => [k, url.searchParams.get(k)]);
    try {
      return teamScopedPath("team_session/", team, pairs);
    } catch {
      throw new SourceAdapterError("source_answer_unexpected", "The source server pointed to a next page that cannot be read.");
    }
  }

  function sessionRows(body, totalHeader) {
    if (!Array.isArray(body)) throw new SourceAdapterError("source_answer_unexpected", "The source server did not answer the session list as a list.");
    const total = Number(totalHeader);
    if (totalHeader === null || totalHeader === undefined || totalHeader === "" || !Number.isInteger(total) || total < 0) {
      throw new SourceAdapterError("source_answer_unexpected", "The source server did not say how many sessions there are.");
    }
    for (const row of body) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new SourceAdapterError("source_answer_unexpected", "A session of the source answer is not an object.");
      const named = namesBoundTeam(row.team, team);
      if (named === null) throw new SourceAdapterError("source_answer_unexpected", "A session of the source answer does not name its team in a known way.");
      if (named === false) throw new SourceAdapterError("source_team_mismatch", "The source server returned a session of another team.");
      if (row.id === undefined || row.id === null || !TEAM_ID.test(String(row.id))) throw new SourceAdapterError("source_answer_unexpected", "A session of the source answer has no usable id.");
      if (row.drills !== undefined && row.drills !== null && !Array.isArray(row.drills)) throw new SourceAdapterError("source_answer_unexpected", "A session of the source answer lists its drills in an unknown way.");
    }
    return { rows: body, total };
  }

  const summary = (s) => ({
    id: String(s.id),
    categoryName: s.category_name ?? null,
    startTimestamp: s.start_timestamp ?? null,
    updatedOn: s.updated_on ?? null,
    drillsCount: Number(s.drills_count ?? 0),
    isStatsValid: s.is_stats_valid === true,
    drillIds: Array.isArray(s.drills) ? s.drills.map(String) : [],
  });

  const adapter = {
    sourceSystem: ADAPTER_SOURCE,
    apiFamily: ADAPTER_API_FAMILY,
    hostKey,
    boundSourceTeamId: team,

    capabilities() {
      return Object.fromEntries(Object.entries(REST_V1_CAPABILITIES).map(([name, c]) => [name, { status: c.status, available: c.status === "proven" }]));
    },

    // Is the bound team readable with this credential? The team's own read
    // decides; the list is not needed and the other teams are never returned.
    async verifyBoundTeam(options) {
      refuseTeamOptions(options);
      let res;
      try {
        res = await read(`team/${team}/`);
      } catch (error) {
        if (error.code === "source_not_found" || error.code === "source_access_refused") {
          throw new SourceAdapterError("source_team_not_visible", "The bound team is not visible with this credential.", { status: error.status });
        }
        throw error;
      }
      const body = res.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new SourceAdapterError("source_answer_unexpected", "The source server did not answer the team as an object.");
      const named = namesBoundTeam(body.id, team);
      if (named === null) throw new SourceAdapterError("source_answer_unexpected", "The source answer does not name the team in a known way.");
      if (named === false) throw new SourceAdapterError("source_team_mismatch", "The source server returned another team.");
      return { visible: true, sourceTeamId: team };
    },

    // How many teams the credential sees. A count and a boolean only: no
    // other team leaves here. The boolean is about the FIRST page and says
    // so; whether the bound team is readable is verifyBoundTeam()'s answer.
    async countVisibleTeams(options) {
      refuseTeamOptions(options);
      const res = await read("team/");
      if (!Array.isArray(res.body)) throw new SourceAdapterError("source_answer_unexpected", "The source server did not answer the team list as a list.");
      const total = Number(res.totalCount);
      if (res.totalCount === null || res.totalCount === undefined || res.totalCount === "" || !Number.isInteger(total) || total < 0) {
        throw new SourceAdapterError("source_answer_unexpected", "The source server did not say how many teams there are.");
      }
      return {
        teamCount: total,
        boundTeamOnFirstPage: res.body.some((t) => t && namesBoundTeam(t.id, team) === true),
        firstPageOnly: res.body.length < total,
      };
    },

    // Every session of the bound team, in the order the source gives them:
    // the whole list or a refusal, never part of it. Team and page size only;
    // a date window is not verified on this family yet. As the e03 importer
    // does, a session named in another session's `drills` is a drill, not a
    // session of its own, and is left out (it stays in its parent's drillIds).
    async listSessions(options) {
      const { limit = SESSION_PAGE_LIMIT_MAX, maxPages = MAX_PAGES, ...rest } = refuseTeamOptions(options);
      const unknownOption = Object.keys(rest)[0];
      if (unknownOption !== undefined) {
        if (/day|date|from|to|start|end|since|until/i.test(unknownOption)) throw unavailable("session_list_by_date");
        throw new SourceAdapterError("invalid_options", "That option is not known to the session list.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_PAGE_LIMIT_MAX) throw new SourceAdapterError("invalid_options", "The page size is a whole number from 1 to 100.");
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new SourceAdapterError("invalid_options", "The number of pages is a whole number from 1 to 20.");
      const rows = [];
      const ids = new Set();
      let total = null;
      let path = teamScopedPath("team_session/", team, [["limit", limit]]);
      let whole = false;
      for (let page = 1; page <= maxPages; page += 1) {
        const res = await read(path);
        const { rows: pageRows, total: pageTotal } = sessionRows(res.body, res.totalCount);
        if (total === null) total = pageTotal;
        else if (total !== pageTotal) throw new SourceAdapterError("source_list_changed", "The number of sessions changed while the list was read; read it again.");
        for (const row of pageRows) {
          const id = String(row.id);
          if (ids.has(id)) throw new SourceAdapterError("source_list_changed", "A session came twice while the list was read; read it again.");
          ids.add(id);
          rows.push(row);
        }
        if (rows.length > total) throw new SourceAdapterError("source_list_changed", "The source returned more sessions than it reported; read it again.");
        const next = nextFromLinkHeader(res.link);
        if (next === null) {
          if (rows.length !== total) throw new SourceAdapterError("source_list_incomplete", "The source reported more sessions than could be read.");
          whole = true;
          break;
        }
        if (rows.length === total) throw new SourceAdapterError("source_answer_unexpected", "The source announced another page after the last session.");
        path = nextSessionPath(next);
      }
      if (!whole) throw new SourceAdapterError("source_list_incomplete", "The source has more sessions than the allowed number of pages.");
      const drillIds = new Set(rows.flatMap((s) => (Array.isArray(s.drills) ? s.drills.map(String) : [])));
      const sessions = rows.filter((s) => !drillIds.has(String(s.id))).map(summary);
      return { sessions, total, drillsLeftOut: rows.length - sessions.length };
    },

    // Not verified on this family yet: each answers the same stable refusal.
    async listSessionsByDay(options) { refuseTeamOptions(options); throw unavailable("session_list_by_date"); },
    async getSession(options) { refuseTeamOptions(options); throw unavailable("session_read"); },
    async getSessionDetails(options) { refuseTeamOptions(options); throw unavailable("session_details"); },
    async getSessionDrillDetails(options) { refuseTeamOptions(options); throw unavailable("session_drill_details"); },
    async listAthleteSessions(options) { refuseTeamOptions(options); throw unavailable("athlete_session_list"); },
    async getAthleteSession(options) { refuseTeamOptions(options); throw unavailable("athlete_session_read"); },
    async getAthleteSessionMore(options) { refuseTeamOptions(options); throw unavailable("athlete_session_more"); },
    async getTrack(options) { refuseTeamOptions(options); throw unavailable("track_read"); },
    async getTeamThresholds(options) { refuseTeamOptions(options); throw unavailable("team_thresholds"); },
    async getUnits(options) { refuseTeamOptions(options); throw unavailable("units"); },
    async listSessionTags(options) { refuseTeamOptions(options); throw unavailable("session_tags"); },
    // The whole bundle the importer's mapper reads needs every read above.
    async fetchSessionBundle(options) { refuseTeamOptions(options); throw unavailable("session_read"); },
  };
  return Object.freeze(adapter);
}
