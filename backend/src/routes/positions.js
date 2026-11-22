// Athlete positions (migration v87): the list for Settings -> Tags & Presets and an athlete's position for Settings ->
// Athletes. Mounted at /api/positions. See backend/src/positionService.js for who reads and writes.
import { Router } from "express";
import { isPoolCheckoutTimeout } from "../db.js";
import { resolveCalendarContext } from "../calendarAccess.js";
import {
  archivePosition, createPosition, listAthletePositions, listPositions, PositionError, renamePosition, restorePosition,
  setAthletePosition,
} from "../positionService.js";

const router = Router();
const NOT_FOUND_BODY = Object.freeze({ error: "notFound", message: "Not found." });

async function contextOf(req) {
  const c = await resolveCalendarContext(req);
  return { accountType: c.type, workspace: c.workspace ?? null, userId: req.user.id, authz: req.authz };
}

function respond(res, next, error) {
  res.set("Cache-Control", "no-store");
  if (error instanceof PositionError) {
    if (error.status === 404) return res.status(404).json(NOT_FOUND_BODY);
    return res.status(error.status).json({ error: error.code, message: error.message, ...error.extra });
  }
  if (isPoolCheckoutTimeout(error)) return res.status(503).json({ error: "try_again", message: "The list is busy. Try again in a moment." });
  return next(error);
}

const handle = (fn) => async (req, res, next) => {
  try {
    const ctx = await contextOf(req);
    res.set("Cache-Control", "no-store").json(await fn(ctx, req));
  } catch (error) {
    respond(res, next, error);
  }
};

router.get("/", handle((ctx) => listPositions(ctx)));
router.post("/", handle((ctx, req) => createPosition(ctx, req.body)));
router.get("/athletes", handle((ctx) => listAthletePositions(ctx)));
router.put("/athletes/:athleteId", handle((ctx, req) => setAthletePosition(ctx, req.params.athleteId, req.body)));
router.post("/:id/rename", handle((ctx, req) => renamePosition(ctx, req.params.id, req.body)));
router.post("/:id/archive", handle((ctx, req) => archivePosition(ctx, req.params.id, req.body)));
router.post("/:id/restore", handle((ctx, req) => restorePosition(ctx, req.params.id, req.body)));

export default router;
