import { createHash, randomUUID } from 'node:crypto';

export class MediaStorageError extends Error {
  constructor(status, code, details = {}) { super(code); this.status = status; this.code = code; this.details = details; }
}
const fail = (status, code, details) => { throw new MediaStorageError(status, code, details); };
export const MIME_TYPES = ['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp'];
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail(400, 'invalid_request');
  return value.toLowerCase();
}
export function bytes(value, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) fail(400, 'invalid_request');
  const n = BigInt(value);
  if (n > 9223372036854775807n || (positive && n === 0n)) fail(400, 'invalid_request');
  return value;
}
function revision(value) {
  if (!Number.isInteger(value) || value < 1 || value >= 2147483647) fail(400, 'invalid_request');
  return value;
}
function reason(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1000) fail(400, 'invalid_request');
  return value.trim();
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function policyDto(p) {
  return { defaultLimitBytes: p.default_limit_bytes, maxVideoBytes: p.max_video_bytes, maxImageBytes: p.max_image_bytes,
    maxParallelUploads: p.max_parallel_uploads, allowedMimeTypes: p.allowed_mime_types };
}
function usageDto(a, p) {
  const limit = a.override_limit_bytes ?? p.default_limit_bytes;
  const available = BigInt(limit) - BigInt(a.used_bytes) - BigInt(a.reserved_bytes);
  return { storageAccountId: a.id, owner: a.owner_platform ? { type: 'platform', id: null } : { type: a.owner_user_id ? 'user' : 'club', id: a.owner_user_id || a.owner_club_id },
    usedBytes: a.used_bytes, reservedBytes: a.reserved_bytes, limitBytes: limit,
    availableBytes: (available > 0n ? available : 0n).toString(), limitSource: a.override_limit_bytes === null ? 'default' : 'override',
    overLimit: BigInt(a.used_bytes) + BigInt(a.reserved_bytes) > BigInt(limit), activeUploads: Number(a.active_uploads || 0),
    maxParallelUploads: p.max_parallel_uploads, maxVideoBytes: p.max_video_bytes, maxImageBytes: p.max_image_bytes,
    allowedMimeTypes: p.allowed_mime_types, overrideLimitBytes: a.override_limit_bytes, revision: a.revision };
}
const accountSelect = `select a.*, (select count(*) from media.uploads u where u.storage_account_id=a.id and u.status in ('reserved','verifying','cancelling')) as active_uploads from media.storage_accounts a`;
function pageLimit(value) {
  const n = value === undefined ? 50 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) fail(400, 'invalid_request');
  return n;
}
function cursorDecode(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 500) fail(400, 'invalid_request');
  try { const c = JSON.parse(Buffer.from(value, 'base64url').toString()); object(c); return c; }
  catch { fail(400, 'invalid_request'); }
}
const cursorEncode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// Internal service. Callers MUST resolve/authorize content ownership first.
// BE-1 exposes no reservation/commit/release HTTP endpoint or R2 permission.
export function createMediaStorageService(pool) {
  // commitBoundMs: the COMMIT's answer is awaited that long at most. On an
  // error or no answer the connection is discarded and the outcome is not
  // known here: 503 commit_outcome_unknown, which the caller resolves by
  // reading the row again on another connection (a Drive import completion).
  async function tx(work, { commitBoundMs = 0 } = {}) {
    const c = await pool.connect();
    let discard = false;
    try { await c.query('begin'); await c.query("set local lock_timeout='5s'"); await c.query("set local statement_timeout='15s'");
      const result = await work(c);
      if (!commitBoundMs) { await c.query('commit'); return result; }
      let timer;
      try {
        await Promise.race([c.query('commit'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('commit_timeout')), commitBoundMs); })]);
      } catch {
        discard = true;
        throw Object.assign(new MediaStorageError(503, 'commit_outcome_unknown'), { retryable: true });
      } finally { clearTimeout(timer); }
      return result;
    } catch (e) { if (!discard) await c.query('rollback').catch(() => {}); throw e; }
    finally { c.release(discard || undefined); }
  }
  const policy = async c => (await c.query('select * from media.storage_policy where id=true')).rows[0];
  const lockPolicy = async c => (await c.query('select * from media.storage_policy where id=true for share')).rows[0];
  async function lockAccount(c, id) {
    const a = (await c.query('select * from media.storage_accounts where id=$1 for update', [uuid(id)])).rows[0];
    if (!a) fail(404, 'resource_not_found');
    return a;
  }
  async function getAccount(c, id, p) {
    const a = (await c.query(`${accountSelect} where a.id=$1`, [uuid(id)])).rows[0];
    if (!a) fail(404, 'resource_not_found');
    return usageDto(a, p || await policy(c));
  }
  async function audit(c, actorId, accountId, oldValues, newValues, why) {
    await c.query(`insert into media.storage_limit_audit (storage_account_id,performed_by_user_id,old_values,new_values,reason) values ($1,$2,$3,$4,$5)`,
      [accountId, uuid(actorId), JSON.stringify(oldValues), JSON.stringify(newValues), reason(why)]);
  }
  async function ensureAccount(owner) {
    object(owner);
    // The one platform account (migration 202610211000): Drive copies, never a coach's quota.
    if (owner.type === 'platform') {
      await pool.query('insert into media.storage_accounts (owner_platform) values (true) on conflict (owner_platform) where owner_platform do nothing');
      return (await pool.query('select id from media.storage_accounts where owner_platform')).rows[0].id;
    }
    uuid(owner.id);
    if (!['user', 'club'].includes(owner.type)) fail(400, 'invalid_request');
    const col = owner.type === 'user' ? 'owner_user_id' : 'owner_club_id';
    // No overwrite of ownership or limit; concurrent first use is harmless.
    await pool.query(`insert into media.storage_accounts (${col}) values ($1) on conflict (${col}) do nothing`, [owner.id]);
    return (await pool.query(`select id from media.storage_accounts where ${col}=$1`, [owner.id])).rows[0].id;
  }
  return {
    ensureAccount,
    async getPolicy() { const p = await policy(pool); return { policy: policyDto(p), revision: p.revision }; },
    async getAccount(id) { return getAccount(pool, id); },
    async getUsage(owners) {
      // Explicitly supplied by the authorized route, never user-controlled IDs.
      const accounts = [];
      for (const owner of owners) accounts.push(await getAccount(pool, await ensureAccount(owner)));
      return { accounts };
    },
    async updatePolicy(actorId, body) {
      object(body); object(body.changes); revision(body.expectedRevision); reason(body.reason);
      const columns = { defaultLimitBytes: 'default_limit_bytes', maxVideoBytes: 'max_video_bytes', maxImageBytes: 'max_image_bytes', maxParallelUploads: 'max_parallel_uploads', allowedMimeTypes: 'allowed_mime_types' };
      const entries = Object.entries(body.changes);
      if (!entries.length || entries.some(([k]) => !Object.hasOwn(columns, k))) fail(400, 'invalid_request');
      for (const [k, v] of entries) {
        if (k.endsWith('Bytes')) bytes(v, { positive: k !== 'defaultLimitBytes' });
        else if (k === 'maxParallelUploads') { if (!Number.isInteger(v) || v < 1 || v > 20) fail(400, 'invalid_request'); }
        else if (!Array.isArray(v) || !v.length || v.length > MIME_TYPES.length || new Set(v).size !== v.length || v.some(x => !MIME_TYPES.includes(x))) fail(400, 'invalid_request');
      }
      return tx(async c => {
        const old = (await c.query('select * from media.storage_policy where id=true for update')).rows[0];
        if (old.revision !== body.expectedRevision) fail(409, 'revision_conflict');
        const values = entries.map(([,v]) => v);
        const assignments = entries.map(([k],i) => `${columns[k]}=$${i+1}`).join(',');
        const updated = (await c.query(`update media.storage_policy set ${assignments}, revision=revision+1,updated_at=now() where id=true returning *`, values)).rows[0];
        await audit(c, actorId, null, { ...policyDto(old), revision: old.revision }, { ...policyDto(updated), revision: updated.revision }, body.reason);
        return { policy: policyDto(updated), revision: updated.revision };
      });
    },
    async updateLimit(actorId, id, body) {
      object(body); revision(body.expectedRevision); reason(body.reason);
      if (body.limitBytes !== null) bytes(body.limitBytes);
      return tx(async c => {
        const p = await lockPolicy(c); const old = await lockAccount(c, id);
        if (old.revision !== body.expectedRevision) fail(409, 'revision_conflict');
        const updated = (await c.query('update media.storage_accounts set override_limit_bytes=$2,revision=revision+1,updated_at=now() where id=$1 returning *', [id, body.limitBytes])).rows[0];
        await audit(c, actorId, id, { limitBytes: old.override_limit_bytes, revision: old.revision }, { limitBytes: updated.override_limit_bytes, revision: updated.revision }, body.reason);
        return getAccount(c, id, p);
      });
    },
    async listAccounts(args = {}) {
      if (args.sort !== undefined && args.sort !== 'used_desc') fail(400, 'invalid_request');
      const limit = pageLimit(args.limit); const cursor = cursorDecode(args.cursor);
      if (cursor) { uuid(cursor.id); bytes(cursor.usedBytes); }
      const p = await policy(pool);
      const rows = (await pool.query(`${accountSelect} ${cursor ? 'where (a.used_bytes,a.id)<($1::bigint,$2::uuid)' : ''} order by a.used_bytes desc,a.id desc limit $${cursor ? 3 : 1}`,
        cursor ? [cursor.usedBytes, cursor.id, limit+1] : [limit+1])).rows;
      const selected = rows.slice(0,limit); const last = selected.at(-1);
      return { accounts: selected.map(a => usageDto(a,p)), nextCursor: rows.length > limit ? cursorEncode({usedBytes:last.used_bytes,id:last.id}) : null };
    },
    async listAudit(args = {}) {
      const limit = pageLimit(args.limit); const cursor = cursorDecode(args.cursor); const params = []; const where = [];
      if (args.storageAccountId) { params.push(uuid(args.storageAccountId)); where.push(`storage_account_id=$${params.length}`); }
      if (cursor) { uuid(cursor.id); if (typeof cursor.createdAt !== 'string' || !Number.isFinite(Date.parse(cursor.createdAt))) fail(400,'invalid_request');
        params.push(cursor.createdAt,cursor.id); where.push(`(created_at,id)<($${params.length-1}::timestamptz,$${params.length}::uuid)`); }
      params.push(limit+1);
      const rows = (await pool.query(`select id,storage_account_id,performed_by_user_id,old_values,new_values,reason,created_at,created_at::text as cursor_timestamp from media.storage_limit_audit ${where.length ? 'where '+where.join(' and ') : ''} order by created_at desc,id desc limit $${params.length}`,params)).rows;
      const chosen = rows.slice(0,limit); const last = chosen.at(-1);
      return { entries: chosen.map(r => ({id:r.id,storageAccountId:r.storage_account_id,performedByUserId:r.performed_by_user_id,oldValues:r.old_values,newValues:r.new_values,reason:r.reason,createdAt:r.created_at})),
        nextCursor: rows.length>limit ? cursorEncode({createdAt:last.cursor_timestamp,id:last.id}) : null };
    },
    async reserveUpload(input) {
      object(input); const accountId = uuid(input.storageAccountId); const actorId = uuid(input.uploadedByUserId); const key = uuid(input.idempotencyKey);
      const size = bytes(input.sizeBytes,{positive:true}); object(input.context);
      const purposes = {exercise_video:'video',exercise_image:'image',video_frame:'image',automatic_thumbnail:'image',drive_import_video:'video',drive_import_image:'image'};
      if (!Object.hasOwn(purposes,input.purpose) || purposes[input.purpose] !== input.kind || !MIME_TYPES.includes(input.mimeType) || !input.mimeType.startsWith(input.kind+'/')) fail(415,'unsupported_media');
      // An import purpose only with an import context, and the reverse (also a database check).
      if (input.purpose.startsWith('drive_import_') !== (input.context.type === 'drive_import')) fail(400,'invalid_request');
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds<1 || input.ttlSeconds>3600) fail(400,'invalid_request');
      const request = canonical({accountId,actorId,size,mimeType:input.mimeType,kind:input.kind,purpose:input.purpose,context:input.context});
      const serialized = JSON.stringify(request); if (serialized.length>8192) fail(400,'invalid_request');
      const fingerprint = createHash('sha256').update(serialized).digest('hex');
      return tx(async c => {
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actorId+':'+key]);
        const existing = (await c.query('select * from media.uploads where uploaded_by_user_id=$1 and idempotency_key=$2',[actorId,key])).rows[0];
        if (existing) { if (existing.request_fingerprint !== fingerprint) fail(409,'idempotency_conflict'); return existing; }
        // A caller's own refusal rule, in this transaction before anything is reserved.
        if (input.precheck) await input.precheck(c);
        const p = await lockPolicy(c); const a = await lockAccount(c,accountId);
        if (!p.allowed_mime_types.includes(input.mimeType)) fail(415,'unsupported_media');
        const max = input.kind==='video' ? p.max_video_bytes : p.max_image_bytes;
        if (BigInt(size)>BigInt(max)) fail(413,'file_too_large');
        const available = BigInt(a.override_limit_bytes ?? p.default_limit_bytes)-BigInt(a.used_bytes)-BigInt(a.reserved_bytes);
        if (BigInt(size)>available) fail(429,'storage_quota_exceeded');
        const active = (await c.query("select count(*) from media.uploads where storage_account_id=$1 and status in ('reserved','verifying','cancelling')",[accountId])).rows[0].count;
        if (Number(active)>=p.max_parallel_uploads) fail(429,'parallel_upload_limit');
        const assetId = randomUUID(); const uploadId = randomUUID();
        await c.query("insert into media.assets (id,object_key,kind,storage_account_id,uploaded_by_user_id) values ($1,$2,$3,$4,$5)",[assetId,`assets/${assetId}`,input.kind,accountId,actorId]);
        const upload = (await c.query(`insert into media.uploads (id,asset_id,storage_account_id,uploaded_by_user_id,idempotency_key,request_fingerprint,context,purpose,temporary_object_key,expected_size_bytes,expected_mime_type,reserved_bytes,expires_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,now()+$12*interval '1 second') returning *`,
          [uploadId,assetId,accountId,actorId,key,fingerprint,JSON.stringify(input.context),input.purpose,`pending/${uploadId}`,size,input.mimeType,input.ttlSeconds])).rows[0];
        await c.query('update media.storage_accounts set reserved_bytes=reserved_bytes+$2,updated_at=now() where id=$1',[accountId,size]);
        return upload;
      });
    },
    // Internal BE-2 hook, only AFTER verification of the immutable create-only object.
    // This does not itself verify an R2 object and is deliberately not routable.
    // onCommit(c, upload) runs in the same transaction, after the asset is ready:
    // a Drive import's copy row commits with its asset or not at all.
    async commitVerifiedUpload(uploadId, verified, { beforeCommit = null, onCommit = null, commitBoundMs = 0 } = {}) {
      uuid(uploadId); object(verified); bytes(verified.sizeBytes,{positive:true}); object(verified.metadata);
      if (JSON.stringify(verified.metadata).length>16384) fail(400,'invalid_request');
      return tx(async c => {
        if (beforeCommit) await beforeCommit(c);
        const found = (await c.query('select storage_account_id from media.uploads where id=$1',[uploadId])).rows[0];
        if (!found) fail(404,'resource_not_found');
        await lockAccount(c,found.storage_account_id);
        const u = (await c.query('select * from media.uploads where id=$1 for update',[uploadId])).rows[0];
        if (verified.sizeBytes!==u.expected_size_bytes || verified.mimeType!==u.expected_mime_type) fail(422,'media_verification_failed');
        if (u.status==='completed') return u;
        if (Object.hasOwn(u,'verification_token') && (u.status!=='verifying' || !u.verification_token || u.verification_token!==verified.verificationToken || verified.objectKey!==u.temporary_object_key)) fail(409,'state_conflict');
        if (verified.objectKey!==undefined && verified.objectKey!==u.temporary_object_key) fail(409,'state_conflict');
        if (!['reserved','verifying'].includes(u.status)) fail(409,'state_conflict');
        await c.query("update media.assets set status='ready',size_bytes=$2,mime_type=$3,metadata=$4,object_key=coalesce($5,object_key),source_video_asset_id=$6,updated_at=now() where id=$1",
          [u.asset_id,verified.sizeBytes,verified.mimeType,JSON.stringify(verified.metadata),verified.objectKey || null,verified.metadata.sourceVideoMediaId || null]);
        await c.query('update media.storage_accounts set reserved_bytes=reserved_bytes-$2,used_bytes=used_bytes+$3,updated_at=now() where id=$1',
          [u.storage_account_id,u.reserved_bytes,verified.sizeBytes]);
        if (onCommit) await onCommit(c, u);
        if (u.verification_token) await c.query("insert into media.upload_events(upload_id,performed_by_user_id,event) values($1,$2,'completed')",[uploadId,u.uploaded_by_user_id]);
        return (await c.query("update media.uploads set status='completed',updated_at=now() where id=$1 returning *",[uploadId])).rows[0];
      }, { commitBoundMs });
    },
    // Internal BE-2 hook: caller must first stop/expire every write capability
    // and verify pending/final objects were removed. Expiry alone is NOT proof.
    async releaseAfterCleanup(uploadId, { cleanupVerified = false, outcome = 'cancelled' } = {}) {
      uuid(uploadId); if (!cleanupVerified || !['cancelled','failed'].includes(outcome)) fail(409,'cleanup_required');
      return tx(async c => {
        const found = (await c.query('select storage_account_id from media.uploads where id=$1',[uploadId])).rows[0];
        if (!found) fail(404,'resource_not_found');
        await lockAccount(c,found.storage_account_id);
        const u = (await c.query('select * from media.uploads where id=$1 for update',[uploadId])).rows[0];
        if (['cancelled','failed'].includes(u.status)) return u;
        if (u.status==='completed') fail(409,'upload_already_completed');
        if (Object.hasOwn(u,'verification_token') && u.status!=='cancelling') fail(409,'cleanup_required');
        await c.query("update media.assets set status='failed',updated_at=now() where id=$1",[u.asset_id]);
        await c.query('update media.storage_accounts set reserved_bytes=reserved_bytes-$2,updated_at=now() where id=$1',[u.storage_account_id,u.reserved_bytes]);
        if (u.verification_token!==undefined) await c.query('insert into media.upload_events(upload_id,performed_by_user_id,event,error_code) values($1,$2,$3,$4)',[uploadId,u.uploaded_by_user_id,outcome,u.error_code || null]);
        return (await c.query('update media.uploads set status=$2,updated_at=now() where id=$1 returning *',[uploadId,outcome])).rows[0];
      });
    },
  };
}
