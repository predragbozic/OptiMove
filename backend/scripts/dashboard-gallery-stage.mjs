// Owner-operated v94-only artifact. Never called by npm start or the rehearsal.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import pg from 'pg';
import {runMigrations} from '../src/migrate.js';import {stageGalleryFiles} from '../src/dashboardGallery/staging.js';
const manifest=JSON.parse(fs.readFileSync(new URL('../../docs/runbooks/dashboard-chart-shapes-v94-manifest.json',import.meta.url),'utf8'));
const target=path.basename(manifest.file);
if(process.argv.length!==4||process.argv[2]!=='--apply'||process.argv[3]!==target)throw Error('Specify --apply '+target+' only after the owner order and successful preflight.');
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required.');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});let recorded;
await client.connect();try{
 const target=(await client.query('select current_database() database,inet_server_addr() host,inet_server_port() port')).rows[0];console.log('Confirmed connection target:',target);
 recorded=new Map((await client.query('select migration_name,checksum from public.schema_migrations')).rows.map(row=>[row.migration_name,row.checksum]));
}finally{await client.end()}
const source=fileURLToPath(new URL('../../migrations_v2/',import.meta.url));
const files=fs.readdirSync(source).filter(name=>/^\d{12}_.*\.sql$/.test(name)).sort().map(name=>[name,fs.readFileSync(path.join(source,name))]);
const staged=stageGalleryFiles(files,recorded,{target,sha256:manifest.sha256,requiredV91:'1da5706c418c0f3262d6a88689e8d1355247a97d7d31bad4a82a59d396c52247'});
const outer=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-gallery-stage-')),root=path.join(outer,'migrations_v2');fs.mkdirSync(root);
try{for(const [name,bytes]of staged)fs.writeFileSync(path.join(root,name),bytes);await runMigrations({databaseUrl:process.env.DATABASE_URL,migrationsRoot:root});console.log('Only v94 was eligible to apply. Run its postcheck; do not activate an unrelated feature.');}finally{fs.rmSync(outer,{recursive:true,force:true})}
