// Settings -> Data sources (phase F3b): the platform-admin screen that
// connects a team to GPEXE and decides who may approve its imports. Driven
// through the real handlers with a fake fetch, so what the screen sends and
// what it shows are both proved here: nothing is sent before a confirmation,
// a refusal is translated into plain admin language, and the technical code
// stays inside "Technical details".
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
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { handleDataSourcesAction, submitDataSourcesForm } = await import("../data-sources-actions.js");
const { enterDataSourcesSection, loadDataSourcesTeam, teamCoachOptions } = await import("../data-sources-data.js");
const { adminMessage, renderDataSourcesPanelHtml } = await import("../data-sources-view.js");
const { renderSettingsNavHtml } = await import("../navigation.js");
const { renderOrganizationPanelHtml } = await import("../organization-view.js");
const { state } = await import("../state.js");

const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TEAM = "bbbbbbbb-0000-4000-8000-000000000002";
const COACH = "cccccccc-0000-4000-8000-000000000003";
const COACH_2 = "dddddddd-0000-4000-8000-000000000004";
const GRANT = "eeeeeeee-0000-4000-8000-000000000005";

function orgData() {
  return {
    isPlatformAdmin: true,
    clubs: [],
    athletes: [],
    teams: [
      { id: TEAM, name: "First team", club_name: "FK Borac", club_id: "club-1" },
      { id: OTHER_TEAM, name: "U19", club_name: "FK Borac", club_id: "club-1" },
    ],
    users: [
      { id: COACH, name: "Ana Kovac", teamRoles: [{ teamId: TEAM, role: "team_coach", isActive: true }] },
      { id: COACH_2, name: "Marko Ilic", teamRoles: [{ teamId: TEAM, role: "team_coach", isActive: true }] },
      { id: "ffffffff-0000-4000-8000-000000000006", name: "Old coach", teamRoles: [{ teamId: TEAM, role: "team_coach", isActive: false }] },
      { id: "99999999-0000-4000-8000-000000000007", name: "Other team coach", teamRoles: [{ teamId: OTHER_TEAM, role: "team_coach", isActive: true }] },
      { id: "88888888-0000-4000-8000-000000000008", name: "An athlete", teamRoles: [] },
      { id: "77777777-0000-4000-8000-000000000009", name: "Disabled coach", loginActive: false, teamRoles: [{ teamId: TEAM, role: "team_coach", isActive: true }] },
    ],
  };
}

const CONNECTED = {
  settings: { gpexeTeamId: "1473", configuredAt: "2026-09-20T10:00:00.000Z", configuredByName: "Owner", changeReason: "pilot" },
  importSwitch: { enabled: false, message: "Import writing is off." },
  viewer: { isPlatformAdmin: true },
};

function reset() {
  state.organization.data = orgData();
  state.organization.section = "dataSources";
  Object.assign(state.dataSources, {
    teamId: "", loading: false, error: null, status: null, history: null, approvers: null, generation: state.dataSources.generation + 1, notice: "",
    noticeFor: "",
    connectOpen: false, connectDraft: { gpexeTeamId: "", reason: "" }, connectConfirm: null, connectBusy: false, connectError: null,
    grantOpen: false, grantConfirm: null, grantBusy: false, grantError: null,
    revokeConfirm: null, revokeBusy: false, revokeError: null, historyOpen: false,
  });
}

const render = () => {};
const act = (action) => handleDataSourcesAction({ dataset: { action } }, { render });
const submit = (kind, fields) => submitDataSourcesForm(
  { dataset: { dataSourcesForm: kind }, elements: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])) },
  { render },
);

// The three reads a chosen team needs, with whatever the test wants back.
function teamResponder({ status = CONNECTED, history = [], approvers = [], writes = {} } = {}) {
  return (call) => {
    if (call.method === "GET" && call.url.endsWith("/status")) return { status: 200, body: status };
    if (call.method === "GET" && call.url.endsWith("/settings/history")) return { status: 200, body: { history } };
    if (call.method === "GET" && call.url.endsWith("/approvers")) return { status: 200, body: { approvers } };
    const write = writes[`${call.method} ${call.url.split("/gpexe/teams/")[1]}`];
    if (write) return write;
    return { status: 200, body: { ok: true } };
  };
}

async function openTeam(options) {
  reset();
  installFetch(teamResponder(options));
  await submit("team", { teamId: TEAM });
}

test("1. the tab is offered to a platform admin only, and a section nobody may see falls back to Overview", () => {
  assert.match(renderSettingsNavHtml({ isPlatformAdmin: true }, "overview"), /data-section="dataSources"/);
  assert.doesNotMatch(renderSettingsNavHtml({ isPlatformAdmin: false }, "overview"), /dataSources/);

  reset();
  state.organization.section = "dataSources";
  const html = renderOrganizationPanelHtml({ currentUser: { name: "Coach" }, data: { ...orgData(), isPlatformAdmin: false }, error: "", role: "Coach", scope: "Team" });
  assert.equal(state.organization.section, "overview", "the section is reset for an account that is not a platform admin");
  assert.doesNotMatch(html, /Data sources<\/h3>/);
});

test("2. choosing a team reads that team only, from the teams Settings already loaded", async () => {
  await openTeam();
  assert.deepEqual(fetchCalls.map((call) => `${call.method} ${call.url}`), [
    `GET /api/training-load/gpexe/teams/${TEAM}/status`,
    `GET /api/training-load/gpexe/teams/${TEAM}/settings/history`,
    `GET /api/training-load/gpexe/teams/${TEAM}/approvers`,
  ]);
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /FK Borac · First team/);
  assert.match(html, /Connected/);
  assert.match(html, /1473/);
  assert.match(html, /Change GPEXE team/);
});

test("3. a team with no connection says so and offers Connect, not Change", async () => {
  await openTeam({ status: { settings: null, importSwitch: { enabled: false }, viewer: { isPlatformAdmin: true } } });
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /Not connected/);
  assert.match(html, /Connect GPEXE/);
  assert.doesNotMatch(html, /Change GPEXE team/);
});

test("4. opening the form, typing and cancelling sends nothing", async () => {
  await openTeam();
  const reads = fetchCalls.length;
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "moved to the new GPEXE team" });
  assert.equal(fetchCalls.length, reads, "the review step sends nothing");
  assert.match(renderDataSourcesPanelHtml(), /GPEXE team 1500/);
  await act("data-sources-cancel");
  assert.equal(fetchCalls.length, reads, "Cancel sends nothing");
  assert.equal(state.dataSources.connectConfirm, null);
  assert.doesNotMatch(renderDataSourcesPanelHtml(), /GPEXE team 1500/);
});

test("5. the confirmation names both sides and what it means, and only Confirm writes", async () => {
  await openTeam();
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "the first number was a typo" });
  const confirmHtml = renderDataSourcesPanelHtml();
  assert.match(confirmHtml, /GPEXE team 1500<\/strong> → <strong>FK Borac · First team/);
  assert.match(confirmHtml, /reads its sessions from GPEXE team 1500 instead of 1473/);
  assert.match(confirmHtml, /only accepted while nothing has been read from GPEXE for this team, so it may still be refused/);
  assert.doesNotMatch(confirmHtml, /already imported stay as they are/, "a change is impossible once anything is imported, so it must not promise that");

  await act("data-sources-connect-save");
  const put = fetchCalls.find((call) => call.method === "PUT");
  assert.equal(put.url, `/api/training-load/gpexe/teams/${TEAM}/settings`);
  assert.deepEqual(put.body, { gpexeTeamId: "1500", reason: "the first number was a typo" });
  assert.match(renderDataSourcesPanelHtml(), /The GPEXE team is changed/);
});

test("6. a first connection needs no reason; a change without one is refused before any request", async () => {
  await openTeam({ status: { settings: null, importSwitch: {}, viewer: { isPlatformAdmin: true } } });
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1473", reason: "" });
  await act("data-sources-connect-save");
  assert.deepEqual(fetchCalls.find((call) => call.method === "PUT").body, { gpexeTeamId: "1473" });

  await openTeam();
  const reads = fetchCalls.length;
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "   " });
  assert.equal(fetchCalls.length, reads, "nothing is sent without a reason");
  assert.equal(state.dataSources.connectConfirm, null);
  assert.match(renderDataSourcesPanelHtml(), /Changing a connection that already exists needs a reason/);
});

test("7. a GPEXE Team ID that is not a number is refused before any request", async () => {
  await openTeam();
  const reads = fetchCalls.length;
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "14 73; drop", reason: "x" });
  assert.equal(fetchCalls.length, reads);
  assert.match(renderDataSourcesPanelHtml(), /A GPEXE Team ID is a number of up to 12 digits/);
});

test("8. the same value again is answered as 'nothing changed'", async () => {
  await openTeam();
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1473", reason: "re-entered" });
  assert.match(renderDataSourcesPanelHtml(), /This is the team's current GPEXE team, so nothing will change/);
  await act("data-sources-connect-save");
  assert.match(renderDataSourcesPanelHtml(), /Nothing changed: this team was already connected to that GPEXE team/);
});

test("9. a blocked change is explained in plain words, promises no move function, and keeps the code out of sight", async () => {
  await openTeam({
    writes: {
      [`PUT ${TEAM}/settings`]: { status: 409, body: { error: "gpexe_team_change_blocked", message: "This team already has a check from GPEXE team 1473..." } },
    },
  });
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "wrong team" });
  await act("data-sources-connect-save");
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /the connection stays as it is/);
  assert.doesNotMatch(html.split("<details")[0], /gpexe_team_change_blocked/, "the code is only inside Technical details");
  assert.match(html, /<details class="data-sources-tech">[\s\S]*gpexe_team_change_blocked/);
  // The sentence denies the move everywhere, inside the app and outside it.
  assert.match(html, /moving this team to another one is not supported: not here, and not for a platform administrator either/);
  assert.doesNotMatch(html, /(we|a platform admin|an administrator) (can|will) move/i);
  assert.doesNotMatch(html, /the runbook decides/i, "the runbook has no procedure for this, so it must not be offered as one");
});

test("10. every refusal of PR #113 has an administrator's sentence, and none of them invents a function", () => {
  const cases = [
    ["gpexe_team_change_blocked", /not supported: not here, and not for a platform administrator either/],
    ["gpexe_orphan_data", /has to be decided with the owner before this team is connected/],
    ["gpexe_team_taken", /already feeds another OptiMove team/],
    ["gpexe_change_busy", /Try again when it has finished/],
    ["invalid_gpexe_team_id", /number of up to 12 digits/],
    ["change_reason_required", /needs a reason/],
    ["change_reason_too_long", /at most 500 characters/],
    ["reason_required", /A reason is required/],
    ["already_granted", /already has approval rights/],
    ["grantee_not_team_coach", /active coach of this team/],
  ];
  for (const [code, phrase] of cases) assert.match(adminMessage({ status: 409, code }), phrase, code);
  assert.match(adminMessage({ status: 403, code: "forbidden" }), /needs platform admin access/);
  assert.match(adminMessage({ status: 404, code: "notFound", scope: "grant" }), /This right no longer exists/);
  assert.match(adminMessage({ status: 404, code: "notFound" }), /not available in your workspace/);
  assert.match(adminMessage({ status: 0, code: "error" }), /can't tell whether the change was made/);
});

test("11. only an active coach of this team, without a grant already, can be offered the right", async () => {
  await openTeam({ approvers: [{ id: GRANT, userId: COACH, userName: "Ana Kovac", grantedAt: "2026-09-20T09:00:00.000Z", grantReason: "pilot", revokedAt: null, active: true }] });
  assert.deepEqual(teamCoachOptions().map((option) => option.label), ["Marko Ilic"]);
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /Ana Kovac/);
  assert.match(html, /1 coach with rights/);
  assert.match(html, /Remove rights/);
});

test("12. no coach is preselected, the confirmation names the coach and the team, and only Confirm writes", async () => {
  await openTeam();
  await act("data-sources-grant-open");
  const form = renderDataSourcesPanelHtml();
  assert.match(form, /<option value="">Choose a coach<\/option>/);
  assert.doesNotMatch(form, /<option value="[^"]+" selected/);

  const reads = fetchCalls.length;
  await submit("grant", { userId: "", reason: "needs to approve while I am away" });
  assert.equal(fetchCalls.length, reads, "no coach chosen: nothing is sent");

  await submit("grant", { userId: COACH, reason: "" });
  assert.equal(fetchCalls.length, reads, "no reason: nothing is sent");
  assert.match(renderDataSourcesPanelHtml(), /A reason is required/);

  await submit("grant", { userId: COACH, reason: "needs to approve while I am away" });
  assert.equal(fetchCalls.length, reads, "the review step sends nothing");
  assert.match(renderDataSourcesPanelHtml(), /Ana Kovac<\/strong> → <strong>FK Borac · First team/);

  await act("data-sources-grant-save");
  const post = fetchCalls.find((call) => call.method === "POST");
  assert.equal(post.url, `/api/training-load/gpexe/teams/${TEAM}/approvers`);
  assert.deepEqual(post.body, { userId: COACH, reason: "needs to approve while I am away" });
  assert.match(renderDataSourcesPanelHtml(), /Ana Kovac can now approve GPEXE imports for this team/);
});

test("13. removing a right names the coach and the team, needs a reason, and sends it once", async () => {
  await openTeam({ approvers: [{ id: GRANT, userId: COACH, userName: "Ana Kovac", grantedAt: "2026-09-20T09:00:00.000Z", revokedAt: null, active: true }] });
  await handleDataSourcesAction({ dataset: { action: "data-sources-revoke-open", grantId: GRANT, userName: "Ana Kovac" } }, { render });
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /Remove approval rights from <strong>Ana Kovac<\/strong> for <strong>FK Borac · First team/);
  assert.match(html, /no longer be able to approve GPEXE imports/);

  const reads = fetchCalls.length;
  await submit("revoke", { reason: "" });
  assert.equal(fetchCalls.length, reads, "no reason: nothing is sent");
  await submit("revoke", { reason: "left the club" });
  const post = fetchCalls.find((call) => call.method === "POST");
  assert.equal(post.url, `/api/training-load/gpexe/teams/${TEAM}/approvers/${GRANT}/revoke`);
  assert.deepEqual(post.body, { reason: "left the club" });
  assert.match(renderDataSourcesPanelHtml(), /Ana Kovac can no longer approve GPEXE imports for this team/);
});

test("14. a second click while a write is running sends nothing more", async () => {
  await openTeam();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetch(async (call) => {
    if (call.method === "PUT") { await gate; return { status: 200, body: { settings: {} } }; }
    return teamResponder()(call);
  });
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "typo" });
  const first = act("data-sources-connect-save");
  await act("data-sources-connect-save");
  assert.equal(fetchCalls.filter((call) => call.method === "PUT").length, 1, "the second click is ignored while the first is running");
  assert.match(renderDataSourcesPanelHtml(), /Saving\.\.\./);
  release();
  await first;
});

test("15. an answer for a team the admin has left never paints over the new one", async () => {
  reset();
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  installFetch(async (call) => {
    if (call.url.includes(TEAM)) { await slow; return { status: 200, body: call.url.endsWith("/status") ? CONNECTED : { history: [], approvers: [] } }; }
    return teamResponder({ status: { settings: { gpexeTeamId: "2000", configuredAt: "2026-09-21T10:00:00.000Z" }, importSwitch: {}, viewer: {} } })(call);
  });
  const first = submit("team", { teamId: TEAM });
  await submit("team", { teamId: OTHER_TEAM });
  release();
  await first;
  assert.equal(state.dataSources.teamId, OTHER_TEAM);
  assert.equal(state.dataSources.status.settings.gpexeTeamId, "2000", "the older team's answer was dropped");
});

test("16. earlier values are the ones before the value in force, newest first", async () => {
  await openTeam({
    // The database appends a row for every write, so the newest row is the
    // value shown above as "Connected" - it is not an earlier value.
    history: [
      { gpexeTeamId: "1473", configuredAt: CONNECTED.settings.configuredAt, configuredByName: "Owner", changeReason: "pilot" },
      { gpexeTeamId: "1200", configuredAt: "2026-09-19T09:00:00.000Z", configuredByName: "Owner", changeReason: "the first number was a typo" },
      { gpexeTeamId: "1100", configuredAt: "2026-09-18T09:00:00.000Z", configuredByName: "Owner", changeReason: "pilot team" },
    ],
  });
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /Earlier values \(2\)/, "the value in force is not listed as an earlier one");
  assert.ok(html.indexOf("the first number was a typo") < html.indexOf("pilot team"), "newest first");
});

test("17. a write that finishes after the admin opened another team does not lock the screen", async () => {
  await openTeam();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetch(async (call) => {
    if (call.method === "PUT") { await gate; return { status: 200, body: { settings: {} } }; }
    return teamResponder()(call);
  });
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "typo" });
  const first = act("data-sources-connect-save");
  await submit("team", { teamId: OTHER_TEAM });
  release();
  await first;
  assert.equal(state.dataSources.connectBusy, false, "the flag of a dropped answer is still cleared");

  // The screen must still work on the team that is open now.
  installFetch(teamResponder());
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1600", reason: "second team" });
  await act("data-sources-connect-save");
  assert.ok(fetchCalls.some((call) => call.method === "PUT" && call.url.includes(OTHER_TEAM)), "the next write is sent");
});

test("18. a right that was already removed says so, instead of sending the admin back to the team picker", async () => {
  await openTeam({
    approvers: [{ id: GRANT, userId: COACH, userName: "Ana Kovac", grantedAt: "2026-09-20T09:00:00.000Z", revokedAt: null, active: true }],
    writes: { [`POST ${TEAM}/approvers/${GRANT}/revoke`]: { status: 404, body: { error: "notFound" } } },
  });
  await handleDataSourcesAction({ dataset: { action: "data-sources-revoke-open", grantId: GRANT, userName: "Ana Kovac" } }, { render });
  await submit("revoke", { reason: "left the club" });
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /This right no longer exists/);
  assert.doesNotMatch(html, /not available in your workspace/, "the team is fine; only the grant is gone");
});

test("19. a coach whose account is switched off is not offered, because the database would refuse that grant", async () => {
  await openTeam();
  assert.deepEqual(teamCoachOptions().map((option) => option.label), ["Ana Kovac", "Marko Ilic"]);
});

test("20. opening the tab again reads the team again", async () => {
  await openTeam();
  assert.ok(state.dataSources.status, "loaded once");
  enterDataSourcesSection();
  assert.equal(state.dataSources.status, null, "the next paint reads the team again");
  assert.equal(state.dataSources.teamId, TEAM, "the chosen team is kept");
});

test("21. the answer to a write is shown inside the card it belongs to", async () => {
  await openTeam();
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "typo" });
  await act("data-sources-connect-save");
  const html = renderDataSourcesPanelHtml();
  const gpexeCard = html.split("<h4>Who may approve imports</h4>")[0];
  assert.match(gpexeCard, /The GPEXE team is changed/, "the connection's answer is in the GPEXE card");
  assert.equal(state.dataSources.noticeFor, "connect");
});

test("22. a team that could not be read says nothing was changed, not that a write may have happened", async () => {
  reset();
  installFetch(async () => ({ status: 500, body: { error: "internal_error" } }));
  await submit("team", { teamId: TEAM });
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /could not be loaded, so nothing is shown yet\. Nothing was changed/);
  assert.doesNotMatch(html, /can't tell whether the change was made/, "nothing was even attempted");
});

test("23. the first connection warns that there is no way back, and the switch state is on screen", async () => {
  await openTeam({ status: { settings: null, importSwitch: { enabled: false }, viewer: { isPlatformAdmin: true } } });
  assert.match(renderDataSourcesPanelHtml(), /Import writing is off in this environment/);
  await act("data-sources-connect-open");
  const form = renderDataSourcesPanelHtml();
  assert.match(form, /There is no Disconnect/);
  assert.match(form, /not checked against GPEXE here/);
  await submit("connect", { gpexeTeamId: "1473", reason: "" });
  assert.match(renderDataSourcesPanelHtml(), /there is no Disconnect: once a check has been started, its GPEXE team is final/);
});

test("24. a change that was saved is never reported as 'nothing was changed' when the read after it fails", async () => {
  await openTeam();
  let writes = 0;
  installFetch(async (call) => {
    if (call.method === "PUT") { writes += 1; return { status: 200, body: { settings: {} } }; }
    // Everything the screen reads after the write is gone.
    return { status: 503, body: { error: "unavailable" } };
  });
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "typo" });
  await act("data-sources-connect-save");
  assert.equal(writes, 1);
  const html = renderDataSourcesPanelHtml();
  assert.match(html, /The GPEXE team is changed\. That change was saved/);
  assert.match(html, /not up to date/);
  assert.doesNotMatch(html, /Nothing was changed/, "the write succeeded, so the screen must not deny it");
  assert.match(html, /data-action="data-sources-reload"/, "and the screen offers a way to read it again");
});

test("25. a team whose check has already run is not offered a change the server would refuse", async () => {
  await openTeam({
    status: {
      settings: { gpexeTeamId: "1473", configuredAt: "2026-09-20T10:00:00.000Z", configuredByName: "Owner" },
      importSwitch: { enabled: false },
      lastCheck: { id: "check-1", status: "succeeded", startedAt: "2026-09-21T08:00:00.000Z" },
      viewer: { isPlatformAdmin: true },
    },
  });
  const html = renderDataSourcesPanelHtml();
  assert.doesNotMatch(html, /data-action="data-sources-connect-open"/, "the impossible action is not offered");
  assert.match(html, /A check has already been started for this team, so its GPEXE team is final/);
});
test("26. a write still running is not unlocked by opening another card's form", async () => {
  await openTeam();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetch(async (call) => {
    if (call.method === "PUT") { await gate; return { status: 200, body: { settings: {} } }; }
    return teamResponder()(call);
  });
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1500", reason: "typo" });
  const first = act("data-sources-connect-save");

  // Opening and closing another form must not remove the guard against a
  // second write of the same thing.
  await act("data-sources-grant-open");
  assert.equal(state.dataSources.connectBusy, true, "the write is still running");
  await act("data-sources-cancel");
  await act("data-sources-connect-open");
  await submit("connect", { gpexeTeamId: "1600", reason: "again" });
  await act("data-sources-connect-save");
  assert.equal(fetchCalls.filter((call) => call.method === "PUT").length, 1, "only the first write was sent");
  release();
  await first;
});

test("27. entering the tab again after a failed read tries the team again", async () => {
  reset();
  installFetch(async () => ({ status: 500, body: { error: "internal_error" } }));
  await submit("team", { teamId: TEAM });
  assert.ok(state.dataSources.error, "the read failed");

  enterDataSourcesSection();
  assert.equal(state.dataSources.error, null, "app.js only reads again when nothing failed, so the error is cleared too");
  assert.equal(state.dataSources.status, null);

  installFetch(teamResponder());
  await loadDataSourcesTeam(render);
  assert.ok(state.dataSources.status, "and the team is readable again");
});

test("28. a grant refused with 404 does not claim the right is gone", async () => {
  await openTeam({ writes: { [`POST ${TEAM}/approvers`]: { status: 404, body: { error: "notFound" } } } });
  await act("data-sources-grant-open");
  await submit("grant", { userId: COACH, reason: "pilot" });
  await act("data-sources-grant-save");
  const html = renderDataSourcesPanelHtml();
  assert.doesNotMatch(html, /This right no longer exists/, "POST /approvers has no grant-level 404; only the team can be missing");
  assert.match(html, /not available in your workspace/);
});

test("29. a full page of history says it is only the most recent values", async () => {
  const history = [{ gpexeTeamId: "1473", configuredAt: CONNECTED.settings.configuredAt, configuredByName: "Owner", changeReason: "in force" }];
  for (let i = 1; i < 50; i += 1) {
    history.push({ gpexeTeamId: String(1000 + i), configuredAt: `2026-08-${String(i).padStart(2, "0")}T09:00:00.000Z`, configuredByName: "Owner", changeReason: `change ${i}` });
  }
  await openTeam({ history });
  // 50 rows came back (a full page), 49 of them are earlier values.
  assert.match(renderDataSourcesPanelHtml(), /Earlier values \(49 most recent\)/);
});

// The write of one team must never end the write of another. Test 17 only
// proves a dropped answer does not lock the screen; this one proves the
// opposite direction, for all three writes: a late answer for the team the
// admin has left must not unlock the team that is on screen now.
const ACTIVE_GRANT = { id: GRANT, userId: COACH, userName: "Ana Kovac", grantedAt: "2026-09-20T09:00:00.000Z", revokedAt: null, active: true };

const STALE_FLOWS = [
  {
    name: "the GPEXE connection",
    busy: "connectBusy",
    confirm: "connectConfirm",
    prepare: async () => {
      await act("data-sources-connect-open");
      await submit("connect", { gpexeTeamId: "1500", reason: "the number was wrong" });
    },
    save: () => act("data-sources-connect-save"),
  },
  {
    name: "a granted right",
    busy: "grantBusy",
    confirm: "grantConfirm",
    prepare: async (coachId) => {
      await act("data-sources-grant-open");
      await submit("grant", { userId: coachId, reason: "approves while the admin is away" });
    },
    save: () => act("data-sources-grant-save"),
  },
  {
    name: "a removed right",
    busy: "revokeBusy",
    confirm: "revokeConfirm",
    prepare: async () => {
      await handleDataSourcesAction({ dataset: { action: "data-sources-revoke-open", grantId: GRANT, userName: "Ana Kovac" } }, { render });
    },
    save: () => submit("revoke", { reason: "left the club" }),
  },
];

for (const flow of STALE_FLOWS) {
  test(`30. ${flow.name}: an answer for the team the admin left does not unlock the team on screen`, async () => {
    reset();
    let releaseA;
    let releaseB;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const gateB = new Promise((resolve) => { releaseB = resolve; });
    const reads = teamResponder({ approvers: [ACTIVE_GRANT] });
    installFetch(async (call) => {
      if (call.method === "GET") return reads(call);
      if (call.url.includes(TEAM)) { await gateA; return { status: 200, body: { ok: true } }; }
      await gateB;
      return { status: 200, body: { ok: true } };
    });
    const writes = () => fetchCalls.filter((call) => call.method !== "GET").length;

    await submit("team", { teamId: TEAM });
    await flow.prepare(COACH_2);
    const writeA = flow.save();
    assert.equal(state.dataSources[flow.busy], true, "the first team's write is running");

    // The admin moves to another team while that write is still in flight.
    await submit("team", { teamId: OTHER_TEAM });
    assert.equal(state.dataSources[flow.busy], false, "the context change releases the screen");
    await flow.prepare("99999999-0000-4000-8000-000000000007");
    const writeB = flow.save();
    assert.equal(state.dataSources[flow.busy], true, "the second team's write is running");
    const sent = writes();

    releaseA();
    await writeA;
    assert.equal(state.dataSources[flow.busy], true, "the stale answer left the running write alone");

    // And the guard it holds still refuses a second one. The confirmation
    // is deliberately still open, so the busy flag is the only thing that
    // can stop this second write.
    assert.ok(state.dataSources[flow.confirm], "the confirmation is still open");
    await flow.save();
    assert.equal(writes(), sent, "no duplicate was sent while the write was still running");

    releaseB();
    await writeB;
    assert.equal(state.dataSources[flow.busy], false, "only its own answer releases it");
  });
}
