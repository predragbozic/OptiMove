import { state } from "./state.js";
import { analysisPeriodPresetKey, ANALYSIS_PERIOD_PRESETS } from "./training-load-analysis-data.js";
import { reportHandlerError } from "./app-errors-capture.js";
import { currentUserWorkspaceContextParts } from "./access.js";
let islandsPromise;
let islands;
let mounted = [];
let observer;
let context;
let open = false;
let renderRoot;
let generation = 0;
let repaint;
let pageMenuOpen=false;
let pageMenuContext;
const hostSelector = "[data-dashboard-controls]";
function releaseDisconnected() {
  const detached = mounted.filter(node => !node.isConnected);
  detached.forEach(node => islands?.unmountIsland(node));
  mounted = mounted.filter(node => node.isConnected);
  if (!mounted.length) { observer?.disconnect(); observer=null; }
}
export function disposeDashboardControls() {
  generation++;
  mounted.forEach(node => islands?.unmountIsland(node)); mounted=[];
  observer?.disconnect(); observer=null;
}
function setOpen(value,{ focus=false }={}) {
  open=value;
  const a=state.trainingLoad.analysis;
  if(value && (a.menu || a.picker?.open)) {
    a.menu=""; if(a.picker) a.picker.open=false;
    repaint?.(); return;
  }
  if (!renderRoot?.isConnected) return;
  paint(renderRoot);
  if (focus) renderRoot.querySelector(value ? '[aria-label="Close period and activity"]' : '.tl-compact-period')?.focus();
}
function paint(root) {
  const a=state.trainingLoad.analysis;
  const panel=root.querySelector("#dashboard-period-panel");
  if(panel) panel.hidden=!open;
  const selected=analysisPeriodPresetKey();
  const label=ANALYSIS_PERIOD_PRESETS.find(preset=>preset.key===selected)?.label || "Custom period";
  const busy=Boolean(a.saving||a.pageLoading||a.pageSaving||a.pagePending);
  const nextPageContext=JSON.stringify([context,a.selectedPageId]);
  if(pageMenuContext!==nextPageContext){pageMenuOpen=false;pageMenuContext=nextPageContext;}
  const props={
    period:[islands.DashboardPeriodButton,{label,open,activeFilter:Boolean(a.runtimeFilter?.activityId),onToggle:()=>setOpen(!open,{focus:true})}],
    fields:[islands.DashboardPeriodFields,{presets:ANALYSIS_PERIOD_PRESETS,selected,dateFrom:a.period.dateFrom,dateTo:a.period.dateTo,onClose:()=>setOpen(false,{focus:true})}],
    pages:[islands.DashboardPageStrip,{pages:a.pages??[],selectedPageId:a.selectedPageId,page:a.page,busy,canManage:a.pageCanManage,menuOpen:pageMenuOpen,onMenuOpenChange:value=>{pageMenuOpen=value;}}],
  };
  for(const node of root.querySelectorAll(hostSelector)) {
    const [Component,model]=props[node.dataset.dashboardControls]??[];
    if(!Component) continue;
    islands.mountIsland(node,Component,model,{name:"dashboard_controls"});
    if(!mounted.includes(node)) mounted.push(node);
  }
}
export async function mountDashboardControls(root, render) {
  repaint=render;
  const token=++generation;
  if(!root?.querySelector(hostSelector)) { disposeDashboardControls(); open=false; return; }
  renderRoot=root;
  const nextContext=JSON.stringify([...currentUserWorkspaceContextParts(),state.trainingLoad.analysis.selectedDashboardId]);
  if(context!==nextContext){open=false;context=nextContext;}
  try {
    islandsPromise??=import("./react-build/islands.js");
    islands=await islandsPromise;
    if(token!==generation||!root.isConnected||!root.querySelector(hostSelector)) return;
    releaseDisconnected();paint(root);
    observer??=new MutationObserver(releaseDisconnected);
    observer.observe(root.ownerDocument.body,{childList:true,subtree:true});
  } catch(error){islandsPromise=null;reportHandlerError(error,"dashboard_controls");}
}
// Bound once by app.js. Only the local disclosure closes: existing actions,
// navigation, fetch/auth and dashboard state remain the application's own.
export function closeDashboardControlPanel(event) {
  if(!open||!renderRoot?.isConnected) return false;
  if(event.type==="keydown"&&event.key==="Escape") {event.preventDefault();event.stopPropagation();setOpen(false,{focus:true});return true;}
  if(event.type==="pointerdown"&&!event.target.closest?.("#dashboard-period-panel, [data-dashboard-controls='period']")) {setOpen(false);return true;}
  return false;
}
