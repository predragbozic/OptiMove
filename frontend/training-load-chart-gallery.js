import { escapeHtml } from './utils.js';
import { chartPresentation, interactiveChartPresentation } from './training-load-chart-composer.js';

// Original schematic illustrations; decorative, never preview data.
const drawings = {
  scatter: '<path d="M14 10v50h96"/><circle cx="30" cy="46" r="3"/><circle cx="48" cy="34" r="3"/><circle cx="67" cy="40" r="3"/><circle cx="86" cy="20" r="3"/>',
  combined: '<path d="M14 10v50h96M25 59V36h16v23m12 0V19h16v40m12 0V29h16v30M22 47l20-17 20 9 20-23 22 8"/>',
  table: '<rect x="12" y="10" width="96" height="52" rx="3"/><path d="M12 26h96M12 44h96M44 10v52M76 10v52"/>',
  kpi: '<rect x="16" y="10" width="88" height="52" rx="6"/><path d="M30 24h28M30 47h12V34H30v13m21 0h12V30H51v17m21-4 8-8 8 4 10-12"/>',
  line_chart: '<path d="M14 10v50h96M22 47l20-17 20 9 20-23 22 8"/>',
  bar_chart: '<path d="M14 10v50h96"/><path d="M25 59V36h16v23m12 0V19h16v40m12 0V29h16v30"/>',
  area: '<path d="M22 60V47l20-17 20 9 20-23 22 8v36Z" fill="currentColor" fill-opacity=".18"/><path d="M14 10v50h96M22 47l20-17 20 9 20-23 22 8"/>',
  'horizontal-bar': '<path d="M14 10v52h96M15 17h58v10H15m0 9h84v10H15m0 9h40v7H15"/>',
  heatmap: '<path d="M14 10v52h96"/><g fill="currentColor"><path d="M23 15h17v12H23zM65 31h17v12H65zM86 47h17v12H86z" fill-opacity=".2"/><path d="M44 15h17v12H44zM86 31h17v12H86zM23 47h17v12H23z" fill-opacity=".45"/><path d="M65 15h17v12H65zM23 31h17v12H23zM44 47h17v12H44z" fill-opacity=".7"/><path d="M86 15h17v12H86zM44 31h17v12H44zM65 47h17v12H65z"/></g>',
};
export const chartGalleryChoices = [
  { id: 'table', type: 'table', name: 'Table', description: 'Inspect returned values and data quality row by row.' },
  { id: 'kpi', type: 'kpi', name: 'KPI', description: 'Highlight the returned metric value for the selected group and period.' },
  { id: 'line_chart', type: 'line_chart', name: 'Line chart', description: 'Follow changes across the selected periods or groups.' },
  { id: 'bar_chart', type: 'bar_chart', name: 'Vertical bar', description: 'Compare values across periods or groups with upright bars.' },
  { id: 'area', type: 'line_chart', variant: 'area', name: 'Area', description: 'Follow a line with a filled area to make its shape easier to read.' },
  { id: 'horizontal-bar', type: 'bar_chart', variant: 'horizontal-bar', name: 'Horizontal bar', description: 'Compare groups with sideways bars and room for category labels.' },
  { id: 'combined', type: 'line_chart', variant: 'combined', name: 'Bar + line', description: 'Use two numeric metrics: bars on the left axis and a line on the right, in Advanced settings.' },
  { id: 'heatmap', type: 'bar_chart', variant: 'heatmap', name: 'Heatmap', description: 'Compare one numeric metric across athletes and days or weeks. Color shows magnitude only.' },
  { id: 'scatter', type: 'line_chart', variant: 'scatter', name: 'Scatter', description: 'Compare two numeric metrics with X and Y axes in Advanced settings.' },
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
const combinedGuidance = 'Open the Advanced editor to change a Bar + line display and preserve its two-metric settings.';
const combinedGuidanceId = 'tl-simple-gallery-combined-guidance';
export function galleryUnavailable(model, choice) {
  if (choice.id !== 'scatter' && [model.savedPresentation, galleryPresentation(model)].some(value => value?.chartVariant === 'scatter' && chartPresentation(value).mode === 'enhanced')) return 'Open the Advanced editor to change a Scatter display and preserve its two-metric settings.';
  if (choice.id !== 'combined' && [model.savedPresentation, galleryPresentation(model)].some(value => value?.chartVariant === 'combined' || value?.chartComposition === 'metrics-v1')) return combinedGuidance;
  if (!(model.capabilities?.widgetTypes ?? []).some(type => (typeof type === 'string' ? type : type.key) === choice.type && type.is_active !== false)) return 'This display type is currently unavailable.';
  if (choice.type !== 'table' && model.selectedMetric?.value_type && model.selectedMetric.value_type !== 'numeric') return 'Choose a numeric metric to use this display.';
  if (choice.id === 'scatter') {
    if (!model.widgetId) return 'Create a line chart first, then add the second metric in Advanced settings.';
    if (model.capabilities?.capabilities?.scatterCharts !== true || model.pageScatterAvailable !== true) return 'Scatter is not available on this dashboard yet.';
    if (!['line_chart', 'bar_chart'].includes(model.savedWidgetType ?? model.draft?.view?.type)) return 'Create a line chart first, then add the second metric in Advanced settings.';
    if (!['day', 'week'].includes(model.draft?.view?.groupBy ?? model.savedGroupBy)) return 'Scatter supports day or week only.';
    if (!knownPresentation(galleryPresentation(model))) return 'Open the Advanced editor to preserve saved presentation settings.';
    return '';
  }
  if (choice.id === 'combined') {
    if (!model.widgetId) return 'Create a line chart first, then add the second metric in Advanced settings.';
    if ((model.capabilities?.capabilities?.combinedCharts !== true || model.pageCombinedAvailable === false)) return 'Bar + line is not available on this dashboard yet.';
    if (!['line_chart', 'bar_chart'].includes(model.savedWidgetType ?? model.draft?.view?.type)) return 'Create a line chart first, then add the second metric in Advanced settings.';
    if (!['day', 'week'].includes(model.draft?.view?.groupBy)) return 'Bar + line supports day or week only.';
    if (!knownPresentation(galleryPresentation(model))) return 'Open the Advanced editor to preserve saved presentation settings.';
    return '';
  }
  if (choice.variant && !model.capabilities?.capabilities?.chartVariants?.includes(choice.variant)) return 'This chart variant is not available on this dashboard yet.';
  if (choice.id === 'heatmap' && !['day', 'week'].includes(model.draft?.view?.groupBy)) return 'Heatmap supports day or week only. Choose day or week before selecting Heatmap.';
  if (gallerySelection(model) !== choice.id && (!knownPresentation(galleryPresentation(model)) || model.savedPresentation != null && !['line_chart', 'bar_chart'].includes(choice.type) && galleryVariant(model) !== 'heatmap')) return 'Open the Advanced editor to change this display and preserve saved presentation settings.';
  return '';
}
export function applyGalleryChoice(draft, model, id) {
  const choice = chartGalleryChoices.find(item => item.id === id);
  if (['combined', 'scatter'].includes(choice?.id)) return; // Advanced handoff only; Simple remains single-series.
  if (!choice || galleryUnavailable(model, choice) || gallerySelection(model) === id) return;
  const previous = galleryPresentation(model), previousVariant = previous?.chartVariant;
  draft.view.type = choice.type;
  if (choice.variant || previousVariant) {
    if (['line_chart', 'bar_chart'].includes(choice.type)) {
      const value = structuredClone(previous ?? interactiveChartPresentation(draft.view.groupBy, choice.variant).value);
      const generated = interactiveChartPresentation(draft.view.groupBy, choice.variant).value;
      if (choice.variant === 'heatmap' || previousVariant === 'heatmap') {
        // Composition must follow the selected display, never the saved sidecar.
        delete value.chartComposition;
        if (generated.chartComposition) value.chartComposition = generated.chartComposition;
      }
      delete value.chartVariant;
      if (choice.variant) {
        value.chartVariant = choice.variant;
        value.chartInteractions ??= interactiveChartPresentation(draft.view.groupBy, choice.variant).value.chartInteractions;
      }
      if (choice.variant === 'heatmap') value.chartInteractions.yAxis = { mode: 'auto' };
      draft.presentation = { mode: 'replace', value };
    } else if (previousVariant === 'heatmap') draft.presentation = { mode: 'clear' };
    else if (model.widgetId) draft.presentation = { mode: 'preserve' };
    else delete draft.presentation;
  } else if (!['line_chart', 'bar_chart'].includes(choice.type) && draft.presentation?.mode === 'replace') {
    if (model.widgetId) draft.presentation = { mode: 'preserve' };
    else delete draft.presentation;
  }
}
export function renderChartGallery(model, locked = false) {
  const selected = gallerySelection(model);
  const choices = chartGalleryChoices.map(choice => ({ choice, reason: galleryUnavailable(model, choice) }));
  const sharedGuidance = choices.some(({ reason }) => reason === combinedGuidance);
  return `<fieldset class="tl-simple-view-options"${locked ? ' disabled' : ''}><legend>Display</legend>${choices.map(({ choice, reason }) => {
    const prefix = `tl-simple-gallery-${choice.id}`, sharedReason = reason === combinedGuidance;
    return `<label class="tl-simple-chart-card"><input type="radio" name="training-load-simple-view" data-action="training-load-simple-view" value="${choice.id}"${selected === choice.id ? ' checked' : ''}${reason ? ' disabled' : ''} aria-labelledby="${prefix}-name" aria-describedby="${prefix}-description${reason ? ` ${sharedReason ? combinedGuidanceId : `${prefix}-reason`}` : ''}"><span class="tl-simple-chart-card-body"><svg viewBox="0 0 120 72" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${drawings[choice.id]}</svg><strong id="${prefix}-name">${choice.name}</strong><span id="${prefix}-description">${choice.description}</span>${reason && !sharedReason ? `<span class="tl-simple-chart-reason" id="${prefix}-reason">${escapeHtml(reason)}</span>` : ''}</span></label>`;
  }).join('')}</fieldset>${sharedGuidance ? `<p class="tl-simple-message" id="${combinedGuidanceId}">${combinedGuidance}</p>` : ''}${!knownPresentation(galleryPresentation(model)) ? '<p class="tl-simple-message">Saved presentation settings are preserved. Open the Advanced editor to change the display.</p>' : ''}`;
}
