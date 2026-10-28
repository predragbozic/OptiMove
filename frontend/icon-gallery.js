// Settings -> Icons (Data configuration visual polish, PR-1; proposal section
// 3.2): the built-in icons as a searchable gallery, grouped by category, each
// with its key, its search words and Copy key. Read only, and shown to everyone
// who sees Settings: nothing in it is private and nothing in it changes
// anything. Typing and a chip repaint only the gallery's list, so the focus
// stays where it was. Copy key says what it did in a line everyone sees; when
// the browser refuses the clipboard, that line shows the key to select.
import { state } from "./state.js";
import { ICON_LIBRARY } from "./icon-library.js";
import { ICON_CATEGORIES, categoryLabel, isLibraryKey, renderIconSvg, searchIcons, storedIconValue } from "./icon-render.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { ICON_SEARCH_MAX } from "./icon-picker.js";

// A sign-out reloads the page, so nothing here outlives it; the gallery
// holds nothing private either way.
function gallery() {
  if (!state.iconGallery) state.iconGallery = { query: "", category: "", status: null };
  return state.iconGallery;
}

const countText = (n) => `${n} ${n === 1 ? "icon" : "icons"}`;

function itemHtml(icon) {
  return `
    <li class="icon-gallery-item">
      <span class="icon-gallery-glyph">${renderIconSvg(icon.key, { size: 28 })}</span>
      <span class="icon-gallery-text"><strong>${escapeHtml(icon.key)}</strong><small class="muted">${escapeHtml(icon.words.join(", "))}</small></span>
      <button class="plain-button ghost compact-button" type="button" data-action="icon-gallery-copy" data-icon-key="${escapeAttr(icon.key)}" aria-label="${escapeAttr(`Copy the key of ${icon.key}`)}">Copy key</button>
    </li>`;
}

function listHtml(g) {
  const icons = searchIcons({ query: g.query, category: g.category });
  if (!icons.length) return `<p class="empty">No icon matches. Try another word, or All.</p>`;
  const groups = ICON_CATEGORIES.map((c) => ({ c, icons: icons.filter((icon) => icon.category === c.id) })).filter((group) => group.icons.length);
  return groups.map(({ c, icons: list }) => `
    <section class="icon-gallery-group" aria-labelledby="icon-gallery-${escapeAttr(c.id)}">
      <h3 id="icon-gallery-${escapeAttr(c.id)}">${escapeHtml(c.label)} <span class="muted">${escapeHtml(countText(list.length))}</span></h3>
      <ul class="icon-gallery-grid">${list.map(itemHtml).join("")}</ul>
    </section>`).join("");
}

function chipsHtml(g) {
  return [{ id: "", label: "All" }, ...ICON_CATEGORIES].map((c) => `<button type="button" class="plain-button compact-button icon-picker-chip${g.category === c.id ? " is-active" : ""}" aria-pressed="${g.category === c.id}" data-action="icon-gallery-category" data-icon-category="${escapeAttr(c.id)}">${escapeHtml(c.label)}</button>`).join("");
}

export function renderIconGalleryHtml() {
  const g = gallery();
  const shown = searchIcons({ query: g.query, category: g.category }).length;
  return `
    <section class="panel icon-gallery" aria-labelledby="icon-gallery-title" data-icon-gallery>
      <div class="icon-gallery-head">
        <h2 id="icon-gallery-title">Icons</h2>
        <p class="muted">The built-in icons. Today you choose one for a new variable (Training Load → Data configuration → Variables → New variable); more places will use them later. Copy key copies the stored value, for example icon:run, for reference. Nothing here can be changed.</p>
      </div>
      <label class="search-field icon-gallery-search"><span>Search icons</span>
        <input type="search" data-icon-gallery-search value="${escapeAttr(g.query)}" maxlength="${ICON_SEARCH_MAX}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="icon-gallery-count">
      </label>
      <div class="icon-picker-chips" role="group" aria-label="Categories" data-icon-gallery-chips>${chipsHtml(g)}</div>
      <p class="muted" id="icon-gallery-count" data-icon-gallery-count>${escapeHtml(countText(shown))}${g.category ? ` in ${escapeHtml(categoryLabel(g.category))}` : ""}</p>
      <p class="icon-gallery-status" role="status" data-icon-gallery-status>${statusHtml(g)}</p>
      <div data-icon-gallery-list>${listHtml(g)}</div>
      <p class="muted icon-gallery-credit">Icons from Tabler Icons ${escapeHtml(ICON_LIBRARY.version)}, ${escapeHtml(ICON_LIBRARY.license)} licence.</p>
    </section>`;
}

function paint(g) {
  const root = globalThis.document?.querySelector?.("[data-icon-gallery]");
  if (!root) return;
  const shown = searchIcons({ query: g.query, category: g.category }).length;
  const list = root.querySelector("[data-icon-gallery-list]");
  if (list) list.innerHTML = listHtml(g);
  const chips = root.querySelector("[data-icon-gallery-chips]");
  if (chips) chips.innerHTML = chipsHtml(g);
  const count = root.querySelector("[data-icon-gallery-count]");
  if (count) count.textContent = `${countText(shown)}${g.category ? ` in ${categoryLabel(g.category)}` : ""}`;
}
// The value is a stored value of a library key (checked before it gets here).
function statusHtml(g) {
  if (!g.status) return "";
  const value = escapeHtml(g.status.value);
  return g.status.copied ? `Copied <code>${value}</code>.` : `Could not copy. The key is <code class="icon-gallery-key">${value}</code>.`;
}
function say(g, status) {
  g.status = status;
  const node = globalThis.document?.querySelector?.("[data-icon-gallery-status]");
  if (node) node.innerHTML = statusHtml(g);
}

export async function handleIconGalleryAction(action) {
  const type = action.dataset.action || "";
  if (!type.startsWith("icon-gallery-")) return false;
  const g = gallery();
  if (type === "icon-gallery-category") {
    const id = action.dataset.iconCategory || "";
    if (id && !ICON_CATEGORIES.some((c) => c.id === id)) return true;
    g.category = id;
    paint(g);
    globalThis.document?.querySelector?.(`[data-icon-gallery] [data-icon-category="${id}"]`)?.focus?.();
    return true;
  }
  if (type === "icon-gallery-copy") {
    const key = action.dataset.iconKey || "";
    if (!isLibraryKey(key)) return true;
    const value = storedIconValue(key);
    try {
      await globalThis.navigator.clipboard.writeText(value);
      say(g, { copied: true, value });
    } catch {
      say(g, { copied: false, value });
    }
    return true;
  }
  return true;
}

export function handleIconGalleryInput(target) {
  const search = target?.closest?.("[data-icon-gallery-search]");
  if (!search) return false;
  const g = gallery();
  g.query = String(search.value || "").slice(0, ICON_SEARCH_MAX);
  paint(g);
  return true;
}
