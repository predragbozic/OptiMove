import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertGalleryRehearsalNode} from '../src/dashboardGallery/rehearsalConfig.js';
test('v94 rehearsal accepts Node 20, 22 and newer rather than requiring major 22',()=>{
 for(const version of ['20.0.0','20.19.0','22.22.0','24.0.0','26.1.0'])assert.equal(assertGalleryRehearsalNode(version),version);
 for(const version of ['18.20.8','19.9.0','22x',null,''])assert.throws(()=>assertGalleryRehearsalNode(version),/Node 20 or newer/);
});
