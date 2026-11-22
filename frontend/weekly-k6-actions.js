// K6-2 / K6-3 (docs/ai/central-calendar-k6-contract.md, sections 3 and 4): the Weekly plan's athlete switcher flow.
// The flow lives in `state.centralCalendar.weeklyFlow` (the calendar's slice, replaced on a workspace change, so
// nothing of it crosses a workspace); it exists only while the plan was opened from the calendar. Moving to
// another athlete pushes NO history entry (Q6): it replaces the athlete, the week and day are kept, and the open
// node path is rebuilt in the other athlete's own plan (weekly-k6.js).
import { buildCentralCalendarSwitcherModel, centralCalendarEventAthletes } from "./central-calendar-switcher.js";
import { readAthleteStripHidden, writeAthleteStripHidden } from "./athlete-strip-pref.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { captureWeeklyPlace, matchWeeklyPlace, renderWeeklySwitcherHtml, slotPathFor, slotWords, weeklyDayItems } from "./weekly-k6.js";

const rosterRows = () => (state.athletes || []).filter((row) => row?.athlete_uuid);
const rowByUuid = (key) => rosterRows().find((row) => String(row.athlete_uuid) === String(key)) || null;
const rowImage = (row) => row?.athlete_image_url || row?.image_url || "";

export function weeklyRosterIdOf(athleteUuid) {
  const row = rowByUuid(athleteUuid);
  return row ? String(row.athlete_id) : "";
}

function uuidOfRosterId(rosterId) {
  const row = rosterRows().find((entry) => String(entry.athlete_id) === String(rosterId));
  return row ? String(row.athlete_uuid) : "";
}

// The flow, only while the athlete shown is the one it names (a click on another athlete in the rail ends it).
export function activeWeeklyFlow() {
  const cal = state.centralCalendar;
  const flow = cal?.weeklyFlow;
  if (!flow) return null;
  if (state.activeTab !== "weekly" || uuidOfRosterId(state.selectedAthleteId) !== flow.currentKey) {
    if (state.activeTab !== "weekly" || !flow.busy) cal.weeklyFlow = null;
    return flow.busy ? flow : null;
  }
  return flow;
}

// The athletes the calendar's switcher shows for its current choice, as the strip's list (K6-1, 2.3).
function calendarListKeys(cal) {
  const model = buildCentralCalendarSwitcherModel(cal);
  if (!model || model.type === "platform") return [];
  const list = model.strip && model.strip.length ? model.strip : model.searchList;
  return (list || []).map((item) => item.key);
}

// The plan was opened from the calendar's panel or "Open the week": the list is the calendar's strip for the chosen
// team (3.1). Returns the flow to hand to the opener (null when there is nothing to switch between).
export function weeklyFlowFromCalendar(athleteUuid) {
  const cal = state.centralCalendar;
  let keys = calendarListKeys(cal);
  if (!keys.includes(athleteUuid)) keys = keys.length ? [...keys, athleteUuid] : [athleteUuid];
  return { keys, currentKey: athleteUuid, eventKey: "", eventTitle: "", slot: null, notInKeys: [], notInLine: "", hiddenCount: 0, line: "", kept: "", busy: false };
}

// K6 follow-up (PR2): a flow whose list is NOT the calendar's strip - the athletes of one panel item on one day, or
// Coach Home's athletes with a session on the shown day. The list is only ever what that screen already shows the coach,
// intersected with the roster (`state.athletes`), so no athlete the roster does not return can be in it. `listLabel`
// says what the list is ("in this event", "planned on this day", "with a session on this day"); `origin` is where
// *Back* goes ("calendar" by default, "home"). Returns null when the chosen athlete is not in the roster list.
function listFlow(keys, currentKey, { listLabel, origin, scopeNote = "" }) {
  const roster = new Set(rosterRows().map((row) => String(row.athlete_uuid)));
  const kept = [...new Set((keys || []).map(String))].filter((key) => roster.has(key));
  if (!kept.includes(String(currentKey))) return null;
  return { keys: kept, currentKey: String(currentKey), eventKey: "", eventTitle: "", slot: null, notInKeys: [], notInLine: "", hiddenCount: 0, line: "", kept: "", busy: false, listLabel, origin, scopeNote };
}

// An athlete's row in the open panel: the switcher holds the athletes of THAT item on THAT day (the panel's own list,
// roster-intersected as See each athlete does). Without such a list the calendar's own strip, as before.
export function weeklyFlowFromPanel(athleteUuid, item) {
  const cal = state.centralCalendar;
  const event = centralCalendarEventAthletes(cal);
  const kind = item?.kind;
  const listLabel = kind === "event" ? "in this event" : kind === "activity" ? "recorded in this session" : "planned on this day";
  const scopeNote = kind === "event" ? "Only the athletes of this event are listed. Back shows everyone." : "Only the athletes of this item on this day are listed. Back shows everyone.";
  const flow = event ? listFlow(event.listed.filter((entry) => entry.targeted).map((entry) => entry.key), athleteUuid, { listLabel, origin: "calendar", scopeNote }) : null;
  return flow || weeklyFlowFromCalendar(athleteUuid);
}

// Coach Home's shown day: the athletes with a session that day (`keys`, already the day's rows). One athlete alone
// needs no switcher (null).
export function weeklyFlowFromHome(keys, athleteUuid) {
  const flow = listFlow(keys, athleteUuid, { listLabel: "with a session on this day", origin: "home", scopeNote: "Only the athletes with a session on this day are listed. Back shows everyone." });
  return flow && flow.keys.length > 1 ? flow : null;
}

const fixedList = (flow) => Boolean(flow.eventKey || flow.listLabel);

function stripItems(flow, cal) {
  const model = buildCentralCalendarSwitcherModel(cal);
  const pairs = cal.switcher?.org?.status === "ready" ? cal.switcher.org.pairs : [];
  const teams = cal.data?.teams || [];
  const items = [];
  for (const key of flow.keys) {
    const row = rowByUuid(key);
    if (!row) continue;
    const dot = model?.type === "club" && !fixedList(flow) ? pairs.find((pair) => pair.athleteUuid === key) : null;
    items.push({
      key, name: String(row.athlete || "Athlete"), imageUrl: rowImage(row),
      notInSession: Boolean(flow.eventKey) && flow.notInKeys.includes(key),
      teamId: dot?.teamId || "",
    });
  }
  return { items, model, teams };
}

function teamLabelFor(flow, cal, model) {
  if (fixedList(flow) || model?.type !== "club") return "";
  const teams = cal.data?.teams || [];
  const chosen = (cal.filters?.teamIds || [])[0] || "";
  if (chosen) return teams.find((team) => String(team.teamId) === chosen)?.name || "";
  const pair = (cal.switcher?.org?.pairs || []).find((entry) => entry.athleteUuid === flow.currentKey);
  return pair ? teams.find((team) => String(team.teamId) === pair.teamId)?.name || "" : "";
}

function groupsHtml(flow, cal, model) {
  if (fixedList(flow) || model?.type !== "club" || (cal.data?.teams || []).length < 2) return "";
  const chosen = (cal.filters?.teamIds || [])[0] || "";
  const chip = (teamId, label, active) => `<button type="button" class="cc-chip${active ? " is-active" : ""}" data-action="weekly-k6-group"${teamId ? ` data-team-id="${escapeAttr(teamId)}"` : ""} aria-pressed="${active ? "true" : "false"}"><span class="cc-chip-label">${escapeHtml(label)}</span></button>`;
  return `<div class="cc-chip-row" role="group" aria-label="Groups"><span class="cc-chip-row-label">Groups</span>${chip("", "All groups", !chosen)}${cal.data.teams.map((team) => chip(String(team.teamId), team.name, chosen === String(team.teamId))).join("")}</div>`;
}

// K6 follow-up: hide / show the strip, remembered per user. Read once per flow from the preference.
function weeklyStripHidden(flow) {
  if (typeof flow.stripHidden !== "boolean") flow.stripHidden = readAthleteStripHidden("weekly", state.currentUser?.id);
  return flow.stripHidden;
}

export function toggleWeeklyStrip() {
  const flow = activeWeeklyFlow();
  if (!flow) return false;
  flow.stripHidden = !weeklyStripHidden(flow);
  writeAthleteStripHidden("weekly", state.currentUser?.id, flow.stripHidden);
  return true;
}

// The header drawn above the week and above every node view; "" when there is no flow.
export function renderWeeklyK6Html({ noPlan = false } = {}) {
  const flow = activeWeeklyFlow();
  if (!flow) return "";
  const cal = state.centralCalendar;
  const { items, model } = stripItems(flow, cal);
  const hidden = flow.hiddenCount > 0 ? `${flow.hiddenCount} athlete${flow.hiddenCount === 1 ? "" : "s"} of this event ${flow.hiddenCount === 1 ? "is" : "are"} not in your roster.` : "";
  return renderWeeklySwitcherHtml({
    flow, items, currentKey: flow.currentKey, groupsHtml: groupsHtml(flow, cal, model), teamLabel: teamLabelFor(flow, cal, model), hiddenNote: hidden, noPlan, stripHidden: weeklyStripHidden(flow),
  });
}

const nameOf = (key) => String(rowByUuid(key)?.athlete || "This athlete");

// Moves to another athlete: the week, the day and the open path are kept (S1, S6). `deps.loadWeekly` reads the
// athlete's plan (cached), `deps.renderCurrent` draws the week or the node.
export async function switchWeeklyAthlete(targetKey, deps) {
  const cal = state.centralCalendar;
  const flow = activeWeeklyFlow();
  if (!flow || flow.busy || !flow.keys.includes(targetKey) || targetKey === flow.currentKey) return false;
  const rosterId = weeklyRosterIdOf(targetKey);
  if (!rosterId) return false;
  const weekStart = state.viewedWeekStart;
  const day = state.selectedWeekDay;
  const place = captureWeeklyPlace({ weekStart, day, navStack: state.navStack, dayItems: weeklyDayItems(state.lastWeeklyData, weekStart, day) });
  const pathDepth = state.navStack.length;
  const aName = nameOf(flow.currentKey);
  const bName = nameOf(targetKey);
  const before = { data: state.lastWeeklyData, athleteId: state.selectedAthleteId, navStack: state.navStack, exerciseDetail: state.exerciseDetail };
  flow.busy = true;
  deps.renderCurrent?.();
  state.selectedAthleteId = rosterId;
  state.exerciseDetail = { ids: [], currentId: null };
  try {
    await deps.loadWeekly();
  } finally {
    if (cal.weeklyFlow === flow) flow.busy = false;
  }
  // The coach left meanwhile (Back to calendar, another tab): nothing of this answer is drawn (review MEDIUM).
  if (state.centralCalendar !== cal || cal.weeklyFlow !== flow || state.activeTab !== "weekly") return false;
  // The load did not answer for this athlete (an error, a stale answer): the plan on screen is still the other
  // athlete's, so it is never shown under this name. Back to where the coach was, with a calm line (review HIGH).
  if (state.lastWeeklyData === before.data || state.selectedAthleteId !== rosterId) {
    state.selectedAthleteId = before.athleteId;
    state.navStack = before.navStack;
    state.exerciseDetail = before.exerciseDetail;
    flow.line = `Could not open ${bName}'s plan. Try again.`;
    flow.kept = "";
    deps.renderCurrent?.();
    return false;
  }
  state.viewedWeekStart = weekStart;
  state.selectedWeekDay = day;
  const dayItemsB = weeklyDayItems(state.lastWeeklyData, weekStart, day);
  flow.currentKey = targetKey;
  let result;
  if (flow.eventKey) result = eventPlace(flow, targetKey, dayItemsB, { day, bName, pathDepth, place, aName });
  else result = matchWeeklyPlace(place, dayItemsB, { aName, bName });
  state.navStack = result.path;
  flow.line = result.line;
  flow.kept = result.kept;
  deps.renderCurrent?.();
  return true;
}

// F6: the first athlete of an event has no session of its slot on that day.
export function noteNotInSession(flow, date) {
  const key = flow.currentKey;
  if (!flow.notInKeys.includes(key)) flow.notInKeys.push(key);
  flow.notInLine = `${nameOf(key)} has no ${flow.slot ? slotWords(flow.slot) : "session"} linked to this event on ${new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(`${date}T12:00:00`))} ${date.slice(8, 10)}.${date.slice(5, 7)}.`;
}

// K6-3: inside an event the slot opens for an athlete with a linked session; one without says so (F6).
function eventPlace(flow, targetKey, dayItemsB, { day, bName, pathDepth, place, aName }) {
  const notIn = flow.notInKeys.includes(targetKey);
  const slot = flow.slot;
  const slotPath = slot && !notIn ? slotPathFor(dayItemsB, slot) : [];
  if (notIn || !slotPath.length) {
    flow.notInLine = `${bName} has no ${slot ? slotWords(slot) : "session"} linked to this event on ${new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(`${day}T12:00:00`))} ${day.slice(8, 10)}.${day.slice(5, 7)}.`;
    if (!flow.notInKeys.includes(targetKey)) flow.notInKeys.push(targetKey);
    return { path: [], line: "", kept: "" };
  }
  if (pathDepth <= slotPath.length) return { path: slotPath, line: "", kept: "" };
  return matchWeeklyPlace(place, dayItemsB, { aName, bName });
}

// The Groups chips of the header: the list changes to that team's athletes; an athlete who is not in it goes to the
// team's first athlete (a plan always has an athlete).
export async function chooseWeeklyGroup(teamId, deps) {
  const cal = state.centralCalendar;
  const flow = activeWeeklyFlow();
  if (!flow || flow.busy || fixedList(flow)) return false;
  const teams = cal.data?.teams || [];
  if (teamId && !teams.some((team) => String(team.teamId) === teamId)) return false;
  cal.filters.teamIds = teamId ? [teamId] : [];
  // The calendar's own athlete choice goes back to Everyone when she is not in the new team (contract 2.2).
  const chosen = cal.switcher?.athleteKey;
  const pairs = cal.switcher?.org?.status === "ready" ? cal.switcher.org.pairs : null;
  if (chosen && teamId && pairs && !pairs.some((pair) => pair.athleteUuid === chosen && pair.teamId === teamId)) {
    cal.switcher.athleteKey = "";
    cal.switcher.answer = null;
    cal.switcher.status = "idle";
  }
  const keys = calendarListKeys(cal);
  if (keys.length) flow.keys = keys;
  if (!flow.keys.includes(flow.currentKey) && flow.keys[0]) return switchWeeklyAthlete(flow.keys[0], deps);
  deps.renderCurrent?.();
  return true;
}

// *Back to calendar*: every layer Back closes first is closed here, then one history step: the Weekly tab's
// drill-in entries are skipped by the app's own Back until the calendar's place is restored (4.3).
export function weeklyBackToCalendar({ renderCurrent, goBack, fallback }) {
  // The flow ends here (review MEDIUM): a load still running bails out, and a later entry into the Weekly plan by
  // another way never inherits it.
  if (state.centralCalendar) state.centralCalendar.weeklyFlow = null;
  state.navStack = [];
  state.exerciseDetail = { ids: [], currentId: null };
  state.weekSelectorOpen = false;
  state.athletesExpanded = false;
  if (state.appHistoryDepth > 0) goBack();
  else fallback?.();
  renderCurrent?.();
}
