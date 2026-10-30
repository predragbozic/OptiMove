// Central calendar (K2a-1a) — the event commands: create, update, cancel, and
// the two reads of the events router (the types, one event).
// Plan: docs/ai/central-calendar-k2a-plan.md, sections 4 (who writes, the lock
// order, requestKey, the audit), 6 (the seeded types) and 10 (D18–D23).
//
// Every command is ONE transaction with this lock order (plan 4.3):
//   1. calendar.lock_event_writer(user, owner, basis)   the role rows FOR SHARE; 42501 → the 404 / 403
//   2. the event row FOR UPDATE (edit, cancel)           lock_timeout 15 s → 409 try_again
//   3. the requestKey replay — the hash covers the canonical body AND the
//      event (edit, cancel) or the owner (create), so a key reused on another
//      event or in another workspace is 409 request_key_reused, never another
//      resource's answer; the same key + the same body answers the current
//      view again; a refused request writes no row, so its key stays free
//   4. the checks and the writes
//   5. the request row (ids only — never a name or a note), then its change
//      row (the database refuses a COMMIT without the pair)
//   6. a bounded COMMIT (the roster commands' discipline): an answer within
//      15 s, else the request row is looked for on a new connection for 5 s
//      → the saved outcome with verifiedAfterCommitError, or 503
//      outcome_unknown — never "nothing was saved" after a sent COMMIT.
// Authorization is decided from the active workspace (eventWriteBasis) and
// re-checked by the database lock; a missing event and a foreign one are the
// identical 404 (ADR-006); a target, type or schedule id that is missing,
// foreign or archived is the identical 400. A reader who may not manage an
// event gets a REDUCED view: the targets inside their own scope only.
import crypto from "node:crypto";
import { pool } from "./db.js";
import { boundedText } from "./metricTextRules.js";
import { dateStr, isValidCalendarDate, readScheduleTargetAthletes, timeStr } from "./calendarQuery.js";
import { calendarScheduleCandidateSql, loadWorkspaceTeams } from "./calendarAccess.js";
import {
  EventError, eventOwnerForWorkspace, eventOwnerId, eventOwnerOfRow, eventTypesOwnerSql, eventWriteBasis, forbidden,
  notFound, resolveEventTargets,
} from "./calendarEventAccess.js";
import { canManageExternalScheduleInScope, externalScheduleScopeForWorkspace } from "./trainingLoadAccess.js";
import {
  COMMIT_ANSWER_TIMEOUT_MS, commitCertainlyRefused, NOTHING_SAVED, OUTCOME_UNKNOWN, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS,
} from "./activityRosterCommands.js";

export const EVENT_EXPECTS = Object.freeze(["rpe", "device_data", "test_result"]);
export const EVENT_TARGET_KINDS = Object.freeze(["athlete", "team", "club"]);
export const MAX_EVENT_TARGETS = 200;
const LOCK_TIMEOUT = "15s";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const bad = (code, message) => new EventError(400, code, message);
const conflict = (code, message, details) => new EventError(409, code, message, details);
const requestKeyReused = () => conflict("request_key_reused", "This requestKey was already used for a different request.");
const isUuid = (v) => typeof v === "string" && UUID_PATTERN.test(v);

// Test-only seams (the roster commands' pattern): default no-ops.
export const testHooks = {};

// ---------------------------------------------------------------------------
// Body validation (400s, before any database work). Each returns the
// canonical body — exactly what the request asks, in a fixed shape; its
// sha256, together with the event or the owner, is the request hash.
// ---------------------------------------------------------------------------
function requestKeyOf(body) {
  if (!isUuid(body?.requestKey)) throw bad("invalid_request_key", "requestKey must be a UUID.");
  return body.requestKey.toLowerCase();
}

// A text field: trimmed, line breaks normalised; null for an empty value;
// undefined when absent.
function textField(body, field, max, code, { multiline = false, required = false } = {}) {
  if (!(field in (body || {}))) {
    if (required) throw bad(code, `${field} is required.`);
    return undefined;
  }
  const raw = body[field];
  if (raw === null || raw === undefined) {
    if (required) throw bad(code, `${field} is required.`);
    return null;
  }
  if (typeof raw !== "string") throw bad(code, `${field} must be text.`);
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (!value) {
    if (required) throw bad(code, `${field} is required.`);
    return null;
  }
  const checked = multiline ? value.replace(/\n/g, " ") : value;
  if (!boundedText(checked, max) || (!multiline && /\n/.test(value))) throw bad(code, `${field} must be 1-${max} visible characters.`);
  return value;
}

function dateField(body, field, code, { required = false } = {}) {
  if (!(field in (body || {}))) {
    if (required) throw bad(code, `${field} is required.`);
    return undefined;
  }
  const raw = body[field];
  if (raw === null || raw === "") {
    if (required) throw bad(code, `${field} is required.`);
    return null;
  }
  if (!isValidCalendarDate(raw)) throw bad(code, `${field} must be a valid YYYY-MM-DD date (years 2000-2100).`);
  return raw;
}

function timeField(body, field) {
  if (!(field in (body || {}))) return undefined;
  const raw = body[field];
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !TIME_PATTERN.test(raw)) throw bad("invalid_time", `${field} must be HH:MM.`);
  return raw;
}

function timezoneField(body, { required = false } = {}) {
  if (!("timezone" in (body || {}))) {
    if (required) throw bad("invalid_timezone", "timezone is required.");
    return undefined;
  }
  const raw = body.timezone;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw.trim())) {
    throw bad("invalid_timezone", "timezone must be an IANA time zone name.");
  }
  return raw.trim();
}

function expectsField(body) {
  if (!("expects" in (body || {}))) return undefined;
  const raw = body.expects;
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > EVENT_EXPECTS.length) throw bad("invalid_expects", "expects must be a list of rpe, device_data, test_result.");
  const out = [];
  for (const v of raw) {
    if (!EVENT_EXPECTS.includes(v) || out.includes(v)) throw bad("invalid_expects", "expects must be a list of rpe, device_data, test_result, without duplicates.");
    out.push(v);
  }
  return EVENT_EXPECTS.filter((e) => out.includes(e));
}

function targetsField(body, { required = false } = {}) {
  if (!("targets" in (body || {}))) {
    if (required) throw bad("invalid_targets", "Choose at least one athlete, team or club.");
    return undefined;
  }
  const raw = body.targets;
  if (!Array.isArray(raw) || !raw.length) throw bad("invalid_targets", "Choose at least one athlete, team or club.");
  if (raw.length > MAX_EVENT_TARGETS) throw bad("invalid_targets", `At most ${MAX_EVENT_TARGETS} targets.`);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (!t || !EVENT_TARGET_KINDS.includes(t.kind) || !isUuid(t.id)) throw bad("invalid_targets", "Every target needs a kind (athlete, team, club) and a UUID id.");
    const key = `${t.kind}:${t.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: t.kind, id: t.id.toLowerCase() });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
  return out;
}

function uuidField(body, field, code) {
  if (!(field in (body || {}))) return undefined;
  const raw = body[field];
  if (raw === null || raw === "") return null;
  if (!isUuid(raw)) throw bad(code, `${field} must be a UUID.`);
  return raw.toLowerCase();
}

function revisionField(body) {
  const raw = body?.expectedRevision;
  if (!Number.isInteger(raw) || raw < 1) throw bad("invalid_revision", "expectedRevision must be a positive integer.");
  return raw;
}

// The service's mirror of the database's events_span_check and
// events_time_shape (migration v49): a user error is a 400 here, never the
// trigger's 500.
const MAX_EVENT_SPAN_DAYS = 366;
function checkDaysAndTimes({ day, endDay, startTime, endTime }) {
  if (endDay && endDay < day) throw bad("invalid_day", "endDay must not be before day.");
  if (endDay && endDay > addDay(day, MAX_EVENT_SPAN_DAYS)) throw bad("invalid_day", `An event spans at most ${MAX_EVENT_SPAN_DAYS} days.`);
  if (endTime && !startTime) throw bad("invalid_time", "An end time needs a start time.");
  const oneDay = !endDay || endDay === day;
  if (endTime && startTime && oneDay && endTime <= startTime) throw bad("invalid_time", "The end time must be after the start time.");
}

export function validateCreateBody(body) {
  const requestKey = requestKeyOf(body);
  const eventTypeId = uuidField(body, "eventTypeId", "invalid_type");
  if (!eventTypeId) throw bad("invalid_type", "eventTypeId is required.");
  const canonical = {
    operation: "create",
    eventTypeId,
    title: textField(body, "title", 120, "invalid_title", { required: true }),
    day: dateField(body, "day", "invalid_day", { required: true }),
    endDay: dateField(body, "endDay", "invalid_day") ?? null,
    startTime: timeField(body, "startTime") ?? null,
    endTime: timeField(body, "endTime") ?? null,
    timezone: timezoneField(body, { required: true }),
    location: textField(body, "location", 120, "invalid_location") ?? null,
    expects: expectsField(body) ?? null,
    notes: textField(body, "notes", 2000, "invalid_notes", { multiline: true }) ?? null,
    targets: targetsField(body, { required: true }),
    externalScheduleId: uuidField(body, "externalScheduleId", "invalid_schedule") ?? null,
    testScheduleId: uuidField(body, "testScheduleId", "invalid_schedule") ?? null,
  };
  checkDaysAndTimes(canonical);
  return { requestKey, canonical };
}

export function validateUpdateBody(body) {
  const requestKey = requestKeyOf(body);
  const expectedRevision = revisionField(body);
  const fields = {};
  const put = (name, value) => { if (value !== undefined) fields[name] = value; };
  put("eventTypeId", uuidField(body, "eventTypeId", "invalid_type"));
  if ("eventTypeId" in fields && fields.eventTypeId === null) throw bad("invalid_type", "eventTypeId cannot be empty.");
  put("title", textField(body, "title", 120, "invalid_title"));
  if ("title" in fields && fields.title === null) throw bad("invalid_title", "title cannot be empty.");
  put("day", dateField(body, "day", "invalid_day"));
  if ("day" in fields && fields.day === null) throw bad("invalid_day", "day cannot be empty.");
  put("endDay", dateField(body, "endDay", "invalid_day"));
  put("startTime", timeField(body, "startTime"));
  put("endTime", timeField(body, "endTime"));
  put("timezone", timezoneField(body));
  put("location", textField(body, "location", 120, "invalid_location"));
  put("expects", expectsField(body));
  if ("expects" in fields && fields.expects === null) throw bad("invalid_expects", "expects must be a list.");
  put("notes", textField(body, "notes", 2000, "invalid_notes", { multiline: true }));
  put("targets", targetsField(body));
  put("externalScheduleId", uuidField(body, "externalScheduleId", "invalid_schedule"));
  put("testScheduleId", uuidField(body, "testScheduleId", "invalid_schedule"));
  if (!Object.keys(fields).length) throw bad("nothing_to_change", "Send at least one field to change.");
  return { requestKey, canonical: { operation: "update", expectedRevision, fields } };
}

export function validateCancelBody(body) {
  const requestKey = requestKeyOf(body);
  const expectedRevision = revisionField(body);
  const reason = textField(body, "reason", 500, "invalid_reason", { multiline: true }) ?? null;
  return { requestKey, canonical: { operation: "cancel", expectedRevision, reason } };
}

// The request hash binds the canonical body to the resource: the event
// (edit, cancel) or the owner (create). A key reused on another event or in
// another workspace never replays the first answer.
function requestHash(canonical, { eventId, owner }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ canonical, eventId: eventId ?? null, owner: owner ? `${owner.scope}:${eventOwnerId(owner)}` : null }))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const EVENT_VIEW_SQL = `
  select e.id, e.owner_scope, e.owner_user_id, e.owner_club_id, e.owner_team_id, e.event_type_id,
         e.title, e.day, e.end_day, e.start_time, e.end_time, e.timezone, e.location, e.status,
         e.cancelled_at, e.cancel_reason, e.expects, e.notes, e.external_schedule_id, e.test_schedule_id, e.revision,
         e.created_at, e.updated_at,
         et.kind as event_kind, et.label as event_type_label,
         t.club_id as owner_team_club_id, coalesce(t.is_active, true) as owner_team_active,
         coalesce(c.is_active, true) as owner_club_active, coalesce(tc.is_active, true) as owner_team_club_active,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'kind', tg.target_kind,
                   'id', coalesce(tg.target_athlete_id, tg.target_team_id, tg.target_club_id),
                   'name', case tg.target_kind
                             when 'athlete' then coalesce(a.display_name, a.full_name, nullif(concat_ws(' ', a.first_name, a.last_name), ''), a.athlete_id)
                             when 'team' then tm.name
                             else cl.name end)
                 order by tg.target_kind, coalesce(tm.name, cl.name, a.display_name, a.full_name), tg.id), '[]'::jsonb)
            from calendar.event_targets tg
            left join public.athletes a on a.id = tg.target_athlete_id
            left join public.teams tm on tm.id = tg.target_team_id
            left join public.clubs cl on cl.id = tg.target_club_id
           where tg.event_id = e.id) as targets,
         (select coalesce(array_agg(distinct l.plan_id), '{}') from calendar.event_session_links l
           where l.event_id = e.id and l.ended_at is null and l.plan_id is not null) as plan_ids,
         (select coalesce(array_agg(l.activity_id), '{}') from calendar.event_activity_links l
           where l.event_id = e.id and l.ended_at is null) as activity_ids
    from calendar.events e
    join calendar.event_types et on et.id = e.event_type_id
    left join public.teams t on t.id = e.owner_team_id
    left join public.clubs c on c.id = e.owner_club_id
    left join public.clubs tc on tc.id = t.club_id
   where e.id = $1`;

// The manager's view: everything the event holds.
function viewOf(row) {
  return {
    id: row.id,
    ownerScope: row.owner_scope, ownerClubId: row.owner_club_id, ownerTeamId: row.owner_team_id, ownerUserId: row.owner_user_id,
    eventTypeId: row.event_type_id, eventKind: row.event_kind, eventTypeLabel: row.event_type_label,
    title: row.title, day: dateStr(row.day), endDay: dateStr(row.end_day),
    startTime: timeStr(row.start_time), endTime: timeStr(row.end_time), timezone: row.timezone, location: row.location,
    status: row.status, cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null, cancelReason: row.cancel_reason,
    expects: row.expects || [], externalScheduleId: row.external_schedule_id, testScheduleId: row.test_schedule_id,
    revision: row.revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    targets: row.targets || [],
    links: { planIds: (row.plan_ids || []).map(String), activityIds: (row.activity_ids || []).map(String) },
    canManage: true,
    notes: row.notes,
  };
}

// The reader's view (a coach who reads the event through the calendar's own
// scope but may not manage it): what the calendar card shows, with the
// targets INSIDE THE READER'S SCOPE only — the athletes the reader may see on
// the event's days (the calendar's one membership rule), and the team / club
// targets of the reader's own structural scope. Never the owner's ids, the
// referenced schedules, the links, the notes or a foreign athlete's name.
async function reducedViewOf(row, ctx, queryable) {
  const span = { from: dateStr(row.day), to: dateStr(row.end_day) || dateStr(row.day) };
  const days = [];
  for (let cursor = span.from; cursor <= span.to; cursor = addDay(cursor)) days.push(cursor);
  const teams = await loadWorkspaceTeams(ctx);
  const teamIds = teams.map((t) => String(t.teamId));
  const scoped = await readScheduleTargetAthletes(ctx, "calendar.event_targets", {
    pairs: days.map((day) => ({ scheduleId: row.id, day })), filters: {}, teamIds, idColumn: "event_id", queryable,
  });
  const athletes = new Map();
  for (const list of scoped.values()) for (const a of list) athletes.set(String(a.athleteId), a.name);
  // readScheduleTargetAthletes expands team and club targets to their
  // members; the reduced view lists only the athletes who are targets
  // themselves, plus the structural team / club targets.
  const targets = [];
  for (const t of row.targets || []) {
    if (t.kind === "athlete" && athletes.has(String(t.id))) targets.push({ kind: "athlete", id: t.id, name: athletes.get(String(t.id)) });
    if (t.kind === "team" && teamIds.includes(String(t.id))) targets.push(t);
    if (t.kind === "club" && ctx.workspace.type === "club" && String(ctx.workspace.scopeId) === String(t.id)) targets.push(t);
    if (t.kind === "club" && ctx.workspace.type === "team" && String(ctx.workspace.clubId || "") === String(t.id)) targets.push(t);
  }
  return {
    id: row.id, ownerScope: row.owner_scope,
    eventKind: row.event_kind, eventTypeLabel: row.event_type_label,
    title: row.title, day: span.from, endDay: dateStr(row.end_day),
    startTime: timeStr(row.start_time), endTime: timeStr(row.end_time), timezone: row.timezone, location: row.location,
    status: row.status, cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    expects: row.expects || [], revision: row.revision,
    targets, canManage: false,
  };
}
function addDay(iso, days = 1) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function readEventView(queryable, ctx, eventId) {
  const row = (await queryable.query(EVENT_VIEW_SQL, [eventId])).rows[0];
  if (!row) return null;
  if (eventWriteBasis(ctx, eventOwnerOfRow(row)) !== null) return viewOf(row);
  return reducedViewOf(row, ctx, queryable);
}

// The club of an ACTIVE team of an ACTIVE club, else null: a team workspace
// whose team or club is archived creates nothing and lists no types.
async function teamClubId(queryable, teamId) {
  const row = (await queryable.query(
    `select t.club_id, (coalesce(t.is_active, true) and coalesce(c.is_active, true)) as active
       from public.teams t join public.clubs c on c.id = t.club_id where t.id = $1`,
    [teamId],
  )).rows[0];
  return row && row.active ? String(row.club_id) : null;
}

// GET /types — the types the active workspace may use, non-archived. An
// archived team's workspace, or a team workspace of an archived club (nothing
// can be created there), gets the router's one 404, as every write there.
export async function listEventTypes(ctx) {
  if (ctx.type !== "coach") throw forbidden();
  const owner = eventOwnerForWorkspace(ctx);
  if (owner?.scope === "team") {
    owner.teamClubId = await teamClubId(pool, owner.teamId);
    if (!owner.teamClubId) throw notFound();
  }
  const params = [];
  const ownerSql = eventTypesOwnerSql(owner, "t", params);
  const result = await pool.query(
    `select t.id, t.kind, t.key, t.label, t.default_expects, t.icon_key, t.sort_order, t.owner_scope
       from calendar.event_types t
      where ${ownerSql} and t.archived_at is null
      order by t.sort_order, t.label, t.id`,
    params,
  );
  return result.rows.map((r) => ({
    id: r.id, kind: r.kind, key: r.key, label: r.label, defaultExpects: r.default_expects || [], iconKey: r.icon_key, sortOrder: r.sort_order, ownerScope: r.owner_scope,
  }));
}

// GET /:id — a coach who may manage the event gets everything; a coach who
// reads it through the calendar's own scope (the structural relation or a
// target athlete in scope on some day of the event) gets the reduced view.
// The athlete workspace reads events only through GET /api/calendar (D21);
// everyone else gets the one 404.
export async function getEvent(ctx, eventId) {
  if (ctx.type !== "coach" || !isUuid(eventId)) throw notFound();
  const row = (await pool.query(EVENT_VIEW_SQL, [eventId.toLowerCase()])).rows[0];
  if (!row) throw notFound();
  if (eventWriteBasis(ctx, eventOwnerOfRow(row)) !== null) return viewOf(row);
  const params = [eventId.toLowerCase()];
  const candidate = calendarScheduleCandidateSql(ctx, "e", "calendar.event_targets", params, "e.day", "coalesce(e.end_day, e.day)", "event_id");
  const readable = (await pool.query(`select 1 from calendar.events e where e.id = $1 and (${candidate})`, params)).rowCount > 0;
  if (!readable) throw notFound();
  return reducedViewOf(row, ctx, pool);
}

// ---------------------------------------------------------------------------
// The checks shared by create and update (inside the transaction)
// ---------------------------------------------------------------------------
async function resolveType(client, owner, eventTypeId) {
  const params = [eventTypeId];
  const ownerSql = eventTypesOwnerSql(owner, "t", params);
  const row = (await client.query(
    `select t.id, t.kind, t.default_expects from calendar.event_types t where t.id = $1 and ${ownerSql} and t.archived_at is null`,
    params,
  )).rows[0];
  if (!row) throw bad("type_not_available", "This event type is not available in this workspace.");
  return row;
}

const scheduleNotAvailable = () => bad("schedule_not_available", "This schedule is not available in this workspace.");

// A referenced schedule belongs to the event's owner or to the owner team's
// club — whoever writes, the platform admin included (whose workspace rule
// below reaches every schedule): a club-owned event references the club's
// schedules, a team-owned event the team's or its club's, a private coach's
// event the coach's own.
function scheduleBelongsToOwner(owner, row) {
  if (owner.scope === "club") return row.owner_scope === "club" && String(row.owner_club_id) === owner.clubId;
  if (owner.scope === "team") {
    return (row.owner_scope === "team" && String(row.owner_team_id) === owner.teamId)
      || (row.owner_scope === "club" && owner.teamClubId !== null && String(row.owner_club_id) === owner.teamClubId);
  }
  return row.owner_scope === "user" && String(row.owner_user_id) === owner.userId;
}

// The referenced schedules (plan 1.1, option a): each must exist, belong to
// the event's owner (above) and be manageable in the ACTIVE workspace — both
// through the external schedules' own workspace-bound rule (the test
// schedule shares the owner columns, so the same predicate applies; the Tests
// module's account-wide canManageSchedule would let an admin of two clubs
// reach the other club's schedule from this workspace); a test schedule only
// on a `test` kind. Every refusal is the one answer, whatever the reason.
async function checkScheduleRefs(client, ctx, owner, { externalScheduleId, testScheduleId, kind }) {
  const scope = externalScheduleScopeForWorkspace(ctx.workspace, { user: { id: ctx.userId } });
  const usable = (row) => Boolean(row) && scope.type !== null && canManageExternalScheduleInScope(scope, row) && scheduleBelongsToOwner(owner, row);
  if (externalScheduleId) {
    const row = (await client.query(`select owner_scope, owner_user_id, owner_club_id, owner_team_id from training_load.external_schedules where id = $1`, [externalScheduleId])).rows[0];
    if (!usable(row)) throw scheduleNotAvailable();
  }
  if (testScheduleId) {
    if (kind !== "test") throw conflict("schedule_kind_mismatch", "A test schedule can be referenced only by an event of kind test.");
    const row = (await client.query(`select owner_scope, owner_user_id, owner_club_id, owner_team_id from tests.test_schedules where id = $1`, [testScheduleId])).rows[0];
    if (!usable(row)) throw scheduleNotAvailable();
  }
}

const SCHEDULE_UNIQUE_CONSTRAINTS = new Set(["events_one_planned_per_external_schedule", "events_one_planned_per_test_schedule"]);
const TIMEZONE_CONSTRAINT = "events_timezone_iana";
const REQUEST_KEY_CONSTRAINT = "event_requests_one_per_key";

// ---------------------------------------------------------------------------
// The command runner
// ---------------------------------------------------------------------------
function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const EVENT_ROW_FOR_WRITE_SQL = `
  select e.*, t.club_id as owner_team_club_id, coalesce(t.is_active, true) as owner_team_active,
         coalesce(c.is_active, true) as owner_club_active, coalesce(tc.is_active, true) as owner_team_club_active, et.kind as event_kind
    from calendar.events e
    join calendar.event_types et on et.id = e.event_type_id
    left join public.teams t on t.id = e.owner_team_id
    left join public.clubs c on c.id = e.owner_club_id
    left join public.clubs tc on tc.id = t.club_id
   where e.id = $1`;

// The answer of a saved request, read again now: the stored result holds
// ids only (never a name or a note), so a replay or a verification after an
// unconfirmed COMMIT re-reads the event as the caller may see it today.
async function answerOf(queryable, ctx, stored, extra) {
  const view = await readEventView(queryable, ctx, stored.eventId);
  if (!view) throw notFound();
  return { status: stored.httpStatus || 200, body: { event: view, ...extra } };
}

async function runEventCommand(ctx, { requestKey, canonical, eventId }, apply) {
  if (ctx.type !== "coach") throw eventId ? notFound() : forbidden();
  const operation = canonical.operation;
  const client = await pool.connect();
  let commitSent = false;
  let broken = false;
  let released = false;
  let hash = null;
  const onClientError = () => { broken = true; };
  client.on("error", onClientError);
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);

    let owner;
    let basis;
    let row = null;
    if (eventId) {
      row = (await client.query(EVENT_ROW_FOR_WRITE_SQL, [eventId])).rows[0];
      if (!row) throw notFound();
      owner = eventOwnerOfRow(row);
      basis = eventWriteBasis(ctx, owner);
      if (!basis) throw notFound();
    } else {
      owner = eventOwnerForWorkspace(ctx);
      if (!owner) {
        if (ctx.workspace?.type === "platform") throw new EventError(403, "workspace_required", "Open the club's workspace to create or change its events.");
        throw forbidden();
      }
      if (owner.scope === "team") {
        owner.teamClubId = await teamClubId(client, owner.teamId);
        if (!owner.teamClubId) throw notFound();
      }
      basis = eventWriteBasis(ctx, owner);
      if (!basis) throw forbidden();
    }
    hash = requestHash(canonical, { eventId, owner });
    if (testHooks.beforeLocks) await testHooks.beforeLocks({ client, operation });
    try {
      await client.query(`select calendar.lock_event_writer($1, $2, $3, $4)`, [ctx.userId, owner.scope, eventOwnerId(owner), basis]);
    } catch (error) {
      if (error?.code === "42501") throw eventId ? notFound() : forbidden();
      throw error;
    }
    if (eventId) {
      row = (await client.query(`${EVENT_ROW_FOR_WRITE_SQL} for update of e`, [eventId])).rows[0];
      if (!row) throw notFound();
      // The right is decided again on the locked row (an owner never changes,
      // but the team's or the club's activity may have).
      if (eventWriteBasis(ctx, eventOwnerOfRow(row)) !== basis) throw notFound();
    }

    const prior = (await client.query(
      `select request_hash, event_id, result from calendar.event_requests where performed_by_user_id = $1 and request_key = $2`,
      [ctx.userId, requestKey],
    )).rows[0];
    if (prior) {
      if (prior.request_hash !== hash || (eventId && String(prior.event_id) !== String(eventId))) throw requestKeyReused();
      const answer = await answerOf(client, ctx, prior.result, { replayed: true });
      await client.query("rollback");
      return { ...answer, replayed: true };
    }

    const requestId = crypto.randomUUID();
    const out = await apply({ client, owner, basis, row, requestId });
    const stored = { httpStatus: out.httpStatus, eventId: out.eventId };
    if (testHooks.beforeRequestRow) await testHooks.beforeRequestRow({ client, operation, requestKey, hash, eventId: out.eventId, userId: ctx.userId });
    await client.query(
      `insert into calendar.event_requests (id, request_key, request_hash, operation, performed_by_user_id, event_id, result)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [requestId, requestKey, hash, operation, ctx.userId, out.eventId, JSON.stringify(stored)],
    );
    const revision = (await client.query(`select revision from calendar.events where id = $1`, [out.eventId])).rows[0].revision;
    await client.query(
      `insert into calendar.event_changes (event_id, kind, basis, performed_by_user_id, reason, details, request_id, revision)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [out.eventId, operation, basis, ctx.userId, out.reason ?? null, JSON.stringify(out.details || {}), requestId, revision],
    );
    if (testHooks.beforeCommit) await testHooks.beforeCommit({ client, operation, eventId: out.eventId });
    commitSent = true;
    const committing = Promise.resolve().then(() => (testHooks.commit ? testHooks.commit(client) : client.query("commit")));
    committing.catch(() => {});
    await withinBound(committing, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    return { status: out.httpStatus, body: out.body };
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (error?.code === "55P03" || error?.code === "40P01") throw conflict("try_again", "The event is being changed. Try again.");
      // The time zone is checked by events_before_write alone (one scan of
      // pg_timezone_names per write, the invariant where it holds).
      if (error?.code === "23514" && error.constraint === TIMEZONE_CONSTRAINT) throw bad("invalid_timezone", "timezone must be an IANA time zone name.");
      if (error?.code === "23505" && SCHEDULE_UNIQUE_CONSTRAINTS.has(error.constraint)) {
        throw conflict("schedule_already_referenced", "Another planned event already refers to this schedule.");
      }
      if (error?.code === "23505" && error.constraint === REQUEST_KEY_CONSTRAINT && hash) {
        // The same key landed meanwhile (a double submit, a retry racing an
        // in-flight COMMIT): the saved request decides, never a bare 500. A
        // lookup that fails or times out says "try again", never that the
        // key belongs to another request.
        let found;
        try {
          found = await findStoredResult(ctx.userId, requestKey, hash, testHooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS);
        } catch (checkError) {
          console.error(`[calendar] checking a racing ${operation} failed: ${checkError?.message}`);
          throw conflict("try_again", "The event is being changed. Try again.");
        }
        if (found) return { ...(await answerOf(pool, ctx, found, { replayed: true })), replayed: true };
        throw requestKeyReused();
      }
      throw error;
    }
    console.error(`[calendar] commit of ${operation} on event ${eventId ?? "(new)"} failed: ${error?.code ?? ""} ${error?.message}`);
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      throw new EventError(500, "internal_error", NOTHING_SAVED);
    }
    released = true;
    client.removeListener("error", onClientError);
    client.on("error", () => {});
    client.release(true);
    let found = null;
    try {
      found = await findStoredResult(ctx.userId, requestKey, hash, testHooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS);
    } catch (checkError) {
      console.error(`[calendar] checking ${operation} after an unconfirmed COMMIT failed: ${checkError?.message}`);
    }
    if (found) return { ...(await answerOf(pool, ctx, found, { verifiedAfterCommitError: true })), verifiedAfterCommitError: true };
    throw new EventError(503, "outcome_unknown", OUTCOME_UNKNOWN);
  } finally {
    if (!released) {
      client.removeListener("error", onClientError);
      client.release(broken ? true : undefined);
    }
  }
}

// Is the request committed? Bounded as a whole on a new connection (the
// roster commands' findStoredResult). Returns the stored ids, or null.
async function findStoredResult(userId, requestKey, hash, ms) {
  const deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now());
  const connecting = pool.connect();
  let checker;
  try {
    checker = await withinBound(connecting, left());
  } catch (error) {
    connecting.then((late) => late.release(true), () => {});
    throw error;
  }
  let bad_ = false;
  const onErr = () => { bad_ = true; };
  checker.on("error", onErr);
  try {
    if (testHooks.checkFault) await testHooks.checkFault(checker);
    const answer = checker.query({
      text: `select request_hash, result from calendar.event_requests where performed_by_user_id = $1 and request_key = $2`,
      values: [userId, requestKey],
      query_timeout: left(),
    });
    answer.catch(() => {});
    const row = (await withinBound(answer, left())).rows[0];
    return row && row.request_hash === hash ? row.result : null;
  } catch (error) {
    bad_ = true;
    throw error;
  } finally {
    checker.removeListener("error", onErr);
    if (bad_) checker.on("error", () => {});
    checker.release(bad_ ? true : undefined);
  }
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------
const scalarDetail = (v) => (v === undefined ? null : Array.isArray(v) ? v.map(String) : v);

export async function createEvent(ctx, body) {
  const { requestKey, canonical } = validateCreateBody(body);
  return runEventCommand(ctx, { requestKey, canonical, eventId: null }, async ({ client, owner }) => {
    const type = await resolveType(client, owner, canonical.eventTypeId);
    const expects = canonical.expects ?? (type.default_expects || []);
    await checkScheduleRefs(client, ctx, owner, { externalScheduleId: canonical.externalScheduleId, testScheduleId: canonical.testScheduleId, kind: type.kind });
    const targets = await resolveEventTargets(client, owner, canonical.targets, canonical.day);
    const inserted = await client.query(
      `insert into calendar.events (owner_scope, owner_user_id, owner_club_id, owner_team_id, event_type_id, title, day, end_day, start_time, end_time,
                                    timezone, location, expects, notes, external_schedule_id, test_schedule_id, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
      [owner.scope, owner.userId, owner.clubId, owner.teamId, type.id, canonical.title, canonical.day, canonical.endDay, canonical.startTime, canonical.endTime,
        canonical.timezone, canonical.location, expects, canonical.notes, canonical.externalScheduleId, canonical.testScheduleId, ctx.userId],
    );
    const eventId = inserted.rows[0].id;
    await insertTargets(client, eventId, targets);
    const view = await readEventView(client, ctx, eventId);
    return {
      eventId, httpStatus: 201, body: { event: view },
      details: {
        eventTypeId: type.id, kind: type.kind, day: canonical.day, endDay: canonical.endDay, startTime: canonical.startTime, endTime: canonical.endTime,
        timezone: canonical.timezone, expects, targetIds: targets.map((t) => t.id), targetKinds: targets.map((t) => t.kind),
        externalScheduleId: canonical.externalScheduleId, testScheduleId: canonical.testScheduleId,
      },
    };
  });
}

// One multi-row INSERT for the targets (the pattern of PR #215: one
// statement per set, not one per row under the locks).
async function insertTargets(client, eventId, targets) {
  if (!targets.length) return;
  await client.query(
    `insert into calendar.event_targets (event_id, target_kind, target_athlete_id, target_team_id, target_club_id)
     select $1, t.kind, case when t.kind = 'athlete' then t.id end, case when t.kind = 'team' then t.id end, case when t.kind = 'club' then t.id end
       from unnest($2::text[], $3::uuid[]) as t(kind, id)`,
    [eventId, targets.map((t) => t.kind), targets.map((t) => t.id)],
  );
}

async function requireOpenAndCurrent(client, ctx, row, expectedRevision) {
  if (row.status === "cancelled") throw conflict("event_cancelled", "This event is cancelled and cannot be changed.", { current: await readEventView(client, ctx, row.id) });
  if (row.revision !== expectedRevision) throw conflict("event_changed", "This event was changed meanwhile. Reload it and try again.", { current: await readEventView(client, ctx, row.id) });
}

export async function updateEvent(ctx, eventId, body) {
  if (!isUuid(eventId)) throw notFound();
  const { requestKey, canonical } = validateUpdateBody(body);
  const f = canonical.fields;
  return runEventCommand(ctx, { requestKey, canonical, eventId: eventId.toLowerCase() }, async ({ client, owner, row }) => {
    await requireOpenAndCurrent(client, ctx, row, canonical.expectedRevision);
    const next = {
      eventTypeId: f.eventTypeId ?? row.event_type_id,
      title: "title" in f ? f.title : row.title,
      day: "day" in f ? f.day : dateStr(row.day),
      endDay: "endDay" in f ? f.endDay : dateStr(row.end_day),
      startTime: "startTime" in f ? f.startTime : timeStr(row.start_time),
      endTime: "endTime" in f ? f.endTime : timeStr(row.end_time),
      timezone: "timezone" in f ? f.timezone : row.timezone,
      location: "location" in f ? f.location : row.location,
      notes: "notes" in f ? f.notes : row.notes,
      externalScheduleId: "externalScheduleId" in f ? f.externalScheduleId : row.external_schedule_id,
      testScheduleId: "testScheduleId" in f ? f.testScheduleId : row.test_schedule_id,
    };
    checkDaysAndTimes(next);
    let kind = row.event_kind;
    let typeChanged = false;
    if (String(next.eventTypeId) !== String(row.event_type_id)) {
      const type = await resolveType(client, owner, next.eventTypeId);
      kind = type.kind;
      typeChanged = true;
    }
    const expects = "expects" in f ? f.expects : (row.expects || []);
    // Only a reference that is set or changed is validated (the database's
    // rule as well), plus the test schedule when the type changed (its kind
    // rule): the other reference, unchanged, may point at a schedule the
    // Tests module deleted since, and must never block this write.
    const extChanged = String(next.externalScheduleId ?? "") !== String(row.external_schedule_id ?? "");
    const testChanged = String(next.testScheduleId ?? "") !== String(row.test_schedule_id ?? "");
    if (extChanged || testChanged || (typeChanged && next.testScheduleId)) {
      await checkScheduleRefs(client, ctx, owner, {
        externalScheduleId: extChanged ? next.externalScheduleId : null,
        testScheduleId: testChanged || typeChanged ? next.testScheduleId : null,
        kind,
      });
    }
    const before = await readEventView(client, ctx, row.id);
    let targets = null;
    if ("targets" in f) targets = await resolveEventTargets(client, owner, f.targets, next.day);
    else if (next.day !== dateStr(row.day)) {
      // The day moved: the existing targets are judged again on the new day.
      await resolveEventTargets(client, owner, before.targets.map((t) => ({ kind: t.kind, id: String(t.id) })), next.day);
    }
    await client.query(
      `update calendar.events
          set event_type_id = $2, title = $3, day = $4, end_day = $5, start_time = $6, end_time = $7, timezone = $8, location = $9,
              expects = $10, notes = $11, external_schedule_id = $12, test_schedule_id = $13, revision = revision + 1
        where id = $1`,
      [row.id, next.eventTypeId, next.title, next.day, next.endDay, next.startTime, next.endTime, next.timezone, next.location,
        expects, next.notes, next.externalScheduleId, next.testScheduleId],
    );
    if (targets) {
      await client.query(`delete from calendar.event_targets where event_id = $1`, [row.id]);
      await insertTargets(client, row.id, targets);
    }
    const after = await readEventView(client, ctx, row.id);
    const details = {};
    for (const key of ["eventTypeId", "title", "day", "endDay", "startTime", "endTime", "timezone", "location", "externalScheduleId", "testScheduleId"]) {
      if (String(before[key] ?? "") !== String(after[key] ?? "")) details[key] = [scalarDetail(before[key]), scalarDetail(after[key])];
    }
    if (JSON.stringify(before.expects) !== JSON.stringify(after.expects)) { details.expectsBefore = before.expects; details.expectsAfter = after.expects; }
    if ((before.notes ?? null) !== (after.notes ?? null)) details.notesChanged = true;
    if (targets) {
      details.targetsBefore = before.targets.map((t) => String(t.id));
      details.targetsAfter = after.targets.map((t) => String(t.id));
    }
    return { eventId: row.id, httpStatus: 200, body: { event: after }, details };
  });
}

export async function cancelEvent(ctx, eventId, body) {
  if (!isUuid(eventId)) throw notFound();
  const { requestKey, canonical } = validateCancelBody(body);
  return runEventCommand(ctx, { requestKey, canonical, eventId: eventId.toLowerCase() }, async ({ client, row }) => {
    await requireOpenAndCurrent(client, ctx, row, canonical.expectedRevision);
    await client.query(
      `update calendar.events
          set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2, cancel_reason = $3, revision = revision + 1
        where id = $1`,
      [row.id, ctx.userId, canonical.reason],
    );
    const after = await readEventView(client, ctx, row.id);
    return { eventId: row.id, httpStatus: 200, body: { event: after }, reason: canonical.reason, details: { status: ["planned", "cancelled"] } };
  });
}
