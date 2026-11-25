// Roles V-3 (docs/ai/roles-v-steps-plan.md section 2.4): the calendar module's context and its entry gate's read list.
// Kept apart from calendarAccess.js (the read scopes, which other modules import) so that only the calendar's routers
// load moduleView.js and permissions.js through it.
import { resolveCalendarContext } from "./calendarAccess.js";
import { canView } from "./moduleView.js";
import { can, clubScope, teamScope } from "./permissions.js";

// Roles V-3 (docs/ai/roles-v-steps-plan.md section 2.4): the context of every route of the calendar module (GET
// /api/calendar, the events, Settings -> Calendar; not the athlete's questions, which have no coach side).
//   - A request the entry gate refused (routes/calendar.js, routes/calendarEvents.js: a view workspace on a route that is
//     not one of the listed reads, without calendar.view, or under a closed licence) gets the context a view workspace
//     got before V-3 - none - so every route answers exactly what it answered then. Nothing is resolved again.
//   - A listed read of a view workspace (req.moduleView, set by the gate after canView()) reads the club or team the
//     workspace names. The workspace itself stays the club_view / team_view one, so every write rule and owner rule
//     (eventWriteBasis, eventOwnerForWorkspace, the settings' club) recognizes nothing and answers no; `view` is the
//     DATA context of the reads only (ADR-002), `readOnly` says so, and the activity scope carries no owner context.
//   - A coach workspace (an old role row) keeps today's context, but only with calendar.view there (R4 section 6: the
//     whole module, writes included, asks for the view word; the club's licence is inside can()). Without it, none.
// `athleteNames`: may the answer name athletes (P-1: only with athletes.view)? Always true outside a view workspace.
export async function resolveCalendarModuleContext(req) {
  if (req.calendarViewRefused === true) return { type: null, reason: "no_workspace" };
  if (req.moduleView) {
    const { workspace, scope } = req.moduleView;
    if (req.method !== "GET" || req.moduleView.module !== "calendar" || !scope) return { type: null, reason: "no_workspace" };
    const team = scope.type === "team";
    const clubId = team ? (workspace.clubId == null ? null : String(workspace.clubId)) : scope.id;
    return {
      type: "coach", workspace, userId: req.user.id, readOnly: true,
      view: Object.freeze({ type: scope.type, id: scope.id, clubId }),
      activityScope: Object.freeze(team ? { type: "team", teamId: scope.id } : { type: "club", clubId: scope.id }),
      athleteNames: canView(req.authz, workspace, "athletes"),
    };
  }
  const ctx = await resolveCalendarContext(req);
  if (ctx.type === "coach" && !coachViewsCalendar(req.authz, ctx.workspace)) return { type: null, reason: "no_workspace" };
  if (ctx.type !== null) ctx.athleteNames = true;
  return ctx;
}

// calendar.view in a coach workspace: at the club or team of an old role row (the licence is inside can(); a platform
// admin passes); the platform and a private coach's workspace as canView() keeps them (R4 Q10: unchanged).
function coachViewsCalendar(authz, workspace) {
  const scope = workspace.type === "club" ? clubScope(String(workspace.scopeId)) : workspace.type === "team" ? teamScope(String(workspace.scopeId)) : null;
  if (scope) return can(authz, "calendar.view", scope);
  return canView(authz, workspace, "calendar");
}

// The calendar's entry gate (moduleView.js viewEntryGate): a view workspace reaches the listed reads with calendar.view;
// anything else it asks is marked refused and goes on WITHOUT req.moduleView, so the route answers what it answered a
// view workspace before V-3 (no context: GET /api/calendar 403, an event read or write 404, a create 403).
export const CALENDAR_VIEW_READS = Object.freeze({
  calendar: Object.freeze([{ method: "GET", path: "/" }]),
  events: Object.freeze([{ method: "GET", path: "/types" }, { method: "GET", path: "/:eventId" }]),
});
export function calendarViewRefused(req, _res, next) {
  req.calendarViewRefused = true;
  next();
}
