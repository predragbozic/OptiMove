// Central calendar K2b-1a — Settings -> Calendar: the club's event types,
// details (with their options), places and team settings (colour, default
// place). Plan: docs/ai/central-calendar-k2b-plan.md, sections 2-6 and 16
// (D24 who writes, D30 hidden options, D33-D38); migration v51.
//
// Who: the active CLUB workspace only, on the basis eventWriteBasis gives a
// club-owned event there (club_admin; a platform admin reaches a club
// workspace only through that club's club_admin role, T6). Everyone else:
// 403 on a collection route (workspace_required from the platform
// workspace), the identical 404 on a route that names an id (ADR-006), and
// the identical 400 for an id in a body (missing, foreign, archived and
// system-owned look the same). The system set is read-only (D35).
//
// Every write is ONE transaction through the calendar's command runner
// (calendarCommandRunner.js): the writer lock calendar.lock_event_writer
// (the club → its role row → the user, FOR SHARE; a team's settings: the
// team first), the subject FOR UPDATE, the requestKey replay (the hash binds
// the club and the subject), the referenced rows FOR SHARE in ascending id,
// the writes, the request row and one change row per subject written, the
// bounded COMMIT. Every update bumps the subject's revision; a stale
// expectedRevision is 409 <subject>_changed with the current view.
import { pool } from "./db.js";
import { boundedText, unitTokenOk } from "./metricTextRules.js";
import { isIconKey } from "./iconKeys.js";
import { isCalendarColorKey } from "./calendarColors.js";
import { EventError, eventWriteBasis, forbidden, notFound } from "./calendarEventAccess.js";
import { EVENT_EXPECTS, eventCatalogOwner, expectsField, isUuid, listEventTypes, requestKeyOf, revisionField, textField } from "./calendarEventService.js";
import { hashOf, runCalendarCommand } from "./calendarCommandRunner.js";

export const EVENT_KINDS = Object.freeze(["training", "match", "travel", "meeting", "day_off", "camp", "test"]);
export const VALUE_KINDS = Object.freeze(["choice", "number", "scale_1_5", "yes_no", "short_text"]);
export const LIMITS = Object.freeze({
  typeLabel: 60, fieldLabel: 60, fieldDescription: 200, optionLabel: 40, options: 20, minOptions: 2,
  typeFields: 20, locationName: 80, address: 200, note: 500, typeOrder: 200,
});

// Test-only seams (the event commands' pattern): default no-ops.
export const testHooks = {};

const bad = (code, message, details) => new EventError(400, code, message, details);
const conflict = (code, message, details) => new EventError(409, code, message, details);
const workspaceRequired = () => new EventError(403, "workspace_required", "Open the club's workspace to change its calendar settings.");

// ---------------------------------------------------------------------------
// Who may use Settings -> Calendar
// ---------------------------------------------------------------------------
// The club of the active workspace and the basis this request writes on, or
// the refusal: `withId` routes answer the one 404, collection routes 403.
export function settingsClub(ctx, { withId = false } = {}) {
  const refuse = () => (withId ? notFound() : forbidden());
  if (ctx.type !== "coach") throw refuse();
  if (ctx.workspace?.type === "platform") throw withId ? notFound() : workspaceRequired();
  if (ctx.workspace?.type !== "club") throw refuse();
  const clubId = String(ctx.workspace.scopeId);
  // T6: a club workspace is offered only to the holders of that club's
  // club_admin role (a platform admin included), and eventWriteBasis answers
  // club_admin first — the one basis Settings -> Calendar writes on.
  const basis = eventWriteBasis(ctx, { scope: "club", clubId, teamId: null, userId: null, teamClubId: null, teamActive: true, clubActive: true });
  if (basis !== "club_admin") throw refuse();
  return { clubId, basis };
}

// ---------------------------------------------------------------------------
// Body validation (400s, before any database work)
// ---------------------------------------------------------------------------
const ICON_RULE = "iconKey is a key of the icon library, or null.";
const COLOR_RULE = "colorKey is one of the palette's colours, or null.";

function plainObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid_body", "The request body must be a JSON object.");
  return body;
}

function only(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw bad("invalid_body", `Unknown field: ${key}.`);
  }
}

function iconField(body) {
  if (!("iconKey" in body)) return undefined;
  const raw = body.iconKey;
  if (raw === null) return null;
  if (!isIconKey(raw)) throw bad("invalid_icon", ICON_RULE);
  return raw;
}

function colorField(body) {
  if (!("colorKey" in body)) return undefined;
  const raw = body.colorKey;
  if (raw === null) return null;
  if (!isCalendarColorKey(raw)) throw bad("invalid_color", COLOR_RULE);
  return raw;
}

// An ordered list of distinct ids (possibly empty), at most `max`.
function orderedIds(body, field, code, max) {
  if (!(field in body)) return undefined;
  const raw = body[field];
  if (!Array.isArray(raw) || raw.length > max) throw bad(code, `${field} must be a list of at most ${max} ids.`);
  const out = [];
  for (const value of raw) {
    if (!isUuid(value)) throw bad(code, `${field} must hold UUIDs.`);
    const id = value.toLowerCase();
    if (out.includes(id)) throw bad(code, `${field} must not repeat an id.`);
    out.push(id);
  }
  return out;
}

function kindField(body) {
  if (!EVENT_KINDS.includes(body.kind)) throw bad("invalid_kind", `kind must be one of ${EVENT_KINDS.join(", ")}.`);
  return body.kind;
}

function numberOrNull(body, field) {
  if (!(field in body)) return undefined;
  const raw = body[field];
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || Math.abs(raw) >= 1e9 || Math.round(raw * 1000) / 1000 !== raw) {
    throw bad("invalid_number", `${field} must be a number below a billion with at most three decimals.`);
  }
  return raw;
}

function unitField(body) {
  if (!("unit" in body)) return undefined;
  const raw = body.unit;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !unitTokenOk(raw.trim())) throw bad("invalid_unit", "unit is 1-30 characters without spaces.");
  return raw.trim();
}

function optionLabel(raw, field) {
  if (typeof raw !== "string" || !boundedText(raw.trim(), LIMITS.optionLabel)) {
    throw bad("invalid_option", `${field}: an option is 1-${LIMITS.optionLabel} visible characters on one line.`);
  }
  return raw.trim();
}

function requiredField(body) {
  if (!("required" in body)) return undefined;
  if (typeof body.required !== "boolean") throw bad("invalid_required", "required must be true or false.");
  return body.required;
}

function bounds(minValue, maxValue) {
  if (minValue !== null && minValue !== undefined && maxValue !== null && maxValue !== undefined && minValue > maxValue) {
    throw bad("invalid_number", "minValue must not be above maxValue.");
  }
}

function expectsList(body) {
  const value = expectsField(body);
  if (value === null) throw bad("invalid_expects", "defaultExpects must be a list.");
  return value;
}

export function validateTypeCreate(body) {
  plainObject(body);
  only(body, ["requestKey", "label", "kind", "iconKey", "colorKey", "defaultExpects", "fieldIds"]);
  const requestKey = requestKeyOf(body);
  const defaultExpects = "defaultExpects" in body ? expectsList({ expects: body.defaultExpects }) : [];
  return {
    requestKey,
    canonical: {
      operation: "type_create",
      label: textField(body, "label", LIMITS.typeLabel, "invalid_label", { required: true }),
      kind: kindField(body),
      iconKey: iconField(body) ?? null,
      colorKey: colorField(body) ?? null,
      defaultExpects,
      fieldIds: orderedIds(body, "fieldIds", "invalid_fields", LIMITS.typeFields) ?? [],
    },
  };
}

export function validateTypeUpdate(body) {
  plainObject(body);
  only(body, ["requestKey", "expectedRevision", "label", "iconKey", "colorKey", "defaultExpects", "fieldIds"]);
  const requestKey = requestKeyOf(body);
  const expectedRevision = revisionField(body);
  const fields = {};
  const put = (name, value) => { if (value !== undefined) fields[name] = value; };
  put("label", textField(body, "label", LIMITS.typeLabel, "invalid_label"));
  if ("label" in fields && fields.label === null) throw bad("invalid_label", "label cannot be empty.");
  put("iconKey", iconField(body));
  put("colorKey", colorField(body));
  if ("defaultExpects" in body) fields.defaultExpects = expectsList({ expects: body.defaultExpects });
  put("fieldIds", orderedIds(body, "fieldIds", "invalid_fields", LIMITS.typeFields));
  if (!Object.keys(fields).length) throw bad("nothing_to_change", "Send at least one field to change.");
  return { requestKey, canonical: { operation: "type_update", expectedRevision, fields } };
}

export function validateArchive(body, operation) {
  plainObject(body);
  only(body, ["requestKey", "expectedRevision"]);
  return { requestKey: requestKeyOf(body), canonical: { operation, expectedRevision: revisionField(body) } };
}

export function validateTypeOrder(body) {
  plainObject(body);
  only(body, ["requestKey", "typeIds"]);
  const requestKey = requestKeyOf(body);
  const typeIds = orderedIds(body, "typeIds", "invalid_order", LIMITS.typeOrder);
  if (!typeIds || !typeIds.length) throw bad("invalid_order", "typeIds must list every live type once.");
  return { requestKey, canonical: { operation: "type_order", typeIds } };
}

export function validateFieldCreate(body) {
  plainObject(body);
  only(body, ["requestKey", "label", "valueKind", "description", "unit", "minValue", "maxValue", "options", "required"]);
  const requestKey = requestKeyOf(body);
  if (!VALUE_KINDS.includes(body.valueKind)) throw bad("invalid_value_kind", `valueKind must be one of ${VALUE_KINDS.join(", ")}.`);
  const valueKind = body.valueKind;
  const number = valueKind === "number";
  if (!number && (body.unit != null || body.minValue != null || body.maxValue != null)) {
    throw bad("invalid_number", "unit, minValue and maxValue belong to a number detail only.");
  }
  const minValue = number ? numberOrNull(body, "minValue") ?? null : null;
  const maxValue = number ? numberOrNull(body, "maxValue") ?? null : null;
  bounds(minValue, maxValue);
  let options = [];
  if (valueKind === "choice") {
    if (!Array.isArray(body.options) || body.options.length < LIMITS.minOptions || body.options.length > LIMITS.options) {
      throw bad("invalid_option", `A choice detail needs ${LIMITS.minOptions} to ${LIMITS.options} options.`);
    }
    options = body.options.map((raw) => optionLabel(raw, "options"));
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw bad("invalid_option", "Two options have the same label.");
  } else if (body.options !== undefined && !(Array.isArray(body.options) && body.options.length === 0)) {
    throw bad("invalid_option", "Only a choice detail has options.");
  }
  return {
    requestKey,
    canonical: {
      operation: "field_create",
      label: textField(body, "label", LIMITS.fieldLabel, "invalid_label", { required: true }),
      valueKind,
      description: textField(body, "description", LIMITS.fieldDescription, "invalid_description") ?? null,
      unit: number ? unitField(body) ?? null : null,
      minValue,
      maxValue,
      options,
      required: requiredField(body) ?? false,
    },
  };
}

export function validateFieldUpdate(body) {
  plainObject(body);
  only(body, ["requestKey", "expectedRevision", "label", "description", "unit", "minValue", "maxValue", "required", "options"]);
  const requestKey = requestKeyOf(body);
  const expectedRevision = revisionField(body);
  const fields = {};
  const put = (name, value) => { if (value !== undefined) fields[name] = value; };
  put("label", textField(body, "label", LIMITS.fieldLabel, "invalid_label"));
  if ("label" in fields && fields.label === null) throw bad("invalid_label", "label cannot be empty.");
  put("description", textField(body, "description", LIMITS.fieldDescription, "invalid_description"));
  put("unit", unitField(body));
  put("minValue", numberOrNull(body, "minValue"));
  put("maxValue", numberOrNull(body, "maxValue"));
  put("required", requiredField(body));
  if ("options" in body) {
    const raw = body.options;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("invalid_option", "options is { add, rename, hide, show }.");
    only(raw, ["add", "rename", "hide", "show"]);
    const ops = { add: [], rename: [], hide: [], show: [] };
    if (raw.add !== undefined) {
      if (!Array.isArray(raw.add) || raw.add.length > LIMITS.options) throw bad("invalid_option", "options.add is a list of labels.");
      ops.add = raw.add.map((label) => optionLabel(label, "options.add"));
    }
    if (raw.rename !== undefined) {
      if (!Array.isArray(raw.rename) || raw.rename.length > LIMITS.options) throw bad("invalid_option", "options.rename is a list of { id, label }.");
      ops.rename = raw.rename.map((r) => {
        if (!r || !isUuid(r.id)) throw bad("invalid_option", "options.rename needs an option id.");
        return { id: r.id.toLowerCase(), label: optionLabel(r.label, "options.rename") };
      });
    }
    for (const op of ["hide", "show"]) {
      if (raw[op] !== undefined) {
        if (!Array.isArray(raw[op]) || raw[op].length > LIMITS.options || raw[op].some((id) => !isUuid(id))) {
          throw bad("invalid_option", `options.${op} is a list of option ids.`);
        }
        ops[op] = raw[op].map((id) => id.toLowerCase());
      }
    }
    const touched = [...ops.rename.map((r) => r.id), ...ops.hide, ...ops.show];
    if (new Set(touched).size !== touched.length) throw bad("invalid_option", "An option is named twice.");
    if (ops.add.length || touched.length) fields.options = ops;
  }
  if (!Object.keys(fields).length) throw bad("nothing_to_change", "Send at least one field to change.");
  return { requestKey, canonical: { operation: "field_update", expectedRevision, fields } };
}

export function validateLocationCreate(body) {
  plainObject(body);
  only(body, ["requestKey", "name", "address", "note"]);
  return {
    requestKey: requestKeyOf(body),
    canonical: {
      operation: "location_create",
      name: textField(body, "name", LIMITS.locationName, "invalid_name", { required: true }),
      address: textField(body, "address", LIMITS.address, "invalid_address") ?? null,
      note: textField(body, "note", LIMITS.note, "invalid_note", { multiline: true }) ?? null,
    },
  };
}

export function validateLocationUpdate(body) {
  plainObject(body);
  only(body, ["requestKey", "expectedRevision", "name", "address", "note"]);
  const requestKey = requestKeyOf(body);
  const expectedRevision = revisionField(body);
  const fields = {};
  const put = (name, value) => { if (value !== undefined) fields[name] = value; };
  put("name", textField(body, "name", LIMITS.locationName, "invalid_name"));
  if ("name" in fields && fields.name === null) throw bad("invalid_name", "name cannot be empty.");
  put("address", textField(body, "address", LIMITS.address, "invalid_address"));
  put("note", textField(body, "note", LIMITS.note, "invalid_note", { multiline: true }));
  if (!Object.keys(fields).length) throw bad("nothing_to_change", "Send at least one field to change.");
  return { requestKey, canonical: { operation: "location_update", expectedRevision, fields } };
}

export function validateTeamUpdate(body) {
  plainObject(body);
  only(body, ["requestKey", "expectedRevision", "colorKey", "defaultLocationId"]);
  const requestKey = requestKeyOf(body);
  const raw = body.expectedRevision;
  if (!Number.isInteger(raw) || raw < 0) throw bad("invalid_revision", "expectedRevision is 0 (no settings yet) or the current revision.");
  const fields = {};
  const color = colorField(body);
  if (color !== undefined) fields.colorKey = color;
  if ("defaultLocationId" in body) {
    const value = body.defaultLocationId;
    if (value !== null && !isUuid(value)) throw bad("invalid_location", "defaultLocationId must be a UUID or null.");
    fields.defaultLocationId = value === null ? null : value.toLowerCase();
  }
  if (!Object.keys(fields).length) throw bad("nothing_to_change", "Send at least one field to change.");
  return { requestKey, canonical: { operation: "team_update", expectedRevision: raw, fields } };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);

// The events of club $1 (owned by the club, or by one of its teams NOW): a
// team moved to another club takes its events with it, and their counts
// never reach the old club (security review of K2b-1a, M1).
const CLUB_EVENT_SQL = `(e.owner_club_id = $1 or exists (select 1 from public.teams et where et.id = e.owner_team_id and et.club_id = $1))`;

const TYPE_VIEW_SQL = `
  select t.id, t.key, t.kind, t.label, t.icon_key, t.color_key, t.default_expects, t.sort_order, t.seed_key,
         t.archived_at, t.revision,
         (select coalesce(array_agg(l.field_id order by l.position, l.field_id), '{}') from calendar.event_type_fields l
           where l.event_type_id = t.id) as field_ids,
         (select count(*)::int from calendar.events e where e.event_type_id = t.id and ${CLUB_EVENT_SQL}) as event_count
    from calendar.event_types t
   where t.owner_scope = 'club' and t.owner_club_id = $1`;

function typeView(r) {
  return {
    id: r.id, key: r.key, kind: r.kind, label: r.label, iconKey: r.icon_key, colorKey: r.color_key,
    defaultExpects: EVENT_EXPECTS.filter((e) => (r.default_expects || []).includes(e)),
    fieldIds: (r.field_ids || []).map(String), sortOrder: r.sort_order, seeded: r.seed_key !== null,
    archived: r.archived_at !== null, archivedAt: iso(r.archived_at), revision: r.revision, eventCount: r.event_count, canEdit: true,
  };
}

const FIELD_VIEW_SQL = `
  select f.id, f.key, f.label, f.description, f.filled_by, f.value_kind, f.unit, f.min_value, f.max_value, f.required,
         f.sort_order, f.seed_key, f.archived_at, f.revision,
         calendar.field_has_values(f.id) as answered,
         (select count(*)::int from calendar.event_selected_fields s join calendar.events e on e.id = s.event_id
           where s.field_id = f.id and ${CLUB_EVENT_SQL}) as event_count,
         (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'sortOrder', o.sort_order, 'archived', o.archived_at is not null)
                   order by o.sort_order, o.created_at, o.id), '[]'::jsonb)
            from calendar.event_field_options o where o.field_id = f.id) as options
    from calendar.event_fields f
   where f.owner_scope = 'club' and f.owner_club_id = $1`;

function fieldView(r) {
  return {
    id: r.id, key: r.key, label: r.label, description: r.description, filledBy: r.filled_by, valueKind: r.value_kind,
    unit: r.unit, minValue: num(r.min_value), maxValue: num(r.max_value), required: r.required, sortOrder: r.sort_order,
    seeded: r.seed_key !== null, archived: r.archived_at !== null, revision: r.revision,
    answered: r.answered === true, eventCount: r.event_count, options: r.options || [], canEdit: true,
  };
}

const LOCATION_VIEW_SQL = `
  select l.id, l.name, l.address, l.note, l.archived_at, l.revision,
         (select count(*)::int from calendar.events e where e.location_id = l.id and ${CLUB_EVENT_SQL}) as event_count,
         (select coalesce(array_agg(s.team_id order by s.team_id), '{}') from calendar.team_settings s
            join public.teams st on st.id = s.team_id and st.club_id = l.owner_club_id
           where s.default_location_id = l.id) as default_of_team_ids
    from calendar.locations l
   where l.owner_club_id = $1`;

function locationView(r) {
  return {
    id: r.id, name: r.name, address: r.address, note: r.note, archived: r.archived_at !== null, revision: r.revision,
    eventCount: r.event_count, defaultOfTeamIds: (r.default_of_team_ids || []).map(String), canEdit: true,
  };
}

// The club's ACTIVE teams with their settings (revision 0 = no row yet). A
// default place of another club (the team was moved) reads as none.
const TEAM_VIEW_SQL = `
  select t.id as team_id, t.name, s.color_key,
         case when dl.owner_club_id = t.club_id then s.default_location_id end as default_location_id,
         coalesce(s.revision, 0) as revision
    from public.teams t
    left join calendar.team_settings s on s.team_id = t.id
    left join calendar.locations dl on dl.id = s.default_location_id
   where t.club_id = $1 and coalesce(t.is_active, true)`;

function teamView(r) {
  return { teamId: r.team_id, name: r.name, colorKey: r.color_key ?? null, defaultLocationId: r.default_location_id ?? null, revision: r.revision };
}

async function readTypes(queryable, clubId, ids = null) {
  const rows = (await queryable.query(`${TYPE_VIEW_SQL}${ids ? " and t.id = any($2::uuid[])" : ""} order by t.archived_at is not null, t.sort_order, t.label, t.id`,
    ids ? [clubId, ids] : [clubId])).rows;
  return rows.map(typeView);
}
async function readFields(queryable, clubId, ids = null) {
  const rows = (await queryable.query(`${FIELD_VIEW_SQL}${ids ? " and f.id = any($2::uuid[])" : ""} order by f.archived_at is not null, f.sort_order, f.label, f.id`,
    ids ? [clubId, ids] : [clubId])).rows;
  return rows.map(fieldView);
}
async function readLocations(queryable, clubId, ids = null) {
  const rows = (await queryable.query(`${LOCATION_VIEW_SQL}${ids ? " and l.id = any($2::uuid[])" : ""} order by l.archived_at is not null, l.name, l.id`,
    ids ? [clubId, ids] : [clubId])).rows;
  return rows.map(locationView);
}
async function readTeams(queryable, clubId, ids = null) {
  const rows = (await queryable.query(`${TEAM_VIEW_SQL}${ids ? " and t.id = any($2::uuid[])" : ""} order by t.name, t.id`,
    ids ? [clubId, ids] : [clubId])).rows;
  return rows.map(teamView);
}

// GET /api/calendar/settings — the active club's whole catalog.
export async function getSettings(ctx) {
  const { clubId } = settingsClub(ctx);
  const [types, fields, locations, teams] = await Promise.all([
    readTypes(pool, clubId), readFields(pool, clubId), readLocations(pool, clubId), readTeams(pool, clubId),
  ]);
  return { clubId, types, fields, locations, teams };
}

// One subject as the caller may see it now (a write's answer, a replay).
async function subjectView(queryable, clubId, kind, id) {
  if (kind === "type") return { type: (await readTypes(queryable, clubId, [id]))[0] ?? null };
  if (kind === "types") return { types: await readTypes(queryable, clubId) };
  if (kind === "field") return { field: (await readFields(queryable, clubId, [id]))[0] ?? null };
  if (kind === "location") return { location: (await readLocations(queryable, clubId, [id]))[0] ?? null };
  return { team: (await readTeams(queryable, clubId, [id]))[0] ?? null };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------
const LABEL_TAKEN_CONSTRAINTS = new Set([
  "event_types_owner_label_live_key", "event_fields_owner_label_live_key", "locations_club_name_live_key", "event_field_options_label_live_key",
]);
const BUSY_CONSTRAINTS = new Set([
  "event_types_owner_key_key", "event_fields_owner_key_key", "settings_changes_type_revision_key", "settings_changes_field_revision_key",
  "settings_changes_location_revision_key", "settings_changes_team_revision_key",
]);
const BUSY = "The calendar settings are being changed. Try again.";

const SUBJECT_ROW_SQL = {
  type: `select t.id, t.revision, t.archived_at, t.kind, t.seed_key from calendar.event_types t
          where t.id = $1 and t.owner_scope = 'club' and t.owner_club_id = $2 for update`,
  field: `select f.id, f.revision, f.archived_at, f.value_kind, f.label, f.unit, f.min_value, f.max_value from calendar.event_fields f
           where f.id = $1 and f.owner_scope = 'club' and f.owner_club_id = $2 for update`,
  location: `select l.id, l.revision, l.archived_at from calendar.locations l where l.id = $1 and l.owner_club_id = $2 for update`,
};

// subject: { kind: "type" | "field" | "location" | "team" | null, id }
async function runSettingsCommand(ctx, { requestKey, canonical, subject }, apply) {
  const withId = Boolean(subject?.id);
  const { clubId, basis } = settingsClub(ctx, { withId });
  const operation = canonical.operation;
  return runCalendarCommand({
    userId: ctx.userId, requestKey, operation, label: "calendar-settings", subject: `${operation} in club ${clubId}`,
    requestsTable: "calendar.settings_requests", requestKeyConstraint: "settings_requests_one_per_key",
    busyMessage: BUSY, hooks: testHooks,
    async prepare(client) {
      const hash = hashOf({ canonical, club: clubId, subject: withId ? `${subject.kind}:${subject.id}` : null });
      if (testHooks.beforeLocks) await testHooks.beforeLocks({ client, operation });
      let lockScope = "club";
      let lockOwner = clubId;
      if (subject?.kind === "team") {
        const team = (await client.query(`select t.club_id from public.teams t where t.id = $1`, [subject.id])).rows[0];
        if (!team || String(team.club_id) !== clubId) throw notFound();
        lockScope = "team";
        lockOwner = subject.id;
      }
      try {
        await client.query(`select calendar.lock_event_writer($1, $2, $3, $4)`, [ctx.userId, lockScope, lockOwner, basis]);
      } catch (error) {
        if (error?.code === "42501") throw withId ? notFound() : forbidden();
        throw error;
      }
      let row = null;
      if (subject?.kind === "team") {
        // Locked FOR SHARE by lock_event_writer; an archived team (which the
        // club's admin could write on for an event) takes no settings.
        const team = (await client.query(`select coalesce(t.is_active, true) as active, t.club_id from public.teams t where t.id = $1`, [subject.id])).rows[0];
        if (!team?.active || String(team.club_id) !== clubId) throw notFound();
        row = (await client.query(`select team_id, revision, default_location_id from calendar.team_settings where team_id = $1 for update`, [subject.id])).rows[0] ?? null;
      } else if (withId) {
        row = (await client.query(SUBJECT_ROW_SQL[subject.kind], [subject.id, clubId])).rows[0];
        if (!row) throw notFound();
      }
      return { hash, row };
    },
    // The hash binds the club and the subject; the saved club and subject are
    // compared too, as a second guard (the Independent review of PR #325).
    sameRequest: (prior, prepared) => prior.request_hash === prepared.hash && String(prior.club_id) === clubId
      && (!withId || String(prior.result?.subjectId ?? "") === subject.id),
    answer: async (queryable, stored, extra) => {
      if (testHooks.answerFault) await testHooks.answerFault();
      if (String(stored.clubId) !== clubId) throw notFound();
      const view = await subjectView(queryable, clubId, stored.subjectKind, stored.subjectId);
      return { status: stored.httpStatus || 200, body: { ...view, ...extra } };
    },
    apply: ({ client, row, requestId }) => apply({ client, row, requestId, clubId, basis }),
    async beforeRequestRow(client) {
      if (testHooks.beforeRequestRow) await testHooks.beforeRequestRow({ client, operation, requestKey, userId: ctx.userId });
    },
    async writeRecord({ client, requestId, out, hash }) {
      const stored = { httpStatus: out.httpStatus, clubId, subjectKind: out.subjectKind, subjectId: out.subjectId ?? null };
      await client.query(
        `insert into calendar.settings_requests (id, request_key, request_hash, operation, performed_by_user_id, club_id, result)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [requestId, requestKey, hash, operation, ctx.userId, clubId, JSON.stringify(stored)],
      );
      for (const change of out.changes) {
        const column = { type: "event_type_id", field: "field_id", location: "location_id", team: "team_id" }[change.kind];
        const table = { type: "calendar.event_types", field: "calendar.event_fields", location: "calendar.locations", team: "calendar.team_settings" }[change.kind];
        const idColumn = change.kind === "team" ? "team_id" : "id";
        const revision = (await client.query(`select revision from ${table} where ${idColumn} = $1`, [change.id])).rows[0].revision;
        await client.query(
          `insert into calendar.settings_changes (request_id, subject_kind, ${column}, revision, kind, basis, performed_by_user_id, details)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [requestId, change.kind, change.id, revision, operation, basis, ctx.userId, JSON.stringify(change.details || {})],
        );
      }
    },
    async beforeCommit(client) {
      if (testHooks.beforeCommit) await testHooks.beforeCommit({ client, operation });
    },
    respond: (out) => ({ status: out.httpStatus, body: out.body }),
    mapError(error) {
      if (error?.code === "23505" && LABEL_TAKEN_CONSTRAINTS.has(error.constraint)) return conflict("label_taken", "Another live item already has this name.");
      if (error?.code === "23505" && BUSY_CONSTRAINTS.has(error.constraint)) return conflict("try_again", BUSY);
      if (error?.code === "23505" && error.constraint === "team_settings_pkey") return conflict("team_changed", "This team's settings were changed meanwhile. Reload and try again.");
      if (error?.code === "23514" && error.constraint === "event_types_last_live") return conflict("last_type", "The club keeps at least one event type.");
      if (error?.code === "23514" && error.constraint === "event_fields_answered_frozen") return conflict("field_answered", "This detail already has answers: its meaning can't change.");
      if (error?.code === "23514" && (error.constraint === "event_field_options_max" || error.constraint === "event_type_fields_max")) {
        return bad("too_many", "That is more than the limit allows.");
      }
      if (error?.code === "23514" && error.constraint === "team_settings_location") return bad("location_not_available", LOCATION_NOT_AVAILABLE);
      return null;
    },
  });
}

const FIELD_NOT_AVAILABLE = "One of these details is not available in this workspace.";
const LOCATION_NOT_AVAILABLE = "This place is not available in this workspace.";
const OPTION_NOT_AVAILABLE = "One of these options is not an option of this detail.";

// The club's live details named by a list, FOR SHARE in ascending id: every
// id must be one (a missing, foreign, system or archived id is the one 400).
async function lockLiveFields(client, clubId, fieldIds) {
  if (!fieldIds.length) return;
  const sorted = [...fieldIds].sort();
  const rows = (await client.query(
    `select f.id from calendar.event_fields f
      where f.id = any($1::uuid[]) and f.owner_scope = 'club' and f.owner_club_id = $2 and f.archived_at is null
      order by f.id for share`,
    [sorted, clubId],
  )).rows;
  if (rows.length !== sorted.length) throw bad("field_not_available", FIELD_NOT_AVAILABLE);
}

// A type's list rewritten: the entries left out removed, the kept ones
// moved, the new ones added (an archived detail already listed stays, plan
// 2.6; v51 refuses an archived one as a NEW entry). Three statements.
async function writeTypeFields(client, typeId, fieldIds) {
  await client.query(`delete from calendar.event_type_fields where event_type_id = $1 and not (field_id = any($2::uuid[]))`, [typeId, fieldIds]);
  await client.query(
    `update calendar.event_type_fields l set position = f.ord - 1
       from unnest($2::uuid[]) with ordinality as f(id, ord)
      where l.event_type_id = $1 and l.field_id = f.id and l.position <> f.ord - 1`,
    [typeId, fieldIds],
  );
  await client.query(
    `insert into calendar.event_type_fields (event_type_id, field_id, position)
     select $1, f.id, f.ord - 1 from unnest($2::uuid[]) with ordinality as f(id, ord)
      where not exists (select 1 from calendar.event_type_fields x where x.event_type_id = $1 and x.field_id = f.id)`,
    [typeId, fieldIds],
  );
}

// A key from the label, unique for the club among every row (archived ones
// included); the database's unique index is the backstop (→ try_again).
async function freeKey(client, table, clubId, label, prefix) {
  let base = label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `${prefix}_${base}`.replace(/_+$/, "");
  base = base.slice(0, 36).replace(/_+$/, "");
  if (base.length < 2) base = `${prefix}_x`;
  const taken = new Set((await client.query(
    `select key from ${table} where owner_scope = 'club' and owner_club_id = $1 and key like $2`,
    [clubId, `${base}%`],
  )).rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  throw conflict("try_again", BUSY);
}

async function requireCurrent(client, clubId, kind, row, expectedRevision) {
  if (row.revision !== expectedRevision) {
    throw conflict(`${kind}_changed`, "This item was changed meanwhile. Reload it and try again.", { current: Object.values(await subjectView(client, clubId, kind, row.id ?? row.team_id))[0] });
  }
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pair = (before, after) => [before ?? null, after ?? null];

// ---- Types -----------------------------------------------------------------
export async function createType(ctx, body) {
  const { requestKey, canonical: c } = validateTypeCreate(body);
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: null }, async ({ client, clubId }) => {
    await lockLiveFields(client, clubId, c.fieldIds);
    const key = await freeKey(client, "calendar.event_types", clubId, c.label, "type");
    const sort = (await client.query(
      `select coalesce(max(sort_order), 0) + 10 as next from calendar.event_types where owner_scope = 'club' and owner_club_id = $1`, [clubId],
    )).rows[0].next;
    const id = (await client.query(
      `insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label, default_expects, icon_key, color_key, sort_order, created_by_user_id)
       values ('club', $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [clubId, c.kind, key, c.label, c.defaultExpects, c.iconKey, c.colorKey, sort, ctx.userId],
    )).rows[0].id;
    await writeTypeFields(client, id, c.fieldIds);
    const view = await subjectView(client, clubId, "type", id);
    return {
      httpStatus: 201, body: view, subjectKind: "type", subjectId: id,
      changes: [{ kind: "type", id, details: { kind: c.kind, iconKey: c.iconKey, colorKey: c.colorKey, defaultExpects: c.defaultExpects, fieldIds: c.fieldIds } }],
    };
  });
}

export async function updateType(ctx, typeId, body) {
  if (!isUuid(typeId)) throw notFound();
  const id = typeId.toLowerCase();
  const { requestKey, canonical: c } = validateTypeUpdate(body);
  const f = c.fields;
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: { kind: "type", id } }, async ({ client, row, clubId }) => {
    await requireCurrent(client, clubId, "type", row, c.expectedRevision);
    if (row.archived_at) throw conflict("type_archived", "This type is archived. Restore it first.", { current: (await subjectView(client, clubId, "type", id)).type });
    const before = (await subjectView(client, clubId, "type", id)).type;
    if (f.fieldIds) await lockLiveFieldsKeepingListed(client, clubId, f.fieldIds, before.fieldIds);
    await client.query(
      `update calendar.event_types
          set label = $2, icon_key = $3, color_key = $4, default_expects = $5, revision = revision + 1
        where id = $1`,
      [id, f.label ?? before.label, "iconKey" in f ? f.iconKey : before.iconKey, "colorKey" in f ? f.colorKey : before.colorKey,
        f.defaultExpects ?? before.defaultExpects],
    );
    if (f.fieldIds && !sameList(f.fieldIds, before.fieldIds)) await writeTypeFields(client, id, f.fieldIds);
    const after = (await subjectView(client, clubId, "type", id)).type;
    const details = {};
    if (after.label !== before.label) details.labelChanged = true;
    if (after.iconKey !== before.iconKey) details.iconKey = pair(before.iconKey, after.iconKey);
    if (after.colorKey !== before.colorKey) details.colorKey = pair(before.colorKey, after.colorKey);
    if (!sameList(after.defaultExpects, before.defaultExpects)) { details.defaultExpectsBefore = before.defaultExpects; details.defaultExpectsAfter = after.defaultExpects; }
    if (!sameList(after.fieldIds, before.fieldIds)) { details.fieldIdsBefore = before.fieldIds; details.fieldIdsAfter = after.fieldIds; }
    return { httpStatus: 200, body: { type: after }, subjectKind: "type", subjectId: id, changes: [{ kind: "type", id, details }] };
  });
}

// A type's list may keep a detail it already lists after that detail was
// archived (plan 2.6: archived details stay in the lists); a NEW entry must
// be a live detail of the club.
async function lockLiveFieldsKeepingListed(client, clubId, fieldIds, listed) {
  const fresh = fieldIds.filter((fid) => !listed.includes(fid));
  await lockLiveFields(client, clubId, fresh);
  const kept = fieldIds.filter((fid) => listed.includes(fid)).sort();
  if (kept.length) await client.query(`select id from calendar.event_fields where id = any($1::uuid[]) order by id for share`, [kept]);
}

async function archiveCommand(ctx, kind, subjectId, body, archive) {
  if (!isUuid(subjectId)) throw notFound();
  const id = subjectId.toLowerCase();
  const operation = `${kind}_${archive ? "archive" : "restore"}`;
  const { requestKey, canonical } = validateArchive(body, operation);
  const table = { type: "calendar.event_types", field: "calendar.event_fields", location: "calendar.locations" }[kind];
  return runSettingsCommand(ctx, { requestKey, canonical, subject: { kind, id } }, async ({ client, row, clubId }) => {
    await requireCurrent(client, clubId, kind, row, canonical.expectedRevision);
    const isArchived = row.archived_at !== null;
    if (archive && isArchived) throw conflict(`${kind}_archived`, "This item is already archived.", { current: Object.values(await subjectView(client, clubId, kind, id))[0] });
    if (!archive && !isArchived) throw conflict(`${kind}_live`, "This item is not archived.", { current: Object.values(await subjectView(client, clubId, kind, id))[0] });
    if (archive && kind === "type") {
      const others = (await client.query(
        `select count(*)::int as n from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and archived_at is null and id <> $2`,
        [clubId, id],
      )).rows[0].n;
      if (!others) throw conflict("last_type", "The club keeps at least one event type.");
    }
    await client.query(
      archive
        ? `update ${table} set archived_at = now(), archived_by_user_id = $2, revision = revision + 1 where id = $1`
        : `update ${table} set archived_at = null, archived_by_user_id = null, revision = revision + 1 where id = $1`,
      archive ? [id, ctx.userId] : [id],
    );
    const view = await subjectView(client, clubId, kind, id);
    return { httpStatus: 200, body: view, subjectKind: kind, subjectId: id, changes: [{ kind, id, details: { archived: pair(isArchived, archive) } }] };
  });
}
export const archiveType = (ctx, id, body) => archiveCommand(ctx, "type", id, body, true);
export const restoreType = (ctx, id, body) => archiveCommand(ctx, "type", id, body, false);
export const archiveField = (ctx, id, body) => archiveCommand(ctx, "field", id, body, true);
export const restoreField = (ctx, id, body) => archiveCommand(ctx, "field", id, body, false);
export const archiveLocation = (ctx, id, body) => archiveCommand(ctx, "location", id, body, true);
export const restoreLocation = (ctx, id, body) => archiveCommand(ctx, "location", id, body, false);

// POST /types/order — every live type exactly once, in the new order.
export async function orderTypes(ctx, body) {
  const { requestKey, canonical: c } = validateTypeOrder(body);
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: null }, async ({ client, clubId }) => {
    const live = (await client.query(
      `select id, sort_order from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and archived_at is null order by id for update`,
      [clubId],
    )).rows;
    const liveIds = live.map((r) => String(r.id)).sort();
    if (!sameList([...c.typeIds].sort(), liveIds)) {
      throw conflict("order_changed", "The list of types changed meanwhile. Reload it and try again.", { current: (await subjectView(client, clubId, "types")).types });
    }
    const changes = [];
    for (const [index, id] of c.typeIds.entries()) {
      const sort = (index + 1) * 10;
      const current = live.find((r) => String(r.id) === id);
      if (current.sort_order === sort) continue;
      await client.query(`update calendar.event_types set sort_order = $2, revision = revision + 1 where id = $1`, [id, sort]);
      changes.push({ kind: "type", id, details: { sortOrder: pair(current.sort_order, sort) } });
    }
    if (!changes.length) throw bad("nothing_to_change", "The types are already in this order.");
    return { httpStatus: 200, body: await subjectView(client, clubId, "types"), subjectKind: "types", subjectId: null, changes };
  });
}

// ---- Details ---------------------------------------------------------------
export async function createField(ctx, body) {
  const { requestKey, canonical: c } = validateFieldCreate(body);
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: null }, async ({ client, clubId }) => {
    const key = await freeKey(client, "calendar.event_fields", clubId, c.label, "detail");
    const sort = (await client.query(
      `select coalesce(max(sort_order), 0) + 10 as next from calendar.event_fields where owner_scope = 'club' and owner_club_id = $1`, [clubId],
    )).rows[0].next;
    const id = (await client.query(
      `insert into calendar.event_fields (owner_scope, owner_club_id, key, label, description, value_kind, unit, min_value, max_value, required, sort_order, created_by_user_id)
       values ('club', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [clubId, key, c.label, c.description, c.valueKind, c.unit, c.minValue, c.maxValue, c.required, sort, ctx.userId],
    )).rows[0].id;
    if (c.options.length) {
      await client.query(
        `insert into calendar.event_field_options (field_id, label, sort_order)
         select $1, o.label, o.ord * 10 from unnest($2::text[]) with ordinality as o(label, ord)`,
        [id, c.options],
      );
    }
    const view = await subjectView(client, clubId, "field", id);
    return {
      httpStatus: 201, body: view, subjectKind: "field", subjectId: id,
      changes: [{ kind: "field", id, details: { valueKind: c.valueKind, required: c.required, options: c.options.length, unit: c.unit !== null, bounds: [c.minValue, c.maxValue] } }],
    };
  });
}

export async function updateField(ctx, fieldId, body) {
  if (!isUuid(fieldId)) throw notFound();
  const id = fieldId.toLowerCase();
  const { requestKey, canonical: c } = validateFieldUpdate(body);
  const f = c.fields;
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: { kind: "field", id } }, async ({ client, row, clubId }) => {
    await requireCurrent(client, clubId, "field", row, c.expectedRevision);
    const before = (await subjectView(client, clubId, "field", id)).field;
    if (row.archived_at) throw conflict("field_archived", "This detail is archived. Restore it first.", { current: before });
    const number = row.value_kind === "number";
    if (!number && ("unit" in f || "minValue" in f || "maxValue" in f)) throw bad("invalid_number", "unit, minValue and maxValue belong to a number detail only.");
    if (f.options && row.value_kind !== "choice") throw bad("invalid_option", "Only a choice detail has options.");
    const next = {
      label: f.label ?? before.label,
      description: "description" in f ? f.description : before.description,
      unit: "unit" in f ? f.unit : before.unit,
      minValue: "minValue" in f ? f.minValue : before.minValue,
      maxValue: "maxValue" in f ? f.maxValue : before.maxValue,
      required: "required" in f ? f.required : before.required,
    };
    bounds(next.minValue, next.maxValue);
    const options = f.options || { add: [], rename: [], hide: [], show: [] };
    const known = new Map(before.options.map((o) => [String(o.id), o]));
    for (const oid of [...options.rename.map((r) => r.id), ...options.hide, ...options.show]) {
      if (!known.has(oid)) throw bad("option_not_available", OPTION_NOT_AVAILABLE);
    }
    const renamed = options.rename.filter((r) => known.get(r.id).label !== r.label);
    // The owner's rule (plan 2.3): with answers, the meaning stays.
    const frozen = [];
    if (next.label !== before.label) frozen.push("label");
    if (next.unit !== before.unit) frozen.push("unit");
    if (next.minValue !== before.minValue) frozen.push("minValue");
    if (next.maxValue !== before.maxValue) frozen.push("maxValue");
    if (renamed.length) frozen.push("options.rename");
    if (frozen.length && before.answered) {
      throw conflict("field_answered", "This detail already has answers: its meaning can't change. Add options, or archive it and create a new one.", { current: before, frozen });
    }
    const hidden = new Set(before.options.filter((o) => o.archived).map((o) => String(o.id)));
    for (const oid of options.hide) hidden.add(oid);
    for (const oid of options.show) hidden.delete(oid);
    const liveCount = before.options.length - hidden.size + options.add.length;
    if (row.value_kind === "choice" && liveCount < LIMITS.minOptions) throw conflict("too_few_options", `A choice detail keeps at least ${LIMITS.minOptions} visible options.`);
    if (liveCount > LIMITS.options) throw bad("too_many", `At most ${LIMITS.options} visible options.`);
    await client.query(
      `update calendar.event_fields
          set label = $2, description = $3, unit = $4, min_value = $5, max_value = $6, required = $7, revision = revision + 1
        where id = $1`,
      [id, next.label, next.description, next.unit, next.minValue, next.maxValue, next.required],
    );
    // Hide first (a label is unique among LIVE options), then rename, show,
    // add — each in one statement.
    if (options.hide.length) await client.query(`update calendar.event_field_options set archived_at = now() where field_id = $1 and id = any($2::uuid[]) and archived_at is null`, [id, options.hide]);
    for (const r of renamed) await client.query(`update calendar.event_field_options set label = $3 where field_id = $1 and id = $2`, [id, r.id, r.label]);
    if (options.show.length) await client.query(`update calendar.event_field_options set archived_at = null where field_id = $1 and id = any($2::uuid[]) and archived_at is not null`, [id, options.show]);
    if (options.add.length) {
      await client.query(
        `insert into calendar.event_field_options (field_id, label, sort_order)
         select $1, o.label, (select coalesce(max(sort_order), 0) from calendar.event_field_options where field_id = $1) + o.ord * 10
           from unnest($2::text[]) with ordinality as o(label, ord)`,
        [id, options.add],
      );
    }
    const after = (await subjectView(client, clubId, "field", id)).field;
    const details = {};
    if (after.label !== before.label) details.labelChanged = true;
    if (after.description !== before.description) details.descriptionChanged = true;
    if (after.unit !== before.unit) details.unitChanged = true;
    if (after.minValue !== before.minValue || after.maxValue !== before.maxValue) details.bounds = [before.minValue, before.maxValue, after.minValue, after.maxValue];
    if (after.required !== before.required) details.required = pair(before.required, after.required);
    if (options.add.length) details.optionsAdded = options.add.length;
    if (renamed.length) details.optionsRenamed = renamed.map((r) => r.id);
    if (options.hide.length) details.optionsHidden = options.hide;
    if (options.show.length) details.optionsShown = options.show;
    return { httpStatus: 200, body: { field: after }, subjectKind: "field", subjectId: id, changes: [{ kind: "field", id, details }] };
  });
}

// ---- Places ----------------------------------------------------------------
export async function createLocation(ctx, body) {
  const { requestKey, canonical: c } = validateLocationCreate(body);
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: null }, async ({ client, clubId }) => {
    const id = (await client.query(
      `insert into calendar.locations (owner_club_id, name, address, note, created_by_user_id) values ($1, $2, $3, $4, $5) returning id`,
      [clubId, c.name, c.address, c.note, ctx.userId],
    )).rows[0].id;
    return {
      httpStatus: 201, body: await subjectView(client, clubId, "location", id), subjectKind: "location", subjectId: id,
      changes: [{ kind: "location", id, details: { address: c.address !== null, note: c.note !== null } }],
    };
  });
}

export async function updateLocation(ctx, locationId, body) {
  if (!isUuid(locationId)) throw notFound();
  const id = locationId.toLowerCase();
  const { requestKey, canonical: c } = validateLocationUpdate(body);
  const f = c.fields;
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: { kind: "location", id } }, async ({ client, row, clubId }) => {
    await requireCurrent(client, clubId, "location", row, c.expectedRevision);
    const before = (await subjectView(client, clubId, "location", id)).location;
    if (row.archived_at) throw conflict("location_archived", "This place is archived. Restore it first.", { current: before });
    await client.query(
      `update calendar.locations set name = $2, address = $3, note = $4, revision = revision + 1 where id = $1`,
      [id, f.name ?? before.name, "address" in f ? f.address : before.address, "note" in f ? f.note : before.note],
    );
    const after = (await subjectView(client, clubId, "location", id)).location;
    const details = {};
    if (after.name !== before.name) details.nameChanged = true;
    if (after.address !== before.address) details.addressChanged = true;
    if (after.note !== before.note) details.noteChanged = true;
    return { httpStatus: 200, body: { location: after }, subjectKind: "location", subjectId: id, changes: [{ kind: "location", id, details }] };
  });
}

// ---- A team's colour and default place --------------------------------------
export async function updateTeam(ctx, teamId, body) {
  if (!isUuid(teamId)) throw notFound();
  const id = teamId.toLowerCase();
  const { requestKey, canonical: c } = validateTeamUpdate(body);
  const f = c.fields;
  return runSettingsCommand(ctx, { requestKey, canonical: c, subject: { kind: "team", id } }, async ({ client, row, clubId }) => {
    const current = row ? row.revision : 0;
    if (current !== c.expectedRevision) {
      throw conflict("team_changed", "This team's settings were changed meanwhile. Reload and try again.", { current: (await subjectView(client, clubId, "team", id)).team });
    }
    const before = (await subjectView(client, clubId, "team", id)).team;
    if (f.defaultLocationId && f.defaultLocationId !== before.defaultLocationId) {
      const place = (await client.query(
        `select 1 from calendar.locations where id = $1 and owner_club_id = $2 and archived_at is null for share`, [f.defaultLocationId, clubId],
      )).rows[0];
      if (!place) throw bad("location_not_available", LOCATION_NOT_AVAILABLE);
    }
    const colorKey = "colorKey" in f ? f.colorKey : before.colorKey;
    const defaultLocationId = "defaultLocationId" in f ? f.defaultLocationId : before.defaultLocationId;
    if (row) {
      await client.query(
        `update calendar.team_settings set color_key = $2, default_location_id = $3, updated_by_user_id = $4, revision = revision + 1 where team_id = $1`,
        [id, colorKey, defaultLocationId, ctx.userId],
      );
    } else {
      await client.query(
        `insert into calendar.team_settings (team_id, color_key, default_location_id, updated_by_user_id) values ($1, $2, $3, $4)`,
        [id, colorKey, defaultLocationId, ctx.userId],
      );
    }
    const after = (await subjectView(client, clubId, "team", id)).team;
    const details = {};
    if (after.colorKey !== before.colorKey) details.colorKey = pair(before.colorKey, after.colorKey);
    if (after.defaultLocationId !== before.defaultLocationId) details.defaultLocationId = pair(before.defaultLocationId, after.defaultLocationId);
    // A stored default of another club (the team was moved) that the view
    // masked and this write cleared: recorded as a flag, never with that
    // club's place id (code re-review of K2b-1a, LOW).
    if (row?.default_location_id && before.defaultLocationId === null && String(row.default_location_id) !== String(after.defaultLocationId ?? "")) {
      details.staleDefaultCleared = true;
    }
    if (!Object.keys(details).length) details.unchanged = true;
    return { httpStatus: 200, body: { team: after }, subjectKind: "team", subjectId: id, changes: [{ kind: "team", id, details }] };
  });
}

// ---------------------------------------------------------------------------
// The event form's lists (T2: additive to GET /api/calendar/events/types)
// ---------------------------------------------------------------------------
// `club` is the club whose catalog the workspace's events use (a club
// workspace: its club; a team workspace: the team's active club), or null for
// the system set (a private coach, the platform workspace). `teamIds`: the
// workspace's teams, for their default places.
export async function formCatalog(queryable, { club, teamIds = [] }) {
  const ownerSql = club ? "f.owner_scope = 'club' and f.owner_club_id = $1" : "f.owner_scope = 'system'";
  const fields = (await queryable.query(
    `select f.id, f.label, f.description, f.value_kind, f.unit, f.min_value, f.max_value, f.required, f.sort_order,
            (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.sort_order, o.created_at, o.id), '[]'::jsonb)
               from calendar.event_field_options o where o.field_id = f.id and o.archived_at is null) as options
       from calendar.event_fields f
      where ${ownerSql} and f.archived_at is null
      order by f.sort_order, f.label, f.id`,
    club ? [club] : [],
  )).rows.map((r) => ({
    id: r.id, label: r.label, description: r.description, valueKind: r.value_kind, unit: r.unit,
    minValue: num(r.min_value), maxValue: num(r.max_value), required: r.required, options: r.options || [],
  }));
  if (!club) return { fields, locations: [], teamDefaults: {} };
  const locations = (await queryable.query(
    `select l.id, l.name, l.address, l.note from calendar.locations l where l.owner_club_id = $1 and l.archived_at is null order by l.name, l.id`,
    [club],
  )).rows.map((r) => ({ id: r.id, name: r.name, address: r.address, note: r.note }));
  const teamDefaults = {};
  if (teamIds.length) {
    const rows = (await queryable.query(
      `select s.team_id, s.default_location_id
         from calendar.team_settings s
         join calendar.locations l on l.id = s.default_location_id and l.archived_at is null and l.owner_club_id = $1
        where s.team_id = any($2::uuid[])`,
      [club, teamIds],
    )).rows;
    for (const r of rows) teamDefaults[String(r.team_id)] = String(r.default_location_id);
  }
  return { fields, locations, teamDefaults };
}

// GET /api/calendar/events/types (T2): the types as before, and — additively
// — the details, places and team default places the workspace's event form
// offers. The types' own read decides who may ask (403 / the one 404).
export async function eventFormOptions(ctx) {
  // One owner for the whole answer (security review L2): the types and the
  // form's lists always come from the same club.
  const owner = await eventCatalogOwner(ctx);
  const types = await listEventTypes(ctx, owner);
  let club = null;
  let teamIds = [];
  if (owner?.scope === "club") {
    club = owner.clubId;
    teamIds = (await pool.query(`select id from public.teams where club_id = $1 and coalesce(is_active, true)`, [club])).rows.map((r) => String(r.id));
  } else if (owner?.scope === "team") {
    club = owner.teamClubId;
    teamIds = [owner.teamId];
  }
  return { types, ...(await formCatalog(pool, { club, teamIds })) };
}
