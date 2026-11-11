// Keeps what a person typed in an open form across a repaint of the screen that holds it.
//
// Settings repaints its whole panel (innerHTML) when an /api/organization answer arrives, and a repaint draws an open
// form again from the saved data: text typed while that answer was on its way was lost (a Save then sent the old
// value). Before the repaint, captureChangedFields() reads every field the person changed - its value differs from the
// value the form was drawn with (defaultValue / defaultChecked / defaultSelected) - and which field had the focus; after
// it, restoreChangedFields() puts those values back into the same field of the same form and gives the focus (and the
// caret) back. A field the person did not touch takes the new value.
//
// A searchable picker (organization-select.js) keeps its choice in an unnamed search box and a hidden input the code
// fills; both are kept as a pair, exactly as chosen (the search is not run again).
//
// Nothing is stored: the values live only in the caller's local variable for the one synchronous repaint (a password
// included), never in state. A successful save resets the form that is on screen (resetLiveForm), so nothing differs and
// nothing is carried over; a closed or cancelled form is not drawn again, so its values have nowhere to go.

const SKIPPED_TYPES = new Set(["hidden", "file", "submit", "button", "reset", "image"]);
const CARET_TYPES = new Set(["text", "search", "url", "tel", "password", ""]);

// A form is identified by its data-* attributes (data-organization-form="edit-team" with its
// data-organization-edit-id, ...); a form without any has no stable identity and is left alone.
export function formKey(form) {
  const parts = [...form.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `${a.name}=${a.value}`).sort();
  return parts.length ? parts.join("&") : "";
}

// A checkbox or radio is one of several with the same name: its value tells them apart. A picker's search box has no
// name: it is known by the field it fills.
function fieldKey(field) {
  if (field.matches?.("[data-org-select-filter]")) return `picker\u0000${field.dataset.targetSelect || ""}`;
  const type = (field.type || "").toLowerCase();
  return type === "checkbox" || type === "radio" ? `${field.name}\u0000${field.value}` : field.name;
}

function pickerHidden(search) {
  return search.closest(".filterable-select-field")?.querySelector('input[type="hidden"]') || null;
}

function changedValue(field) {
  const tag = field.tagName;
  const type = (field.type || "").toLowerCase();
  if (field.matches?.("[data-org-select-filter]")) {
    const hidden = pickerHidden(field);
    const changed = field.value !== field.defaultValue || (hidden && hidden.value !== hidden.defaultValue);
    return changed ? { value: field.value, picked: hidden ? hidden.value : null } : null;
  }
  if (tag === "SELECT") {
    const options = [...field.options];
    return options.some((o) => o.selected !== o.defaultSelected) ? { selected: options.filter((o) => o.selected).map((o) => o.value) } : null;
  }
  if (type === "checkbox" || type === "radio") return field.checked !== field.defaultChecked ? { checked: field.checked } : null;
  return field.value !== field.defaultValue ? { value: field.value } : null;
}

function keptField(field) {
  if (field.matches?.("[data-org-select-filter]")) return true;
  return Boolean(field.name) && !SKIPPED_TYPES.has((field.type || "").toLowerCase());
}

function fieldsOf(form) {
  return [...form.elements].filter(keptField);
}

export function captureChangedFields(root) {
  const kept = [];
  for (const form of root?.querySelectorAll?.("form") || []) {
    const key = formKey(form);
    if (!key) continue;
    for (const field of fieldsOf(form)) {
      const change = changedValue(field);
      if (change) kept.push({ form: key, field: fieldKey(field), ...change });
    }
  }
  // The field being typed in, and where the caret was, so the keyboard does not lose its place.
  const active = root?.ownerDocument?.activeElement;
  const activeForm = active && root.contains(active) ? active.form || active.closest?.("form") : null;
  if (activeForm && keptField(active) && formKey(activeForm)) {
    let start = null;
    let end = null;
    try { start = active.selectionStart; end = active.selectionEnd; } catch { /* a type without a caret */ }
    kept.focus = { form: formKey(activeForm), field: fieldKey(active), start, end };
  }
  return kept;
}

export function restoreChangedFields(root, kept) {
  if (!kept?.length && !kept?.focus) return;
  const forms = new Map([...(root?.querySelectorAll?.("form") || [])].map((form) => [formKey(form), form]));
  const find = (formId, fieldId) => {
    const form = forms.get(formId);
    return form ? fieldsOf(form).find((f) => fieldKey(f) === fieldId) || null : null;
  };
  for (const entry of kept) {
    const field = find(entry.form, entry.field);
    if (!field) continue;
    if (entry.selected) for (const option of field.options) option.selected = entry.selected.includes(option.value);
    else if ("checked" in entry) field.checked = entry.checked;
    else {
      field.value = entry.value;
      if ("picked" in entry && entry.picked !== null) {
        const hidden = pickerHidden(field);
        if (hidden) hidden.value = entry.picked;
      }
    }
  }
  const focus = kept.focus;
  const field = focus ? find(focus.form, focus.field) : null;
  if (field && typeof field.focus === "function") {
    field.focus({ preventScroll: true });
    if (focus.start !== null && CARET_TYPES.has((field.type || "").toLowerCase()) && typeof field.setSelectionRange === "function") {
      try { field.setSelectionRange(focus.start, focus.end ?? focus.start); } catch { /* a type without a caret */ }
    }
  }
}

// After a successful save: reset the form that is on screen now. The submitted node may have been replaced by a
// repaint while the request was on its way (and the person's text put into the new one); resetting only the old node
// would leave the typed values - a password included - on screen.
export function resetLiveForm(form, root = globalThis.document) {
  form?.reset?.();
  if (!form || form.isConnected) return;
  const key = formKey(form);
  if (!key) return;
  const live = [...(root?.querySelectorAll?.("form") || [])].find((candidate) => formKey(candidate) === key);
  live?.reset?.();
}
