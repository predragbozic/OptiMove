// Central calendar (K2a-1a) — the events router: /api/calendar/events
// (docs/ai/central-calendar-k2a-plan.md, section 4). Mounted with requireAuth
// only, before /api/calendar (server.js); the workspace decides inside
// (calendarEventAccess.js): the athlete workspace and the platform workspace
// create nothing, a missing event and a foreign one are the one 404
// (ADR-006), every write takes a requestKey (calendarEventService.js). Stable
// codes only — a database message is logged, never sent.
import { Router } from "express";
import { resolveCalendarContext } from "../calendarAccess.js";
import { EventError } from "../calendarEventAccess.js";
import { cancelEvent, createEvent, getEvent, listEventTypes, updateEvent } from "../calendarEventService.js";
import { isPoolCheckoutTimeout, POOL_CHECKOUT_TIMEOUT } from "../db.js";

const router = Router();

async function contextOf(req) {
  const ctx = await resolveCalendarContext(req);
  ctx.authz = req.authz;
  return ctx;
}

const NOT_FOUND_BODY = Object.freeze({ error: "notFound", message: "Not found." });

function respondError(req, res, error, { read = false } = {}) {
  if (error instanceof EventError) {
    // The one 404, never cached (as the GPEXE administrator routes answer).
    if (error.status === 404) return res.status(404).set("Cache-Control", "no-store").json(NOT_FOUND_BODY);
    if (error.code === "forbidden") return res.status(403).json({ error: "Forbidden" });
    return res.status(error.status).json({ error: error.code, message: error.message, ...(error.details ?? {}) });
  }
  if (isPoolCheckoutTimeout(error)) {
    console.error(`[db] ${POOL_CHECKOUT_TIMEOUT}: ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")}`);
    return res.status(503).json({ error: "try_again", message: "The calendar is busy. Try again in a moment." });
  }
  console.error(`[calendar] ${req.method} ${req.path} failed: ${error?.code ?? ""} ${error?.message}`);
  if (read) return res.status(500).json({ error: "internal_error", message: "The event could not be read." });
  // Everything that reaches here failed before the COMMIT, or the COMMIT was
  // refused by the server: a certain rollback. An unknown COMMIT outcome is
  // the service's own 503 outcome_unknown.
  return res.status(500).json({ error: "internal_error", message: "Nothing was saved. Try again." });
}

router.get("/types", async (req, res) => {
  try {
    const ctx = await contextOf(req);
    res.json({ types: await listEventTypes(ctx) });
  } catch (error) {
    respondError(req, res, error, { read: true });
  }
});

router.get("/:eventId", async (req, res) => {
  try {
    const ctx = await contextOf(req);
    res.json({ event: await getEvent(ctx, req.params.eventId) });
  } catch (error) {
    respondError(req, res, error, { read: true });
  }
});

function command(run) {
  return async (req, res) => {
    try {
      const ctx = await contextOf(req);
      const outcome = await run(ctx, req);
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      respondError(req, res, error);
    }
  };
}

router.post("/", command((ctx, req) => createEvent(ctx, req.body)));
router.patch("/:eventId", command((ctx, req) => updateEvent(ctx, req.params.eventId, req.body)));
router.post("/:eventId/cancel", command((ctx, req) => cancelEvent(ctx, req.params.eventId, req.body)));

export default router;
