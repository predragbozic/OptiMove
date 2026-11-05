import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { renderPagesHtml, renderPagePendingHtml } from '../training-load-pages-view.js';

const prefix = 'training-load-analysis-page-';
function model(extra = {}) {
  const pages = [{ id: 'page-1', name: 'Pregled' }, { id: 'page-2', name: 'Napredak' }, { id: 'page-3', name: 'Oporavak' }];
  return { pagesMode: true, pages, selectedPageId: 'page-2', page: pages[1], pageCapabilities: { pageManagement: true, pageWidgetEditing: true }, ...extra };
}
const dom = a => JSDOM.fragment(renderPagesHtml(a));
const control = (root, type) => root.querySelector(`[data-action="${prefix}${type}"]`);
const tabs = root => [...root.querySelectorAll('[role="tab"]')];
const form = (mode = 'create', extra = {}) => ({ mode, name: 'Nova stranica', preset: 'last_28_days', targetId: 'page-2', widgetCount: 4, ...extra });
const management = ['create', 'rename', 'duplicate', 'left', 'right', 'defaults', 'delete'];

test('exportovani pending helper bez zahteva vraća prazno', () => {
  for (const pending of [undefined, null, {}, { status: '' }]) assert.equal(renderPagePendingHtml(pending), '');
});

for (const status of ['sending', 'unknown', 'checking']) {
  test(`exportovani ${status} helper radi samostalno unutar overlay-a`, () => {
    const pending = { status, requestId: 'original-request', body: '{"original":true}' };
    const before = structuredClone(pending);
    const root = JSDOM.fragment(`<section role="dialog" aria-label="Napredna podešavanja">${renderPagePendingHtml(pending)}</section>`);
    const banner = root.querySelector('.tl-page-write-banner');
    assert.equal(banner.closest('[role="dialog"]'), root.querySelector('[role="dialog"]'));
    assert.equal(banner.getAttribute('role'), status === 'unknown' ? 'alert' : 'status');
    assert.equal(banner.getAttribute('tabindex'), '-1');
    assert.equal(banner.getAttribute('aria-live'), status === 'unknown' ? 'assertive' : 'polite');
    assert.equal(banner.querySelectorAll('button').length, 2);
    for (const type of ['write-status', 'write-retry']) {
      const recovery = control(banner, type);
      assert.equal(recovery.disabled, status !== 'unknown');
      assert.equal(recovery.type, 'button');
    }
    assert.deepEqual(pending, before);
  });
}

test('legacy režim vraća prazno; render ne menja ulaz', () => {
  assert.equal(renderPagesHtml(), '');
  assert.equal(renderPagesHtml(null), '');
  assert.equal(renderPagesHtml({ pagesMode: false }), '');
  const a = model({ pageForm: form() }), before = structuredClone(a);
  renderPagesHtml(a);
  assert.deepEqual(a, before);
});

test('nav ima imenovane kartice, izabranu Page i vezu ka panelu glavnog prikaza', () => {
  const root = dom(model());
  assert.equal(root.querySelector('nav').getAttribute('aria-label'), 'Stranice kontrolne table');
  assert.equal(root.querySelector('[role="tablist"]').getAttribute('aria-orientation'), 'horizontal');
  assert.deepEqual(tabs(root).map(tab => tab.textContent), ['Pregled', 'Napredak', 'Oporavak']);
  assert.deepEqual(tabs(root).map(tab => tab.getAttribute('aria-selected')), ['false', 'true', 'false']);
  assert.deepEqual(tabs(root).map(tab => tab.tabIndex), [-1, 0, -1]);
  assert.equal(new Set(tabs(root).map(tab => tab.id)).size, 3);
  for (const tab of tabs(root)) {
    assert.equal(tab.getAttribute('aria-controls'), 'tl-page-panel');
    assert.equal(tab.type, 'button');
    assert.equal(tab.disabled, false);
    assert.equal(tab.dataset.action, `${prefix}select`);
  }
  assert.deepEqual(tabs(root).map(tab => tab.dataset.pageId), ['page-1', 'page-2', 'page-3']);
  assert.equal(root.querySelector('[role="tabpanel"]'), null);
});

test('aktivna Page ima native details meni sa svim akcijama i ciljanim ID-jem', () => {
  const root = dom(model());
  assert.ok(root.querySelector('details > summary'));
  assert.equal(root.querySelector('summary').getAttribute('aria-label'), 'Opcije stranice Napredak');
  assert.equal(control(root, 'create').textContent, '+ Stranica');
  for (const type of management.filter(type => type !== 'create')) {
    assert.equal(control(root, type).dataset.pageId, 'page-2');
    assert.equal(control(root, type).disabled, false);
  }
  assert.equal(control(root, 'defaults').textContent, 'Sačuvaj početni raspon i filtere');
});

test('krajnje kartice blokiraju pomeranje preko granice, poslednja Page blokira brisanje', () => {
  for (const [index, left, right] of [[0, true, false], [2, false, true]]) {
    const a = model(); a.selectedPageId = a.pages[index].id; a.page = a.pages[index];
    const root = dom(a);
    assert.equal(control(root, 'left').disabled, left);
    assert.equal(control(root, 'right').disabled, right);
  }
  const a = model(); a.pages = [a.page];
  const root = dom(a);
  for (const type of ['left', 'right', 'delete']) assert.equal(control(root, type).disabled, true);
});

test('prazna lista ima create bez izmišljenih kartica i bez menija', () => {
  const root = dom(model({ pages: [], page: null, selectedPageId: '' }));
  assert.equal(tabs(root).length, 0);
  assert.equal(root.querySelector('details'), null);
  assert.equal(control(root, 'create').disabled, false);
});

test('nepoverljivi nazivi, ID-jevi, input vrednosti i greške ostaju običan tekst', () => {
  const hostile = '\"><img src=x onerror="alert(1)"><script>alert(2)</script>&`';
  const page = { id: hostile, name: hostile };
  const root = dom(model({ pages: [page], page, selectedPageId: hostile, pageForm: form('rename', { name: hostile, error: hostile }) }));
  assert.equal(root.querySelector('script, img, [onerror], [onclick]'), null);
  assert.equal(tabs(root)[0].textContent, hostile);
  assert.equal(tabs(root)[0].dataset.pageId, hostile);
  assert.equal(control(root, 'rename').dataset.pageId, hostile);
  assert.equal(root.querySelector('summary').getAttribute('aria-label'), `Opcije stranice ${hostile}`);
  assert.equal(root.querySelector('input').value, hostile);
  assert.equal(root.querySelector('[role="alert"]').textContent, hostile);
  const deletion = dom(model({ pageForm: form('delete', { name: hostile }) }));
  assert.equal(deletion.querySelector('img, script'), null);
  assert.ok(deletion.querySelector('form').textContent.includes(hostile));
});

test('create forma koristi delegirani submit, named input maxlength 200 i četiri preseta', () => {
  const root = dom(model({ pageForm: form('create', { preset: 'this_week' }) }));
  const element = root.querySelector('form');
  assert.equal(element.dataset.tlAnalysisForm, 'page');
  assert.equal(element.hasAttribute('data-action'), false);
  assert.equal(element.getAttribute('aria-labelledby'), root.querySelector('h3').id);
  const input = control(root, 'form-name');
  assert.equal(input.name, 'name');
  assert.equal(input.maxLength, 200);
  assert.equal(input.required, true);
  assert.equal(input.value, 'Nova stranica');
  assert.equal(root.querySelector(`label[for="${input.id}"]`).textContent.trim(), 'Naziv stranice');
  const select = control(root, 'form-preset');
  assert.equal(select.name, 'preset');
  assert.equal(select.value, 'this_week');
  assert.deepEqual([...select.options].map(option => option.value), ['last_28_days', 'last_7_days', 'this_week', 'current']);
  assert.equal(element.querySelector('[type="submit"]').hasAttribute('data-action'), false);
  assert.equal(control(root, 'form-cancel').textContent, 'Otkaži');
});

for (const mode of ['rename', 'duplicate']) {
  test(`${mode} forma nema preset dropdown`, () => {
    const root = dom(model({ pageForm: form(mode) }));
    assert.ok(control(root, 'form-name'));
    assert.equal(root.querySelector('select'), null);
    assert.equal(root.querySelector('[type="submit"]').disabled, false);
    if (mode === 'duplicate') assert.match(root.querySelector('form').textContent, /zadržava početni raspon i filtere/);
  });
}

test('delete jasno prikazuje broj vidžeta i zabranjuje poslednju Page', () => {
  const a = model({ pageForm: form('delete', { widgetCount: 17 }) });
  let root = dom(a);
  assert.match(root.querySelector('form').textContent, /trajno se brišu svi njeni vidžeti. Broj vidžeta: 17/);
  assert.equal(root.querySelector('input, select'), null);
  assert.equal(root.querySelector('[type="submit"]').disabled, false);
  a.pages = [a.page]; root = dom(a);
  assert.equal(root.querySelector('[type="submit"]').disabled, true);
  assert.match(root.textContent, /Poslednju stranicu nije moguće obrisati/);
});

test('limit 32 blokira create i duplicate u meniju i u otvorenoj formi', () => {
  const pages = Array.from({ length: 32 }, (_, i) => ({ id: `page-${i}`, name: `Stranica ${i + 1}` }));
  for (const mode of ['create', 'duplicate']) {
    const root = dom(model({ pages, page: pages[2], selectedPageId: pages[2].id, pageForm: form(mode) }));
    assert.equal(control(root, 'create').disabled, true);
    assert.equal(control(root, 'duplicate').disabled, true);
    assert.equal(control(root, 'rename').disabled, false);
    assert.equal(root.querySelector('[type="submit"]').disabled, true);
    assert.equal(tabs(root).length, 32);
    assert.ok(tabs(root).every(tab => !tab.disabled));
  }
});

for (const status of ['sending', 'unknown', 'checking']) {
  test(`pending ${status} blokira switch/CRUD; recovery ostaje dostupan unutar Page forme`, () => {
    const root = dom(model({ pageWritePending: { status }, pageForm: form() }));
    assert.ok(tabs(root).every(tab => tab.disabled));
    for (const type of management) assert.equal(control(root, type).disabled, true);
    for (const element of root.querySelectorAll('form input, form select, .tl-page-form-actions button')) assert.equal(element.disabled, true);
    const banner = root.querySelector('.tl-page-write-banner');
    assert.equal(root.querySelectorAll('.tl-page-write-banner').length, 1);
    assert.equal(banner.getAttribute('role'), status === 'unknown' ? 'alert' : 'status');
    assert.equal(banner.closest('form'), root.querySelector('form'));
    assert.equal(banner.closest('fieldset'), null);
    assert.equal(banner.getAttribute('tabindex'), '-1');
    assert.equal(banner.querySelectorAll('button').length, 2);
    for (const type of ['write-status', 'write-retry']) {
      assert.equal(control(root, type).disabled, status !== 'unknown');
      assert.equal(control(root, type).type, 'button');
    }
    assert.equal(root.querySelector('fieldset'), null);
  });
}

for (const mode of ['create', 'rename', 'duplicate', 'delete']) {
  test(`${mode} unknown uz idle Simple nacrt zadržava cancel blokadu i revision snapshot`, () => {
    const a = model({ pageWritePending: { status: 'unknown', requestId: 'original-request', body: '{"original":true}' },
      pageForm: form(mode, { pageRevision: 7, pagesRevision: 12, submitting: true }),
      simpleEditor: { saveState: 'idle', draft: { title: 'Nesačuvan nacrt' } } });
    const before = structuredClone(a), root = dom(a), pageForm = root.querySelector('form');
    assert.equal(control(pageForm, 'form-cancel').disabled, true);
    assert.equal(pageForm.querySelector('[type="submit"]').disabled, true);
    for (const type of ['write-status', 'write-retry']) {
      const recovery = control(pageForm, type);
      assert.ok(recovery);
      assert.equal(recovery.disabled, false);
      assert.equal(recovery.type, 'button');
      assert.equal(recovery.closest('fieldset'), null);
    }
    assert.deepEqual(a, before);
  });
}

for (const status of ['sending', 'unknown', 'checking']) {
  test(`bez Page forme ${status} recovery ostaje u zasebnom banneru`, () => {
    const root = dom(model({ pageWritePending: { status } }));
    const banner = root.querySelector('.tl-page-write-banner');
    assert.ok(banner);
    assert.equal(banner.closest('form, fieldset'), null);
    for (const type of ['write-status', 'write-retry']) assert.equal(control(banner, type).disabled, status !== 'unknown');
  });
}

test('nema recovery bannera bez pending zahteva', () => {
  assert.equal(dom(model()).querySelector('.tl-page-write-banner'), null);
});

for (const extra of [{ saving: true }, { detailLoading: true }, { simpleEditor: { saveState: 'saving' } }, { simpleEditor: { saveState: 'unknown' } }, { pageForm: form('rename', { submitting: true }) }]) {
  test(`zauzet prikaz blokira kontrole: ${JSON.stringify(extra)}`, () => {
    const root = dom(model(extra));
    assert.ok(tabs(root).every(tab => tab.disabled));
    for (const type of management) assert.equal(control(root, type).disabled, true);
  });
}

test('idle Simple draft ostavlja kartice dostupnim za prompt glavnog agenta', () => {
  const root = dom(model({ simpleEditor: { saveState: 'idle', draft: { title: 'Nesačuvano' } } }));
  assert.ok(tabs(root).every(tab => !tab.disabled));
});

test('read-only template/archive capabilities blokiraju upravljanje, ali dozvoljavaju čitanje kartica', () => {
  for (const dashboard of [{ is_template: true }, { status: 'archived' }, {}]) {
    const root = dom(model({ dashboard, pageCapabilities: { pageManagement: false, pageWidgetEditing: false }, pageForm: form('rename') }));
    assert.ok(tabs(root).every(tab => !tab.disabled));
    for (const type of management) assert.equal(control(root, type).disabled, true);
    assert.equal(root.querySelector('[type="submit"]').disabled, true);
  }
  assert.equal(control(dom(model({ pageCapabilities: { pageManagement: true, pageWidgetEditing: false } })), 'defaults').disabled, true);
});

test('mobilni markup zadržava jedan skrolujući tablist i CSS koristi app temu', async () => {
  const root = dom(model());
  assert.equal(root.querySelectorAll('.tl-pages-tabs').length, 1);
  assert.equal(root.querySelectorAll('.tl-pages-tools').length, 1);
  const css = await readFile(new URL('../training-load-pages.css', import.meta.url), 'utf8');
  assert.match(css, /overflow-x:\s*auto/);
  assert.match(css, /min-width:\s*0/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /flex-direction:\s*column/);
  assert.match(css, /var\(--surface,\s*#fff\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height:\s*44px/);
});
