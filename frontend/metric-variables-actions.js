// Training Load -> Data configuration -> Variables: loading, the forms and the
// writes (create and new version, M3-0; rename, archive and restore, R2). One
// write at a time; a write whose answer is lost is shown as "Result not
// confirmed" and checked by sending the very same request (the same request
// key and body) again - the server replays a saved write and never saves twice.
import { state } from "./state.js";
import {
  CHANGE_MODES, archiveVariable, buildRequest, checkNoteText, checkSettles, codeText, createVariable, createVersion, emptyVariablesState,
  errorInfo, fetchKeySuggestion, fetchVariable, fetchVariables, newRequestKey, openForm, outcomeUnknown, rebaseRename, renameVariable,
  replaceName, restoreVariable, variablesContext, variablesState,
} from "./metric-variables-data.js";

export const KEY_SUGGESTION_DELAY_MS = 350;
let keyTimer = null;

const confirmAsk = (question) => Boolean(globalThis.window?.confirm?.(question));

// A fresh, empty screen (a workspace switch, signing out): an answer still in
// flight for the old view is dropped by the generation it carries.
export function resetVariables() {
  const generation = (state.trainingLoad.variables?.generation || 0) + 1;
  clearTimeout(keyTimer);
  state.trainingLoad.variables = { ...emptyVariablesState(), generation };
}

// The list, from the first page (or the next one with `more`).
export async function loadVariables(render, { more = false } = {}) {
  const s = variablesState();
  if (!variablesContext()) return;
  const list = s.list;
  if (more && (!list.nextCursor || list.loadingMore)) return;
  const generation = s.generation;
  const query = { scope: s.scope, stateFilter: s.stateFilter, cursor: more ? list.nextCursor : null };
  if (more) list.loadingMore = true; else { list.loading = true; list.error = null; }
  render();
  try {
    const data = await fetchVariables(query);
    if (variablesState().generation !== generation || s.scope !== query.scope || s.stateFilter !== query.stateFilter) return;
    list.items = more ? [...list.items, ...(data.variables || [])] : data.variables || [];
    list.nextCursor = data.nextCursor || null;
    list.loaded = true;
    list.error = null;
  } catch (error) {
    if (variablesState().generation !== generation) return;
    const info = errorInfo(error);
    list.error = info.code === "notFound" ? codeText(info) : "The variables could not be loaded.";
    if (!more) list.loaded = false;
  } finally {
    if (variablesState().generation === generation) { list.loading = false; list.loadingMore = false; }
  }
  render();
}

// One variable with its newest versions (or the next, older page).
export async function loadVariable(id, render, { more = false } = {}) {
  const s = variablesState();
  const d = s.detail;
  if (more && (!d.nextCursor || d.loadingMore || d.id !== id)) return;
  const generation = s.generation;
  if (!more) {
    if (d.id !== id) Object.assign(d, { id, variable: null, nextCursor: null });
    d.loading = true;
    d.error = null;
  } else d.loadingMore = true;
  render();
  try {
    const data = await fetchVariable(id, more ? d.nextCursor : null);
    if (variablesState().generation !== generation || d.id !== id) return;
    const variable = data.variable || null;
    if (more && d.variable && variable) d.variable = { ...variable, versions: [...(d.variable.versions || []), ...(variable.versions || [])] };
    else d.variable = variable;
    d.nextCursor = data.nextCursor || null;
  } catch (error) {
    if (variablesState().generation !== generation || d.id !== id) return;
    const info = errorInfo(error);
    d.error = info.code === "notFound" ? "This variable is not available in this workspace." : "The variable could not be loaded.";
  } finally {
    if (variablesState().generation === generation && d.id === id) { d.loading = false; d.loadingMore = false; }
  }
  render();
}

// Entering the screen: the list is read when it is not there yet.
export function loadVariablesSection(render) {
  const s = variablesState();
  if (!variablesContext()) { render(); return Promise.resolve(); }
  if (s.detail.id && !s.form) return loadVariable(s.detail.id, render);
  if (!s.list.loaded && !s.list.loading) return loadVariables(render);
  render();
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Leaving: a save in flight, an unconfirmed result or unsaved form values are
// asked about first.
// ---------------------------------------------------------------------------
export function variablesMayBeLeft() {
  const form = state.trainingLoad.variables?.form;
  if (!form) return true;
  if (form.busy) return confirmAsk("A variable is still being saved. Leave anyway? Its result will not be shown.");
  if (form.unconfirmed) return confirmAsk("The last save is not confirmed. Leave without checking? Look for it in the list later.");
  if (form.dirty) return confirmAsk(DISCARD_QUESTION[form.mode] || "Discard the variable you have not saved?");
  return true;
}
const DISCARD_QUESTION = {
  version: "Discard the new version you have not saved?",
  rename: "Discard the new names you have not saved?",
  archive: "Discard the archive you have not confirmed?",
  restore: "Discard the restore you have not confirmed?",
};
// Closing or reloading the page while a save is in flight or not confirmed
// loses the only view of its outcome; unsaved values are lost too.
export function variablesUnloadShouldWarn() {
  if (state.activeTab !== "training-load" || state.trainingLoad.section !== "variables") return false;
  const form = state.trainingLoad.variables?.form;
  return Boolean(form && (form.busy || form.unconfirmed || form.dirty));
}
function leaveForm() {
  if (!variablesMayBeLeft()) return false;
  clearTimeout(keyTimer);
  variablesState().form = null;
  return true;
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------
export async function handleVariablesAction(action, { render }) {
  const type = action.dataset.action || "";
  if (!type.startsWith("metric-variables-")) return false;
  const s = variablesState();

  if (type === "metric-variables-create-open") {
    if (s.form) return true;
    s.notice = "";
    s.form = openForm("create");
    render();
    focusFirstField();
    return true;
  }
  if (type === "metric-variables-version-open") {
    if (s.form || !s.detail.variable) return true;
    s.notice = "";
    s.form = openForm("version", { variable: s.detail.variable });
    render();
    focusFirstField();
    return true;
  }
  // R2: offered only where the server's `actions` names it (J3b.2).
  const change = { "metric-variables-rename-open": "rename", "metric-variables-archive-open": "archive", "metric-variables-restore-open": "restore" }[type];
  if (change) {
    const variable = s.detail.variable;
    if (s.form || !variable || !(variable.actions || []).includes(change)) return true;
    s.notice = "";
    s.form = openForm(change, { variable });
    render();
    focusFirstField();
    return true;
  }
  if (type === "metric-variables-name-replace") {
    const form = s.form;
    const field = action.dataset.mvName || "";
    if (!form || form.busy || form.unconfirmed || !replaceName(form, field)) return true;
    render();
    globalThis.document?.querySelector?.(`.metric-variables-form [data-mv-field="${field}"]`)?.focus?.();
    return true;
  }
  if (type === "metric-variables-cancel") {
    const form = s.form;
    if (!leaveForm()) return true;
    // A save left without a check may still have landed: the list (or the
    // variable) is read again, so the screen never shows it as missing.
    if (form?.unconfirmed) {
      if (CHANGE_MODES.includes(form.mode) && form.variableId) {
        s.notice = "The result was not checked. The variable below is as it is saved now.";
        await loadVariable(form.variableId, render);
      } else if (form.mode === "version" && form.variableId) {
        s.notice = "The result was not checked. If the new version was saved, it is in the versions below.";
        await loadVariable(form.variableId, render);
      } else {
        s.notice = "The result was not checked. If the variable was saved, it is in the list below.";
        s.list = { ...emptyVariablesState().list };
        await loadVariables(render);
      }
      return true;
    }
    // Someone saved other names meanwhile: the variable behind the form is
    // read again, so it never shows the names that are no longer saved.
    if (form?.conflict && form.variableId) {
      await loadVariable(form.variableId, render);
      return true;
    }
    render();
    return true;
  }
  if (type === "metric-variables-back") {
    if (!leaveForm()) return true;
    s.detail = { ...emptyVariablesState().detail };
    s.notice = "";
    if (!s.list.loaded) await loadVariables(render); else render();
    return true;
  }
  if (type === "metric-variables-open") {
    const id = action.dataset.variableId || "";
    if (!id || !leaveForm()) return true;
    s.notice = "";
    await loadVariable(id, render);
    return true;
  }
  if (type === "metric-variables-scope") {
    const scope = action.dataset.scope === "system" ? "system" : "own";
    if (scope === s.scope) return true;
    if (!leaveForm()) return true;
    s.scope = scope;
    s.notice = "";
    s.list = { ...emptyVariablesState().list };
    await loadVariables(render);
    return true;
  }
  if (type === "metric-variables-reload") {
    await loadVariables(render);
    return true;
  }
  if (type === "metric-variables-more") {
    await loadVariables(render, { more: true });
    return true;
  }
  if (type === "metric-variables-more-versions") {
    if (s.detail.id) await loadVariable(s.detail.id, render, { more: true });
    return true;
  }
  if (type === "metric-variables-check-result") {
    await send(render);
    return true;
  }
  return true;
}

function focusFirstField() {
  globalThis.document?.querySelector?.(".metric-variables-form [data-mv-field]:not([disabled])")?.focus?.();
}

// ---------------------------------------------------------------------------
// Typing: the form's values live in state, so a repaint never loses them.
// ---------------------------------------------------------------------------
export function handleVariablesInput(target, { render }) {
  const s = state.trainingLoad.variables;
  if (!s) return false;
  const filter = target.closest?.("[data-metric-variables-filter]");
  if (filter) {
    if (filter.value === s.stateFilter) return true;
    if (!leaveForm()) { filter.value = s.stateFilter; return true; }
    s.stateFilter = ["active", "archived", "all"].includes(filter.value) ? filter.value : "active";
    s.list = { ...emptyVariablesState().list };
    void loadVariables(render);
    return true;
  }
  const form = s.form;
  if (!form || form.busy || form.unconfirmed) return Boolean(target.closest?.(".metric-variables-form"));
  const level = target.closest?.("[data-mv-level]");
  if (level) {
    const value = level.dataset.mvLevel;
    const set = new Set(form.draft.levels);
    if (level.checked) set.add(value); else set.delete(value);
    form.draft.levels = [...set];
    form.dirty = true;
    delete form.errors.levels;
    globalThis.document?.getElementById?.("mv-err-levels")?.remove?.();
    clearFormError(form);
    return true;
  }
  const field = target.closest?.("[data-mv-field]");
  if (!field) return false;
  const name = field.dataset.mvField;
  if (!(name in form.draft)) return true;
  form.draft[name] = field.value;
  form.dirty = true;
  clearFormError(form);
  if (form.errors[name]) {
    delete form.errors[name];
    field.removeAttribute?.("aria-invalid");
    globalThis.document?.getElementById?.(`mv-err-${name}`)?.remove?.();
  }
  // A choice that changes which fields exist repaints the form.
  if (field.hasAttribute?.("data-mv-structural")) {
    render();
    globalThis.document?.querySelector?.(`.metric-variables-form [data-mv-field="${name}"]`)?.focus?.();
  }
  if (name === "label" && form.mode === "create") scheduleKeySuggestion(form);
  return true;
}

// A changed value answers the form-level message ("Check the marked fields.",
// a refusal): it is not shown against values it no longer describes.
function clearFormError(form) {
  if (!form.error) return;
  form.error = "";
  globalThis.document?.querySelector?.(".metric-variables-form > .error")?.remove?.();
}

// The key the name makes, from the server's own rule (C84), a moment after
// typing stops; shown under Technical details.
function scheduleKeySuggestion(form) {
  clearTimeout(keyTimer);
  const label = form.draft.label.replace(/\s+/g, " ").trim();
  if (!label) {
    form.keyHint = { key: "", taken: false, required: false, loading: false, label: "" };
    paintKeyHint(form);
    return;
  }
  keyTimer = setTimeout(async () => {
    const s = variablesState();
    // A sent form (saving, or its result not confirmed) is locked: a hint now
    // could describe the key of the very variable just saved as "already used".
    if (s.form !== form || form.busy || form.unconfirmed) return;
    form.keyHint = { ...form.keyHint, loading: true, label };
    paintKeyHint(form);
    let hint;
    try {
      const data = await fetchKeySuggestion(label);
      hint = { key: data.key || "", taken: data.taken === true, required: false, loading: false, label };
    } catch (error) {
      const info = errorInfo(error);
      hint = { key: "", taken: false, required: info.code === "key_required", loading: false, label };
    }
    // Only the answer for what the field holds now, in the same open form,
    // and never once that form was sent.
    if (variablesState().form !== form || form.busy || form.unconfirmed || form.draft.label.replace(/\s+/g, " ").trim() !== label) return;
    form.keyHint = hint;
    paintKeyHint(form);
  }, KEY_SUGGESTION_DELAY_MS);
}

function paintKeyHint(form) {
  const node = globalThis.document?.querySelector?.("[data-mv-key-hint]");
  if (!node) return;
  const h = form.keyHint;
  node.textContent = h.loading ? "Making the key..." : h.required ? "No key can be made from this name (a key uses only the letters a-z, digits and underscores): enter one below."
    : h.key ? `Key: ${h.key}${h.taken ? " - already used here; enter another key below." : ""}` : "The key is made from the name.";
  if ((h.required || h.taken) && node.closest?.("details")) node.closest("details").open = true;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
export async function submitVariablesForm(_formElement, { render }) {
  const s = variablesState();
  const form = s.form;
  if (!form || form.busy || form.unconfirmed) return;
  const { body, errors, unchanged } = buildRequest(form);
  form.errors = errors;
  form.error = "";
  if (unchanged) {
    form.error = "Nothing changed: change a name, or Cancel.";
    render();
    return;
  }
  if (!body) {
    form.error = "Check the marked fields.";
    render();
    globalThis.document?.querySelector?.('.metric-variables-form [aria-invalid="true"]')?.focus?.();
    return;
  }
  // A suggestion read still in flight is dropped when it answers; its
  // "Making the key..." goes now, so an unlocked form never keeps it.
  clearTimeout(keyTimer);
  if (form.keyHint?.loading) form.keyHint = { ...form.keyHint, loading: false };
  form.sentBody = body;
  await send(render);
}

const WRITES = {
  create: (form) => createVariable(form.sentBody),
  version: (form) => createVersion(form.variableId, form.sentBody),
  rename: (form) => renameVariable(form.variableId, form.sentBody),
  archive: (form) => archiveVariable(form.variableId, form.sentBody),
  restore: (form) => restoreVariable(form.variableId, form.sentBody),
};

async function send(render) {
  const s = variablesState();
  const form = s.form;
  if (!form || form.busy || !form.sentBody) return;
  const generation = s.generation;
  // A Check result: the same request again, after an answer that was lost.
  const check = form.unconfirmed;
  form.busy = true;
  form.error = "";
  render();
  let data;
  try {
    data = await WRITES[form.mode](form);
  } catch (error) {
    if (variablesState().generation !== generation || s.form !== form) return;
    form.busy = false;
    refused(form, errorInfo(error), render, { check });
    return;
  }
  if (variablesState().generation !== generation || s.form !== form) return;
  await saved(form, data, render);
}

function refused(form, info, render, { check = false } = {}) {
  const s = variablesState();
  // A lost answer, or a Check result answered before the server read its
  // request record: what happened to the first write is still not known, so
  // nothing here may say "Nothing was saved" or unlock the form.
  if (outcomeUnknown(info) || (check && !checkSettles(info))) {
    form.unconfirmed = true;
    form.checkNote = check ? checkNoteText(info) : "";
    render();
    return;
  }
  form.unconfirmed = false;
  form.checkNote = "";
  if (info.code === "invalid_unit") form.errors.unit = codeText(info);
  else if (info.code === "invalid_condition") form.errors.conditionKind = codeText(info);
  else if (info.code === "key_required" || info.code === "key_taken") {
    form.errors.key = codeText(info);
    form.keyHint = { ...form.keyHint, required: info.code === "key_required", taken: info.code === "key_taken" };
  } else if (info.code === "request_key_reused") form.requestKey = newRequestKey();
  // Other names were saved meanwhile: the form stays open on them, with the
  // coach's own changes kept, and asks to save again (J3b.2).
  if (info.code === "variable_changed" && rebaseRename(form, info.current)) {
    form.dirty = true;
    render();
    // The Save button that had the focus is gone: the focus goes to the
    // explanation (not to a field, which would open a phone's keyboard).
    const box = globalThis.document?.querySelector?.(".metric-variables-conflict");
    box?.focus?.({ preventScroll: true });
    box?.scrollIntoView?.({ block: "nearest" });
    return;
  }
  if (info.code === "current_version_changed" || (CHANGE_MODES.includes(form.mode) && CLOSES_CHANGE.has(info.code))) {
    // The form was made from a variable that changed (a newer version, other
    // names, another state) or that this change no longer fits: it is closed
    // and the variable read again, so the coach starts from how it is now.
    const id = form.variableId;
    s.form = null;
    s.notice = codeText(info, form.mode);
    void loadVariable(id, render);
    return;
  }
  form.error = codeText(info, form.mode);
  render();
}
const CLOSES_CHANGE = new Set(["variable_changed", "variable_not_active", "variable_active", "variable_pinned", "restore_by_admin"]);

async function saved(form, data, render) {
  const s = variablesState();
  s.form = null;
  s.list = { ...emptyVariablesState().list };
  const variable = data?.variable || null;
  const id = variable?.id || data?.variableId || form.variableId;
  if (form.mode === "create") {
    s.notice = data?.readError ? "The variable was created, but it could not be read back. Open it from the list." : `The variable ${variable?.label || ""} was created.`;
  } else if (CHANGE_MODES.includes(form.mode)) {
    const done = { rename: "renamed", archive: "archived", restore: "restored" }[form.mode];
    s.notice = data?.readError ? `The variable was ${done}, but it could not be read back. Open it again from the list.` : `The variable was ${done}.`;
  } else {
    const number = data?.version?.versionNumber ?? variable?.currentVersion?.versionNumber;
    s.notice = data?.readError ? "The new version was saved, but it could not be read back. Open the variable again." : `Version ${number ?? ""} was saved.`;
  }
  if (id) await loadVariable(id, render);
  else await loadVariables(render);
}
