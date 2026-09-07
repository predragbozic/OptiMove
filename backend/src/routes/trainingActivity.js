// Training Activity — the canonical identity layer connecting planned
// Weekly sessions, external RPE assignments, and Metrics Core events/
// participants/segments to one shared "this actually happened"
// activity/participant identity. Mounted at /api/training-activity (see
// server.js), alongside the existing /api/training-load and
// /api/training-load/metrics routers — a separate module, not folded
// into either.
//
// No frontend and no Metric Library/manual-entry UI, AC/CH computation,
// or Athlete Context are part of this router — those are explicitly out
// of scope for this delivery. Every SECURITY-sensitive DB function in
// migrations_v2's training_activity_v4 migration (reparent, merge, the 2
// group materializers) is called ONLY from trainingActivityMaterialize.js
// — never directly from a route — and every one of those service
// functions resolves and checks workspace authorization before doing
// anything, exactly like the rest of this app's write paths.
import { Router } from "express";
import { resolveActiveWorkspace } from "../workspace.js";
import { resolveActivityWorkspaceScope, activityScopeForWorkspace } from "../trainingActivityAccess.js";
import {
  materializeActivityParticipant, materializeGroupFromExternalOccurrence, materializeGroupFromMetricEvent,
  acceptMatchSuggestion, dismissMatchSuggestion, reparentActivityParticipant, mergeActivityParticipants,
} from "../trainingActivityMaterialize.js";
import { getCanonicalActivityResults, listActivities } from "../trainingActivityResults.js";

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Same shape as trainingLoadMetrics.js's own validTimestamp — pins the
// month/day/hour/minute/second to their real valid numeric ranges AND
// requires an explicit zone (Z or a numeric ±HH:MM offset — never a bare
// local time, which would be ambiguous for a stored instant).
const TIMESTAMP_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-][01]\d:[0-5]\d)$/;
const MAX_NAME_LENGTH = 200;
const MAX_REASON_LENGTH = 2000;

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
function validDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const m = TIMESTAMP_PATTERN.exec(value);
  if (!m) return false;
  const dateOnly = `${m[1]}-${m[2]}-${m[3]}`;
  return validDate(dateOnly);
}
// The standard, reliable way to validate a real IANA timezone string in
// Node without a DB round trip — Intl.DateTimeFormat throws RangeError
// for anything it doesn't recognize, and correctly accepts "UTC".
function validTimezone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function validPositiveFiniteInt(value) {
  if (value === undefined || value === null) return true; // absent is fine
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}
function validMaxLength(value, max) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.length <= max;
}
// The date, in `tz`, that `instantIso` falls on — "en-CA" formats
// year-month-day in exactly YYYY-MM-DD order, which is what this needs.
function localDateInTimezone(instantIso, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instantIso));
}
function validCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return { cursor: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Invalid cursor." };
  }
  if (parsed === null) return { cursor: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Invalid cursor." };
  if (!validDate(parsed.localDate) || !validUuid(parsed.activityId) || !validUuid(parsed.participantId)) {
    return { error: "Invalid cursor." };
  }
  return { cursor: { localDate: parsed.localDate, activityId: parsed.activityId, participantId: parsed.participantId } };
}

// A controlled response for any error carrying httpStatus (thrown by the
// service layer after its own authorization/validation checks), OR a raw
// P0001 (a plpgsql RAISE EXCEPTION — every CHECK/trigger/business-rule
// violation the training.* functions in migrations_v2's training_activity
// migrations raise, e.g. "refusing to reparent into activity X — it is
// already superseded") — the caller gets the DB's own message as a
// controlled 400, never an opaque 500. 23505 (unique_violation) -> 409, a
// genuine double-submit race. Everything else falls through to
// next(error) -> the app's central error handler.
function respondToServiceError(res, next, error) {
  if (error?.httpStatus) return res.status(error.httpStatus).json({ error: error.message });
  if (error?.code === "P0001") return res.status(400).json({ error: error.message });
  if (error?.code === "23505") return res.status(409).json({ error: "This was already submitted." });
  return next(error);
}

// Same isAthleteSelf/scope split as trainingLoadMetrics.js's own
// resolveReadContext — resolves the active workspace ONCE per request and
// reuses it for both read-authorization branches.
async function resolveActivityReadContext(req, res) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (workspace?.type === "athlete") {
    if (!req.authz.athleteId) {
      res.status(403).json({ error: "This account has no athlete profile." });
      return null;
    }
    return { isAthleteSelf: true, athleteId: req.authz.athleteId, scope: { type: null } };
  }
  const scope = activityScopeForWorkspace(workspace, req);
  if (scope.type === null) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { isAthleteSelf: false, athleteId: null, scope };
}

// A coach-capable workspace is required for every write route below —
// resolved once per request and reused for authorization and the write
// itself.
async function requireActivityWorkspace(req, res) {
  const scope = await resolveActivityWorkspaceScope(req);
  if (scope.type === null) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return scope;
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const readContext = await resolveActivityReadContext(req, res);
    if (!readContext) return;
    const { athleteId, dateFrom, dateTo, limit } = req.query;
    if (athleteId !== undefined && !validUuid(athleteId)) return res.status(400).json({ error: "Invalid athleteId." });
    if (!validDate(dateFrom)) return res.status(400).json({ error: "Invalid dateFrom." });
    if (!validDate(dateTo)) return res.status(400).json({ error: "Invalid dateTo." });
    const { cursor, error: cursorError } = validCursor(req.query.cursor);
    if (cursorError) return res.status(400).json({ error: cursorError });
    const result = await listActivities(readContext, { athleteId, dateFrom, dateTo, limit, cursor });
    res.json(result);
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.get("/:activityId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.activityId)) return res.status(400).json({ error: "Invalid activityId." });
    const readContext = await resolveActivityReadContext(req, res);
    if (!readContext) return;
    const result = await getCanonicalActivityResults(readContext, req.params.activityId);
    res.json(result);
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Match suggestions
// ------------------------------------------------------------

router.post("/match-suggestions/:suggestionId/accept", async (req, res, next) => {
  try {
    if (!validUuid(req.params.suggestionId)) return res.status(400).json({ error: "Invalid suggestionId." });
    const scope = await requireActivityWorkspace(req, res);
    if (!scope) return;
    const result = await acceptMatchSuggestion(scope, { suggestionId: req.params.suggestionId, performedBy: req.user.id, reason: req.body?.reason });
    res.json(result);
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/match-suggestions/:suggestionId/dismiss", async (req, res, next) => {
  try {
    if (!validUuid(req.params.suggestionId)) return res.status(400).json({ error: "Invalid suggestionId." });
    const scope = await requireActivityWorkspace(req, res);
    if (!scope) return;
    const result = await dismissMatchSuggestion(scope, { suggestionId: req.params.suggestionId, performedBy: req.user.id });
    res.json(result);
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Reparent / merge
// ------------------------------------------------------------

router.post("/participants/:participantId/reparent", async (req, res, next) => {
  try {
    if (!validUuid(req.params.participantId)) return res.status(400).json({ error: "Invalid participantId." });
    if (!validUuid(req.body?.toActivityId)) return res.status(400).json({ error: "toActivityId is required." });
    const componentStrategy = req.body?.componentStrategy;
    if (componentStrategy !== undefined && !["none", "clone", "map"].includes(componentStrategy)) {
      return res.status(400).json({ error: "componentStrategy must be one of none, clone, map." });
    }
    const scope = await requireActivityWorkspace(req, res);
    if (!scope) return;
    const result = await reparentActivityParticipant(scope, {
      participantId: req.params.participantId, toActivityId: req.body.toActivityId, performedBy: req.user.id,
      reason: req.body?.reason, componentStrategy: componentStrategy || "none", componentMapping: req.body?.componentMapping,
    });
    res.json(result);
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/participants/:participantId/merge", async (req, res, next) => {
  try {
    if (!validUuid(req.params.participantId)) return res.status(400).json({ error: "Invalid participantId." });
    if (!validUuid(req.body?.targetParticipantId)) return res.status(400).json({ error: "targetParticipantId is required." });
    const scope = await requireActivityWorkspace(req, res);
    if (!scope) return;
    const result = await mergeActivityParticipants(scope, {
      sourceParticipantId: req.params.participantId, targetParticipantId: req.body.targetParticipantId,
      performedBy: req.user.id, reason: req.body?.reason,
    });
    res.json(result);
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Materialization — internal wiring for a future planned-session/
// external-assignment/metric-event integration to call; not driven by any
// frontend in this delivery.
// ------------------------------------------------------------

router.post("/materialize", async (req, res, next) => {
  try {
    const b = req.body || {};
    if (typeof b.requestKey !== "string" || !b.requestKey) return res.status(400).json({ error: "requestKey is required." });
    if (b.planLogicalSessionId !== undefined && b.planLogicalSessionId !== null && !validUuid(b.planLogicalSessionId)) return res.status(400).json({ error: "Invalid planLogicalSessionId." });
    if (b.externalAssignmentId !== undefined && b.externalAssignmentId !== null && !validUuid(b.externalAssignmentId)) return res.status(400).json({ error: "Invalid externalAssignmentId." });
    // Returned BEFORE any authorization/DB work — the service itself
    // re-checks this too, but a malformed request should never even reach
    // a transaction.
    if (b.planLogicalSessionId && b.externalAssignmentId) {
      return res.status(400).json({ error: "planLogicalSessionId and externalAssignmentId cannot both be provided." });
    }
    const naturalKey = b.planLogicalSessionId || b.externalAssignmentId;
    if (!validMaxLength(b.name, MAX_NAME_LENGTH)) return res.status(400).json({ error: `name must be at most ${MAX_NAME_LENGTH} characters.` });
    if (!validMaxLength(b.reason, MAX_REASON_LENGTH)) return res.status(400).json({ error: `reason must be at most ${MAX_REASON_LENGTH} characters.` });

    if (naturalKey) {
      // Identity (athleteId/localDate/timezone/startInstant/endInstant/
      // durationMinutes) is derived AUTHORITATIVELY by the service from
      // the real plan session / external assignment — never trusted from
      // the client. These fields are optional here; if present, only
      // their FORMAT is checked now (the service itself rejects a value
      // that doesn't match the authoritative source). name/activityTypeKey
      // remain pure presentation.
      if (b.athleteId !== undefined && b.athleteId !== null && !validUuid(b.athleteId)) return res.status(400).json({ error: "Invalid athleteId." });
      if (b.localDate !== undefined && b.localDate !== null && !validDate(b.localDate)) return res.status(400).json({ error: "Invalid localDate." });
      if (b.timezone !== undefined && b.timezone !== null && !validTimezone(b.timezone)) return res.status(400).json({ error: "Invalid timezone." });
    } else {
      // Pure manual materialization — every identity/time field is
      // client-supplied and must be fully validated here (Node-side); the
      // DB additionally guards timezone validity and a reversed interval
      // on training.activities itself.
      if (!validUuid(b.athleteId)) return res.status(400).json({ error: "athleteId is required." });
      if (!validDate(b.localDate)) return res.status(400).json({ error: "localDate is required (YYYY-MM-DD)." });
      if (!validTimezone(b.timezone)) return res.status(400).json({ error: "timezone is required and must be a real IANA zone (e.g. UTC, Europe/Belgrade)." });
      if (b.startInstant !== undefined && b.startInstant !== null && !validTimestamp(b.startInstant)) return res.status(400).json({ error: "Invalid startInstant — must be an explicitly-zoned timestamp." });
      if (b.endInstant !== undefined && b.endInstant !== null && !validTimestamp(b.endInstant)) return res.status(400).json({ error: "Invalid endInstant — must be an explicitly-zoned timestamp." });
      if (b.startInstant && b.endInstant && new Date(b.endInstant) < new Date(b.startInstant)) return res.status(400).json({ error: "endInstant cannot be before startInstant." });
      if (!validPositiveFiniteInt(b.durationMinutes)) return res.status(400).json({ error: "durationMinutes must be a positive whole number." });
      if (b.startInstant && localDateInTimezone(b.startInstant, b.timezone) !== b.localDate) {
        return res.status(400).json({ error: "localDate does not match startInstant converted into timezone." });
      }
    }

    const operationKind = b.planLogicalSessionId ? "materialize_from_rpe" : b.externalAssignmentId ? "materialize_from_external" : "materialize_manual";
    const scope = await requireActivityWorkspace(req, res);
    if (!scope) return;
    const result = await materializeActivityParticipant(scope, {
      requestKey: b.requestKey, requestedBy: req.user.id, operationKind,
      athleteId: b.athleteId, localDate: b.localDate, timezone: b.timezone,
      startInstant: b.startInstant, endInstant: b.endInstant, durationMinutes: b.durationMinutes,
      name: b.name, activityTypeKey: b.activityTypeKey, origin: b.planLogicalSessionId ? "planned_session" : b.externalAssignmentId ? "external_assignment" : "manual",
      planLogicalSessionId: b.planLogicalSessionId, externalAssignmentId: b.externalAssignmentId,
    });
    res.status(201).json(result);
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/materialize/external-occurrence/:occurrenceId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.occurrenceId)) return res.status(400).json({ error: "Invalid occurrenceId." });
    const scope = await requireActivityWorkspace(req, res);
    if (!scope) return;
    const activityId = await materializeGroupFromExternalOccurrence(scope, {
      occurrenceId: req.params.occurrenceId, activityTypeKey: req.body?.activityTypeKey, name: req.body?.name, performedBy: req.user.id,
    });
    res.status(201).json({ activityId });
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/materialize/metric-event/:eventId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.eventId)) return res.status(400).json({ error: "Invalid eventId." });
    const scope = await requireActivityWorkspace(req, res);
    if (!scope) return;
    const activityId = await materializeGroupFromMetricEvent(scope, {
      eventId: req.params.eventId, activityTypeKey: req.body?.activityTypeKey, name: req.body?.name, performedBy: req.user.id,
    });
    res.status(201).json({ activityId });
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

export default router;
