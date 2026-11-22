// K6 (docs/ai/central-calendar-k6-contract.md, section 1): the athlete switcher
// strip shared by the Builder's batch switcher, the central calendar and the
// Weekly plan header. Pure functions, no state of its own.
import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, initialsFor } from "./utils.js";

// The "Everyone" strip of a club is a strip only up to this many athletes
// (contract 2.4, Q9: a constant, changed by a pull request).
export const ATHLETE_STRIP_MAX = 60;
// The search shows at most this many results (contract 2.6).
export const ATHLETE_SEARCH_MAX = 8;
// The search field appears when the strip has more athletes than this.
export const ATHLETE_SEARCH_MIN_STRIP = 8;

// "Ana Kovač" -> "Ana K."; one word stays as it is. The rule the Builder used.
export function athleteCaption(name) {
  const text = String(name ?? "");
  const parts = text.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : text;
}

function pillHtml(item, { active, action, keyAttr, isAll }) {
  const name = item.name;
  const caption = item.caption !== undefined && item.caption !== null ? item.caption : athleteCaption(name);
  const dot = item.teamColorStyle ? `<span class="athlete-switcher-dot" style="${escapeAttr(item.teamColorStyle)}" aria-hidden="true"></span>` : "";
  const mark = item.notInSession ? `<span class="athlete-switcher-mark" aria-hidden="true">–</span>` : "";
  const label = item.groupLabel ? `<span class="athlete-switcher-group-label" aria-hidden="true">${escapeHtml(item.groupLabel)}</span>` : "";
  const glyph = isAll ? "All" : initialsFor(name);
  const avatar = `<span class="builder-batch-avatar"><span>${escapeHtml(glyph)}</span>${item.imageUrl ? renderImage(item.imageUrl, "builder-batch-photo") : ""}${dot}</span>`;
  return `${label}
              <button class="builder-batch-pill ${active ? "is-active" : ""}${isAll ? " athlete-switcher-all" : ""}" type="button" data-action="${escapeAttr(action)}" ${keyAttr}="${escapeAttr(item.key)}" title="${escapeAttr(name)}" aria-label="${escapeAttr(name)}" aria-pressed="${active}">
                ${avatar}${mark}
                <span class="builder-batch-caption">${escapeHtml(caption)}</span>
              </button>
            `;
}

// Returns the `builder-batch-buttons` markup: ‹, the pills, ›. The first line
// carries no indentation: the caller places it.
export function renderAthleteSwitcherStripHtml({
  items = [],
  currentKey = "",
  action,
  keyAttr = "data-athlete-key",
  allItem = null,
  ariaLabel = "",
  wrapArrows = false,
} = {}) {
  const sequence = allItem ? [{ key: "", name: allItem.label, caption: allItem.caption, isAll: true }, ...items] : items.slice();
  const currentIndex = sequence.findIndex((item) => String(item.key) === String(currentKey ?? ""));
  const at = (index) => {
    if (!sequence.length) return null;
    if (index >= 0 && index < sequence.length) return sequence[index];
    if (!wrapArrows) return null;
    return sequence[(index + sequence.length) % sequence.length];
  };
  const previous = currentIndex < 0 ? null : at(currentIndex - 1);
  const next = currentIndex < 0 ? null : at(currentIndex + 1);
  const arrow = (target, label, glyph) => `<button class="plain-button icon-button" type="button" data-action="${escapeAttr(action)}" ${keyAttr}="${escapeAttr(target ? target.key : "")}" ${target ? "" : "disabled"} aria-label="${label}"><span class="button-icon">${glyph}</span></button>`;
  const aria = ariaLabel ? ` role="group" aria-label="${escapeAttr(ariaLabel)}"` : "";
  return `<div class="builder-batch-buttons"${aria}>
          ${arrow(previous, "Previous athlete", "&lt;")}
          <div class="builder-batch-pills">
            ${sequence.map((item, index) => pillHtml(item, { active: index === currentIndex, action, keyAttr, isAll: Boolean(item.isAll) })).join("")}
          </div>
          ${arrow(next, "Next athlete", "&gt;")}
        </div>`;
}

// Keeps the chosen pill in view after a render (phones). Safe where scrollIntoView
// or layout is missing (JSDOM).
export function athleteSwitcherScrollIntoView(root) {
  const scope = root || (typeof document !== "undefined" ? document : null);
  const pill = scope?.querySelector?.(".builder-batch-pills .builder-batch-pill.is-active");
  if (!pill) return false;
  // Only the strip scrolls sideways (never the page): the pill is centred in its own box.
  const box = pill.parentElement;
  if (box && box.clientWidth > 0) {
    try { box.scrollLeft = Math.max(0, pill.offsetLeft - (box.clientWidth - pill.offsetWidth) / 2); } catch { /* ignore */ }
  }
  return true;
}

// --- Search (contract 2.6) -------------------------------------------------

export function foldSearchText(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// items: [{ key, name, teamNames?: string[], teamOrder?: number }]. Matching is
// case- and accent-insensitive, a word-start match first, then anywhere in the
// name; ordered by that rank, then team order, then name.
export function searchAthletes(items, query, { max = ATHLETE_SEARCH_MAX } = {}) {
  const needle = foldSearchText(query);
  if (!needle) return { results: [], more: 0, total: 0 };
  const ranked = [];
  for (const item of items || []) {
    const hay = foldSearchText(item.name);
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    const wordStart = hay.split(" ").some((word) => word.startsWith(needle)) || hay.startsWith(needle);
    ranked.push({ item, rank: wordStart ? 0 : 1 });
  }
  ranked.sort((a, b) => a.rank - b.rank
    || (a.item.teamOrder ?? 0) - (b.item.teamOrder ?? 0)
    || String(a.item.name).localeCompare(String(b.item.name)));
  const total = ranked.length;
  return { results: ranked.slice(0, max).map((row) => row.item), more: Math.max(0, total - max), total };
}

// The name with the matching letters marked. Offsets are found in the folded
// text; accents fold to one code unit each, so offsets carry over for names
// whose folded length equals their own (otherwise the name is drawn unmarked).
export function highlightMatchHtml(name, query) {
  const text = String(name ?? "");
  const needle = foldSearchText(query);
  const folded = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!needle || folded.length !== text.length) return escapeHtml(text);
  const at = folded.indexOf(needle);
  if (at < 0) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, at))}<mark>${escapeHtml(text.slice(at, at + needle.length))}</mark>${escapeHtml(text.slice(at + needle.length))}`;
}

// The search field and its result list. `results` is the search's own output
// ({ results, more }); `emptySentence` is the caller's sentence for no match.
export function renderAthleteSwitcherSearchHtml({
  value = "",
  action = "athlete-switcher-search",
  placeholder = "Search athletes",
  results = null,
  activeIndex = 0,
  emptySentence = "",
  listId = "athlete-switcher-results",
  pickAction = "athlete-switcher-pick",
} = {}) {
  const has = String(value).trim() !== "";
  return `<div class="athlete-switcher-search">
    <input type="search" class="athlete-switcher-search-input" data-athlete-switcher-search="${escapeAttr(action)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${escapeAttr(placeholder)}"${has && results && results.results.length ? ` aria-controls="${escapeAttr(listId)}"` : ""}>
    <div class="athlete-switcher-results-host" data-athlete-switcher-results>${renderAthleteSwitcherResultsHtml({ value, results, activeIndex, emptySentence, listId, pickAction })}</div>
  </div>`;
}

// Only the result list: drawn again on every keystroke while the field itself (its caret, a phone's keyboard)
// stays untouched.
export function renderAthleteSwitcherResultsHtml({ value = "", results = null, activeIndex = 0, emptySentence = "", listId = "athlete-switcher-results", pickAction = "athlete-switcher-pick" } = {}) {
  const has = String(value).trim() !== "";
  let body = "";
  if (has && results) {
    if (!results.results.length) {
      body = `<p class="athlete-switcher-empty" role="status">${escapeHtml(emptySentence)}</p>`;
    } else {
      body = `<ul class="athlete-switcher-results" id="${escapeAttr(listId)}" role="listbox">${results.results.map((item, index) => {
        const image = item.imageUrl ? renderImage(item.imageUrl, "builder-batch-photo") : "";
        const teams = (item.teamLabels || []).map((team) => `<span class="athlete-switcher-result-team">${team.colorStyle ? `<span class="athlete-switcher-dot athlete-switcher-dot-inline" style="${escapeAttr(team.colorStyle)}" aria-hidden="true"></span>` : ""}${escapeHtml(team.name)}</span>`).join("");
        return `<li role="option" aria-selected="${index === activeIndex}"><button type="button" class="athlete-switcher-result${index === activeIndex ? " is-active" : ""}" data-action="${escapeAttr(pickAction)}" data-athlete-key="${escapeAttr(item.key)}"><span class="builder-batch-avatar"><span>${escapeHtml(initialsFor(item.name))}</span>${image}</span><span class="athlete-switcher-result-name">${highlightMatchHtml(item.name, value)}</span>${teams}</button></li>`;
      }).join("")}</ul>${results.more ? `<p class="athlete-switcher-more">and ${results.more} more — keep typing</p>` : ""}`;
    }
  }
  return body;
}
