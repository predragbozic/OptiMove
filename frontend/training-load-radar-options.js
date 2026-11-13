/** Build chart options from a server-provided Radar snapshot. */
export function radarChartOption(snapshot, axisLabels, athleteLabels) {
  const athleteData = snapshot.athletes.filter(athlete => athlete.polygon !== null).map(athlete => ({
    name: athleteLabels.get(athlete.athleteId) ?? athlete.athleteId,
    value: athlete.polygon
  }));
  if (snapshot.status !== 'ready' || !athleteData.length) return null;
  const names = new Set(['100% reference']);
  for (const athlete of athleteData) {
    const label = athlete.name;
    for (let suffix = 2; names.has(athlete.name); suffix++) athlete.name = `${label} (${suffix})`;
    names.add(athlete.name);
  }
  const indicators = snapshot.athletes[0].axes.map(axis => ({
    name: axisLabels.get(axis.metricDefinitionId) ?? axis.metricDefinitionId,
    min: 0, max: snapshot.radialMaximum
  }));
  return {
    animation: false,
    legend: { type: 'scroll' },
    tooltip: { trigger: 'item', renderMode: 'richText', confine: true },
    radar: { indicator: indicators },
    series: [{
      type: 'radar',
      data: [
        { name: '100% reference', value: indicators.map(() => 100), symbol: 'none',
          lineStyle: { type: 'dashed', color: '#525252' } },
        ...athleteData
      ]
    }]
  };
}
