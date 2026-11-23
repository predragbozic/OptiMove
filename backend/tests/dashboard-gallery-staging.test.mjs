import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {stageGalleryFiles} from '../src/dashboardGallery/staging.js';
const hash=b=>createHash('sha256').update(b).digest('hex');const target='202611261000_training_load_v94_chart_shapes.sql',bytes=Buffer.from('v94');const requiredV91='b'.repeat(64);
const recorded=()=>new Map([['migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql',requiredV91]]);
test('single-file v94 staging omits unrecorded v92/v93 regardless of their merge order',()=>{
 for(const optional of [[],['202611241000_v92.sql'],['202611251000_v93.sql'],['202611241000_v92.sql','202611251000_v93.sql'],['202611251000_v93.sql','202611241000_v92.sql']]){
  const r=recorded(),files=[[target,bytes],['202611241000_v92.sql',Buffer.from('roles')],['202611251000_v93.sql',Buffer.from('calendar')]];
  for(const name of optional)r.set('migrations_v2/'+name,hash(files.find(([n])=>n===name)[1]));
  const result=stageGalleryFiles(files,r,{target,sha256:hash(bytes),requiredV91});assert.deepEqual(result.map(([name])=>name).sort(),[target,...optional].sort());
 }
});
test('staging refuses a missing prerequisite, target checksum drift, or a changed recorded file',()=>{
 assert.throws(()=>stageGalleryFiles([[target,bytes]],new Map(),{target,sha256:hash(bytes),requiredV91}),/v91/);
 assert.throws(()=>stageGalleryFiles([[target,bytes]],recorded(),{target,sha256:'a'.repeat(64),requiredV91}),/checksum/);
 const r=recorded();r.set('migrations_v2/old.sql','c'.repeat(64));assert.throws(()=>stageGalleryFiles([[target,bytes],['old.sql',Buffer.from('changed')]],r,{target,sha256:hash(bytes),requiredV91}),/Recorded migration checksum/);
});
