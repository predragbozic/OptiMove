import { escapeHtml, escapeAttr } from './utils.js';

const prefix = 'training-load-analysis-page-';
const disabled = value => value ? ' disabled' : '';
const action = type => `data-action="${prefix}${type}"`;
const button = (type, label, blocked, pageId) => `<button type="button" ${action(type)}${pageId == null ? '' : ` data-page-id="${escapeAttr(pageId)}"`}${disabled(blocked)}>${escapeHtml(label)}</button>`;
const modes = {
  create: ['Nova stranica', 'Napravi stranicu'],
  rename: ['Preimenuj stranicu', 'Sačuvaj naziv'],
  duplicate: ['Dupliraj stranicu', 'Dupliraj'],
  delete: ['Obriši stranicu', 'Obriši stranicu'],
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
    ${deleting ? `<p>Brisanjem stranice „${escapeHtml(form.name)}” trajno se brišu svi njeni vidžeti. Broj vidžeta: <strong>${count}</strong>.</p>` : `<label class="tl-page-field" for="tl-page-form-name">Naziv stranice
      <input id="tl-page-form-name" name="name" type="text" maxlength="200" required value="${escapeAttr(form.name ?? '')}" ${action('form-name')}${disabled(busy)}>
    </label>`}
    ${form.mode === 'create' ? `<label class="tl-page-field" for="tl-page-form-preset">Početni raspon
      <select id="tl-page-form-preset" name="preset" ${action('form-preset')}${disabled(busy)}>${[
        ['last_28_days', 'Poslednjih 28 dana'], ['last_7_days', 'Poslednjih 7 dana'], ['this_week', 'Ova nedelja'], ['current', 'Trenutni raspon'],
      ].map(([value, label]) => `<option value="${value}"${value === (form.preset ?? 'last_28_days') ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </label>` : ''}
    ${form.mode === 'duplicate' ? '<p>Duplikat zadržava početni raspon i filtere izvorne stranice.</p>' : ''}
    ${lastPage ? '<p class="tl-page-error">Poslednju stranicu nije moguće obrisati.</p>' : ''}
    ${atLimit ? '<p class="tl-page-error">Dozvoljene su najviše 32 stranice.</p>' : ''}
    ${form.error ? `<p class="tl-page-error" role="alert">${escapeHtml(form.error)}</p>` : ''}
    <div class="tl-page-form-actions"><button type="submit"${deleting ? ' class="tl-page-danger"' : ''}${disabled(busy || atLimit || lastPage)}>${form.submitting ? 'Čuvanje…' : submit}</button>${button('form-cancel', 'Otkaži', busy)}</div>
  </form>`;
}

export function renderPagePendingHtml(pending) {
  if (!pending?.status) return '';
  const busy = ['sending', 'checking'].includes(pending.status);
  const message = pending.status === 'sending' ? 'Čuvanje promene stranice je u toku.'
    : pending.status === 'checking' ? 'Provera ishoda čuvanja stranice je u toku.'
      : 'Ishod čuvanja stranice nije potvrđen. Proverite status ili ponovite isti zahtev. Ostanite na ovoj stranici dok se ishod ne potvrdi.';
  return `<section class="tl-page-write-banner" role="${pending.status === 'unknown' ? 'alert' : 'status'}" tabindex="-1" aria-live="${pending.status === 'unknown' ? 'assertive' : 'polite'}" aria-atomic="true">
    <p>${message}</p><div class="tl-page-write-actions">${button('write-status', 'Proveri status', busy)}${button('write-retry', 'Ponovi isti zahtev', busy)}</div>
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
    <nav class="tl-pages-nav" aria-label="Stranice kontrolne table">
      <div class="tl-pages-tabs" role="tablist" aria-label="Stranice" aria-orientation="horizontal">${pages.map((page, i) => `<button type="button" id="tl-page-tab-${i}" role="tab" aria-selected="${page.id === a.selectedPageId}" tabindex="${page.id === a.selectedPageId ? 0 : -1}" aria-controls="tl-page-panel" ${action('select')} data-page-id="${escapeAttr(page.id)}"${disabled(blocked)}>${escapeHtml(page.name)}</button>`).join('')}</div>
      <div class="tl-pages-tools">${button('create', '+ Stranica', crudBlocked || atLimit)}
      ${active ? `<details class="tl-page-menu"><summary aria-label="Opcije stranice ${escapeAttr(active.name)}">Opcije stranice</summary><div class="tl-page-menu-actions">
        ${button('rename', 'Preimenuj', crudBlocked, active.id)}
        ${button('duplicate', 'Dupliraj', crudBlocked || atLimit, active.id)}
        ${button('left', 'Pomeri levo', crudBlocked || index <= 0, active.id)}
        ${button('right', 'Pomeri desno', crudBlocked || index < 0 || index >= pages.length - 1, active.id)}
        ${button('defaults', 'Sačuvaj početni raspon i filtere', crudBlocked || a.pageCapabilities?.pageWidgetEditing !== true, active.id)}
        ${button('delete', 'Obriši', crudBlocked || pages.length <= 1, active.id)}
      </div></details>` : ''}</div>
    </nav>
    ${atLimit ? '<p class="tl-pages-hint">Dostignut je limit od 32 stranice.</p>' : ''}
    ${a.pageForm && Object.hasOwn(modes, a.pageForm.mode) ? '' : renderPagePendingHtml(a.pageWritePending)}
    ${renderForm({ ...a, pages }, crudBlocked)}
  </div>`;
}
