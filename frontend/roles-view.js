// Settings > Roles and the role assignment of Settings > Users (roles plan R3, parts B and C): what a club's
// administrator (or a platform administrator) sees. Pure template strings over state.roles; every text a club typed
// is escaped, no id is shown. The server's `actions`, `held` and `delegable` decide what is offered - a word the
// editor may not hold or delegate is shown disabled with the reason as text (no padlock, owner decision Q2).
import { rolesContext, rolesUsersAvailable } from "./roles-data.js";
import { renderFilterableSelect } from "./organization-select.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const rs = () => state.roles;

export const BASIC_ASSIGNABLE = Object.freeze({ club_admin: "club", team_coach: "team" });

// "athletes.logins.manage" -> "Athletes · logins · manage" (the catalog carries no labels; the module label is the group's).
export function permissionLabel(word) {
  const parts = String(word).split(/[._]/).filter(Boolean);
  return parts.map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join(" · ");
}

export function roleScopeLabel(role) {
  const types = role?.scopeTypes || [];
  return types.map((t) => (t === "team" ? "Teams" : t === "club" ? "Club" : t)).join(" and ") || "—";
}

// Why a word cannot be ticked in this form, as a sentence - or "" when it can. Server refusals stay the real guard.
export function permissionReason(word, form, catalog) {
  const cat = (catalog?.permissions || []).find((p) => p.word === word);
  if (!cat) return "This permission is not known.";
  if (form.mode === "view") return "";
  const basicKey = form.role?.basicKey || "";
  if (cat.platformOnly) return "Only platform administrators can have this.";
  if (cat.systemRoleOnly && basicKey !== "club_admin") return "Only the Club admin role can hold this.";
  if (!cat.honoured) return "Not in use yet - it has no effect today.";
  if (!(catalog.held || []).includes(word)) return "You do not hold this permission yourself.";
  if (!(catalog.delegable || []).includes(word) && basicKey !== "club_admin") return "You cannot hand this on.";
  const types = form.draft.scopeTypes || [];
  if (types.length && !cat.scopeTypes.some((t) => types.includes(t))) return "It does not apply to the chosen kind of access.";
  return "";
}

function roleBadges(role) {
  const out = [];
  if (role.owner?.scope === "system") out.push(`<span class="role-badge">${role.isBasic ? "Basic role" : "System role"}</span>`);
  if (role.archived) out.push(`<span class="user-status-badge is-disabled">Archived</span>`);
  return out.join(" ");
}

function noticeHtml(d) {
  if (!d.notice) return "";
  return `<p class="roles-notice ${d.noticeTone === "error" ? "builder-error" : "muted"}" role="${d.noticeTone === "error" ? "alert" : "status"}" tabindex="-1" data-roles-notice>${escapeHtml(d.notice)}</p>`;
}

function commandBanner(d) {
  const cmd = d.command;
  if (!cmd) return "";
  if (cmd.unconfirmed) {
    return `<div class="data-sources-error" role="alert">
      <p><strong>Result not confirmed.</strong> ${escapeHtml(cmd.checkNote || "The answer was lost, so it is not known whether this was saved.")}</p>
      <div class="data-sources-form-actions"><button class="plain-button data-sources-primary" type="button" data-action="roles-check-result"${cmd.busy ? " disabled" : ""}>Check result</button></div>
    </div>`;
  }
  return cmd.busy ? `<p class="muted" role="status">Saving…</p>` : "";
}

export function renderRolesPanelHtml() {
  const ctx = rolesContext();
  const d = rs();
  if (!ctx) return `<section class="panel data-sources roles-panel"><p class="muted data-sources-empty">Roles are not available in this workspace.</p></section>`;
  let body;
  if (d.roles && d.ctxKey === (ctx.clubId || "system")) body = d.form ? formHtml(d, ctx) : listHtml(d, ctx);
  else if (d.error) body = `<div class="data-sources-error" role="alert"><p>${escapeHtml(d.error)}</p><div class="data-sources-form-actions"><button class="plain-button" type="button" data-action="roles-retry">Try again</button></div></div>`;
  else body = `<p class="muted" role="status">Loading the roles…</p>`;
  const club = ctx.clubId ? (state.organization?.data?.clubs || []).find((c) => String(c.id) === String(ctx.clubId))?.name || "" : "";
  return `
    <section class="panel data-sources roles-panel" aria-labelledby="roles-title">
      <div class="data-sources-head">
        <p class="eyebrow">${escapeHtml(club || (ctx.clubId ? "Club" : "System roles"))}</p>
        <h3 id="roles-title">Roles</h3>
        <p class="muted">A role is a named set of permissions. Give a role to a person in Users.</p>
      </div>
      ${commandBanner(d)}
      ${noticeHtml(d)}
      ${body}
    </section>`;
}

function listHtml(d, ctx) {
  const roles = (d.roles || []).filter((r) => d.showArchived || !r.archived);
  const archivedCount = (d.roles || []).filter((r) => r.archived).length;
  const canCreate = Boolean(ctx.platform || ctx.clubId) && !d.command?.unconfirmed;
  return `
    <div class="roles-toolbar">
      ${canCreate && rolesCanWrite(d, ctx) ? `<button class="plain-button data-sources-primary" type="button" data-action="roles-new">New role</button>` : ""}
      ${archivedCount ? `<label class="roles-archived-toggle"><input type="checkbox" data-action="roles-toggle-archived"${d.showArchived ? " checked" : ""}> Show archived (${archivedCount})</label>` : ""}
    </div>
    <div class="roles-list">
      ${roles.length ? roles.map((role) => rowHtml(role, d)).join("") : `<p class="muted">No roles to show.</p>`}
    </div>`;
}

// Whether any of the caller's rows lets it create: the server decides on the write; a read-only caller sees none.
export function rolesCanWrite(d, ctx) {
  if (ctx.platform) return true;
  return (d.roles || []).some((r) => r.actions?.change || r.actions?.copy);
}

function rowHtml(role, d) {
  const a = role.actions || {};
  const busy = Boolean(d.command);
  const people = Number(role.holderCount) || 0;
  return `
    <article class="roles-row${role.archived ? " is-archived" : ""}" data-role-id="${escapeAttr(role.id)}">
      <div class="roles-row-main">
        <strong>${escapeHtml(role.name)}</strong> ${roleBadges(role)}
        ${role.description ? `<p class="muted">${escapeHtml(role.description)}</p>` : ""}
        <small>${escapeHtml(roleScopeLabel(role))} · ${people} ${people === 1 ? "person" : "people"}</small>
      </div>
      <div class="roles-row-actions">
        <button class="plain-button compact-button" type="button" data-action="roles-open" data-role-id="${escapeAttr(role.id)}">${a.change ? "Edit" : "View"}</button>
        ${a.copy ? `<button class="plain-button compact-button" type="button" data-action="roles-copy" data-role-id="${escapeAttr(role.id)}"${busy ? " disabled" : ""}>Copy</button>` : ""}
        ${a.archive ? `<button class="plain-button compact-button danger-button" type="button" data-action="roles-archive" data-role-id="${escapeAttr(role.id)}"${busy ? " disabled" : ""}>Archive</button>` : ""}
      </div>
    </article>`;
}

// What the role would show in the app: the areas (modules) that at least one ticked permission belongs to.
export function roleSections(items, catalog) {
  const words = new Set(items || []);
  const modules = new Set((catalog?.permissions || []).filter((p) => words.has(p.word)).map((p) => p.module));
  return (catalog?.modules || []).filter((m) => modules.has(m.word)).map((m) => m.label);
}

function groupHtml(group, form, catalog) {
  const draft = form.draft;
  const readOnly = form.mode === "view";
  const reasons = Object.fromEntries(group.permissions.map((w) => [w, permissionReason(w, form, catalog)]));
  const own = group.permissions.filter((w) => draft.items.includes(w));
  const exact = (group.levels || []).find((l) => l.permissions.length === own.length && l.permissions.every((w) => own.includes(w)));
  const customLevel = !exact;
  const levelKey = exact?.key;
  return `
    <fieldset class="roles-group" data-roles-group="${escapeAttr(group.key)}">
      <legend>${escapeHtml(group.label)}</legend>
      <label class="search-field roles-level"><span>Level</span>
        <select data-roles-level="${escapeAttr(group.key)}" aria-label="${escapeAttr(`${group.label} level`)}"${readOnly ? " disabled" : ""}>
          ${(group.levels || []).map((l) => `<option value="${escapeAttr(l.key)}"${!customLevel && l.key === levelKey ? " selected" : ""}>${escapeHtml(l.label)}</option>`).join("")}
          ${customLevel ? `<option value="custom" selected>Custom</option>` : ""}
        </select>
      </label>
      <ul class="roles-words">
        ${group.permissions.map((word) => {
          const reason = reasons[word];
          const disabled = readOnly || Boolean(reason);
          return `<li><label><input type="checkbox" data-roles-word="${escapeAttr(word)}"${draft.items.includes(word) ? " checked" : ""}${disabled ? " disabled" : ""}> ${escapeHtml(permissionLabel(word))}</label>${reason ? `<small class="roles-reason">${escapeHtml(reason)}</small>` : ""}</li>`;
        }).join("")}
      </ul>
    </fieldset>`;
}

function formHtml(d, ctx) {
  const form = d.form;
  const catalog = d.catalog;
  const mode = form.mode;
  const role = form.role || null;
  const draft = form.draft;
  const readOnly = mode === "view";
  const title = { create: "New role", edit: `Edit ${role?.name || "role"}`, view: role?.name || "Role", copy: `Copy ${role?.name || "role"}`, archive: `Archive ${role?.name || "role"}` }[mode];
  const busy = Boolean(d.command);
  const holders = Number(role?.holderCount) || 0;
  const sections = roleSections(draft.items, catalog);
  const needsReason = mode === "edit" || mode === "archive";
  const reasonField = needsReason ? `<label class="search-field"><span>Reason (kept in the role's history)</span><textarea name="reason" data-roles-field="reason" rows="2" maxlength="500" required>${escapeHtml(draft.reason || "")}</textarea></label>` : "";
  const submit = { create: "Create role", edit: "Save changes", copy: "Copy role", archive: "Archive role" }[mode];
  let body;
  if (mode === "archive") {
    body = `<p>${holders ? `${holders} ${holders === 1 ? "person holds" : "people hold"} this role now. A role that is held can't be archived: take it from them first.` : "Nobody holds this role. It will be archived and can no longer be given."}</p>${reasonField}`;
  } else if (mode === "copy") {
    body = `<p class="muted">A copy keeps the permissions you may hand on. The rest are listed after the copy is made.</p>
      <label class="search-field"><span>Name of the copy (optional)</span><input data-roles-field="name" value="${escapeAttr(draft.name || "")}" maxlength="80" autocomplete="off"></label>`;
  } else {
    const basic = Boolean(role?.isBasic);
    body = `
      <label class="search-field"><span>Name</span><input data-roles-field="name" value="${escapeAttr(draft.name || "")}" maxlength="80" required autocomplete="off"${readOnly ? " readonly" : ""}></label>
      <label class="search-field"><span>Description (optional)</span><textarea data-roles-field="description" rows="2" maxlength="500"${readOnly ? " readonly" : ""}>${escapeHtml(draft.description || "")}</textarea></label>
      <fieldset class="roles-scope"><legend>Can be given for</legend>
        ${[["club", "The whole club"], ["team", "A team"]].map(([value, label]) => `<label><input type="checkbox" data-roles-scope="${value}"${draft.scopeTypes.includes(value) ? " checked" : ""}${readOnly || basic ? " disabled" : ""}> ${label}</label>`).join("")}
      </fieldset>
      ${mode === "edit" && holders ? `<p class="muted">${holders} ${holders === 1 ? "person holds" : "people hold"} this role. A change applies to all of them.</p>` : ""}
      ${readOnly && role ? `<p class="muted">You can read this role but not change it.</p>` : ""}
      ${(catalog?.groups || []).map((g) => groupHtml(g, form, catalog)).join("")}
      <section class="roles-preview" aria-live="polite" data-roles-preview>
        <h4>What this role sees</h4>
        ${sections.length ? `<ul>${sections.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : `<p class="muted">Nothing yet. Tick at least one permission.</p>`}
      </section>
      ${reasonField}
      ${readOnly ? historyHtml(form) : ""}
      ${mode === "edit" ? historyHtml(form) : ""}`;
  }
  return `
    <form class="data-sources-form roles-form" data-roles-form="role" novalidate>
      <h4 class="data-sources-form-title">${escapeHtml(title)}</h4>
      ${form.loading ? `<p class="muted" role="status">Loading the role…</p>` : body}
      ${form.error ? `<p class="builder-error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      <div class="data-sources-form-actions">
        <button class="plain-button" type="button" data-action="roles-cancel"${busy && !readOnly ? " disabled" : ""}>${readOnly ? "Close" : "Cancel"}</button>
        ${readOnly || form.loading ? "" : `<button class="plain-button data-sources-primary${mode === "archive" ? " danger-button" : ""}" type="submit"${busy ? " disabled" : ""}>${escapeHtml(submit)}</button>`}
      </div>
    </form>`;
}

function historyHtml(form) {
  const history = form.detail?.history;
  if (!Array.isArray(history) || !history.length) return "";
  const date = (value) => { const t = new Date(value); return Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString("en-GB"); };
  return `<details class="roles-history"><summary>History (${history.length})</summary>
    <ol>${[...history].reverse().map((h) => `<li>Version ${Number(h.revision)} · ${escapeHtml(String(h.kind || "").replace(/_/g, " "))} · ${escapeHtml(date(h.at))}${h.reason ? ` · ${escapeHtml(h.reason)}` : ""}${h.itemsAdded?.length ? ` · added ${h.itemsAdded.length}` : ""}${h.itemsRemoved?.length ? ` · removed ${h.itemsRemoved.length}` : ""}</li>`).join("")}</ol></details>`;
}

// ---------------------------------------------------------------------------
// Settings > Users: ONE role assignment form (owner decision Q3), and "who holds what".
// ---------------------------------------------------------------------------
const scopeOptionsOf = (data) => [
  ...(data.manageableClubIds?.length ? (data.clubs || []).filter((c) => data.manageableClubIds.some((id) => String(id) === String(c.id))) : (data.clubs || []))
    .map((club) => ({ value: `club:${club.id}`, label: `Club: ${club.name}`, clubId: club.id, type: "club" })),
  ...(data.manageableTeamIds?.length ? (data.teams || []).filter((t) => data.manageableTeamIds.some((id) => String(id) === String(t.id))) : (data.teams || []))
    .map((team) => ({ value: `team:${team.id}`, label: `Team: ${team.name}${team.club_name ? ` - ${team.club_name}` : ""}`, clubId: team.club_id, type: "team" })),
];
export const assignScopeOptions = scopeOptionsOf;

// The roles one scope may be given: the club's own and the system roles the server lists, plus the two basic ones
// that the existing routes grant.
export function assignableRoles(roles, scopeType) {
  return (roles || []).filter((r) => !r.archived && r.scopeTypes?.includes(scopeType)
    && (r.actions?.assign || BASIC_ASSIGNABLE[r.basicKey] === scopeType));
}

export function renderRolesAssignHtml(data) {
  const d = rs();
  const a = d.assign;
  const users = data.users || [];
  if (!users.length) return "";
  const scopes = scopeOptionsOf(data);
  const scope = scopes.find((s) => s.value === a.draft.scope) || null;
  const list = scope ? a.byClub[scope.clubId] : null;
  const roles = scope && list?.roles ? assignableRoles(list.roles, scope.type) : [];
  const role = roles.find((r) => r.id === a.draft.roleId) || null;
  const basic = Boolean(role?.isBasic);
  const userOptions = users.map((u) => ({ value: u.id, label: `${u.name || u.email}${u.email ? ` - ${u.email}` : ""}` }));
  const cmd = a.command;
  return `
    <div data-roles-assign>
      <form class="panel organization-form roles-assign-form" data-roles-form="assign" novalidate>
        <div><p class="eyebrow">Access</p><h3>Give a role</h3></div>
        ${renderFilterableSelect({ name: "userId", label: "User", options: userOptions, value: a.draft.userId, required: true, placeholder: "Type user name or email" })}
        <label class="search-field"><span>Where</span>
          <select name="scope" data-roles-assign-field="scope" required>
            <option value="">Choose a club or a team</option>
            ${scopes.map((s) => `<option value="${escapeAttr(s.value)}"${s.value === a.draft.scope ? " selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}
          </select>
        </label>
        <label class="search-field"><span>Role</span>
          <select name="roleId" data-roles-assign-field="roleId" required${scope && roles.length ? "" : " disabled"}>
            <option value="">${!scope ? "Choose where first" : list?.loading ? "Loading roles…" : roles.length ? "Choose a role" : "No role can be given here"}</option>
            ${roles.map((r) => `<option value="${escapeAttr(r.id)}"${r.id === a.draft.roleId ? " selected" : ""}>${escapeHtml(r.name)}${r.isBasic ? " (basic role)" : ""}</option>`).join("")}
          </select>
        </label>
        ${list?.error ? `<p class="builder-error" role="alert">${escapeHtml(list.error)}</p>` : ""}
        ${role && !basic ? `
          <label class="search-field"><span>Title shown next to the name (optional)</span><input name="displayTitle" data-roles-assign-field="displayTitle" value="${escapeAttr(a.draft.displayTitle)}" maxlength="80" autocomplete="off"></label>
          <label class="search-field"><span>Ends on (optional)</span><input type="date" name="expiresAt" data-roles-assign-field="expiresAt" value="${escapeAttr(a.draft.expiresAt)}"></label>
          <label class="search-field"><span>Reason (kept in the history)</span><textarea name="reason" data-roles-assign-field="reason" rows="2" maxlength="500" required>${escapeHtml(a.draft.reason)}</textarea></label>` : ""}
        ${basic ? `<p class="muted">A basic role has no title, end date or reason.</p>` : ""}
        ${a.error ? `<p class="builder-error" role="alert">${escapeHtml(a.error)}</p>` : ""}
        ${a.notice ? `<p class="muted" role="status" tabindex="-1" data-roles-assign-notice>${escapeHtml(a.notice)}</p>` : ""}
        ${cmd?.unconfirmed ? `<div class="data-sources-error" role="alert"><p><strong>Result not confirmed.</strong> ${escapeHtml(cmd.checkNote || "The answer was lost, so it is not known whether the role was given.")}</p><button class="plain-button data-sources-primary" type="button" data-action="roles-assign-check"${cmd.busy ? " disabled" : ""}>Check result</button></div>` : ""}
        <div class="organization-form-footer">
          <button class="plain-button data-sources-primary" type="submit"${!role || cmd ? " disabled" : ""}>${cmd?.busy ? "Saving…" : "Give role"}</button>
        </div>
      </form>
    </div>`;
}

const STATE_WORDS = { active: "Active", revoked: "Revoked", expired: "Ended", lapsed: "Ended" };

export function renderRolesWhoHtml(data) {
  const d = rs();
  const who = d.who;
  if (who.unavailable || !rolesUsersAvailable(data)) return "";
  const ctx = rolesContext(data);
  const clubs = data.clubs || [];
  const clubId = who.clubId || ctx?.clubId || "";
  const roles = (d.assign.byClub[clubId]?.roles || []).filter((r) => !r.archived);
  const teamName = (id) => (data.teams || []).find((t) => String(t.id) === String(id))?.name || "Team";
  const clubName = (id) => clubs.find((c) => String(c.id) === String(id))?.name || "Club";
  const date = (value) => { const t = new Date(value); return Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString("en-GB"); };
  return `
    <section class="panel roles-who" data-roles-who aria-labelledby="roles-who-title">
      <div class="organization-list-head"><p class="eyebrow">Access</p><h3 id="roles-who-title">Who holds what</h3></div>
      <div class="roles-who-filters">
        ${ctx?.clubId ? "" : `<label class="search-field"><span>Club</span><select data-roles-who-field="clubId"><option value="">All clubs</option>${clubs.map((c) => `<option value="${escapeAttr(c.id)}"${String(c.id) === String(clubId) ? " selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></label>`}
        <label class="search-field"><span>Role</span><select data-roles-who-field="roleId"><option value="">All roles</option>${roles.map((r) => `<option value="${escapeAttr(r.id)}"${r.id === who.roleId ? " selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}</select></label>
      </div>
      ${who.error ? `<p class="builder-error" role="alert">${escapeHtml(who.error)}</p>` : ""}
      ${who.notice ? `<p class="muted" role="status" tabindex="-1" data-roles-who-notice>${escapeHtml(who.notice)}</p>` : ""}
      <div class="roles-who-list">
        ${who.rows.length ? who.rows.map((row) => whoRowHtml(row, who, { teamName, clubName, date })).join("") : who.loading || !who.loaded ? `<p class="muted" role="status">Loading…</p>` : `<p class="muted">Nobody holds a role here yet.</p>`}
      </div>
      ${who.nextCursor ? `<button class="plain-button compact-button" type="button" data-action="roles-who-more"${who.loading ? " disabled" : ""}>Show more</button>` : ""}
    </section>`;
}

function whoRowHtml(row, who, { teamName, clubName, date }) {
  const scope = row.scopeType === "team" ? teamName(row.scopeId) : clubName(row.scopeId);
  const revoking = who.revoke && who.revoke.id === row.id ? who.revoke : null;
  const canRevoke = row.source === "assignment" && row.state === "active";
  const stateWord = STATE_WORDS[row.state] || String(row.state || "");
  return `
    <article class="roles-who-row" data-assignment-id="${escapeAttr(row.id)}">
      <div class="roles-who-main">
        <strong>${escapeHtml(row.userName || "User")}</strong>
        <span>${escapeHtml(row.roleName || "Role")}${row.title ? ` · ${escapeHtml(row.title)}` : ""}</span>
        <small>${escapeHtml(scope)} · ${escapeHtml(stateWord)}${row.expiresAt ? ` · until ${escapeHtml(date(row.expiresAt))}` : ""}</small>
      </div>
      <div class="roles-row-actions">
        ${canRevoke && !revoking ? `<button class="plain-button compact-button danger-button" type="button" data-action="roles-revoke-open" data-assignment-id="${escapeAttr(row.id)}">Revoke</button>` : ""}
        ${row.source === "basic" && row.state === "active" ? `<button class="plain-button compact-button" type="button" data-action="organization-manage-account-open" data-user-id="${escapeAttr(row.userId)}">Manage account</button>` : ""}
      </div>
      ${revoking ? `
        <form class="roles-revoke-form" data-roles-form="revoke" novalidate>
          <label class="search-field"><span>Reason (kept in the history)</span><textarea data-roles-revoke-reason rows="2" maxlength="500" required>${escapeHtml(revoking.reason)}</textarea></label>
          ${revoking.error ? `<p class="builder-error" role="alert">${escapeHtml(revoking.error)}</p>` : ""}
          ${revoking.unconfirmed ? `<p class="builder-error" role="alert"><strong>Result not confirmed.</strong> ${escapeHtml(revoking.checkNote || "The answer was lost.")}</p>` : ""}
          <div class="data-sources-form-actions">
            <button class="plain-button" type="button" data-action="roles-revoke-cancel"${revoking.busy ? " disabled" : ""}>Cancel</button>
            ${revoking.unconfirmed
              ? `<button class="plain-button data-sources-primary" type="button" data-action="roles-revoke-check"${revoking.busy ? " disabled" : ""}>Check result</button>`
              : `<button class="plain-button data-sources-primary danger-button" type="submit"${revoking.busy ? " disabled" : ""}>Revoke role</button>`}
          </div>
        </form>` : ""}
    </article>`;
}
