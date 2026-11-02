// A fake server3 (rest_v1) source for the suites that check and approve
// through a team's binding (9-B: a legacy-path candidate is never
// importable, J17 section 3 step 3). Extracted from the v33 suite
// (gpexe-check-finalization.test.mjs) so the importer suites share one:
// the token exchange and team reads of Connect / Bind, and the rest_v1 reads
// of every session served for a source team (the list, the session, its
// athlete rows, /more/, tracks, the whole-session and drill details, the
// thresholds). Marker credentials only, never real ones; no network.
//
// bindThroughRoutes() connects a club account and binds one team through the
// real Connect / Bind routes; the caller then starts the activations
// (support/mapped-world.mjs activateBinding).
export const FAKE_USERNAME = "marker-username-9b@example.invalid";
export const FAKE_PASSWORD = "MARKER-password-9b-not-real";
export const FAKE_TOKEN = "MARKER-token-9b-connection-not-real-0123456789";
export const FAKE_SOURCE_SENTENCE = "Marker sentence from the source server body";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const REST = "https://server3.gpexe.com/rest/v1/";
const LEGACY = "https://server3.gpexe.com/api/";

export function createFakeSource() {
  const calls = [];
  const visibleTeams = new Set();
  // sourceTeamId (text) -> bundles served for that team.
  const served = new Map();
  const state = { gates: { athletes: {} }, faults: { drillPlayers: {}, drillMissing: {} } };
  const json = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const allBundles = () => [...served.values()].flat();
  const bySid = (sid) => allBundles().find((b) => String(b.teamSession.id) === String(sid));
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = `${u.pathname}${u.search}`;
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? null;
    calls.push({ key, method: init.method ?? "GET" });
    if (String(url) === EXCHANGE_URL) {
      const params = new URLSearchParams(init.body);
      return params.get("username") === FAKE_USERNAME && params.get("password") === FAKE_PASSWORD ? json(200, { token: FAKE_TOKEN }) : json(400, { non_field_errors: [FAKE_SOURCE_SENTENCE] });
    }
    if (!String(url).startsWith(REST) && !String(url).startsWith(LEGACY)) return json(404, { detail: "not served" });
    if (init.method !== "GET") return json(405, {});
    if (auth !== `Token ${FAKE_TOKEN}`) return json(401, { detail: FAKE_SOURCE_SENTENCE });
    if (key === "/rest/v1/team/") return json(200, [...visibleTeams].map((id) => ({ id, name: `Team ${id}` })), { "x-total-count": String(visibleTeams.size) });
    let m = key.match(/^\/rest\/v1\/team\/(\d+)\/$/);
    if (m) return visibleTeams.has(Number(m[1])) ? json(200, { id: Number(m[1]), name: `Team ${m[1]}` }) : json(404, { detail: FAKE_SOURCE_SENTENCE });
    m = key.replace(/&start_timestamp_gte=[^&]*&start_timestamp_lte=[^&]*/, "").match(/^\/rest\/v1\/team_session\/\?team=(\d+)&limit=100$/);
    if (m) {
      const lg = state.gates.list;
      if (lg) { lg.reached = true; await lg.p; }
      const rows = [];
      for (const b of served.get(m[1]) ?? []) {
        const sid = b.teamSession.id;
        rows.push({ ...b.teamSession, drills: [sid * 1000 + 1, sid * 1000 + 2], drills_count: 2 });
        for (const k of [1, 2]) rows.push({ id: sid * 1000 + k, team: Number(m[1]), category_name: "DRILL", start_timestamp: b.teamSession.start_timestamp, end_timestamp: b.teamSession.end_timestamp, updated_on: b.teamSession.updated_on, is_stats_valid: true, drills: [], drills_count: 0 });
      }
      return json(200, rows, { "x-total-count": String(rows.length) });
    }
    m = key.match(/^\/rest\/v1\/team_session\/(\d+)\/$/);
    if (m && bySid(m[1])) return json(200, { ...bySid(m[1]).teamSession, drills_count: 2 });
    m = key.match(/^\/rest\/v1\/athlete_session\/\?teamsession=(\d+)&limit=100$/);
    if (m && bySid(m[1])) {
      const g = state.gates.athletes[m[1]];
      if (g) { g.reached = true; await g.p; }
      const rows = bySid(m[1]).athleteSessions;
      return json(200, rows, { "x-total-count": String(rows.length) });
    }
    m = key.match(/^\/rest\/v1\/athlete_session\/(\d+)\/(more\/)?$/);
    if (m) {
      for (const b of allBundles()) {
        const row = b.athleteSessions.find((r) => String(r.id) === m[1]);
        if (row) return json(200, m[2] ? b.more[m[1]] : row);
      }
      return json(404, { detail: FAKE_SOURCE_SENTENCE });
    }
    m = key.match(/^\/rest\/v1\/track\/(\d+)\/$/);
    if (m) {
      for (const b of allBundles()) if (b.tracks[m[1]]) return json(200, b.tracks[m[1]]);
      return json(404, { detail: FAKE_SOURCE_SENTENCE });
    }
    m = key.match(/^\/rest\/v1\/team_session\/(\d+)\/details\/$/);
    if (m && bySid(m[1])) return json(200, { drills_count: 2, players: bySid(m[1]).details.full.players, team: { aggregate: 1 }, teamsession: Number(m[1]) });
    m = key.match(/^\/api\/team_session\/(\d+)\/details\/\?drill=(\d)$/);
    if (m && bySid(m[1])) {
      if (state.faults.drillMissing[m[1]] === Number(m[2])) return json(404, { detail: FAKE_SOURCE_SENTENCE });
      const override = state.faults.drillPlayers[m[1]];
      const players = override ? override(Number(m[2])) : bySid(m[1]).details.drills[m[2]].players;
      return json(200, { drills_count: 0, players, team: { aggregate: 1 }, teamsession: Number(m[1]) * 1000 + Number(m[2]) + 1 });
    }
    m = key.match(/^\/api\/team_session\/(\d+)\/brief\/$/);
    if (m) return json(404, { detail: FAKE_SOURCE_SENTENCE });
    m = key.match(/^\/rest\/v1\/team\/(\d+)\/thresholds\/\?valid_on=(\d{4}-\d{2}-\d{2})$/);
    if (m && served.has(m[1])) return json(200, served.get(m[1])[0]?.teamThresholds ?? {});
    return json(404, { detail: "not served" });
  };
  // Serve the sessions of one source team (replacing what it served before);
  // each bundle is a copy carried by that team (asSourceTeam).
  // The session-level reads carry no team, so a session id is served for one
  // team at a time: serving it for this team withdraws it from every other.
  const serve = (sourceTeamId, bundles) => {
    visibleTeams.add(Number(sourceTeamId));
    const ids = new Set(bundles.map((b) => String(b.teamSession.id)));
    for (const [team, list] of served) if (team !== String(sourceTeamId)) served.set(team, list.filter((b) => !ids.has(String(b.teamSession.id))));
    served.set(String(sourceTeamId), bundles.map((b) => asSourceTeam(b, sourceTeamId)));
  };
  const show = (sourceTeamId) => visibleTeams.add(Number(sourceTeamId));
  return { calls, fetchImpl, state, serve, show, visibleTeams };
}

// A fixture bundle (_gpexe-fixtures.mjs makeBundle) as another GPEXE team's:
// the session's and the threshold set's team are the only places it names it.
export function asSourceTeam(bundle, sourceTeamId) {
  const copy = structuredClone(bundle);
  copy.teamSession.team = Number(sourceTeamId);
  if (copy.teamThresholds) copy.teamThresholds.team = Number(sourceTeamId);
  return copy;
}

// Connect a club-owned server3 account and bind one team to its approved
// GPEXE team through the real routes (the caller is a platform admin in the
// platform workspace or the club's admin in its workspace; the team's
// approved pair must already be set). Returns { connectionId, bindingId }.
export async function bindThroughRoutes({ apiBase, cookie, clubId, teamId, sourceTeamId }) {
  const call = async (path, body) => {
    const res = await fetch(`${apiBase}/api/training-load/sources/gpexe${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
    return { status: res.status, body: parsed };
  };
  const created = await call("/connections", { ownerScope: "club", ownerClubId: clubId, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token" });
  if (created.status !== 201) throw new Error(`create connection: ${created.status} ${JSON.stringify(created.body)}`);
  const connectionId = created.body.connection.id;
  const connected = await call(`/connections/${connectionId}/connect`, { username: FAKE_USERNAME, password: FAKE_PASSWORD });
  if (connected.status !== 200) throw new Error(`connect: ${connected.status} ${JSON.stringify(connected.body)}`);
  const bound = await call(`/connections/${connectionId}/bindings`, { teamId, sourceTeamId: String(sourceTeamId) });
  if (bound.status !== 201) throw new Error(`bind: ${bound.status} ${JSON.stringify(bound.body)}`);
  const bindingId = bound.body.result?.binding?.bindingId;
  if (!bindingId) throw new Error("bind answered no binding id");
  return { connectionId: String(connectionId), bindingId: String(bindingId) };
}
