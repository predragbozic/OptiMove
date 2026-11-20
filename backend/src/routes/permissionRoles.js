// The Roles API (roles R2 contract, section 5), mounted at
// /api/organization/roles behind requireAuth only - not requireCoach: the
// service does the 404 gate for every caller, an athlete and an account
// without any role included, and this API has no 403. Every answer is not
// cached; an unknown path or method under the mount answers the same
// 404 {"error":"notFound"} (the catch-all at the end), so it never falls
// through to the organization router behind requireCoach.
import { Router } from "express";
import { isPoolCheckoutTimeout, POOL_CHECKOUT_TIMEOUT } from "../db.js";
import * as roles from "../permissionRolesService.js";

const router = Router();

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const ctxOf = (req) => ({ userId: req.user.id, authz: req.authz });

// A stable refusal answers its code and fixed sentence; a lost database
// checkout is try_again; anything else is a sanitized 500 internal_error that
// carries no database text.
function answer(handler, successStatus = 200) {
  return async (req, res) => {
    try {
      const body = await handler(req);
      res.status(successStatus).json(body);
    } catch (error) {
      if (error instanceof roles.RolesRefusal) {
        if (error.status === 404) return res.status(404).json({ error: "notFound" });
        return res.status(error.status).json({ error: error.code, message: error.message, ...error.extra });
      }
      if (error?.code === "permissions_unavailable" && error.status === 503) {
        return res.status(503).json({ error: "permissions_unavailable", message: "Permissions could not be checked right now. Try again in a moment." });
      }
      if (isPoolCheckoutTimeout(error)) {
        console.error(`[db] ${POOL_CHECKOUT_TIMEOUT}: ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")}`);
        res.setHeader("Retry-After", "5");
        return res.status(409).json({ error: "try_again", message: "The server is busy right now. Nothing was written; try again in a moment." });
      }
      console.error(`[roles] ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")} failed: ${String(error?.code || error?.name || "error")}`);
      return res.status(500).json({ error: "internal_error", message: "Something went wrong. Nothing was confirmed." });
    }
  };
}

router.get("/catalog", answer((req) => roles.getCatalog(ctxOf(req), req.query)));
router.get("/assignments", answer((req) => roles.listAssignments(ctxOf(req), req.query)));
router.post("/assignments", answer((req) => roles.assignRole(ctxOf(req), req.body)));
router.post("/assignments/:assignmentId/revoke", answer((req) => roles.revokeAssignment(ctxOf(req), req.params.assignmentId, req.body)));
router.get("/", answer((req) => roles.listRoles(ctxOf(req), req.query)));
router.post("/", answer((req) => roles.createRole(ctxOf(req), req.body)));
router.get("/:roleId", answer((req) => roles.getRole(ctxOf(req), req.params.roleId, req.query)));
router.post("/:roleId/change", answer((req) => roles.changeRole(ctxOf(req), req.params.roleId, req.body)));
router.post("/:roleId/archive", answer((req) => roles.archiveRole(ctxOf(req), req.params.roleId, req.body)));
router.post("/:roleId/copy", answer((req) => roles.copyRole(ctxOf(req), req.params.roleId, req.body)));

// Every other path and method under the mount.
router.use((req, res) => res.status(404).json({ error: "notFound" }));

export default router;
