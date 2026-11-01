// Central calendar (K2a-1a) — the events router: /api/calendar/events
// (docs/ai/central-calendar-k2a-plan.md, section 4). Mounted with requireAuth
// only, before /api/calendar (server.js); the workspace decides inside
// (calendarEventAccess.js): the athlete workspace and the platform workspace
// create nothing, a missing event and a foreign one are the one 404
// (ADR-006), every write takes a requestKey (calendarEventService.js). Stable
// codes only — a database message is logged, never sent.
import { Router } from "express";
import {
  alignSessions, attachActivity, attachSessions, cancelEvent, createEvent, detachActivity, detachSessions, getEvent, updateEvent,
} from "../calendarEventService.js";
import { eventFormOptions } from "../calendarSettingsService.js";
import { calendarCommand, calendarContextOf, respondCalendarError } from "./calendarRouteErrors.js";

const router = Router();

router.get("/types", async (req, res) => {
  try {
    const ctx = await calendarContextOf(req);
    // K2b-1a (T2): the types as before, plus the form's details, places and
    // the teams' default places.
    res.json(await eventFormOptions(ctx));
  } catch (error) {
    respondCalendarError(req, res, error, { read: true });
  }
});

router.get("/:eventId", async (req, res) => {
  try {
    const ctx = await calendarContextOf(req);
    res.json({ event: await getEvent(ctx, req.params.eventId) });
  } catch (error) {
    respondCalendarError(req, res, error, { read: true });
  }
});

const command = (run) => calendarCommand(run);

router.post("/", command((ctx, req) => createEvent(ctx, req.body)));
router.patch("/:eventId", command((ctx, req) => updateEvent(ctx, req.params.eventId, req.body)));
router.post("/:eventId/cancel", command((ctx, req) => cancelEvent(ctx, req.params.eventId, req.body)));
// K2a-1b: the links of an event (plan sections 2 and 3.2), each a command
// with its requestKey, expectedRevision and audit like the three above.
router.post("/:eventId/sessions", command((ctx, req) => attachSessions(ctx, req.params.eventId, req.body)));
router.post("/:eventId/sessions/detach", command((ctx, req) => detachSessions(ctx, req.params.eventId, req.body)));
router.post("/:eventId/sessions/align", command((ctx, req) => alignSessions(ctx, req.params.eventId, req.body)));
router.post("/:eventId/activities", command((ctx, req) => attachActivity(ctx, req.params.eventId, req.body)));
router.post("/:eventId/activities/detach", command((ctx, req) => detachActivity(ctx, req.params.eventId, req.body)));

export default router;
