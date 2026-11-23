export function galleryDraftSettings(widget){
 const shape=widget.presentation_config?.schemaVersion===1&&widget.presentation_config.chartShape?.schemaVersion===1?widget.presentation_config.chartShape:null;
 return {galleryKind:shape?.kind??'standard',galleryKeys:shape?.seriesIds??null,galleryMarks:Object.fromEntries((shape?.bindings??[]).map(b=>[b.seriesId,b.mark])),galleryAdditive:shape?.additive===true};
}
export const GALLERY_CHOICES=[['standard','Standard'],['area','Area'],['horizontal_bar','Horizontal bar'],['combined','Bar + line'],['heatmap','Heatmap'],['scatter','Scatter'],['stacked','Stacked bar'],['boxplot','Box plot']];
export function galleryEntries(draft){return draft.galleryKeys?draft.galleryKeys.map(key=>draft.series.find(e=>e.key===key)).filter(Boolean):draft.series;}
export function galleryEditorProblem(draft){
 const kind=draft.galleryKind??'standard';if(kind==='standard')return '';
 const entries=galleryEntries(draft);
 if(!['line_chart','bar_chart'].includes(draft.widgetType))return 'This chart needs a line or bar display. Choose one of those types.';
 if(kind==='area'&&draft.widgetType!=='line_chart')return 'An area chart needs a line display. Choose Line chart.';
 if(kind==='horizontal_bar'&&draft.widgetType!=='bar_chart')return 'Horizontal bars need a bar display. Choose Bar chart.';
 if(!entries.length)return 'The chart needs measurements. Select at least one series.';
 if(['heatmap','boxplot'].includes(kind)&&(entries.length!==1||!['day','week'].includes(draft.groupBy)))return 'This chart needs one measurement grouped by date. Choose one series and group by day or week.';
 if(['heatmap','boxplot'].includes(kind)&&entries.some(e=>e.fields.analyticalAggregation!=='none'))return 'This chart needs separate athlete values. Choose Each measurement for its series.';
 if(kind==='scatter'&&entries.length!==2)return 'A scatter plot needs two measurements. Select its X and Y series in that order.';
 if(['combined','stacked'].includes(kind)&&entries.length<2)return 'This chart needs several measurements. Select at least two series.';
 if(kind==='stacked'&&!draft.galleryAdditive)return 'A stack needs additive parts. Confirm that these measurements are separate components of one total.';
 if(kind==='stacked'&&entries.some(e=>e.fields.analyticalAggregation==='ratio'))return 'Ratios cannot be stacked. Choose additive measurements.';
 if(kind==='combined'&&new Set(entries.map((e,i)=>draft.galleryMarks?.[e.key]??(i===entries.length-1?'line':'bar'))).size!==2)return 'This combination needs bars and a line. Choose both marks below.';
 return '';
}
export function gallerySettingsChanged(widget,draft){
 const old=widget.presentation_config?.schemaVersion===1?widget.presentation_config.chartShape:null;
 if((draft.galleryKind??'standard')!==(old?.kind??'standard'))return true;
 if(!old)return false;
 const entries=galleryEntries(draft);
 if(JSON.stringify(entries.map(e=>e.id))!==JSON.stringify(old.seriesIds))return true;
 if(draft.galleryKind==='stacked'&&draft.galleryAdditive!==old.additive)return true;
 if(draft.galleryKind==='combined')return entries.some(e=>{const b=old.bindings?.find(b=>b.seriesId===e.id);return (draft.galleryMarks?.[e.key]??b?.mark)!==b?.mark||((e.fields.axis??'primary')==='secondary'?1:0)!==b?.axis});
 return false;
}
export function galleryEditorPresentation(widget,draft){
 const config=widget.presentation_config?.schemaVersion===1?structuredClone(widget.presentation_config):{schemaVersion:1};
 delete config.chartShape;
 if((draft.galleryKind??'standard')==='standard')return config;
 const entries=galleryEntries(draft);if(entries.some(e=>!e.id))throw Error('Save the measurements before configuring the chart.');
 config.chartShape={schemaVersion:1,kind:draft.galleryKind,seriesIds:entries.map(e=>e.id),
  ...(draft.galleryKind==='stacked'?{additive:draft.galleryAdditive===true}:{}),
  ...(draft.galleryKind==='combined'?{bindings:entries.map((e,i)=>({seriesId:e.id,mark:draft.galleryMarks?.[e.key]??(i===entries.length-1?'line':'bar'),axis:e.fields.axis==='secondary'?1:0}))}:{})};
 return config;
}
