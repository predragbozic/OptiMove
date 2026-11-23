// Pure projections of an already-authorized dashboard result. This module never
// loads athletes/facts, changes aggregation, or uses a client-supplied row set.
export const GALLERY_LIMITS = Object.freeze({ series: 20, athletes: 20, rows: 16000, cells: 8000 });
const kinds = new Set(['area','horizontal_bar','combined','heatmap','scatter','stacked','boxplot']);
const badFlags = ['conflict','unitConflict','typeConflict','semanticConflict'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = v => typeof v === 'string' ? v.toLowerCase() : v;
const usable = r => object(r) && typeof r.value === 'number' && Number.isFinite(r.value)
  && !badFlags.some(key => r[key] === true) && r.error == null;
const key = row => JSON.stringify([lower(row.athleteId ?? null), row.bucketKey]);
const failure = reason => ({status:'unavailable',reason,groups:[],omitted:0});

function readSeries(widget, result, seriesId) {
  const definitions = widget.series.filter(s => object(s) && lower(s.id) === lower(seriesId));
  const answers = result.series.filter(s => object(s) && lower(s.seriesId) === lower(seriesId));
  if (definitions.length !== 1 || answers.length !== 1 || answers[0].status !== 'ok'
      || !Array.isArray(answers[0].data?.current)) return null;
  const rows = answers[0].data.current;
  if (rows.length > GALLERY_LIMITS.rows) return null;
  // Ambiguous unit is not a request to choose or convert one.
  const units = new Set(rows.map(r => r?.unit ?? null));
  if (units.size > 1) return null;
  const cells = new Map();
  for (const row of rows) {
    if (!object(row) || typeof row.bucketKey !== 'string' || !row.bucketKey
        || (row.athleteId != null && typeof row.athleteId !== 'string')
        || (row.unit != null && typeof row.unit !== 'string')) return null;
    const identity = key(row);
    if (!cells.has(identity)) cells.set(identity, []);
    cells.get(identity).push(row);
  }
  return {definition:definitions[0],answer:answers[0],cells,unit:[...units][0] ?? null};
}

export function galleryQuantile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction, lo = Math.floor(index), hi = Math.ceil(index);
  // Weighted interpolation avoids an overflowing (hi - lo) for opposite signs.
  return lo === hi ? sorted[lo] : sorted[lo] * (hi-index) + sorted[hi] * (index-lo);
}

export function buildGalleryData({widget,result,shape}) {
  if (!object(widget) || !object(result) || !object(shape) || !kinds.has(shape.kind)
      || lower(widget.id) !== lower(result.widgetId) || !Array.isArray(widget.series)
      || !Array.isArray(result.series) || !['line_chart','bar_chart'].includes(widget.widget_type)) return failure('invalidChart');
  const ids = shape.seriesIds ?? widget.series.map(s => s.id);
  if (!Array.isArray(ids) || !ids.length || ids.length > GALLERY_LIMITS.series
      || ids.some(id => typeof id !== 'string' || !id)
      || new Set(ids.map(lower)).size !== ids.length) return failure('invalidSeries');
  const series = ids.map(id => readSeries(widget,result,id));
  if (series.some(s => !s)) return failure('seriesUnavailable');
  const scopes = new Set(series.map(s => s.definition.data_scope_level ?? null));
  if (scopes.size !== 1) return failure('incompatibleScope');
  if (series.some(s => s.definition.comparison_period != null
      || s.answer.data.comparisonRange != null || s.answer.data.comparison?.length)) return failure('comparisonNotSupported');
  if (shape.kind === 'scatter' && (series.length !== 2 || !['day','week','session','component'].includes(widget.group_by))) return failure('chooseTwoSeries');
  if (['heatmap','boxplot'].includes(shape.kind) && series.length !== 1) return failure('chooseOneSeries');
  if (['heatmap','boxplot'].includes(shape.kind) && !['day','week'].includes(widget.group_by)) return failure('chooseDayOrWeek');
  if (['area','horizontal_bar'].includes(shape.kind) && new Set(series.map(s=>s.unit)).size!==1) return failure('incompatibleAxisUnit');
  if (shape.kind === 'combined') {
    if (series.length < 2) return failure('chooseAxes');
    if (!Array.isArray(shape.bindings) || shape.bindings.length !== series.length) return failure('chooseAxes');
    if(new Set(shape.bindings.map(b=>b.mark)).size!==2)return failure('chooseAxes');
    const assigned = new Set(), axes = new Map();
    for (const binding of shape.bindings) {
      const found = series.find(s => lower(s.definition.id) === lower(binding.seriesId));
      if (!found || assigned.has(lower(binding.seriesId)) || !['bar','line'].includes(binding.mark)
          || ![0,1].includes(binding.axis) || !found.unit) return failure('chooseAxes');
      assigned.add(lower(binding.seriesId));
      if (axes.has(binding.axis) && axes.get(binding.axis) !== found.unit) return failure('incompatibleAxisUnit');
      axes.set(binding.axis,found.unit);
    }
  }
  if (shape.kind === 'stacked') {
    const refs=series.map(s=>s.definition.metric_definition_id?['metric',s.definition.metric_definition_id]:s.definition.built_in_series_key?['builtin',s.definition.built_in_series_key]:null).filter(Boolean).map(v=>JSON.stringify(v));
    if(new Set(refs).size!==refs.length)return failure('nonAdditiveComponents');
    const metricIds=new Set(series.map(s=>s.definition.metric_definition_id).filter(Boolean));
    if(series.some(s=>(s.definition.galleryCalculation?.inputs??[]).some(id=>metricIds.has(id))))return failure('nonAdditiveComponents');
    if (shape.additive !== true || series.length < 2) return failure('declareComponents');
    if (series.some(s => s.definition.analytical_aggregation === 'ratio'
        || s.answer.calculation?.kind === 'ratio' || s.answer.data.calculation?.kind === 'ratio'
        || !s.unit || ['%','percent','percentage'].includes(s.unit.toLowerCase()))
        || new Set(series.map(s => s.unit)).size !== 1) return failure('nonAdditiveComponents');
  }
  const cellKeys = [...new Set(series.flatMap(s => [...s.cells.keys()]))].sort();
  if(shape.kind!=='boxplot'&&new Set(series.flatMap(s=>[...s.cells.keys()].map(key=>JSON.parse(key)[0])).filter(Boolean)).size>GALLERY_LIMITS.athletes)return failure('athleteLimitExceeded');
  if (cellKeys.length > GALLERY_LIMITS.cells) return failure('chartTooLarge');
  const groups = [];let omitted = 0;
  for (const identity of cellKeys) {
    const matches = series.map(s => s.cells.get(identity) ?? []);
    // No positional pairing, arbitrary source winner, null-to-zero or interpolation.
    const values=matches.map(rows=>rows.length===1 && usable(rows[0])?rows[0].value:null);
    if (values.some(n=>n===null)) { omitted++;if(['scatter','stacked','heatmap','boxplot'].includes(shape.kind))continue; }
    const [athleteId,bucketKey] = JSON.parse(identity);
    if (['heatmap','boxplot'].includes(shape.kind) && !athleteId) { omitted++;continue; }
    const group={athleteId,bucketKey,values};
    if (shape.kind === 'stacked') { group.total=values.reduce((sum,n)=>sum+n,0);if(!Number.isFinite(group.total)){omitted++;continue;} }
    groups.push(group);
  }
  const base={status:groups.some(g=>g.values.some(n=>n!==null))?(omitted?'partial':'ready'):'empty',kind:shape.kind,
    series:series.map(s=>({seriesId:s.definition.id,unit:s.unit})),groups,omitted};
  if (shape.kind !== 'boxplot') return base;
  const buckets=new Map();
  for(const g of groups){if(!buckets.has(g.bucketKey))buckets.set(g.bucketKey,[]);buckets.get(g.bucketKey).push(g.values[0]);}
  return {...base,groups:[...buckets].sort(([a],[b])=>a.localeCompare(b)).map(([bucketKey,samples])=>{
    samples.sort((a,b)=>a-b);const q1=galleryQuantile(samples,.25),median=galleryQuantile(samples,.5),q3=galleryQuantile(samples,.75);
    const iqr=q3-q1,lower=q1-1.5*iqr,upper=q3+1.5*iqr,inside=samples.filter(n=>n>=lower&&n<=upper);
    return {bucketKey,count:samples.length,box:[inside[0],q1,median,q3,inside.at(-1)],outliers:samples.filter(n=>n<lower||n>upper)};
  })};
}
