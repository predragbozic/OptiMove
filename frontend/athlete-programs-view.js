import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, programInitials } from "./utils.js";

// feature/athlete-programs-profile: the athlete-only "Specific programs"
// picker, restyled as visual template cards matching Program Library's own
// card look (.program-library-card/-card-hit/-card-media/...), reusing
// its exact CSS rather than inventing a parallel card system. The coach
// side of this same tab (viewing an athlete's specific programs while
// managing them) keeps the original chip toolbar in app.js's
// renderProgramToolbar - this file is athlete-mode-only.
//
// Every field used here comes straight off GET
// /api/athletes/:athleteId/program-data?program=__all_programs__'s real
// response (see backend/src/utils/grouping.js's buildPrograms) - imageUrl/
// category/sessionCount/itemCount are real plans.v_plan_summary columns,
// not fabricated. cover image and category are confirmed empty for
// virtually every real assigned program today (only templates populate
// them), so the initials fallback is what most athletes will actually see
// - that's expected, not a bug.
//
// No price, marketplace actions, edit/review controls, or ownership UI are
// rendered - these are the athlete's own already-assigned programs, not a
// marketplace listing.

// Documented threshold: with 3 or fewer programs, a search box adds more
// UI than it saves (the whole list already fits without scrolling much),
// so it stays hidden. With more than 3, scanning by eye gets slow enough
// that search earns its place. Covered by
// athlete-programs-view.render.test.mjs.
export const ATHLETE_PROGRAMS_SEARCH_THRESHOLD = 3;

function filterPrograms(programs, searchQuery) {
  const query = (searchQuery || "").trim().toLowerCase();
  if (!query) return programs;
  return programs.filter((program) => (program.name || "").toLowerCase().includes(query));
}

function renderProgramCardHtml(program, isSelected) {
  const initials = programInitials(program.name || "");
  const media = program.imageUrl
    ? renderImage(program.imageUrl, "program-library-cover")
    : `<span class="program-library-card-icon">${escapeHtml(initials)}</span>`;
  const itemCount = Number(program.itemCount) || 0;
  const countLabel = itemCount > 0 ? `${itemCount} ${itemCount === 1 ? "item" : "items"}` : "";
  return `
    <article class="program-library-card athlete-program-card ${isSelected ? "is-selected" : ""}">
      <button class="program-library-card-hit" type="button" data-action="athlete-program-open" data-program-id="${escapeAttr(program.id)}">
        <span class="program-library-card-media">${media}</span>
        <span class="program-library-card-body">
          <span class="program-library-card-title">${escapeHtml(program.name || "Untitled program")}</span>
          ${program.category ? `<span class="program-library-card-sub">${escapeHtml(program.category)}</span>` : ""}
        </span>
        <span class="program-library-card-foot">
          ${countLabel ? `<span class="program-library-meta-primary"><span class="program-library-card-chip">${escapeHtml(countLabel)}</span></span>` : ""}
          <span class="text-action program-library-card-action">Open program</span>
        </span>
      </button>
    </article>
  `;
}

// Re-rendered on every keystroke by app.js's wiring - kept as its own
// function (and its own DOM container) specifically so the search input
// itself never gets replaced/re-created while typing, which would drop
// keyboard focus after every character.
export function renderAthleteProgramCardsRailHtml(programs, selectedProgramId, searchQuery) {
  const filtered = filterPrograms(programs, searchQuery);
  if (!filtered.length) {
    return `<p class="muted athlete-programs-no-match">No programs match your search.</p>`;
  }
  return `
    <div class="program-library-row athlete-program-cards-rail">
      ${filtered.map((program) => renderProgramCardHtml(program, program.id === selectedProgramId)).join("")}
    </div>
  `;
}

export function renderAthleteProgramsPanelHtml(programs, selectedProgramId, searchQuery) {
  if (!programs.length) return "";
  const showSearch = programs.length > ATHLETE_PROGRAMS_SEARCH_THRESHOLD;
  return `
    <div class="athlete-programs-panel">
      ${showSearch ? `
        <label class="search-field athlete-programs-search">
          <span>Search programs</span>
          <input type="search" placeholder="Program name" data-action="athlete-programs-search" value="${escapeAttr(searchQuery || "")}">
        </label>
      ` : ""}
      <div class="athlete-program-cards-rail-container">${renderAthleteProgramCardsRailHtml(programs, selectedProgramId, searchQuery)}</div>
    </div>
  `;
}
