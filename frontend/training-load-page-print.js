export function printDashboardPage(analysis) {
  const panel = document.querySelector('#tl-page-panel');
  if (!panel) return;
  const title = [analysis.dashboard.name, analysis.page?.name].filter(Boolean).join(' — ');
  const report = document.createElement('main');
  const heading = document.createElement('h1');
  heading.textContent = title;
  report.append(heading);
  const context = document.createElement('p');
  const { dateFrom, dateTo } = analysis.period ?? {};
  const activity = analysis.runtimeFilter?.activityId && (analysis.selectedActivity?.name || 'Selected activity');
  const component = analysis.componentOptions?.find(item => item.id === analysis.runtimeFilter?.componentId)?.name;
  const athleteCount = analysis.runtimeFilter?.athleteIds?.length;
  context.textContent = [dateFrom && dateTo && `${dateFrom} – ${dateTo}`, activity, component,
    athleteCount && `Athletes selected: ${athleteCount}`].filter(Boolean).join(' · ');
  report.append(context);

  const appendix = document.createElement('section');
  appendix.className = 'tl-print-appendix';
  const appendixHeading = document.createElement('h2');
  appendixHeading.textContent = 'Data behind the charts';
  appendix.append(appendixHeading);

  const widgets = [...panel.querySelectorAll('.tl-analysis-grid > .tl-analysis-widget')];
  const position = (widget, axis) => Number(widget.style.getPropertyValue(`--tl-${axis}`));
  widgets.sort((left, right) => position(left, 'y') - position(right, 'y') || position(left, 'x') - position(right, 'x'));
  for (const widget of widgets) {
    const copy = widget.cloneNode(true);
    const canvases = copy.querySelectorAll('canvas');
    widget.querySelectorAll('canvas').forEach((canvas, index) => {
      canvases[index].width = canvas.width;
      canvases[index].height = canvas.height;
      canvases[index].getContext('2d').drawImage(canvas, 0, 0);
    });
    copy.querySelectorAll('button, .tl-widget-menu-anchor, .tl-analysis-widget-tools, .tl-chart-tools, .tl-chart-point-details, .tl-chart-interaction-status')
      .forEach(control => control.remove());
    for (const chart of copy.querySelectorAll('optimove-dashboard-chart')) {
      // Print the existing plot without mounting an interactive chart in the print frame.
      const snapshot = document.createElement('div');
      snapshot.className = 'tl-print-plot';
      snapshot.append(...chart.childNodes);
      chart.replaceWith(snapshot);
    }
    const values = copy.querySelector('.tl-analysis-chart-values');
    const table = values?.open ? values.querySelector('.tl-analysis-table-wrap') : null;
    if (table) {
      const section = document.createElement('section');
      section.className = 'tl-print-chart-data';
      const label = document.createElement('h3');
      label.textContent = copy.querySelector('.tl-analysis-widget-head h3')?.textContent || 'Chart';
      section.append(label, table);
      appendix.append(section);
    }
    values?.remove();
    report.append(copy);
  }
  if (appendix.childElementCount > 1) report.append(appendix);
  if (!report.querySelector('article')) {
    const empty = document.createElement('p');
    empty.textContent = 'This page is empty.';
    report.append(empty);
  }

  const frame = document.createElement('iframe');
  frame.title = 'Dashboard page print preview';
  frame.style.cssText = 'position:fixed;width:1032px;height:700px;border:0;left:-10000px;top:0';
  document.body.append(frame);
  const target = frame.contentDocument;
  const printer = frame.contentWindow;
  target.title = title;
  const styles = [...document.querySelectorAll('link[rel="stylesheet"]')].map(source => {
    const link = target.createElement('link');
    link.rel = 'stylesheet';
    link.href = source.href;
    const ready = new Promise(resolve => {
      link.onload = resolve;
      link.onerror = resolve;
    });
    target.head.append(link);
    return ready;
  });
  const style = target.createElement('style');
  style.textContent = `
    @page { size: A4 landscape; margin: 12mm; }
    body { display: block !important; margin: 0; color: #172033; background: white; }
    main { display: block; width: auto; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    main > p { margin: 0 0 16px; }
    .tl-analysis-widget { display: block; position: static; height: auto; min-height: 0; margin: 0 0 12px;
      overflow: visible; print-color-adjust: exact; }
    .tl-analysis-widget-head { break-after: avoid; }
    .tl-print-plot { break-inside: avoid; }
    .tl-analysis-widget-body :is(div, section):has(> :is(canvas, svg)) { break-inside: avoid; }
    .tl-analysis-widget-body, .tl-analysis-widget-body :is(div, section) { overflow: visible; max-height: none; }
    .tl-analysis-widget-body :is(canvas, svg) { max-width: 100%; break-inside: avoid; }
    .tl-print-appendix { break-before: page; }
    .tl-print-appendix h2, .tl-print-chart-data h3, caption, thead { break-after: avoid; }
    .tl-print-chart-data { break-inside: avoid; margin-bottom: 16px; }
    .tl-print-chart-data .tl-analysis-table-wrap { overflow: visible; max-height: none; }
    .tl-analysis-table thead { display: table-header-group; }
    .tl-analysis-table tr { break-inside: avoid; }
  `;
  target.head.append(style);
  target.body.append(report);
  printer.addEventListener('afterprint', () => frame.remove(), { once: true });
  Promise.all(styles).then(async () => {
    await target.fonts?.ready;
    printer.focus();
    printer.print();
  });
}
