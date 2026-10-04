// Source credential connections (F3c2d): create, connect, reconnect, test
// and read; (F3c2e) bind a team; (F3c2f) unbind. Mounted at /api/training-load/sources behind
// requireAuth. A platform admin, or the owning club's admin in that club's
// workspace; anything else — and any connection, club, team or id the caller
// may not see — answers the same 404 as a missing one (ADR-006).
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
        const { expected, connectionId, teamId, retryAfterMinutes, auditId, current } = error.details || {};
        if (error.status === 429 && retryAfterMinutes) res.setHeader("Retry-After", String(retryAfterMinutes * 60));
        return res.status(error.status).json({
          error: error.code, message: error.message,
          ...(expected ? { expected } : {}), ...(connectionId ? { connectionId } : {}), ...(teamId ? { teamId } : {}), ...(auditId ? { auditId } : {}), ...(current ? { current } : {}),
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
        await service.recordUnknownOutcome({ connectionId: error.details.connectionId, action: ACTION_NAME[action], ctx, attemptId: error.details.attemptId ?? null, teamId: error.details.teamId ?? null });
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
    // A binding that was created now is 201; everything else (a Connect, a
    // Test, the same binding again) is 200.
    res.status(action === "bindTeam" && result.idempotent === false ? 201 : 200).json({ result, connection, ...(connectionReadError ? { connectionReadError: true } : {}) });
  });
}
const ACTION_NAME = { connect: "connect", reconnect: "reconnect", testConnection: "test", bindTeam: "bind" };

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
// F3c2e: bind one OptiMove team of the owning club to one chosen source team
// ({ teamId, sourceTeamId }); the chosen team is read again, alone, before
// the row is written.
router.post("/:source/connections/:id/bindings", attemptRoute("bindTeam"));

// F3c2f: end an active binding ({ requestKey, reason, expected: { teamId,
// sourceTeamId } }). Local only: nothing is sent to the source. The same
// requestKey answers the same saved result.
router.post("/:source/connections/:id/bindings/:bindingId/unbind", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  const body = req.body;
  req.body = undefined;
  let result;
  try {
    result = await service.unbindTeam({ ctx, sourceSystem: req.params.source, id: req.params.id, bindingId: req.params.bindingId, body });
  } catch (error) {
    if (error instanceof service.SourceConnectionError && error.code === "outcome_unknown" && error.details?.connectionId) {
      await service.recordUnknownOutcome({ connectionId: error.details.connectionId, action: "unbind", ctx, attemptId: error.details.attemptId ?? null, teamId: error.details.teamId ?? null });
    }
    throw error;
  } finally {
    scrub(body);
  }
  if (!result) return notFound(res);
  let connection = null;
  let connectionReadError = false;
  try {
    connection = await service.getConnection({ ctx, sourceSystem: req.params.source, id: req.params.id });
  } catch {
    connectionReadError = true;
  }
  res.json({ result, connection, ...(connectionReadError ? { connectionReadError: true } : {}) });
}));

export default router;
