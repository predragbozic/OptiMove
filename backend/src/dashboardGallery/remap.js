// Series identities must be remapped after copy/clone; unknown opaque versions
// remain byte-preserved and are never interpreted as gallery configurations.
export function remapGalleryPresentation(config,idMap){
 if(config?.schemaVersion!==1||!config.chartShape)return structuredClone(config);
 const copy=structuredClone(config),remap=id=>{const found=idMap.get(id.toLowerCase());if(!found)throw Object.assign(new Error('gallerySeriesRequired'),{code:'S2C02'});return found;};
 copy.chartShape.seriesIds=copy.chartShape.seriesIds.map(remap);
 if(copy.chartShape.bindings)copy.chartShape.bindings=copy.chartShape.bindings.map(b=>({...b,seriesId:remap(b.seriesId)}));
 return copy;
}
