// Settings -> Tags & Presets -> Session types (ST-5): events. Every write is sent once, with a requestKey kept for
// Check result; an archive and a restore are saved at once and offer Undo.
import { loadSessionTypesSettings, newSessionTypeRequestKey, sendSessionTypeWrite, sessionTypesBusy, sessionTypesState, SESSION_TYPE_LABEL_MAX } from "./session-types-data.js";

// The typed name: from the field when there is a DOM, otherwise from the state (tests).
function typed(selector, fallback) {
  try {
    const el = globalThis.document?.querySelector?.(selector);
    if (el && typeof el.value === "string") return el.value;
  } catch {
    // no DOM in tests
  }
  return fallback ?? "";
}

function labelProblem(label) {
  if (!label) return "Type a name first.";
  if (label.length > SESSION_TYPE_LABEL_MAX) return `A name is at most ${SESSION_TYPE_LABEL_MAX} characters.`;
  return "";
}

export async function handleSessionTypesAction(action, { render }) {
  const type = action.dataset.action;
  if (!type || !type.startsWith("session-types-")) return false;
  const st = sessionTypesState();
  if (type === "session-types-reload") { await loadSessionTypesSettings(render, { force: true }); return true; }
  if (type === "session-types-check") {
    if (st.unconfirmed && !st.sending) await sendSessionTypeWrite(st.unconfirmed, render);
    return true;
  }
  if (sessionTypesBusy()) return true;
  const row = (key) => (st.types || []).find((t) => t.key === key && t.editable);
  if (type === "session-types-undo") {
    const undo = st.notice?.undo;
    if (undo && row(undo.key)) await sendSessionTypeWrite({ ...undo, label: row(undo.key).label, requestKey: newSessionTypeRequestKey() }, render);
    return true;
  }
  if (type === "session-types-add") {
    if (!st.canAdd) return true;
    const label = typed("[data-session-type-new]", st.newLabel).trim();
    st.newLabel = label;
    const problem = labelProblem(label);
    if (problem) { st.notice = { tone: "refused", text: problem }; render(); return true; }
    await sendSessionTypeWrite({ kind: "add", label, requestKey: newSessionTypeRequestKey() }, render);
    return true;
  }
  if (type === "session-types-rename") {
    const t = row(action.dataset.key);
    if (t?.active) { st.editing = { key: t.key, label: t.label, expectedLabel: t.label }; st.notice = null; render(); }
    return true;
  }
  if (type === "session-types-rename-cancel") { st.editing = null; render(); return true; }
  if (type === "session-types-rename-save") {
    const t = row(st.editing?.key);
    if (!t) return true;
    const label = typed("[data-session-type-rename]", st.editing.label).trim();
    st.editing.label = label;
    const problem = labelProblem(label);
    if (problem) { st.notice = { tone: "refused", text: problem }; render(); return true; }
    if (label === st.editing.expectedLabel) { st.editing = null; render(); return true; }
    await sendSessionTypeWrite({ kind: "rename", key: t.key, label, expectedLabel: st.editing.expectedLabel, requestKey: newSessionTypeRequestKey() }, render);
    return true;
  }
  if (type === "session-types-archive" || type === "session-types-restore") {
    const t = row(action.dataset.key);
    if (!t || t.active !== (type === "session-types-archive")) return true;
    await sendSessionTypeWrite({ kind: type === "session-types-archive" ? "archive" : "restore", key: t.key, label: t.label, requestKey: newSessionTypeRequestKey() }, render);
    return true;
  }
  return true;
}

// Enter in a name field: the form's own button (no page reload).
export async function submitSessionTypesForm(form, { render }) {
  const kind = form?.dataset?.sessionTypesForm;
  if (!kind) return false;
  await handleSessionTypesAction({ dataset: { action: kind === "add" ? "session-types-add" : "session-types-rename-save" } }, { render });
  return true;
}
