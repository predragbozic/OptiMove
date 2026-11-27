import { lockProgramRpeActor, nativeProgramRpeScope } from "./programRpeSettingsAccess.js";
import { canManagePlanTrainingLoadInScope, externalScheduleScopeForWorkspace, isAthleteInWorkspaceScope } from "./trainingLoadAccess.js";
import { pickFallbackWorkspace, resolveActiveWorkspaceReadOnly } from "./workspace.js";

export function refuseProgramEdit(status = 403, message = "Forbidden") {
  return Object.assign(new Error(message), { status, code: "program_edit_scope" });
}

export async function lockProgramEditActor(client, req, { requireEdit = true } = {}) {
  if (!req.sessionToken) throw refuseProgramEdit();
  const runQuery = client.query.bind(client);
  const { workspace, availableWorkspaces } = await resolveActiveWorkspaceReadOnly(req.user.id, req.authz, runQuery);
  const selected = workspace ?? pickFallbackWorkspace(availableWorkspaces);
  const scope = externalScheduleScopeForWorkspace(selected, req);
  const actor = await lockProgramRpeActor(client, req, { ...scope, allowFallback: !workspace });
  if (!actor) throw refuseProgramEdit();
  const scopeId = nativeProgramRpeScope(scope);
  if (!scopeId) {
    return { actor: programEditActor(actor, scope), sourceActor: actor, scope, checked: false, canEdit: true };
  }
  const { rows: [rights] } = await runQuery(
    `select public.permission_word_honoured('programs.edit') as staged,
      public.user_has_permission($1,'programs.view',$2,$3) as view,
      public.user_has_permission($1,'programs.edit',$2,$3) as edit`,
    [actor.user.id, scope.type, scopeId],
  );
  if (rights?.view !== true) throw refuseProgramEdit();
  const checked = rights.staged === true && rights.edit === true;
  const writer = { actor: programEditActor(actor, scope), sourceActor: actor, scope, checked, canEdit: checked };
  if (requireEdit) assertProgramEditHeld(writer);
  return writer;
}

export function assertProgramEditHeld(writer) {
  if (!writer.canEdit) throw refuseProgramEdit();
}

function programEditActor(actor, scope) {
  if (scope.type === "platform") return actor;
  return {
    ...actor,
    authz: {
      ...actor.authz,
      platformRoles: [],
      managedTeamIds: scope.type === "team" ? actor.authz.managedTeamIds.filter(id => id === scope.teamId) : [],
      clubRoles: scope.type === "club" ? actor.authz.clubRoles.filter(role => role.clubId === scope.clubId) : [],
      teamRoles: scope.type === "team" ? actor.authz.teamRoles.filter(role => role.teamId === scope.teamId) : [],
    },
  };
}

export async function assertProgramEditOwnership(client, scope, plan) {
  if (scope.type === "platform") return;
  const { rows: [owner] } = await client.query(
    "select * from training_load.plan_workspace_ownership where plan_id=$1 for share",
    [plan.id],
  );
  // Historical non-weekly plans have no workspace record. Their unchanged
  // legacy author/athlete predicate provides the remaining authority.
  if (!owner && plan.plan_type !== "weekly") {
    if (nativeProgramRpeScope(scope) && plan.athlete_uuid &&
        !await isAthleteInWorkspaceScope(scope, plan.athlete_uuid, client.query.bind(client))) {
      throw refuseProgramEdit(404, "Draft program not found");
    }
    return;
  }
  if (!canManagePlanTrainingLoadInScope(scope, owner)) throw refuseProgramEdit(404, "Draft program not found");
}

export async function combinedProgramEditIsChecked(client, actor, plan) {
  const scope = externalScheduleScopeForWorkspace(actor.workspace, actor);
  await assertProgramEditOwnership(client, scope, plan);
  if (!nativeProgramRpeScope(scope)) return false;
  const { rows: [stage] } = await client.query("select public.permission_word_honoured('programs.edit') as checked");
  if (stage?.checked !== true) throw refuseProgramEdit();
  return true;
}

export async function recordProgramEditUse(client, checked) {
  if (!checked) return;
  await client.query(
    "insert into plans.program_manage_v109_use(singleton) values(true) on conflict(singleton) do nothing",
  );
}
