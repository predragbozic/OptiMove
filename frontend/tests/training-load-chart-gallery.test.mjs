import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderChartGallery, applyGalleryChoice, chartGalleryChoices, gallerySelection } from '../training-load-chart-gallery.js';
import { chartPresentation } from '../training-load-chart-composer.js';

const model = () => ({ draft: { view: { type: 'table', groupBy: 'day' } }, selectedMetric: { value_type: 'numeric' }, capabilities: { widgetTypes: ['table','kpi','line_chart','bar_chart'], capabilities: { chartVariants: ['area','horizontal-bar'] } } });
const documentFor = html => new JSDOM(html).window.document;

test('six native radio cards have distinct accessible names, descriptions and decorative original SVGs', () => {
  const m = model(), before = structuredClone(m), doc = documentFor(renderChartGallery(m));
  assert.equal(doc.querySelector('legend').textContent, 'Display');
  const radios = [...doc.querySelectorAll('input[type="radio"]')];
  assert.deepEqual(radios.map(input => input.value), chartGalleryChoices.map(choice => choice.id));
  assert.equal(new Set(radios.map(input => input.name)).size, 1);
  for (const [index, input] of radios.entries()) {
    assert.equal(doc.getElementById(input.getAttribute('aria-labelledby')).textContent, chartGalleryChoices[index].name);
    assert.ok(doc.getElementById(input.getAttribute('aria-describedby')).textContent.length > 25);
    assert.equal(input.disabled, false);
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
      const blocked = variant && !advertised?.includes(input.value);
      assert.equal(input.disabled, Boolean(blocked));
      if (blocked) {
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
