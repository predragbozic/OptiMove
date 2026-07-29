import { escapeAttr } from "./utils.js";

const ICON_PENCIL = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z"></path><path d="M13 7l4 4"></path></svg>`;
const ICON_COPY = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path></svg>`;

export function renderPlanMoreMenu(planId, objectType) {
  if (document.body.classList.contains("athlete-mode")) return "";
  const isTemplate = objectType === "template";
  const isWeekly = objectType === "weekly";
  const objectLabel = isTemplate ? "template" : isWeekly ? "weekly plan" : "program";
  const summaryClass = isTemplate ? "plain-button compact-button" : "plain-button icon-button";
  const summaryContent = isTemplate ? "Editing" : `<span class="button-icon">...</span>`;
  return `
    <details class="plan-more-menu">
      <summary class="${summaryClass}" aria-label="${objectLabel} actions" title="${objectLabel} actions">${summaryContent}</summary>
      <div class="plan-more-menu-popover">
        <button type="button" data-action="builder-edit-plan" data-plan-id="${escapeAttr(planId)}">${ICON_PENCIL}<span>Edit</span></button>
        <button type="button" data-action="builder-duplicate-plan" data-plan-id="${escapeAttr(planId)}" data-plan-type="${isWeekly ? "weekly" : "program"}">${ICON_COPY}<span>Copy</span></button>
        <button class="danger-action" type="button" data-action="builder-delete-source-plan" data-plan-id="${escapeAttr(planId)}" data-object-label="${objectLabel}">${ICON_TRASH}<span>Delete</span></button>
      </div>
    </details>
  `;
}
