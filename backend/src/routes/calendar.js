// Central calendar (K1a) — GET /api/calendar, the one source-neutral read of
// everything planned, recorded or scheduled in the active workspace's
// window (docs/ai/central-calendar-k1-plan.md). Mounted with requireAuth
// only (server.js): the athlete workspace reads its own rows, as GET
// /api/training-load/calendar does. Validation and the one workspace read
// live here; the scopes in calendarAccess.js, the reads and the item model
// in calendarQuery.js. No route here writes.
import { Router } from "express";
import { resolveCalendarContext } from "../calendarAccess.js";
import { CALENDAR_KINDS, CALENDAR_MAX_RANGE_DAYS, readCalendar } from "../calendarQuery.js";

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// How far the caller's `today` may lie from the server's UTC date (manager
// decision 3): a browser's local date is at most one day away; two keeps a
// clock a little off from being refused.
const TODAY_MAX_DRIFT_DAYS = 2;

// A real Gregorian date (the rule of routes/trainingLoad.js's
// isValidGregorianDateString): "2026-02-30" is refused, and so is a year
// outside 2000-2100 — a day walk towards "9999-12-31" would otherwise leave
// the four-digit form and fail inside the read instead of here.
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
function validDate(value) {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}
function serverTodayUtc() {
  return new Date().toISOString().slice(0, 10);
}
// Returns { ids, invalid }: ids null when absent (no filter), invalid true
// when any entry is not a UUID (the caller answers 400 before any read).
function parseUuidList(raw) {
  if (raw === undefined || raw === null || raw === "") return { ids: null, invalid: false };
  const ids = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { ids: null, invalid: false };
  if (ids.some((id) => !UUID_PATTERN.test(id))) return { ids: null, invalid: true };
  return { ids: [...new Set(ids.map((id) => id.toLowerCase()))], invalid: false };
}
function parseKinds(raw) {
  if (raw === undefined || raw === null || raw === "") return { kinds: new Set(CALENDAR_KINDS), invalid: false };
  const kinds = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!kinds.length || kinds.some((k) => !CALENDAR_KINDS.includes(k))) return { kinds: null, invalid: true };
  return { kinds: new Set(kinds), invalid: false };
}

// A 400 carries a stable code in `error` (for the client's branching) and
// the sentence in `message`.
function badRequest(res, code, message) {
  return res.status(400).json({ error: code, message });
}

router.get("/", async (req, res, next) => {
  try {
    const from = String(req.query?.from ?? "");
    const to = String(req.query?.to ?? "");
    if (!validDate(from) || !validDate(to)) return badRequest(res, "invalid_range", "from and to must be valid YYYY-MM-DD dates (years 2000-2100).");
    if (to < from) return badRequest(res, "invalid_range", "to must not be before from.");
    if (daysBetween(from, to) > CALENDAR_MAX_RANGE_DAYS) return badRequest(res, "range_too_long", `Date range must not exceed ${CALENDAR_MAX_RANGE_DAYS} days.`);

    let today = serverTodayUtc();
    if (req.query?.today !== undefined && req.query.today !== "") {
      const requested = String(req.query.today);
      if (!validDate(requested)) return badRequest(res, "invalid_today", "today must be a valid YYYY-MM-DD date.");
      if (Math.abs(daysBetween(today, requested)) > TODAY_MAX_DRIFT_DAYS) {
        return badRequest(res, "invalid_today", `today must be within ${TODAY_MAX_DRIFT_DAYS} days of the server's date.`);
      }
      today = requested;
    }

    const { kinds, invalid: kindsInvalid } = parseKinds(req.query?.kinds);
    if (kindsInvalid) return badRequest(res, "invalid_kinds", `kinds must be a comma-separated subset of ${CALENDAR_KINDS.join(", ")}.`);

    const include = req.query?.include === undefined || req.query.include === "" ? [] : String(req.query.include).split(",").map((s) => s.trim()).filter(Boolean);
    if (include.some((part) => part !== "athletes")) return badRequest(res, "invalid_include", "include may only name athletes.");
    const includeAthletes = include.includes("athletes");

    const clubFilter = parseUuidList(req.query?.clubIds);
    const teamFilter = parseUuidList(req.query?.teamIds);
    const athleteFilter = parseUuidList(req.query?.athleteIds);
    if (clubFilter.invalid || teamFilter.invalid || athleteFilter.invalid) {
      return badRequest(res, "invalid_ids", "clubIds/teamIds/athleteIds must be valid UUIDs.");
    }

    const ctx = await resolveCalendarContext(req);
    if (ctx.type === null) {
      if (ctx.reason === "no_athlete_profile") return res.status(403).json({ error: "This account has no athlete profile." });
      return res.status(403).json({ error: "Forbidden" });
    }
    // The athlete workspace is always self-scoped; its filters are ignored,
    // as GET /api/training-load/calendar ignores them.
    const filters = ctx.type === "athlete" ? {} : { clubIds: clubFilter.ids, teamIds: teamFilter.ids, athleteIds: athleteFilter.ids };

    const result = await readCalendar(ctx, { from, to, today, kinds, filters, includeAthletes });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
