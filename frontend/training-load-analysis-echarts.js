import {dashboardDisclosureOpen} from './training-load-dashboard-disclosures.js';
let libraryPromise;

function loadLibrary() {
  libraryPromise ??= import("./vendor/echarts/echarts-6.1.0.min.mjs").catch(error => {
    libraryPromise = null;
    throw error;
  });
  return libraryPromise;
}

export function registerDashboardChartElement(scope = globalThis, loader = loadLibrary) {
  if (!scope.customElements || scope.customElements.get("optimove-dashboard-chart")) return;
  class DashboardChart extends scope.HTMLElement {
    connectedCallback() {
      const generation = this.generation = (this.generation || 0) + 1;
      void this.mount(generation);
    }

    async mount(generation) {
      let chart;
      try {
        const library = await loader();
        if (!this.isConnected || generation !== this.generation) return;
        const plot = JSON.parse(this.getAttribute("data-chart"));
        const container = this.querySelector(".tl-analysis-echarts");
        const draw = () => {
          if (!this.isConnected || generation !== this.generation || !container.clientWidth || !container.clientHeight) return;
          try {
            if (chart) chart.resize();
            else {
              chart = this.chart = library.init(container, null, { renderer: "svg" });
              plot.option.tooltip.valueFormatter = value => typeof value === "number" && !Number.isInteger(value) ? value.toFixed(plot.precision) : String(value);
              if (plot.shortDateAxis || plot.shortDateCategoryAxis) {
                // Full category dates stay available in tooltips; shorten only axis labels.
                const dateAxis=plot.shortDateCategoryAxis==='y'?plot.option.yAxis:plot.option.xAxis;
                dateAxis.axisLabel??={};
                dateAxis.axisLabel.formatter = value => /^\d{2}\.\d{2}\.\d{4}$/.test(value) ? value.slice(0, 6) : value;
              }
              chart.setOption(plot.option, { notMerge: true });
              this.mountControls(plot,chart);
            }
          } catch {
            this.showFailure();
          }
        };
        if (scope.ResizeObserver) {
          this.observer = new scope.ResizeObserver(draw);
          this.observer.observe(container);
        } else {
          this.resize = draw;
          scope.addEventListener("resize", draw);
        }
        draw();
      } catch {
        if (this.isConnected && generation === this.generation) this.showFailure();
      }
    }

    mountControls(plot,chart){
      const settings=plot.interactions??{},widgetId=this.closest('[data-analysis-widget-id]')?.dataset.analysisWidgetId;
      const controls=scope.document.createElement('details');controls.className='tl-chart-controls';controls.dataset.dashboardDisclosure='controls';
      if(widgetId)controls.dataset.widgetId=widgetId;controls.open=dashboardDisclosureOpen(widgetId,'controls',true);
      const summary=scope.document.createElement('summary');summary.textContent='Chart controls';controls.append(summary);
      const addButton=(label,handler)=>{const button=scope.document.createElement('button');button.type='button';button.className='plain-button compact-button';button.textContent=label;button.addEventListener('click',()=>{if(this.isConnected&&this.chart===chart)handler()});controls.append(button);return button;};
      if(plot.option.legend?.show&&settings.legend?.toggle!==false)addButton('Show all series',()=>chart.dispatchAction?.({type:'legendAllSelect'}));
      if(plot.zoomDates?.length){
        addButton('Reset zoom',()=>chart.dispatchAction?.({type:'dataZoom',start:0,end:100}));
        if(widgetId&&settings.zoom?.applyPeriodAction&&Number.isInteger(plot.interactionGeneration)){
          const apply=addButton('Apply selected period',()=>{});apply.disabled=true;apply.dataset.action='training-load-analysis-chart-period';apply.dataset.widgetId=widgetId;apply.dataset.boundPeriod=JSON.stringify(plot.period);apply.dataset.boundGeneration=String(plot.interactionGeneration);
          chart.on?.('datazoom',event=>{
            const change=event.batch?.[0]??event,n=plot.zoomDates.length;
            const first=Number.isFinite(change.startValue)?change.startValue:Math.floor((change.start??0)*(n-1)/100);
            const last=Number.isFinite(change.endValue)?change.endValue:Math.ceil((change.end??100)*(n-1)/100);
            apply.dataset.dateFrom=plot.zoomDates[Math.max(0,Math.min(n-1,first))];apply.dataset.dateTo=plot.zoomDates[Math.max(0,Math.min(n-1,last))];apply.disabled=false;
          });
        }
      }
      if(controls.children.length>1)this.append(controls);
      if(settings.pointSelection?.mode==='details')chart.on?.('click',event=>{
        if(!this.isConnected||this.chart!==chart||event.componentType!=='series')return;
        let details=this.querySelector('.tl-chart-point');if(!details){details=scope.document.createElement('details');details.className='tl-chart-point';details.dataset.dashboardDisclosure='point';if(widgetId)details.dataset.widgetId=widgetId;const title=scope.document.createElement('summary');title.textContent='Selected point details';details.append(title,scope.document.createElement('p'));this.append(details);}
        const values=Array.isArray(event.value)?event.value:[event.value];
        details.querySelector('p').textContent=[event.seriesName,event.name,...values.filter(value=>typeof value==='number'&&Number.isFinite(value)).map(value=>Number.isInteger(value)?String(value):value.toFixed(plot.precision))].filter(Boolean).join(' · ');details.open=true;
      });
    }

    printLegend(){
      const options=this.chart?.getOption?.();if(!options?.legend?.[0]?.show)return [];
      const selected=options.legend[0].selected??{};
      return (options.series??[]).map((series,index)=>({name:series.name,color:this.chart.getVisual?.({seriesIndex:index},'color')??'#002d9c'})).filter(item=>selected[item.name]!==false);
    }

    printSvg(){
      const url=this.chart?.getDataURL?.({type:'svg',excludeComponents:['dataZoom','toolbox','legend']});
      if(url?.startsWith('data:image/svg+xml'))return decodeURIComponent(url.slice(url.indexOf(',')+1));
      return this.querySelector('svg')?.outerHTML??null;
    }

    showFailure() {
      this.release();
      const message = this.querySelector(".tl-analysis-chart-failure");
      if (message) message.hidden = false;
      const container = this.querySelector(".tl-analysis-echarts");
      if (container) container.hidden = true;
    }

    release() {
      this.observer?.disconnect();
      this.observer = null;
      if (this.resize) scope.removeEventListener("resize", this.resize);
      this.resize = null;
      this.chart?.dispose();
      this.chart = null;
    }

    disconnectedCallback() {
      this.generation = (this.generation || 0) + 1;
      this.release();
    }
  }
  scope.customElements.define("optimove-dashboard-chart", DashboardChart);
}

registerDashboardChartElement();
