// The actions of Map by drag and drop (J18; contract sections 3.4-3.8). One
// write at a time; a lost answer is checked by sending the very same request
// again; a generation counter drops an answer for an older view. The screen
// sends identities only: never a value, a unit or an athlete.
import { state } from "./state.js";
import {
  MAX_ROWS, boardContext, boardErrorText, boardState, columnOf, emptyBoardState, endActivation, errorInfo, fetchBoard, fetchBoardTeams, fetchConfirmations,
  fetchPlacement, newRequestKey, newRows, outcomeUnknown, preplacedRows, saveBoard, saveBody, unsavedCount, variableOf,
} from "./metric-board-data.js";

const SWITCH_OFF_REASON = "Switched off on the drag-and-drop board.";
const ask = (text) => (typeof globalThis.confirm === "function" ? globalThis.confirm(text) : true);
const live = (s, generation) => boardState() === s && s.generation === generation;
const focus = (id) => queueMicrotask(() => globalThis.document?.getElementById?.(id)?.focus?.());
const focusFirst = (selector) => queueMicrotask(() => globalThis.document?.querySelector?.(selector)?.focus?.());
const columnSelector = (fieldId) => `[data-action="metric-board-pick"][data-field-id="${String(fieldId).replace(/[^0-9a-f-]/gi, "")}"]`;
const SAVE_BAR = '[data-action="metric-board-review"]';
const clearForms = (s) => Object.assign(s, { placements: {}, preplaced: {}, extra: {}, panel: null, picked: null, review: false, switchOff: null, notice: "" });
// Whether a refusal of a repeated request says the first one was not saved: only a stated 409 of the service
// itself. Signed out, no access, a busy or failed server say nothing about it.
const checkSettles = (info) => info.status === 409 && info.code !== "try_again";
function checkNote(info) {
  if (outcomeUnknown(info)) return "Still no answer. Wait a moment and check again.";
  if (info.status === 401) return "The check could not be done: you are signed out. Sign in again in a new tab, then Check result here.";
  if (info.status === 404) return "The check could not be done: this workspace has no access to it now. The result is still not confirmed.";
  return "The check could not be done. The result is still not confirmed; Check result again in a moment.";
}

export function resetBoard() {
  const generation = (state.trainingLoad.board?.generation || 0) + 1;
  state.trainingLoad.board = { ...emptyBoardState(), generation };
  pendingTeamId = null;
}

// A request to open the board for a team (the setup stepper's "Choose my own").
let pendingTeamId = null;
export function requestBoardOpen({ teamId }) { pendingTeamId = teamId ? String(teamId) : null; }

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
export function boardMayBeLeft() {
  const s = state.trainingLoad.board;
  if (!s) return true;
  if (s.write?.sending) return ask("A change is still being saved. Leave anyway? Its result will not be shown.");
  if (s.write?.unconfirmed) return ask("The result of the last save is not known. Leave without checking? Open the board later to see whether it was saved.");
  const n = unsavedCount(s);
  if (n > 0) return ask(`Discard the ${n} ${n === 1 ? "change" : "changes"} you have not saved?`);
  return true;
}
export function boardUnloadShouldWarn() {
  if (state.activeTab !== "training-load" || state.trainingLoad.section !== "board") return false;
  const s = state.trainingLoad.board;
  return Boolean(s && (s.write?.sending || s.write?.unconfirmed || unsavedCount(s) > 0));
}
// Leaving the board: everything read for it goes (the two athletes' names and values, the last save's notice, the
// history), so the next visit reads it again; an answer still on its way is dropped. The team stays chosen.
export function dropBoardForms() {
  const s = state.trainingLoad.board;
  if (!s) return;
  const { teams, teamId } = s;
  const pending = pendingTeamId;
  resetBoard();
  pendingTeamId = pending;
  Object.assign(boardState(), { teams: teams.loaded && !teams.error ? teams : emptyBoardState().teams, teamId });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function loadBoardSection(render) {
  const ctx = boardContext();
  let s = boardState();
  if (!ctx) { render(); return; }
  if (pendingTeamId) {
    const wanted = pendingTeamId;
    pendingTeamId = null;
    if (wanted !== s.teamId) { resetBoard(); s = boardState(); s.teamId = wanted; }
  }
  const generation = s.generation;
  if (!s.teams.loaded && !s.teams.loading) {
    s.teams = { ...s.teams, loading: true, error: null };
    render();
    try {
      const items = await fetchBoardTeams(ctx.clubId);
      if (!live(s, generation)) return;
      s.teams = { items, loaded: true, loading: false, error: null };
      // One team: no question to ask.
      if (!s.teamId && items.length === 1) s.teamId = items[0].teamId;
    } catch (error) {
      if (!live(s, generation)) return;
      const info = errorInfo(error);
      if (info.status === 404) info.code = "notFound";
      s.teams = { items: [], loaded: true, loading: false, error: info };
    }
    render();
  }
  if (s.teamId && !s.board && !s.loading) await loadBoard(render);
}

async function loadBoard(render, { keepPlacements = false } = {}) {
  const s = boardState();
  const generation = s.generation;
  s.loading = true;
  s.error = null;
  render();
  try {
    const answer = await fetchBoard({ teamId: s.teamId, pair: s.pair });
    if (!live(s, generation)) return false;
    s.board = answer.board;
    s.loading = false;
    if (!keepPlacements) Object.assign(s, { placements: {}, preplaced: {}, extra: {}, panel: null, picked: null, review: false });
    render();
    return true;
  } catch (error) {
    if (!live(s, generation)) return false;
    s.loading = false;
    s.error = errorInfo(error);
    if (s.error.status === 404) s.error.code = "notFound";
    render();
    return false;
  }
}

// After the pair or the board changed: every new placement is read again for
// the pair on screen, loses its tick and reads "Compare again".
async function rereadPlacements(render) {
  const s = boardState();
  const generation = s.generation;
  const board = s.board;
  const stillThis = () => live(s, generation) && s.board === board;
  // The ticks go at once, and the board is held until every placement is read for the pair on screen.
  for (const p of Object.values(s.placements)) s.placements[p.fieldId] = { ...p, checked: false, again: true };
  if (Object.keys(s.placements).length === 0) { render(); return; }
  s.loading = true;
  render();
  try {
    for (const p of Object.values(s.placements)) {
      try {
        const answer = await fetchPlacement({ teamId: s.teamId, candidateId: board.session.candidateId, pair: board.pair.index, fieldId: p.fieldId, targetId: p.targetId });
        if (!stillThis()) return;
        if (s.placements[p.fieldId]) s.placements[p.fieldId] = { ...s.placements[p.fieldId], placement: answer.placement, checked: false, again: true };
      } catch {
        if (!stillThis()) return;
        delete s.placements[p.fieldId];
      }
    }
  } finally {
    if (stillThis()) { s.loading = false; render(); }
  }
}
// Reads the board again and keeps the admin's own rows, each read again for what is on screen now.
async function reloadKeeping(render) {
  const s = boardState();
  const keep = { placements: s.placements, preplaced: s.preplaced, extra: s.extra };
  const ok = await loadBoard(render, { keepPlacements: true });
  if (!ok || boardState() !== s) return ok;
  Object.assign(s, keep);
  await rereadPlacements(render);
  return true;
}

async function loadHistory(render, { more = false } = {}) {
  const s = boardState();
  const generation = s.generation;
  const h = s.history;
  s.history = { ...h, loading: !more, loadingMore: more, error: null };
  render();
  try {
    const answer = await fetchConfirmations({ teamId: s.teamId, cursor: more ? h.nextCursor : undefined });
    if (!live(s, generation)) return;
    s.history = { items: more ? [...h.items, ...answer.confirmations] : answer.confirmations, nextCursor: answer.nextCursor || null, loaded: true, loading: false, loadingMore: false, error: null };
  } catch (error) {
    if (!live(s, generation)) return;
    s.history = { ...h, loading: false, loadingMore: false, loaded: true, error: errorInfo(error) };
  }
  render();
}

// ---------------------------------------------------------------------------
// Placing a column
// ---------------------------------------------------------------------------
async function openPlacement(fieldId, targetId, render) {
  const s = boardState();
  if (s.write || !s.board) return;
  const column = columnOf(s.board, fieldId);
  const variable = variableOf(s.board, targetId);
  if (!column || !variable) return;
  // Dropping onto a variable that already holds a new placement asks first.
  const held = Object.values(s.placements).find((p) => p.targetId === targetId && p.fieldId !== fieldId);
  if (held && !ask(`Replace ${columnOf(s.board, held.fieldId)?.label || "the column"} with ${column.label}?`)) return;
  if (!s.placements[fieldId] && !held && newRows(s).length + preplacedRows(s).length >= MAX_ROWS) {
    s.notice = `A save holds at most ${MAX_ROWS} rows. Save these first.`;
    render();
    return;
  }
  const generation = s.generation;
  s.picked = null;
  s.review = false;
  s.notice = "";
  s.panel = { fieldId, targetId, loading: true, placement: null, error: null };
  s.live = `${column.label} onto ${variable.label}. Reading two athletes.`;
  render();
  focus("mb-panel-title");
  try {
    const answer = await fetchPlacement({ teamId: s.teamId, candidateId: s.board.session.candidateId, pair: s.board.pair.index, fieldId, targetId });
    if (!live(s, generation) || s.panel?.fieldId !== fieldId || s.panel?.targetId !== targetId) return;
    const placement = answer.placement;
    s.panel = { fieldId, targetId, loading: false, placement, error: null };
    if (placement.placeable === true && placement.kind === "preplaced") {
      // OptiMove's own mapping of this column: switched on as it is, no check needed.
      s.extra = { ...(s.extra || {}), [placement.mappingVersionId]: placement };
      s.preplaced = { ...s.preplaced, [placement.mappingVersionId]: { ...(s.preplaced[placement.mappingVersionId] || {}), added: true, removed: false } };
      s.panel = null;
      s.live = `${column.label} fills ${variable.label} through OptiMove's mapping. No check needed.`;
    } else if (placement.placeable === true) {
      if (held) delete s.placements[held.fieldId];
      const before = s.placements[fieldId];
      s.placements[fieldId] = { fieldId, targetId, placement, checked: false, requirement: before?.requirement || "required", fresh: true };
      s.live = `Compare ${column.label} for two athletes.`;
    } else {
      s.live = "This cannot be placed here.";
    }
  } catch (error) {
    if (!live(s, generation)) return;
    const info = errorInfo(error);
    if (info.status === 404) info.code = "notFound";
    s.panel = { fieldId, targetId, loading: false, placement: null, error: info };
  }
  render();
  focus("mb-panel-title");
}

export function dropFieldOnVariable(fieldId, variableId, { render }) {
  return openPlacement(fieldId, variableId, render);
}

// ---------------------------------------------------------------------------
// Saving and switching off
// ---------------------------------------------------------------------------
function savedSummary(s, body) {
  const label = (id, of) => of(s.board, id)?.label || "";
  const rows = body.rows.map((r) => {
    if (r.kind === "new") return { column: label(r.fieldId, columnOf), variable: label(r.targetId, variableOf), checked: true };
    const p = preplacedRows(s).find((x) => x.mappingVersionId === r.mappingVersionId);
    return { column: label(p?.fieldId, columnOf), variable: label(p?.variableId, variableOf), checked: false };
  });
  return { team: s.board.team.name, at: new Date().toISOString(), sessionAt: s.board.session.startedAt, rows, checked: rows.filter((r) => r.checked), plain: rows.filter((r) => !r.checked) };
}

async function send(render) {
  const s = boardState();
  const w = s.write;
  if (!w || w.sending) return;
  const generation = s.generation;
  w.sending = true;
  render();
  try {
    if (w.kind === "save") await saveBoard(w.body);
    else await endActivation(w.activationId, w.body);
    if (!live(s, generation)) return;
    const summary = w.kind === "save" ? w.summary : null;
    s.write = null;
    s.switchOff = null;
    s.saved = summary;
    s.notice = "";
    s.live = summary ? `Saved. Switched on for ${summary.team}.` : "Switched off.";
    s.history = emptyBoardState().history;
    if (summary) {
      // What was saved is no longer the admin's to send: it goes before the board is read again.
      clearForms(s);
      await loadBoard(render);
    } else {
      // A Switch off leaves the admin's unsaved rows where they are.
      s.panel = null;
      s.review = false;
      await reloadKeeping(render);
    }
    focus("mb-outcome");
  } catch (error) {
    if (!live(s, generation)) return;
    const info = errorInfo(error);
    if (outcomeUnknown(info) || (w.checkedOnce && !checkSettles(info))) {
      s.write = { ...w, sending: false, unconfirmed: true, note: w.checkedOnce ? checkNote(info) : "" };
      render();
      focus("mb-outcome");
      return;
    }
    // A stated refusal: nothing was saved.
    s.write = null;
    s.switchOff = null;
    s.review = false;
    if (info.status === 404) info.code = "notFound";
    s.notice = boardErrorText(info);
    await reloadKeeping(render);
    if (!live(s, generation)) return;
    render();
    focus("mb-outcome");
  }
}

function startSave(render) {
  const s = boardState();
  if (s.write || !s.board) return null;
  if (newRows(s).some((p) => !p.checked)) return null;
  if (newRows(s).length + preplacedRows(s).length > MAX_ROWS) return null;
  const body = saveBody(s, newRequestKey());
  if (body.rows.length === 0) return null;
  s.write = { kind: "save", body, summary: savedSummary(s, body), sending: false, unconfirmed: false };
  s.saved = null;
  return send(render);
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------
export async function handleBoardAction(action, { render }) {
  const type = action.dataset.action || "";
  if (!type.startsWith("metric-board-")) return false;
  const s = boardState();
  const act = type.slice("metric-board-".length);
  if (action.getAttribute?.("aria-disabled") === "true" || action.disabled) return true;

  if (act === "team") {
    s.teamId = action.dataset.teamId || null;
    await loadBoard(render);
  } else if (act === "change-team") {
    if (!boardMayBeLeft()) return true;
    const teams = s.teams;
    resetBoard();
    boardState().teams = teams;
    render();
  } else if (act === "reload") {
    if (!s.teams.loaded || s.teams.error) { s.teams = emptyBoardState().teams; await loadBoardSection(render); } else await reloadKeeping(render);
  } else if (act === "tab") {
    const tab = action.dataset.boardTab === "history" ? "history" : "map";
    if (tab === s.tab) return true;
    if (tab === "history" && unsavedCount(s) > 0 && !boardMayBeLeft()) return true;
    if (tab === "history") clearForms(s);
    s.tab = tab;
    render();
    if (tab === "history" && !s.history.loaded) await loadHistory(render);
  } else if (act === "history-reload") {
    await loadHistory(render);
  } else if (act === "history-more") {
    if (s.history.nextCursor && !s.history.loadingMore) await loadHistory(render, { more: true });
  } else if (act === "pick") {
    const fieldId = action.dataset.fieldId || null;
    s.picked = s.picked === fieldId ? null : fieldId;
    s.panel = null;
    s.review = false;
    const column = columnOf(s.board, s.picked);
    s.live = column ? `${column.label} chosen. Choose a variable for it.` : "";
    render();
    if (s.picked) { focus("mb-targets-title"); focusFirst(".mb-slot.is-target .mb-slot-open"); }
  } else if (act === "unpick") {
    const fieldId = s.picked;
    s.picked = null;
    render();
    if (fieldId) focusFirst(columnSelector(fieldId));
  } else if (act === "dismiss") {
    // The backdrop of a phone's sheet: what Escape does.
    closeBoardOverlay(render);
  } else if (act === "place") {
    if (s.picked) await openPlacement(s.picked, action.dataset.variableId, render);
  } else if (act === "compare") {
    const p = s.placements[action.dataset.fieldId];
    if (p) {
      s.review = false;
      s.panel = { fieldId: p.fieldId, targetId: p.targetId, loading: false, placement: p.placement, error: null, fromReview: true };
      s.placements[p.fieldId] = { ...p, fresh: false };
      render();
      focus("mb-panel-title");
    }
  } else if (act === "keep") {
    if (s.panel && s.placements[s.panel.fieldId]) s.placements[s.panel.fieldId].fresh = false;
    s.panel = null;
    render();
    focusFirst(SAVE_BAR);
  } else if (act === "cancel") {
    // Cancel removes this placement; a refusal or an error only closes.
    const fieldId = s.panel?.fieldId;
    if (fieldId && s.panel?.placement?.placeable === true && s.placements[fieldId]) delete s.placements[fieldId];
    s.panel = null;
    render();
    if (fieldId) focusFirst(columnSelector(fieldId));
  } else if (act === "remove") {
    delete s.placements[action.dataset.fieldId];
    if (s.panel?.fieldId === action.dataset.fieldId) s.panel = null;
    render();
  } else if (act === "pre-remove") {
    const id = action.dataset.versionId;
    s.preplaced = { ...s.preplaced, [id]: { ...(s.preplaced[id] || {}), removed: true, added: false } };
    render();
  } else if (act === "pre-add") {
    const id = action.dataset.versionId;
    if (newRows(s).length + preplacedRows(s).length >= MAX_ROWS) s.notice = `A save holds at most ${MAX_ROWS} rows. Save these first.`;
    else s.preplaced = { ...s.preplaced, [id]: { ...(s.preplaced[id] || {}), removed: false, added: true } };
    render();
  } else if (act === "off-add") {
    // A mapping an administrator switched off: placed again by hand, through its own placement.
    const off = (s.board.switchedOff || []).find((x) => x.mappingVersionId === action.dataset.versionId);
    if (off) await openPlacement(off.fieldId, off.variableId, render);
  } else if (act === "other-athletes" || act === "first-athletes") {
    const n = Object.keys(s.placements).length;
    if (act === "other-athletes" && n > 0 && !ask(`Your ${n} ${n === 1 ? "placement" : "placements"} will show two other athletes. Compare each one again in GPEXE.`)) return true;
    s.pair = act === "first-athletes" ? 0 : (s.board?.pair?.index ?? s.pair) + 1;
    s.panel = null;
    s.review = false;
    const before = s.board?.pair?.index ?? 0;
    const ok = await reloadKeeping(render);
    // A failed read leaves the pair that is on record, so Try again reads it and not the next one.
    if (!ok && boardState() === s) s.pair = before;
  } else if (act === "review") {
    s.review = true;
    s.panel = null;
    s.picked = null;
    render();
    focus("mb-review-title");
  } else if (act === "review-close") {
    s.review = false;
    render();
    focusFirst(SAVE_BAR);
  } else if (act === "save") {
    await startSave(render);
  } else if (act === "check-result") {
    if (s.write?.unconfirmed) { s.write.checkedOnce = true; s.write.unconfirmed = false; await send(render); }
  } else if (act === "switch-off-open") {
    const on = (s.board.on || []).find((o) => o.activationId === action.dataset.activationId);
    if (on) s.switchOff = { activationId: on.activationId, variableId: on.variableId, label: `${columnOf(s.board, on.fieldId)?.label || "the column"} → ${variableOf(s.board, on.variableId)?.label || "the variable"}` };
    render();
    focus("mb-switch-off-title");
  } else if (act === "switch-off-cancel") {
    s.switchOff = null;
    render();
  } else if (act === "switch-off") {
    if (s.switchOff && !s.write) {
      s.write = { kind: "switch-off", activationId: s.switchOff.activationId, body: { requestKey: newRequestKey(), expectedState: "open", reason: SWITCH_OFF_REASON }, sending: false, unconfirmed: false };
      s.saved = null;
      await send(render);
    }
  }
  return true;
}

// A checkbox of the panel: the row's own tick, and its requirement.
export function handleBoardInput(target, { render }) {
  const s = state.trainingLoad.board;
  if (!s?.panel || !target?.matches?.("input[type=checkbox]")) return false;
  const p = s.placements[s.panel.fieldId];
  if (!p) return false;
  if (target.matches("[data-mb-tick]")) {
    // A tick is given only here, while the panel shows this row's values for the pair on screen.
    s.placements[p.fieldId] = { ...p, checked: target.checked === true, again: false };
  } else if (target.matches("[data-mb-required]")) {
    s.placements[p.fieldId] = { ...p, requirement: target.checked ? "required" : "optional" };
  } else {
    return false;
  }
  render();
  return true;
}

// Escape closes the open sheet or panel.
export function closeBoardOverlay(render) {
  const s = state.trainingLoad.board;
  if (!s || s.write) return false;
  if (s.switchOff) s.switchOff = null;
  else if (s.review) s.review = false;
  else if (s.panel) { if (s.panel.placement?.placeable === true && s.placements[s.panel.fieldId]?.fresh) delete s.placements[s.panel.fieldId]; s.panel = null; } else if (s.picked) s.picked = null;
  else return false;
  render();
  return true;
}
