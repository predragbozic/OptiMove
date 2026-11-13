import { bindDashboardChartInteractions, chartPointText } from './training-load-chart-interactions.js';

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
              plot.option.tooltip.valueFormatter = value => plot.enhanced && plot.settings.tooltip === 'exact' ? String(value) : typeof value === "number" && !Number.isInteger(value) ? value.toFixed(plot.precision) : String(value);
              if(plot.enhanced) {
                plot.option.tooltip.formatter = event => chartPointText(plot.rowsBySeries[event.seriesIndex]?.[event.dataIndex],plot.precision,plot.settings.tooltip==='formatted');
                for(const series of plot.option.series)series.label.formatter=event=>{
                  const value=series.type==='heatmap'?event.value?.[2]:series.type==='scatter'?event.value?.[1]:event.value;
                  return typeof value==='number' ? Number.isInteger(value)?String(value):value.toFixed(plot.precision) : '';
                };
              }
              if (plot.radarDetails) {
                plot.option.tooltip.formatter = event => (plot.radarDetails[event.dataIndex] ?? '').replace(/[{}]/g, '');
                chart.on('click', event => {
                  const series = plot.option.series[0].data[event.dataIndex];
                  if (event.componentType === 'series' && series) {
                    chart.dispatchAction({ type: 'legendToggleSelect', name: series.name });
                  }
                });
              }
              chart.setOption(plot.option, { notMerge: true });
              if (plot.radarDetails) {
                const controls = this.ownerDocument.createElement('div');
                controls.className = 'tl-chart-controls';
                controls.setAttribute('role', 'group');
                controls.setAttribute('aria-label', 'Radar series visibility');
                for (const { name } of plot.option.series[0].data) {
                  const button = this.ownerDocument.createElement('button');
                  button.type = 'button';
                  button.className = 'plain-button compact-button';
                  button.textContent = name;
                  button.setAttribute('aria-pressed', 'true');
                  button.addEventListener('click', () => chart.dispatchAction({ type: 'legendToggleSelect', name }));
                  chart.on('legendselectchanged', event => button.setAttribute('aria-pressed', String(event.selected[name] !== false)));
                  controls.append(button);
                }
                this.radarControls = controls;
                const values = this.closest('.tl-analysis-widget-body')?.querySelector('[data-radar-series-controls]');
                if (values) values.append(controls);
                else container.before(controls);
              }
              if(plot.enhanced)this.interactions = bindDashboardChartInteractions(this,chart,plot,scope);
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

    showFailure() {
      this.release();
      const message = this.querySelector(".tl-analysis-chart-failure");
      if (message) message.hidden = false;
      const container = this.querySelector(".tl-analysis-echarts");
      if (container) container.hidden = true;
    }

    release() {
      this.radarControls?.remove();
      this.radarControls = null;
      this.interactions?.();
      this.interactions = null;
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
