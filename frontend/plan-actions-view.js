import { escapeAttr } from "./utils.js";

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
        <button type="button" data-action="builder-edit-plan" data-plan-id="${escapeAttr(planId)}">Edit ${objectLabel}</button>
        <button type="button" data-action="builder-duplicate-plan" data-plan-id="${escapeAttr(planId)}" data-plan-type="${isWeekly ? "weekly" : "program"}">Edit copy</button>
        <button class="danger-action" type="button" data-action="builder-delete-source-plan" data-plan-id="${escapeAttr(planId)}" data-object-label="${objectLabel}">Delete ${objectLabel}</button>
      </div>
    </details>
  `;
}
