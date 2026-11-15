// Option A, A1: the error-tracking routes (/api/app-errors; requireAuth is applied where the router is mounted).
//   POST /          a signed-in browser reports one error. Closed shape only (appErrorTracking.sanitizeClientReport);
//                   anything else is 400 invalid_error_report. The answer never repeats the report.
//   GET  /groups    the platform admin's view: errors grouped by fingerprint (last 1-30 days). Anyone else gets the
//                   same 404 as an unknown route (info-hiding).
import express from "express";
import { isPlatformAdministrator } from "../authz.js";
import { MAX_REPORT_BYTES, allowReport, listErrorGroups, recordClientError, sanitizeClientReport, userHashKeyState } from "../appErrorTracking.js";

export const appErrorsRouter = express.Router();

const notFound = (req, res) => res.status(404).json({ error: "Not found", path: `${req.baseUrl}${req.path}` });

appErrorsRouter.post("/", async (req, res, next) => {
  try {
    if (JSON.stringify(req.body ?? null).length > MAX_REPORT_BYTES) return res.status(413).json({ error: "body_too_large" });
    const report = sanitizeClientReport(req.body);
    if (!report) return res.status(400).json({ error: "invalid_error_report" });
    if (!allowReport(req.user.id)) return res.status(429).json({ error: "too_many_reports" });
    await recordClientError(req, report);
    return res.status(204).end();
  } catch (error) {
    // A failed record must never become a second error report; the generic handler answers 5xx without a message.
    if (error && typeof error === "object") { try { error.skipAppErrorRecord = true; } catch { /* a frozen error is passed on as it is */ } }
    return next(error);
  }
});

appErrorsRouter.get("/groups", async (req, res, next) => {
  try {
    if (!isPlatformAdministrator(req.authz)) return notFound(req, res);
    const days = req.query.days === undefined ? 7 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 30) return res.status(400).json({ error: "invalid_days" });
    res.setHeader("Cache-Control", "no-store");
    // people: whether distinct people can be counted for new rows (the hashing key is set) - never the key or its name.
    return res.json({ days, people: userHashKeyState(), groups: await listErrorGroups({ days }) });
  } catch (error) {
    return next(error);
  }
});
