// Settings -> Calendar (K2b-1c, docs/ai/central-calendar-k2b-plan.md sections 8
// and 20): the club admin's screen over the K2b-1a API, through the real
// handlers and templates with a fake fetch (tests/support/fetch-mock.mjs) and
// JSDOM for the markup. The fake keeps the routes' contracts
// (backend/src/routes/calendarSettings.js, calendarSettingsService.js): the
// answers' shapes, a stale expectedRevision as <subject>_changed with
// `current`, a requestKey's replay of the saved answer and request_key_reused
// for another body. Proved here: who is offered the tab (T6), what each write
// sends, one write at a time, a lost answer checked with the same request and
// never resent with a new key, the refusals' sentences, the owner's decisions
// P1-P4, and the team colours (P2: with no choice, exactly today's colours).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

let confirmAnswer = true;
const questions = [];
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: (question) => { questions.push(question); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

const { emptyCalendarSettingsState, emptyCentralCalendarState, state } = await import("../state.js");
const colors = await import("../calendar-colors.js");
const data = await import("../calendar-settings-data.js");
const actions = await import("../calendar-settings-actions.js");
const { CALENDAR_SETTINGS_DETAILS_SENTENCE, CALENDAR_SETTINGS_REQUIRED_SENTENCE, renderCalendarSettingsPanelHtml } = await import("../calendar-settings-view.js");
const { calendarSettingsMapsUrl } = data;
const { renderSettingsNavHtml } = await import("../navigation.js");
const { renderOrganizationPanelHtml } = await import("../organization-view.js");
const calendarView = await import("../central-calendar-view.js");
const backendColors = await import("../../backend/src/calendarColors.js");

const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const OTHER_CLUB = "c2c2c2c2-0000-4000-8000-000000000002";
const T1 = "71000000-0000-4000-8000-000000000001";
const T2 = "71000000-0000-4000-8000-000000000002";
const T3 = "71000000-0000-4000-8000-000000000003";
const F1 = "f1000000-0000-4000-8000-000000000001";
const F2 = "f1000000-0000-4000-8000-000000000002";
const F3 = "f1000000-0000-4000-8000-000000000003";
const F4 = "f1000000-0000-4000-8000-000000000004";
const O1 = "0a000000-0000-4000-8000-000000000001";
const O2 = "0a000000-0000-4000-8000-000000000002";
const O3 = "0a000000-0000-4000-8000-000000000003";
const L1 = "1c000000-0000-4000-8000-000000000001";
const L2 = "1c000000-0000-4000-8000-000000000002";
const TM1 = "7e000000-0000-4000-8000-000000000001";
const TM2 = "7e000000-0000-4000-8000-000000000002";
const TM3 = "7e000000-0000-4000-8000-000000000003";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE = "/api/calendar/settings";

function catalog() {
  return {
    clubId: CLUB,
    types: [
      { id: T1, key: "training", kind: "training", label: "Training", iconKey: "run", colorKey: null, defaultExpects: ["rpe"], fieldIds: [F1], sortOrder: 10, seeded: true, archived: false, archivedAt: null, revision: 1, eventCount: 3, canEdit: true },
      { id: T2, key: "match", kind: "match", label: "Match", iconKey: "trophy", colorKey: "rust", defaultExpects: ["rpe", "device_data"], fieldIds: [F2, F3, F4], sortOrder: 20, seeded: true, archived: false, archivedAt: null, revision: 4, eventCount: 0, canEdit: true },
      { id: T3, key: "old", kind: "meeting", label: "Old type", iconKey: null, colorKey: null, defaultExpects: [], fieldIds: [], sortOrder: 30, seeded: false, archived: true, archivedAt: "2026-11-01T10:00:00.000Z", revision: 2, eventCount: 1, canEdit: true },
    ],
    fields: [
      { id: F1, key: "weather", label: "Weather", description: null, filledBy: "coach", valueKind: "choice", unit: null, minValue: null, maxValue: null, required: false, sortOrder: 10, seeded: true, archived: false, revision: 1, answered: false, eventCount: 2,
        options: [{ id: O1, label: "Sunny", sortOrder: 10, archived: false }, { id: O2, label: "Rain", sortOrder: 20, archived: false }, { id: O3, label: "Snow", sortOrder: 30, archived: true }], canEdit: true },
      { id: F2, key: "opponent", label: "Opponent", description: "Who we played", filledBy: "coach", valueKind: "short_text", unit: null, minValue: null, maxValue: null, required: false, sortOrder: 20, seeded: true, archived: false, revision: 1, answered: false, eventCount: 0, options: [], canEdit: true },
      { id: F3, key: "our_score", label: "Our score", description: null, filledBy: "coach", valueKind: "number", unit: null, minValue: 0, maxValue: 999, required: true, sortOrder: 30, seeded: true, archived: false, revision: 3, answered: true, eventCount: 5, options: [], canEdit: true },
      { id: F4, key: "old_detail", label: "Old detail", description: null, filledBy: "coach", valueKind: "yes_no", unit: null, minValue: null, maxValue: null, required: false, sortOrder: 40, seeded: false, archived: true, revision: 2, answered: false, eventCount: 0, options: [], canEdit: true },
    ],
    locations: [
      { id: L1, name: "Main stadium", address: "Ulica 1, Novi Sad", note: "Gate B\nParking on the left", archived: false, revision: 1, eventCount: 2, defaultOfTeamIds: [TM1], canEdit: true },
      { id: L2, name: "Old hall", address: null, note: null, archived: true, revision: 2, eventCount: 0, defaultOfTeamIds: [], canEdit: true },
    ],
    teams: [
      { teamId: TM1, name: "First team", colorKey: null, defaultLocationId: L1, revision: 1 },
      { teamId: TM2, name: "U17", colorKey: "teal", defaultLocationId: null, revision: 2 },
      { teamId: TM3, name: "U19", colorKey: null, defaultLocationId: null, revision: 0 },
    ],
  };
}

// The fake K2b-1a API. `faults` answer a matching call instead of the server
// (`{ match, result }`), or let the server apply it and lose the answer
// (`{ match, lose: true }`). Every write is recorded under its requestKey and
// replayed for the same body, as the command runner does.
let db;
let saved;
let faults;
let calls;
let nextId;
const newId = () => `9e000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const find = (list, id, key = "id") => list.find((row) => row[key] === id);
const conflict = (code, current, extra = {}) => ({ status: 409, body: { error: code, message: code, current: clone(current), ...extra } });

function applyWrite(call) {
  const [, , , , collection, id, tail] = call.url.split("/");
  const b = call.body || {};
  const stale = (row, kind) => (b.expectedRevision !== row.revision ? conflict(`${kind}_changed`, row) : null);
  if (collection === "types" && call.method === "POST" && !id) {
    if (db.types.some((t) => !t.archived && t.label.toLowerCase() === b.label.toLowerCase())) return { status: 409, body: { error: "label_taken", message: "taken" } };
    const row = { id: newId(), key: "k", kind: b.kind, label: b.label, iconKey: b.iconKey, colorKey: b.colorKey, defaultExpects: b.defaultExpects, fieldIds: b.fieldIds, sortOrder: 40, seeded: false, archived: false, archivedAt: null, revision: 1, eventCount: 0, canEdit: true };
    db.types.push(row);
    return { status: 201, body: { type: clone(row) } };
  }
  if (collection === "types" && id === "order") {
    db.types.filter((t) => !t.archived).forEach((t) => { t.sortOrder = (b.typeIds.indexOf(t.id) + 1) * 10; t.revision += 1; });
    db.types.sort((x, y) => Number(x.archived) - Number(y.archived) || x.sortOrder - y.sortOrder);
    return { status: 200, body: { types: clone(db.types) } };
  }
  const lists = { types: ["types", "type"], fields: ["fields", "field"], locations: ["locations", "location"] };
  if (lists[collection]) {
    const [list, kind] = lists[collection];
    if (call.method === "POST" && !id) {
      const row = collection === "fields"
        ? { id: newId(), key: "k", label: b.label, description: b.description ?? null, filledBy: "coach", valueKind: b.valueKind, unit: b.unit ?? null, minValue: b.minValue ?? null, maxValue: b.maxValue ?? null, required: b.required, sortOrder: 50, seeded: false, archived: false, revision: 1, answered: false, eventCount: 0, options: (b.options || []).map((label, i) => ({ id: newId(), label, sortOrder: (i + 1) * 10, archived: false })), canEdit: true }
        : { id: newId(), name: b.name, address: b.address ?? null, note: b.note ?? null, archived: false, revision: 1, eventCount: 0, defaultOfTeamIds: [], canEdit: true };
      db[list].push(row);
      return { status: 201, body: { [kind]: clone(row) } };
    }
    const row = find(db[list], id);
    if (!row) return { status: 404, body: { error: "notFound", message: "Not found." } };
    const s = stale(row, kind);
    if (s) return s;
    if (tail === "archive" || tail === "restore") {
      row.archived = tail === "archive";
      row.revision += 1;
      return { status: 200, body: { [kind]: clone(row) } };
    }
    if (kind === "field" && row.answered && ("label" in b || "unit" in b || "minValue" in b || "maxValue" in b)) {
      return conflict("field_answered", row, { frozen: ["label"] });
    }
    for (const [key, value] of Object.entries(b)) if (!["requestKey", "expectedRevision", "options"].includes(key)) row[key] = value;
    if (b.options) {
      for (const label of b.options.add || []) row.options.push({ id: newId(), label, sortOrder: 99, archived: false });
      for (const r of b.options.rename || []) find(row.options, r.id).label = r.label;
      for (const oid of b.options.hide || []) find(row.options, oid).archived = true;
      for (const oid of b.options.show || []) find(row.options, oid).archived = false;
    }
    row.revision += 1;
    return { status: 200, body: { [kind]: clone(row) } };
  }
  if (collection === "teams") {
    const row = find(db.teams, id, "teamId");
    if (b.expectedRevision !== row.revision) return conflict("team_changed", row);
    if ("colorKey" in b) row.colorKey = b.colorKey;
    if ("defaultLocationId" in b) row.defaultLocationId = b.defaultLocationId;
    row.revision += 1;
    return { status: 200, body: { team: clone(row) } };
  }
  return { status: 400, body: { error: "invalid_body", message: "?" } };
}

function server(call) {
  const at = faults.findIndex((fault) => fault.match(call));
  const fault = at >= 0 ? faults.splice(at, 1)[0] : null;
  if (fault && !fault.lose) return fault.result;
  if (call.method === "GET" && call.url === BASE) return { status: 200, body: clone(db) };
  const key = call.body?.requestKey;
  const signature = `${call.method} ${call.url} ${JSON.stringify({ ...call.body, requestKey: undefined })}`;
  let answer;
  if (key && saved.has(key)) {
    const prior = saved.get(key);
    answer = prior.signature === signature ? { status: prior.status, body: { ...clone(prior.body), replayed: true } } : { status: 409, body: { error: "request_key_reused", message: "?" } };
  } else {
    answer = applyWrite(call);
    if (key && answer.status < 300) saved.set(key, { signature, ...clone(answer) });
  }
  return fault?.lose ? { throwNetworkError: true } : answer;
}

const writes = () => calls.filter((c) => c.method !== "GET");
const reads = () => calls.filter((c) => c.method === "GET");
let renders = 0;
const render = () => { renders += 1; };
const doc = () => new JSDOM(`<body>${renderCalendarSettingsPanelHtml()}</body>`).window.document;
const d = () => state.calendarSettings;

// A click on the real button of the rendered screen (its data attributes are
// the ones the handler reads).
async function click(selector, page = doc()) {
  const el = page.querySelector(selector);
  assert.ok(el, `no element for ${selector}`);
  assert.equal(el.disabled, false, `${selector} is disabled`);
  await actions.handleCalendarSettingsAction(el, { render });
  return el;
}
function type(page, selector, value) {
  const el = page.querySelector(selector);
  assert.ok(el, `no field ${selector}`);
  el.value = value;
  actions.handleCalendarSettingsInput(el, { render });
  return el;
}
function choose(page, selector) {
  const el = page.querySelector(selector);
  assert.ok(el, `no choice ${selector}`);
  if (el.type === "radio" || el.type === "checkbox") el.checked = !(el.type === "checkbox" && el.checked);
  actions.handleCalendarSettingsInput(el, { render });
  return el;
}
async function submit(page) {
  await actions.submitCalendarSettingsForm(page.querySelector("[data-calendar-settings-form]"), { render });
}

function asClubAdmin(clubs = [{ id: CLUB, name: "FK Borac", role: "club_admin" }]) {
  state.currentUser = { id: "u1", name: "Admin", activeWorkspace: { type: "club", scopeId: CLUB }, clubs };
}

beforeEach(async () => {
  db = catalog();
  saved = new Map();
  faults = [];
  nextId = 0;
  renders = 0;
  confirmAnswer = true;
  questions.length = 0;
  data.resetCalendarSettingsForWorkspaceChange();
  state.iconPicker = null;
  asClubAdmin();
  state.organization.data = { isPlatformAdmin: false, clubs: [{ id: CLUB, name: "FK Borac" }], manageableClubIds: [CLUB], teams: [], users: [], athletes: [] };
  state.organization.section = "calendar";
  calls = installFetchMock(server);
});

async function loaded() {
  await data.loadCalendarSettings(render);
  calls.length = 0;
}

// ---------------------------------------------------------------------------
// Who is offered the tab (T6 and the manager's visibility rule)
// ---------------------------------------------------------------------------
test("1. the Calendar tab: a club workspace with that club's club_admin role only - never through manageableClubIds", () => {
  const offered = () => /data-section="calendar"/.test(renderSettingsNavHtml(state.organization.data, "overview"));
  assert.equal(offered(), true, "the club's admin in its workspace");
  state.currentUser = { activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [] };
  state.organization.data = { ...state.organization.data, isPlatformAdmin: true, manageableClubIds: [CLUB, OTHER_CLUB] };
  assert.equal(offered(), false, "a platform admin without the club's role (manageableClubIds names every club)");
  state.currentUser = { activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, role: "club_admin" }] };
  assert.equal(offered(), true, "a platform admin who also holds the club's role (T6)");
  state.currentUser = { activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: OTHER_CLUB, role: "club_admin" }] };
  assert.equal(offered(), false, "the admin of another club");
  state.currentUser = { activeWorkspace: { type: "platform", scopeId: null }, clubs: [{ id: CLUB, role: "club_admin" }] };
  assert.equal(offered(), false, "the platform workspace");
  state.currentUser = { activeWorkspace: { type: "team", scopeId: TM1 }, clubs: [], teams: [{ id: TM1, role: "team_coach" }] };
  assert.equal(offered(), false, "a team coach");
  state.currentUser = { activeWorkspace: { type: "athlete", scopeId: "a1" }, clubs: [] };
  assert.equal(offered(), false, "an athlete");
  // A section the account can no longer see falls back to the overview.
  state.organization.section = "calendar";
  renderOrganizationPanelHtml({ currentUser: state.currentUser, data: { ...state.organization.data, clubs: [], teams: [], athletes: [], users: [] }, error: "", role: "", scope: "" });
  assert.equal(state.organization.section, "overview");
});

test("2. the read: one GET, four sections with their live counts, the types in order, archived ones folded away; a refused read says it neutrally", async () => {
  await data.loadCalendarSettings(render);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}`]);
  const page = doc();
  const tabs = [...page.querySelectorAll("[data-calendar-settings-section]")];
  assert.deepEqual(tabs.map((t) => t.firstChild.textContent), ["Event types", "Details", "Places", "Teams"]);
  assert.deepEqual(tabs.map((t) => t.querySelector(".cs-tab-count").textContent), ["2", "3", "1", "3"]);
  assert.equal(page.querySelector(".cs-tab.is-active").dataset.calendarSettingsSection, "types");
  assert.deepEqual([...page.querySelectorAll(".cs-list:not(.cs-list-archived) .cs-row-title")].map((n) => n.textContent), ["Training", "Match"]);
  assert.match(page.querySelector(".cs-row-meta").textContent, /Base kind: Training · Collects athletes' RPE · 1 detail · Used by 3 events/);
  assert.equal(page.querySelector(".cs-list-archived"), null, "archived types are folded away");
  assert.match(page.querySelector('[data-action="calendar-settings-toggle-archived"]').textContent, /Show archived types \(1\)/);
  assert.equal(page.querySelector("[data-tab]"), null, "no element carries data-tab (app.js turns it into a menu switch)");

  data.resetCalendarSettingsForWorkspaceChange();
  faults.push({ match: (c) => c.method === "GET", result: { status: 404, body: { error: "notFound" } } });
  await data.loadCalendarSettings(render);
  assert.match(doc().querySelector(".data-sources-error").textContent, /Calendar settings are not available in this workspace\./);
  assert.ok(doc().querySelector('[data-action="calendar-settings-retry"]'));
});

test("3. a slower older read never replaces a newer one; a workspace switch drops the slice", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let first = true;
  calls = installFetchMock(async (call) => {
    if (first) { first = false; await slow; return { status: 200, body: { ...catalog(), types: [] } }; }
    return server(call);
  });
  const older = data.loadCalendarSettings(render);
  await data.loadCalendarSettings(render);
  release();
  await older;
  assert.equal(d().data.types.length, 3, "the newer answer stays");
  data.resetCalendarSettingsForWorkspaceChange();
  assert.deepEqual(state.calendarSettings, emptyCalendarSettingsState());
});

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
test("4. Add a type: name, base kind, icon through the shared picker, colour, what it collects and its details - one POST with a fresh key; a double submit sends one", async () => {
  await loaded();
  await click('[data-action="calendar-settings-new"][data-kind="type"]');
  let page = doc();
  assert.ok(page.querySelector("[data-calendar-settings-form='type'] [data-cs-first]"), "the name field comes first");
  assert.equal(page.querySelector('[data-action="calendar-settings-new"][data-kind="type"]').disabled, true, "Add a type is off while its form is open");
  type(page, "#cs-type-label", "  Recovery   session ");
  type(page, "#cs-type-kind", "training");
  page = doc();
  // The icon: the picker opens over the form (the form is inert), a choice is used.
  await click('[data-action="calendar-settings-type-icon"]', page);
  page = doc();
  assert.ok(page.querySelector("[data-icon-picker]"), "the shared icon picker is open");
  assert.ok(page.querySelector("[data-calendar-settings-form]").hasAttribute("inert"));
  await actions.handleCalendarSettingsAction(fakeAction({ action: "icon-picker-choose", iconKey: "yoga" }), { render });
  await actions.handleCalendarSettingsAction(fakeAction({ action: "icon-picker-use" }), { render });
  assert.equal(state.iconPicker, null);
  page = doc();
  choose(page, "#cs-type-color-plum");
  choose(page, '[data-cs-expect="device_data"]');
  type(page, "#cs-type-add-field", F2);
  await click('[data-action="calendar-settings-type-field-add"]', page);
  page = doc();
  assert.equal(page.querySelector("#cs-type-add-field option[value='" + F4 + "']"), null, "an archived detail is never offered as a new entry");
  const sending = submit(page);
  const twice = submit(page);
  await Promise.all([sending, twice]);
  assert.equal(writes().length, 1, "one request");
  const sent = writes()[0];
  assert.equal(`${sent.method} ${sent.url}`, `POST ${BASE}/types`);
  assert.match(sent.body.requestKey, UUID);
  assert.deepEqual({ ...sent.body, requestKey: undefined }, {
    requestKey: undefined, label: "Recovery session", kind: "training", iconKey: "yoga", colorKey: "plum", defaultExpects: ["device_data"], fieldIds: [F2],
  });
  assert.equal(d().form, null, "the form closes");
  assert.equal(d().notice, "“Recovery session” was added.");
  assert.equal(reads().length, 1, "the catalog is read again after the write");
});

test("5. Edit a type: only what changed, with expectedRevision; nothing changed sends nothing; the base kind is fixed; its details keep an archived one, move and go", async () => {
  await loaded();
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T2}"]`);
  let page = doc();
  assert.equal(page.querySelector("#cs-type-kind"), null, "no base kind control on an edit");
  assert.match(page.querySelector("[data-calendar-settings-form] .cs-fact").textContent, /Base kind Match \(fixed\)/);
  await submit(page);
  assert.equal(writes().length, 0);
  assert.equal(d().form.error, "Nothing changed: change something, or Cancel.");
  // The list: Opponent, Our score, Old detail (archived, kept).
  assert.match(page.querySelector(".cs-mini-list").textContent, /Old detail \(archived\)/);
  await click(`[data-action="calendar-settings-type-field-move"][data-id="${F3}"][data-direction="up"]`, page);
  await click(`[data-action="calendar-settings-type-field-remove"][data-id="${F2}"]`);
  page = doc();
  type(page, "#cs-type-label", "League match");
  await submit(page);
  const sent = writes()[0];
  assert.equal(`${sent.method} ${sent.url}`, `PATCH ${BASE}/types/${T2}`);
  assert.deepEqual({ ...sent.body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 4, label: "League match", fieldIds: [F3, F4] });
  assert.equal(d().notice, "Changes to “League match” were saved.");
});

test("6. Move a type: the whole live order in one request; the first one cannot move up; the last live type has no Archive", async () => {
  await loaded();
  const page = doc();
  assert.equal(page.querySelector(`[data-action="calendar-settings-type-move"][data-id="${T1}"][data-direction="up"]`).disabled, true);
  await click(`[data-action="calendar-settings-type-move"][data-id="${T2}"][data-direction="up"]`, page);
  assert.equal(`${writes()[0].method} ${writes()[0].url}`, `POST ${BASE}/types/order`);
  assert.deepEqual(writes()[0].body.typeIds, [T2, T1]);
  assert.equal(d().notice, "“Match” was moved up.");
  // One live type left: no Archive, and the sentence says why.
  db.types = db.types.filter((t) => t.id !== T2);
  await data.loadCalendarSettings(render);
  const one = doc();
  assert.equal(one.querySelector('[data-action="calendar-settings-archive"][data-kind="type"]'), null);
  assert.match(one.querySelector(".cs-hint").textContent, /keeps at least one event type/);
});

test("7. Archive and Restore: the subject's revision, no form; a taken name on Restore says what to do", async () => {
  await loaded();
  await click(`[data-action="calendar-settings-archive"][data-kind="type"][data-id="${T2}"]`);
  assert.equal(`${writes()[0].method} ${writes()[0].url}`, `POST ${BASE}/types/${T2}/archive`);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 4 });
  assert.match(d().notice, /^“Match” was archived\. Coaches can no longer choose it for a new event; the events that have it keep it\.$/);
  calls.length = 0;
  await click('[data-action="calendar-settings-toggle-archived"][data-list="types"]');
  faults.push({ match: (c) => c.url.endsWith("/restore"), result: { status: 409, body: { error: "label_taken", message: "taken" } } });
  await click(`[data-action="calendar-settings-restore"][data-kind="type"][data-id="${T3}"]`);
  assert.equal(d().noticeTone, "error");
  assert.equal(d().notice, "Nothing was saved: an active (not archived) type already has this name. Rename that one first, then restore this one.");
});

// ---------------------------------------------------------------------------
// One write at a time; a lost answer
// ---------------------------------------------------------------------------
test("8. a lost answer: Result not confirmed, every other write off; Check result sends the SAME key and body and settles with the replay", async () => {
  await loaded();
  faults.push({ match: (c) => c.url.endsWith("/archive"), lose: true });
  await click(`[data-action="calendar-settings-archive"][data-kind="type"][data-id="${T2}"]`);
  let page = doc();
  assert.match(page.querySelector(".cs-unconfirmed").textContent, /Result not confirmed\. Archiving “Match”: the answer was lost, so it is not known whether it was saved/);
  assert.equal(page.querySelector('[data-action="calendar-settings-new"][data-kind="type"]').disabled, true, "no new write while unconfirmed");
  assert.equal(page.querySelector(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`).disabled, true);
  // A click on a disabled control's action does nothing either: no write, no form.
  await actions.handleCalendarSettingsAction(fakeAction({ action: "calendar-settings-archive", kind: "type", id: T1 }), { render });
  assert.equal(writes().length, 1);
  await actions.handleCalendarSettingsAction(fakeAction({ action: "calendar-settings-new", kind: "type" }), { render });
  await actions.handleCalendarSettingsAction(fakeAction({ action: "calendar-settings-edit", kind: "field", id: F1 }), { render });
  assert.equal(d().form, null, "no form opens while a write is not confirmed");
  const first = writes()[0];
  await click('[data-action="calendar-settings-check-result"]', page);
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].body.requestKey, first.body.requestKey, "the same key");
  assert.deepEqual(writes()[1].body, first.body, "the same body");
  assert.equal(d().command, null);
  assert.equal(d().notice.startsWith("Checked: “Match” was archived."), true);
  page = doc();
  assert.equal(page.querySelector(".cs-unconfirmed"), null);
});

test("9. Check result answered before the record (busy, 5xx, another key's body) keeps it unconfirmed; a refusal after the record settles it", async () => {
  await loaded();
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  let page = doc();
  type(page, "#cs-type-label", "Team training");
  faults.push({ match: (c) => c.method === "PATCH", result: { status: 503, body: { error: "outcome_unknown", message: "?" } } });
  await submit(page);
  page = doc();
  assert.ok(page.querySelector("[data-calendar-settings-form] .cs-unconfirmed"), "inside the form");
  assert.equal(page.querySelector("[data-calendar-settings-form] .cs-form-body").disabled, true, "the form is locked");
  assert.equal(page.querySelector('[data-calendar-settings-form] button[type="submit"]'), null, "no Save while unconfirmed");
  faults.push({ match: (c) => c.method === "PATCH", result: { status: 409, body: { error: "try_again", message: "busy" } } });
  await click('[data-action="calendar-settings-check-result"]', page);
  assert.equal(d().command.unconfirmed, true);
  assert.match(d().command.checkNote, /the server was busy/);
  faults.push({ match: (c) => c.method === "PATCH", result: { status: 502, body: {} } });
  await click('[data-action="calendar-settings-check-result"]');
  assert.equal(d().command.checkNote, "No answer again. The result is still not confirmed.");
  faults.push({ match: (c) => c.method === "PATCH", result: { status: 409, body: { error: "request_key_reused", message: "?" } } });
  await click('[data-action="calendar-settings-check-result"]');
  assert.equal(d().command.unconfirmed, true, "a key used for another request is no answer about this one");
  faults.push({ match: (c) => c.method === "PATCH", result: conflict("type_changed", { ...db.types[0], label: "Renamed elsewhere", revision: 2 }) });
  await click('[data-action="calendar-settings-check-result"]');
  assert.equal(d().command, null, "a refusal after the record settles the first write");
  assert.equal(d().form, null);
  assert.equal(d().notice, "Checked: Nothing was saved: this type was changed meanwhile. It is shown as it is now; make your change again.");
  const keys = new Set(writes().map((c) => c.body.requestKey));
  assert.equal(keys.size, 1, "every check used the one key");
});

test("10. Close without checking asks, then reads the catalog again; leaving asks while a write is open", async () => {
  await loaded();
  faults.push({ match: (c) => c.url.endsWith("/order"), lose: true });
  await click(`[data-action="calendar-settings-type-move"][data-id="${T1}"][data-direction="down"]`);
  assert.equal(actions.calendarSettingsMayBeLeft({ final: "switch" }), true, "the switch asked, the answer was yes");
  assert.match(questions.at(-1), /The last calendar setting's save is not confirmed\. Switch without checking\?/);
  confirmAnswer = false;
  assert.equal(actions.calendarSettingsMayBeLeft({ final: "sign-out" }), false);
  const event = { isTrusted: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(actions.handleCalendarSettingsBeforeUnload(event), true);
  assert.equal(event.defaultPrevented, true);
  await click('[data-action="calendar-settings-drop-unconfirmed"]');
  assert.ok(d().command, "declined: nothing changes");
  confirmAnswer = true;
  calls.length = 0;
  await click('[data-action="calendar-settings-drop-unconfirmed"]');
  assert.equal(d().command, null);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "only a read");
  assert.match(d().notice, /^Not checked\./);
});

test("11. a stated refusal keeps the form and its values: a taken name, a busy server, a sign-out", async () => {
  await loaded();
  await click('[data-action="calendar-settings-new"][data-kind="type"]');
  let page = doc();
  type(page, "#cs-type-label", "match");
  type(page, "#cs-type-kind", "match");
  await submit(page);
  page = doc();
  assert.equal(page.querySelector("#cs-type-label").getAttribute("aria-invalid"), "true");
  assert.equal(page.querySelector("#cs-type-label-error").textContent, "Another event type already has this name.");
  assert.equal(page.querySelector("#cs-type-label").value, "match", "the value stays");
  assert.equal(page.querySelector(".cs-form-error").textContent, "Check the marked fields. Nothing was saved.");
  faults.push({ match: (c) => c.method === "POST", result: { status: 409, body: { error: "try_again", message: "busy" } } });
  type(page, "#cs-type-label", "Friendly");
  await submit(page);
  assert.equal(d().form.error, "The calendar settings are busy. Nothing was saved; try again in a moment.");
  faults.push({ match: (c) => c.method === "POST", result: { status: 401, body: { error: "unauthenticated" } } });
  await submit(doc());
  assert.equal(d().form.error, "Please sign in again. Nothing was saved.");
  const keys = writes().map((c) => c.body.requestKey);
  assert.equal(new Set(keys).size, 3, "a refused request's key is never reused: each Save is a new request");
});

// ---------------------------------------------------------------------------
// Details (P1, P3, the frozen meaning)
// ---------------------------------------------------------------------------
test("12. Details: the owner's sentence; the Required switch (K2b-1d, 21.5) is off by default with D25's sentence, and a new detail sends required: false", async () => {
  await loaded();
  await click('[data-action="calendar-settings-section"][data-calendar-settings-section="details"]');
  let page = doc();
  assert.equal(CALENDAR_SETTINGS_DETAILS_SENTENCE, "Details are filled in by the event's coach. Questions for athletes will be asked through Tests.");
  assert.ok(page.querySelector(".cs-filled-by").textContent.includes(CALENDAR_SETTINGS_DETAILS_SENTENCE));
  assert.doesNotMatch(page.body.textContent, /after the event|RPE request/i, "P3: neither 'after the event' nor RPE");
  const rows = [...page.querySelectorAll(".cs-list:not(.cs-list-archived) > .cs-row")];
  assert.match(rows[0].textContent, /Choice: Sunny, Rain/);
  assert.doesNotMatch(rows[0].textContent, /Snow/, "a hidden option is not offered");
  assert.match(rows[2].textContent, /Number, 0 to 999.*Required · Has answers · Used by 5 events/s);
  await click('[data-action="calendar-settings-new"][data-kind="field"]', page);
  page = doc();
  const required = page.querySelector('[data-calendar-settings-form] #cs-field-required[type="checkbox"]');
  assert.ok(required, "the Required switch (P1 turned on in K2b-1d)");
  assert.equal(required.checked, false, "off by default");
  assert.equal(CALENDAR_SETTINGS_REQUIRED_SENTENCE, "Optional details only remind the coach; a required one makes the event wait until it is filled.");
  assert.equal(page.querySelector(`#${required.getAttribute("aria-describedby")}`).textContent, CALENDAR_SETTINGS_REQUIRED_SENTENCE);
  assert.match(page.querySelector("[data-calendar-settings-form]").textContent, /Filled by coach/);
  type(page, "#cs-field-label", "Pitch");
  type(page, "#cs-field-valueKind", "choice");
  page = doc();
  const options = [...page.querySelectorAll("[data-cs-option]")];
  assert.equal(options.length, 2, "a choice starts with two options");
  type(page, `[data-cs-option="${options[0].dataset.csOption}"]`, "Grass");
  type(page, `[data-cs-option="${options[1].dataset.csOption}"]`, "grass");
  await submit(page);
  assert.equal(writes().length, 0);
  assert.equal(d().form.errors.optionLabels[options[1].dataset.csOption], "Two options have this name.");
  type(page, `[data-cs-option="${options[1].dataset.csOption}"]`, "Turf");
  await click('[data-action="calendar-settings-option-add"]', page);
  page = doc();
  const third = [...page.querySelectorAll("[data-cs-option]")][2];
  type(page, `[data-cs-option="${third.dataset.csOption}"]`, "Indoor");
  await submit(page);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, label: "Pitch", valueKind: "choice", required: false, options: ["Grass", "Turf", "Indoor"] });
});

test("13. a number detail: unit and limits as numbers, a comma read as a decimal point, the highest never below the lowest", async () => {
  await loaded();
  d().section = "details";
  await click('[data-action="calendar-settings-new"][data-kind="field"]');
  let page = doc();
  type(page, "#cs-field-label", "Temperature");
  type(page, "#cs-field-valueKind", "number");
  page = doc();
  type(page, "#cs-field-unit", "°C");
  choose(page, "#cs-field-required");
  type(page, "#cs-field-minValue", "10");
  type(page, "#cs-field-maxValue", "-40,5");
  await submit(page);
  assert.equal(writes().length, 0);
  assert.equal(d().form.errors.maxValue, "The highest value cannot be below the lowest.");
  type(page, "#cs-field-minValue", "-40,5");
  type(page, "#cs-field-maxValue", "50");
  await submit(page);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, label: "Temperature", valueKind: "number", required: true, unit: "°C", minValue: -40.5, maxValue: 50 }, "the switch on: required: true");
});

test("14. editing a choice: rename, add, hide and show in one request; a detail with answers keeps its meaning (read only) but takes new and hidden options", async () => {
  await loaded();
  d().section = "details";
  await click(`[data-action="calendar-settings-edit"][data-kind="field"][data-id="${F1}"]`);
  let page = doc();
  type(page, `[data-cs-option="o-${O1}"]`, "Sun");
  await click(`[data-action="calendar-settings-option-show"][data-option-key="o-${O3}"]`, page);
  page = doc();
  await click(`[data-action="calendar-settings-option-hide"][data-option-key="o-${O2}"]`, page);
  await click('[data-action="calendar-settings-option-add"]');
  page = doc();
  const added = [...page.querySelectorAll("[data-cs-option]")].at(-1);
  type(page, `[data-cs-option="${added.dataset.csOption}"]`, "Fog");
  await submit(page);
  assert.deepEqual(writes()[0].body.options, { add: ["Fog"], rename: [{ id: O1, label: "Sun" }], hide: [O2], show: [O3] });
  assert.equal(writes()[0].body.expectedRevision, 1);
  assert.equal("required" in writes()[0].body, false, "an untouched switch is not sent");

  // Our score has answers: name and limits read only.
  calls.length = 0;
  await click(`[data-action="calendar-settings-edit"][data-kind="field"][data-id="${F3}"]`);
  page = doc();
  assert.match(page.querySelector(".cs-frozen").textContent, /already has answers: its meaning can't change/);
  for (const id of ["#cs-field-label", "#cs-field-minValue", "#cs-field-maxValue", "#cs-field-unit"]) assert.ok(page.querySelector(id).hasAttribute("readonly"), id);
  type(page, "#cs-field-label", "Goals");
  assert.equal(d().form.draft.label, "Our score", "a frozen part does not change");
  type(page, "#cs-field-description", "Goals we scored");
  // Required changes on an answered detail too (2.3): it is not its meaning.
  assert.equal(page.querySelector("#cs-field-required").checked, true);
  assert.equal(page.querySelector("#cs-field-required").disabled, false);
  choose(page, "#cs-field-required");
  await submit(page);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 3, description: "Goals we scored", required: false });
});

test("15. field_answered: a detail answered meanwhile - its frozen parts go back to the saved values, the rest stays, the sentence says why", async () => {
  await loaded();
  d().section = "details";
  await click(`[data-action="calendar-settings-edit"][data-kind="field"][data-id="${F2}"]`);
  let page = doc();
  type(page, "#cs-field-label", "Rival");
  type(page, "#cs-field-description", "Club we played");
  faults.push({ match: (c) => c.method === "PATCH", result: conflict("field_answered", { ...db.fields[1], answered: true, revision: 2 }, { frozen: ["label"] }) });
  await submit(page);
  assert.equal(d().form.answered, true);
  assert.equal(d().form.draft.label, "Opponent");
  assert.equal(d().form.draft.description, "Club we played");
  assert.equal(d().form.revision, 2);
  assert.match(d().form.error, /^Nothing was saved\. This detail already has answers/);
  page = doc();
  assert.ok(page.querySelector("#cs-field-label").hasAttribute("readonly"));
  await submit(page);
  assert.deepEqual({ ...writes()[1].body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 2, description: "Club we played" });
});

// ---------------------------------------------------------------------------
// Places and teams (P2)
// ---------------------------------------------------------------------------
test("16. Places: the address with Open in maps (a new tab, no referrer), the note on its lines, the teams it is the default of; a new place's body", async () => {
  await loaded();
  await click('[data-action="calendar-settings-section"][data-calendar-settings-section="places"]');
  let page = doc();
  const link = page.querySelector(".cs-row .cs-maps");
  assert.equal(link.getAttribute("href"), "https://www.google.com/maps/search/?api=1&query=Ulica%201%2C%20Novi%20Sad");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(page.querySelector(".cs-row-note").textContent, "Gate B\nParking on the left");
  assert.match(page.querySelector(".cs-row").textContent, /Default place of First team · Used by 2 events/);
  await click('[data-action="calendar-settings-new"][data-kind="location"]', page);
  page = doc();
  type(page, "#cs-location-name", "Sports hall");
  type(page, "#cs-location-address", "Bulevar 5, Novi Sad");
  type(page, "#cs-location-note", "  Side door\r\nCode 1234  ");
  page = doc();
  assert.equal(page.querySelector(".cs-maps-preview a").getAttribute("href"), calendarSettingsMapsUrl("Bulevar 5, Novi Sad"));
  await submit(page);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, name: "Sports hall", address: "Bulevar 5, Novi Sad", note: "Side door\nCode 1234" });
  // An edit that clears the address sends null.
  calls.length = 0;
  await click(`[data-action="calendar-settings-edit"][data-kind="location"][data-id="${L1}"]`);
  page = doc();
  type(page, "#cs-location-address", "");
  await submit(page);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 1, address: null });
});

test("17. Teams: colour (Automatic first) and default place through PUT with the team's revision - 0 before its first row", async () => {
  await loaded();
  await click('[data-action="calendar-settings-section"][data-calendar-settings-section="teams"]');
  let page = doc();
  const rows = [...page.querySelectorAll(".cs-row")];
  assert.match(rows[0].textContent, /First team.*Colour: Rust \(automatic\) · Default place: Main stadium/s, "teal is chosen by U17, so First team's automatic colour is the next one");
  assert.match(rows[1].textContent, /U17.*Colour: Teal · Default place: None/s);
  assert.match(rows[2].textContent, /U19.*Colour: Indigo \(automatic\)/s);
  await click(`[data-action="calendar-settings-edit"][data-kind="team"][data-id="${TM3}"]`, page);
  page = doc();
  const radios = [...page.querySelectorAll('input[type="radio"][data-cs-field="colorKey"]')];
  assert.equal(radios[0].value, "", "Automatic first");
  assert.equal(radios.length, 13);
  assert.equal(radios[0].checked, true);
  assert.equal(page.querySelector('#cs-team-defaultLocationId option[value="' + L2 + '"]'), null, "an archived place is not offered");
  choose(page, "#cs-team-color-violet");
  type(page, "#cs-team-defaultLocationId", L1);
  await submit(page);
  assert.equal(`${writes()[0].method} ${writes()[0].url}`, `PUT ${BASE}/teams/${TM3}`);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 0, colorKey: "violet", defaultLocationId: L1 });
  // Back to Automatic: null.
  calls.length = 0;
  await click(`[data-action="calendar-settings-edit"][data-kind="team"][data-id="${TM2}"]`);
  page = doc();
  choose(page, "#cs-team-color-none");
  await submit(page);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 2, colorKey: null });
});

test("18. P2 - with no team colour chosen, every team wears exactly today's colour (position mod 8); choices are honoured and skipped by the automatic ones", () => {
  // Today's rule, as it was in central-calendar-view.js before K2b-1c.
  const before = (teamId, teams) => { const index = teams.findIndex((t) => t.teamId === teamId); return index < 0 ? -1 : index % 8; };
  for (const size of [0, 1, 3, 8, 9, 12, 13, 20]) {
    const teams = Array.from({ length: size }, (_, i) => ({ teamId: `t${i}`, name: `T${i}` }));
    for (const team of teams) assert.equal(calendarView.centralCalendarTeamIndex(team.teamId, teams), before(team.teamId, teams), `${size} teams, ${team.teamId}`);
    const withNulls = teams.map((t) => ({ ...t, colorKey: null }));
    for (const team of withNulls) assert.equal(calendarView.centralCalendarTeamIndex(team.teamId, withNulls), before(team.teamId, withNulls));
  }
  assert.equal(calendarView.centralCalendarTeamIndex("unknown", [{ teamId: "t0" }]), -1);
  // One team's choice of a colour nobody wore moves nobody: t0 chose coral.
  const stable = [{ teamId: "t0", colorKey: "coral" }, { teamId: "t1" }, { teamId: "t2" }];
  assert.deepEqual(stable.map((t) => calendarView.centralCalendarTeamIndex(t.teamId, stable)), [10, 1, 2]);
  // Choices take colours: t1 chose teal (0) and t3 violet (11). t0 wore teal,
  // so it takes the next free automatic colour (rust, 1); t2 keeps indigo;
  // t4's unknown key counts as no choice and it keeps green (4).
  const teams = [{ teamId: "t0" }, { teamId: "t1", colorKey: "teal" }, { teamId: "t2" }, { teamId: "t3", colorKey: "violet" }, { teamId: "t4", colorKey: "not-a-key" }];
  assert.deepEqual(teams.map((t) => calendarView.centralCalendarTeamIndex(t.teamId, teams)), [1, 0, 2, 11, 4]);
  // A team pushed off its colour never takes another team's: t0 chose rust, so
  // only t1 (rust) moves - to the first free colour, teal - and t2 keeps indigo.
  const chain = [{ teamId: "t0", colorKey: "rust" }, { teamId: "t1" }, { teamId: "t2" }];
  assert.deepEqual(chain.map((t) => calendarView.centralCalendarTeamIndex(t.teamId, chain)), [1, 0, 2]);
  // The last team chose teal (t0's): only t0 moves (to plum); t1 and t2 keep theirs.
  const last = [{ teamId: "t0" }, { teamId: "t1" }, { teamId: "t2" }, { teamId: "t3", colorKey: "teal" }];
  assert.deepEqual(last.map((t) => calendarView.centralCalendarTeamIndex(t.teamId, last)), [3, 1, 2, 0]);
  // Every automatic colour chosen: a team whose own colour was chosen takes
  // one of the other four.
  const allAuto = colors.CALENDAR_COLOR_KEYS.slice(0, 8).map((key, i) => ({ teamId: `c${i}`, colorKey: key }));
  const more = [...allAuto, { teamId: "x" }, { teamId: "y" }];
  assert.equal(calendarView.centralCalendarTeamIndex("x", more), 8);
  assert.equal(calendarView.centralCalendarTeamIndex("y", more), 9);
});

test("19. the palette: the frontend's twelve keys are the server's, in the same order; styles.css holds --cc-team-0..11 with the first eight unchanged", () => {
  assert.deepEqual([...colors.CALENDAR_COLOR_KEYS], [...backendColors.CALENDAR_COLOR_KEYS]);
  assert.deepEqual(Object.keys(colors.CALENDAR_COLOR_LABELS), [...colors.CALENDAR_COLOR_KEYS]);
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const tokens = [...css.matchAll(/--cc-team-(\d+):\s*(#[0-9a-f]{6})/gi)].map((m) => [Number(m[1]), m[2].toLowerCase()]);
  assert.deepEqual(tokens.map(([n]) => n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "each token defined once");
  assert.deepEqual(tokens.slice(0, 8).map(([, hex]) => hex), ["#1f6f68", "#b5542b", "#4a5fc1", "#8a4c8f", "#2f7d3a", "#b07a0a", "#c23a6b", "#3b7f9c"], "today's eight colours");
});

// ---------------------------------------------------------------------------
// Escaping, leaving, the section switch
// ---------------------------------------------------------------------------
test("20. every text the club typed is escaped; no id is printed as text", async () => {
  db.types[0].label = `<img src=x onerror="alert(1)">Training`;
  db.locations[0].name = `<script>alert(2)</script>`;
  db.locations[0].address = `"><b>x</b>`;
  db.locations[0].note = `<i>note</i>`;
  db.fields[0].options[0].label = `<u>Sun</u>`;
  await loaded();
  for (const section of ["types", "details", "places", "teams"]) {
    d().section = section;
    const page = doc();
    assert.equal(page.querySelector("img, script, b, i, u"), null, `${section}: nothing typed became markup`);
    assert.doesNotMatch(page.body.textContent, /[0-9a-f]{8}-[0-9a-f]{4}-/, `${section}: no id in the text`);
  }
  d().section = "places";
  assert.ok(doc().body.textContent.includes("<script>alert(2)</script>"), "shown as text");
});

test("21. a section switch or a menu switch keeps the open form and its values; Cancel drops it; a dirty form asks before another opens", async () => {
  await loaded();
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  type(doc(), "#cs-type-label", "Practice");
  await click('[data-action="calendar-settings-section"][data-calendar-settings-section="places"]');
  data.enterCalendarSettingsSection();
  assert.equal(d().stale, false, "re-entering with an open form does not read the catalog under it");
  await click('[data-action="calendar-settings-section"][data-calendar-settings-section="types"]');
  assert.equal(doc().querySelector("#cs-type-label").value, "Practice");
  confirmAnswer = false;
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T2}"]`);
  assert.equal(d().form.id, T1, "declined: the first form stays");
  assert.match(questions.at(-1), /^Discard your unsaved changes to the event type “Training”\?$/);
  assert.equal(actions.calendarSettingsMayBeLeft({ final: "switch" }), false);
  confirmAnswer = true;
  await click('[data-action="calendar-settings-cancel"]');
  assert.equal(d().form, null);
  assert.equal(actions.calendarSettingsMayBeLeft({ final: "switch" }), true);
  assert.equal(writes().length, 0, "nothing was sent");
  data.enterCalendarSettingsSection();
  assert.equal(d().stale, true, "with nothing open, coming back reads again");
});

// ---------------------------------------------------------------------------
// The review round's fixes (code-reviewer, mobile-qa, ux-design-reviewer)
// ---------------------------------------------------------------------------
test("22. option names are unique over the final set: a rename into a taken name, Show again of a hidden twin, and rename + hide send nothing wrong; a taken option name on the server marks the options", async () => {
  await loaded();
  d().section = "details";
  // Rename Sunny into Rain: marked on the renamed option, nothing sent.
  await click(`[data-action="calendar-settings-edit"][data-kind="field"][data-id="${F1}"]`);
  let page = doc();
  type(page, `[data-cs-option="o-${O1}"]`, "rain");
  await submit(page);
  assert.equal(writes().length, 0);
  assert.equal(d().form.errors.optionLabels[`o-${O1}`], "Two options have this name.");
  assert.equal(d().form.errors.optionLabels[`o-${O2}`], undefined, "the untouched option is not marked");
  // Rename, then hide the same option: only the hide is sent, under its saved name.
  type(page, `[data-cs-option="o-${O1}"]`, "Sun");
  await click(`[data-action="calendar-settings-option-show"][data-option-key="o-${O3}"]`, page);
  await click(`[data-action="calendar-settings-option-hide"][data-option-key="o-${O1}"]`);
  assert.equal(d().form.draft.options.find((o) => o.id === O1).label, "Sunny");
  await submit(doc());
  assert.deepEqual(writes()[0].body.options, { hide: [O1], show: [O3] });
  // Show again a hidden option whose name a live one now has.
  calls.length = 0;
  db.fields[0].options = [
    { id: O1, label: "Sunny", sortOrder: 10, archived: false }, { id: O2, label: "Snow", sortOrder: 20, archived: false },
    { id: O3, label: "snow", sortOrder: 30, archived: true },
  ];
  db.fields[0].revision = 7;
  await data.loadCalendarSettings(render);
  calls.length = 0;
  await click(`[data-action="calendar-settings-edit"][data-kind="field"][data-id="${F1}"]`);
  await click(`[data-action="calendar-settings-option-show"][data-option-key="o-${O3}"]`);
  await submit(doc());
  assert.equal(writes().length, 0);
  assert.equal(d().form.errors.optionLabels[`o-${O3}`], "Two options have this name.");
  // The server's label_taken on a body that keeps the detail's own name marks the options.
  await click(`[data-action="calendar-settings-option-hide"][data-option-key="o-${O3}"]`);
  await click('[data-action="calendar-settings-option-add"]');
  page = doc();
  const added = [...page.querySelectorAll("[data-cs-option]")].at(-1);
  type(page, `[data-cs-option="${added.dataset.csOption}"]`, "Fog");
  faults.push({ match: (c) => c.method === "PATCH", result: { status: 409, body: { error: "label_taken", message: "taken" } } });
  await submit(page);
  assert.equal(d().form.errors.options, "Another option of this detail already has one of these names.");
  assert.equal(d().form.errors.label, undefined, "never the detail's own name");
});

test("23. a saved team colour shows at once, even when the read after it fails (the colours are cached by the team list)", async () => {
  await loaded();
  d().section = "teams";
  doc();
  await click(`[data-action="calendar-settings-edit"][data-kind="team"][data-id="${TM1}"]`);
  choose(doc(), "#cs-team-color-rose");
  faults.push({ match: (c) => c.method === "GET", result: { status: 500, body: { error: "internal_error" } } });
  await submit(doc());
  const row = [...doc().querySelectorAll(".cs-row")].find((r) => r.textContent.includes("First team"));
  assert.match(row.querySelector(".cs-dot").getAttribute("style"), /--cc-team-6\)/);
  assert.match(row.textContent, /Colour: Rose/);
});

test("24. the type form: a detail chosen but not added is named and nothing is sent; the order cannot change under an open type edit", async () => {
  await loaded();
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  let page = doc();
  type(page, "#cs-type-add-field", F2);
  await submit(page);
  assert.equal(writes().length, 0);
  assert.equal(d().form.errors.addFieldId, "You chose “Opponent” but did not add it: press Add detail, or choose nothing.");
  page = doc();
  assert.equal(page.querySelector("#cs-type-add-field").getAttribute("aria-invalid"), "true");
  assert.equal(page.querySelector(`[data-action="calendar-settings-type-move"][data-id="${T2}"][data-direction="up"]`).disabled, true);
  assert.match(page.querySelector(".cs-section").textContent, /Save or cancel the open form to change the order\./);
  await actions.handleCalendarSettingsAction(fakeAction({ action: "calendar-settings-type-move", id: T2, direction: "up" }), { render });
  assert.equal(writes().length, 0, "the move is refused under the open edit");
  type(page, "#cs-type-add-field", "");
  await submit(doc());
  assert.equal(d().form.error, "Nothing changed: change something, or Cancel.");
});

test("25. a form's write that is not confirmed is named from another section, with a way back to it", async () => {
  await loaded();
  d().section = "details";
  await click(`[data-action="calendar-settings-edit"][data-kind="field"][data-id="${F2}"]`);
  let page = doc();
  type(page, "#cs-field-description", "The club we played");
  faults.push({ match: (c) => c.method === "PATCH", lose: true });
  await submit(page);
  await click('[data-action="calendar-settings-section"][data-calendar-settings-section="places"]');
  page = doc();
  assert.match(page.querySelector(".cs-notice").textContent, /The changes to “Opponent”: the result is not confirmed yet\. Open Details to check it\./);
  assert.equal(page.querySelector('[data-action="calendar-settings-new"][data-kind="location"]').disabled, true);
  await click('.cs-notice [data-action="calendar-settings-section"][data-calendar-settings-section="details"]', page);
  assert.ok(doc().querySelector('[data-calendar-settings-form] [data-action="calendar-settings-check-result"]'));
});

test("26. app.js repaints this panel only while its section is on screen: never another Settings section (it may hold typed values)", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const body = app.slice(app.indexOf("function renderCalendarSettingsSurface() {"), app.indexOf("// From Source connections to the approved pair"));
  assert.match(body, /^function renderCalendarSettingsSurface\(\) \{\n {2}if \(state\.activeTab !== "organization" \|\| state\.organization\.section !== "calendar"\) return;/);
  assert.ok(body.indexOf('section !== "calendar") return;') < body.indexOf("renderOrganizationPanel("), "the section is checked before any Settings repaint");
  assert.match(body, /panel\.outerHTML = renderCalendarSettingsPanelHtml\(\);/);
});

// ---------------------------------------------------------------------------
// The independent review of PR #343 (the stream manager's order of 2026-11-03)
// ---------------------------------------------------------------------------
test("27. P2 (S11, S12): one team's choice moves only the team whose colour it took; with no choice, today's colours for 0..20 teams, nulls included", () => {
  const before = (id, teams) => { const i = teams.findIndex((t) => t.teamId === id); return i < 0 ? -1 : i % 8; };
  for (let n = 0; n <= 20; n += 1) {
    const teams = Array.from({ length: n }, (_, i) => ({ teamId: `t${i}`, colorKey: i % 2 ? null : undefined }));
    for (const team of teams) assert.equal(calendarView.centralCalendarTeamIndex(team.teamId, teams), before(team.teamId, teams), `${n} teams`);
  }
  for (let n = 1; n <= 12; n += 1) {
    for (let chooser = 0; chooser < n; chooser += 1) {
      for (const key of colors.CALENDAR_COLOR_KEYS) {
        const teams = Array.from({ length: n }, (_, i) => ({ teamId: `t${i}`, colorKey: i === chooser ? key : null }));
        const owner = teams.findIndex((t, i) => i !== chooser && i < 8 && colors.CALENDAR_COLOR_KEYS[i % 8] === key);
        teams.forEach((team, i) => {
          if (i === chooser || i === owner || n > 8) return;
          assert.equal(calendarView.centralCalendarTeamIndex(team.teamId, teams), i % 8, `${n} teams, t${chooser} chose ${key}: t${i} keeps its colour`);
        });
      }
    }
  }
});

test("28. the calendar reads its catalog again after a Settings write (S18): its view cache is dropped, and the event form's types too - at once with no form open, at the next form when one is open", async () => {
  const { setCacheData, getCacheEntry, hasCachedData } = await import("../view-cache.js");
  const types = [{ id: T1, label: "Training" }, { id: T2, label: "Match" }];
  state.centralCalendar = emptyCentralCalendarState();
  state.centralCalendar.eventTypes = types;
  setCacheData("central-calendar", "probe", { days: [] });
  await loaded();
  await click('[data-action="calendar-settings-new"][data-kind="type"]');
  let page = doc();
  type(page, "#cs-type-label", "Gym");
  type(page, "#cs-type-kind", "training");
  await submit(page);
  assert.equal(d().command, null, "settled");
  assert.equal(state.centralCalendar.eventTypes, null, "no event form open: the types are read again at the next one");
  assert.equal(hasCachedData(getCacheEntry("central-calendar", "probe")), false, "the calendar's cached range is dropped");
  // An event form is open: its list stays until it closes, then the next form reads again.
  state.centralCalendar.eventTypes = types;
  state.centralCalendar.form = { mode: "create" };
  await click(`[data-action="calendar-settings-archive"][data-kind="type"][data-id="${T2}"]`);
  assert.equal(state.centralCalendar.eventTypes, types, "the open form keeps the list it was made from");
  assert.equal(state.centralCalendar.eventTypesStale, true);
  const calendarActions = await import("../central-calendar-actions.js");
  state.centralCalendar.form = null;
  state.centralCalendar.data = { workspace: { type: "club", scopeId: CLUB }, teams: [], days: [] };
  state.centralCalendar.anchor = "2026-11-03";
  state.centralCalendar.selectedDate = "2026-11-03";
  calls.length = 0;
  installFetchMock((call) => {
    calls.push(call);
    return call.url === "/api/calendar/events/types" ? { status: 200, body: { types: [types[0]] } } : { status: 404, body: {} };
  });
  await calendarActions.handleCentralCalendarAction(fakeAction({ action: "central-calendar-new-event" }), { render });
  assert.ok(state.centralCalendar.form, "the next event form opened");
  assert.equal(state.centralCalendar.eventTypesStale, false);
  assert.ok(calls.some((c) => c.url === "/api/calendar/events/types"), "the next form read the types again");
  assert.deepEqual(state.centralCalendar.eventTypes, [types[0]], "with the new list");
  state.centralCalendar = emptyCentralCalendarState();
  calls = installFetchMock(server);
});

test("29. an icon or a colour the form never touched is never sent - a saved key this bundle does not know stays (S20)", async () => {
  db.types[0].iconKey = "a-newer-icon";
  db.types[0].colorKey = "a-newer-colour";
  await loaded();
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  const page = doc();
  type(page, "#cs-type-label", "Team training");
  await submit(page);
  assert.deepEqual({ ...writes()[0].body, requestKey: undefined }, { requestKey: undefined, expectedRevision: 1, label: "Team training" });
  // Choosing in the form does send it.
  calls.length = 0;
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  choose(doc(), "#cs-type-color-sky");
  await submit(doc());
  assert.equal(writes()[0].body.colorKey, "sky");
  assert.equal("iconKey" in writes()[0].body, false);
});

test("30. another role in the same club (not club_admin) is offered no tab", () => {
  state.currentUser = { activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, role: "club_coach" }, { id: OTHER_CLUB, role: "club_admin" }] };
  assert.equal(/data-section="calendar"/.test(renderSettingsNavHtml(state.organization.data, "overview")), false);
  assert.equal(data.calendarSettingsContext(), null);
});

test("31. a late answer after a workspace switch lands on nothing: no request, no notice, no state in the new slice (S17)", async () => {
  await loaded();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = installFetchMock(async (call) => {
    if (call.method !== "GET") await gate;
    return server(call);
  });
  const painted = [];
  const pending = actions.handleCalendarSettingsAction(doc().querySelector(`[data-action="calendar-settings-archive"][data-kind="type"][data-id="${T2}"]`), { render: () => painted.push(state.calendarSettings.notice) });
  assert.equal(d().command?.busy, true);
  data.resetCalendarSettingsForWorkspaceChange();
  const fresh = state.calendarSettings;
  const sent = seen.length;
  painted.length = 0;
  release();
  await pending;
  assert.equal(seen.length, sent, "no request after the late answer (no read again)");
  assert.deepEqual(painted, [], "nothing painted");
  assert.deepEqual(fresh, emptyCalendarSettingsState(), "the new slice is untouched");
  calls = installFetchMock(server);
});
