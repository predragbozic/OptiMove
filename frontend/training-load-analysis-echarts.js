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
                for(const series of plot.option.series)series.label.formatter=event=>typeof event.value==='number' ? Number.isInteger(event.value)?String(event.value):event.value.toFixed(plot.precision) : '';
              }
              chart.setOption(plot.option, { notMerge: true });
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
