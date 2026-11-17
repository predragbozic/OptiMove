// Settings > Source connections: each bound team's session time zone (manager, 2026-11-17, after PR #587): the zone in
// force or Not set, Change and Clear with a reason, for whoever the server lets read it. Real handlers, a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

let fetchCalls;
function installFetch(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    if (result instanceof Error) throw result;
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { confirmLeaveSourceConnections, handleSourceConnectionsAction, submitSourceConnectionsForm } = await import("../source-connections-actions.js");
const { loadSourceConnections, writeInFlight } = await import("../source-connections-data.js");
const { renderSourceConnectionsPanelHtml } = await import("../source-connections-view.js");
const { state } = await import("../state.js");

const CLUB = "11111111-0000-4000-8000-000000000001";
const OTHER_CLUB = "22222222-0000-4000-8000-000000000002";
const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const CONN = "cccccccc-0000-4000-8000-000000000001";
const BINDING = "bbbbbbbb-0000-4000-8000-000000000001";
const PASSWORD = "Sup3r-Secret pass word!";
const USERNAME = "club.account@example.test";
const BASE = "/api/training-load/sources/gpexe/connections";

function connection(over = {}) {
  return {
    id: CONN, sourceSystem: "gpexe", hostKey: "server3", hostLabel: "GPEXE server3", ownerScope: "club", ownerClubId: CLUB,
    accountLabel: "Club account", credentialKind: "exchanged_token", state: "not_connected", hasCredential: false,
    lastVerifiedAt: null, lastErrorCode: null, lastErrorAt: null, boundTeams: [], createdAt: "2026-10-05T08:00:00.000Z", updatedAt: "2026-10-05T08:00:00.000Z",
    ...over,
  };
}
const verified = (over = {}) => connection({ state: "verified", hasCredential: true, lastVerifiedAt: "2026-10-05T09:00:00.000Z", ...over });
const BOUND = { bindingId: BINDING, teamId: TEAM, teamName: "First team", sourceTeamId: "980", state: "active", boundAt: "2026-10-05T09:05:00.000Z", teamActive: true };
const TEAMS = [
  { sourceTeamId: "980", name: "First squad", approvedTeamId: TEAM, approvedTeamName: "First team" },
  { sourceTeamId: "981", name: "Youth", approvedTeamId: null, approvedTeamName: null },
];
const okResult = (action, over = {}) => ({ connectionId: CONN, action, outcome: "ok", state: "verified", code: null, lastVerifiedAt: "2026-10-05T09:00:00.000Z", boundTeamsChecked: 0, sourceTeamCount: 2, sourceTeams: TEAMS, sourceTeamsTruncated: false, ...over });

function orgData(over = {}) {
  return {
    isPlatformAdmin: true,
    clubs: [{ id: CLUB, name: "FK Borac" }, { id: OTHER_CLUB, name: "FK Drugi" }],
    manageableClubIds: [CLUB, OTHER_CLUB],
    teams: [{ id: TEAM, name: "First team", club_id: CLUB, club_name: "FK Borac" }, { id: TEAM_2, name: "U19", club_id: CLUB, club_name: "FK Borac" }],
    users: [], athletes: [],
    ...over,
  };
}

function freshSlice() {
  return {
    clubId: "", loading: false, error: null, connections: null, generation: state.sourceConnections.generation + 1, notice: "", noticeFor: "", ended: null,
    createOpen: false, createDraft: { hostKey: "server3", accountLabel: "" }, createBusy: false, createError: null,
    credentialOpen: null, credentialBusy: false, credentialError: null,
    testBusy: "", testError: null, lastAttempt: {}, teamsOpen: "",
    bindReview: null, bindBusy: false, bindError: null,
    unbindOpen: null, unbindBusy: false, unbindError: null,
    checkBusy: false, unconfirmed: null,
  };
}
function asPlatformAdmin() {
  state.currentUser = { name: "Owner", activeWorkspace: { type: "platform", scopeId: null }, clubs: [] };
  state.organization.data = orgData();
  state.organization.section = "sourceConnections";
  Object.assign(state.sourceConnections, freshSlice());
}
function asClubAdmin() {
  state.currentUser = { name: "Club admin", activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, name: "FK Borac", role: "club_admin" }] };
  state.organization.data = orgData({ isPlatformAdmin: false, manageableClubIds: [CLUB], clubs: [{ id: CLUB, name: "FK Borac" }] });
  state.organization.section = "sourceConnections";
  Object.assign(state.sourceConnections, freshSlice());
}
function asCoach() {
  state.currentUser = { name: "Coach", activeWorkspace: { type: "team", scopeId: TEAM }, clubs: [] };
  state.organization.data = orgData({ isPlatformAdmin: false, manageableClubIds: [] });
  state.organization.section = "sourceConnections";
  Object.assign(state.sourceConnections, freshSlice());
}

const render = () => {};
const act = (action, dataset = {}) => handleSourceConnectionsAction({ dataset: { action, ...dataset } }, { render, openDataSources: () => { state.organization.section = "dataSources"; } });
const submit = (kind, fields, dataset = {}) => submitSourceConnectionsForm(
  { dataset: { sourceConnectionsForm: kind, ...dataset }, elements: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])) },
  { render },
);
const html = () => renderSourceConnectionsPanelHtml();
const calls = () => fetchCalls.map((call) => `${call.method} ${call.url}`);

// The club's list, one connection's read, and whatever writes the test wants.
function responder({ list = [], writes = {} } = {}) {
  let current = list;
  const api = {
    set: (next) => { current = next; },
    handler: (call) => {
      if (call.method === "GET" && call.url.startsWith(`${BASE}?clubId=`)) return { status: 200, body: { connections: current } };
      if (call.method === "GET" && call.url.startsWith(`${BASE}/`)) return { status: 200, body: { connection: current[0] || null } };
      const key = `${call.method} ${call.url.slice(BASE.length)}`;
      const write = writes[key];
      if (typeof write === "function") return write(call);
      if (write) return write;
      return { status: 404, body: { error: "notFound" } };
    },
  };
  return api;
}


const TZ = (teamId) => `/api/training-load/gpexe/teams/${teamId}/session-timezone`;
const BOUND_2 = { ...BOUND, bindingId: "bbbbbbbb-0000-4000-8000-000000000002", teamId: TEAM_2, teamName: "U19", sourceTeamId: "981" };
const zoneAnswer = (timezone) => ({ status: 200, body: { sessionTimezone: { current: timezone ? { timezone, setAt: "2026-11-10T08:00:00Z", reason: "Home", setByName: "Club admin" } : null, history: [] } } });

// The club's list with two bound teams, and each team's session time zone as the test says.
async function openWithZones(zoneOf, { who = asClubAdmin, put = null } = {}) {
  who();
  const r = responder({ list: [verified({ boundTeams: [BOUND, BOUND_2] })] });
  installFetch((call) => {
    const tz = Object.entries({ [TEAM]: TZ(TEAM), [TEAM_2]: TZ(TEAM_2) }).find(([, p]) => call.url === p);
    if (tz && call.method === "GET") return zoneOf(tz[0], call);
    if (tz && call.method === "PUT") return put ? put(tz[0], call) : { status: 404, body: { error: "notFound" } };
    return r.handler(call);
  });
  await loadSourceConnections(render);
}
const puts = () => fetchCalls.filter((c) => c.method === "PUT");
const rowOf = (name, page = html()) => {
  const at = page.indexOf(`<strong>${name}</strong>`);
  assert.ok(at > 0, `the row of ${name}`);
  const end = page.indexOf("</li>", at);
  return page.slice(at, end);
};

test("1. a club admin sees each bound team's session time zone: the zone or Not set; Change for both, Clear only where one is set", async () => {
  await openWithZones((teamId) => zoneAnswer(teamId === TEAM ? "Europe/Sarajevo" : null));
  const first = rowOf("First team");
  const second = rowOf("U19");
  assert.match(first, /Session time zone:<\/span> <strong>Europe\/Sarajevo<\/strong>/);
  assert.match(first, /data-action="source-connections-zone-change"[^>]*>Change</);
  assert.match(first, /data-action="source-connections-zone-clear"/);
  assert.match(second, /Session time zone:<\/span> <strong>Not set<\/strong>/);
  assert.match(second, />Set the time zone</);
  assert.doesNotMatch(second, /source-connections-zone-clear/, "nothing to clear");
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/session-timezone")).length, 2, "one read per bound team");
});

test("2. a viewer the server does not let read it (403, 404) has no line at all; a failed read says so and offers Try again", async () => {
  await openWithZones((teamId) => (teamId === TEAM ? { status: 403, body: { error: "forbidden", message: "Only a platform administrator..." } } : { status: 404, body: { error: "notFound" } }));
  assert.doesNotMatch(html(), /Session time zone|source-connections-zone/);
  let fail = true;
  await openWithZones(() => (fail ? { status: 500, body: { error: "Internal server error" } } : zoneAnswer("UTC")));
  assert.match(rowOf("First team"), /The session time zone could not be read\./);
  fail = false;
  await act("source-connections-zone-retry", { teamId: TEAM });
  assert.match(rowOf("First team"), /<strong>UTC<\/strong>/);
});

test("3. Change: nothing is sent without a reason or for the same zone; then one PUT and a saved line", async () => {
  await openWithZones((teamId) => zoneAnswer(teamId === TEAM ? "Europe/Sarajevo" : null), {
    put: (teamId, call) => zoneAnswer(call.body.timezone),
  });
  await act("source-connections-zone-change", { teamId: TEAM });
  assert.match(rowOf("First team"), /<option value="Europe\/Sarajevo" selected>/, "the form opens on the zone in force");
  await submit("zone", { timezone: "Europe/Stockholm", reason: "  " }, { teamId: TEAM });
  assert.match(rowOf("First team"), /Write why, for the record\./);
  await submit("zone", { timezone: "Europe/Sarajevo", reason: "Same" }, { teamId: TEAM });
  assert.match(rowOf("First team"), /That is already the team(?:'|&#0?39;)s time zone\. Nothing to save\./);
  assert.equal(puts().length, 0);
  await submit("zone", { timezone: "Europe/Stockholm", reason: " Away camp " }, { teamId: TEAM });
  assert.deepEqual(puts().map((c) => [c.url, c.body]), [[TZ(TEAM), { timezone: "Europe/Stockholm", reason: "Away camp" }]]);
  const row = rowOf("First team");
  assert.match(row, /Saved\. The team(?:'|&#0?39;)s time zone is Europe\/Stockholm\./);
  assert.match(row, /<strong>Europe\/Stockholm<\/strong>/);
});

test("4. Clear: the consequence in one sentence, a reason, one PUT with timezone null; then Not set", async () => {
  await openWithZones((teamId) => zoneAnswer(teamId === TEAM ? "Europe/Sarajevo" : null), { put: () => zoneAnswer(null) });
  await act("source-connections-zone-clear", { teamId: TEAM });
  let row = rowOf("First team");
  assert.match(row, /After this, sessions whose GPS units report different time zones are not imported until a time zone is set again\./);
  assert.doesNotMatch(row, /name="timezone"/, "no zone to choose");
  await submit("zone", { reason: "Wrong zone" }, { teamId: TEAM });
  assert.deepEqual(puts().map((c) => c.body), [{ timezone: null, reason: "Wrong zone" }]);
  row = rowOf("First team");
  assert.match(row, /Cleared\. The team has no session time zone\./);
  assert.match(row, /<strong>Not set<\/strong>/);
  // Clear is offered only where a zone is set.
  await act("source-connections-zone-clear", { teamId: TEAM_2 });
  assert.equal(state.sourceConnections.zones[TEAM_2].step, "shown");
});

test("5. a coded refusal: Nothing was saved, the form stays; the server's own 500 or no answer is not confirmed, Check only reads, and leaving asks", async () => {
  await openWithZones(() => zoneAnswer(null), { put: () => ({ status: 409, body: { error: "gpexe_change_busy", message: "x" } }) });
  await act("source-connections-zone-change", { teamId: TEAM });
  await submit("zone", { timezone: "UTC", reason: "Test" }, { teamId: TEAM });
  assert.match(rowOf("First team"), /A search or an import is running for this team\. Try again when it has finished\. Nothing was saved\./);
  assert.equal(state.sourceConnections.zones[TEAM].step, "open");
  for (const [stored, saved] of [["UTC", true], [null, false]]) {
    let sent = 0;
    await openWithZones(() => zoneAnswer(sent ? stored : null), { put: () => { sent += 1; return { status: 500, body: { error: "Internal server error", message: "Something went wrong." } }; } });
    await act("source-connections-zone-change", { teamId: TEAM });
    await submit("zone", { timezone: "UTC", reason: "Test" }, { teamId: TEAM });
    assert.match(rowOf("First team"), /We can(?:'|&#0?39;)t tell whether the time zone was saved\./);
    assert.doesNotMatch(rowOf("First team"), /Nothing was saved/);
    assert.ok(writeInFlight(), "the screen's writes wait, and leaving asks");
    globalThis.window.confirm = () => false;
    assert.equal(confirmLeaveSourceConnections(), false);
    globalThis.window.confirm = () => true;
    await act("source-connections-zone-check", { teamId: TEAM });
    assert.equal(sent, 1, "Check never sends the save again");
    if (saved) assert.match(rowOf("First team"), /Saved\. The team(?:'|&#0?39;)s time zone is UTC\./);
    else assert.match(rowOf("First team"), /It was not saved: the team(?:'|&#0?39;)s time zone is still not set\./);
    assert.ok(!writeInFlight());
  }
});

test("6. Change and Clear wait while another write on the screen runs", async () => {
  await openWithZones(() => zoneAnswer("UTC"));
  state.sourceConnections.unbindBusy = true;
  assert.match(rowOf("First team"), /data-action="source-connections-zone-change"[^>]*disabled/);
  assert.match(rowOf("First team"), /data-action="source-connections-zone-clear"[^>]*disabled/);
  state.sourceConnections.unbindBusy = false;
});

test("7. a platform admin has the line too (platform workspace, club chosen)", async () => {
  await openWithZones(() => zoneAnswer("UTC"), { who: asPlatformAdmin });
  await submit("club", { clubId: CLUB });
  assert.match(rowOf("First team"), /<strong>UTC<\/strong>/);
});

const { handleSourceConnectionsInput } = await import("../source-connections-actions.js");

test("8 (code review): one write at a time - an open zone form sends nothing while another write runs, and only one zone form is open", async () => {
  await openWithZones(() => zoneAnswer("UTC"), { put: () => zoneAnswer("Europe/Sarajevo") });
  await act("source-connections-zone-change", { teamId: TEAM });
  assert.match(html(), /data-action="source-connections-unbind-open"[^>]*disabled/, "an open zone form locks the row's Unbind");
  state.sourceConnections.unbindBusy = true;
  assert.match(rowOf("First team"), /type="submit"[^>]*disabled/);
  await submit("zone", { timezone: "Europe/Sarajevo", reason: "x" }, { teamId: TEAM });
  assert.equal(puts().length, 0, "nothing is sent while another write runs");
  state.sourceConnections.unbindBusy = false;
  await act("source-connections-zone-change", { teamId: TEAM_2 });
  assert.notEqual(state.sourceConnections.zones[TEAM_2].step, "open", "one zone form at a time");
});

test("9 (code review): a team bound on this screen gets its line at once, without leaving the tab", async () => {
  asClubAdmin();
  let bound = [BOUND];
  const r = responder({
    list: [verified({ boundTeams: bound })],
    writes: {
      [`POST /${CONN}/bindings`]: () => {
        bound = [BOUND, BOUND_2];
        r.set([verified({ boundTeams: bound })]);
        return { status: 201, body: { result: { connectionId: CONN, action: "bind", outcome: "ok", idempotent: false, binding: BOUND_2 }, connection: verified({ boundTeams: bound }) } };
      },
    },
  });
  installFetch((call) => (call.url.endsWith("/session-timezone") ? zoneAnswer(null) : r.handler(call)));
  await loadSourceConnections(render);
  assert.equal(fetchCalls.filter((c) => c.url === TZ(TEAM_2)).length, 0);
  await act("source-connections-bind-open", { connectionId: CONN, teamId: TEAM_2, teamName: "U19", sourceTeamId: "981" });
  await act("source-connections-bind-confirm");
  assert.equal(fetchCalls.filter((c) => c.url === TZ(TEAM_2)).length, 1, "the new team's zone is read once");
  assert.equal(fetchCalls.filter((c) => c.url === TZ(TEAM)).length, 1, "a team with a line is not read again");
  assert.match(rowOf("U19"), /Session time zone:<\/span> <strong>Not set/);
});

test("10 (code review): a repaint while the zone form is open keeps what was typed", async () => {
  await openWithZones(() => zoneAnswer("UTC"));
  await act("source-connections-zone-change", { teamId: TEAM });
  const form = { dataset: { sourceConnectionsForm: "zone", teamId: TEAM } };
  const field = (name, value) => ({ name, value, closest: (sel) => (sel === 'form[data-source-connections-form="zone"]' ? form : null) });
  assert.equal(handleSourceConnectionsInput(field("timezone", "Europe/Stockholm")), true);
  handleSourceConnectionsInput(field("reason", "Away camp"));
  const row = rowOf("First team");
  assert.match(row, /<option value="Europe\/Stockholm" selected>/);
  assert.match(row, />Away camp<\/textarea>/);
  assert.equal(handleSourceConnectionsInput({ closest: () => null }), false, "other fields are not this handler's");
});

test("11 (code review): a Check refused as 403 releases the screen with a sentence; a lost Clear says 'not cleared'", async () => {
  let sent = 0;
  await openWithZones(() => (sent ? { status: 403, body: { error: "forbidden", message: "x" } } : zoneAnswer(null)), { put: () => { sent += 1; return { status: 500, body: { error: "Internal server error" } }; } });
  await act("source-connections-zone-change", { teamId: TEAM });
  await submit("zone", { timezone: "UTC", reason: "t" }, { teamId: TEAM });
  assert.ok(writeInFlight());
  await act("source-connections-zone-check", { teamId: TEAM });
  assert.ok(!writeInFlight(), "the screen is released");
  assert.match(rowOf("First team"), /Your account can no longer read this team(?:'|&#0?39;)s time zone, so OptiMove can(?:'|&#0?39;)t tell whether the change was made\./);
  let cleared = 0;
  await openWithZones(() => zoneAnswer("UTC"), { put: () => { cleared += 1; return { status: 502, body: null }; } });
  await act("source-connections-zone-clear", { teamId: TEAM });
  await submit("zone", { reason: "Wrong" }, { teamId: TEAM });
  assert.match(rowOf("First team"), /We can(?:'|&#0?39;)t tell whether the time zone was cleared\./);
  await act("source-connections-zone-check", { teamId: TEAM });
  assert.match(rowOf("First team"), /It was not cleared: the team(?:'|&#0?39;)s time zone is still UTC\. Clear it again\./);
});

test("12 (code review): an open zone form disables the card's other writes but hides nothing (its team list and error stay)", async () => {
  await openWithZones(() => zoneAnswer("UTC"));
  state.sourceConnections.lastAttempt[CONN] = { action: "test", at: "2026-11-17T09:00:00Z", result: okResult("test") };
  state.sourceConnections.teamsOpen = CONN;
  await act("source-connections-zone-change", { teamId: TEAM });
  const page = html();
  assert.match(page, /First squad/, "the GPEXE team list stays");
  assert.match(page, /data-action="source-connections-test"[^>]*disabled/, "Test waits");
  assert.match(page, /data-action="source-connections-unbind-open"[^>]*disabled/, "Unbind waits");
  assert.doesNotMatch(rowOf("First team"), /type="submit"[^>]*disabled/, "the zone form's own Save is not locked by itself");
});

test("13 (code review): with two connections, an open Unbind form on one keeps the zone form closed on the other", async () => {
  asClubAdmin();
  const C2 = "cccccccc-0000-4000-8000-000000000002";
  const r = responder({ list: [verified({ boundTeams: [BOUND] }), verified({ id: C2, boundTeams: [BOUND_2] })] });
  installFetch((c) => (c.url.endsWith("/session-timezone") ? zoneAnswer("UTC") : r.handler(c)));
  await loadSourceConnections(render);
  await act("source-connections-unbind-open", { connectionId: CONN, bindingId: BINDING, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  assert.ok(state.sourceConnections.unbindOpen);
  await act("source-connections-zone-change", { teamId: TEAM_2 });
  assert.notEqual(state.sourceConnections.zones[TEAM_2].step, "open");
});
