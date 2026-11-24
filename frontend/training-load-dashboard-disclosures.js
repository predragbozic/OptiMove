import {currentUserWorkspaceContextParts} from './access.js';
const installed=new WeakSet();
const key=(id,name)=>'optimove:dashboard:disclosure:'+JSON.stringify([currentUserWorkspaceContextParts(),id,name]);
export function dashboardDisclosureOpen(id,name,fallback=true){
 registerDashboardDisclosures();try{const value=globalThis.sessionStorage?.getItem(key(id,name));return value===null||value===undefined?fallback:value==='open'}catch{return fallback}
}
export function registerDashboardDisclosures(doc=globalThis.document){
 if(!doc||installed.has(doc))return;installed.add(doc);
 doc.addEventListener('toggle',event=>{const node=event.target;if(node?.tagName!=='DETAILS'||!node.dataset.dashboardDisclosure)return;
 const id=node.dataset.widgetId??node.closest('[data-analysis-widget-id]')?.dataset.analysisWidgetId;if(!id)return;
 try{globalThis.sessionStorage?.setItem(key(id,node.dataset.dashboardDisclosure),node.open?'open':'closed')}catch{/* storage unavailable */}
 },true);
}
