// Session types (ST-1, migration v85): the list of training.activity_types for Settings -> Tags & Presets.
// Mounted at /api/training-activity/session-types, before the training-activity router (whose /:activityId would
// otherwise take the path). See backend/src/sessionTypeService.js for who reads and writes.
import { Router } from "express";
import { isPoolCheckoutTimeout } from "../db.js";
import { resolveCalendarContext } from "../calendarAccess.js";
import {
  archiveSessionType, createSessionType, listSessionTypes, renameSessionType, restoreSessionType, SessionTypeError,
} from "../sessionTypeService.js";

const router = Router();
const NOT_FOUND_BODY = Object.freeze({ error: "notFound", message: "Not found." });

async function contextOf(req) {
  const c = await resolveCalendarContext(req);
  return { accountType: c.type, workspace: c.workspace ?? null, userId: req.user.id, authz: req.authz };
}

function respond(res, next, error) {
  res.set("Cache-Control", "no-store");
  if (error instanceof SessionTypeError) {
    if (error.status === 404) return res.status(404).set("Cache-Control", "no-store").json(NOT_FOUND_BODY);
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

router.get("/", handle((ctx) => listSessionTypes(ctx)));
router.post("/", handle((ctx, req) => createSessionType(ctx, req.body)));
router.post("/:key/rename", handle((ctx, req) => renameSessionType(ctx, req.params.key, req.body)));
router.post("/:key/archive", handle((ctx, req) => archiveSessionType(ctx, req.params.key, req.body)));
router.post("/:key/restore", handle((ctx, req) => restoreSessionType(ctx, req.params.key, req.body)));

export default router;
