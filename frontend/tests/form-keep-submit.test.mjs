import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

// F1 through the real submit: a late /api/organization answer repaints Settings while a save is on its way (the typed
// values move into the redrawn form); once the save succeeds, nothing typed - a password included - stays on screen.
const dom = new JSDOM("<!doctype html><body><main id=content></main></body>", { url: "https://optimove.test/" });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.FormData = dom.window.FormData;
const { captureChangedFields, restoreChangedFields } = await import("../form-keep.js");
const { renderFilterableSelect } = await import("../organization-select.js");
const { submitOrganizationForm } = await import("../organization-actions.js");
const root = dom.window.document.getElementById("content");

const loginForm = () => `
  <form class="panel organization-form" data-organization-form="athleteLogin">
    ${renderFilterableSelect({ name: "athleteId", label: "Athlete", options: [{ value: "a1", label: "Ana Example" }], required: true })}
    <label class="search-field"><span>Email</span><input name="email" type="email" required></label>
    <label class="search-field"><span>Password</span><input name="password" type="password" required></label>
    <p class="builder-error"></p>
    <button type="submit">Create login</button>
  </form>`;

const repaint = () => {
  const kept = captureChangedFields(root);
  root.innerHTML = loginForm();
  restoreChangedFields(root, kept);
};

test("a repaint during a successful Create login carries nothing over: email and password are empty on screen", async () => {
  root.innerHTML = loginForm();
  const form = root.querySelector("form");
  form.querySelector("[data-org-select-filter]").value = "Ana Example";
  form.querySelector('input[type="hidden"][name="athleteId"]').value = "a1";
  form.querySelector('[name="email"]').value = "ana@example.invalid";
  form.querySelector('[name="password"]').value = "demo-password-1";
  let repaintedDuringRequest = false;
  const calls = installFetchMock(async (call) => {
    if (call.method === "POST") { repaint(); repaintedDuringRequest = true; return { status: 201, body: {} }; }
    return { status: 200, body: {} };
  });
  try {
    await submitOrganizationForm(form, { loadAthletes: async () => {}, renderOrganizationPanel: async () => repaint() });
  } finally { restoreFetch(); }
  assert.ok(repaintedDuringRequest && calls.some((c) => c.method === "POST" && c.body?.email === "ana@example.invalid"));
  assert.equal(form.isConnected, false, "the submitted form was replaced during the request");
  assert.equal(root.querySelector('[name="email"]').value, "");
  assert.equal(root.querySelector('[name="password"]').value, "", "no password left on screen");
});
