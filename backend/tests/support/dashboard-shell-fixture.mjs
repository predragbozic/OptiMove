// Real backend HTTP fixture. All dependencies resolve from backend/node_modules;
// no browser tooling, E2E helpers or persistent database is used.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { createDisposableDatabase } from './disposable-db.mjs';
import { bootstrapLegacySnapshot } from './legacy-bootstrap.mjs';
import { runMigrations } from '../../src/migrate.js';
import { createSession, hashPassword } from '../../src/auth.js';
import { generateKeyEntry } from '../../src/sourceCredentialCrypto.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
async function seed(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const club = async name => (await client.query('insert into public.clubs(name) values($1) returning id', [name])).rows[0].id;
    const clubA = await club('Example Club'), clubB = await club('Other Club');
    const team = async (clubId, name) => (await client.query('insert into public.teams(club_id,name) values($1,$2) returning id', [clubId,name])).rows[0].id;
    const teamA = await team(clubA,'First team'), teamA2 = await team(clubA,'U19 team'), teamB = await team(clubB,'Other team');
    const athleteIds = [];
    for (const first of ['Ana','Bojan','Cara','Dario','Ema','Filip','Gaia','Hugo','Iva','Jan','Kira','Luka']) {
      const id = (await client.query("insert into public.athletes(athlete_id,first_name,last_name,full_name,display_name,device_timezone) values(nextval('public.athlete_generated_id_seq')::text,$1,'Example',$2,$2,'Europe/Sarajevo') returning id", [first,`${first} Example`])).rows[0].id;
      await client.query("insert into public.athlete_memberships(athlete_id,club_id,team_id,membership_type,status,starts_at) values($1,$2,null,'club','active','2026-01-01T00:00:00Z'),($1,$2,$3,'team','active','2026-01-01T00:00:00Z')", [id,clubA,teamA]);
      athleteIds.push(id);
    }
    const account = async (role, type, first) => {
      const name = `${first} Example`;
      const id = (await client.query("insert into public.users(email,first_name,last_name,full_name,display_name,password_hash) values($1,$2,'Example',$3,$3,$4) returning id", [`${role}@shell-test.invalid`,first,name,hashPassword(crypto.randomBytes(24).toString('base64url'))])).rows[0].id;
      if (role === 'platform_admin') await client.query("insert into public.user_global_roles(user_id,role,is_active) values($1,'platform_admin',true)", [id]);
      else if (role === 'athlete') await client.query('update public.athletes set user_id=$1 where id=$2', [id,athleteIds[0]]);
      else if (role === 'independent_coach') await client.query("insert into public.user_global_roles(user_id,role,is_active) values($1,'independent_coach',true)", [id]);
      else if (role === 'club_admin') await client.query("insert into public.user_club_roles(user_id,club_id,role,is_active) values($1,$2,'club_admin',true)", [id,clubA]);
      else if (role === 'team_coach') await client.query("insert into public.user_team_roles(user_id,team_id,role,is_active) values($1,$2,'team_coach',true)", [id,teamA]);
      await client.query('insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,$2,$3)', [id,type,type==='club'?clubA:type==='team'?teamA:null]);
      return { role,id,sessionToken:await createSession(id,client) };
    };
    const accounts = [await account('platform_admin','platform','Platform Admin'), await account('athlete','athlete','Ana'), await account('club_admin','club','Club Admin'), await account('team_coach','team','Team Coach'), await account('independent_coach','private_coach','Private Coach')];
    return { accounts,ids:{clubA,clubB,teamA,teamA2,teamB,athleteIds} };
  } finally { await client.end(); }
}

async function freePort() {
  return new Promise((resolve,reject) => {
    const server = net.createServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',() => { const port=server.address().port;server.close(() => resolve(port)); });
  });
}

export async function startDashboardShellFixture({ envOverrides = {} } = {}) {
  const db = await createDisposableDatabase({prefix:'dashboard',label:'shell_http'});
  let child;
  const stop = async () => {
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        const timeout=setTimeout(() => child.kill('SIGKILL'),3000);
        child.once('exit',() => { clearTimeout(timeout);resolve(); });
        child.kill('SIGTERM');
      });
    }
    await db.drop();
  };
  try {
    const migrationsRoot=path.join(root,'migrations_v2');
    const snapshotSql=fs.readFileSync(path.join(root,'backend/tests/support/legacy-schema.sql'),'utf8');
    const lastMigration=snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)?.[1];
    if (!lastMigration) throw new Error('Legacy snapshot migration marker missing');
    await bootstrapLegacySnapshot({databaseUrl:db.url,snapshotSql,migrationsRoot,lastMigration});
    await runMigrations({databaseUrl:db.url,migrationsRoot});
    const seeded=await seed(db.url);
    const port=await freePort(),baseUrl=`http://127.0.0.1:${port}`;
    const env={...process.env,...envOverrides,DATABASE_URL:db.url,PORT:String(port),NODE_ENV:'development'};
    for (const key of Object.keys(env)) if (/^(SUPABASE|RENDER|GPEXE_API_TOKEN|SOURCE_CREDENTIAL_|APP_ERROR_USER_HASH_KEYS)/.test(key)) delete env[key];
    env.SOURCE_CREDENTIAL_KEYS=generateKeyEntry(1);
    env.APP_ERROR_USER_HASH_KEYS=generateKeyEntry(2);
    child=spawn(process.execPath,['src/server.js'],{cwd:path.join(root,'backend'),env,stdio:'ignore',windowsHide:true});
    const until=Date.now()+60000;
    while (Date.now()<until) {
      if (child.exitCode!==null) throw new Error(`Backend fixture exited: ${child.exitCode}`);
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return {...seeded,baseUrl,databaseUrl:db.url,stop}; } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve,100));
    }
    throw new Error('Backend fixture startup timed out');
  } catch (error) { await stop();throw error; }
}
