import { escapeHtml, escapeAttr } from './utils.js';

const prefix = 'training-load-analysis-page-';
const disabled = value => value ? ' disabled' : '';
const action = type => `data-action="${prefix}${type}"`;
const button = (type, label, blocked, pageId) => `<button type="button" ${action(type)}${pageId == null ? '' : ` data-page-id="${escapeAttr(pageId)}"`}${disabled(blocked)}>${escapeHtml(label)}</button>`;
const modes = {
  create: ['New page', 'Create page'],
  rename: ['Rename page', 'Save name'],
  duplicate: ['Duplicate page', 'Duplicate'],
  delete: ['Delete page', 'Delete page'],
};

function renderForm(a, blocked) {
  const form = a.pageForm;
  if (!form || !Object.hasOwn(modes, form.mode)) return '';
  const [heading, submit] = modes[form.mode];
  const deleting = form.mode === 'delete';
  const atLimit = a.pages.length >= 32 && ['create', 'duplicate'].includes(form.mode);
  const lastPage = deleting && a.pages.length <= 1;
  const busy = blocked || Boolean(form.submitting);
  const count = Number.isSafeInteger(form.widgetCount) && form.widgetCount >= 0 ? form.widgetCount : 0;
  return `<form class="tl-page-form" data-tl-analysis-form="page" aria-labelledby="tl-page-form-heading" aria-busy="${Boolean(form.submitting)}">
    <h3 id="tl-page-form-heading">${heading}</h3>
    ${renderPagePendingHtml(a.pageWritePending)}
    ${deleting ? `<p>Deleting page “${escapeHtml(form.name)}” permanently deletes all its widgets. Widget count: <strong>${count}</strong>.</p>` : `<label class="tl-page-field" for="tl-page-form-name">Page name
      <input id="tl-page-form-name" name="name" type="text" maxlength="200" required value="${escapeAttr(form.name ?? '')}" ${action('form-name')}${disabled(busy)}>
    </label>`}
    ${form.mode === 'create' ? `<label class="tl-page-field" for="tl-page-form-preset">Default period
      <select id="tl-page-form-preset" name="preset" ${action('form-preset')}${disabled(busy)}>${[
        ['last_28_days', 'Last 28 days'], ['last_7_days', 'Last 7 days'], ['this_week', 'This week'], ['current', 'Current period'],
      ].map(([value, label]) => `<option value="${value}"${value === (form.preset ?? 'last_28_days') ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </label>` : ''}
    ${form.mode === 'duplicate' ? '<p>The copy keeps the original page’s default period and filters.</p>' : ''}
    ${lastPage ? '<p class="tl-page-error">The last page cannot be deleted.</p>' : ''}
    ${atLimit ? '<p class="tl-page-error">Up to 32 pages are allowed.</p>' : ''}
    ${form.error ? `<p class="tl-page-error" role="alert">${escapeHtml(form.error)}</p>` : ''}
    <div class="tl-page-form-actions"><button type="submit"${deleting ? ' class="tl-page-danger"' : ''}${disabled(busy || atLimit || lastPage)}>${form.submitting ? 'Saving…' : submit}</button>${button('form-cancel', 'Cancel', busy)}</div>
  </form>`;
}

export function renderPagePendingHtml(pending) {
  if (!pending?.status) return '';
  const busy = ['sending', 'checking'].includes(pending.status);
  const message = pending.status === 'sending' ? 'Saving page changes.'
    : pending.status === 'checking' ? 'Checking the save outcome.'
      : 'The save outcome is unknown. Check the status or retry the same request. Stay on this page until the outcome is confirmed.';
  return `<section class="tl-page-write-banner" role="${pending.status === 'unknown' ? 'alert' : 'status'}" tabindex="-1" aria-live="${pending.status === 'unknown' ? 'assertive' : 'polite'}" aria-atomic="true">
    <p>${message}</p><div class="tl-page-write-actions">${button('write-status', 'Check status', busy)}${button('write-retry', 'Retry same request', busy)}</div>
  </section>`;
}

export function renderPagesHtml(a) {
  if (!a?.pagesMode) return '';
  const pages = a.pages ?? [];
  const blocked = Boolean(a.saving || a.detailLoading || a.pageForm?.submitting || a.pageWritePending?.status || ['saving', 'unknown'].includes(a.simpleEditor?.saveState));
  const manage = a.pageCapabilities?.pageManagement === true;
  const crudBlocked = blocked || !manage;
  const index = pages.findIndex(page => page.id === a.selectedPageId);
  const active = a.page?.id === a.selectedPageId ? a.page : pages[index];
  const atLimit = pages.length >= 32;
  return `<div class="tl-pages">
    <nav class="tl-pages-nav" aria-label="Dashboard pages">
      <div class="tl-pages-tabs" role="tablist" aria-label="Pages" aria-orientation="horizontal">${pages.map((page, i) => `<button type="button" id="tl-page-tab-${i}" role="tab" aria-selected="${page.id === a.selectedPageId}" tabindex="${page.id === a.selectedPageId ? 0 : -1}" aria-controls="tl-page-panel" ${action('select')} data-page-id="${escapeAttr(page.id)}"${disabled(blocked)}>${escapeHtml(page.name)}</button>`).join('')}</div>
      <div class="tl-pages-tools">${button('create', '+ Page', crudBlocked || atLimit)}
      ${active ? `<details class="tl-page-menu"><summary aria-label="Page options ${escapeAttr(active.name)}">Page options</summary><div class="tl-page-menu-actions">
        ${button('export-pdf', 'Export page as PDF', blocked || a.queryLoading || a.editMode || Boolean(a.queryError), active.id)}
        ${button('rename', 'Rename', crudBlocked, active.id)}
        ${button('duplicate', 'Duplicate', crudBlocked || atLimit, active.id)}
        ${button('left', 'Move left', crudBlocked || index <= 0, active.id)}
        ${button('right', 'Move right', crudBlocked || index < 0 || index >= pages.length - 1, active.id)}
        ${button('defaults', 'Save default period and filters', crudBlocked || a.pageCapabilities?.pageWidgetEditing !== true, active.id)}
        ${button('delete', 'Delete', crudBlocked || pages.length <= 1, active.id)}
      </div></details>` : ''}</div>
    </nav>
    ${atLimit ? '<p class="tl-pages-hint">The limit of 32 pages has been reached.</p>' : ''}
    ${a.pageForm && Object.hasOwn(modes, a.pageForm.mode) ? '' : renderPagePendingHtml(a.pageWritePending)}
    ${renderForm({ ...a, pages }, crudBlocked)}
  </div>`;
}
