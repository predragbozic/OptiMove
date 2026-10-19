import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createMediaStorageService } from './mediaStorage.js';
import { createMediaUploadService } from './mediaUploads.js';
import { createR2UploadStore } from './r2UploadStore.js';
export async function runMediaUploadCleanup() {
  if(process.env.MEDIA_STORAGE_ENABLED!=='true')return {disabled:true};
  const {pool}=await import('./db.js');
  try{return await createMediaUploadService({pool,storage:createMediaStorageService(pool),store:createR2UploadStore()}).cleanupExpired();}
  finally{await pool.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await runMediaUploadCleanup()));}
  catch {console.error('[media] cleanup unavailable');process.exitCode=1;}
}
