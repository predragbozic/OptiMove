import { escapeAttr } from "./utils.js";

const collator = new Intl.Collator("sr-Latn", { sensitivity: "base", numeric: true });
const queries = new Map();
const name = (row) => String(row.athlete || row.name || row.full_name || row.display_name || "").trim();
const id = (row) => String(row.athlete_id ?? row.athleteId ?? row.source_external_id ?? row.id ?? "");
const normalize = (value) => String(value).toLocaleLowerCase("sr-Latn").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "dj");

export function sortAthletes(rows = []) {
  return [...rows].sort((a, b) => collator.compare(name(a), name(b)) || collator.compare(id(a), id(b)));
}

export function athleteMatches(row, query = "") {
  return normalize(`${name(row)} ${id(row)}`).includes(normalize(query.trim()));
}

export function matchingAthletes(rows, key) {
  return sortAthletes(rows).filter((row) => athleteMatches(row, queries.get(key) || ""));
}

export function clearAthleteFilters() { queries.clear(); }

export function athleteFilterAttrs(row, key) {
  return `data-athlete-filter-row="${escapeAttr(key)}" data-athlete-filter-text="${escapeAttr(`${name(row)} ${id(row)}`)}"${athleteMatches(row, queries.get(key) || "") ? "" : " hidden"}`;
}

export function renderAthleteFilter(key, rows) {
  const query = queries.get(key) || "";
  const empty = query && !rows.some((row) => athleteMatches(row, query));
  return `<label class="search-field athlete-list-search"><span>Search athletes</span><input type="search" data-athlete-filter="${escapeAttr(key)}" aria-label="Search athletes" placeholder="Name or ID" value="${escapeAttr(query)}"></label><p class="muted" role="status" data-athlete-filter-empty="${escapeAttr(key)}" ${empty ? "" : "hidden"}>No athletes match your search.</p>`;
}

// Filter only the rendered roster: no network request or form re-render per keystroke.
export function handleAthleteFilter(input) {
  const key = input.dataset.athleteFilter;
  queries.set(key, input.value);
  const scope = input.closest("[data-athlete-filter-scope]");
  if (!scope) return;
  let count = 0;
  for (const row of scope.querySelectorAll("[data-athlete-filter-row]")) {
    if (row.dataset.athleteFilterRow !== key) continue;
    row.hidden = !normalize(row.dataset.athleteFilterText).includes(normalize(input.value.trim()));
    if (!row.hidden) count++;
  }
  const empty = scope.querySelector("[data-athlete-filter-empty]");
  if (empty) empty.hidden = !input.value.trim() || count > 0;
  const toggle = scope.querySelector('[data-action="builder-toggle-select-all-athletes"]');
  if (toggle) {
    const visible = [...scope.querySelectorAll("[data-athlete-filter-row]")].filter((row) => !row.hidden);
    const checked = visible.length > 0 && visible.every((row) => row.classList.contains("is-selected"));
    toggle.disabled = !visible.length;
    toggle.classList.toggle("is-checked", checked);
    toggle.setAttribute("aria-label", checked ? "Uncheck all shown athletes" : "Check all shown athletes");
    const icon = toggle.querySelector("span");
    if (icon) icon.textContent = checked ? "\u2713" : "";
  }
}
