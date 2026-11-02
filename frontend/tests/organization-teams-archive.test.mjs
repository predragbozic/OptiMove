// D44 (the owner, 2026-11-02): Settings → Organization → Teams shows the
// archived teams to whoever the server lists them to (a platform admin, a
// club's admin) with Restore, and the create form answers a name taken by an
// archived team with the message and a Restore for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

// organization-view.js reaches dom.js, which reads `document` at load time.
const created = [];
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => {
    const element = { tag, dataset: {}, type: "", className: "", textContent: "" };
    created.push(element);
    return element;
  },
};
// The form's fields, as FormData reads them.
globalThis.FormData = class {
  constructor(form) { this.values = form.values || {}; }
  entries() { return Object.entries(this.values); }
  has(key) { return key in this.values; }
};

const { renderOrganizationBrowser } = await import("../organization-view.js");
const { handleOrganizationAction, submitOrganizationForm } = await import("../organization-actions.js");
const { state } = await import("../state.js");

function resetState(section = "teams") {
  state.organization = {
    data: null, error: "", selectedClubId: "", selectedTeamId: "", section, addFormOpen: true, assignOpen: false, accessOpen: false,
    showArchivedAthletes: false, showArchivedTeamMembers: false, showArchivedClubMembers: false, showArchivedTeams: false,
    requestStatus: "all", requestAthleteId: "all", requestError: "", requestMessage: "",
  };
  state.organizationInvite = { open: false, athleteId: "", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
}

const archivedTeams = [
  { id: "team-u17", club_id: "club-1", name: "U17", club_name: "Club One", club_active: true },
  { id: "team-old", club_id: "club-2", name: "Old team", club_name: "Club Two", club_active: false },
  { id: "team-orphan", club_id: null, name: "Orphan team", club_name: null, club_active: false },
];
const baseData = (extra) => ({ isPlatformAdmin: false, canCreateTeam: true, clubs: [{ id: "club-1", name: "Club One" }], teams: [], athletes: [], users: [], ...extra });

test("the archived teams: a toggle for the club's admin, the list with Restore — none for a team of an archived club", () => {
  resetState();
  let html = renderOrganizationBrowser(baseData({ archivedTeams }));
  assert.ok(html.includes('data-action="organization-toggle-archived-teams"'));
  assert.ok(html.includes("Show archived (3)"));
  assert.ok(!html.includes('data-action="organization-restore-team"'), "the list is folded until asked");

  state.organization.showArchivedTeams = true;
  html = renderOrganizationBrowser(baseData({ archivedTeams }));
  assert.ok(html.includes("Hide archived"));
  assert.ok(html.includes('data-action="organization-restore-team" data-team-id="team-u17"'), "Restore for the club's team");
  assert.ok(!html.includes('data-team-id="team-old"'), "no Restore while its club is archived");
  assert.ok(html.includes("the club is archived"));
  assert.ok(!html.includes('data-team-id="team-orphan"'), "no Restore for a team without a club (the server refuses it)");
  assert.ok(html.includes("No club"));
});

test("a coach (the server lists no archived teams) gets neither the toggle nor the list", () => {
  resetState();
  state.organization.showArchivedTeams = true;
  const html = renderOrganizationBrowser(baseData({ canCreateTeam: false, archivedTeams: undefined }));
  assert.ok(!html.includes("organization-toggle-archived-teams"));
  assert.ok(!html.includes("organization-restore-team"));
});

function fakeForm(type, values) {
  const error = { textContent: "", appended: [], append(...parts) { this.appended.push(...parts); } };
  const button = { disabled: false };
  return {
    error,
    form: {
      values,
      dataset: { organizationForm: type, organizationEditId: "team-x" },
      querySelector: (selector) => (selector === ".builder-error" ? error : selector.startsWith("button") ? button : null),
      querySelectorAll: () => [],
      reset() {},
    },
  };
}
const noop = async () => {};

test("a name taken by an archived team: the create form shows the message and offers Restore for that team", async () => {
  resetState();
  created.length = 0;
  installFetchMock([{ status: 409, body: { error: "team_name_taken", archived: true, teamId: "team-u17", message: "An archived team with this name exists in this club — restore it instead." } }]);
  try {
    const { form, error } = fakeForm("team", { name: "U17", clubId: "club-1" });
    await submitOrganizationForm(form, { loadAthletes: noop, renderOrganizationPanel: noop });
    assert.equal(error.textContent, "An archived team with this name exists in this club — restore it instead.");
    const restore = error.appended.find((part) => typeof part === "object");
    assert.ok(restore, "a Restore button is offered");
    assert.deepEqual([restore.dataset.action, restore.dataset.teamId, restore.textContent], ["organization-restore-team", "team-u17", "Restore"]);
  } finally {
    restoreFetch();
  }
});

test("a name taken by an active team, or a rename onto an archived team's name: the message only", async () => {
  resetState();
  for (const [type, body] of [
    ["team", { error: "team_name_taken", archived: false, message: "A team with this name already exists in this club." }],
    ["edit-team", { error: "team_name_taken", archived: true, teamId: "team-u17", message: "An archived team with this name exists in this club — restore it instead." }],
  ]) {
    installFetchMock([{ status: 409, body }]);
    try {
      const { form, error } = fakeForm(type, { name: "U17", clubId: "club-1" });
      await submitOrganizationForm(form, { loadAthletes: noop, renderOrganizationPanel: noop });
      assert.equal(error.textContent, body.message, type);
      assert.equal(error.appended.length, 0, `${type}: no Restore`);
    } finally {
      restoreFetch();
    }
  }
});

test("Restore from the create form's message closes the form before the panel is drawn again", async () => {
  resetState();
  state.activeTab = "organization";
  installFetchMock([{ status: 200, body: { team: { id: "team-u17" }, restored: true } }]);
  try {
    const seen = [];
    const action = { dataset: { action: "organization-restore-team", teamId: "team-u17" }, disabled: false };
    await handleOrganizationAction(action, {
      loadAthletes: noop,
      renderOrganizationPanel: async () => { seen.push(state.organization.addFormOpen); },
    });
    assert.deepEqual(seen, [false], "the one repaint shows the form closed");
    assert.equal(action.disabled, false);
  } finally {
    restoreFetch();
  }
});
