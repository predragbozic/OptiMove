// Settings -> Source connections (F3c3): the administrator's screen for the
// club's source credential connection - create, Connect, Test, Approve and
// bind, Reconnect, Unbind. Driven through the real handlers with a fake
// fetch, so what the screen sends and what it shows are both proved here:
// who is offered the tab, that nothing is sent before a form or a
// confirmation, that the username and password travel in exactly one request
// and stay nowhere, that a lost answer is checked and never resent blindly,
// and that every refusal reads as plain administrator language.
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

const { confirmLeaveSourceConnections, handleSourceConnectionsAction, handleSourceConnectionsBeforeUnload, submitSourceConnectionsForm } = await import("../source-connections-actions.js");
const { loadSourceConnections, newRequestKey, sourceConnectionsAdminContext, sourceConnectionsNeedLoad, writeInFlight } = await import("../source-connections-data.js");
const { connectionMessage, renderSourceConnectionsPanelHtml } = await import("../source-connections-view.js");
const { checkErrorText, renderCheckSummaryHtml } = await import("../gpexe-import-view.js");
const { renderSettingsNavHtml } = await import("../navigation.js");
const { renderOrganizationPanelHtml } = await import("../organization-view.js");
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
const submit = (kind, fields) => submitSourceConnectionsForm(
  { dataset: { sourceConnectionsForm: kind }, elements: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])) },
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

async function openClub(options = {}, { who = asPlatformAdmin } = {}) {
  who();
  const r = responder(options);
  installFetch(r.handler);
  if (who === asPlatformAdmin) await submit("club", { clubId: CLUB });
  else await (await import("../source-connections-data.js")).loadSourceConnections(render);
  return r;
}

test("1. the tab is offered to a platform admin (platform or club workspace) and to the owning club's admin in that club's workspace only; a coach, a club admin in another workspace and an account without the facts never see it, and the section falls back to Overview", () => {
  asPlatformAdmin();
  assert.match(renderSettingsNavHtml(state.organization.data, "overview"), /data-section="sourceConnections"/);
  assert.deepEqual(sourceConnectionsAdminContext(), { basis: "platform_admin", workspaceType: "platform", clubId: null });
  state.currentUser.activeWorkspace = { type: "club", scopeId: OTHER_CLUB };
  assert.deepEqual(sourceConnectionsAdminContext(), { basis: "platform_admin", workspaceType: "club", clubId: OTHER_CLUB });

  asClubAdmin();
  assert.match(renderSettingsNavHtml(state.organization.data, "overview"), /sourceConnections/);
  assert.deepEqual(sourceConnectionsAdminContext(), { basis: "club_admin", workspaceType: "club", clubId: CLUB });
  // The same club admin in a team workspace: no context, no tab.
  state.currentUser.activeWorkspace = { type: "team", scopeId: TEAM };
  assert.equal(sourceConnectionsAdminContext(), null);
  assert.doesNotMatch(renderSettingsNavHtml(state.organization.data, "overview"), /sourceConnections/);
  // A club admin whose club workspace is another club than the ones they administer.
  state.currentUser.activeWorkspace = { type: "club", scopeId: OTHER_CLUB };
  assert.equal(sourceConnectionsAdminContext(), null);
  // The workspace TYPE counts, not only the scope id: a non-club workspace whose scope happened to carry the club's id is no basis.
  state.currentUser.activeWorkspace = { type: "team", scopeId: CLUB };
  assert.equal(sourceConnectionsAdminContext(), null);
  state.currentUser.activeWorkspace = { type: "private_coach", scopeId: CLUB };
  assert.equal(sourceConnectionsAdminContext(), null);

  asCoach();
  assert.equal(sourceConnectionsAdminContext(), null);
  assert.doesNotMatch(renderSettingsNavHtml(state.organization.data, "overview"), /sourceConnections/);
  const panel = renderOrganizationPanelHtml({ currentUser: state.currentUser, data: state.organization.data, error: "", role: "Coach", scope: "Team" });
  assert.equal(state.organization.section, "overview", "a coach is never left on the section");
  assert.doesNotMatch(panel, /Source connections<\/h3>/);
  assert.equal(html(), "", "nothing is rendered without an administrator context");
  // The nav helper is safe without any user at all (older callers).
  state.currentUser = null;
  assert.doesNotMatch(renderSettingsNavHtml({ isPlatformAdmin: true }, "overview"), /sourceConnections/);
});

test("2. a platform admin chooses a club and that club alone is read; a club admin's own club is read without a picker; a 404 reads as 'no source connections are available' and reveals nothing; a failed read offers Try again", async () => {
  await openClub({ list: [] });
  assert.deepEqual(calls(), [`GET ${BASE}?clubId=${CLUB}`]);
  let out = html();
  assert.match(out, /FK Borac/);
  assert.match(out, /has no GPEXE connection yet/);
  assert.match(out, /Create connection/);

  await openClub({ list: [verified()] }, { who: asClubAdmin });
  assert.deepEqual(calls(), [`GET ${BASE}?clubId=${CLUB}`]);
  out = html();
  assert.doesNotMatch(out, /Open club/, "no club picker inside a club workspace");
  assert.match(out, /Verified/);
  assert.match(out, /Club account/);

  asPlatformAdmin();
  installFetch(() => ({ status: 404, body: { error: "notFound" } }));
  await submit("club", { clubId: OTHER_CLUB });
  out = html();
  assert.match(out, /No source connections are available in this workspace\./);
  assert.doesNotMatch(out, /exists|forbidden|not allowed|Try again/i);

  asPlatformAdmin();
  installFetch(() => ({ status: 500, body: { error: "internal_error", message: "boom" } }));
  await submit("club", { clubId: CLUB });
  out = html();
  assert.match(out, /could not be loaded, so nothing is shown yet/);
  assert.match(out, /data-action="source-connections-reload"/);
});

test("3. Create: the form offers the approved host profile only, needs an account name, sends exactly the body the route takes, and opens the Connect form on the new row", async () => {
  await openClub({ list: [], writes: { "POST ": (call) => ({ status: 201, body: { connection: connection({ accountLabel: call.body.accountLabel }) } }) } });
  await act("source-connections-create-open");
  let out = html();
  assert.match(out, /data-source-connections-form="create"/);
  assert.match(out, /<option value="server3"/);
  assert.doesNotMatch(out, /e03/, "only the approved profile is offered");
  await submit("create", { hostKey: "server3", accountLabel: "   " });
  assert.equal(state.sourceConnections.createError.code, "account_label_required");
  assert.equal(fetchCalls.length, 1, "nothing sent on a refused form");
  await submit("create", { hostKey: "evil", accountLabel: "Club account" });
  assert.equal(state.sourceConnections.createError.code, "host_not_allowed");
  assert.equal(fetchCalls.length, 1);
  await submit("create", { hostKey: "server3", accountLabel: "Club account" });
  assert.deepEqual(fetchCalls[1], { method: "POST", url: BASE, body: { ownerScope: "club", ownerClubId: CLUB, hostKey: "server3", accountLabel: "Club account", credentialKind: "exchanged_token" } });
  assert.deepEqual(state.sourceConnections.credentialOpen, { connectionId: CONN, action: "connect" });
  out = html();
  assert.match(out, /Connect the GPEXE account/);
  assert.match(out, /The connection is created\. Connect the account/);
});

test("4. Connect: the username and password travel in exactly one request (a double submit sends one), appear in no state, HTML, URL or notice, the password field never carries a value and asks the browser not to save it; a verified answer shows the badge, the notice and the server's GPEXE teams - and nothing beyond them", async () => {
  let posts = 0;
  const r = await openClub({
    list: [connection()],
    writes: {
      [`POST /${CONN}/connect`]: async (call) => {
        posts += 1;
        assert.deepEqual(call.body, { username: USERNAME, password: PASSWORD });
        // While the request is in flight the pair is in no state slice either.
        assert.doesNotMatch(JSON.stringify(state.sourceConnections), /Sup3r-Secret|club\.account@/, "nothing of the pair in state while in flight");
        await new Promise((resolve) => setTimeout(resolve, 10));
        r.set([verified()]);
        return { status: 200, body: { result: okResult("connect", { sourceTeamsTruncated: true }), connection: verified() } };
      },
    },
  });
  await act("source-connections-connect-open", { connectionId: CONN });
  let out = html();
  assert.match(out, /name="password" type="password"[^>]*autocomplete="current-password"/);
  assert.doesNotMatch(out, /name="password"[^>]*value=/);
  assert.match(out, /exchanged for an access token right away/);
  assert.match(out, /OptiMove does not retain the username or password after this request\. Your browser or password manager may handle them according to its own settings\./);
  // An empty pair never leaves the screen.
  await submit("credential", { username: USERNAME, password: "" });
  assert.equal(state.sourceConnections.credentialError.code, "credentials_required");
  assert.equal(posts, 0);
  // A double submit: the second one finds the busy flag and does nothing.
  const first = submit("credential", { username: ` ${USERNAME} `, password: PASSWORD });
  const second = submit("credential", { username: USERNAME, password: PASSWORD });
  await Promise.all([first, second]);
  assert.equal(posts, 1, "one request");
  assert.deepEqual(calls().filter((c) => c.startsWith("POST")), [`POST ${BASE}/${CONN}/connect`]);
  for (const call of fetchCalls) assert.doesNotMatch(call.url, new RegExp(PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(state.sourceConnections), /Sup3r-Secret/);
  assert.doesNotMatch(JSON.stringify(state.sourceConnections), /club\.account@/);
  out = html();
  assert.doesNotMatch(out, /Sup3r-Secret|club\.account@/);
  assert.match(out, /Verified/);
  assert.match(out, /The connection is verified/);
  assert.match(out, /Access token stored, encrypted\. It is never shown\./);
  // The GPEXE teams: exactly the server's two rows, the truncation named, Bind only where a pair is approved,
  // and the platform admin's way to the approved pair for the other one.
  assert.match(out, /GPEXE teams this account can see \(2\) - first page only/);
  assert.match(out, /run Test connection again to refresh this list/);
  assert.equal((out.match(/GPEXE team 98\d</g) || []).length, 2);
  assert.match(out, /Approved for First team/);
  assert.match(out, /No approved OptiMove team yet/);
  assert.equal((out.match(/data-action="source-connections-bind-open"/g) || []).length, 1);
  assert.match(out, /data-action="source-connections-open-pair"[^>]*>Set the pair for GPEXE team 981 in Data sources/);
  await act("source-connections-open-pair", { connectionId: CONN });
  assert.equal(state.organization.section, "dataSources", "the approved pair is set through the existing Data sources tab");
  assert.equal(state.sourceConnections.lastAttempt[CONN], undefined, "the team list read before the pair changes is dropped");
  state.organization.section = "sourceConnections";
  assert.match(html(), /Test the connection to list the GPEXE teams/, "on return the card asks for a new Test instead of a stale list");
});

test("5. the club admin sees only the teams the server presented (the approved intersection) and no way to approve a pair; an empty intersection says to ask a platform admin", async () => {
  const r = await openClub({
    list: [verified()],
    writes: { [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test", { sourceTeams: [TEAMS[0]], sourceTeamCount: 1 }), connection: verified() } }) },
  }, { who: asClubAdmin });
  await act("source-connections-test", { connectionId: CONN });
  assert.deepEqual(fetchCalls.at(-1), { method: "POST", url: `${BASE}/${CONN}/test`, body: {} });
  let out = html();
  assert.match(out, /Only the teams approved for one of your club's OptiMove teams are listed/);
  assert.equal((out.match(/GPEXE team 98\d</g) || []).length, 1);
  assert.doesNotMatch(out, /Youth|981|source-connections-open-pair/);
  r.set([verified()]);
  installFetch(responder({ list: [verified()], writes: { [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test", { sourceTeams: [], sourceTeamCount: 0 }), connection: verified() } }) } }).handler);
  await act("source-connections-test", { connectionId: CONN });
  out = html();
  assert.match(out, /None of the teams this account sees is approved for your club yet/);
});

test("6. Test: a refused credential moves the badge to Needs reconnect with the sentence to reconnect; a throttle, a running change and a 403 read as plain sentences; the token and the source's answer appear nowhere", async () => {
  await openClub({
    list: [verified()],
    writes: {
      [`POST /${CONN}/test`]: () => ({
        status: 200,
        body: {
          result: okResult("test", { outcome: "refused", state: "needs_reconnect", code: "source_auth_rejected", sourceTeams: null, sourceTeamCount: null, sourceTeamsTruncated: null }),
          connection: verified({ state: "needs_reconnect", lastErrorCode: "source_auth_rejected", lastErrorAt: "2026-10-05T10:00:00.000Z" }),
        },
      }),
    },
  });
  await act("source-connections-test", { connectionId: CONN });
  let out = html();
  assert.match(out, /Needs reconnect/);
  assert.match(out, /GPEXE refused the stored credential/);
  assert.match(out, /Reconnect with a working username and password/);
  // In this state Reconnect is the primary and Test the plain button.
  assert.match(out, /class="plain-button data-sources-primary" type="button" data-action="source-connections-reconnect-open"/);
  assert.match(out, /class="plain-button " type="button" data-action="source-connections-test"/);
  for (const [status, code, pattern] of [[429, "source_auth_throttled", /Too many attempts reached GPEXE/], [409, "try_again", /Another change of this connection/], [403, "forbidden", /administrator right your account does not hold/]]) {
    installFetch(responder({ list: [verified()], writes: { [`POST /${CONN}/test`]: () => ({ status, body: { error: code, message: "server text with host https://server3.gpexe.com/ and token abc" } }) } }).handler);
    await act("source-connections-test", { connectionId: CONN });
    out = html();
    assert.match(out, pattern, code);
    assert.doesNotMatch(out.replace(/<details class="data-sources-tech">[^]*?<\/details>/g, ""), /server3\.gpexe\.com|token abc/, "the server's text stays inside Technical details");
  }
});

test("7. Approve and bind: the review names the source, the host, the club, the OptiMove team and the GPEXE team; Confirm sends the pair once; an idempotent answer and a mismatch read as sentences; the bound team appears with Unbind", async () => {
  let bound = [];
  const r = await openClub({
    list: [verified()],
    writes: {
      [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test"), connection: verified({ boundTeams: bound }) } }),
      [`POST /${CONN}/bindings`]: (call) => {
        assert.deepEqual(call.body, { teamId: TEAM, sourceTeamId: "980" });
        const idempotent = bound.length > 0;
        bound = [BOUND];
        r.set([verified({ boundTeams: bound })]);
        return { status: idempotent ? 200 : 201, body: { result: { connectionId: CONN, action: "bind", outcome: "ok", idempotent, binding: BOUND }, connection: verified({ boundTeams: bound }) } };
      },
    },
  });
  await act("source-connections-test", { connectionId: CONN });
  await act("source-connections-bind-open", { connectionId: CONN, teamId: TEAM, teamName: "First team", sourceTeamId: "980", sourceTeamName: "First squad" });
  let out = html();
  assert.match(out, /Review the binding/);
  for (const fact of [/<dt>Source<\/dt><dd>GPEXE<\/dd>/, /<dt>Host<\/dt><dd>GPEXE server3<\/dd>/, /<dt>Club<\/dt><dd>FK Borac<\/dd>/, /<dt>OptiMove team<\/dt><dd>First team<\/dd>/, /<dt>GPEXE team<\/dt><dd>980 · First squad<\/dd>/]) assert.match(out, fact);
  assert.match(out, /never used for this team again - not even after an Unbind/);
  assert.equal(calls().filter((c) => c.includes("/bindings")).length, 0, "nothing bound before Confirm");
  await act("source-connections-bind-confirm");
  assert.equal(calls().filter((c) => c === `POST ${BASE}/${CONN}/bindings`).length, 1);
  out = html();
  assert.match(out, /First team now reads from GPEXE team 980/);
  assert.match(out, /Bound teams/);
  assert.match(out, /data-action="source-connections-unbind-open"/);
  assert.match(out, /Bound · First team/, "the team list marks the bound pair");
  // The same pair again is the server's idempotent answer, never a second row.
  await act("source-connections-bind-open", { connectionId: CONN, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  await act("source-connections-bind-confirm");
  assert.match(html(), /was already bound to GPEXE team 980; nothing changed/);
  installFetch(responder({ list: [verified({ boundTeams: bound })], writes: { [`POST /${CONN}/bindings`]: () => ({ status: 409, body: { error: "team_setting_mismatch", message: "x" } }) } }).handler);
  await act("source-connections-bind-open", { connectionId: CONN, teamId: TEAM_2, teamName: "U19", sourceTeamId: "981" });
  await act("source-connections-bind-confirm");
  assert.match(html(), /not the one approved for that OptiMove team under Data sources/);
  assert.ok(state.sourceConnections.bindReview, "the review stays open with the refusal");
});

test("8. Reconnect: the confirmation names the source, the owning club and the number of bound teams and travels with the new pair; the old credential is never shown; a stale confirmation reads as a sentence", async () => {
  await openClub({
    list: [verified({ boundTeams: [BOUND] })],
    writes: {
      [`POST /${CONN}/reconnect`]: (call) => {
        assert.deepEqual(call.body, { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: CLUB, affectedTeamCount: 1 } });
        return { status: 200, body: { result: okResult("reconnect", { boundTeamsChecked: 1 }), connection: verified({ boundTeams: [BOUND], lastVerifiedAt: "2026-10-05T11:00:00.000Z" }) } };
      },
    },
  });
  await act("source-connections-reconnect-open", { connectionId: CONN });
  let out = html();
  assert.match(out, /Reconnect the GPEXE account/);
  assert.match(out, /connection of <strong>FK Borac<\/strong>/);
  assert.match(out, /<strong>1 bound team<\/strong> will read through the new one/);
  assert.match(out, /The old credential is never shown and cannot be recovered/);
  assert.doesNotMatch(out, /value="[^"]*(token|secret)/i);
  await submit("credential", { username: USERNAME, password: PASSWORD });
  assert.equal(calls().filter((c) => c === `POST ${BASE}/${CONN}/reconnect`).length, 1);
  out = html();
  assert.match(out, /verified and its bound team reads/);
  assert.doesNotMatch(JSON.stringify(state.sourceConnections) + out, /Sup3r-Secret/);
  installFetch(responder({ list: [verified({ boundTeams: [BOUND] })], writes: { [`POST /${CONN}/reconnect`]: () => ({ status: 409, body: { error: "confirmation_mismatch", message: "x", expected: { sourceSystem: "gpexe", ownerClubId: CLUB, affectedTeamCount: 2 } } }) } }).handler);
  await act("source-connections-reconnect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  assert.match(html(), /changed since this screen was loaded/);
});

test("9. Unbind: the reason is required, the confirmation names both teams and warns that the team does not fall back to the environment token, the body carries a fresh requestKey and the expected pair, and the ended binding stays as history", async () => {
  const seen = [];
  await openClub({
    list: [verified({ boundTeams: [BOUND] })],
    writes: {
      [`POST /${CONN}/bindings/${BINDING}/unbind`]: (call) => {
        seen.push(call.body);
        return { status: 200, body: { result: { connectionId: CONN, action: "unbind", outcome: "ok", replayed: false, binding: { ...BOUND, state: "ended", endedAt: "2026-10-05T12:00:00.000Z", endReason: call.body.reason }, sourceContacted: false }, connection: verified() } };
      },
    },
  });
  await act("source-connections-unbind-open", { connectionId: CONN, bindingId: BINDING, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  let out = html();
  assert.match(out, /End the binding of <strong>First team<\/strong> to <strong>GPEXE team 980<\/strong>/);
  assert.match(out, /It does not fall back to the older server-wide GPEXE access \(the environment token\)\./);
  await submit("unbind", { reason: " " });
  assert.equal(state.sourceConnections.unbindError.code, "reason_required");
  assert.equal(seen.length, 0, "nothing sent without a reason");
  await submit("unbind", { reason: "Season over" });
  assert.equal(seen.length, 1);
  assert.match(seen[0].requestKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(seen[0], { requestKey: seen[0].requestKey, reason: "Season over", expected: { teamId: TEAM, sourceTeamId: "980" } });
  out = html();
  assert.match(out, /no longer reads from GPEXE team 980/);
  assert.match(out, /does not fall back to the older server-wide GPEXE access/);
  assert.match(out, /Ended just now/);
  assert.match(out, /Season over/);
  assert.doesNotMatch(out, /source-connections-unbind-open/, "no active binding is left");
  installFetch(responder({ list: [verified()], writes: { [`POST /${CONN}/bindings/${BINDING}/unbind`]: () => ({ status: 409, body: { error: "binding_already_ended", message: "x", current: { state: "ended" } } }) } }).handler);
  state.sourceConnections.connections = [verified({ boundTeams: [BOUND] })];
  await act("source-connections-unbind-open", { connectionId: CONN, bindingId: BINDING, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  await submit("unbind", { reason: "again" });
  // The sentence is honest: the connection was read again and the ended row is gone from the list.
  assert.deepEqual(calls().slice(-2), [`POST ${BASE}/${CONN}/bindings/${BINDING}/unbind`, `GET ${BASE}/${CONN}`]);
  const out2 = html();
  assert.match(out2, /This binding had already ended/);
  assert.doesNotMatch(out2, /source-connections-unbind-open/, "the ended row is not offered again");
  assert.equal(state.sourceConnections.unbindOpen, null);
});

test("9a. a write's outcome is never claimed when it is unknown: an uncoded 5xx without a JSON body (a proxy, a restart) and an aborted request are lost answers with Check result, a coded 5xx (key_missing) is a refusal; a settled Connect whose post-write read failed is shown as settled with an out-of-date note, never as a refusal; the credential form posts natively as POST only and the password field is blanked on submit", async () => {
  // An uncoded 504 whose body is not JSON.
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => ({ status: 504, body: undefined }) } });
  globalThis.fetch = ((inner) => async (url, options) => { const r = await inner(url, options); return r.status === 504 ? { ...r, json: async () => { throw new SyntaxError("not json"); } } : r; })(globalThis.fetch);
  await act("source-connections-connect-open", { connectionId: CONN });
  const form = { dataset: { sourceConnectionsForm: "credential" }, elements: { username: { value: USERNAME }, password: { value: PASSWORD } } };
  await submitSourceConnectionsForm(form, { render });
  assert.equal(form.elements.password.value, "", "the password field is blanked on submit");
  assert.equal(state.sourceConnections.unconfirmed?.action, "connect", "an uncoded 5xx is a lost answer");
  assert.equal(state.sourceConnections.credentialError, null);
  assert.match(html(), /Result not confirmed/);
  assert.doesNotMatch(html(), /Nothing was changed/);
  installFetch(responder({ list: [verified()] }).handler);
  await act("source-connections-read-state");
  assert.deepEqual(calls(), [`GET ${BASE}/${CONN}`], "a read only");
  assert.equal(state.sourceConnections.unconfirmed?.action, "connect", "a read never confirms the lost attempt");
  // An abort (the client bound) is a lost answer too.
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" }) } });
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  assert.equal(state.sourceConnections.unconfirmed?.action, "connect");
  // A coded 5xx the service wrote itself stays a refusal.
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => ({ status: 503, body: { error: "key_missing", message: "x" } }) } });
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  assert.equal(state.sourceConnections.unconfirmed, null);
  assert.match(html(), /no key to protect the credential/);
  // A settled write whose post-write read failed.
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => ({ status: 200, body: { result: okResult("connect"), connection: null, connectionReadError: true } }) } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options) => (!options?.method && url.startsWith(`${BASE}/`) ? { ok: false, status: 500, statusText: "", json: async () => ({ error: "internal_error" }) } : inner(url, options));
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  assert.equal(state.sourceConnections.credentialError, null, "a settled write is never shown as a refusal");
  assert.equal(state.sourceConnections.lastAttempt[CONN]?.action, "connect");
  assert.equal(state.sourceConnections.staleAfterWrite, CONN);
  let out = html();
  assert.match(out, /The request was settled, but the connection could not be read again afterwards, so the facts below may be out of date/);
  // A coded 5xx the service writes for a credential it cannot read is a refusal with its own sentence, not a lost answer.
  await openClub({ list: [verified()], writes: { [`POST /${CONN}/test`]: () => ({ status: 503, body: { error: "credential_unreadable", message: "x" } }) } });
  await act("source-connections-test", { connectionId: CONN });
  assert.equal(state.sourceConnections.unconfirmed, null);
  assert.match(html(), /can no longer be read\. Reconnect to store a new one/);
  // The client bound travels with every request.
  let sawSignal = false;
  const inner2 = globalThis.fetch;
  globalThis.fetch = async (url, options) => { if (options?.signal) sawSignal = true; return inner2(url, options); };
  await act("source-connections-test", { connectionId: CONN });
  assert.equal(sawSignal, typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function");
  assert.match(out, /The connection is verified/);
  // The form never submits natively as GET.
  await openClub({ list: [connection()] });
  await act("source-connections-connect-open", { connectionId: CONN });
  out = html();
  assert.match(out, /<form[^>]*data-source-connections-form="credential"[^>]*method="post"/);
  assert.match(out, /name="password"[^>]*data-bwignore/);
});

test("9b. Create with a lost answer: the form closes, no second create can be sent before Check result, and Check result reads the club's list (the route has no idempotency key)", async () => {
  await openClub({ list: [], writes: { "POST ": () => new TypeError("Failed to fetch") } });
  await act("source-connections-create-open");
  await submit("create", { hostKey: "server3", accountLabel: "Club account" });
  assert.equal(state.sourceConnections.unconfirmed?.action, "create");
  assert.equal(state.sourceConnections.createOpen, false, "the form closes");
  let out = html();
  assert.doesNotMatch(out, /data-source-connections-form="create"/);
  assert.match(out, /Result not confirmed/);
  assert.match(out, /data-action="source-connections-create-open"[^>]*disabled/, "no new create while the outcome is unconfirmed");
  await submit("create", { hostKey: "server3", accountLabel: "Club account" });
  await act("source-connections-create-open");
  assert.equal(fetchCalls.filter((c) => c.method === "POST").length, 1, "exactly one POST");
  installFetch(responder({ list: [connection()] }).handler);
  await act("source-connections-read-state");
  assert.deepEqual(calls(), [`GET ${BASE}?clubId=${CLUB}`], "a read of the list, never a second create");
  assert.equal(state.sourceConnections.unconfirmed?.action, "create", "the list is refreshed, the attempt's outcome stays unknown");
  assert.match(html(), /Club account/);
  assert.match(html(), /Which row, if any, the lost attempt created is not known/);
});

test("9c. a workspace switch never shows the previous club's connections: the loaded list is treated as not loaded, the panel's one-shot read fires for the new club, and nothing fires while a write is in flight", async () => {
  await openClub({ list: [verified()] }, { who: asClubAdmin });
  assert.match(html(), /Club account/);
  assert.equal(sourceConnectionsNeedLoad(), false);
  // The same person administers a second club and switches to its workspace.
  state.currentUser.activeWorkspace = { type: "club", scopeId: OTHER_CLUB };
  state.organization.data = orgData({ isPlatformAdmin: false, manageableClubIds: [OTHER_CLUB], clubs: [{ id: OTHER_CLUB, name: "FK Drugi" }] });
  const out = html();
  assert.doesNotMatch(out, /Club account|Verified/, "nothing of club A under club B's heading");
  assert.match(out, /FK DRUGI|FK Drugi/);
  assert.match(out, /Loading/);
  assert.equal(sourceConnectionsNeedLoad(), true, "the panel reads club B");
  installFetch(responder({ list: [] }).handler);
  await loadSourceConnections(render);
  assert.deepEqual(calls(), [`GET ${BASE}?clubId=${OTHER_CLUB}`]);
  assert.equal(state.sourceConnections.clubId, OTHER_CLUB);
  assert.match(html(), /has no GPEXE connection yet/);
  // A write in flight is never interrupted by the one-shot read.
  state.sourceConnections.credentialBusy = true;
  assert.equal(sourceConnectionsNeedLoad(), false);
  state.sourceConnections.credentialBusy = false;
  // An unconfirmed outcome of the previous club stays reachable after the switch: its Check result is
  // rendered above "Loading...", and the new club is read once it is resolved.
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => new TypeError("Failed to fetch") } }, { who: asClubAdmin });
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  state.currentUser.activeWorkspace = { type: "club", scopeId: OTHER_CLUB };
  state.organization.data = orgData({ isPlatformAdmin: false, manageableClubIds: [OTHER_CLUB], clubs: [{ id: OTHER_CLUB, name: "FK Drugi" }] });
  // In club B's workspace the server answers 404 for club A's connection, so no Check result is offered there:
  // the marker (and an Unbind's requestKey) is kept until the admin is back in club A's workspace.
  installFetch(() => ({ status: 404, body: { error: "notFound" } }));
  const out2 = html();
  assert.match(out2, /A change made for FK Borac is not confirmed yet\. Open FK Borac.{0,6}s workspace to check its result/);
  assert.doesNotMatch(out2, /data-action="source-connections-check-result"/);
  assert.doesNotMatch(out2, /Club account|Loading\.\.\./);
  assert.equal(sourceConnectionsNeedLoad(), false, "nothing is read while the outcome is unconfirmed");
  assert.equal(state.sourceConnections.unconfirmed?.action, "connect", "the marker is kept");
  // Back in club A's workspace: the block with Check result is there, and it settles.
  state.currentUser.activeWorkspace = { type: "club", scopeId: CLUB };
  state.organization.data = orgData({ isPlatformAdmin: false, manageableClubIds: [CLUB], clubs: [{ id: CLUB, name: "FK Borac" }] });
  assert.match(html(), /data-action="source-connections-read-state"/);
  installFetch(responder({ list: [verified()] }).handler);
  await act("source-connections-read-state");
  assert.equal(state.sourceConnections.unconfirmed?.action, "connect", "the read keeps the marker");
  globalThis.window.confirm = () => true;
  await act("source-connections-acknowledge");
  assert.equal(state.sourceConnections.unconfirmed, null);
});

test("9d2. a failed re-read after binding_already_ended is said, never hidden under 'the list is current'; a busy write of the previous club is named instead of an endless 'Loading...'", async () => {
  await openClub({ list: [verified({ boundTeams: [BOUND] })], writes: { [`POST /${CONN}/bindings/${BINDING}/unbind`]: () => ({ status: 409, body: { error: "binding_already_ended", message: "x", current: { state: "ended" } } }) } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options) => (!options?.method && url.startsWith(`${BASE}/`) ? Promise.reject(new TypeError("Failed to fetch")) : inner(url, options));
  await act("source-connections-unbind-open", { connectionId: CONN, bindingId: BINDING, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  await submit("unbind", { reason: "again" });
  const out = html();
  assert.doesNotMatch(out, /the list below is current/);
  assert.match(out, /This binding had already ended.*could not be read again, so the list may be out of date; open the tab again/);
  // A busy write of club A while club B is the workspace: a sentence, not "Loading...".
  await openClub({ list: [verified()] }, { who: asClubAdmin });
  state.sourceConnections.credentialBusy = true;
  state.currentUser.activeWorkspace = { type: "club", scopeId: OTHER_CLUB };
  state.organization.data = orgData({ isPlatformAdmin: false, manageableClubIds: [OTHER_CLUB], clubs: [{ id: OTHER_CLUB, name: "FK Drugi" }, { id: CLUB, name: "FK Borac" }] });
  const out2 = html();
  assert.match(out2, /A change for FK Borac is still running; this club is read when it has finished/);
  assert.doesNotMatch(out2, /Loading\.\.\.|Club account/);
  state.sourceConnections.credentialBusy = false;
});

test("9d3. a lost Create whose Check result cannot read the list either claims nothing: the outcome stays unconfirmed and Check result stays offered; a bind refused because the stored credential was refused closes the review, reads the card again (Needs reconnect) and names Reconnect as the next step", async () => {
  await openClub({ list: [], writes: { "POST ": () => new TypeError("Failed to fetch") } });
  await act("source-connections-create-open");
  await submit("create", { hostKey: "server3", accountLabel: "Club account" });
  assert.equal(state.sourceConnections.unconfirmed?.action, "create");
  installFetch(() => ({ status: 500, body: { error: "internal_error", message: "boom" } }));
  await act("source-connections-read-state");
  assert.equal(state.sourceConnections.unconfirmed?.action, "create", "still unconfirmed");
  let out = html();
  assert.doesNotMatch(out, /That change was made|what the server holds now/);
  assert.match(out, /Result not confirmed/);
  assert.match(out, /data-action="source-connections-read-state"/);
  // The bind refused by the source's 401: the server moved the connection to needs_reconnect.
  const needs = verified({ state: "needs_reconnect", lastErrorCode: "source_auth_rejected", lastErrorAt: "2026-10-05T10:00:00.000Z" });
  const r = await openClub({
    list: [verified()],
    writes: {
      [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test"), connection: verified() } }),
      [`POST /${CONN}/bindings`]: () => { r.set([needs]); return { status: 409, body: { error: "source_auth_rejected", message: "x", teamId: TEAM } }; },
    },
  });
  await act("source-connections-test", { connectionId: CONN });
  await act("source-connections-bind-open", { connectionId: CONN, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  await act("source-connections-bind-confirm");
  assert.deepEqual(calls().slice(-2), [`POST ${BASE}/${CONN}/bindings`, `GET ${BASE}/${CONN}`]);
  assert.equal(state.sourceConnections.bindReview, null, "the review closes");
  out = html();
  assert.match(out, /Needs reconnect/);
  assert.match(out, /nothing was bound and the connection now needs a reconnect/);
  assert.match(out, /class="plain-button data-sources-primary" type="button" data-action="source-connections-reconnect-open"/);
});

test("9e. re-entering the tab drops the previous visit's presented team list, notice and ended row (never a write in flight)", async () => {
  await openClub({ list: [verified()], writes: { [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test"), connection: verified() } }) } });
  await act("source-connections-test", { connectionId: CONN });
  assert.ok(state.sourceConnections.lastAttempt[CONN]);
  const { enterSourceConnectionsSection } = await import("../source-connections-data.js");
  enterSourceConnectionsSection();
  assert.deepEqual(state.sourceConnections.lastAttempt, {});
  assert.equal(state.sourceConnections.teamsOpen, "");
  assert.equal(state.sourceConnections.connections, null);
  state.sourceConnections.unconfirmed = { action: "test", connectionId: CONN };
  state.sourceConnections.connections = [verified()];
  enterSourceConnectionsSection();
  assert.ok(state.sourceConnections.connections, "an unconfirmed outcome keeps the loaded card");
  state.sourceConnections.unconfirmed = null;
  // A club admin can never reach Data sources through the pair action, even by hand.
  asClubAdmin();
  state.organization.section = "sourceConnections";
  await act("source-connections-open-pair", { connectionId: CONN });
  assert.equal(state.organization.section, "sourceConnections");
});

test("9d. newRequestKey is a v4 UUID even without crypto.randomUUID (an insecure context or an older browser)", () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(newRequestKey(), V4);
  const real = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i += 1) a[i] = (i * 37 + 11) & 255; return a; } }, configurable: true });
    assert.match(newRequestKey(), V4);
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    assert.match(newRequestKey(), V4);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
  }
});

test("10. a lost answer is never resent blindly: after a lost Connect, Check result reads the connection (the pair is not sent again); after a lost Unbind it repeats the same requestKey; after an outcome_unknown bind it repeats the same pair; the screen says the result is not confirmed meanwhile", async () => {
  const lost = () => new TypeError("Failed to fetch");
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => lost() } });
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  let out = html();
  assert.match(out, /Result not confirmed/);
  assert.match(out, /sends no username or password again/);
  assert.equal(state.sourceConnections.unconfirmed.action, "connect");
  assert.ok(writeInFlight(), "an unconfirmed outcome counts as in flight");
  assert.doesNotMatch(out, /data-action="source-connections-test"/, "no other write is offered meanwhile");
  installFetch(responder({ list: [verified()] }).handler);
  await act("source-connections-read-state");
  assert.deepEqual(calls(), [`GET ${BASE}/${CONN}`], "a read, never the pair again");
  assert.equal(state.sourceConnections.unconfirmed?.action, "connect", "a read never confirms the lost Connect");
  assert.match(html(), /Read current state: the connection is Verified/);
  assert.match(html(), /does not tell whether the lost Connect landed/);

  // Unbind: the same key again.
  const keys = [];
  let attempt = 0;
  await openClub({
    list: [verified({ boundTeams: [BOUND] })],
    writes: {
      [`POST /${CONN}/bindings/${BINDING}/unbind`]: (call) => {
        keys.push(call.body.requestKey);
        attempt += 1;
        if (attempt === 1) return lost();
        return { status: 200, body: { result: { connectionId: CONN, action: "unbind", outcome: "ok", replayed: true, binding: { ...BOUND, state: "ended", endedAt: "2026-10-05T12:00:00.000Z", endReason: call.body.reason }, sourceContacted: false }, connection: verified() } };
      },
    },
  });
  await act("source-connections-unbind-open", { connectionId: CONN, bindingId: BINDING, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  await submit("unbind", { reason: "Season over" });
  assert.match(html(), /Result not confirmed.*same request again/s);
  await act("source-connections-check-result");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the same requestKey");
  assert.match(html(), /no longer reads from GPEXE team 980/);

  // bind: outcome_unknown, then the same pair again.
  let binds = 0;
  await openClub({
    list: [verified()],
    writes: {
      [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test"), connection: verified() } }),
      [`POST /${CONN}/bindings`]: (call) => {
        binds += 1;
        assert.deepEqual(call.body, { teamId: TEAM, sourceTeamId: "980" });
        if (binds === 1) return { status: 503, body: { error: "outcome_unknown", message: "x", connectionId: CONN } };
        return { status: 200, body: { result: { connectionId: CONN, action: "bind", outcome: "ok", idempotent: true, binding: BOUND }, connection: verified({ boundTeams: [BOUND] }) } };
      },
    },
  });
  await act("source-connections-test", { connectionId: CONN });
  await act("source-connections-bind-open", { connectionId: CONN, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  await act("source-connections-bind-confirm");
  assert.equal(state.sourceConnections.unconfirmed?.action, "bind");
  await act("source-connections-check-result");
  assert.equal(binds, 2);
  assert.match(html(), /First team reads from GPEXE team 980 \(the earlier request had gone through\)/);
});

test("14. a lost Connect, Reconnect, Test or create is never confirmed by a read: a lost Reconnect on a verified connection followed by an identical verified row keeps the marker and every write locked; a lost Connect followed by not_connected keeps it; a lost create refreshes the list but keeps it; only the explicit acknowledgement - asked first, sending nothing - lifts the lock; a bind and an Unbind keep the idempotent Check result", async () => {
  // (a) lost Reconnect on a verified connection; the GET answers the identical verified row.
  await openClub({ list: [verified({ boundTeams: [BOUND] })], writes: { [`POST /${CONN}/reconnect`]: () => new TypeError("Failed to fetch") } });
  await act("source-connections-reconnect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  assert.equal(state.sourceConnections.unconfirmed?.action, "reconnect");
  installFetch(responder({ list: [verified({ boundTeams: [BOUND] })] }).handler);
  await act("source-connections-read-state");
  assert.deepEqual(calls(), [`GET ${BASE}/${CONN}`], "a read only, the pair never again");
  assert.equal(state.sourceConnections.unconfirmed?.action, "reconnect", "an identical verified row proves nothing about the lost Reconnect");
  assert.ok(writeInFlight(), "writes stay locked");
  let out = html();
  assert.match(out, /Read current state: the connection is Verified/);
  assert.match(out, /does not tell whether the lost Reconnect landed/);
  assert.match(out, /data-action="source-connections-read-state"/);
  assert.match(out, /data-action="source-connections-acknowledge"/);
  assert.doesNotMatch(out, /data-action="source-connections-check-result"/, "no idempotent repeat is offered for a Reconnect");
  assert.doesNotMatch(out, /data-action="source-connections-test"|data-action="source-connections-reconnect-open"|data-action="source-connections-bind-open"/, "no other write control");
  assert.match(out, /data-action="source-connections-unbind-open"[^>]*disabled/);
  await act("source-connections-reconnect-open", { connectionId: CONN });
  assert.equal(state.sourceConnections.credentialOpen, null, "a write cannot even be opened while the marker stands");
  await act("source-connections-test", { connectionId: CONN });
  assert.equal(calls().filter((c) => c.startsWith("POST")).length, 0, "nothing sent");
  // (d) the explicit acknowledgement: declined → nothing changes; accepted → the marker goes, nothing is sent, writes unlock.
  let asked = 0;
  globalThis.window.confirm = () => { asked += 1; return false; };
  await act("source-connections-acknowledge");
  assert.equal(asked, 1);
  assert.equal(state.sourceConnections.unconfirmed?.action, "reconnect", "declined changes nothing");
  globalThis.window.confirm = () => { asked += 1; return true; };
  const before = fetchCalls.length;
  await act("source-connections-acknowledge");
  assert.equal(asked, 2);
  assert.equal(fetchCalls.length, before, "acknowledging sends nothing");
  assert.equal(state.sourceConnections.unconfirmed, null);
  assert.equal(writeInFlight(), false, "writes unlock only now");
  out = html();
  assert.match(out, /was acknowledged; its outcome stays unknown/);
  assert.match(out, /data-action="source-connections-test"(?![^>]*disabled)/);
  globalThis.window.confirm = () => true;
  // (b) lost Connect; the GET answers not_connected: the marker stays.
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => new TypeError("Failed to fetch") } });
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  installFetch(responder({ list: [connection()] }).handler);
  await act("source-connections-read-state");
  assert.equal(state.sourceConnections.unconfirmed?.action, "connect", "not_connected now does not mean the lost Connect will not land");
  assert.match(html(), /Read current state: the connection is Not connected/);
  assert.ok(writeInFlight());
  // (c) lost create; the list read refreshes the display but the attempt's outcome stays unknown.
  await openClub({ list: [], writes: { "POST ": () => new TypeError("Failed to fetch") } });
  await act("source-connections-create-open");
  await submit("create", { hostKey: "server3", accountLabel: "Club account" });
  installFetch(responder({ list: [connection()] }).handler);
  await act("source-connections-read-state");
  assert.deepEqual(calls(), [`GET ${BASE}?clubId=${CLUB}`]);
  assert.equal(state.sourceConnections.connections.length, 1, "the list is refreshed");
  assert.equal(state.sourceConnections.unconfirmed?.action, "create", "which row the lost attempt created is not known");
  assert.match(html(), /Which row, if any, the lost attempt created is not known/);
  assert.match(html(), /data-action="source-connections-connect-open"[^>]*disabled/, "the new row's writes stay locked");
  // (e) a bind and an Unbind keep Check result: the same pair / key again, and the acknowledgement is not offered.
  await openClub({ list: [verified({ boundTeams: [BOUND] })], writes: { [`POST /${CONN}/bindings/${BINDING}/unbind`]: () => new TypeError("Failed to fetch") } });
  await act("source-connections-unbind-open", { connectionId: CONN, bindingId: BINDING, teamId: TEAM, teamName: "First team", sourceTeamId: "980" });
  await submit("unbind", { reason: "Season over" });
  out = html();
  assert.match(out, /data-action="source-connections-check-result"/);
  assert.doesNotMatch(out, /data-action="source-connections-acknowledge"|data-action="source-connections-read-state"/);
  await act("source-connections-acknowledge");
  assert.equal(state.sourceConnections.unconfirmed?.action, "unbind", "an Unbind is never acknowledged away; it is checked");
  await act("source-connections-read-state");
  assert.equal(calls().filter((c) => c.startsWith("GET")).length, 1, "no plain read for an Unbind either");
});

test("15. doc-lint: the credential form carries the agreed sentence and autocomplete=\"current-password\", and neither the screen nor the documents claim that the pair is 'not saved anywhere' or 'never shown again'", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  await openClub({ list: [connection()] });
  await act("source-connections-connect-open", { connectionId: CONN });
  const out = html();
  assert.match(out, /OptiMove does not retain the username or password after this request\. Your browser or password manager may handle them according to its own settings\./);
  assert.match(out, /name="password" type="password"[^>]*autocomplete="current-password"/);
  assert.doesNotMatch(out, /new-password|not saved anywhere|never shown again|neither offers nor saves/);
  const root = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
  const files = ["frontend/source-connections-view.js", "docs/ai/source-connections-f3c2-contract.md", "docs/runbooks/gpexe-in-app-import.md", "docs/runbooks/gpexe-owner-pilot-f3c3.md"];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /not saved anywhere|never shown again|neither offers nor saves|is never saved/, file);
    assert.doesNotMatch(text, /autocomplete="new-password"|`new-password` on the/, `${file}: the old attribute`);
  }
  const contract = fs.readFileSync(path.join(root, "docs/ai/source-connections-f3c2-contract.md"), "utf8");
  assert.match(contract, /current-password/);
  assert.match(contract, /OptiMove\s+does not retain the username or password after this request\. Your browser or password manager\s+may handle them according to its own settings\./);
});

test("11. leaving: the section switch and beforeunload ask only while a write runs or an outcome is not confirmed", async () => {
  asPlatformAdmin();
  let asked = 0;
  globalThis.window.confirm = () => { asked += 1; return false; };
  assert.equal(confirmLeaveSourceConnections(), true);
  const event = { preventDefault() { this.prevented = true; }, returnValue: undefined };
  handleSourceConnectionsBeforeUnload(event);
  assert.equal(event.prevented, undefined);
  state.sourceConnections.unconfirmed = { action: "connect", connectionId: CONN };
  assert.equal(confirmLeaveSourceConnections(), false);
  assert.equal(asked, 1);
  handleSourceConnectionsBeforeUnload(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, "");
  // The way to Data sources is an exit like any other: asked, and declined changes nothing.
  state.organization.section = "sourceConnections";
  await act("source-connections-open-pair");
  assert.equal(asked, 2);
  assert.equal(state.organization.section, "sourceConnections");
  globalThis.window.confirm = () => true;
  Object.assign(state.sourceConnections, freshSlice());
});

test("11b. a Reconnect refused as confirmation_mismatch reads the connection again, closes the form and says what to do; the 'Set the pair' button is disabled while a write runs", async () => {
  await openClub({
    list: [verified({ boundTeams: [BOUND] })],
    writes: { [`POST /${CONN}/reconnect`]: () => ({ status: 409, body: { error: "confirmation_mismatch", message: "x", expected: { sourceSystem: "gpexe", ownerClubId: CLUB, affectedTeamCount: 2 } } }) },
  });
  await act("source-connections-reconnect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  assert.deepEqual(calls().slice(-2), [`POST ${BASE}/${CONN}/reconnect`, `GET ${BASE}/${CONN}`]);
  assert.equal(state.sourceConnections.credentialOpen, null, "the form closes");
  const out = html();
  assert.match(out, /it was read again\. Open Reconnect again/);
  assert.doesNotMatch(out, /Sup3r-Secret/);
  // Platform admin: the pair button follows the busy rule.
  await openClub({ list: [verified()], writes: { [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test"), connection: verified() } }) } });
  await act("source-connections-test", { connectionId: CONN });
  state.sourceConnections.testBusy = CONN;
  assert.match(html(), /data-action="source-connections-open-pair"[^>]*disabled/);
  state.sourceConnections.testBusy = "";
  assert.doesNotMatch(html(), /data-action="source-connections-open-pair"[^>]*disabled/);
});

test("11c. the sentences follow the state: a refused FIRST Connect keeps the form open and names the typed pair (not 'reconnect'); a connect that stored the token but failed the check read says to Test, never 'nothing was changed'; the test's ok outcome is said once", async () => {
  await openClub({ list: [connection()], writes: { [`POST /${CONN}/connect`]: () => ({ status: 409, body: { error: "source_auth_rejected", message: "x" } }) } });
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  let out = html();
  assert.match(out, /Not connected/);
  assert.match(out, /data-source-connections-form="credential"/, "the form stays open");
  assert.match(out, /GPEXE refused this username and password\. Nothing was stored; check them and try once more/);
  assert.doesNotMatch(out, /Reconnect with a working/);
  await openClub({
    list: [connection()],
    writes: { [`POST /${CONN}/connect`]: () => ({ status: 200, body: { result: okResult("connect", { outcome: "failed", state: "linked_untested", code: "source_unavailable", sourceTeams: null, sourceTeamCount: null, sourceTeamsTruncated: null }), connection: connection({ state: "linked_untested", hasCredential: true, lastErrorCode: "source_unavailable", lastErrorAt: "2026-10-05T10:00:00.000Z" }) } }) },
  });
  await act("source-connections-connect-open", { connectionId: CONN });
  await submit("credential", { username: USERNAME, password: PASSWORD });
  out = html();
  assert.match(out, /Connected, not tested/);
  assert.match(out, /stored the access token, but the check read did not succeed \(GPEXE did not answer\)\. Test the connection\./);
  assert.doesNotMatch(out, /Nothing was changed/);
  assert.match(out, /The access token is stored, but the check read did not succeed \(the source did not answer\)/);
  await openClub({ list: [verified()], writes: { [`POST /${CONN}/test`]: () => ({ status: 200, body: { result: okResult("test", { boundTeamsChecked: 1 }), connection: verified() } }) } });
  await act("source-connections-test", { connectionId: CONN });
  out = html();
  assert.equal((out.match(/succeeded; 1 bound team was read/g) || []).length, 1, "the ok outcome is said once, on the attempt line");
  assert.doesNotMatch(out, /The connection is verified and its bound team reads/);
});

test("12. every stable backend code of the source routes reads as a sentence, never as the raw code", () => {
  const codes = ["credential_unreadable", "network_budget_exhausted", "attempt_not_sent", "try_again", "rights_changed", "team_setting_missing", "team_setting_mismatch", "team_already_bound", "source_team_already_bound", "host_not_allowed", "binding_refused", "binding_already_ended", "outcome_unknown", "key_missing", "internal_error", "attempt_not_recorded", "source_auth_throttled", "request_key_reused", "not_connected", "exchange_not_supported", "credential_kind_unsupported", "connection_not_verified", "confirmation_mismatch", "binding_mismatch", "already_connected", "owner_scope_unsupported", "adapter_not_available", "invalid_body", "jsonRequired", "source_auth_rejected", "source_team_not_visible", "source_unavailable", "source_answer_unexpected"];
  for (const code of codes) {
    const text = connectionMessage({ status: 409, code, message: "" });
    assert.ok(text.length > 20 && !text.includes(code) && /[.!]$/.test(text) && !text.startsWith("That did not work"), code);
  }
  assert.match(connectionMessage({ status: 404, code: "notFound" }), /not available in your workspace/);
  assert.match(connectionMessage({ status: 0, code: "no_answer" }), /Check result/);
});

test("13. the coach's Imports screen: a check refused or failed through the team's source connection tells the coach to contact an administrator instead of 'try again'", () => {
  assert.match(checkErrorText({ code: "source_connection_unavailable", message: "The team's source connection cannot be used right now; contact an administrator. Nothing was read." }), /contact an administrator/);
  assert.doesNotMatch(checkErrorText({ code: "source_connection_unavailable", message: "" }), /Try again/);
  const failed = renderCheckSummaryHtml({ id: "c1", status: "failed", startedAt: "2026-10-05T10:00:00.000Z", window: {}, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0, error: { code: "source_connection_unavailable", message: "The team's source connection cannot be used right now; contact an administrator." } });
  assert.match(failed, /contact an administrator/);
  assert.doesNotMatch(failed, /Try again in a moment/);
  const general = renderCheckSummaryHtml({ id: "c2", status: "failed", startedAt: "2026-10-05T10:00:00.000Z", window: {}, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0, error: { code: "source_unavailable", message: "x" } });
  assert.match(general, /Try again in a moment/);
  // An administrator sees the precise connection code on the row: the advice is Settings > Source connections, not "try again".
  const admin = renderCheckSummaryHtml({ id: "c3", status: "failed", startedAt: "2026-10-05T10:00:00.000Z", window: {}, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0, error: { code: "binding_ended", message: "x" } });
  assert.match(admin, /an administrator acts under Settings &gt; Source connections|an administrator acts under Settings > Source connections/);
  assert.doesNotMatch(admin, /Try again in a moment/);
});
