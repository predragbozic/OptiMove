import { escapeHtml } from './utils.js';
import { chartPresentation, interactiveChartPresentation } from './training-load-chart-composer.js';

// Original schematic illustrations; decorative, never preview data.
const drawings = {
  table: '<rect x="12" y="10" width="96" height="52" rx="3"/><path d="M12 26h96M12 44h96M44 10v52M76 10v52"/>',
  kpi: '<rect x="16" y="10" width="88" height="52" rx="6"/><path d="M30 24h28M30 47h12V34H30v13m21 0h12V30H51v17m21-4 8-8 8 4 10-12"/>',
  line_chart: '<path d="M14 10v50h96M22 47l20-17 20 9 20-23 22 8"/>',
  bar_chart: '<path d="M14 10v50h96"/><path d="M25 59V36h16v23m12 0V19h16v40m12 0V29h16v30"/>',
  area: '<path d="M22 60V47l20-17 20 9 20-23 22 8v36Z" fill="currentColor" fill-opacity=".18"/><path d="M14 10v50h96M22 47l20-17 20 9 20-23 22 8"/>',
  'horizontal-bar': '<path d="M14 10v52h96M15 17h58v10H15m0 9h84v10H15m0 9h40v7H15"/>',
};
export const chartGalleryChoices = [
  { id: 'table', type: 'table', name: 'Table', description: 'Inspect returned values and data quality row by row.' },
  { id: 'kpi', type: 'kpi', name: 'KPI', description: 'Highlight the returned metric value for the selected group and period.' },
  { id: 'line_chart', type: 'line_chart', name: 'Line chart', description: 'Follow changes across the selected periods or groups.' },
  { id: 'bar_chart', type: 'bar_chart', name: 'Vertical bar', description: 'Compare values across periods or groups with upright bars.' },
  { id: 'area', type: 'line_chart', variant: 'area', name: 'Area', description: 'Follow a line with a filled area to make its shape easier to read.' },
  { id: 'horizontal-bar', type: 'bar_chart', variant: 'horizontal-bar', name: 'Horizontal bar', description: 'Compare groups with sideways bars and room for category labels.' },
];
export function galleryPresentation(model) {
  const intent = model.draft?.presentation;
  return intent?.mode === 'replace' ? intent.value : intent?.mode === 'clear' ? null : model.savedPresentation ?? null;
}
export function galleryVariant(model) { return galleryPresentation(model)?.chartVariant; }
function knownPresentation(value) {
  return value == null || chartPresentation(value).mode === 'enhanced';
}
export function gallerySelection(model) {
  const type = model.draft?.view?.type ?? 'table', variant = galleryVariant(model);
  return chartGalleryChoices.find(choice => choice.type === type && choice.variant === variant)?.id;
}
export function galleryUnavailable(model, choice) {
  if (!(model.capabilities?.widgetTypes ?? []).some(type => (typeof type === 'string' ? type : type.key) === choice.type && type.is_active !== false)) return 'This display type is currently unavailable.';
  if (choice.type !== 'table' && model.selectedMetric?.value_type && model.selectedMetric.value_type !== 'numeric') return 'Choose a numeric metric to use this display.';
  if (choice.variant && !model.capabilities?.capabilities?.chartVariants?.includes(choice.variant)) return 'This chart variant is not available on this dashboard yet.';
  if (gallerySelection(model) !== choice.id && (!knownPresentation(galleryPresentation(model)) || model.savedPresentation != null && !['line_chart', 'bar_chart'].includes(choice.type))) return 'Open the Advanced editor to change this display and preserve saved presentation settings.';
  return '';
}
export function applyGalleryChoice(draft, model, id) {
  const choice = chartGalleryChoices.find(item => item.id === id);
  if (!choice || galleryUnavailable(model, choice) || gallerySelection(model) === id) return;
  const previous = galleryPresentation(model), previousVariant = previous?.chartVariant;
  draft.view.type = choice.type;
  if (choice.variant || previousVariant) {
    if (['line_chart', 'bar_chart'].includes(choice.type)) {
      const value = structuredClone(previous ?? interactiveChartPresentation(draft.view.groupBy, choice.variant).value);
      delete value.chartVariant;
      if (choice.variant) {
        value.chartVariant = choice.variant;
        value.chartInteractions ??= interactiveChartPresentation(draft.view.groupBy, choice.variant).value.chartInteractions;
      }
      draft.presentation = { mode: 'replace', value };
    } else if (model.widgetId) draft.presentation = { mode: 'preserve' };
    else delete draft.presentation;
  } else if (!['line_chart', 'bar_chart'].includes(choice.type) && draft.presentation?.mode === 'replace') {
    if (model.widgetId) draft.presentation = { mode: 'preserve' };
    else delete draft.presentation;
  }
}
export function renderChartGallery(model, locked = false) {
  const selected = gallerySelection(model);
  return `<fieldset class="tl-simple-view-options"${locked ? ' disabled' : ''}><legend>Display</legend>${chartGalleryChoices.map(choice => {
    const reason = galleryUnavailable(model, choice), prefix = `tl-simple-gallery-${choice.id}`;
    return `<label class="tl-simple-chart-card"><input type="radio" name="training-load-simple-view" data-action="training-load-simple-view" value="${choice.id}"${selected === choice.id ? ' checked' : ''}${reason ? ' disabled' : ''} aria-labelledby="${prefix}-name" aria-describedby="${prefix}-description${reason ? ` ${prefix}-reason` : ''}"><span class="tl-simple-chart-card-body"><svg viewBox="0 0 120 72" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${drawings[choice.id]}</svg><strong id="${prefix}-name">${choice.name}</strong><span id="${prefix}-description">${choice.description}</span>${reason ? `<span class="tl-simple-chart-reason" id="${prefix}-reason">${escapeHtml(reason)}</span>` : ''}</span></label>`;
  }).join('')}</fieldset>${!knownPresentation(galleryPresentation(model)) ? '<p class="tl-simple-message">Saved presentation settings are preserved. Open the Advanced editor to change the display.</p>' : ''}`;
}
