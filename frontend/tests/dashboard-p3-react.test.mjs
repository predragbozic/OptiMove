import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
let islands, dom;
before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  islands = await import("../react-build/islands.js");
});
after(() => dom.window.close());
function mount(Component, props) {
  const container = document.createElement("div"); document.body.append(container);
  islands.mountIsland(container, Component, props, { name: "references" });
  return { container, close() { islands.unmountIsland(container); container.remove(); } };
}
test("reference list offers only the server-provided create capability and passes selection through", () => {
  let selected;
  const host = mount(islands.ReferenceTables, { tables: [{ key: "private-key", name: "Game targets", published: true }], canCreate: false, onOpen: (key) => { selected = key; } });
  try {
    assert.equal(host.container.textContent.includes("Add reference table"), false);
    host.container.querySelector("button").click();
    assert.equal(selected, "private-key");
    assert.equal(host.container.innerHTML.includes("private-key"), false);
    assert.equal(host.container.textContent.includes("Published"), true);
  } finally { host.close(); }
});
test("named values keep zero distinct from missing and place unit in the header", () => {
  const host = mount(islands.ReferenceValues, {
    title: "Game targets", columns: [{ key: "metric-id", name: "Duration", unit: "min", values: [{ key: "minimum", name: "Minimum" }, { key: "target", name: "Target" }] }],
    rows: [{ key: "position-id", name: "Forward", cells: { "metric-id": { minimum: 0 } } }],
  });
  try {
    assert.equal(host.container.querySelector("thead").textContent.includes("Duration (min)"), true);
    assert.equal(host.container.querySelector("tbody").textContent.includes("Minimum: 0"), true);
    assert.equal(host.container.querySelector("tbody").textContent.includes("Target: Not available"), true);
    assert.equal(host.container.innerHTML.includes("position-id"), false);
    assert.equal(host.container.innerHTML.includes("metric-id"), false);
    assert.equal(host.container.querySelectorAll("input").length, 0);
    assert.equal(host.container.querySelector('[role="region"]').style.overflowX, "auto");
  } finally { host.close(); }
});
test("authorized editor labels each extensible value with mobile-safe controls", () => {
  const host = mount(islands.ReferenceValues, { title: "Targets", canEdit: true,
    columns: [{ key: "m", name: "Distance", values: [{ key: "return", name: "Return to play" }] }],
    rows: [{ key: "p", name: "Forward", cells: {} }],
  });
  try {
    const input = host.container.querySelector("input");
    assert.equal(input.closest("label").textContent, "Return to play");
    assert.equal(input.style.fontSize, "16px");
    assert.equal(input.style.minHeight, "44px");
    assert.equal(input.value, "");
  } finally { host.close(); }
});

test('binding controls stay disabled while an update is unconfirmed',()=>{
 const host=mount(islands.ReferenceBindingEditor,{model:{busy:false,pending:{},binding:{mode:'overlay',source:'teamAverage',groupBy:'cohort',teamId:'',series:[],selected:[],axes:{}},options:{teams:[]},tables:[]},onAction:()=>{}});
 try{for(const select of host.container.querySelectorAll('select'))assert.equal(select.matches(':disabled'),true);assert.equal(host.container.querySelector('[aria-label="Close reference settings"]').disabled,true);}finally{host.close();}
});
test('Radar distinguishes same-name athletes and leaves values above 100 unclamped without identifiers',async()=>{
 const {referenceChartModel}=await import('../dashboard-reference-model.js');
 const axes=['Distance','Fast distance','Sprint distance'].map(label=>({label,unit:'m',status:'ready',points:[{personKey:'athlete_0',label:'Alex',status:'ok',normalized:150,references:[{key:'target',label:'Target',value:100,normalized:100}]},{personKey:'athlete_1',label:'Alex',status:'ok',normalized:80,references:[{key:'target',label:'Target',value:100,normalized:100}]}]}));
 const model=referenceChartModel({mode:'radar',axes},{display_config:{legend:{visible:false}}});assert.equal(model.option.legend.show,false);const names=model.option.series.map(s=>s.name);assert.equal(new Set(names).size,names.length);assert.ok(names.includes('Alex (2)'));assert.equal(model.option.series[0].data[0].value[0],150);assert.ok(model.option.radar.indicator[0].max>150);
});
test('reference chart scrubs an unresolved athlete identity from text, attributes and chart data',()=>{
 const id='12345678-1234-4234-8234-123456789abc';const host=mount(islands.ReferenceChart,{widget:{id:'widget'},data:{mode:'overlay',tableName:'Targets',axes:[{label:'Distance',unit:'m',status:'ready',points:[{label:'Athlete '+id,actual:0,status:'ok',references:[{key:'target',label:'Target',value:100}]}]}]}});
 try{assert.doesNotMatch(host.container.innerHTML,new RegExp(id));assert.match(host.container.textContent,/Athlete name unavailable/);assert.match(host.container.textContent,/Target: 100/);}finally{host.close();}
});
