// P4b (owner 2026-11-13, the coach prototype): "Later" puts a Ready session aside on this device only. Nothing is sent and
// nothing is stored on the server: the session stays Ready for every other person and device. It is kept in
// localStorage per sign-in and team; a session that changes comes back by itself (a new version is a new candidate).
// Storage can be missing or refused (a private window, blocked site data): then "Later" lasts until the page reloads.
import { state } from "./state.js";

const g = () => state.trainingLoad.gpexe;
const PREFIX = "optimove.imports.later";
// A bound on what one sign-in keeps for one team; the oldest go first.
export const LATER_MAX = 200;

function storageKey(gx = g()) {
  const user = state.currentUser?.id;
  return user && gx?.teamId ? `${PREFIX}.${user}.${gx.teamId}` : "";
}

function readStored(key) {
  if (!key) return [];
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id.length <= 100) : [];
  } catch {
    return [];
  }
}

function writeStored(key, ids) {
  if (!key) return;
  try {
    if (ids.length) globalThis.localStorage?.setItem(key, JSON.stringify(ids));
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Not stored: "Later" lasts until the page reloads.
  }
}

// The ids put aside for this sign-in and team, read from storage once per team (and again after a team change).
function laterList(gx = g()) {
  const key = storageKey(gx);
  if (!gx.later || gx.later.key !== key) gx.later = { key, ids: readStored(key), notice: "", open: false };
  return gx.later;
}

export function isLater(c, gx = g()) {
  return Boolean(c?.id) && laterList(gx).ids.includes(c.id);
}

// "Later": aside on this device; out of the batch selection as well (Import N ready sessions never takes it).
export function putLater(id, gx = g()) {
  if (typeof id !== "string" || !id) return false;
  const l = laterList(gx);
  if (l.ids.includes(id)) return false;
  l.ids = [...l.ids, id].slice(-LATER_MAX);
  l.notice = id;
  if (gx.batch?.selected && Object.hasOwn(gx.batch.selected, id)) delete gx.batch.selected[id];
  writeStored(l.key, l.ids);
  return true;
}

// "Bring back" (and Undo right after "Later").
export function bringBack(id, gx = g()) {
  const l = laterList(gx);
  if (!l.ids.includes(id)) return false;
  l.ids = l.ids.filter((x) => x !== id);
  if (l.notice === id) l.notice = "";
  writeStored(l.key, l.ids);
  return true;
}

export function laterNotice(gx = g()) {
  return laterList(gx).notice;
}

export function clearLaterNotice(gx = g()) {
  laterList(gx).notice = "";
}

export function laterOpen(gx = g()) {
  return laterList(gx).open;
}

export function setLaterOpen(open, gx = g()) {
  laterList(gx).open = Boolean(open);
}

// After the list is read: ids of sessions that are gone or no longer Ready are forgotten, so storage never grows
// with sessions nobody will see again. `stillReady(id)` says whether a listed session is still Ready.
export function pruneLater(stillReady, gx = g()) {
  const l = laterList(gx);
  const kept = l.ids.filter((id) => stillReady(id));
  if (kept.length === l.ids.length) return;
  l.ids = kept;
  if (l.notice && !kept.includes(l.notice)) l.notice = "";
  writeStored(l.key, kept);
}
