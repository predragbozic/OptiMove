// Training Load -> Data configuration -> Source fields: the reads, the clicks
// and the two acts (phase 6, J4). One act at a time; a save in flight, a
// result not confirmed or a form not saved is asked about before leaving. An
// act whose answer is lost is shown as "Result not confirmed" and checked by
// sending the very same request (the same request key and body) again - the
// server replays a saved act and never saves twice.
import { state } from "./state.js";
import {
  CLOSES_FORM, createNextStep, FIELD_OF_CODE, buildSourceFieldRequest, checkNoteText, checkSettles, confirmQuestion, createOffered, createSourceField,
  emptyInventory, emptySourceFieldsState, errorInfo, fetchField, openCreateFieldForm,
  confirmObservedField, fetchBoardTeams, fetchObservation, fetchObservations, observationReadText, observeOffered, openObserveForm, REREADS_OBSERVATION,
  fetchFields, fetchInventory, inventoryMatches, meaningActOffered, newRequestKey, openSourceFieldForm, outcomeUnknown, sourceFieldCodeText, sourceFieldsContext,
  sourceFieldsState, unitActOffered, verifyMeaning, verifyUnit,
} from "./source-fields-data.js";

const confirmAsk = (question) => Boolean(globalThis.window?.confirm?.(question));
// After a field opens or closes, its title is at the top of the screen (a
// long list on a phone would otherwise leave the new view scrolled).
const toTitle = () => globalThis.document?.getElementById?.("source-fields-title")?.scrollIntoView?.({ block: "start" });
const focus = (selector) => globalThis.document?.querySelector?.(selector)?.focus?.();
// A value inside a quoted attribute selector.
const cssValue = (value) => String(value ?? "").replace(/["\\]/g, "\\$&");

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
    // G1b-2: the field's comparisons on the board (route 10), for a platform admin only.
    if (sourceFieldsContext()?.mayVerify && s.detail.field) {
      try {
        const listed = await fetchObservations(id);
        if (sourceFieldsState().generation !== generation || s.detail.id !== id) return;
        s.detail.observations = Array.isArray(listed?.observations) ? listed.observations : [];
        s.detail.observationsTruncated = listed?.truncated === true;
        s.detail.observationsError = null;
      } catch {
        if (sourceFieldsState().generation !== generation || s.detail.id !== id) return;
        s.detail.observations = null;
        s.detail.observationsError = "The comparisons could not be loaded.";
      }
    }
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

// I3: the names GPEXE sent that no source field covers yet (I2's read). `more` reads the next page; otherwise the list
// is read again from the start with the chosen filter. Read-only: nothing here ever writes.
export async function loadInventory(render, { more = false } = {}) {
  const s = sourceFieldsState();
  if (!sourceFieldsContext()) return;
  const inv = s.inventory;
  // One read at a time, both ways: neither Load more nor a read from the start runs while the other is in flight (code
  // review, LOW; its re-review's L1).
  if (inv.loading || inv.loadingMore || (more && !inv.nextCursor)) return;
  const generation = s.generation;
  const filter = `${inv.endpoint}|${inv.showSupported}`;
  if (more) inv.loadingMore = true; else { inv.loading = true; inv.error = null; inv.nextCursor = null; }
  render();
  try {
    const data = await fetchInventory({ endpoint: inv.endpoint, showSupported: inv.showSupported, cursor: more ? inv.nextCursor : null });
    if (sourceFieldsState().generation !== generation || `${inv.endpoint}|${inv.showSupported}` !== filter) return;
    const items = Array.isArray(data?.fields) ? data.fields : [];
    inv.items = more ? [...inv.items, ...items] : items;
    inv.nextCursor = typeof data?.nextCursor === "string" ? data.nextCursor : null;
    // The team thresholds of the zone names (platform only; the first page carries them, as every page does).
    if (!more || data?.zoneThresholds) inv.zoneThresholds = data?.zoneThresholds ?? null;
    inv.loaded = true;
    inv.error = null;
  } catch (error) {
    if (sourceFieldsState().generation !== generation || `${inv.endpoint}|${inv.showSupported}` !== filter) return;
    const info = errorInfo(error);
    inv.error = info.code === "notFound" ? "The names GPEXE sent are not available in this workspace."
      : info.code === "try_again" ? "The server was busy. Try again in a moment."
      : more ? "More names could not be loaded." : "The names GPEXE sent could not be loaded.";
  } finally {
    if (sourceFieldsState().generation === generation) { inv.loading = false; inv.loadingMore = false; }
  }
  render();
}
// Team thresholds (P1): the platform workspace only, read once when asked for.
export async function loadInventoryThresholds(render) {
  const s = sourceFieldsState();
  const ctx = sourceFieldsContext();
  if (!ctx?.mayVerify) return;
  const t = s.inventory.thresholds;
  if (t.loading) return;
  t.open = true;
  const generation = s.generation;
  t.loading = true;
  t.error = null;
  render();
  try {
    const data = await fetchInventory({ endpoint: "team_thresholds" });
    if (sourceFieldsState().generation !== generation) return;
    t.items = Array.isArray(data?.fields) ? data.fields : [];
    t.loaded = true;
  } catch (error) {
    if (sourceFieldsState().generation !== generation) return;
    t.error = errorInfo(error).code === "try_again" ? "The server was busy. Try again in a moment." : "The team thresholds could not be loaded.";
  } finally {
    if (sourceFieldsState().generation === generation) t.loading = false;
  }
  render();
}
// The team thresholds fold's open state, from its own "toggle" (app.js), so a repaint keeps it as the admin left it.
export function sourceFieldsThresholdsToggled(open) {
  const s = state.trainingLoad.sourceFields;
  if (s?.inventory?.thresholds) s.inventory.thresholds.open = Boolean(open);
}
// The search narrows the loaded names in place, so the field keeps its focus while typing.
function applyInventorySearch(search) {
  const doc = globalThis.document;
  if (!doc?.querySelectorAll) return;
  const items = sourceFieldsState().inventory.items;
  let shown = 0;
  doc.querySelectorAll("[data-sf-inv-row]").forEach((row) => {
    const item = items[Number(row.dataset.sfInvRow)];
    const match = Boolean(item) && inventoryMatches(item, search);
    row.hidden = !match;
    if (match) shown += 1;
  });
  // A group with no matching row is hidden whole; a match in the fold opens it (the code review's LOW).
  doc.querySelectorAll("[data-sf-inv-group]").forEach((group) => { group.hidden = !group.querySelector("[data-sf-inv-row]:not([hidden])"); });
  const fold = doc.querySelector(".source-fields-inventory-other");
  if (fold && search && fold.querySelector("[data-sf-inv-row]:not([hidden])")) fold.open = true;
  const none = doc.getElementById("sf-inv-no-match");
  if (none) none.hidden = shown > 0 || !items.length;
}

// The list read once, for the Data configuration start screen's card.
export function ensureSourceFieldsList(render) {
  const s = sourceFieldsState();
  if (!sourceFieldsContext() || s.list.loaded || s.list.loading) return Promise.resolve();
  return loadSourceFields(render);
}

export function loadSourceFieldsSection(render) {
  const s = sourceFieldsState();
  if (!sourceFieldsContext()) { render(); return Promise.resolve(); }
  if (s.detail.id && !s.form) return loadSourceField(s.detail.id, render);
  const reads = [];
  if (!s.list.loaded && !s.list.loading) reads.push(loadSourceFields(render));
  if (!s.inventory.loaded && !s.inventory.loading) reads.push(loadInventory(render));
  if (reads.length) return Promise.all(reads).then(() => {});
  render();
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
export function sourceFieldsMayBeLeft() {
  const form = state.trainingLoad.sourceFields?.form;
  if (!form) return true;
  if (form.act === "create") {
    if (form.busy) return confirmAsk("The new field is still being created. Leave anyway? Its result will not be shown.");
    if (form.unconfirmed) return confirmAsk("It is not known whether the new field was created. Leave without checking? Open Source fields later to see.");
    if (form.dirty) return confirmAsk("Discard the field you have not created?");
    return true;
  }
  if (form.act === "observe") {
    if (form.busy) return confirmAsk("The comparison is still being saved. Leave anyway? Its result will not be shown.");
    if (form.unconfirmed) return confirmAsk("It is not known whether the comparison was saved. Leave without checking? Open the field later to see.");
    if (form.dirty) return confirmAsk("Discard the comparison you have not saved?");
    return true;
  }
  if (form.busy) return confirmAsk("A confirmation is still being saved. Leave anyway? Its result will not be shown.");
  if (form.unconfirmed) return confirmAsk("The result of the last confirmation is not known. Leave without checking? Open the field later to see whether it was saved.");
  if (form.dirty) return confirmAsk("Discard the confirmation you have not saved?");
  return true;
}
// The list and the names read again after a field was (or may have been) created.
function readAgainAfterCreate(s) {
  s.list = { ...emptySourceFieldsState().list };
  s.inventory = { ...emptyInventory(), endpoint: s.inventory.endpoint, showSupported: s.inventory.showSupported, search: s.inventory.search, thresholds: s.inventory.thresholds, technical: s.inventory.technical };
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
  if (type === "source-fields-inv-reload") {
    await loadInventory(render);
    return true;
  }
  if (type === "source-fields-inv-endpoint") {
    const endpoint = action.dataset.endpoint || "";
    if (s.inventory.endpoint === endpoint) return true;
    s.inventory = { ...emptyInventory(), endpoint, showSupported: s.inventory.showSupported, search: s.inventory.search, thresholds: s.inventory.thresholds, technical: s.inventory.technical };
    await loadInventory(render);
    return true;
  }
  if (type === "source-fields-inv-technical") {
    // The plain view or the technical one. Leaving the technical view also clears a source filter chosen there, since
    // its chips are hidden in the plain view (the code review's MEDIUM: never a filter with no visible control).
    const technical = !s.inventory.technical;
    if (!technical && s.inventory.endpoint) {
      s.inventory = { ...emptyInventory(), endpoint: "", showSupported: s.inventory.showSupported, search: s.inventory.search, thresholds: s.inventory.thresholds, technical };
      await loadInventory(render);
      return true;
    }
    s.inventory.technical = technical;
    render();
    return true;
  }
  if (type === "source-fields-inv-supported") {
    s.inventory = { ...emptyInventory(), endpoint: s.inventory.endpoint, showSupported: !s.inventory.showSupported, search: s.inventory.search, thresholds: s.inventory.thresholds, technical: s.inventory.technical };
    await loadInventory(render);
    return true;
  }
  if (type === "source-fields-inv-more") {
    await loadInventory(render, { more: true });
    return true;
  }
  if (type === "source-fields-inv-thresholds") {
    await loadInventoryThresholds(render);
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
    toTitle();
    return true;
  }
  if (type === "source-fields-back") {
    if (!leaveForm()) return true;
    s.detail = { ...emptySourceFieldsState().detail };
    s.notice = "";
    if (!s.list.loaded) await loadSourceFields(render); else render();
    if (!s.inventory.loaded && !s.inventory.loading) await loadInventory(render);
    toTitle();
    return true;
  }
  if (type === "source-fields-cancel") {
    const form = s.form;
    if (!leaveForm()) return true;
    if (form?.act === "create") {
      if (form.unconfirmed) {
        // A field left without a check may still have been created: the list and the names are read again.
        setNotice(s, "The result was not checked. The source fields below are as they are saved now.", "warning");
        readAgainAfterCreate(s);
        await loadSourceFieldsSection(render);
        focusNotice();
        return true;
      }
      render();
      focus(`[data-action="source-fields-create-open"][data-sf-inv-endpoint="${cssValue(form.endpoint)}"][data-sf-inv-name="${cssValue(form.name)}"]`);
      return true;
    }
    if (form?.unconfirmed) {
      // A confirmation left without a check may still have landed: the field
      // is read again, so the screen never shows it as missing.
      setNotice(s, "The result was not checked. The field below is as it is saved now.", "warning");
      s.list = { ...emptySourceFieldsState().list };
      await loadSourceField(form.fieldId, render);
      focusNotice();
      return true;
    }
    render();
    // Back where the form was opened from.
    if (form?.act === "observe") focus(`[data-action="source-fields-observe-open"][data-revision-id="${cssValue(form.revisionId)}"]`);
    else if (form) focus(`[data-action="source-fields-act-open"][data-act="${form.act}"][data-revision-id="${form.revisionId}"]`);
    return true;
  }
  if (type === "source-fields-check-result") {
    await send(render);
    return true;
  }
  if (type === "source-fields-create-open") {
    // Only on a name the server marked creatable, in the platform workspace; route C decides again.
    if (s.form || s.detail.id) return true;
    const item = s.inventory.items.find((i) => i.endpoint === action.dataset.sfInvEndpoint && i.name === action.dataset.sfInvName) || null;
    if (!createOffered(ctx, item)) return true;
    s.notice = "";
    s.form = openCreateFieldForm(item, s.inventory.items);
    render();
    toTitle();
    focus(".source-fields-form [data-sf-field]:not([disabled])");
    return true;
  }
  if (type === "source-fields-observe-open") {
    // G1b-2: the comparison, only where the view offers it (the same helper decides both).
    if (s.form || s.detail.loading || s.detail.error) return true;
    const field = s.detail.field;
    const revision = (field?.revisions || []).find((r) => r.id === action.dataset.revisionId) || null;
    if (!observeOffered(ctx, field, revision)) return true;
    s.notice = "";
    s.form = openObserveForm({ field, revision });
    render();
    toTitle();
    await loadObserveTeams(render);
    focus(".source-fields-form [data-sf-field]:not([disabled])");
    return true;
  }
  if (type === "source-fields-observe-load") {
    const form = s.form;
    if (form?.act !== "observe" || form.busy || form.unconfirmed || form.observationLoading) return true;
    if (!form.draft.teamId) {
      form.errors = { teamId: "Choose a team." };
      render();
      focus('.source-fields-form select[data-sf-field="teamId"]');
      return true;
    }
    await loadObservation(render, { pair: 0 });
    return true;
  }
  if (type === "source-fields-observe-other") {
    const form = s.form;
    const o = form?.observation;
    if (form?.act !== "observe" || !o || form.busy || form.unconfirmed || form.observationLoading || !(o.pair?.count > 1)) return true;
    await loadObservation(render, { pair: (o.pair.index + 1) % o.pair.count, candidateId: o.session.candidateId });
    return true;
  }
  if (type === "source-fields-act-open") {
    // Only what the view offers: the same helpers decide both, so a forged
    // click opens nothing the server would not take.
    // Not while the field on the screen may be out of date.
    if (s.form || s.detail.loading || s.detail.error) return true;
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
// G1b-2: the comparison's reads - the teams (once), then one comparison (route 8). Read-only.
// ---------------------------------------------------------------------------
async function loadObserveTeams(render) {
  const s = sourceFieldsState();
  const form = s.form;
  if (form?.act !== "observe" || form.teams.loading || form.teams.loaded) return;
  form.teams.loading = true;
  form.teams.error = "";
  render();
  try {
    const data = await fetchBoardTeams();
    if (s.form !== form) return;
    form.teams.items = Array.isArray(data?.teams) ? data.teams : [];
    form.teams.truncated = data?.truncated === true;
    form.teams.loaded = true;
  } catch (error) {
    if (s.form !== form) return;
    form.teams.error = errorInfo(error).code === "try_again" ? "The server was busy. Try again in a moment." : "The teams could not be loaded.";
  } finally {
    if (s.form === form) form.teams.loading = false;
  }
  render();
}
async function loadObservation(render, { pair = 0, candidateId = null, keepError = false } = {}) {
  const s = sourceFieldsState();
  const form = s.form;
  if (form?.act !== "observe") return;
  const teamId = form.draft.teamId;
  form.observationLoading = true;
  form.observationError = "";
  form.errors = {};
  if (!keepError) form.error = "";
  form.draft.attested = false;
  render();
  try {
    const data = await fetchObservation(form.fieldId, candidateId ? { teamId: null, candidateId, pair } : { teamId, candidateId: null, pair: null });
    if (s.form !== form || form.draft.teamId !== teamId) return;
    form.observation = data?.observation || null;
    // The comparison is of this field's revision only; another one closes nothing here, the tick would refuse it.
    if (form.observation && form.observation.revisionId !== form.revisionId) form.observation = null;
  } catch (error) {
    if (s.form !== form || form.draft.teamId !== teamId) return;
    form.observation = null;
    form.observationError = observationReadText(errorInfo(error));
  } finally {
    if (s.form === form) form.observationLoading = false;
  }
  render();
}

// ---------------------------------------------------------------------------
// Typing: the form's values live in state, so a repaint never loses them.
// ---------------------------------------------------------------------------
export function handleSourceFieldsInput(target, { render = null } = {}) {
  if (target.matches?.("[data-sf-inv-search]")) {
    sourceFieldsState().inventory.search = target.value;
    applyInventorySearch(target.value);
    return true;
  }
  const field = target.closest?.("[data-sf-field]");
  if (!field) return false;
  const form = state.trainingLoad.sourceFields?.form;
  if (!form || form.busy || form.unconfirmed) return true;
  const name = field.dataset.sfField;
  if (!(name in form.draft)) return true;
  // A level of a new field is a checkbox; the drill of a per-drill name never changes.
  if (field.type === "checkbox") {
    if (form.act === "create" && name === "supportsDrill" && form.drillLocked) return true;
    form.draft[name] = field.checked === true;
    if (form.errors.attested) {
      delete form.errors.attested;
      globalThis.document?.getElementById?.("sf-err-attested")?.remove?.();
    }
    if (form.errors.levels) {
      delete form.errors.levels;
      globalThis.document?.getElementById?.("sf-err-levels")?.remove?.();
    }
    form.dirty = true;
    return true;
  }
  // G1b-2: another team drops the comparison on the screen (it was of the other team); the admin asks for the new one.
  if (form.act === "observe" && name === "teamId") {
    // Only the "change" call (which renders) takes the choice: a browser sends "input" first, without a render, and the
    // old comparison must never stay on the screen under the new team (UX review MEDIUM-1).
    if (!render) return true;
    if (form.draft.teamId === field.value) return true;
    form.draft.teamId = field.value;
    form.observation = null;
    form.observationError = "";
    form.draft.attested = false;
    form.errors = {};
    if (render) render();
    return true;
  }
  form.draft[name] = field.value;
  form.dirty = true;
  if (form.error) {
    form.error = "";
    globalThis.document?.querySelector?.(".source-fields-form > .error")?.remove?.();
  }
  if (form.errors[name]) {
    delete form.errors[name];
    field.removeAttribute?.("aria-invalid");
    field.closest?.('[role="radiogroup"]')?.removeAttribute?.("aria-invalid");
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
    // The first marked control: a field, or a zone's first choice (a radiogroup itself takes no focus).
    focus('.source-fields-form input[aria-invalid="true"], .source-fields-form select[aria-invalid="true"], .source-fields-form textarea[aria-invalid="true"], .source-fields-form [role="radiogroup"][aria-invalid="true"] input');
    return;
  }
  // A write-once act: the last question names what is saved for good.
  if (!confirmAsk(confirmQuestion(form, body))) return;
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
    data = form.act === "create" ? await createSourceField(form.sentBody)
      : form.act === "observe" ? await confirmObservedField(form.fieldId, form.revisionId, form.sentBody)
      : await (form.act === "unit" ? verifyUnit : verifyMeaning)(form.fieldId, form.revisionId, form.sentBody);
  } catch (error) {
    if (sourceFieldsState().generation !== generation || s.form !== form) return;
    form.busy = false;
    await refused(form, errorInfo(error), { render, check });
    return;
  }
  if (sourceFieldsState().generation !== generation || s.form !== form) return;
  s.form = null;
  if (form.act === "create") {
    // Created (or a Check result found it created): the new field opens; the list and the names are read again later.
    setNotice(s, `${form.draft?.label || "The value"} is now in OptiMove. ${createNextStep(form.endpoint)}`, "");
    readAgainAfterCreate(s);
    const id = typeof data?.field?.id === "string" ? data.field.id : null;
    if (id) await loadSourceField(id, render); else await loadSourceFieldsSection(render);
    focusNotice();
    return;
  }
  const saved = form.act === "observe"
    ? `The unit (${form.observation?.unit}, stated by GPEXE) and the meaning (GPEXE's own label) were saved from the comparison.`
    : form.act === "unit" ? "The unit was confirmed." : "The meaning was confirmed.";
  setNotice(s, `${saved}${data?.readError ? " It could not be read back; the field below is read again." : ""}`, "");
  s.list = { ...emptySourceFieldsState().list };
  await loadSourceField(form.fieldId, render);
  focusNotice();
}

// A notice says what happened; a refusal or an unchecked result is a warning,
// never shown like a saved confirmation.
function setNotice(s, text, kind) {
  s.notice = text;
  s.noticeKind = kind;
}
const focusNotice = () => focus(".source-fields .metric-variables-notice");

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
  if (form.act === "create" && (info.code === "field_exists" || info.code === "notFound")) {
    // The field is there already (someone created it meanwhile): it opens. A 404 closes the form and reads the list again.
    s.form = null;
    readAgainAfterCreate(s);
    const existing = typeof info.current?.fieldId === "string" ? info.current.fieldId : null;
    if (info.code === "field_exists" && existing) {
      setNotice(s, "This field already exists, so nothing was created. It is shown below.", "");
      await loadSourceField(existing, render);
    } else {
      setNotice(s, sourceFieldCodeText(info, form), "warning");
      await loadSourceFieldsSection(render);
    }
    focusNotice();
    return;
  }
  if (form.act === "create" && info.code === "invalid_body") form.errors.label = "Check this value.";
  if (form.act === "observe" && REREADS_OBSERVATION.has(info.code)) {
    // The comparison no longer stands: it is read again (the same team), and the tick starts over.
    form.error = sourceFieldCodeText(info, form);
    form.requestKey = newRequestKey();
    form.draft.attested = false;
    render();
    await loadObservation(render, { pair: 0, keepError: true });
    return;
  }
  if (CLOSES_FORM.has(info.code)) {
    // The form was made from a revision that changed: it is closed and the
    // field read again, so the screen shows it as it is now.
    s.form = null;
    setNotice(s, sourceFieldCodeText(info, form), "warning");
    s.list = { ...emptySourceFieldsState().list };
    await loadSourceField(form.fieldId, render);
    focusNotice();
    return;
  }
  const field = FIELD_OF_CODE[info.code];
  if (field) form.errors[field] = "The server refused this value.";
  form.error = sourceFieldCodeText(info, form);
  render();
}
