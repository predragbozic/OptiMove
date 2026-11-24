import {createHash} from 'node:crypto';
export function stageGalleryFiles(files,recorded,{target,sha256,requiredV91}){
 if(recorded.get('migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql')!==requiredV91)throw Error('The exact v91 must already be recorded.');
 const staged=[];
 for(const [name,bytes]of files){
  const hash=createHash('sha256').update(bytes).digest('hex');
  if(name===target){if(hash!==sha256)throw Error('Approved v94 checksum mismatch.');staged.push([name,bytes]);}
  else if(recorded.has('migrations_v2/'+name)){if(recorded.get('migrations_v2/'+name)!==hash)throw Error('Recorded migration checksum mismatch: '+name);staged.push([name,bytes]);}
  // Unrecorded files, including v92/v93, are outside this single-file order.
 }
 if(!staged.some(([name])=>name===target))throw Error('Approved v94 file missing.');
 return staged;
}
