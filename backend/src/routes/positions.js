// Athlete positions (migration v87): the list for Settings -> Tags & Presets and an athlete's position for Settings ->
// Athletes. Mounted at /api/positions. See backend/src/positionService.js for who reads and writes.
import { Router } from "express";
import { isPoolCheckoutTimeout } from "../db.js";
import { resolveCalendarContext } from "../calendarAccess.js";
import { viewEntryGate } from "../moduleView.js";
import {
  archivePosition, createPosition, hidePosition, listAthletePositions, listPositions, PositionError, renamePosition, restorePosition,
  setAthletePosition, showPosition,
} from "../positionService.js";

const router = Router();
const NOT_FOUND_BODY = Object.freeze({ error: "notFound", message: "Not found." });

// Roles V-2: a view workspace reaches only the two reads, with athletes.view at its club or team (moduleView.js); every
// other request of a view workspace gets the identical 404 this router answers it today. Read-only: the gate's workspace
// is used as it is, never resolved again.
router.use(viewEntryGate("athletes", [{ method: "GET", path: "/" }, { method: "GET", path: "/athletes" }], {
  refuse: (_req, res) => res.status(404).set("Cache-Control", "no-store").json(NOT_FOUND_BODY),
}));

async function contextOf(req) {
  if (req.moduleView?.module === "athletes") {
    return { accountType: "view", workspace: req.moduleView.workspace, viewScope: req.moduleView.scope, userId: req.user.id, authz: req.authz };
  }
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
// A club's own view of a default position (the system list and other clubs unchanged).
router.post("/:id/hide", handle((ctx, req) => hidePosition(ctx, req.params.id, req.body)));
router.post("/:id/show", handle((ctx, req) => showPosition(ctx, req.params.id, req.body)));

export default router;
