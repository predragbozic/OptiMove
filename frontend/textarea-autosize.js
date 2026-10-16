// Text fields that grow with what is typed (textarea[data-autogrow]), so a
// coach always sees the whole note instead of a two-line window. The height
// follows the text up to the CSS max-height, where the field starts to
// scroll. Called on every input and again after each re-render (autosave
// repaints the Builder's lists), so a field never snaps back while typing.

export const AUTOGROW_SELECTOR = "textarea[data-autogrow]";

// Rows to render before the script measures: the text's own lines, at least
// `min`, at most `max` - so the first paint is already close to the result.
export function autogrowRows(text, { min = 3, max = 12, charsPerLine = 60 } = {}) {
  const lines = String(text || "").split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  return Math.min(max, Math.max(min, lines));
}

export function autosizeTextarea(textarea) {
  if (!textarea?.matches?.(AUTOGROW_SELECTOR)) return;
  // A field that is not laid out (a CSS-hidden list) has nothing to measure.
  if (!textarea.getClientRects?.().length) return;
  const borders = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + borders}px`;
}

export function autosizeTextareas(root) {
  root?.querySelectorAll?.(AUTOGROW_SELECTOR).forEach(autosizeTextarea);
}
