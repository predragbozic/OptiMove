import {dashboardWriteContract as v} from '../routes/trainingLoadDashboard.js';
import {validFilterShape} from '../trainingLoadDashboardCatalog.js';
import {isUuid} from '../dashboardSimple/schema.js';
import {canUseSimplePlatformPilot} from '../dashboardSimple/platformPilot.js';
const basic={create:v.CREATE_WIDGET_KEYS,content:v.UPDATE_WIDGET_CONTENT_KEYS,addSeries:v.ADD_SERIES_KEYS,updateSeries:v.UPDATE_SERIES_KEYS,delete:['expectedWidgetRevision'],deleteSeries:['expectedWidgetRevision'],widgetLayout:['expectedWidgetRevision','x','y','width','height','mobileOrder'],layout:['expectedRevision','layout'],reorderSeries:['expectedWidgetRevision','order'],resolveSeries:['expectedWidgetRevision','metricDefinitionId']};
export function validPageWidgetBody(operation,body,{req,workspace,mode}){
 if(!body||typeof body!=='object'||Array.isArray(body)||!basic[operation])return false;
 const keys=[...basic[operation],'expectedPageRevision'];
 const presentation=['create','content'].includes(operation)&&['preview','enabled'].includes(mode)&&canUseSimplePlatformPilot(req,workspace);
 if(presentation)keys.push('presentation');
 if(Object.keys(body).some(k=>!keys.includes(k)))return false;
 if(['create','layout'].includes(operation)&&!v.validRevision(body.expectedPageRevision))return false;
 if(!['create','layout'].includes(operation)&&!v.validRevision(body.expectedWidgetRevision))return false;
 if(operation==='create'){
  if(!v.validNonEmptyTrimmedString(body.widgetType,100)||!v.validNonEmptyTrimmedString(body.title,200)||!v.validNonNegInt(body.widgetOrder)||!v.validNonNegInt(body.mobileOrder)||!v.validX(body.x)||!v.validNonNegInt(body.y)||!v.validWidth(body.width)||!v.validPositiveInt(body.height))return false;
 }
 if(operation==='layout'&&!(Array.isArray(body.layout)&&body.layout.length<=200&&body.layout.every(v.validLayoutEntry)&&new Set(body.layout.map(x=>x.widgetId.toLowerCase())).size===body.layout.length))return false;
 if(operation==='reorderSeries'&&!(Array.isArray(body.order)&&body.order.length<=20&&body.order.every(v.validReorderEntry)&&new Set(body.order.map(x=>x.seriesId.toLowerCase())).size===body.order.length))return false;
 for(const field of ['metricDefinitionId','sourceConnectionId'])if(body[field]!=null&&!isUuid(body[field]))return false;
 if(operation==='resolveSeries'&&!isUuid(body.metricDefinitionId))return false;
 if(operation==='addSeries'){
  if(!v.validNonNegInt(body.seriesOrder))return false;
  if((Number(Boolean(body.metricDefinitionId))+Number(Boolean(body.builtInSeriesKey))+Number(Boolean(body.templateMetricKeyHints)))!==1)return false;
 }
 if(body.templateMetricKeyHints!=null&&!v.validTemplateHints(body.templateMetricKeyHints))return false;
 if(Object.hasOwn(body,'builtInSeriesKey')&&!v.validNonEmptyTrimmedString(body.builtInSeriesKey,100))return false;
 for(const [field,values] of Object.entries(v.enums))if(Object.hasOwn(body,field)&&!(field==='comparisonPeriod'&&body[field]===null)&&!values.has(body[field]))return false;
 for(const field of ['title','widgetType'])if(Object.hasOwn(body,field)&&!v.validNonEmptyTrimmedString(body[field],field==='title'?200:100))return false;
 for(const field of ['color','displayLabel'])if(Object.hasOwn(body,field)&&!v.validNullableLabelString(body[field],field==='color'?100:200))return false;
 for(const [field,validate] of Object.entries({x:v.validX,y:v.validNonNegInt,width:v.validWidth,height:v.validPositiveInt,mobileOrder:v.validNonNegInt,widgetOrder:v.validNonNegInt}))if(Object.hasOwn(body,field)&&!validate(body[field]))return false;
 if(Object.hasOwn(body,'displayConfig')&&!v.validDisplayConfig(body.displayConfig))return false;
 if(Object.hasOwn(body,'presentation')&&!v.validPresentationMode(body.presentation,operation==='create'?'create':'update'))return false;
 if(Object.hasOwn(body,'localFilterOverride')&&body.localFilterOverride!==null&&!validFilterShape(body.localFilterOverride))return false;
 if(['content','updateSeries','widgetLayout'].includes(operation)&&!Object.keys(body).some(k=>!['expectedPageRevision','expectedWidgetRevision'].includes(k)))return false;
 return true;
}
