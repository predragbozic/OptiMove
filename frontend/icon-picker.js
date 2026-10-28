// The one icon picker (Data configuration visual polish, PR-1; proposal section
// 3.3), used wherever an icon is chosen: a dialog on a computer, a bottom sheet
// on a phone. Search, category chips, a grid of icon buttons, No icon and Use
// icon. Nothing is preselected but the screen's current choice; the chosen key
// is named under the grid. The screen that opens it (its `host`) renders it and
// receives the choice; the picker itself writes nothing and sends nothing.
// Typing, a chip or a choice repaints only the picker's own parts, so the focus
// stays where it was. It is modal: the host renders its own form inert while
// the picker is open, and Tab stays inside the dialog (trapIconPickerTab).
import { state } from "./state.js";
import { ICON_CATEGORIES, isLibraryKey, renderIconSvg, searchIcons, storedIconValue } from "./icon-render.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const ICON_SEARCH_MAX = 60;

export function openIconPicker({ host, title = "Choose an icon", current = null, returnFocus = "" }) {
  state.iconPicker = { host, title, query: "", category: "", selected: isLibraryKey(current) ? current : null, returnFocus };
}
export const iconPickerOpenFor = (host) => state.iconPicker?.host === host;
// Closes the picker; gives back what the screen needs to put the focus back.
export function closeIconPicker() {
  const picker = state.iconPicker || null;
  state.iconPicker = null;
  return picker;
}

function gridHtml(p) {
  const icons = searchIcons({ query: p.query, category: p.category });
  if (!icons.length) return `<p class="muted icon-picker-empty">No icon matches. Try another word, or All.</p>`;
  return icons.map((icon) => `<button type="button" class="icon-picker-option${p.selected === icon.key ? " is-selected" : ""}" aria-pressed="${p.selected === icon.key}" data-action="icon-picker-choose" data-icon-key="${escapeAttr(icon.key)}" aria-label="${escapeAttr(`${icon.key}: ${icon.words.join(", ")}`)}" title="${escapeAttr(icon.key)}">${renderIconSvg(icon.key)}</button>`).join("");
}
function choiceHtml(p) {
  return p.selected
    ? `${renderIconSvg(p.selected, { size: 20 })}<span>Chosen: <strong>${escapeHtml(p.selected)}</strong> · stored as <code>${escapeHtml(storedIconValue(p.selected))}</code></span>`
    : `<span>No icon chosen yet.</span>`;
}
function chipsHtml(p) {
  return [{ id: "", label: "All" }, ...ICON_CATEGORIES].map((c) => `<button type="button" class="plain-button compact-button icon-picker-chip${p.category === c.id ? " is-active" : ""}" aria-pressed="${p.category === c.id}" data-action="icon-picker-category" data-icon-category="${escapeAttr(c.id)}">${escapeHtml(c.label)}</button>`).join("");
}

export function renderIconPickerHtml() {
  const p = state.iconPicker;
  if (!p) return "";
  return `
    <div class="icon-picker-overlay" data-icon-picker>
      <button class="icon-picker-backdrop" type="button" data-action="icon-picker-cancel" aria-label="Close without choosing" tabindex="-1"></button>
      <section class="panel icon-picker" role="dialog" aria-modal="true" aria-labelledby="icon-picker-title">
        <div class="icon-picker-head">
          <h2 id="icon-picker-title" tabindex="-1">${escapeHtml(p.title)}</h2>
          <button class="plain-button ghost" type="button" data-action="icon-picker-cancel">Cancel</button>
        </div>
        <label class="search-field icon-picker-search"><span>Search icons</span>
          <input type="search" data-icon-picker-search value="${escapeAttr(p.query)}" maxlength="${ICON_SEARCH_MAX}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-controls="icon-picker-grid">
        </label>
        <div class="icon-picker-chips" role="group" aria-label="Categories" data-icon-picker-chips>${chipsHtml(p)}</div>
        <div class="icon-picker-grid" id="icon-picker-grid" role="group" aria-label="Icons" data-icon-picker-grid>${gridHtml(p)}</div>
        <p class="icon-picker-choice" data-icon-picker-choice aria-live="polite">${choiceHtml(p)}</p>
        <div class="icon-picker-actions">
          <button class="plain-button data-sources-primary" type="button" data-action="icon-picker-use" ${p.selected ? "" : "disabled"}>Use icon</button>
          <button class="plain-button ghost" type="button" data-action="icon-picker-none">Use no icon</button>
        </div>
      </section>
    </div>`;
}

// Repaints the grid, the chips, the choice and Use icon in place.
function paint(p, { grid = true } = {}) {
  const doc = globalThis.document;
  const root = doc?.querySelector?.("[data-icon-picker]");
  if (!root) return;
  if (grid) {
    const node = root.querySelector("[data-icon-picker-grid]");
    if (node) node.innerHTML = gridHtml(p);
  }
  const chips = root.querySelector("[data-icon-picker-chips]");
  if (chips) chips.innerHTML = chipsHtml(p);
  const choice = root.querySelector("[data-icon-picker-choice]");
  if (choice) choice.innerHTML = choiceHtml(p);
  const use = root.querySelector('[data-action="icon-picker-use"]');
  if (use) use.disabled = !p.selected;
}

// On open: the search with a mouse or a keyboard; on a touch screen the title,
// so the phone's keyboard does not open over the grid and Use icon.
export function focusIconPicker() {
  const doc = globalThis.document;
  const touch = Boolean(globalThis.matchMedia?.("(pointer: coarse)")?.matches);
  doc?.querySelector?.(touch ? "#icon-picker-title" : "[data-icon-picker-search]")?.focus?.();
}

// Tab and Shift+Tab stay inside the open picker (it is aria-modal). True when
// the key was handled here.
export function trapIconPickerTab(event) {
  if (!state.iconPicker || event?.key !== "Tab") return false;
  const doc = globalThis.document;
  const dialog = doc?.querySelector?.("[data-icon-picker] .icon-picker");
  if (!dialog) return false;
  const controls = Array.from(dialog.querySelectorAll("button:not(:disabled),input:not(:disabled)"));
  if (!controls.length) return false;
  const at = controls.indexOf(doc.activeElement);
  const inside = dialog.contains(doc.activeElement);
  if (event.shiftKey && (at <= 0)) {
    event.preventDefault();
    controls.at(-1).focus();
    return true;
  }
  if (!event.shiftKey && (at === controls.length - 1 || !inside)) {
    event.preventDefault();
    controls[0].focus();
    return true;
  }
  return false;
}

// A click inside the picker. `apply(key | null)` hands the choice to the screen
// (null: No icon); `render` repaints the screen once the picker is closed.
export function handleIconPickerAction(action, { render, apply }) {
  const p = state.iconPicker;
  const type = action.dataset.action || "";
  if (!p || !type.startsWith("icon-picker-")) return false;
  const doc = globalThis.document;
  if (type === "icon-picker-choose") {
    const key = action.dataset.iconKey || "";
    if (!isLibraryKey(key)) return true;
    p.selected = key;
    paint(p);
    doc?.querySelector?.(`[data-icon-picker] [data-icon-key="${key}"]`)?.focus?.();
    return true;
  }
  if (type === "icon-picker-category") {
    const id = action.dataset.iconCategory || "";
    if (id && !ICON_CATEGORIES.some((c) => c.id === id)) return true;
    p.category = id;
    paint(p);
    doc?.querySelector?.(`[data-icon-picker] [data-icon-category="${id}"]`)?.focus?.();
    return true;
  }
  if (type === "icon-picker-use" || type === "icon-picker-none" || type === "icon-picker-cancel") {
    if (type === "icon-picker-use" && !p.selected) return true;
    if (type === "icon-picker-use") apply(p.selected);
    if (type === "icon-picker-none") apply(null);
    const closed = closeIconPicker();
    render();
    if (closed?.returnFocus) doc?.querySelector?.(closed.returnFocus)?.focus?.();
    return true;
  }
  return true;
}

// Typing in the search: the grid narrows in place.
export function handleIconPickerInput(target) {
  const p = state.iconPicker;
  const search = target?.closest?.("[data-icon-picker-search]");
  if (!p || !search) return false;
  p.query = String(search.value || "").slice(0, ICON_SEARCH_MAX);
  paint(p);
  return true;
}
