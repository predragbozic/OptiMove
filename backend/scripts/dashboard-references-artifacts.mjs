import {REFERENCE_DATA_DIGEST_SQL} from '../src/dashboardReferences/evidence.js';
// Development-only generator. Connects exclusively through the disposable helper.
import fs from 'node:fs';import crypto from 'node:crypto';
import {createPagesDatabase} from '../tests/support/dashboard-pages-db.mjs';
const file='migrations_v2/202611291000_training_load_v97_references.sql',base='docs/runbooks/dashboard-references-v97';
const db=await createPagesDatabase({through:'202611291000',label:'references_artifacts'});
try{
 const q=db.client;
 const functions=(await q.query("select p.oid::regprocedure::text signature,md5(p.prosrc) md5,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='training_load' and (p.proname like '%dashboard_reference%' or p.proname in ('dashboard_presentation_valid','dashboard_presentation_assert_compatible','dashboard_chart_shape_remap')) order by p.oid::regprocedure::text")).rows;
 const tables=(await q.query("select tablename from pg_tables where schemaname='training_load' and tablename like 'dashboard_reference_%' order by tablename")).rows.map(r=>r.tablename);
 const restore=[['dashboard_reference_legacy_valid','dashboard_presentation_valid','9ce11aa017244998674f357eac2d8c89'],['dashboard_reference_legacy_compatible','dashboard_presentation_assert_compatible','439d80f9e60bbf32479afdf58f102f4b'],['dashboard_reference_legacy_remap','dashboard_chart_shape_remap','ac6d865af34dcbfa510c66b0f1feb2da']];
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 const checks=functions.map(f=>' if (select md5(prosrc) from pg_proc where oid=to_regprocedure('+quote(f.signature)+')) is distinct from '+quote(f.md5)+" then raise exception 'v97 body changed: %',"+quote(f.signature)+" using errcode='23514'; end if;").join('\n');
 const manifest={file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),functions:functions.map(({signature,md5})=>({signature,md5})),tables};
 fs.writeFileSync(base+'-manifest.json',JSON.stringify(manifest,null,2)+'\n');
 let rollback="begin;\nset local lock_timeout='5s';\ndo $guard$ begin\n if exists(select 1 from public.schema_migrations where migration_name>"+quote(file)+") then raise exception 'v97 rollback refused: later migration' using errcode='23514';end if;\n"+checks+'\nend $guard$;\n';
 for(const table of ['dashboards','dashboard_pages','dashboard_widgets','dashboard_widget_series',...tables])rollback+='lock table training_load.'+table+' in access exclusive mode;\n';
 rollback+="do $use$ begin if exists(select 1 from training_load.dashboard_reference_tables) or exists(select 1 from training_load.dashboard_reference_requests) or exists(select 1 from training_load.dashboard_reference_widget_usage) or exists(select 1 from training_load.dashboard_widgets where presentation_config?'referenceConfig') then raise exception 'v97 rollback refused: real reference writes' using errcode='23514';end if;end $use$;\n";
 rollback+='drop trigger dashboard_reference_widget_check on training_load.dashboard_widgets;\ndrop trigger dashboard_reference_series_check on training_load.dashboard_widget_series;\n';
 for(const [helper,name] of restore){const f=functions.find(f=>f.signature.startsWith('training_load.'+helper+'('));if(!f)throw Error('Missing helper '+helper);rollback+=f.definition.replace('training_load.'+helper+'(','training_load.'+name+'(')+';\n';}
 rollback+='drop table '+tables.map(t=>'training_load.'+t).join(',')+';\n';
 const replacements=new Set(restore.map(r=>r[1]));
 // No CASCADE: an unexpected dependent object must stop the rollback.
 const drops=functions.filter(f=>!replacements.has(f.signature.split('.')[1].split('(')[0]));
 for(const f of [...drops.filter(f=>!f.signature.includes('dashboard_reference_config_valid(')),...drops.filter(f=>f.signature.includes('dashboard_reference_config_valid('))])rollback+='drop function '+f.signature+';\n';
 rollback+='do $restored$ begin\n';
 for(const [,name,md5]of restore){const f=functions.find(f=>f.signature.startsWith('training_load.'+name+'('));rollback+=' if (select md5(prosrc) from pg_proc where oid='+quote(f.signature)+"::regprocedure) is distinct from '"+md5+"' then raise exception 'v97 restored body mismatch';end if;\n";}
 rollback+='end $restored$;\ndelete from public.schema_migrations where migration_name='+quote(file)+';\ncommit;\n';fs.writeFileSync(base+'-rollback.sql',rollback);
 const required="select exists(select 1 from public.schema_migrations where migration_name='migrations_v2/202611261000_training_load_v94_chart_shapes.sql' and checksum='2c018c784ace8edc1cb0c9b729d5e0143166d813477899f678060d6c6ac304cb') v94_exact;\n";
 let pre=required;for(const [,name,md5]of restore){const f=functions.find(f=>f.signature.startsWith('training_load.'+name+'('));pre+='select (select md5(prosrc) from pg_proc where oid=to_regprocedure('+quote(f.signature)+'))='+quote(md5)+' '+name+'_exact;\n';}
 pre+="select not exists(select 1 from public.schema_migrations where migration_name="+quote(file)+") v97_absent;\nselect (select count(*) from training_load.dashboards) dashboards,(select count(*) from training_load.dashboard_widgets) widgets,(select count(*) from training_load.dashboard_widget_series) series;\n";fs.writeFileSync(base+'-preflight.sql',pre+REFERENCE_DATA_DIGEST_SQL);
 let post='select count(*)=1 and bool_and(checksum='+quote(manifest.sha256)+') v97_exact from public.schema_migrations where migration_name='+quote(file)+';\n';
 for(const f of functions)post+='select (select md5(prosrc) from pg_proc where oid=to_regprocedure('+quote(f.signature)+'))='+quote(f.md5)+' body_exact;\n';
 post+="select not exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='training_load' and (c.relname like 'dashboard_reference_%' or t.tgname like 'dashboard_reference_%') and not t.tgisinternal and t.tgenabled<>'O') triggers_enabled;\n";fs.writeFileSync(base+'-postcheck.sql',post+REFERENCE_DATA_DIGEST_SQL);
 console.log('Generated v97 packet from disposable catalog.');
}finally{await db.drop();}
