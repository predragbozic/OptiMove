import { lockProgramRpeActor, nativeProgramRpeScope } from "./programRpeSettingsAccess.js";
import { externalScheduleScopeForWorkspace } from "./trainingLoadAccess.js";
import { pickFallbackWorkspace, resolveActiveWorkspaceReadOnly } from "./workspace.js";

export function refuseProgramEdit(status = 403, message = "Forbidden") {
  return Object.assign(new Error(message), { status });
}

export async function lockProgramEditActor(client, req) {
  const runQuery = client.query.bind(client);
  const { workspace, availableWorkspaces } = await resolveActiveWorkspaceReadOnly(req.user.id, req.authz, runQuery);
  const selected = workspace ?? pickFallbackWorkspace(availableWorkspaces);
  const scope = externalScheduleScopeForWorkspace(selected, req);
  const actor = await lockProgramRpeActor(client, req, { ...scope, allowFallback: !workspace });
  if (!actor) throw refuseProgramEdit();
  const scopeId = nativeProgramRpeScope(scope);
  if (!scopeId) {
    return { actor: programEditActor(actor, scope), scope, checked: false };
  }
  const { rows: [rights] } = await runQuery(
    `select public.permission_word_honoured('programs.edit') as staged,
      public.user_has_permission($1,'programs.view',$2,$3) as view,
      public.user_has_permission($1,'programs.edit',$2,$3) as edit`,
    [actor.user.id, scope.type, scopeId],
  );
  if (rights?.view !== true || (rights.staged && rights.edit !== true)) throw refuseProgramEdit();
  return { actor: programEditActor(actor, scope), scope, checked: rights.staged === true };
}

function programEditActor(actor, scope) {
  if (scope.type === "platform") return actor;
  return {
    ...actor,
    authz: {
      ...actor.authz,
      platformRoles: [],
      clubRoles: scope.type === "club" ? actor.authz.clubRoles.filter(role => role.clubId === scope.clubId) : [],
      teamRoles: scope.type === "team" ? actor.authz.teamRoles.filter(role => role.teamId === scope.teamId) : [],
    },
  };
}

export async function recordCombinedProgramEditUse(client, workspace) {
  if (workspace.type !== "club" && workspace.type !== "team") return;
  const { rows: [stage] } = await client.query("select public.permission_word_honoured('programs.edit') as checked");
  await recordProgramEditUse(client, stage?.checked === true);
}

export async function recordProgramEditUse(client, checked) {
  if (!checked) return;
  await client.query(
    "insert into plans.program_manage_v109_use(singleton) values(true) on conflict(singleton) do nothing",
  );
}
