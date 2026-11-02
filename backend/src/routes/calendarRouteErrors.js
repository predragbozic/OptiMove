// The calendar routers' one error answer (the events router of K2a and the
// Settings -> Calendar router of K2b-1a): stable codes only — a database
// message is logged, never sent. A missing resource and a foreign one are
// the same fixed 404 body (ADR-006), never cached.
import { resolveCalendarContext } from "../calendarAccess.js";
import { EventError } from "../calendarEventAccess.js";
import { isPoolCheckoutTimeout, POOL_CHECKOUT_TIMEOUT } from "../db.js";

export const NOT_FOUND_BODY = Object.freeze({ error: "notFound", message: "Not found." });

export async function calendarContextOf(req) {
  const ctx = await resolveCalendarContext(req);
  ctx.authz = req.authz;
  return ctx;
}

export function respondCalendarError(req, res, error, { read = false, readMessage = "The event could not be read.", log = "calendar" } = {}) {
  if (error instanceof EventError) {
    if (error.status === 404) return res.status(404).set("Cache-Control", "no-store").json(NOT_FOUND_BODY);
    if (error.code === "forbidden") return res.status(403).json({ error: "Forbidden" });
    return res.status(error.status).json({ error: error.code, message: error.message, ...(error.details ?? {}) });
  }
  if (isPoolCheckoutTimeout(error)) {
    console.error(`[db] ${POOL_CHECKOUT_TIMEOUT}: ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")}`);
    return res.status(503).json({ error: "try_again", message: "The calendar is busy. Try again in a moment." });
  }
  console.error(`[${log}] ${req.method} ${req.path} failed: ${error?.code ?? ""} ${error?.message}`);
  if (read) return res.status(500).json({ error: "internal_error", message: readMessage });
  // Everything that reaches here failed before the COMMIT, or the COMMIT was
  // refused by the server: a certain rollback. An unknown COMMIT outcome is
  // the service's own 503 outcome_unknown.
  return res.status(500).json({ error: "internal_error", message: "Nothing was saved. Try again." });
}

// A write route: run the command, answer its status and body.
export function calendarCommand(run, options = {}) {
  return async (req, res) => {
    try {
      const ctx = await calendarContextOf(req);
      const outcome = await run(ctx, req);
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      respondCalendarError(req, res, error, options);
    }
  };
}
