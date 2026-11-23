import {state} from './state.js';
import {escapeHtml,escapeAttr} from './utils.js';
export function renderDashboardPages(){
 const a=state.trainingLoad.analysis;if(!a.pagesAvailable)return '';
 const busy=a.saving||a.pageLoading||a.pageSaving||Boolean(a.pagePending),off=busy?'disabled':'';
 const page=a.page,form=a.pageForm;
 return `<section class="tl-dashboard-pages" aria-label="Dashboard pages">
 <nav aria-label="Pages">${(a.pages??[]).map(p=>`<button type="button" data-action="training-load-pages-select" data-page-id="${escapeAttr(p.id)}" aria-current="${p.id===a.selectedPageId?'page':'false'}" ${off}>${escapeHtml(p.name)}${p.is_home&&p.name!=='Home'?' · Home':''}</button>`).join('')}</nav>
 ${a.pageCanManage?`<div class="tl-page-actions"><button type="button" data-action="training-load-pages-create" ${off}>New page</button>${page?`<button type="button" data-action="training-load-pages-rename" ${off}>Rename</button><button type="button" data-action="training-load-pages-defaults" ${off}>Default period</button>${!page.is_home?`<button type="button" data-action="training-load-pages-up" ${busy||page.position<=1?'disabled':''}>Move left</button><button type="button" data-action="training-load-pages-down" ${busy||page.position>=(a.pages??[]).length-1?'disabled':''}>Move right</button><button type="button" data-action="training-load-pages-delete" ${off}>Delete page</button>`:''}`:''}</div>`:''}
 ${busy?'<p role="status">◷ Updating page…</p>':''}
 ${a.pageError?`<p role="alert">${escapeHtml(a.pageError)}</p><button type="button" data-action="${a.pagePending?'training-load-pages-check':'training-load-pages-reload'}" ${a.pageSaving?'disabled':''}>${a.pagePending?'Check update':'Reload dashboard'}</button>`:''}
 ${form?`<div class="tl-page-form" role="group" aria-label="${escapeAttr(form.operation==='create'?'New page':form.operation==='delete'?'Delete page':form.operation==='defaults'?'Default period':form.operation==='copy'?'Copy widget':'Rename page')}">
 ${form.operation==='copy'?`<label>Copy “${escapeHtml(form.name)}” to<select data-action="training-load-pages-destination" ${off}>${(a.pages??[]).map(p=>`<option value="${escapeAttr(p.id)}" ${p.id===form.destinationPageId?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>`:form.operation==='defaults'?'<p>This period is shared by everyone who opens this page.</p>':form.operation==='delete'?`<p>Delete “${escapeHtml(form.name)}”? The page must be empty.</p>`:`<label>Page name<input type="text" data-action="training-load-pages-name" maxlength="80" value="${escapeAttr(form.name)}" ${off}></label>`}
 ${['create','defaults'].includes(form.operation)?`<label>Default period<select data-action="training-load-pages-preset" ${off}>${(form.operation==='defaults'?[['unchanged','Keep current period'],['dashboard','Use dashboard period']]:[]).concat([['last_28_days','Last 28 days'],['last_7_days','Last 7 days'],['this_week','This week'],['today','Today']]).map(([value,label])=>`<option value="${value}" ${form.preset===value?'selected':''}>${label}</option>`).join('')}</select></label>`:''}
 <button type="button" data-action="training-load-pages-save" ${off}>${form.operation==='delete'?'Delete page':form.operation==='copy'?'Copy widget':'Save page'}</button><button type="button" data-action="training-load-pages-cancel" ${off}>Cancel</button></div>`:''}
 </section>`;
}
