// ST-5: Settings -> Tags & Presets -> Session types. The list of ST-1's routes, and its writes, through the real handlers
// with a fake fetch that keeps the routes' rules the screen depends on.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { state } = await import("../state.js");
const { handleSessionTypesAction, submitSessionTypesForm } = await import("../session-types-actions.js");
const { loadSessionTypesSettings, resetSessionTypesForWorkspaceChange, sessionTypesBusy } = await import("../session-types-data.js");
const { renderSessionTypesPanelHtml } = await import("../session-types-view.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let world;
let requests;
let fault;
const seen = new Map();
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ method, url, body });
  const result = fault ? await fault(method, url, body) ?? serve(method, url, body) : serve(method, url, body);
  if (result instanceof Error) throw result;
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};
// ST-1's rules: the club admin writes the club's types only; a taken name, a stale name and an archived type are refused; a
// request key replays its saved answer.
function serve(method, url, body) {
  const view = (t) => ({ key: t.key, label: t.label, ownerScope: t.ownerScope, active: t.active, sortOrder: 100 });
  if (method === "GET" && url === "/api/training-activity/session-types") {
    if (world.role === "athlete") return { status: 404, body: { error: "notFound", message: "Not found." } };
    return { status: 200, body: { types: world.types.map((t) => ({ ...view(t), editable: world.role === "clubAdmin" && t.ownerScope === "club" })), canAdd: world.role === "clubAdmin" ? "club" : null } };
  }
  if (method !== "POST" || world.role !== "clubAdmin") return { status: 404, body: { error: "notFound", message: "Not found." } };
  if (seen.has(body.requestKey)) return seen.get(body.requestKey);
  const answer = (() => {
    if (url === "/api/training-activity/session-types") {
      if (world.types.some((t) => t.active && t.ownerScope === "club" && t.label.toLowerCase() === body.label.toLowerCase())) return { status: 409, body: { error: "label_taken", message: "x" } };
      const t = { key: `c_0000abcd_${body.label.toLowerCase()}`, label: body.label, ownerScope: "club", active: true };
      world.types.push(t);
      return { status: 200, body: { type: view(t) } };
    }
    const m = url.match(/^\/api\/training-activity\/session-types\/([^/]+)\/(rename|archive|restore)$/);
    const t = m && world.types.find((x) => x.key === decodeURIComponent(m[1]) && x.ownerScope === "club");
    if (!t) return { status: 404, body: { error: "notFound", message: "Not found." } };
    if (m[2] === "rename") {
      if (t.label !== body.expectedLabel) return { status: 409, body: { error: "label_changed", message: "x" } };
      t.label = body.label;
    } else t.active = m[2] === "restore";
    return { status: 200, body: { type: view(t) } };
  })();
  if (answer.status === 200) seen.set(body.requestKey, answer);
  return answer;
}

let renders = 0;
const render = () => { renders += 1; };
async function open(role = "clubAdmin") {
  world = { role, types: [
    { key: "training_session", label: "Full training", ownerScope: "system", active: true },
    { key: "match", label: "Game", ownerScope: "system", active: true },
    { key: "testing_session", label: "Testing session", ownerScope: "system", active: false },
    { key: "c_0000abcd_gym", label: "Gym", ownerScope: "club", active: true },
  ] };
  requests = [];
  fault = null;
  seen.clear();
  resetSessionTypesForWorkspaceChange();
  await loadSessionTypesSettings(render);
  requests = [];
  return state.sessionTypes;
}
const act = (action, extra = {}) => handleSessionTypesAction({ dataset: { action, ...extra } }, { render });
const writes = () => requests.filter((r) => r.method !== "GET");
const html = () => renderSessionTypesPanelHtml();

test("1. the list: active types with whose they are, archived ones folded away; only the club's own carry Rename and Archive; no key is shown", async () => {
  await open();
  const page = html();
  assert.match(page, /<strong>Full training<\/strong> <small class="muted">OptiMove<\/small>/);
  assert.match(page, /<strong>Gym<\/strong> <small class="muted">Your club&#039;s<\/small>/);
  assert.match(page, /<summary>Archived \(1\)<\/summary>/);
  assert.deepEqual([...page.matchAll(/data-action="session-types-(rename|archive|restore)" data-key="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ["rename:c_0000abcd_gym", "archive:c_0000abcd_gym"]);
  assert.doesNotMatch(page.replace(/data-key="[^"]*"/g, ""), /c_0000abcd|training_session/, "a key is never shown as text");
  assert.match(page, /New session type for your club/);
});

test("2. add: one request with a key; the new type is listed; a taken name and an empty name are refused in words, nothing saved", async () => {
  const st = await open();
  st.newLabel = "Pool";
  await act("session-types-add");
  const [w] = writes();
  assert.deepEqual([w.method, w.url, w.body.label], ["POST", "/api/training-activity/session-types", "Pool"]);
  assert.match(w.body.requestKey, UUID);
  assert.match(html(), /Added: Pool\./);
  assert.match(html(), /<strong>Pool<\/strong>/);
  assert.equal(st.newLabel, "");
  st.newLabel = "gym";
  await act("session-types-add");
  assert.match(html(), /A session type with this name already exists\. Nothing was saved\./);
  st.newLabel = "   ";
  await act("session-types-add");
  assert.equal(writes().length, 2, "an empty name sends nothing");
  assert.match(html(), /Type a name first\./);
});

test("3. rename: the form carries the name it replaces; the same name sends nothing; a name changed meanwhile is refused and the list is read again", async () => {
  const st = await open();
  await act("session-types-rename", { key: "c_0000abcd_gym" });
  assert.match(html(), /New name for Gym/);
  st.editing.label = "Gym";
  await act("session-types-rename-save");
  assert.equal(writes().length, 0);
  await act("session-types-rename", { key: "c_0000abcd_gym" });
  st.editing.label = "Strength";
  await submitSessionTypesForm({ dataset: { sessionTypesForm: "rename" } }, { render });
  assert.deepEqual(writes()[0].body.label, "Strength");
  assert.equal(writes()[0].body.expectedLabel, "Gym");
  assert.match(html(), /Renamed to Strength\./);
  // Someone else renamed it meanwhile.
  await act("session-types-rename", { key: "c_0000abcd_gym" });
  world.types.find((t) => t.key === "c_0000abcd_gym").label = "Weights";
  st.editing.label = "Power";
  await act("session-types-rename-save");
  assert.match(html(), /Someone changed this name meanwhile\. The list shows it as it is now\. Nothing was saved\./);
  assert.match(html(), /<strong>Weights<\/strong>/);
});

test("4. archive is saved at once and Undo restores it; an archived type moves under Archived", async () => {
  await open();
  await act("session-types-archive", { key: "c_0000abcd_gym" });
  assert.match(writes()[0].url, /\/c_0000abcd_gym\/archive$/);
  let page = html();
  assert.match(page, /Gym is archived\. Sessions that have it keep it; it is no longer offered\./);
  assert.match(page, /<summary>Archived \(2\)<\/summary>/);
  await act("session-types-undo");
  assert.match(writes()[1].url, /\/c_0000abcd_gym\/restore$/);
  page = html();
  assert.match(page, /Gym is offered again\./);
  assert.match(page, /<summary>Archived \(1\)<\/summary>/);
});

test("5. a lost answer is not confirmed: every control is off, Check result sends the very same request, and nothing is written twice", async () => {
  const st = await open();
  let lose = true;
  fault = (method, url, body) => {
    if (method !== "POST" || !lose) return null;
    serve(method, url, body); // the server saved it
    return new Error("network");
  };
  st.newLabel = "Pool";
  await act("session-types-add");
  assert.ok(st.unconfirmed);
  assert.equal(sessionTypesBusy(), true);
  assert.match(html(), /We can&#039;t tell yet whether the change was saved/);
  assert.match(html(), /data-action="session-types-archive"[^>]*disabled/);
  await act("session-types-archive", { key: "c_0000abcd_gym" });
  assert.equal(writes().length, 1, "no other write while one is not confirmed");
  lose = false;
  await act("session-types-check");
  assert.deepEqual(writes()[1].body, writes()[0].body, "the same request, the same key");
  assert.equal(world.types.filter((t) => t.label === "Pool").length, 1, "written once");
  assert.match(html(), /Added: Pool\./);
});

test("6. a coach reads the list without any write control; an account that may not read it sees no panel; a forged write from a coach sends nothing", async () => {
  await open("coach");
  let page = html();
  assert.match(page, /<strong>Gym<\/strong>/);
  assert.doesNotMatch(page, /session-types-(add|rename|archive|restore)"/);
  await act("session-types-archive", { key: "c_0000abcd_gym" });
  state.sessionTypes.newLabel = "Pool";
  await act("session-types-add");
  assert.equal(writes().length, 0);
  await open("athlete");
  assert.equal(html(), "");
});

test("7. a rename open while the role is lost: the route's 404 notFound closes the form and says nothing was saved", async () => {
  const st = await open();
  await act("session-types-rename", { key: "c_0000abcd_gym" });
  assert.ok(st.editing);
  st.editing.label = "Strength";
  world.role = "coach";
  await act("session-types-rename-save");
  assert.equal(st.editing, null);
  assert.match(html(), /You can&#039;t change this session type\. Nothing was saved\./);
  assert.equal(writes().length, 1);
});

test("8. a write whose answer arrives after a workspace change touches nothing of the new workspace's state", async () => {
  const st = await open();
  fault = async (method) => {
    if (method === "POST") {
      resetSessionTypesForWorkspaceChange();
      return { status: 409, body: { error: "label_taken", message: "x" } };
    }
    return undefined;
  };
  await act("session-types-archive", { key: "c_0000abcd_gym" });
  assert.equal(st.unconfirmed, null);
  assert.equal(st.notice, null);
  assert.equal(st.sending, null);
  assert.equal(writes().length, 1);
});
