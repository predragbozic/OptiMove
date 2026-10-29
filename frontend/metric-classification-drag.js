// Training Load -> Data configuration -> Categories: dragging a variable onto
// a category (PR-2, docs/ai/data-configuration-visual-proposal.md section 6).
// A drop sends the existing link create (C4 of J6) with its own request key:
// the same call, the same rules and the same rights as Add to a category. One
// write runs at a time, shared with the screen's forms. A lost answer is
// "Result not confirmed", and Check result sends the very same request again
// (the server replays a saved write and never saves twice). After a drop the
// screen offers Undo for 10 seconds: the existing link remove (C5), with its
// own request key. A drop never removes a link: a variable may sit in several
// categories (O3).
//
// The read of the domains and categories carries no variable's links, so every
// drop is sent: the server answers link_exists for a variable already in that
// category, and the screen says so ("Nothing was changed"). Nothing is
// remembered locally, so a link removed elsewhere is never taken for present.
import { variableDragAvailable, variableDragInProgress } from "./data-config-drag.js";
import { checkNoteText, checkSettles, classificationCodeText, createLink, ownActive, removeLink } from "./metric-classification-data.js";
import { errorInfo, fetchVariables, newRequestKey, outcomeUnknown, variablesContext, variablesState } from "./metric-variables-data.js";
import { state } from "./state.js";

export const UNDO_MS = 10_000;
let undoTimer = null;

// Whether the Categories screen offers the tray and the drop targets: an
// administrator of the workspace (never a team's coach) on a computer.
export function dragOffered(s, ctx) {
  return Boolean(ctx && ctx.view !== "coach" && s.view === "categories" && !s.node && variableDragAvailable());
}

// A drop waits while any write of the screen runs or is not confirmed.
export function dropBlocked() {
  const s = variablesState();
  return Boolean(s.form || s.drop?.busy || s.drop?.unconfirmed);
}

// The categories a variable can be dropped on: this workspace's own active
// ones (O4: a link stays inside its owner; an archived one takes no link).
export const dropTargets = (tree, ctx) => ownActive(tree, "category", ctx);

// ---------------------------------------------------------------------------
// The tray: this workspace's own active variables, the first page of the
// default list (100), read once when the Categories screen opens.
// ---------------------------------------------------------------------------
export function emptyTray() {
  return { items: [], more: false, loaded: false, loading: false, error: null };
}
export async function loadTray(render) {
  const s = variablesState();
  if (!variablesContext()) return;
  if (!s.tray) s.tray = emptyTray();
  const tray = s.tray;
  if (tray.loading) return;
  const generation = s.generation;
  tray.loading = true;
  tray.error = null;
  render();
  try {
    const data = await fetchVariables({ scope: "own", stateFilter: "active" });
    if (variablesState().generation !== generation || s.tray !== tray) return;
    tray.items = data?.variables || [];
    tray.more = Boolean(data?.nextCursor);
    tray.loaded = true;
  } catch {
    if (variablesState().generation !== generation || s.tray !== tray) return;
    tray.error = "The variables could not be loaded.";
  } finally {
    if (variablesState().generation === generation && s.tray === tray) tray.loading = false;
  }
  render();
}

// Read when the Categories screen opens on a computer (once per opening).
export function ensureTray(render) {
  setDropRender(render);
  const s = variablesState();
  if (!dragOffered(s, variablesContext())) return Promise.resolve();
  if (s.tray && (s.tray.loaded || s.tray.loading)) return Promise.resolve();
  return loadTray(render);
}

function clearUndoTimer() {
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null;
}
// A saved link changes what the list's category filter counts: the list is
// read again when it is next shown.
function listStale(s) {
  s.list = { ...s.list, items: [], nextCursor: null, loaded: false };
}

// ---------------------------------------------------------------------------
// The drop
// ---------------------------------------------------------------------------
// The screen is drawn anew on every step of a drop; the list of variables in
// the tray keeps where it was scrolled, so the next variable stays in reach.
function keepingTrayScroll(render) {
  return () => {
    const top = globalThis.document?.querySelector?.(".dc-tray-list")?.scrollTop || 0;
    render();
    const list = globalThis.document?.querySelector?.(".dc-tray-list");
    if (list && top) list.scrollTop = top;
  };
}

export async function dropVariableOnCategory(variableId, categoryId, { render: draw }) {
  const render = keepingTrayScroll(draw);
  const s = variablesState();
  const ctx = variablesContext();
  if (!dragOffered(s, ctx) || dropBlocked()) return;
  const variable = (s.tray?.items || []).find((item) => item.id === variableId);
  const category = dropTargets(s.classification.tree, ctx).find((node) => node.id === categoryId);
  if (!variable || !category) return;
  clearUndoTimer();
  // A name the server shortened keeps its mark, as in the lists.
  const names = {
    variableId, categoryId,
    variableLabel: `${variable.label || ""}${variable.truncated ? "…" : ""}`,
    categoryName: `${category.name || ""}${category.truncated ? "…" : ""}`,
  };
  const requestKey = newRequestKey();
  s.notice = "";
  s.drop = { ...names, phase: "link", body: { requestKey, variableId, categoryId }, busy: true, unconfirmed: false };
  render();
  await sendDrop({ render });
}

// The undo of the last saved drop, while its 10 seconds last.
export async function undoDrop({ render: draw }) {
  const render = keepingTrayScroll(draw);
  const s = variablesState();
  const drop = s.drop;
  if (!drop || drop.phase !== "done" || !drop.linkId || Date.now() > drop.undoUntil || dropBlocked()) return;
  clearUndoTimer();
  s.drop = { ...drop, phase: "undo", body: { requestKey: newRequestKey() }, busy: true, unconfirmed: false };
  render();
  await sendDrop({ render });
}

// Check result: the very same request again.
export async function checkDrop({ render: draw }) {
  const render = keepingTrayScroll(draw);
  const drop = variablesState().drop;
  if (!drop?.unconfirmed || drop.busy) return;
  drop.busy = true;
  render();
  await sendDrop({ render, check: true });
}

// Closing a result that was not checked: what the screen shows is read again
// where it can change (the list), and the line in the tray names the result as
// unknown (phase "unchecked"; nothing is pending any more).
export function dismissDrop({ render: draw }) {
  const render = keepingTrayScroll(draw);
  const s = variablesState();
  const drop = s.drop;
  if (!drop || drop.busy) return;
  clearUndoTimer();
  if (drop.unconfirmed) {
    listStale(s);
    s.drop = { variableId: drop.variableId, categoryId: drop.categoryId, variableLabel: drop.variableLabel, categoryName: drop.categoryName, phase: "unchecked" };
  } else {
    s.drop = null;
  }
  render();
}

async function sendDrop({ render, check = false }) {
  const s = variablesState();
  const drop = s.drop;
  if (!drop?.body) return;
  const generation = s.generation;
  let data;
  try {
    data = drop.phase === "undo" ? await removeLink(drop.linkId, drop.body) : await createLink(drop.body);
  } catch (error) {
    if (variablesState().generation !== generation || s.drop !== drop) return;
    drop.busy = false;
    refusedDrop(s, drop, errorInfo(error), { check });
    render();
    return;
  }
  if (variablesState().generation !== generation || s.drop !== drop) return;
  savedDrop(s, drop, data);
  render();
}

function savedDrop(s, drop, data) {
  listStale(s);
  if (drop.phase === "undo") {
    s.drop = { variableId: drop.variableId, categoryId: drop.categoryId, variableLabel: drop.variableLabel, categoryName: drop.categoryName, phase: "undone" };
    return;
  }
  const linkId = data?.link?.id || null;
  s.drop = {
    variableId: drop.variableId, categoryId: drop.categoryId, variableLabel: drop.variableLabel, categoryName: drop.categoryName,
    phase: "done", linkId, undoUntil: Date.now() + UNDO_MS,
  };
  // Undo is offered only while it lasts; the screen is drawn again when it ends,
  // but not under a drag of the next variable (that would take its marks away):
  // then once the drag is over. Undo itself is refused from the 10 seconds on.
  if (linkId) {
    const expire = () => {
      undoTimer = null;
      const now = variablesState().drop;
      if (now?.phase !== "done" || now.linkId !== linkId) return;
      now.undoUntil = 0;
      if (variableDragInProgress()) {
        undoTimer = setTimeout(expire, 500);
        return;
      }
      if (boardShown() && dropRender) keepingTrayScroll(dropRender)();
    };
    undoTimer = setTimeout(expire, UNDO_MS);
  }
}

function refusedDrop(s, drop, info, { check }) {
  // A lost answer, or a Check result answered before the server read its
  // request record: what happened to the first write is still not known.
  if (outcomeUnknown(info) || (check && !checkSettles(info))) {
    drop.unconfirmed = true;
    drop.checkNote = check ? checkNoteText(info) : "";
    return;
  }
  drop.unconfirmed = false;
  drop.checkNote = "";
  if (drop.phase === "link" && info.code === "link_exists") {
    s.drop = { ...drop, phase: "already", body: null };
    return;
  }
  // A refusal is a warning and changes nothing on the screen.
  const undo = drop.phase === "undo";
  s.drop = { ...drop, phase: undo ? "undo-refused" : "refused", body: null, text: classificationCodeText(info, undo ? "link-remove" : "variable-link") };
}

// Whether the board is what the screen shows now: the end of Undo draws the
// screen again only then, never over a form being typed in or another tab.
function boardShown() {
  const s = variablesState();
  return state.activeTab === "training-load" && state.trainingLoad.section === "variables" && !s.form && dragOffered(s, variablesContext());
}

// The render the undo timer uses: set by the screen when it draws the tray.
let dropRender = null;
export function setDropRender(render) {
  dropRender = render;
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
// A drop in flight or not confirmed: true when it asks (the caller asks the
// coach); false when there is nothing to ask about.
export function dropNeedsAsk() {
  const drop = variablesState().drop;
  return Boolean(drop && (drop.busy || drop.unconfirmed));
}
export function dropLeaveQuestion() {
  const drop = variablesState().drop || {};
  const x = drop.variableLabel || "The variable";
  const y = drop.categoryName || "the category";
  const undo = drop.phase === "undo";
  if (drop.busy) {
    return undo
      ? `${x} is still being removed from ${y}. Leave anyway? You will not see whether it was removed.`
      : `${x} is still being added to ${y}. Leave anyway? You will not see whether it was added.`;
  }
  return `It is not confirmed whether ${x} was ${undo ? "removed from" : "added to"} ${y}. Leave without checking? Open ${x} under Variables later to see its categories.`;
}
// Leaving the screen ends the drop's status and its undo. A drop left in
// flight or not confirmed may have been saved: the list is read again.
export function discardDrop() {
  clearUndoTimer();
  const s = variablesState();
  if (s.drop?.busy || s.drop?.unconfirmed) listStale(s);
  s.drop = null;
}
