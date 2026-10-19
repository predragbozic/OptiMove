import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MediaStorageError } from './mediaStorage.js';

const unavailable = () => Object.assign(new MediaStorageError(503,'media_storage_unavailable'),{retryable:true});
export function createR2UploadStore(env = process.env) {
  let client;
  function config() {
    if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID || '') || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || env.R2_BUCKET !== 'optimove-exercise-videos') throw unavailable();
    return {bucket:env.R2_BUCKET};
  }
  function sdk() {
    config();
    return client ||= new S3Client({region:'auto',endpoint:`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY},maxAttempts:2,
      requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  }
  async function send(command) {
    try {return await sdk().send(command,{abortSignal:AbortSignal.timeout(15000)});}
    catch(e) {if (e.$metadata?.httpStatusCode===404 || e.name==='NoSuchKey' || e.name==='NotFound') return null; throw unavailable();}
  }
  return {
    assertConfigured() { config(); },
    async signPut(upload) {
      const {bucket}=config();
      try {
        const url=await getSignedUrl(sdk(),new PutObjectCommand({Bucket:bucket,Key:upload.temporary_object_key,
          ContentType:upload.expected_mime_type,ContentLength:Number(upload.expected_size_bytes),IfNoneMatch:'*'}),
          {expiresIn:600,signingDate:new Date(new Date(upload.expires_at).getTime()-600000),
            signableHeaders:new Set(['content-type','content-length','if-none-match'])});
        const signed=new URL(url).searchParams.get('X-Amz-SignedHeaders')?.split(';') || [];
        if (!['content-type','content-length','if-none-match'].every(h=>signed.includes(h))) throw unavailable();
        return {method:'PUT',url,headers:{'Content-Type':upload.expected_mime_type,'If-None-Match':'*'},expiresAt:upload.expires_at};
      } catch { throw unavailable(); }
    },
    async head(key) {
      const r=await send(new HeadObjectCommand({Bucket:config().bucket,Key:key}));
      return r && {sizeBytes:String(r.ContentLength),mimeType:r.ContentType,etag:r.ETag,tombstone:r.Metadata?.['optimove-tombstone']==='true'};
    },
    async read(key,offset,length,etag) {
      const r=await send(new GetObjectCommand({Bucket:config().bucket,Key:key,Range:`bytes=${offset}-${offset+length-1}`,IfMatch:etag}));
      if (!r) throw new MediaStorageError(422,'media_verification_failed');
      const chunks=[]; let total=0;
      try {for await (const chunk of r.Body) {total+=chunk.length; if(total>length) {r.Body.destroy?.();throw new Error('read limit');}chunks.push(chunk);}}
      catch {r.Body?.destroy?.();throw unavailable();}
      if (total!==length) throw new MediaStorageError(422,'media_verification_failed');
      return Buffer.concat(chunks);
    },
    async tombstone(key) {
      // Every browser PUT is signed If-None-Match:*. A persistent zero-byte
      // sentinel fences even a request started before its signed URL expired.
      await send(new PutObjectCommand({Bucket:config().bucket,Key:key,Body:Buffer.alloc(0),ContentLength:0,
        ContentType:'application/octet-stream',Metadata:{'optimove-tombstone':'true'}}));
      const head=await this.head(key);
      if (!head || !head.tombstone || head.sizeBytes!=='0') throw unavailable();
    },
  };
}
