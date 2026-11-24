// The P2 owner rehearsal supports maintained and newer Node releases, not only 22.
export function assertGalleryRehearsalNode(version=process.versions.node) {
  if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)||Number(version.split('.')[0])<20) {
    throw new Error('Use Node 20 or newer for the gallery rehearsal.');
  }
  return version;
}
