// v88: positions - the Tags & Presets section and the athlete's Position form, through the real handlers with a fake
// fetch: what is offered to whom, the bodies sent, the request key kept after a lost answer and reused once, a refusal
// in plain words, and the estimate panel's Position average texts. Invented names only.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { state } = await import("../state.js");
const { loadPositions, resetPositions } = await import("../positions-data.js");
const { renderPositionsSectionHtml, renderAthletePositionFormHtml } = await import("../positions-view.js");
const { handlePositionAction, submitPositionForm } = await import("../positions-actions.js");
const { estimateLabelText } = await import("../activity-estimate.js");

const LIST = (canAdd) => ({
  canAdd,
  positions: [
    { id: "p-gk", name: "Goalkeeper", ownerScope: "system", active: true, sortOrder: 10, editable: canAdd === "system" },
    { id: "p-fw", name: "Forward", ownerScope: "system", active: true, sortOrder: 60, editable: canAdd === "system" },
    { id: "p-old", name: "Sweeper", ownerScope: "club", active: false, sortOrder: 70, editable: canAdd === "club" },
  ],
});

let requests;
function server({ canAdd = "club", athletes = { canSet: true, assignments: [{ athleteId: "a-1", positionId: "p-old" }] }, onWrite } = {}) {
  requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method, url, body });
    let result;
    if (method === "GET" && url.endsWith("/api/positions")) result = { status: 200, body: LIST(canAdd) };
    else if (method === "GET" && url.endsWith("/api/positions/athletes")) result = athletes ? { status: 200, body: athletes } : { status: 404, body: { error: "notFound" } };
    else result = await onWrite(method, url, body);
    if (result instanceof Error) throw result;
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}
const renders = { n: 0 };
const ctx = { renderOrganizationPanel: async () => { renders.n += 1; } };
const form = (dataset, fields) => {
  const f = { dataset, entries: fields };
  return f;
};
globalThis.FormData = class { constructor(f) { this.f = f.entries; } get(k) { return this.f[k] ?? null; } };

test("1. the section: every position with its owner, the archived one marked; a club admin edits only the club's and may add", async () => {
  resetPositions();
  server({ canAdd: "club" });
  await loadPositions();
  const html = renderPositionsSectionHtml();
  assert.match(html, /Goalkeeper/);
  assert.match(html, /Sweeper<\/strong><small class="muted"> · Your club<\/small><span class="muted"> · archived/);
  assert.equal((html.match(/data-action="positions-rename"/g) || []).length, 1, "only the club's own position is editable");
  assert.match(html, /data-action="positions-restore" data-position-id="p-old"/);
  assert.match(html, /data-action="positions-toggle-add"/);
  resetPositions();
  server({ canAdd: null });
  await loadPositions();
  const coach = renderPositionsSectionHtml();
  assert.doesNotMatch(coach, /positions-toggle-add|positions-rename|positions-archive/);
});

test("2. the athlete's form: No position or the active positions, the athlete's archived one kept and marked; outside a club or team workspace only a sentence", async () => {
  resetPositions();
  server();
  await loadPositions();
  const html = renderAthletePositionFormHtml("a-1");
  assert.match(html, /<option value="" >No position<\/option>/);
  assert.match(html, /<option value="p-old" selected>Sweeper \(archived\)<\/option>/);
  assert.match(html, /data-position-expected="p-old"/);
  assert.doesNotMatch(renderAthletePositionFormHtml("a-2"), /p-old/, "an archived position is not offered to another athlete");
  resetPositions();
  server({ athletes: null });
  await loadPositions();
  assert.match(renderAthletePositionFormHtml("a-1"), /set in a club's or a team's workspace/);
  assert.doesNotMatch(renderAthletePositionFormHtml("a-1"), /<select/);
});

test("3. saving a position: the body names the new and the expected position; a lost answer keeps the key and the resend reuses it once", async () => {
  resetPositions();
  let calls = 0;
  server({ onWrite: async () => { calls += 1; return calls === 1 ? new TypeError("network") : { status: 200, body: { athleteId: "a-1", positionId: "p-fw" } }; } });
  await loadPositions();
  const f = form({ positionForm: "athlete", athleteId: "a-1", positionExpected: "p-old" }, { positionId: "p-fw" });
  await submitPositionForm(f, ctx);
  const first = requests.find((r) => r.method === "PUT");
  assert.equal(first.url, "/api/positions/athletes/a-1");
  assert.deepEqual({ positionId: first.body.positionId, expectedPositionId: first.body.expectedPositionId }, { positionId: "p-fw", expectedPositionId: "p-old" });
  assert.match(state.positions.message, /not confirmed/);
  await submitPositionForm(f, ctx);
  const puts = requests.filter((r) => r.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[1].body.requestKey, puts[0].body.requestKey, "the resend carries the same key");
  assert.equal(state.positions.message, "Position saved.");
  assert.deepEqual(state.positions.keys, {}, "a definite answer drops the key");
});

test("4. a refusal reads as a sentence, drops the key and reads the list again; Clear sends null", async () => {
  resetPositions();
  server({ onWrite: async () => ({ status: 409, body: { error: "position_changed", current: { positionId: "p-gk" } } }) });
  await loadPositions();
  const before = requests.length;
  await submitPositionForm(form({ positionForm: "athlete", athleteId: "a-1", positionExpected: "p-old" }, { positionId: "" }), ctx);
  const put = requests.slice(before).find((r) => r.method === "PUT");
  assert.equal(put.body.positionId, null);
  assert.equal(state.positions.message, "The position was changed meanwhile. Check it and save again.");
  assert.deepEqual(state.positions.keys, {});
  assert.ok(requests.slice(before).some((r) => r.method === "GET" && r.url.endsWith("/api/positions/athletes")), "the list is read again");
});

test("5. the list's writes: add, rename with the expected name, archive", async () => {
  resetPositions();
  server({ onWrite: async (method, url, body) => ({ status: 200, body: { position: { id: "p-new", name: body.name ?? "x" } } }) });
  await loadPositions();
  await handlePositionAction({ dataset: { action: "positions-toggle-add" } }, ctx);
  assert.equal(state.positions.addOpen, true);
  await submitPositionForm(form({ positionForm: "add" }, { name: "  Libero " }), ctx);
  await submitPositionForm(form({ positionForm: "rename", positionId: "p-old", positionExpected: "Sweeper" }, { name: "Stopper" }), ctx);
  await handlePositionAction({ dataset: { action: "positions-archive", positionId: "p-old" } }, ctx);
  const writes = requests.filter((r) => r.method === "POST").map((r) => [r.url, { ...r.body, requestKey: typeof r.body.requestKey }]);
  assert.deepEqual(writes, [
    ["/api/positions", { name: "Libero", requestKey: "string" }],
    ["/api/positions/p-old/rename", { name: "Stopper", expectedName: "Sweeper", requestKey: "string" }],
    ["/api/positions/p-old/archive", { requestKey: "string" }],
  ]);
  assert.equal(state.positions.addOpen, false);
});

test("6. the estimate label names the position and the count", () => {
  assert.equal(estimateLabelText({ method: "position_average", positionName: "Forward", athleteCount: 3, estimatedBy: "Mira Coach", estimatedAt: "2026-11-20T10:00:00Z" }),
    "Estimate · position average (Forward, 3 athletes) · Mira Coach, 20.11.2026");
  assert.equal(estimateLabelText({ method: "position_average" }), "Estimate · position average");
});
