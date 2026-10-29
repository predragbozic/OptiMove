// Training Load -> Data configuration -> Variables -> Domains & categories: the
// read, the clicks and the writes (phase 12c, J6 3.4). The forms share the
// Variables screen's one form slot, so one write runs at a time and leaving
// asks first. A write whose answer is lost is shown as "Result not confirmed"
// and checked by sending the very same request (the same request key and
// body) again - the server replays a saved write and never saves twice. The
// variables' loaders come in from metric-variables-actions.js (`load`).
import { variablesContext, variablesState } from "./metric-variables-data.js";
import {
  CLOSES_FORM, KEY_FIELD_TEXT, buildClassificationRequest, categoryPlaceable, changeNode, checkNoteText, checkSettles, classificationCodeText,
  createLink, createNode, errorInfo, fetchClassification, findNode, nounOf, openClassificationForm, outcomeUnknown, placeableDomains, removeLink,
  removablePlacement, removableVariableLink,
} from "./metric-classification-data.js";
import { newRequestKey } from "./metric-variables-data.js";
import { checkDrop, dismissDrop, ensureTray, loadTray, undoDrop } from "./metric-classification-drag.js";

// The domains and categories the workspace reads (C1).
export async function loadClassification(render) {
  const s = variablesState();
  if (!variablesContext()) return;
  const c = s.classification;
  const generation = s.generation;
  c.loading = true;
  c.error = null;
  render();
  try {
    const data = await fetchClassification();
    if (variablesState().generation !== generation) return;
    c.tree = data || null;
    c.loaded = true;
  } catch (error) {
    if (variablesState().generation !== generation) return;
    const info = errorInfo(error);
    c.error = info.code === "notFound" ? "Domains and categories are not available in this workspace." : "The domains and categories could not be loaded.";
  } finally {
    if (variablesState().generation === generation) c.loading = false;
  }
  render();
}
// Read once per view of the screen (the list's filter and a variable's links need it).
export function ensureClassification(render) {
  const c = variablesState().classification;
  if (c.loaded || c.loading) return Promise.resolve();
  return loadClassification(render);
}

const focusFirstField = () => globalThis.document?.querySelector?.(".metric-classification-form [data-mc-field]:not([disabled])")?.focus?.();
// The screens of the start screen (layout C).
const VIEWS = ["home", "variables", "domains", "categories"];
// A new screen starts at its title: the focus goes there and it is scrolled
// to the top (a long list on a phone would otherwise stay scrolled).
export function toTitle() {
  const title = globalThis.document?.getElementById?.("metric-variables-title");
  title?.focus?.({ preventScroll: true });
  title?.scrollIntoView?.({ block: "start" });
}
// After a read repainted the screen, the focus that went down with the old
// markup comes back to the title (never taken from where the coach moved it).
function keepTitle() {
  const doc = globalThis.document;
  const active = doc?.activeElement;
  if (active && active !== doc.body) return;
  doc?.getElementById?.("metric-variables-title")?.focus?.({ preventScroll: true });
}
const nodeOf = (action) => findNode(variablesState().classification.tree, action.dataset.kind, action.dataset.nodeId || "");

// ---------------------------------------------------------------------------
// Clicks (every one named metric-classification-*). `leaveForm` asks before an
// open form is dropped; `load` are the variables' loaders.
// ---------------------------------------------------------------------------
export async function handleClassificationAction(action, { render, leaveForm, load }) {
  const type = action.dataset.action || "";
  const s = variablesState();
  const ctx = variablesContext();
  if (!ctx) return true;
  const admin = ctx.view !== "coach";

  // The start screen and its screens (layout C, PR-1): Variables, Domains,
  // Categories. Each opens at its start: no variable or node left open.
  if (type === "metric-classification-view") {
    const view = VIEWS.includes(action.dataset.view) ? action.dataset.view : "home";
    if (view === s.view && !s.node && !(view === "variables" && s.detail.id)) return true;
    if (!leaveForm()) return true;
    s.view = view;
    s.node = null;
    s.notice = "";
    s.detail = { ...s.detail, id: null, variable: null };
    let read = null;
    if (view === "domains") read = loadClassification(render);
    else if (view === "categories") {
      // The tray of variables (PR-2) is read again each time the screen opens.
      s.tray = null;
      read = Promise.all([loadClassification(render), ensureTray(render)]);
    }
    else if (view === "home") read = load.home(render);
    else if (s.list.loaded) render();
    else read = load.list(render);
    toTitle();
    await read;
    keepTitle();
    return true;
  }
  if (type === "metric-classification-reload") {
    await loadClassification(render);
    return true;
  }
  // Dragging a variable onto a category (PR-2): the tray's read, and the last
  // drop's Undo, Check result and Close without checking.
  if (type === "metric-classification-tray-reload") {
    await loadTray(render);
    return true;
  }
  if (type === "metric-classification-drop-undo") {
    await undoDrop({ render });
    return true;
  }
  if (type === "metric-classification-drop-check") {
    await checkDrop({ render });
    return true;
  }
  if (type === "metric-classification-drop-dismiss") {
    dismissDrop({ render });
    return true;
  }
  if (type === "metric-classification-open") {
    const node = nodeOf(action);
    if (!node || !leaveForm()) return true;
    s.node = { kind: action.dataset.kind, id: node.id };
    s.notice = "";
    render();
    toTitle();
    return true;
  }
  if (type === "metric-classification-back") {
    if (!leaveForm()) return true;
    s.node = null;
    s.notice = "";
    render();
    toTitle();
    return true;
  }
  if (type === "metric-classification-show-variables") {
    const node = nodeOf(action);
    if (!node || !leaveForm()) return true;
    s.filter = { kind: action.dataset.kind, id: node.id };
    s.view = "variables";
    s.node = null;
    s.notice = "";
    s.detail = { ...s.detail, id: null, variable: null };
    s.list = { ...s.list, items: [], nextCursor: null, loaded: false };
    await load.list(render);
    return true;
  }
  if (type === "metric-classification-filter-clear") {
    if (!s.filter || !leaveForm()) return true;
    s.filter = null;
    s.list = { ...s.list, items: [], nextCursor: null, loaded: false };
    await load.list(render);
    return true;
  }

  // The forms: only an admin's, and only what the server's answer offers.
  if (!admin || s.form) return true;
  if (type === "metric-classification-create-open") {
    const kind = action.dataset.kind === "category" ? "category" : "domain";
    s.notice = "";
    s.form = openClassificationForm("node-create", { kind });
    render();
    focusFirstField();
    return true;
  }
  const verb = { "metric-classification-rename-open": "rename", "metric-classification-archive-open": "archive", "metric-classification-restore-open": "restore" }[type];
  if (verb) {
    const node = nodeOf(action);
    if (!node || !(node.actions || []).includes(verb)) return true;
    s.notice = "";
    s.form = openClassificationForm(`node-${verb}`, { kind: action.dataset.kind, node });
    render();
    focusFirstField();
    return true;
  }
  // Place and Remove open only for what the view offers: the same helpers
  // decide both, so a forged click opens nothing the server did not offer.
  if (type === "metric-classification-place-open") {
    const tree = s.classification.tree;
    const category = findNode(tree, "category", action.dataset.nodeId || "");
    if (!categoryPlaceable(category, tree, ctx) || !placeableDomains(tree).length) return true;
    s.notice = "";
    s.form = openClassificationForm("category-place", { category });
    render();
    focusFirstField();
    return true;
  }
  if (type === "metric-classification-variable-link-open") {
    const variable = s.detail.variable;
    if (!variable || variable.id !== action.dataset.variableId || variable.state !== "active") return true;
    s.notice = "";
    s.form = openClassificationForm("variable-link", { linkKind: action.dataset.linkKind === "domain" ? "domain" : "category", variableId: variable.id, variableLabel: variable.label, returnTo: "variable" });
    render();
    focusFirstField();
    return true;
  }
  if (type === "metric-classification-link-remove-open") {
    const linkId = action.dataset.linkId || "";
    const variableId = action.dataset.variableId || null;
    let params = null;
    if (variableId) {
      // A variable's own link, from the variable on the screen.
      const variable = s.detail.variable;
      const found = variable?.id === variableId ? removableVariableLink(variable, linkId, ctx) : null;
      if (found) params = { shape: `variable-${found.kind}`, subject: variable.label || "", target: found.entry.name || "", variableId, returnTo: "variable" };
    } else {
      // A category's placement, from the tree.
      const tree = s.classification.tree;
      const link = removablePlacement(tree, linkId, ctx);
      if (link) params = { shape: "category-domain", subject: findNode(tree, "category", link.categoryId)?.name || "", target: findNode(tree, "domain", link.domainId)?.name || "", returnTo: "classification" };
    }
    if (!params) return true;
    s.notice = "";
    s.form = openClassificationForm("link-remove", { linkId, ...params });
    render();
    focusFirstField();
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Typing: the form's values live in state, so a repaint never loses them.
// ---------------------------------------------------------------------------
export function handleClassificationInput(target) {
  const form = variablesState().form;
  const field = target.closest?.("[data-mc-field]");
  if (!field) return false;
  if (!form || form.busy || form.unconfirmed) return true;
  const name = field.dataset.mcField;
  if (!(name in form.draft)) return true;
  form.draft[name] = field.value;
  form.dirty = true;
  if (form.error) {
    form.error = "";
    globalThis.document?.querySelector?.(".metric-classification-form > .error")?.remove?.();
  }
  if (form.errors[name]) {
    delete form.errors[name];
    field.removeAttribute?.("aria-invalid");
    globalThis.document?.getElementById?.(`mc-err-${name}`)?.remove?.();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
export async function submitClassificationForm({ render, load }) {
  const form = variablesState().form;
  if (!form || form.busy || form.unconfirmed) return;
  const { body, errors, unchanged } = buildClassificationRequest(form);
  form.errors = errors;
  form.error = "";
  if (unchanged) {
    form.error = "Nothing changed: change the name or the description, or Cancel.";
    render();
    return;
  }
  if (!body) {
    form.error = "Check the marked fields.";
    render();
    globalThis.document?.querySelector?.('.metric-classification-form [aria-invalid="true"]')?.focus?.();
    return;
  }
  form.sentBody = body;
  await sendClassification({ render, load });
}

const WRITES = {
  "node-create": (form) => createNode(form.kind, form.sentBody),
  "node-rename": (form) => changeNode(form.kind, form.nodeId, "rename", form.sentBody),
  "node-archive": (form) => changeNode(form.kind, form.nodeId, "archive", form.sentBody),
  "node-restore": (form) => changeNode(form.kind, form.nodeId, "restore", form.sentBody),
  "category-place": (form) => createLink(form.sentBody),
  "variable-link": (form) => createLink(form.sentBody),
  "link-remove": (form) => removeLink(form.linkId, form.sentBody),
};

export async function sendClassification({ render, load }) {
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
    await refused(form, errorInfo(error), { render, load, check });
    return;
  }
  if (variablesState().generation !== generation || s.form !== form) return;
  await saved(form, data, { render, load });
}

async function refused(form, info, { render, load, check }) {
  const s = variablesState();
  // A lost answer, or a Check result answered before the server read its
  // request record: what happened to the first write is still not known.
  if (outcomeUnknown(info) || (check && !checkSettles(info))) {
    form.unconfirmed = true;
    form.checkNote = check ? checkNoteText(info) : "";
    render();
    return;
  }
  form.unconfirmed = false;
  form.checkNote = "";
  if (info.code === "key_required" || info.code === "key_taken") form.errors.key = KEY_FIELD_TEXT[info.code];
  else if (info.code === "request_key_reused") form.requestKey = newRequestKey();
  if (CLOSES_FORM.has(info.code)) {
    // The form was made from a state that changed: it is closed and the
    // screen read again, so the coach starts from how it is now.
    s.form = null;
    s.notice = classificationCodeText(info, form.mode, form);
    await reloadAfter(form, { render, load });
    return;
  }
  form.error = classificationCodeText(info, form.mode, form);
  render();
}

// After a write (or a write left without a check): the tree, and the variable
// the form was opened from, are read again; the list's filter may count other
// variables now.
async function reloadAfter(form, { render, load }) {
  const s = variablesState();
  s.list = { ...s.list, items: [], nextCursor: null, loaded: false };
  await Promise.all([
    loadClassification(render),
    form.returnTo === "variable" && form.variableId ? load.variable(form.variableId, render) : null,
  ]);
}

const DONE = {
  "node-create": (form) => `The ${nounOf(form.kind)} was created.`,
  "node-rename": (form) => `The ${nounOf(form.kind)} was renamed.`,
  "node-archive": (form) => `The ${nounOf(form.kind)} was archived.`,
  "node-restore": (form) => `The ${nounOf(form.kind)} was restored.`,
  "category-place": () => "The category was placed in the domain.",
  "variable-link": (form) => `The variable was added to the ${nounOf(form.linkKind)}.`,
  "link-remove": (form) => (form.subject && form.target ? `${form.subject} was removed from ${form.target}.` : `It was removed from the ${form.shape === "variable-category" ? "category" : "domain"}.`),
};
async function saved(form, data, { render, load }) {
  const s = variablesState();
  s.form = null;
  s.notice = data?.readError ? `${DONE[form.mode](form)} It could not be read back; the list below is read again.` : DONE[form.mode](form);
  // A new domain or category opens; a change keeps its node open.
  if (form.mode === "node-create") {
    const created = data?.[form.kind] || null;
    s.node = created?.id ? { kind: form.kind, id: created.id } : null;
  }
  await reloadAfter(form, { render, load });
}

// Leaving a form whose result was not checked: the screen is read again, so it
// never shows a saved change as missing.
export async function afterUncheckedClose(form, { render, load }) {
  const s = variablesState();
  s.notice = "The result was not checked. What is shown below is as it is saved now.";
  await reloadAfter(form, { render, load });
}
