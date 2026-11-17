// Shared scope/permission helpers for the Training Activity domain
// (training.activities / activity_participants / activity_components /
// the 5 typed link tables) — same shape as trainingLoadMetricsAccess.js,
// deliberately not importing from it (each feature owns its own scope
// resolution over its own tables), except isAthleteInWorkspaceScope, which
// IS the single shared source of truth for "does this athlete belong to
// what I currently manage" across every training_load/training feature.
//
// training.activities is stamped from the ACTING coach's CURRENTLY ACTIVE
// workspace at write time, never from client input — same reasoning as
// trainingLoadMetricsAccess.js's own header: an activity belongs to
// whichever workspace the coach was acting in when they recorded/
// materialized it, not to an arbitrary scope they could otherwise type
// into a request body.
import { resolveActiveWorkspace } from "./workspace.js";
import { isAthleteInWorkspaceScope } from "./trainingLoadAccess.js";

export { isAthleteInWorkspaceScope };

function scopeFromWorkspace(workspace, req) {
  if (!workspace) return { type: null };
  if (workspace.type === "platform") return { type: "platform" };
  if (workspace.type === "club") return { type: "club", clubId: workspace.scopeId };
  if (workspace.type === "team") return { type: "team", teamId: workspace.scopeId };
  if (workspace.type === "private_coach") return { type: "private_coach", userId: req.user.id };
  return { type: null }; // athlete workspace, or no workspace at all
}

function ownerContextFromWorkspace(workspace, req) {
  if (workspace?.type === "club") return { ownerScope: "club", ownerUserId: null, ownerClubId: workspace.scopeId, ownerTeamId: null };
  if (workspace?.type === "team") return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: workspace.scopeId };
  if (workspace?.type === "platform") return { ownerScope: "system", ownerUserId: null, ownerClubId: null, ownerTeamId: null };
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

// Synchronous variant for a caller that already resolved workspace itself
// this request — same "resolve once, reuse" convention as
// trainingLoadAccess.js / trainingLoadMetricsAccess.js.
export function activityScopeForWorkspace(workspace, req) {
  const scope = scopeFromWorkspace(workspace, req);
  if (scope.type !== null) scope.ownerContext = ownerContextFromWorkspace(workspace, req);
  return scope;
}

export async function resolveActivityWorkspaceScope(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return activityScopeForWorkspace(workspace, req);
}

// Per-row "may this scope manage this already-owned activity" check.
export function canManageActivityInScope(scope, activity) {
  if (scope.type === "platform") return true;
  if (scope.type === "club") return activity.owner_scope === "club" && String(activity.owner_club_id) === String(scope.clubId);
  if (scope.type === "team") return activity.owner_scope === "team" && String(activity.owner_team_id) === String(scope.teamId);
  if (scope.type === "private_coach") return activity.owner_scope === "user" && String(activity.owner_user_id) === String(scope.userId);
  return false;
}

// List-query SQL-fragment variant — `alias` is the activities table alias
// in the calling query. Appends its own bind param(s) to the caller's
// `params` array, same convention as the rest of this app's scope
// helpers.
export function activityScopeSqlForWorkspace(scope, alias, params) {
  if (scope.type === "platform") return "true";
  if (scope.type === "club") {
    params.push(scope.clubId);
    return `(${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${params.length})`;
  }
  if (scope.type === "team") {
    params.push(scope.teamId);
    return `(${alias}.owner_scope = 'team' and ${alias}.owner_team_id = $${params.length})`;
  }
  if (scope.type === "private_coach") {
    params.push(scope.userId);
    return `(${alias}.owner_scope = 'user' and ${alias}.owner_user_id = $${params.length})`;
  }
  return "false";
}

// READ scope (owner decision D8, the central calendar K1a — see
// docs/ai/central-calendar-k1-plan.md, section 3): in the active CLUB
// workspace a club admin also reads the activities owned by the club's
// active teams, so a team session seen on the club's calendar never ends in
// a 404 on the activity detail (the O2 precedent of activityRoster.js, where
// the club admin already decides on a team's roster through the club
// workspace). Every other workspace keeps the manage scope above: a team
// coach reads the team's own activities (D6), a private coach their own
// (D7), a platform admin all. Reads only — the activity write routes
// (materialize, reparent, merge, the match-suggestion accept / dismiss, the
// metrics link) keep canManageActivityInScope / activityScopeSqlForWorkspace,
// so a club admin reads a team activity but still cannot change it through
// them (the same 404 as for a stranger; a deliberate asymmetry of the
// read-only phase, decided with K2's events). The roster commands are the
// one write the club admin already has, through O2 (activityRoster.js). An
// archived team (public.teams.is_active = false) is not read, as the roster
// read already treats it as missing.
export function activityReadScopeSqlForWorkspace(scope, alias, params) {
  if (scope.type === "club") {
    params.push(scope.clubId);
    const n = params.length;
    return `((${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${n}) or (${alias}.owner_scope = 'team' and exists (select 1 from public.teams t_read where t_read.id = ${alias}.owner_team_id and t_read.club_id = $${n} and coalesce(t_read.is_active, true))))`;
  }
  return activityScopeSqlForWorkspace(scope, alias, params);
}

// Row variant of activityReadScopeSqlForWorkspace. `activity` carries the
// owner columns and, for a team-owned row, `owner_team_club_id` and
// `owner_team_active` from a `left join public.teams` the caller made —
// never derived here from a second read.
export function canReadActivityInScope(scope, activity) {
  if (canManageActivityInScope(scope, activity)) return true;
  if (scope.type !== "club") return false;
  return activity.owner_scope === "team"
    && activity.owner_team_club_id != null
    && String(activity.owner_team_club_id) === String(scope.clubId)
    && activity.owner_team_active !== false;
}

// An athlete's own participation, as far as it is hers to see (owner, 2026-11-16: "the athlete sees only data that
// was really measured; there are no estimates on the athlete's side"). Saving an estimate for an athlete who was not
// in the recording creates her participant row; such a participation exists ONLY because of the estimate, and showing
// her the session - even empty - would tell her that one was made. So for an athlete-self read a participant is hers
// when it is NOT estimate-only: it is, when every measurement linked to it (her alias participants after a merge
// included; superseded ones too) is an estimate and nothing else ties her to the session - no planned session or
// rating request linked to it. A participant with no linked measurement at all stays hers, as before.
// `participantIdSql` is a SQL expression of the participant's id (a column reference written in this code, never
// a value from a request). Returns a SQL boolean.
export function athleteOwnParticipationSql(participantIdSql) {
  const occasions = `from training.participant_alias_ids(${participantIdSql}) own_pa
          join training.activity_participant_metric_participant_links own_ml on own_ml.activity_participant_id = own_pa.participant_id and own_ml.link_status = 'confirmed'
          join training_load.metric_measurement_occasions own_o on own_o.event_participant_id = own_ml.metric_event_participant_id`;
  return `not (
        exists (select 1 ${occasions})
        and not exists (select 1 ${occasions} where own_o.entry_method <> 'estimate')
        and not exists (select 1 from training.participant_alias_ids(${participantIdSql}) own_sp
                          join training.activity_participant_session_links own_sl on own_sl.activity_participant_id = own_sp.participant_id and own_sl.link_status = 'confirmed'))`;
}
