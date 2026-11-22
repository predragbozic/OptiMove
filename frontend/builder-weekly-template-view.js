// Weekly program templates in the Builder (docs/ai/weekly-program-template-plan.md):
// part WT-A: the week strip. Pure template strings; the actions are
// builder-weekly-template-actions.js.
import { escapeHtml } from "./utils.js";

export const isWeeklyTemplateDraft = (draft) => draft?.plan?.planType === "program" && draft?.plan?.templateKind === "weekly";
export const weekOfBlock = (block) => Math.floor((Number(block.index) - 1) / 7) + 1;
export const dayOfBlock = (block) => ((Number(block.index) - 1) % 7) + 1;

// The week on screen, kept inside the template's weeks.
export function currentTemplateWeek(state) {
  const count = Number(state.builder.draft?.plan?.weekCount) || 1;
  const week = Number(state.builder.templateWeek) || 1;
  return Math.min(Math.max(week, 1), count);
}

export function templateWeekBlocks(draft, week) {
  return (draft.blocks || []).filter((block) => weekOfBlock(block) === week).sort((a, b) => a.index - b.index);
}

const sessionCount = (draft, week) => templateWeekBlocks(draft, week).reduce((n, block) => n + (block.sessions || []).length, 0);

export function renderTemplateWeekStripHtml(state) {
  const draft = state.builder.draft;
  const count = Number(draft.plan.weekCount) || 1;
  const week = currentTemplateWeek(state);
  const busy = Boolean(state.builder.templateWeekBusy);
  const confirm = Number(state.builder.templateWeekDeleteConfirm) === week;
  const tabs = Array.from({ length: count }, (_, i) => i + 1).map((w) => {
    const n = sessionCount(draft, w);
    return `<button class="builder-week-tab${w === week ? " is-active" : ""}" type="button" role="tab" aria-selected="${w === week}" data-action="builder-tw-select-week" data-week="${w}">
      <strong>Week ${w}</strong><small>${n} session${n === 1 ? "" : "s"}</small></button>`;
  }).join("");
  return `
    <div class="builder-week-strip">
      <div class="builder-week-tabs" role="tablist" aria-label="Template weeks">
        ${tabs}
        <button class="builder-week-tab builder-week-add" type="button" data-action="builder-tw-add-week" ${busy || count >= 52 ? "disabled" : ""} aria-label="Add an empty week"><strong>+ Week</strong><small>Empty</small></button>
      </div>
      <div class="builder-week-actions" role="group" aria-label="Week ${week}">
        <button class="plain-button compact-button" type="button" data-action="builder-tw-duplicate-week" data-week="${week}" ${busy || count >= 52 ? "disabled" : ""}>Duplicate week ${week}</button>
        <button class="plain-button compact-button" type="button" data-action="builder-tw-move-week" data-week="${week}" data-to="${week - 1}" ${busy || week === 1 ? "disabled" : ""} aria-label="Move week ${week} earlier">&larr; Earlier</button>
        <button class="plain-button compact-button" type="button" data-action="builder-tw-move-week" data-week="${week}" data-to="${week + 1}" ${busy || week === count ? "disabled" : ""} aria-label="Move week ${week} later">Later &rarr;</button>
        ${count > 1 ? `<button class="plain-button compact-button danger-action" type="button" data-action="builder-tw-delete-week" data-week="${week}" ${busy ? "disabled" : ""}>Delete week ${week}</button>` : ""}
      </div>
      ${confirm ? `
        <div class="builder-week-confirm" role="alertdialog" aria-label="Delete week ${week}">
          <p>Delete week ${week}${sessionCount(draft, week) ? ` and its ${sessionCount(draft, week)} session${sessionCount(draft, week) === 1 ? "" : "s"}` : ""}? The weeks after it move up.</p>
          <div class="builder-week-confirm-actions">
            <button class="plain-button danger-action" type="button" data-action="builder-tw-delete-week-confirm" data-week="${week}">Delete week</button>
            <button class="plain-button" type="button" data-action="builder-tw-delete-week-cancel">Cancel</button>
          </div>
        </div>` : ""}
      ${state.builder.templateNotice ? `<p class="builder-tw-notice" role="status">${escapeHtml(state.builder.templateNotice)}</p>` : ""}
      ${state.builder.templateWeekError ? `<p class="builder-error" role="alert">${escapeHtml(state.builder.templateWeekError)}</p>` : ""}
    </div>
  `;
}
