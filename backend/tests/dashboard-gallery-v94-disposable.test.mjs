import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
import {createPagesDatabase} from './support/dashboard-pages-db.mjs';
import {PAGE_CATALOG_SQL} from './support/dashboard-pages-catalog.mjs';
import {validGalleryShape} from '../src/dashboardGallery/contract.js';
let db,q,actor;
const file='202611261000_training_load_v94_chart_shapes.sql';
const rollback=fs.readFileSync(new URL('../../docs/runbooks/dashboard-chart-shapes-v94-rollback.sql',import.meta.url),'utf8');
before(async()=>{db=await createPagesDatabase({through:'202611231100',label:'gallery_v94'});q=db.client;});
after(async()=>{await db?.drop()});
const tx=async fn=>{await q.query('begin');try{const value=await fn();await q.query('commit');return value}catch(e){await q.query('rollback');throw e}};
const shape=(kind,seriesIds,more={})=>({schemaVersion:1,kind,seriesIds,...more});
const pres=s=>({schemaVersion:1,chartShape:s});
async function fixture({type='bar_chart',keys=['duration_minutes']}={}){
 actor??=(await q.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('gallery@test.invalid','Gallery','Tester','Gallery Tester','Gallery Tester') returning id")).rows[0].id;
 const dashboard=(await q.query("select * from training_load.create_dashboard('Gallery',null,'user',$1,null,null,'platform',null,false,$1,null)",[actor])).rows[0];
 const widget=(await q.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by) values($1,$2,'Gallery',0,0,0,6,4,0,'day') returning *",[dashboard.id,type])).rows[0];
 const ids=[];for(const [index,key]of keys.entries()){
  const rev=(await q.query('select revision from training_load.dashboard_widgets where id=$1',[widget.id])).rows[0].revision;
  const scope=key==='session_count'?'day':'session';
  ids.push((await q.query("select * from training_load.add_series($1,$2,$3,null,$4,null,$5,null,null,'not_applicable',null,$6,'sum')",[widget.id,rev,index,key,index?'secondary':'primary',scope])).rows[0].series_id);
 }
 return{dashboard,widget,ids};
}
test('v94 applies → actual rollback → identical catalog → reapply with old rows unchanged',async()=>{
 const fixtureBefore=await fixture();const before=(await q.query(PAGE_CATALOG_SQL)).rows[0];const rowBefore=(await q.query('select to_jsonb(w) row from training_load.dashboard_widgets w where id=$1',[fixtureBefore.widget.id])).rows[0].row;
 const recordedBefore=new Set((await q.query('select migration_name from public.schema_migrations')).rows.map(r=>r.migration_name));
 const applied=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/dashboard-gallery-stage.mjs',import.meta.url)),'--apply',file],{env:{...process.env,DATABASE_URL:db.url},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
 assert.equal(applied.code,0,applied.output);assert.match(applied.output,/Only v94 was eligible to apply/);
 assert.deepEqual((await q.query('select migration_name from public.schema_migrations order by migration_name')).rows.map(r=>r.migration_name).filter(name=>!recordedBefore.has(name)),['migrations_v2/'+file]);
 assert.deepEqual((await q.query('select to_jsonb(w) row from training_load.dashboard_widgets w where id=$1',[fixtureBefore.widget.id])).rows[0].row,rowBefore);
 for(const runbook of ['postcheck']){const results=await q.query(fs.readFileSync(new URL('../../docs/runbooks/dashboard-chart-shapes-v94-'+runbook+'.sql',import.meta.url),'utf8'));for(const result of results)for(const row of result.rows??[])for(const value of Object.values(row))if(typeof value==='boolean')assert.equal(value,true);}
 await q.query(rollback);assert.deepEqual((await q.query(PAGE_CATALOG_SQL)).rows[0],before);
 await db.applyThrough('202611261000');
});
test('SQL/JS shape allow-lists agree on every gallery form and invalid unions',async()=>{
 const a=crypto.randomUUID(),b=crypto.randomUUID();
 const forms=[shape('area',[a]),shape('horizontal_bar',[a]),shape('scatter',[a,b]),shape('heatmap',[a]),shape('boxplot',[a]),shape('stacked',[a,b],{additive:true}),shape('combined',[a,b],{bindings:[{seriesId:a,mark:'bar',axis:0},{seriesId:b,mark:'line',axis:1}]})];
 const invalid=[null,{},shape('scatter',[a]),shape('boxplot',[a,b]),shape('area',[a,a.toUpperCase()]),shape('area',['bad']),shape('area',[a],{unknown:1}),shape('stacked',[a,b]),shape('combined',[a,b],{bindings:[]}),shape('combined',[a,b],{bindings:[{seriesId:a,mark:'bar',axis:0},{seriesId:b,mark:'line',axis:null}]})];
 for(const value of [...forms,...invalid])assert.equal((await q.query('select training_load.dashboard_chart_shape_valid($1) valid',[value])).rows[0].valid,validGalleryShape(value),JSON.stringify(value));
 assert.equal((await q.query("select training_load.dashboard_presentation_valid('{\"schemaVersion\":1}') valid")).rows[0].valid,true);
 assert.equal((await q.query('select training_load.dashboard_presentation_valid($1) valid',[{schemaVersion:1,chartShape:forms[0],tableFormatting:{evaluationVersion:1,rules:[]}}])).rows[0].valid,false);
});
test('deferred reference guard rejects missing series and leaves no use evidence on refused writes',async()=>{
 const f=await fixture();const count=(await q.query('select count(*)::int n from training_load.dashboard_chart_shape_usage')).rows[0].n;
 await assert.rejects(tx(()=>q.query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1',[f.widget.id,pres(shape('horizontal_bar',[crypto.randomUUID()]))])),e=>e.code==='S2C02'&&e.message==='gallerySeriesRequired');
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_chart_shape_usage')).rows[0].n,count);
});
test('rollback rejects changed bodies and later recorded migrations before dropping anything',async()=>{
 const definition=(await q.query("select pg_get_functiondef('training_load.dashboard_chart_shapes_available()'::regprocedure) body")).rows[0].body;
 await q.query("create or replace function training_load.dashboard_chart_shapes_available() returns boolean language sql immutable as $$select false;$$");
 await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/body changed/.test(e.message));await q.query('rollback');await q.query(definition);
 const future='migrations_v2/202611271000_v95_test_only.sql';await q.query("insert into public.schema_migrations(migration_name,checksum,execution_time_ms,runner_version) values($1,repeat('a',64),0,'test')",[future]);
 await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/later migration/.test(e.message));await q.query('rollback');await q.query('delete from public.schema_migrations where migration_name=$1',[future]);
});
test('real shape write is validated and use evidence is append-only even after the widget is deleted',async()=>{
 const f=await fixture();await q.query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1',[f.widget.id,pres(shape('horizontal_bar',f.ids))]);
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_chart_shape_usage where widget_id=$1',[f.widget.id])).rows[0].n,1);
 await assert.rejects(tx(()=>q.query('delete from training_load.dashboard_widget_series where id=$1',[f.ids[0]])),e=>e.code==='S2C02'&&e.message==='gallerySeriesRequired');
 for(const query of ['delete from training_load.dashboard_chart_shape_usage','update training_load.dashboard_chart_shape_usage set first_used_at=now()','truncate training_load.dashboard_chart_shape_usage'])await assert.rejects(q.query(query),e=>e.code==='23514'&&e.message==='chartShapeUseImmutable');
 await q.query('update training_load.dashboard_widgets set presentation_config=null where id=$1',[f.widget.id]);await q.query('delete from training_load.dashboard_widgets where id=$1',[f.widget.id]);
 await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/real gallery writes/.test(e.message));await q.query('rollback');
});
test('combined axis assignment accepts labelled compatible axes and refuses a false axis claim',async()=>{
 const f=await fixture({keys:['duration_minutes','srpe']});
 const bindings=f.ids.map((seriesId,axis)=>({seriesId,axis,mark:axis?'line':'bar'}));
 await q.query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1',[f.widget.id,pres(shape('combined',f.ids,{bindings}))]);
 await assert.rejects(tx(()=>q.query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1',[f.widget.id,pres(shape('combined',f.ids,{bindings:bindings.map(b=>({...b,axis:0}))}))])),e=>e.code==='S2C02'&&e.message==='incompatibleAxisUnit');
});
