// Central calendar (K2a-1a, K2a-1b) — the event commands: create, update,
// cancel; attach / detach planned sessions and activities, align the linked
// sessions' flags (K2a-1b); and the two reads of the events router (the
// types, one event).
// Plan: docs/ai/central-calendar-k2a-plan.md, sections 4 (who writes, the lock
// order, requestKey, the audit), 6 (the seeded types) and 10 (D18–D23).
//
// Every command is ONE transaction with this lock order (plan 4.3):
//   1. calendar.lock_event_writer(user, owner, basis)   the role rows FOR SHARE; 42501 → the 404 / 403
//   2. the event row FOR UPDATE (every command but create) lock_timeout 15 s → 409 try_again
//   3. the requestKey replay — the hash covers the canonical body AND the
//      event (edit, cancel) or the owner (create), so a key reused on another
//      event or in another workspace is 409 request_key_reused, never another
//      resource's answer; the same key + the same body answers the current
//      view again; a refused request writes no row, so its key stays free
//   4. the checks and the writes; the link commands lock what they link
//      first, in one order: the plans FOR SHARE in ascending id (a Builder
//      save or delete of a plan locks its row FOR UPDATE, so the two
//      serialize), then the sessions FOR UPDATE in ascending id when their
//      flags are written (the Training Load quick toggles' row lock), or the
//      activity FOR SHARE; every command bumps the event's revision, so its
//      change row is required at COMMIT (events_need_change)
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
import { dateStr, isValidCalendarDate, normalizedSessionName, readScheduleTargetAthletes, timeStr } from "./calendarQuery.js";
import {
  calendarActivityScopeSql, calendarAthleteScopeSql, calendarScheduleCandidateSql, loadWorkspaceTeams, membershipOnDaySql,
} from "./calendarAccess.js";
import {
  EventError, eventOwnerForWorkspace, eventOwnerId, eventOwnerOfRow, eventTypesOwnerSql, eventWriteBasis, forbidden,
  notFound, resolveEventTargets,
} from "./calendarEventAccess.js";
import {
  canManageExternalScheduleInScope, canManagePlanTrainingLoadInScope, externalScheduleScopeForWorkspace, WEEKLY_PLAN_SESSION_FILTER_SQL,
} from "./trainingLoadAccess.js";
import { writePublishedSessionFlags } from "./plannedSessionFlags.js";
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
         (select coalesce(array_agg(distinct training.resolve_canonical_activity_id(l.activity_id)), '{}') from calendar.event_activity_links l
           where l.event_id = e.id and l.ended_at is null) as activity_ids,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', l.id, 'planId', l.plan_id, 'day', l.day, 'amPm', l.am_pm, 'bta', l.bta, 'order', l.session_order,
                   'sessionNameAtLink', l.session_name_at_link, 'sessionId', s.session_id, 'sessionName', s.session_name,
                   'logicalSessionId', s.logical_session_id, 'athleteId', s.athlete_id, 'athleteName', s.athlete_name,
                   'rpeEnabled', s.rpe_enabled, 'trainingLoadEnabled', s.training_load_enabled)
                 order by l.day, l.am_pm nulls first, l.bta nulls first, l.session_order, l.id), '[]'::jsonb)
            from calendar.event_session_links l
            left join lateral (
              select ps.id as session_id, ps.name as session_name, ps.logical_session_id, ps.rpe_enabled, ps.training_load_enabled,
                     ath.id as athlete_id,
                     coalesce(ath.display_name, ath.full_name, nullif(concat_ws(' ', ath.first_name, ath.last_name), ''), ath.athlete_id) as athlete_name
                from plans.plans p
                join plans.plan_days pd on pd.plan_id = p.id
                join plans.plan_sessions ps on ps.plan_day_id = pd.id
                join public.athletes ath on ath.id = p.athlete_id
               where p.id = l.plan_id and ${WEEKLY_PLAN_SESSION_FILTER_SQL}
                 and pd.date = l.day and ps.am_pm is not distinct from l.am_pm and ps.bta is not distinct from l.bta
                 and ps.session_order = l.session_order
               order by ps.id
               limit 1
            ) s on true
           where l.event_id = e.id and l.ended_at is null) as session_links,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', l.id, 'activityId', ca.id, 'name', ca.name, 'day', ca.occurred_local_date, 'origin', ca.origin)
                 order by ca.occurred_local_date, l.id), '[]'::jsonb)
            from calendar.event_activity_links l
            join training.activities ca on ca.id = training.resolve_canonical_activity_id(l.activity_id)
           where l.event_id = e.id and l.ended_at is null) as activity_links
    from calendar.events e
    join calendar.event_types et on et.id = e.event_type_id
    left join public.teams t on t.id = e.owner_team_id
    left join public.clubs c on c.id = e.owner_club_id
    left join public.clubs tc on tc.id = t.club_id
   where e.id = $1`;

// The manager's view: everything the event holds; a linked activity's name
// and origin only when the caller may read that activity
// (`readableActivityIds`).
function viewOf(row, readableActivityIds) {
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
    ...linkFacts(row, readableActivityIds),
    canManage: true,
    notes: row.notes,
  };
}

// The manager's view of the links (K2a-1b, plan 2.2 and 3.2): each live
// session link with the session now in its slot — `linked`, `renamed`
// (the session's name changed since the link) or `orphaned` (the plan was
// deleted or its slot holds no session any more: visible, never silent) —
// and whether its flags follow the event's `expects` (`aligned`); the live
// activity links — named (`visible: true`, the name and the origin) only
// when the activity is in the caller's calendar read scope, else
// `visible: false` with its ids and day alone, so its manager can still
// detach it without learning what it is (independent review of PR #313,
// LOW-3); `alignment.pending`, the panel's note until the coach aligns (D20,
// never an alarm).
function linkFacts(row, readableActivityIds = new Set()) {
  const expectsRpe = (row.expects || []).includes("rpe");
  const sessionLinks = (row.session_links || []).map((l) => {
    const state = !l.sessionId ? "orphaned"
      : normalizedSessionName(l.sessionName) !== normalizedSessionName(l.sessionNameAtLink) ? "renamed" : "linked";
    const aligned = !l.sessionId ? null
      : expectsRpe ? l.rpeEnabled === true && l.trainingLoadEnabled === true : l.rpeEnabled !== true;
    return {
      id: l.id, planId: l.planId, day: dateStr(l.day), amPm: l.amPm ?? null, bta: l.bta ?? null, order: l.order,
      state, sessionName: l.sessionName ?? null, sessionNameAtLink: l.sessionNameAtLink ?? null,
      logicalSessionId: l.logicalSessionId ?? null, athleteId: l.athleteId ?? null, athleteName: l.athleteName ?? null,
      asksRpe: l.sessionId ? l.rpeEnabled === true && l.trainingLoadEnabled === true : null, aligned,
    };
  });
  const activityLinks = (row.activity_links || []).map((l) => {
    const visible = readableActivityIds.has(String(l.activityId));
    return {
      id: l.id, activityId: l.activityId, day: dateStr(l.day), visible,
      name: visible ? l.name ?? null : null, origin: visible ? l.origin ?? null : null,
    };
  });
  return {
    sessionLinks, activityLinks,
    alignment: { pending: sessionLinks.filter((l) => l.aligned === false).length },
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

// The linked activities the caller may read in the calendar (the activity
// read scope the attach checks too); one statement, none without a link.
async function readableActivityIdsOf(queryable, ctx, row) {
  const ids = (row.activity_links || []).map((l) => String(l.activityId));
  if (!ids.length) return new Set();
  const params = [ids];
  const scope = calendarActivityScopeSql(ctx, "a", params);
  const result = await queryable.query(`select a.id from training.activities a where a.id = any($1::uuid[]) and (${scope})`, params);
  return new Set(result.rows.map((r) => String(r.id)));
}
async function managerViewOf(queryable, ctx, row) {
  return viewOf(row, await readableActivityIdsOf(queryable, ctx, row));
}

async function readEventView(queryable, ctx, eventId) {
  const row = (await queryable.query(EVENT_VIEW_SQL, [eventId])).rows[0];
  if (!row) return null;
  if (eventWriteBasis(ctx, eventOwnerOfRow(row)) !== null) return managerViewOf(queryable, ctx, row);
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
  if (eventWriteBasis(ctx, eventOwnerOfRow(row)) !== null) return managerViewOf(pool, ctx, row);
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
const SESSION_LINK_CONSTRAINT = "event_session_links_one_live_per_slot";
const ACTIVITY_LINK_CONSTRAINT = "event_activity_links_one_live_per_activity";
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
// ids and the command's own counts only (never a name or a note), so a
// replay or a verification after an unconfirmed COMMIT re-reads the event
// as the caller may see it today and repeats the first answer's counts.
async function answerOf(queryable, ctx, stored, extra) {
  const view = await readEventView(queryable, ctx, stored.eventId);
  if (!view) throw notFound();
  return { status: stored.httpStatus || 200, body: { event: view, ...(stored.counts || {}), ...extra } };
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
    const stored = { httpStatus: out.httpStatus, eventId: out.eventId, ...(out.counts ? { counts: out.counts } : {}) };
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
      // A slot or an activity linked by a concurrent command to another
      // event meanwhile (the pre-check under the plan locks saw it free).
      if (error?.code === "23505" && error.constraint === SESSION_LINK_CONSTRAINT) {
        throw conflict("session_already_attached", "One of these sessions is already attached to another event.");
      }
      if (error?.code === "23505" && error.constraint === ACTIVITY_LINK_CONSTRAINT) {
        throw conflict("activity_already_attached", "This activity is already attached to another event.");
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
    // A change of the days never strands a link (K2a-1b): every live session
    // and activity link (the activity's canonical survivor, ADR-001, as the
    // read shows it) stays on one of the event's days, or nothing is written
    // and the coach detaches them first. Counted under the event's lock,
    // which every link command takes first.
    if (next.day !== dateStr(row.day) || String(next.endDay ?? "") !== String(dateStr(row.end_day) ?? "")) {
      const outside = (await client.query(
        `select (select count(*)::int from calendar.event_session_links l
                  where l.event_id = $1 and l.ended_at is null and (l.day < $2::date or l.day > $3::date))
              + (select count(*)::int from calendar.event_activity_links l
                   join training.activities a on a.id = training.resolve_canonical_activity_id(l.activity_id)
                  where l.event_id = $1 and l.ended_at is null
                    and (a.occurred_local_date < $2::date or a.occurred_local_date > $3::date)) as n`,
        [row.id, next.day, next.endDay || next.day],
      )).rows[0].n;
      if (outside > 0) {
        throw conflict("links_outside_event", "Some linked sessions or activities are outside the new days. Detach them first.", { count: outside });
      }
    }
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
    // A cancelled event is final and takes no link command, so its live
    // links end with it, in the same transaction (K2a-1b): the slots and the
    // activities are free for another event at once, and nothing stays
    // linked to an event no one can change.
    const sessionLinksEnded = (await client.query(
      `update calendar.event_session_links set ended_at = now(), ended_by_user_id = $2 where event_id = $1 and ended_at is null`,
      [row.id, ctx.userId],
    )).rowCount;
    const activityLinksEnded = (await client.query(
      `update calendar.event_activity_links set ended_at = now(), ended_by_user_id = $2 where event_id = $1 and ended_at is null`,
      [row.id, ctx.userId],
    )).rowCount;
    await client.query(
      `update calendar.events
          set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2, cancel_reason = $3, revision = revision + 1
        where id = $1`,
      [row.id, ctx.userId, canonical.reason],
    );
    const after = await readEventView(client, ctx, row.id);
    const counts = { linksEnded: { sessions: sessionLinksEnded, activities: activityLinksEnded } };
    return {
      eventId: row.id, httpStatus: 200, body: { event: after, ...counts }, counts, reason: canonical.reason,
      details: { status: ["planned", "cancelled"], sessionLinksEnded, activityLinksEnded },
    };
  });
}

// ---------------------------------------------------------------------------
// The link commands (K2a-1b; plan sections 2.1 (a), 2.2, 2.3 and 3.2)
// ---------------------------------------------------------------------------
export const MAX_LINKED_SESSIONS = 200;

function uuidListField(body, field, code, { max }) {
  const raw = body?.[field];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) throw bad(code, `${field} must be a list of 1 to ${max} ids.`);
  const out = new Set();
  for (const value of raw) {
    if (!isUuid(value)) throw bad(code, `${field} must hold UUIDs.`);
    out.add(value.toLowerCase());
  }
  return [...out].sort();
}
function booleanField(body, field, code) {
  if (!(field in (body || {})) || body[field] === undefined) return false;
  if (typeof body[field] !== "boolean") throw bad(code, `${field} must be true or false.`);
  return body[field];
}

export function validateAttachSessionsBody(body) {
  return {
    requestKey: requestKeyOf(body),
    canonical: {
      operation: "attach_sessions", expectedRevision: revisionField(body),
      logicalSessionIds: uuidListField(body, "logicalSessionIds", "invalid_sessions", { max: MAX_LINKED_SESSIONS }),
      alignSessions: booleanField(body, "alignSessions", "invalid_align"),
      confirmDisableWithResults: booleanField(body, "confirmDisableWithResults", "invalid_confirm"),
    },
  };
}
export function validateDetachSessionsBody(body) {
  return {
    requestKey: requestKeyOf(body),
    canonical: {
      operation: "detach_sessions", expectedRevision: revisionField(body),
      linkIds: uuidListField(body, "linkIds", "invalid_links", { max: MAX_LINKED_SESSIONS }),
    },
  };
}
// The standalone alignment is audited as an `update` of the event (v49's
// change kinds hold no `align_sessions`; the details say `align`), its
// canonical body carrying `align: true` so its request hash never equals an
// ordinary edit's.
export function validateAlignSessionsBody(body) {
  return {
    requestKey: requestKeyOf(body),
    canonical: {
      operation: "update", align: true, expectedRevision: revisionField(body),
      confirmDisableWithResults: booleanField(body, "confirmDisableWithResults", "invalid_confirm"),
    },
  };
}
export function validateActivityLinkBody(body, operation) {
  const activityId = uuidField(body, "activityId", "invalid_activity");
  if (!activityId) throw bad("invalid_activity", "activityId is required.");
  return { requestKey: requestKeyOf(body), canonical: { operation, expectedRevision: revisionField(body), activityId } };
}

const sessionNotAvailable = () => bad("session_not_available", "One of these sessions is not available in this workspace.");
const activityNotAvailable = () => bad("activity_not_available", "This activity is not available in this workspace.");
const linkNotAvailable = () => bad("link_not_available", "One of these links is not a live link of this event.");

// The athlete `athleteExpr` is a target of the event `eventParam` ON THE DAY
// `dayExpr`: directly, or a member of a target team or club that day — the
// calendar's one membership rule (readScheduleTargetAthletes).
function eventTargetsAthleteSql(eventParam, athleteExpr, dayExpr) {
  return `exists (select 1 from calendar.event_targets tg where tg.event_id = ${eventParam} and (
            (tg.target_kind = 'athlete' and tg.target_athlete_id = ${athleteExpr})
         or (tg.target_kind = 'team' and ${membershipOnDaySql(athleteExpr, (m) => `(${m}.membership_type = 'team' and ${m}.team_id = tg.target_team_id)`, dayExpr)})
         or (tg.target_kind = 'club' and ${membershipOnDaySql(athleteExpr, (m) => `(${m}.membership_type = 'club' and ${m}.club_id = tg.target_club_id)`, dayExpr)})))`;
}

// A plan or an activity may be linked only inside the event owner's own tree
// (security review of K2a-1b): the owner itself, a team event's club, or a
// club event's teams — the owners whose managers can always see the event
// and detach the link again. A private coach's plan of a club athlete, a
// sibling team's or another club's, a system or unresolved one never folds
// under the event, whoever asks (a platform administrator included); it is
// answered like an id the caller cannot see. `holder` carries the stored
// owner columns and, for a team owner, `owner_team_club_id`.
function withinEventOwner(owner, holder) {
  const scope = holder?.owner_scope;
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  if (owner.scope === "user") return scope === "user" && same(holder.owner_user_id, owner.userId);
  if (owner.scope === "team") {
    return (scope === "team" && same(holder.owner_team_id, owner.teamId))
      || (scope === "club" && same(holder.owner_club_id, owner.teamClubId));
  }
  if (owner.scope === "club") {
    return (scope === "club" && same(holder.owner_club_id, owner.clubId))
      || (scope === "team" && same(holder.owner_team_club_id, owner.clubId));
  }
  return false;
}

// The plans FOR SHARE in ascending id: a Builder save, delete or batch sync
// of one of them takes its row FOR UPDATE first, so the two serialize and
// the sessions are resolved again after the lock (whatever the Builder did
// meanwhile is what the link sees).
async function lockPlansForShare(client, planIds) {
  const ids = [...new Set(planIds.filter(Boolean).map(String))].sort();
  if (ids.length) await client.query(`select id from plans.plans where id = any($1::uuid[]) order by id for share`, [ids]);
}

// The published sessions named by logical session id, with what the attach
// and the alignment decide on: the viewer's calendar scope on the session's
// day, the event's targets on that day, the plan's stored owner, the flags,
// the workspace switch, and the event a live link of the slot already names.
// `lockSessions` takes the rows FOR UPDATE in ascending id (the alignment's
// write).
async function readLinkableSessions(client, ctx, eventId, logicalSessionIds, { lockSessions = false } = {}) {
  const params = [logicalSessionIds, eventId];
  const scope = calendarAthleteScopeSql(ctx, "ath", params, "pd.date");
  const targeted = eventTargetsAthleteSql("$2::uuid", "ath.id", "pd.date");
  const result = await client.query(
    `select ps.logical_session_id, ps.id as session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_order,
            ps.rpe_enabled, ps.training_load_enabled, pd.date as day, p.id as plan_id, p.athlete_id,
            pwo.owner_scope, pwo.owner_user_id, pwo.owner_club_id, pwo.owner_team_id, ot.club_id as owner_team_club_id,
            (${scope}) as in_scope, (${targeted}) as targeted,
            coalesce(training_load.planned_rpe_effective_for_plan(p.id, pd.date), false) as switch_on,
            (select l.event_id from calendar.event_session_links l
              where l.plan_id = p.id and l.day = pd.date and l.am_pm is not distinct from ps.am_pm
                and l.bta is not distinct from ps.bta and l.session_order = ps.session_order and l.ended_at is null) as linked_event_id
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       join public.athletes ath on ath.id = p.athlete_id
       left join training_load.plan_workspace_ownership pwo on pwo.plan_id = p.id
       left join public.teams ot on ot.id = pwo.owner_team_id
      where ps.logical_session_id = any($1::uuid[]) and ${WEEKLY_PLAN_SESSION_FILTER_SQL}
      order by ps.id${lockSessions ? " for update of ps" : ""}`,
    params,
  );
  return result.rows;
}

// Every named id is one published session the caller's scope sees on its
// day, of a plan inside the event owner's tree; a missing, foreign,
// out-of-scope, unpublished or other-owner id is the one answer.
function allLinkable(owner, sessions, logicalSessionIds) {
  const found = new Set(sessions.filter((x) => x.in_scope === true && withinEventOwner(owner, x)).map((x) => String(x.logical_session_id)));
  return sessions.length === logicalSessionIds.length && logicalSessionIds.every((id) => found.has(id));
}

async function bumpRevision(client, eventId) {
  await client.query(`update calendar.events set revision = revision + 1 where id = $1`, [eventId]);
}

function inEventDays(row, day) {
  return day >= dateStr(row.day) && day <= (dateStr(row.end_day) || dateStr(row.day));
}

// D20, option A: the linked sessions' flags follow the event's `expects` —
// an event expecting RPE turns Training Load tracking and RPE on, one that
// does not turns RPE off (tracking left as it is); written through the one
// write path of the Training Load quick toggles (plannedSessionFlags.js),
// only on plans the active workspace MANAGES (the stored
// plan_workspace_ownership, canManagePlanTrainingLoadInScope — a plan the
// scope only reads is `notAllowed` and its gap stays). Turning RPE off on a
// session that already has results needs `confirmDisableWithResults` (the
// quick toggles' gate): without it nothing is written and the answer is 409
// has_existing_results. The workspace planned-RPE switch is never touched;
// a session whose switch is off is counted `switchOff` (it asks once the
// switch is on). The sessions arrive locked FOR UPDATE. Every session of one
// command gets the same flags (RPE on: tracking and RPE; RPE off: RPE alone,
// tracking left as each row has it, its edit-draft copy included), so one
// call of the shared function writes them all: the statements do not grow
// with the number of sessions.
async function alignLinkedSessions(client, ctx, eventRow, sessions, confirmDisableWithResults) {
  const expectsRpe = (eventRow.expects || []).includes("rpe");
  const scope = externalScheduleScopeForWorkspace(ctx.workspace, { user: { id: ctx.userId } });
  const outcome = { direction: expectsRpe ? "rpe_on" : "rpe_off", changed: 0, unchanged: 0, notAllowed: 0, switchOff: 0 };
  const want = expectsRpe ? { trainingLoadEnabled: true, rpeEnabled: true } : { rpeEnabled: false };
  const toWrite = [];
  for (const session of sessions) {
    // `switchOff` counts the sessions that follow the event after this
    // command (already aligned or written now) whose workspace switch is off.
    const switchOff = expectsRpe && !session.switch_on;
    const follows = expectsRpe ? session.training_load_enabled === true && session.rpe_enabled === true : session.rpe_enabled !== true;
    if (follows) {
      outcome.unchanged += 1;
      if (switchOff) outcome.switchOff += 1;
      continue;
    }
    const ownership = { owner_scope: session.owner_scope, owner_user_id: session.owner_user_id, owner_club_id: session.owner_club_id, owner_team_id: session.owner_team_id };
    if (scope.type === null || !canManagePlanTrainingLoadInScope(scope, ownership)) {
      outcome.notAllowed += 1;
      continue;
    }
    toWrite.push(session);
    if (switchOff) outcome.switchOff += 1;
  }
  if (!expectsRpe && !confirmDisableWithResults && toWrite.length) {
    const counted = await client.query(
      `select count(*)::int as n from training_load.session_feedback where logical_session_id = any($1::uuid[])`,
      [toWrite.map((session) => session.logical_session_id)],
    );
    if (counted.rows[0].n > 0) {
      throw conflict("has_existing_results", "Some of these sessions already have RPE results. Confirm to stop asking for RPE.", { resultCount: counted.rows[0].n });
    }
  }
  if (toWrite.length) {
    await writePublishedSessionFlags(client, {
      sessions: toWrite.map((session) => ({ sessionId: session.session_id, planId: session.plan_id, logicalSessionId: session.logical_session_id })),
      ...want,
    });
  }
  outcome.changed = toWrite.length;
  return outcome;
}

// POST /:id/sessions — attach planned sessions (a planned card's
// `links.logicalSessionIds`): one slot-key link per session (plan section
// 2.2), the session's athlete a target of the event on that day, the session
// on one of the event's days, inside the caller's calendar scope and of a
// plan inside the event owner's tree (withinEventOwner); a slot already
// linked to this event is kept (idempotent), to another event is a 409. `alignSessions: true` aligns the named sessions' flags (D20).
export async function attachSessions(ctx, eventId, body) {
  if (!isUuid(eventId)) throw notFound();
  const { requestKey, canonical } = validateAttachSessionsBody(body);
  return runEventCommand(ctx, { requestKey, canonical, eventId: eventId.toLowerCase() }, async ({ client, owner, row }) => {
    await requireOpenAndCurrent(client, ctx, row, canonical.expectedRevision);
    // Decided first on an unlocked read, so a refused id never takes (or
    // waits on) a lock of a plan the caller may not link; then the plans of
    // the linkable sessions FOR SHARE in ascending id, and the sessions read
    // and judged again under those locks (what the Builder did meanwhile is
    // what the link sees).
    const unlocked = await readLinkableSessions(client, ctx, row.id, canonical.logicalSessionIds);
    if (!allLinkable(owner, unlocked, canonical.logicalSessionIds)) throw sessionNotAvailable();
    await lockPlansForShare(client, unlocked.map((x) => x.plan_id));
    const sessions = await readLinkableSessions(client, ctx, row.id, canonical.logicalSessionIds, { lockSessions: canonical.alignSessions });
    if (!allLinkable(owner, sessions, canonical.logicalSessionIds)) throw sessionNotAvailable();
    if (sessions.some((x) => !inEventDays(row, dateStr(x.day)))) {
      throw conflict("session_outside_event", "A session must be on one of the event's days.");
    }
    const notTargeted = sessions.filter((x) => x.targeted !== true).length;
    if (notTargeted) throw conflict("athlete_not_targeted", "An athlete of these sessions is not a target of this event on that day.", { count: notTargeted });
    if (sessions.some((x) => x.linked_event_id && String(x.linked_event_id) !== String(row.id))) {
      throw conflict("session_already_attached", "One of these sessions is already attached to another event.");
    }
    const fresh = sessions.filter((x) => !x.linked_event_id);
    if (fresh.length) {
      await client.query(
        `insert into calendar.event_session_links (event_id, plan_id, day, am_pm, bta, session_order, logical_session_id_at_link, session_name_at_link, linked_by_user_id)
         select $1, x.plan_id, x.day, x.am_pm, x.bta, x.session_order, x.logical_session_id, x.session_name, $2
           from unnest($3::uuid[], $4::date[], $5::text[], $6::text[], $7::int[], $8::uuid[], $9::text[])
                as x(plan_id, day, am_pm, bta, session_order, logical_session_id, session_name)`,
        [row.id, ctx.userId, fresh.map((x) => x.plan_id), fresh.map((x) => dateStr(x.day)), fresh.map((x) => x.am_pm),
          fresh.map((x) => x.bta), fresh.map((x) => Number(x.session_order) || 0), fresh.map((x) => x.logical_session_id),
          fresh.map((x) => linkName(x.session_name))],
      );
    }
    const alignment = canonical.alignSessions ? await alignLinkedSessions(client, ctx, row, sessions, canonical.confirmDisableWithResults) : null;
    await bumpRevision(client, row.id);
    const view = await readEventView(client, ctx, row.id);
    const details = {
      sessions: fresh.length, alreadyAttached: sessions.length - fresh.length,
      planIds: [...new Set(fresh.map((x) => String(x.plan_id)))].sort(),
    };
    if (alignment) Object.assign(details, { align: alignment.direction, aligned: alignment.changed, notAllowed: alignment.notAllowed, switchOff: alignment.switchOff });
    const counts = { attached: fresh.length, alreadyAttached: sessions.length - fresh.length, alignment };
    return { eventId: row.id, httpStatus: 200, body: { event: view, ...counts }, counts, details };
  });
}

// The name kept on the link for information (v49's CHECK: the text rule, at
// most 120 characters; a longer or unprintable name is not kept).
function linkName(name) {
  const value = String(name ?? "").trim();
  return value && boundedText(value, 120) ? value : null;
}

// POST /:id/sessions/detach — end live session links of this event by their
// ids (the manager view's `sessionLinks[].id`; an orphaned link included).
// The flags of the sessions are left as they are.
export async function detachSessions(ctx, eventId, body) {
  if (!isUuid(eventId)) throw notFound();
  const { requestKey, canonical } = validateDetachSessionsBody(body);
  return runEventCommand(ctx, { requestKey, canonical, eventId: eventId.toLowerCase() }, async ({ client, row }) => {
    await requireOpenAndCurrent(client, ctx, row, canonical.expectedRevision);
    const planIds = (await client.query(
      `select plan_id from calendar.event_session_links where id = any($1::uuid[]) and event_id = $2 and ended_at is null`,
      [canonical.linkIds, row.id],
    )).rows.map((r) => r.plan_id);
    await lockPlansForShare(client, planIds);
    const links = (await client.query(
      `select id from calendar.event_session_links where id = any($1::uuid[]) and event_id = $2 and ended_at is null order by id for update`,
      [canonical.linkIds, row.id],
    )).rows;
    if (links.length !== canonical.linkIds.length) throw linkNotAvailable();
    await client.query(
      `update calendar.event_session_links set ended_at = now(), ended_by_user_id = $2 where id = any($1::uuid[])`,
      [canonical.linkIds, ctx.userId],
    );
    await bumpRevision(client, row.id);
    const view = await readEventView(client, ctx, row.id);
    const counts = { detached: links.length };
    return { eventId: row.id, httpStatus: 200, body: { event: view, ...counts }, counts, details: { sessions: links.length, linkIds: canonical.linkIds } };
  });
}

// POST /:id/sessions/align — align every live linked session of the event
// (not an orphaned link) to its `expects` (D20, option A).
export async function alignSessions(ctx, eventId, body) {
  if (!isUuid(eventId)) throw notFound();
  const { requestKey, canonical } = validateAlignSessionsBody(body);
  return runEventCommand(ctx, { requestKey, canonical, eventId: eventId.toLowerCase() }, async ({ client, row }) => {
    await requireOpenAndCurrent(client, ctx, row, canonical.expectedRevision);
    const linked = (await client.query(
      `select l.plan_id, ps.logical_session_id
         from calendar.event_session_links l
         join plans.plans p on p.id = l.plan_id
         join plans.plan_days pd on pd.plan_id = p.id and pd.date = l.day
         join plans.plan_sessions ps on ps.plan_day_id = pd.id and ps.am_pm is not distinct from l.am_pm
                                    and ps.bta is not distinct from l.bta and ps.session_order = l.session_order
         join calendar.events e on e.id = l.event_id
        where l.event_id = $1 and l.ended_at is null and l.day between e.day and coalesce(e.end_day, e.day)
          and ${WEEKLY_PLAN_SESSION_FILTER_SQL}`,
      [row.id],
    )).rows;
    if (!linked.length) throw conflict("nothing_to_align", "This event has no linked session to align.");
    await lockPlansForShare(client, linked.map((r) => r.plan_id));
    const logicalIds = [...new Set(linked.map((r) => String(r.logical_session_id)))].sort();
    // Under the plan locks: only the sessions still linked to this event.
    const sessions = (await readLinkableSessions(client, ctx, row.id, logicalIds, { lockSessions: true }))
      .filter((x) => String(x.linked_event_id) === String(row.id));
    if (!sessions.length) throw conflict("nothing_to_align", "This event has no linked session to align.");
    const alignment = await alignLinkedSessions(client, ctx, row, sessions, canonical.confirmDisableWithResults);
    await bumpRevision(client, row.id);
    const view = await readEventView(client, ctx, row.id);
    return {
      eventId: row.id, httpStatus: 200, body: { event: view, alignment }, counts: { alignment },
      details: { align: alignment.direction, aligned: alignment.changed, unchanged: alignment.unchanged, notAllowed: alignment.notAllowed, switchOff: alignment.switchOff },
    };
  });
}

// POST /:id/activities — attach an activity by hand (so `device_data` can be
// met): a canonical activity inside the caller's calendar read scope and the
// event owner's tree (withinEventOwner), on one of the event's days, with at
// least one participant who is a target of the event that day; already
// linked to this event is kept, to another is a 409. "Linked" counts every
// live link of the activity's aliases too (ADR-001: a link of an activity
// merged into this one names this one), so a merge never lets the survivor
// take a second event (independent review of PR #313, MEDIUM-1). The
// activity row is locked FOR SHARE after the event.
export async function attachActivity(ctx, eventId, body) {
  if (!isUuid(eventId)) throw notFound();
  const { requestKey, canonical } = validateActivityLinkBody(body, "attach_activity");
  return runEventCommand(ctx, { requestKey, canonical, eventId: eventId.toLowerCase() }, async ({ client, owner, row }) => {
    await requireOpenAndCurrent(client, ctx, row, canonical.expectedRevision);
    const params = [canonical.activityId, row.id];
    const scope = calendarActivityScopeSql(ctx, "a", params);
    const targeted = eventTargetsAthleteSql("$2::uuid", "ap.athlete_id", "a.occurred_local_date");
    const readActivity = async (lock) => (await client.query(
      `select a.id, a.lifecycle_state, a.occurred_local_date, (${scope}) as in_scope,
              a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id, ot.club_id as owner_team_club_id,
              exists (select 1 from training.activity_participants ap
                       where ap.activity_id = a.id and ap.merge_status = 'canonical' and ${targeted}) as targeted,
              (select l.event_id from calendar.event_activity_links l
                where l.activity_id in (select x.activity_id from training.activity_alias_ids(a.id) x) and l.ended_at is null
                order by (l.event_id = $2::uuid) desc, l.linked_at, l.id
                limit 1) as linked_event_id
         from training.activities a
         left join public.teams ot on ot.id = a.owner_team_id
        where a.id = $1${lock ? `
          for share of a` : ""}`,
      params,
    )).rows[0];
    // Inside the caller's read scope and the event owner's tree, decided on
    // an unlocked read first (a refused id never takes or waits on the
    // activity's lock), then again under the row lock.
    const linkable = (x) => x && x.in_scope === true && withinEventOwner(owner, x);
    if (!linkable(await readActivity(false))) throw activityNotAvailable();
    const activity = await readActivity(true);
    if (!linkable(activity)) throw activityNotAvailable();
    if (activity.lifecycle_state === "superseded") throw conflict("activity_superseded", "This activity was merged into another one. Reload and try again.");
    if (!inEventDays(row, dateStr(activity.occurred_local_date))) throw conflict("activity_outside_event", "The activity must be on one of the event's days.");
    if (activity.targeted !== true) throw conflict("activity_not_targeted", "No participant of this activity is a target of this event on that day.");
    if (activity.linked_event_id && String(activity.linked_event_id) !== String(row.id)) {
      throw conflict("activity_already_attached", "This activity is already attached to another event.");
    }
    const fresh = !activity.linked_event_id;
    if (fresh) {
      await client.query(
        `insert into calendar.event_activity_links (event_id, activity_id, link_method, linked_by_user_id) values ($1, $2, 'manual', $3)`,
        [row.id, activity.id, ctx.userId],
      );
    }
    await bumpRevision(client, row.id);
    const view = await readEventView(client, ctx, row.id);
    return { eventId: row.id, httpStatus: 200, body: { event: view, attached: fresh }, counts: { attached: fresh }, details: { activityId: activity.id, attached: fresh } };
  });
}

// POST /:id/activities/detach — end this event's live link of an activity
// (named by the canonical id the read shows, ADR-001).
export async function detachActivity(ctx, eventId, body) {
  if (!isUuid(eventId)) throw notFound();
  const { requestKey, canonical } = validateActivityLinkBody(body, "detach_activity");
  return runEventCommand(ctx, { requestKey, canonical, eventId: eventId.toLowerCase() }, async ({ client, row }) => {
    await requireOpenAndCurrent(client, ctx, row, canonical.expectedRevision);
    const links = (await client.query(
      `select l.id from calendar.event_activity_links l
        where l.event_id = $1 and l.ended_at is null and training.resolve_canonical_activity_id(l.activity_id) = $2
        order by l.id for update`,
      [row.id, canonical.activityId],
    )).rows;
    if (!links.length) throw linkNotAvailable();
    await client.query(
      `update calendar.event_activity_links set ended_at = now(), ended_by_user_id = $2 where id = any($1::uuid[])`,
      [links.map((l) => l.id), ctx.userId],
    );
    await bumpRevision(client, row.id);
    const view = await readEventView(client, ctx, row.id);
    return { eventId: row.id, httpStatus: 200, body: { event: view, detached: links.length }, counts: { detached: links.length }, details: { activityId: canonical.activityId } };
  });
}
