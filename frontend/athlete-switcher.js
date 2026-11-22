// The athlete switcher (K6 contract section 1): ‹, the photo pills, ›. One
// component for the Builder's batch switcher, the central calendar and the
// Weekly plan header. Pure functions, no state of its own. The pills keep the
// Builder's builder-batch-* classes, so there is one CSS, not two; what the
// Builder does not use (the All pill, the team dot, the group label, the
// "not in this session" mark, a label on the strip) is drawn only when its
// argument is given, so the Builder's markup stays byte for byte as it was
// (frontend/tests/builder-batch-switcher-golden.test.mjs).
import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, initialsFor } from "./utils.js";

// A club's "All groups" strip shows every athlete only up to this many (F3,
// Q9: a constant, changed by a pull request if the pilot shows another number).
export const ATHLETE_SWITCHER_ALL_GROUPS_LIMIT = 60;
// The search shows at most this many results (contract 2.6).
export const ATHLETE_SWITCHER_SEARCH_LIMIT = 8;
// The search is drawn once a strip holds more than this many athletes.
export const ATHLETE_SWITCHER_SEARCH_FROM = 8;

// "Ana K." — the rule the Builder's pills have always used.
export function athleteCaption(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : name;
}

// items: [{ key, name, caption?, imageUrl?, teamColorStyle?, groupLabel?, mark? }]
//   teamColorStyle is markup the caller built (` style="--cc-team-color: …"`), never user text.
//   mark: a short sign drawn on the pill ("–", not in this session) with markLabel for the screen reader.
// allItem: { label, caption } - a first pill whose key is "".
// wrapArrows: false disables ‹ on the first pill and › on the last (no wrap).
export function renderAthleteSwitcherStripHtml({ items = [], currentKey = "", action, keyAttr, allItem = null, ariaLabel = "", wrapArrows = false } = {}) {
  const pills = allItem ? [{ key: "", name: allItem.label, caption: allItem.caption, isAll: true }, ...items] : items;
  const index = pills.findIndex((pill) => String(pill.key) === String(currentKey ?? ""));
  const at = (i) => (wrapArrows && pills.length ? pills[(i + pills.length) % pills.length] : pills[i]);
  const previous = index < 0 ? undefined : at(index - 1);
  const next = index < 0 ? undefined : at(index + 1);
  const keyOf = (pill) => escapeAttr(pill?.key ?? "");
  const pillsLabel = ariaLabel ? ` role="group" aria-label="${escapeAttr(ariaLabel)}"` : "";
  return `<div class="builder-batch-buttons">
          <button class="plain-button icon-button" type="button" data-action="${escapeAttr(action)}" ${keyAttr}="${keyOf(previous)}" ${previous ? "" : "disabled"} aria-label="Previous athlete"><span class="button-icon">&lt;</span></button>
          <div class="builder-batch-pills"${pillsLabel}>
            ${pills.map((pill, i) => {
              const name = pill.name;
              const caption = pill.caption ?? athleteCaption(name);
              const label = pill.mark && pill.markLabel ? `${name}, ${pill.markLabel}` : name;
              return `${pill.groupLabel ? `
              <span class="athlete-switcher-group-label">${escapeHtml(pill.groupLabel)}</span>` : ""}
              <button class="builder-batch-pill ${i === index ? "is-active" : ""}${pill.isAll ? " athlete-switcher-all" : ""}" type="button" data-action="${escapeAttr(action)}" ${keyAttr}="${keyOf(pill)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" aria-pressed="${i === index}">
                <span class="builder-batch-avatar"><span>${escapeHtml(pill.isAll ? allItem.caption : initialsFor(name))}</span>${pill.imageUrl ? renderImage(pill.imageUrl, "builder-batch-photo") : ""}${pill.teamColorStyle ? `<span class="athlete-switcher-dot"${pill.teamColorStyle} aria-hidden="true"></span>` : ""}${pill.mark ? `<span class="athlete-switcher-mark" aria-hidden="true">${escapeHtml(pill.mark)}</span>` : ""}</span>
                <span class="builder-batch-caption">${escapeHtml(caption)}</span>
              </button>
            `; }).join("")}
          </div>
          <button class="plain-button icon-button" type="button" data-action="${escapeAttr(action)}" ${keyAttr}="${keyOf(next)}" ${next ? "" : "disabled"} aria-label="Next athlete"><span class="button-icon">&gt;</span></button>
        </div>`;
}

// Keeps the chosen pill in view inside its strip (F1, phones): only the strip
// scrolls, never the page.
export function athleteSwitcherScrollIntoView(root) {
  for (const pills of root?.querySelectorAll?.(".builder-batch-pills") || []) {
    const active = pills.querySelector(".builder-batch-pill.is-active");
    if (!active || typeof pills.scrollTo !== "function") continue;
    const left = active.offsetLeft - (pills.clientWidth - active.offsetWidth) / 2;
    pills.scrollTo({ left: Math.max(0, left), behavior: "auto" });
  }
}

// Case- and accent-insensitive text for matching (contract 2.6).
export function athleteSearchFold(text) {
  return String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// The search over `list` ([{ key, name, teamIds?, rank? }]), in memory only.
// A match at the start of a word of the name first, then anywhere; then by
// `rank` (the caller's team order), then by name.
export function athleteSwitcherSearch(list, query) {
  const q = athleteSearchFold(query).trim();
  if (!q) return { results: [], more: 0 };
  const scored = [];
  for (const entry of list) {
    const folded = athleteSearchFold(entry.name);
    const at = folded.indexOf(q);
    if (at < 0) continue;
    const wordStart = folded.split(/\s+/).some((word) => word.startsWith(q));
    scored.push({ entry, score: wordStart ? 0 : 1, at });
  }
  scored.sort((a, b) => a.score - b.score || (a.entry.rank ?? 0) - (b.entry.rank ?? 0) || a.entry.name.localeCompare(b.entry.name));
  const results = scored.slice(0, ATHLETE_SWITCHER_SEARCH_LIMIT).map((row) => row.entry);
  return { results, more: Math.max(0, scored.length - results.length) };
}

// The matching letters of `name` marked (escaped), the first match only.
export function athleteSearchHighlightHtml(name, query) {
  const q = athleteSearchFold(query).trim();
  const text = String(name || "");
  if (!q) return escapeHtml(text);
  // Fold character by character so an index of the folded name maps back to the name.
  const map = [];
  let folded = "";
  for (let i = 0; i < text.length; i += 1) {
    const f = athleteSearchFold(text[i]);
    for (let j = 0; j < f.length; j += 1) map.push(i);
    folded += f;
  }
  const at = folded.indexOf(q);
  if (at < 0) return escapeHtml(text);
  const start = map[at];
  const end = map[at + q.length - 1] + 1;
  return `${escapeHtml(text.slice(0, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>${escapeHtml(text.slice(end))}`;
}

// The search's results under the field (drawn again alone while the coach types, so the field, its caret and a
// phone's keyboard stay). results: [{ key, name, imageUrl?, detailHtml? }] (detailHtml is markup the caller built from
// escaped names: the team and its dot).
export function renderAthleteSwitcherSearchResultsHtml({ value = "", action, results = [], more = 0, activeIndex = -1, emptySentence = "", keyAttr = "data-athlete-key", id = "athlete-switcher-search" } = {}) {
  const typed = String(value || "").trim();
  if (!typed) return "";
  const listId = `${id}-results`;
  if (!results.length) return `<p class="athlete-switcher-empty" role="status">${escapeHtml(emptySentence)}</p>`;
  const rows = results.map((row, i) => `<li role="option" id="${escapeAttr(`${listId}-${i}`)}" aria-selected="${i === activeIndex}"><button type="button" class="athlete-switcher-result${i === activeIndex ? " is-active" : ""}" data-action="${escapeAttr(action)}" ${keyAttr}="${escapeAttr(row.key)}" tabindex="-1"><span class="builder-batch-avatar"><span>${escapeHtml(initialsFor(row.name))}</span>${row.imageUrl ? renderImage(row.imageUrl, "builder-batch-photo") : ""}</span><span class="athlete-switcher-result-name">${athleteSearchHighlightHtml(row.name, typed)}</span>${row.detailHtml || ""}</button></li>`).join("");
  return `<ul class="athlete-switcher-results" id="${escapeAttr(listId)}" role="listbox">${rows}</ul>${more > 0 ? `<p class="athlete-switcher-more">and ${more} more — keep typing</p>` : ""}`;
}

// The search field and its results.
export function renderAthleteSwitcherSearchHtml({ value = "", inputAction, placeholder = "Search athletes", focusKey = "", id = "athlete-switcher-search", ...results } = {}) {
  const listId = `${id}-results`;
  const typed = String(value || "").trim();
  const activeIndex = results.activeIndex ?? -1;
  return `<div class="athlete-switcher-search">
    <input type="search" class="athlete-switcher-search-input" data-action="${escapeAttr(inputAction)}"${focusKey ? ` data-cc-focus="${escapeAttr(focusKey)}"` : ""} value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" aria-label="${escapeAttr(placeholder)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${typed && (results.results || []).length ? "true" : "false"}" aria-controls="${escapeAttr(listId)}"${activeIndex >= 0 && (results.results || [])[activeIndex] ? ` aria-activedescendant="${escapeAttr(`${listId}-${activeIndex}`)}"` : ""}>
    <div class="athlete-switcher-search-body" id="${escapeAttr(`${id}-body`)}">${renderAthleteSwitcherSearchResultsHtml({ value, id, ...results })}</div>
  </div>`;
}
