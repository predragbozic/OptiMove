// Central calendar K2b-1a — Settings -> Calendar: /api/calendar/settings
// (docs/ai/central-calendar-k2b-plan.md, section 5.1). Mounted with
// requireAuth only, before /api/calendar (server.js); the active CLUB
// workspace and its admin decide inside (calendarSettingsService.js): 403 on
// a collection route for everyone else (workspace_required from the platform
// workspace), the one 404 on a route that names an id (ADR-006). Every write
// takes a requestKey. Stable codes only — a database message is logged,
// never sent.
import { Router } from "express";
import {
  archiveField, archiveLocation, archiveType, createField, createLocation, createType, getSettings, orderTypes, restoreField,
  restoreLocation, restoreType, updateField, updateLocation, updateTeam, updateType,
} from "../calendarSettingsService.js";
import { calendarCommand, calendarContextOf, respondCalendarError } from "./calendarRouteErrors.js";

const router = Router();
const ERRORS = { log: "calendar-settings" };

router.get("/", async (req, res) => {
  try {
    const ctx = await calendarContextOf(req);
    res.json(await getSettings(ctx));
  } catch (error) {
    respondCalendarError(req, res, error, { ...ERRORS, read: true, readMessage: "The calendar settings could not be read." });
  }
});

const command = (run) => calendarCommand(run, ERRORS);

router.post("/types", command((ctx, req) => createType(ctx, req.body)));
router.post("/types/order", command((ctx, req) => orderTypes(ctx, req.body)));
router.patch("/types/:typeId", command((ctx, req) => updateType(ctx, req.params.typeId, req.body)));
router.post("/types/:typeId/archive", command((ctx, req) => archiveType(ctx, req.params.typeId, req.body)));
router.post("/types/:typeId/restore", command((ctx, req) => restoreType(ctx, req.params.typeId, req.body)));

router.post("/fields", command((ctx, req) => createField(ctx, req.body)));
router.patch("/fields/:fieldId", command((ctx, req) => updateField(ctx, req.params.fieldId, req.body)));
router.post("/fields/:fieldId/archive", command((ctx, req) => archiveField(ctx, req.params.fieldId, req.body)));
router.post("/fields/:fieldId/restore", command((ctx, req) => restoreField(ctx, req.params.fieldId, req.body)));

router.post("/locations", command((ctx, req) => createLocation(ctx, req.body)));
router.patch("/locations/:locationId", command((ctx, req) => updateLocation(ctx, req.params.locationId, req.body)));
router.post("/locations/:locationId/archive", command((ctx, req) => archiveLocation(ctx, req.params.locationId, req.body)));
router.post("/locations/:locationId/restore", command((ctx, req) => restoreLocation(ctx, req.params.locationId, req.body)));

router.put("/teams/:teamId", command((ctx, req) => updateTeam(ctx, req.params.teamId, req.body)));

export default router;
