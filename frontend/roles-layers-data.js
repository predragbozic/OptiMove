// Roles R4-4, PR B (docs/ai/roles-r4-4-screens-contract.md 5.2-5.6): the data side of the two role-layer islands over
// the R4-3 routes (backend/src/permissionLayersService.js):
//   * Club roles  - GET /clubs/:clubId/roles; POST /:roleId/clubs/:clubId/version and .../version/answer;
//                   POST /:roleId/clubs/:clubId/custom-word-removal (Take it from them too);
//   * Person access - GET /users/:userId/clubs/:clubId, GET /catalog?clubId, GET /clubs/:clubId/custom-drift;
//                   POST /users/:userId/clubs/:clubId/custom, POST /users/:userId/custom/:customId/end.
// The server decides everything; nothing here is the protection. Every write carries its own requestKey; a lost answer
// is "Result not confirmed" and Check result sends the very same request again (never a read). One write at a time per
// island; a newer read always wins over an older answer; every state belongs to one club (and one person) and an
// answer for a replaced state settles nothing.
import { api } from "./api.js";
import { CENTRAL_CALENDAR_WRITE_BOUND_MS, centralCalendarErrorInfo, centralCalendarOutcomeUnknown, newCentralCalendarRequestKey } from "./central-calendar-data.js";
import { itemChanges, layersCheckSettles, layersRefusalText, wordsText } from "./roles-layers-rules.js";
import { normalizeCatalog, rolesErrorInfo } from "./roles-data.js";

export const LAYERS_BASE = "/api/organization/roles";
const enc = encodeURIComponent;

function send(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(CENTRAL_CALENDAR_WRITE_BOUND_MS) : undefined;
  return api(`${LAYERS_BASE}${path}`, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}

const errorInfo = (error) => ({ ...centralCalendarErrorInfo(error), words: rolesErrorInfo(error).words });

function readErrorText(error, what) {
  const status = Number(error?.status) || 0;
  if (status === 401) return "Please sign in again.";
  if (status === 404) return "This is no longer available.";
  return `${what} could not be read. Try again.`;
}

// One write of a holder (clubRoles or person): send, then classify the answer. `onSaved(answer)` settles a success,
// `onRefused(info)` a stated refusal; a lost answer keeps the command unconfirmed for Check result.
async function runCommand(holder, command, render, { onSaved, onRefused, check = false }) {
  const mine = holder.epoch;
  const current = () => mine === holder.epoch;
  holder.command = { ...command, busy: true, unconfirmed: check };
  holder.notice = "";
  render?.();
  try {
    const answer = await send(command.path, command.body);
    if (!current()) return;
    holder.command = null;
    onSaved(answer);
  } catch (error) {
    if (!current()) return;
    const info = errorInfo(error);
    if (check ? !layersCheckSettles(info) : centralCalendarOutcomeUnknown(info)) {
      holder.command = { ...command, busy: false, unconfirmed: true };
      holder.notice = check ? "Still not confirmed. Try Check result again in a moment." : "";
      holder.noticeTone = "error";
    } else {
      holder.command = null;
      onRefused(info);
    }
  }
  render?.();
}

export const writeOpen = (holder) => Boolean(holder.command?.busy || holder.command?.unconfirmed);

// ---------------------------------------------------------------------------
// Club roles (contract 5.2): the club's built-in roles with their state, and the club's own roles (R2, listed only).
// ---------------------------------------------------------------------------
export function emptyClubRoles() {
  return {
    clubId: "", epoch: 0, view: null, loading: false, error: "", openRoleId: "", draft: null, reason: "",
    command: null, notice: "", noticeTone: "ok", stillHolding: null, removalReason: "",
  };
}
export const clubRoles = emptyClubRoles();
let clubGeneration = 0;

export function resetClubRoles() {
  const epoch = clubRoles.epoch + 1;
  Object.assign(clubRoles, emptyClubRoles(), { epoch });
  clubGeneration += 1;
}

export async function loadClubRoles(clubId, render) {
  if (!clubId) return;
  if (clubRoles.clubId !== clubId) {
    if (writeOpen(clubRoles)) return;
    const epoch = clubRoles.epoch + 1;
    Object.assign(clubRoles, emptyClubRoles(), { clubId, epoch });
  }
  const mine = ++clubGeneration;
  clubRoles.loading = true;
  render?.();
  try {
    const view = await api(`${LAYERS_BASE}/clubs/${enc(clubId)}/roles`);
    if (mine !== clubGeneration || clubRoles.clubId !== clubId) return;
    clubRoles.view = view && Array.isArray(view.systemRoles) ? view : { systemRoles: [], clubRoles: [], closedModules: [] };
    clubRoles.error = "";
  } catch (error) {
    if (mine !== clubGeneration || clubRoles.clubId !== clubId) return;
    clubRoles.error = readErrorText(error, "The club's roles");
  } finally {
    if (mine === clubGeneration && clubRoles.clubId === clubId) clubRoles.loading = false;
  }
  render?.();
}

export function clubRolesNeedLoad(clubId) {
  if (!clubId) return false;
  if (clubRoles.clubId !== clubId) return !writeOpen(clubRoles);
  return !clubRoles.loading && !clubRoles.command && !clubRoles.view && !clubRoles.error;
}

export const systemRoleOf = (roleId) => (clubRoles.view?.systemRoles || []).find((r) => r.roleId === roleId) || null;

export function openClubRole(roleId) {
  if (clubRoles.command) return;
  const role = systemRoleOf(roleId);
  clubRoles.openRoleId = role ? roleId : "";
  clubRoles.draft = role ? [...role.effectiveItems] : null;
  clubRoles.reason = "";
  clubRoles.notice = "";
  clubRoles.stillHolding = null;
}

export function closeClubRole() {
  if (writeOpen(clubRoles)) return;
  clubRoles.openRoleId = "";
  clubRoles.draft = null;
  clubRoles.reason = "";
  clubRoles.stillHolding = null;
}

export function toggleClubRoleWord(word) {
  if (!clubRoles.draft || clubRoles.command) return;
  clubRoles.draft = clubRoles.draft.includes(word) ? clubRoles.draft.filter((w) => w !== word) : [...clubRoles.draft, word];
}

export const clubRoleChanges = () => {
  const role = systemRoleOf(clubRoles.openRoleId);
  return role && clubRoles.draft ? itemChanges(role.effectiveItems, clubRoles.draft) : { add: [], remove: [] };
};

// A refusal that carries the current role (version_changed, question_outdated) refreshes it on screen; the draft is
// kept on top of it.
function applyCurrentRole(current) {
  if (!current?.roleId || !clubRoles.view) return;
  clubRoles.view.systemRoles = clubRoles.view.systemRoles.map((r) => (r.roleId === current.roleId ? current : r));
}

// Save the open role's ticks: the first change makes the club's version (expectedRevision null), later ones change it.
export async function saveClubRole(render, { check = false } = {}) {
  if (clubRoles.command?.busy) return;
  let command;
  if (check) {
    if (!clubRoles.command?.unconfirmed || clubRoles.command.kind !== "version") return;
    command = clubRoles.command;
  } else {
    if (clubRoles.command) return;
    const role = systemRoleOf(clubRoles.openRoleId);
    if (!role) return;
    const { add, remove } = clubRoleChanges();
    if (!add.length && !remove.length) return;
    const reason = clubRoles.reason.trim();
    if (!reason) {
      clubRoles.notice = "Write a reason. It is kept in the role's history.";
      clubRoles.noticeTone = "error";
      render?.();
      return;
    }
    command = {
      kind: "version", roleId: role.roleId, roleName: role.name,
      path: `/${enc(role.roleId)}/clubs/${enc(clubRoles.clubId)}/version`,
      body: { requestKey: newCentralCalendarRequestKey(), expectedRevision: role.version ? role.version.revision : null, add, remove, reason },
    };
  }
  let reread = false;
  await runCommand(clubRoles, command, render, {
    check,
    onSaved: (answer) => {
      // A saved write whose read failed (readError) carries no role: the screen reads the club's roles again.
      if (answer?.role) applyCurrentRole(answer.role); else reread = true;
      const role = systemRoleOf(command.roleId);
      clubRoles.draft = role && !reread ? [...role.effectiveItems] : null;
      if (reread) clubRoles.openRoleId = "";
      clubRoles.reason = "";
      clubRoles.notice = `Saved for this club: ${command.roleName}.`;
      clubRoles.noticeTone = "ok";
      const list = Array.isArray(answer?.customsStillHolding) ? answer.customsStillHolding : [];
      // The words the listed customs still hold, in the order they were taken from the role.
      const held = new Set(list.flatMap((c) => c.words || []));
      const words = command.body.remove.filter((w) => held.has(w));
      clubRoles.stillHolding = list.length && words.length ? { roleId: command.roleId, roleName: command.roleName, words, list, truncated: Boolean(answer?.customsStillHoldingTruncated) } : null;
      clubRoles.removalReason = clubRoles.stillHolding ? `Removed from ${command.roleName} in this club` : "";
    },
    onRefused: (info) => {
      applyCurrentRole(info.current);
      clubRoles.notice = layersRefusalText(info);
      clubRoles.noticeTone = "error";
      if (info.code === "notFound") { clubRoles.openRoleId = ""; clubRoles.draft = null; clubRoles.view = null; }
    },
  });
  if (reread) await loadClubRoles(clubRoles.clubId, render);
}

// O3: use the new default (the club's version ends) or keep the club's own.
export async function answerClubRole(roleId, choice, render, { check = false } = {}) {
  if (clubRoles.command?.busy) return;
  let command;
  if (check) {
    if (!clubRoles.command?.unconfirmed || clubRoles.command.kind !== "answer") return;
    command = clubRoles.command;
  } else {
    if (clubRoles.command) return;
    const role = systemRoleOf(roleId);
    if (!role?.question) return;
    command = {
      kind: "answer", roleId, roleName: role.name,
      path: `/${enc(roleId)}/clubs/${enc(clubRoles.clubId)}/version/answer`,
      body: { requestKey: newCentralCalendarRequestKey(), systemRevision: role.question.systemRevision, choice },
    };
  }
  await runCommand(clubRoles, command, render, {
    check,
    onSaved: (answer) => {
      applyCurrentRole(answer?.role);
      const role = systemRoleOf(command.roleId);
      if (clubRoles.openRoleId === command.roleId) clubRoles.draft = role ? [...role.effectiveItems] : null;
      clubRoles.notice = command.body.choice === "accept_default"
        ? `${command.roleName} now follows OptiMove's default in this club.`
        : `${command.roleName} keeps this club's own version.`;
      clubRoles.noticeTone = "ok";
    },
    onRefused: (info) => {
      applyCurrentRole(info.current);
      clubRoles.notice = layersRefusalText(info);
      clubRoles.noticeTone = "error";
    },
  });
}

// Q15, Take it from them too: one request per word, one at a time, over the listed customs that still hold it.
export async function removeFromCustoms(render, { check = false } = {}) {
  if (clubRoles.command?.busy) return;
  const sh = clubRoles.stillHolding;
  let command;
  if (check) {
    if (!clubRoles.command?.unconfirmed || clubRoles.command.kind !== "removal") return;
    command = clubRoles.command;
  } else {
    if (clubRoles.command || !sh?.words?.length || !sh.list.length) return;
    if (!clubRoles.removalReason.trim()) clubRoles.removalReason = `Removed from ${sh.roleName} in this club`;
    const reason = clubRoles.removalReason.trim();
    if (!reason) {
      clubRoles.notice = "Write a reason. It is kept in each person's history.";
      clubRoles.noticeTone = "error";
      render?.();
      return;
    }
    const word = sh.words[0];
    // Only the customs that hold this word (the server refuses one that does not: custom_changed).
    const customIds = sh.list.filter((c) => (c.words || []).includes(word)).map((c) => c.customId);
    if (!customIds.length) {
      clubRoles.stillHolding = sh.words.length > 1 ? { ...sh, words: sh.words.slice(1) } : null;
      return removeFromCustoms(render);
    }
    command = {
      kind: "removal", roleId: sh.roleId, word,
      path: `/${enc(sh.roleId)}/clubs/${enc(clubRoles.clubId)}/custom-word-removal`,
      body: { requestKey: newCentralCalendarRequestKey(), word, customIds, reason },
    };
  }
  await runCommand(clubRoles, command, render, {
    check,
    onSaved: () => {
      const rest = (clubRoles.stillHolding?.words || []).filter((w) => w !== command.word);
      clubRoles.notice = `Taken from them too: ${wordsText([command.word])}.`;
      clubRoles.noticeTone = "ok";
      if (rest.length && clubRoles.stillHolding) clubRoles.stillHolding = { ...clubRoles.stillHolding, words: rest };
      else clubRoles.stillHolding = null;
    },
    onRefused: (info) => {
      clubRoles.notice = layersRefusalText(info);
      clubRoles.noticeTone = "error";
    },
  });
  // The next word goes as its own request, only after this one settled.
  if (!check && !clubRoles.command && clubRoles.stillHolding?.words?.length && clubRoles.noticeTone === "ok") await removeFromCustoms(render);
}

// ---------------------------------------------------------------------------
// Person access (contract 5.4) and drift (5.5), in one club.
// ---------------------------------------------------------------------------
export function emptyPerson() {
  return {
    clubId: "", userId: "", epoch: 0, catalog: null, view: null, loading: false, error: "", editKey: "", draft: null,
    reason: "", command: null, notice: "", noticeTone: "ok", drift: null, driftError: "", endKey: "", endReason: "",
  };
}
export const person = emptyPerson();
let personGeneration = 0;
let driftGeneration = 0;

export function resetPerson() {
  const epoch = person.epoch + 1;
  Object.assign(person, emptyPerson(), { epoch });
  personGeneration += 1;
  driftGeneration += 1;
}

export const holdingKey = (h) => `${h.roleId}|${h.scopeType}|${h.scopeId}`;
export const holdingOf = (key) => (person.view?.holdings || []).find((h) => holdingKey(h) === key) || null;
// What a person's custom starts from or changes: the live custom's items, else the role's items in the club.
export const holdingBase = (h) => (h?.custom?.live ? h.custom.items : h?.roleItems) || [];

// The club's catalog (labels, levels, what the caller holds) and drift, read once per club.
export async function loadPersonClub(clubId, render) {
  if (!clubId) return;
  if (person.clubId !== clubId) {
    if (writeOpen(person)) return;
    const epoch = person.epoch + 1;
    Object.assign(person, emptyPerson(), { clubId, epoch });
  }
  const mine = ++driftGeneration;
  try {
    const [catalog, drift] = await Promise.all([
      api(`${LAYERS_BASE}/catalog?clubId=${enc(clubId)}`),
      api(`${LAYERS_BASE}/clubs/${enc(clubId)}/custom-drift`),
    ]);
    if (mine !== driftGeneration || person.clubId !== clubId) return;
    person.catalog = normalizeCatalog(catalog);
    person.drift = Array.isArray(drift?.customs) ? drift.customs : [];
    person.driftError = "";
  } catch (error) {
    if (mine !== driftGeneration || person.clubId !== clubId) return;
    person.driftError = readErrorText(error, "Access in this club");
  }
  render?.();
}

export async function loadPerson(userId, render, { keepNotice = false } = {}) {
  if (!person.clubId || writeOpen(person)) return;
  const sameView = keepNotice && person.userId === userId;
  person.userId = userId || "";
  if (!sameView) person.view = null;
  person.error = "";
  person.editKey = "";
  person.draft = null;
  if (!keepNotice) person.notice = "";
  person.endKey = "";
  if (!userId) { render?.(); return; }
  const mine = ++personGeneration;
  const clubId = person.clubId;
  person.loading = true;
  render?.();
  try {
    const view = await api(`${LAYERS_BASE}/users/${enc(userId)}/clubs/${enc(clubId)}`);
    if (mine !== personGeneration || person.userId !== userId || person.clubId !== clubId) return;
    person.view = view;
  } catch (error) {
    if (mine !== personGeneration || person.userId !== userId || person.clubId !== clubId) return;
    person.error = Number(error?.status) === 404 ? "This person has no role in this club you can change." : readErrorText(error, "This person's access");
  } finally {
    if (mine === personGeneration && person.userId === userId && person.clubId === clubId) person.loading = false;
  }
  render?.();
}

export function editHolding(key) {
  if (person.command) return;
  const h = holdingOf(key);
  person.editKey = h ? key : "";
  person.draft = h ? [...holdingBase(h)] : null;
  person.reason = "";
  person.notice = "";
  person.endKey = "";
}

export function cancelHoldingEdit() {
  if (writeOpen(person)) return;
  person.editKey = "";
  person.draft = null;
  person.reason = "";
  person.endKey = "";
  person.endReason = "";
}

export function togglePersonWord(word) {
  if (!person.draft || person.command) return;
  person.draft = person.draft.includes(word) ? person.draft.filter((w) => w !== word) : [...person.draft, word];
}

export const personChanges = () => {
  const h = holdingOf(person.editKey);
  return h && person.draft ? itemChanges(holdingBase(h), person.draft) : { add: [], remove: [] };
};

async function rereadPerson(render) {
  const userId = person.userId;
  if (userId) await loadPerson(userId, render, { keepNotice: true });
  await loadPersonClub(person.clubId, render);
}

// Make or change "<Role> (custom)" for this person (O4).
export async function savePersonCustom(render, { check = false } = {}) {
  if (person.command?.busy) return;
  let command;
  if (check) {
    if (!person.command?.unconfirmed || person.command.kind !== "custom") return;
    command = person.command;
  } else {
    if (person.command) return;
    const h = holdingOf(person.editKey);
    if (!h) return;
    const { add, remove } = personChanges();
    if (!add.length && !remove.length) return;
    const reason = person.reason.trim();
    if (!reason) {
      person.notice = "Write a reason. It is kept in this person's history.";
      person.noticeTone = "error";
      render?.();
      return;
    }
    command = {
      kind: "custom", name: person.view?.name || "", roleName: h.roleName,
      path: `/users/${enc(person.userId)}/clubs/${enc(person.clubId)}/custom`,
      body: { requestKey: newCentralCalendarRequestKey(), roleId: h.roleId, scopeType: h.scopeType, scopeId: h.scopeId, expectedRevision: h.custom?.live ? h.custom.revision : null, add, remove, reason },
    };
  }
  await runCommand(person, command, render, {
    check,
    onSaved: () => {
      person.notice = `Saved: ${command.roleName} (custom) for ${command.name || "this person"}.`;
      person.noticeTone = "ok";
      person.editKey = "";
      person.draft = null;
      person.reason = "";
    },
    onRefused: (info) => {
      person.notice = layersRefusalText(info);
      person.noticeTone = "error";
    },
  });
  if (!person.command) await rereadPerson(render);
}

// Back to <Role>: end this person's custom role (the club's role applies again).
export async function endPersonCustom(render, { check = false } = {}) {
  if (person.command?.busy) return;
  let command;
  if (check) {
    if (!person.command?.unconfirmed || person.command.kind !== "end") return;
    command = person.command;
  } else {
    if (person.command) return;
    const h = holdingOf(person.endKey);
    if (!h?.custom?.live) return;
    const reason = person.endReason.trim();
    if (!reason) {
      person.notice = "Write a reason. It is kept in this person's history.";
      person.noticeTone = "error";
      render?.();
      return;
    }
    command = {
      kind: "end", name: person.view?.name || "", roleName: h.roleName,
      path: `/users/${enc(person.userId)}/custom/${enc(h.custom.id)}/end`,
      body: { requestKey: newCentralCalendarRequestKey(), reason },
    };
  }
  await runCommand(person, command, render, {
    check,
    onSaved: () => {
      person.notice = `${command.name || "This person"} is back to ${command.roleName}.`;
      person.noticeTone = "ok";
      person.endKey = "";
      person.endReason = "";
    },
    onRefused: (info) => {
      person.notice = layersRefusalText(info);
      person.noticeTone = "error";
    },
  });
  if (!person.command) await rereadPerson(render);
}

// Drift (5.5): take one word from the listed customs of one role that still hold it.
export async function removeDriftWord(roleId, word, render, { check = false } = {}) {
  if (person.command?.busy) return;
  let command;
  if (check) {
    if (!person.command?.unconfirmed || person.command.kind !== "drift") return;
    command = person.command;
  } else {
    if (person.command) return;
    const customs = (person.drift || []).filter((c) => c.roleId === roleId && c.words.includes(word));
    if (!customs.length) return;
    command = {
      kind: "drift", word,
      path: `/${enc(roleId)}/clubs/${enc(person.clubId)}/custom-word-removal`,
      body: { requestKey: newCentralCalendarRequestKey(), word, customIds: customs.map((c) => c.customId), reason: `Removed from ${customs[0].roleName} in this club` },
    };
  }
  await runCommand(person, command, render, {
    check,
    onSaved: () => {
      person.notice = `Taken from them too: ${wordsText([command.word])}.`;
      person.noticeTone = "ok";
    },
    onRefused: (info) => {
      person.notice = layersRefusalText(info);
      person.noticeTone = "error";
    },
  });
  if (!person.command) await rereadPerson(render);
}
