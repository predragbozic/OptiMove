// Central calendar K2b-1b: the events use the club's catalog — a library
// place, the chosen details and their values — on create, on edit, through
// the values command and in every read, with D41 on every read and finding
// 6 (option A) on every edit. Plan: docs/ai/central-calendar-k2b-plan.md,
// section 18 (18.6 is this suite's list; 18.7 the manager's decisions).
//
// No migration: v51 holds every row written here. One disposable database
// through the real runner (support/calendar-fixture.mjs); the real Express
// app over HTTP with real session cookies. Nothing touches OPTIMOVE or any
// persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { addDays, calendarRoleMatrix, newKey, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const FUTURE = addDays(TODAY, 1);
const PAST = addDays(TODAY, -2);
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);
const TZ = "Europe/Belgrade";
const ZERO = "00000000-0000-4000-8000-000000000000";

let env;
let m;
let eventService;
let settingsService;

before(async () => {
  env = await startCalendarApp({ label: "k2bev" });
  eventService = await import("../src/calendarEventService.js");
  settingsService = await import("../src/calendarSettingsService.js");
  m = await calendarRoleMatrix(env, "k2bev");
});

after(async () => {
  if (env) await env.stop();
});

const q = (sql, params) => env.q(sql, params);
const api = (p, o) => env.api(p, o);
const calendarOf = (cookie) => api(`/api/calendar?from=${FROM}&to=${TO}`, { cookie });
const send = (cookie, method, p, body) => api(`/api/calendar/settings${p}`, { method, cookie, body: { requestKey: newKey(), ...body } });
const ev = (cookie, method, p, body) => api(`/api/calendar/events${p}`, { method, cookie, body: { requestKey: newKey(), ...body } });
const createEvent = (cookie, body) => ev(cookie, "POST", "", { timezone: TZ, day: FUTURE, ...body });
const patchEvent = (cookie, event, body) => ev(cookie, "PATCH", `/${event.id}`, { expectedRevision: event.revision, ...body });
const setValues = (cookie, event, values, extra = {}) => ev(cookie, "POST", `/${event.id}/fields`, { expectedRevision: event.revision, values, ...extra });
const getEvent = (cookie, id) => api(`/api/calendar/events/${id}`, { cookie });
// The athlete's card names its event under links only (D21).
const cardsOf = (res, eventId) => (res.body.days || []).flatMap((d) => d.items).filter((i) => i.kind === "event" && (i.eventId ?? i.links?.eventId) === eventId);
const valueOf = (event, fieldId) => event.fields.find((f) => f.fieldId === fieldId)?.value;
const changesOf = async (eventId) => q(`select kind, details from calendar.event_changes where event_id = $1 order by revision`, [eventId]);

async function freshClub(label) {
  const clubId = await env.fx.makeClub(`${label} club`);
  const teamId = await env.fx.makeTeam(clubId, `${label} team`);
  const admin = await env.fx.clubAdminOf(clubId, `${label} admin`);
  return { clubId, teamId, admin };
}
async function catalog(cookie) {
  const res = await api("/api/calendar/settings", { cookie });
  assert.equal(res.status, 200, res.text);
  return res.body;
}
const typeOf = (cat, key) => cat.types.find((t) => t.key === key);
async function newField(admin, body) {
  const res = await send(admin.cookie, "POST", "/fields", body);
  assert.equal(res.status, 201, res.text);
  return res.body.field;
}
async function newPlace(admin, name, extra = {}) {
  const res = await send(admin.cookie, "POST", "/locations", { name, ...extra });
  assert.equal(res.status, 201, res.text);
  return res.body.location;
}
async function clubEvent(c, extra = {}) {
  const cat = await catalog(c.admin.cookie);
  const res = await createEvent(c.admin.cookie, { eventTypeId: typeOf(cat, "training").id, title: `Event ${uid()}`, targets: [{ kind: "club", id: c.clubId }], ...extra });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
// A paused command: `hooks[name]` waits for release(); `reached` resolves
// once the command is inside its transaction.
function pause(hooks, name, operation) {
  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  hooks[name] = async (ctx) => {
    if (operation && ctx.operation !== operation) return;
    delete hooks[name];
    reached();
    await gate;
  };
  return { release, arrived };
}
async function waitForLockWait(minWaiting = 1) {
  for (let i = 0; i < 200; i += 1) {
    const n = (await q(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`))[0].n;
    if (n >= minWaiting) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no statement started to wait for a lock");
}

// ---------------------------------------------------------------------------
// 1-2. Create
// ---------------------------------------------------------------------------
test("1. create: a library place of the owner's club or the one-off text, never both; one 400 for a foreign, archived or unknown place, and for a private coach", async () => {
  const a = await freshClub("place");
  const b = await freshClub("place other");
  const cat = await catalog(a.admin.cookie);
  const training = typeOf(cat, "training");
  const place = await newPlace(a.admin, "Main stadium", { address: "1 Stadium Road", note: "Gate B" });
  const archived = await newPlace(a.admin, "Old hall");
  assert.equal((await send(a.admin.cookie, "POST", `/locations/${archived.id}/archive`, { expectedRevision: 1 })).status, 200);
  const foreign = await newPlace(b.admin, "Their ground");

  const base = { eventTypeId: training.id, title: "With a place", targets: [{ kind: "club", id: a.clubId }] };
  const lib = await createEvent(a.admin.cookie, { ...base, locationId: place.id });
  assert.equal(lib.status, 201, lib.text);
  assert.deepEqual(lib.body.event.place, { source: "library", locationId: place.id, name: "Main stadium", address: "1 Stadium Road", note: "Gate B" });
  assert.equal(lib.body.event.locationId, place.id);
  assert.equal(lib.body.event.location, null);
  assert.deepEqual((await q(`select location_id, location from calendar.events where id = $1`, [lib.body.event.id]))[0], { location_id: place.id, location: null });
  const [created] = await changesOf(lib.body.event.id);
  assert.equal(created.details.locationId, place.id, "the change row names the club's own place");

  const text = await createEvent(a.admin.cookie, { ...base, location: "Park" });
  assert.equal(text.status, 201, text.text);
  assert.deepEqual(text.body.event.place, { source: "one_off", text: "Park" });
  assert.equal(text.body.event.locationId, null);

  const both = await createEvent(a.admin.cookie, { ...base, location: "Park", locationId: place.id });
  assert.deepEqual([both.status, both.body.error], [400, "invalid_location"]);
  assert.equal((await createEvent(a.admin.cookie, { ...base, locationId: "nope" })).body.error, "invalid_location");

  const refusals = [];
  for (const id of [foreign.id, archived.id, ZERO]) refusals.push(await createEvent(a.admin.cookie, { ...base, locationId: id }));
  const coach = m.roles.privateCoach;
  const sys = (await api("/api/calendar/events/types", { cookie: coach.cookie })).body.types[0];
  refusals.push(await createEvent(coach.cookie, { eventTypeId: sys.id, title: "Private", targets: [{ kind: "athlete", id: m.athletes.ownAthlete.athleteId }], locationId: place.id }));
  for (const res of refusals) {
    assert.deepEqual([res.status, res.body.error], [400, "location_not_available"], res.text);
    assert.equal(res.text, refusals[0].text, "the one answer, whatever the reason");
  }

  // A team event takes a place of its team's club.
  const coachA = await env.fx.coachOf(a.teamId, "place coach");
  const teamEvent = await createEvent(coachA.cookie, { eventTypeId: training.id, title: "Team", targets: [{ kind: "team", id: a.teamId }], locationId: place.id });
  assert.equal(teamEvent.status, 201, teamEvent.text);
  assert.equal(teamEvent.body.event.place.locationId, place.id);
});

test("2. create: no fieldIds copies the type's live default details in their order; an explicit list is kept; a foreign, archived, system or unknown detail is the one 400", async () => {
  const a = await freshClub("fields");
  const b = await freshClub("fields other");
  let cat = await catalog(a.admin.cookie);
  const match = typeOf(cat, "match");
  assert.ok(match.fieldIds.length >= 3, "the seeded match lists details");
  const gone = match.fieldIds[1];
  const goneField = cat.fields.find((f) => f.id === gone);
  assert.equal((await send(a.admin.cookie, "POST", `/fields/${gone}/archive`, { expectedRevision: goneField.revision })).status, 200);
  cat = await catalog(a.admin.cookie);
  const liveDefaults = typeOf(cat, "match").fieldIds.filter((id) => id !== gone);

  const base = { eventTypeId: match.id, title: "Match", targets: [{ kind: "club", id: a.clubId }] };
  // A body without the new keys keeps K2a's canonical body, so its request
  // hash is unchanged and a create retried across the deploy replays.
  const k2aCanonical = eventService.validateCreateBody({ requestKey: newKey(), timezone: TZ, day: FUTURE, ...base }).canonical;
  assert.deepEqual(Object.keys(k2aCanonical), ["operation", "eventTypeId", "title", "day", "endDay", "startTime", "endTime", "timezone", "location",
    "expects", "notes", "targets", "externalScheduleId", "testScheduleId"], "K2a's keys, in K2a's order");
  assert.deepEqual(k2aCanonical, {
    operation: "create", eventTypeId: match.id, title: "Match", day: FUTURE, endDay: null, startTime: null, endTime: null, timezone: TZ,
    location: null, expects: null, notes: null, targets: k2aCanonical.targets, externalScheduleId: null, testScheduleId: null,
  });
  assert.equal("locationId" in eventService.validateCreateBody({ requestKey: newKey(), timezone: TZ, day: FUTURE, ...base, locationId: null }).canonical, false,
    "an explicit null place is no key either");
  const byDefault = await createEvent(a.admin.cookie, base);
  assert.equal(byDefault.status, 201, byDefault.text);
  assert.deepEqual(byDefault.body.event.fields.map((f) => f.fieldId), liveDefaults, "the type's live defaults, in order");
  assert.deepEqual((await q(`select field_id from calendar.event_selected_fields where event_id = $1 order by position`, [byDefault.body.event.id])).map((r) => r.field_id), liveDefaults);
  assert.deepEqual((await changesOf(byDefault.body.event.id))[0].details.fieldIds, liveDefaults);

  const own = await newField(a.admin, { label: "Pitch", valueKind: "yes_no" });
  const explicit = await createEvent(a.admin.cookie, { ...base, fieldIds: [own.id, liveDefaults[0]] });
  assert.equal(explicit.status, 201, explicit.text);
  assert.deepEqual(explicit.body.event.fields.map((f) => f.fieldId), [own.id, liveDefaults[0]]);
  const none = await createEvent(a.admin.cookie, { ...base, fieldIds: [] });
  assert.deepEqual(none.body.event.fields, [], "an empty list is no details");

  const foreign = (await catalog(b.admin.cookie)).fields[0].id;
  const system = (await q(`select id from calendar.event_fields where owner_scope = 'system' order by sort_order limit 1`))[0].id;
  const refusals = [];
  for (const id of [foreign, gone, system, ZERO]) refusals.push(await createEvent(a.admin.cookie, { ...base, fieldIds: [own.id, id] }));
  for (const res of refusals) {
    assert.deepEqual([res.status, res.body.error], [400, "field_not_available"], res.text);
    assert.equal(res.text, refusals[0].text);
  }
  assert.equal((await createEvent(a.admin.cookie, { ...base, fieldIds: [own.id, own.id] })).body.error, "invalid_fields");
  assert.equal((await createEvent(a.admin.cookie, { ...base, fieldIds: Array.from({ length: 31 }, () => ZERO) })).body.error, "invalid_fields");
  assert.equal((await createEvent(a.admin.cookie, { ...base, fieldIds: ["x"] })).body.error, "invalid_fields");

  // A private coach: the system set (by default and explicitly); a club's detail is refused.
  const coach = m.roles.privateCoach;
  const sysTypes = (await api("/api/calendar/events/types", { cookie: coach.cookie })).body.types;
  const sysMatch = sysTypes.find((t) => t.key === "match");
  const sysDefaults = (await q(`select field_id from calendar.event_type_fields where event_type_id = $1 order by position`, [sysMatch.id])).map((r) => r.field_id);
  const target = [{ kind: "athlete", id: m.athletes.ownAthlete.athleteId }];
  const priv = await createEvent(coach.cookie, { eventTypeId: sysMatch.id, title: "Private match", targets: target });
  assert.equal(priv.status, 201, priv.text);
  assert.deepEqual(priv.body.event.fields.map((f) => f.fieldId), sysDefaults);
  assert.deepEqual((await createEvent(coach.cookie, { eventTypeId: sysMatch.id, title: "x", targets: target, fieldIds: [system] })).status, 201);
  assert.equal((await createEvent(coach.cookie, { eventTypeId: sysMatch.id, title: "x", targets: target, fieldIds: [own.id] })).body.error, "field_not_available");
});

// ---------------------------------------------------------------------------
// 3. Edit
// ---------------------------------------------------------------------------
test("3. edit: the place changed, swapped for the text and back, cleared; the list rewritten by difference; a type change keeps the list; stale and cancelled refused", async () => {
  const a = await freshClub("edit");
  const p1 = await newPlace(a.admin, "Hall one");
  const p2 = await newPlace(a.admin, "Hall two");
  const p3 = await newPlace(a.admin, "Hall three");
  const f1 = await newField(a.admin, { label: "One", valueKind: "yes_no" });
  const f2 = await newField(a.admin, { label: "Two", valueKind: "short_text" });
  const f3 = await newField(a.admin, { label: "Three", valueKind: "yes_no" });
  const f4 = await newField(a.admin, { label: "Four", valueKind: "yes_no" });
  let event = await clubEvent(a, { locationId: p1.id, fieldIds: [f1.id, f2.id, f3.id] });

  let res = await patchEvent(a.admin.cookie, event, { locationId: p2.id });
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.equal(event.place.locationId, p2.id);
  assert.deepEqual((await changesOf(event.id)).at(-1).details.locationId, [p1.id, p2.id]);
  res = await patchEvent(a.admin.cookie, event, { location: "Gym" });
  event = res.body.event;
  assert.deepEqual([event.place, event.locationId], [{ source: "one_off", text: "Gym" }, null]);
  res = await patchEvent(a.admin.cookie, event, { locationId: p1.id });
  event = res.body.event;
  assert.deepEqual([event.place.locationId, event.location], [p1.id, null], "a place replaces the text");
  assert.equal((await patchEvent(a.admin.cookie, event, { locationId: p2.id, location: "Both" })).body.error, "invalid_location");

  // A kept place may be archived; a new archived one is refused.
  assert.equal((await send(a.admin.cookie, "POST", `/locations/${p1.id}/archive`, { expectedRevision: 1 })).status, 200);
  assert.equal((await send(a.admin.cookie, "POST", `/locations/${p3.id}/archive`, { expectedRevision: 1 })).status, 200);
  res = await patchEvent(a.admin.cookie, event, { title: "Renamed" });
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.equal(event.place.locationId, p1.id, "an archived place the event has stays");
  res = await patchEvent(a.admin.cookie, event, { locationId: p1.id });
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.equal((await patchEvent(a.admin.cookie, event, { locationId: p3.id })).body.error, "location_not_available");
  res = await patchEvent(a.admin.cookie, event, { locationId: null });
  event = res.body.event;
  assert.equal(event.place, null);

  // The list: a value on f2; f1 archived and kept; f2 taken off (its value stays); positions follow.
  res = await setValues(a.admin.cookie, event, [{ fieldId: f2.id, value: "Kept answer" }]);
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.equal((await send(a.admin.cookie, "POST", `/fields/${f1.id}/archive`, { expectedRevision: 1 })).status, 200);
  assert.equal((await send(a.admin.cookie, "POST", `/fields/${f4.id}/archive`, { expectedRevision: 1 })).status, 200);
  res = await patchEvent(a.admin.cookie, event, { fieldIds: [f3.id, f1.id] });
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.deepEqual(event.fields.map((f) => f.fieldId), [f3.id, f1.id]);
  assert.equal(event.fields[1].archived, true);
  assert.deepEqual((await q(`select field_id, position from calendar.event_selected_fields where event_id = $1 order by position`, [event.id])).map((r) => [r.field_id, r.position]), [[f3.id, 0], [f1.id, 1]]);
  assert.equal((await q(`select count(*)::int as n from calendar.event_field_values where event_id = $1 and field_id = $2`, [event.id, f2.id]))[0].n, 1, "a value is never deleted");
  const last = (await changesOf(event.id)).at(-1).details;
  assert.deepEqual([last.fieldIdsBefore, last.fieldIdsAfter], [[f1.id, f2.id, f3.id], [f3.id, f1.id]]);
  res = await patchEvent(a.admin.cookie, event, { fieldIds: [f3.id, f1.id, f2.id] });
  event = res.body.event;
  assert.equal(valueOf(event, f2.id), "Kept answer", "chosen again, its value shows again");
  assert.equal((await patchEvent(a.admin.cookie, event, { fieldIds: [f3.id, f4.id] })).body.error, "field_not_available", "an archived detail is not newly chosen");

  // A type change keeps the list (18.7).
  const cat = await catalog(a.admin.cookie);
  res = await patchEvent(a.admin.cookie, event, { eventTypeId: typeOf(cat, "match").id });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.event.fields.map((f) => f.fieldId), event.fields.map((f) => f.fieldId));
  event = res.body.event;

  const stale = await patchEvent(a.admin.cookie, { ...event, revision: event.revision - 1 }, { fieldIds: [] });
  assert.deepEqual([stale.status, stale.body.error], [409, "event_changed"]);
  assert.equal((await ev(a.admin.cookie, "POST", `/${event.id}/cancel`, { expectedRevision: event.revision, reason: "Rain" })).status, 200);
  const cancelled = await patchEvent(a.admin.cookie, { ...event, revision: event.revision + 1 }, { fieldIds: [] });
  assert.deepEqual([cancelled.status, cancelled.body.error], [409, "event_cancelled"]);
  assert.equal((await q(`select count(*)::int as n from calendar.event_selected_fields where event_id = $1`, [event.id]))[0].n, 3, "a cancelled event keeps its list");
});

// ---------------------------------------------------------------------------
// 4-5. Values
// ---------------------------------------------------------------------------
test("4. values: each kind by its rule, a hidden option kept but never newly chosen, null clears and the row stays, a detail not chosen is the one 400; replay, reuse, stale, cancelled", async () => {
  const a = await freshClub("values");
  const choice = await newField(a.admin, { label: "Pitch quality", valueKind: "choice", options: ["Good", "Fair", "Poor"] });
  const other = await newField(a.admin, { label: "Mood", valueKind: "choice", options: ["Up", "Down"] });
  const number = await newField(a.admin, { label: "Wind", valueKind: "number", unit: "km/h", minValue: 0, maxValue: 200 });
  const scale = await newField(a.admin, { label: "Effort", valueKind: "scale_1_5" });
  const yes = await newField(a.admin, { label: "Floodlights", valueKind: "yes_no" });
  const text = await newField(a.admin, { label: "Opponent name", valueKind: "short_text" });
  const unchosen = await newField(a.admin, { label: "Not on it", valueKind: "yes_no" });
  let event = await clubEvent(a, { fieldIds: [choice.id, number.id, scale.id, yes.id, text.id, other.id] });
  const [good, fair, poor] = choice.options.map((o) => o.id);

  const ok = await setValues(a.admin.cookie, event, [
    { fieldId: choice.id, value: fair }, { fieldId: number.id, value: 12.5 }, { fieldId: scale.id, value: 3 },
    { fieldId: yes.id, value: true }, { fieldId: text.id, value: "  Rival FC  " },
  ]);
  assert.equal(ok.status, 200, ok.text);
  event = ok.body.event;
  assert.equal(event.revision, 2, "the event's revision is bumped");
  assert.deepEqual([valueOf(event, choice.id), valueOf(event, number.id), valueOf(event, scale.id), valueOf(event, yes.id), valueOf(event, text.id)], [fair, 12.5, 3, true, "Rival FC"]);
  const change = (await changesOf(event.id)).at(-1);
  assert.equal(change.kind, "set_fields");
  assert.deepEqual(change.details, { fieldIds: [choice.id, number.id, scale.id, yes.id, text.id].sort(), cleared: [] });
  assert.ok(!JSON.stringify(change.details).includes("Rival"), "the change row names no value");

  const refused = [
    [choice.id, other.options[0].id], [choice.id, "Fair"], [choice.id, 1],
    [number.id, 12.3456], [number.id, 201], [number.id, -1], [number.id, "12"], [number.id, 1e9],
    [scale.id, 6], [scale.id, 0], [scale.id, 2.5], [scale.id, "3"],
    [yes.id, "yes"], [yes.id, 1],
    [text.id, ""], [text.id, "   "], [text.id, "two\nlines"], [text.id, "x".repeat(201)], [text.id, 5], [text.id, "​"],
    [choice.id, { id: good }],
  ];
  for (const [fieldId, value] of refused) {
    const res = await setValues(a.admin.cookie, event, [{ fieldId, value }]);
    assert.deepEqual([res.status, res.body.error, res.body.fieldId], [400, "invalid_value", fieldId], `${JSON.stringify(value)}: ${res.text}`);
  }
  assert.equal((await q(`select revision from calendar.events where id = $1`, [event.id]))[0].revision, 2, "no refusal wrote anything");

  // A hidden option: the value that has it stays and is still named; it is never newly chosen.
  const hidden = await send(a.admin.cookie, "PATCH", `/fields/${choice.id}`, { expectedRevision: choice.revision, options: { hide: [fair] } });
  assert.equal(hidden.status, 200, hidden.text);
  const view = (await getEvent(a.admin.cookie, event.id)).body.event;
  const shown = view.fields.find((f) => f.fieldId === choice.id).options;
  assert.deepEqual(shown.map((o) => [o.id, o.hidden]), [[good, false], [fair, true], [poor, false]], "the live options plus the hidden one a value names");
  let res = await setValues(a.admin.cookie, event, [{ fieldId: choice.id, value: fair }]);
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  res = await setValues(a.admin.cookie, event, [{ fieldId: choice.id, value: good }]);
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.equal(res.body.event.fields.find((f) => f.fieldId === choice.id).options.some((o) => o.id === fair), false, "a hidden option no value names is not listed");
  assert.equal((await setValues(a.admin.cookie, event, [{ fieldId: choice.id, value: fair }])).body.error, "invalid_value", "a hidden option is never newly chosen");

  // null clears; the row stays with every column null.
  res = await setValues(a.admin.cookie, event, [{ fieldId: text.id, value: null }, { fieldId: yes.id, value: false }]);
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.deepEqual([valueOf(event, text.id), valueOf(event, yes.id)], [null, false]);
  assert.deepEqual((await q(`select num_nonnulls(option_id, number_value, scale_value, bool_value, text_value) as n from calendar.event_field_values where event_id = $1 and field_id = $2`, [event.id, text.id]))[0], { n: 0 });
  assert.deepEqual((await changesOf(event.id)).at(-1).details.cleared, [text.id]);
  res = await setValues(a.admin.cookie, event, [{ fieldId: other.id, value: null }]);
  assert.equal(res.status, 200, res.text);
  event = res.body.event;
  assert.deepEqual((await changesOf(event.id)).at(-1).details.cleared, [], "a detail without a value is not named as cleared");
  assert.equal((await q(`select count(*)::int as n from calendar.event_field_values where event_id = $1 and field_id = $2`, [event.id, other.id]))[0].n, 0);

  // A detail not chosen on the event, a detail of another club, an unknown id: the one 400.
  const b = await freshClub("values other");
  const foreign = await newField(b.admin, { label: "Theirs", valueKind: "yes_no" });
  const notChosen = [];
  for (const id of [unchosen.id, foreign.id, ZERO]) notChosen.push(await setValues(a.admin.cookie, event, [{ fieldId: id, value: true }]));
  for (const r of notChosen) {
    assert.deepEqual([r.status, r.body.error], [400, "field_not_available"], r.text);
    assert.equal(r.text, notChosen[0].text);
  }

  // The body.
  assert.equal((await setValues(a.admin.cookie, event, [])).body.error, "invalid_values");
  assert.equal((await setValues(a.admin.cookie, event, [{ fieldId: yes.id, value: true }, { fieldId: yes.id, value: false }])).body.error, "invalid_values");
  assert.equal((await setValues(a.admin.cookie, event, [{ value: true }])).body.error, "invalid_values");
  assert.equal((await setValues(a.admin.cookie, event, Array.from({ length: 31 }, () => ({ fieldId: newKey(), value: true })))).body.error, "invalid_values");

  // Replay, reuse, stale.
  const key = newKey();
  const body = { requestKey: key, expectedRevision: event.revision, values: [{ fieldId: number.id, value: 40 }] };
  const first = await api(`/api/calendar/events/${event.id}/fields`, { method: "POST", cookie: a.admin.cookie, body });
  assert.equal(first.status, 200, first.text);
  const replay = await api(`/api/calendar/events/${event.id}/fields`, { method: "POST", cookie: a.admin.cookie, body });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.event.revision, first.body.event.revision);
  assert.equal((await q(`select count(*)::int as n from calendar.event_changes where event_id = $1 and kind = 'set_fields'`, [event.id]))[0].n, 6, "the replay wrote nothing");
  const reused = await api(`/api/calendar/events/${event.id}/fields`, { method: "POST", cookie: a.admin.cookie, body: { ...body, values: [{ fieldId: number.id, value: 41 }] } });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  event = first.body.event;
  const stale = await setValues(a.admin.cookie, { ...event, revision: event.revision - 1 }, [{ fieldId: number.id, value: 1 }]);
  assert.deepEqual([stale.status, stale.body.error], [409, "event_changed"]);
  assert.equal(stale.body.current.revision, event.revision);

  assert.equal((await ev(a.admin.cookie, "POST", `/${event.id}/cancel`, { expectedRevision: event.revision })).status, 200);
  const cancelled = await setValues(a.admin.cookie, { ...event, revision: event.revision + 1 }, [{ fieldId: number.id, value: 1 }]);
  assert.deepEqual([cancelled.status, cancelled.body.error], [409, "event_cancelled"]);
});

test("5. values: the event's managers only (D39) — the team coach on its team's event, the club admin also on its teams' (D18), the platform admin as support, a private coach on their own; everyone else the one 404", async () => {
  const { teams, roles } = m;
  const coachTypes = (await api("/api/calendar/events/types", { cookie: roles.teamCoach.cookie })).body.types;
  const training = coachTypes.find((t) => t.key === "training");
  const field = (await catalog(roles.clubAdmin.cookie)).fields.find((f) => f.valueKind === "yes_no" || f.valueKind === "number");
  const teamEvent = await createEvent(roles.teamCoach.cookie, { eventTypeId: training.id, title: "T1 session", targets: [{ kind: "team", id: teams.t1 }], fieldIds: [field.id] });
  assert.equal(teamEvent.status, 201, teamEvent.text);
  const clubEventRes = await createEvent(roles.clubAdmin.cookie, { eventTypeId: training.id, title: "C1 session", targets: [{ kind: "team", id: teams.t1 }], fieldIds: [field.id] });
  assert.equal(clubEventRes.status, 201, clubEventRes.text);
  const value = field.valueKind === "yes_no" ? true : field.minValue ?? 1;

  let current = teamEvent.body.event;
  for (const role of [roles.teamCoach, roles.clubAdmin, roles.platformAdmin, roles.platformInClub]) {
    const res = await setValues(role.cookie, current, [{ fieldId: field.id, value }]);
    assert.equal(res.status, 200, res.text);
    current = res.body.event;
  }
  const missing = await setValues(roles.clubAdmin.cookie, { id: ZERO, revision: 1 }, [{ fieldId: field.id, value }]);
  assert.equal(missing.status, 404);
  for (const role of [roles.stranger, roles.revokedAdmin, roles.privateCoach, roles.athlete, roles.archivedAdmin]) {
    const res = await setValues(role.cookie, current, [{ fieldId: field.id, value }]);
    assert.equal(res.status, 404, res.text);
    assert.equal(res.text, missing.text, "the one 404");
    assert.equal(res.cacheControl, "no-store");
  }
  // The team coach reads the club's event but does not manage it.
  const onClub = await setValues(roles.teamCoach.cookie, clubEventRes.body.event, [{ fieldId: field.id, value }]);
  assert.equal(onClub.status, 404, onClub.text);
  assert.equal(onClub.text, missing.text);

  const coach = roles.privateCoach;
  const sysType = (await api("/api/calendar/events/types", { cookie: coach.cookie })).body.types.find((t) => t.key === "match");
  const priv = await createEvent(coach.cookie, { eventTypeId: sysType.id, title: "Own", targets: [{ kind: "athlete", id: m.athletes.ownAthlete.athleteId }] });
  assert.equal(priv.status, 201, priv.text);
  const opponent = priv.body.event.fields.find((f) => f.valueKind === "short_text");
  assert.equal((await setValues(coach.cookie, priv.body.event, [{ fieldId: opponent.fieldId, value: "Rivals" }])).status, 200);
  assert.equal((await setValues(roles.clubAdmin.cookie, priv.body.event, [{ fieldId: opponent.fieldId, value: "x" }])).status, 404);
});

// ---------------------------------------------------------------------------
// 6-7. Reads and the status
// ---------------------------------------------------------------------------
test("6. reads: the card's place and line, the manager's details counts; the reduced view and the athlete get the place, never a detail (T7)", async () => {
  const { roles, teams } = m;
  const admin = roles.clubAdmin;
  const place = await newPlace(admin, `Read ground ${uid()}`, { address: "5 Read Road", note: "North gate" });
  const required = await newField(admin, { label: `Secret required ${uid()}`, valueKind: "yes_no", required: true });
  const optional = await newField(admin, { label: `Secret optional ${uid()}`, valueKind: "short_text" });
  const training = (await catalog(admin.cookie)).types.find((t) => t.key === "training");
  const created = await createEvent(admin.cookie, { eventTypeId: training.id, title: "Read me", targets: [{ kind: "team", id: teams.t1 }], locationId: place.id, fieldIds: [required.id, optional.id] });
  assert.equal(created.status, 201, created.text);
  const filled = await setValues(admin.cookie, created.body.event, [{ fieldId: optional.id, value: "Secret answer" }]);
  assert.equal(filled.status, 200, filled.text);
  const id = created.body.event.id;
  const expectedPlace = { source: "library", locationId: place.id, name: place.name, address: "5 Read Road", note: "North gate" };

  const [managerCard] = cardsOf(await calendarOf(admin.cookie), id);
  assert.deepEqual(managerCard.place, expectedPlace);
  assert.equal(managerCard.location, place.name, "the K2a-2 line names the place");
  assert.deepEqual(managerCard.details, { selected: 2, filled: 1, required: 1, filledRequired: 0 });

  const coachRes = await calendarOf(roles.teamCoach.cookie);
  const [coachCard] = cardsOf(coachRes, id);
  assert.ok(coachCard, "the team coach reads the club's event on its team");
  assert.equal(coachCard.canManage, false);
  assert.deepEqual(coachCard.place, expectedPlace);
  assert.equal("details" in coachCard, false, "no details on a card the reader does not manage");
  const reduced = await getEvent(roles.teamCoach.cookie, id);
  assert.equal(reduced.status, 200, reduced.text);
  assert.deepEqual(reduced.body.event.place, expectedPlace);
  assert.equal("fields" in reduced.body.event, false, "the reduced view holds no details (T7)");

  const athleteRes = await calendarOf(m.athletes.athlete.cookie);
  const [athleteCard] = cardsOf(athleteRes, id);
  assert.ok(athleteCard, "the athlete reads the event of their team");
  assert.deepEqual(athleteCard.place, expectedPlace);
  assert.deepEqual(Object.keys(athleteCard).sort(), ["cancelled", "date", "endTime", "eventKind", "eventTypeLabel", "key", "kind", "links", "location", "place", "span", "startTime", "status", "teamIds", "title"]);
  for (const text of [coachRes.text, reduced.text, athleteRes.text]) {
    for (const secret of [required.id, optional.id, required.label, optional.label, "Secret answer"]) assert.ok(!text.includes(secret), `no detail reaches a non-manager (${secret})`);
  }

  const view = (await getEvent(admin.cookie, id)).body.event;
  assert.deepEqual(view.place, expectedPlace);
  assert.deepEqual(view.fields.map((f) => [f.fieldId, f.label, f.valueKind, f.required, f.value]), [
    [required.id, required.label, "yes_no", true, null],
    [optional.id, optional.label, "short_text", false, "Secret answer"],
  ]);
});

test("7. status (D31): a required detail without a value awaits after the event's last day, on a manager's card only; optional details never count; before the last day and cancelled as before", async () => {
  const a = await freshClub("status");
  const coach = await env.fx.coachOf(a.teamId, "status coach");
  const required = await newField(a.admin, { label: "Score sheet", valueKind: "yes_no", required: true });
  const optional = await newField(a.admin, { label: "Notes line", valueKind: "short_text" });
  const training = typeOf(await catalog(a.admin.cookie), "training");
  const make = async (extra) => {
    const res = await createEvent(a.admin.cookie, { eventTypeId: training.id, title: `S ${uid()}`, targets: [{ kind: "team", id: a.teamId }], expects: [], ...extra });
    assert.equal(res.status, 201, res.text);
    return res.body.event;
  };
  const statusOf = async (cookie, event, date) => cardsOf(await calendarOf(cookie), event.id).find((c) => c.date === date)?.status;

  const past = await make({ day: PAST, fieldIds: [required.id, optional.id] });
  assert.equal(await statusOf(a.admin.cookie, past, PAST), "awaiting_entry", "an unmet required detail after the last day");
  assert.equal(await statusOf(coach.cookie, past, PAST), "none", "a reader who does not manage it sees no detail check");
  const filled = await setValues(a.admin.cookie, past, [{ fieldId: required.id, value: false }]);
  assert.equal(filled.status, 200, filled.text);
  assert.equal(await statusOf(a.admin.cookie, past, PAST), "done", "filled (false is a value)");

  const optionalOnly = await make({ day: PAST, fieldIds: [optional.id] });
  assert.equal(await statusOf(a.admin.cookie, optionalOnly, PAST), "none", "optional details never change the status");
  const future = await make({ day: FUTURE, fieldIds: [required.id] });
  assert.equal(await statusOf(a.admin.cookie, future, FUTURE), "planned", "an event that expects nothing waits for its required detail");
  const running = await make({ day: PAST, endDay: FUTURE, fieldIds: [required.id] });
  assert.equal(await statusOf(a.admin.cookie, running, PAST), "planned", "judged only after the event's LAST day");
  const cleared = await make({ day: PAST, fieldIds: [required.id] });
  const set = await setValues(a.admin.cookie, cleared, [{ fieldId: required.id, value: true }]);
  const unset = await setValues(a.admin.cookie, set.body.event, [{ fieldId: required.id, value: null }]);
  assert.equal(unset.status, 200, unset.text);
  assert.equal(await statusOf(a.admin.cookie, cleared, PAST), "awaiting_entry", "a cleared value is no value");
  const gone = await make({ day: PAST, fieldIds: [required.id] });
  assert.equal((await ev(a.admin.cookie, "POST", `/${gone.id}/cancel`, { expectedRevision: gone.revision })).status, 200);
  assert.equal(await statusOf(a.admin.cookie, gone, PAST), "cancelled");
});

// ---------------------------------------------------------------------------
// 8. D41 and finding 6
// ---------------------------------------------------------------------------
test("8. D41 and finding 6: after a team moves, club B sees nothing of club A's place, details or values anywhere; B's next edit detaches and clears (flags only); A's values stay", async () => {
  const a = await freshClub("move A");
  const b = await freshClub("move B");
  // Only a team without memberships moves (a membership's (team, club) key
  // and its immutability), so no athlete reads a moved team's events today;
  // the athlete's card takes the place from the coach card's statement (6).
  const coach = await env.fx.coachOf(a.teamId, "move coach");
  const placeA = await newPlace(a.admin, `A ground ${uid()}`, { address: "A street 1" });
  const reqA = await newField(a.admin, { label: `A required ${uid()}`, valueKind: "yes_no", required: true });
  const optA = await newField(a.admin, { label: `A optional ${uid()}`, valueKind: "short_text" });
  const training = typeOf(await catalog(a.admin.cookie), "training");
  const mk = async (title, day = FUTURE) => {
    const res = await createEvent(coach.cookie, { eventTypeId: training.id, title, day, targets: [{ kind: "team", id: a.teamId }], locationId: placeA.id, fieldIds: [reqA.id, optA.id] });
    assert.equal(res.status, 201, res.text);
    const v = await setValues(coach.cookie, res.body.event, [{ fieldId: optA.id, value: "A secret answer" }]);
    assert.equal(v.status, 200, v.text);
    return v.body.event;
  };
  const event = await mk("Moved");
  const second = await mk("Moved too");
  const gone = await mk("Moved and cancelled");
  assert.equal((await ev(coach.cookie, "POST", `/${gone.id}/cancel`, { expectedRevision: gone.revision })).status, 200);

  await q(`update public.teams set club_id = $2 where id = $1`, [a.teamId, b.clubId]);
  const secrets = [placeA.id, placeA.name, "A street 1", reqA.id, optA.id, reqA.label, optA.label, "A secret answer"];
  const clean = (text, where) => { for (const s of secrets) assert.ok(!text.includes(s), `${where}: nothing of club A (${s})`); };

  const calB = await calendarOf(b.admin.cookie);
  const [cardB] = cardsOf(calB, event.id);
  assert.ok(cardB, "club B manages its moved team's event");
  assert.equal(cardB.canManage, true);
  assert.deepEqual([cardB.place, cardB.location], [null, null]);
  assert.deepEqual(cardB.details, { selected: 0, filled: 0, required: 0, filledRequired: 0 }, "no count of A's details");
  clean(calB.text, "B's calendar");
  const viewB = await getEvent(b.admin.cookie, event.id);
  assert.equal(viewB.status, 200, viewB.text);
  assert.deepEqual([viewB.body.event.place, viewB.body.event.locationId, viewB.body.event.fields], [null, null, []]);
  clean(viewB.text, "B's view");
  const calCoach = await calendarOf(coach.cookie);
  assert.deepEqual(cardsOf(calCoach, event.id)[0].details, { selected: 0, filled: 0, required: 0, filledRequired: 0 });
  clean(calCoach.text, "the team coach's calendar");

  // B's values command on A's detail: the one 400 of a detail not chosen.
  const onA = await setValues(b.admin.cookie, event, [{ fieldId: optA.id, value: "B writes" }]);
  const unknown = await setValues(b.admin.cookie, event, [{ fieldId: ZERO, value: "B writes" }]);
  assert.deepEqual([onA.status, onA.body.error], [400, "field_not_available"]);
  assert.equal(onA.text, unknown.text);
  // A's place sent back by B is a new place, refused (the edit writes nothing).
  const backA = await patchEvent(b.admin.cookie, event, { locationId: placeA.id });
  assert.deepEqual([backA.status, backA.body.error], [400, "location_not_available"]);
  assert.equal((await q(`select count(*)::int as n from calendar.event_selected_fields where event_id = $1`, [event.id]))[0].n, 2, "a refused edit detaches nothing");

  // A refusal's `current` shows nothing of A either (and detaches nothing).
  const stale = await patchEvent(b.admin.cookie, { ...event, revision: event.revision - 1 }, { title: "Stale" });
  assert.deepEqual([stale.status, stale.body.error], [409, "event_changed"]);
  clean(stale.text, "a 409's current");

  // B's next edit, whatever it changes (T8): detached and cleared, audited by flags only.
  const editBody = { requestKey: newKey(), expectedRevision: event.revision, title: "Renamed by B" };
  const edit = await api(`/api/calendar/events/${event.id}`, { method: "PATCH", cookie: b.admin.cookie, body: editBody });
  assert.equal(edit.status, 200, edit.text);
  clean(edit.text, "the edit's answer");
  const editReplay = await api(`/api/calendar/events/${event.id}`, { method: "PATCH", cookie: b.admin.cookie, body: editBody });
  assert.equal(editReplay.status, 200, editReplay.text);
  clean(editReplay.text, "the edit's replay");
  assert.deepEqual((await q(`select location_id from calendar.events where id = $1`, [event.id]))[0], { location_id: null });
  assert.equal((await q(`select count(*)::int as n from calendar.event_selected_fields where event_id = $1`, [event.id]))[0].n, 0);
  assert.equal((await q(`select count(*)::int as n from calendar.event_field_values where event_id = $1`, [event.id]))[0].n, 1, "A's value is never deleted");
  const details = (await changesOf(event.id)).at(-1).details;
  assert.equal(details.foreignFieldsDetached, 2);
  assert.equal(details.foreignPlaceCleared, true);
  clean(JSON.stringify(details), "the change row");
  assert.equal((await catalog(a.admin.cookie)).fields.find((f) => f.id === optA.id).answered, true, "A's detail stays answered");

  // B chooses its own.
  const placeB = await newPlace(b.admin, "B ground");
  const fieldB = await newField(b.admin, { label: "B detail", valueKind: "yes_no" });
  const own = await patchEvent(b.admin.cookie, edit.body.event, { locationId: placeB.id, fieldIds: [fieldB.id] });
  assert.equal(own.status, 200, own.text);
  assert.deepEqual([own.body.event.place.locationId, own.body.event.fields.map((f) => f.fieldId)], [placeB.id, [fieldB.id]]);
  assert.equal((await setValues(b.admin.cookie, own.body.event, [{ fieldId: fieldB.id, value: true }])).status, 200);

  // The platform admin as support normalizes the same way.
  const support = await patchEvent(m.roles.platformAdmin.cookie, second, { notes: "Support" });
  assert.equal(support.status, 200, support.text);
  const supportDetails = (await changesOf(second.id)).at(-1).details;
  assert.deepEqual([supportDetails.foreignFieldsDetached, supportDetails.foreignPlaceCleared], [2, true]);

  // A cancelled event stays as it is, hidden on every read.
  const cancelledView = await getEvent(b.admin.cookie, gone.id);
  assert.deepEqual([cancelledView.body.event.place, cancelledView.body.event.fields], [null, []]);
  clean(cancelledView.text, "the cancelled event");
  const onCancelled = await patchEvent(b.admin.cookie, { ...gone, revision: gone.revision + 1 }, { title: "Too late" });
  assert.deepEqual([onCancelled.status, onCancelled.body.error], [409, "event_cancelled"]);
  clean(onCancelled.text, "the cancelled event's 409");
  assert.equal((await q(`select count(*)::int as n from calendar.event_selected_fields where event_id = $1`, [gone.id]))[0].n, 2);
});

// ---------------------------------------------------------------------------
// 9. Races
// ---------------------------------------------------------------------------
test("9. races: a value against a detail's edit in both orders, a place archived while an edit sets it, the same key twice at once", async () => {
  const a = await freshClub("race");
  const hooks = settingsService.testHooks;
  const eventHooks = eventService.testHooks;
  // Order 1: the detail's edit holds the detail; the value waits and is judged by the new bounds.
  const wind = await newField(a.admin, { label: "Wind race", valueKind: "number", minValue: 0, maxValue: 200 });
  let event = await clubEvent(a, { fieldIds: [wind.id] });
  let gate = pause(hooks, "beforeCommit", "field_update");
  const narrowing = send(a.admin.cookie, "PATCH", `/fields/${wind.id}`, { expectedRevision: 1, maxValue: 10 });
  await gate.arrived;
  const value = setValues(a.admin.cookie, event, [{ fieldId: wind.id, value: 50 }]);
  await waitForLockWait();
  gate.release();
  assert.equal((await narrowing).status, 200);
  const late = await value;
  assert.deepEqual([late.status, late.body.error, late.body.fieldId], [400, "invalid_value", wind.id], late.text);

  // Order 2: the value holds the detail; the edit waits and finds it answered.
  gate = pause(eventHooks, "beforeCommit", "set_fields");
  const first = setValues(a.admin.cookie, event, [{ fieldId: wind.id, value: 5 }]);
  await gate.arrived;
  const widening = send(a.admin.cookie, "PATCH", `/fields/${wind.id}`, { expectedRevision: 2, maxValue: 100 });
  await waitForLockWait();
  gate.release();
  const written = await first;
  assert.equal(written.status, 200, written.text);
  const refused = await widening;
  assert.deepEqual([refused.status, refused.body.error], [409, "field_answered"], refused.text);
  event = written.body.event;

  // A place archived while an edit sets it: the edit waits and is refused.
  const place = await newPlace(a.admin, "Race hall");
  gate = pause(hooks, "beforeCommit", "location_archive");
  const archiving = send(a.admin.cookie, "POST", `/locations/${place.id}/archive`, { expectedRevision: 1 });
  await gate.arrived;
  const setting = patchEvent(a.admin.cookie, event, { locationId: place.id });
  await waitForLockWait();
  gate.release();
  assert.equal((await archiving).status, 200);
  const placeRes = await setting;
  assert.deepEqual([placeRes.status, placeRes.body.error], [400, "location_not_available"], placeRes.text);

  // A default detail archived while a create copies the type's list: the
  // create waits and leaves it out (never a 500).
  const cat = await catalog(a.admin.cookie);
  const match = typeOf(cat, "match");
  const firstDefault = cat.fields.find((f) => f.id === match.fieldIds[0]);
  gate = pause(hooks, "beforeCommit", "field_archive");
  const archivingDetail = send(a.admin.cookie, "POST", `/fields/${firstDefault.id}/archive`, { expectedRevision: firstDefault.revision });
  await gate.arrived;
  const creating = createEvent(a.admin.cookie, { eventTypeId: match.id, title: "Defaults race", targets: [{ kind: "club", id: a.clubId }] });
  await waitForLockWait();
  gate.release();
  assert.equal((await archivingDetail).status, 200);
  const created = await creating;
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.body.event.fields.map((f) => f.fieldId), match.fieldIds.slice(1), "the archived default left out, the order kept");

  // The same key twice at once: one write and one replay.
  const body = { requestKey: newKey(), expectedRevision: event.revision, values: [{ fieldId: wind.id, value: 6 }] };
  const [x, y] = await Promise.all([0, 1].map(() => api(`/api/calendar/events/${event.id}/fields`, { method: "POST", cookie: a.admin.cookie, body })));
  assert.deepEqual([x.status, y.status], [200, 200], `${x.text} ${y.text}`);
  assert.equal(x.body.event.revision, y.body.event.revision);
  assert.equal((await q(`select count(*)::int as n from calendar.event_changes where event_id = $1 and kind = 'set_fields'`, [event.id]))[0].n, 2);
});

// ---------------------------------------------------------------------------
// 10. No write on a read; bounded statements
// ---------------------------------------------------------------------------
test("10. a read writes nothing, and the number of statements of the calendar does not depend on the number of events with places and details", async () => {
  const tables = ["calendar.events", "calendar.event_selected_fields", "calendar.event_field_values", "calendar.locations", "calendar.event_fields",
    "calendar.event_requests", "calendar.event_changes"];
  const digests = async () => {
    const out = {};
    for (const t of tables) out[t] = (await q(`select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as d from ${t} x`))[0];
    return out;
  };
  const small = await freshClub("count small");
  const large = await freshClub("count large");
  for (const [c, n] of [[small, 1], [large, 12]]) {
    const place = await newPlace(c.admin, "Count hall");
    const field = await newField(c.admin, { label: "Count detail", valueKind: "yes_no", required: true });
    for (let i = 0; i < n; i += 1) {
      const e = await clubEvent(c, { day: addDays(TODAY, (i % 5) - 2), locationId: place.id, fieldIds: [field.id] });
      if (i % 2 === 0) assert.equal((await setValues(c.admin.cookie, e, [{ fieldId: field.id, value: true }])).status, 200);
    }
  }
  const before = await digests();
  const pool = env.appPool;
  const original = pool.query;
  let count = 0;
  pool.query = function counted(...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    count = 0;
    assert.equal((await calendarOf(small.admin.cookie)).status, 200);
    const smallCount = count;
    assert.ok(smallCount > 0);
    count = 0;
    const res = await calendarOf(large.admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(new Set((res.body.days || []).flatMap((d) => d.items).filter((i) => i.kind === "event").map((i) => i.eventId)).size, 12);
    assert.equal(count, smallCount, `the same number of statements for 1 and for 12 events (${smallCount})`);
  } finally {
    pool.query = original;
  }
  const anyEvent = (await q(`select id from calendar.events where owner_club_id = $1 limit 1`, [large.clubId]))[0].id;
  for (const cookie of [large.admin.cookie, m.roles.teamCoach.cookie, m.athletes.athlete.cookie]) {
    await calendarOf(cookie);
    await getEvent(cookie, anyEvent);
    await api("/api/calendar/events/types", { cookie });
  }
  assert.deepEqual(await digests(), before, "no read wrote a row");
});
