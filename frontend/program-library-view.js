import { renderCopyPlanModal } from "./builder-modals.js";
import { renderCoachDetailModalHtml } from "./coach-profiles.js";
import { renderPlanMoreMenu } from "./plan-actions-view.js";
import {
  duplicateTemplateNames,
  programPriceLabel,
  renderProgramInfoModal,
  renderTemplateFiltersHtml,
  renderTemplateLibraryResultsHtml,
  templateCategoryLabel,
  templateCategoryOptions,
  templateFilterOptionMatches,
  templateFilterSuggestions,
  templateSecondaryLabel,
} from "./program-library.js";
import { renderTemplatePreviewModalHtml } from "./program-preview.js";
import { clean, escapeAttr, escapeHtml } from "./utils.js";

export function renderTemplateToolbarHtml(templates, selectedTemplateId) {
  const duplicateNames = duplicateTemplateNames(templates);
  return `
    <div class="chip-row template-toolbar">
      ${templates.map((template) => `
        <button class="chip ${template.plan_id === selectedTemplateId ? "is-active" : ""}" data-template-id="${escapeAttr(template.plan_id)}">
          <span class="chip-main">${escapeHtml(template.plan_name)}</span>
          ${templateSecondaryLabel(template, duplicateNames) ? `<span class="chip-sub">${escapeHtml(templateSecondaryLabel(template, duplicateNames))}</span>` : ""}
        </button>
      `).join("")}
      ${selectedTemplateId ? renderPlanMoreMenu(selectedTemplateId, "template") : ""}
    </div>
  `;
}

export function renderTemplateDetailHtml({ groups, isMicrocycle, renderNodeButton, renderProgramDayCard, selected, state }) {
  return `
    <section class="content-section">
      <section class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Template</p>
            <h3>${escapeHtml(selected.plan_name)}</h3>
            <p class="muted">${escapeHtml([templateCategoryLabel(selected), programPriceLabel(selected)].filter(Boolean).join(" - "))}</p>
          </div>
          <div class="builder-source-actions">${renderPlanMoreMenu(selected.plan_id, "template")}</div>
        </div>
        ${isMicrocycle
          ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
          : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
      </section>
    </section>
    ${renderCopyPlanModal(state)}
  `;
}

export function renderTemplateLibraryPageHtml({
  coaches,
  currentUser,
  programInfo,
  selectedTemplateId,
  state,
  templates,
  templateFiltersHtml,
  templatePreviewHtml,
}) {
  return `
    <section class="content-section program-library-page">
      <div class="program-library-head">
        <p class="muted" data-template-count>${templates.length} ${templates.length === 1 ? "program" : "programs"}</p>
      </div>
      ${templateFiltersHtml}
      <div class="program-library-shelves" data-template-results>
        ${renderTemplateLibraryResultsHtml(templates, selectedTemplateId)}
      </div>
    </section>
    ${templatePreviewHtml}
    ${renderProgramInfoModal(programInfo)}
    ${renderCoachDetailModalHtml(coaches, currentUser)}
    ${renderCopyPlanModal(state)}
  `;
}

export function renderTemplateLibraryResultsOnlyHtml(templates, selectedTemplateId) {
  return renderTemplateLibraryResultsHtml(templates, selectedTemplateId);
}

export function renderTemplateFiltersViewHtml({ activeScope, filters, lastTemplates, options, scopeLabel, scopes, showAdminFilters }) {
  const tagPrefix = clean(filters.tag).toLowerCase();
  const visibleTags = tagPrefix ? (options.tags || []).filter((tag) => templateFilterOptionMatches(tag, tagPrefix)) : (options.tags || []);
  const categories = templateCategoryOptions(options, lastTemplates);
  const categoryPrefix = clean(filters.category).toLowerCase();
  const visibleCategories = categoryPrefix ? categories.filter((category) => templateFilterOptionMatches(category, categoryPrefix)) : categories;
  const creatorOptions = templateFilterSuggestions("creator", options, lastTemplates);
  const creatorPrefix = clean(filters.creator).toLowerCase();
  const visibleCreators = creatorPrefix ? creatorOptions.filter((creator) => templateFilterOptionMatches(creator, creatorPrefix)) : creatorOptions;
  const clubOptions = templateFilterSuggestions("club", options, lastTemplates);
  const clubPrefix = clean(filters.club).toLowerCase();
  const visibleClubs = clubPrefix ? clubOptions.filter((club) => templateFilterOptionMatches(club, clubPrefix)) : clubOptions;
  return renderTemplateFiltersHtml({
    filters,
    options,
    showAdminFilters,
    scopes,
    activeScope,
    scopeLabel,
    visibleTags,
    visibleCategories,
    creatorOptions,
    visibleCreators,
    clubOptions,
    visibleClubs,
  });
}

export function renderTemplatePreviewModalViewHtml(data) {
  return renderTemplatePreviewModalHtml({
    ...data,
    renderPlanMoreMenu,
  });
}
