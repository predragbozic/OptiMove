// Central calendar K2b-2a-1 — the athlete's side of Ask athletes:
// /api/calendar/questions (plan docs/ai/central-calendar-k2b2-plan.md, 3.4 and
// 9.1.3). Mounted with requireAuth only, before /api/calendar (server.js).
//   GET  /mine                 her own open questions ([] for anyone else)
//   POST /:questionId/later    her *Later* (requestKey); the 404 when the
//                              question is not hers or the switch is off
import { Router } from "express";
import { myOpenQuestions, postponeQuestion } from "../calendarQuestionService.js";
import { calendarCommand, calendarContextOf, respondCalendarError } from "./calendarRouteErrors.js";

const router = Router();

router.get("/mine", async (req, res) => {
  try {
    const ctx = await calendarContextOf(req);
    res.set("Cache-Control", "no-store").json(await myOpenQuestions(ctx));
  } catch (error) {
    respondCalendarError(req, res, error, { read: true, readMessage: "The questions could not be read." });
  }
});

router.post("/:questionId/later", calendarCommand((ctx, req) => postponeQuestion(ctx, req.params.questionId, req.body)));

export default router;
