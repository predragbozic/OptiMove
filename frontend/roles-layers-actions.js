// The plain side of the two role-layer islands of roles R4-4, PR B (docs/ai/roles-r4-4-screens-contract.md 5.2-5.5):
// Settings > Roles in a club workspace draws an empty host for *Club roles*, Settings > Users one for *Access in this
// club*; after a paint of either, syncRolesLayers() reads what is missing, mounts the island into its host (React is
// imported lazily, only when a host exists) and passes the state and callbacks. Each island's state belongs to one club
// (and Person access to one person); nothing is shown or written for a club that is not the host's.
import {
  answerClubRole, cancelHoldingEdit, clubRoleChanges, clubRoles, clubRolesNeedLoad, closeClubRole, editHolding,
  endPersonCustom, loadClubRoles, loadPerson, loadPersonClub, openClubRole, person, personChanges, removeDriftWord,
  removeFromCustoms, saveClubRole, savePersonCustom, toggleClubRoleWord, togglePersonWord, writeOpen,
} from "./roles-layers-data.js";
import { handleRolesAction } from "./roles-actions.js";
import { rolesCanWrite } from "./roles-view.js";
import { rolesContext } from "./roles-data.js";
import { state } from "./state.js";

export const CLUB_ROLES_HOST = "[data-club-roles-host]";
export const PERSON_ACCESS_HOST = "[data-person-access-host]";

let islands = null;
let loadingIslands = null;
const hosts = { roles: null, person: null };
let renders = { renderRoles: null, renderUsers: null };

function loadIslands() {
  if (islands) return Promise.resolve(islands);
  loadingIslands ??= import("./react-build/islands.js").then((mod) => { islands = mod; return mod; }).finally(() => { loadingIslands = null; });
  return loadingIslands;
}

const hostClub = (host) => host?.dataset.clubId || "";

// The club's own roles keep R3's tested flows (the form is drawn by roles-view.js instead of the island while open).
const ownRole = (action, roleId = "") => () => { void handleRolesAction({ dataset: { action, roleId } }, { render: renders.renderRoles }); };

function clubRolesProps(host) {
  const same = hostClub(host) === clubRoles.clubId;
  const d = state.roles;
  const ctx = rolesContext();
  const rerender = () => rerenderRoles();
  const base = { clubName: host.dataset.clubName || "", catalog: d.catalog, r2Roles: d.roles || [], platform: Boolean(ctx?.platform), onRetry: () => { clubRoles.error = ""; void loadClubRoles(hostClub(host), rerender); } };
  if (!same) return { ...base, loading: true, view: null };
  return {
    ...base,
    view: clubRoles.view,
    loading: clubRoles.loading,
    error: clubRoles.error,
    openRoleId: clubRoles.openRoleId,
    draft: clubRoles.draft,
    changes: clubRoleChanges(),
    reason: clubRoles.reason,
    command: clubRoles.command,
    notice: clubRoles.notice,
    noticeTone: clubRoles.noticeTone,
    stillHolding: clubRoles.stillHolding,
    removalReason: clubRoles.removalReason,
    canCreate: Boolean(ctx?.clubId) && rolesCanWrite(d, ctx),
    onOpen: (roleId) => { openClubRole(roleId); rerender(); },
    onClose: () => { closeClubRole(); rerender(); },
    onToggle: (word) => { toggleClubRoleWord(word); rerender(); },
    onReason: (text) => { clubRoles.reason = text; rerender(); },
    onSave: () => { void saveClubRole(rerender); },
    onAnswer: (roleId, choice) => { void answerClubRole(roleId, choice, rerender); },
    onRemovalReason: (text) => { clubRoles.removalReason = text; rerender(); },
    onRemove: () => { void removeFromCustoms(rerender); },
    onCheck: () => {
      const kind = clubRoles.command?.kind;
      if (kind === "version") void saveClubRole(rerender, { check: true });
      else if (kind === "answer") void answerClubRole(clubRoles.command.roleId, clubRoles.command.body.choice, rerender, { check: true });
      else if (kind === "removal") void removeFromCustoms(rerender, { check: true });
    },
    onCopy: (roleId) => ownRole("roles-copy", roleId)(),
    onOwnOpen: (roleId) => ownRole("roles-open", roleId)(),
    onOwnNew: () => ownRole("roles-new")(),
    onOwnCopy: (roleId) => ownRole("roles-copy", roleId)(),
    onOwnArchive: (roleId) => ownRole("roles-archive", roleId)(),
  };
}

function personProps(host) {
  const same = hostClub(host) === person.clubId;
  const data = state.organization?.data || {};
  const rerender = () => rerenderPerson();
  const clubId = hostClub(host);
  const people = (data.users || [])
    .filter((u) => u.loginActive !== false)
    .map((u) => ({ id: String(u.id), name: u.name || u.email || "User" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const base = { clubName: host.dataset.clubName || "", people, selfId: String(state.currentUser?.id || ""), platform: Boolean(data.isPlatformAdmin), teams: (data.teams || []).filter((t) => String(t.club_id) === clubId) };
  if (!same) return { ...base, loading: true };
  return {
    ...base,
    userId: person.userId,
    catalog: person.catalog,
    view: person.view,
    loading: person.loading,
    error: person.error,
    editKey: person.editKey,
    draft: person.draft,
    changes: personChanges(),
    reason: person.reason,
    endKey: person.endKey,
    endReason: person.endReason,
    command: person.command,
    notice: person.notice,
    noticeTone: person.noticeTone,
    drift: person.drift,
    driftError: person.driftError,
    onPick: (userId) => { void loadPerson(userId, rerender); },
    onEdit: (key) => { editHolding(key); rerender(); },
    onCancel: () => { cancelHoldingEdit(); rerender(); },
    onToggle: (word) => { togglePersonWord(word); rerender(); },
    onReason: (text) => { person.reason = text; rerender(); },
    onSave: () => { void savePersonCustom(rerender); },
    onAskEnd: (key) => { if (!person.command) { person.endKey = key; person.editKey = ""; person.draft = null; person.endReason = ""; } rerender(); },
    onEndReason: (text) => { person.endReason = text; rerender(); },
    onEnd: () => { void endPersonCustom(rerender); },
    onDriftRemove: (roleId, word) => { void removeDriftWord(roleId, word, rerender); },
    onCheck: () => {
      const kind = person.command?.kind;
      if (kind === "custom") void savePersonCustom(rerender, { check: true });
      else if (kind === "end") void endPersonCustom(rerender, { check: true });
      else if (kind === "drift") void removeDriftWord("", person.command.word, rerender, { check: true });
    },
  };
}

async function mount(which, host, Component, props, name) {
  const mod = await loadIslands();
  if (!host.isConnected || hosts[which] !== host) return;
  mod.mountIsland(host, mod[Component], props(host), { name });
}

function rerenderRoles() {
  const host = hosts.roles;
  if (!host?.isConnected) return;
  if (clubRolesNeedLoad(hostClub(host))) void loadClubRoles(hostClub(host), rerenderRoles);
  void mount("roles", host, "ClubRoles", clubRolesProps, "club_roles");
}

function rerenderPerson() {
  const host = hosts.person;
  if (!host?.isConnected) return;
  const clubId = hostClub(host);
  if (clubId && person.clubId !== clubId && !writeOpen(person)) void loadPersonClub(clubId, rerenderPerson);
  void mount("person", host, "PersonAccess", personProps, "person_access");
}

function swap(which, host) {
  if (hosts[which] && hosts[which] !== host && islands) islands.unmountIsland(hosts[which]);
  hosts[which] = host;
}

// After a paint of Settings (or of the roles or users surface): mount into the hosts drawn, unmount the ones gone.
export function syncRolesLayers(root = globalThis.document, given = {}) {
  renders = { ...renders, ...given };
  swap("roles", root?.querySelector?.(CLUB_ROLES_HOST) || null);
  swap("person", root?.querySelector?.(PERSON_ACCESS_HOST) || null);
  if (hosts.roles) rerenderRoles();
  if (hosts.person) rerenderPerson();
}

// Leaving Settings: both islands go at once.
export function leaveRolesLayers() {
  for (const which of ["roles", "person"]) {
    if (hosts[which] && islands) islands.unmountIsland(hosts[which]);
    hosts[which] = null;
  }
}
