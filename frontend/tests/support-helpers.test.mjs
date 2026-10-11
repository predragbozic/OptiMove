// The shared frontend test support (tests/support/*.mjs, T1) checked on its
// own, so a change to a helper that 100+ suites may one day share is caught
// here first, with the exact shapes the migrated suites depend on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";
import { fakeAction, fakeElement } from "./support/dom.mjs";

const realFetch = globalThis.fetch;

test("installFetchMock(responder): records url, method and the parsed JSON body of every call, in order", async () => {
  const calls = installFetchMock((call) => ({ status: call.url.endsWith("/ok") ? 200 : 404, body: { echoed: call.body } }));
  const first = await fetch("/api/ok", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "Content-Type": "application/json" } });
  const second = await fetch("/api/missing");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { url: "/api/ok", method: "POST", body: { a: 1 }, rawBody: '{"a":1}', headers: { "Content-Type": "application/json" } });
  assert.deepEqual(calls[1], { url: "/api/missing", method: "GET", body: undefined, rawBody: undefined, headers: {} });
  assert.equal(first.ok, true);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { echoed: { a: 1 } });
  assert.equal(second.ok, false);
  assert.equal(second.status, 404);
  assert.equal(second.statusText, "");
});

test("installFetchMock(queue): answers one queued response per call and can simulate a network failure", async () => {
  const calls = installFetchMock([{ status: 201, body: { id: "x" } }, { throwNetworkError: true }]);
  const res = await fetch("/api/create", { method: "POST", body: JSON.stringify({ name: "n" }) });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: "x" });
  await assert.rejects(() => fetch("/api/again"), (error) => error instanceof TypeError && error.message === "Failed to fetch");
  assert.equal(calls.length, 2);
});

test("a second install starts a fresh call list; the previous list stops growing", async () => {
  const first = installFetchMock(() => ({ status: 200, body: {} }));
  await fetch("/one");
  const second = installFetchMock(() => ({ status: 200, body: {} }));
  await fetch("/two");
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].url, "/two");
});

test("a response exposes text() and headers.get() for the data modules that read them", async () => {
  installFetchMock(() => ({ status: 200, body: { k: 1 }, headers: { "X-Total-Count": "7" } }));
  const res = await fetch("/list");
  assert.equal(await res.text(), '{"k":1}');
  assert.equal(res.headers.get("x-total-count"), "7");
  assert.equal(res.headers.get("missing"), null);
});

test("a non-JSON request body is kept as it was sent instead of throwing", async () => {
  const calls = installFetchMock(() => ({ status: 200, body: {} }));
  await fetch("/raw", { method: "POST", body: "plain text" });
  assert.equal(calls[0].body, "plain text");
  assert.equal(calls[0].rawBody, "plain text");
});

test("installFetchMock refuses anything but a responder function or a response array", () => {
  assert.throws(() => installFetchMock("nope"), TypeError);
  assert.throws(() => installFetchMock(), TypeError);
});

test("restoreFetch puts the original fetch back", () => {
  installFetchMock(() => ({ status: 200, body: {} }));
  assert.notEqual(globalThis.fetch, realFetch);
  restoreFetch();
  assert.equal(globalThis.fetch, realFetch);
});

test("fakeAction returns the union shape every migrated suite's handler can read", () => {
  const plain = fakeAction({ action: "x", id: "1" });
  assert.deepEqual(plain.dataset, { action: "x", id: "1" });
  assert.equal(plain.value, undefined);
  assert.equal(plain.disabled, false);
  assert.equal(plain.closest(".anything"), null);
  const withValue = fakeAction({ action: "y" }, { value: "7" });
  assert.equal(withValue.value, "7");
  const target = { id: "row" };
  const withClosest = fakeAction({ action: "z" }, { closestResult: target, checked: true });
  assert.equal(withClosest.closest(".row"), target);
  assert.equal(withClosest.checked, true);
});

test("fakeElement is an empty container that answers no selector", () => {
  const el = fakeElement();
  assert.equal(el.innerHTML, "");
  assert.equal(el.textContent, "");
  assert.equal(el.querySelector(".x"), null);
  assert.deepEqual(el.querySelectorAll(".x"), []);
  assert.equal(fakeElement({ hidden: true }).hidden, true);
});
