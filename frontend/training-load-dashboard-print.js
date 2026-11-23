const PRINT_CSS=`@page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;color:#14233b;background:white;font:11pt Arial,sans-serif}h1{font-size:20pt}h2{font-size:14pt}p{margin:4mm 0}.report-widget{break-inside:avoid;margin:0 0 7mm}.report-widget figure{margin:3mm 0}.report-legend{list-style:none;display:flex;flex-wrap:wrap;gap:2mm 4mm;padding:0;margin:2mm 0;font-size:9pt}.report-legend li{display:flex;align-items:center;gap:2mm;break-inside:avoid}.report-legend span{display:inline-block;width:5mm;height:2mm}h2{break-after:avoid}.report-widget svg{display:block;width:100%;height:auto;max-height:145mm}.report-values{break-before:page;break-after:page;break-inside:avoid;margin:0 0 7mm}.report-values.is-long{break-inside:auto}table{border-collapse:collapse;width:100%;font-size:9pt;table-layout:auto}th,td{border-bottom:1px solid #cbd5e1;padding:2mm;text-align:left;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}caption{text-align:left;font-weight:bold;padding:2mm 0}.muted{color:#475569}.tl-analysis-kpi-value{font-size:26pt}button,input,select,textarea,summary{display:none!important}@media screen{body{max-width:186mm;margin:12mm auto}}`;
const numbers=(node,key)=>Number(node.style.getPropertyValue(key))||0;
export function orderedReportWidgets(root){
 return [...root.querySelectorAll('.tl-analysis-widget[data-analysis-widget-id]')].map((node,index)=>({node,index,rect:node.getBoundingClientRect()}))
  .sort((a,b)=>a.rect.top-b.rect.top||a.rect.left-b.rect.left||numbers(a.node,'--tl-y')-numbers(b.node,'--tl-y')||numbers(a.node,'--tl-x')-numbers(b.node,'--tl-x')||a.index-b.index).map(x=>x.node);
}
function scrub(node){
 for(const item of [node,...node.querySelectorAll('*')])for(const attr of [...item.attributes])if(attr.name.startsWith('data-')||attr.name.startsWith('on')||attr.name==='tabindex'||attr.name==='id'&&item.namespaceURI!=='http://www.w3.org/2000/svg')item.removeAttribute(attr.name);
 node.querySelectorAll('script,style,button,input,select,textarea,pre,code,[hidden]').forEach(n=>n.remove());
 return node;
}
export function buildDashboardReport(source,target,{title='Dashboard',subtitle=''}={}){
 target.head.innerHTML='';target.body.innerHTML='';target.title=title;
 const style=target.createElement('style');style.textContent=PRINT_CSS;target.head.append(style);
 const h1=target.createElement('h1');h1.textContent=title;target.body.append(h1);
 const sub=target.createElement('p');sub.textContent=subtitle;target.body.append(sub);
 for(const widget of orderedReportWidgets(source)){
  const copy=widget.cloneNode(true);
  copy.querySelectorAll('details:not([open]),[hidden],pre,code').forEach(n=>n.remove());
  copy.querySelectorAll('button,input,select,textarea,.tl-analysis-widget-tools,.tl-analysis-widget-move,.tl-popover-anchor,.tl-analysis-series-summary').forEach(n=>n.remove());
  const section=target.createElement('section');section.className='report-widget';
  const heading=target.createElement('h2');heading.textContent=widget.querySelector('h3')?.textContent??'Chart';section.append(heading);
  const originalCharts=[...widget.querySelectorAll('optimove-dashboard-chart')];
  for(const [index,host]of [...copy.querySelectorAll('optimove-dashboard-chart')].entries()){
   const original=originalCharts[index];let svg=original?.printSvg?.();
   if(!svg&&original?.querySelector('svg'))svg=original.querySelector('svg').outerHTML;
   if(!svg)throw Error('Charts are still loading. Try PDF again.');
   const holder=target.createElement('div');holder.innerHTML=svg;const drawing=holder.querySelector('svg');if(!drawing)throw Error('A chart could not be prepared. Try PDF again.');
   if(!drawing.hasAttribute('viewBox'))drawing.setAttribute('viewBox',`0 0 ${drawing.getAttribute('width')||600} ${drawing.getAttribute('height')||300}`);
   drawing.removeAttribute('width');drawing.removeAttribute('height');
   const names=original.printLegend?.()??[],legend=target.createElement('ul');legend.className='report-legend';
   for(const item of names){const entry=target.createElement('li'),swatch=target.createElement('span');swatch.style.backgroundColor=item.color;entry.append(swatch,target.createTextNode(item.name));legend.append(entry);}
   host.replaceWith(...(names.length?[legend,drawing]:[drawing]));
  }
  const tables=[...copy.querySelectorAll('table')];tables.forEach(n=>n.remove());
  for(const node of [...copy.querySelectorAll('.tl-analysis-plot,.tl-analysis-kpi,p[role="status"],.builder-error')]){
   if(node.parentElement?.closest('.tl-analysis-plot,.tl-analysis-kpi'))continue;
   section.append(scrub(node));
  }
  target.body.append(section);
  for(const table of tables){const values=target.createElement('section');values.className='report-values';const label=target.createElement('h2');label.textContent=heading.textContent+' — values';values.append(label,scrub(table));target.body.append(values);}
 }
 return target;
}
export async function printDashboardPage(root,options={},scope=globalThis.window){
 if(!root||!orderedReportWidgets(root).length)throw Error('There are no widgets to export. Add a widget first.');
 const popup=scope.open('','_blank');if(!popup)throw Error('The report window was blocked. Allow pop-ups and try PDF again.');
 try{
  popup.opener=null;buildDashboardReport(root,popup.document,options);
  await popup.document.fonts?.ready;
  const pageHeight=1030;for(const table of popup.document.querySelectorAll('.report-values'))if(table.getBoundingClientRect().height>pageHeight)table.classList.add('is-long');
  popup.focus();popup.print();return popup;
 }catch(error){popup.close();throw error}
}
