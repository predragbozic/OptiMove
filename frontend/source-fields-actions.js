// Training Load -> Data configuration -> Source fields: the reads, the clicks
// and the two acts (phase 6, J4). One act at a time; a save in flight, a
// result not confirmed or a form not saved is asked about before leaving. An
// act whose answer is lost is shown as "Result not confirmed" and checked by
// sending the very same request (the same request key and body) again - the
// server replays a saved act and never saves twice.
import { state } from "./state.js";
import {
  CLOSES_FORM, FIELD_OF_CODE, buildSourceFieldRequest, checkNoteText, checkSettles, emptySourceFieldsState, errorInfo, fetchField,
  fetchFields, meaningActOffered, newRequestKey, openSourceFieldForm, outcomeUnknown, sourceFieldCodeText, sourceFieldsContext,
  sourceFieldsState, unitActOffered, verifyMeaning, verifyUnit,
} from "./source-fields-data.js";

const confirmAsk = (question) => Boolean(globalThis.window?.confirm?.(question));
const focus = (selector) => globalThis.document?.querySelector?.(selector)?.focus?.();

export function resetSourceFields() {
  const generation = (state.trainingLoad.sourceFields?.generation || 0) + 1;
  state.trainingLoad.sourceFields = { ...emptySourceFieldsState(), generation };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const NOT_AVAILABLE = "Source fields are not available in this workspace.";
export async function loadSourceFields(render) {
  const s = sourceFieldsState();
  if (!sourceFieldsContext()) return;
  const list = s.list;
  const generation = s.generation;
  list.loading = true;
  list.error = null;
  render();
  try {
    const data = await fetchFields();
    if (sourceFieldsState().generation !== generation) return;
    list.items = Array.isArray(data?.fields) ? data.fields : [];
    list.loaded = true;
  } catch (error) {
    if (sourceFieldsState().generation !== generation) return;
    const info = errorInfo(error);
    list.error = info.code === "notFound" ? NOT_AVAILABLE
      : info.code === "result_too_large" ? "There are more source fields than this screen shows at once."
      : "The source fields could not be loaded.";
  } finally {
    if (sourceFieldsState().generation === generation) list.loading = false;
  }
  render();
}

export async function loadSourceField(id, render) {
  const s = sourceFieldsState();
  if (!sourceFieldsContext() || !id) return;
  const generation = s.generation;
  const keep = s.detail.id === id ? s.detail.field : null;
  s.detail = { ...s.detail, id, field: keep, verifications: keep ? s.detail.verifications : [], loading: true, error: null };
  render();
  try {
    const data = await fetchField(id);
    if (sourceFieldsState().generation !== generation || s.detail.id !== id) return;
    s.detail.field = data?.field || null;
    s.detail.verifications = Array.isArray(data?.verifications) ? data.verifications : [];
  } catch (error) {
    if (sourceFieldsState().generation !== generation || s.detail.id !== id) return;
    const info = errorInfo(error);
    s.detail.field = info.code === "notFound" ? null : s.detail.field;
    s.detail.error = info.code === "notFound" ? "This field is not available in this workspace, or it is no longer there."
      : "The field could not be loaded.";
  } finally {
    if (sourceFieldsState().generation === generation && s.detail.id === id) s.detail.loading = false;
  }
  render();
}

export function loadSourceFieldsSection(render) {
  const s = sourceFieldsState();
  if (!sourceFieldsContext()) { render(); return Promise.resolve(); }
  if (s.detail.id && !s.form) return loadSourceField(s.detail.id, render);
  if (!s.list.loaded && !s.list.loading) return loadSourceFields(render);
  render();
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
export function sourceFieldsMayBeLeft() {
  const form = state.trainingLoad.sourceFields?.form;
  if (!form) return true;
  if (form.busy) return confirmAsk("A confirmation is still being saved. Leave anyway? Its result will not be shown.");
  if (form.unconfirmed) return confirmAsk("The last confirmation is not confirmed. Leave without checking? Look at the revision later.");
  if (form.dirty) return confirmAsk("Discard the confirmation you have not saved?");
  return true;
}
export function sourceFieldsUnloadShouldWarn() {
  if (state.activeTab !== "training-load" || state.trainingLoad.section !== "source-fields") return false;
  const form = state.trainingLoad.sourceFields?.form;
  return Boolean(form && (form.busy || form.unconfirmed || form.dirty));
}
function leaveForm() {
  if (!sourceFieldsMayBeLeft()) return false;
  sourceFieldsState().form = null;
  return true;
}

// ---------------------------------------------------------------------------
// Clicks (every one named source-fields-*)
// ---------------------------------------------------------------------------
export async function handleSourceFieldsAction(action, { render }) {
  const type = action.dataset.action || "";
  if (!type.startsWith("source-fields-")) return false;
  const s = sourceFieldsState();
  const ctx = sourceFieldsContext();
  if (!ctx) return true;

  if (type === "source-fields-reload") {
    await loadSourceFields(render);
    return true;
  }
  if (type === "source-fields-detail-reload") {
    if (s.detail.id) await loadSourceField(s.detail.id, render);
    return true;
  }
  if (type === "source-fields-open") {
    const id = action.dataset.fieldId || "";
    if (!id || !leaveForm()) return true;
    s.notice = "";
    await loadSourceField(id, render);
    return true;
  }
  if (type === "source-fields-back") {
    if (!leaveForm()) return true;
    s.detail = { ...emptySourceFieldsState().detail };
    s.notice = "";
    if (!s.list.loaded) await loadSourceFields(render); else render();
    return true;
  }
  if (type === "source-fields-cancel") {
    const form = s.form;
    if (!leaveForm()) return true;
    if (form?.unconfirmed) {
      // A confirmation left without a check may still have landed: the field
      // is read again, so the screen never shows it as missing.
      s.notice = "The result was not checked. The field below is as it is saved now.";
      s.list = { ...emptySourceFieldsState().list };
      await loadSourceField(form.fieldId, render);
      return true;
    }
    render();
    return true;
  }
  if (type === "source-fields-check-result") {
    await send(render);
    return true;
  }
  if (type === "source-fields-act-open") {
    // Only what the view offers: the same helpers decide both, so a forged
    // click opens nothing the server would not take.
    if (s.form) return true;
    const field = s.detail.field;
    const revision = (field?.revisions || []).find((r) => r.id === action.dataset.revisionId) || null;
    const act = action.dataset.act === "meaning" ? "meaning" : "unit";
    const offered = act === "unit" ? unitActOffered(ctx, field, revision) : meaningActOffered(ctx, field, revision);
    if (!offered) return true;
    s.notice = "";
    s.form = openSourceFieldForm(act, { field, revision });
    render();
    focus(".source-fields-form [data-sf-field]:not([disabled])");
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Typing: the form's values live in state, so a repaint never loses them.
// ---------------------------------------------------------------------------
export function handleSourceFieldsInput(target) {
  const field = target.closest?.("[data-sf-field]");
  if (!field) return false;
  const form = state.trainingLoad.sourceFields?.form;
  if (!form || form.busy || form.unconfirmed) return true;
  const name = field.dataset.sfField;
  if (!(name in form.draft)) return true;
  form.draft[name] = field.value;
  form.dirty = true;
  if (form.error) {
    form.error = "";
    globalThis.document?.querySelector?.(".source-fields-form > .error")?.remove?.();
  }
  if (form.errors[name]) {
    delete form.errors[name];
    field.removeAttribute?.("aria-invalid");
    globalThis.document?.getElementById?.(`sf-err-${name}`)?.remove?.();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
export async function submitSourceFieldsForm({ render }) {
  const form = sourceFieldsState().form;
  if (!form || form.busy || form.unconfirmed) return;
  const { body, errors } = buildSourceFieldRequest(form);
  form.errors = errors;
  form.error = "";
  if (!body) {
    form.error = "Check the marked fields.";
    render();
    focus('.source-fields-form [aria-invalid="true"]');
    return;
  }
  form.sentBody = body;
  await send(render);
}

async function send(render) {
  const s = sourceFieldsState();
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
    data = await (form.act === "unit" ? verifyUnit : verifyMeaning)(form.fieldId, form.revisionId, form.sentBody);
  } catch (error) {
    if (sourceFieldsState().generation !== generation || s.form !== form) return;
    form.busy = false;
    await refused(form, errorInfo(error), { render, check });
    return;
  }
  if (sourceFieldsState().generation !== generation || s.form !== form) return;
  s.form = null;
  s.notice = form.act === "unit" ? "The unit was confirmed." : "The meaning was confirmed.";
  if (data?.readError) s.notice += " It could not be read back; the field below is read again.";
  s.list = { ...emptySourceFieldsState().list };
  await loadSourceField(form.fieldId, render);
}

async function refused(form, info, { render, check }) {
  const s = sourceFieldsState();
  // A lost answer, or a Check result answered before the server read its
  // request record: what happened to the first act is still not known.
  if (outcomeUnknown(info) || (check && !checkSettles(info))) {
    form.unconfirmed = true;
    form.checkNote = check ? checkNoteText(info) : "";
    render();
    return;
  }
  form.unconfirmed = false;
  form.checkNote = "";
  if (info.code === "request_key_reused") form.requestKey = newRequestKey();
  if (CLOSES_FORM.has(info.code)) {
    // The form was made from a revision that changed: it is closed and the
    // field read again, so the screen shows it as it is now.
    s.form = null;
    s.notice = sourceFieldCodeText(info);
    s.list = { ...emptySourceFieldsState().list };
    await loadSourceField(form.fieldId, render);
    return;
  }
  const field = FIELD_OF_CODE[info.code];
  if (field) form.errors[field] = "The server refused this value.";
  form.error = sourceFieldCodeText(info);
  render();
}
