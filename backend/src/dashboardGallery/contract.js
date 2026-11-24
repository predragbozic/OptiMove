// Proposed nested chartShape contract. Kept isolated until the v94 SQL validator
// and capability gate can be enabled together; no existing save path is widened.
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed,required)=>object(value)&&Object.keys(value).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(value,k));
const kinds=new Set(['area','horizontal_bar','combined','heatmap','scatter','stacked','boxplot']);
export function validGalleryShape(shape) {
 if(!keys(shape,['schemaVersion','kind','seriesIds','bindings','additive'],['schemaVersion','kind','seriesIds'])
   ||shape.schemaVersion!==1||!kinds.has(shape.kind)||!Array.isArray(shape.seriesIds)
   ||!shape.seriesIds.length||shape.seriesIds.length>20||!shape.seriesIds.every(uuid)
   ||new Set(shape.seriesIds.map(s=>s.toLowerCase())).size!==shape.seriesIds.length)return false;
 if(['heatmap','boxplot'].includes(shape.kind)&&shape.seriesIds.length!==1)return false;
 if(shape.kind==='scatter'&&shape.seriesIds.length!==2)return false;
 if(['combined','stacked'].includes(shape.kind)&&shape.seriesIds.length<2)return false;
 if(shape.kind!=='combined'&&Object.hasOwn(shape,'bindings'))return false;
 if(shape.kind!=='stacked'&&Object.hasOwn(shape,'additive'))return false;
 if(shape.kind==='stacked'&&shape.additive!==true)return false;
 if(shape.kind==='combined'){
  if(!Array.isArray(shape.bindings)||shape.bindings.length!==shape.seriesIds.length)return false;
  const selected=new Set(shape.seriesIds.map(s=>s.toLowerCase())),seen=new Set(),marks=new Set();
  for(const b of shape.bindings){
   if(!keys(b,['seriesId','mark','axis'],['seriesId','mark','axis'])||!uuid(b.seriesId)
     ||!selected.has(b.seriesId.toLowerCase())||seen.has(b.seriesId.toLowerCase())
     ||!['bar','line'].includes(b.mark)||![0,1].includes(b.axis))return false;
   seen.add(b.seriesId.toLowerCase());marks.add(b.mark);
  }
  if(marks.size!==2)return false;
 }
 return true;
}
