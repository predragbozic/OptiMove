// K2b-2a-2b (docs/ai/central-calendar-k2b2a2-ui-contract.md sections 2 and
// 10): Settings -> Calendar's questions for athletes, through the real
// handlers and templates with a fake fetch and JSDOM. The fake keeps the
// routes' contracts (backend/src/routes/calendarSettings.js,
// calendarSettingsService.js):
// - GET /api/calendar/settings carries questions {enabled, revision,
//   updatedAt}, and each type's defaultQuestions only while the switch is on;
// - PUT /api/calendar/settings/questions: a platform admin in the club's
//   workspace only, the identical 404 for everyone else; reason required
//   (400 invalid_reason); a requestKey replays its saved answer, another body
//   is request_key_reused;
// - PATCH /api/calendar/settings/types/:id with defaultQuestions while the
//   switch is off: 409 questions_off, nothing saved.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";

const asked = [];
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: (q) => { asked.push(q); return true; }, matchMedia: () => ({ matches: false }) };

const { state } = await import("../state.js");
const data = await import("../calendar-settings-data.js");
const actions = await import("../calendar-settings-actions.js");
const { renderCalendarSettingsPanelHtml } = await import("../calendar-settings-view.js");

const CLUB = "c1c1c1c1-0000-4000-8000-000000000001";
const T1 = "71000000-0000-4000-8000-000000000001";
const T2 = "71000000-0000-4000-8000-000000000002";
const BASE = "/api/calendar/settings";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let srv;
let calls;
const clone = (v) => JSON.parse(JSON.stringify(v));

function reset({ on = false, platformAdmin = true } = {}) {
  srv = {
    on, platformAdmin, revision: on ? 1 : 0, updatedAt: on ? "2026-11-10T09:00:00.000Z" : null, saved: new Map(), faults: [],
    types: [
      { id: T1, key: "training", kind: "training", label: "Training", iconKey: null, colorKey: null, defaultExpects: ["rpe"], fieldIds: [], sortOrder: 10, archived: false, revision: 1, eventCount: 0, questions: ["rpe"] },
      { id: T2, key: "meeting", kind: "meeting", label: "Meeting", iconKey: null, colorKey: null, defaultExpects: [], fieldIds: [], sortOrder: 20, archived: false, revision: 1, eventCount: 0, questions: [] },
    ],
  };
}
const typeView = (t) => {
  const { questions, ...rest } = t;
  return { ...clone(rest), ...(srv.on ? { defaultQuestions: [...questions] } : {}) };
};
const settings = () => ({ clubId: CLUB, types: srv.types.map(typeView), fields: [], locations: [], teams: [], questions: { enabled: srv.on, revision: srv.revision, updatedAt: srv.updatedAt } });

function apply(call) {
  const b = call.body || {};
  if (call.method === "PUT" && call.url === `${BASE}/questions`) {
    if (!srv.platformAdmin) return { status: 404, body: { error: "notFound", message: "Not found." } };
    if (typeof b.reason !== "string" || !b.reason.trim()) return { status: 400, body: { error: "invalid_reason", message: "reason" } };
    srv.on = b.enabled === true;
    srv.revision += 1;
    srv.updatedAt = "2026-11-19T08:00:00.000Z";
    return { status: 200, body: { questions: { enabled: srv.on, revision: srv.revision, updatedAt: srv.updatedAt } } };
  }
  const m = call.url.match(/^\/api\/calendar\/settings\/types\/([^/]+)$/);
  if (call.method === "PATCH" && m) {
    const row = srv.types.find((t) => t.id === m[1]);
    if (!row) return { status: 404, body: { error: "notFound" } };
    if (b.expectedRevision !== row.revision) return { status: 409, body: { error: "type_changed", current: typeView(row) } };
    if ("defaultQuestions" in b && !srv.on) return { status: 409, body: { error: "questions_off", message: "off" } };
    if ("defaultQuestions" in b) row.questions = ["rpe", "wellness"].filter((k) => b.defaultQuestions.includes(k));
    if ("label" in b) row.label = b.label;
    row.revision += 1;
    return { status: 200, body: { type: typeView(row) } };
  }
  return { status: 400, body: { error: "invalid_body" } };
}

function server(call) {
  const at = srv.faults.findIndex((f) => f.match(call));
  const fault = at >= 0 ? srv.faults.splice(at, 1)[0] : null;
  if (fault && !fault.lose) return fault.result;
  if (call.method === "GET" && call.url === BASE) return { status: 200, body: settings() };
  const key = call.body?.requestKey;
  const signature = `${call.method} ${call.url} ${JSON.stringify({ ...call.body, requestKey: undefined })}`;
  let answer;
  if (key && srv.saved.has(key)) {
    const prior = srv.saved.get(key);
    answer = prior.signature === signature ? { status: prior.status, body: { ...clone(prior.body), replayed: true } } : { status: 409, body: { error: "request_key_reused" } };
  } else {
    answer = apply(call);
    if (key && answer.status < 300) srv.saved.set(key, { signature, ...clone(answer) });
  }
  return fault?.lose ? { throwNetworkError: true } : answer;
}

const render = () => {};
const doc = () => new JSDOM(`<body>${renderCalendarSettingsPanelHtml()}</body>`).window.document;
const writes = () => calls.filter((c) => c.method !== "GET");
const cs = () => state.calendarSettings;
const text = (page) => page.body.textContent.replace(/\s+/g, " ");

async function click(selector, page = doc()) {
  const el = page.querySelector(selector);
  assert.ok(el, `no element for ${selector}`);
  assert.equal(el.disabled, false, `${selector} is disabled`);
  await actions.handleCalendarSettingsAction(el, { render });
  return el;
}
function typeIn(page, selector, value) {
  const el = page.querySelector(selector);
  assert.ok(el, `no field ${selector}`);
  el.value = value;
  actions.handleCalendarSettingsInput(el, { render });
}

async function setup({ on = false, platformAdmin = true } = {}) {
  reset({ on, platformAdmin });
  data.resetCalendarSettingsForWorkspaceChange();
  asked.length = 0;
  state.iconPicker = null;
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, name: "Example Club", role: "club_admin" }] };
  state.organization.data = { isPlatformAdmin: platformAdmin, clubs: [{ id: CLUB, name: "Example Club" }], manageableClubIds: [CLUB], teams: [], users: [], athletes: [] };
  calls = installFetchMock(server);
  await data.loadCalendarSettings(render);
  calls.length = 0;
}

beforeEach(() => setup());

// ---------------------------------------------------------------------------
// The club's switch
// ---------------------------------------------------------------------------
test("1. the club's admin sees the state read-only: no reason field, no button", async () => {
  await setup({ on: false, platformAdmin: false });
  let page = doc();
  assert.match(text(page), /Questions for athletes/);
  assert.match(text(page), /○ Off — questions to athletes are not turned on for this club\. A platform administrator can turn them on\./);
  assert.equal(page.querySelector("[data-cs-questions-reason]"), null);
  assert.equal(page.querySelector('[data-action="calendar-settings-questions-request"]'), null);
  await setup({ on: true, platformAdmin: false });
  page = doc();
  assert.match(text(page), /● On — this club's coaches can ask athletes questions after events\. Turned on 10\.11\.2026\./);
  assert.equal(page.querySelector("[data-cs-questions-reason]"), null);
});

test("2. without migration v81 (no questions in the read) nothing of it shows", async () => {
  cs().data.questions = null;
  assert.doesNotMatch(text(doc()), /Questions for athletes/);
});

test("3. a platform admin: an empty reason asks for one and sends nothing", async () => {
  await click('[data-action="calendar-settings-questions-request"]');
  assert.equal(cs().questionsForm.error, "Write a reason.");
  assert.equal(cs().questionsForm.confirming, false);
  const page = doc();
  assert.equal(page.querySelector("[data-cs-questions-reason]").getAttribute("aria-invalid"), "true");
  assert.match(text(page), /Write a reason\./);
  assert.equal(writes().length, 0);
});

test("4. turn on: the reason, one inline step (one sentence, two buttons), Cancel sends nothing, Turn on sends one PUT with the exact body", async () => {
  let page = doc();
  assert.match(page.querySelector('[data-action="calendar-settings-questions-request"]').textContent, /Turn on for this club/);
  typeIn(page, "[data-cs-questions-reason]", "  Pilot of the athlete questions.  ");
  await click('[data-action="calendar-settings-questions-request"]');
  page = doc();
  assert.match(text(page), /Turn on questions for athletes for this club\? Its coaches can then ask athletes after events\./);
  assert.equal(page.querySelector('[data-action="calendar-settings-questions-request"]'), null, "the request button gives way to the step");
  assert.equal(page.querySelectorAll(".cs-inline-confirm button").length, 2);
  assert.equal(asked.length, 0, "never a native confirm()");
  await click('[data-action="calendar-settings-questions-cancel"]');
  assert.equal(writes().length, 0, "Cancel sends nothing");
  assert.equal(cs().questionsForm.reason, "  Pilot of the athlete questions.  ", "the reason stays");
  await click('[data-action="calendar-settings-questions-request"]');
  await click('[data-action="calendar-settings-questions-confirm"]');
  assert.equal(writes().length, 1);
  const put = writes()[0];
  assert.equal(put.method, "PUT");
  assert.equal(put.url, `${BASE}/questions`);
  assert.deepEqual(Object.keys(put.body).sort(), ["enabled", "reason", "requestKey"]);
  assert.equal(put.body.enabled, true);
  assert.equal(put.body.reason, "Pilot of the athlete questions.");
  assert.match(put.body.requestKey, UUID);
  assert.equal(cs().notice, "Questions for athletes are now on for this club.");
  assert.equal(cs().questionsForm, null);
  assert.equal(cs().data.questions.enabled, true, "read again after the save");
  page = doc();
  assert.match(text(page), /● On/);
  assert.match(page.querySelector('[data-action="calendar-settings-questions-request"]').textContent, /Turn off for this club/);
});

test("5. turn off: its own question and words; a new key for every press", async () => {
  await setup({ on: true });
  const page = doc();
  typeIn(page, "[data-cs-questions-reason]", "End of the pilot.");
  await click('[data-action="calendar-settings-questions-request"]');
  assert.match(text(doc()), /Turn off questions for athletes for this club\? Coaches can't ask new questions; the answers given stay\. Questions already asked keep running; to stop one, turn this back on first\./);
  await click('[data-action="calendar-settings-questions-confirm"]');
  assert.equal(writes()[0].body.enabled, false);
  assert.equal(cs().notice, "Questions for athletes are now off for this club.");
  typeIn(doc(), "[data-cs-questions-reason]", "Back on.");
  await click('[data-action="calendar-settings-questions-request"]');
  await click('[data-action="calendar-settings-questions-confirm"]');
  assert.notEqual(writes()[1].body.requestKey, writes()[0].body.requestKey);
});

test("6. the identical 404: one neutral sentence, the form gone, the settings read again", async () => {
  srv.platformAdmin = false; // the server decides: no longer allowed
  typeIn(doc(), "[data-cs-questions-reason]", "Pilot.");
  await click('[data-action="calendar-settings-questions-request"]');
  await click('[data-action="calendar-settings-questions-confirm"]');
  assert.equal(cs().notice, "This setting isn't available for you here. Nothing was saved.");
  assert.equal(cs().noticeTone, "error");
  assert.equal(cs().questionsForm, null);
  assert.ok(calls.some((c) => c.method === "GET" && c.url === BASE), "read again");
});

test("7. refusals: invalid_reason on the field; try_again and request_key_reused as one sentence; never a code", async () => {
  const send = async () => {
    typeIn(doc(), "[data-cs-questions-reason]", "Pilot.");
    await click('[data-action="calendar-settings-questions-request"]');
    await click('[data-action="calendar-settings-questions-confirm"]');
  };
  srv.faults.push({ match: (c) => c.method === "PUT", result: { status: 400, body: { error: "invalid_reason" } } });
  await send();
  assert.equal(cs().questionsForm.error, "Write a reason of at most 500 characters.");
  assert.equal(cs().questionsForm.confirming, false);
  srv.faults.push({ match: (c) => c.method === "PUT", result: { status: 409, body: { error: "try_again" } } });
  await send();
  assert.equal(cs().notice, "The calendar settings are busy. Nothing was saved; try again in a moment.");
  srv.faults.push({ match: (c) => c.method === "PUT", result: { status: 409, body: { error: "request_key_reused" } } });
  await send();
  assert.equal(cs().notice, "This could not be sent. Nothing was saved; try again.");
  assert.doesNotMatch(text(doc()), /invalid_reason|try_again|request_key_reused|notFound/);
});

test("8. a lost answer: Result not confirmed, Check result sends the same path, body and key; every other write is off meanwhile", async () => {
  srv.faults.push({ match: (c) => c.method === "PUT", lose: true });
  typeIn(doc(), "[data-cs-questions-reason]", "Pilot.");
  await click('[data-action="calendar-settings-questions-request"]');
  await click('[data-action="calendar-settings-questions-confirm"]');
  assert.equal(cs().command.unconfirmed, true);
  let page = doc();
  assert.match(text(page), /Result not confirmed\./);
  assert.match(text(page), /Turning questions for athletes on: the answer was lost/);
  assert.ok(page.querySelector('[data-action="calendar-settings-edit"]').disabled, "other writes are off");
  assert.equal(actions.calendarSettingsMayBeLeft({ final: "switch" }), true);
  assert.match(asked.at(-1), /not confirmed/);
  await click('[data-action="calendar-settings-check-result"]', page);
  const puts = writes().filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1].body, puts[0].body, "the same body and key");
  assert.equal(puts[1].url, puts[0].url);
  assert.equal(cs().command, null);
  assert.equal(cs().notice, "Checked: Questions for athletes are now on for this club.");
  page = doc();
  assert.match(text(page), /● On/);
});

test("9. a typed reason is a leave question and a beforeunload", async () => {
  typeIn(doc(), "[data-cs-questions-reason]", "Pilot.");
  asked.length = 0;
  assert.equal(actions.calendarSettingsMayBeLeft({ final: "switch" }), true);
  assert.equal(asked.length, 1);
  const event = { isTrusted: true, preventDefault() { this.prevented = true; } };
  assert.equal(actions.handleCalendarSettingsBeforeUnload(event), true);
  assert.equal(event.prevented, true);
});

// ---------------------------------------------------------------------------
// The type's questions
// ---------------------------------------------------------------------------
test("10. per type: shown only while the switch is on; the list row says what it asks", async () => {
  let page = doc();
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`, page);
  assert.equal(doc().querySelector("[data-cs-question]"), null, "switch off: no questions group");
  assert.doesNotMatch(text(doc()), /Asks RPE/);
  await setup({ on: true });
  page = doc();
  assert.match(text(page), /Asks RPE/);
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`, page);
  page = doc();
  const boxes = [...page.querySelectorAll("[data-cs-question]")];
  assert.deepEqual(boxes.map((b) => [b.dataset.csQuestion, b.checked]), [["rpe", true], ["wellness", false]]);
  assert.match(text(page), /Athletes are asked these questions on new events of this type\. Coaches can change them per event\./);
});

test("11. per type: sent only when changed, on the type's Save, with no extra step", async () => {
  await setup({ on: true });
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  let page = doc();
  typeIn(page, '[data-cs-field="label"]', "Training session");
  await actions.submitCalendarSettingsForm(page.querySelector("[data-calendar-settings-form]"), { render });
  assert.equal("defaultQuestions" in writes()[0].body, false, "untouched: not sent");
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  page = doc();
  const box = page.querySelector('[data-cs-question="wellness"]');
  box.checked = true;
  actions.handleCalendarSettingsInput(box, { render });
  await actions.submitCalendarSettingsForm(doc().querySelector("[data-calendar-settings-form]"), { render });
  assert.deepEqual(writes()[1].body.defaultQuestions, ["rpe", "wellness"]);
  assert.equal(asked.length, 0, "no confirmation");
  assert.match(text(doc()), /Asks RPE and WELLNESS/);
});

test("12. questions_off: one sentence, the group gone, nothing saved; Save again without it saves the rest", async () => {
  await setup({ on: true });
  await click(`[data-action="calendar-settings-edit"][data-kind="type"][data-id="${T1}"]`);
  let page = doc();
  typeIn(page, '[data-cs-field="label"]', "Training session");
  const box = page.querySelector('[data-cs-question="wellness"]');
  box.checked = true;
  actions.handleCalendarSettingsInput(box, { render });
  srv.on = false; // turned off meanwhile
  await actions.submitCalendarSettingsForm(doc().querySelector("[data-calendar-settings-form]"), { render });
  assert.equal(cs().form.error, "Questions for athletes are not turned on for this club. Nothing was saved. Save again without the questions.");
  page = doc();
  assert.equal(page.querySelector("[data-cs-question]"), null, "the group is gone");
  assert.equal(srv.types[0].label, "Training", "nothing saved");
  await actions.submitCalendarSettingsForm(page.querySelector("[data-calendar-settings-form]"), { render });
  const last = writes().at(-1);
  assert.equal("defaultQuestions" in last.body, false);
  assert.equal(last.body.label, "Training session");
  assert.equal(srv.types[0].label, "Training session");
});
