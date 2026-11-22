// Settings -> Tags & Presets -> Session types (ST-5; routes of ST-1, backend/src/routes/sessionTypes.js): the list a
// workspace offers, and its writes. A system type is written by a platform admin in the platform workspace, a club's type
// by the club's admin in the club's workspace; the server says which (`canAdd`, `editable`) and decides again on every
// write. Every write carries a requestKey: after a lost answer the same request is sent again and can never write twice.
import { api } from "./api.js";
import { state } from "./state.js";

export const SESSION_TYPE_LABEL_MAX = 60;
const BASE = "/api/training-activity/session-types";

export function sessionTypesState() {
  return state.sessionTypes;
}

export async function loadSessionTypesSettings(render, { force = false } = {}) {
  const st = sessionTypesState();
  if (st.loading) { if (force) st.rereadWanted = true; return; }
  if (st.loaded && !force) return;
  const generation = (st.generation += 1);
  st.loading = true;
  st.error = "";
  render();
  try {
    const answer = await api(BASE);
    if (generation !== st.generation) return;
    st.types = Array.isArray(answer?.types) ? answer.types : [];
    st.canAdd = answer?.canAdd ?? null;
    st.loaded = true;
    st.unavailable = false;
  } catch (error) {
    if (generation !== st.generation) return;
    // An account that may not read the list (the identical 404): the panel is simply not shown.
    if (Number(error?.status) === 404) { st.unavailable = true; st.loaded = true; st.types = []; st.canAdd = null; } else st.error = "The session types could not be read.";
  } finally {
    if (generation === st.generation) {
      st.loading = false;
      const again = st.rereadWanted;
      st.rereadWanted = false;
      if (again) { void loadSessionTypesSettings(render, { force: true }); return; }
      render();
    }
  }
}

const REFUSALS = {
  label_taken: "A session type with this name already exists.",
  label_changed: "Someone changed this name meanwhile. The list shows it as it is now.",
  label_unchanged: "That is already its name.",
  type_archived: "Restore the session type before renaming it.",
  invalid_label: `A name is 1 to ${SESSION_TYPE_LABEL_MAX} characters on one line.`,
  try_again: "The list is being changed right now. Try again in a moment.",
  notFound: "You can't change this session type.",
};

// One write. `write` = { kind: "add" | "rename" | "archive" | "restore", key?, label?, expectedLabel?, requestKey }.
// Outcomes: saved (the list is read again), refused (a sentence; nothing was written), or not confirmed (kept in
// st.unconfirmed; Check result sends the very same request).
export async function sendSessionTypeWrite(write, render) {
  const st = sessionTypesState();
  if (st.sending) return;
  const generation = st.generation;
  st.sending = write;
  st.notice = null;
  st.unconfirmed = null;
  render();
  const path = write.kind === "add" ? BASE : `${BASE}/${encodeURIComponent(write.key)}/${write.kind}`;
  const body = { requestKey: write.requestKey, ...(write.kind === "add" || write.kind === "rename" ? { label: write.label } : {}), ...(write.kind === "rename" ? { expectedLabel: write.expectedLabel } : {}) };
  try {
    const answer = await api(path, { method: "POST", body: JSON.stringify(body) });
    if (generation !== st.generation) return;
    const label = answer?.type?.label ?? write.label ?? "";
    st.notice = { tone: "saved", text: write.kind === "add" ? `Added: ${label}.` : write.kind === "rename" ? `Renamed to ${label}.` : write.kind === "archive" ? `${label} is archived. Sessions that have it keep it; it is no longer offered.` : `${label} is offered again.`,
      // An archive is undone by a restore and the other way round, by the same person, with no reason asked.
      undo: write.kind === "archive" || write.kind === "restore" ? { kind: write.kind === "archive" ? "restore" : "archive", key: write.key } : null };
    st.editing = null;
    if (write.kind === "add") st.newLabel = "";
    // The Imports review reads the list again the next time it needs it.
    if (state.trainingLoad?.gpexe) state.trainingLoad.gpexe.sessionTypes = null;
  } catch (error) {
    if (generation !== st.generation) return;
    const code = typeof error?.data?.error === "string" ? error.data.error : null;
    const status = Number(error?.status) || 0;
    if (code && status >= 400 && status < 500) {
      st.notice = { tone: "refused", text: `${REFUSALS[code] || "The change was refused."} Nothing was saved.`, key: write.key ?? null };
      // The row is no longer what the form was opened on: the form closes and the list shows it as it is now.
      if (code === "label_changed" || code === "type_archived" || code === "notFound") st.editing = null;
    }
    else {
      st.unconfirmed = write;
      st.notice = { tone: "unconfirmed", text: "We can't tell yet whether the change was saved. Check the result; it will not be saved twice." };
    }
  } finally {
    if (generation === st.generation) st.sending = null;
  }
  if (generation !== st.generation) return;
  if (!st.unconfirmed) await loadSessionTypesSettings(render, { force: true });
  else render();
}

// A workspace switch changes whose types are listed: the list is read again, and nothing typed or pending is kept.
export function resetSessionTypesForWorkspaceChange() {
  const st = sessionTypesState();
  Object.assign(st, { loaded: false, loading: false, error: "", unavailable: false, types: [], canAdd: null, newLabel: "", editing: null, sending: null, unconfirmed: null, notice: null, generation: st.generation + 1 });
}

export function newSessionTypeRequestKey() {
  return globalThis.crypto.randomUUID();
}

// A write in flight or not confirmed is the only local view of its outcome.
export function sessionTypesBusy() {
  const st = sessionTypesState();
  return Boolean(st.sending || st.unconfirmed);
}
