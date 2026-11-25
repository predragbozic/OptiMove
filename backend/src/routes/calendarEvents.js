// Central calendar (K2a-1a) — the events router: /api/calendar/events
// (docs/ai/central-calendar-k2a-plan.md, section 4). Mounted with requireAuth
// only, before /api/calendar (server.js); the workspace decides inside
// (calendarEventAccess.js): the athlete workspace and the platform workspace
// create nothing, a missing event and a foreign one are the one 404
// (ADR-006), every write takes a requestKey (calendarEventService.js). Stable
// codes only — a database message is logged, never sent.
import { Router } from "express";
import {
  alignSessions, askQuestion, attachActivity, attachSessions, cancelEvent, createEvent, deleteEvent, detachActivity, detachSessions, getEvent, moveQuestion,
  removeQuestion, setEventFields, updateEvent,
} from "../calendarEventService.js";
import { getEventQuestions } from "../calendarQuestionService.js";
import { eventFormOptions } from "../calendarSettingsService.js";
import { calendarCommand, calendarContextOf, respondCalendarError } from "./calendarRouteErrors.js";
import { CALENDAR_VIEW_READS, calendarViewRefused } from "../calendarModuleContext.js";
import { viewEntryGate } from "../moduleView.js";

const router = Router();

// Roles V-3 (docs/ai/roles-v-steps-plan.md section 2.4): a view workspace reaches GET /types and the reduced GET
// /:eventId with calendar.view; the questions and every write keep the answer they had (calendarModuleContext.js).
router.use(viewEntryGate("calendar", CALENDAR_VIEW_READS.events, { refuse: calendarViewRefused }));

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

// K2b-2a-1: the event's questions for its managers (the identical 404 for
// anyone else and while the club's switch is off).
router.get("/:eventId/questions", async (req, res) => {
  try {
    const ctx = await calendarContextOf(req);
    res.set("Cache-Control", "no-store").json(await getEventQuestions(ctx, req.params.eventId));
  } catch (error) {
    respondCalendarError(req, res, error, { read: true, readMessage: "The questions could not be read." });
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
// v93: delete an event that holds nothing (the cancel right; calendarEventService.js deleteEvent).
router.post("/:eventId/delete", command((ctx, req) => deleteEvent(ctx, req.params.eventId, req.body)));
// K2a-1b: the links of an event (plan sections 2 and 3.2), each a command
// with its requestKey, expectedRevision and audit like the three above.
router.post("/:eventId/sessions", command((ctx, req) => attachSessions(ctx, req.params.eventId, req.body)));
router.post("/:eventId/sessions/detach", command((ctx, req) => detachSessions(ctx, req.params.eventId, req.body)));
router.post("/:eventId/sessions/align", command((ctx, req) => alignSessions(ctx, req.params.eventId, req.body)));
router.post("/:eventId/activities", command((ctx, req) => attachActivity(ctx, req.params.eventId, req.body)));
router.post("/:eventId/activities/detach", command((ctx, req) => detachActivity(ctx, req.params.eventId, req.body)));
// K2b-1b: the values of the event's chosen details (plan section 18.2; D39:
// the event's managers only).
router.post("/:eventId/fields", command((ctx, req) => setEventFields(ctx, req.params.eventId, req.body)));
// K2b-2a-1: Ask athletes (plan 9.1.3).
router.post("/:eventId/questions", command((ctx, req) => askQuestion(ctx, req.params.eventId, req.body)));
router.post("/:eventId/questions/:questionId/remove", command((ctx, req) => removeQuestion(ctx, req.params.eventId, req.params.questionId, req.body)));
router.post("/:eventId/questions/:questionId/move", command((ctx, req) => moveQuestion(ctx, req.params.eventId, req.params.questionId, req.body)));

export default router;
