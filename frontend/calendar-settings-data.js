// Settings -> Calendar (K2b-1c): the data side. The screen over the K2b-1a
// API, /api/calendar/settings (backend/src/routes/calendarSettings.js,
// calendarSettingsService.js; plan docs/ai/central-calendar-k2b-plan.md
// sections 5.1, 8 and 20): one read of the active club's whole catalog, and
// one write at a time, each with its requestKey. The server decides every
// right again on every request - the active club workspace and that club's
// club_admin role (T6), the identical 404 for an id it does not show - so
// nothing here is the protection.
import { api } from "./api.js";
import { CENTRAL_CALENDAR_WRITE_BOUND_MS, centralCalendarErrorInfo, centralCalendarOutcomeUnknown, newCentralCalendarRequestKey } from "./central-calendar-data.js";
import { emptyCalendarSettingsState, state } from "./state.js";

export const CALENDAR_SETTINGS_BASE = "/api/calendar/settings";
// The service's own limits (calendarSettingsService.js LIMITS): the form
// says them before a request does.
export const CALENDAR_SETTINGS_LIMITS = Object.freeze({
  typeLabel: 60, fieldLabel: 60, fieldDescription: 200, optionLabel: 40, options: 20, minOptions: 2,
  typeFields: 20, locationName: 80, address: 200, note: 500, unit: 30,
});
export const CALENDAR_SETTINGS_SECTIONS = Object.freeze(["types", "details", "places", "teams"]);

// "Open in maps" (plan section 7): a link built in the browser from the
// address alone; no server sends an address anywhere.
export function calendarSettingsMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}
export const CALENDAR_VALUE_KINDS = Object.freeze(["choice", "number", "scale_1_5", "yes_no", "short_text"]);

let generation = 0;

function cs() {
  return state.calendarSettings;
}

// Who is offered the tab, from /me alone: the active workspace is a club and
// the account holds that club's club_admin role. A platform admin without
// the role is not offered it (T6: Settings -> Calendar writes only on the
// club_admin basis), whatever /api/organization says it may manage.
export function calendarSettingsContext() {
  const user = state.currentUser;
  const ws = user?.activeWorkspace || null;
  if (!ws || ws.type !== "club" || !ws.scopeId) return null;
  const clubId = String(ws.scopeId);
  const admin = (user.clubs || []).some((club) => String(club?.id) === clubId && club?.role === "club_admin");
  return admin ? { clubId } : null;
}

export function resetCalendarSettingsForWorkspaceChange() {
  state.calendarSettings = emptyCalendarSettingsState();
  generation += 1;
}

// Coming back to the section reads the catalog again (another admin may have
// changed it) - unless a form is open or a write is not settled: their base
// stays as it was until they are done.
export function enterCalendarSettingsSection() {
  const d = cs();
  d.notice = "";
  if (!d.form && !d.command) d.stale = true;
}

export function calendarSettingsNeedLoad() {
  const ctx = calendarSettingsContext();
  const d = cs();
  if (!ctx || d.loading) return false;
  if (d.clubId !== ctx.clubId) return true;
  return d.stale || (!d.data && !d.error);
}

export function describeCalendarSettingsReadError(error) {
  const status = Number(error?.status) || 0;
  if (status === 401) return "Please sign in again to see the calendar settings.";
  if (status === 403 || status === 404) return "Calendar settings are not available in this workspace.";
  return "The calendar settings could not be read. Try again.";
}

// GET /api/calendar/settings for the active club. A slower older answer (an
// earlier read, another workspace's) is dropped by the generation counter.
export async function loadCalendarSettings(render) {
  const ctx = calendarSettingsContext();
  const d = cs();
  if (!ctx) return;
  if (d.clubId !== ctx.clubId) {
    Object.assign(d, emptyCalendarSettingsState(), { section: d.section });
    d.clubId = ctx.clubId;
  }
  const mine = ++generation;
  d.loading = true;
  d.stale = false;
  render?.();
  try {
    const data = await api(CALENDAR_SETTINGS_BASE);
    if (mine !== generation || state.calendarSettings !== d) return;
    d.data = normalizeSettings(data);
    d.error = "";
  } catch (error) {
    if (mine !== generation || state.calendarSettings !== d) return;
    d.error = describeCalendarSettingsReadError(error);
  } finally {
    if (mine === generation && state.calendarSettings === d) d.loading = false;
  }
  render?.();
}

function normalizeSettings(data) {
  return {
    clubId: String(data?.clubId || ""),
    types: Array.isArray(data?.types) ? data.types : [],
    fields: Array.isArray(data?.fields) ? data.fields : [],
    locations: Array.isArray(data?.locations) ? data.locations : [],
    teams: Array.isArray(data?.teams) ? data.teams : [],
  };
}

// ---------------------------------------------------------------------------
// The catalog's order, as the server reads it: live before archived, then
// the sort order, the name and the id.
// ---------------------------------------------------------------------------
const byLabel = (a, b) => String(a).localeCompare(String(b));
function catalogOrder(nameOf) {
  return (a, b) => (Number(a.archived) - Number(b.archived)) || ((a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    || byLabel(nameOf(a), nameOf(b)) || byLabel(a.id, b.id);
}
const LISTS = Object.freeze({
  type: { list: "types", order: catalogOrder((r) => r.label) },
  field: { list: "fields", order: catalogOrder((r) => r.label) },
  location: { list: "locations", order: (a, b) => (Number(a.archived) - Number(b.archived)) || byLabel(a.name, b.name) || byLabel(a.id, b.id) },
  team: { list: "teams", key: "teamId" },
});

// One subject as an answer gives it: replaced in its list, or added. A team
// keeps its place (the server's order, which the calendar's automatic colours
// follow); anything else moves to where the server's order puts it - the
// read after every write gives the server's own order back.
export function patchCalendarSettings(kind, row) {
  const d = cs();
  const spec = LISTS[kind];
  if (!d.data || !spec || !row) return;
  const key = spec.key || "id";
  const list = d.data[spec.list];
  const at = list.findIndex((entry) => String(entry[key]) === String(row[key]));
  if (kind === "team") {
    // A new array, never a change in place: the team colours are cached by
    // the array (calendar-colors.js).
    if (at >= 0) d.data.teams = list.map((entry, index) => (index === at ? row : entry));
    return;
  }
  const next = list.filter((_, index) => index !== at);
  next.push(row);
  d.data[spec.list] = next.sort(spec.order);
}

export function replaceCalendarSettingsTypes(types) {
  const d = cs();
  if (d.data && Array.isArray(types)) d.data.types = [...types].sort(LISTS.type.order);
}

const findIn = (list, id, key = "id") => (list || []).find((row) => String(row[key]) === String(id)) || null;
export const calendarTypeById = (id) => findIn(cs().data?.types, id);
export const calendarFieldById = (id) => findIn(cs().data?.fields, id);
export const calendarLocationById = (id) => findIn(cs().data?.locations, id);
export const calendarTeamById = (id) => findIn(cs().data?.teams, id, "teamId");

// ---------------------------------------------------------------------------
// Writes. Every one carries a fresh requestKey; a lost answer is checked by
// sending the very same request again (the server replays it, never saves
// twice). A write still open after the bound is a lost answer, never a
// refusal - the server's own worst case (a 15 s lock wait, the bounded COMMIT
// and its check) is well under it.
// ---------------------------------------------------------------------------
export const newCalendarSettingsRequestKey = newCentralCalendarRequestKey;

export function sendCalendarSettingsWrite({ method, path, body }) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(CENTRAL_CALENDAR_WRITE_BOUND_MS) : undefined;
  return api(`${CALENDAR_SETTINGS_BASE}${path}`, { method, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}

export const calendarSettingsPath = (collection, id = "", tail = "") => `/${collection}${id ? `/${encodeURIComponent(id)}` : ""}${tail ? `/${tail}` : ""}`;

export function calendarSettingsErrorInfo(error) {
  const data = error?.data && typeof error.data === "object" ? error.data : null;
  return { ...centralCalendarErrorInfo(error), frozen: Array.isArray(data?.frozen) ? data.frozen : [] };
}

export const calendarSettingsOutcomeUnknown = centralCalendarOutcomeUnknown;

// Check result sends the same request again. Only these answers settle what
// happened to the first one: the body's own checks (the same body, the same
// answer as the first time), and the service's refusals, which come after the
// runner read its request record under the key (calendarCommandRunner.js:
// the record is read before the command's own checks, so a key already saved
// is replayed and never reaches them). Every other answer (busy, no access,
// signed out, a server error, a key used for another request) comes before
// that record is read, so the first write stays not confirmed.
const SETTLED_ON_CHECK = new Set([
  // The body's checks (calendarSettingsService.js validate*).
  "invalid_body", "invalid_request_key", "invalid_revision", "invalid_label", "invalid_kind", "invalid_icon", "invalid_color",
  "invalid_fields", "invalid_expects", "invalid_order", "invalid_value_kind", "invalid_number", "invalid_unit", "invalid_option",
  "invalid_required", "invalid_description", "invalid_name", "invalid_address", "invalid_note", "invalid_location",
  // The command's own refusals, after the request record.
  "type_changed", "field_changed", "location_changed", "team_changed", "order_changed",
  "type_archived", "field_archived", "location_archived", "type_live", "field_live", "location_live",
  "last_type", "label_taken", "field_answered", "too_few_options", "too_many",
  "field_not_available", "location_not_available", "option_not_available", "nothing_to_change",
]);
export const calendarSettingsCheckSettles = (info) => info.status >= 400 && info.status < 500 && SETTLED_ON_CHECK.has(info.code);
