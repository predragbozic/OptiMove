import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { handlePageTabKeydown } from '../training-load-pages-actions.js';
import { renderPagesHtml } from '../training-load-pages-view.js';

function setup(t) {
  const pages = ['Prva', 'Druga', 'Treća'].map((name, index) => ({ id: `page-${index}`, name }));
  const dom = new JSDOM(renderPagesHtml({ pagesMode: true, pages, selectedPageId: 'page-1', page: pages[1] }));
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const outcomes = [];
  document.addEventListener('keydown', event => outcomes.push(handlePageTabKeydown(event)));
  const key = (target, value, extra = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  return { document, tabs, key, outcomes };
}

test('strelice pomeraju fokus uz wrap i roving tabindex, bez promene izabrane Page', t => {
  const { document, tabs, key } = setup(t);
  let clicks = 0; document.addEventListener('click', () => clicks++);
  tabs[1].focus();
  for (const [from, value, to] of [[1, 'ArrowRight', 2], [2, 'ArrowRight', 0], [0, 'ArrowLeft', 2], [2, 'ArrowLeft', 1]]) {
    assert.equal(key(tabs[from], value).defaultPrevented, true);
    assert.equal(document.activeElement, tabs[to]);
    assert.deepEqual(tabs.map(tab => tab.tabIndex), tabs.map((_, i) => i === to ? 0 : -1));
    assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['false', 'true', 'false']);
  }
  assert.equal(clicks, 0);
});

test('Home i End fokusiraju prvi i poslednji dostupan tab', t => {
  const { document, tabs, key } = setup(t);
  tabs[1].focus();
  assert.equal(key(tabs[1], 'End').defaultPrevented, true);
  assert.equal(document.activeElement, tabs[2]);
  assert.equal(key(tabs[2], 'Home').defaultPrevented, true);
  assert.equal(document.activeElement, tabs[0]);
});

test('disabled i aria-disabled kartice se preskaču; disabled izvor se ignoriše', t => {
  const { document, tabs, key } = setup(t);
  tabs[0].disabled = true; tabs[2].setAttribute('aria-disabled', 'true');
  tabs[1].focus();
  for (const value of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.equal(key(tabs[1], value).defaultPrevented, true);
    assert.equal(document.activeElement, tabs[1]);
  }
  assert.equal(key(tabs[0], 'ArrowRight').defaultPrevented, false);
  assert.equal(key(tabs[2], 'Home').defaultPrevented, false);
});

test('fieldset disabled i potpuno blokirani tabovi ne menjaju fokus', t => {
  const { document, tabs, key, outcomes } = setup(t);
  const fieldset = document.createElement('fieldset'); fieldset.disabled = true;
  document.body.append(fieldset); fieldset.append(document.querySelector('[role="tablist"]'));
  const before = tabs.map(tab => tab.tabIndex);
  assert.equal(key(tabs[1], 'ArrowLeft').defaultPrevented, false);
  assert.equal(outcomes.at(-1), false);
  assert.deepEqual(tabs.map(tab => tab.tabIndex), before);
});

test('Enter i Space ostaju native aktivacija; Tab i vertikalne strelice se ne preuzimaju', t => {
  const { document, tabs, key, outcomes } = setup(t);
  tabs[1].focus();
  for (const value of ['Enter', ' ', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape']) {
    assert.equal(key(tabs[1], value).defaultPrevented, false);
    assert.equal(outcomes.at(-1), false);
    assert.equal(document.activeElement, tabs[1]);
  }
});

test('modifikatori i već obrađeni događaji se ignorišu', t => {
  const { tabs, key, outcomes } = setup(t);
  for (const extra of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(key(tabs[1], 'ArrowRight', extra).defaultPrevented, false);
    assert.equal(outcomes.at(-1), false);
  }
  tabs[1].addEventListener('keydown', event => event.preventDefault(), { once: true });
  key(tabs[1], 'ArrowRight');
  assert.equal(outcomes.at(-1), false);
});

test('handler koristi closest tablist i ne pomera fokus u drugu listu', t => {
  const { document, tabs, key } = setup(t);
  const other = document.querySelector('[role="tablist"]').cloneNode(true);
  document.body.append(other);
  const child = document.createElement('span'); tabs[2].append(child);
  assert.equal(key(child, 'ArrowRight').defaultPrevented, true);
  assert.equal(document.activeElement, tabs[0]);
  assert.deepEqual([...other.querySelectorAll('[role="tab"]')].map(tab => tab.tabIndex), [-1, 0, -1]);
  assert.equal(key(document.querySelector('summary'), 'Home').defaultPrevented, false);
  assert.equal(handlePageTabKeydown({ key: 'End', target: null }), false);
});
