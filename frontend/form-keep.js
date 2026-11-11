// Keeps what a person typed in an open form across a repaint of the screen that holds it.
//
// Settings repaints its whole panel (innerHTML) when an /api/organization answer arrives, and a repaint draws an open
// form again from the saved data: text typed while that answer was on its way was lost (a Save then sent the old
// value). Before the repaint, captureChangedFields() reads every field the person changed - its value differs from the
// value the form was drawn with (defaultValue / defaultChecked / defaultSelected) - and after it restoreChangedFields()
// puts those values back into the same field of the same form. A field the person did not touch takes the new value.
//
// Nothing is stored: the values live only in the caller's local variable for the one synchronous repaint (a password
// included), never in state. After a successful save the form is reset (form.reset()) before its repaint, so nothing
// differs and nothing is carried over; a closed or cancelled form is not drawn again, so its values have nowhere to go.

const SKIPPED_TYPES = new Set(["hidden", "file", "submit", "button", "reset", "image"]);

// A form is identified by its data-* attributes (data-organization-form="edit-team" with its
// data-organization-edit-id, ...); a form without any has no stable identity and is left alone.
function formKey(form) {
  const parts = [...form.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `${a.name}=${a.value}`).sort();
  return parts.length ? parts.join("&") : "";
}

// A checkbox or radio is one of several with the same name: its value tells them apart.
function fieldKey(field) {
  const type = (field.type || "").toLowerCase();
  return type === "checkbox" || type === "radio" ? `${field.name}\u0000${field.value}` : field.name;
}

function changedValue(field) {
  const tag = field.tagName;
  const type = (field.type || "").toLowerCase();
  if (tag === "SELECT") {
    const options = [...field.options];
    return options.some((o) => o.selected !== o.defaultSelected) ? { selected: options.filter((o) => o.selected).map((o) => o.value) } : null;
  }
  if (type === "checkbox" || type === "radio") return field.checked !== field.defaultChecked ? { checked: field.checked } : null;
  return field.value !== field.defaultValue ? { value: field.value } : null;
}

export function captureChangedFields(root) {
  const kept = [];
  for (const form of root?.querySelectorAll?.("form") || []) {
    const key = formKey(form);
    if (!key) continue;
    for (const field of form.elements) {
      if (!field.name || SKIPPED_TYPES.has((field.type || "").toLowerCase())) continue;
      const change = changedValue(field);
      if (change) kept.push({ form: key, field: fieldKey(field), ...change });
    }
  }
  return kept;
}

export function restoreChangedFields(root, kept) {
  if (!kept?.length) return;
  const forms = new Map([...(root?.querySelectorAll?.("form") || [])].map((form) => [formKey(form), form]));
  for (const entry of kept) {
    const form = forms.get(entry.form);
    if (!form) continue;
    const field = [...form.elements].find((f) => f.name && fieldKey(f) === entry.field);
    if (!field) continue;
    if (entry.selected) for (const option of field.options) option.selected = entry.selected.includes(option.value);
    else if ("checked" in entry) field.checked = entry.checked;
    else field.value = entry.value;
  }
}
