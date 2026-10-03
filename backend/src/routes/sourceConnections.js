// Source credential connections (F3c2d): create, connect, reconnect, test
// and read. Mounted at /api/training-load/sources behind requireAuth. A
// platform admin only; anything else — and any connection, club or id the
// caller may not see — answers the same 404 as a missing one (ADR-006).
// Same-origin JSON only: the session cookie is SameSite=Lax and every write
// here requires a JSON object body, so a cross-site form post never reaches
// the service. No body is logged anywhere in this router.
import { Router } from "express";
import * as service from "../sourceConnectionService.js";

const router = Router();

function notFound(res) {
  return res.status(404).json({ error: "notFound" });
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof service.SourceConnectionError) {
        // Only known detail fields: a detail can never replace error/message
        // and never carries a body field back.
        const { expected, connectionId, teamId, retryAfterMinutes, auditId } = error.details || {};
        if (error.status === 429 && retryAfterMinutes) res.setHeader("Retry-After", String(retryAfterMinutes * 60));
        return res.status(error.status).json({
          error: error.code, message: error.message,
          ...(expected ? { expected } : {}), ...(connectionId ? { connectionId } : {}), ...(teamId ? { teamId } : {}), ...(auditId ? { auditId } : {}),
          ...(error.details?.commitConfirmation ? { commitConfirmation: error.details.commitConfirmation } : {}),
        });
      }
      next(error);
    }
  };
}

// A write takes a JSON object body and nothing else (form bodies, arrays,
// text are refused before the service sees them).
function jsonObjectBody(req, res) {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "jsonRequired", message: "This request takes a JSON body." });
    return false;
  }
  if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "invalid_body", message: "A JSON object body is required." });
    return false;
  }
  return true;
}

async function adminContext(req, res) {
  const ctx = await service.resolveConnectionAdmin(req);
  if (!ctx) notFound(res);
  return ctx;
}

router.get("/:source/connections", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  const list = await service.listConnections({ ctx, sourceSystem: req.params.source, clubId: typeof req.query.clubId === "string" ? req.query.clubId : null });
  if (!list) return notFound(res);
  res.json({ connections: list });
}));

router.get("/:source/connections/:id", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  const connection = await service.getConnection({ ctx, sourceSystem: req.params.source, id: req.params.id });
  if (!connection) return notFound(res);
  res.json({ connection });
}));

router.post("/:source/connections", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  let connection;
  try {
    connection = await service.createConnection({ ctx, sourceSystem: req.params.source, body: req.body });
  } catch (error) {
    if (error instanceof service.SourceConnectionError && error.code === "outcome_unknown" && error.details?.connectionId) {
      await service.recordUnknownOutcome({ connectionId: error.details.connectionId, action: "create", ctx });
    }
    throw error;
  }
  if (!connection) return notFound(res);
  res.status(201).json({ connection });
}));

// Connect, reconnect and test share one shape. The username and password
// are handed to the service and every reference this router holds is
// dropped as soon as the service has read them (JavaScript strings cannot
// be overwritten in place; what is guaranteed is that nothing here keeps or
// logs them).
function attemptRoute(action) {
  return handle(async (req, res) => {
    const ctx = await adminContext(req, res);
    if (!ctx) return;
    if (!jsonObjectBody(req, res)) return;
    const body = req.body;
    req.body = undefined;
    let result;
    try {
      result = await service[action]({ ctx, sourceSystem: req.params.source, id: req.params.id, body });
    } catch (error) {
      if (error instanceof service.SourceConnectionError && error.code === "outcome_unknown" && error.details?.connectionId) {
        await service.recordUnknownOutcome({ connectionId: error.details.connectionId, action: action === "testConnection" ? "test" : action, ctx, attemptId: error.details.attemptId ?? null });
      }
      throw error;
    } finally {
      scrub(body);
    }
    if (!result) return notFound(res);
    // The read after a confirmed COMMIT never changes the answer's status:
    // the result already carries the state; a failed re-read is a flag.
    let connection = null;
    let connectionReadError = false;
    try {
      connection = await service.getConnection({ ctx, sourceSystem: req.params.source, id: req.params.id });
    } catch {
      connectionReadError = true;
    }
    res.json({ result, connection, ...(connectionReadError ? { connectionReadError: true } : {}) });
  });
}

function scrub(body) {
  if (body && typeof body === "object") {
    for (const key of Object.keys(body)) {
      try { body[key] = undefined; delete body[key]; } catch { /* nothing kept */ }
    }
  }
}

router.post("/:source/connections/:id/connect", attemptRoute("connect"));
router.post("/:source/connections/:id/reconnect", attemptRoute("reconnect"));
router.post("/:source/connections/:id/test", attemptRoute("testConnection"));

export default router;
