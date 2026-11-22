// Settings > Roles and the role assignment of Settings > Users (roles plan R3, parts B and C): events and writes.
// One write at a time per area; every write carries its own requestKey; a lost answer is *Result not confirmed* and
// Check result sends the very same request (same key) again - the server replays it, never writes twice. A refusal
// is shown as one plain sentence; the server decided it.
import { api } from "./api.js";
import {
  loadRoleDetail, loadRoles, loadRolesOfClub, loadWho, markRolesUsersStale, newRolesRequestKey, rolesCheckSettles, rolesContext, rolesErrorInfo,
  rolesOutcomeUnknown, sendRolesWrite,
} from "./roles-data.js";
import { assignScopeOptions, assignableRoles, permissionLabel, permissionReason, BASIC_ASSIGNABLE } from "./roles-view.js";
import { state } from "./state.js";

const rs = () => state.roles;

// One sentence per stable code of the Roles API (contract section 5.2); nothing of the server's text but its own
// fixed 400 sentences.
export function rolesRefusalText(info) {
  const words = (info.words || []).map(permissionLabel).join(", ");
  switch (info.code) {
    case "staleRevision": return "Someone changed this role meanwhile. Nothing was saved. Open it again to see the new version.";
    case "role_name_taken": return "A role with this name already exists. Choose another name.";
    case "role_not_editable": return "This role can't be changed or archived.";
    case "role_archived": return "This role is archived.";
    case "role_has_assignments": return `${info.count ?? "Some"} ${info.count === 1 ? "person still holds" : "people still hold"} this role. Take it from them first.`;
    case "permission_not_held": return `You do not hold ${words || "some of these permissions"} yourself, so you can't hand ${words ? "it" : "them"} on.`;
    case "role_exceeds_your_permissions": return "This role has permissions you do not hold yourself, so you can't change or give it.";
    case "permission_not_delegable": return "Only the Club admin role can hold one of these permissions.";
    case "permission_not_honoured": return "One of these permissions has no effect yet and can't be added.";
    case "role_limit_reached": return "This club has reached its limit of 50 roles. Archive one first.";
    case "permission_platform_only": return "One of these permissions is for platform administrators only.";
    case "permission_scope_mismatch": return "One of the permissions does not apply to the chosen kind of access.";
    case "club_admin_requires": return "The Club admin role must keep the permissions to give and manage roles.";
    case "scope_types_narrowed": return "A role that is already given can't lose a kind of access.";
    case "role_not_assignable_here": return "This role can't be given here.";
    case "assignment_exists": return "This person already has this role here.";
    case "assignment_already_revoked": return "This role was already taken away.";
    case "assignment_mismatch": return "This entry changed. The list was read again.";
    case "self_assignment": return "You can't give a role to yourself.";
    case "user_inactive": return "This account's login is switched off.";
    case "request_key_reused": return "This request was already used for something else. Try again.";
    case "try_again": return "The server is busy. Nothing was saved. Try again in a moment.";
    default:
      if (info.status === 400) return info.message || "Check the entries and try again.";
      return "Something went wrong. Nothing was saved.";
  }
}

const NOT_AVAILABLE = "Roles are not available in this workspace.";
const notFound = (info) => info.status === 403 || info.status === 404 || info.code === "notFound";

function focusSoon(selector) {
  if (typeof document === "undefined") return;
  setTimeout(() => document.querySelector(selector)?.focus?.(), 0);
}

// The one runner of a write. `holder.command` is the write in flight or not confirmed; a second write can't start
// beside it. Returns { data } or { info } (a stated refusal), or null when the answer is unconfirmed or stale.
async function execute(cmd, { holder, owner, render }) {
  if (holder.command && holder.command !== cmd) return null;
  if (cmd.busy) return null;
  const check = Boolean(cmd.unconfirmed);
  holder.command = cmd;
  cmd.busy = true;
  render?.();
  let data = null;
  let info = null;
  try {
    data = await sendRolesWrite(cmd);
  } catch (error) {
    info = rolesErrorInfo(error);
  }
  if (state.roles !== owner || holder.command !== cmd) return null;
  cmd.busy = false;
  if (!info) { holder.command = null; return { data, check }; }
  if (rolesOutcomeUnknown(info) || (check && !rolesCheckSettles(info))) {
    cmd.unconfirmed = true;
    cmd.checkNote = check ? "Still not confirmed. The server could not say yet; check again in a moment." : "";
    render?.();
    return null;
  }
  holder.command = null;
  return { info, check };
}

const rolesAsk = (question) => Boolean(globalThis.window?.confirm?.(question));
const rolesCommands = () => { const d = rs(); return [d.command, d.assign.command, d.who.command]; };
// A role write in flight or not confirmed (no question: beforeunload uses this too).
const rolesWriteOpen = () => rolesCommands().some((c) => c?.busy || c?.unconfirmed);

// A workspace switch, a sign-out or the app's reload asks first, like the calendar's settings ("final" leaves the page).
export function rolesMayBeLeft({ final = false } = {}) {
  const verb = final === "sign-out" || final === true ? "Sign out" : final === "switch" ? "Switch" : "Leave";
  if (rolesCommands().some((c) => c?.busy)) return rolesAsk(`A role change is still being saved. ${verb} anyway? Its result will not be shown here.`);
  if (rolesCommands().some((c) => c?.unconfirmed)) return rolesAsk(`The last role change is not confirmed. ${verb} without checking?`);
  return true;
}
export function handleRolesBeforeUnload(event) {
  if (!rolesWriteOpen()) return;
  event.preventDefault();
  event.returnValue = "";
}

function setNotice(text, tone = "ok") {
  const d = rs();
  d.notice = text;
  d.noticeTone = tone;
}

const DROPPED = { system_role_only: "only the Club admin role can hold it", not_honoured: "it has no effect yet", not_held: "you do not hold it" };

function savedText(cmd, data) {
  const name = data?.role?.name || cmd.name || "the role";
  if (cmd.verb === "create") return `Role "${name}" created.`;
  if (cmd.verb === "archive") return `Role "${name}" archived.`;
  if (cmd.verb === "copy") {
    const dropped = Array.isArray(data?.dropped) ? data.dropped : [];
    const list = dropped.map((x) => `${permissionLabel(x.word)} (${DROPPED[x.reason] || x.reason})`).join("; ");
    return `Copied as "${name}".${dropped.length ? ` Left out: ${list}.` : ""}`;
  }
  const people = Number(data?.affected?.people);
  return `Saved "${name}".${Number.isFinite(people) ? (people ? ` This changes what ${people} ${people === 1 ? "person" : "people"} can do.` : " Nobody holds this role yet.") : ""}`;
}

async function reread(render) {
  rs().stale = true;
  await loadRoles(render);
}

function draftFromRole(role) {
  return {
    name: role?.name || "", description: role?.description || "", scopeTypes: [...(role?.scopeTypes || [])],
    items: [...(role?.items || [])], reason: "",
  };
}

function findRole(id) {
  return (rs().roles || []).find((r) => r.id === id) || null;
}

async function openRole(id, render) {
  const d = rs();
  const role = findRole(id);
  if (!role || d.command) return;
  const mode = role.actions?.change ? "edit" : "view";
  const form = { mode, role, draft: draftFromRole(role), base: draftFromRole(role), detail: null, loading: true, error: "" };
  d.form = form;
  render?.();
  try {
    const detail = await loadRoleDetail(id);
    if (state.roles !== d || d.form !== form) return;
    form.role = { ...role, ...detail };
    form.detail = detail;
    form.draft = draftFromRole(form.role);
    form.base = draftFromRole(form.role);
    form.loading = false;
    // The detail may take the change right away (the list said so) or not any more.
    form.mode = form.role.actions?.change ? "edit" : "view";
  } catch (error) {
    if (state.roles !== d || d.form !== form) return;
    const info = rolesErrorInfo(error);
    d.form = null;
    setNotice(notFound(info) ? NOT_AVAILABLE : "The role could not be read. Try again.", "error");
    await reread(render);
    return;
  }
  render?.();
  focusSoon("[data-roles-field='name']");
}

function setWord(draft, word, on) {
  const has = draft.items.includes(word);
  if (on && !has) draft.items = [...draft.items, word];
  if (!on && has) draft.items = draft.items.filter((w) => w !== word);
}

export async function handleRolesAction(action, { render, renderUsers, refreshOrganization } = {}) {
  const type = action?.dataset?.action;
  if (!type || !type.startsWith("roles-")) return false;
  const d = rs();
  const id = action.dataset.roleId || "";
  switch (type) {
    case "roles-retry": await reread(render); return true;
    case "roles-toggle-archived": d.showArchived = Boolean(action.checked); render?.(); return true;
    case "roles-new": {
      if (d.command) return true;
      const ctx = rolesContext();
      d.form = { mode: "create", role: null, draft: { name: "", description: "", scopeTypes: ctx?.clubId ? ["club"] : ["club", "team"], items: [], reason: "" }, base: null, detail: null, error: "" };
      render?.();
      focusSoon("[data-roles-field='name']");
      return true;
    }
    case "roles-open": await openRole(id, render); return true;
    case "roles-copy":
    case "roles-archive": {
      const role = findRole(id);
      if (!role || d.command) return true;
      d.form = { mode: type === "roles-copy" ? "copy" : "archive", role, draft: { ...draftFromRole(role), name: "" }, base: null, detail: null, error: "" };
      render?.();
      focusSoon(type === "roles-copy" ? "[data-roles-field='name']" : "[data-roles-field='reason']");
      return true;
    }
    case "roles-cancel":
      if (d.command?.busy) return true;
      d.form = null;
      render?.();
      return true;
    case "roles-check-result":
      if (d.command?.unconfirmed) {
        const cmd = d.command;
        await settleRolesCommand(await execute(cmd, { holder: d, owner: d, render }), cmd, render);
      }
      return true;
    case "roles-assign-check": {
      const a = d.assign;
      if (a.command?.unconfirmed) {
        const cmd = a.command;
        await settleAssign(await execute(cmd, { holder: a, owner: d, render: renderUsers }), cmd, { renderUsers, refreshOrganization });
      }
      return true;
    }
    case "roles-who-ended": d.who.showEnded = !d.who.showEnded; renderUsers?.(); return true;
    case "roles-who-more": await loadWho({ more: true }, renderUsers); return true;
    case "roles-revoke-open": {
      if (d.who.command) return true;
      d.who.revoke = { id: action.dataset.assignmentId, reason: "", error: "" };
      renderUsers?.();
      focusSoon("[data-roles-revoke-reason]");
      return true;
    }
    case "roles-revoke-cancel":
      // A write whose outcome is not known stays: only Check result may settle it.
      if (d.who.command?.busy || d.who.command?.unconfirmed) return true;
      d.who.revoke = null;
      d.who.command = null;
      renderUsers?.();
      return true;
    case "roles-revoke-check": {
      const w = d.who;
      if (w.command?.unconfirmed) {
        const cmd = w.command;
        await settleRevoke(await execute(cmd, { holder: w, owner: d, render: renderUsers }), cmd, renderUsers);
      }
      return true;
    }
    default: return false;
  }
}

// Inputs and selects. A text field updates the draft without repainting (the caret stays); a choice repaints.
export function handleRolesInput(target, { render, renderUsers } = {}, eventType = "change") {
  const d = rs();
  if (!target?.closest) return false;
  const field = target.closest("[data-roles-field]");
  if (field && d.form) {
    d.form.draft[field.dataset.rolesField] = field.value;
    return true;
  }
  const scope = target.closest("[data-roles-scope]");
  if (scope && d.form && eventType === "change") {
    const value = scope.dataset.rolesScope;
    const on = scope.checked;
    const types = d.form.draft.scopeTypes.filter((t) => t !== value);
    d.form.draft.scopeTypes = on ? [...types, value] : types;
    render?.();
    focusSoon(`[data-roles-scope="${value}"]`);
    return true;
  }
  const word = target.closest("[data-roles-word]");
  if (word && d.form && eventType === "change") {
    setWord(d.form.draft, word.dataset.rolesWord, word.checked);
    render?.();
    focusSoon(`[data-roles-word="${word.dataset.rolesWord}"]`);
    return true;
  }
  const level = target.closest("[data-roles-level]");
  if (level && d.form && eventType === "change") {
    const group = (d.catalog?.groups || []).find((g) => g.key === level.dataset.rolesLevel);
    const picked = (group?.levels || []).find((l) => l.key === level.value);
    if (group && picked) {
      for (const word of group.permissions) {
        // A word the editor can't change stays as it is; the rest follow the chosen level.
        if (permissionReason(word, d.form, d.catalog)) continue;
        setWord(d.form.draft, word, picked.permissions.includes(word));
      }
      render?.();
      focusSoon(`[data-roles-level="${group.key}"]`);
    }
    return true;
  }
  const assignField = target.closest("[data-roles-assign-field]");
  if (assignField) {
    const a = d.assign;
    const form = assignField.closest("form");
    const name = assignField.dataset.rolesAssignField;
    a.draft[name] = assignField.value;
    if (form?.elements?.userId) a.draft.userId = form.elements.userId.value;
    // Only a choice of place or role repaints (once, on its change); typed fields just keep their value.
    if (name !== "scope" && name !== "roleId") return true;
    if (eventType !== "change") return true;
    if (name === "scope") {
      a.draft.roleId = "";
      a.error = "";
      const scope = assignScopeOptions(state.organization.data).find((s) => s.value === a.draft.scope);
      if (scope) void loadRolesOfClub(scope.clubId, renderUsers);
    }
    renderUsers?.();
    focusSoon(`[data-roles-assign-field="${name}"]`);
    return true;
  }
  const whoField = target.closest("[data-roles-who-field]");
  if (whoField && eventType === "change") {
    const w = d.who;
    w[whoField.dataset.rolesWhoField] = whoField.value;
    if (whoField.dataset.rolesWhoField === "clubId") {
      w.roleId = "";
      if (w.clubId) void loadRolesOfClub(w.clubId, renderUsers);
    }
    w.rows = [];
    w.nextCursor = "";
    w.loaded = false;
    void loadWho({}, renderUsers);
    return true;
  }
  const revokeReason = target.closest("[data-roles-revoke-reason]");
  if (revokeReason && d.who.revoke) {
    d.who.revoke.reason = revokeReason.value;
    return true;
  }
  return false;
}

async function settleRolesCommand(result, cmd, render) {
  const d = rs();
  if (!result) return;
  const form = cmd.form && d.form === cmd.form ? cmd.form : null;
  if (result.data) {
    if (form) d.form = null;
    // The Users screen caches the club's roles and who holds them: a settled write makes both old.
    markRolesUsersStale();
    setNotice(savedText(cmd, result.data));
    render?.();
    focusSoon("[data-roles-notice]");
    await reread(render);
    return;
  }
  const info = result.info;
  const prefix = result.check ? "Checked: " : "";
  if (notFound(info)) {
    d.form = null;
    setNotice(`${prefix}${NOT_AVAILABLE}`, "error");
    render?.();
    await reread(render);
    return;
  }
  if (info.code === "staleRevision" || info.code === "assignment_mismatch") {
    d.form = null;
    setNotice(`${prefix}${rolesRefusalText(info)}`, "error");
    render?.();
    await reread(render);
    return;
  }
  const text = `${prefix}${rolesRefusalText(info)}`;
  if (form) form.error = text;
  else setNotice(text, "error");
  render?.();
}

function requireText(value, sentence) {
  return typeof value === "string" && value.trim() ? "" : sentence;
}

function buildRoleCommand(form, ctx) {
  const draft = form.draft;
  const key = newRolesRequestKey();
  const clubId = ctx?.clubId || "";
  if (form.mode === "create") {
    const bad = requireText(draft.name, "Give the role a name.") || (draft.scopeTypes.length ? "" : "Choose what the role can be given for.") || (draft.items.length ? "" : "Tick at least one permission.");
    if (bad) return { error: bad };
    const body = { requestKey: key, name: draft.name, scopeTypes: draft.scopeTypes, items: draft.items };
    if (clubId) body.clubId = clubId;
    if (draft.description?.trim()) body.description = draft.description;
    return { cmd: { verb: "create", path: "/", body, name: draft.name } };
  }
  if (form.mode === "copy") {
    const body = { requestKey: key, clubId };
    if (draft.name?.trim()) body.name = draft.name;
    return { cmd: { verb: "copy", path: `/${encodeURIComponent(form.role.id)}/copy`, body, name: draft.name } };
  }
  const reason = requireText(draft.reason, "Write the reason. It is kept in the role's history.");
  if (reason) return { error: reason };
  if (form.mode === "archive") {
    const body = { requestKey: key, expectedRevision: form.role.revision, reason: draft.reason };
    if (clubId) body.clubId = clubId;
    return { cmd: { verb: "archive", path: `/${encodeURIComponent(form.role.id)}/archive`, body, name: form.role.name } };
  }
  // edit: only what changed
  const base = form.base;
  const body = { requestKey: key, expectedRevision: form.role.revision, reason: draft.reason };
  if (clubId) body.clubId = clubId;
  if (draft.name !== base.name) {
    const bad = requireText(draft.name, "Give the role a name.");
    if (bad) return { error: bad };
    body.name = draft.name;
  }
  if ((draft.description || "") !== (base.description || "")) body.description = draft.description?.trim() ? draft.description : null;
  if ([...draft.items].sort().join() !== [...base.items].sort().join()) body.items = draft.items;
  if ([...draft.scopeTypes].sort().join() !== [...base.scopeTypes].sort().join()) body.scopeTypes = draft.scopeTypes;
  if (!("name" in body) && !("description" in body) && !("items" in body) && !("scopeTypes" in body)) return { error: "Nothing was changed." };
  return { cmd: { verb: "change", path: `/${encodeURIComponent(form.role.id)}/change`, body, name: draft.name } };
}

// -------------------------------- Users: assign ---------------------------------
async function settleAssign(result, cmd, { renderUsers, refreshOrganization }) {
  const d = rs();
  const a = d.assign;
  if (!result) return;
  if (result.data) {
    a.draft = { ...a.draft, roleId: "", displayTitle: "", expiresAt: "", reason: "", userId: "" };
    a.error = "";
    a.notice = cmd.notice || "Role given.";
    d.who.loaded = false;
    renderUsers?.();
    focusSoon("[data-roles-assign-notice]");
    await loadWho({}, renderUsers);
    return;
  }
  const info = result.info;
  const prefix = result.check ? "Checked: " : "";
  a.error = notFound(info) ? `${prefix}${NOT_AVAILABLE}` : `${prefix}${rolesRefusalText(info)}`;
  a.notice = "";
  renderUsers?.();
  void refreshOrganization;
}

// "Ana now has Assistant in FK Borac." - who, what and where, so the admin can see the right person got the right role.
function givenText(data, scope, role, userId) {
  const user = (data.users || []).find((u) => String(u.id) === String(userId));
  return `${user?.name || user?.email || "The person"} now has ${role.name} in ${String(scope.label).replace(/^(Club|Team): /, "")}.`;
}

async function submitAssign(formEl, { renderUsers, refreshOrganization }) {
  const d = rs();
  const a = d.assign;
  if (a.command) return;
  const data = state.organization.data;
  // What is on screen is the truth: read every field of the form that the draft may not have heard of yet.
  for (const name of ["userId", "displayTitle", "expiresAt", "reason"]) {
    const value = formEl.elements?.[name]?.value;
    if (typeof value === "string") a.draft[name] = value;
  }
  const scope = assignScopeOptions(data).find((s) => s.value === a.draft.scope);
  const role = scope ? assignableRoles(a.byClub[scope.clubId]?.roles, scope.type).find((r) => r.id === a.draft.roleId) : null;
  a.notice = "";
  if (!a.draft.userId) { a.error = "Choose a user."; renderUsers?.(); return; }
  if (!scope || !role) { a.error = "Choose where and which role."; renderUsers?.(); return; }
  a.error = "";
  const scopeId = scope.value.slice(scope.type.length + 1);
  if (role.isBasic && BASIC_ASSIGNABLE[role.basicKey] === scope.type) {
    // Basic roles keep their own routes (the Roles API does not grant them).
    const route = scope.type === "club" ? "/api/organization/club-roles" : "/api/organization/team-roles";
    const userIdSent = a.draft.userId;
    const body = scope.type === "club" ? { userId: userIdSent, clubId: scopeId } : { userId: userIdSent, teamId: scopeId };
    a.command = { busy: true, basic: true };
    renderUsers?.();
    try {
      await api(route, { method: "POST", body: JSON.stringify(body) });
      if (state.roles !== d) return;
      a.command = null;
      const noticeText = givenText(data, scope, role, userIdSent);
      a.draft = { ...a.draft, roleId: "", userId: "" };
      a.notice = noticeText;
      renderUsers?.();
      await refreshOrganization?.();
      d.who.loaded = false;
      await loadWho({}, renderUsers);
    } catch (error) {
      if (state.roles !== d) return;
      a.command = null;
      const info = rolesErrorInfo(error);
      if (rolesOutcomeUnknown(info)) {
        // The old route takes no request key, so it is never sent again blindly: the check is a read of who holds what.
        a.error = "Result not confirmed. The list below was read again; check whether the role was given before you try again.";
        d.who.loaded = false;
        renderUsers?.();
        await loadWho({}, renderUsers);
        return;
      }
      a.error = error?.message || "The role could not be given.";
      renderUsers?.();
    }
    return;
  }
  const reason = requireText(a.draft.reason, "Write the reason. It is kept in the history.");
  if (reason) { a.error = reason; renderUsers?.(); return; }
  const body = { requestKey: newRolesRequestKey(), userId: a.draft.userId, roleId: role.id, scopeType: scope.type, scopeId, reason: a.draft.reason };
  if (a.draft.displayTitle?.trim()) body.displayTitle = a.draft.displayTitle;
  if (a.draft.expiresAt) {
    const t = new Date(`${a.draft.expiresAt}T23:59:59`);
    if (Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) { a.error = "Choose an end date in the future."; renderUsers?.(); return; }
    body.expiresAt = t.toISOString();
  }
  const cmd = { verb: "assign", path: "/assignments", body, notice: givenText(data, scope, role, a.draft.userId) };
  await settleAssign(await execute(cmd, { holder: a, owner: d, render: renderUsers }), cmd, { renderUsers, refreshOrganization });
}

async function settleRevoke(result, cmd, renderUsers) {
  const d = rs();
  const w = d.who;
  if (!result) return;
  if (result.data) {
    w.revoke = null;
    w.notice = "Role revoked.";
    w.loaded = false;
    renderUsers?.();
    focusSoon("[data-roles-who-notice]");
    await loadWho({}, renderUsers);
    return;
  }
  const info = result.info;
  const prefix = result.check ? "Checked: " : "";
  if (info.code === "assignment_already_revoked" || info.code === "assignment_mismatch") {
    w.revoke = null;
    w.notice = rolesRefusalText(info);
    w.loaded = false;
    renderUsers?.();
    await loadWho({}, renderUsers);
    return;
  }
  if (w.revoke) w.revoke.error = notFound(info) ? `${prefix}${NOT_AVAILABLE}` : `${prefix}${rolesRefusalText(info)}`;
  renderUsers?.();
}

async function submitRevoke(formEl, { renderUsers }) {
  const d = rs();
  const w = d.who;
  const revoke = w.revoke;
  const row = revoke && w.rows.find((r) => r.id === revoke.id);
  if (!revoke || !row || w.command) return;
  const bad = requireText(revoke.reason, "Write the reason. It is kept in the history.");
  if (bad) { revoke.error = bad; renderUsers?.(); return; }
  revoke.error = "";
  w.notice = "";
  const cmd = {
    verb: "revoke", path: `/assignments/${encodeURIComponent(row.id)}/revoke`,
    body: { requestKey: newRolesRequestKey(), reason: revoke.reason, expected: { userId: row.userId, roleId: row.roleId } },
  };
  // The form's own flags mirror the write so the row can show them.
  const mirror = new Proxy(cmd, { set(target, key, value) { target[key] = value; if (["busy", "unconfirmed", "checkNote"].includes(key)) revoke[key] = value; return true; } });
  w.command = null;
  await settleRevoke(await execute(mirror, { holder: w, owner: d, render: renderUsers }), mirror, renderUsers);
}

export async function submitRolesForm(formEl, { render, renderUsers, refreshOrganization } = {}) {
  const kind = formEl?.dataset?.rolesForm;
  const d = rs();
  if (kind === "assign") { await submitAssign(formEl, { renderUsers, refreshOrganization }); return true; }
  if (kind === "revoke") { await submitRevoke(formEl, { renderUsers }); return true; }
  if (kind !== "role" || !d.form || d.command || d.form.mode === "view" || d.form.loading) return true;
  const form = d.form;
  const built = buildRoleCommand(form, rolesContext());
  if (built.error) { form.error = built.error; render?.(); return true; }
  form.error = "";
  const cmd = { ...built.cmd, form };
  await settleRolesCommand(await execute(cmd, { holder: d, owner: d, render }), cmd, render);
  return true;
}
