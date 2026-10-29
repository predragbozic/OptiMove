import { parentPort,workerData } from 'node:worker_threads';
import mediaInfoFactory from 'mediainfo.js';
import sharp from 'sharp';
import { validateVideoTracks } from './mediaInspection.js';
const pending=new Map();let nextId=0;
parentPort.on('message',message=>{const callback=pending.get(message.id);if(callback){pending.delete(message.id);callback(Buffer.from(message.data));}});
async function read(length,offset) {
  length=Math.min(length,workerData.size-offset);
  const id=++nextId;
  return new Promise(resolve=>{pending.set(id,resolve);parentPort.postMessage({id,length,offset});});
}
let info;
try {
  let metadata;
  const mime=workerData.mimeType;
  if(mime.startsWith('image/')) {
    const data=await read(workerData.size,0);
    const image=sharp(data,{failOn:'warning',limitInputPixels:16777216,animated:true});
    const m=await image.metadata();
    const format={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'}[mime];
    if(!format || m.format!==format || (m.pages || 1)>1 || !m.width || !m.height || m.width*m.height>16777216) throw Object.assign(new Error(),{status:415,code:'unsupported_media'});
    await image.stats();
    metadata={width:m.width,height:m.height};
  } else {
    info=await mediaInfoFactory({format:'object',chunkSize:65536});
    metadata=validateVideoTracks(await info.analyzeData(workerData.size,read),mime,{maxSeconds:workerData.maxVideoSeconds});
  }
  parentPort.postMessage({result:metadata});
} catch(e) {parentPort.postMessage({error:['unsupported_media','video_too_long'].includes(e.code)?e.code:'media_verification_failed',status:e.status===415?415:422});}
finally {info?.close();parentPort.close();}
