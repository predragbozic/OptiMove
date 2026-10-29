import { MediaStorageError } from './mediaStorage.js';

// Drive copies (migration 202610291100): an R2 copy of a Google Drive file that
// exercises and plan items still name by their legacy link. Drive's own player
// plays only for a browser signed in to Google (never on iPhone), and Drive
// refuses its files to other sites, so a legacy slot whose link names a copied
// file is served as that asset. No exercise, copy or plan-item row changes.
const fail=(status,code)=>{throw new MediaStorageError(status,code);};
export const DRIVE_FILE_ID_PATTERN=/^[A-Za-z0-9_-]{10,200}$/;
const kinds=['video','image'];

// The Drive file a link names, in the forms the frontend reads (media.js
// getDriveId): /file/d/<id>, ?id=<id> on drive.google.com, lh3 /d/<id>.
export function driveFileIdOf(url) {
  const raw=typeof url==='string'?url.trim():'';
  if(!raw)return null;
  const id=(raw.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) || [])[1]
    || (/drive\.google\.com/.test(raw) && (raw.match(/[?&]id=([^&#]+)/) || [])[1])
    || (raw.match(/lh3\.googleusercontent\.com\/d\/([^/?#=]+)/) || [])[1] || '';
  return DRIVE_FILE_ID_PATTERN.test(id)?id:null;
}
export function driveFileId(value) {
  if(typeof value!=='string' || !DRIVE_FILE_ID_PATTERN.test(value))fail(400,'invalid_request');
  return value;
}
export function copyKind(value) {
  if(!kinds.includes(value))fail(400,'invalid_request');
  return value;
}

// The ready copies of these Drive files: Map "<id>:<kind>" -> asset id. One query.
export async function readyDriveCopies(run,ids) {
  const wanted=[...new Set(ids.filter(Boolean))];
  const copies=new Map();
  if(!wanted.length)return copies;
  const rows=(await run(`select c.drive_file_id,c.kind,c.asset_id from media.drive_copies c
    join media.assets a on a.id=c.asset_id and a.status='ready' and a.kind=c.kind where c.drive_file_id=any($1::text[])`,[wanted])).rows;
  for(const r of rows)copies.set(`${r.drive_file_id}:${r.kind}`,r.asset_id);
  return copies;
}

export async function recordedDriveCopies(run,ids) {
  const wanted=[...new Set(ids.filter(Boolean))];
  if(!wanted.length)return new Set();
  const result=await run(`select drive_file_id,kind from media.drive_copies where drive_file_id=any($1::text[])
    union select drive_file_id,kind from media.drive_copy_events where event='created' and drive_file_id=any($1::text[])`,[wanted]);
  return new Set(result.rows.map(row=>`${row.drive_file_id}:${row.kind}`));
}

// Every legacy link that names a Drive file, in exercises and plan items.
const legacyLinksSql=kind=>{if(!kinds.includes(kind))fail(400,'invalid_request');return `
  select ${kind}_url as url from library.exercises where coalesce(${kind}_source,'legacy')='legacy' and (${kind}_url ilike '%drive.google.com%' or ${kind}_url ilike '%googleusercontent.com%')
  union all
  select ${kind}_url from plans.plan_items where coalesce(${kind}_source,'legacy')='legacy' and (${kind}_url ilike '%drive.google.com%' or ${kind}_url ilike '%googleusercontent.com%')`;};

// A read-only transaction with its own statement bound: the link scans read
// every exercise and plan item.
export async function withReadOnly(pool,work) {
  const c=await pool.connect();
  try {await c.query("begin read only");await c.query("set local statement_timeout='15s'");const r=await work(c.query.bind(c));await c.query('commit');return r;}
  catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
}

// Whether any exercise or plan item names this Drive file in a legacy slot.
export async function driveFileInUse(run,kind,id) {
  const rows=(await run(`select url from (${legacyLinksSql(kind)}) links where strpos(url,$1)>0`,[id])).rows;
  return rows.some(r=>driveFileIdOf(r.url)===id);
}

export function createDriveCopyService({pool}) {
  async function tx(work) {
    const c=await pool.connect();
    try {await c.query('begin');await c.query("set local lock_timeout='5s'");await c.query("set local statement_timeout='30s'");const r=await work(c);await c.query('commit');return r;}
    catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
  }
  return {
    // The Drive files the rows use, by kind, with how many rows name each and
    // whether it has a copy: what the import still has to do.
    async status() {
      return withReadOnly(pool,async run=>{
        const result={};
        for(const kind of kinds) {
          const counts=new Map();
          for(const r of (await run(legacyLinksSql(kind))).rows) {
            const id=driveFileIdOf(r.url);
            if(id)counts.set(id,(counts.get(id) || 0)+1);
          }
          const copies=await readyDriveCopies(run,[...counts.keys()]);
          result[kind]=[...counts].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,rows])=>({driveFileId:id,rows,copied:copies.has(`${id}:${kind}`),mediaId:copies.get(`${id}:${kind}`) || null}));
        }
        const account=(await run('select id from media.storage_accounts where owner_platform')).rows[0];
        return {videos:result.video,images:result.image,platformStorageAccountId:account?.id || null};
      });
    },
    // Inside the transaction that marks the import's asset ready (the upload
    // service's onCommit): one copy per Drive file and kind, never replaced.
    async insertCopy(c,upload,actorId) {
      const id=driveFileId(upload.context.driveFileId),kind=copyKind(upload.purpose==='drive_import_video'?'video':upload.purpose==='drive_import_image'?'image':'');
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`drive-copy:${id}:${kind}`]);
      if((await c.query('select 1 from media.drive_copies where drive_file_id=$1 and kind=$2',[id,kind])).rowCount)fail(409,'already_copied');
      await c.query('insert into media.drive_copies (drive_file_id,kind,asset_id,created_by_user_id) values ($1,$2,$3,$4)',[id,kind,upload.asset_id,actorId]);
      await c.query("insert into media.drive_copy_events (drive_file_id,kind,asset_id,event,performed_by_user_id) values ($1,$2,$3,'created',$4)",[id,kind,upload.asset_id,actorId]);
    },
    // Rollback of one copy: that file plays from Drive again. The R2 object
    // stays charged to the platform account until a later cleanup.
    async remove(actorId,kindValue,idValue,reasonValue) {
      const kind=copyKind(kindValue),id=driveFileId(idValue);
      if(typeof reasonValue!=='string' || !reasonValue.trim() || reasonValue.trim().length>1000)fail(400,'invalid_request');
      return tx(async c=>{
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`drive-copy:${id}:${kind}`]);
        const row=(await c.query('delete from media.drive_copies where drive_file_id=$1 and kind=$2 returning asset_id',[id,kind])).rows[0];
        if(!row)fail(404,'resource_not_found');
        await c.query("insert into media.drive_copy_events (drive_file_id,kind,asset_id,event,performed_by_user_id,reason) values ($1,$2,$3,'removed',$4,$5)",[id,kind,row.asset_id,actorId,reasonValue.trim()]);
        return {driveFileId:id,kind,removed:true};
      });
    },
  };
}
