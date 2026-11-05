import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderChartGallery, applyGalleryChoice, chartGalleryChoices, gallerySelection } from '../training-load-chart-gallery.js';
import { simpleDraftFromWidget } from '../training-load-simple-controller.js';
import { renderSimpleEditorHtml } from '../training-load-simple-view.js';
import { chartPresentation } from '../training-load-chart-composer.js';

const model = () => ({ draft: { view: { type: 'table', groupBy: 'day' } }, selectedMetric: { value_type: 'numeric' }, capabilities: { widgetTypes: ['table','kpi','line_chart','bar_chart'], capabilities: { chartVariants: ['area','horizontal-bar'] } } });
const documentFor = html => new JSDOM(html).window.document;

test('seven native radio cards have distinct accessible names, descriptions and decorative original SVGs', () => {
  const m = model(), before = structuredClone(m), doc = documentFor(renderChartGallery(m));
  assert.equal(doc.querySelector('legend').textContent, 'Display');
  const radios = [...doc.querySelectorAll('input[type="radio"]')];
  assert.deepEqual(radios.map(input => input.value), chartGalleryChoices.map(choice => choice.id));
  assert.equal(new Set(radios.map(input => input.name)).size, 1);
  for (const [index, input] of radios.entries()) {
    assert.equal(doc.getElementById(input.getAttribute('aria-labelledby')).textContent, chartGalleryChoices[index].name);
    assert.ok(doc.getElementById(input.getAttribute('aria-describedby').split(' ')[0]).textContent.length > 25);
    assert.equal(input.disabled, input.value === 'combined');
    const svg = input.closest('label').querySelector('svg');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(svg.getAttribute('focusable'), 'false');
    assert.equal(svg.querySelectorAll('script, a, image, foreignObject, animate').length, 0);
  }
  assert.equal(radios.filter(input => input.checked).length, 1);
  assert.deepEqual(m, before);
});

test('absent and partial capability disable only unadvertised variants and associate the explanation', () => {
  for (const advertised of [undefined, [], ['area']]) {
    const m = model(); m.capabilities.capabilities.chartVariants = advertised;
    const doc = documentFor(renderChartGallery(m));
    for (const input of doc.querySelectorAll('input')) {
      const variant = ['area','horizontal-bar'].includes(input.value);
      const blocked = input.value === 'combined' || variant && !advertised?.includes(input.value);
      assert.equal(input.disabled, Boolean(blocked));
      if (blocked && input.value !== 'combined') {
        const reasonId = input.getAttribute('aria-describedby').split(' ').at(-1);
        assert.match(doc.getElementById(reasonId).textContent, /not available on this dashboard yet/);
      }
    }
  }
});

test('text and boolean metrics retain Table and explain the numeric gate on all other cards', () => {
  for (const value_type of ['text','boolean']) {
    const m = model(); m.selectedMetric.value_type = value_type;
    const doc = documentFor(renderChartGallery(m));
    for (const input of doc.querySelectorAll('input')) {
      assert.equal(input.disabled, input.value !== 'table');
      if (input.disabled) assert.match(input.closest('label').textContent, /numeric metric/);
    }
  }
});

test('save lock uses native fieldset disabling and inactive widget gates apply to both variants', () => {
  const m = model();
  assert.equal(documentFor(renderChartGallery(m, true)).querySelector('fieldset').disabled, true);
  m.capabilities.widgetTypes = [{ key: 'table', is_active: true }, { key: 'line_chart', is_active: false }, { key: 'bar_chart', is_active: false }, { key: 'kpi', is_active: true }];
  const doc = documentFor(renderChartGallery(m));
  for (const input of doc.querySelectorAll('input')) assert.equal(input.disabled, !['table','kpi'].includes(input.value));
});

test('variant replacement adds required interactions while preserving existing supported settings', () => {
  const m = model(); m.widgetId = 'saved'; m.savedPresentation = { schemaVersion: 1, chartComposition: 'athletes-v1' };
  m.draft.view.type = 'line_chart'; m.draft.presentation = { mode: 'preserve' };
  applyGalleryChoice(m.draft, m, 'area');
  assert.equal(chartPresentation(m.draft.presentation.value).mode, 'enhanced');
  assert.equal(m.draft.presentation.value.chartComposition, 'athletes-v1');
  assert.equal(m.savedPresentation.chartVariant, undefined);
  assert.equal(gallerySelection(m), 'area');
});

test('standard line and bar reselect preserve supported custom interactions and opaque sidecars exactly', () => {
  for (const type of ['line_chart','bar_chart']) for (const savedPresentation of [{ schemaVersion: 99, opaque: ['keep'] }, { schemaVersion: 1, chartInteractions: { yAxis: { mode: 'fixed', min: -5, max: 5 } } }]) {
    const m = model(); m.savedPresentation = savedPresentation; m.draft.view.type = type; m.draft.presentation = { mode: 'preserve' };
    const before = structuredClone(m);
    applyGalleryChoice(m.draft, m, type);
    assert.deepEqual(m, before);
  }
});


test('combined is a gated Advanced handoff and never mutates the Simple draft', () => {
  const m = model(); m.widgetId = 'saved'; m.draft.view.type = 'line_chart';
  m.capabilities.capabilities.combinedCharts = true;
  assert.equal(documentFor(renderChartGallery(m)).querySelector('[value="combined"]').disabled, false);
  const before = structuredClone(m); applyGalleryChoice(m.draft, m, 'combined'); assert.deepEqual(m, before);
  for (const cap of [undefined, false]) {
    m.capabilities.capabilities.combinedCharts = cap;
    assert.equal(documentFor(renderChartGallery(m)).querySelector('[value="combined"]').disabled, true);
  }
  delete m.widgetId;
  assert.match(renderChartGallery(m), /Create a line chart first, then add the second metric in Advanced settings./);
});


test('a combined widget with one surviving series reaches Simple display but all regular conversions require Advanced', () => {
  const config = { schemaVersion: 1, chartVariant: 'combined', chartComposition: 'metrics-v1', chartInteractions: { yAxis: { mode: 'auto' } } };
  const series = { id: 'first', built_in_series_key: 'rpe', resolution_status: 'resolved', axis: 'primary', data_scope_level: 'session', analytical_aggregation: 'avg' };
  const widget = { id: 'saved', widget_type: 'line_chart', title: 'Partial combined', group_by: 'day', presentation_config: config, series: [series] };
  assert.equal(simpleDraftFromWidget({ ...widget, series: [series, { ...series, id: 'second', axis: 'secondary' }] }, () => 'draft'), null, 'normal two-series widgets use the existing Advanced fallback');
  const m = model(); m.open = true; m.step = 3; m.widgetId = widget.id; m.savedPresentation = structuredClone(config);
  m.draft = simpleDraftFromWidget(widget, () => 'draft'); assert.ok(m.draft, 'one-series partial state has a Simple draft');
  m.capabilities.capabilities.combinedCharts = true;
  const doc = documentFor(renderSimpleEditorHtml(m));
  for (const choice of chartGalleryChoices.filter(choice => choice.id !== 'combined')) {
    const input = doc.querySelector(`input[value="${choice.id}"]`);
    assert.ok(input); assert.equal(input.disabled, true);
    const shared = doc.getElementById('tl-simple-gallery-combined-guidance');
    assert.ok(shared); assert.match(shared.textContent, /Advanced editor/);
    assert.ok(input.getAttribute('aria-describedby').split(' ').includes(shared.id));
    assert.equal(input.closest('label').querySelector('.tl-simple-chart-reason'), null);
    const before = structuredClone(m); applyGalleryChoice(m.draft, m, choice.id); assert.deepEqual(m, before);
  }
  const guidance = doc.getElementById('tl-simple-gallery-combined-guidance');
  assert.equal(doc.body.textContent.split(guidance.textContent).length - 1, 1, 'combined guidance is rendered once');
  assert.equal(doc.querySelector('input[value="combined"]').disabled, false, 'combined remains an Advanced handoff');
  m.capabilities.capabilities.combinedCharts = false;
  const unavailable = documentFor(renderChartGallery(m)).querySelector('input[value="combined"]');
  const ownReason = unavailable.closest('label').querySelector('.tl-simple-chart-reason');
  assert.ok(ownReason); assert.match(ownReason.textContent, /not available on this dashboard yet/);
  assert.ok(unavailable.getAttribute('aria-describedby').split(' ').includes(ownReason.id));
  m.savedPresentation = null; m.draft.presentation = { mode: 'replace', value: structuredClone(config) };
  for (const choice of chartGalleryChoices.filter(choice => choice.id !== 'combined')) {
    const before = structuredClone(m); applyGalleryChoice(m.draft, m, choice.id); assert.deepEqual(m, before, 'draft-only combined composition also cannot be rewritten in Simple');
  }
});
