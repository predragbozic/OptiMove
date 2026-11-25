import { boundedText } from "../metricTextRules.js";
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const keys = (object, allowed, required = allowed) => object !== null && typeof object === "object" && !Array.isArray(object)
  && Object.keys(object).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(object, key));
const order = value => Number.isInteger(value) && value >= 0;
export { uuid as referenceUuid };
export const REFERENCE_LIMITS = Object.freeze({ columns: 20, rows: 100, valueKinds: 20, cells: 300, bytes: 60_000 });
export function validReferenceDraft(draft) {
  if (!keys(draft, ["columns", "rows", "valueKinds", "cells"])) return false;
  for (const field of Object.keys(REFERENCE_LIMITS).filter(key => key !== "bytes")) {
    if (!Array.isArray(draft[field]) || draft[field].length > REFERENCE_LIMITS[field]) return false;
  }
  if (!draft.columns.every(column => keys(column,["definitionId","unit","aggregation","dataLevel","order"])
    && uuid(column.definitionId) && (column.unit === null || boundedText(column.unit,30))
    && ["sum","avg","max","last","none","ratio"].includes(column.aggregation)
    && ["session","component","day"].includes(column.dataLevel) && order(column.order))) return false;
  if (!draft.rows.every(row => keys(row,["positionId","order"]) && uuid(row.positionId) && order(row.order))) return false;
  if (!draft.valueKinds.every(value => keys(value,["key","name","order"]) && /^[a-z][a-z0-9_]{0,39}$/.test(value.key)
    && boundedText(value.name,80) && order(value.order))) return false;
  const columns = new Set(draft.columns.map(row => row.definitionId.toLowerCase()));
  const rows = new Set(draft.rows.map(row => row.positionId.toLowerCase()));
  const kinds = new Set(draft.valueKinds.map(row => row.key));
  if (columns.size !== draft.columns.length || rows.size !== draft.rows.length || kinds.size !== draft.valueKinds.length) return false;
  const seen = new Set();
  return draft.cells.every(cell => {
    if (!keys(cell,["positionId","definitionId","valueKey","value"]) || !uuid(cell.positionId) || !uuid(cell.definitionId)
      || !rows.has(cell.positionId.toLowerCase()) || !columns.has(cell.definitionId.toLowerCase()) || !kinds.has(cell.valueKey)
      || typeof cell.value !== "number" || !Number.isFinite(cell.value) || Math.abs(cell.value)>1e15) return false;
    const key = `${cell.positionId.toLowerCase()}|${cell.definitionId.toLowerCase()}|${cell.valueKey}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function validReferenceWrite(action,body) {
  const common = ["requestId", "expectedRevision"];
  if (!keys(body,action === "create" ? ["requestId","name"] : action === "draft" ? [...common,"draft"] : common)) return false;
  if (!uuid(body.requestId)) return false;
  if (action === "create") return boundedText(body.name,80);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) return false;
  return action === "draft" ? validReferenceDraft(body.draft) : ["publish","archive"].includes(action);
}

export function validReferenceConfig(value) {
 const allowed=["schemaVersion","source","mode","clubId","tableId","versionId","teamId","axes"];
 if(!keys(value,allowed,["schemaVersion","source","mode","clubId","axes"])||value.schemaVersion!==1||!["preset","teamAverage"].includes(value.source)
  ||!["overlay","radar"].includes(value.mode)||!uuid(value.clubId)||!Array.isArray(value.axes)||value.axes.length<1||value.axes.length>20)return false;
 if(value.source==="preset"?(!uuid(value.tableId)||!uuid(value.versionId)||Object.hasOwn(value,"teamId"))
  :(!uuid(value.teamId)||Object.hasOwn(value,"tableId")||Object.hasOwn(value,"versionId")))return false;
 const seen=new Set(); const key=x=>typeof x==='string'&&/^[a-z][a-z0-9_]{0,39}$/.test(x);
 return value.axes.every(axis=>{
  if(!keys(axis,["seriesId","anchorKey","valueKeys","band"],["seriesId","valueKeys"])||!uuid(axis.seriesId)||seen.has(axis.seriesId.toLowerCase())
   ||!Array.isArray(axis.valueKeys)||axis.valueKeys.length<1||axis.valueKeys.length>20||!axis.valueKeys.every(item=>key(item)||(value.source==='teamAverage'&&item==='teamAverage'))||new Set(axis.valueKeys).size!==axis.valueKeys.length)return false;
  seen.add(axis.seriesId.toLowerCase());
  if(value.source==='teamAverage')return !Object.hasOwn(axis,'anchorKey')&&!Object.hasOwn(axis,'band')&&axis.valueKeys.length===1&&axis.valueKeys[0]==='teamAverage';
  return key(axis.anchorKey)&&(!Object.hasOwn(axis,'band')||keys(axis.band,['lowerKey','upperKey'])&&key(axis.band.lowerKey)&&key(axis.band.upperKey));
 });
}
