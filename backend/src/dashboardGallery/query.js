import {buildGalleryData} from './data.js';
import {validGalleryShape} from './contract.js';
export async function galleryAvailable(query){return (await query("select to_regprocedure('training_load.dashboard_chart_shapes_available()') is not null as supported")).rows[0]?.supported===true;}
export function attachGalleryResult(widget,result){
 const shape=widget?.presentation_config?.schemaVersion===1?widget.presentation_config.chartShape:null;
 if(!shape)return result;
 return {...result,gallery:validGalleryShape(shape)?buildGalleryData({widget,result,shape}):{status:'unavailable',reason:'invalidChart',groups:[],omitted:0}};
}

export async function hydrateGalleryWidgets(query,widgets){
 const ids=widgets.filter(w=>w.presentation_config?.schemaVersion===1&&w.presentation_config.chartShape).map(w=>w.id);if(!ids.length)return widgets;
 const rows=(await query('select s.id,v.calculation from training_load.dashboard_widget_series s left join training_load.metric_definitions d on d.id=s.metric_definition_id left join training_load.metric_definition_versions v on v.id=d.current_version_id where s.widget_id=any($1::uuid[])',[ids])).rows;
 const calculations=new Map(rows.map(row=>[row.id,row.calculation]));
 return widgets.map(w=>({...w,series:w.series.map(s=>({...s,galleryCalculation:calculations.get(s.id)??null}))}));
}
