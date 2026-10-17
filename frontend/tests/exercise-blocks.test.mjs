import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderExerciseBlocksHtml } from "../exercise-blocks.js";
import { renderExerciseCollectionsHtml } from "../exercise-collections.js";
import { renderExerciseLibraryHtml } from "../exercise-library.js";
import { exerciseSearchUrl } from "../exercise-data.js";
import { openExerciseBlocks } from "../exercise-blocks.js";
import { state,emptyExerciseOptions } from "../state.js";

const block={id:"block-id",name:"Ankle <strength>",description:"Package description",exerciseCount:3,coverImageUrl:"https://example.test/cover.jpg",locked:false};
const other={id:"other",name:"Other",description:"Unassigned exercises",exerciseCount:2,coverImageUrl:""};

test("catalog uses cover cards, counts, Other and administrator-only Assign",()=>{
  const dom=new JSDOM(renderExerciseBlocksHtml({blocks:[block],other,canManageCollections:true}));
  assert.equal(dom.window.document.querySelectorAll(".exercise-block-card").length,2);
  assert.equal(dom.window.document.querySelector("img").src,block.coverImageUrl);
  assert.match(dom.window.document.body.textContent,/Ankle <strength>/);
  assert.equal(dom.window.document.querySelectorAll('[data-action="exercise-collections-open"]').length,2);
  const normal=renderExerciseBlocksHtml({blocks:[block],other,canManageCollections:false});
  assert.equal(normal.includes("Edit / Assign"),false);
  dom.window.close();
});

test("locked card has no open, copy, play or assign controls",()=>{
  const dom=new JSDOM(renderExerciseBlocksHtml({blocks:[{...block,locked:true}],other:{...other,exerciseCount:0},canManageCollections:false}));
  assert.ok(dom.window.document.querySelector(".is-locked"));
  assert.equal(dom.window.document.querySelectorAll("[data-open-block]").length,0);
  assert.match(dom.window.document.body.textContent,/Access required/);
  assert.equal(dom.window.document.querySelectorAll("iframe,video").length,0);
  dom.window.close();
});

test("editor supports pending checkbox selections, metadata and separate hidden/locked controls",()=>{
  const panel={draft:{name:"Block",exercises:[],users:[],accessAll:false},collections:[],search:{},pending:{exercises:[{id:"one"}],users:[]},options:{exercises:[{id:"one",name:"One"},{id:"two",name:"Two",collectionId:"elsewhere"}],users:[]}};
  const dom=new JSDOM(renderExerciseCollectionsHtml(panel));
  const doc=dom.window.document;
  assert.ok(doc.querySelector('[data-pick-kind="exercises"][data-id="one"]').checked);
  assert.ok(doc.querySelector('[data-pick-kind="exercises"][data-id="two"]').disabled);
  assert.match(doc.querySelector('[data-add-selected="exercises"]').textContent,/1/);
  for(const selector of ["[data-block-cover]","[data-block-description]","[data-block-all]","[data-block-preview]","[data-exercise-preview]"]) assert.ok(doc.querySelector(selector));
  assert.equal(doc.querySelector("[data-block-preview]").value,"hidden");
  dom.window.close();
});

test("block filtering reaches the server and locked rows are noninteractive separate previews",()=>{
  assert.equal(new URL(exerciseSearchUrl("",30,{collection:"other"}),"https://test.local").searchParams.get("collection"),"other");
  const html=renderExerciseLibraryHtml({exercises:[],itemIds:[],markedExerciseIds:new Set(),search:{filters:{},options:{},view:"list",lockedPreviews:[{name:"Locked title",blockName:"Restricted"}]},tagEditor:{open:false}});
  const dom=new JSDOM(html);
  assert.ok(dom.window.document.querySelector('[data-action="exercise-blocks-open"]'));
  assert.equal(dom.window.document.querySelectorAll(".exercise-locked-results button").length,0);
  assert.match(dom.window.document.querySelector(".exercise-locked-results").textContent,/Locked title/);
  dom.window.close();
});

test("opening a permitted block reuses normal library search with a server-side collection filter",async()=>{
  const dom=new JSDOM('<h2 id="screenTitle"></h2><div id="viewToolbar"></div><main id="content"></main>');
  globalThis.document=dom.window.document;
  globalThis.window=dom.window;
  const { els }=await import("../dom.js");
  els.title=document.querySelector("#screenTitle");
  els.toolbar=document.querySelector("#viewToolbar");
  els.content=document.querySelector("#content");
  state.currentUser={id:"coach-id",activeWorkspace:{type:"private_coach"}};
  state.exerciseSearch={filters:{},options:emptyExerciseOptions(),limit:30};
  state.markedExerciseIds=new Set();
  state.markedExercises=new Map();
  const requests=[];
  globalThis.fetch=async(url)=>{
    requests.push(String(url));
    return {ok:true,json:async()=>String(url).includes("/catalog")?{blocks:[block],other,canManageCollections:false}:String(url).includes("/options")?emptyExerciseOptions():{exercises:[],lockedPreviews:[]}};
  };
  await openExerciseBlocks({renderExercises(){},setLoading(){}});
  assert.equal(document.querySelectorAll(".exercise-block-card").length,2);
  document.querySelector('[data-open-block="block-id"]').click();
  await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(state.exerciseSearch.filters.collection,"block-id");
  assert.ok(requests.some((url)=>url.startsWith("/api/exercises?")&&new URL(url,"https://test.local").searchParams.get("collection")==="block-id"));
  assert.ok(document.querySelector("#exerciseSearch"));
  dom.window.close();
});

test("a late exercise response cannot replace the block catalog and realtime refresh stays in Blocks",async()=>{
  const dom=new JSDOM('<h2 id="screenTitle"></h2><div id="viewToolbar"></div><main id="content"></main>');
  globalThis.document=dom.window.document;
  globalThis.window=dom.window;
  const { els }=await import("../dom.js");
  const { searchExercises }=await import("../exercise-actions.js");
  const { clearAllViewCache }=await import("../view-cache.js");
  clearAllViewCache();
  els.title=document.querySelector("#screenTitle");
  els.toolbar=document.querySelector("#viewToolbar");
  els.content=document.querySelector("#content");
  state.currentUser={id:"late-coach",activeWorkspace:{type:"private_coach"}};
  state.exerciseSearch={surface:"exercises",term:"",filters:{},options:emptyExerciseOptions(),limit:30};
  let finishSearch;
  let catalogRequests=0;
  let exerciseRenders=0;
  const handlers={renderExercises(){exerciseRenders++;},setLoading(){}};
  globalThis.fetch=async(url)=>{
    if(String(url).includes("/catalog")) {
      catalogRequests++;
      return {ok:true,json:async()=>({blocks:[block],other,canManageCollections:false})};
    }
    return new Promise((resolve)=>{finishSearch=()=>resolve({ok:true,json:async()=>({exercises:[]})});});
  };
  const pending=searchExercises("",handlers);
  await new Promise((resolve)=>setTimeout(resolve,0));
  assert.equal(typeof finishSearch,"function");
  await openExerciseBlocks(handlers);
  finishSearch();
  await pending;
  assert.equal(exerciseRenders,0);
  assert.ok(document.querySelector(".exercise-block-catalog"));
  await searchExercises("",handlers,{forceRefresh:true});
  assert.equal(catalogRequests,2);
  assert.equal(exerciseRenders,0);
  dom.window.close();
});
