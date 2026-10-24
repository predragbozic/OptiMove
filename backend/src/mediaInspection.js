import { Worker } from 'node:worker_threads';

import { MediaStorageError } from './mediaStorage.js';
const invalid = () => new MediaStorageError(422,'media_verification_failed');
const unsupported = () => new MediaStorageError(415,'unsupported_media');
const tooLong = () => new MediaStorageError(415,'video_too_long');
const MAX_PROBE_BYTES=8*1024*1024;
const MAX_PIXELS=16777216;
// The owner's rule of 2026-10-19: an exercise video is at most 30 seconds. The
// client refuses a longer one before converting or sending it; the server
// checks the container's declared durations (it never reads the sample tables,
// so a file whose headers understate its length is bounded by the size cap,
// not by this rule). MEDIA_MAX_VIDEO_SECONDS can only lower the limit (tests).
const PRODUCT_MAX_VIDEO_SECONDS=30;
const envSeconds=Number(process.env.MEDIA_MAX_VIDEO_SECONDS);
export const MAX_VIDEO_SECONDS=Number.isFinite(envSeconds) && envSeconds>0 ? Math.min(PRODUCT_MAX_VIDEO_SECONDS,envSeconds) : PRODUCT_MAX_VIDEO_SECONDS;
// The owner's rule of 2026-10-21 for the Drive import: existing exercise videos
// are kept whole (the longest is 154 s), so an import allows up to 180 s.
// MEDIA_MAX_IMPORT_VIDEO_SECONDS can only lower it (tests).
const IMPORT_MAX_VIDEO_SECONDS=180;
const envImportSeconds=Number(process.env.MEDIA_MAX_IMPORT_VIDEO_SECONDS);
export const DRIVE_IMPORT_MAX_VIDEO_SECONDS=Number.isFinite(envImportSeconds) && envImportSeconds>0 ? Math.min(IMPORT_MAX_VIDEO_SECONDS,envImportSeconds) : IMPORT_MAX_VIDEO_SECONDS;
// Track kinds phones write beside the picture and the sound (timed metadata,
// timecode, chapters, captions): the player never parses them, so they do not
// count as media - but at most a few, and their length still counts.
const IGNORED_TRACK_TYPES=new Set(['Other','Text','Menu']);
const MAX_IGNORED_TRACKS=8;

export function validateVideoTracks(result,mimeType,{maxSeconds=MAX_VIDEO_SECONDS}={}) {
  const tracks=result?.media?.track || [];
  const general=tracks.find(t=>t['@type']==='General');
  const videos=tracks.filter(t=>t['@type']==='Video');
  const audio=tracks.filter(t=>t['@type']==='Audio');
  const ignored=tracks.filter(t=>IGNORED_TRACK_TYPES.has(t['@type']));
  if (videos.length!==1 || audio.length>1 || ignored.length>MAX_IGNORED_TRACKS || tracks.some(t=>!['General','Video','Audio'].includes(t['@type']) && !IGNORED_TRACK_TYPES.has(t['@type']))) throw unsupported();
  const v=videos[0];
  const duration=Number(v.Duration || general?.Duration), width=Number(v.Width),height=Number(v.Height);
  if (!(duration>0 && duration<=14400 && width>0 && height>0 && width<=4096 && height<=4096 && width*height<=MAX_PIXELS)) throw unsupported();
  // A file plays until its longest track ends: the video, the audio, an
  // ignored track or the container's own duration, whichever is longest.
  const playing=Math.max(duration,Number(general?.Duration)||0,...audio.map(a=>Number(a.Duration)||0),...ignored.map(t=>Number(t.Duration)||0));
  if (playing>maxSeconds+0.05) throw tooLong();
  if (mimeType==='video/mp4') {
    if (general?.Format!=='MPEG-4' || v.Format!=='AVC' || !/^(Baseline|Constrained Baseline|Main|High)(@|$)/.test(v.Format_Profile || '') || Number(v.BitDepth)!==8 || v.ChromaSubsampling!=='4:2:0') throw unsupported();
    if (audio.some(a=>a.Format!=='AAC' || !/LC/.test(String(a.Format_AdditionalFeatures || a.Format_Profile || a.CommercialName || '')))) throw unsupported();
  } else if (mimeType==='video/webm') {
    if (general?.Format!=='WebM' || v.Format!=='VP8' || audio.some(a=>!['Opus','Vorbis'].includes(a.Format))) throw unsupported();
  } else throw unsupported();
  return {durationSeconds:duration,width,height,videoCodec:mimeType==='video/mp4'?'h264':'vp8',audioCodec:audio[0]?.Format?.toLowerCase() || null};
}
let activeInspections=0;
export async function inspectMedia(store,upload,head,{maxVideoSeconds=MAX_VIDEO_SECONDS}={}) {
  if(activeInspections>=1) {const e=new MediaStorageError(503,'media_inspection_busy');e.retryable=true;throw e;}
  activeInspections++;
  try {
    return await new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./mediaInspectionWorker.js',import.meta.url),{workerData:{size:Number(head.sizeBytes),mimeType:upload.expected_mime_type,maxVideoSeconds},resourceLimits:{maxOldGenerationSizeMb:64}});
      let settled=false,readBytes=0,reads=0;
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(result);};
      const timer=setTimeout(()=>finish(invalid()),30000);
      worker.on('error',()=>finish(invalid()));
      worker.on('exit',()=>{if(!settled)finish(invalid());});
      worker.on('message',async message=>{
        if(settled)return;
        if(message.result){finish(null,message.result);return;}
        if(message.error){finish(new MediaStorageError(message.status || 422,message.error));return;}
        const {id,length,offset}=message;
        const budget=upload.expected_mime_type.startsWith('image/')?10*1024*1024:MAX_PROBE_BYTES;
        if(!Number.isSafeInteger(length) || !Number.isSafeInteger(offset) || length<1 || offset<0 || offset+length>Number(head.sizeBytes) || ++reads>128 || (readBytes+=length)>budget) {finish(invalid());return;}
        try {const data=await store.read(upload.temporary_object_key,offset,length,head.etag);if(!settled)worker.postMessage({id,data});}
        catch(e){finish(e instanceof MediaStorageError?e:invalid());}
      });
    });
  } finally {activeInspections--;}
}