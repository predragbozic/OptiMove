// Explicit owner-operated A-only migration artifact. Never runs from npm start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '../src/migrate.js';
const file='202611231000_training_load_v90_dashboard_pages_home.sql';
if(process.argv.length!==4||process.argv[2]!=='--apply'||process.argv[3]!==file)throw Error('Specify --apply '+file+' after the owner order and successful preflight');
if(process.env.DASHBOARD_PAGES_ENABLED&&!['false'].includes(process.env.DASHBOARD_PAGES_ENABLED))throw Error('DASHBOARD_PAGES_ENABLED must be false for stage A');
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
const optional=new Map([
 ['202611221200_athletes_v87_positions.sql','f0422b12dd159e8be27e39357f03bc252e8b16045570a61285d9e17ce19cca54'],
 ['202611221300_training_load_v88_manual_values.sql','20002940bf6243e4a5d0519600e7cb0941e21d6b56990333bc9b245808ddd8e8'],
 ['202611221400_training_load_v89_participant_session_types.sql','2a74ca824cb774d98546ece898c6eb359f5b1b023a750a142433bb0044f62540']
]);
const client=new pg.Client({connectionString:process.env.DATABASE_URL});let recorded;
await client.connect();
try{await client.query('begin read only');recorded=new Map((await client.query('select migration_name,checksum from public.schema_migrations')).rows.map(row=>[row.migration_name,row.checksum]));await client.query('commit')}finally{await client.end()}
const source=fileURLToPath(new URL('../../migrations_v2/',import.meta.url));
const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-page-stage-a-'));
const temporary=path.join(temporaryRoot,'migrations_v2');fs.mkdirSync(temporary);
try{
 for(const name of fs.readdirSync(source).sort()){
  if(!/^[0-9]{12}_.*\.sql$/.test(name)||name.slice(0,12)>file.slice(0,12))continue;
  const bytes=fs.readFileSync(path.join(source,name)),hash=createHash('sha256').update(bytes).digest('hex');
  if(name===file){if(hash!=='dcfb07b959cc886fa1b3f99faad6916288d19448b837ebffbdb36b0aefc0bbaf')throw Error('Approved stage A checksum mismatch')}
  else if(recorded.has('migrations_v2/'+name)){if(recorded.get('migrations_v2/'+name)!==hash)throw Error('Recorded migration checksum mismatch: '+name)}
  else if(optional.has(name)){if(optional.get(name)!==hash)throw Error('Optional migration checksum mismatch: '+name);console.log('Not ordered by stage A; omitted: '+name);continue}
  else throw Error('Stage A refuses to apply another unrecorded migration: '+name);
  fs.writeFileSync(path.join(temporary,name),bytes);
 }
 if(!fs.existsSync(path.join(temporary,file)))throw Error('Approved stage A file missing');
 await runMigrations({databaseUrl:process.env.DATABASE_URL,migrationsRoot:temporary});
 console.log('Stage A recorded; run the v90 postcheck. Stage B was not included.');
}finally{fs.rmSync(temporaryRoot,{recursive:true,force:true})}
